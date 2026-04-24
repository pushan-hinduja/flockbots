import type { Vec2, TileType } from './types';
import { FURNITURE_BLOCKED, SEAT_TILES } from './layout';

export function findPath(
  startX: number, startY: number,
  endX: number, endY: number,
  grid: TileType[][],
  tileSize: number
): Vec2[] {
  const cols = grid[0].length;
  const rows = grid.length;

  // Convert world coords to grid coords
  const sc = Math.floor(startX / tileSize);
  const sr = Math.floor(startY / tileSize);
  const ec = Math.floor(endX / tileSize);
  const er = Math.floor(endY / tileSize);

  if (sc === ec && sr === er) return [];
  if (er < 0 || er >= rows || ec < 0 || ec >= cols) return [];
  if (grid[er][ec] === 1) return []; // Target is wall

  const visited = new Set<string>();
  const queue: { col: number; row: number; path: { col: number; row: number }[] }[] = [];
  const key = (c: number, r: number) => `${c},${r}`;
  const targetKey = key(ec, er);
  const targetIsSeat = SEAT_TILES.has(targetKey);

  visited.add(key(sc, sr));
  queue.push({ col: sc, row: sr, path: [] });

  const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]]; // up, down, left, right

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const [dc, dr] of dirs) {
      const nc = current.col + dc;
      const nr = current.row + dr;
      const k = key(nc, nr);

      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (visited.has(k)) continue;
      if (grid[nr][nc] === 1) continue; // Wall
      if (FURNITURE_BLOCKED.has(k) && !(targetIsSeat && k === targetKey)) continue; // Furniture

      visited.add(k);
      const newPath = [...current.path, { col: nc, row: nr }];

      if (nc === ec && nr === er) {
        // Convert grid path back to world coords (center of tile)
        return newPath.map(p => ({
          x: p.col * tileSize + tileSize / 2,
          y: p.row * tileSize + tileSize / 2,
        }));
      }

      queue.push({ col: nc, row: nr, path: newPath });
    }
  }

  // No path found — do not walk through walls or furniture.
  return [];
}
