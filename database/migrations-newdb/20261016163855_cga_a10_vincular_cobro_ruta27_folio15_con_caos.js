'use strict';
/**
 * `[CGA-A.10a]` — **El cobro de la ruta 27 del 16-oct entró al libro por $120.00 cuando vale
 * $21,240.00, y su depósito en CAOS quedó suelto.** Esta migración corrige el importe contra su
 * propia fuente y enlaza el depósito.
 *
 * ── Lo medido en prod el 2026-10-16, sólo lectura ───────────────────────────────────────────
 *
 *  · `finance.cash_ledger` **CI-2026-00047** · `origen_tipo='cobro'` ·
 *    `origen_ref='01-005|U-A-5|0000015|0011'` · **monto = 120.00**
 *  · `analytics.route_collections` para ese mismo `origen_ref` tiene **dos** renglones:
 *        folio_corte 0000011  Caja 1-99    $ 8,934.25
 *        folio_corte 0000012  Caja 1-100   $12,305.75
 *    → **suma 21,240.00**, que es lo que la vista publica hoy y lo que confirmó Edgar.
 *  · `analytics.caos_cash_movements` **AST700-19758 / 1615** · `Deposito` ·
 *    ref «ruta 27   161026» · 2026-10-16 20:36:52 · **total 21,120.00** · sin enlazar.
 *  · El hermano del mismo día lo hace así: **CI-2026-00048** (ruta 28, `01-006|U-A-5|0000013|0011`,
 *    libro $13,699.00) está enlazado a CAOS **#1617** con `monto_enlazado` **$13,280.00**.
 *    O sea: **el libro lleva lo que dice Kepler y el enlace lleva lo que llegó a la bóveda.**
 *    La diferencia no se promedia ni se esconde — queda a la vista. Acá son **$120.00**.
 *
 * ⭐ **Por qué el importe estaba mal, y por qué no alcanza con corregirlo.** La captura
 * **congela** el importe, y la vista de pendientes excluye por `origen_ref` — **no por monto**.
 * Así que si la fuente se corrige después (acá el importer re-corrió a las 22:08 y arregló los
 * renglones que a las 21:07 estaban incompletos), **el libro se queda con el número viejo y el
 * documento ya nunca vuelve a ofrecerse**. Mismo modo de fallar que `GOTCHAS` §86: el dinero no
 * se pierde ni se duplica, **se vuelve invisible**.
 * Lo vigila desde hoy `npm run check:cobro-monto-desfasado`. Alcance medido al escribir esto:
 * **2 filas** desfasadas en todo el libro — ésta ($21,120.00) y `CI-2026-00004` (**−$0.38**, un
 * redondeo que tecleó la persona). **Esta migración toca SÓLO la primera.**
 *
 * ── Lo que NO hace, dicho con todas las letras ──────────────────────────────────────────────
 *  · No toca `CI-2026-00004`: esos $0.38 son una decisión de quien capturó, no un desfase de
 *    tubería. Se resuelven en la pantalla o se dejan, pero no por migración.
 *  · No inventa el importe: lo **relee de `analytics.route_collections`** al correr. Si la fuente
 *    no suma 21,240.00 exactos, **aborta** en vez de escribir un número distinto del medido.
 *
 * ⚠️ Sólo hace `UPDATE`/`INSERT`: la compuerta del despliegue la clasifica NO_MEDIDO y frena al
 *    equipo. **Aplicar a mano ANTES de mergear**, con `apply-one-migration-prod.js`.
 *
 * Idempotente: corre dos veces y la segunda no cambia nada.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ORIGEN_REF = '01-005|U-A-5|0000015|0011';
const FOLIO = 'CI-2026-00047';
const CAOS_DEVICE = 'AST700-19758';
const CAOS_EXTERNAL_ID = '1615';

/** Lo medido. Si la base no coincide, la migración NO escribe: aborta y lo dice. */
const MONTO_MALO = '120.00';
const MONTO_BUENO = '21240.00';
const MONTO_CAOS = '21120.00';
const MARCA = 'migracion 20261016163855 [CGA-A.10a]';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. ¿Existe la fila, y sigue valiendo lo que medí? ────────────────────────────────────
  const { rows: libro } = await knex.raw(
    `SELECT id, monto::text AS monto FROM finance.cash_ledger
      WHERE tenant_id = ? AND folio = ? AND origen_tipo = 'cobro' AND origen_ref = ?
        AND deleted_at IS NULL`,
    [TENANT, FOLIO, ORIGEN_REF]);

  if (libro.length !== 1) {
    console.log(`[CGA-A.10a] ${FOLIO} no está (o está duplicado): ${libro.length} filas. No se toca nada.`);
    return;
  }
  const fila = libro[0];

  // ── 2. El importe bueno se RELEE de la fuente, no se teclea ──────────────────────────────
  const { rows: fuente } = await knex.raw(
    `SELECT sum(importe)::text AS monto, count(*)::int AS renglones
       FROM analytics.route_collections
      WHERE tenant_id = ? AND cuenta = '0011'
        AND (almacen || '|U-A-5|' || cobro_folio || '|0011') = ?`,
    [TENANT, ORIGEN_REF]);

  const montoFuente = fuente[0] && fuente[0].monto;
  if (!montoFuente) {
    throw new Error(`[CGA-A.10a] analytics.route_collections no tiene nada para ${ORIGEN_REF}. ABORTA.`);
  }
  if (Number(montoFuente) !== Number(MONTO_BUENO)) {
    throw new Error(
      `[CGA-A.10a] la fuente cambió: suma ${montoFuente}, yo medí ${MONTO_BUENO}. ` +
      `No escribo un número que nadie verificó. ABORTA.`);
  }

  // ── 3. Corregir el importe. Idempotente: si ya está bien, no hace nada ───────────────────
  if (Number(fila.monto) === Number(MONTO_BUENO)) {
    console.log(`[CGA-A.10a] ${FOLIO} ya vale ${MONTO_BUENO}. Nada que corregir.`);
  } else if (Number(fila.monto) !== Number(MONTO_MALO)) {
    throw new Error(
      `[CGA-A.10a] ${FOLIO} vale ${fila.monto}, y yo medí ${MONTO_MALO}. ` +
      `Alguien lo tocó entre la medición y esto. ABORTA — que lo mire una persona.`);
  } else {
    const r = await knex.raw(
      `UPDATE finance.cash_ledger
          SET monto = ?::numeric, updated_at = now()
        WHERE id = ? AND monto = ?::numeric`,
      [MONTO_BUENO, fila.id, MONTO_MALO]);
    console.log(`[CGA-A.10a] ${FOLIO}: ${MONTO_MALO} → ${MONTO_BUENO} (${r.rowCount} fila).`);
  }

  // ── 4. Enlazar el depósito de CAOS. El enlace lleva lo que LLEGÓ, no lo que Kepler dice ──
  const { rows: caos } = await knex.raw(
    `SELECT total::text AS total, ref FROM analytics.caos_cash_movements
      WHERE tenant_id = ? AND device = ? AND external_id = ?`,
    [TENANT, CAOS_DEVICE, CAOS_EXTERNAL_ID]);

  if (!caos.length) {
    console.log(`[CGA-A.10a] CAOS ${CAOS_DEVICE}|${CAOS_EXTERNAL_ID} no está en el espejo. Enlace omitido.`);
    return;
  }
  if (Number(caos[0].total) !== Number(MONTO_CAOS)) {
    throw new Error(
      `[CGA-A.10a] el depósito CAOS vale ${caos[0].total}, yo medí ${MONTO_CAOS}. ABORTA.`);
  }

  const senales = JSON.stringify({
    confianza: 'alta',
    motivos: [
      'ref «ruta 27   161026» nombra la unidad y la fecha del cobro',
      'mismo día y misma caja fuerte que el cobro 01-005|U-A-5|0000015',
      `diferencia con el libro: $120.00 (Kepler ${MONTO_BUENO} vs bóveda ${MONTO_CAOS})`,
    ],
    origen: MARCA,
  });

  // `ux_caos_link_vivo (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL`
  // hace esto idempotente sin tener que preguntar antes.
  const ins = await knex.raw(
    `INSERT INTO finance.caos_cash_links
       (id, tenant_id, cash_ledger_id, caos_device, caos_external_id, monto_enlazado,
        senales, confirmed_by, confirmed_at, created_at, updated_at)
     SELECT gen_random_uuid(), ?, l.id, ?, ?, ?::numeric, ?::jsonb,
            l.created_by, now(), now(), now()
       FROM finance.cash_ledger l
      WHERE l.id = ?
     ON CONFLICT (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL
     DO NOTHING`,
    [TENANT, CAOS_DEVICE, CAOS_EXTERNAL_ID, MONTO_CAOS, senales, fila.id]);

  console.log(ins.rowCount
    ? `[CGA-A.10a] enlace CAOS #${CAOS_EXTERNAL_ID} (${MONTO_CAOS}) → ${FOLIO}.`
    : `[CGA-A.10a] CAOS #${CAOS_EXTERNAL_ID} ya estaba enlazado. Nada que hacer.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // El enlace: sólo el que creó esta migración, reconocible por `senales->>'origen'`.
  await knex.raw(
    `DELETE FROM finance.caos_cash_links
      WHERE tenant_id = ? AND caos_device = ? AND caos_external_id = ?
        AND senales->>'origen' = ?`,
    [TENANT, CAOS_DEVICE, CAOS_EXTERNAL_ID, MARCA]);

  // El importe: vuelve a 120.00 SÓLO si sigue en 21240.00. Si alguien lo movió, no se toca.
  await knex.raw(
    `UPDATE finance.cash_ledger
        SET monto = ?::numeric, updated_at = now()
      WHERE tenant_id = ? AND folio = ? AND origen_ref = ?
        AND deleted_at IS NULL AND monto = ?::numeric`,
    [MONTO_MALO, TENANT, FOLIO, ORIGEN_REF, MONTO_BUENO]);
};
