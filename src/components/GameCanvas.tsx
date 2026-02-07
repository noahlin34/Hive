import { useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { GAME_VIEWPORT, Game } from '../engine/Core/Game';
import type { Tool } from '../engine/Core/Tools';

interface GameCanvasProps {
  selectedTool: Tool | null;
}

export function GameCanvas({ selectedTool }: GameCanvasProps) {
  const worldCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const simulationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<Game | null>(null);
  const pendingPrimaryActionRef = useRef<number | null>(null);
  const lastPrimaryClickRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const DOUBLE_CLICK_WINDOW_MS = 320;
  const DOUBLE_CLICK_MAX_DISTANCE_PX = 18;

  useEffect(() => {
    const worldCanvas = worldCanvasRef.current;
    const simulationCanvas = simulationCanvasRef.current;

    if (!worldCanvas || !simulationCanvas) {
      return;
    }

    const game = new Game(worldCanvas, simulationCanvas);
    gameRef.current = game;
    game.start();

    return () => {
      if (pendingPrimaryActionRef.current !== null) {
        window.clearTimeout(pendingPrimaryActionRef.current);
        pendingPrimaryActionRef.current = null;
      }
      lastPrimaryClickRef.current = null;
      game.dispose();
      gameRef.current = null;
    };
  }, []);

  useEffect(() => {
    gameRef.current?.setTool(selectedTool);
  }, [selectedTool]);

  const getScaledPointerPosition = (
    event: MouseEvent<HTMLCanvasElement>,
  ): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scaleX = GAME_VIEWPORT.width / rect.width;
    const scaleY = GAME_VIEWPORT.height / rect.height;

    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  };

  const handlePointerMove = (event: MouseEvent<HTMLCanvasElement>): void => {
    const game = gameRef.current;
    if (!game) {
      return;
    }

    const pointer = getScaledPointerPosition(event);
    game.updatePrimaryDrag(pointer.x, pointer.y);
  };

  const handlePointerLeave = (): void => {
    if (pendingPrimaryActionRef.current !== null) {
      window.clearTimeout(pendingPrimaryActionRef.current);
      pendingPrimaryActionRef.current = null;
    }
    lastPrimaryClickRef.current = null;
    gameRef.current?.clearPointer();
    gameRef.current?.cancelPrimaryAction();
  };

  const handlePointerDown = (event: MouseEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) {
      return;
    }

    const game = gameRef.current;
    if (!game) {
      return;
    }

    const pointer = getScaledPointerPosition(event);
    game.beginPrimaryAction(pointer.x, pointer.y);
  };

  const handlePointerUp = (event: MouseEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) {
      return;
    }

    const game = gameRef.current;
    if (!game) {
      return;
    }

    const pointer = getScaledPointerPosition(event);
    if (pendingPrimaryActionRef.current !== null) {
      window.clearTimeout(pendingPrimaryActionRef.current);
      pendingPrimaryActionRef.current = null;
    }

    const now = performance.now();
    const lastClick = lastPrimaryClickRef.current;
    const dx = lastClick ? pointer.x - lastClick.x : 0;
    const dy = lastClick ? pointer.y - lastClick.y : 0;
    const withinDistance =
      dx * dx + dy * dy <= DOUBLE_CLICK_MAX_DISTANCE_PX * DOUBLE_CLICK_MAX_DISTANCE_PX;
    const isDoubleClick =
      Boolean(lastClick) && now - (lastClick?.time ?? 0) <= DOUBLE_CLICK_WINDOW_MS && withinDistance;

    if (isDoubleClick) {
      game.cancelPrimaryAction();
      game.handleInspectDoubleClick(pointer.x, pointer.y);
      lastPrimaryClickRef.current = null;
      return;
    }

    lastPrimaryClickRef.current = { time: now, x: pointer.x, y: pointer.y };
    pendingPrimaryActionRef.current = window.setTimeout(() => {
      game.endPrimaryAction(pointer.x, pointer.y);
      pendingPrimaryActionRef.current = null;
      lastPrimaryClickRef.current = null;
    }, DOUBLE_CLICK_WINDOW_MS);
  };

  const handleContextMenu = (event: MouseEvent<HTMLCanvasElement>): void => {
    event.preventDefault();

    const game = gameRef.current;
    if (!game) {
      return;
    }

    const pointer = getScaledPointerPosition(event);
    game.handleCommandClick(pointer.x, pointer.y);
  };

  return (
    <div
      className="relative h-[640px] w-[960px] overflow-hidden rounded-lg border border-slate-700"
      style={{
        width: GAME_VIEWPORT.width,
        height: GAME_VIEWPORT.height,
      }}
    >
      <canvas
        ref={worldCanvasRef}
        className="absolute inset-0"
        aria-label="World Layer"
      />
      <canvas
        ref={simulationCanvasRef}
        className="absolute inset-0"
        aria-label="Simulation Layer"
        onMouseMove={handlePointerMove}
        onMouseLeave={handlePointerLeave}
        onMouseDown={handlePointerDown}
        onMouseUp={handlePointerUp}
        onContextMenu={handleContextMenu}
      />
    </div>
  );
}
