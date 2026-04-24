import type { Furniture, IdleSpot, TileType, Vec2 } from './types';

export const TILE_SIZE = 32;
export const GRID_COLS = 24;
export const GRID_ROWS = 16;
export const CANVAS_W = GRID_COLS * TILE_SIZE; // 768
export const CANVAS_H = GRID_ROWS * TILE_SIZE; // 512

// Tile grid: 0=floor, 1=wall, 2=door
// Single wall divider at col 14, entrance at rows 11-12
// Layout:
//   Row 0:  WWWWWWWWWWWWWWWWWWWWWWWW
//   Row 1:  W.............W........W
//   Row 4:  W.............D........W  (centered door workspace→kitchen)
//   Row 7:  W.............WWWWDDWWWW  (kitchen/rec divider)
//   Row 9:  W.............W........W  (wall workspace→rec)
//   Row 11: ..............D........W  (centered door workspace→rec)
//   Row 12: ..............W........W  (entrance)
//   Row 15: WWWWWWWWWWWWWWWWWWWWWWWW
export const TILE_GRID: TileType[][] = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,2,2,1,1,1,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,1],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
];

// Floor tile source coordinates in tiles.png
// TilesHouse.png layout (512x512, 16x16 grid of 32x32 tiles):
// Row 2-3, cols 0-3 have wood floor planks (horizontal grain)
// Row 0 col 4-5 area has lighter floor tiles
export const FLOOR_TILE_LIGHT = { sx: 128, sy: 64, sw: 32, sh: 32 };
export const FLOOR_TILE_DARK = { sx: 160, sy: 64, sw: 32, sh: 32 };
// Walls rendered as solid colors — no tileset tile needed
export const WALL_TILE = { sx: 0, sy: 0, sw: 32, sh: 32 }; // unused, walls drawn with fillRect

// Agent desk positions (world coordinates - center of where character sits)
export const DESK_POSITIONS: Record<string, Vec2> = {
  pm:       { x: 7 * 32 + 16, y: 13 * 32 + 16 },  // George
  ux:       { x: 166, y: 212 },                   // Luna
  reviewer: { x: 314, y: 212 },                  // Oscar
  dev:      { x: 166, y: 248 },                  // Enzo
  test:     { x: 314, y: 248 },                  // Zara
};

// Founder desk - bottom center of workspace (above desk, facing up)
export const FOUNDER_DESK: Vec2 = { x: 6 * 32 + 16, y: 11 * 32 + 16 };

export const PING_PONG_TABLE = {
  x: 569,
  y: 9 * 32 + 8,
  width: 3 * 32,
  height: 44,
};

// Players stand at the short ends of the ping-pong table, with their vertical
// center aligned to the table's horizontal midline (the net line) so each
// side reads as centered on its half of the court.
export const PING_PONG_SPOTS: Vec2[] = [
  { x: 16 * 32 + 16, y: PING_PONG_TABLE.y + PING_PONG_TABLE.height / 2 },
  { x: 21 * 32 + 16, y: PING_PONG_TABLE.y + PING_PONG_TABLE.height / 2 },
];

export const SEAT_TILES: Set<string> = new Set([
  '7,13', // PM chair
  '5,6', '9,6', // top workstation chairs
  '5,7', '9,7', // bottom workstation chairs
  '3,3', '4,3', '9,3', '10,3', // top lounge chairs
  '17,12', '21,12', // rec room chairs
]);

// Wait spots — green lounge chairs at the top of the workspace (awaiting_human)
export const WAIT_SPOTS: Vec2[] = [
  { x: 3 * 32 + 16, y: 3 * 32 + 16 },
  { x: 4 * 32 + 16, y: 3 * 32 + 16 },
  { x: 9 * 32 + 16, y: 3 * 32 + 16 },
  { x: 10 * 32 + 16, y: 3 * 32 + 16 },
];

