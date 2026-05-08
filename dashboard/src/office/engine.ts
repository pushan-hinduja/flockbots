import { Direction, CharState, type Character, type Vec2 } from './types';
import { drawCharacter, drawFurniture, drawSprite, FRAME_SIZE } from './sprites';
import { findPath } from './pathfinding';
import {
  TILE_SIZE, GRID_COLS, GRID_ROWS, CANVAS_W, CANVAS_H,
  TILE_GRID, DESK_POSITIONS, WAIT_SPOTS, IDLE_SPOTS, PING_PONG_TABLE, PING_PONG_SPOTS,
  FURNITURE_BLOCKED, SEAT_TILES,
} from './layout';

const WALK_SPEED = 90; // pixels per second
const WALK_FRAME_DUR = 0.15; // seconds per walk frame
const IDLE_MIN = 10; // min seconds before wandering
const IDLE_MAX = 30;
const MAX_DT = 0.1; // cap delta time
const PING_PONG_PLAY_MAX = 7;
const PING_PONG_COOLDOWN = 18;

const WALL_STYLE = {
  fill: '#e8e6e0',
  shade: '#cfccc4',
  line: '#3f3835',
};

const WALL_DIMENSIONS = {
  backHeight: 38,
  dividerWidth: 12,
  outerWidth: 12,
  connectionOffset: 8,
  bottomWallHeight: 12,
};

const OFFICE_DECOR_SLICES = {
  waterCooler: { srcX: 288, srcY: 22, srcW: 24, srcH: 58 },
  vendingMachine: { srcX: 458, srcY: 16, srcW: 46, srcH: 64 },
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WallLayout {
  topH: number;
  dividerW: number;
  outerW: number;
  connectionOffset: number;
  bottomH: number;
  bottomY: number;
  mainDividerX: number;
  recDividerY: number;
  kitchenOpeningTopY: number;
  kitchenOpeningBottomY: number;
  recLeftStart: number;
  recRoomInnerLeftX: number;
  recRoomInnerRightX: number;
  kitchenRecOpeningWidth: number;
  kitchenRecOpeningCenterX: number;
  kitchenRecOpeningX: number;
  recRightStart: number;
  recRightWidth: number;
  recOpeningTopY: number;
  recOpeningBottomY: number;
}

function getWallLayout(): WallLayout {
  const topH = WALL_DIMENSIONS.backHeight;
  const dividerW = WALL_DIMENSIONS.dividerWidth;
  const outerW = WALL_DIMENSIONS.outerWidth;
  const connectionOffset = WALL_DIMENSIONS.connectionOffset;
  const bottomH = WALL_DIMENSIONS.bottomWallHeight;
  const bottomY = CANVAS_H - bottomH;
  const mainDividerX = 15 * TILE_SIZE - dividerW;
  const recDividerY = 7 * TILE_SIZE;

  // Match the kitchen opening to the appliance run: start right below the vending machine.
  const kitchenOpeningTopY = 3 * TILE_SIZE;
  const kitchenOpeningBottomY = 5 * TILE_SIZE - connectionOffset;
  const openingHeight = kitchenOpeningBottomY - kitchenOpeningTopY;

  const recLeftStart = mainDividerX;
  const recRoomInnerLeftX = mainDividerX + dividerW - 2;
  const recRoomInnerRightX = CANVAS_W - outerW;
  const kitchenRecOpeningWidth = 2 * TILE_SIZE;
  const kitchenRecOpeningCenterX = (recRoomInnerLeftX + recRoomInnerRightX) / 2;
  const kitchenRecOpeningX = Math.round(kitchenRecOpeningCenterX - kitchenRecOpeningWidth / 2);
  const recRightStart = kitchenRecOpeningX + kitchenRecOpeningWidth;
  const recRightWidth = CANVAS_W - dividerW - recRightStart;
  const recOpeningTopY = Math.round(recDividerY + (bottomY - recDividerY - openingHeight) / 2);
  const recOpeningBottomY = recOpeningTopY + openingHeight;

  return {
    topH,
    dividerW,
    outerW,
    connectionOffset,
    bottomH,
    bottomY,
    mainDividerX,
    recDividerY,
    kitchenOpeningTopY,
    kitchenOpeningBottomY,
    recLeftStart,
    recRoomInnerLeftX,
    recRoomInnerRightX,
    kitchenRecOpeningWidth,
    kitchenRecOpeningCenterX,
    kitchenRecOpeningX,
    recRightStart,
    recRightWidth,
    recOpeningTopY,
    recOpeningBottomY,
  };
}

// Agent definitions with sprite parameters
export const AGENT_DEFS = [
  { id: 'pm',       name: 'George', role: 'PM',     bodyRow: 2, hairRow: 4, suitRow: 2 },
  { id: 'ux',       name: 'Luna',   role: 'Design', bodyRow: 1, hairRow: 2, suitRow: 1 },
  { id: 'dev',      name: 'Enzo',   role: 'Dev',    bodyRow: 0, hairRow: 7, suitRow: 3 },
  { id: 'test',     name: 'Zara',   role: 'QA',     bodyRow: 0, hairRow: 0, suitRow: 0 },
  { id: 'reviewer', name: 'Oscar',  role: 'Review', bodyRow: 3, hairRow: 3, suitRow: 3 },
];

/**
 * Resolve a (possibly synthetic) character id to its base role id. Synthetic
 * ids of the form `<role>:<n>` are used for parallel-session extras spawned
 * by the React layer when the primary is stuck in a wait state and the
 * coordinator picks up another task. They share the role's desk + work
 * direction with the primary.
 */
export function baseRoleId(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(0, idx) : id;
}

const WORK_DIRECTIONS: Record<string, Direction> = {
  pm: Direction.UP,
  ux: Direction.UP,
  reviewer: Direction.UP,
  dev: Direction.DOWN,
  test: Direction.DOWN,
};

export interface EngineState {
  characters: Map<string, Character>;
  sprites: Map<string, HTMLImageElement>;
  claimed: Set<number>;
  handoff: { from: string; to: string; phase: string; timer: number } | null;
}

/** Pick the next unclaimed lounge-wait spot (and record it as taken). Falls
 *  back to spot 0 if every spot is already claimed — only possible when more
 *  agents are waiting than there are spots, which is extremely unlikely in
 *  practice but needs a safe fallback so we always return a valid index. */
function pickUnclaimedWaitSpot(taken: Set<number>): number {
  for (let i = 0; i < WAIT_SPOTS.length; i++) {
    if (!taken.has(i)) {
      taken.add(i);
      return i;
    }
  }
  return 0;
}

/** Pick an unused spawn tile, preferring ones at least a tile away from every
 *  previously-chosen spawn so agents don't overlap on load. */
function pickRandomSpawn(tiles: Vec2[], usedKeys: Set<string>): Vec2 {
  if (tiles.length === 0) return { x: TILE_SIZE * 2, y: TILE_SIZE * 2 };
  const unused = tiles.filter((t) => !usedKeys.has(`${Math.floor(t.x / TILE_SIZE)},${Math.floor(t.y / TILE_SIZE)}`));
  const pool = unused.length > 0 ? unused : tiles;
  const choice = pool[Math.floor(Math.random() * pool.length)];
  usedKeys.add(`${Math.floor(choice.x / TILE_SIZE)},${Math.floor(choice.y / TILE_SIZE)}`);
  return choice;
}

/** Walkable tiles reachable from an anchor in the main workspace. Used once
 *  at startup to place idle agents in a random spot each time the office
 *  loads, instead of always spawning them at the same predefined IDLE_SPOTS. */
function computeInitialSpawnTiles(): Vec2[] {
  // BFS across walkable non-seat tiles from a known-reachable tile near the
  // workspace entrance. Using BFS (rather than a raw scan) keeps agents out of
  // furniture-walled pockets like the cols 6–8 rows 6–7 island.
  const anchorCol = 1, anchorRow = 2;
  const visited = new Set<string>();
  const tiles: Vec2[] = [];
  const queue: Array<[number, number]> = [[anchorCol, anchorRow]];
  visited.add(`${anchorCol},${anchorRow}`);
  const dirs: Array<[number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]];

  while (queue.length > 0) {
    const [c, r] = queue.shift()!;
    const k = `${c},${r}`;
    // Skip seat tiles as spawn candidates — chairs should be occupied by
    // sitting, not just standing on.
    if (!SEAT_TILES.has(k)) {
      tiles.push({
        x: c * TILE_SIZE + TILE_SIZE / 2,
        y: r * TILE_SIZE + TILE_SIZE / 2,
      });
    }
    for (const [dc, dr] of dirs) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      const nk = `${nc},${nr}`;
      if (visited.has(nk)) continue;
      if (TILE_GRID[nr][nc] === 1) continue;
      if (FURNITURE_BLOCKED.has(nk)) continue;
      visited.add(nk);
      queue.push([nc, nr]);
    }
  }
  return tiles;
}

/**
 * Snap existing characters to positions consistent with the current
 * active/waiting sets, *without* the walk-to-desk animation. Used when
 * the office state is stale relative to the underlying task data —
 * specifically:
 *
 *   - Hard refresh / first data arrival: useTaskPipeline emits an
 *     intermediate (tasksLoaded=true, tasks=[]) state before the fetch
 *     resolves, so the initial state was created with an empty active
 *     set and every agent is at a random idle spawn.
 *   - Instance switch: engine state carries over from the previous
 *     instance, but the new instance's active agents should appear at
 *     their desks immediately, not walk over from wherever the old
 *     instance left them.
 *
 * Idle agents are left in place (so they don't teleport mid-wander).
 * Stale WORK/WAIT states are dropped to IDLE so the live loop picks
 * them up naturally.
 */
