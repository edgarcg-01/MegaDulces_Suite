'use strict';
/**
 * `[TP.15]` — **Lo que Finanzas acepta en «Entregas» llega solo al Calendario de Pagos.**
 *
 * ── Por qué (Francisco, 2026-10-16) ─────────────────────────────────────────────────────────
 * «No le encuentro la o por lo redondo de cómo cargo las notas para pago». El Calendario sólo
 * asigna obligaciones que ya existen, y la de proveedor se capturaba a mano en `/compras/
 * obligaciones` (pestaña que Finanzas ni ve). Nadie lo hizo: el circuito Entrega → Calendario
 * estaba cortado. Aceptar una factura en Entregas (RE.32) dejaba la constancia del papel y nada
 * que pagar.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-16) ────────────────────────────────────────
 *  · `commercial.supplier_payment_obligations`: **0 filas**. `finance.payment_calendar_lots`: 0.
 *    El Calendario mostraba «Obligaciones disponibles: 0» con $2.15M de capacidad el día.
 *  · Renglones de entrega `aceptado`: 38 ($1,959,744.41), los 38 casan con `catalog.suppliers`
 *    por `code` (único por tenant).
 *  · ⭐ Contra la deuda viva de Kepler (`analytics.v_supplier_payables`, misma sucursal +
 *    proveedor + folio de la entrada): 15 con saldo igual al importe, 2 con saldo MENOR
 *    (abonos/NC: $211,922.78 → $209,879.78) y **21 sin saldo** ($370,011.10: ya pagadas o de
 *    contado). Ninguna entrada casa con dos documentos. Si se copiara el importe de la entrega,
 *    esas 21 se ofrecerían para pagar OTRA VEZ. Por eso la obligación nace con el **pendiente
 *    de Kepler**, y la que no tiene pendiente no nace.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  1. `commercial.supplier_payment_obligations` gana (todas NULL, aditivas):
 *       · `purchase_delivery_line_id` → el renglón de la entrega que la originó (FK) + índice
 *         único parcial: una entrada aceptada produce a lo más UNA obligación.
 *       · `kepler_sucursal`, `kepler_doc_tipo`, `kepler_doc_sub`, `kepler_folio` → la llave del
 *         documento en `kdxe`, para que el Calendario vuelva a medir el saldo vivo al asignar.
 *     Las obligaciones capturadas a mano quedan con todo en NULL (sin cambio de comportamiento).
 *  2. Backfill: las aceptadas HOY con pendiente en Kepler (medido: 17 por $1,587,690.31).
 *     `authorized_by` = quien aceptó el renglón (`decided_by`): aceptar el papel ES la
 *     autorización para programarlo (ADR-064: la obligación nace autorizada en su origen).
 *
 * No es copia de tabla: la obligación es dato propio (quién la autorizó, cuánto se reservó y
 * pagó desde el Calendario). Del ERP sólo guarda la llave y el pendiente al momento de aceptar;
 * el saldo vivo se vuelve a leer de la vista al asignar el pago.
 *
 * ⚠️ El INSERT de abajo es el MISMO que hace `PurchaseDeliveriesService.toCalendar()` al
 *    aceptar; si cambia uno, cambia el otro.
 *
 * Idempotente (`hasColumn` por columna, `IF NOT EXISTS`, `NOT EXISTS` + `ON CONFLICT`).
 *
 * @param { import("knex").Knex } knex
 */

