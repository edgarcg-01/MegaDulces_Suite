import type { IncomeChannel, IncomeForecastCell, IncomeForecastDay } from '@megadulces/contracts';

/**
 * `[PU.13]` La lógica de la pantalla de ingresos, pura y probada aparte (la pantalla sólo pinta).
 *
 * «Proyectado» = lo REAL si ese día ya está cargado; si no, el ESTIMADO. Así el mes en curso suma lo
 * que ya entró más lo que falta, y conforme Tesorería carga estados de cuenta el número se corrige
 * solo. Si un día no tiene ni real ni estimado queda `null` (no se dibuja como cero).
 */

export const CANALES: IncomeChannel[] = ['bancos', 'caja_general'];

export type Origen = 'real' | 'estimado' | 'sin_dato';

export function proyectado(c: IncomeForecastCell): number | null {
  if (c.real !== null) return Number(c.real);
  if (c.estimado !== null) return Number(c.estimado);
  return null;
}

export function origen(c: IncomeForecastCell): Origen {
  if (c.real !== null) return 'real';
  if (c.estimado !== null) return 'estimado';
  return 'sin_dato';
}

const suma = (xs: Array<number | null>): number | null => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

export interface SemanaFila {
  clave: string;
  etiqueta: string;
  desde: string;
  hasta: string;
  /** Índice 0 = lunes … 6 = domingo. `null` = ese día cae fuera del periodo. */
  dias: Array<IncomeForecastDay | null>;
  total: Record<IncomeChannel, number | null>;
  totalAmbos: number | null;
}

export function semanas(dias: IncomeForecastDay[]): SemanaFila[] {
  const out: SemanaFila[] = [];
  for (const d of dias) {
    const clave = `${d.semana_anio}-${String(d.semana).padStart(2, '0')}`;
    let s = out.find((x) => x.clave === clave);
    if (!s) {
      s = { clave, etiqueta: `semana ${d.semana}`, desde: d.fecha, hasta: d.fecha, dias: Array(7).fill(null),
        total: { bancos: null, caja_general: null }, totalAmbos: null };
      out.push(s);
    }
    s.dias[d.dia_semana - 1] = d;
    s.hasta = d.fecha;
  }
  for (const s of out) {
    const presentes = s.dias.filter((d): d is IncomeForecastDay => d !== null);
    for (const c of CANALES) s.total[c] = suma(presentes.map((d) => proyectado(d[c])));
    s.totalAmbos = suma([s.total.bancos, s.total.caja_general]);
  }
  return out;
}

export interface MesCanal {
  /** Lo que ya entró (días cargados). */
  real: number | null;
  /** Lo estimado para los días que todavía no están cargados. */
  porEntrar: number | null;
  /** real + porEntrar. */
  proyectado: number | null;
  /** Días con real Y estimado: cuánto se desvió lo real de lo estimado. `null` = todavía no hay con qué. */
  desvio: { real: number; estimado: number; pct: number } | null;
}

export interface MesFila {
  mes: string;
  etiqueta: string;
  canal: Record<IncomeChannel, MesCanal>;
  total: number | null;
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function meses(dias: IncomeForecastDay[]): MesFila[] {
  const claves = [...new Set(dias.map((d) => d.fecha.slice(0, 7)))];
  return claves.map((mes) => {
    const del = dias.filter((d) => d.fecha.startsWith(mes));
    const canal = {} as Record<IncomeChannel, MesCanal>;
    for (const c of CANALES) {
      const real = suma(del.map((d) => d[c].real));
      const porEntrar = suma(del.filter((d) => d[c].real === null).map((d) => d[c].estimado));
      const ambos = del.filter((d) => d[c].real !== null && d[c].estimado !== null);
      const r = ambos.reduce((a, d) => a + Number(d[c].real), 0);
      const e = ambos.reduce((a, d) => a + Number(d[c].estimado), 0);
      canal[c] = {
        real, porEntrar, proyectado: suma([real, porEntrar]),
        desvio: ambos.length && e > 0 ? { real: r, estimado: e, pct: ((r - e) / e) * 100 } : null,
      };
    }
    return { mes, etiqueta: MESES[Number(mes.slice(5, 7)) - 1], canal,
      total: suma([canal.bancos.proyectado, canal.caja_general.proyectado]) };
  });
}

/** Lo que falta por entrar en todo el periodo (sólo días sin cargar). */
export function porEntrar(dias: IncomeForecastDay[]): number | null {
  return suma(dias.flatMap((d) => CANALES.map((c) => (d[c].real === null ? d[c].estimado : null))));
}