export function snapAgentsToInitialPositions(
  state: EngineState,
  activeAgents: Set<string>,
  waitingAgents: Set<string>,
): void {
  const takenWaitSpots = new Set<number>();

  for (const [id, ch] of state.characters) {
    const isActive = activeAgents.has(id);
    const isWaiting = waitingAgents.has(id);
    const role = baseRoleId(id);
    const deskPos = DESK_POSITIONS[role];

    if (isActive && deskPos) {
      ch.x = deskPos.x;
      ch.y = deskPos.y;
      ch.state = CharState.WORK;
      ch.dir = WORK_DIRECTIONS[role] ?? Direction.UP;
      ch.path = [];
      ch.pathIdx = 0;
      ch.animFrame = 0;
      ch.animTimer = 0;
      ch.blockedTimer = 0;
      ch.idleSpot = -1;
      ch.waitSpotIdx = -1;
    } else if (isWaiting) {
      const waitSpotIdx = pickUnclaimedWaitSpot(takenWaitSpots);
      const ws = WAIT_SPOTS[waitSpotIdx];
      ch.x = ws.x;
      ch.y = ws.y;
      ch.state = CharState.WAIT;
      ch.dir = Direction.DOWN;
      ch.path = [];
      ch.pathIdx = 0;
      ch.animFrame = 0;
      ch.animTimer = 0;
      ch.blockedTimer = 0;
      ch.idleSpot = -1;
      ch.waitSpotIdx = waitSpotIdx;
    } else if (ch.state === CharState.WORK || ch.state === CharState.WAIT) {
      // Stale work/wait state from the previous instance — drop to idle
      // in place. The live loop will start a wander when idleTimer expires.
      ch.state = CharState.IDLE;
      ch.idleTimer = 0;
      ch.path = [];
      ch.pathIdx = 0;
      ch.animFrame = 0;
      ch.animTimer = 0;
      ch.waitSpotIdx = -1;
      ch.idleSpot = -1;
    }
  }
}

export function createInitialState(
  activeAgents?: Set<string>,
  waitingAgents?: Set<string>,
): EngineState {
  const characters = new Map<string, Character>();
  const claimed = new Set<number>();
  const spawnTiles = computeInitialSpawnTiles();
  const usedSpawnKeys = new Set<string>();

  const takenWaitSpots = new Set<number>();
  AGENT_DEFS.forEach((def) => {
    const deskPos = DESK_POSITIONS[def.id];
    const isActive = activeAgents?.has(def.id) && deskPos;
    const isWaiting = waitingAgents?.has(def.id);

    if (isActive) {
      // Agent is already working — start them at their desk
      characters.set(def.id, {
        id: def.id, name: def.name, role: def.role,
        bodyRow: def.bodyRow, hairRow: def.hairRow, suitRow: def.suitRow,
        x: deskPos.x, y: deskPos.y,
        state: CharState.WORK,
        dir: WORK_DIRECTIONS[def.id] ?? Direction.UP,
        animTimer: 0, animFrame: 0,
        path: [], pathIdx: 0,
        idleSpot: -1,
        idleTimer: 0,
        wanderCount: 0,
        pingPongCooldown: 0,
        blockedTimer: 0,
        waitSpotIdx: -1,
      });
    } else if (isWaiting) {
      // Agent is waiting — start them at an unclaimed lounge spot. If all 4
      // wait spots are somehow taken (5+ waiting agents), fall back to spot 0
      // and let the live update loop sort out duplicates.
      const waitSpotIdx = pickUnclaimedWaitSpot(takenWaitSpots);
      const ws = WAIT_SPOTS[waitSpotIdx];
      characters.set(def.id, {
        id: def.id, name: def.name, role: def.role,
        bodyRow: def.bodyRow, hairRow: def.hairRow, suitRow: def.suitRow,
        x: ws.x, y: ws.y,
        state: CharState.WAIT,
        dir: Direction.DOWN,
        animTimer: 0, animFrame: 0,
        path: [], pathIdx: 0,
        idleSpot: -1,
        idleTimer: 0,
        wanderCount: 0,
        pingPongCooldown: 0,
        blockedTimer: 0,
        waitSpotIdx,
      });
    } else {
      // Idle — spawn at a random reachable tile so the office doesn't always
      // load with agents in the same corner. Working/waiting agents keep
      // their deterministic placements so the dashboard still shows them in
      // the right role-specific spot.
      const spot = pickRandomSpawn(spawnTiles, usedSpawnKeys);
      characters.set(def.id, {
        id: def.id, name: def.name, role: def.role,
        bodyRow: def.bodyRow, hairRow: def.hairRow, suitRow: def.suitRow,
        x: spot.x, y: spot.y,
        state: CharState.IDLE,
        dir: [Direction.DOWN, Direction.UP, Direction.LEFT, Direction.RIGHT][Math.floor(Math.random() * 4)],
        animTimer: 0, animFrame: 0,
        path: [], pathIdx: 0,
        idleSpot: -1,
        idleTimer: IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN),
        wanderCount: 0,
        pingPongCooldown: 0,
        blockedTimer: 0,
        waitSpotIdx: -1,
      });
    }
  });

  return { characters, sprites: new Map(), claimed, handoff: null };
}

/** Destination an agent heads to when idle.
 *  `idleSpot >= 0` means it's one of the predefined social spots (chair, ping-pong)
 *  that must be claimed so no two agents target it. `idleSpot === -1` means it's a
 *  free-tile wander target with no claim. */
interface WanderTarget { dest: Vec2; idleSpot: number }

const BFS_DIRS: Array<[number, number]> = [[0, -1], [0, 1], [-1, 0], [1, 0]];

/** BFS over the walkable grid (floor tiles not furniture-blocked).
 *  Returns every tile reachable from the seed tiles along unblocked edges. */
function bfsReachable(seeds: Array<[number, number]>): Vec2[] {
  const visited = new Set<string>();
  const queue: Array<[number, number]> = [];
  for (const [c, r] of seeds) {
    const k = `${c},${r}`;
    if (visited.has(k)) continue;
    visited.add(k);
    queue.push([c, r]);
  }

  const tiles: Vec2[] = [];
  while (queue.length > 0) {
    const [c, r] = queue.shift()!;
    tiles.push({
      x: c * TILE_SIZE + TILE_SIZE / 2,
      y: r * TILE_SIZE + TILE_SIZE / 2,
    });

    for (const [dc, dr] of BFS_DIRS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
      const k = `${nc},${nr}`;
      if (visited.has(k)) continue;
      if (TILE_GRID[nr][nc] === 1) continue;                // wall
      if (FURNITURE_BLOCKED.has(k)) continue;               // furniture (including chair tiles)
      visited.add(k);
      queue.push([nc, nr]);
    }
  }
  return tiles;
}

/** Compute tiles reachable from an agent's current position.
 *
 *  An agent standing on a blocked tile (e.g., sitting on a chair) is treated
 *  specially: chair tiles only participate in pathfinding as a destination, so
 *  we avoid seeding BFS through them. Instead we BFS from each unblocked
 *  neighbor separately and keep the largest connected region — that prevents
 *  an agent from escaping into a furniture-isolated pocket (like the
 *  cols 6–8 rows 6–7 island between the workstation desks). */
function reachableTilesFrom(startX: number, startY: number): Vec2[] {
  const startCol = Math.floor(startX / TILE_SIZE);
  const startRow = Math.floor(startY / TILE_SIZE);
  if (
    startCol < 0 || startCol >= GRID_COLS ||
    startRow < 0 || startRow >= GRID_ROWS ||
    TILE_GRID[startRow][startCol] === 1
  ) {
    return [];
  }

  const startKey = `${startCol},${startRow}`;
  if (!FURNITURE_BLOCKED.has(startKey)) {
    return bfsReachable([[startCol, startRow]]);
  }

  // Blocked start (chair): BFS from each unblocked neighbor in isolation and
  // keep the largest region — that is the "main office" area connected to the
  // seat, not any furniture-walled pocket.
  let best: Vec2[] = [];
  for (const [dc, dr] of BFS_DIRS) {
    const nc = startCol + dc;
    const nr = startRow + dr;
    if (nc < 0 || nc >= GRID_COLS || nr < 0 || nr >= GRID_ROWS) continue;
    if (TILE_GRID[nr][nc] === 1) continue;
    const k = `${nc},${nr}`;
    if (FURNITURE_BLOCKED.has(k)) continue;
    const region = bfsReachable([[nc, nr]]);
    if (region.length > best.length) best = region;
  }
  return best;
}

