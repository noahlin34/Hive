import { useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { GAME_VIEWPORT, Game } from '../engine/Core/Game';
import type { Tool } from '../engine/Core/Tools';

interface GameCanvasProps {
  selectedTool: Tool;
}

export function GameCanvas({ selectedTool }: GameCanvasProps) {
  const worldCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const simulationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameRef = useRef<Game | null>(null);

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
    game.endPrimaryAction(pointer.x, pointer.y);
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
