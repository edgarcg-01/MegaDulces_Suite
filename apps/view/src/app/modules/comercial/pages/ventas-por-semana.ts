/**
 * `[VEC.42]`/`[VEC.43]` El calendario de venta del desglose de una ruta (`/comercial/ventas-por-ruta`): una
 * fila por semana (lunes a domingo), un cuadro por día y el total de la semana al final.
 *
 * ── De dónde sale ────────────────────────────────────────────────────────────────────────────
 * Se arma con los mismos renglones de «Por día» (`detail.daily`): mismo origen, mismos filtros.
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
 * ── Qué semanas salen ────────────────────────────────────────────────────────────────────────
 * Todas las del periodo, desde la que contiene su primer día hasta la de su último día —o la de
 * hoy, si el periodo todavía no termina—. Las semanas que aún no empiezan no salen.
 *
 * ── Lo que se declara, no se esconde ─────────────────────────────────────────────────────────
 *  · Un día del periodo que ya pasó y no tiene venta dice «sin venta»; uno fuera del periodo, o
 *    cuya venta todavía no llega (hoy incluido), NO se dibuja como cero: tiene su propio estado.
 *  · Una semana que el periodo CORTA (`incompleta`) o que todavía no termina (`en_curso`) tiene
 *    menos días: compararla por su venta total contra una semana completa engaña. Se marca, y el
 *    promedio por día con venta es la cifra comparable.
 *  · El tono de cada día es relativo al MEJOR día del periodo, y ese día se nombra en la leyenda.
 *    La cifra se ve siempre: el color nunca es el único portador del dato.
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

/**
 * `venta`: hay renglón de venta ese día · `sin_venta`: el día está en el periodo, ya pasó y no
 * hay venta · `fuera`: el periodo no lo cubre · `futuro`: su venta todavía no llega — los días
 * que vienen y TAMBIÉN HOY: la venta de ruta llega al día siguiente (D+1), así que un hoy sin
 * renglón no es «no vendió», es «todavía no se sabe».
 */
export type EstadoDia = 'venta' | 'sin_venta' | 'fuera' | 'futuro';

export interface CeldaDia {
  fecha: string;
  /** Día del mes, para ubicarse en el calendario. */
  dia: number;
  /** `lunes 2 nov`: para el lector de pantalla y el título del cuadro. */
  nombre: string;
  estado: EstadoDia;
  revenue: number;
  tickets: number;
  /** 0 = sin tono · 1 a 4 = de menos a más venta, relativo al mejor día del periodo. */
  nivel: 0 | 1 | 2 | 3 | 4;
}

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
  /** Los 7 días, de lunes a domingo. */
  celdas: CeldaDia[];
}

