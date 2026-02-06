import {
  AgentSystem,
  ECSWorld,
  type EntityId,
  ElevatorSystem,
  FloatingTextSystem,
  MouseSystem,
  RenderSystem,
} from '../ECS/World';
import { GameLoop } from './Loop';
import { GridRenderer, GridSystem, type GridCell } from '../Renderer/GridRenderer';
import { Tool } from './Tools';

const GRID_CELL_SIZE = 32;
const GRID_COLUMNS = 30;
const GRID_ROWS = 20;
const GROUND_ROW = GRID_ROWS - 2;

const STARTING_FUNDS = 20000;
const RENT_PER_FLOOR = 100;

const GAME_HOUR_REAL_MS = 2000;
const GAME_MINUTES_PER_REAL_MS = 60 / GAME_HOUR_REAL_MS;
const MINUTES_PER_DAY = 24 * 60;
const MORNING_MINUTE = 7 * 60;
const EVENING_MINUTE = 17 * 60;

const DEFAULT_LOBBY_X = 2;

type StoreListener = () => void;

export interface GameState {
  money: number;
  elapsedMinutes: number;
}

class GameStateStore {
  private state: GameState;
  private readonly listeners = new Set<StoreListener>();

  public constructor(initialState: GameState) {
    this.state = initialState;
  }

  public readonly getSnapshot = (): GameState => this.state;

