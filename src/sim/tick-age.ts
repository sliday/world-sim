export const NEW_TICK_WINDOW = 300;

export interface TickAge {
  ticks: number;
  isNew: boolean;
  label: string;
}

export function formatTickAge(nowTick: number, createdTick: number): TickAge {
  const ticks = Math.max(0, Math.floor(nowTick - createdTick));
  if (ticks <= NEW_TICK_WINDOW) return { ticks, isNew: true, label: "[new]" };
  if (ticks < 3_600) return { ticks, isNew: false, label: `${Math.floor(ticks / 60)}m old` };
  if (ticks < 86_400) return { ticks, isNew: false, label: `${Math.floor(ticks / 3_600)}h old` };
  return { ticks, isNew: false, label: `${Math.floor(ticks / 86_400)}d old` };
}
