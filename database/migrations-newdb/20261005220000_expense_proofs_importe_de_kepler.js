/**
 * `[GX.68]` Repara el IMPORTE de los vales de gasto ya grabados: pasa a ser el de Kepler.
 *
 * `ExpenseProofsService.create()` releía la solicitud SÓLO por folio, y con folios repetidos entre
 * plazas (373 medidos) `.first()` grababa el importe de la solicitud de OTRA tienda. El código se
 * corrige en el mismo PR; esta migración arregla lo que ya quedó grabado.
 *
 * Reglas (las mismas de `database/scripts/fix-expense-proof-importe.js`, que sirve para VER la
 * lista antes de aplicar):
 *  · Llave = (tenant, sucursal, folio). Un vale SIN sucursal sólo se casa si su folio es único en
 *    Kepler; si vive en varias plazas no se toca (adivinar es el defecto mismo).
 *  · Sólo cuando Kepler trae importe > 0 y difiere en ≥ $0.01.
 *  · El valor viejo NO se pierde: queda en `capture_meta.importe_anterior`, con la marca
 *    `importe_corregido_motivo = 'GX.68'`, que es lo que usa `down()` para devolverlo.
 *  · No toca `status` ni ninguna otra columna. Idempotente: una 2ª corrida no encuentra nada.
 *
 * ⚠️ `analytics.expense_requests` es una VISTA sobre `kepler_ods`: el cruce se materializa una vez
 * en una tabla temporal para no re-derivarla por fila.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const t = await knex.raw(`SELECT to_regclass('finance.expense_proofs') AS p,
                                   to_regclass('analytics.expense_requests') AS k`);
  if (!t.rows[0]?.p || !t.rows[0]?.k) return; // entorno sin el módulo

  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`DROP TABLE IF EXISTS gx68_kepler`);
  await knex.raw(`
    CREATE TEMP TABLE gx68_kepler ON COMMIT DROP AS
    SELECT tenant_id, btrim(sucursal) AS sucursal, folio, importe::numeric AS importe,
           count(*) OVER (PARTITION BY tenant_id, folio) AS plazas
      FROM analytics.expense_requests`);

  const res = await knex.raw(`
    UPDATE finance.expense_proofs p
       SET importe = k.importe,
           capture_meta = COALESCE(p.capture_meta, '{}'::jsonb) || jsonb_build_object(
             'importe_anterior', p.importe::numeric,
             'importe_corregido_at', now(),
             'importe_corregido_motivo', 'GX.68'),
           updated_at = now()
      FROM gx68_kepler k
     WHERE k.tenant_id = p.tenant_id
       AND k.folio = p.folio_solicitud
       AND (k.sucursal = btrim(p.sucursal)
            OR (NULLIF(btrim(p.sucursal), '') IS NULL AND k.plazas = 1))
       AND k.importe > 0
       AND abs(k.importe - COALESCE(p.importe, 0)::numeric) >= 0.01`);
  console.log(`[GX.68] vales corregidos al importe de Kepler: ${res.rowCount}`);
};

exports.down = async function (knex) {
  const t = await knex.raw(`SELECT to_regclass('finance.expense_proofs') AS p`);
  if (!t.rows[0]?.p) return;
  await knex.raw(`
    UPDATE finance.expense_proofs
       SET importe = (capture_meta->>'importe_anterior')::numeric,
           capture_meta = capture_meta - 'importe_anterior' - 'importe_corregido_at' - 'importe_corregido_motivo',
           updated_at = now()
     WHERE capture_meta->>'importe_corregido_motivo' = 'GX.68'
       AND capture_meta->>'importe_anterior' IS NOT NULL`);
};
