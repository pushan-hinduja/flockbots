import { useEffect, useRef, useState } from 'react';

const FRAME_SIZE = 32;

// Cache loaded sprite sheets across mounts.
const sheetCache = new Map<string, Promise<HTMLImageElement>>();
function loadSheet(src: string): Promise<HTMLImageElement> {
  let p = sheetCache.get(src);
  if (p) return p;
  p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
  sheetCache.set(src, p);
  return p;
}

interface AgentSpriteThumbProps {
  bodyRow: number;
  hairRow: number;
  suitRow: number;
  /** Rendered pixel size of each side (sprite is always 32×32 source). */
  size?: number;
}

export function AgentSpriteThumb({ bodyRow, hairRow, suitRow, size = 56 }: AgentSpriteThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      loadSheet('/sprites/character-body.png'),
      loadSheet('/sprites/hairs.png'),
      loadSheet('/sprites/suit.png'),
    ]).then(([body, hair, suit]) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, FRAME_SIZE, FRAME_SIZE);

      // DOWN direction, frame 0 = column 0 of the sheet, row = bodyRow/etc.
      ctx.drawImage(body, 0, bodyRow * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE, 0, 0, FRAME_SIZE, FRAME_SIZE);
      ctx.drawImage(suit, 0, suitRow * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE, 0, 0, FRAME_SIZE, FRAME_SIZE);
      ctx.drawImage(hair, 0, hairRow * FRAME_SIZE, FRAME_SIZE, FRAME_SIZE, 0, 0, FRAME_SIZE, FRAME_SIZE);
      setReady(true);
    }).catch(err => {
      console.warn('AgentSpriteThumb load failed:', err);
    });
    return () => { cancelled = true; };
  }, [bodyRow, hairRow, suitRow]);

  return (
    <canvas
      ref={canvasRef}
      width={FRAME_SIZE}
      height={FRAME_SIZE}
      style={{
        width: size,
        height: size,
        imageRendering: 'pixelated',
        opacity: ready ? 1 : 0,
        transition: 'opacity 180ms ease',
      }}
    />
  );
}