function pickFreeTileWanderTarget(ch: Character): Vec2 | null {
  const curCol = Math.floor(ch.x / TILE_SIZE);
  const curRow = Math.floor(ch.y / TILE_SIZE);
  const candidates = reachableTilesFrom(ch.x, ch.y).filter((tile) => {
    const col = Math.floor(tile.x / TILE_SIZE);
    const row = Math.floor(tile.y / TILE_SIZE);
    if (SEAT_TILES.has(`${col},${row}`)) return false;      // seats are destination-only via social picks
    if (col === curCol && row === curRow) return false;     // don't pick the current tile
    // Give preference to tiles at least a couple tiles away so walks feel intentional.
    const dist = Math.abs(col - curCol) + Math.abs(row - curRow);
    return dist >= 2;
  });
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Choose a wander destination using weighted randomness over three behaviors:
 *  - pair up at ping-pong when one side is open and cooldown allows (social)
 *  - relax in a rec-room chair (social)
 *  - otherwise walk to any random reachable free tile (the default)
 *
 *  This replaces the old fixed-route picker; the agent still heads toward
 *  predefined seats for the social cases so those behaviors stay recognizable. */
function pickWanderTarget(claimed: Set<number>, ch: Character): WanderTarget {
  const cooldownReady = (ch.pingPongCooldown ?? 0) <= 0;

  const freePingPong = IDLE_SPOTS
    .map((_, i) => i)
    .filter((i) => IDLE_SPOTS[i].kind === 'ping_pong' && !claimed.has(i));
  const claimedPingPong = IDLE_SPOTS
    .map((_, i) => i)
    .filter((i) => IDLE_SPOTS[i].kind === 'ping_pong' && claimed.has(i));

  // Strong bias: if one ping-pong side is taken, join the other (cooldown permitting).
  if (cooldownReady && freePingPong.length === 1 && claimedPingPong.length === 1 && Math.random() < 0.8) {
    const idx = freePingPong[0];
    return { dest: IDLE_SPOTS[idx], idleSpot: idx };
  }

  const roll = Math.random();

  // 10% — start a new ping-pong game when possible
  if (cooldownReady && roll < 0.10 && freePingPong.length > 0) {
    const idx = freePingPong[Math.floor(Math.random() * freePingPong.length)];
    return { dest: IDLE_SPOTS[idx], idleSpot: idx };
  }

  // 20% — take a seat in the rec-room idle chairs
  if (roll < 0.30) {
    const freeChairs = IDLE_SPOTS
      .map((_, i) => i)
      .filter((i) => IDLE_SPOTS[i].kind === 'chair' && !claimed.has(i));
    if (freeChairs.length > 0) {
      const idx = freeChairs[Math.floor(Math.random() * freeChairs.length)];
      return { dest: IDLE_SPOTS[idx], idleSpot: idx };
    }
  }

  // 70% (or fallback) — wander to any random reachable free tile
  const freeTile = pickFreeTileWanderTarget(ch);
  if (freeTile) return { dest: freeTile, idleSpot: -1 };

  // If the office somehow has no free tile reachable, stand still.
  return { dest: { x: ch.x, y: ch.y }, idleSpot: -1 };
}

function leavingPingPongSpot(ch: Character): boolean {
  if (ch.idleSpot < 0) return false;
  return IDLE_SPOTS[ch.idleSpot]?.kind === 'ping_pong';
}

/** Release any previously claimed social spot when an agent leaves idle.
 *  Ping-pong spots also trigger the per-agent cooldown so the same agent
 *  doesn't immediately queue up for another match. */
function releaseIdleClaim(ch: Character, claimed: Set<number>): void {
  if (ch.idleSpot < 0) return;
  if (leavingPingPongSpot(ch)) ch.pingPongCooldown = PING_PONG_COOLDOWN;
  claimed.delete(ch.idleSpot);
  ch.idleSpot = -1;
}

/** Kick off a new wander: compute a destination, claim the social spot if any,
 *  and path the agent there. Falls back to IDLE when no path is found. */
function startWanderTarget(ch: Character, claimed: Set<number>): void {
  const target = pickWanderTarget(claimed, ch);
  if (target.idleSpot >= 0) claimed.add(target.idleSpot);
  ch.idleSpot = target.idleSpot;
  const path = pathTo(ch, target.dest);
  ch.path = path;
  ch.pathIdx = 0;
  ch.state = path.length > 0 ? CharState.WALK : CharState.IDLE;
}

/** Body-radius used for agent-to-agent collision detection — a bit smaller
 *  than a tile so two agents can squeeze past each other in a corridor
 *  without locking up. */
const AGENT_COLLISION_RADIUS = 18;

/** Return true if stepping onto `target` would put the moving agent within the
 *  personal space of another agent that isn't already seated at a desk or in
 *  the waiting lounge. Seated/waiting agents are ignored because they stay
 *  put inside chair footprints rather than in walkable corridors. */
function isPathBlockedByAgent(
  self: Character,
  target: Vec2,
  characters: Map<string, Character>,
): boolean {
  const radiusSq = AGENT_COLLISION_RADIUS * AGENT_COLLISION_RADIUS;
  for (const other of characters.values()) {
    if (other.id === self.id) continue;
    if (other.state === CharState.WORK) continue;   // seated at a desk
    if (other.state === CharState.WAIT) continue;   // seated in waiting lounge
    const dx = other.x - target.x;
    const dy = other.y - target.y;
    if (dx * dx + dy * dy < radiusSq) return true;
  }
  return false;
}

function directionFromDelta(dx: number, dy: number): Direction {
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? Direction.RIGHT : Direction.LEFT;
  }
  return dy > 0 ? Direction.DOWN : Direction.UP;
}

function pathTo(from: Vec2, to: Vec2): Vec2[] {
  return findPath(from.x, from.y, to.x, to.y, TILE_GRID, TILE_SIZE);
}

/** Path that routes around the tiles other walking/idling agents currently
 *  occupy. Used by the corridor-collision recovery in update(): when an
 *  agent's next step is blocked by a peer, we replan toward the same
 *  destination treating peers as walls so the agent goes around instead
 *  of standing still until the peer moves. Seated/waiting agents are
 *  excluded from blockers — they stay inside furniture footprints, so
 *  routing around them isn't necessary (and would over-restrict the grid). */
function pathToAvoidingAgents(from: Vec2, to: Vec2, self: Character, characters: Map<string, Character>): Vec2[] {
  const blocked = new Set<string>();
  for (const other of characters.values()) {
    if (other.id === self.id) continue;
    if (other.state === CharState.WORK) continue;
    if (other.state === CharState.WAIT) continue;
    const col = Math.floor(other.x / TILE_SIZE);
    const row = Math.floor(other.y / TILE_SIZE);
    blocked.add(`${col},${row}`);
  }
  return findPath(from.x, from.y, to.x, to.y, TILE_GRID, TILE_SIZE, blocked);
}

function isNearTarget(from: Vec2, to: Vec2): boolean {
  return Math.abs(from.x - to.x) < TILE_SIZE && Math.abs(from.y - to.y) < TILE_SIZE;
}

function tileKeyForPoint(point: Vec2): string {
  return `${Math.floor(point.x / TILE_SIZE)},${Math.floor(point.y / TILE_SIZE)}`;
}

function isWalkablePathPoint(point: Vec2, finalPoint: Vec2 | null): boolean {
  const key = tileKeyForPoint(point);
  const finalKey = finalPoint ? tileKeyForPoint(finalPoint) : null;
  if (!FURNITURE_BLOCKED.has(key)) return true;
  return finalKey === key && SEAT_TILES.has(key);
}

