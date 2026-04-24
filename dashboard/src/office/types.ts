export enum Direction { DOWN = 0, UP = 1, RIGHT = 2, LEFT = 3 }
export enum CharState { IDLE = 'idle', WALK = 'walk', WORK = 'work', WAIT = 'wait', WALK_TO_WAIT = 'walk_to_wait' }

export interface Vec2 { x: number; y: number }

export interface Character {
  id: string;
  name: string;
  role: string;
  bodyRow: number;    // Row in character-body.png (skin tone)
  hairRow: number;    // Row in hairs.png (hair color)
  suitRow: number;    // Row in suit.png (outfit color)
  // Runtime state
  x: number;
  y: number;
  state: CharState;
  dir: Direction;
  animTimer: number;
  animFrame: number;  // 0=idle, 1=walk1, 2=walk2
  path: Vec2[];
  pathIdx: number;
  idleSpot: number;
  idleTimer: number;
  wanderCount: number;
  pingPongCooldown: number;
  // Seconds the agent has been unable to step forward because another
  // character is blocking the next tile. If this grows past a small
  // threshold we replan the route so two walkers don't deadlock.
  blockedTimer: number;
  // Index into WAIT_SPOTS the agent is assigned to (during WALK_TO_WAIT /
  // WAIT), or -1 if not waiting. Used so each waiting agent gets a unique
  // lounge chair instead of piling onto the same one via `waitIdx % length`.
  waitSpotIdx: number;
}

export interface Furniture {
  sheet: string;       // sprite sheet key
  srcX: number;        // source x in sheet
  srcY: number;        // source y in sheet
  srcW: number;        // source width
  srcH: number;        // source height
  x: number;           // world x position
  y: number;           // world y position
  zY: number;          // z-sort y (usually y + srcH)
}

export interface IdleSpot {
  x: number;
  y: number;
  zone: 'work' | 'kitchen' | 'rec';
  kind?: 'wander' | 'chair' | 'ping_pong';
}

export type TileType = 0 | 1 | 2; // 0=floor, 1=wall, 2=door
