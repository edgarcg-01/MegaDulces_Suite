/**
 * `[MS.2.5]` El reloj de la Mesa de Servicio: minutos HÁBILES y minutos corridos, en la zona horaria
 * del tenant. **Función pura**: nada de base de datos, nada de `new Date()` implícito.
 *
 * `[MS.3.8]` Vive en `libs/contracts` desde que la bandeja «sin asignar» de Mi trabajo (`libs/trade`) necesita medir la
 * espera en horas HÁBILES y `trade` no puede importar `service-desk` (`eslint.config.js`). La Mesa lo re-exporta desde
 * su `domain/business-clock.ts`, así que nada de lo que ya lo importaba cambió.
 *
 * ── Por qué se escribe acá y no se reutiliza ─────────────────────────────────────────────────
 * El repo NO tenía nada de horas hábiles (se buscó: `habil|festiv|holiday|business.?day` en libs, apps y
 * migraciones). `mx-date.ts` sólo da `toMxDateKey`/`todayMx`, y `biz-days.ts` es del front vendor y usa la
 * hora local del dispositivo. Un `getDay()` en el servidor leería el día del SERVIDOR, no el de México.
 *
 * ── Qué cuenta como hábil ────────────────────────────────────────────────────────────────────
 * Los días de `settings.business_days` (0 = domingo … 6 = sábado; por defecto lunes a sábado) entre
 * `business_start` y `business_end` en `settings.tz`. **No hay festivos**: no existe ese dato en ninguna
 * parte y no se inventa; se declara (FASE_MS §10). Si se agrega una tabla de festivos, este es el único
 * lugar que cambia.
 *
 * ── Zona horaria ─────────────────────────────────────────────────────────────────────────────
 * Se resuelve con `Intl.DateTimeFormat` + `timeZone`, nunca con el huso del proceso. México no tiene horario
 * de verano desde 2022, pero la conversión local→instante se hace iterando el desfase, así que tampoco
 * depende de que siga siendo así.
 */

export interface BusinessCalendar {
  /** IANA, p. ej. `America/Mexico_City`. */
  tz: string;
  /** 0 = domingo … 6 = sábado. */
  days: readonly number[];
  /** Minutos desde la medianoche local. 08:00 = 480. */
  startMin: number;
  endMin: number;
}

export const MINUTE_MS = 60_000;
/** Tope de días que se recorren al sumar: protege de un calendario vacío o un plazo absurdo. */
const MAX_DAYS_WALK = 3660;

/** `'08:00'` o `'08:00:00'` (formato de una columna `time` de Postgres) → minutos desde la medianoche. */
export function parseHHMM(value: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value).trim());
  if (!m) throw new Error(`Hora inválida: "${value}"`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) throw new Error(`Hora fuera de rango: "${value}"`);
  return h * 60 + mi;
}

export function validarCalendario(cal: BusinessCalendar): void {
  if (!cal.days.length) throw new Error('El calendario hábil no tiene ningún día');
  if (cal.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Los días hábiles van de 0 (domingo) a 6 (sábado)');
  if (cal.endMin <= cal.startMin) throw new Error('El horario hábil termina antes de empezar');
}

interface LocalParts {
  y: number;
  m: number;
  d: number;
  /** 0 = domingo … 6 = sábado, EN la zona del calendario. */
  dow: number;
  minOfDay: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(at: Date, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(at)) p[x.type] = x.value;
  return {
    y: Number(p['year']),
    m: Number(p['month']),
    d: Number(p['day']),
    dow: DOW[p['weekday']],
    minOfDay: Number(p['hour']) * 60 + Number(p['minute']),
  };
}

/** Desfase (ms) de la zona respecto de UTC en el instante `at`: positivo si va por delante de UTC. */
function offsetMs(at: Date, tz: string): number {
  const p = localParts(at, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, 0, p.minOfDay);
  // Se compara contra el instante truncado al minuto: `localParts` no entrega segundos.
  return asUtc - Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
}

/** El instante que corresponde a «año-mes-día a tal minuto» EN la zona `tz`. */
export function instantFromLocal(y: number, m: number, d: number, minOfDay: number, tz: string): Date {
  const naive = Date.UTC(y, m - 1, d, 0, minOfDay);
  let guess = naive - offsetMs(new Date(naive), tz);
  // Una segunda pasada corrige el caso en que el desfase del instante «adivinado» difiere del del real.
  guess = naive - offsetMs(new Date(guess), tz);
  return new Date(guess);
}

function nextDayStart(p: LocalParts, cal: BusinessCalendar): Date {
  // Mediodía UTC del día siguiente evita cualquier ambigüedad al sumar un día calendario.
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + 1, 12, 0));
  return instantFromLocal(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), cal.startMin, cal.tz);
}

