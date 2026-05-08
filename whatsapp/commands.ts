import { db, Task, createTask, answerEscalation, getPendingEscalations, logEvent } from '../coordinator/src/queue';
import { getBudgetEstimate, isPeakHours } from '../coordinator/src/rate-limiter';
import { rollbackTask, deployToProduction, updateStatus } from '../coordinator/src/pipeline';
import { retryTask, dismissTask } from '../coordinator/src/task-actions';
import { syncToSupabase } from '../coordinator/src/supabase-sync';
import { killSession, isSessionRunning } from '../coordinator/src/session-manager';
import { handleDesignReply } from '../coordinator/src/design-reply-handler';
import { approveEpic, cancelEpic } from '../coordinator/src/epic';
import { randomUUID } from 'crypto';

const VALID_EFFORT_LEVELS = ['medium', 'high', 'xhigh', 'max'];
const MODEL_ALIASES: Record<string, string> = {
  'opus': 'claude-opus-4-7',
  'opus-4-7': 'claude-opus-4-7',
  'claude-opus-4-7': 'claude-opus-4-7',
  'sonnet': 'claude-sonnet-4-6',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
};

// Which agent a given task status belongs to. Mirrors pipeline.ts agentForStatus
// but inlined to avoid importing internals.
function agentForTaskStatus(status: string): 'pm' | 'ux' | 'dev' | 'reviewer' | null {
  switch (status) {
    case 'inbox': case 'researching': case 'design_validation': return 'pm';
    case 'design_pending': case 'designing': return 'ux';
    case 'dev_ready': case 'developing': case 'testing': return 'dev';
    case 'review_pending': case 'reviewing': return 'reviewer';
    default: return null;
  }
}

// When an override kills a running session mid-stage, reset the task status to
// the prior pending state so the next pipeline tick reruns the stage cleanly
// rather than routing into a resume-handler that expects different context.
function statusAfterKill(currentStatus: string): string {
  const map: Record<string, string> = {
    'researching': 'inbox',
    'designing': 'design_pending',
    'developing': 'dev_ready', // avoids routing into resumeDevWithContext
    'testing': 'dev_ready',
  };
  return map[currentStatus] || currentStatus;
}

