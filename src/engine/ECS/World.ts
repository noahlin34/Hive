import { Tool, TOOL_COSTS } from '../Core/Tools';
import type { GridCell } from '../Renderer/GridRenderer';

export type EntityId = number;

export interface Position {
  x: number;
  y: number;
}

export interface Velocity {
  dx: number;
  dy: number;
}

export interface Renderable {
  color: string;
  shape: 'square' | 'circle';
  sizeScale?: number;
}

export type AgentMood = 'happy' | 'neutral' | 'angry';
export type AgentArchetype = 'VISITOR' | 'RESIDENT' | 'OFFICE_WORKER';
export type AgentRoutine =
  | 'VISITING'
  | 'SHOPPING'
  | 'LEAVING'
  | 'HOME'
  | 'WANDERING'
  | 'COMMUTING_TO_WORK'
  | 'WORKING'
  | 'LUNCH_BREAK'
  | 'COMMUTING_HOME';

export type AgentPhase =
  | 'IDLE'
  | 'WALK_TO_SHAFT'
  | 'WAIT_AT_SHAFT'
  | 'RIDING'
  | 'WALK_TO_TARGET'
  | 'AT_TARGET';

export type TravelDirection = 'UP' | 'DOWN' | 'NONE';

export interface Agent {
  name: string;
  archetype: AgentArchetype;
  routine: AgentRoutine;
  mood: AgentMood;
  speed: number;
  phase: AgentPhase;
  stress: number;
  waitMs: number;
  nextActionMinute: number;
  leaveByMinute: number | null;
  hasLunchedToday: boolean;
  sourceFloorY: number | null;
  targetFloorY: number | null;
  targetX: number;
  targetY: number;
  homeX: number | null;
  homeY: number | null;
  workX: number | null;
  workY: number | null;
  desiredDirection: TravelDirection;
  assignedShaftX: number | null;
  waitX: number | null;
  assignedCarId: EntityId | null;
  callRegistered: boolean;
  despawnOnArrival: boolean;
}

export type ScheduleStage =
  | 'COMMUTE_TO_OFFICE'
  | 'AT_OFFICE'
  | 'TO_LUNCH'
  | 'AT_LUNCH'
  | 'RETURN_TO_OFFICE'
  | 'TO_HOME';

export interface Schedule {
  role: 'OFFICE_WORKER';
  stage: ScheduleStage;
  officeX: number;
  officeY: number;
  homeX: number;
  lunchReleaseMinute: number | null;
}

export type RoomZone = 'HALLWAY' | 'LOBBY' | 'OFFICE' | 'CONDO' | 'FOOD_COURT';

export interface Floor {
  kind: 'floor';
  zone: RoomZone;
  occupied: boolean;
  rent: number;
  windowSeed: number;
}

export interface Elevator {
  kind: 'elevator_shaft';
}

export type ElevatorState = 'IDLE' | 'MOVING' | 'LOADING' | 'UNLOADING';

export interface ElevatorCar {
  state: ElevatorState;
  direction: TravelDirection;
  speed: number;
  column: number;
  bankId: number;
  stopQueue: number[];
  phaseTimerMs: number;
  capacity: number;
  occupants: EntityId[];
}

export interface Influence {
  noiseRadius: number;
  noiseIntensity: number;
}

export interface Condo {
  noiseSensitivity: number;
  warningActive: boolean;
  warningMinutes: number;
  occupied: boolean;
}

export interface FloatingText {
  text: string;
  color: string;
  ageMs: number;
  ttlMs: number;
  risePerSecond: number;
}

export interface ComponentRegistry {
  position: Position;
  velocity: Velocity;
  renderable: Renderable;
  agent: Agent;
  schedule: Schedule;
  floor: Floor;
  elevator: Elevator;
  elevatorCar: ElevatorCar;
  influence: Influence;
  condo: Condo;
  floatingText: FloatingText;
}

type ComponentKey = keyof ComponentRegistry;
type StructureKey = 'floor' | 'elevator';

type ComponentStores = {
  [K in ComponentKey]: Map<EntityId, ComponentRegistry[K]>;
};

export interface GridProjector {
  readonly cellSize: number;
  gridToScreen(gridX: number, gridY: number): { x: number; y: number };
}

export interface PlacementPreview {
  cell: GridCell;
  valid: boolean;
  affordable: boolean;
  tool: Tool;
}

export interface FloorDragPreview {
  cells: GridCell[];
  valid: boolean;
  affordable: boolean;
  cost: number;
}

export interface PlacementResult {
  changedMap: boolean;
  spent: number;
  errorMessage?: string;
}

interface ElevatorBank {
  id: number;
  columns: number[];
}

const WAIT_STRESS_THRESHOLD_MS = 15000;
const STRESS_GAIN_PER_SECOND = 6;
const STRESS_DECAY_PER_SECOND = 2.2;

const DISPATCH_DIRECTION_PENALTY = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function moveTowards(
  current: number,
  target: number,
  maxDelta: number,
): { value: number; arrived: boolean } {
  const delta = target - current;

  if (Math.abs(delta) <= maxDelta) {
    return { value: target, arrived: true };
  }

  return {
    value: current + Math.sign(delta) * maxDelta,
    arrived: false,
  };
}

function computeDirection(sourceFloorY: number, targetFloorY: number): TravelDirection {
  if (targetFloorY < sourceFloorY) {
    return 'UP';
  }

  if (targetFloorY > sourceFloorY) {
    return 'DOWN';
  }

  return 'NONE';
}

function dedupeStops(stops: number[]): number[] {
  const result: number[] = [];

  for (const stop of stops) {
    if (result.includes(stop)) {
      continue;
    }

    result.push(stop);
  }

  return result;
}

function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export class ECSWorld {
  private nextEntityId: EntityId = 1;
  private readonly entities = new Set<EntityId>();
  private readonly components: ComponentStores = {
    position: new Map<EntityId, Position>(),
    velocity: new Map<EntityId, Velocity>(),
    renderable: new Map<EntityId, Renderable>(),
    agent: new Map<EntityId, Agent>(),
    schedule: new Map<EntityId, Schedule>(),
    floor: new Map<EntityId, Floor>(),
    elevator: new Map<EntityId, Elevator>(),
    elevatorCar: new Map<EntityId, ElevatorCar>(),
    influence: new Map<EntityId, Influence>(),
    condo: new Map<EntityId, Condo>(),
    floatingText: new Map<EntityId, FloatingText>(),
  };

  public createEntity(): EntityId {
    const id = this.nextEntityId;
    this.nextEntityId += 1;
    this.entities.add(id);
    return id;
  }

  public destroyEntity(entityId: EntityId): void {
    this.entities.delete(entityId);

    for (const key of Object.keys(this.components) as ComponentKey[]) {
      this.components[key].delete(entityId);
    }
  }

  public addComponent<K extends ComponentKey>(
    entityId: EntityId,
    key: K,
    component: ComponentRegistry[K],
  ): void {
    if (!this.entities.has(entityId)) {
      throw new Error(`Cannot add component to unknown entity ${entityId}`);
    }

    this.components[key].set(entityId, component);
  }

  public getComponent<K extends ComponentKey>(
    entityId: EntityId,
    key: K,
  ): ComponentRegistry[K] | undefined {
    return this.components[key].get(entityId);
  }

  public removeComponent<K extends ComponentKey>(entityId: EntityId, key: K): void {
    this.components[key].delete(entityId);
  }

  public query<K extends ComponentKey>(...required: K[]): EntityId[] {
    const result: EntityId[] = [];

    entityLoop: for (const entityId of this.entities) {
      for (const key of required) {
        if (!this.components[key].has(entityId)) {
          continue entityLoop;
        }
      }

      result.push(entityId);
    }

    return result;
  }
}

