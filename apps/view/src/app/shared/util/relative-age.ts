/**
 * Frescura y edad relativa de un timestamp — compartido por las superficies de
 * mapa (live-map, capa live de routes/commercial, flota). Centraliza lo que
 * antes estaba duplicado como `ageLabel` (live-map) y `ago` (logística), y
 * tokeniza los colores de estado (antes hex sueltos #16a34a/#d97706/#9ca3af).
 */

export type Freshness = 'online' | 'idle' | 'stale';

export const FRESHNESS = {
  ONLINE_MS: 90_000, // < 1.5 min → en línea
  IDLE_MS: 6 * 60_000, // < 6 min → inactivo; más → sin señal
} as const;

/** Estado de frescura a partir de la antigüedad (ms) del último fix. */
export function freshnessOf(capturedAtMs: number, nowMs: number): Freshness {
  const age = nowMs - capturedAtMs;
  if (age < FRESHNESS.ONLINE_MS) return 'online';
  if (age < FRESHNESS.IDLE_MS) return 'idle';
  return 'stale';
}

/** Color del estado (token CSS con fallback hex — no romper si el token no existe). */
export function freshnessColor(f: Freshness): string {
  switch (f) {
    case 'online': return 'var(--ok-fg, #16a34a)';
    case 'idle': return 'var(--warn-fg, #d97706)';
    default: return 'var(--neutral-400, #9ca3af)';
  }
}

/** "hace 30s" / "hace 5 min" / "hace 2 h". Clamp a 0 (relojes adelantados). */
export function relativeAge(capturedAtMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.round((nowMs - capturedAtMs) / 1000));
  if (sec < 60) return `hace ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.round(min / 60)} h`;
}
