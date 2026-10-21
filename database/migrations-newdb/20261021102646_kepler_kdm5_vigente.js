'use strict';
/**
 * `[CSU.11]` — **Las aplicaciones de Kepler que de verdad están vivas: `kdm5` sin lo cancelado.**
 * Una sola fuente, para que ninguna pantalla vuelva a sumar un cobro o un pago que se canceló.
 *
 * ── El defecto, medido en prod el 2026-10-21 (sólo lectura) ────────────────────────────────
 *
 * Cuando un documento se CANCELA en Kepler, su cabecera queda en `kdm1.c43 = 'C'` con
 * `c16 = 0`, y `kdue` pone su abono en 0 — pero **sus aplicaciones en `kdm5` conservan el
 * monto**. Quien suma `kdm5.c13` sin mirar la cabecera cuenta dinero que no existe:
 *
 *     854 de 70,478 aplicaciones son de documentos cancelados (12,804 cancelados en kdm1)
 *     U-A-5 → D-13   242   $5,050,203.12     X-D-26 → A-20   129   $9,694,616.17
 *     U-A-5 → D-12    52   $1,154,048.39     X-D-25 → A-20    30   $2,254,781.61
 *     U-A-25 → D-13   30     $467,321.86     X-D-26 → A-10   263   $1,275,500.54
 *     U-A-5 → D-23    14     $171,986.56  ← Cortes/Sucursales: cobrado de oct inflado
 *
 * Ya se había parchado por separado tres veces (`income_bridge_src`, el `LATERAL` de
 * `v_route_credit_sales` —que excluye el cancelado para la FECHA pero lo sigue sumando— y los
 * filtros de `erp_collections`). Cada consumidor nuevo tenía que acordarse. Esta vista es el
 * lugar donde la regla vive UNA vez; la compuerta `check:kdm5-vigente` impide leer `kdm5` crudo.
 *
 * ── La forma ───────────────────────────────────────────────────────────────────────────────
 *
 * `SELECT a.*` — las MISMAS columnas que `kepler_ods.kdm5`, así que un consumidor se migra
 * cambiando sólo el nombre de la tabla, y sus filtros siguen bajando a los índices de `kdm5`
 * (la vista es simple: Postgres la aplana). La cabecera se busca por la LLAVE de `kdm1`
 * (`kdm1_pkey`: sucursal, c1, c2, c3, c4, c5, c6) del documento dueño (`sucursal = c1`, el
 * anti-réplica). Medido: con la llave cruda salen las mismas 854 que con `btrim` (cero espacios
 * en kdm5 y kdm1), y no hace falta índice nuevo.
 *
 * Un documento cuya cabecera NO está en el ODS se conserva: no se sabe si está cancelado, y
 * quitarlo sería inventar. Sólo se excluye lo que Kepler dice que está cancelado.
 *
 * Idempotente (`CREATE OR REPLACE`). Se verifica a sí misma antes de terminar.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = 'analytics.kepler_kdm5_vigente';

const SQL_VISTA = `
  CREATE OR REPLACE VIEW ${VISTA} AS
  SELECT a.*
    FROM kepler_ods.kdm5 a
   WHERE NOT EXISTS (
     SELECT 1
       FROM kepler_ods.kdm1 k
      WHERE k.sucursal = a.c1 AND k.c1 = a.c1 AND k.c2 = a.c2 AND k.c3 = a.c3
        AND k.c4 = a.c4 AND k.c5 = a.c5 AND k.c6 = a.c6
        AND btrim(coalesce(k.c43, '')) = 'C')`;

exports.up = async function up(knex) {
  const ods = await knex.raw(`SELECT to_regclass('kepler_ods.kdm5') AS a, to_regclass('kepler_ods.kdm1') AS b`);
  // Sin ODS (entorno de dev pelado) no hay nada que derivar.
  if (!ods.rows[0]?.a || !ods.rows[0]?.b) return;

  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`SET LOCAL statement_timeout = '120s'`);
  await knex.raw(SQL_VISTA);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON ${VISTA} TO dev_ro'; END IF;
  END $$`);
  // ⛔ `COMMENT ON` no admite parámetros ligados: el texto va inlineado.
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS
    '[CSU.11] kepler_ods.kdm5 SIN las aplicaciones de documentos cancelados en Kepler (cabecera kdm1.c43 = C del documento dueno). Mismas columnas que kdm5. Toda suma de aplicaciones lee de aqui, no de kdm5: lo vigila check:kdm5-vigente.'`);

  // ── Verificación: lo que la vista quita es EXACTAMENTE lo cancelado, medido por otro camino ──
  // (el conteo independiente usa btrim y LEFT JOIN, no la llave cruda ni NOT EXISTS).
  const { rows } = await knex.raw(`
    SELECT (SELECT count(*) FROM kepler_ods.kdm5)::bigint AS kdm5,
           (SELECT count(*) FROM ${VISTA})::bigint AS vigentes,
           (SELECT count(*) FROM kepler_ods.kdm5 a
              JOIN kepler_ods.kdm1 k
                ON btrim(k.sucursal) = btrim(a.c1) AND btrim(k.c1) = btrim(a.c1) AND k.c2 = a.c2
               AND btrim(k.c3) = btrim(a.c3) AND k.c4 = a.c4 AND k.c5 = a.c5 AND btrim(k.c6) = btrim(a.c6)
             WHERE btrim(coalesce(k.c43, '')) = 'C')::bigint AS canceladas`);
  const v = rows[0];
  const quitadas = Number(v.kdm5) - Number(v.vigentes);
  if (quitadas !== Number(v.canceladas)) {
    throw new Error(`[CSU.11] la vista quitó ${quitadas} aplicaciones y hay ${v.canceladas} de documentos cancelados: no cuadra, no se publica.`);
  }
  console.log(`  [CSU.11] ${VISTA}: ${v.vigentes} vigentes de ${v.kdm5} (quitadas ${quitadas} de documentos cancelados)`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. Aborta si algo ya depende de la vista. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP VIEW IF EXISTS ${VISTA} RESTRICT`);
};
