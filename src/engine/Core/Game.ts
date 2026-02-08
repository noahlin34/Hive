import {
  AgentSystem,
  type Agent,
  type AgentArchetype,
  createPersonAgent,
  type EntityId,
  ECSWorld,
  ElevatorSystem,
  type Floor,
  FloatingTextSystem,
  MouseSystem,
  RenderSystem,
  type RoomZone,
  ZoningSystem,
} from '../ECS/World';
import { GameLoop } from './Loop';
import { GridRenderer, GridSystem, type GridCell } from '../Renderer/GridRenderer';
import { Tool } from './Tools';

const GRID_CELL_SIZE = 64;
const GRID_COLUMNS = 30;
const GRID_ROWS = 20;
const GROUND_ROW = GRID_ROWS - 2;

const STARTING_FUNDS = 100000;
const OFFICE_TEXTURE_PATH: string | null = '/office.png';
const OFFICE_ACTIVE_TEXTURE_PATH: string | null = '/office_active.jpg';
const OFFICE_WIDE_TEXTURE_PATH: string | null = '/office_wide.png';
const CONDO_WIDE_TEXTURE_PATH: string | null = '/condo_wide.png';

const GAME_HOUR_REAL_MS = 2000;
const GAME_MINUTES_PER_REAL_MS = 60 / GAME_HOUR_REAL_MS;

const MINUTES_PER_DAY = 24 * 60;
const MORNING_MINUTE = 8 * 60;
const LUNCH_MINUTE = 12 * 60;
const EVENING_MINUTE = 17 * 60;

const DEFAULT_LOBBY_X = 2;
const MORNING_WORKER_COUNT = 6;
const RESIDENT_WORKER_SHARE = 0.45;

type StoreListener = () => void;

export type InspectableRoomZone = 'OFFICE' | 'CONDO' | 'FOOD_COURT';

export interface RoomInspection {
  roomId: number;
  roomIdSource: 'ROOM_ID' | 'ANCHOR';
  anchorX: number;
  anchorY: number;
  zone: InspectableRoomZone;
  tileCount: number;
  totalRent: number;
  assignedCount: number;
  assignedLabel: 'Employees' | 'Residents';
  occupancyCount: number;
  occupancyCapacity: number;
  occupancyPercent: number;
}

export interface GameState {
  money: number;
  elapsedMinutes: number;
  statusMessage: string | null;
  inspectedRoom: RoomInspection | null;
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
  inspectedRoom: null,
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
  private readonly zoningSystem = new ZoningSystem(this.world, GAME_MINUTES_PER_REAL_MS);
  private readonly floatingTextSystem = new FloatingTextSystem(this.world);
  private readonly renderSystem = new RenderSystem(this.world, this.grid);
  private readonly loop: GameLoop;

  private selectedTool: Tool | null = Tool.FLOOR;
  private worldLayerDirty = true;
  private officeTexture: HTMLImageElement | null = null;
  private officeTextureLoaded = false;
  private officeTexturePath: string | null = null;
  private officeActiveTexture: HTMLImageElement | null = null;
  private officeActiveTextureLoaded = false;
  private officeActiveTexturePath: string | null = null;
  private officeWideTexture: HTMLImageElement | null = null;
  private officeWideTextureLoaded = false;
  private officeWideTexturePath: string | null = null;
  private condoWideTexture: HTMLImageElement | null = null;
  private condoWideTextureLoaded = false;
  private condoWideTexturePath: string | null = null;
  private activeOfficeTiles = new Set<string>();

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

