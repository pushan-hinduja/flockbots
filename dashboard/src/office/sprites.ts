const imageCache = new Map<string, HTMLImageElement>();
const officeDecorUrl = new URL('../../assets/Office Tileset/Office VX Ace/B-C-D-E Office 2.png', import.meta.url).href;

const SPRITE_SHEETS: Record<string, string> = {
  // Character layers (user's asset pack)
  body: '/sprites/character-body.png',
  hair: '/sprites/hairs.png',
  suit: '/sprites/suit.png',
  shadow: '/sprites/shadow.png',
  // Floor tiles (pixel-agents, 16x16 grayscale)
  floor0: '/sprites/floors/floor_0.png',
  floor1: '/sprites/floors/floor_1.png',
  floor2: '/sprites/floors/floor_2.png',
  floor3: '/sprites/floors/floor_3.png',
  workspaceFloor: '/sprites/floors/workspace_floor.png',
  kitchenFloor: '/sprites/floors/kitchen_floor.png',
  recRoomFloor: '/sprites/floors/rec_room_floor.png',
  // Wood floor tiles (32x32 from TilesHouse, drawn at 1x)
  woodFloor0: '/sprites/floors/wood_floor_0.png',
  woodFloor1: '/sprites/floors/wood_floor_1.png',
  // Wall tiles (pixel-agents, 64x128 auto-tile sheet)
  wall0: '/sprites/walls/wall_0.png',
  // Furniture (pixel-agents PNGs)
  deskFront: '/sprites/furniture/DESK_DESK_FRONT.png',
  deskSide: '/sprites/furniture/DESK_DESK_SIDE.png',
  pcFrontOn1: '/sprites/furniture/PC_PC_FRONT_ON_1.png',
  pcFrontOn2: '/sprites/furniture/PC_PC_FRONT_ON_2.png',
  pcBack: '/sprites/furniture/PC_PC_BACK.png',
  pcSide: '/sprites/furniture/PC_PC_SIDE.png',
  bookshelf: '/sprites/furniture/BOOKSHELF_BOOKSHELF.png',
  doubleBookshelf: '/sprites/furniture/DOUBLE_BOOKSHELF_DOUBLE_BOOKSHELF.png',
  plant: '/sprites/furniture/PLANT_PLANT.png',
  plant2: '/sprites/furniture/PLANT_2_PLANT_2.png',
  largePlant: '/sprites/furniture/LARGE_PLANT_LARGE_PLANT.png',
  cactus: '/sprites/furniture/CACTUS_CACTUS.png',
  coffee: '/sprites/furniture/COFFEE_COFFEE.png',
  clock: '/sprites/furniture/CLOCK_CLOCK.png',
  sofaFront: '/sprites/furniture/SOFA_SOFA_FRONT.png',
  sofaSide: '/sprites/furniture/SOFA_SOFA_SIDE.png',
  chairFront: '/sprites/furniture/CUSHIONED_CHAIR_CUSHIONED_CHAIR_FRONT.png',
  chairBack: '/sprites/furniture/CUSHIONED_CHAIR_CUSHIONED_CHAIR_BACK.png',
  chairSide: '/sprites/furniture/CUSHIONED_CHAIR_CUSHIONED_CHAIR_SIDE.png',
  coffeeTable: '/sprites/furniture/COFFEE_TABLE_COFFEE_TABLE.png',
  smallTableFront: '/sprites/furniture/SMALL_TABLE_SMALL_TABLE_FRONT.png',
  smallPainting: '/sprites/furniture/SMALL_PAINTING_SMALL_PAINTING.png',
  smallPainting2: '/sprites/furniture/SMALL_PAINTING_2_SMALL_PAINTING_2.png',
  largePainting: '/sprites/furniture/LARGE_PAINTING_LARGE_PAINTING.png',
  whiteboard: '/sprites/furniture/WHITEBOARD_WHITEBOARD.png',
  bin: '/sprites/furniture/BIN_BIN.png',
  pot: '/sprites/furniture/POT_POT.png',
  hangingPlant: '/sprites/furniture/HANGING_PLANT_HANGING_PLANT.png',
  cushionedBench: '/sprites/furniture/CUSHIONED_BENCH_CUSHIONED_BENCH.png',
  woodenChairFront: '/sprites/furniture/WOODEN_CHAIR_WOODEN_CHAIR_FRONT.png',
  woodenChairBack: '/sprites/furniture/WOODEN_CHAIR_WOODEN_CHAIR_BACK.png',
  tableFront: '/sprites/furniture/TABLE_FRONT_TABLE_FRONT.png',
  // Kitchen furniture (extracted from Kitchen-Sheet)
  counterFront: '/sprites/furniture/KITCHEN_COUNTER_FRONT.png',
  counterFront2: '/sprites/furniture/KITCHEN_COUNTER_FRONT_2.png',
  kitchenMicrowave: '/sprites/furniture/KITCHEN_MICROWAVE.png',
  kitchenStove: '/sprites/furniture/KITCHEN_STOVE.png',
  kitchenFridge: '/sprites/furniture/KITCHEN_FRIDGE.png',
  kitchenVending: '/sprites/furniture/KITCHEN_VENDING.png',
  officeDecor: officeDecorUrl,
  officeCountertop: '/sprites/furniture/OFFICE_COUNTERTOP.png',
  officeVendingMachine: '/sprites/furniture/OFFICE_VENDING_MACHINE.png',
  officeDeskBrown: '/sprites/furniture/OFFICE_DESK_BROWN.png',
  officeDeskSilver: '/sprites/furniture/OFFICE_DESK_SILVER.png',
  officeBoardGreen: '/sprites/furniture/OFFICE_BOARD_GREEN.png',
  officeBoardBlue: '/sprites/furniture/OFFICE_BOARD_BLUE.png',
  officeFrameProcess: '/sprites/furniture/OFFICE_FRAME_PROCESS.png',
  officeFrameWorld: '/sprites/furniture/OFFICE_FRAME_WORLD.png',
  officeFrameCity: '/sprites/furniture/OFFICE_FRAME_CITY.png',
  officeFrameChecklist: '/sprites/furniture/OFFICE_FRAME_CHECKLIST.png',
  officeFileCabinet: '/sprites/furniture/OFFICE_FILE_CABINET.png',
  officeBookcase: '/sprites/furniture/OFFICE_BOOKCASE.png',
  officeDeskDarkGrey: '/sprites/furniture/OFFICE_DESK_DARK_GREY.png',
  officePinkChairUp: '/sprites/furniture/OFFICE_PINK_CHAIR_UP.png',
  officePinkChairDown: '/sprites/furniture/OFFICE_PINK_CHAIR_DOWN.png',
  officeWhiteChairBack: '/sprites/furniture/OFFICE_WHITE_CHAIR_BACK.png',
  officeWhiteChairFront: '/sprites/furniture/OFFICE_WHITE_CHAIR_FRONT.png',
  officeWhiteboardChart1: '/sprites/furniture/OFFICE_WHITEBOARD_CHART_1.png',
  officeWhiteboardChart2: '/sprites/furniture/OFFICE_WHITEBOARD_CHART_2.png',
  officeWhiteboardChart3: '/sprites/furniture/OFFICE_WHITEBOARD_CHART_3.png',
  officeDualMonitorDark: '/sprites/furniture/OFFICE_DUAL_MONITOR_DARK.png',
  officeDualMonitorBlue: '/sprites/furniture/OFFICE_DUAL_MONITOR_BLUE.png',
  officeMonitorBack: '/sprites/furniture/OFFICE_MONITOR_BACK.png',
  officeMonitorBackFull: '/sprites/furniture/OFFICE_MONITOR_BACK_FULL.png',
  officeMonitorDark: '/sprites/furniture/OFFICE_MONITOR_DARK.png',
  officeMonitorBlue: '/sprites/furniture/OFFICE_MONITOR_BLUE.png',
  officeMonitorKbDark: '/sprites/furniture/OFFICE_MONITOR_KB_DARK.png',
  officeMonitorKbBlue: '/sprites/furniture/OFFICE_MONITOR_KB_BLUE.png',
  officeServerTower: '/sprites/furniture/OFFICE_SERVER_TOWER.png',
};