export function updateCharacters(
  state: EngineState,
  dt: number,
  activeAgents: Set<string>,
  waitingAgents: Set<string>
) {
  const { characters, claimed, handoff } = state;
  dt = Math.min(dt, MAX_DT);
  const pingPongPlayers = getPingPongPlayers(characters);

  // Seed the claim set with spots that agents already own from a previous
  // frame so re-assignments (after a collision-timeout replan, say) don't pick
  // a spot that's still taken by someone mid-walk or already sitting.
  const claimedWaitSpots = new Set<number>();
  for (const ch of characters.values()) {
    if (
      (ch.state === CharState.WAIT || ch.state === CharState.WALK_TO_WAIT) &&
      ch.waitSpotIdx >= 0
    ) {
      claimedWaitSpots.add(ch.waitSpotIdx);
    }
  }

  for (const [id, ch] of characters) {
    ch.pingPongCooldown = Math.max(0, ch.pingPongCooldown - dt);
    const shouldWork = activeAgents.has(id);
    const shouldWait = waitingAgents.has(id);
    const role = baseRoleId(id);
    const deskPos = DESK_POSITIONS[role];
    const inHandoff = handoff && (handoff.from === id || handoff.to === id);

    // Release any stale wait-spot claim when the agent no longer needs to wait.
    if (!shouldWait && ch.waitSpotIdx >= 0 &&
        ch.state !== CharState.WAIT && ch.state !== CharState.WALK_TO_WAIT) {
      claimedWaitSpots.delete(ch.waitSpotIdx);
      ch.waitSpotIdx = -1;
    }

    if (inHandoff) {
      // Skip — handled by handoff logic
    } else if (shouldWait && ch.state !== CharState.WAIT && ch.state !== CharState.WALK_TO_WAIT) {
      releaseIdleClaim(ch, claimed);
      // Reuse the agent's previous wait spot if they still own one; otherwise
      // claim a fresh unclaimed lounge seat so multiple waiters don't bunch up
      // on the same chair via `waitIdx % length` wrap-around.
      let spotIdx = ch.waitSpotIdx >= 0 && !claimedWaitSpots.has(ch.waitSpotIdx)
        ? ch.waitSpotIdx
        : pickUnclaimedWaitSpot(claimedWaitSpots);
      ch.waitSpotIdx = spotIdx;
      const ws = WAIT_SPOTS[spotIdx];
      const path = pathTo(ch, ws);
      ch.path = path;
      ch.pathIdx = 0;
      if (path.length > 0) {
        ch.state = CharState.WALK_TO_WAIT;
      } else if (isNearTarget(ch, ws)) {
        ch.state = CharState.WAIT;
        ch.dir = Direction.DOWN;
      } else {
        ch.state = CharState.IDLE;
      }
    } else if (shouldWork && ch.state !== CharState.WORK && ch.state !== CharState.WALK) {
      releaseIdleClaim(ch, claimed);
      const path = pathTo(ch, deskPos);
      ch.path = path;
      ch.pathIdx = 0;
      if (path.length > 0) {
        ch.state = CharState.WALK;
      } else if (deskPos && isNearTarget(ch, deskPos)) {
        ch.state = CharState.WORK;
        ch.dir = WORK_DIRECTIONS[role] ?? Direction.UP;
      } else {
        ch.state = CharState.IDLE;
      }
    } else if (!shouldWork && !shouldWait && (ch.state === CharState.WORK || ch.state === CharState.WAIT)) {
      startWanderTarget(ch, claimed);
    } else if (ch.state === CharState.IDLE) {
      ch.idleTimer -= dt;
      if (ch.idleTimer <= 0) {
        releaseIdleClaim(ch, claimed);
        startWanderTarget(ch, claimed);
        ch.idleTimer = IDLE_MIN + Math.random() * (IDLE_MAX - IDLE_MIN);
      }
    }

    // Movement
    if ((ch.state === CharState.WALK || ch.state === CharState.WALK_TO_WAIT) && ch.path.length > 0 && ch.pathIdx < ch.path.length) {
      const target = ch.path[ch.pathIdx];
      const finalPathPoint = ch.path[ch.path.length - 1] ?? null;

      if (!isWalkablePathPoint(target, finalPathPoint)) {
        ch.path = [];
        ch.pathIdx = 0;
        ch.state = CharState.IDLE;
        ch.animFrame = 0;
        continue;
      }

      // Don't step into another agent's personal space. On first detection
      // try to route AROUND the blocker toward the same destination — if a
      // detour exists, take it immediately. If no detour exists, hold
      // position; if we've been blocked for a while, give up and re-pick a
      // wander target so two walkers don't stand deadlocked in a corridor.
      if (isPathBlockedByAgent(ch, target, characters)) {
        if (ch.blockedTimer === 0 && ch.path.length > 0) {
          // First tick blocked: try to find an alternate route to the
          // destination that goes around the blocker. Same target tile,
          // same final goal, just a different sequence of moves.
          const finalDest = ch.path[ch.path.length - 1];
          const detour = pathToAvoidingAgents(ch, finalDest, ch, characters);
          if (detour.length > 0) {
            ch.path = detour;
            ch.pathIdx = 0;
            ch.blockedTimer = 0;
            continue;
          }
          // No detour available — fall through to wait.
        }
        ch.blockedTimer += dt;
        ch.animFrame = 0;
        if (ch.blockedTimer > 2.0) {
          ch.path = [];
          ch.pathIdx = 0;
          ch.blockedTimer = 0;
          ch.state = CharState.IDLE;
          ch.idleTimer = 0.4;     // re-pick a destination almost immediately
        }
        continue;
      }
      ch.blockedTimer = 0;

      const dx = target.x - ch.x;
      const dy = target.y - ch.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = WALK_SPEED * dt;

      if (dist <= step) {
        ch.x = target.x;
        ch.y = target.y;
        ch.pathIdx++;
        if (ch.pathIdx >= ch.path.length) {
          if (ch.state === CharState.WALK_TO_WAIT) {
            ch.state = CharState.WAIT;
            ch.dir = Direction.DOWN;
          } else if (deskPos && Math.abs(ch.x - deskPos.x) < TILE_SIZE && Math.abs(ch.y - deskPos.y) < TILE_SIZE) {
            ch.state = CharState.WORK;
            ch.dir = WORK_DIRECTIONS[role] ?? Direction.UP;
          } else {
            ch.state = CharState.IDLE;
            ch.dir = Direction.DOWN;
          }
          ch.path = [];
          ch.animFrame = 0;
        }
      } else {
        ch.dir = directionFromDelta(dx, dy);
        ch.x += (dx / dist) * step;
        ch.y += (dy / dist) * step;
      }

      // Walk animation
      ch.animTimer += dt;
      if (ch.animTimer >= WALK_FRAME_DUR) {
        ch.animTimer = 0;
        ch.animFrame = ch.animFrame === 1 ? 2 : 1;
      }
    } else if (ch.state === CharState.WORK) {
      // Subtle typing animation
      ch.animTimer += dt;
      if (ch.animTimer >= 0.4) {
        ch.animTimer = 0;
        ch.animFrame = ch.animFrame === 0 ? 1 : 0;
      }
    } else if (pingPongPlayers?.some(player => player.id === ch.id) && ch.state === CharState.IDLE && isNearPoint(ch, PING_PONG_SPOTS[0], 10)) {
      ch.idleTimer = Math.min(ch.idleTimer, PING_PONG_PLAY_MAX);
      ch.dir = Direction.RIGHT;
      ch.animTimer += dt;
      if (ch.animTimer >= 0.22) {
        ch.animTimer = 0;
        ch.animFrame = ch.animFrame === 0 ? 1 : 0;
      }
    } else if (pingPongPlayers?.some(player => player.id === ch.id) && ch.state === CharState.IDLE && isNearPoint(ch, PING_PONG_SPOTS[1], 10)) {
      ch.idleTimer = Math.min(ch.idleTimer, PING_PONG_PLAY_MAX);
      ch.dir = Direction.LEFT;
      ch.animTimer += dt;
      if (ch.animTimer >= 0.22) {
        ch.animTimer = 0;
        ch.animFrame = ch.animFrame === 0 ? 1 : 0;
      }
    } else {
      ch.animFrame = 0;
    }
  }
}

/* ========================================================================
   RENDER — uses PNG sprites from pixel-agents asset pack
   ======================================================================== */

/** Helper to get rendered height of a furniture sprite at a given scale */
function furnitureHeight(sprites: Map<string, HTMLImageElement>, key: string, scale: number = 2): number {
  const img = sprites.get(key);
  return img ? img.height * scale : 32;
}

function furnitureWidth(sprites: Map<string, HTMLImageElement>, key: string, scale: number = 2): number {
  const img = sprites.get(key);
  return img ? img.width * scale : 32;
}

function isNearPoint(from: Vec2, to: Vec2, threshold: number = TILE_SIZE / 2): boolean {
  return Math.abs(from.x - to.x) <= threshold && Math.abs(from.y - to.y) <= threshold;
}

function getPingPongPlayers(characters: Map<string, Character>): [Character, Character] | null {
  const leftPlayer = Array.from(characters.values()).find((ch) => isNearPoint(ch, PING_PONG_SPOTS[0], 10));
  const rightPlayer = Array.from(characters.values()).find((ch) => ch.id !== leftPlayer?.id && isNearPoint(ch, PING_PONG_SPOTS[1], 10));
  return leftPlayer && rightPlayer ? [leftPlayer, rightPlayer] : null;
}

type ChairSpot = {
  x: number;
  y: number;
  dir: Direction;
  yOffset: number;
  ids?: string[];
  mode: 'work' | 'idle' | 'wait';
};

function getChairSitPose(
  ch: Character,
  chairSpots: ChairSpot[],
  pingPongPlayers: [Character, Character] | null
): { x: number; y: number; dir: Direction } | null {
  if (ch.state === CharState.WALK || ch.state === CharState.WALK_TO_WAIT) return null;
  if (pingPongPlayers?.some((player) => player.id === ch.id)) return null;

  const chair = chairSpots.find((spot) =>
    ((spot.mode === 'work' && ch.state === CharState.WORK && (!!spot.ids && spot.ids.includes(ch.id))) ||
      (spot.mode === 'idle' && ch.state === CharState.IDLE) ||
      (spot.mode === 'wait' && ch.state === CharState.WAIT)) &&
    Math.abs(ch.x - spot.x) <= 18 &&
    Math.abs(ch.y - spot.y) <= 18
  );

  if (!chair) return null;

  return {
    x: chair.x,
    y: chair.y + chair.yOffset,
    dir: chair.dir,
  };
}

function drawPingPongTable(ctx: CanvasRenderingContext2D, playersActive: boolean, t: number) {
  const { x, y, width, height } = PING_PONG_TABLE;

  ctx.fillStyle = '#215f72';
  ctx.fillRect(x, y, width, height);

  ctx.fillStyle = '#f4f1e6';
  ctx.fillRect(x + 4, y + 4, width - 8, 2);
  ctx.fillRect(x + 4, y + height - 6, width - 8, 2);
  ctx.fillRect(x + 4, y + 4, 2, height - 8);
  ctx.fillRect(x + width / 2 - 1, y + 4, 2, height - 8);
  ctx.fillRect(x + width - 6, y + 4, 2, height - 8);

  ctx.fillStyle = '#d9d3c8';
  ctx.fillRect(x + width / 2 - 1, y + 6, 2, height - 12);
  ctx.fillStyle = '#b7b7bb';
  const netX = x + width / 2 - 1;
  const netTopY = y + 8;
  const netBottomY = y + height - 8;
  ctx.fillRect(netX, netTopY, 2, netBottomY - netTopY);
  ctx.fillRect(netX - 4, netTopY, 10, 2);
  ctx.fillRect(netX - 4, netBottomY - 2, 10, 2);
  ctx.fillRect(netX + 1, netTopY + 3, 1, netBottomY - netTopY - 6);

  ctx.fillStyle = '#71574c';
  ctx.fillRect(x + 8, y + height, 8, 10);
  ctx.fillRect(x + width - 16, y + height, 8, 10);

  if (!playersActive) return;

  // Players stand just outside the short ends of the table and each holds a
  // paddle in the hand nearest the table. Paddles are drawn between the
  // player's hand and the table edge; the ball rallies between them with a
  // parabolic arc so it reads as a bounce rather than a slide.
  const leftPlayerX = PING_PONG_SPOTS[0].x;
  const rightPlayerX = PING_PONG_SPOTS[1].x;
  const playY = y + height / 2;      // vertical center of the table surface

  const paddleW = 4;
  const paddleH = 10;
  // Rest position: just outside the table edge, close to the player's hand.
  // Strike position: nudged toward the table to "meet" the ball.
  const leftPaddleRestX = x - paddleW - 2;   // 2-pixel gap from table
  const leftPaddleStrikeX = leftPaddleRestX + 4;
  const rightPaddleRestX = x + width + 2;
  const rightPaddleStrikeX = rightPaddleRestX - 4;

  // Rally clock: one full cycle = ball hit on left then hit on right.
  const travelMs = 900;
  const tMod = ((t % (2 * travelMs)) + 2 * travelMs) % (2 * travelMs);
  const movingRight = tMod < travelMs;
  const phase = movingRight ? tMod / travelMs : (tMod - travelMs) / travelMs; // 0..1

  // Strike envelope — paddle is in its forward "hit" pose for a brief window
  // right around the instant the ball reaches it.
  const strikeRamp = 0.2;
  const leftStrike = movingRight
    ? Math.max(0, 1 - phase / strikeRamp)                   // just hit (start of right-bound leg)
    : Math.max(0, (phase - (1 - strikeRamp)) / strikeRamp); // about to hit (end of left-bound leg)
  const rightStrike = movingRight
    ? Math.max(0, (phase - (1 - strikeRamp)) / strikeRamp)
    : Math.max(0, 1 - phase / strikeRamp);

  const leftPaddleX = leftPaddleRestX + leftStrike * (leftPaddleStrikeX - leftPaddleRestX);
  const rightPaddleX = rightPaddleRestX + rightStrike * (rightPaddleStrikeX - rightPaddleRestX);

  // Ball: starts at the paddle it just came off and lands on the other paddle.
  const ballStartX = movingRight ? leftPaddleX + paddleW : rightPaddleX;
  const ballEndX = movingRight ? rightPaddleX : leftPaddleX + paddleW;
  const ballX = ballStartX + (ballEndX - ballStartX) * phase;
  const arcHeight = 6;
  const ballY = playY - arcHeight * Math.sin(Math.PI * phase);

  // Paddle shafts — a short line from the player's hand out to the paddle face,
  // so the paddle reads as "held" rather than floating.
  const leftHandX = leftPlayerX + 8;       // hand roughly 8px right of player center
  const rightHandX = rightPlayerX - 8;
  const shaftY = Math.round(playY) - 1;
  ctx.fillStyle = '#3b2d29';
  if (leftPaddleX > leftHandX) {
    ctx.fillRect(Math.round(leftHandX), shaftY, Math.round(leftPaddleX) - Math.round(leftHandX), 2);
  }
  if (rightHandX > rightPaddleX + paddleW) {
    ctx.fillRect(Math.round(rightPaddleX + paddleW), shaftY, Math.round(rightHandX) - Math.round(rightPaddleX + paddleW), 2);
  }

  // Paddle faces
  ctx.fillStyle = '#d95763';
  ctx.fillRect(Math.round(leftPaddleX), Math.round(playY - paddleH / 2), paddleW, paddleH);
  ctx.fillStyle = '#4b86d9';
  ctx.fillRect(Math.round(rightPaddleX), Math.round(playY - paddleH / 2), paddleW, paddleH);

  // Ball
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(Math.round(ballX) - 1, Math.round(ballY) - 1, 3, 3);
}

function drawBackWallPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  rounded: { left?: boolean; right?: boolean } = {},
  endCaps: { left?: boolean; right?: boolean } = {},
  joins: { left?: 'flush' | 'inner' | 'split'; right?: 'flush' | 'inner' } = {}
) {
  const leftInset = rounded.left ? WALL_DIMENSIONS.outerWidth : 0;
  const rightInset = rounded.right ? WALL_DIMENSIONS.outerWidth : 0;
  const topLeftInset = joins.left === 'inner' || joins.left === 'split'
    ? WALL_DIMENSIONS.dividerWidth
    : 0;
  const topRightInset = joins.right === 'inner' ? WALL_DIMENSIONS.dividerWidth : rightInset;
  const midLeftInset = joins.left === 'split'
    ? WALL_DIMENSIONS.dividerWidth
    : joins.left === 'flush'
      ? 0
      : leftInset;
  const midRightInset = joins.right === 'flush' ? 0 : rightInset;
  const shadeLeftInset = endCaps.left ? 2 : 0;
  const shadeRightInset = endCaps.right ? 2 : 0;

  ctx.fillStyle = WALL_STYLE.fill;
  ctx.fillRect(x, y, width, height);

  ctx.fillStyle = WALL_STYLE.line;
  ctx.fillRect(x + topLeftInset, y, width - topLeftInset - topRightInset, 2);
  ctx.fillRect(x + midLeftInset, y + 8, width - midLeftInset - midRightInset, 2);
  ctx.fillRect(x, y + height - 2, width, 2);
  if (endCaps.left) ctx.fillRect(x, y, 2, height);
  if (endCaps.right) ctx.fillRect(x + width - 2, y, 2, height);
  if (joins.left === 'split') {
    // Leave the inside of the T-joint open on the room side.
    ctx.fillRect(x + WALL_DIMENSIONS.dividerWidth - 2, y + 8, 2, height - 8);
  }

  ctx.fillStyle = WALL_STYLE.shade;
  ctx.fillRect(x + shadeLeftInset, y + height - 7, width - shadeLeftInset - shadeRightInset, 4);
}

function drawVerticalWallFace(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  edges: { left?: boolean; right?: boolean } = { left: true, right: true }
) {
  ctx.fillStyle = WALL_STYLE.fill;
  ctx.fillRect(x, y, width, height);

  ctx.fillStyle = WALL_STYLE.line;
  if (edges.left !== false) ctx.fillRect(x, y, 2, height);
  if (edges.right !== false) ctx.fillRect(x + width - 2, y, 2, height);
}

function drawVerticalWallEnd(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number
) {
  ctx.fillStyle = WALL_STYLE.line;
  ctx.fillRect(x, y, width, 2);
}

function drawVerticalWallTrim(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number
) {
  ctx.fillStyle = WALL_STYLE.line;
  ctx.fillRect(x, y, width, 2);
}

function drawBottomWall(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  rounded: { left?: boolean; right?: boolean } = {}
) {
  const leftInset = rounded.left ? WALL_DIMENSIONS.outerWidth : 0;
  const rightInset = rounded.right ? WALL_DIMENSIONS.outerWidth : 0;

  ctx.fillStyle = WALL_STYLE.fill;
  ctx.fillRect(x, y, width, height);

  ctx.fillStyle = WALL_STYLE.line;
  ctx.fillRect(x + leftInset, y, width - leftInset - rightInset, 2);
  ctx.fillRect(x + leftInset, y + height - 2, width - leftInset - rightInset, 2);
}

function drawRoundedOuterCorner(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  orientation: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
) {
  ctx.save();
  if (orientation === 'top-right') {
    ctx.translate(Math.round(x + size), Math.round(y));
    ctx.scale(-1, 1);
  } else if (orientation === 'bottom-left') {
    ctx.translate(Math.round(x), Math.round(y + size));
    ctx.scale(1, -1);
  } else if (orientation === 'bottom-right') {
    ctx.translate(Math.round(x + size), Math.round(y + size));
    ctx.scale(-1, -1);
  } else {
    ctx.translate(Math.round(x), Math.round(y));
  }

  ctx.fillStyle = WALL_STYLE.fill;
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(size, size);
  ctx.lineTo(0, size);
  ctx.quadraticCurveTo(0, 0, size, 0);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = WALL_STYLE.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(size, 1);
  ctx.arcTo(1, 1, 1, size, size);
  ctx.lineTo(1, size);
  ctx.stroke();
  ctx.restore();
}

