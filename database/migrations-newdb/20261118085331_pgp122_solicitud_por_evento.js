'use strict';
/**
 * `[PGP.122]` R1 por EVENTO (anexo S §17.6) — cuando el ODS recibe una solicitud X-A-15 con la marca de la Suite
 * (`c26 = 'SUITE SG-…'`), o le cambia el estado (`c43`, la cancelación), la base AVISA `solicitud_gasto_kepler`. El
 * worker escucha (`SolicitudPorEventoService`) y corre el lazo de después de escribir: `written → seen_in_ods`, la
 * cancelación en Kepler llega al vale, las huérfanas. Edgar, 2026-11-10: «ningún cron».
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-18) ────────────────────────────────────────────────────────
 *  · `kepler_ods.kdm1` ya lleva 8 disparadores POR SENTENCIA (`tg_bml_*`, `tg_exs_*`): el patrón es el de ADR-104.
 *  · Escrituras desde el último reinicio de estadísticas: 72,682 altas, 125,841 cambios, 2,893 bajas.
 *  · Solicitudes con la marca de la Suite en el ODS: 0 (la escritura sigue apagada en las 9). El disparador casi
 *    nunca encuentra nada: su costo es recorrer las filas de la sentencia con un filtro barato (`c2`, `c3`, `c4`).
 *
 * ── Qué crea ───────────────────────────────────────────────────────────────────────────────────────────────
 *  · `finance.tg_solicitud_suite_kdm1()`: SÓLO avisa (`pg_notify`), no escribe nada. No hay cola: el lazo lee el
 *    estado de verdad (vale contra `analytics.expense_requests`), así que un aviso perdido no pierde nada — lo encuentra
 *    el aviso siguiente, la mirada al arrancar o al volver el LISTEN, y el árbitro de 5 min mientras no se retire.
 *  · `tg_solicitud_suite_ins` (alta) y `tg_solicitud_suite_upd` (cambio de `c43` o `c26`; un cambio en otra columna
 *    no avisa). Las bajas no: Kepler cancela, no borra.
 *  · ⭐ Nunca frena la ingesta: atrapa su error y lo dice con `RAISE WARNING` (no hay tabla de errores: no escribe).
 *
 * ⛔ FUERA DE HORARIO (regla 9): cada CREATE TRIGGER toma SHARE ROW EXCLUSIVE sobre `kdm1` (frena escrituras de la
 *    ingesta, no lecturas) hasta el COMMIT. CREATE OR REPLACE, no DROP + CREATE (DROP TRIGGER toma ACCESS EXCLUSIVE).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const CANAL = 'solicitud_gasto_kepler';
/** La solicitud que escribió la Suite: X-A-15 serie 1 con su marca. */
const ES_DE_LA_SUITE = (r) => `${r}.c2 = 'X' AND ${r}.c3 = 'A' AND ${r}.c4 = 15 AND ${r}.c5 = 1 AND btrim(${r}.c26) LIKE 'SUITE SG-%'`;
const MISMA_FILA = ['sucursal', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((c) => `o.${c} = n.${c}`).join(' AND ');

const FUNCION = `
  CREATE OR REPLACE FUNCTION finance.tg_solicitud_suite_kdm1()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $fn$
  BEGIN
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF EXISTS (SELECT 1 FROM new_rows n WHERE ${ES_DE_LA_SUITE('n')}) THEN
          PERFORM pg_notify('${CANAL}', 'alta');
        END IF;
      ELSIF TG_OP = 'UPDATE' THEN
        -- Sólo si la fila de la Suite cambió de estado o de marca: la ingesta reescribe sin cambiar nada a menudo.
        IF EXISTS (SELECT 1 FROM new_rows n WHERE ${ES_DE_LA_SUITE('n')}
                      AND NOT EXISTS (SELECT 1 FROM old_rows o WHERE ${MISMA_FILA}
                                         AND o.c43 IS NOT DISTINCT FROM n.c43 AND o.c26 IS NOT DISTINCT FROM n.c26)) THEN
          PERFORM pg_notify('${CANAL}', 'cambio');
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[PGP.122] tg_solicitud_suite_kdm1 (%): % — la escritura pasa, el árbitro de 5 min la encuentra', TG_OP, SQLERRM;
    END;
    RETURN NULL;
  END
  $fn$`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [r] } = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') IS NOT NULL AS hay`);
  if (!r.hay) {
    console.log('[PGP.122] sin kepler_ods.kdm1 (entorno sin ODS): no hay nada que poner por evento.');
    return;
  }
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  await knex.raw(FUNCION);
  await knex.raw(`COMMENT ON FUNCTION finance.tg_solicitud_suite_kdm1() IS
    '[PGP.122] Avisa ${CANAL} cuando llega o cambia de estado (c43) una X-A-15 con la marca de la Suite. Sólo avisa: el lazo lo corre SolicitudPorEventoService.'`);
  await knex.raw(`CREATE OR REPLACE TRIGGER tg_solicitud_suite_ins
    AFTER INSERT ON kepler_ods.kdm1 REFERENCING NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION finance.tg_solicitud_suite_kdm1()`);
  await knex.raw(`CREATE OR REPLACE TRIGGER tg_solicitud_suite_upd
    AFTER UPDATE ON kepler_ods.kdm1 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT EXECUTE FUNCTION finance.tg_solicitud_suite_kdm1()`);
  console.log(`[PGP.122] kepler_ods.kdm1: tg_solicitud_suite_ins y tg_solicitud_suite_upd avisan ${CANAL}.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [r] } = await knex.raw(`SELECT to_regclass('kepler_ods.kdm1') IS NOT NULL AS hay`);
  if (r.hay) {
    await knex.raw(`DROP TRIGGER IF EXISTS tg_solicitud_suite_ins ON kepler_ods.kdm1`);
    await knex.raw(`DROP TRIGGER IF EXISTS tg_solicitud_suite_upd ON kepler_ods.kdm1`);
  }
  await knex.raw(`DROP FUNCTION IF EXISTS finance.tg_solicitud_suite_kdm1()`);
};

exports.CANAL = CANAL;
