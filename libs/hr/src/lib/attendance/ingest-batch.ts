/**
 * Fase RH · `[RH.1.2]` — el lote que manda el lector de relojes, en funciones puras.
 *
 * El formato es el del agente de Mega Talento, a propósito: ADR-084 D3 deja UN solo lector
 * de relojes y ese lector es el agente que ya está en producción. Para pasarlo a la Suite
 * sólo cambian su dirección y su llave; el cuerpo que manda es el mismo. Por eso los nombres
 * de los campos de entrada siguen en español (`serie`, `checadas`, `fechaHora`…).
 */

/** Una checada como la manda el agente: hora de PARED del reloj, sin zona. */
export interface IncomingPunch {
  codigo: string;
  /** 'YYYY-MM-DDTHH:mm:ss' (o con espacio) en hora local del reloj. */
  fechaHora: string;
  /** 0 entrada · 1 salida · 2/3 comida · 4/5 extra. */
  tipo?: number | null;
  /** 1 huella · 15 rostro · 2 clave · 3/4 tarjeta. El agente lo manda si su firmware lo da. */
  verificacion?: number | null;
}

export interface IncomingBatch {
  serie: string;
  ip?: string | null;
  origen?: string | null;
  agenteVersion?: string | null;
  agenteHost?: string | null;
  infoReloj?: {
    logCounts?: number;
    userCounts?: number;
    /** La hora que marcaba el reloj al leerlo (ISO), para medir su desfase. */
    horaReloj?: string;
    origenVisto?: string | null;
  } | null;
  usuarios?: Array<{ codigo: string; nombre?: string | null }> | null;
  checadas?: IncomingPunch[] | null;
  /** true = lectura VERIFICADA completa (respaldo), no el flujo en vivo. */
  completa?: boolean;
}

/** Una checada lista para guardar. */
export interface NormalizedPunch {
  code: string;
  /** 'YYYY-MM-DD HH:mm:ss', hora de pared tal como la mostró el reloj. */
  local: string;
  date: string;
  punchType: number | null;
  verifyMode: number | null;
}

export type IngestSource = 'agente' | 'push' | 'manual';

/**
 * Los relojes sin hora configurada graban 2000-01-01. Eso no es un dato: es basura que
 * después aparece como la falta de alguien. Mega Talento tenía 2,684 checadas así.
 */
export const MIN_VALID_DATE = '2001-01-01';

const RE_FECHA_HORA = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})$/;

const entero = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null;

/**
 * Limpia el lote: descarta lo que no se puede usar en vez de guardarlo mal. Rechaza código
 * vacío, fecha con otro formato, fechas anteriores a 2001 y repetidas dentro del mismo lote.
 */
export function normalizePunches(list: unknown): { rows: NormalizedPunch[]; rejected: number } {
  const items = Array.isArray(list) ? list : [];
  const seen = new Set<string>();
  const rows: NormalizedPunch[] = [];
  let rejected = 0;
  for (const raw of items) {
    const p = (raw || {}) as Partial<IncomingPunch>;
    const code = String(p.codigo ?? '').trim();
    const m = RE_FECHA_HORA.exec(String(p.fechaHora ?? '').trim());
    if (!code || !m || m[1] < MIN_VALID_DATE) { rejected += 1; continue; }
    const local = `${m[1]} ${m[2]}`;
    const key = `${code}__${local}`;
    if (seen.has(key)) { rejected += 1; continue; }
    seen.add(key);
    rows.push({ code, local, date: m[1], punchType: entero(p.tipo), verifyMode: entero(p.verificacion) });
  }
  return { rows, rejected };
}

/** El origen del lote; cualquier valor desconocido cuenta como el agente. */
export function normalizeSource(origen: unknown): IngestSource {
  return origen === 'push' || origen === 'manual' ? origen : 'agente';
}

/**
 * Desfase del reloj contra el servidor, en segundos (positivo = el reloj va adelantado).
 * Sin hora válida devuelve null: no se inventa un cero.
 */
export function clockDriftSeconds(horaReloj: unknown, now: Date): number | null {
  if (typeof horaReloj !== 'string' || !horaReloj.trim()) return null;
  const t = new Date(horaReloj).getTime();
  return Number.isFinite(t) ? Math.round((t - now.getTime()) / 1000) : null;
}

/**
 * El padrón que manda el reloj: código → nombre. Un nombre vacío queda como
 * 'Empleado <código>' para que la persona exista aunque el reloj no la nombre.
 */
export function deviceUsers(usuarios: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of Array.isArray(usuarios) ? usuarios : []) {
    const u = (raw || {}) as { codigo?: unknown; nombre?: unknown };
    const code = String(u.codigo ?? '').trim();
    if (!code) continue;
    const name = String(u.nombre ?? '').trim();
    out.set(code, name || `Empleado ${code}`);
  }
  return out;
}

/** La última fecha en que checó cada código dentro del lote (para detectar reapariciones). */
export function lastDateByCode(rows: NormalizedPunch[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const prev = out.get(r.code);
    if (!prev || r.date > prev) out.set(r.code, r.date);
  }
  return out;
}

/** La checada más reciente del lote (hora de pared), o null si no hay ninguna. */
export function latestLocal(rows: NormalizedPunch[]): string | null {
  let max: string | null = null;
  for (const r of rows) if (!max || r.local > max) max = r.local;
  return max;
}
