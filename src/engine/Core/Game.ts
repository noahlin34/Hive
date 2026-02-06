import {
  AgentSystem,
  type Agent,
  type EntityId,
  ECSWorld,
  ElevatorSystem,
  FloatingTextSystem,
  MouseSystem,
  RenderSystem,
  type RoomZone,
  type Schedule,
  ZoningSystem,
} from '../ECS/World';
import { GameLoop } from './Loop';
import { GridRenderer, GridSystem, type GridCell } from '../Renderer/GridRenderer';
import { Tool } from './Tools';

const GRID_CELL_SIZE = 32;
const GRID_COLUMNS = 30;
const GRID_ROWS = 20;
const GROUND_ROW = GRID_ROWS - 2;

const STARTING_FUNDS = 50000;

const GAME_HOUR_REAL_MS = 2000;
const GAME_MINUTES_PER_REAL_MS = 60 / GAME_HOUR_REAL_MS;

const MINUTES_PER_DAY = 24 * 60;
const MORNING_MINUTE = 8 * 60;
const LUNCH_MINUTE = 12 * 60;
const EVENING_MINUTE = 17 * 60;

const DEFAULT_LOBBY_X = 2;
const MORNING_WORKER_COUNT = 5;

type StoreListener = () => void;

export interface GameState {
  money: number;
  elapsedMinutes: number;
  statusMessage: string | null;
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
  statusMessage: null,
});

export const GAME_VIEWPORT = {
  width: GRID_COLUMNS * GRID_CELL_SIZE,
  height: GRID_ROWS * GRID_CELL_SIZE,
} as const;