  public readonly subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public setState(patch: Partial<GameState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };

    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const gameStateStore = new GameStateStore({
  money: STARTING_FUNDS,
  elapsedMinutes: 0,
});

export const GAME_VIEWPORT = {
  width: GRID_COLUMNS * GRID_CELL_SIZE,
  height: GRID_ROWS * GRID_CELL_SIZE,
} as const;

export function formatGameTime(elapsedMinutes: number): string {
  const normalizedMinutes =
    ((elapsedMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  const hours = Math.floor(normalizedMinutes / 60);
  const minutes = normalizedMinutes % 60;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return `${hh}:${mm}`;
}

export class Game {
  private readonly worldCanvas: HTMLCanvasElement;
  private readonly simulationCanvas: HTMLCanvasElement;
  private readonly worldContext: CanvasRenderingContext2D;
  private readonly simulationContext: CanvasRenderingContext2D;
  private readonly grid = new GridSystem(GRID_CELL_SIZE, GRID_COLUMNS, GRID_ROWS);

  private readonly world = new ECSWorld();
  private readonly mouseSystem = new MouseSystem(this.world, GROUND_ROW);
  private readonly agentSystem = new AgentSystem(this.world, GROUND_ROW);
  private readonly elevatorSystem = new ElevatorSystem(this.world);
  private readonly floatingTextSystem = new FloatingTextSystem(this.world);
  private readonly renderSystem = new RenderSystem(this.world, this.grid);
  private readonly loop: GameLoop;

  private selectedTool: Tool = Tool.FLOOR;
  private worldLayerDirty = true;
  private lastProcessedGameMinute = 0;
  private lastPublishedGameMinute = -1;
  private nextAgentId = 1;

  public constructor(
    worldCanvas: HTMLCanvasElement,
    simulationCanvas: HTMLCanvasElement,
  ) {
    this.worldCanvas = worldCanvas;
    this.simulationCanvas = simulationCanvas;

    const worldCtx = this.worldCanvas.getContext('2d');
    const simulationCtx = this.simulationCanvas.getContext('2d');

    if (!worldCtx || !simulationCtx) {
      throw new Error('Could not acquire 2D canvas contexts.');
    }

    this.worldContext = worldCtx;
    this.simulationContext = simulationCtx;

    this.configureCanvas(this.worldCanvas, this.worldContext);
    this.configureCanvas(this.simulationCanvas, this.simulationContext);

    this.loop = new GameLoop((deltaMs, elapsedMs) => {
      this.update(deltaMs, elapsedMs);
      this.renderFrame();
    });
  }

  public start(): void {
    this.lastProcessedGameMinute = 0;
    this.lastPublishedGameMinute = -1;
    this.nextAgentId = 1;

    gameStateStore.setState({
      money: STARTING_FUNDS,
      elapsedMinutes: 0,
    });

    this.worldLayerDirty = true;
    this.loop.reset();
    this.loop.start();
  }

  public dispose(): void {
    this.loop.stop();
    this.worldContext.clearRect(0, 0, this.grid.widthPx, this.grid.heightPx);
    this.simulationContext.clearRect(0, 0, this.grid.widthPx, this.grid.heightPx);
  }

  public setTool(tool: Tool): void {
    this.selectedTool = tool;
  }

  public setPointerPosition(pixelX: number, pixelY: number): void {
    this.mouseSystem.setHoveredCell(this.grid.screenToGrid(pixelX, pixelY));
  }

  public clearPointer(): void {
    this.mouseSystem.clearHoveredCell();
  }

  public handlePrimaryClick(pixelX: number, pixelY: number): void {
    this.setPointerPosition(pixelX, pixelY);

    const funds = gameStateStore.getSnapshot().money;
    const result = this.mouseSystem.applyToolAtHoveredCell(this.selectedTool, funds);

    if (result.spent > 0) {
      gameStateStore.setState({ money: funds - result.spent });
    }

    if (result.changedMap) {
      this.worldLayerDirty = true;
      return;
    }

    this.commandAgentToHoveredFloor();
  }

  public handleCommandClick(pixelX: number, pixelY: number): void {
    this.setPointerPosition(pixelX, pixelY);
    this.commandAgentToHoveredFloor();
  }

  private configureCanvas(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
  ): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(this.grid.widthPx * dpr);
    canvas.height = Math.floor(this.grid.heightPx * dpr);
    canvas.style.width = `${this.grid.widthPx}px`;
    canvas.style.height = `${this.grid.heightPx}px`;

    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.imageSmoothingEnabled = false;
  }

  private update(deltaMs: number, elapsedMs: number): void {
    this.advanceClock(elapsedMs);

    this.agentSystem.update(deltaMs);
    this.elevatorSystem.update(deltaMs);
    this.floatingTextSystem.update(deltaMs);
  }

  private advanceClock(elapsedMs: number): void {
    const currentGameMinute = Math.floor(elapsedMs * GAME_MINUTES_PER_REAL_MS);

    for (
      let minute = this.lastProcessedGameMinute + 1;
      minute <= currentGameMinute;
      minute += 1
    ) {
      this.processMinute(minute);
    }

    this.lastProcessedGameMinute = currentGameMinute;

    if (currentGameMinute !== this.lastPublishedGameMinute) {
      this.lastPublishedGameMinute = currentGameMinute;
      gameStateStore.setState({ elapsedMinutes: currentGameMinute });
    }
  }

  private processMinute(totalMinute: number): void {
    const minuteOfDay = ((totalMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

    if (minuteOfDay === MORNING_MINUTE) {
      this.spawnMorningRush();
      return;
    }

    if (minuteOfDay === EVENING_MINUTE) {
      this.sendAgentsHome();
      return;
    }

    if (minuteOfDay === 0) {
      this.collectRentAtMidnight();
    }
  }

  private spawnMorningRush(): void {
    const officeFloors = this.getOfficeFloorCells();
    if (officeFloors.length === 0) {
      return;
    }

    const lobbyCells = this.getLobbyFloorCells();

    for (let index = 0; index < 5; index += 1) {
      const spawnX = this.pickLobbySpawnX(lobbyCells, index);
      const agentId = this.spawnAgent(spawnX);

      const office = officeFloors[Math.floor(Math.random() * officeFloors.length)];
      this.agentSystem.issueTrip(agentId, office, false);
    }
  }

  private sendAgentsHome(): void {
    const lobbyCells = this.getLobbyFloorCells();

    for (const agentEntity of this.world.query('position', 'agent')) {
      const position = this.world.getComponent(agentEntity, 'position');
      const agent = this.world.getComponent(agentEntity, 'agent');
      if (!position || !agent) {
        continue;
      }

      const lobbyX = this.pickNearestLobbyX(lobbyCells, position.x);

      if (agent.phase === 'RIDING_ELEVATOR') {
        agent.destinationX = lobbyX;
        agent.destinationY = GROUND_ROW;
        agent.targetFloorY = GROUND_ROW;
        agent.despawnOnArrival = true;
        agent.mood = 'neutral';
        continue;
      }

      this.agentSystem.issueTrip(
        agentEntity,
        {
          x: lobbyX,
          y: GROUND_ROW,
        },
        true,
      );
    }
  }

  private collectRentAtMidnight(): void {
    const floorEntities = this.world.query('position', 'floor');
    if (floorEntities.length === 0) {
      return;
    }

    let payout = 0;

    for (const floorEntity of floorEntities) {
      const position = this.world.getComponent(floorEntity, 'position');
      if (!position) {
        continue;
      }

      payout += RENT_PER_FLOOR;
      this.spawnFloatingText(position.x, position.y - 0.15, `+$${RENT_PER_FLOOR}`);
    }

    const currentFunds = gameStateStore.getSnapshot().money;
    gameStateStore.setState({ money: currentFunds + payout });
  }

  private spawnFloatingText(x: number, y: number, text: string): void {
    const popup = this.world.createEntity();
    this.world.addComponent(popup, 'position', { x, y });
    this.world.addComponent(popup, 'floatingText', {
      text,
      color: '#4ade80',
      ageMs: 0,
      ttlMs: 1200,
      risePerSecond: 0.8,
    });
  }

  private spawnAgent(spawnX: number): EntityId {
    const agentEntity = this.world.createEntity();

    this.world.addComponent(agentEntity, 'position', {
      x: spawnX,
      y: GROUND_ROW - 1,
    });

    this.world.addComponent(agentEntity, 'renderable', {
      color: '#ef4444',
      shape: 'square',
      sizeScale: 1,
    });

    this.world.addComponent(agentEntity, 'agent', {
      name: `Tenant ${this.nextAgentId}`,
      mood: 'neutral',
      speed: 3.2,
      phase: 'IDLE',
      assignedElevatorX: null,
      sourceFloorY: GROUND_ROW,
      targetFloorY: GROUND_ROW,
      destinationX: spawnX,
      destinationY: GROUND_ROW,
      callRegistered: false,
      despawnOnArrival: false,
    });

    this.nextAgentId += 1;

    return agentEntity;
  }

  private pickLobbySpawnX(lobbyCells: GridCell[], sequenceIndex: number): number {
    if (lobbyCells.length === 0) {
      return DEFAULT_LOBBY_X + (sequenceIndex % 4);
    }

    const randomCell = lobbyCells[Math.floor(Math.random() * lobbyCells.length)];
    return randomCell.x;
  }

  private pickNearestLobbyX(lobbyCells: GridCell[], fromX: number): number {
    if (lobbyCells.length === 0) {
      return DEFAULT_LOBBY_X;
    }

    let bestX = lobbyCells[0].x;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const cell of lobbyCells) {
      const distance = Math.abs(cell.x - fromX);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestX = cell.x;
      }
    }

    return bestX;
  }

  private getLobbyFloorCells(): GridCell[] {
    const result: GridCell[] = [];

    for (const floorEntity of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(floorEntity, 'position');
      if (!position || position.y !== GROUND_ROW) {
        continue;
      }

      result.push({ x: position.x, y: position.y });
    }

    return result;
  }

  private getOfficeFloorCells(): GridCell[] {
    const result: GridCell[] = [];

    for (const floorEntity of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(floorEntity, 'position');
      if (!position || position.y >= GROUND_ROW) {
        continue;
      }

      result.push({ x: position.x, y: position.y });
    }

    return result;
  }

  private commandAgentToHoveredFloor(): void {
    const hoveredCell = this.mouseSystem.getHoveredCell();
    if (!hoveredCell || !this.mouseSystem.hasFloorAt(hoveredCell)) {
      return;
    }

    const issued = this.agentSystem.issueTripForFirstAgent(hoveredCell, false);
    if (issued) {
      return;
    }

    const spawned = this.spawnAgent(this.pickNearestLobbyX(this.getLobbyFloorCells(), DEFAULT_LOBBY_X));
    this.agentSystem.issueTrip(spawned, hoveredCell, false);
  }

  private renderFrame(): void {
    if (this.worldLayerDirty) {
      this.renderWorldLayer();
      this.worldLayerDirty = false;
    }

    this.renderSimulationLayer();
  }

  private renderWorldLayer(): void {
    this.worldContext.clearRect(0, 0, this.grid.widthPx, this.grid.heightPx);

    this.worldContext.fillStyle = '#0f172a';
    this.worldContext.fillRect(0, 0, this.grid.widthPx, this.grid.heightPx);

    this.drawGroundLine();
    GridRenderer.drawGrid(this.worldContext, this.grid);
    this.drawPlacedStructures();
  }

  private drawGroundLine(): void {
    const groundTop = this.grid.gridToScreen(0, GROUND_ROW).y;

    this.worldContext.fillStyle = 'rgba(30, 41, 59, 0.85)';
    this.worldContext.fillRect(0, groundTop, this.grid.widthPx, this.grid.cellSize);

    this.worldContext.strokeStyle = 'rgba(148, 163, 184, 0.8)';
    this.worldContext.lineWidth = 2;
    this.worldContext.beginPath();
    this.worldContext.moveTo(0, groundTop + 0.5);
    this.worldContext.lineTo(this.grid.widthPx, groundTop + 0.5);
    this.worldContext.stroke();
  }

  private drawPlacedStructures(): void {
    for (const entityId of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(entityId, 'position');
      if (!position) {
        continue;
      }

      const tile = this.grid.gridToScreen(position.x, position.y);

      this.worldContext.fillStyle = '#64748b';
      this.worldContext.fillRect(tile.x, tile.y, this.grid.cellSize, this.grid.cellSize);

      this.worldContext.fillStyle = '#cbd5e1';
      this.worldContext.fillRect(tile.x, tile.y, this.grid.cellSize, 6);
    }

    for (const entityId of this.world.query('position', 'elevator')) {
      const position = this.world.getComponent(entityId, 'position');
      if (!position) {
        continue;
      }

      const tile = this.grid.gridToScreen(position.x, position.y);

      this.worldContext.fillStyle = '#334155';
      this.worldContext.fillRect(tile.x, tile.y, this.grid.cellSize, this.grid.cellSize);

      this.worldContext.fillStyle = '#94a3b8';
      this.worldContext.fillRect(
        tile.x + this.grid.cellSize * 0.35,
        tile.y + 3,
        this.grid.cellSize * 0.3,
        this.grid.cellSize - 6,
      );
    }
  }

  private renderSimulationLayer(): void {
    this.simulationContext.clearRect(0, 0, this.grid.widthPx, this.grid.heightPx);
    this.renderSystem.render(this.simulationContext);

    const preview = this.mouseSystem.getPlacementPreview(
      this.selectedTool,
      gameStateStore.getSnapshot().money,
    );

    if (preview) {
      GridRenderer.drawToolGhost(
        this.simulationContext,
        this.grid,
        preview.cell,
        preview.tool,
        preview.valid,
        preview.affordable,
      );
    }
  }
}
