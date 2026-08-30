export const NEW_TICK_WINDOW = 300;

export interface TickAge {
  ticks: number;
  isNew: boolean;
  label: string;
}

export function formatTickAge(nowTick: number, createdTick: number): TickAge {
  const ticks = Math.max(0, Math.floor(nowTick - createdTick));
  if (ticks <= NEW_TICK_WINDOW) return { ticks, isNew: true, label: "[NEW]" };
  if (ticks < 3_600) return { ticks, isNew: false, label: `${Math.floor(ticks / 60)}M OLD` };
  if (ticks < 86_400) return { ticks, isNew: false, label: `${Math.floor(ticks / 3_600)}H OLD` };
  return { ticks, isNew: false, label: `${Math.floor(ticks / 86_400)}D OLD` };
}
