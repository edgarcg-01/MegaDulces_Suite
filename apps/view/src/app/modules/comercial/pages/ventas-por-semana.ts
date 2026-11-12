/**
 * `[VEC.42]` La pestaña «Por semana» del desglose de una ruta (`/comercial/ventas-por-ruta`).
 *
 * ── De dónde sale ────────────────────────────────────────────────────────────────────────────
 * Se SUMA de los mismos renglones de «Por día» (`detail.daily`): mismo origen, mismos filtros.
 * Por eso no hay consulta nueva, y la suma de las semanas es la suma de los días, que es el total
 * del encabezado. Un ticket tiene un solo día, así que sumar los tickets de cada día no cuenta
 * dos veces el mismo documento.
 *
 * ── Qué semana ───────────────────────────────────────────────────────────────────────────────
 * ISO: de lunes a domingo, numerada por su jueves (`S45`). Es la misma que usan los reportes
 * semanales del servidor (`libs/commercial/.../weekly-analytics.service.ts`, `isoWeekLabel`).
 * ⚠️ Deuda con nombre: ese cálculo vive privado en el servidor y éste en la pantalla. Si un
 * tercero lo necesita, se sube a `libs/contracts` en vez de copiarlo otra vez.
 *
 * ── Lo que se declara, no se esconde ─────────────────────────────────────────────────────────
 *  · Una semana que el periodo CORTA (`incompleta`) o que todavía no termina (`en_curso`) tiene
 *    menos días: compararla por su venta total contra una semana completa engaña. Se marca, y el
 *    promedio por día con venta es la cifra comparable.
 *  · Una semana SIN venta entre la primera y la última del periodo sale como renglón propio. Si
 *    no saliera, la lista saltaría de S43 a S41 y la semana en que la ruta no vendió no se vería.
 */

export interface DiaDeVenta {
  date: string;
  revenue: number;
  units: number;
  tickets: number;
}

/** El periodo que se consultó: `desde` incluido, `hasta` EXCLUIDO (el mismo tope del endpoint). */
export interface PeriodoConsultado {
  desde: string;
  hasta: string;
}

export type EstadoSemana = 'completa' | 'incompleta' | 'en_curso';

export interface SemanaDeVenta {
  /** Lunes de la semana (YYYY-MM-DD): llave del renglón y de la faceta. */
  lunes: string;
  /** `S45 · 2–8 nov`: la semana completa, aunque el periodo sólo cubra una parte. */
  etiqueta: string;
  /** Días con al menos una venta. 0 = semana sin venta registrada. */
  dias: number;
  tickets: number;
  revenue: number;
  units: number;
  /** Venta / días con venta. null cuando no hubo venta (no se dibuja un cero). */
  promedioDia: number | null;
  estado: EstadoSemana;
  /** Qué días de la semana caen dentro del periodo consultado (`1–4 nov`). */
  cubre: string;
}

export interface VentaPorSemana {
  /** De la más vieja a la más reciente: el mismo orden en que el servidor manda los días de «Por día». */
  semanas: SemanaDeVenta[];
  /** Renglones cuya fecha no se pudo leer. Se cuentan para declararlos, no se pierden callados. */
  sinFecha: number;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIA_MS = 864e5;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

const ms = (dia: string): number => Date.parse(`${dia}T00:00:00Z`);
const dia = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** Lunes de la semana ISO a la que pertenece un día (YYYY-MM-DD). El domingo cierra la semana. */
export function lunesDe(fecha: string): string {
  const t = ms(fecha);
  const desdeLunes = (new Date(t).getUTCDay() + 6) % 7;
  return dia(t - desdeLunes * DIA_MS);
}

/** Número de semana ISO: se numera por su jueves, así que el 1-ene-2026 (jueves) cae en la S01. */
export function numeroSemana(lunes: string): number {
  const jueves = ms(lunes) + 3 * DIA_MS;
  const primeroDeEnero = Date.UTC(new Date(jueves).getUTCFullYear(), 0, 1);
  return Math.floor((jueves - primeroDeEnero) / DIA_MS / 7) + 1;
}

/** `2–8 nov` o, si cruza de mes, `26 oct–1 nov`. Un solo día: `1 nov`. */
function rango(ini: string, fin: string): string {
  const a = new Date(ms(ini));
  const b = new Date(ms(fin));
  if (ini === fin) return `${a.getUTCDate()} ${MESES[a.getUTCMonth()]}`;
  if (a.getUTCMonth() === b.getUTCMonth()) {
    return `${a.getUTCDate()}–${b.getUTCDate()} ${MESES[b.getUTCMonth()]}`;
  }
  return `${a.getUTCDate()} ${MESES[a.getUTCMonth()]}–${b.getUTCDate()} ${MESES[b.getUTCMonth()]}`;
}

/** `S45 · 2–8 nov`. */
export function etiquetaSemana(lunes: string): string {
  const domingo = dia(ms(lunes) + 6 * DIA_MS);
  return `S${String(numeroSemana(lunes)).padStart(2, '0')} · ${rango(lunes, domingo)}`;
}

/**
 * Agrupa la venta diaria por semana ISO.
 *
 * @param hoy fecha de hoy en México (YYYY-MM-DD): marca la semana `en_curso`.
 */
export function agruparPorSemana(
  dias: readonly DiaDeVenta[],
  periodo: PeriodoConsultado,
  hoy: string,
): VentaPorSemana {
  const acum = new Map<string, { dias: number; tickets: number; revenue: number; units: number }>();
  let sinFecha = 0;
  for (const d of dias) {
    if (!FECHA.test(d.date) || Number.isNaN(ms(d.date))) {
      sinFecha += 1;
      continue;
    }
    const lunes = lunesDe(d.date);
    const a = acum.get(lunes) ?? { dias: 0, tickets: 0, revenue: 0, units: 0 };
    a.dias += 1;
    a.tickets += Number(d.tickets) || 0;
    a.revenue += Number(d.revenue) || 0;
    a.units += Number(d.units) || 0;
    acum.set(lunes, a);
  }
  if (!acum.size) return { semanas: [], sinFecha };

  const lunesConVenta = [...acum.keys()].sort();
  const primera = ms(lunesConVenta[0]);
  const ultima = ms(lunesConVenta[lunesConVenta.length - 1]);
  const ultimoDiaDelPeriodo = dia(ms(periodo.hasta) - DIA_MS);

  const semanas: SemanaDeVenta[] = [];
  for (let t = primera; t <= ultima; t += 7 * DIA_MS) {
    const lunes = dia(t);
    const domingo = dia(t + 6 * DIA_MS);
    const a = acum.get(lunes) ?? { dias: 0, tickets: 0, revenue: 0, units: 0 };
    const cortada = lunes < periodo.desde || domingo > ultimoDiaDelPeriodo;
    // ⛔ El corte del periodo manda sobre «en curso»: aunque la semana termine, el panel no va
    // a contar los días que quedan fuera del periodo.
    const estado: EstadoSemana = cortada ? 'incompleta' : lunes <= hoy && hoy <= domingo ? 'en_curso' : 'completa';
    const desde = lunes < periodo.desde ? periodo.desde : lunes;
    const hasta = domingo > ultimoDiaDelPeriodo ? ultimoDiaDelPeriodo : domingo;
    semanas.push({
      lunes,
      etiqueta: etiquetaSemana(lunes),
      dias: a.dias,
      tickets: a.tickets,
      revenue: a.revenue,
      units: a.units,
      promedioDia: a.dias > 0 ? a.revenue / a.dias : null,
      estado,
      cubre: rango(desde, hasta),
    });
  }
  return { semanas, sinFecha };
}