export async function loadAllSprites(): Promise<Map<string, HTMLImageElement>> {
  const promises = Object.entries(SPRITE_SHEETS).map(([key, src]) => {
    return new Promise<[string, HTMLImageElement]>((resolve, reject) => {
      if (imageCache.has(key)) { resolve([key, imageCache.get(key)!]); return; }
      const img = new Image();
      img.onload = () => { imageCache.set(key, img); resolve([key, img]); };
      img.onerror = () => reject(new Error(`Failed to load sprite "${key}" from ${src}`));
      img.src = src;
    });
  });
  const results = await Promise.allSettled(promises);
  const loaded = new Map<string, HTMLImageElement>();

  for (const result of results) {
    if (result.status === 'fulfilled') {
      loaded.set(result.value[0], result.value[1]);
    } else {
      console.warn(result.reason);
    }
  }

  return loaded;
}

export function getSheet(key: string): HTMLImageElement | undefined {
  return imageCache.get(key);
}

// Character sprite frame layout: 24 columns of 32x32 frames per row
// 4 directions × 6 frames each. Order: down(0-5), right(6-11), up(12-17), left(18-23)
const FRAMES_PER_DIR = 6;
const DIRS_PER_CHAR = 4;
const FRAME_SIZE = 32;
const DIRECTION_TO_SHEET_INDEX: Record<number, number> = {
  0: 0, // DOWN
  1: 2, // UP
  2: 1, // RIGHT
  3: 3, // LEFT
};

