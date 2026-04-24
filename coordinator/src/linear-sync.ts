import { LinearClient } from '@linear/sdk';
import { db, logEvent, createTask } from './queue';
import { randomUUID } from 'crypto';
import { syncToSupabase } from './supabase-sync';

let linearClient: LinearClient | null = null;

export function initLinear(): void {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    console.warn('Linear API key not configured — sync disabled');
    return;
  }
  if (!process.env.LINEAR_TEAM_ID) {
    console.warn('LINEAR_TEAM_ID not set — Linear sync disabled');
    return;
  }
  linearClient = new LinearClient({ apiKey });
}

const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID || '';
const AGENT_READY_LABEL = process.env.LINEAR_AGENT_READY_LABEL || 'agent-ready';

export async function pollLinearIssues(): Promise<void> {
  if (!linearClient) return;

  try {
    const team = await linearClient.team(LINEAR_TEAM_ID);
    const issues = await team.issues({
      filter: {
        labels: { name: { eq: AGENT_READY_LABEL } },
        state: { type: { nin: ['completed', 'canceled'] } },
      },
    });

    for (const issue of issues.nodes) {
      const existing = db.prepare('SELECT id FROM tasks WHERE source_id = ?').get(issue.id);
      if (existing) continue;

      const taskId = randomUUID().slice(0, 8);
      createTask(
        taskId,
        issue.title,
        issue.description || issue.title,
        'linear',
        issue.id,
        issue.priority ?? 2
      );

      db.prepare('UPDATE tasks SET linear_url = ?, updated_at = ? WHERE id = ?')
        .run(issue.url, Date.now(), taskId);

      logEvent(taskId, 'linear', 'task_imported', `Imported from Linear: ${issue.title}`);
      await syncToSupabase('task_update', { id: taskId });
    }
  } catch (err: any) {
    console.error('Linear poll failed:', err.message);
    logEvent(null, 'linear', 'sync_error', `Linear poll failed: ${err.message}`);
  }
}

export async function updateLinearIssue(
  issueId: string,
  status: string,
  prUrl?: string
): Promise<void> {
  if (!linearClient) return;

  try {
    const issue = await linearClient.issue(issueId);

    const team = await linearClient.team(LINEAR_TEAM_ID);
    const states = await team.states();
    const targetState = states.nodes.find(s => s.name.toLowerCase() === status.toLowerCase());

    if (targetState) {
      await issue.update({ stateId: targetState.id });
    }

    if (prUrl) {
      await linearClient.createComment({
        issueId: issue.id,
        body: `PR created: ${prUrl}`,
      });
    }
  } catch (err: any) {
    console.error('Linear update failed:', err.message);
    logEvent(null, 'linear', 'sync_error', `Linear update failed: ${err.message}`);
  }
}

/**
 * Create a new Linear issue from a WhatsApp/CLI task after PM research.
 * Returns the Linear issue ID so we can link it back.
 */
export async function createLinearIssue(
  title: string,
  description: string,
  priority: number
): Promise<string | null> {
  if (!linearClient) return null;

  try {
    const issue = await linearClient.createIssue({
      teamId: LINEAR_TEAM_ID,
      title,
      description,
      priority,
    });

    const created = await issue.issue;
    if (created) {
      logEvent(null, 'linear', 'issue_created', `Created Linear issue: ${created.identifier} - ${title}`);
      return created.id;
    }
    return null;
  } catch (err: any) {
    console.error('Linear issue creation failed:', err.message);
    logEvent(null, 'linear', 'sync_error', `Linear create failed: ${err.message}`);
    return null;
  }
}

/**
 * Enrich a Linear issue with PM research findings.
 * Called after the PM agent completes research — updates the issue description
 * with effort estimate, affected files, root cause hypothesis.
 */
export async function enrichLinearIssue(
  issueId: string,
  research: {
    effort?: { size: string; estimated_turns: number; rationale: string; dev_model: string; use_swarm: boolean };
    research?: { summary: string; title?: string; affected_files: string[]; root_cause?: string };
    design_brief?: { userGoal: string; affectedScreens: string[]; affectedComponents: string[] };
  },
  newTitle?: string
): Promise<void> {
  if (!linearClient) return;

  try {
    const parts: string[] = [];

    if (research.research) {
      parts.push(`## Research Findings`);
      parts.push(research.research.summary);
      if (research.research.root_cause) {
        parts.push(`\n**Root cause hypothesis:** ${research.research.root_cause}`);
      }
      if (research.research.affected_files?.length > 0) {
        parts.push(`\n**Affected files:**`);
        for (const f of research.research.affected_files) parts.push(`- \`${f}\``);
      }
    }

    if (research.effort) {
      parts.push(`\n## Effort Estimate`);
      parts.push(`- **Size:** ${research.effort.size}`);
      parts.push(`- **Estimated turns:** ${research.effort.estimated_turns}`);
      parts.push(`- **Model:** ${research.effort.dev_model}`);
      parts.push(`- **Swarm:** ${research.effort.use_swarm ? 'Yes' : 'No'}`);
      parts.push(`- **Rationale:** ${research.effort.rationale}`);
    }

    if (research.design_brief) {
      parts.push(`\n## Design Brief`);
      parts.push(`- **User goal:** ${research.design_brief.userGoal}`);
      if (research.design_brief.affectedScreens?.length > 0) {
        parts.push(`- **Affected screens:** ${research.design_brief.affectedScreens.join(', ')}`);
      }
    }

    if (parts.length > 0) {
      const issue = await linearClient.issue(issueId);
      const existingDesc = issue.description || '';
      const enrichment = `\n\n---\n*Enriched by PM Agent*\n\n${parts.join('\n')}`;
      const updatePayload: { description: string; title?: string } = {
        description: existingDesc + enrichment,
      };
      if (newTitle) updatePayload.title = newTitle;
      await issue.update(updatePayload);

      await linearClient.createComment({
        issueId,
        body: `PM Agent completed research. Effort: **${research.effort?.size || '?'}** (${research.effort?.dev_model || 'sonnet'})`,
      });

      logEvent(null, 'linear', 'issue_enriched', `Enriched Linear issue ${issueId}`);
    }
  } catch (err: any) {
    console.error('Linear enrichment failed:', err.message);
    logEvent(null, 'linear', 'sync_error', `Linear enrich failed: ${err.message}`);
  }
}
