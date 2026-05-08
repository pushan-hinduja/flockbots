import { useState } from 'react';
import { supabase } from '../supabase';

interface TaskPipelineProps {
  tasks: any[];
}

// Stages shown in the timeline view (subset). The post-design coordinator/PM/
// human steps collapse into a single "design_validation" pillar in the timeline
// — visually one slot, three internal stages (rendering, PM check, human gate).
const PIPELINE_STAGES = [
  'inbox', 'researching', 'designing', 'design_validation',
  'dev_ready', 'developing', 'reviewing', 'merged',
];

// Full ordering of all possible task statuses, used for revert eligibility checks
const FULL_STAGE_ORDER = [
  'inbox', 'researching', 'design_pending', 'designing',
  'wireframes_rendering', 'design_validation', 'awaiting_design_approval',
  'dev_ready', 'developing', 'testing', 'review_pending', 'reviewing', 'merged',
];

const STAGE_LABELS: Record<string, string> = {
  inbox: 'Inbox',
  researching: 'Research',
  designing: 'Design',
  design_pending: 'Design',
  wireframes_rendering: 'Render',
  design_validation: 'Review Design',
  awaiting_design_approval: 'Approval',
  dev_ready: 'Ready',
  developing: 'Dev',
  reviewing: 'Code Review',
  merged: 'Merged',
};

// All stages a task can be reverted/retried to
const REVERT_TARGETS = ['inbox', 'researching', 'design_pending', 'dev_ready'];

async function sendAction(instanceId: string, taskId: string, action: string, extra?: Record<string, string>) {
  // webhook_inbox has instance_id NOT NULL — the relevant coordinator polls
  // by its own instance_id, so the action only fires on the right one.
  await supabase.from('webhook_inbox').insert({
    instance_id: instanceId,
    source: 'dashboard',
    sender: null,
    payload: { action, task_id: taskId, ...extra },
  });
}

function modelLabel(model?: string): string {
  if (!model) return 'Sonnet';
  if (model.includes('opus')) return 'Opus';
  return 'Sonnet';
}

function getFailedAtStage(task: any): string | null {
  if (!task.error) return null;
  try {
    const parsed = JSON.parse(task.error);
    return parsed.previous_status || null;
  } catch {
    return null;
  }
}

// Some previous_status values are not themselves columns in PIPELINE_STAGES
// (e.g. 'design_pending' is bundled into 'designing', 'review_pending' into
// 'reviewing'). Map them so the failed card lands in the right column.
function mapPreviousStatusToColumn(prev: string): string | null {
  if (!prev) return null;
  if (PIPELINE_STAGES.includes(prev)) return prev;
  switch (prev) {
    case 'design_pending':
    case 'wireframes_rendering':
    case 'awaiting_design_approval':
      return 'design_validation';
    case 'testing':
      return 'developing';
    case 'review_pending':
      return 'reviewing';
    case 'qa_pending':
    case 'qa_running':
      return 'merged';
    default:
      return null;
  }
}

/** Bucket failed tasks into the column matching their previous_status. */
function failedTasksByColumn(tasks: any[]): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const t of tasks) {
    if (t.status !== 'failed') continue;
    const col = mapPreviousStatusToColumn(getFailedAtStage(t) || '');
    if (!col) continue;
    (out[col] = out[col] || []).push(t);
  }
  return out;
}

