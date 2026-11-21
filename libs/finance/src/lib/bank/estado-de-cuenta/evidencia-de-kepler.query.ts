import type { Knex } from 'knex';
import type { RenglonDeKepler } from './cuenta-de-kepler';

/**
 * `[BFU.7.2]` **La evidencia de Kepler de cada retiro: qué documentos liquida y con qué cuentas** (motor de categoría, E7).
 *
 * Dos rutas al MISMO documento de Kepler (`kdxe`, el que sube la deuda con el acreedor):
 *  - **pareo**: el pago `X-D-25/26/60` que la conciliación casó → `kdxf` (cargo aplicado al abono) → el documento;
 *  - **calendario**: el pago del Calendario ligado al retiro → sus renglones `kepler_payable` → el documento.
 * El documento es una entrada de compra (tipo 20 → cuenta 511) o un gasto (tipo 10 → sus renglones en `kdm6`: cuenta
 * `c8`, importe `c11`, departamento `c16`). Si las dos rutas llegan, manda el pareo.
 *
 * Medido en prod el 2026-11-20: todos los retiros de noviembre (2,569 renglones de Kepler) en 362 ms. ⛔ Las tablas del
 * ODS se leen UNA vez, materializadas y ya recortadas (`btrim` en la proyección, no en el JOIN): con `btrim` en el JOIN
 * el plan hacía bucles anidados y pasaba de 5 minutos.
 *
 * Sin `kepler_ods` (CI, desarrollo sin ODS) devuelve vacío y lo dice (`hay_ods: false`): el motor declara el motivo
 * «sin ODS», no inventa que no hay documento.
 */

/**
 * La llave de un documento de Kepler en el Calendario (`obligation_source = 'kepler_payable'`). ⛔ Es la MISMA expresión
 * que `sqlKeplerPayableId` de `@megadulces/contracts/finance/kepler-payable-key`: no se importa porque las pruebas
 * contra base real cargan este módulo con stubs del paquete; `evidencia-de-kepler.query.spec.ts` exige que sean iguales.
 */
export const sqlLlaveKeplerPayable = (a: string): string =>
  `md5('kepler_payable|'||${a}.sucursal||'|'||${a}.doc_tipo||'|'||${a}.doc_sub||'|'||${a}.folio)::uuid`;

export interface EvidenciaDeKepler {
  ruta: 'pareo' | 'calendario';
  /** El pase de la conciliación del pago (`motor-tes`, `motor-tes-tol`…); `null` en la ruta del Calendario. */
  pase: string | null;
  /** Los documentos liquidados, `tipo-sub-folio@sucursal`. */
  documentos: string[];
  renglones: RenglonDeKepler[];
}

export async function hayOds(trx: Knex | Knex.Transaction): Promise<boolean> {
  return !!(await trx.raw(`select to_regclass('kepler_ods.kdxf') is not null and to_regclass('kepler_ods.kdm6') is not null
    and to_regclass('kepler_ods.kdxe') is not null as ok`)).rows[0]?.ok;
}

