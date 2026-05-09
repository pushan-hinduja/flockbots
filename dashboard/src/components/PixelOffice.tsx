import { useRef, useEffect, useState, useMemo } from 'react';
import type { SystemStatus } from '../hooks/useSystemStatus';
import { useSubAgents } from '../hooks/useSubAgents';
import { useAgentCustomizations } from '../hooks/useAgentCustomizations';
import { useInstance } from '../contexts/InstanceContext';
import { loadAllSprites } from '../office/sprites';
import { createInitialState, snapAgentsToInitialPositions, startGameLoop, updateCharacters, render, isCharacterOccludedByWall, baseRoleId, type EngineState } from '../office/engine';
import { CANVAS_W, CANVAS_H, DESK_POSITIONS, WAIT_SPOTS } from '../office/layout';
import { CharState, Direction } from '../office/types';

// Fixed pixel offsets (relative to parent's desk) for up to 4 sub-agent clones.
// Spawn_idx % 4 picks the slot. These are chosen to sit next to the parent
// without landing inside wall/furniture regions (eyeballed from the layout).
const SUB_AGENT_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: -32, dy: -4 },  // left
  { dx: +32, dy: -4 },  // right
  { dx: 0,   dy: -28 }, // above
  { dx: 0,   dy: +28 }, // below
];

// Status → agent mapping. qa_pending is intentionally NOT here — during the
// post-merge deploy buffer Zara isn't working, so she shouldn't be at her desk.
// She only goes to her desk once the task transitions to qa_running.
const STATUS_MAP: Record<string, string> = {
  researching: 'pm', designing: 'ux', design_validation: 'pm', design_pending: 'ux',
  developing: 'dev', testing: 'test', review_pending: 'reviewer', reviewing: 'reviewer',
  qa_running: 'test',
  // wireframes_rendering and awaiting_design_approval are intentionally absent —
  // no agent is at their desk for either (coordinator render / human wait).
};
const ESCALATION_AGENT_MAP: Record<string, string> = {
  researching: 'pm', designing: 'ux', design_validation: 'pm',
  developing: 'dev', testing: 'test', reviewing: 'reviewer',
  qa_pending: 'test', qa_running: 'test',
};
const ACTIVITY_LABELS: Record<string, string> = {
  researching: 'Researching', designing: 'Designing', design_validation: 'Validating design',
  developing: 'Coding', reviewing: 'Reviewing PR', testing: 'Testing',
  design_pending: 'Starting design', review_pending: 'Opening PR',
  wireframes_rendering: 'Rendering wireframes', awaiting_design_approval: 'Awaiting design approval',
  qa_running: 'Verifying',
};

// When clicking Zara on a QA task, stream events/chunks come in under the
// coordinator-side agent role 'qa', not the dashboard id 'test'. Translate
// at click time so the stream modal subscribes to the right rows.
function streamAgentForClick(dashboardAgentId: string, taskStatus: string): string {
  if (dashboardAgentId === 'test' && (taskStatus === 'qa_pending' || taskStatus === 'qa_running')) {
    return 'qa';
  }
  return dashboardAgentId;
}

/**
 * Group tasks by the responsible agent, split into active (currently working)
 * and waiting (in a human-wait state). When a role has BOTH at the same time,
 * the engine renders the primary at the lounge (waiting wins) and the
 * coordinator-spawned parallel session is rendered as a separate "extra"
 * overlay at the desk via getParallelExtras / ExtraAgent.
 */
function classifyTaskByAgent(t: any): { agentId: string | null; bucket: 'active' | 'waiting' | null } {
  if (t.status === 'awaiting_human') {
    let prev = '';
    try { prev = JSON.parse(t.error)?.previous_status || ''; } catch {}
    return { agentId: ESCALATION_AGENT_MAP[prev] || 'pm', bucket: 'waiting' };
  }
  if (t.status === 'awaiting_design_approval') return { agentId: 'ux', bucket: 'waiting' };
  if (t.status === 'epic_awaiting_approval') return { agentId: 'pm', bucket: 'waiting' };
  const a = STATUS_MAP[t.status];
  if (a) return { agentId: a, bucket: 'active' };
  return { agentId: null, bucket: null };
}

