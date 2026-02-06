import { useState, useSyncExternalStore } from 'react';
import { GameCanvas } from './components/GameCanvas';
import { formatGameTime, gameStateStore } from './engine/Core/Game';
import { Tool, TOOL_COSTS, TOOL_LABELS } from './engine/Core/Tools';

const TOOL_ORDER: Tool[] = [
  Tool.FLOOR,
  Tool.OFFICE,
  Tool.CONDO,
  Tool.FOOD_COURT,
  Tool.ELEVATOR,
  Tool.DELETE,
];

function roomZoneLabel(zone: string): string {
  return zone.replaceAll('_', ' ');
}

function App() {
  const [selectedTool, setSelectedTool] = useState<Tool | null>(Tool.FLOOR);

  const gameState = useSyncExternalStore(
    gameStateStore.subscribe,
    gameStateStore.getSnapshot,
    gameStateStore.getSnapshot,
  );

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-3 py-6 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">SimTower Prototype</h1>

        <section className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700 bg-slate-900/70 p-3">
          {TOOL_ORDER.map((tool) => {
            const isSelected = selectedTool === tool;
            const cost = TOOL_COSTS[tool];
            const canAfford = cost === 0 || gameState.money >= cost;

            return (
              <button
                key={tool}
                type="button"
                onClick={() => {
                  setSelectedTool((current) => (current === tool ? null : tool));
                }}
                className={`rounded px-3 py-2 text-sm font-medium transition ${
                  isSelected
                    ? 'bg-sky-500 text-slate-950'
                    : 'bg-slate-800 text-slate-100 hover:bg-slate-700'
                } ${!canAfford ? 'opacity-50' : ''}`}
              >
                {TOOL_LABELS[tool]}
                {cost > 0 ? ` ($${cost.toLocaleString()})` : ''}
              </button>
            );
          })}

          <p className="ml-2 text-xs text-slate-400">
            Drag with Floor to lay segments ($10 each). Rooms require floor support. Right click sends an
            agent. Click a selected tool again to deselect. Double click a room to inspect it.
          </p>
        </section>

        <div className="w-full overflow-x-auto rounded-lg">
          <div className="relative w-fit">
            <GameCanvas selectedTool={selectedTool} />

            <section className="pointer-events-none absolute left-4 top-4 rounded-md border border-slate-600/60 bg-slate-900/85 px-4 py-3 shadow-xl backdrop-blur-sm">
              <p className="text-xs uppercase tracking-[0.18em] text-slate-400">City Ledger</p>
              <p className="text-lg font-semibold">
                Current Funds: ${gameState.money.toLocaleString()}
              </p>
              <p className="text-sm text-slate-300">
                Time: {formatGameTime(gameState.elapsedMinutes)}
              </p>
              {gameState.statusMessage ? (
                <p className="mt-1 text-sm font-medium text-rose-300">
                  {gameState.statusMessage}
                </p>
              ) : null}
            </section>

            {gameState.inspectedRoom ? (
              <section className="pointer-events-none absolute right-4 top-4 rounded-md border border-slate-600/60 bg-slate-900/88 px-4 py-3 shadow-xl backdrop-blur-sm">
                <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Room Inspector</p>
                <p className="text-sm font-semibold">
                  {roomZoneLabel(gameState.inspectedRoom.zone)} #{gameState.inspectedRoom.roomId}
                </p>
                <p className="text-sm text-slate-200">
                  Rent: ${gameState.inspectedRoom.totalRent.toLocaleString()} / day
                </p>
                <p className="text-sm text-slate-200">
                  {gameState.inspectedRoom.assignedLabel}: {gameState.inspectedRoom.assignedCount}
                </p>
                <p className="text-sm text-slate-200">
                  Occupancy: {gameState.inspectedRoom.occupancyCount}/
                  {gameState.inspectedRoom.occupancyCapacity} ({gameState.inspectedRoom.occupancyPercent}%)
                </p>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}

export default App;
