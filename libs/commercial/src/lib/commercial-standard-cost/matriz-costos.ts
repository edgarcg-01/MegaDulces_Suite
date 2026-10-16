import type { CeldaMatrizCostos, FuenteCostoKepler, VeredictoMatrizCostos } from '@megadulces/contracts';
import { clasificarEntreSucursales } from './entre-sucursales';

/**
 * `[CAT-COSTO.10]` — **Una fila de la matriz de costos**: el costo de un producto en cada almacén ese
 * día, comparado contra la mayoría.
 *
 * NO reimplementa la comparación: usa `clasificarEntreSucursales` (la regla de «Entre sucursales»:
 * mayoría a centavos, ±0.5 %, y se declaran `sin_mayoria`, `unidad_distinta` y `una_plaza`). Lo único
 * que agrega es la **coincidencia**: qué parte de los almacenes comparados tiene el costo de la mayoría.
 */
export interface CeldaCruda {
  sucursal: string;
  costo: number;
  desde: string;
  fuente: FuenteCostoKepler;
  referencia: string | null;
  unidad: string | null;
  /** Vendió en 30 días (sólo cuenta si se pide comparar únicamente almacenes con venta). */
  vende: boolean;
}

export interface FilaMatriz {
  celdas: CeldaMatrizCostos[];
  mayoria: number | null;
  coincidencia_pct: number | null;
  diferencia_pct: number | null;
  veredicto: VeredictoMatrizCostos;
}

export function filaMatriz(celdas: CeldaCruda[], opts: { soloConVenta?: boolean } = {}): FilaMatriz {
  const r = clasificarEntreSucursales(
    celdas.map((c) => ({ sucursal: c.sucursal, costo: c.costo, unidad: c.unidad, vende: c.vende })),
    { soloConVenta: opts.soloConVenta },
  );
  const porSucursal = new Map(r.celdas.map((c) => [c.sucursal, c]));
  const comparadas = r.celdas.filter((c) => c.comparada && c.fuera !== null);
  const coincidencia_pct = r.mayoria !== null && comparadas.length
    ? Math.round((1000 * comparadas.filter((c) => !c.fuera).length) / comparadas.length) / 10
    : null;
  return {
    celdas: celdas
      .filter((c) => Number.isFinite(c.costo) && c.costo > 0)
      .map((c) => {
        const k = porSucursal.get(c.sucursal);
        return {
          sucursal: c.sucursal,
          costo: c.costo,
          desde: c.desde,
          fuente: c.fuente,
          referencia: c.referencia,
          unidad: c.unidad,
          fuera: k?.fuera ?? null,
          desviacion_pct: k?.desviacion_pct ?? null,
        };
      }),
    mayoria: r.mayoria,
    coincidencia_pct,
    diferencia_pct: r.diferencia_pct,
    veredicto: r.veredicto,
  };
}