function getAgentSets(tasks: any[]): { active: Set<string>; waiting: Set<string> } {
  const active = new Set<string>(), waiting = new Set<string>();
  for (const t of tasks) {
    const { agentId, bucket } = classifyTaskByAgent(t);
    if (!agentId || !bucket) continue;
    if (bucket === 'waiting') waiting.add(agentId);
    else active.add(agentId);
  }
  // When both: primary character goes to lounge (waiting wins). The active
  // session is rendered via getParallelExtras as a duplicate at the desk.
  for (const id of waiting) active.delete(id);
  return { active, waiting };
}

interface ParallelExtra {
  agentId: string;
  taskId: string;
  taskTitle: string;
  taskStatus: string;
}

/**
 * When a role has BOTH a waiting task AND an active task in flight, the
 * coordinator has spawned a parallel session: the original is blocked on
 * human input, but the agent picked up the next inbox task while waiting.
 * Surface that as an additional character ("<Name> 2") at the desk so the
 * office matches reality — without this, the dashboard would show the
 * primary stuck at the lounge while the streaming view shows code being
 * written.
 *
 * Bounded to one extra per role (per-agent locks prevent multi-active for
 * the same role; stacked-waiting isn't visualized in v1 — only the count
 * in the in-page escalation banner (mc-esc) conveys it).
 */
function getParallelExtras(tasks: any[]): ParallelExtra[] {
  const activeByRole: Record<string, any[]> = {};
  const waitingByRole: Record<string, any[]> = {};
  for (const t of tasks) {
    const { agentId, bucket } = classifyTaskByAgent(t);
    if (!agentId || !bucket) continue;
    const dst = bucket === 'waiting' ? waitingByRole : activeByRole;
    (dst[agentId] = dst[agentId] || []).push(t);
  }
  const extras: ParallelExtra[] = [];
  for (const role of Object.keys(activeByRole)) {
    if (!(waitingByRole[role] || []).length) continue;
    const activeTask = activeByRole[role][0];
    extras.push({
      agentId: role,
      taskId: activeTask.id,
      taskTitle: activeTask.title,
      taskStatus: activeTask.status,
    });
  }
  return extras;
}

// How long an exiting extra is kept around walking to the lounge before we
// delete its character entry. Tuned to give the agent enough time to traverse
// the office at WALK_SPEED without leaving an idle ghost sitting in the
// lounge for too long.
const EXTRA_DESPAWN_MS = 8000;

interface ExtraLifecycle {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  state: 'working' | 'exiting';
  /** Set when state transitions to 'exiting'; despawn timer is offset from this. */
  exitingSince?: number;
}

const synthId = (role: string) => `${role}:2`;

function getActivityLabels(tasks: any[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const t of tasks) {
    const agent = STATUS_MAP[t.status];
    if (agent && ACTIVITY_LABELS[t.status]) labels[agent] = ACTIVITY_LABELS[t.status];
  }
  return labels;
}

// ===== COMPONENT =====
interface PixelOfficeProps {
  tasks: any[];
  tasksLoaded: boolean;
  systemStatus: SystemStatus;
  onAgentClick?: (agentId: string, taskId: string, taskTitle: string) => void;
  bare?: boolean;
}