// Idle spots where agents wander when not working
export const IDLE_SPOTS: IdleSpot[] = [
  // Kitchen spots (avoiding furniture tiles)
  { x: 16 * 32 + 16, y: 3 * 32 + 16, zone: 'kitchen', kind: 'wander' },
  { x: 18 * 32 + 16, y: 4 * 32 + 16, zone: 'kitchen', kind: 'wander' },
  { x: 20 * 32 + 16, y: 4 * 32 + 16, zone: 'kitchen', kind: 'wander' },
  { x: 18 * 32 + 16, y: 5 * 32 + 16, zone: 'kitchen', kind: 'wander' },
  // Rec room spots
  { x: 16 * 32 + 16, y: 9 * 32 + 16, zone: 'rec', kind: 'wander' },
  { x: 21 * 32 + 16, y: 9 * 32 + 16, zone: 'rec', kind: 'wander' },
  { x: PING_PONG_SPOTS[0].x, y: PING_PONG_SPOTS[0].y, zone: 'rec', kind: 'ping_pong' },
  { x: PING_PONG_SPOTS[1].x, y: PING_PONG_SPOTS[1].y, zone: 'rec', kind: 'ping_pong' },
  { x: 17 * 32 + 16, y: 12 * 32 + 16, zone: 'rec', kind: 'chair' },
  { x: 21 * 32 + 16, y: 12 * 32 + 16, zone: 'rec', kind: 'chair' },
  { x: 16 * 32 + 16, y: 12 * 32 + 16, zone: 'rec', kind: 'wander' },
  { x: 21 * 32 + 16, y: 13 * 32 + 16, zone: 'rec', kind: 'wander' },
  { x: 17 * 32 + 16, y: 14 * 32 + 16, zone: 'rec', kind: 'wander' },
  // Work area spots
  { x: 12 * 32 + 16, y: 4 * 32 + 16, zone: 'work', kind: 'wander' },
  { x: 6 * 32 + 16, y: 7 * 32 + 16, zone: 'work', kind: 'wander' },
  { x: 10 * 32 + 16, y: 10 * 32 + 16, zone: 'work', kind: 'wander' },
];