/**
 * Suma `minutes` de tiempo HÁBIL a `from`. Si `from` cae fuera del horario, el reloj arranca en la próxima
 * apertura. `minutes = 0` devuelve el primer instante hábil a partir de `from`.
 */
export function addBusinessMinutes(from: Date, minutes: number, cal: BusinessCalendar): Date {
  validarCalendario(cal);
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error('Los minutos a sumar deben ser un número ≥ 0');
  let cursor = from;
  let remaining = Math.round(minutes);

  for (let i = 0; i < MAX_DAYS_WALK; i++) {
    const p = localParts(cursor, cal.tz);
    const hábil = cal.days.includes(p.dow);
    if (!hábil || p.minOfDay >= cal.endMin) {
      cursor = nextDayStart(p, cal);
      continue;
    }
    if (p.minOfDay < cal.startMin) {
      cursor = instantFromLocal(p.y, p.m, p.d, cal.startMin, cal.tz);
      continue;
    }
    const disponible = cal.endMin - p.minOfDay;
    if (remaining <= disponible) return new Date(cursor.getTime() + remaining * MINUTE_MS);
    remaining -= disponible;
    cursor = nextDayStart(p, cal);
  }
  throw new Error('addBusinessMinutes: el plazo excede el tope de días recorridos (calendario mal configurado)');
}

/** Minutos HÁBILES transcurridos entre `a` y `b`. 0 si `b <= a`. */
export function businessMinutesBetween(a: Date, b: Date, cal: BusinessCalendar): number {
  validarCalendario(cal);
  if (b.getTime() <= a.getTime()) return 0;
  let total = 0;
  let cursor = a;

  for (let i = 0; i < MAX_DAYS_WALK && cursor.getTime() < b.getTime(); i++) {
    const p = localParts(cursor, cal.tz);
    if (!cal.days.includes(p.dow) || p.minOfDay >= cal.endMin) {
      cursor = nextDayStart(p, cal);
      continue;
    }
    if (p.minOfDay < cal.startMin) {
      cursor = instantFromLocal(p.y, p.m, p.d, cal.startMin, cal.tz);
      continue;
    }
    const cierre = instantFromLocal(p.y, p.m, p.d, cal.endMin, cal.tz);
    const hasta = b.getTime() < cierre.getTime() ? b : cierre;
    total += Math.max(0, Math.round((hasta.getTime() - cursor.getTime()) / MINUTE_MS));
    cursor = nextDayStart(p, cal);
  }
  return total;
}

/** ¿`at` cae dentro del horario hábil? */
export function esHorarioHabil(at: Date, cal: BusinessCalendar): boolean {
  validarCalendario(cal);
  const p = localParts(at, cal.tz);
  return cal.days.includes(p.dow) && p.minOfDay >= cal.startMin && p.minOfDay < cal.endMin;
}

// ── Reloj de la política: hábil o corrido ────────────────────────────────────────────────────

export type ClockKind = 'business' | 'calendar';

export function addClockMinutes(from: Date, minutes: number, clock: ClockKind, cal: BusinessCalendar): Date {
  if (clock === 'calendar') {
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error('Los minutos a sumar deben ser un número ≥ 0');
    return new Date(from.getTime() + Math.round(minutes) * MINUTE_MS);
  }
  return addBusinessMinutes(from, minutes, cal);
}

export function clockMinutesBetween(a: Date, b: Date, clock: ClockKind, cal: BusinessCalendar): number {
  if (clock === 'calendar') return b.getTime() <= a.getTime() ? 0 : Math.round((b.getTime() - a.getTime()) / MINUTE_MS);
  return businessMinutesBetween(a, b, cal);
}
