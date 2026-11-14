'use strict';
/**
 * `[PGP.119]` — **Un anticipo a proveedor se pide en la Suite y se paga por el Calendario.**
 *
 * Hasta hoy el anticipo (`X-D-60`) se decidía y pagaba por fuera: Tesorería transfería (o Caja General
 * entregaba) y Cuentas por pagar lo capturaba en Kepler. Ni Dirección lo autorizaba en el Calendario ni
 * contaba contra el tope del día. Ahora Compras lo pide y nace como una obligación de pago más, de
 * naturaleza `anticipo`; sale por el carril de siempre y se liga sola con el `X-D-60` al leerla.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  `commercial.supplier_payment_obligations` gana `nature text NOT NULL DEFAULT 'factura'`
 *  (`factura` | `anticipo`). En un anticipo, la sucursal de Kepler donde se capturará el `X-D-60` va en
 *  `kepler_sucursal` con `kepler_doc_tipo = 60` y `kepler_folio` VACÍO: el documento se parea al leer
 *  (derivado, no se copia). Un CHECK lo fija, porque los diez lectores de `kepler_*` (CFDI, ensayo
 *  de Kepler, estado de cuenta, fuera de programa…) tratan `kepler_folio` lleno como una factura.
 *
 * ── Por qué no rompe nada (regla 14) ────────────────────────────────────────────────────────
 *  · Los cuatro caminos que insertan aquí (entrega aceptada `[TP.15]` y su backfill, alta manual,
 *    «programar documento de Kepler») no mandan `nature`: el DEFAULT los deja en `factura`, como hoy.
 *  · Compatible con la API desplegada: la columna nueva no se exige a nadie.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-13) ────────────────────────────────────────
 *  · 38 obligaciones, todas de entrega aceptada; ninguna de alta manual ni con OC.
 *  · `X-D-60` de 12 meses: 206 documentos, ~$15.6 M; de 16 a 31 por mes.
 *  · La referencia del `X-D-60` no cita OC (168 con texto libre, 39 vacías): la OC es opcional.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'supplier_payment_obligations';
const CK_NATURE = 'ck_spo_nature';
const CK_ANTICIPO = 'ck_spo_anticipo_sin_folio';

async function existe(knex, nombre) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'commercial.supplier_payment_obligations'::regclass`, [nombre]);
  return rows.length > 0;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // ⚠️ `withSchema(...).hasColumn`: `hasColumn('commercial.x', ...)` devuelve false SIEMPRE.
  if (!(await knex.schema.withSchema('commercial').hasColumn(TABLA, 'nature'))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN nature text NOT NULL DEFAULT 'factura'`);
  }
  if (!(await existe(knex, CK_NATURE))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${CK_NATURE} CHECK (nature IN ('factura','anticipo'))`);
  }
  if (!(await existe(knex, CK_ANTICIPO))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${CK_ANTICIPO} CHECK (nature <> 'anticipo' OR kepler_folio IS NULL)`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.${TABLA}.nature IS '[PGP.119] factura = deuda por una compra; anticipo = dinero adelantado que pidio Compras (su X-D-60 se parea al leer: kepler_folio queda NULL y kepler_sucursal dice donde se capturara).'`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. ⛔ Si ya hay anticipos pedidos, se niega:
 * quitar la columna los volvería facturas sin serlo.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('commercial').hasColumn(TABLA, 'nature')) {
    const { rows: [m] } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.${TABLA} WHERE nature = 'anticipo'`);
    if (m.n > 0) throw new Error(`[PGP.119] ${m.n} anticipo(s) pedidos: cancélalos antes de deshacer.`);
  }
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${CK_ANTICIPO}`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${CK_NATURE}`);
  if (await knex.schema.withSchema('commercial').hasColumn(TABLA, 'nature')) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN nature`);
  }
};