export async function leerEvidenciaDeKepler(trx: Knex | Knex.Transaction, movimientos: readonly string[]): Promise<{ hay_ods: boolean; evidencia: Map<string, EvidenciaDeKepler> }> {
  const evidencia = new Map<string, EvidenciaDeKepler>();
  if (!movimientos.length) return { hay_ods: true, evidencia };
  if (!(await hayOds(trx))) return { hay_ods: false, evidencia };
  const filas = (await trx.raw(`
    WITH mov AS (SELECT unnest(?::uuid[]) AS id),
    xf AS MATERIALIZED (SELECT sucursal, c4, btrim(c6) AS c6, c7, c8, btrim(c9) AS c9, c10 FROM kepler_ods.kdxf WHERE c4 IN (25, 26, 60)),
    x6 AS MATERIALIZED (SELECT sucursal, c5, btrim(c6) AS c6, btrim(c8) AS c8, c11, btrim(c16) AS c16
                          FROM kepler_ods.kdm6 WHERE c2 = 'X' AND c3 = 'A' AND c4 = 10),
    pagos AS (
      SELECT r.bank_movement_id AS id, r.kepler_sucursal AS suc, split_part(r.kepler_doc_tipo, '-', 3)::numeric AS t,
             btrim(r.kepler_doc_folio) AS folio, r.matched_by AS pase
        FROM finance.bank_recon_matches r JOIN mov ON mov.id = r.bank_movement_id
       WHERE r.kepler_doc_tipo ~ '^X-D-[0-9]+$'),
    aplA AS (
      SELECT p.id, 'pareo'::text AS ruta, p.pase, f.sucursal AS suc, f.c7 AS t, f.c8 AS s, f.c9 AS folio, f.c10 AS imp
        FROM pagos p JOIN xf f ON f.sucursal = p.suc AND f.c4 = p.t AND f.c6 = p.folio),
    items AS (
      SELECT pa.paid_bank_movement_id AS id, i.obligation_id AS oid, (i.applied_amount + coalesce(i.discount_amount, 0)) AS imp
        FROM finance.payment_allocations pa JOIN mov ON mov.id = pa.paid_bank_movement_id
        JOIN finance.payment_allocation_items i ON i.allocation_id = pa.id AND i.obligation_source = 'kepler_payable'
       WHERE NOT EXISTS (SELECT 1 FROM aplA WHERE aplA.id = pa.paid_bank_movement_id)),
    kx AS MATERIALIZED (
      SELECT d.sucursal, d.doc_tipo AS t, d.doc_sub AS s, d.folio, ${sqlLlaveKeplerPayable('d')} AS oid
        FROM (SELECT x.sucursal, x.c4 AS doc_tipo, x.c5 AS doc_sub, btrim(x.c6) AS folio
                FROM kepler_ods.kdxe x WHERE btrim(x.c1) = x.sucursal AND x.c3 = 'A') d
       WHERE EXISTS (SELECT 1 FROM items)),
    aplB AS (
      SELECT items.id, 'calendario'::text AS ruta, NULL::text AS pase, kx.sucursal AS suc, kx.t, kx.s, kx.folio, items.imp
        FROM items JOIN kx ON kx.oid = items.oid),
    apl AS (SELECT * FROM aplA UNION ALL SELECT * FROM aplB)
    SELECT apl.id::text AS id, apl.ruta, apl.pase, apl.t::int AS t, apl.s::int AS s, apl.folio, apl.suc,
           CASE WHEN apl.t = 20 THEN '511' ELSE k.c8 END AS cuenta,
           (CASE WHEN apl.t = 20 THEN apl.imp ELSE k.c11 END)::float8 AS imp,
           k.c16 AS departamento
      FROM apl LEFT JOIN x6 k ON apl.t = 10 AND k.sucursal = apl.suc AND k.c5 = apl.s AND k.c6 = apl.folio`,
  [Array.from(movimientos)])).rows as { id: string; ruta: 'pareo' | 'calendario'; pase: string | null; t: number; s: number; folio: string; suc: string;
    cuenta: string | null; imp: number | null; departamento: string | null }[];
  for (const f of filas) {
    const e = evidencia.get(f.id) ?? { ruta: f.ruta, pase: f.pase, documentos: [], renglones: [] };
    const doc = `${f.t}-${f.s}-${f.folio}@${f.suc}`;
    if (!e.documentos.includes(doc)) e.documentos.push(doc);
    // Un documento que no es compra ni gasto (nota, anticipo…) no trae cuenta: se declara con cuenta nula.
    e.renglones.push({ cuenta: f.t === 20 || f.t === 10 ? f.cuenta : null, importe: Number(f.imp ?? 0), departamento: f.departamento });
    evidencia.set(f.id, e);
  }
  return { hay_ods: true, evidencia };
}
