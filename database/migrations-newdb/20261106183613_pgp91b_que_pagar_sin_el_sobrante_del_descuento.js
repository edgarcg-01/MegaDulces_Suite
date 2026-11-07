'use strict';
/**
 * `[PGP.91b]` — **«Qué conviene pagar» no vuelve a proponer el sobrante de un descuento al pagar.**
 *
 * `[PGP.91]` deja pagar una factura con descuento (3 % de pronto pago, uno por volumen): sale el
 * NETO y la nota de crédito la emite el proveedor DESPUÉS en Kepler. Mientras esa nota no llega,
 * Kepler sigue debiendo el sobrante (p. ej. $1,166.40 de una factura de $38,880).
 *
 * El Calendario ya no lo vuelve a ofrecer (cuenta lo CUBIERTO = neto + descuento), pero
 * `analytics.v_pago_sugerido` (`[PGP.41]`) lee `v_supplier_payables.pendiente` crudo: en cuanto
 * Kepler registra el X-D-26 por el neto, el sobrante queda «pendiente» con su ventana abierta, y
 * el panel diría «Pagando $1,166.40 … se ganan $35» — el sobrante que la función existe para
 * esconder, más una «ganancia» sobre un descuento que ya se tomó. Lo encontró la revisión
 * adversarial de `[PGP.91]`.
 *
 * Historia: nació como `[PGP.51b]` en el PR #482, que se cerró sin fusionar el 2026-11-06 cuando
 * Edgar rehízo la pantalla de Pagos. Nunca entró a `main` ni se aplicó desde él; ésta la reemplaza
 * con número y marca de tiempo nuevos. ⚠️ El cuerpo se arma sobre el de `[PGP.41]` (de Edgar), que
 * lee `analytics.v_supplier_payables`: el arreglo de `[PGP.67]` (un pago cancelado no salda) vive
 * en ESA vista y no se pierde.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 * Re-crea la vista con el MISMO cuerpo de `[PGP.41]` (se toma de esa migración, no se copia) y
 * una sola condición más: queda fuera la factura que tiene un pago vigente (pendiente o
 * ejecutado) con descuento al pagar. ⛔ Es a propósito estrecho: NO resta lo reservado sin
 * descuento — esa es otra deuda de `[PGP.41]` (declarada), y meterla acá cambiaría la cifra de
 * todos los acreedores sin medición antes/después (regla 15).
 * ⚠️ Declarado (revisión del PR): un pago PARCIAL con descuento saca la factura ENTERA de la
 * propuesta, aunque le quede saldo con ventana abierta. Es raro —el descuento al pagar se aplica
 * pagando la factura completa— y se prefirió no ofrecer de más a calcular un resto que Kepler
 * todavía no refleja. Si el uso muestra lo contrario, la condición se vuelve «cubierto ≥ importe».
 *
 * Cubre las DOS fuentes de factura con descuento: la derivada por la llave del Calendario
 * (`sqlKeplerPayableId`, `md5('kepler_payable|'…)::uuid`) y la capturada por su liga `kepler_*`.
 * Si alguna vez cambia allá, esta condición deja de excluir sin error: lo ancla el vector fijo de
 * `payment-calendar-kepler-payable.spec.ts` y `descuento-al-pagar.spec.ts` (prueba que esta migración la contiene).
 *
 * Depende de `20261106183612` (la columna `discount_amount`) y de `20261031140043` (la vista).
 * Idempotente (CREATE OR REPLACE con las mismas columnas). `down()` vuelve al cuerpo de `[PGP.41]`.
 *
 * @param { import("knex").Knex } knex
 */

const PGP41 = require('./20261031140043_pgp41_que_hay_que_pagar_hoy.js');

/** El punto exacto del cuerpo de PGP.41 donde entra la condición. Si no está, se frena: no se adivina. */
const ANCLA = `WHERE NOT ${PGP41.SQL.FINANCIERO})`;

/**
 * Las DOS fuentes de factura que admiten descuento (`assertDescuentoPermitido`): la derivada se
 * reconoce por su llave md5; la capturada, por su liga `kepler_*` (igual que Pronto pago). La
 * primera versión sólo veía la derivada y la capturada volvía a aparecer — lo cazó la 2ª revisión.
 */
