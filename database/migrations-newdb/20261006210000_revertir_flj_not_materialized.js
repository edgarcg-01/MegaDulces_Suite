/**
 * `[CG.41.1]` — **REVIERTE `[CG.41]`: el `NOT MATERIALIZED` era una regresión, no una mejora.**
 *
 * ── Qué pasó ────────────────────────────────────────────────────────────────────────────────
 *
 * `20261006170000` hizo dos cosas: creó `kepler_ods.ix_kdm1_tesoreria_fecha` y reescribió el CTE
 * `flj` de `analytics.kepler_bank_movements` a `NOT MATERIALIZED`. Se aplicó a prod el 2026-10-06
 * (batch 737). **Las dos hay que deshacerlas**, y lo decide la medición contra prod, no un
 * argumento sobre el planificador.
 *
 * ── La medición, cara a cara sobre la MISMA definición de vista ──────────────────────────────
 *
 * Las dos formas se corrieron como subconsulta (`WITH v AS (<viewdef>)`) sin tocar la vista viva:
 *
 * | consulta real                                   | NOT MATERIALIZED | MATERIALIZED |
 * |-------------------------------------------------|-----------------:|-------------:|
 * | `cajas()` — **una de las 9 del arranque de CG**  |      52,521 ms   |      898 ms  |
 * | el leg de Conciliación — *para el que se hizo*   |      11,787 ms   |      793 ms  |
 *
 * ⛔ **Es peor hasta para la consulta que el cambio pretendía arreglar**: 15×. Y en
 * `cajas()` es **58×**. `pg_stat_statements` lo confirma desde el otro lado: esa consulta tiene
 * DOS entradas, la vieja con 64 llamadas a **8,697 ms** de media y la nueva —abierta el 2026-10-06
 * a las 20:41 UTC, que es cuando se midió— con **52,013 ms**.
 *
 * ⭐ **La lección: se midió el efecto sobre UNA consulta y se cambió una vista COMPARTIDA.**
 * `analytics.kepler_bank_movements` la leen 11 consultas de finanzas. `flj` está referenciado dos
 * veces, y Postgres materializa por defecto justamente porque inlinearlo lo hace evaluar dos
 * veces; el "697 → 475 ms" que `[CG.41]` reportó no se reprodujo contra la vista real.
 *
 * ── Y el índice: 0 escaneos ─────────────────────────────────────────────────────────────────
 *
 * `pg_stat_user_indexes` sobre `kepler_ods.kdm1`, con el índice ya en prod y la pantalla en uso:
 * **`idx_scan = 0`, `idx_tup_read = 0`**. Nunca se usó — que es lo que `[CG.41]` ya había medido
 * ("index-only: nada") y aun así se desplegó, apostando a que serviría junto con la forma del CTE.
 * No sirvió. Se va: `kdm1` es la tabla caliente del CDC y cada índice grava cada inserción.
 *
 * ⚠️ `idx_kdm1_tesoreria_c45` **también está en 0** y es anterior a esta fase. NO se toca acá —
 * no es de este commit y borrar un índice ajeno sin su dueño es exactamente lo que esta migración
 * está corrigiendo. Queda anotado.
 *
 * ⚠️ El `CREATE OR REPLACE VIEW` conserva dueño y privilegios, pero el GRANT se re-aplica
 * explícito: esta casa ya perdió un GRANT en un replace y sólo lo vio una aserción de metadata
 * (ADR-057). Medido antes de escribir esto, la vista tiene `app_runtime=r` y `dev_ro=r`.
 */

exports.config = { transaction: false };   // DROP INDEX CONCURRENTLY no corre en transacción

const VISTA = 'analytics.kepler_bank_movements';
const IDX = 'ix_kdm1_tesoreria_fecha';
const MARCA_NM = ', flj AS NOT MATERIALIZED (';
const MARCA_MAT = ', flj AS (';

/** Literal SQL: los comandos de utilidad (`COMMENT ON`) no aceptan binds. Ver `[CG.40.1]`. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const COMENTARIO = `[CG.41.1] El CTE flj va MATERIALIZADO (el default). Se probo NOT MATERIALIZED `
  + `el 2026-10-06 y fue una REGRESION medida contra prod: cajas() 898 ms -> 52,521 ms (58x) y el `
  + `leg de Conciliacion 793 ms -> 11,787 ms (15x), o sea peor hasta para la consulta que el cambio `
  + `buscaba arreglar. flj esta referenciado DOS veces; inlinearlo lo hace evaluar dos veces. `
  + `Esta vista la leen 11 consultas de finanzas: medir una y cambiar la vista es cambiarlas todas.`;

async function ponerForma(knex, desde, hasta) {
  const [{ d }] = (await knex.raw(`SELECT pg_get_viewdef('${VISTA}'::regclass) AS d`)).rows;
  const def = String(d).replace(/;\s*$/, '');
  if (!def.includes(desde)) {
    // ⛔ Si el marcador no está, la vista ya no es la que esta migración midió: parar y decirlo,
    // nunca "arreglar" a ciegas una definición que alguien más movió.
    throw new Error(`[CG.41.1] No se encontro el marcador ${JSON.stringify(desde)} en ${VISTA}. `
      + `La definicion cambio desde que se midio; revisarla a mano antes de seguir.`);
  }
  const nueva = def.replace(desde, hasta);
  await knex.raw(`CREATE OR REPLACE VIEW ${VISTA} AS ${nueva}`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);
}

exports.up = async function up(knex) {
  await ponerForma(knex, MARCA_NM, MARCA_MAT);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS ${lit(COMENTARIO)}`);
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${IDX}`);
};

exports.down = async function down(knex) {
  // La vuelta reconstruye lo que `20261006170000` dejó. No se recomienda: está medido como peor.
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX}
                      ON kepler_ods.kdm1 (((c9)::date))
                   WHERE btrim(COALESCE(c45, '')) <> ''`);
  await ponerForma(knex, MARCA_MAT, MARCA_NM);
  await knex.raw(`COMMENT ON VIEW ${VISTA} IS NULL`);
};