export class RenderSystem {
  private readonly world: ECSWorld;
  private readonly projector: GridProjector;

  public constructor(world: ECSWorld, projector: GridProjector) {
    this.world = world;
    this.projector = projector;
  }

  public render(ctx: CanvasRenderingContext2D): void {
    this.renderElevatorCables(ctx);
    this.renderShapes(ctx);
    this.renderCondoWarnings(ctx);
    this.renderFloatingText(ctx);
  }

  private renderElevatorCables(ctx: CanvasRenderingContext2D): void {
    const boundsByColumn = new Map<number, { minY: number; maxY: number }>();

    for (const shaftEntity of this.world.query('position', 'elevator')) {
      const shaftPosition = this.world.getComponent(shaftEntity, 'position');
      if (!shaftPosition) {
        continue;
      }

      const existing = boundsByColumn.get(shaftPosition.x);
      if (!existing) {
        boundsByColumn.set(shaftPosition.x, {
          minY: shaftPosition.y,
          maxY: shaftPosition.y,
        });
      } else {
        existing.minY = Math.min(existing.minY, shaftPosition.y);
        existing.maxY = Math.max(existing.maxY, shaftPosition.y);
      }
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
    ctx.lineWidth = 2;

    for (const carEntity of this.world.query('position', 'elevatorCar')) {
      const car = this.world.getComponent(carEntity, 'elevatorCar');
      const position = this.world.getComponent(carEntity, 'position');
      if (!car || !position) {
        continue;
      }

      const bounds = boundsByColumn.get(car.column);
      if (!bounds) {
        continue;
      }

      const centerX = this.projector.gridToScreen(car.column + 0.5, 0).x;
      const topY = this.projector.gridToScreen(0, bounds.minY).y + 4;
      const carCenterY = this.projector.gridToScreen(0, position.y + 0.5).y;

      ctx.beginPath();
      ctx.moveTo(centerX, topY);
      ctx.lineTo(centerX, carCenterY);
      ctx.stroke();

      const mirroredGridY = bounds.minY + bounds.maxY - position.y;
      const counterweightPixel = this.projector.gridToScreen(car.column + 0.08, mirroredGridY + 0.2);
      const weightWidth = this.projector.cellSize * 0.26;
      const weightHeight = this.projector.cellSize * 0.6;

      ctx.fillStyle = 'rgba(203, 213, 225, 0.65)';
      ctx.fillRect(counterweightPixel.x, counterweightPixel.y, weightWidth, weightHeight);

      ctx.beginPath();
      ctx.moveTo(counterweightPixel.x + weightWidth * 0.5, topY);
      ctx.lineTo(counterweightPixel.x + weightWidth * 0.5, counterweightPixel.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  private renderShapes(ctx: CanvasRenderingContext2D): void {
    for (const entityId of this.world.query('position', 'renderable')) {
      const position = this.world.getComponent(entityId, 'position');
      const renderable = this.world.getComponent(entityId, 'renderable');

      if (!position || !renderable) {
        continue;
      }

      const { x: pixelX, y: pixelY } = this.projector.gridToScreen(position.x, position.y);
      const size = this.projector.cellSize * (renderable.sizeScale ?? 1);
      const offset = (this.projector.cellSize - size) * 0.5;
      const drawX = pixelX + offset;
      const drawY = pixelY + offset;

      if (renderable.shape === 'circle') {
        const radius = size * 0.5;
        ctx.fillStyle = renderable.color;
        ctx.beginPath();
        ctx.arc(drawX + radius, drawY + radius, radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = renderable.color;
        ctx.fillRect(drawX, drawY, size, size);
      }

      const agent = this.world.getComponent(entityId, 'agent');
      if (agent) {
        const moodOutline =
          agent.mood === 'happy'
            ? '#22c55e'
            : agent.mood === 'angry'
              ? '#ef4444'
              : '#facc15';

        ctx.strokeStyle = moodOutline;
        ctx.lineWidth = 2;
        ctx.strokeRect(drawX + 1, drawY + 1, size - 2, size - 2);
      }

      const elevatorCar = this.world.getComponent(entityId, 'elevatorCar');
      if (elevatorCar) {
        const glow =
          elevatorCar.state === 'LOADING' || elevatorCar.state === 'UNLOADING'
            ? 'rgba(56, 189, 248, 0.85)'
            : 'rgba(148, 163, 184, 0.75)';

        ctx.strokeStyle = glow;
        ctx.lineWidth = 2;
        ctx.strokeRect(drawX + 2, drawY + 2, size - 4, size - 4);
      }
    }
  }

  private renderCondoWarnings(ctx: CanvasRenderingContext2D): void {
    for (const entityId of this.world.query('position', 'floor', 'condo')) {
      const position = this.world.getComponent(entityId, 'position');
      const condo = this.world.getComponent(entityId, 'condo');

      if (!position || !condo || !condo.warningActive) {
        continue;
      }

      const bubble = this.projector.gridToScreen(position.x + 0.5, position.y - 0.35);
      const radius = this.projector.cellSize * 0.2;

      ctx.save();
      ctx.fillStyle = 'rgba(239, 68, 68, 0.92)';
      ctx.beginPath();
      ctx.arc(bubble.x, bubble.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.font = '700 11px "IBM Plex Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', bubble.x, bubble.y + 0.5);
      ctx.restore();
    }
  }

  private renderFloatingText(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.font = '700 14px "IBM Plex Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const entityId of this.world.query('position', 'floatingText')) {
      const position = this.world.getComponent(entityId, 'position');
      const floatingText = this.world.getComponent(entityId, 'floatingText');

      if (!position || !floatingText) {
        continue;
      }

      const alpha = clamp(1 - floatingText.ageMs / floatingText.ttlMs, 0, 1);
      const pixel = this.projector.gridToScreen(position.x + 0.5, position.y);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = floatingText.color;
      ctx.fillText(floatingText.text, pixel.x, pixel.y);
      ctx.restore();
    }

    ctx.restore();
  }
}

export class MouseSystem {
  private readonly world: ECSWorld;
  private readonly groundRow: number;
  private hoveredCell: GridCell | null = null;

  public constructor(world: ECSWorld, groundRow: number) {
    this.world = world;
    this.groundRow = groundRow;
  }

  public setHoveredCell(cell: GridCell | null): void {
    this.hoveredCell = cell;
  }

  public clearHoveredCell(): void {
    this.hoveredCell = null;
  }

  public getHoveredCell(): GridCell | null {
    return this.hoveredCell;
  }

  public hasFloorAt(cell: GridCell): boolean {
    return this.getEntityByTypeAt(cell, 'floor') !== null;
  }

  public getPlacementPreview(tool: Tool, funds: number): PlacementPreview | null {
    if (!this.hoveredCell) {
      return null;
    }

    const cost =
      tool === Tool.FLOOR
        ? TOOL_COSTS[Tool.FLOOR]
        : tool === Tool.OFFICE || tool === Tool.CONDO || tool === Tool.FOOD_COURT
          ? this.getRoomFootprint(tool, this.hoveredCell).length * TOOL_COSTS[tool]
          : TOOL_COSTS[tool];
    return {
      cell: this.hoveredCell,
      valid: this.isValidPlacement(tool, this.hoveredCell),
      affordable: funds >= cost,
      tool,
    };
  }

  public getFloorDragPreview(
    start: GridCell,
    end: GridCell,
    funds: number,
  ): FloorDragPreview {
    const cells = this.getFloorDragCells(start, end);
    const valid = this.canBuildFloorCells(cells);
    const cost = cells.length * TOOL_COSTS[Tool.FLOOR];

    return {
      cells,
      valid,
      affordable: funds >= cost,
      cost,
    };
  }

  public applyFloorDrag(start: GridCell, end: GridCell, funds: number): PlacementResult {
    const preview = this.getFloorDragPreview(start, end, funds);

    if (!preview.valid) {
      return {
        changedMap: false,
        spent: 0,
        errorMessage: 'Invalid floor placement',
      };
    }

    if (!preview.affordable) {
      return {
        changedMap: false,
        spent: 0,
        errorMessage: 'Insufficient funds',
      };
    }

    for (const cell of preview.cells) {
      this.spawnFloorSegment(cell);
    }

    return {
      changedMap: preview.cells.length > 0,
      spent: preview.cost,
    };
  }

  public applyToolAtHoveredCell(tool: Tool, funds: number): PlacementResult {
    const cell = this.hoveredCell;
    if (!cell) {
      return { changedMap: false, spent: 0 };
    }

    if (tool === Tool.DELETE) {
      const target = this.getStructureEntityAt(cell);
      if (target === null) {
        return { changedMap: false, spent: 0 };
      }

      this.world.destroyEntity(target);
      return { changedMap: true, spent: 0 };
    }

    if (tool === Tool.FLOOR) {
      return this.applyFloorDrag(cell, cell, funds);
    }

    if (tool === Tool.OFFICE || tool === Tool.CONDO || tool === Tool.FOOD_COURT) {
      return this.applyRoomPlacement(tool, cell, funds);
    }

    const cost = TOOL_COSTS[tool];
    if (funds < cost || !this.isValidPlacement(tool, cell)) {
      return {
        changedMap: false,
        spent: 0,
      };
    }

    if (tool === Tool.ELEVATOR) {
      const entity = this.world.createEntity();
      this.world.addComponent(entity, 'position', { x: cell.x, y: cell.y });
      this.world.addComponent(entity, 'elevator', { kind: 'elevator_shaft' });
      return { changedMap: true, spent: cost };
    }

    return { changedMap: false, spent: 0 };
  }

  private isValidPlacement(tool: Tool, cell: GridCell): boolean {
    if (tool === Tool.DELETE) {
      return this.getStructureEntityAt(cell) !== null;
    }

    if (tool === Tool.ELEVATOR) {
      if (this.getStructureEntityAt(cell) !== null) {
        return false;
      }
      return this.isValidElevatorPlacement(cell);
    }

    if (tool === Tool.FLOOR) {
      if (this.getStructureEntityAt(cell) !== null) {
        return false;
      }

      return this.isValidFloorSegmentPlacement(cell, new Set<string>());
    }

    if (tool === Tool.OFFICE || tool === Tool.CONDO || tool === Tool.FOOD_COURT) {
      return this.canPlaceRoom(tool, cell);
    }

    return false;
  }

  private applyRoomPlacement(tool: Tool, anchor: GridCell, funds: number): PlacementResult {
    const footprint = this.getRoomFootprint(tool, anchor);
    const cost = footprint.length * TOOL_COSTS[tool];

    if (funds < cost) {
      return {
        changedMap: false,
        spent: 0,
        errorMessage: 'Insufficient funds',
      };
    }

    const placementCheck = this.checkRoomPlacement(tool, anchor);
    if (!placementCheck.valid) {
      return {
        changedMap: false,
        spent: 0,
        errorMessage: placementCheck.requiresFloor ? 'Requires Floor' : 'Invalid placement',
      };
    }

    for (const cell of footprint) {
      const floorEntity = this.getEntityByTypeAt(cell, 'floor');
      if (floorEntity === null) {
        continue;
      }

      const floor = this.world.getComponent(floorEntity, 'floor');
      if (!floor) {
        continue;
      }

      floor.zone =
        tool === Tool.OFFICE
          ? 'OFFICE'
          : tool === Tool.CONDO
            ? 'CONDO'
            : 'FOOD_COURT';
      floor.occupied = true;
      floor.rent = floor.zone === 'FOOD_COURT' ? 0 : 100;

      if (floor.zone === 'OFFICE') {
        this.world.addComponent(floorEntity, 'influence', {
          noiseRadius: 2,
          noiseIntensity: 5,
        });
        this.world.removeComponent(floorEntity, 'condo');
      } else if (floor.zone === 'CONDO') {
        this.world.removeComponent(floorEntity, 'influence');
        this.world.addComponent(floorEntity, 'condo', {
          noiseSensitivity: 9 + Math.floor(Math.random() * 6),
          warningActive: false,
          warningMinutes: 0,
          occupied: true,
        });
      } else {
        this.world.removeComponent(floorEntity, 'influence');
        this.world.removeComponent(floorEntity, 'condo');
      }
    }

    return {
      changedMap: true,
      spent: cost,
    };
  }

  private canPlaceRoom(tool: Tool, anchor: GridCell): boolean {
    return this.checkRoomPlacement(tool, anchor).valid;
  }

  private checkRoomPlacement(
    tool: Tool,
    anchor: GridCell,
  ): { valid: boolean; requiresFloor: boolean } {
    const footprint = this.getRoomFootprint(tool, anchor);

    if (tool === Tool.CONDO && anchor.y === this.groundRow) {
      return { valid: false, requiresFloor: false };
    }

    if (tool === Tool.FOOD_COURT && anchor.y !== this.groundRow) {
      return { valid: false, requiresFloor: false };
    }

    for (const cell of footprint) {
      const floorEntity = this.getEntityByTypeAt(cell, 'floor');
      if (floorEntity === null) {
        return { valid: false, requiresFloor: true };
      }

      const floor = this.world.getComponent(floorEntity, 'floor');
      if (!floor) {
        return { valid: false, requiresFloor: true };
      }

      if (floor.zone !== 'HALLWAY' && floor.zone !== 'LOBBY') {
        return { valid: false, requiresFloor: false };
      }
    }

    return { valid: true, requiresFloor: false };
  }

  private getRoomFootprint(tool: Tool, anchor: GridCell): GridCell[] {
    if (tool !== Tool.OFFICE && tool !== Tool.CONDO && tool !== Tool.FOOD_COURT) {
      return [anchor];
    }

    const width = tool === Tool.FOOD_COURT ? 3 : 2;
    const footprint: GridCell[] = [];

    for (let offset = 0; offset < width; offset += 1) {
      footprint.push({ x: anchor.x + offset, y: anchor.y });
    }

    return footprint;
  }

  private spawnFloorSegment(cell: GridCell): void {
    const entity = this.world.createEntity();
    this.world.addComponent(entity, 'position', { x: cell.x, y: cell.y });
    this.world.addComponent(entity, 'floor', {
      kind: 'floor',
      zone: cell.y === this.groundRow ? 'LOBBY' : 'HALLWAY',
      occupied: true,
      rent: 0,
      windowSeed: Math.floor(pseudoRandom(entity + cell.x * 17 + cell.y * 31) * 10000),
    });
  }

  private getFloorDragCells(start: GridCell, end: GridCell): GridCell[] {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const y = start.y;
    const cells: GridCell[] = [];

    for (let x = minX; x <= maxX; x += 1) {
      cells.push({ x, y });
    }

    return cells;
  }

  private canBuildFloorCells(cells: GridCell[]): boolean {
    if (cells.length === 0) {
      return false;
    }

    const planned = new Set(cells.map((cell) => this.cellKey(cell)));
    let hasExternalSupport = cells[0].y === this.groundRow;

    for (const cell of cells) {
      if (this.getStructureEntityAt(cell) !== null) {
        return false;
      }

      if (this.hasExistingFloorNeighbor(cell)) {
        hasExternalSupport = true;
      }

      if (!this.isValidFloorSegmentPlacement(cell, planned)) {
        return false;
      }
    }

    return hasExternalSupport;
  }

  private isValidFloorSegmentPlacement(cell: GridCell, planned: Set<string>): boolean {
    if (cell.y === this.groundRow) {
      return true;
    }

    const neighbors: GridCell[] = [
      { x: cell.x - 1, y: cell.y },
      { x: cell.x + 1, y: cell.y },
      { x: cell.x, y: cell.y - 1 },
      { x: cell.x, y: cell.y + 1 },
    ];

    return neighbors.some((neighbor) => {
      if (this.getEntityByTypeAt(neighbor, 'floor') !== null) {
        return true;
      }

      return planned.has(this.cellKey(neighbor));
    });
  }

  private hasExistingFloorNeighbor(cell: GridCell): boolean {
    const neighbors: GridCell[] = [
      { x: cell.x - 1, y: cell.y },
      { x: cell.x + 1, y: cell.y },
      { x: cell.x, y: cell.y - 1 },
      { x: cell.x, y: cell.y + 1 },
    ];

    return neighbors.some((neighbor) => this.getEntityByTypeAt(neighbor, 'floor') !== null);
  }

  private isValidElevatorPlacement(cell: GridCell): boolean {
    const hasVerticalNeighbor =
      this.getEntityByTypeAt({ x: cell.x, y: cell.y - 1 }, 'elevator') !== null ||
      this.getEntityByTypeAt({ x: cell.x, y: cell.y + 1 }, 'elevator') !== null;

    return hasVerticalNeighbor || cell.y === this.groundRow;
  }

  private getStructureEntityAt(cell: GridCell): EntityId | null {
    const floorEntity = this.getEntityByTypeAt(cell, 'floor');
    if (floorEntity !== null) {
      return floorEntity;
    }

    return this.getEntityByTypeAt(cell, 'elevator');
  }

  private getEntityByTypeAt(cell: GridCell, type: StructureKey): EntityId | null {
    for (const entityId of this.world.query('position', type)) {
      const position = this.world.getComponent(entityId, 'position');
      if (!position) {
        continue;
      }

      if (position.x === cell.x && position.y === cell.y) {
        return entityId;
      }
    }

    return null;
  }

  private cellKey(cell: GridCell): string {
    return `${cell.x},${cell.y}`;
  }
}

export class AgentSystem {
  private readonly world: ECSWorld;
  private readonly groundRow: number;

  public constructor(world: ECSWorld, groundRow: number) {
    this.world = world;
    this.groundRow = groundRow;
  }

  public issueTrip(agentId: EntityId, targetFloor: GridCell, despawnOnArrival: boolean): boolean {
    const agent = this.world.getComponent(agentId, 'agent');
    const position = this.world.getComponent(agentId, 'position');

    if (!agent || !position) {
      return false;
    }

    const sourceFloorY = Math.round(position.y);

    agent.targetX = targetFloor.x;
    agent.targetY = targetFloor.y;
    agent.targetFloorY = targetFloor.y;
    agent.sourceFloorY = sourceFloorY;
    agent.desiredDirection = computeDirection(sourceFloorY, targetFloor.y);
    agent.assignedCarId = null;
    agent.waitX = null;
    agent.callRegistered = false;
    agent.waitMs = 0;
    agent.despawnOnArrival = despawnOnArrival;

    if (sourceFloorY === targetFloor.y) {
      agent.assignedShaftX = null;
      agent.waitX = null;
      agent.phase = 'WALK_TO_TARGET';
      return true;
    }

    const shafts = this.getCandidateShaftColumns(sourceFloorY, targetFloor.y);
    if (shafts.length === 0) {
      agent.phase = 'IDLE';
      agent.mood = 'angry';
      return false;
    }

    const assignedShaft = this.chooseBestShaftColumn(shafts, position.x, targetFloor.x);
    const waitX = this.resolveWaitXForShaft(assignedShaft, sourceFloorY, position.x);
    if (waitX === null) {
      agent.phase = 'IDLE';
      agent.mood = 'angry';
      return false;
    }

    agent.assignedShaftX = assignedShaft;
    agent.waitX = waitX;
    agent.phase = 'WALK_TO_SHAFT';
    agent.mood = 'neutral';
    return true;
  }

  public issueTripForFirstAgent(targetFloor: GridCell, despawnOnArrival: boolean): boolean {
    for (const entityId of this.world.query('agent', 'position')) {
      const schedule = this.world.getComponent(entityId, 'schedule');
      if (schedule) {
        continue;
      }

      return this.issueTrip(entityId, targetFloor, despawnOnArrival);
    }

    return false;
  }

  public update(deltaMs: number): void {
    const deltaSeconds = deltaMs / 1000;

    for (const entityId of this.world.query('position', 'agent')) {
      const position = this.world.getComponent(entityId, 'position');
      const agent = this.world.getComponent(entityId, 'agent');

      if (!position || !agent) {
        continue;
      }

      const isGroundExitEgressPhase = this.isGroundExitEgressPhase(agent);

      if (agent.phase !== 'RIDING' && !isGroundExitEgressPhase) {
        const standingFloorY = Math.round(position.y);
        if (!this.hasFloorAt(Math.round(position.x), standingFloorY)) {
          this.world.destroyEntity(entityId);
          continue;
        }
      }

      if (agent.phase === 'WALK_TO_SHAFT') {
        const shaftX = agent.assignedShaftX;
        const waitX = agent.waitX;
        const sourceFloor = agent.sourceFloorY;

        if (shaftX === null || waitX === null || sourceFloor === null) {
          agent.phase = 'IDLE';
          continue;
        }

        position.y = sourceFloor;
        const step = moveTowards(position.x, waitX, agent.speed * deltaSeconds);

        if (!this.hasFloorAt(Math.round(step.value), sourceFloor)) {
          this.world.destroyEntity(entityId);
          continue;
        }

        position.x = step.value;

        if (step.arrived) {
          agent.phase = 'WAIT_AT_SHAFT';
          agent.waitMs = 0;
        }

        this.coolStress(agent, deltaSeconds);
        continue;
      }

      if (agent.phase === 'WAIT_AT_SHAFT') {
        const sourceFloor = agent.sourceFloorY;
        const waitX = agent.waitX;

        if (sourceFloor !== null) {
          position.y = sourceFloor;
        }

        if (
          waitX !== null &&
          sourceFloor !== null &&
          !this.hasFloorAt(Math.round(position.x), sourceFloor)
        ) {
          position.x = waitX;
        }

        agent.waitMs += deltaMs;

        if (agent.waitMs > WAIT_STRESS_THRESHOLD_MS) {
          const overtimeSeconds = deltaMs / 1000;
          agent.stress = clamp(agent.stress + overtimeSeconds * STRESS_GAIN_PER_SECOND, 0, 100);
        }

        agent.mood = agent.stress > 60 ? 'angry' : 'neutral';
        continue;
      }

      if (agent.phase === 'RIDING') {
        const assignedCarId = agent.assignedCarId;
        if (assignedCarId !== null) {
          const carPosition = this.world.getComponent(assignedCarId, 'position');
          if (carPosition) {
            position.x = carPosition.x;
            position.y = carPosition.y;
          }
        }

        this.coolStress(agent, deltaSeconds);
        continue;
      }

      if (agent.phase === 'WALK_TO_TARGET') {
        position.y = agent.targetY;

        const step = moveTowards(position.x, agent.targetX, agent.speed * deltaSeconds);

        if (!isGroundExitEgressPhase && !this.hasFloorAt(Math.round(step.value), agent.targetY)) {
          this.world.destroyEntity(entityId);
          continue;
        }

        position.x = step.value;

        if (step.arrived) {
          agent.phase = 'AT_TARGET';
          agent.mood = 'happy';

          if (agent.despawnOnArrival && agent.targetY === this.groundRow) {
            this.world.destroyEntity(entityId);
            continue;
          }
        }

        this.coolStress(agent, deltaSeconds);
        continue;
      }

      if (agent.phase === 'AT_TARGET' || agent.phase === 'IDLE') {
        this.coolStress(agent, deltaSeconds);
      }
    }
  }

  private isGroundExitEgressPhase(agent: Agent): boolean {
    return (
      agent.despawnOnArrival &&
      agent.targetY === this.groundRow &&
      (agent.phase === 'WALK_TO_TARGET' || agent.phase === 'AT_TARGET')
    );
  }

  private coolStress(agent: Agent, deltaSeconds: number): void {
    agent.stress = clamp(agent.stress - deltaSeconds * STRESS_DECAY_PER_SECOND, 0, 100);

    if (agent.stress > 65) {
      agent.mood = 'angry';
      return;
    }

    if (agent.phase === 'AT_TARGET') {
      agent.mood = 'happy';
      return;
    }

    agent.mood = 'neutral';
  }

  private getCandidateShaftColumns(sourceFloorY: number, targetFloorY: number): number[] {
    const floorsByColumn = new Map<number, Set<number>>();

    for (const shaftEntity of this.world.query('position', 'elevator')) {
      const shaftPosition = this.world.getComponent(shaftEntity, 'position');
      if (!shaftPosition) {
        continue;
      }

      const floors = floorsByColumn.get(shaftPosition.x) ?? new Set<number>();
      floors.add(shaftPosition.y);
      floorsByColumn.set(shaftPosition.x, floors);
    }

    const candidates: number[] = [];

    for (const [column, floors] of floorsByColumn) {
      if (floors.has(sourceFloorY) && floors.has(targetFloorY)) {
        candidates.push(column);
      }
    }

    return candidates;
  }

  private chooseBestShaftColumn(
    columns: number[],
    sourceX: number,
    destinationX: number,
  ): number {
    let best = columns[0];
    let bestScore = Number.POSITIVE_INFINITY;

    for (const column of columns) {
      const score = Math.abs(sourceX - column) + Math.abs(destinationX - column);
      if (score < bestScore) {
        bestScore = score;
        best = column;
      }
    }

    return best;
  }

  private resolveWaitXForShaft(
    shaftX: number,
    floorY: number,
    preferredX: number,
  ): number | null {
    const candidates = [shaftX - 1, shaftX + 1];

    let bestX: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidateX of candidates) {
      if (!this.hasFloorAt(candidateX, floorY)) {
        continue;
      }

      const distance = Math.abs(candidateX - preferredX);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestX = candidateX;
      }
    }

    return bestX;
  }

  private hasFloorAt(x: number, y: number): boolean {
    for (const entityId of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(entityId, 'position');
      if (!position) {
        continue;
      }

      if (position.x === x && position.y === y) {
        return true;
      }
    }

    return false;
  }
}

export class ElevatorSystem {
  private readonly world: ECSWorld;
  private readonly unloadDurationMs = 450;
  private readonly loadDurationMs = 500;

  public constructor(world: ECSWorld) {
    this.world = world;
  }

  public update(deltaMs: number): void {
    const floorsByColumn = this.getShaftFloorsByColumn();
    const banks = this.buildBanks(floorsByColumn);
    const bankByColumn = this.buildBankLookup(banks);

    this.syncCars(floorsByColumn, bankByColumn);
    this.dispatchCalls(floorsByColumn, banks);
    this.arrangeQueueLines();
    this.updateCars(deltaMs, floorsByColumn);
    this.syncRiders();
  }

  private getShaftFloorsByColumn(): Map<number, Set<number>> {
    const result = new Map<number, Set<number>>();

    for (const shaftEntity of this.world.query('position', 'elevator')) {
      const position = this.world.getComponent(shaftEntity, 'position');
      if (!position) {
        continue;
      }

      const floors = result.get(position.x) ?? new Set<number>();
      floors.add(position.y);
      result.set(position.x, floors);
    }

    return result;
  }

  private buildBanks(floorsByColumn: Map<number, Set<number>>): ElevatorBank[] {
    const sortedColumns = Array.from(floorsByColumn.keys()).sort((a, b) => a - b);
    const banks: ElevatorBank[] = [];

    if (sortedColumns.length === 0) {
      return banks;
    }

    let activeColumns: number[] = [sortedColumns[0]];

    for (let index = 1; index < sortedColumns.length; index += 1) {
      const column = sortedColumns[index];
      const previous = sortedColumns[index - 1];

      if (column - previous <= 1) {
        activeColumns.push(column);
      } else {
        banks.push({
          id: banks.length + 1,
          columns: activeColumns,
        });
        activeColumns = [column];
      }
    }

    banks.push({
      id: banks.length + 1,
      columns: activeColumns,
    });

    return banks;
  }

  private buildBankLookup(banks: ElevatorBank[]): Map<number, ElevatorBank> {
    const result = new Map<number, ElevatorBank>();

    for (const bank of banks) {
      for (const column of bank.columns) {
        result.set(column, bank);
      }
    }

    return result;
  }

  private syncCars(
    floorsByColumn: Map<number, Set<number>>,
    bankByColumn: Map<number, ElevatorBank>,
  ): void {
    const carsByColumn = new Map<number, EntityId>();

    for (const carEntity of this.world.query('position', 'elevatorCar')) {
      const car = this.world.getComponent(carEntity, 'elevatorCar');
      if (!car) {
        continue;
      }

      carsByColumn.set(car.column, carEntity);
    }

    for (const [column, servedFloors] of floorsByColumn) {
      const bank = bankByColumn.get(column);
      if (!bank) {
        continue;
      }

      const existingCarId = carsByColumn.get(column);
      if (existingCarId !== undefined) {
        const existingCar = this.world.getComponent(existingCarId, 'elevatorCar');
        if (existingCar) {
          existingCar.bankId = bank.id;
        }
        continue;
      }

      const spawnFloor = Math.max(...Array.from(servedFloors));
      const carEntity = this.world.createEntity();

      this.world.addComponent(carEntity, 'position', { x: column, y: spawnFloor });
      this.world.addComponent(carEntity, 'renderable', {
        color: '#38bdf8',
        shape: 'square',
      });
      this.world.addComponent(carEntity, 'elevatorCar', {
        state: 'IDLE',
        direction: 'NONE',
        speed: 2.8,
        column,
        bankId: bank.id,
        stopQueue: [],
        phaseTimerMs: 0,
        capacity: 4,
        occupants: [],
      });
    }

    for (const [column, carEntity] of carsByColumn) {
      if (floorsByColumn.has(column)) {
        continue;
      }

      this.world.destroyEntity(carEntity);

      for (const agentEntity of this.world.query('agent')) {
        const agent = this.world.getComponent(agentEntity, 'agent');
        if (!agent || agent.assignedCarId !== carEntity) {
          continue;
        }

        agent.assignedCarId = null;
        agent.waitX = null;
        agent.callRegistered = false;
        agent.phase = 'WAIT_AT_SHAFT';
      }
    }
  }

  private dispatchCalls(
    floorsByColumn: Map<number, Set<number>>,
    banks: ElevatorBank[],
  ): void {
    const carsByBank = new Map<number, EntityId[]>();

    for (const carEntity of this.world.query('position', 'elevatorCar')) {
      const car = this.world.getComponent(carEntity, 'elevatorCar');
      if (!car) {
        continue;
      }

      const inBank = carsByBank.get(car.bankId) ?? [];
      inBank.push(carEntity);
      carsByBank.set(car.bankId, inBank);
    }

    for (const agentEntity of this.world.query('position', 'agent')) {
      const agent = this.world.getComponent(agentEntity, 'agent');
      if (!agent || agent.phase !== 'WAIT_AT_SHAFT') {
        continue;
      }

      if (agent.callRegistered && agent.assignedCarId !== null) {
        continue;
      }

      const shaftX = agent.assignedShaftX;
      const sourceFloor = agent.sourceFloorY;
      const targetFloor = agent.targetFloorY;
      if (shaftX === null || sourceFloor === null || targetFloor === null) {
        continue;
      }

      const bank = banks.find((candidate) => candidate.columns.includes(shaftX));
      if (!bank) {
        continue;
      }

      const carCandidates = carsByBank.get(bank.id) ?? [];
      let bestCarEntity: EntityId | null = null;
      let bestScore = Number.POSITIVE_INFINITY;

      for (const carEntity of carCandidates) {
        const car = this.world.getComponent(carEntity, 'elevatorCar');
        const carPosition = this.world.getComponent(carEntity, 'position');
        if (!car || !carPosition) {
          continue;
        }

        const servedFloors = floorsByColumn.get(car.column);
        if (!servedFloors || !servedFloors.has(sourceFloor) || !servedFloors.has(targetFloor)) {
          continue;
        }

        const directionPenalty =
          car.direction === 'NONE' || car.direction === agent.desiredDirection
            ? 0
            : DISPATCH_DIRECTION_PENALTY;

        const score =
          Math.abs(carPosition.y - sourceFloor) +
          directionPenalty +
          car.occupants.length * 2 +
          car.stopQueue.length * 1.4 +
          Math.abs(car.column - shaftX) * 0.8;

        if (score < bestScore) {
          bestScore = score;
          bestCarEntity = carEntity;
        }
      }

      if (bestCarEntity === null) {
        continue;
      }

      const selectedCar = this.world.getComponent(bestCarEntity, 'elevatorCar');
      if (!selectedCar) {
        continue;
      }

      this.addStop(selectedCar, sourceFloor);
      this.addStop(selectedCar, targetFloor);

      agent.assignedCarId = bestCarEntity;
      agent.callRegistered = true;

      if (agent.assignedShaftX !== selectedCar.column) {
        const waitX = this.resolveWaitXForShaft(
          selectedCar.column,
          sourceFloor,
          agent.waitX ?? shaftX,
        );
        if (waitX === null) {
          continue;
        }

        agent.assignedShaftX = selectedCar.column;
        agent.waitX = waitX;
        agent.phase = 'WALK_TO_SHAFT';
      }
    }
  }

  private updateCars(
    deltaMs: number,
    floorsByColumn: Map<number, Set<number>>,
  ): void {
    const deltaSeconds = deltaMs / 1000;

    for (const carEntity of this.world.query('position', 'elevatorCar')) {
      const car = this.world.getComponent(carEntity, 'elevatorCar');
      const position = this.world.getComponent(carEntity, 'position');

      if (!car || !position) {
        continue;
      }

      const servedFloors = floorsByColumn.get(car.column);
      if (!servedFloors) {
        continue;
      }

      car.stopQueue = dedupeStops(car.stopQueue.filter((stop) => servedFloors.has(stop)));

      if (car.state === 'IDLE') {
        car.direction = 'NONE';

        if (car.stopQueue.length > 0) {
          car.state = 'MOVING';
        }

        continue;
      }

      if (car.state === 'MOVING') {
        const targetFloor = car.stopQueue[0];

        if (targetFloor === undefined) {
          car.state = 'IDLE';
          car.direction = 'NONE';
          continue;
        }

        if (Math.abs(position.y - targetFloor) < 0.01) {
          position.y = targetFloor;
          this.unloadAtFloor(carEntity, car.column, targetFloor);
          car.state = 'UNLOADING';
          car.phaseTimerMs = this.unloadDurationMs;
          car.direction = 'NONE';
          continue;
        }

        const direction: TravelDirection = targetFloor < position.y ? 'UP' : 'DOWN';
        car.direction = direction;
        const speedDelta = car.speed * deltaSeconds;

        if (direction === 'UP') {
          position.y -= speedDelta;
          if (position.y <= targetFloor) {
            position.y = targetFloor;
            this.unloadAtFloor(carEntity, car.column, targetFloor);
            car.state = 'UNLOADING';
            car.phaseTimerMs = this.unloadDurationMs;
            car.direction = 'NONE';
          }
        } else {
          position.y += speedDelta;
          if (position.y >= targetFloor) {
            position.y = targetFloor;
            this.unloadAtFloor(carEntity, car.column, targetFloor);
            car.state = 'UNLOADING';
            car.phaseTimerMs = this.unloadDurationMs;
            car.direction = 'NONE';
          }
        }

        continue;
      }

      if (car.state === 'UNLOADING') {
        car.phaseTimerMs -= deltaMs;
        if (car.phaseTimerMs <= 0) {
          const floor = Math.round(position.y);
          this.loadAtFloor(carEntity, car.column, floor);
          car.state = 'LOADING';
          car.phaseTimerMs = this.loadDurationMs;
        }

        continue;
      }

      if (car.state === 'LOADING') {
        car.phaseTimerMs -= deltaMs;
        if (car.phaseTimerMs <= 0) {
          const floor = Math.round(position.y);

          if (car.stopQueue[0] === floor) {
            car.stopQueue.shift();
          } else {
            car.stopQueue = car.stopQueue.filter((stop) => stop !== floor);
          }

          car.state = car.stopQueue.length > 0 ? 'MOVING' : 'IDLE';
          car.direction = 'NONE';
        }
      }
    }
  }

  private arrangeQueueLines(): void {
    type QueueGroup = {
      floorY: number;
      shaftX: number;
      sideX: number;
      agents: EntityId[];
    };

    const groups = new Map<string, QueueGroup>();

    for (const agentEntity of this.world.query('position', 'agent')) {
      const agent = this.world.getComponent(agentEntity, 'agent');
      if (!agent || agent.phase !== 'WAIT_AT_SHAFT') {
        continue;
      }

      const floorY = agent.sourceFloorY;
      const shaftX = agent.assignedShaftX;
      const sideX = agent.waitX;

      if (floorY === null || shaftX === null || sideX === null) {
        continue;
      }

      const key = `${floorY}:${shaftX}:${sideX}`;
      const group = groups.get(key) ?? {
        floorY,
        shaftX,
        sideX,
        agents: [],
      };

      group.agents.push(agentEntity);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const direction = group.sideX < group.shaftX ? -1 : 1;

      group.agents.sort((a, b) => {
        const aAgent = this.world.getComponent(a, 'agent');
        const bAgent = this.world.getComponent(b, 'agent');

        if (!aAgent || !bAgent) {
          return 0;
        }

        return bAgent.waitMs - aAgent.waitMs;
      });

      for (let index = 0; index < group.agents.length; index += 1) {
        const agentEntity = group.agents[index];
        const position = this.world.getComponent(agentEntity, 'position');
        if (!position) {
          continue;
        }

        const candidateX = group.sideX + direction * index;
        const assignedX = this.hasFloorAt(candidateX, group.floorY)
          ? candidateX
          : group.sideX;

        position.x = assignedX;
        position.y = group.floorY;
      }
    }
  }

  private unloadAtFloor(carEntity: EntityId, column: number, floor: number): void {
    const car = this.world.getComponent(carEntity, 'elevatorCar');
    if (!car) {
      return;
    }

    for (const agentEntity of this.world.query('position', 'agent')) {
      const agent = this.world.getComponent(agentEntity, 'agent');
      const position = this.world.getComponent(agentEntity, 'position');

      if (!agent || !position) {
        continue;
      }

      if (agent.phase !== 'RIDING' || agent.assignedCarId !== carEntity) {
        continue;
      }

      if (agent.targetFloorY !== floor) {
        continue;
      }

      const exitX = this.resolveWaitXForShaft(column, floor, agent.targetX);
      if (exitX === null) {
        // No walkable tile adjacent to the shaft on this floor, so keep the
        // rider in the car and retry when service changes.
        this.addStop(car, floor);
        continue;
      }

      position.x = exitX;
      position.y = floor;
      agent.phase = 'WALK_TO_TARGET';
      agent.sourceFloorY = floor;
      agent.assignedCarId = null;
      agent.assignedShaftX = null;
      agent.waitX = null;
      agent.callRegistered = false;
      agent.waitMs = 0;

      car.occupants = car.occupants.filter((occupantId) => occupantId !== agentEntity);
    }
  }

  private loadAtFloor(carEntity: EntityId, column: number, floor: number): void {
    const car = this.world.getComponent(carEntity, 'elevatorCar');
    if (!car) {
      return;
    }

    const waitingAgents: EntityId[] = [];

    for (const agentEntity of this.world.query('position', 'agent')) {
      const agent = this.world.getComponent(agentEntity, 'agent');
      if (!agent || agent.phase !== 'WAIT_AT_SHAFT') {
        continue;
      }

      if (agent.assignedCarId !== carEntity || agent.assignedShaftX !== column) {
        continue;
      }

      if (agent.sourceFloorY !== floor) {
        continue;
      }

      waitingAgents.push(agentEntity);
    }

    waitingAgents.sort((a, b) => {
      const aAgent = this.world.getComponent(a, 'agent');
      const bAgent = this.world.getComponent(b, 'agent');

      if (!aAgent || !bAgent) {
        return 0;
      }

      return bAgent.waitMs - aAgent.waitMs;
    });

    const remainingCapacity = Math.max(0, car.capacity - car.occupants.length);
    const boardingAgents = waitingAgents.slice(0, remainingCapacity);
    const overflowAgents = waitingAgents.slice(remainingCapacity);

    for (const agentEntity of boardingAgents) {
      const agent = this.world.getComponent(agentEntity, 'agent');
      const position = this.world.getComponent(agentEntity, 'position');

      if (!agent || !position) {
        continue;
      }

      agent.phase = 'RIDING';
      agent.waitMs = 0;
      position.x = column;
      position.y = floor;

      if (!car.occupants.includes(agentEntity)) {
        car.occupants.push(agentEntity);
      }

      const targetFloor = agent.targetFloorY;
      if (targetFloor !== null) {
        this.addStop(car, targetFloor);
      }
    }

    for (const agentEntity of overflowAgents) {
      const agent = this.world.getComponent(agentEntity, 'agent');
      if (!agent) {
        continue;
      }

      // Keep the queue physically in place, but release the dispatch lock
      // so another car (or the same car on a later cycle) can pick up.
      agent.assignedCarId = null;
      agent.callRegistered = false;
    }
  }

  private syncRiders(): void {
    for (const agentEntity of this.world.query('position', 'agent')) {
      const agent = this.world.getComponent(agentEntity, 'agent');
      const position = this.world.getComponent(agentEntity, 'position');

      if (!agent || !position || agent.phase !== 'RIDING') {
        continue;
      }

      const carId = agent.assignedCarId;
      if (carId === null) {
        agent.phase = 'WAIT_AT_SHAFT';
        agent.callRegistered = false;
        continue;
      }

      const carPosition = this.world.getComponent(carId, 'position');
      if (!carPosition) {
        agent.assignedCarId = null;
        agent.callRegistered = false;
        agent.phase = 'WAIT_AT_SHAFT';
        continue;
      }

      position.x = carPosition.x;
      position.y = carPosition.y;
    }
  }

  private addStop(car: ElevatorCar, floor: number): void {
    if (car.stopQueue.includes(floor)) {
      return;
    }

    car.stopQueue.push(floor);
  }

  private resolveWaitXForShaft(
    shaftX: number,
    floorY: number,
    preferredX: number,
  ): number | null {
    const candidates = [shaftX - 1, shaftX + 1];

    let bestX: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidateX of candidates) {
      if (!this.hasFloorAt(candidateX, floorY)) {
        continue;
      }

      const distance = Math.abs(candidateX - preferredX);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestX = candidateX;
      }
    }

    return bestX;
  }