    this.setOfficeTexturePath(OFFICE_TEXTURE_PATH);
    this.setOfficeActiveTexturePath(OFFICE_ACTIVE_TEXTURE_PATH);
    this.setOfficeWideTexturePath(OFFICE_WIDE_TEXTURE_PATH);
    this.setCondoWideTexturePath(CONDO_WIDE_TEXTURE_PATH);
  }

  public start(): void {
    this.lastProcessedGameMinute = 0;
    this.lastPublishedGameMinute = -1;
    this.lastSkySlot = -1;
    this.nextAgentId = 1;
    this.activeOfficeTiles = new Set<string>();

    gameStateStore.setState({
      money: STARTING_FUNDS,
      elapsedMinutes: 0,
      statusMessage: null,
      inspectedRoom: null,
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

  public setTool(tool: Tool | null): void {
    this.selectedTool = tool;
  }

  public setOfficeTexturePath(path: string | null): void {
    const trimmed = path?.trim() ?? '';
    if (!trimmed) {
      this.officeTexturePath = null;
    } else if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('data:')
    ) {
      this.officeTexturePath = trimmed;
    } else {
      this.officeTexturePath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    }

    this.officeTexture = null;
    this.officeTextureLoaded = false;

    if (!this.officeTexturePath) {
      this.worldLayerDirty = true;
      return;
    }

    const requestedPath = this.officeTexturePath;
    const image = new Image();
    image.onload = () => {
      if (this.officeTexturePath !== requestedPath) {
        return;
      }
      this.officeTexture = image;
      this.officeTextureLoaded = true;
      this.worldLayerDirty = true;
    };
    image.onerror = () => {
      this.officeTexture = null;
      this.officeTextureLoaded = false;
      this.worldLayerDirty = true;
    };
    image.src = this.officeTexturePath;
  }

  public setOfficeActiveTexturePath(path: string | null): void {
    const trimmed = path?.trim() ?? '';
    if (!trimmed) {
      this.officeActiveTexturePath = null;
    } else if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('data:')
    ) {
      this.officeActiveTexturePath = trimmed;
    } else {
      this.officeActiveTexturePath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    }

    this.officeActiveTexture = null;
    this.officeActiveTextureLoaded = false;

    if (!this.officeActiveTexturePath) {
      this.worldLayerDirty = true;
      return;
    }

    const requestedPath = this.officeActiveTexturePath;
    const image = new Image();
    image.onload = () => {
      if (this.officeActiveTexturePath !== requestedPath) {
        return;
      }
      this.officeActiveTexture = image;
      this.officeActiveTextureLoaded = true;
      this.worldLayerDirty = true;
    };
    image.onerror = () => {
      this.officeActiveTexture = null;
      this.officeActiveTextureLoaded = false;
      this.worldLayerDirty = true;
    };
    image.src = this.officeActiveTexturePath;
  }

  public setOfficeWideTexturePath(path: string | null): void {
    const trimmed = path?.trim() ?? '';
    if (!trimmed) {
      this.officeWideTexturePath = null;
    } else if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('data:')
    ) {
      this.officeWideTexturePath = trimmed;
    } else {
      this.officeWideTexturePath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    }

    this.officeWideTexture = null;
    this.officeWideTextureLoaded = false;

    if (!this.officeWideTexturePath) {
      this.worldLayerDirty = true;
      return;
    }

    const requestedPath = this.officeWideTexturePath;
    const image = new Image();
    image.onload = () => {
      if (this.officeWideTexturePath !== requestedPath) {
        return;
      }
      this.officeWideTexture = image;
      this.officeWideTextureLoaded = true;
      this.worldLayerDirty = true;
    };
    image.onerror = () => {
      this.officeWideTexture = null;
      this.officeWideTextureLoaded = false;
      this.worldLayerDirty = true;
    };
    image.src = this.officeWideTexturePath;
  }

  public setCondoWideTexturePath(path: string | null): void {
    const trimmed = path?.trim() ?? '';
    if (!trimmed) {
      this.condoWideTexturePath = null;
    } else if (
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('data:')
    ) {
      this.condoWideTexturePath = trimmed;
    } else {
      this.condoWideTexturePath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    }

    this.condoWideTexture = null;
    this.condoWideTextureLoaded = false;

    if (!this.condoWideTexturePath) {
      this.worldLayerDirty = true;
      return;
    }

    const requestedPath = this.condoWideTexturePath;
    const image = new Image();
    image.onload = () => {
      if (this.condoWideTexturePath !== requestedPath) {
        return;
      }
      this.condoWideTexture = image;
      this.condoWideTextureLoaded = true;
      this.worldLayerDirty = true;
    };
    image.onerror = () => {
      this.condoWideTexture = null;
      this.condoWideTextureLoaded = false;
      this.worldLayerDirty = true;
    };
    image.src = this.condoWideTexturePath;
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

    if (this.selectedTool === null) {
      this.handleInspectDoubleClick(pixelX, pixelY);
      this.setStatus(null);
      return;
    }

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

  public handleInspectDoubleClick(pixelX: number, pixelY: number): void {
    const cell = this.grid.screenToGrid(pixelX, pixelY);
    if (!cell) {
      gameStateStore.setState({ inspectedRoom: null });
      return;
    }

    const inspectedRoom = this.buildRoomInspectionAtCell(cell);
    gameStateStore.setState({ inspectedRoom });
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
    this.refreshOfficeOccupancy();
    this.refreshInspectedRoom();

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

    this.spawnAutonomousTraffic(totalMinute, minuteOfDay);
    this.updateAutonomousRoutines(totalMinute, minuteOfDay);

    if (minuteOfDay === MORNING_MINUTE) {
      this.startOfficeDay(totalMinute);
      return;
    }

    if (minuteOfDay === LUNCH_MINUTE) {
      this.startLunchBreak(totalMinute);
      return;
    }

    if (minuteOfDay === EVENING_MINUTE) {
      this.endOfficeDay();
      return;
    }

    if (minuteOfDay === 0) {
      this.resetDailyFlags();
      this.collectRentAtMidnight();
    }
  }

  private spawnAutonomousTraffic(totalMinute: number, minuteOfDay: number): void {
    const offices = this.getFloorCellsByZone('OFFICE');
    const condos = this.getFloorCellsByZone('CONDO');
    const foodCourts = this.getFloorCellsByZone('FOOD_COURT');
    const lobbies = this.getFloorCellsByZone('LOBBY');

    if (lobbies.length === 0) {
      return;
    }

    const attractionScore =
      offices.length * 1.3 +
      condos.length * 1.1 +
      foodCourts.length * 2.1 +
      lobbies.length * 0.25;

    const visitors = this.getAgentsByArchetype('VISITOR').length;
    const visitorCap = Math.max(4, Math.min(24, Math.floor(2 + attractionScore * 0.32)));
    const visitorSpawnInterval = Math.max(6, 22 - Math.min(14, Math.floor(attractionScore / 2.5)));

    if (
      minuteOfDay >= 6 * 60 &&
      minuteOfDay < 22 * 60 &&
      visitors < visitorCap &&
      totalMinute % visitorSpawnInterval === 0
    ) {
      const spawnChance = Math.min(0.9, 0.16 + attractionScore * 0.01);
      if (Math.random() < spawnChance) {
        const lobby = lobbies[Math.floor(Math.random() * lobbies.length)];
        this.spawnVisitor(lobby.x, totalMinute);
      }
    }

    if (condos.length > 0) {
      const residents = this.getAgentsByArchetype('RESIDENT');
      const residentTarget = Math.min(condos.length, Math.max(1, Math.floor(condos.length * 0.78)));
      const residentSpawnInterval = 60;

      if (
        residents.length < residentTarget &&
        totalMinute % residentSpawnInterval === 0 &&
        Math.random() < 0.65
      ) {
        const occupiedHomes = new Set(
          residents
            .map((residentId) => this.world.getComponent(residentId, 'agent'))
            .filter((agent): agent is Agent => Boolean(agent && agent.homeX !== null && agent.homeY !== null))
            .map((agent) => `${agent.homeX},${agent.homeY}`),
        );

        const availableHomes = condos.filter((cell) => !occupiedHomes.has(`${cell.x},${cell.y}`));
        const home = this.pickRandomCell(availableHomes);

        if (home) {
          this.spawnResident(home, totalMinute);
        }
      }
    }
  }

  private updateAutonomousRoutines(totalMinute: number, minuteOfDay: number): void {
    const foodCourts = this.getFloorCellsByZone('FOOD_COURT');
    const offices = this.getFloorCellsByZone('OFFICE');
    const lobbies = this.getFloorCellsByZone('LOBBY');

    for (const agentEntity of this.world.query('position', 'agent')) {
      const position = this.world.getComponent(agentEntity, 'position');
      const agent = this.world.getComponent(agentEntity, 'agent');

      if (!position || !agent) {
        continue;
      }

      if (agent.phase !== 'AT_TARGET' && agent.phase !== 'IDLE') {
        continue;
      }

      const standingZone = this.getZoneAt(Math.round(position.x), Math.round(position.y));
      if (standingZone === 'FOOD_COURT' && totalMinute >= agent.nextActionMinute) {
        this.addShopRevenue(8 + Math.floor(Math.random() * 28), position.x, position.y);
        agent.nextActionMinute = totalMinute + 10 + Math.floor(Math.random() * 20);
      }

      if (agent.archetype === 'VISITOR') {
        if (agent.leaveByMinute !== null && totalMinute >= agent.leaveByMinute) {
          const exitTarget = this.getOffscreenExitTarget(position.x);
          const leaving = this.agentSystem.issueTrip(agentEntity, exitTarget, true);
          if (leaving) {
            agent.routine = 'LEAVING';
          }
          continue;
        }

        if (totalMinute < agent.nextActionMinute) {
          continue;
        }

        const target = this.pickExplorationTarget(position.x);
        if (!target) {
          continue;
        }

        const moving = this.agentSystem.issueTrip(agentEntity, target, false);
        if (moving) {
          agent.routine = target.y === GROUND_ROW ? 'VISITING' : 'SHOPPING';
          agent.nextActionMinute = totalMinute + 10 + Math.floor(Math.random() * 30);
        }

        continue;
      }

      if (agent.archetype === 'RESIDENT') {
        const isNight = minuteOfDay >= 21 * 60 || minuteOfDay < 6 * 60;

        if (isNight && agent.homeX !== null && agent.homeY !== null) {
          if (Math.round(position.x) !== agent.homeX || Math.round(position.y) !== agent.homeY) {
            const returning = this.agentSystem.issueTrip(
              agentEntity,
              { x: agent.homeX, y: agent.homeY },
              false,
            );
            if (returning) {
              agent.routine = 'COMMUTING_HOME';
            }
          } else {
            agent.routine = 'HOME';
          }
          continue;
        }

        if (
          agent.workX !== null &&
          agent.workY !== null &&
          minuteOfDay >= MORNING_MINUTE &&
          minuteOfDay < EVENING_MINUTE
        ) {
          if (agent.hasLunchedToday && minuteOfDay < LUNCH_MINUTE + 90) {
            continue;
          }

          if (minuteOfDay >= LUNCH_MINUTE && !agent.hasLunchedToday) {
            const lunchTarget =
              this.findNearestCell(foodCourts, position.x) ?? this.findNearestCell(lobbies, position.x);
            if (lunchTarget && this.agentSystem.issueTrip(agentEntity, lunchTarget, false)) {
              agent.routine = 'LUNCH_BREAK';
              agent.hasLunchedToday = true;
              agent.nextActionMinute = totalMinute + 30;
              continue;
            }
          }

          if (agent.routine === 'LUNCH_BREAK' && totalMinute >= agent.nextActionMinute) {
            if (this.agentSystem.issueTrip(agentEntity, { x: agent.workX, y: agent.workY }, false)) {
              agent.routine = 'COMMUTING_TO_WORK';
            }
            continue;
          }

          if (Math.round(position.x) !== agent.workX || Math.round(position.y) !== agent.workY) {
            if (this.agentSystem.issueTrip(agentEntity, { x: agent.workX, y: agent.workY }, false)) {
              agent.routine = 'COMMUTING_TO_WORK';
            }
            continue;
          }

          agent.routine = 'WORKING';
          continue;
        }

        if (totalMinute >= agent.nextActionMinute) {
          const wanderTarget =
            this.findNearestCell(foodCourts, position.x) ??
            this.findNearestCell(offices, position.x) ??
            this.findNearestCell(lobbies, position.x);

          if (wanderTarget && this.agentSystem.issueTrip(agentEntity, wanderTarget, false)) {
            agent.routine = 'WANDERING';
            agent.nextActionMinute = totalMinute + 20 + Math.floor(Math.random() * 25);
          }
        }

        continue;
      }

      if (agent.archetype === 'OFFICE_WORKER') {
        if (minuteOfDay >= EVENING_MINUTE || minuteOfDay < MORNING_MINUTE) {
          const exitTarget = this.getOffscreenExitTarget(position.x);
          if (this.agentSystem.issueTrip(agentEntity, exitTarget, true)) {
            agent.routine = 'LEAVING';
          }
          continue;
        }

        if (minuteOfDay >= LUNCH_MINUTE && !agent.hasLunchedToday) {
          const lunchTarget =
            this.findNearestCell(foodCourts, position.x) ?? this.findNearestCell(lobbies, position.x);

          if (lunchTarget && this.agentSystem.issueTrip(agentEntity, lunchTarget, false)) {
            agent.routine = 'LUNCH_BREAK';
            agent.hasLunchedToday = true;
            agent.nextActionMinute = totalMinute + 30;
            continue;
          }
        }

        if (
          agent.routine === 'LUNCH_BREAK' &&
          totalMinute >= agent.nextActionMinute &&
          agent.workX !== null &&
          agent.workY !== null
        ) {
          if (this.agentSystem.issueTrip(agentEntity, { x: agent.workX, y: agent.workY }, false)) {
            agent.routine = 'COMMUTING_TO_WORK';
          }
          continue;
        }

        if (agent.workX !== null && agent.workY !== null) {
          if (Math.round(position.x) !== agent.workX || Math.round(position.y) !== agent.workY) {
            if (this.agentSystem.issueTrip(agentEntity, { x: agent.workX, y: agent.workY }, false)) {
              agent.routine = 'COMMUTING_TO_WORK';
            }
          } else {
            agent.routine = 'WORKING';
          }
        }
      }
    }
  }

  private startOfficeDay(totalMinute: number): void {
    const offices = this.getFloorCellsByZone('OFFICE');
    const lobbies = this.getFloorCellsByZone('LOBBY');

    if (offices.length === 0 || lobbies.length === 0) {
      return;
    }

    const residents = this.getAgentsByArchetype('RESIDENT');
    const residentWorkerBudget = Math.min(
      offices.length,
      Math.floor(offices.length * RESIDENT_WORKER_SHARE),
    );

    const shuffledOffices = [...offices].sort(() => Math.random() - 0.5);
    let assignedResidentWorkers = 0;

    for (const residentId of residents) {
      if (assignedResidentWorkers >= residentWorkerBudget || shuffledOffices.length === 0) {
        break;
      }

      const resident = this.world.getComponent(residentId, 'agent');
      const residentPos = this.world.getComponent(residentId, 'position');
      if (!resident || !residentPos) {
        continue;
      }

      const office = shuffledOffices.pop();
      if (!office) {
        continue;
      }

      resident.workX = office.x;
      resident.workY = office.y;
      resident.hasLunchedToday = false;

      if (this.agentSystem.issueTrip(residentId, office, false)) {
        resident.routine = 'COMMUTING_TO_WORK';
        assignedResidentWorkers += 1;
      }
    }

    const targetExternalWorkers = Math.min(
      offices.length,
      MORNING_WORKER_COUNT + Math.floor(offices.length * 0.3),
    );

    for (let index = 0; index < targetExternalWorkers && shuffledOffices.length > 0; index += 1) {
      const spawnLobby = lobbies[Math.floor(Math.random() * lobbies.length)];
      const office = shuffledOffices.pop();
      if (!office) {
        continue;
      }

      const worker = this.spawnOfficeWorker(spawnLobby.x, office, totalMinute);
      this.agentSystem.issueTrip(worker, office, false);
    }
  }

  private startLunchBreak(totalMinute: number): void {
    const foodCourts = this.getFloorCellsByZone('FOOD_COURT');
    const lobbies = this.getFloorCellsByZone('LOBBY');

    for (const workerEntity of this.world.query('agent', 'position')) {
      const agent = this.world.getComponent(workerEntity, 'agent');
      const position = this.world.getComponent(workerEntity, 'position');

      if (!agent || !position) {
        continue;
      }

      const isWorkingResident =
        agent.archetype === 'RESIDENT' &&
        agent.workX !== null &&
        agent.workY !== null &&
        agent.routine === 'WORKING';
      const isOfficeWorker = agent.archetype === 'OFFICE_WORKER' && agent.routine === 'WORKING';

      if ((!isWorkingResident && !isOfficeWorker) || agent.hasLunchedToday) {
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

      agent.routine = 'LUNCH_BREAK';
      agent.hasLunchedToday = true;
      agent.nextActionMinute = totalMinute + 30;
    }
  }

  private endOfficeDay(): void {
    for (const workerEntity of this.world.query('agent', 'position')) {
      const agent = this.world.getComponent(workerEntity, 'agent');
      const position = this.world.getComponent(workerEntity, 'position');

      if (!agent || !position) {
        continue;
      }

      if (agent.archetype === 'RESIDENT' && agent.homeX !== null && agent.homeY !== null) {
        if (this.agentSystem.issueTrip(workerEntity, { x: agent.homeX, y: agent.homeY }, false)) {
          agent.routine = 'COMMUTING_HOME';
        }
        continue;
      }

      if (agent.archetype !== 'OFFICE_WORKER') {
        continue;
      }

      const exitTarget = this.getOffscreenExitTarget(position.x);
      const success = this.agentSystem.issueTrip(workerEntity, exitTarget, true);
      if (!success) {
        continue;
      }

      agent.routine = 'LEAVING';
    }
  }

  private resetDailyFlags(): void {
    for (const agentEntity of this.world.query('agent')) {
      const agent = this.world.getComponent(agentEntity, 'agent');
      if (!agent) {
        continue;
      }

      agent.hasLunchedToday = false;
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

  private spawnVisitor(spawnX: number, totalMinute: number, autoEnter: boolean = true): EntityId {
    const ingress = this.resolveIngress(spawnX);
    const spawnCell = ingress?.spawn ?? { x: spawnX, y: GROUND_ROW };
    const entryCell = ingress?.entry ?? { x: spawnX, y: GROUND_ROW };
    const visitor = this.world.createEntity();

    this.world.addComponent(visitor, 'position', {
      x: spawnCell.x,
      y: spawnCell.y,
    });

    this.world.addComponent(visitor, 'renderable', {
      color: '#ef4444',
      shape: 'square',
      sizeScale: 0.66,
    });

    this.world.addComponent(visitor, 'agent', {
      ...createPersonAgent('VISITOR', {
        name: `Visitor ${this.nextAgentId}`,
        archetype: 'VISITOR',
        routine: 'VISITING',
        mood: 'neutral',
        speed: 3.1,
        phase: 'IDLE',
        stress: 0,
        waitMs: 0,
        nextActionMinute: totalMinute + 10 + Math.floor(Math.random() * 20),
        leaveByMinute: totalMinute + 60 + Math.floor(Math.random() * 180),
        hasLunchedToday: false,
        sourceFloorY: spawnCell.y,
        targetFloorY: spawnCell.y,
        targetX: spawnCell.x,
        targetY: spawnCell.y,
        homeX: null,
        homeY: null,
        workX: null,
        workY: null,
        desiredDirection: 'NONE',
        assignedShaftX: null,
        waitX: null,
        assignedCarId: null,
        callRegistered: false,
        despawnOnArrival: false,
      }),
    });

    if (autoEnter && (entryCell.x !== spawnCell.x || entryCell.y !== spawnCell.y)) {
      const didEnter = this.agentSystem.issueTrip(visitor, entryCell, false);
      if (didEnter) {
        const agent = this.world.getComponent(visitor, 'agent');
        if (agent) {
          agent.routine = 'VISITING';
          agent.nextActionMinute = totalMinute + 20 + Math.floor(Math.random() * 25);
        }
      }
    }

    this.nextAgentId += 1;
    return visitor;
  }

  private spawnResident(home: GridCell, totalMinute: number): EntityId {
    const ingress = this.resolveIngress(home.x);
    const spawnCell = ingress?.spawn ?? { x: home.x, y: home.y };
    const resident = this.world.createEntity();

    this.world.addComponent(resident, 'position', {
      x: spawnCell.x,
      y: spawnCell.y,
    });

    this.world.addComponent(resident, 'renderable', {
      color: '#22c55e',
      shape: 'square',
      sizeScale: 0.66,
    });

    this.world.addComponent(resident, 'agent', {
      ...createPersonAgent('RESIDENT', {
        name: `Resident ${this.nextAgentId}`,
        archetype: 'RESIDENT',
        routine: 'COMMUTING_HOME',
        mood: 'neutral',
        speed: 3,
        phase: 'IDLE',
        stress: 0,
        waitMs: 0,
        nextActionMinute: totalMinute + 15 + Math.floor(Math.random() * 35),
        leaveByMinute: null,
        hasLunchedToday: false,
        sourceFloorY: spawnCell.y,
        targetFloorY: spawnCell.y,
        targetX: spawnCell.x,
        targetY: spawnCell.y,
        homeX: home.x,
        homeY: home.y,
        workX: null,
        workY: null,
        desiredDirection: 'NONE',
        assignedShaftX: null,
        waitX: null,
        assignedCarId: null,
        callRegistered: false,
        despawnOnArrival: false,
      }),
    });

    const didEnter = this.agentSystem.issueTrip(resident, home, false);
    if (!didEnter) {
      const agent = this.world.getComponent(resident, 'agent');
      if (agent) {
        agent.routine = 'WANDERING';
      }
    }

    this.nextAgentId += 1;
    return resident;
  }

  private spawnOfficeWorker(homeX: number, officeDesk: GridCell, totalMinute: number): EntityId {
    const ingress = this.resolveIngress(homeX);
    const spawnCell = ingress?.spawn ?? { x: homeX, y: GROUND_ROW };
    const worker = this.world.createEntity();

    this.world.addComponent(worker, 'position', {
      x: spawnCell.x,
      y: spawnCell.y,
    });

    this.world.addComponent(worker, 'renderable', {
      color: '#ef4444',
      shape: 'square',
      sizeScale: 0.66,
    });

    this.world.addComponent(worker, 'agent', {
      ...createPersonAgent('OFFICE_WORKER', {
        name: `Worker ${this.nextAgentId}`,
        archetype: 'OFFICE_WORKER',
        routine: 'COMMUTING_TO_WORK',
        mood: 'neutral',
        speed: 3.2,
        phase: 'IDLE',
        stress: 0,
        waitMs: 0,
        nextActionMinute: totalMinute + 10 + Math.floor(Math.random() * 12),
        leaveByMinute: null,
        hasLunchedToday: false,
        sourceFloorY: spawnCell.y,
        targetFloorY: spawnCell.y,
        targetX: spawnCell.x,
        targetY: spawnCell.y,
        homeX: null,
        homeY: null,
        workX: officeDesk.x,
        workY: officeDesk.y,
        desiredDirection: 'NONE',
        assignedShaftX: null,
        waitX: null,
        assignedCarId: null,
        callRegistered: false,
        despawnOnArrival: false,
      }),
    });

    this.nextAgentId += 1;
    return worker;
  }

  private spawnFreelanceAgent(homeX: number): EntityId {
    return this.spawnVisitor(homeX, this.lastProcessedGameMinute, false);
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

  private getOffscreenExitTarget(fromX: number): GridCell {
    const center = GRID_COLUMNS * 0.5;
    const useLeftExit =
      fromX < center || (Math.abs(fromX - center) < 0.01 && Math.random() < 0.5);

    return {
      x: useLeftExit ? -2 : GRID_COLUMNS + 2,
      y: GROUND_ROW,
    };
  }

  private resolveIngress(preferredX: number): { spawn: GridCell; entry: GridCell } | null {
    const lobbies = this.getFloorCellsByZone('LOBBY').filter((cell) => cell.y === GROUND_ROW);
    if (lobbies.length === 0) {
      return null;
    }

    let leftEdge = lobbies[0];
    let rightEdge = lobbies[0];
    for (const lobby of lobbies) {
      if (lobby.x < leftEdge.x) {
        leftEdge = lobby;
      }
      if (lobby.x > rightEdge.x) {
        rightEdge = lobby;
      }
    }

    const entry = this.findNearestCell(lobbies, preferredX) ?? leftEdge;
    if (leftEdge.x === rightEdge.x) {
      return { spawn: leftEdge, entry };
    }

    const midpoint = (leftEdge.x + rightEdge.x) * 0.5;
    const spawn = preferredX >= midpoint ? leftEdge : rightEdge;
    return { spawn, entry };
  }

  private getAgentsByArchetype(archetype: AgentArchetype): EntityId[] {
    const matches: EntityId[] = [];

    for (const entityId of this.world.query('agent')) {
      const agent = this.world.getComponent(entityId, 'agent');
      if (!agent || agent.archetype !== archetype) {
        continue;
      }

      matches.push(entityId);
    }

    return matches;
  }

  private pickRandomCell(cells: GridCell[]): GridCell | null {
    if (cells.length === 0) {
      return null;
    }

    const index = Math.floor(Math.random() * cells.length);
    return cells[index] ?? null;
  }

  private pickExplorationTarget(fromX: number): GridCell | null {
    const lobbies = this.getFloorCellsByZone('LOBBY');
    const foodCourts = this.getFloorCellsByZone('FOOD_COURT');
    const offices = this.getFloorCellsByZone('OFFICE');
    const condos = this.getFloorCellsByZone('CONDO');

    const weighted: Array<{ cell: GridCell; weight: number }> = [];

    for (const cell of foodCourts) {
      weighted.push({ cell, weight: 4.2 });
    }

    for (const cell of offices) {
      weighted.push({ cell, weight: 2.4 });
    }

    for (const cell of condos) {
      weighted.push({ cell, weight: 1.2 });
    }

    for (const cell of lobbies) {
      weighted.push({ cell, weight: 1 });
    }

    if (weighted.length === 0) {
      return null;
    }

    let weightTotal = 0;
    for (const entry of weighted) {
      const distanceFactor = 1 + Math.abs(entry.cell.x - fromX) * 0.25;
      weightTotal += entry.weight / distanceFactor;
    }

    if (weightTotal <= 0) {
      return weighted[0]?.cell ?? null;
    }

    let roll = Math.random() * weightTotal;
    for (const entry of weighted) {
      const distanceFactor = 1 + Math.abs(entry.cell.x - fromX) * 0.25;
      roll -= entry.weight / distanceFactor;
      if (roll <= 0) {
        return entry.cell;
      }
    }

    return weighted[weighted.length - 1]?.cell ?? null;
  }

  private getZoneAt(x: number, y: number): RoomZone | null {
    for (const floorEntity of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(floorEntity, 'position');
      const floor = this.world.getComponent(floorEntity, 'floor');

      if (!position || !floor) {
        continue;
      }

      if (position.x === x && position.y === y) {
        return floor.zone;
      }
    }

    return null;
  }

  private isInspectableZone(zone: RoomZone): zone is InspectableRoomZone {
    return zone === 'OFFICE' || zone === 'CONDO' || zone === 'FOOD_COURT';
  }

  private buildRoomInspectionAtCell(cell: GridCell): RoomInspection | null {
    const floor = this.getFloorAt(cell.x, cell.y);
    if (!floor || !floor.occupied || !this.isInspectableZone(floor.zone)) {
      return null;
    }

    if (floor.roomId === null) {
      return this.buildRoomInspectionFromAnchor(cell, floor.zone);
    }

    return this.buildRoomInspectionById(floor.roomId);
  }

  private buildRoomInspectionById(roomId: number): RoomInspection | null {
    const roomTiles = this.getRoomTilesByRoomId(roomId);
    if (!roomTiles) {
      return null;
    }

    return this.buildRoomInspection(roomTiles.zone, roomTiles.tiles, roomTiles.totalRent, roomId, 'ROOM_ID');
  }

  private buildRoomInspectionFromAnchor(
    anchor: GridCell,
    zone: InspectableRoomZone,
  ): RoomInspection | null {
    const cluster = this.getConnectedRoomTiles(anchor, zone);
    if (cluster.tiles.length === 0) {
      return null;
    }

    const syntheticRoomId = this.syntheticRoomId(anchor, zone);
    return this.buildRoomInspection(zone, cluster.tiles, cluster.totalRent, syntheticRoomId, 'ANCHOR');
  }

  private buildRoomInspection(
    zone: InspectableRoomZone,
    tiles: GridCell[],
    totalRent: number,
    roomId: number,
    roomIdSource: 'ROOM_ID' | 'ANCHOR',
  ): RoomInspection {
    const anchor = this.pickAnchorTile(tiles);
    const tileKeys = new Set(tiles.map((tile) => this.cellKey(tile.x, tile.y)));
    let occupancyCount = 0;
    let assignedCount = 0;

    for (const agentEntity of this.world.query('position', 'agent')) {
      const position = this.world.getComponent(agentEntity, 'position');
      const agent = this.world.getComponent(agentEntity, 'agent');
      if (!position || !agent) {
        continue;
      }

      const standingKey = this.cellKey(Math.round(position.x), Math.round(position.y));
      if (tileKeys.has(standingKey)) {
        occupancyCount += 1;
      }

      if (zone === 'OFFICE') {
        if (
          (agent.archetype === 'OFFICE_WORKER' || agent.archetype === 'RESIDENT') &&
          agent.workX !== null &&
          agent.workY !== null &&
          tileKeys.has(this.cellKey(agent.workX, agent.workY))
        ) {
          assignedCount += 1;
        }
      } else if (zone === 'CONDO') {
        if (
          agent.archetype === 'RESIDENT' &&
          agent.homeX !== null &&
          agent.homeY !== null &&
          tileKeys.has(this.cellKey(agent.homeX, agent.homeY))
        ) {
          assignedCount += 1;
        }
      }
    }

    const occupancyCapacityPerTile = zone === 'OFFICE' ? 6 : zone === 'CONDO' ? 3 : 10;
    const occupancyCapacity = Math.max(1, tiles.length * occupancyCapacityPerTile);
    const occupancyPercent = Math.min(
      999,
      Math.round((occupancyCount / occupancyCapacity) * 100),
    );

    return {
      roomId,
      roomIdSource,
      anchorX: anchor.x,
      anchorY: anchor.y,
      zone,
      tileCount: tiles.length,
      totalRent,
      assignedCount,
      assignedLabel: zone === 'CONDO' ? 'Residents' : 'Employees',
      occupancyCount,
      occupancyCapacity,
      occupancyPercent,
    };
  }

  private refreshInspectedRoom(): void {
    const currentInspection = gameStateStore.getSnapshot().inspectedRoom;
    if (!currentInspection) {
      return;
    }

    const refreshed =
      currentInspection.roomIdSource === 'ROOM_ID'
        ? this.buildRoomInspectionById(currentInspection.roomId)
        : this.buildRoomInspectionAtCell({
            x: currentInspection.anchorX,
            y: currentInspection.anchorY,
          });
    if (!this.isRoomInspectionEqual(currentInspection, refreshed)) {
      gameStateStore.setState({ inspectedRoom: refreshed });
    }
  }

  private addShopRevenue(amount: number, x: number, y: number): void {
    if (amount <= 0) {
      return;
    }

    const funds = gameStateStore.getSnapshot().money;
    gameStateStore.setState({
      money: funds + amount,
    });

    this.spawnFloatingText(x, y - 0.05, `+$${amount}`);
  }

  private toMinuteOfDay(totalMinute: number): number {
    return ((totalMinute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
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
    void minuteOfDay;

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

      if (floor.zone === 'CONDO' && floor.occupied) {
        const span = floor.condoSpan ?? 'SINGLE';
        if (span === 'RIGHT') {
          const leftFloor = this.getFloorAt(position.x - 1, position.y);
          if (
            leftFloor &&
            leftFloor.occupied &&
            leftFloor.zone === 'CONDO' &&
            leftFloor.condoSpan === 'LEFT'
          ) {
            continue;
          }
        }

        if (span === 'LEFT' && this.condoWideTextureLoaded && this.condoWideTexture) {
          const rightFloor = this.getFloorAt(position.x + 1, position.y);
          const isValidWidePair =
            rightFloor !== null &&
            rightFloor.occupied &&
            rightFloor.zone === 'CONDO' &&
            rightFloor.condoSpan === 'RIGHT';

          if (isValidWidePair) {
            this.worldContext.drawImage(
              this.condoWideTexture,
              tile.x,
              tile.y,
              this.grid.cellSize * 2,
              this.grid.cellSize,
            );
            continue;
          }
        }
      }

      if (floor.zone === 'OFFICE' && floor.occupied) {
        const span = floor.officeSpan ?? 'SINGLE';
        if (span === 'RIGHT') {
          const leftFloor = this.getFloorAt(position.x - 1, position.y);
          if (
            leftFloor &&
            leftFloor.occupied &&
            leftFloor.zone === 'OFFICE' &&
            leftFloor.officeSpan === 'LEFT'
          ) {
            continue;
          }
        }

        if (
          span === 'LEFT' &&
          this.officeWideTextureLoaded &&
          this.officeWideTexture
        ) {
          const rightFloor = this.getFloorAt(position.x + 1, position.y);
          const isValidWidePair =
            rightFloor !== null &&
            rightFloor.occupied &&
            rightFloor.zone === 'OFFICE' &&
            rightFloor.officeSpan === 'RIGHT';

          if (isValidWidePair) {
            this.worldContext.drawImage(
              this.officeWideTexture,
              tile.x,
              tile.y,
              this.grid.cellSize * 2,
              this.grid.cellSize,
            );
            continue;
          }
        }

        const officeKey = this.cellKey(position.x, position.y);
        const active = this.activeOfficeTiles.has(officeKey);
        const texture =
          active && this.officeActiveTextureLoaded && this.officeActiveTexture
            ? this.officeActiveTexture
            : this.officeTextureLoaded && this.officeTexture
              ? this.officeTexture
              : null;

        if (texture) {
          this.worldContext.drawImage(texture, tile.x, tile.y, this.grid.cellSize, this.grid.cellSize);
          continue;
        }
      }

      this.worldContext.fillStyle = floor.occupied ? zoneColor : 'rgba(51, 65, 85, 0.7)';
      this.worldContext.fillRect(tile.x, tile.y, this.grid.cellSize, this.grid.cellSize);

      this.worldContext.fillStyle = floor.occupied ? topAccent : 'rgba(148, 163, 184, 0.45)';
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

      this.worldContext.fillStyle = 'rgba(148, 163, 184, 0.75)';
      this.worldContext.fillRect(
        tile.x + this.grid.cellSize * 0.37,
        tile.y + 3,
        this.grid.cellSize * 0.26,
        this.grid.cellSize - 6,
      );
    }
  }

  private refreshOfficeOccupancy(): void {
    const officeTiles = new Set<string>();
    const roomTiles = new Set<string>();
    for (const floorEntity of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(floorEntity, 'position');
      const floor = this.world.getComponent(floorEntity, 'floor');
      if (!position || !floor || !floor.occupied) {
        continue;
      }

      const key = this.cellKey(position.x, position.y);
      if (floor.zone === 'OFFICE') {
        officeTiles.add(key);
        roomTiles.add(key);
      } else if (floor.zone === 'CONDO' || floor.zone === 'FOOD_COURT') {
        roomTiles.add(key);
      }
    }

    const activeOfficeTiles = new Set<string>();
    for (const agentEntity of this.world.query('position', 'agent', 'renderable')) {
      const position = this.world.getComponent(agentEntity, 'position');
      const agent = this.world.getComponent(agentEntity, 'agent');
      const renderable = this.world.getComponent(agentEntity, 'renderable');
      if (!position || !agent || !renderable) {
        continue;
      }

      const tileX = Math.round(position.x);
      const tileY = Math.round(position.y);
      const tileKey = this.cellKey(tileX, tileY);
      const isInsideRoom = agent.phase === 'AT_TARGET' && roomTiles.has(tileKey);

      renderable.hidden = isInsideRoom;
      if (isInsideRoom && officeTiles.has(tileKey)) {
        activeOfficeTiles.add(tileKey);
      }
    }

    if (!this.areEqualSets(this.activeOfficeTiles, activeOfficeTiles)) {
      this.activeOfficeTiles = activeOfficeTiles;
      this.worldLayerDirty = true;
    }
  }

  private cellKey(x: number, y: number): string {
    return `${x},${y}`;
  }

  private getFloorAt(x: number, y: number): Floor | null {
    for (const floorEntity of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(floorEntity, 'position');
      const floor = this.world.getComponent(floorEntity, 'floor');
      if (!position || !floor) {
        continue;
      }

      if (position.x === x && position.y === y) {
        return floor;
      }
    }

    return null;
  }

  private getRoomTilesByRoomId(
    roomId: number,
  ): { zone: InspectableRoomZone; tiles: GridCell[]; totalRent: number } | null {
    let zone: InspectableRoomZone | null = null;
    const tiles: GridCell[] = [];
    let totalRent = 0;

    for (const floorEntity of this.world.query('position', 'floor')) {
      const position = this.world.getComponent(floorEntity, 'position');
      const floor = this.world.getComponent(floorEntity, 'floor');
      if (!position || !floor) {
        continue;
      }

      if (floor.roomId !== roomId || !floor.occupied || !this.isInspectableZone(floor.zone)) {
        continue;
      }

      if (zone === null) {
        zone = floor.zone;
      }

      if (floor.zone !== zone) {
        continue;
      }

      tiles.push({ x: position.x, y: position.y });
      totalRent += floor.rent;
    }

    if (!zone || tiles.length === 0) {
      return null;
    }

    return { zone, tiles, totalRent };
  }

  private getConnectedRoomTiles(
    anchor: GridCell,
    zone: InspectableRoomZone,
  ): { tiles: GridCell[]; totalRent: number } {
    const queue: GridCell[] = [anchor];
    const visited = new Set<string>();
    const tiles: GridCell[] = [];
    let totalRent = 0;

    while (queue.length > 0) {
      const cell = queue.shift();
      if (!cell) {
        continue;
      }

      const key = this.cellKey(cell.x, cell.y);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);

      const floor = this.getFloorAt(cell.x, cell.y);
      if (!floor || !floor.occupied || floor.zone !== zone) {
        continue;
      }

      tiles.push(cell);
      totalRent += floor.rent;

      queue.push({ x: cell.x - 1, y: cell.y });
      queue.push({ x: cell.x + 1, y: cell.y });
      queue.push({ x: cell.x, y: cell.y - 1 });
      queue.push({ x: cell.x, y: cell.y + 1 });
    }

    return { tiles, totalRent };
  }

  private pickAnchorTile(tiles: GridCell[]): GridCell {
    let anchor = tiles[0] ?? { x: 0, y: 0 };

    for (const tile of tiles) {
      if (tile.y < anchor.y || (tile.y === anchor.y && tile.x < anchor.x)) {
        anchor = tile;
      }
    }

    return anchor;
  }

  private syntheticRoomId(anchor: GridCell, zone: InspectableRoomZone): number {
    const zoneSalt = zone === 'OFFICE' ? 1 : zone === 'CONDO' ? 2 : 3;
    return 1_000_000 + zoneSalt * 100_000 + anchor.y * 1_000 + anchor.x;
  }

  private isRoomInspectionEqual(a: RoomInspection | null, b: RoomInspection | null): boolean {
    if (!a || !b) {
      return a === b;
    }

    return (
      a.roomId === b.roomId &&
      a.roomIdSource === b.roomIdSource &&
      a.anchorX === b.anchorX &&
      a.anchorY === b.anchorY &&
      a.zone === b.zone &&
      a.tileCount === b.tileCount &&
      a.totalRent === b.totalRent &&
      a.assignedCount === b.assignedCount &&
      a.assignedLabel === b.assignedLabel &&
      a.occupancyCount === b.occupancyCount &&
      a.occupancyCapacity === b.occupancyCapacity &&
      a.occupancyPercent === b.occupancyPercent
    );
  }

  private areEqualSets(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) {
      return false;
    }

    for (const value of a) {
      if (!b.has(value)) {
        return false;
      }
    }

    return true;
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

    if (this.selectedTool === null) {
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