export async function handleWhatsAppMessage(from: string, text: string): Promise<string | null> {
  const parts = text.split(' ');
  const command = parts[0].toLowerCase();

  switch (command) {
    case '/help':
      return [
        'Commands:',
        '',
        'Tasks',
        '  /task {title} | {description} - Add a new task',
        '  /status {id} - Task details',
        '  /queue - Show task queue with effort + model info',
        '  /retry {id} - Retry a failed task',
        '  /dismiss {id} - Dismiss a failed task',
        '  /answer {id} {text} - Answer an agent escalation',
        '  /design_reply {id} {text} - Approve / revise wireframes (use "approved" to ship)',
        '  /approve_epic {id} - Approve a decomposed epic and queue its phases',
        '  /cancel_epic {id} - Cancel a decomposed epic before phases run',
        '',
        'Overrides (apply to current stage; kills + reruns if in-flight)',
        '  /effort {id} {medium|high|xhigh|max}',
        '  /model {id} {opus|sonnet}',
        '',
        'Pipeline',
        '  /status - System overview (budget, tasks, health)',
        '  /budget - Rate limit budget + scheduling info',
        '  /pause - Pause the pipeline',
        '  /resume - Resume the pipeline',
        '',
        'Deployment',
        '  /deploy - Merge staging to master',
        '  /rollback {id} - Revert a merged task on staging',
        '',
        'System',
        '  /help - This message',
      ].join('\n');

    case '/status': {
      if (parts[1]) {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parts[1]) as Task | undefined;
        if (!task) return `Task ${parts[1]} not found`;
        return [
          `Task: ${task.title}`,
          `Status: ${task.status}`,
          `Effort: ${task.effort_size || 'TBD'}`,
          `Model: ${task.dev_model}`,
          `Swarm: ${task.use_swarm ? 'yes' : 'no'}`,
          `Retries: ${task.retry_count}`,
          task.pr_url ? `PR: ${task.pr_url}` : '',
          task.error ? `Error: ${task.error.slice(0, 200)}` : '',
        ].filter(Boolean).join('\n');
      }

      const budget = getBudgetEstimate();
      const taskCounts = db.prepare(`
        SELECT status, COUNT(*) as count FROM tasks GROUP BY status
      `).all() as { status: string; count: number }[];

      const statusLine = taskCounts.map(r => `${r.status}: ${r.count}`).join(', ');
      const escalations = getPendingEscalations();

      return [
        'System Status',
        `Cost (5h): $${budget.costUsd.toFixed(2)}`,
        `Peak hours: ${budget.isPeakHours ? 'active' : 'off-peak'}`,
        `Paused: ${budget.shouldPause ? 'yes' : 'no'}`,
        `Tasks: ${statusLine || 'none'}`,
        escalations.length > 0 ? `Pending escalations: ${escalations.length}` : '',
      ].filter(Boolean).join('\n');
    }

    case '/queue': {
      const tasks = db.prepare(`
        SELECT id, title, status, effort_size, dev_model, priority
        FROM tasks
        WHERE status NOT IN ('merged', 'failed')
        ORDER BY priority ASC, created_at ASC
        LIMIT 20
      `).all() as any[];

      if (tasks.length === 0) return 'Queue is empty';

      return ['Task Queue:', ...tasks.map((t, i) =>
        `${i + 1}. [${t.status}] ${t.title} (${t.effort_size || '?'}, ${t.dev_model?.includes('opus') ? 'opus' : 'sonnet'})`
      )].join('\n');
    }

    case '/budget': {
      const budget = getBudgetEstimate();
      const queuedTasks = db.prepare(`
        SELECT effort_size, COUNT(*) as count FROM tasks
        WHERE status = 'dev_ready'
        GROUP BY effort_size
      `).all() as { effort_size: string; count: number }[];

      const queueLine = queuedTasks.map(r => `${r.count} ${r.effort_size}`).join(', ');

      return [
        'Rate Limit Budget',
        `Cost (5h): $${budget.costUsd.toFixed(2)} | ${budget.sessionCount} sessions`,
        `Peak hours: ${budget.isPeakHours ? 'Active (5am-11am PT)' : 'Off-peak'}`,
        `Should pause: ${budget.shouldPause ? 'YES' : 'no'}`,
        `Tasks queued: ${queueLine || 'none'}`,
      ].join('\n');
    }

    case '/design_reply': {
      const taskId = parts[1];
      const reply = parts.slice(2).join(' ');
      if (!taskId || !reply) return 'Usage: /design_reply {task-id} {text}';

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
      if (!task) return `Task ${taskId} not found`;

      const result = await handleDesignReply(task, reply);
      return result.message;
    }

    case '/answer': {
      const idInput = parts[1];
      const answer = parts.slice(2).join(' ');
      if (!idInput || !answer) return 'Usage: /answer {task-id} {text}';

      // Look up most recent pending escalation by task ID first
      let escalation = db.prepare(
        "SELECT id, task_id FROM escalations WHERE task_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
      ).get(idInput) as { id: number; task_id: string } | undefined;

      // Fallback: try as escalation ID for backwards compatibility
      if (!escalation) {
        const escalationId = parseInt(idInput);
        if (!isNaN(escalationId)) {
          escalation = db.prepare('SELECT id, task_id FROM escalations WHERE id = ?')
            .get(escalationId) as { id: number; task_id: string } | undefined;
        }
      }

      if (!escalation) return `No pending escalation found for "${idInput}"`;

      answerEscalation(escalation.id, answer);

      const task = db.prepare('SELECT error, status, retry_count FROM tasks WHERE id = ?')
        .get(escalation.task_id) as { error: string; status: string; retry_count: number } | undefined;
      if (task?.error) {
        try {
          const parsed = JSON.parse(task.error);
          if (parsed.previous_status) {
            // Route escalations to the right resume point:
            // - reviewing/developing/testing → developing (dev resumes with guidance)
            // - researching/design_pending/designing/design_review → stay put, the stage handler
            //   checks for answered escalations and injects them into the agent's prompt
            const routeToDev = ['reviewing', 'developing', 'testing'].includes(parsed.previous_status);
            const resumeStatus = routeToDev ? 'developing' : parsed.previous_status;

            if (routeToDev) {
              db.prepare('UPDATE tasks SET status = ?, error = NULL, retry_count = 0, test_retry_count = 0, updated_at = ? WHERE id = ?')
                .run(resumeStatus, Date.now(), escalation.task_id);
            } else {
              db.prepare('UPDATE tasks SET status = ?, error = NULL, updated_at = ? WHERE id = ?')
                .run(resumeStatus, Date.now(), escalation.task_id);
            }
            await syncToSupabase('task_update', { id: escalation.task_id });
            return `Answered. Task ${escalation.task_id} resumed at ${resumeStatus}${routeToDev ? ' (retry count reset)' : ''}`;
          }
        } catch {}
      }

      await syncToSupabase('task_update', { id: escalation.task_id });
      return `Answered escalation for task ${escalation.task_id}`;
    }

    case '/pause':
      db.prepare('UPDATE pipeline_lock SET locked = 1, locked_by = ?, locked_at = ? WHERE id = 1')
        .run('manual_pause', Date.now());
      return 'Pipeline paused';

    case '/resume':
      db.prepare('UPDATE pipeline_lock SET locked = 0, locked_by = NULL, locked_at = NULL, task_id = NULL WHERE id = 1')
        .run();
      return 'Pipeline resumed';

    case '/task': {
      const taskText = parts.slice(1).join(' ');
      const [title, description] = taskText.split('|').map(s => s.trim());
      if (!title) return 'Usage: /task {title} | {description}';

      const taskId = randomUUID().slice(0, 8);
      createTask(taskId, title, description || title, 'whatsapp');
      return `Task created: ${taskId}\n${title}`;
    }

    case '/retry': {
      const taskId = parts[1];
      if (!taskId) return 'Usage: /retry {task-id}';
      return await retryTask(taskId);
    }

    case '/dismiss': {
      const taskId = parts[1];
      if (!taskId) return 'Usage: /dismiss {task-id}';
      return await dismissTask(taskId);
    }

    case '/approve_epic': {
      const epicId = parts[1];
      if (!epicId) return 'Usage: /approve_epic {epic-id}';
      return await approveEpic(epicId, updateStatus);
    }

    case '/cancel_epic': {
      const epicId = parts[1];
      if (!epicId) return 'Usage: /cancel_epic {epic-id}';
      return await cancelEpic(epicId);
    }

    case '/rollback': {
      const taskId = parts[1];
      if (!taskId) return 'Usage: /rollback {task-id}';
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
      if (!task) return `Task ${taskId} not found`;
      if (task.status !== 'merged') return `Task ${taskId} is "${task.status}" — can only rollback merged tasks`;
      if (!task.pr_number) return `Task ${taskId} has no PR to rollback`;

      const result = await rollbackTask(task);
      return result;
    }

    case '/deploy': {
      const result = await deployToProduction();
      return result;
    }

    case '/effort': {
      const taskId = parts[1];
      const level = (parts[2] || '').toLowerCase();
      if (!taskId || !level) return `Usage: /effort {task-id} {${VALID_EFFORT_LEVELS.join('|')}}`;
      if (!VALID_EFFORT_LEVELS.includes(level)) {
        return `Invalid effort level "${parts[2]}". Must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`;
      }

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
      if (!task) return `Task ${taskId} not found`;

      const agent = agentForTaskStatus(task.status);
      if (agent !== 'dev' && agent !== 'reviewer') {
        return `Effort override only applies to dev or reviewer stages. Task ${taskId} is at "${task.status}" (${agent || 'unknown'}).`;
      }

      const column = agent === 'dev' ? 'dev_effort' : 'reviewer_effort';
      const currentValue = agent === 'dev' ? task.dev_effort : task.reviewer_effort;
      if (currentValue === level) {
        return `${column} is already "${level}" — no change.`;
      }

      const running = isSessionRunning(taskId);
      if (running.running) {
        const killResult = killSession(taskId);
        const newStatus = statusAfterKill(task.status);
        db.prepare(`UPDATE tasks SET ${column} = ?, status = ?, updated_at = ? WHERE id = ?`)
          .run(level, newStatus, Date.now(), taskId);
        logEvent(taskId, 'system', 'override_applied',
          `${column}: ${currentValue}→${level} | killed ${agent} session after ${killResult.runtimeMs}ms | status ${task.status}→${newStatus} | by WhatsApp`);
        await syncToSupabase('task_update', { id: taskId });
        return `${column}: ${currentValue} → ${level}\nKilled running ${agent} session (${Math.round((killResult.runtimeMs || 0) / 1000)}s runtime). Rerunning on next tick.`;
      }

      db.prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`)
        .run(level, Date.now(), taskId);
      logEvent(taskId, 'system', 'override_applied',
        `${column}: ${currentValue}→${level} | not running, future only | by WhatsApp`);
      await syncToSupabase('task_update', { id: taskId });
      return `${column}: ${currentValue} → ${level}\nWill apply on next ${agent} run.`;
    }

    case '/model': {
      const taskId = parts[1];
      const modelInput = (parts[2] || '').toLowerCase();
      if (!taskId || !modelInput) return 'Usage: /model {task-id} {opus|sonnet}';
      const resolvedModel = MODEL_ALIASES[modelInput];
      if (!resolvedModel) {
        return `Invalid model "${parts[2]}". Use: opus, sonnet (or full names).`;
      }

      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
      if (!task) return `Task ${taskId} not found`;

      const agent = agentForTaskStatus(task.status);
      if (agent !== 'dev' && agent !== 'reviewer') {
        return `Model override only applies to dev or reviewer stages. Task ${taskId} is at "${task.status}" (${agent || 'unknown'}).`;
      }

      const column = agent === 'dev' ? 'dev_model' : 'reviewer_model';
      const currentValue = agent === 'dev' ? task.dev_model : task.reviewer_model;
      if (currentValue === resolvedModel) {
        return `${column} is already "${resolvedModel}" — no change.`;
      }

      const running = isSessionRunning(taskId);
      if (running.running) {
        const killResult = killSession(taskId);
        const newStatus = statusAfterKill(task.status);
        db.prepare(`UPDATE tasks SET ${column} = ?, status = ?, updated_at = ? WHERE id = ?`)
          .run(resolvedModel, newStatus, Date.now(), taskId);
        logEvent(taskId, 'system', 'override_applied',
          `${column}: ${currentValue}→${resolvedModel} | killed ${agent} session after ${killResult.runtimeMs}ms | status ${task.status}→${newStatus} | by WhatsApp`);
        await syncToSupabase('task_update', { id: taskId });
        return `${column}: ${currentValue} → ${resolvedModel}\nKilled running ${agent} session (${Math.round((killResult.runtimeMs || 0) / 1000)}s runtime). Rerunning on next tick.`;
      }

      db.prepare(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`)
        .run(resolvedModel, Date.now(), taskId);
      logEvent(taskId, 'system', 'override_applied',
        `${column}: ${currentValue}→${resolvedModel} | not running, future only | by WhatsApp`);
      await syncToSupabase('task_update', { id: taskId });
      return `${column}: ${currentValue} → ${resolvedModel}\nWill apply on next ${agent} run.`;
    }

    default:
      return null;
  }
}