export function PixelOffice({ tasks, tasksLoaded, systemStatus, onAgentClick, bare = false }: PixelOfficeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<EngineState | null>(null);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const statusRef = useRef(systemStatus);
  statusRef.current = systemStatus;
  const tagRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [loaded, setLoaded] = useState(false);

  // Active sub-agents (swarm visualization). Render as small pills next to
  // the parent's desk using CSS absolute positioning — no engine integration
  // needed because they're ephemeral and don't pathfind.
  const subAgents = useSubAgents();

  // Merged agent config — names + sprite rows reflect user customizations.
  // Used for overlay labels, legend, and propagated into engine state so the
  // canvas re-renders with new sprites on change.
  const { agents: AGENTS, byId: agentsById } = useAgentCustomizations();

  // Parallel extras: when a role has both an active task and a waiting task
  // (the coordinator picked up the next inbox item while the original task
  // is blocked on human input), spawn a duplicate "<Name> 2" engine character
  // that walks from the lounge to the desk, works there, and walks back to
  // the lounge to despawn when the parallel session ends.
  const parallelExtras = useMemo(() => getParallelExtras(tasks), [tasks]);
  const lifecyclesRef = useRef<Map<string, ExtraLifecycle>>(new Map());
  const [extraIds, setExtraIds] = useState<string[]>([]);

  // When customizations change OR the engine finishes initializing, mutate
  // existing characters in-place so the next render frame picks up the new
  // sprite rows / name. The `loaded` dep handles the race where AGENTS
  // resolves before engine init.
  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    for (const a of AGENTS) {
      const ch = state.characters.get(a.id);
      if (ch) {
        ch.name = a.name;
        ch.role = a.role;
        ch.bodyRow = a.bodyRow;
        ch.hairRow = a.hairRow;
        ch.suitRow = a.suitRow;
      }
    }
  }, [AGENTS, loaded]);


  // Initialize engine once tasks have loaded so active agents start at their
  // desks. Two cases also force a snap-to-initial-positions on existing
  // state without re-creating it:
  //   1. Hard refresh race — useTaskPipeline emits (tasksLoaded=true, tasks=[])
  //      briefly before the fetch resolves, so the very first init may run
  //      with an empty active set. When real data arrives, we snap.
  //   2. Instance switch — engine state carries over from the previous
  //      instance; the new active agents need to appear at their desks
  //      immediately, not walk over from the old positions.
  // Live transitions (a task starts mid-session in the SAME instance with
  // populated data) bypass this and flow through the game loop's normal
  // walk-to-desk animation.
  const { selectedInstance } = useInstance();
  const lastSnapKeyRef = useRef<string>('');
  useEffect(() => {
    if (!tasksLoaded) return;

    const { active, waiting } = getAgentSets(tasks);
    const dataPresent = active.size > 0 || waiting.size > 0;

    if (!stateRef.current) {
      // First-ever init for this mount.
      const state = createInitialState(active, waiting);
      stateRef.current = state;
      lastSnapKeyRef.current = `${selectedInstance}|${dataPresent ? 'data' : 'empty'}`;

      loadAllSprites().then((sprites) => {
        state.sprites = sprites;
        setLoaded(true);
      }).catch(err => {
        console.error('Failed to load sprites:', err);
        setLoaded(true); // Still show with fallback colors
      });
      return;
    }

    // We already have engine state — snap on instance switch or first-data
    // arrival, leave alone otherwise so live transitions still animate.
    const [prevInstance, prevDataMarker] = lastSnapKeyRef.current.split('|');
    const instanceChanged = prevInstance !== String(selectedInstance);
    const firstDataForInstance = prevDataMarker === 'empty' && dataPresent;

    if (instanceChanged || firstDataForInstance) {
      snapAgentsToInitialPositions(stateRef.current, active, waiting);
      lastSnapKeyRef.current = `${selectedInstance}|${dataPresent ? 'data' : 'empty'}`;
    }
  }, [tasksLoaded, tasks, selectedInstance]);

  // Parallel-extras lifecycle: spawn new ones, mark vanished ones as exiting.
  // Spawning inserts a fresh engine character at the primary's lounge spot
  // ("right in front of" the waiting agent) — the engine then walks it to
  // the role's desk via the active-set membership wired in startGameLoop.
  useEffect(() => {
    if (!loaded) return;
    const state = stateRef.current;
    if (!state) return;

    const desired = new Map<string, typeof parallelExtras[number]>();
    for (const ex of parallelExtras) desired.set(ex.agentId, ex);
    const lifecycles = lifecyclesRef.current;

    let listChanged = false;

    // Spawn new extras OR refresh task association on existing ones.
    for (const [role, ex] of desired) {
      const id = synthId(role);
      const existing = lifecycles.get(role);
      if (!existing) {
        const baseAgent = agentsById[role];
        const primary = state.characters.get(role);
        if (!baseAgent) continue;
        // Spawn position: "right in front of" the waiting primary's lounge
        // chair. If the primary isn't in a wait spot for some reason, fall
        // back to its current position so the extra appears next to it.
        const spawnAt = primary && primary.waitSpotIdx >= 0
          ? { x: WAIT_SPOTS[primary.waitSpotIdx].x, y: WAIT_SPOTS[primary.waitSpotIdx].y + 24 }
          : primary
            ? { x: primary.x, y: primary.y + 8 }
            : { x: WAIT_SPOTS[0].x, y: WAIT_SPOTS[0].y + 24 };

        state.characters.set(id, {
          id,
          name: `${baseAgent.name} 2`,
          role: baseAgent.role,
          bodyRow: baseAgent.bodyRow,
          hairRow: baseAgent.hairRow,
          suitRow: baseAgent.suitRow,
          x: spawnAt.x,
          y: spawnAt.y,
          state: CharState.IDLE,
          dir: Direction.DOWN,
          animTimer: 0,
          animFrame: 0,
          path: [],
          pathIdx: 0,
          idleSpot: -1,
          idleTimer: 0,
          wanderCount: 0,
          pingPongCooldown: 0,
          blockedTimer: 0,
          waitSpotIdx: -1,
        });
        lifecycles.set(role, {
          taskId: ex.taskId,
          taskTitle: ex.taskTitle,
          taskStatus: ex.taskStatus,
          state: 'working',
        });
        listChanged = true;
      } else {
        // Update task association; if it was exiting (rare — would mean a new
        // active task arrived during the despawn window), revive to working.
        existing.taskId = ex.taskId;
        existing.taskTitle = ex.taskTitle;
        existing.taskStatus = ex.taskStatus;
        if (existing.state === 'exiting') {
          existing.state = 'working';
          existing.exitingSince = undefined;
        }
      }
    }

    // Mark vanished extras as exiting. Don't remove from state.characters
    // yet — the despawn timer effect handles deletion after the agent has
    // had time to walk to the lounge.
    for (const [role, lc] of lifecycles) {
      if (!desired.has(role) && lc.state === 'working') {
        lc.state = 'exiting';
        lc.exitingSince = Date.now();
      }
    }

    if (listChanged) {
      setExtraIds(Array.from(lifecycles.keys()).map(synthId));
    }
  }, [parallelExtras, agentsById, loaded]);

  // Despawn timer — remove exiting extras after their walk-to-lounge window.
  useEffect(() => {
    const interval = setInterval(() => {
      const state = stateRef.current;
      if (!state) return;
      const lifecycles = lifecyclesRef.current;
      let removed = false;
      const now = Date.now();
      for (const [role, lc] of lifecycles) {
        if (lc.state !== 'exiting' || !lc.exitingSince) continue;
        if (now - lc.exitingSince < EXTRA_DESPAWN_MS) continue;
        const id = synthId(role);
        state.characters.delete(id);
        lifecycles.delete(role);
        delete tagRefs.current[id];
        removed = true;
      }
      if (removed) {
        setExtraIds(Array.from(lifecycles.keys()).map(synthId));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Game loop
  useEffect(() => {
    if (!loaded || !canvasRef.current || !stateRef.current) return;
    const canvas = canvasRef.current;
    const state = stateRef.current;

    // Augment active/waiting with parallel-extras synth IDs. 'working' extras
    // route to active (engine walks them to the role's desk); 'exiting' route
    // to waiting (engine walks them to the lounge before they despawn).
    const cleanup = startGameLoop(
      canvas,
      state,
      () => {
        const set = new Set(getAgentSets(tasksRef.current).active);
        for (const [role, lc] of lifecyclesRef.current) {
          if (lc.state === 'working') set.add(synthId(role));
        }
        return set;
      },
      () => {
        const set = new Set(getAgentSets(tasksRef.current).waiting);
        for (const [role, lc] of lifecyclesRef.current) {
          if (lc.state === 'exiting') set.add(synthId(role));
        }
        return set;
      },
      () => statusRef.current === 'offline',
    );

    // Overlay position update loop
    let overlayId: number;
    function updateOverlays() {
      if (!canvas || !state) { overlayId = requestAnimationFrame(updateOverlays); return; }
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width / CANVAS_W;
      const sy = rect.height / CANVAS_H;
      const isOffline = statusRef.current === 'offline';
      const { active: baseActive, waiting: baseWaiting } = getAgentSets(tasksRef.current);
      const activities = getActivityLabels(tasksRef.current);
      const lifecycles = lifecyclesRef.current;

      // Helper: position + style a tag for either a base agent or an extra.
      // Extras share their base role's activity label but their own
      // active-set membership for the spinning-up indicator.
      const updateTag = (charId: string, isExtra: boolean) => {
        const ch = state.characters.get(charId);
        const el = tagRefs.current[charId];
        if (!ch || !el) return;
        if (isOffline) { el.style.display = 'none'; return; }
        if (isCharacterOccludedByWall(ch.x, ch.y)) { el.style.display = 'none'; return; }

        el.style.display = '';
        el.style.left = `${ch.x * sx}px`;
        el.style.top = `${(ch.y - 20) * sy}px`;

        const role = baseRoleId(charId);
        const lcState = isExtra ? lifecycles.get(role)?.state : null;
        const isActiveForChar = isExtra
          ? lcState === 'working'
          : baseActive.has(charId);
        const isSpinningUp = isActiveForChar && ch.state === CharState.WALK;

        if (ch.state === CharState.WORK) {
          el.style.backgroundColor = 'rgba(52,148,92,0.92)';
          el.style.cursor = 'pointer';
          el.style.pointerEvents = 'auto';
        } else if (isSpinningUp) {
          el.style.backgroundColor = 'rgba(52,148,92,0.55)';
          el.style.cursor = 'default';
          el.style.pointerEvents = 'none';
        } else if (ch.state === CharState.WAIT || ch.state === CharState.WALK_TO_WAIT) {
          el.style.backgroundColor = 'rgba(220,160,40,0.92)';
          el.style.cursor = 'default';
          el.style.pointerEvents = 'none';
        } else {
          el.style.backgroundColor = 'rgba(30,30,45,0.85)';
          el.style.cursor = 'default';
          el.style.pointerEvents = 'none';
        }

        const actEl = el.querySelector('[data-activity]') as HTMLElement | null;
        if (actEl) {
          let label = '';
          if (isExtra) {
            const lc = lifecycles.get(role);
            if (isSpinningUp) label = 'Starting...';
            else if (ch.state === CharState.WORK && lc) label = ACTIVITY_LABELS[lc.taskStatus] || '';
            else if (ch.state === CharState.WALK_TO_WAIT || ch.state === CharState.WAIT) label = 'Wrapping up';
          } else {
            label = isSpinningUp ? 'Starting...' : (activities[charId] || '');
          }
          actEl.textContent = label;
          actEl.style.display = label ? '' : 'none';
        }
      };

      for (const def of AGENTS) updateTag(def.id, false);
      for (const id of Object.keys(tagRefs.current)) {
        if (id.includes(':')) updateTag(id, true);
      }
      // baseActive / baseWaiting referenced for typing — keep the references
      // alive so future contributors don't accidentally drop the augmented
      // wiring above.
      void baseWaiting;
      overlayId = requestAnimationFrame(updateOverlays);
    }
    overlayId = requestAnimationFrame(updateOverlays);

    return () => {
      cleanup();
      cancelAnimationFrame(overlayId);
    };
  }, [loaded]);

  const canvasBox = (
    <div
      style={bare ? {
        position: 'relative',
        aspectRatio: `${CANVAS_W} / ${CANVAS_H}`,
        width: '100%',
        maxHeight: '100%',
        margin: 'auto',
        overflow: 'hidden',
      } : { position: 'relative', overflow: 'hidden', width: '100%' }}
    >
      {!loaded && (
        <div className="flex items-center justify-center py-20">
          <span className="text-sm text-muted-foreground">Loading office...</span>
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        style={bare ? {
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated',
          borderRadius: '18px',
          display: loaded ? 'block' : 'none',
        } : {
          width: '100%',
          imageRendering: 'pixelated',
          borderRadius: '8px',
          display: loaded ? 'block' : 'none',
        }}
      />
      {loaded && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
          {AGENTS.map(a => (
            <div
              key={a.id}
              ref={el => { tagRefs.current[a.id] = el; }}
              onClick={() => {
                if (!onAgentClick) return;
                const activeTask = tasks.find((t: any) => STATUS_MAP[t.status] === a.id);
                if (activeTask) {
                  const streamId = streamAgentForClick(a.id, activeTask.status);
                  onAgentClick(streamId, activeTask.id, activeTask.title);
                }
              }}
              className="absolute text-[9px] font-medium px-1.5 py-0.5 rounded-md text-white whitespace-nowrap shadow-sm hover:brightness-110 transition-all"
              style={{ transform: 'translate(-50%, -100%)', transition: 'left 0.05s linear, top 0.05s linear' }}
            >
              <div>{a.name} <span className="opacity-70">· {a.role}</span></div>
              <div data-activity className="text-[8px] opacity-80 text-center" style={{ display: 'none' }} />
            </div>
          ))}

          {/* Sub-agent clones — render as small pills next to parent's desk.
              Positioned via percentage coords so they scale with canvas. */}
          {subAgents.map(sa => {
            const desk = DESK_POSITIONS[sa.parent_agent];
            if (!desk) return null;
            const off = SUB_AGENT_OFFSETS[sa.spawn_idx % SUB_AGENT_OFFSETS.length];
            const leftPct = ((desk.x + off.dx) / CANVAS_W) * 100;
            const topPct = ((desk.y + off.dy) / CANVAS_H) * 100;
            return (
              <div
                key={sa.tool_use_id}
                className="absolute text-[8px] font-medium px-1 py-0.5 rounded text-white whitespace-nowrap animate-in fade-in zoom-in-95 duration-200"
                style={{
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  transform: 'translate(-50%, -50%)',
                  backgroundColor: 'rgba(120,72,168,0.85)', // purple — distinct from work/wait states
                  boxShadow: '0 0 4px rgba(120,72,168,0.6)',
                }}
              >
                {sa.sub_name}
              </div>
            );
          })}

          {/* Parallel-extras label tags. The actual sprite is rendered by
              the engine on the canvas (real character with pathfinding); the
              tag here just floats above it and follows it as it moves, same
              as the base agent tags above. */}
          {extraIds.map(id => {
            const role = baseRoleId(id);
            const baseAgent = agentsById[role];
            if (!baseAgent) return null;
            return (
              <div
                key={id}
                ref={el => { tagRefs.current[id] = el; }}
                onClick={() => {
                  if (!onAgentClick) return;
                  const lc = lifecyclesRef.current.get(role);
                  if (!lc || lc.state !== 'working') return;
                  const streamId = streamAgentForClick(role, lc.taskStatus);
                  onAgentClick(streamId, lc.taskId, lc.taskTitle);
                }}
                className="absolute text-[9px] font-medium px-1.5 py-0.5 rounded-md text-white whitespace-nowrap shadow-sm hover:brightness-110 transition-all"
                style={{ transform: 'translate(-50%, -100%)', transition: 'left 0.05s linear, top 0.05s linear' }}
              >
                <div>{baseAgent.name} 2 <span className="opacity-70">· {baseAgent.role}</span></div>
                <div data-activity className="text-[8px] opacity-80 text-center" style={{ display: 'none' }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const canvasArea = bare ? (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    }}>{canvasBox}</div>
  ) : canvasBox;

  if (bare) return canvasArea;

  return (
    <div className="bg-card border border-border rounded-2xl p-4 overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground">Office</h2>
          {systemStatus === 'offline' && (
            <span className="text-[10px] text-muted-foreground/60 px-1.5 py-0.5 bg-secondary rounded">offline</span>
          )}
        </div>
        {systemStatus !== 'offline' && (
          <div className="flex items-center gap-3 flex-wrap">
            {AGENTS.map((a, i) => (
              <div key={a.id} className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{
                  backgroundColor: ['#7848A8', '#E068A0', '#4878B8', '#48A868', '#D08838'][i]
                }} />
                <span className="text-[10px] text-muted-foreground">{a.name} <span className="opacity-60">({a.role})</span></span>
              </div>
            ))}
          </div>
        )}
      </div>

      {canvasArea}
    </div>
  );
}
