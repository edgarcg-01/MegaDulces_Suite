'use strict';
/**
 * ⭐⭐ `[CGA-A.19]` — **`CONTADO` deja de capturarse a mano: se declara `115 / 071`.**
 *
 * ── Qué pasaba, medido en prod el 2026-10-19 ───────────────────────────────────────────────
 *
 * `CONTADO` es la entidad de **todos los cobros de camioneta**, y **no existe en
 * `analytics.mv_caja_autofill_entidad`** — ni antes ni después de `[CGA-A.17]` (verificado
 * corriendo la definición nueva: sigue sin aparecer). `porEntidad()` contesta `sin_historia`,
 * la pantalla dice *«Sin propuesta: captúralo a mano»*, y alguien teclea la cuenta en **cada
 * cobro de ruta, todos los días**.
 *
 *     115/071  ABONO A CLIENTES   42 capturas   $800,492.73
 *
 * ⛔ Por eso A.17 **no alcanza** para este caso: A.17 le pone el CONCEPTO a entidades que ya
 * tienen fila con su cuenta. A `CONTADO` le falta la fila entera.
 *
 * ── Por qué `115/071` y NO `102/011` ───────────────────────────────────────────────────────
 *
 * ⛔ **El conteo 42-contra-7 NO es lo que decide**, y creerlo habría sido el error: no son
 * «la regla» contra «el error repetido», son **dos poblaciones distintas**.
 *
 *     115/071   U-A-5, depósito de RUTA        36   $705,819.63
 *     115/071   CAOS (bóveda)                  21   $350,320.50
 *     102/011   CAOS (bóveda)                   9   $164,467.00
 *     102/011   X-D-26, gasto de caja chica     5     $5,228.02
 *     102/037   X-D-26, gasto de caja chica     2       $560.00
 *
 * Los `102/011` **no vienen de un U-A-5**: traen `origen_ref = AST700-19758|…` o son gastos con
 * glosa «GASTOS GENERALES CAJA CHIICA». Declarar `102/011` para el cobro de ruta sería tomar la
 * regla de la bóveda y de la caja chica y aplicarla al documento equivocado.
 *
 * ⭐ **Lo decide un árbitro que no deriva de nuestro libro**: Kepler postea la póliza del `U-A-5`
 * por su cuenta, contra `115 ABONO A CLIENTES`, en **24,716 documentos · 100%**. Encaja por tres
 * lados independientes:
 *
 *   1. El documento **nombra** su cuenta —ABONO A CLIENTES—, igual que el nombre del concepto `071`.
 *   2. `[CS.3.8]` ya lo midió **con placebo**: `UA0501/115` es 100% ABONO ($462.7 M), mientras la
 *      misma cuenta `115` en `UD0501/UD1301` es 100% CARGO. El sentido no es propiedad de la
 *      cuenta: lo decide el documento, y para `U-A-5` es abono.
 *   3. Contablemente es el lado correcto: `102` **es** Caja General, así que registrar `102` ahí
 *      diría «Caja General contra Caja General» — una tautología, no una partida. En el gasto se
 *      registra `201` (el pasivo), no el `102` que salió; por simetría, en el ingreso va la
 *      contrapartida, no el efectivo.
 *
 * ⚠️ **Lo que esta sesión NO verificó**: la cifra «24,716 · 100%» viene de la decisión de
 * Finanzas, no de una medición propia — mi consulta al árbitro usó un filtro de doctype
 * equivocado y devolvió vacío, así que **no la reproduje**. Lo que sí se midió acá es todo lo
 * demás: que `CONTADO` no está en la matvista, las cinco poblaciones de la tabla, y las guardas
 * de abajo.
 *
 * ── Alcance real, y por qué no se desborda ─────────────────────────────────────────────────
 *
 * La declaración se busca por `entidad_code`, y `porEntidad()` sólo se consulta cuando el
 * movimiento **tiene documento de Kepler**. Los depósitos de CAOS no lo tienen (`origen_ref =
 * AST700-…`), así que esta fila **no los toca**: alcanza exactamente a los cobros `U-A-5` de
 * camioneta, que es lo que el árbitro cubre.
 *
 * ⚠️ **Pregunta abierta que NO resuelve esta migración**: los depósitos de CAOS están repartidos
 * entre `115/071` (21) y `102/011` (9) — dos criterios conviviendo para la misma operación.
 * Queda con nombre; la decide Finanzas, no una migración.
 *
 * Idempotente: `ON CONFLICT` sobre `(tenant_id, entidad_code)`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const ENTIDAD = 'CONTADO';
const CUENTA = '115';
const CONCEPTO = '071';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── Guarda 1: el par existe en el catálogo vivo. Sin esto Kepler lo rechaza al contabilizar,
  // y la captura falla igual que hoy pero más tarde y con el dinero adentro.
  const { rows: [cat] } = await knex.raw(
    `SELECT count(*)::int AS n, min(concepto_nombre) AS nombre
       FROM analytics.v_kepler_conceptos WHERE cuenta = ? AND concepto = ?`, [CUENTA, CONCEPTO]);
  if (!cat || cat.n === 0) {
    throw new Error(`[A.19] el par ${CUENTA}/${CONCEPTO} no existe en v_kepler_conceptos. ABORTA.`);
  }

  // ── Guarda 2: sigue siendo cierto que CONTADO no se puede derivar. Si algún día la matvista
  // lo resuelve sola, esta declaración pasa a ser una verdad duplicada que hay que mantener:
  // mejor enterarse acá que descubrirlo cuando las dos se contradigan.
  const { rows: [mv] } = await knex.raw(
    `SELECT kepler_cuenta, kepler_concepto FROM analytics.mv_caja_autofill_entidad
      WHERE tenant_id = ?::uuid AND entidad_code = ?`, [TENANT, ENTIDAD]);
  if (mv && mv.kepler_cuenta && mv.kepler_concepto) {
    throw new Error(`[A.19] la matvista ya resuelve ${ENTIDAD} (${mv.kepler_cuenta}/${mv.kepler_concepto}).`
      + ' Declararlo sería redundante: revisá si todavía hace falta. ABORTA.');
  }

  // ── Guarda 3: lo capturado no contradice al árbitro. No decide —el árbitro es Kepler— pero si
  // el libro dijera mayoritariamente otra cosa, hay que mirarlo antes y no después.
  const { rows: [h] } = await knex.raw(
    `SELECT count(*) FILTER (WHERE kepler_cuenta = ? AND kepler_concepto = ?)::int AS con,
            count(*)::int AS total
       FROM finance.cash_ledger
      WHERE tenant_id = ?::uuid AND deleted_at IS NULL AND estado <> 'cancelado'
        AND origen_tipo = 'cobro' AND split_part(origen_ref, '|', 2) = 'U-A-5'`,
    [CUENTA, CONCEPTO, TENANT]);
  if (h && h.total >= 5 && h.con / h.total < 0.5) {
    throw new Error(`[A.19] de ${h.total} cobros U-A-5 capturados, sólo ${h.con} usan ${CUENTA}/${CONCEPTO}.`
      + ' El libro contradice al árbitro: ABORTA y que lo mire Finanzas.');
  }

  await knex.raw(
    `INSERT INTO finance.caja_autofill_declarada
       (tenant_id, entidad_code, kepler_cuenta, kepler_concepto, motivo, declarada_por_username)
     VALUES (?::uuid, ?, ?, ?, ?, 'migracion')
     ON CONFLICT (tenant_id, entidad_code) DO UPDATE
        SET kepler_cuenta = EXCLUDED.kepler_cuenta,
            kepler_concepto = EXCLUDED.kepler_concepto,
            motivo = EXCLUDED.motivo,
            updated_at = now()`,
    [TENANT, ENTIDAD, CUENTA, CONCEPTO,
      '[CGA-A.19] CONTADO es la entidad de todos los cobros de camioneta y no existe en la '
      + 'matvista, asi que no proponia nada y se tecleaba en cada cobro (42 capturas, $800,492.73). '
      + 'El par lo fija el arbitro de Kepler: la poliza del U-A-5 postea contra 115 ABONO A '
      + 'CLIENTES en 24,716 documentos, 100%. NO lo decide el conteo del libro.']);

  console.log(`[A.19] ${ENTIDAD} declarada: ${CUENTA}/${CONCEPTO} (${cat.nombre})`);
  if (h) console.log(`[A.19] respaldo en el libro: ${h.con} de ${h.total} cobros U-A-5 ya lo usaban.`);
};

/** Quita SÓLO lo que puso esta migración. */
exports.down = async function down(knex) {
  await knex.raw(
    `DELETE FROM finance.caja_autofill_declarada
      WHERE tenant_id = ?::uuid AND entidad_code = ? AND declarada_por_username = 'migracion'`,
    [TENANT, ENTIDAD]);
};
