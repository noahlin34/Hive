import { Tool } from '../Core/Tools';
import type { GridProjector } from '../ECS/World';

export interface GridCell {
  x: number;
  y: number;
}

export class GridSystem implements GridProjector {
  public readonly cellSize: number;
  public readonly columns: number;
  public readonly rows: number;
  private hoveredCellInternal: GridCell | null = null;

  public constructor(cellSize: number, columns: number, rows: number) {
    this.cellSize = cellSize;
    this.columns = columns;
    this.rows = rows;
  }

  public get widthPx(): number {
    return this.columns * this.cellSize;
  }

  public get heightPx(): number {
    return this.rows * this.cellSize;
  }

  public get hoveredCell(): GridCell | null {
    return this.hoveredCellInternal;
  }

  public clearHover(): void {
    this.hoveredCellInternal = null;
  }

  public setHoverFromScreen(pixelX: number, pixelY: number): void {
    this.hoveredCellInternal = this.screenToGrid(pixelX, pixelY);
  }

  public gridToScreen(gridX: number, gridY: number): { x: number; y: number } {
    // Grid-space is measured in tile units. Pixel-space is measured in screen pixels.
    // Multiplying by cellSize moves from tile index -> top-left pixel of that tile.
    return {
      x: gridX * this.cellSize,
      y: gridY * this.cellSize,
    };
  }

  public screenToGrid(pixelX: number, pixelY: number): GridCell | null {
    const gridX = Math.floor(pixelX / this.cellSize);
    const gridY = Math.floor(pixelY / this.cellSize);

    const withinBounds =
      gridX >= 0 &&
      gridY >= 0 &&
      gridX < this.columns &&
      gridY < this.rows;

    if (!withinBounds) {
      return null;
    }

    return { x: gridX, y: gridY };
  }
}

export class GridRenderer {
  public static drawGrid(ctx: CanvasRenderingContext2D, grid: GridSystem): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;

    for (let x = 0; x <= grid.columns; x += 1) {
      const pixelX = x * grid.cellSize;
      ctx.beginPath();
      ctx.moveTo(pixelX + 0.5, 0);
      ctx.lineTo(pixelX + 0.5, grid.heightPx);
      ctx.stroke();
    }

    for (let y = 0; y <= grid.rows; y += 1) {
      const pixelY = y * grid.cellSize;
      ctx.beginPath();
      ctx.moveTo(0, pixelY + 0.5);
      ctx.lineTo(grid.widthPx, pixelY + 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }

  public static drawToolGhost(
    ctx: CanvasRenderingContext2D,
    grid: GridSystem,
    cell: GridCell,
    tool: Tool,
    valid: boolean,
    affordable: boolean,
  ): void {
    const { x: pixelX, y: pixelY } = grid.gridToScreen(cell.x, cell.y);

    let fillColor = 'rgba(148, 163, 184, 0.26)';
    let strokeColor = 'rgba(148, 163, 184, 0.8)';

    if (!valid || !affordable) {
      fillColor = 'rgba(239, 68, 68, 0.24)';
      strokeColor = 'rgba(248, 113, 113, 0.9)';
    } else if (tool === Tool.FLOOR) {
      fillColor = 'rgba(148, 163, 184, 0.35)';
      strokeColor = 'rgba(226, 232, 240, 0.95)';
    } else if (tool === Tool.ELEVATOR) {
      fillColor = 'rgba(51, 65, 85, 0.5)';
      strokeColor = 'rgba(148, 163, 184, 0.95)';
    } else if (tool === Tool.DELETE) {
      fillColor = 'rgba(220, 38, 38, 0.3)';
      strokeColor = 'rgba(252, 165, 165, 0.95)';
    }

    ctx.save();
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;

    ctx.fillRect(pixelX, pixelY, grid.cellSize, grid.cellSize);
    ctx.strokeRect(pixelX + 1, pixelY + 1, grid.cellSize - 2, grid.cellSize - 2);

    if (tool === Tool.DELETE) {
      ctx.beginPath();
      ctx.moveTo(pixelX + 5, pixelY + 5);
      ctx.lineTo(pixelX + grid.cellSize - 5, pixelY + grid.cellSize - 5);
      ctx.moveTo(pixelX + grid.cellSize - 5, pixelY + 5);
      ctx.lineTo(pixelX + 5, pixelY + grid.cellSize - 5);
      ctx.stroke();
    }

    ctx.restore();
  }
}
