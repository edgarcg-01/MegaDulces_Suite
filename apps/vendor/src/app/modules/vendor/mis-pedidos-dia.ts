/**
 * `[MCP.20]` «Pedidos» por día: los días que se ofrecen arriba de la lista y cómo se nombran.
 * Puro (sin Angular): se prueba solo en `mis-pedidos-dia.spec.ts`.
 *
 * Por qué por día: medido en prod el 2026-11-11, sin día una vendedora tenía 145 pedidos en la lista
 * (72 de hace más de 7 días, el más viejo del 26 de agosto), porque casi ningún pedido llega a
 * «entregado» y la lista mostraba todo lo agendado de cualquier fecha.
 */

/** Cuántos días se ofrecen sin abrir el calendario (hoy y los 6 anteriores: una semana). */
export const DIAS_A_LA_MANO = 7;

/** `YYYY-MM-DD` de hoy en México (el día del vendedor, no el del celular en UTC). */
export function hoyMx(ahora: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ahora);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** Suma (o resta) días a un `YYYY-MM-DD`, sin husos: se cuenta en UTC a mediodía. */
export function sumarDias(fecha: string, n: number): string {
  const [y, m, d] = fecha.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** ¿Es un `YYYY-MM-DD` que existe? (El calendario del celular puede mandar vacío.) */
export function esDia(v: string | null | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const corto = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
const largo = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const conMes = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const aUtc = (f: string) => { const [y, m, d] = f.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
/** Intl dice «mié 28 de oct.» y «lunes, 9 de noviembre»: en un botón sobran el punto y la coma. */
const limpio = (s: string) => s.replace(/\./g, '').replace(',', '');

/** Nombre corto del día para su botón: «Hoy», «Ayer», «lun 9»; fuera de la semana, «mar 28 oct». */
export function nombreCorto(fecha: string, hoy: string): string {
  if (fecha === hoy) return 'Hoy';
  if (fecha === sumarDias(hoy, -1)) return 'Ayer';
  const dentro = fecha > sumarDias(hoy, -DIAS_A_LA_MANO);
  return dentro ? limpio(corto.format(aUtc(fecha))) : limpio(conMes.format(aUtc(fecha))).replace(' de ', ' ');
}

/** Nombre completo para el título: «hoy», «ayer» o «el lunes 9 de noviembre». */
export function nombreLargo(fecha: string, hoy: string): string {
  if (fecha === hoy) return 'hoy';
  if (fecha === sumarDias(hoy, -1)) return 'ayer';
  return `el ${limpio(largo.format(aUtc(fecha)))}`;
}

export interface DiaOfrecido {
  fecha: string;
  texto: string;
  /** Hay un reporte de surtido que no ha visto de un pedido levantado ese día. */
  nuevo: boolean;
}

/**
 * Los días a la mano: hoy y los 6 anteriores, del más nuevo al más viejo. Si el elegido es más viejo
 * (salió del calendario), se agrega al final para que se vea cuál es.
 */
export function diasALaMano(hoy: string, elegido: string, sinVer: readonly string[] = []): DiaOfrecido[] {
  const nuevos = new Set(sinVer);
  const fechas = Array.from({ length: DIAS_A_LA_MANO }, (_, i) => sumarDias(hoy, -i));
  if (esDia(elegido) && elegido <= hoy && !fechas.includes(elegido)) fechas.push(elegido);
  return fechas.map((fecha) => ({ fecha, texto: nombreCorto(fecha, hoy), nuevo: nuevos.has(fecha) }));
}

/** Días con reportes nuevos que NO están a la mano (más viejos que la semana): se avisan aparte. */
export function sinVerFuera(hoy: string, sinVer: readonly string[] = []): string[] {
  const limite = sumarDias(hoy, -DIAS_A_LA_MANO);
  return [...new Set(sinVer)].filter((f) => esDia(f) && f <= limite).sort().reverse();
}
