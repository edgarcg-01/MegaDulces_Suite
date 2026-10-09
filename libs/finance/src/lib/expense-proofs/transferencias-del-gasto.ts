import type { Knex } from 'knex';
import type { TransferenciaGasto } from '@megadulces/contracts';

/**
 * `[GX.75]` — **Las transferencias `XD2601` que pagaron un gasto `XA1001`.**
 *
 * Una sola lectura para dos superficies: la pantalla del Expediente (`expedientePorUsuario`)
 * y el PDF del expediente (`ExpedienteGastoService.expediente`). Dos copias de la consulta se
 * separarían como cualquier otra regla.
 *
 * ## La fuente: `kepler_ods.kdm5` (vista viva del ODS, sin importer)
 * `kdm5` es donde Kepler guarda **qué documento se aplicó a qué documento**. Para egresos:
 *   · `c1` sucursal dueña · `c2='X'` · `c3='D'` · `c4=26` · `c5=1` · `c6` folio → la **transferencia**
 *   · `c8='A'` · `c9=10` · `c10=1` · `c11` folio → el **gasto**
 *   · `c13` cuánto se aplicó
 * El encabezado de la transferencia (`kdm1`) da fecha (`c9`), importe (`c16`) y estado (`c43`).
 * Las dos tablas van en el carril ctid del ODS (`replicate-ods-live`), así que llegan con la
 * misma frescura que el resto del vale.
 *
 * ## ⚠️ El folio es único POR SUCURSAL
 * Se pega por el PAR `(sucursal, folio)`. Cruzar las listas por separado mezclaba folios de una
 * plaza con otra: medido en prod, 188 folios devolvían 583 encabezados.
 *
 * ## ⚠️ Rendimiento, medido en prod (293 gastos del Expediente)
 * Con sólo el `IN (unnest(pares))` el planificador emparejaba por sucursal y filtraba el folio
 * después: **1.4 millones** de comparaciones, ~370 ms. Filtrar ANTES con `= ANY` por sucursal y
 * por folio (superconjunto) y luego exigir el par exacto lo deja en **~25 ms**.
 *
 * ## `btrim(c1) = sucursal`
 * Cada base de sucursal trae réplicas de documentos de otras plazas; la buena es la de su dueña.
 */
export const SQL_TRANSFERENCIAS_DEL_GASTO = `
SELECT m.sucursal,
       btrim(m.c11)                     AS gasto_folio,
       btrim(m.c6)                      AS folio,
       sum(m.c13)::numeric              AS aplicado,
       to_char(max(h.c9), 'YYYY-MM-DD') AS fecha,
       max(h.c16)::numeric              AS importe,
       max(btrim(h.c43))                AS estado
  FROM kepler_ods.kdm5 m
  LEFT JOIN kepler_ods.kdm1 h
    ON h.sucursal = m.sucursal AND h.c1 = m.sucursal AND h.c2 = 'X' AND h.c3 = 'D'
   AND h.c4 = m.c4 AND h.c5 = m.c5 AND h.c6 = m.c6
 WHERE m.sucursal = ANY(?::text[]) AND btrim(m.c11) = ANY(?::text[])
   AND (m.sucursal, btrim(m.c11)) IN (SELECT * FROM unnest(?::text[], ?::text[]))
   AND btrim(m.c1) = m.sucursal
   AND m.c2 = 'X' AND m.c3 = 'D' AND m.c4 = 26 AND m.c5 = 1
   AND m.c8 = 'A' AND m.c9 = 10 AND m.c10 = 1
 GROUP BY 1, 2, 3`;

/** Un renglón tal como lo devuelve `SQL_TRANSFERENCIAS_DEL_GASTO`. */
export interface FilaTransferencia {
  sucursal: string;
  gasto_folio: string;
  folio: string;
  aplicado: number | string | null;
  fecha: string | null;
  importe: number | string | null;
  estado: string | null;
}

export interface ParGasto { sucursal: string | null | undefined; gasto_folio: string | null | undefined }

/** La llave de un gasto: el folio sólo identifica dentro de su sucursal. */
export const llaveGasto = (sucursal: unknown, folio: unknown): string =>
  `${String(sucursal ?? '').trim()}|${String(folio ?? '').trim()}`;

/** Los pares a consultar, sin vacíos y sin repetir. */
export function paresUnicos(pares: readonly ParGasto[]): { sucursal: string; gasto_folio: string }[] {
  const vistos = new Map<string, { sucursal: string; gasto_folio: string }>();
  for (const p of pares) {
    const sucursal = String(p.sucursal ?? '').trim();
    const gasto_folio = String(p.gasto_folio ?? '').trim();
    if (!sucursal || !gasto_folio) continue;
    vistos.set(llaveGasto(sucursal, gasto_folio), { sucursal, gasto_folio });
  }
  return [...vistos.values()];
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/**
 * Agrupa los renglones por gasto. Cada lista va en el orden del pago (fecha, luego folio), y la
 * transferencia cancelada viaja **marcada**: Kepler conserva su aplicación en `kdm5`.
 */
export function agruparTransferencias(filas: readonly FilaTransferencia[]): Map<string, TransferenciaGasto[]> {
  const mapa = new Map<string, TransferenciaGasto[]>();
  for (const f of filas) {
    const k = llaveGasto(f.sucursal, f.gasto_folio);
    const lista = mapa.get(k) ?? [];
    lista.push({
      gasto_folio: String(f.gasto_folio).trim(),
      folio: String(f.folio).trim(),
      fecha: f.fecha || null,
      importe: num(f.importe),
      aplicado: num(f.aplicado) ?? 0,
      cancelada: String(f.estado ?? '').trim() === 'C',
    });
    mapa.set(k, lista);
  }
  for (const lista of mapa.values()) {
    lista.sort((a, b) => String(a.fecha ?? '').localeCompare(String(b.fecha ?? '')) || a.folio.localeCompare(b.folio));
  }
  return mapa;
}

/** Las transferencias de un vale: las de todos sus gastos, en el orden de sus gastos. */
export function transferenciasDelVale(
  sucursal: string | null | undefined,
  gastoFolios: readonly string[],
  mapa: Map<string, TransferenciaGasto[]>,
): TransferenciaGasto[] {
  return gastoFolios.flatMap((g) => mapa.get(llaveGasto(sucursal, g)) ?? []);
}

/**
 * Lee de Kepler las transferencias de esos gastos, en UN viaje.
 *
 * ⛔ Devuelve `null` si el ODS de Kepler no existe en este entorno (base local de desarrollo):
 * un `catch` que devolviera `[]` convertiría «no pude medir» en «nadie pagó».
 */
export async function leerTransferenciasDelGasto(
  trx: Knex | Knex.Transaction,
  pares: readonly ParGasto[],
): Promise<Map<string, TransferenciaGasto[]> | null> {
  const [{ existe }] = await trx.select(trx.raw(
    `(to_regclass('kepler_ods.kdm5') IS NOT NULL AND to_regclass('kepler_ods.kdm1') IS NOT NULL) AS existe`));
  if (existe !== true) return null;
  const unicos = paresUnicos(pares);
  if (!unicos.length) return new Map();
  const sucursales = unicos.map((p) => p.sucursal);
  const folios = unicos.map((p) => p.gasto_folio);
  const res: any = await trx.raw(SQL_TRANSFERENCIAS_DEL_GASTO, [sucursales, folios, sucursales, folios]);
  return agruparTransferencias((res?.rows ?? res ?? []) as FilaTransferencia[]);
}