function getForegroundWallRects(): Rect[] {
  const {
    topH,
    dividerW,
    outerW,
    connectionOffset,
    bottomY,
    mainDividerX,
    recDividerY,
    recLeftStart,
    kitchenRecOpeningX,
    recRightStart,
    recRightWidth,
    kitchenOpeningTopY,
    kitchenOpeningBottomY,
    recOpeningTopY,
    recOpeningBottomY,
  } = getWallLayout();

  return [
    { x: 0, y: 0, w: 14 * TILE_SIZE, h: topH },
    { x: 14 * TILE_SIZE, y: 0, w: 10 * TILE_SIZE, h: topH },
    { x: recLeftStart, y: recDividerY - topH, w: kitchenRecOpeningX - recLeftStart, h: topH },
    { x: recRightStart, y: recDividerY - topH, w: recRightWidth, h: topH },
    { x: 0, y: connectionOffset, w: outerW, h: bottomY - connectionOffset },
    { x: CANVAS_W - outerW, y: connectionOffset, w: outerW, h: bottomY - connectionOffset },
    { x: mainDividerX, y: connectionOffset, w: dividerW, h: kitchenOpeningTopY - connectionOffset },
    { x: mainDividerX, y: kitchenOpeningBottomY, w: dividerW, h: recOpeningTopY - kitchenOpeningBottomY },
    { x: mainDividerX, y: recOpeningBottomY, w: dividerW, h: bottomY - recOpeningBottomY },
    { x: CANVAS_W - dividerW, y: recDividerY - topH + 8, w: dividerW, h: topH + 4 },
  ];
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function isCharacterOccludedByWall(x: number, y: number): boolean {
  const characterRect = {
    x: x - FRAME_SIZE / 2,
    y: y - FRAME_SIZE / 2,
    w: FRAME_SIZE,
    h: FRAME_SIZE,
  };

  return getForegroundWallRects().some(rect => rectsIntersect(characterRect, rect));
}

function drawCharacterWithWallOcclusion(
  ctx: CanvasRenderingContext2D,
  sprites: Map<string, HTMLImageElement>,
  x: number,
  y: number,
  bodyRow: number,
  hairRow: number,
  suitRow: number,
  direction: number,
  animFrame: number,
) {
  const dstX = Math.round(x);
  const dstY = Math.round(y);
  const characterRect = { x: dstX, y: dstY, w: FRAME_SIZE, h: FRAME_SIZE };

  if (!getForegroundWallRects().some(rect => rectsIntersect(characterRect, rect))) {
    drawCharacter(ctx, sprites, dstX, dstY, bodyRow, hairRow, suitRow, direction, animFrame);
    return;
  }

  const buffer = document.createElement('canvas');
  buffer.width = FRAME_SIZE;
  buffer.height = FRAME_SIZE;
  const bufferCtx = buffer.getContext('2d');
  if (!bufferCtx) {
    drawCharacter(ctx, sprites, dstX, dstY, bodyRow, hairRow, suitRow, direction, animFrame);
    return;
  }

  bufferCtx.imageSmoothingEnabled = false;
  drawCharacter(bufferCtx, sprites, 0, 0, bodyRow, hairRow, suitRow, direction, animFrame);

  for (const rect of getForegroundWallRects()) {
    const ix = Math.max(characterRect.x, rect.x);
    const iy = Math.max(characterRect.y, rect.y);
    const ix2 = Math.min(characterRect.x + characterRect.w, rect.x + rect.w);
    const iy2 = Math.min(characterRect.y + characterRect.h, rect.y + rect.h);

    if (ix2 > ix && iy2 > iy) {
      bufferCtx.clearRect(ix - characterRect.x, iy - characterRect.y, ix2 - ix, iy2 - iy);
    }
  }

  ctx.drawImage(buffer, dstX, dstY);
}

function drawOfficeWalls(
  ctx: CanvasRenderingContext2D,
  _sprites: Map<string, HTMLImageElement>
) {
  const {
    topH,
    dividerW,
    outerW,
    connectionOffset,
    bottomH,
    bottomY,
    mainDividerX,
    recDividerY,
    kitchenOpeningTopY,
    kitchenOpeningBottomY,
    recLeftStart,
    kitchenRecOpeningX,
    recRightStart,
    recRightWidth,
    recOpeningTopY,
    recOpeningBottomY,
  } = getWallLayout();

  drawBackWallPanel(ctx, 0, 0, 14 * TILE_SIZE, topH, { left: true });
  drawBackWallPanel(ctx, 14 * TILE_SIZE, 0, 10 * TILE_SIZE, topH, { right: true });
  drawBackWallPanel(
    ctx,
    recLeftStart,
    recDividerY - topH,
    kitchenRecOpeningX - recLeftStart,
    topH,
    {},
    { right: true },
    { left: 'split' }
  );
  drawBackWallPanel(ctx, recRightStart, recDividerY - topH, recRightWidth, topH, {}, { left: true });

  drawVerticalWallFace(ctx, 0, connectionOffset, outerW, bottomY - connectionOffset);
  drawVerticalWallFace(ctx, CANVAS_W - outerW, connectionOffset, outerW, bottomY - connectionOffset);

  drawVerticalWallFace(ctx, mainDividerX, connectionOffset, dividerW, kitchenOpeningTopY - connectionOffset);
  drawVerticalWallFace(ctx, mainDividerX, kitchenOpeningBottomY, dividerW, recOpeningTopY - kitchenOpeningBottomY);
  // Center the rec-room opening vertically within the room.
  drawVerticalWallFace(ctx, mainDividerX, recOpeningBottomY, dividerW, bottomY - recOpeningBottomY);

  drawVerticalWallEnd(ctx, mainDividerX, kitchenOpeningTopY - 2, dividerW);
  drawVerticalWallEnd(ctx, mainDividerX, kitchenOpeningBottomY, dividerW);
  drawVerticalWallEnd(ctx, mainDividerX, recOpeningTopY - 2, dividerW);
  drawVerticalWallEnd(ctx, mainDividerX, recOpeningBottomY, dividerW);
  drawVerticalWallTrim(ctx, mainDividerX, kitchenOpeningTopY - 50, dividerW);
  drawVerticalWallTrim(ctx, mainDividerX, recOpeningTopY - 50, dividerW);

  // Open the T-joint gaps so the trim reads as a single connected wall.
  ctx.fillStyle = WALL_STYLE.fill;
  ctx.fillRect(mainDividerX + dividerW - 2, recDividerY - topH + 2, 2, 6);
  ctx.fillRect(CANVAS_W - dividerW, recDividerY - topH + 2, 2, 6);

  // Align this short vertical face with the inner trim line of the rec-room back wall.
  drawVerticalWallFace(ctx, CANVAS_W - dividerW, recDividerY - topH + 8, dividerW, topH + 4);

  drawBottomWall(ctx, 0, bottomY, CANVAS_W, bottomH, { left: true, right: true });
  ctx.fillStyle = WALL_STYLE.fill;
  ctx.fillRect(mainDividerX + 2, bottomY, dividerW - 4, 2);
  drawRoundedOuterCorner(ctx, 0, 0, outerW, 'top-left');
  drawRoundedOuterCorner(ctx, CANVAS_W - outerW, 0, outerW, 'top-right');
  drawRoundedOuterCorner(ctx, 0, bottomY - outerW + bottomH, outerW, 'bottom-left');
  drawRoundedOuterCorner(ctx, CANVAS_W - outerW, bottomY - outerW + bottomH, outerW, 'bottom-right');
}

function drawRepeatedRoomFloor(
  ctx: CanvasRenderingContext2D,
  sprites: Map<string, HTMLImageElement>,
  key: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fallback: string,
  patternScale: number,
) {
  const img = sprites.get(key);
  if (img) {
    const drawW = Math.max(1, Math.round(img.width * patternScale));
    const drawH = Math.max(1, Math.round(img.height * patternScale));

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();

    for (let py = y; py < y + height; py += drawH) {
      for (let px = x; px < x + width; px += drawW) {
        ctx.drawImage(img, 0, 0, img.width, img.height, px, py, drawW, drawH);
      }
    }

    ctx.restore();
    return;
  }

  ctx.fillStyle = fallback;
  ctx.fillRect(x, y, width, height);
}

function drawSolidRoomFloor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width, height);
}