export function getCharFrameCoords(direction: number, animFrame: number, charVariant: number = 0): { sx: number; sy: number } {
  const dirIndex = DIRECTION_TO_SHEET_INDEX[direction] ?? 0;
  const col = charVariant * (DIRS_PER_CHAR * FRAMES_PER_DIR) + dirIndex * FRAMES_PER_DIR + animFrame;
  return { sx: col * FRAME_SIZE, sy: 0 }; // sy comes from the row param when drawing
}

export function drawCharacter(
  ctx: CanvasRenderingContext2D,
  sprites: Map<string, HTMLImageElement>,
  x: number, y: number,
  bodyRow: number, hairRow: number, suitRow: number,
  direction: number, animFrame: number
) {
  const body = sprites.get('body');
  const hair = sprites.get('hair');
  const suit = sprites.get('suit');
  const shadow = sprites.get('shadow');
  if (!body) return;

  const { sx } = getCharFrameCoords(direction, animFrame);
  const dstX = Math.round(x);
  const dstY = Math.round(y);

  // Shadow underneath
  if (shadow) {
    ctx.globalAlpha = 0.3;
    ctx.drawImage(shadow, 0, 0, 32, 32, dstX, dstY + 16, 32, 16);
    ctx.globalAlpha = 1;
  }

  // Body (skin tone row)
  ctx.drawImage(body, sx, bodyRow * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE, dstX, dstY, FRAME_SIZE, FRAME_SIZE);

  // Suit/outfit overlay
  if (suit) {
    ctx.drawImage(suit, sx, suitRow * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE, dstX, dstY, FRAME_SIZE, FRAME_SIZE);
  }

  // Hair overlay
  if (hair) {
    ctx.drawImage(hair, sx, hairRow * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE, dstX, dstY, FRAME_SIZE, FRAME_SIZE);
  }
}

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprites: Map<string, HTMLImageElement>,
  sheet: string,
  srcX: number, srcY: number, srcW: number, srcH: number,
  dstX: number, dstY: number, dstW?: number, dstH?: number
) {
  const img = sprites.get(sheet);
  if (!img) return;
  ctx.drawImage(img, srcX, srcY, srcW, srcH, Math.round(dstX), Math.round(dstY), dstW ?? srcW, dstH ?? srcH);
}

/** Draw a full furniture PNG at 2x scale (pixel-agents assets are 16px base) */
export function drawFurniture(
  ctx: CanvasRenderingContext2D,
  sprites: Map<string, HTMLImageElement>,
  key: string,
  x: number, y: number,
  scale: number = 2
) {
  const img = sprites.get(key);
  if (!img) return;
  ctx.drawImage(img, 0, 0, img.width, img.height,
    Math.round(x), Math.round(y), img.width * scale, img.height * scale);
}

/** Draw a floor tile (16x16 grayscale) with brown wood tint at 2x */
export function drawFloorTile(
  ctx: CanvasRenderingContext2D,
  sprites: Map<string, HTMLImageElement>,
  floorKey: string,
  x: number, y: number,
  tint: string = '#B89468'
) {
  const img = sprites.get(floorKey);
  if (!img) {
    ctx.fillStyle = tint;
    ctx.fillRect(x, y, 32, 32);
    return;
  }
  // Draw grayscale tile at 2x
  ctx.drawImage(img, 0, 0, 16, 16, x, y, 32, 32);
  // Apply tint using multiply blend mode
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = tint;
  ctx.fillRect(x, y, 32, 32);
  ctx.globalCompositeOperation = 'source-over';
}

/** Draw a wall segment from the wall auto-tile sheet at 2x */
export function drawWallTile(
  ctx: CanvasRenderingContext2D,
  sprites: Map<string, HTMLImageElement>,
  x: number, y: number,
  tint: string = '#3A3A5C'
) {
  const img = sprites.get('wall0');
  if (!img) {
    ctx.fillStyle = tint;
    ctx.fillRect(x, y, 32, 32);
    return;
  }
  // Use the center tile from the auto-tile sheet (isolated wall, position 0,0 in the 4x4 grid)
  // wall_0.png is 64x128 = 4 cols of 16px x 4 rows of 32px
  // Position (0,0) = no connections = full wall block top half
  ctx.drawImage(img, 0, 0, 16, 16, x, y, 32, 32);
  // Apply tint
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = tint;
  ctx.fillRect(x, y, 32, 32);
  ctx.globalCompositeOperation = 'source-over';
}

export { FRAME_SIZE };
