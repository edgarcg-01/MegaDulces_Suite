/**
 * `[BFU.7.6]` **La cobertura del motor de categoría, para la API**: de los renglones de la descarga del banco de un
 * periodo, cuántos tienen categoría y, de los que no, **por qué y de quién** — y que las partes sumen el total.
 *
 * El motor guarda el motivo al correr (`category_reason`); «Kepler todavía no lo tiene» depende del DÍA, así que se
 * recalcula al leer: pasado el plazo de captura (`PLAZO_DE_CAPTURA` días hábiles) pasa a «Kepler no lo tiene» y al
 * área, aunque el motor no haya vuelto a correr.
 *
 * Un renglón sin categoría y SIN motivo (lo puso una persona sin categoría, o el motor todavía no lo evaluó) no se
 * esconde ni se reparte: va aparte, en `sin_motivo`.
 */
import { diasHabiles, PLAZO_DE_CAPTURA, RESPONSABLE, type MotivoSinCategoria, type Responsable } from './motor-de-categoria';

/** Un grupo leído de la base: renglones del mismo estado, motivo, responsable y día. */
export interface FilaDeCobertura {
  con_categoria: boolean;
  motivo: string | null;
  responsable: string | null;
  /** `YYYY-MM-DD` del movimiento (`null` si no tiene: entonces no se recalcula). */
  fecha: string | null;
  n: number | string;
  monto: number | string | null;
}

export interface PorResolver { motivo: MotivoSinCategoria | string; responsable: Responsable | string; n: number; monto: number }

export interface CoberturaDeCategoria {
  /** Renglones de la descarga del banco en el periodo (el universo del motor). */
  evaluados: number;
  con_categoria: { n: number; monto: number };
  /** Sin categoría, por motivo y responsable; el de más dinero primero. */
  por_resolver: PorResolver[];
  /** Sin categoría y sin motivo: no lo decidió el motor. Se declara aparte. */
  sin_motivo: { n: number; monto: number };
  /**
   * Los renglones agrupados contra un conteo INDEPENDIENTE del universo (otra consulta). Si no casan, el agrupado
   * perdió renglones (una fecha nula, un JOIN de más). `null` = no se midió.
   */
  suma_cuadra: boolean | null;
  /** Cuántos «todavía no» ya pasaron el plazo al leer (y por eso se cuentan como «no lo tiene»). */
  vencidos_al_leer: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export function coberturaDeCategoria(filas: readonly FilaDeCobertura[], hoy: string, totalIndependiente?: number | null): CoberturaDeCategoria {
  let evaluados = 0, vencidos = 0;
  const con = { n: 0, monto: 0 }, sinMotivo = { n: 0, monto: 0 };
  const grupos = new Map<string, PorResolver>();
  for (const f of filas) {
    const n = Number(f.n || 0), monto = Number(f.monto || 0);
    evaluados += n;
    if (f.con_categoria) { con.n += n; con.monto += monto; continue; }
    if (!f.motivo) { sinMotivo.n += n; sinMotivo.monto += monto; continue; }
    let motivo = f.motivo, responsable = f.responsable || RESPONSABLE[motivo as MotivoSinCategoria] || 'sistemas';
    if (motivo === 'kepler_aun_no_lo_tiene' && f.fecha && diasHabiles(f.fecha, hoy) > PLAZO_DE_CAPTURA) {
      motivo = 'kepler_no_lo_tiene'; responsable = RESPONSABLE.kepler_no_lo_tiene; vencidos += n;
    }
    const k = `${motivo}|${responsable}`;
    const g = grupos.get(k) ?? { motivo, responsable, n: 0, monto: 0 };
    g.n += n; g.monto += monto; grupos.set(k, g);
  }
  const por_resolver = Array.from(grupos.values()).map((g) => ({ ...g, monto: r2(g.monto) }))
    .sort((a, b) => b.monto - a.monto || b.n - a.n);
  return {
    evaluados,
    con_categoria: { n: con.n, monto: r2(con.monto) },
    por_resolver,
    sin_motivo: { n: sinMotivo.n, monto: r2(sinMotivo.monto) },
    suma_cuadra: totalIndependiente == null ? null : Number(totalIndependiente) === evaluados,
    vencidos_al_leer: vencidos,
  };
}
