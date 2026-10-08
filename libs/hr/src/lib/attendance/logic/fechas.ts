/**
 * Fase RH — utilidades de fecha que Mega Talento repetía en cada archivo (`menosDias`,
 * `siguienteDia`, `rangoFechas`, `hoyMexico`). Todas trabajan con 'yyyy-MM-dd' a MEDIODÍA UTC,
 * que es lo que hace que ningún huso corra el día.
 */

export const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/** Resta días a una fecha 'yyyy-MM-dd'. Con `dias` negativo, suma. */
export function menosDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  return new Date(d.getTime() - dias * 86400000).toISOString().slice(0, 10);
}

export function masDias(fecha: string, dias: number): string {
  return menosDias(fecha, -dias);
}

export function siguienteDia(fecha: string): string {
  return menosDias(fecha, -1);
}

/** Las fechas entre `desde` y `hasta`, inclusive. Con un tope, por si llega un año mal escrito. */
export function rangoFechas(desde: string, hasta: string, tope = 4000): string[] {
  const out: string[] = [];
  for (let f = desde; f <= hasta && out.length < tope; f = siguienteDia(f)) out.push(f);
  return out;
}

/** Días entre dos fechas, contando las dos. */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T12:00:00Z`) - Date.parse(`${desde}T12:00:00Z`)) / 86400000) + 1;
}

/** Hoy en México, 'yyyy-MM-dd' (el servidor está en UTC). */
export function hoyMexico(ahora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ahora);
}

/** 'HH:mm' → minutos desde medianoche, o null. */
export function minutosDeHHMM(hhmm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(hhmm ?? '').trim());
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

/** Fecha que viene de la base (Date de pg o texto) → 'yyyy-MM-dd'. */
export function aFecha(v: unknown): string {
  if (v instanceof Date) {
    // Respaldo: las consultas de este módulo piden las fechas con `to_char` para no llegar aquí.
    // Una columna `date` puede llegar como medianoche UTC o como medianoche LOCAL según cómo
    // esté configurado el parser de pg; `toISOString` en MX la corre al día anterior (LC.16).
    const utc = v.getUTCHours() === 0 && v.getUTCMinutes() === 0;
    const y = utc ? v.getUTCFullYear() : v.getFullYear();
    const m = (utc ? v.getUTCMonth() : v.getMonth()) + 1;
    const d = utc ? v.getUTCDate() : v.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return String(v ?? '').slice(0, 10);
}