const M = '00000000-0000-0000-0000-00000000d01c';
const COLS = ['purchase_delivery_line_id', 'kepler_sucursal', 'kepler_doc_tipo', 'kepler_doc_sub', 'kepler_folio'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // RLS está FORZADO en ambas tablas: sin tenant en el contexto, un rol no-superusuario no ve nada.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);

  const has = (c) => knex.schema.withSchema('commercial').hasColumn('supplier_payment_obligations', c);
  if (!(await has('purchase_delivery_line_id'))) {
    await knex.raw(`ALTER TABLE commercial.supplier_payment_obligations
      ADD COLUMN purchase_delivery_line_id uuid REFERENCES commercial.purchase_delivery_lines (id) ON DELETE RESTRICT`);
  }
  if (!(await has('kepler_sucursal'))) await knex.raw(`ALTER TABLE commercial.supplier_payment_obligations ADD COLUMN kepler_sucursal text`);
  if (!(await has('kepler_doc_tipo'))) await knex.raw(`ALTER TABLE commercial.supplier_payment_obligations ADD COLUMN kepler_doc_tipo numeric`);
  if (!(await has('kepler_doc_sub'))) await knex.raw(`ALTER TABLE commercial.supplier_payment_obligations ADD COLUMN kepler_doc_sub numeric`);
  if (!(await has('kepler_folio'))) await knex.raw(`ALTER TABLE commercial.supplier_payment_obligations ADD COLUMN kepler_folio text`);

  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_spo_delivery_line
    ON commercial.supplier_payment_obligations (tenant_id, purchase_delivery_line_id)
    WHERE purchase_delivery_line_id IS NOT NULL`);
  await knex.raw(`COMMENT ON COLUMN commercial.supplier_payment_obligations.purchase_delivery_line_id IS
    '[TP.15] Renglón de la entrega (RE.32) que originó la obligación al aceptarse. NULL = capturada a mano en /compras/obligaciones.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.supplier_payment_obligations.kepler_folio IS
    '[TP.15] Llave del documento en kepler_ods.kdxe (con kepler_sucursal/doc_tipo/doc_sub): el Calendario re-mide el pendiente vivo en analytics.v_supplier_payables al asignar.'`);

  // Backfill: mismo SQL que PurchaseDeliveriesService.toCalendar(), sin filtro de entrega.
  await knex.raw(`
    WITH doc AS MATERIALIZED (
      SELECT p.tenant_id, p.sucursal, p.proveedor, p.folio,
             min(p.doc_tipo) AS doc_tipo, min(p.doc_sub) AS doc_sub,
             min(p.vencimiento) AS vencimiento, sum(p.pendiente) AS pendiente
        FROM analytics.v_supplier_payables p
       GROUP BY p.tenant_id, p.sucursal, p.proveedor, p.folio
      HAVING count(*) = 1
    )
    INSERT INTO commercial.supplier_payment_obligations
      (tenant_id, supplier_id, invoice_folio, concept, original_amount, original_due_date, notes,
       authorized_by, authorized_at, created_by,
       purchase_delivery_line_id, kepler_sucursal, kepler_doc_tipo, kepler_doc_sub, kepler_folio)
    SELECT l.tenant_id, s.id, nullif(btrim(l.referencia), ''),
           'Entrada ' || l.receipt_sucursal || '-' || l.receipt_folio
             || coalesce(' · Fact. ' || nullif(btrim(l.referencia), ''), ''),
           round(doc.pendiente, 2), coalesce(doc.vencimiento, l.kepler_due_date),
           'Desde la entrega ' || d.code || ', aceptada por ' || l.decided_by,
           l.decided_by, l.decided_at, 'mig:tp15',
           l.id, doc.sucursal, doc.doc_tipo, doc.doc_sub, doc.folio
      FROM commercial.purchase_delivery_lines l
      JOIN commercial.purchase_deliveries d ON d.tenant_id = l.tenant_id AND d.id = l.delivery_id
      JOIN catalog.suppliers s ON s.tenant_id = l.tenant_id AND s.code = l.supplier_code
      JOIN doc ON doc.tenant_id = l.tenant_id AND doc.sucursal = l.receipt_sucursal
              AND doc.proveedor = l.supplier_code AND doc.folio = l.receipt_folio
     WHERE l.status = 'aceptado' AND round(doc.pendiente, 2) > 0
       AND NOT EXISTS (SELECT 1 FROM commercial.supplier_payment_obligations o
                        WHERE o.tenant_id = l.tenant_id AND o.purchase_delivery_line_id = l.id)
    ON CONFLICT (tenant_id, purchase_delivery_line_id) WHERE purchase_delivery_line_id IS NOT NULL DO NOTHING`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
  if (!(await knex.schema.withSchema('commercial').hasColumn('supplier_payment_obligations', 'purchase_delivery_line_id'))) return;
  // Si ya se programó o pagó alguna, bajar la migración borraría historia de pagos: se niega.
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.supplier_payment_obligations
    WHERE purchase_delivery_line_id IS NOT NULL AND (reserved_amount > 0 OR paid_amount > 0)`);
  if (rows[0].n > 0) throw new Error(`[TP.15] down: ${rows[0].n} obligación(es) de entrega ya tienen pagos; cancélalos antes.`);
  await knex.raw(`DELETE FROM commercial.supplier_payment_obligations WHERE purchase_delivery_line_id IS NOT NULL`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_spo_delivery_line`);
  for (const c of COLS) await knex.raw(`ALTER TABLE commercial.supplier_payment_obligations DROP COLUMN IF EXISTS ${c}`);
};
