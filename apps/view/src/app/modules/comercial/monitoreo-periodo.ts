/**
 * `[MV.3]` Los periodos del Monitoreo vecinal: atajos y rango, en días de México (`AAAA-MM-DD`).
 *
 * ⚠️ La catorcena se ancla en el sábado 2026-10-17, la MISMA que usa el servidor para la meta
 * (`CATORCENA_ANCLA`, supervisor-board.engine.ts). Una catorcena distinta aquí haría que «Esta
 * catorcena» y la meta midieran periodos distintos.
 */
export const CATORCENA_ANCLA = '2026-10-17';
/** El servidor acepta hasta 92 días; la pantalla no ofrece más. */
export const MAX_DIAS = 92;

export type AtajoPeriodo = 'hoy' | 'ayer' | 'semana' | 'catorcena' | 'mes' | 'mes_anterior' | 'ultimos_30';

export interface Periodo { from: string; to: string }

const DIA = 86_400_000;
const aFecha = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const aYmd = (d: Date) => d.toISOString().slice(0, 10);
export const sumarDias = (ymd: string, n: number): string => aYmd(new Date(aFecha(ymd).getTime() + n * DIA));
export const diasEntre = (a: string, b: string): number => Math.round((aFecha(b).getTime() - aFecha(a).getTime()) / DIA);

/** Días con actividad (lunes a sábado), mínimo 1: el promedio por día nunca divide entre cero. */
export function diasConActividad(from: string, to: string): number {
  let n = 0;
  for (let f = from; f <= to; f = sumarDias(f, 1)) if (aFecha(f).getUTCDay() !== 0) n++;
  return Math.max(n, 1);
}

/** El inicio (sábado) de la catorcena que contiene la fecha. */
export function inicioCatorcena(ymd: string, ancla = CATORCENA_ANCLA): string {
  const d = diasEntre(ancla, ymd);
  return sumarDias(ancla, Math.floor(d / 14) * 14);
}

/** El rango de un atajo, visto desde `hoy`. Nunca termina después de hoy. */
export function rangoDe(atajo: AtajoPeriodo, hoy: string): Periodo {
  const d = aFecha(hoy);
  switch (atajo) {
    case 'hoy': return { from: hoy, to: hoy };
    case 'ayer': { const a = sumarDias(hoy, -1); return { from: a, to: a }; }
    case 'semana': { const dow = (d.getUTCDay() + 6) % 7; return { from: sumarDias(hoy, -dow), to: hoy }; } // lunes → hoy
    case 'catorcena': return { from: inicioCatorcena(hoy), to: hoy };
    case 'mes': return { from: hoy.slice(0, 8) + '01', to: hoy };
    case 'mes_anterior': {
      const ini = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, 12));
      const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0, 12));
      return { from: aYmd(ini), to: aYmd(fin) };
    }
    case 'ultimos_30': return { from: sumarDias(hoy, -29), to: hoy };
  }
}

/** Un rango elegido en el calendario, recortado a hoy y a `MAX_DIAS`. `null` si no es válido. */
export function rangoValido(a: string | null, b: string | null, hoy: string): Periodo | null {
  if (!a) return null;
  let from = a;
  let to = b ?? a;
  if (to < from) [from, to] = [to, from];
  if (to > hoy) to = hoy;
  if (from > to) return null;
  if (diasEntre(from, to) + 1 > MAX_DIAS) from = sumarDias(to, -(MAX_DIAS - 1));
  return { from, to };
}

const mesCorto = new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', timeZone: 'UTC' });
const conDia = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
const limpio = (s: string) => s.replace(/\./g, '').replace(',', '').replace(/-/g, ' ');

/** «jue 05 nov» o «31 oct – 05 nov». */
export function etiquetaPeriodo(p: Periodo): string {
  return p.from === p.to ? limpio(conDia.format(aFecha(p.from))) : `${limpio(mesCorto.format(aFecha(p.from)))} – ${limpio(mesCorto.format(aFecha(p.to)))}`;
}