function drawWoodWorkspaceFloor(
  ctx: CanvasRenderingContext2D,
  sprites: Map<string, HTMLImageElement>,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();

  const fallbackLight = '#C49A6C';
  const fallbackDark = '#B08858';

  for (let py = y, row = 0; py < y + height; py += TILE_SIZE, row++) {
    for (let px = x, col = 0; px < x + width; px += TILE_SIZE, col++) {
      const isLight = (row + col) % 2 === 0;
      const woodKey = isLight ? 'woodFloor0' : 'woodFloor1';
      const img = sprites.get(woodKey);

      if (img) {
        ctx.drawImage(img, 0, 0, 32, 32, px, py, TILE_SIZE, TILE_SIZE);
      } else {
        ctx.fillStyle = isLight ? fallbackLight : fallbackDark;
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  ctx.restore();
}

export function render(
  ctx: CanvasRenderingContext2D,
  state: EngineState,
  isOffline: boolean
) {
  const { characters, sprites } = state;
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  const dividerFloorBoundaryX = 15 * TILE_SIZE - WALL_DIMENSIONS.dividerWidth / 2;
  const workspaceInnerLeftX = WALL_DIMENSIONS.outerWidth;
  const workspaceInnerRightX = 15 * TILE_SIZE - WALL_DIMENSIONS.dividerWidth;
  const bottomWallY = CANVAS_H - WALL_DIMENSIONS.bottomWallHeight;
  const kitchenInnerLeftX = 15 * TILE_SIZE - 2;
  const kitchenInnerRightX = CANVAS_W - WALL_DIMENSIONS.outerWidth;
  const recRoomInnerLeftX = 15 * TILE_SIZE - 2;
  const recRoomInnerRightX = CANVAS_W - WALL_DIMENSIONS.outerWidth;
  const workspaceCenterX = (workspaceInnerLeftX + workspaceInnerRightX) / 2;
  const recRoomCenterX = (recRoomInnerLeftX + recRoomInnerRightX) / 2;
  const kitchenRecOpeningWidth = 2 * TILE_SIZE;
  const kitchenRecOpeningCenterX = (recRoomInnerLeftX + recRoomInnerRightX) / 2;
  const kitchenRecOpeningLeftX = Math.round(kitchenRecOpeningCenterX - kitchenRecOpeningWidth / 2);
  const kitchenRecOpeningRightX = kitchenRecOpeningLeftX + kitchenRecOpeningWidth;

  // 1. Draw room floors first so walls cleanly mask the room boundaries.
  // Keep the workspace on the original wood flooring, tile the kitchen floor art,
  // and use a continuous fill in the rec room so seams do not appear.
  drawWoodWorkspaceFloor(ctx, sprites, 0, 0, dividerFloorBoundaryX, CANVAS_H);
  drawRepeatedRoomFloor(ctx, sprites, 'kitchenFloor', dividerFloorBoundaryX, 0, CANVAS_W - dividerFloorBoundaryX, 8 * TILE_SIZE, '#CBC0AB', 0.372);
  drawSolidRoomFloor(ctx, dividerFloorBoundaryX, 7 * TILE_SIZE, CANVAS_W - dividerFloorBoundaryX, CANVAS_H - 7 * TILE_SIZE, '#7D97AE');

  // 2. Restore the detailed architectural wall treatment from the wall-design commit.
  drawOfficeWalls(ctx, sprites);

  // 3. Collect all Z-sorted drawables (furniture + characters)
  interface ZDrawable { zY: number; draw: () => void }
  const drawables: ZDrawable[] = [];

  const pushFurniture = (key: string, x: number, y: number, scale: number = 2, zY?: number) => {
    const h = furnitureHeight(sprites, key, scale);
    drawables.push({
      zY: zY ?? (y + h),
      draw: () => drawFurniture(ctx, sprites, key, x, y, scale),
    });
  };

  // Wall-mounted items (paintings, clocks) don't block floor tiles.
  const pushWallFurniture = (key: string, x: number, y: number, scale: number = 1) => {
    drawables.push({
      zY: 0,
      draw: () => drawFurniture(ctx, sprites, key, x, y, scale),
    });
  };

  const deskSurfaceZ = (deskY: number, deskKey: string) => deskY + furnitureHeight(sprites, deskKey, 1) + 2;

  // ===== WORKSPACE (left room, cols 1-13) =====
  const workspaceShelfWidth = furnitureWidth(sprites, 'doubleBookshelf', 2);
  const workspaceShelfHeight = furnitureHeight(sprites, 'doubleBookshelf', 2);
  const workspaceShelfY = 4;
  const loungeChairWidth = furnitureWidth(sprites, 'chairFront', 2);
  const loungeChairHeight = furnitureHeight(sprites, 'chairFront', 2);
  const loungePlantWidth = furnitureWidth(sprites, 'plant2', 2);
  const loungeGroupY = 2 * 32 + 6;
  const loungeGap = 8;
  const loungePairGap = 10;
  const loungeCenterGap = 132;
  const loungeGroupWidth =
    loungePlantWidth +
    loungeGap +
    loungeChairWidth +
    loungePairGap +
    loungeChairWidth +
    loungeCenterGap +
    loungeChairWidth +
    loungePairGap +
    loungeChairWidth +
    loungeGap +
    loungePlantWidth;
  const loungeGroupStartX = Math.round(workspaceCenterX - loungeGroupWidth / 2);
  const leftPlantX = loungeGroupStartX;
  const leftChairOneX = leftPlantX + loungePlantWidth + loungeGap;
  const leftChairTwoX = leftChairOneX + loungeChairWidth + loungePairGap;
  const rightChairOneX = leftChairTwoX + loungeChairWidth + loungeCenterGap;
  const rightChairTwoX = rightChairOneX + loungeChairWidth + loungePairGap;
  const rightPlantX = rightChairTwoX + loungeChairWidth + loungeGap;
  for (let x = workspaceInnerLeftX; x < workspaceInnerRightX; x += workspaceShelfWidth) {
    const visibleWidth = Math.min(workspaceShelfWidth, workspaceInnerRightX - x);
    drawables.push({
      zY: workspaceShelfY + workspaceShelfHeight,
      draw: () => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, workspaceShelfY, visibleWidth, workspaceShelfHeight);
        ctx.clip();
        drawFurniture(ctx, sprites, 'doubleBookshelf', x, workspaceShelfY, 2);
        ctx.restore();
      },
    });
  }

  pushFurniture('plant2',                  leftPlantX,     loungeGroupY - 10);
  pushFurniture('chairFront',              leftChairOneX,  loungeGroupY + 4);
  pushFurniture('chairFront',              leftChairTwoX,  loungeGroupY + 4);
  pushFurniture('chairFront',              rightChairOneX, loungeGroupY + 4);
  pushFurniture('chairFront',              rightChairTwoX, loungeGroupY + 4);
  pushFurniture('plant2',                  rightPlantX,    loungeGroupY - 10);

  const workstationDeskWidth = furnitureWidth(sprites, 'officeDeskSilver', 1);
  const workstationWidth = workstationDeskWidth * 2;
  const workstationGap = 16;
  const deskLeftX = Math.round(workspaceCenterX - workstationGap / 2 - workstationWidth);
  const deskRightX = Math.round(workspaceCenterX + workstationGap / 2);
  const topDeskY = 5 * 32;
  const bottomDeskY = 8 * 32 + 14;
  const topChairY = 6 * 32 - 2;
  const bottomChairY = 7 * 32 + 8;
  const pmChairY = 13 * 32;
  const pmWhiteboardY = 12 * 32 - 8;
  const pmWhiteboardGap = 8;
  const pmWhiteboard1Width = furnitureWidth(sprites, 'officeWhiteboardChart1', 1);
  const pmWhiteboard2Width = furnitureWidth(sprites, 'officeWhiteboardChart2', 1);
  const pmWhiteboard3Width = furnitureWidth(sprites, 'officeWhiteboardChart3', 1);
  const pmWhiteboardGroupWidth = pmWhiteboard1Width + pmWhiteboardGap + pmWhiteboard2Width + pmWhiteboardGap + pmWhiteboard3Width;
  const pmWhiteboardStartX = Math.round(workspaceCenterX - pmWhiteboardGroupWidth / 2);
  const pmWhiteboardEndX = pmWhiteboardStartX + pmWhiteboardGroupWidth;
  const office2TopMargin = 0;
  const deskPairOffset = workstationDeskWidth;
  const topMonitorBlueWidth = furnitureWidth(sprites, 'officeMonitorBlue', 1);
  const topMonitorDarkWidth = furnitureWidth(sprites, 'officeMonitorDark', 1);
  const bottomMonitorWidth = furnitureWidth(sprites, 'officeMonitorBack', 1);
  // Top workstation: chairs drawn below the back-wall desks. We use the
  // front-view chair sprite (backrest at the top of the sprite, seat visible
  // below); the seated agent is rendered facing the desk above.
  // Bottom workstation: chairs drawn above the divider-wall desks. We use the
  // back-view chair sprite (backrest toward the viewer, seat behind it);
  // the seated agent is rendered facing the desk below.
  const topChairSprite = 'officeWhiteChairFront';
  const bottomChairSprite = 'officeWhiteChairBack';
  const topChairXOffset = Math.round((workstationWidth - furnitureWidth(sprites, topChairSprite, 1)) / 2);
  const bottomChairXOffset = Math.round((workstationWidth - furnitureWidth(sprites, bottomChairSprite, 1)) / 2);
  const pmChairX = Math.round(pmWhiteboardStartX + pmWhiteboardGroupWidth / 2 - furnitureWidth(sprites, 'officeWhiteChairFront', 1) / 2);
  const pmShelfY = 14 * 32 - 8;
  const topMonitorY = topDeskY - 12;
  const bottomMonitorY = bottomDeskY - 12;

  // PM station: bottom-center chair facing the whiteboards.
  pushFurniture('officeWhiteChairFront',  pmChairX,                 pmChairY,       1);
  pushFurniture('officeWhiteboardChart1', pmWhiteboardStartX,       pmWhiteboardY - office2TopMargin,  1);
  pushFurniture('officeWhiteboardChart2', pmWhiteboardStartX + pmWhiteboard1Width + pmWhiteboardGap, pmWhiteboardY - office2TopMargin,  1);
  pushFurniture('officeWhiteboardChart3', pmWhiteboardStartX + pmWhiteboard1Width + pmWhiteboardGap + pmWhiteboard2Width + pmWhiteboardGap, pmWhiteboardY - office2TopMargin,  1);
  for (let x = pmWhiteboardStartX; x < pmWhiteboardEndX; x += workspaceShelfWidth) {
    const visibleWidth = Math.min(workspaceShelfWidth, pmWhiteboardEndX - x);
    drawables.push({
      zY: pmShelfY + workspaceShelfHeight,
      draw: () => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, pmShelfY, visibleWidth, workspaceShelfHeight);
        ctx.clip();
        drawFurniture(ctx, sprites, 'doubleBookshelf', x, pmShelfY, 2);
        ctx.restore();
      },
    });
  }

  // Centered 2x2 workstation layout.
  pushFurniture('officeDeskSilver',       deskLeftX,                              topDeskY - office2TopMargin,       1);
  pushFurniture('officeDeskSilver',       deskLeftX + deskPairOffset,             topDeskY - office2TopMargin,       1);
  pushFurniture('officeMonitorBlue',      deskLeftX + Math.round((workstationDeskWidth - topMonitorBlueWidth) / 2), topMonitorY,  1, deskSurfaceZ(topDeskY - office2TopMargin, 'officeDeskSilver'));
  pushFurniture('officeMonitorDark',      deskLeftX + deskPairOffset + Math.round((workstationDeskWidth - topMonitorDarkWidth) / 2), topMonitorY, 1, deskSurfaceZ(topDeskY - office2TopMargin, 'officeDeskSilver'));
  pushFurniture(topChairSprite,           deskLeftX + topChairXOffset,             topChairY,      1);

  pushFurniture('officeDeskSilver',       deskRightX,                             topDeskY - office2TopMargin,       1);
  pushFurniture('officeDeskSilver',       deskRightX + deskPairOffset,            topDeskY - office2TopMargin,       1);
  pushFurniture('officeMonitorBlue',      deskRightX + Math.round((workstationDeskWidth - topMonitorBlueWidth) / 2), topMonitorY,  1, deskSurfaceZ(topDeskY - office2TopMargin, 'officeDeskSilver'));
  pushFurniture('officeMonitorDark',      deskRightX + deskPairOffset + Math.round((workstationDeskWidth - topMonitorDarkWidth) / 2), topMonitorY, 1, deskSurfaceZ(topDeskY - office2TopMargin, 'officeDeskSilver'));
  pushFurniture(topChairSprite,           deskRightX + topChairXOffset,            topChairY,      1);

  pushFurniture('officeDeskSilver',       deskLeftX,                             bottomDeskY - office2TopMargin,    1);
  pushFurniture('officeDeskSilver',       deskLeftX + deskPairOffset,            bottomDeskY - office2TopMargin,    1);
  pushFurniture('officeMonitorBack',      deskLeftX + Math.round((workstationDeskWidth - bottomMonitorWidth) / 2),                   bottomMonitorY, 1, deskSurfaceZ(bottomDeskY - office2TopMargin, 'officeDeskSilver'));
  pushFurniture('officeMonitorBack',      deskLeftX + deskPairOffset + Math.round((workstationDeskWidth - bottomMonitorWidth) / 2), bottomMonitorY, 1, deskSurfaceZ(bottomDeskY - office2TopMargin, 'officeDeskSilver'));
  pushFurniture(bottomChairSprite,        deskLeftX + bottomChairXOffset,          bottomChairY,   1);

  pushFurniture('officeDeskSilver',       deskRightX,                            bottomDeskY - office2TopMargin,    1);
  pushFurniture('officeDeskSilver',       deskRightX + deskPairOffset,           bottomDeskY - office2TopMargin,    1);
  pushFurniture('officeMonitorBack',      deskRightX + Math.round((workstationDeskWidth - bottomMonitorWidth) / 2),                  bottomMonitorY, 1, deskSurfaceZ(bottomDeskY - office2TopMargin, 'officeDeskSilver'));
  pushFurniture('officeMonitorBack',      deskRightX + deskPairOffset + Math.round((workstationDeskWidth - bottomMonitorWidth) / 2), bottomMonitorY, 1, deskSurfaceZ(bottomDeskY - office2TopMargin, 'officeDeskSilver'));
  pushFurniture(bottomChairSprite,        deskRightX + bottomChairXOffset,         bottomChairY,   1);

  pushFurniture('plant2',                  1 * 32,      13 * 32);
  pushFurniture('plant',                   13 * 32,     13 * 32);

  // ===== KITCHEN (top-right, cols 15-22, rows 1-6) =====
  const kitchenClockX = Math.round((kitchenInnerLeftX + kitchenInnerRightX - furnitureWidth(sprites, 'clock', 1)) / 2);
  pushFurniture('clock',          kitchenClockX, 0 * 32 + 6, 1);
  pushFurniture('officeVendingMachine', 15 * 32 + 8, 1 * 32, 1);
  drawables.push({
    zY: 1 * 32 + OFFICE_DECOR_SLICES.waterCooler.srcH,
    draw: () => drawSprite(
      ctx,
      sprites,
      'officeDecor',
      OFFICE_DECOR_SLICES.waterCooler.srcX,
      OFFICE_DECOR_SLICES.waterCooler.srcY,
      OFFICE_DECOR_SLICES.waterCooler.srcW,
      OFFICE_DECOR_SLICES.waterCooler.srcH,
      17 * 32 + 4,
      1 * 32 + 2
    ),
  });
  pushFurniture('officeCountertop',    18 * 32 + 10, 1 * 32 + 16, 1);
  pushFurniture('kitchenMicrowave',    19 * 32 + 12, 1 * 32 + 14, 1, 1 * 32 + 56);
  pushFurniture('coffee',              20 * 32 + 2,  1 * 32 + 18, 2, 1 * 32 + 56);
  pushFurniture('officeFileCabinet',   21 * 32 + 16, 1 * 32, 1);

  // ===== REC ROOM (bottom-right, cols 15-22, rows 8-14) =====
  const plantWidth = furnitureWidth(sprites, 'plant', 2);
  const plant2Width = furnitureWidth(sprites, 'plant2', 2);
  const plant2Height = furnitureHeight(sprites, 'plant2', 2);
  const recChairWidth = furnitureWidth(sprites, 'woodenChairFront', 2);
  const recCoffeeTableWidth = furnitureWidth(sprites, 'coffeeTable', 2);
  const recSofaWidth = furnitureWidth(sprites, 'sofaFront', 2);
  const pingPongPlayers = getPingPongPlayers(characters);
  const bottomPlantInset = 12;
  const bottomPlantY = bottomWallY - plant2Height - 6;
  const recSeatingY = 11 * 32 + 8;
  const recCoffeeTableX = Math.round(recRoomCenterX - recCoffeeTableWidth / 2);
  const recLeftChairX = recCoffeeTableX - recChairWidth;
  const recRightChairX = recCoffeeTableX + recCoffeeTableWidth;
  const recSofaX = Math.round(recRoomCenterX - recSofaWidth / 2);
  // Workstation seat offsets are tuned against the chair sprite seat pixels:
  //   - UX, reviewer, PM use chair-FRONT sprites. The backrest is at the top of
  //     the sprite, so the character needs to render high enough to sit IN the
  //     seat with the backrest visible above them; otherwise the backrest draws
  //     over the character and hides them.
  //   - Dev, test use chair-BACK sprites (bottom row of workstations). Character
  //     renders slightly below DESK_POSITIONS.y so the torso sits in the seat
  //     cushion and the face pokes forward over the desk.
  const chairSpots: ChairSpot[] = [
    { x: DESK_POSITIONS.ux.x,       y: DESK_POSITIONS.ux.y,       dir: Direction.UP,   yOffset: -8, ids: ['ux'], mode: 'work' },
    { x: DESK_POSITIONS.reviewer.x, y: DESK_POSITIONS.reviewer.y, dir: Direction.UP,   yOffset: -8, ids: ['reviewer'], mode: 'work' },
    { x: DESK_POSITIONS.dev.x,      y: DESK_POSITIONS.dev.y,      dir: Direction.DOWN, yOffset: 6,  ids: ['dev'], mode: 'work' },
    { x: DESK_POSITIONS.test.x,     y: DESK_POSITIONS.test.y,     dir: Direction.DOWN, yOffset: 6,  ids: ['test'], mode: 'work' },
    { x: DESK_POSITIONS.pm.x,       y: DESK_POSITIONS.pm.y,       dir: Direction.UP,   yOffset: -4, ids: ['pm'], mode: 'work' },
    { x: leftChairOneX + loungeChairWidth / 2,  y: loungeGroupY + 4 + loungeChairHeight / 2, dir: Direction.DOWN, yOffset: 4, mode: 'wait' },
    { x: leftChairTwoX + loungeChairWidth / 2,  y: loungeGroupY + 4 + loungeChairHeight / 2, dir: Direction.DOWN, yOffset: 4, mode: 'wait' },
    { x: rightChairOneX + loungeChairWidth / 2, y: loungeGroupY + 4 + loungeChairHeight / 2, dir: Direction.DOWN, yOffset: 4, mode: 'wait' },
    { x: rightChairTwoX + loungeChairWidth / 2, y: loungeGroupY + 4 + loungeChairHeight / 2, dir: Direction.DOWN, yOffset: 4, mode: 'wait' },
    { x: recLeftChairX + recChairWidth / 2,     y: recSeatingY + furnitureHeight(sprites, 'woodenChairFront', 2) / 2, dir: Direction.DOWN, yOffset: 4, mode: 'idle' },
    { x: recRightChairX + recChairWidth / 2,    y: recSeatingY + furnitureHeight(sprites, 'woodenChairFront', 2) / 2, dir: Direction.DOWN, yOffset: 4, mode: 'idle' },
  ];

  // Double bookshelves against the back wall, tucked into the corners.
  pushFurniture('doubleBookshelf',  recRoomInnerLeftX, 6 * 32 + 2);
  pushFurniture('doubleBookshelf',  22 * 32 - 12, 6 * 32 + 2);

  // Plants align their inner edges with the opening edges closest to them.
  pushFurniture('plant',            kitchenRecOpeningLeftX - plantWidth, 6 * 32 + 4);
  pushFurniture('plant',            kitchenRecOpeningRightX,             6 * 32 + 4);

  drawables.push({
    zY: PING_PONG_TABLE.y + PING_PONG_TABLE.height + 10,
    draw: () => drawPingPongTable(ctx, Boolean(pingPongPlayers), performance.now()),
  });

  // Seating area (centered beneath the ping pong table and nudged downward)
  pushFurniture('woodenChairFront', recLeftChairX,  recSeatingY);
  pushFurniture('coffeeTable',      recCoffeeTableX, recSeatingY);
  pushFurniture('woodenChairFront', recRightChairX, recSeatingY);
  pushFurniture('sofaFront',        recSofaX,       13 * 32 + 8);

  // Mirrored corner plants, slightly inward and closer to the bottom wall.
  pushFurniture('plant2',           recRoomInnerLeftX + bottomPlantInset,                bottomPlantY);
  pushFurniture('plant2',           recRoomInnerRightX - plant2Width - bottomPlantInset, bottomPlantY);

  // Add characters
  for (const [, ch] of characters) {
    const seatedPose = getChairSitPose(ch, chairSpots, pingPongPlayers);
    const renderX = seatedPose?.x ?? ch.x;
    const renderY = seatedPose?.y ?? ch.y;
    const renderDir = seatedPose?.dir ?? ch.dir;
    const renderAnimFrame = seatedPose ? 0 : ch.animFrame;

    drawables.push({
      zY: renderY + 16,
      draw: () => {
        drawCharacterWithWallOcclusion(ctx, sprites, renderX - FRAME_SIZE / 2, renderY - FRAME_SIZE / 2,
          ch.bodyRow, ch.hairRow, ch.suitRow, renderDir, renderAnimFrame);
      },
    });
  }

  // Sort by zY and draw
  drawables.sort((a, b) => a.zY - b.zY);
  for (const d of drawables) d.draw();

  // 4. Bubbles (question mark for waiting agents)
  for (const [, ch] of characters) {
    if (ch.state === CharState.WAIT) {
      const bx = ch.x - 6;
      const by = ch.y - FRAME_SIZE / 2 - 16;
      ctx.fillStyle = 'rgba(240,180,40,0.9)';
      ctx.fillRect(bx, by, 12, 12);
      ctx.fillStyle = '#604010';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('?', bx + 6, by + 10);
    }
  }

  // 5. Offline overlay
  if (isOffline) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = 'rgba(20,20,30,0.9)';
    ctx.fillRect(CANVAS_W / 2 - 60, CANVAS_H / 2 - 14, 120, 28);
    ctx.fillStyle = '#A0A0B0';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('SYSTEM OFFLINE', CANVAS_W / 2, CANVAS_H / 2 + 4);
  }
}

// Game loop
export function startGameLoop(
  canvas: HTMLCanvasElement,
  state: EngineState,
  getActive: () => Set<string>,
  getWaiting: () => Set<string>,
  getOffline: () => boolean,
): () => void {
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  let lastTime = 0;
  let animId: number;

  function frame(time: number) {
    const dt = lastTime === 0 ? 0 : Math.min((time - lastTime) / 1000, MAX_DT);
    lastTime = time;
    updateCharacters(state, dt, getActive(), getWaiting());
    render(ctx, state, getOffline());
    animId = requestAnimationFrame(frame);
  }

  animId = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(animId);
}

export { CANVAS_W, CANVAS_H, TILE_SIZE };