// Furniture placements - each references a sprite sheet region
// zY = y + srcH for proper depth sorting (zY: 0 for wall-mounted items)
export const FURNITURE: Furniture[] = [
  // === WORKSPACE DESKS (using TV sheet for monitors) ===
  // PM desk monitor
  { sheet: 'tv', srcX: 128, srcY: 0, srcW: 64, srcH: 32, x: 2 * 32, y: 1 * 32 + 8, zY: 1 * 32 + 40 },
  // UX desk monitor
  { sheet: 'tv', srcX: 128, srcY: 0, srcW: 64, srcH: 32, x: 7 * 32, y: 1 * 32 + 8, zY: 1 * 32 + 40 },
  // Dev desk monitor
  { sheet: 'tv', srcX: 128, srcY: 0, srcW: 64, srcH: 32, x: 2 * 32, y: 4 * 32 + 8, zY: 4 * 32 + 40 },
  // Reviewer desk monitor
  { sheet: 'tv', srcX: 128, srcY: 0, srcW: 64, srcH: 32, x: 7 * 32, y: 4 * 32 + 8, zY: 4 * 32 + 40 },

  // === WORKSPACE FURNITURE ===
  // Bookshelves (from livingRoom sheet - row 0 gray, front bookshelf at col 2)
  { sheet: 'livingRoom', srcX: 192, srcY: 0, srcW: 32, srcH: 64, x: 12 * 32, y: 1 * 32, zY: 1 * 32 + 64 },
  { sheet: 'livingRoom', srcX: 192, srcY: 96, srcW: 32, srcH: 64, x: 13 * 32, y: 1 * 32, zY: 1 * 32 + 64 },
  // Plants in workspace
  { sheet: 'flowers', srcX: 0, srcY: 0, srcW: 48, srcH: 64, x: 1 * 32, y: 7 * 32 - 16, zY: 7 * 32 + 48 },
  { sheet: 'flowers', srcX: 96, srcY: 0, srcW: 48, srcH: 64, x: 12 * 32, y: 6 * 32 - 16, zY: 6 * 32 + 48 },
  { sheet: 'flowers', srcX: 192, srcY: 0, srcW: 48, srcH: 64, x: 1 * 32, y: 12 * 32 - 16, zY: 12 * 32 + 48 },
  // Paintings on wall (zY: 0 so they render behind everything)
  { sheet: 'paintings', srcX: 0, srcY: 0, srcW: 32, srcH: 32, x: 5 * 32, y: 0 * 32 + 4, zY: 0 },
  // Lamp
  { sheet: 'lights', srcX: 0, srcY: 0, srcW: 32, srcH: 64, x: 0 * 32 + 16, y: 9 * 32, zY: 9 * 32 + 64 },

  // === FOUNDER DESK (using cupboard for a fancy desk look) ===
  { sheet: 'cupboard', srcX: 0, srcY: 0, srcW: 96, srcH: 64, x: 5 * 32, y: 11 * 32, zY: 11 * 32 + 64 },
  // Founder's monitor
  { sheet: 'tv', srcX: 0, srcY: 0, srcW: 32, srcH: 32, x: 6 * 32, y: 11 * 32 - 8, zY: 11 * 32 + 24 },

  // === KITCHEN ===
  // Fridge
  { sheet: 'kitchen', srcX: 288, srcY: 0, srcW: 64, srcH: 64, x: 22 * 32 - 16, y: 1 * 32, zY: 1 * 32 + 64 },
  // Stove/oven
  { sheet: 'kitchen', srcX: 192, srcY: 0, srcW: 64, srcH: 64, x: 16 * 32 + 16, y: 1 * 32, zY: 1 * 32 + 64 },
  // Counter (cutting board area)
  { sheet: 'kitchen', srcX: 0, srcY: 0, srcW: 32, srcH: 32, x: 19 * 32, y: 1 * 32 + 16, zY: 1 * 32 + 48 },
  // Kitchen table (from misc - pink table)
  { sheet: 'misc', srcX: 256, srcY: 0, srcW: 64, srcH: 32, x: 18 * 32, y: 4 * 32, zY: 4 * 32 + 32 },
  // Kitchen chairs
  { sheet: 'misc', srcX: 320, srcY: 0, srcW: 32, srcH: 32, x: 17 * 32 + 16, y: 4 * 32 + 24, zY: 4 * 32 + 56 },
  { sheet: 'misc', srcX: 352, srcY: 0, srcW: 32, srcH: 32, x: 20 * 32 + 16, y: 4 * 32 + 24, zY: 4 * 32 + 56 },
  // Plant in kitchen
  { sheet: 'flowers', srcX: 48, srcY: 0, srcW: 48, srcH: 64, x: 22 * 32, y: 5 * 32 - 16, zY: 5 * 32 + 48 },

  // === REC ROOM ===
  // Couch (from livingRoom - light blue row 5, front view)
  { sheet: 'livingRoom', srcX: 0, srcY: 5 * 96, srcW: 96, srcH: 32, x: 16 * 32 + 16, y: 12 * 32, zY: 12 * 32 + 32 },
  // Side bookshelf in rec room (green row 3)
  { sheet: 'livingRoom', srcX: 288, srcY: 3 * 96, srcW: 32, srcH: 64, x: 22 * 32, y: 11 * 32, zY: 11 * 32 + 64 },
  // Teddy bears
  { sheet: 'misc', srcX: 0, srcY: 0, srcW: 32, srcH: 32, x: 21 * 32, y: 13 * 32, zY: 13 * 32 + 32 },
  { sheet: 'misc', srcX: 192, srcY: 0, srcW: 32, srcH: 32, x: 22 * 32, y: 13 * 32, zY: 13 * 32 + 32 },
  // Dresser/storage in rec room
  { sheet: 'misc', srcX: 416, srcY: 0, srcW: 64, srcH: 64, x: 22 * 32 - 16, y: 8 * 32, zY: 8 * 32 + 64 },
  // TV in rec room
  { sheet: 'tv', srcX: 192, srcY: 0, srcW: 64, srcH: 32, x: 19 * 32, y: 8 * 32 + 8, zY: 8 * 32 + 40 },
  // Plant in rec room
  { sheet: 'flowers', srcX: 144, srcY: 0, srcW: 48, srcH: 64, x: 16 * 32, y: 8 * 32, zY: 8 * 32 + 64 },
  // Lamp in rec room
  { sheet: 'lights', srcX: 32, srcY: 0, srcW: 32, srcH: 64, x: 16 * 32 + 8, y: 13 * 32 - 16, zY: 13 * 32 + 48 },
  // Painting on rec room wall
  { sheet: 'paintings', srcX: 128, srcY: 0, srcW: 32, srcH: 32, x: 19 * 32, y: 7 * 32 + 4, zY: 0 },
];