export interface VentaPorSemana {
  /** De la más vieja a la más reciente: el mismo orden en que el servidor manda los días de «Por día». */
  semanas: SemanaDeVenta[];
  /** El día de más venta del periodo: la referencia del tono más intenso. */
  mejorDia: { fecha: string; nombre: string; revenue: number } | null;
  /** Renglones cuya fecha no se pudo leer. Se cuentan para declararlos, no se pierden callados. */
  sinFecha: number;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
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

/** `lunes 2 nov`. */
function nombreDia(fecha: string): string {
  const d = new Date(ms(fecha));
  return `${DIAS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
}

/** Tono de 1 a 4 relativo al mejor día; 0 si no hubo venta positiva. */
function nivelDe(revenue: number, max: number): CeldaDia['nivel'] {
  if (!(revenue > 0) || !(max > 0)) return 0;
  return Math.min(4, Math.max(1, Math.ceil((revenue / max) * 4))) as CeldaDia['nivel'];
}

/**
 * Arma el calendario de venta por semana ISO.
 *
 * @param hoy fecha de hoy en México (YYYY-MM-DD): marca la semana `en_curso` y los días `futuro`.
 */
export function agruparPorSemana(
  dias: readonly DiaDeVenta[],
  periodo: PeriodoConsultado,
  hoy: string,
): VentaPorSemana {
  // Un renglón por fecha: si la fuente repitiera un día, se suma, no se pisa.
  const porDia = new Map<string, { tickets: number; revenue: number; units: number }>();
  let sinFecha = 0;
  for (const d of dias) {
    if (!FECHA.test(d.date) || Number.isNaN(ms(d.date))) {
      sinFecha += 1;
      continue;
    }
    const a = porDia.get(d.date) ?? { tickets: 0, revenue: 0, units: 0 };
    a.tickets += Number(d.tickets) || 0;
    a.revenue += Number(d.revenue) || 0;
    a.units += Number(d.units) || 0;
    porDia.set(d.date, a);
  }
  if (!porDia.size) return { semanas: [], mejorDia: null, sinFecha };

  const ultimoDiaDelPeriodo = dia(ms(periodo.hasta) - DIA_MS);
  const finVisible = hoy < ultimoDiaDelPeriodo ? hoy : ultimoDiaDelPeriodo;
  const fechas = [...porDia.keys()].sort();
  // Del inicio del periodo a hoy (o a su fin); si hubiera venta fuera de eso, se estira para
  // incluirla: un dato nunca se queda sin cuadro.
  const primera = Math.min(ms(lunesDe(periodo.desde)), ms(lunesDe(fechas[0])));
  const ultima = Math.max(
    finVisible >= periodo.desde ? ms(lunesDe(finVisible)) : -Infinity,
    ms(lunesDe(fechas[fechas.length - 1])),
  );

  let mejorDia: VentaPorSemana['mejorDia'] = null;
  for (const [fecha, a] of porDia) {
    if (a.revenue > 0 && (!mejorDia || a.revenue > mejorDia.revenue)) {
      mejorDia = { fecha, nombre: nombreDia(fecha), revenue: a.revenue };
    }
  }
  const max = mejorDia?.revenue ?? 0;

  const semanas: SemanaDeVenta[] = [];
  for (let t = primera; t <= ultima; t += 7 * DIA_MS) {
    const lunes = dia(t);
    const domingo = dia(t + 6 * DIA_MS);
    const celdas: CeldaDia[] = [];
    let diasConVenta = 0;
    let tickets = 0;
    let revenue = 0;
    let units = 0;
    for (let i = 0; i < 7; i++) {
      const fecha = dia(t + i * DIA_MS);
      const v = porDia.get(fecha);
      const estado: EstadoDia = v
        ? 'venta'
        : fecha < periodo.desde || fecha > ultimoDiaDelPeriodo
          ? 'fuera'
          : fecha >= hoy
            ? 'futuro'
            : 'sin_venta';
      if (v) {
        diasConVenta += 1;
        tickets += v.tickets;
        revenue += v.revenue;
        units += v.units;
      }
      celdas.push({
        fecha,
        dia: new Date(ms(fecha)).getUTCDate(),
        nombre: nombreDia(fecha),
        estado,
        revenue: v?.revenue ?? 0,
        tickets: v?.tickets ?? 0,
        nivel: v ? nivelDe(v.revenue, max) : 0,
      });
    }
    const cortada = lunes < periodo.desde || domingo > ultimoDiaDelPeriodo;
    // ⛔ El corte del periodo manda sobre «en curso»: aunque la semana termine, el panel no va
    // a contar los días que quedan fuera del periodo.
    const estado: EstadoSemana = cortada ? 'incompleta' : lunes <= hoy && hoy <= domingo ? 'en_curso' : 'completa';
    const desde = lunes < periodo.desde ? periodo.desde : lunes;
    const hasta = domingo > ultimoDiaDelPeriodo ? ultimoDiaDelPeriodo : domingo;
    semanas.push({
      lunes,
      etiqueta: etiquetaSemana(lunes),
      dias: diasConVenta,
      tickets,
      revenue,
      units,
      promedioDia: diasConVenta > 0 ? revenue / diasConVenta : null,
      estado,
      cubre: rango(desde, hasta),
      celdas,
    });
  }
  return { semanas, mejorDia, sinFecha };
}