  private hasFloorAt(x: number, y: number): boolean {
    for (const entityId of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(entityId, 'position');
      if (!position) {
        continue;
      }

      if (position.x === x && position.y === y) {
        return true;
      }
    }

    return false;
  }
}

export class ZoningSystem {
  private readonly world: ECSWorld;
  private readonly gameMinutesPerRealMs: number;
  private readonly checkIntervalMs = 10000;
  private elapsedMs = 0;

  public constructor(world: ECSWorld, gameMinutesPerRealMs: number) {
    this.world = world;
    this.gameMinutesPerRealMs = gameMinutesPerRealMs;
  }

  public update(deltaMs: number): boolean {
    this.elapsedMs += deltaMs;

    let changedMap = false;

    while (this.elapsedMs >= this.checkIntervalMs) {
      this.elapsedMs -= this.checkIntervalMs;

      const checkMinutes = this.checkIntervalMs * this.gameMinutesPerRealMs;
      if (this.evaluateCondos(checkMinutes)) {
        changedMap = true;
      }
    }

    return changedMap;
  }

  private evaluateCondos(checkMinutes: number): boolean {
    const offices: Array<{ x: number; y: number; influence: Influence }> = [];

    for (const officeEntity of this.world.query('position', 'floor', 'influence')) {
      const position = this.world.getComponent(officeEntity, 'position');
      const floor = this.world.getComponent(officeEntity, 'floor');
      const influence = this.world.getComponent(officeEntity, 'influence');

      if (!position || !floor || !influence || floor.zone !== 'OFFICE' || !floor.occupied) {
        continue;
      }

      offices.push({
        x: position.x,
        y: position.y,
        influence,
      });
    }

    let changedMap = false;

    for (const condoEntity of this.world.query('position', 'floor', 'condo')) {
      const position = this.world.getComponent(condoEntity, 'position');
      const floor = this.world.getComponent(condoEntity, 'floor');
      const condo = this.world.getComponent(condoEntity, 'condo');

      if (!position || !floor || !condo || floor.zone !== 'CONDO' || !condo.occupied) {
        continue;
      }

      let noiseTotal = 0;

      for (const office of offices) {
        const manhattanDistance = Math.abs(position.x - office.x) + Math.abs(position.y - office.y);
        if (manhattanDistance <= office.influence.noiseRadius) {
          noiseTotal += office.influence.noiseIntensity;
        }
      }

      if (noiseTotal > condo.noiseSensitivity) {
        condo.warningActive = true;
        condo.warningMinutes += checkMinutes;

        if (condo.warningMinutes > 24 * 60) {
          condo.warningActive = false;
          condo.warningMinutes = 0;
          condo.occupied = false;
          floor.occupied = false;
          floor.rent = 0;
          changedMap = true;
        }
      } else {
        condo.warningActive = false;
        condo.warningMinutes = 0;
      }
    }

    return changedMap;
  }
}

export class FloatingTextSystem {
  private readonly world: ECSWorld;

  public constructor(world: ECSWorld) {
    this.world = world;
  }

  public update(deltaMs: number): void {
    const deltaSeconds = deltaMs / 1000;

    for (const entityId of this.world.query('position', 'floatingText')) {
      const position = this.world.getComponent(entityId, 'position');
      const floatingText = this.world.getComponent(entityId, 'floatingText');

      if (!position || !floatingText) {
        continue;
      }

      floatingText.ageMs += deltaMs;
      position.y -= floatingText.risePerSecond * deltaSeconds;

      if (floatingText.ageMs >= floatingText.ttlMs) {
        this.world.destroyEntity(entityId);
      }
    }
  }
}
