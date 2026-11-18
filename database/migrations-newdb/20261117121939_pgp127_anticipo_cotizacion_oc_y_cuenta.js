'use strict';
/**
 * `[PGP.127]` — **El anticipo se pide con su cotización, su OC de Kepler y la CLABE a la que se paga.**
 *
 * Francisco (2026-11-17): en Kepler no hay dónde pedir un anticipo; se registra hasta que se pagó. El
 * pedido de la Suite (`[PGP.119]`) no traía los papeles: ni la cotización, ni la OC real (la de la
 * Suite dejó de existir el 26-oct, D21 de PQ: la real es la `X-A-35` de Kepler), ni la cuenta.
 *
 * ── Qué agrega (sólo columnas NULAS en `commercial.supplier_payment_obligations`) ─────────────
 *  · `quote_file_key` / `quote_file_kind` — la cotización en el almacenamiento privado (S3), como las
 *    demás evidencias de la Suite (`ObjectStorageService.putFile`): la llave, nunca una URL pública.
 *  · `kepler_ocs` (jsonb) — las `X-A-35` de Kepler a las que va el anticipo, `[{ serie, folio }]`, en la
 *    sucursal de `kepler_sucursal`. Es una REFERENCIA (la OC se lee viva de `kepler_ods.kdm1`), no una
 *    copia de su total.
 *  · `payee_clabe` — la CLABE de la cotización a la que se paga; NULL = se paga en efectivo. Su estado
 *    (aprobada / espera aprobación) se DERIVA al leer del catálogo de cuentas y sus solicitudes: no se
 *    guarda aquí para que no pueda contradecirlas.
 *  · Dos CHECK de FORMA (no de obligatoriedad): la CLABE son 18 dígitos y el tipo es pdf o image.
 *
 * ── Por qué no rompe nada (regla 14) ────────────────────────────────────────────────────────
 *  · Los cuatro caminos que insertan aquí (entrega aceptada `[TP.15]` y su backfill, alta manual,
 *    «programar documento de Kepler», pedir anticipo) siguen funcionando: las columnas son nulas.
 *    Que el anticipo LLEVE cotización y OC lo exige `crearAnticipo` (el único camino que crea uno);
 *    un CHECK de obligatoriedad rompería los anticipos de prueba de `payment-calendar.it.spec.ts` y
 *    no protege nada que el servicio no proteja ya.
 *  · Compatible con la API desplegada: no lee ni escribe estas columnas.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-17) ────────────────────────────────────────
 *  · 0 anticipos pedidos en la Suite; 0 cuentas de proveedor en el catálogo.
 *  · 44 de 49 `X-D-60` de mercancía de 120 días tenían una `X-A-35` viva del mismo acreedor y sucursal
 *    en los 45 días previos.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'supplier_payment_obligations';
const CK_CLABE = 'ck_spo_payee_clabe';
const CK_KIND = 'ck_spo_quote_file_kind';

async function existe(knex, nombre) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'commercial.supplier_payment_obligations'::regclass`, [nombre]);
  return rows.length > 0;
}

const COLUMNAS = [
  ['quote_file_key', 'text', '[PGP.127] La cotizacion del anticipo en el almacenamiento privado (llave de S3, se abre con URL firmada).'],
  ['quote_file_kind', 'text', '[PGP.127] pdf | image.'],
  ['kepler_ocs', 'jsonb', '[PGP.127] Las X-A-35 de Kepler del anticipo, [{serie, folio}], en la sucursal de kepler_sucursal. Referencia: la OC se lee viva de kepler_ods.kdm1.'],
  ['payee_clabe', 'text', '[PGP.127] La CLABE de la cotizacion a la que se paga el anticipo; NULL = efectivo. Si esta aprobada se deriva del catalogo de cuentas.'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // ⚠️ `withSchema(...).hasColumn`: `hasColumn('commercial.x', ...)` devuelve false SIEMPRE.
  for (const [col, tipo, comentario] of COLUMNAS) {
    if (!(await knex.schema.withSchema('commercial').hasColumn(TABLA, col))) {
      await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN ${col} ${tipo}`);
    }
    await knex.raw(`COMMENT ON COLUMN commercial.${TABLA}.${col} IS '${comentario}'`);
  }
  if (!(await existe(knex, CK_CLABE))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${CK_CLABE} CHECK (payee_clabe IS NULL OR payee_clabe ~ '^[0-9]{18}$')`);
  }
  if (!(await existe(knex, CK_KIND))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${CK_KIND} CHECK (quote_file_kind IS NULL OR quote_file_kind IN ('pdf','image'))`);
  }
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. ⛔ Si ya hay anticipos con cotización, se
 * niega: quitar las columnas perdería la cotización y la cuenta de pedidos vivos.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('commercial').hasColumn(TABLA, 'quote_file_key')) {
    const { rows: [m] } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.${TABLA} WHERE quote_file_key IS NOT NULL OR payee_clabe IS NOT NULL OR kepler_ocs IS NOT NULL`);
    if (m.n > 0) throw new Error(`[PGP.127] ${m.n} anticipo(s) con cotización, OC o cuenta: no se deshace sin perderlos.`);
  }
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${CK_KIND}`);
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${CK_CLABE}`);
  for (const [col] of [...COLUMNAS].reverse()) {
    if (await knex.schema.withSchema('commercial').hasColumn(TABLA, col)) {
      await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN ${col}`);
    }
  }
};
