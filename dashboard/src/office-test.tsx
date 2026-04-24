import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loadAllSprites } from './office/sprites';
import { createInitialState, startGameLoop, AGENT_DEFS, type EngineState } from './office/engine';
import { CANVAS_W, CANVAS_H, PING_PONG_SPOTS } from './office/layout';
import { Direction, CharState } from './office/types';

function Root() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<EngineState | null>(null);
  const params = new URLSearchParams(window.location.search);
  const initialMode = (params.get('mode') as 'active' | 'idle' | 'waiting') || 'active';
  const [mode, setMode] = useState<'active' | 'idle' | 'waiting'>(initialMode);
  const [activeList, setActiveList] = useState<string>('pm,ux,dev,test,reviewer');
  const [loaded, setLoaded] = useState(false);

  const activeSet = new Set(
    mode === 'active' ? activeList.split(',').map((s) => s.trim()).filter(Boolean) : [],
  );
  const waitingSet = new Set(
    mode === 'waiting' ? AGENT_DEFS.map((a) => a.id) : [],
  );

  const activeRef = useRef(activeSet);
  const waitingRef = useRef(waitingSet);
  activeRef.current = activeSet;
  waitingRef.current = waitingSet;

  useEffect(() => {
    const state = createInitialState(activeSet, waitingSet);
    stateRef.current = state;

    // `?pingpong=1` plants two agents directly at the paddle spots so the
    // animation can be inspected without waiting for a 10%-chance spawn.
    if (params.get('pingpong') === '1') {
      const [ux, dev] = [state.characters.get('ux'), state.characters.get('dev')];
      if (ux) { ux.x = PING_PONG_SPOTS[0].x; ux.y = PING_PONG_SPOTS[0].y; ux.state = CharState.IDLE; ux.dir = Direction.RIGHT; ux.idleSpot = -1; }
      if (dev) { dev.x = PING_PONG_SPOTS[1].x; dev.y = PING_PONG_SPOTS[1].y; dev.state = CharState.IDLE; dev.dir = Direction.LEFT; dev.idleSpot = -1; }
    }

    loadAllSprites().then((sprites) => {
      state.sprites = sprites;
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded || !canvasRef.current || !stateRef.current) return;
    const cleanup = startGameLoop(
      canvasRef.current,
      stateRef.current,
      () => activeRef.current,
      () => waitingRef.current,
      () => false,
    );
    return cleanup;
  }, [loaded]);

  useEffect(() => {
    // Wire up the HTML buttons
    const setActive = document.getElementById('set-active');
    const setIdle = document.getElementById('set-idle');
    const setWaiting = document.getElementById('set-waiting');
    const input = document.getElementById('active-input') as HTMLInputElement;
    const onSetActive = () => { setActiveList(input.value); setMode('active'); };
    const onSetIdle = () => setMode('idle');
    const onSetWaiting = () => setMode('waiting');
    setActive?.addEventListener('click', onSetActive);
    setIdle?.addEventListener('click', onSetIdle);
    setWaiting?.addEventListener('click', onSetWaiting);
    return () => {
      setActive?.removeEventListener('click', onSetActive);
      setIdle?.removeEventListener('click', onSetIdle);
      setWaiting?.removeEventListener('click', onSetWaiting);
    };
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 8, fontSize: 12 }}>
        mode: <b>{mode}</b> {mode === 'active' && `(${activeList})`}
      </div>
      <canvas ref={canvasRef} width={CANVAS_W} height={CANVAS_H} style={{ width: CANVAS_W * 2, height: CANVAS_H * 2 }} />
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<Root />);
