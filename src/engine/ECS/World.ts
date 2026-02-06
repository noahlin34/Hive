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

export type AgentPhase =
  | 'IDLE'
  | 'WALK_TO_ELEVATOR'
  | 'WAIT_ELEVATOR'
  | 'RIDING_ELEVATOR'
  | 'WALK_TO_DESTINATION'
  | 'AT_DESTINATION';

export interface Agent {
  name: string;
  mood: AgentMood;
  speed: number;
  phase: AgentPhase;
  assignedElevatorX: number | null;
  sourceFloorY: number | null;
  targetFloorY: number | null;
  destinationX: number;
  destinationY: number;
  callRegistered: boolean;
  despawnOnArrival: boolean;
}

export interface Floor {
  kind: 'floor';
}

export interface Elevator {
  kind: 'elevator';
}

export type ElevatorState = 'IDLE' | 'MOVING_UP' | 'MOVING_DOWN' | 'LOADING';

export interface ElevatorCar {
  state: ElevatorState;
  speed: number;
  pendingStops: number[];
  loadTimerMs: number;
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
  floor: Floor;
  elevator: Elevator;
  elevatorCar: ElevatorCar;
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

export interface HorizontalBounds {
  minX: number;
  maxX: number;
}

export interface PlacementPreview {
  cell: GridCell;
  valid: boolean;
  affordable: boolean;
  tool: Tool;
}

export interface PlacementResult {
  changedMap: boolean;
  spent: number;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class ECSWorld {
  private nextEntityId: EntityId = 1;
  private readonly entities = new Set<EntityId>();
  private readonly components: ComponentStores = {
    position: new Map<EntityId, Position>(),
    velocity: new Map<EntityId, Velocity>(),
    renderable: new Map<EntityId, Renderable>(),
    agent: new Map<EntityId, Agent>(),
    floor: new Map<EntityId, Floor>(),
    elevator: new Map<EntityId, Elevator>(),
    elevatorCar: new Map<EntityId, ElevatorCar>(),
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

export class MovementSystem {
  private readonly world: ECSWorld;
  private readonly bounds: HorizontalBounds;

  public constructor(world: ECSWorld, bounds: HorizontalBounds) {
    this.world = world;
    this.bounds = bounds;
  }

  public update(deltaMs: number): void {
    const deltaSeconds = deltaMs / 1000;

    for (const entityId of this.world.query('position', 'velocity')) {
      const position = this.world.getComponent(entityId, 'position');
      const velocity = this.world.getComponent(entityId, 'velocity');

      if (!position || !velocity) {
        continue;
      }

      position.x += velocity.dx * deltaSeconds;
      position.y += velocity.dy * deltaSeconds;

      if (position.x < this.bounds.minX) {
        position.x = this.bounds.minX;
        velocity.dx = Math.abs(velocity.dx);
      } else if (position.x > this.bounds.maxX) {
        position.x = this.bounds.maxX;
        velocity.dx = -Math.abs(velocity.dx);
      }
    }
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
    this.renderShapes(ctx);
    this.renderFloatingText(ctx);
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

      if (renderable.shape === 'circle') {
        const radius = size * 0.5;
        ctx.fillStyle = renderable.color;
        ctx.beginPath();
        ctx.arc(pixelX + radius, pixelY + radius, radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = renderable.color;
        ctx.fillRect(pixelX, pixelY, size, size);
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
        ctx.strokeRect(pixelX + 1, pixelY + 1, size - 2, size - 2);
      }

      const elevatorCar = this.world.getComponent(entityId, 'elevatorCar');
      if (elevatorCar) {
        const glow =
          elevatorCar.state === 'LOADING'
            ? 'rgba(56, 189, 248, 0.8)'
            : 'rgba(148, 163, 184, 0.8)';
        ctx.strokeStyle = glow;
        ctx.lineWidth = 2;
        ctx.strokeRect(pixelX + 2, pixelY + 2, size - 4, size - 4);
      }
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
    return this.hasStructureAt(cell, 'floor');
  }

  public getPlacementPreview(tool: Tool, funds: number): PlacementPreview | null {
    if (!this.hoveredCell) {
      return null;
    }

    const cost = TOOL_COSTS[tool];
    return {
      cell: this.hoveredCell,
      valid: this.isValidPlacement(tool, this.hoveredCell),
      affordable: funds >= cost,
      tool,
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

    const cost = TOOL_COSTS[tool];
    if (funds < cost) {
      return { changedMap: false, spent: 0 };
    }

    if (!this.isValidPlacement(tool, cell)) {
      return { changedMap: false, spent: 0 };
    }

    const entity = this.world.createEntity();
    this.world.addComponent(entity, 'position', { x: cell.x, y: cell.y });

    if (tool === Tool.FLOOR) {
      this.world.addComponent(entity, 'floor', { kind: 'floor' });
    } else if (tool === Tool.ELEVATOR) {
      this.world.addComponent(entity, 'elevator', { kind: 'elevator' });
    }

    return { changedMap: true, spent: cost };
  }

  private isValidPlacement(tool: Tool, cell: GridCell): boolean {
    if (tool === Tool.DELETE) {
      return this.getStructureEntityAt(cell) !== null;
    }

    if (this.getStructureEntityAt(cell) !== null) {
      return false;
    }

    if (tool === Tool.FLOOR) {
      return this.isValidFloorPlacement(cell);
    }

    if (tool === Tool.ELEVATOR) {
      return this.isValidElevatorPlacement(cell);
    }

    return false;
  }

  private isValidFloorPlacement(cell: GridCell): boolean {
    if (cell.y === this.groundRow) {
      return true;
    }

    const neighbors: GridCell[] = [
      { x: cell.x - 1, y: cell.y },
      { x: cell.x + 1, y: cell.y },
      { x: cell.x, y: cell.y - 1 },
      { x: cell.x, y: cell.y + 1 },
    ];

    return neighbors.some((neighbor) => this.hasStructureAt(neighbor, 'floor'));
  }

  private isValidElevatorPlacement(cell: GridCell): boolean {
    const hasVerticalNeighbor =
      this.hasStructureAt({ x: cell.x, y: cell.y - 1 }, 'elevator') ||
      this.hasStructureAt({ x: cell.x, y: cell.y + 1 }, 'elevator');

    return hasVerticalNeighbor || cell.y === this.groundRow;
  }

  private getStructureEntityAt(cell: GridCell): EntityId | null {
    const floorEntity = this.getEntityByTypeAt(cell, 'floor');
    if (floorEntity !== null) {
      return floorEntity;
    }

    return this.getEntityByTypeAt(cell, 'elevator');
  }

  private hasStructureAt(cell: GridCell, type: StructureKey): boolean {
    return this.getEntityByTypeAt(cell, type) !== null;
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

    const sourceFloorY = Math.round(position.y + 1);

    agent.destinationX = targetFloor.x;
    agent.destinationY = targetFloor.y;
    agent.targetFloorY = targetFloor.y;
    agent.sourceFloorY = sourceFloorY;
    agent.despawnOnArrival = despawnOnArrival;
    agent.callRegistered = false;
    agent.mood = 'neutral';

    if (sourceFloorY === targetFloor.y) {
      agent.assignedElevatorX = null;
      agent.phase = 'WALK_TO_DESTINATION';
      return true;
    }

    const candidateColumns = this.getElevatorColumnsForTrip(sourceFloorY, targetFloor.y);
    if (candidateColumns.length === 0) {
      agent.phase = 'IDLE';
      agent.mood = 'angry';
      agent.assignedElevatorX = null;
      return false;
    }

    const assignedElevator = this.selectBestElevatorColumn(
      candidateColumns,
      position.x,
      targetFloor.x,
    );

    agent.assignedElevatorX = assignedElevator;
    agent.phase = 'WALK_TO_ELEVATOR';
    return true;
  }

  public issueTripForFirstAgent(targetFloor: GridCell, despawnOnArrival: boolean): boolean {
    for (const entityId of this.world.query('agent', 'position')) {
      const agent = this.world.getComponent(entityId, 'agent');
      if (!agent) {
        continue;
      }

      if (agent.phase === 'RIDING_ELEVATOR') {
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

      if (agent.phase === 'WALK_TO_ELEVATOR') {
        const sourceFloorY = agent.sourceFloorY;
        const elevatorX = agent.assignedElevatorX;

        if (sourceFloorY === null || elevatorX === null) {
          agent.phase = 'IDLE';
          continue;
        }

        position.y = sourceFloorY - 1;
        const step = moveTowards(position.x, elevatorX, agent.speed * deltaSeconds);
        position.x = step.value;

        if (step.arrived) {
          agent.phase = 'WAIT_ELEVATOR';
        }

        continue;
      }

      if (agent.phase === 'WAIT_ELEVATOR') {
        const sourceFloorY = agent.sourceFloorY;
        if (sourceFloorY !== null) {
          position.y = sourceFloorY - 1;
        }
        continue;
      }

      if (agent.phase === 'WALK_TO_DESTINATION') {
        position.y = agent.destinationY - 1;

        const step = moveTowards(position.x, agent.destinationX, agent.speed * deltaSeconds);
        position.x = step.value;

        if (step.arrived) {
          agent.phase = 'AT_DESTINATION';
          agent.mood = 'happy';

          if (agent.despawnOnArrival && agent.destinationY === this.groundRow) {
            this.world.destroyEntity(entityId);
          }
        }
      }
    }
  }

  private getElevatorColumnsForTrip(sourceFloorY: number, targetFloorY: number): number[] {
    const floorSetByColumn = new Map<number, Set<number>>();

    for (const elevatorEntity of this.world.query('position', 'elevator')) {
      const position = this.world.getComponent(elevatorEntity, 'position');
      if (!position) {
        continue;
      }

      const column = position.x;
      const floors = floorSetByColumn.get(column) ?? new Set<number>();
      floors.add(position.y);
      floorSetByColumn.set(column, floors);
    }

    const validColumns: number[] = [];

    for (const [column, floors] of floorSetByColumn) {
      if (floors.has(sourceFloorY) && floors.has(targetFloorY)) {
        validColumns.push(column);
      }
    }

    return validColumns;
  }

  private selectBestElevatorColumn(
    candidateColumns: number[],
    sourceX: number,
    destinationX: number,
  ): number {
    let bestColumn = candidateColumns[0];
    let bestScore = Number.POSITIVE_INFINITY;

    for (const column of candidateColumns) {
      const score = Math.abs(sourceX - column) + Math.abs(destinationX - column);
      if (score < bestScore) {
        bestScore = score;
        bestColumn = column;
      }
    }

    return bestColumn;
  }
}

export class ElevatorSystem {
  private readonly world: ECSWorld;
  private readonly loadingDurationMs = 500;

  public constructor(world: ECSWorld) {
    this.world = world;
  }

  public update(deltaMs: number): void {
    const shaftFloorsByColumn = this.getShaftFloorsByColumn();
    this.syncElevatorCars(shaftFloorsByColumn);

    for (const carEntity of this.world.query('position', 'elevatorCar')) {
      const position = this.world.getComponent(carEntity, 'position');
      const car = this.world.getComponent(carEntity, 'elevatorCar');

      if (!position || !car) {
        continue;
      }

      const column = Math.round(position.x);
      const servedFloors = shaftFloorsByColumn.get(column);

      if (!servedFloors) {
        continue;
      }

      this.registerWaitingCalls(column, servedFloors, car);
      this.prunePendingStops(car, servedFloors);
      this.advanceElevatorState(position, car, column, deltaMs);
      this.syncRidingAgents(column, position.y);
    }
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

  private syncElevatorCars(shaftFloorsByColumn: Map<number, Set<number>>): void {
    const carsByColumn = new Map<number, EntityId>();

    for (const carEntity of this.world.query('position', 'elevatorCar')) {
      const position = this.world.getComponent(carEntity, 'position');
      if (!position) {
        continue;
      }

      carsByColumn.set(Math.round(position.x), carEntity);
    }

    for (const [column, servedFloors] of shaftFloorsByColumn) {
      if (carsByColumn.has(column)) {
        continue;
      }

      const spawnFloor = Math.max(...Array.from(servedFloors));
      const carEntity = this.world.createEntity();

      this.world.addComponent(carEntity, 'position', { x: column, y: spawnFloor });
      this.world.addComponent(carEntity, 'renderable', {
        color: '#38bdf8',
        shape: 'square',
        sizeScale: 1,
      });
      this.world.addComponent(carEntity, 'elevatorCar', {
        state: 'IDLE',
        speed: 2.4,
        pendingStops: [],
        loadTimerMs: 0,
      });
    }

    for (const [column, carEntity] of carsByColumn) {
      if (shaftFloorsByColumn.has(column)) {
        continue;
      }

      this.world.destroyEntity(carEntity);

      for (const agentEntity of this.world.query('agent')) {
        const agent = this.world.getComponent(agentEntity, 'agent');
        if (!agent) {
          continue;
        }

        if (agent.assignedElevatorX === column) {
          agent.phase = 'IDLE';
          agent.assignedElevatorX = null;
          agent.callRegistered = false;
          agent.mood = 'angry';
        }
      }
    }
  }

  private registerWaitingCalls(
    column: number,
    servedFloors: Set<number>,
    car: ElevatorCar,
  ): void {
    for (const agentEntity of this.world.query('agent')) {
      const agent = this.world.getComponent(agentEntity, 'agent');
      if (!agent) {
        continue;
      }

      if (agent.phase === 'RIDING_ELEVATOR' && agent.assignedElevatorX === column) {
        const targetFloor = agent.targetFloorY;
        if (targetFloor !== null && servedFloors.has(targetFloor)) {
          this.addStop(car, targetFloor);
        }
        continue;
      }

      if (agent.phase !== 'WAIT_ELEVATOR' || agent.assignedElevatorX !== column) {
        continue;
      }

      if (agent.callRegistered) {
        continue;
      }

      const sourceFloor = agent.sourceFloorY;
      const targetFloor = agent.targetFloorY;

      if (sourceFloor === null || targetFloor === null) {
        continue;
      }

      if (!servedFloors.has(sourceFloor) || !servedFloors.has(targetFloor)) {
        agent.phase = 'IDLE';
        agent.assignedElevatorX = null;
        agent.mood = 'angry';
        continue;
      }

      this.addStop(car, sourceFloor);
      this.addStop(car, targetFloor);
      agent.callRegistered = true;
    }
  }

  private prunePendingStops(car: ElevatorCar, servedFloors: Set<number>): void {
    const unique: number[] = [];

    for (const stop of car.pendingStops) {
      if (!servedFloors.has(stop)) {
        continue;
      }

      if (unique.includes(stop)) {
        continue;
      }

      unique.push(stop);
    }

    car.pendingStops = unique;
  }

  private advanceElevatorState(
    position: Position,
    car: ElevatorCar,
    column: number,
    deltaMs: number,
  ): void {
    if (car.state === 'LOADING') {
      car.loadTimerMs -= deltaMs;
      if (car.loadTimerMs <= 0) {
        car.loadTimerMs = 0;
        car.state = 'IDLE';
      }
      return;
    }

    if (car.pendingStops.length === 0) {
      car.state = 'IDLE';
      return;
    }

    const targetFloor = car.pendingStops[0];

    if (Math.abs(position.y - targetFloor) < 0.01) {
      this.arriveAtStop(position, car, column, targetFloor);
      return;
    }

    const direction = targetFloor < position.y ? -1 : 1;
    car.state = direction < 0 ? 'MOVING_UP' : 'MOVING_DOWN';

    position.y += direction * car.speed * (deltaMs / 1000);

    const reached = direction < 0 ? position.y <= targetFloor : position.y >= targetFloor;
    if (reached) {
      this.arriveAtStop(position, car, column, targetFloor);
    }
  }

  private arriveAtStop(
    position: Position,
    car: ElevatorCar,
    column: number,
    floor: number,
  ): void {
    position.y = floor;

    if (car.pendingStops[0] === floor) {
      car.pendingStops.shift();
    } else {
      car.pendingStops = car.pendingStops.filter((stop) => stop !== floor);
    }

    this.transferAgentsAtFloor(column, floor);

    car.state = 'LOADING';
    car.loadTimerMs = this.loadingDurationMs;
  }

  private transferAgentsAtFloor(column: number, floor: number): void {
    for (const agentEntity of this.world.query('position', 'agent')) {
      const position = this.world.getComponent(agentEntity, 'position');
      const agent = this.world.getComponent(agentEntity, 'agent');

      if (!position || !agent || agent.assignedElevatorX !== column) {
        continue;
      }

      if (agent.phase === 'RIDING_ELEVATOR') {
        if (agent.targetFloorY === floor) {
          position.x = column;
          position.y = floor - 1;
          agent.phase = 'WALK_TO_DESTINATION';
          agent.sourceFloorY = floor;
          agent.callRegistered = false;
          agent.assignedElevatorX = null;
        }
        continue;
      }

      if (agent.phase === 'WAIT_ELEVATOR' && agent.sourceFloorY === floor) {
        agent.phase = 'RIDING_ELEVATOR';
        position.x = column;
        position.y = floor;
      }
    }
  }

  private syncRidingAgents(column: number, elevatorY: number): void {
    for (const agentEntity of this.world.query('position', 'agent')) {
      const position = this.world.getComponent(agentEntity, 'position');
      const agent = this.world.getComponent(agentEntity, 'agent');

      if (!position || !agent) {
        continue;
      }

      if (agent.phase === 'RIDING_ELEVATOR' && agent.assignedElevatorX === column) {
        position.x = column;
        position.y = elevatorY;
      }
    }
  }

  private addStop(car: ElevatorCar, floor: number): void {
    if (car.pendingStops.includes(floor)) {
      return;
    }

    car.pendingStops.push(floor);
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