function RetryMenu({ task, onClose }: { task: any; onClose: () => void }) {
  const failedAt = getFailedAtStage(task);
  // Use the full stage order so intermediate statuses (review_pending, design_pending, testing) resolve correctly
  const effectiveStatus = (task.status === 'failed' || task.status === 'awaiting_human')
    ? (failedAt || 'reviewing')
    : task.status;
  const currentIdx = FULL_STAGE_ORDER.indexOf(effectiveStatus);

  const targets = REVERT_TARGETS.filter((stage) => {
    const idx = FULL_STAGE_ORDER.indexOf(stage);
    return idx >= 0 && idx <= currentIdx;
  });

  if (targets.length === 0) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-card border border-border rounded-lg shadow-lg py-1">
        <div className="px-2 py-1 text-[10px] text-muted-foreground font-medium">Retry from stage</div>
        {targets.map((stage) => {
          const isFailedStage = failedAt && (stage === failedAt || STAGE_LABELS[stage] === STAGE_LABELS[failedAt]);
          return (
            <button
              key={stage}
              onClick={() => {
                sendAction(task.instance_id, task.id, 'revert_stage', { target_status: stage });
                onClose();
              }}
              className={`w-full text-left px-2 py-1.5 text-xs hover:bg-secondary transition-colors flex items-center justify-between ${
                isFailedStage ? 'text-foreground' : ''
              }`}
            >
              <span>{STAGE_LABELS[stage]}</span>
              {isFailedStage && (
                <span className="text-[10px] text-destructive">failed here</span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

function TaskCard({ task }: { task: any }) {
  const [showMenu, setShowMenu] = useState(false);
  const isFailed = task.status === 'failed';
  const canRevert = isFailed || (task.status !== 'merged' && task.status !== 'inbox');
  const isQaAuto = task.source === 'qa-auto';
  const isQaRunning = task.status === 'qa_pending' || task.status === 'qa_running';

  return (
    <div
      className={`bg-background border rounded-xl p-3 text-xs min-w-0 relative ${
        isFailed ? 'border-destructive/60' : 'border-border'
      }`}
    >
      <div className="flex items-start gap-2">
        {isFailed && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-destructive flex-shrink-0 mt-1.5"
            title="Failed at this stage"
          />
        )}
        <p className="font-medium truncate flex-1">{task.title}</p>
        {(isQaAuto || isQaRunning) && (
          <span
            className="px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider flex-shrink-0"
            style={isQaAuto
              ? { backgroundColor: 'rgba(217,119,6,0.15)', color: '#d97706' }
              : { backgroundColor: 'rgba(120,72,168,0.15)', color: '#7848a8' }}
            title={isQaAuto ? 'Auto-created from a QA regression' : 'QA verification in progress'}
          >
            QA
          </span>
        )}
        {canRevert && (
          <button
            onClick={() => setShowMenu(!showMenu)}
            className={`p-0.5 rounded transition-colors flex-shrink-0 ${
              isFailed
                ? 'text-destructive hover:text-destructive hover:bg-destructive/10'
                : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-secondary'
            }`}
            title="Retry from earlier stage"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
            </svg>
          </button>
        )}
        {isFailed && (
          <button
            onClick={() => sendAction(task.instance_id, task.id, 'dismiss')}
            className="p-0.5 rounded text-muted-foreground/60 hover:text-destructive hover:bg-secondary transition-colors flex-shrink-0"
            title="Dismiss"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      {task.effort_size && (
        <p className={`mt-1 ${isFailed ? 'text-destructive/80' : 'text-muted-foreground'}`}>
          {task.effort_size} · {modelLabel(task.dev_model)}
          {isFailed && ' · failed here'}
        </p>
      )}
      {showMenu && <RetryMenu task={task} onClose={() => setShowMenu(false)} />}
    </div>
  );
}

function FailedCard({ task }: { task: any }) {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="bg-background border border-border rounded-xl p-3 text-xs flex items-center gap-2 relative">
      <p className="font-medium truncate flex-1">{task.title}</p>
      <button
        onClick={() => setShowMenu(!showMenu)}
        className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
        title="Retry"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
      </button>
      <button
        onClick={() => sendAction(task.instance_id, task.id, 'dismiss')}
        className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors flex-shrink-0"
        title="Dismiss"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      {showMenu && <RetryMenu task={task} onClose={() => setShowMenu(false)} />}
    </div>
  );
}

export function TaskPipeline({ tasks }: TaskPipelineProps) {
  // Failed tasks appear in the column matching their previous_status (with a
  // red dot + red border on the card). Failed tasks whose previous_status
  // doesn't map to any pipeline column fall back to the bottom "Failed"
  // section.
  const failedByCol = failedTasksByColumn(tasks);
  const grouped = PIPELINE_STAGES.reduce((acc, stage) => {
    const active = tasks.filter((t: any) => t.status === stage);
    const inStageFailed = failedByCol[stage] || [];
    acc[stage] = [...active, ...inStageFailed];
    return acc;
  }, {} as Record<string, any[]>);

  const failedInColumns = new Set(
    Object.values(failedByCol).flat().map((t: any) => t.id)
  );
  const orphanFailed = tasks.filter(
    (t: any) => t.status === 'failed' && !failedInColumns.has(t.id)
  );
  const awaiting = tasks.filter((t: any) => t.status === 'awaiting_human');

  if (tasks.length === 0) {
    return (
      <div className="bg-card border border-border rounded-2xl p-4">
        <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-4">Pipeline</h2>
        <div className="py-8 text-center">
          <p className="text-sm text-muted-foreground">No tasks yet</p>
          <p className="text-xs text-muted-foreground mt-1">Tasks will appear here when added via WhatsApp, Linear, or CLI</p>
        </div>
      </div>
    );
  }

  const stages = PIPELINE_STAGES;

  return (
    <div className="bg-card border border-border rounded-2xl p-4">
      <h2 className="text-xs uppercase tracking-widest text-muted-foreground mb-4">
        Pipeline
      </h2>

      {/* Timeline */}
      <div className="space-y-0">
        {stages.map((stage, i) => {
          const stageTasks = grouped[stage] || [];
          const hasItems = stageTasks.length > 0;
          const isLast = i === stages.length - 1;

          const stageHasFailed = stageTasks.some((t: any) => t.status === 'failed');
          return (
            <div key={stage} className="flex gap-3">
              {/* Timeline track — red dot if any task failed in this stage */}
              <div className="flex flex-col items-center w-5 flex-shrink-0">
                <div
                  className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${
                    stageHasFailed
                      ? 'bg-destructive'
                      : hasItems
                        ? 'bg-foreground'
                        : 'bg-muted-foreground/30'
                  }`}
                />
                {!isLast && (
                  <div className="w-px flex-1 min-h-[16px] bg-border" />
                )}
              </div>

              {/* Stage content */}
              <div className={`flex-1 min-w-0 ${hasItems ? 'pb-3' : 'pb-2'}`}>
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-medium ${
                    stageHasFailed ? 'text-destructive' : hasItems ? 'text-foreground' : 'text-muted-foreground'
                  }`}>
                    {STAGE_LABELS[stage]}
                  </span>
                  {hasItems && (
                    <span className="text-xs text-muted-foreground">{stageTasks.length}</span>
                  )}
                </div>
                {hasItems && (
                  <div className="space-y-1.5 mt-1.5">
                    {stageTasks.map((task: any) => (
                      <TaskCard key={task.id} task={task} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Special states. Failed tasks normally render inline within their
          previous-stage column (with red dot + border); only orphans whose
          previous_status doesn't map to a pipeline column fall to this
          bucket. Awaiting-human tasks always live here — they're a wait
          state, not a stage. */}
      {(orphanFailed.length > 0 || awaiting.length > 0) && (
        <div className="mt-3 pt-3 border-t border-border space-y-3">
          {awaiting.length > 0 && (
            <div>
              <span className="text-xs font-medium text-amber-500">
                Awaiting Human ({awaiting.length})
              </span>
              {awaiting.map((t: any) => (
                <div key={t.id} className="mt-1.5">
                  <TaskCard task={t} />
                </div>
              ))}
            </div>
          )}
          {orphanFailed.length > 0 && (
            <div>
              <span className="text-xs font-medium text-destructive">
                Failed ({orphanFailed.length})
              </span>
              <div className="space-y-1.5 mt-1.5">
                {orphanFailed.map((t: any) => (
                  <FailedCard key={t.id} task={t} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