const CON_DESCUENTO_VIGENTE = `
       AND NOT EXISTS (
             SELECT 1
               FROM finance.payment_allocation_items i
               JOIN finance.payment_allocations a ON a.id = i.allocation_id
              WHERE i.tenant_id = v.tenant_id
                AND i.discount_amount > 0
                AND a.status IN ('pending', 'executed')
                AND (   (i.obligation_source = 'kepler_payable'
                         AND i.obligation_id = md5('kepler_payable|'||v.sucursal||'|'||v.doc_tipo||'|'||v.doc_sub||'|'||v.folio)::uuid)
                     OR (i.obligation_source = 'supplier_payable'
                         AND i.obligation_id IN (
                               SELECT o.id FROM commercial.supplier_payment_obligations o
                                WHERE o.kepler_sucursal = v.sucursal AND o.kepler_doc_tipo = v.doc_tipo
                                  AND o.kepler_doc_sub = v.doc_sub   AND o.kepler_folio    = v.folio
                                  AND o.status <> 'cancelled')))))`;

function cuerpo() {
  const base = PGP41.SQL.CUERPO;
  if (base.split(ANCLA).length !== 2) {
    throw new Error('[PGP.91b] el cuerpo de v_pago_sugerido (PGP.41) ya no tiene el punto de inserción esperado. Se frena.');
  }
  return base.replace(ANCLA, ANCLA.slice(0, -1) + CON_DESCUENTO_VIGENTE);
}

/** El SELECT de un cuerpo de vista, para medir el viejo y el nuevo en la MISMA consulta. */
const select = (sql) => sql.replace(/^\s*CREATE OR REPLACE VIEW analytics\.v_pago_sugerido AS/, '');

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // Antes/después (regla 15) en UNA sentencia: un solo snapshot. En dos lecturas separadas, la
  // ingesta (OdsLiveLoop) podía escribir en medio y la guarda revertía una migración sana.
  const { rows: [m] } = await knex.raw(`
    WITH viejo AS (${select(PGP41.SQL.CUERPO)}),
         nuevo AS (${select(cuerpo())})
    SELECT (SELECT count(*) FROM viejo)::int                  AS n_antes,
           (SELECT coalesce(sum(importe), 0) FROM viejo)      AS importe_antes,
           (SELECT count(*) FROM nuevo)::int                  AS n_despues,
           (SELECT coalesce(sum(importe), 0) FROM nuevo)      AS importe_despues,
           (SELECT count(*) FROM finance.payment_allocation_items WHERE discount_amount > 0)::int AS con_descuento`);
  console.log(`[PGP.91b] antes ${m.n_antes} acreedores / ${m.importe_antes} · después ${m.n_despues} / ${m.importe_despues} · ` +
    `${m.con_descuento} item(s) con descuento`);
  // Sin ningún descuento capturado la propuesta tiene que quedar IGUAL: si cambia, excluye de más.
  if (m.con_descuento === 0 && (m.n_antes !== m.n_despues || Number(m.importe_antes) !== Number(m.importe_despues))) {
    throw new Error('[PGP.91b] sin ningún descuento capturado la propuesta cambió: la condición excluye de más. Se revierte.');
  }

  const t0 = process.hrtime.bigint();
  await knex.raw(PGP41.SQL.SONDA);
  const msAntes = Number(process.hrtime.bigint() - t0) / 1e6;

  await knex.raw(cuerpo());
  await knex.raw('GRANT SELECT ON analytics.v_pago_sugerido TO app_runtime');
  await knex.raw('GRANT SELECT ON analytics.v_pago_sugerido TO dev_ro');

  await knex.raw(PGP41.SQL.SONDA);
  const t1 = process.hrtime.bigint();
  await knex.raw(PGP41.SQL.SONDA);
  const ms = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`[PGP.91b] la vista cuesta ${ms.toFixed(0)} ms (antes ${msAntes.toFixed(0)} ms)`);
  const tope = Math.round(msAntes * PGP41.SQL.FACTOR + PGP41.SQL.MARGEN_MS);
  if (ms > tope) {
    throw new Error(`[PGP.91b] la vista pasó de ${msAntes.toFixed(0)} a ${ms.toFixed(0)} ms (tope ${tope} ms). Se revierte.`);
  }
};

/** Vuelve EXACTAMENTE al cuerpo de `[PGP.41]`. */
exports.down = async function down(knex) {
  await knex.raw(PGP41.SQL.CUERPO);
};

exports.SQL = { ANCLA, CON_DESCUENTO_VIGENTE, cuerpo };