// Floor zones for per-room tinting
export type FloorZone = 'work' | 'kitchen' | 'rec';

export function getFloorZone(r: number, c: number): FloorZone {
  if (c >= 15 && c <= 22 && r >= 1 && r <= 6) return 'kitchen';
  if (c >= 15 && c <= 22 && r >= 8 && r <= 14) return 'rec';
  return 'work';
}

// Tiles blocked by furniture — pathfinding treats these like walls, except
// SEAT_TILES are allowed as destinations (for sitting). Keep this in sync
// manually when adding or moving furniture in engine.ts. Programmatic
// derivation from sprite bounds over-blocks because many sprites (chairs in
// particular) have transparent padding that bleeds into neighboring tiles and
// cuts off valid walkways between workstations.
export const FURNITURE_BLOCKED: Set<string> = new Set([
  // Workspace back-wall furniture
  '1,1', '2,1', '3,1', '4,1', '5,1', '6,1', '7,1', '8,1', '9,1', '10,1', '11,1', '12,1', '13,1',
  '1,3', '2,3', '3,3', '4,3', '5,3', '9,3', '10,3', '11,3', '12,3', '13,3',
  // Workspace desk cluster and PM station
  '3,5', '4,5', '5,5', '6,5', '7,5', '8,5', '9,5', '10,5', '11,5',
  // Top workstation chairs — block walk-through, but SEAT_TILES allows them as destinations
  '5,6', '9,6',
  // Bottom workstation chairs
  '5,7', '9,7',
  '3,8', '4,8', '5,8', '6,8', '7,8', '8,8', '9,8', '10,8', '11,8',
  '3,9', '4,9', '5,9', '6,9', '7,9', '8,9', '9,9', '10,9', '11,9',
  '4,11', '5,11', '6,11', '7,11', '8,11', '9,11', '10,11',
  '4,12', '5,12', '6,12', '7,12', '8,12', '9,12', '10,12',
  '7,13',
  '1,13', '13,13', '1,14', '13,14',
  '4,14', '5,14', '6,14', '7,14', '8,14', '9,14', '10,14',
  // Kitchen left-wall appliances
  '15,1', '16,1', '15,2', '16,2', // vending
  '17,1', '17,2',                 // water cooler
  // Kitchen centerpiece and right corner
  '18,1', '19,1', '20,1', '21,1', '22,1',
  '18,2', '19,2', '20,2', '21,2', '22,2',
  // Rec room upper wall furniture (bookshelves + plants overlap row 8 only by a
  // few pixels, so row 8 is intentionally left walkable — otherwise the door
  // opening from the kitchen at (18,7)/(19,7) dead-ends at the ping-pong
  // table and agents can't use it).
  // Ping pong table
  '17,9', '18,9', '19,9', '20,9',
  '17,10', '18,10', '19,10', '20,10',
  // Rec room seating cluster
  '17,11', '18,11', '19,11', '20,11', '21,11',
  '17,12', '18,12', '19,12', '20,12', '21,12',
  '18,13', '19,13', '20,13',
  // Rec room lower plants
  '15,14', '16,14', '22,14',
]);


// Zone labels for rendering
export const ZONE_LABELS = [
  { text: 'WORKSPACE', x: 7 * 32, y: 0 * 32 + 20 },
  { text: 'KITCHEN', x: 18 * 32 + 16, y: 0 * 32 + 20 },
  { text: 'REC ROOM', x: 20 * 32, y: 7 * 32 + 20 },
];
