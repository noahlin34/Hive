import { Tool } from '../Core/Tools';
import type { GridProjector } from '../ECS/World';

export interface GridCell {
  x: number;
  y: number;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

const SKY_KEYS: Array<{ minute: number; top: RGB; bottom: RGB }> = [
  {
    minute: 0,
    top: { r: 46, g: 36, b: 84 },
    bottom: { r: 18, g: 27, b: 59 },
  },
  {
    minute: 360,
    top: { r: 99, g: 160, b: 238 },
    bottom: { r: 151, g: 204, b: 255 },
  },
  {
    minute: 720,
    top: { r: 57, g: 198, b: 245 },
    bottom: { r: 166, g: 238, b: 255 },
  },
  {
    minute: 1080,
    top: { r: 241, g: 141, b: 75 },
    bottom: { r: 252, g: 192, b: 120 },
  },
  {
    minute: 1440,
    top: { r: 46, g: 36, b: 84 },
    bottom: { r: 18, g: 27, b: 59 },
  },
];

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

function interpolateColor(a: RGB, b: RGB, t: number): RGB {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function toRgbString(color: RGB): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function getSkyColors(minuteOfDay: number): { top: RGB; bottom: RGB } {
  const normalizedMinute = ((minuteOfDay % 1440) + 1440) % 1440;

  for (let index = 0; index < SKY_KEYS.length - 1; index += 1) {
    const start = SKY_KEYS[index];
    const end = SKY_KEYS[index + 1];

    if (normalizedMinute < start.minute || normalizedMinute > end.minute) {
      continue;
    }

    const duration = end.minute - start.minute;
    const t = duration === 0 ? 0 : (normalizedMinute - start.minute) / duration;

    return {
      top: interpolateColor(start.top, end.top, t),
      bottom: interpolateColor(start.bottom, end.bottom, t),
    };
  }

  return {
    top: SKY_KEYS[0].top,
    bottom: SKY_KEYS[0].bottom,
  };
}

export class GridRenderer {
  public static drawSkyGradient(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    minuteOfDay: number,
  ): void {
    const colors = getSkyColors(minuteOfDay);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, toRgbString(colors.top));
    gradient.addColorStop(1, toRgbString(colors.bottom));

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }

  public static drawGrid(ctx: CanvasRenderingContext2D, grid: GridSystem): void {
    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.24)';
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
    } else if (tool === Tool.ELEVATOR) {
      fillColor = 'rgba(51, 65, 85, 0.5)';
      strokeColor = 'rgba(148, 163, 184, 0.95)';
    } else if (tool === Tool.CONDO) {
      fillColor = 'rgba(20, 184, 166, 0.33)';
      strokeColor = 'rgba(94, 234, 212, 0.95)';
    } else if (tool === Tool.FOOD_COURT) {
      fillColor = 'rgba(251, 191, 36, 0.3)';
      strokeColor = 'rgba(252, 211, 77, 0.95)';
    } else if (tool === Tool.OFFICE || tool === Tool.FLOOR) {
      fillColor = 'rgba(147, 197, 253, 0.3)';
      strokeColor = 'rgba(191, 219, 254, 0.95)';
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