function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

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
  private readonly zoningSystem = new ZoningSystem(this.world, GAME_MINUTES_PER_REAL_MS);
  private readonly floatingTextSystem = new FloatingTextSystem(this.world);
  private readonly renderSystem = new RenderSystem(this.world, this.grid);
  private readonly loop: GameLoop;

  private selectedTool: Tool = Tool.FLOOR;
  private worldLayerDirty = true;

  private lastProcessedGameMinute = 0;
  private lastPublishedGameMinute = -1;
  private lastSkySlot = -1;

  private nextAgentId = 1;
  private floorDragStart: GridCell | null = null;
  private floorDragCurrent: GridCell | null = null;

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
    this.lastSkySlot = -1;
    this.nextAgentId = 1;

    gameStateStore.setState({
      money: STARTING_FUNDS,
      elapsedMinutes: 0,
      statusMessage: null,
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

  public beginPrimaryAction(pixelX: number, pixelY: number): void {
    this.setPointerPosition(pixelX, pixelY);

    if (this.selectedTool !== Tool.FLOOR) {
      return;
    }

    const hovered = this.mouseSystem.getHoveredCell();
    if (!hovered) {
      return;
    }

    this.floorDragStart = hovered;
    this.floorDragCurrent = hovered;
  }

  public updatePrimaryDrag(pixelX: number, pixelY: number): void {
    this.setPointerPosition(pixelX, pixelY);

    if (!this.floorDragStart) {
      return;
    }

    const hovered = this.mouseSystem.getHoveredCell();
    if (!hovered) {
      return;
    }

    this.floorDragCurrent = {
      x: hovered.x,
      y: this.floorDragStart.y,
    };
  }

  public endPrimaryAction(pixelX: number, pixelY: number): void {
    this.setPointerPosition(pixelX, pixelY);

    if (this.selectedTool === Tool.FLOOR && this.floorDragStart) {
      const funds = gameStateStore.getSnapshot().money;
      const end = this.floorDragCurrent ?? this.floorDragStart;
      const result = this.mouseSystem.applyFloorDrag(this.floorDragStart, end, funds);

      if (result.spent > 0) {
        gameStateStore.setState({ money: funds - result.spent });
      }

      if (result.changedMap) {
        this.worldLayerDirty = true;
      }

      this.floorDragStart = null;
      this.floorDragCurrent = null;
      this.setStatus(result.errorMessage ?? null);
      return;
    }

    this.handlePrimaryClick(pixelX, pixelY);
  }

  public cancelPrimaryAction(): void {
    this.floorDragStart = null;
    this.floorDragCurrent = null;
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
      this.setStatus(null);
      return;
    }

    if (result.errorMessage) {
      this.setStatus(result.errorMessage);
      return;
    }

    this.commandAgentToHoveredFloor();
    this.setStatus(null);
  }

  public handleCommandClick(pixelX: number, pixelY: number): void {
    this.setPointerPosition(pixelX, pixelY);
    this.commandAgentToHoveredFloor();
    this.setStatus(null);
  }

  private setStatus(message: string | null): void {
    gameStateStore.setState({ statusMessage: message });
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

    const zoningChanged = this.zoningSystem.update(deltaMs);
    if (zoningChanged) {
      this.worldLayerDirty = true;
    }

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

    const skySlot = Math.floor(currentGameMinute / 15);
    if (skySlot !== this.lastSkySlot) {
      this.lastSkySlot = skySlot;
      this.worldLayerDirty = true;
    }
  }

  private processMinute(totalMinute: number): void {
    const minuteOfDay = this.toMinuteOfDay(totalMinute);

    this.updateWorkerSchedules(totalMinute);

    if (minuteOfDay === MORNING_MINUTE) {
      this.spawnMorningWorkers();
      return;
    }

    if (minuteOfDay === LUNCH_MINUTE) {
      this.sendWorkersToLunch(totalMinute);
      return;
    }

    if (minuteOfDay === EVENING_MINUTE) {
      this.sendWorkersHome();
      return;
    }

    if (minuteOfDay === 0) {
      this.collectRentAtMidnight();
    }
  }

  private updateWorkerSchedules(totalMinute: number): void {
    const workers = this.world.query('agent', 'schedule', 'position');

    for (const workerEntity of workers) {
      const schedule = this.world.getComponent(workerEntity, 'schedule');
      const agent = this.world.getComponent(workerEntity, 'agent');
      const position = this.world.getComponent(workerEntity, 'position');

      if (!schedule || !agent || !position) {
        continue;
      }

      if (schedule.stage === 'COMMUTE_TO_OFFICE' && agent.phase === 'AT_TARGET') {
        schedule.stage = 'AT_OFFICE';
        continue;
      }

      if (schedule.stage === 'TO_LUNCH' && agent.phase === 'AT_TARGET') {
        schedule.stage = 'AT_LUNCH';
        schedule.lunchReleaseMinute = totalMinute + 30;
        continue;
      }

      if (
        schedule.stage === 'AT_LUNCH' &&
        schedule.lunchReleaseMinute !== null &&
        totalMinute >= schedule.lunchReleaseMinute
      ) {
        const success = this.agentSystem.issueTrip(
          workerEntity,
          { x: schedule.officeX, y: schedule.officeY },
          false,
        );

        if (success) {
          schedule.stage = 'RETURN_TO_OFFICE';
          schedule.lunchReleaseMinute = null;
        }

        continue;
      }

      if (schedule.stage === 'RETURN_TO_OFFICE' && agent.phase === 'AT_TARGET') {
        schedule.stage = 'AT_OFFICE';
        continue;
      }

      if (schedule.stage === 'TO_HOME' && agent.phase === 'IDLE') {
        const lobbyTarget = this.findNearestCell(this.getFloorCellsByZone('LOBBY'), position.x);

        const success = this.agentSystem.issueTrip(
          workerEntity,
          lobbyTarget ?? { x: schedule.homeX, y: GROUND_ROW },
          true,
        );

        if (!success) {
          agent.phase = 'IDLE';
        }
      }
    }
  }

  private spawnMorningWorkers(): void {
    const offices = this.getFloorCellsByZone('OFFICE');
    const lobbies = this.getFloorCellsByZone('LOBBY');

    if (offices.length === 0 || lobbies.length === 0) {
      return;
    }

    for (let index = 0; index < MORNING_WORKER_COUNT; index += 1) {
      const spawnLobby = lobbies[Math.floor(Math.random() * lobbies.length)];
      const office = offices[Math.floor(Math.random() * offices.length)];

      const worker = this.spawnOfficeWorker(spawnLobby.x, office);
      this.agentSystem.issueTrip(worker, office, false);
    }
  }

  private sendWorkersToLunch(totalMinute: number): void {
    const foodCourts = this.getFloorCellsByZone('FOOD_COURT');
    const lobbies = this.getFloorCellsByZone('LOBBY');

    for (const workerEntity of this.world.query('agent', 'schedule', 'position')) {
      const schedule = this.world.getComponent(workerEntity, 'schedule');
      const position = this.world.getComponent(workerEntity, 'position');

      if (!schedule || !position || schedule.stage === 'TO_HOME') {
        continue;
      }

      const lunchTarget =
        this.findNearestCell(foodCourts, position.x) ??
        this.findNearestCell(lobbies, position.x);

      if (!lunchTarget) {
        continue;
      }

      const success = this.agentSystem.issueTrip(workerEntity, lunchTarget, false);
      if (!success) {
        continue;
      }

      schedule.stage = 'TO_LUNCH';
      schedule.lunchReleaseMinute = totalMinute + 30;
    }
  }

  private sendWorkersHome(): void {
    const lobbies = this.getFloorCellsByZone('LOBBY');

    for (const workerEntity of this.world.query('agent', 'schedule', 'position')) {
      const schedule = this.world.getComponent(workerEntity, 'schedule');
      const position = this.world.getComponent(workerEntity, 'position');

      if (!schedule || !position) {
        continue;
      }

      const lobby = this.findNearestCell(lobbies, position.x) ?? {
        x: schedule.homeX,
        y: GROUND_ROW,
      };

      const success = this.agentSystem.issueTrip(workerEntity, lobby, true);
      if (!success) {
        continue;
      }

      schedule.stage = 'TO_HOME';
      schedule.lunchReleaseMinute = null;
    }
  }

  private collectRentAtMidnight(): void {
    let payout = 0;

    for (const floorEntity of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(floorEntity, 'position');
      const floor = this.world.getComponent(floorEntity, 'floor');

      if (!position || !floor || !floor.occupied || floor.rent <= 0) {
        continue;
      }

      payout += floor.rent;
      this.spawnFloatingText(position.x, position.y - 0.15, `+$${floor.rent}`);
    }

    if (payout > 0) {
      const currentFunds = gameStateStore.getSnapshot().money;
      gameStateStore.setState({ money: currentFunds + payout });
    }
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

  private spawnOfficeWorker(homeX: number, officeDesk: GridCell): EntityId {
    const worker = this.world.createEntity();

    this.world.addComponent(worker, 'position', {
      x: homeX,
      y: GROUND_ROW,
    });

    this.world.addComponent(worker, 'renderable', {
      color: '#ef4444',
      shape: 'square',
      sizeScale: 0.66,
    });

    this.world.addComponent(worker, 'agent', {
      name: `Worker ${this.nextAgentId}`,
      mood: 'neutral',
      speed: 3.2,
      phase: 'IDLE',
      stress: 0,
      waitMs: 0,
      sourceFloorY: GROUND_ROW,
      targetFloorY: GROUND_ROW,
      targetX: homeX,
      targetY: GROUND_ROW,
      desiredDirection: 'NONE',
      assignedShaftX: null,
      waitX: null,
      assignedCarId: null,
      callRegistered: false,
      despawnOnArrival: false,
    });

    const schedule: Schedule = {
      role: 'OFFICE_WORKER',
      stage: 'COMMUTE_TO_OFFICE',
      officeX: officeDesk.x,
      officeY: officeDesk.y,
      homeX,
      lunchReleaseMinute: null,
    };

    this.world.addComponent(worker, 'schedule', schedule);

    this.nextAgentId += 1;
    return worker;
  }

  private spawnFreelanceAgent(homeX: number): EntityId {
    const agentEntity = this.world.createEntity();

    this.world.addComponent(agentEntity, 'position', {
      x: homeX,
      y: GROUND_ROW,
    });

    this.world.addComponent(agentEntity, 'renderable', {
      color: '#ef4444',
      shape: 'square',
      sizeScale: 0.66,
    });

    const agent: Agent = {
      name: `Visitor ${this.nextAgentId}`,
      mood: 'neutral',
      speed: 3.2,
      phase: 'IDLE',
      stress: 0,
      waitMs: 0,
      sourceFloorY: GROUND_ROW,
      targetFloorY: GROUND_ROW,
      targetX: homeX,
      targetY: GROUND_ROW,
      desiredDirection: 'NONE',
      assignedShaftX: null,
      waitX: null,
      assignedCarId: null,
      callRegistered: false,
      despawnOnArrival: false,
    };

    this.world.addComponent(agentEntity, 'agent', agent);

    this.nextAgentId += 1;
    return agentEntity;
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

    const lobbies = this.getFloorCellsByZone('LOBBY');
    const fallbackLobby = this.findNearestCell(lobbies, DEFAULT_LOBBY_X) ?? {
      x: DEFAULT_LOBBY_X,
      y: GROUND_ROW,
    };

    const spawned = this.spawnFreelanceAgent(fallbackLobby.x);
    this.agentSystem.issueTrip(spawned, hoveredCell, false);
  }

  private getFloorCellsByZone(zone: RoomZone): GridCell[] {
    const result: GridCell[] = [];

    for (const floorEntity of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(floorEntity, 'position');
      const floor = this.world.getComponent(floorEntity, 'floor');

      if (!position || !floor || floor.zone !== zone || !floor.occupied) {
        continue;
      }

      result.push({ x: position.x, y: position.y });
    }

    return result;
  }

  private findNearestCell(cells: GridCell[], fromX: number): GridCell | null {
    if (cells.length === 0) {
      return null;
    }

    let best = cells[0];
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const cell of cells) {
      const distance = Math.abs(cell.x - fromX);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cell;
      }
    }

    return best;
  }

  private toMinuteOfDay(totalMinute: number): number {
    return ((totalMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  }

  private isNight(minuteOfDay: number): boolean {
    return minuteOfDay >= 19 * 60 || minuteOfDay < 6 * 60;
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

    const minuteOfDay = this.toMinuteOfDay(this.lastProcessedGameMinute);
    GridRenderer.drawSkyGradient(
      this.worldContext,
      this.grid.widthPx,
      this.grid.heightPx,
      minuteOfDay,
    );

    this.drawGroundLine();
    GridRenderer.drawGrid(this.worldContext, this.grid);
    this.drawPlacedStructures(minuteOfDay);
  }

  private drawGroundLine(): void {
    const groundTop = this.grid.gridToScreen(0, GROUND_ROW).y;

    this.worldContext.fillStyle = 'rgba(15, 23, 42, 0.65)';
    this.worldContext.fillRect(0, groundTop, this.grid.widthPx, this.grid.cellSize);

    this.worldContext.strokeStyle = 'rgba(148, 163, 184, 0.8)';
    this.worldContext.lineWidth = 2;
    this.worldContext.beginPath();
    this.worldContext.moveTo(0, groundTop + 0.5);
    this.worldContext.lineTo(this.grid.widthPx, groundTop + 0.5);
    this.worldContext.stroke();
  }

  private drawPlacedStructures(minuteOfDay: number): void {
    const night = this.isNight(minuteOfDay);
    const twinklePhase = Math.floor(this.lastProcessedGameMinute / 30);

    for (const entityId of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(entityId, 'position');
      const floor = this.world.getComponent(entityId, 'floor');

      if (!position || !floor) {
        continue;
      }

      const tile = this.grid.gridToScreen(position.x, position.y);

      const zoneColor =
        floor.zone === 'HALLWAY'
          ? '#6b7280'
          : floor.zone === 'LOBBY'
          ? '#64748b'
          : floor.zone === 'OFFICE'
            ? '#3b82f6'
            : floor.zone === 'CONDO'
              ? '#14b8a6'
              : '#f59e0b';

      const topAccent =
        floor.zone === 'HALLWAY'
          ? '#d1d5db'
          : floor.zone === 'LOBBY'
          ? '#cbd5e1'
          : floor.zone === 'OFFICE'
            ? '#bfdbfe'
            : floor.zone === 'CONDO'
              ? '#99f6e4'
              : '#fde68a';

      this.worldContext.fillStyle = floor.occupied ? zoneColor : 'rgba(51, 65, 85, 0.7)';
      this.worldContext.fillRect(tile.x, tile.y, this.grid.cellSize, this.grid.cellSize);

      this.worldContext.fillStyle = floor.occupied ? topAccent : 'rgba(148, 163, 184, 0.45)';
      this.worldContext.fillRect(tile.x, tile.y, this.grid.cellSize, 6);

      const canLightWindows =
        floor.occupied && floor.zone !== 'HALLWAY' && floor.zone !== 'LOBBY';

      if (night && canLightWindows) {
        for (let index = 0; index < 4; index += 1) {
          const seed = floor.windowSeed + index * 17 + twinklePhase * 5;
          const lightChance = pseudoRandom(seed);
          if (lightChance < 0.42) {
            continue;
          }

          const localX = (index % 2) * 12 + 7;
          const localY = Math.floor(index / 2) * 10 + 10;

          this.worldContext.fillStyle = 'rgba(255, 241, 179, 0.92)';
          this.worldContext.fillRect(tile.x + localX, tile.y + localY, 4, 4);
        }
      }
    }

    for (const entityId of this.world.query('position', 'elevator')) {
      const position = this.world.getComponent(entityId, 'position');
      if (!position) {
        continue;
      }

      const tile = this.grid.gridToScreen(position.x, position.y);

      this.worldContext.fillStyle = '#334155';
      this.worldContext.fillRect(tile.x, tile.y, this.grid.cellSize, this.grid.cellSize);

      this.worldContext.fillStyle = 'rgba(148, 163, 184, 0.75)';
      this.worldContext.fillRect(
        tile.x + this.grid.cellSize * 0.37,
        tile.y + 3,
        this.grid.cellSize * 0.26,
        this.grid.cellSize - 6,
      );
    }
  }

  private renderSimulationLayer(): void {
    this.simulationContext.clearRect(0, 0, this.grid.widthPx, this.grid.heightPx);
    this.renderSystem.render(this.simulationContext);

    if (this.selectedTool === Tool.FLOOR && this.floorDragStart && this.floorDragCurrent) {
      const funds = gameStateStore.getSnapshot().money;
      const dragPreview = this.mouseSystem.getFloorDragPreview(
        this.floorDragStart,
        this.floorDragCurrent,
        funds,
      );

      for (const cell of dragPreview.cells) {
        GridRenderer.drawToolGhost(
          this.simulationContext,
          this.grid,
          cell,
          Tool.FLOOR,
          dragPreview.valid,
          dragPreview.affordable,
        );
      }

      return;
    }

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
