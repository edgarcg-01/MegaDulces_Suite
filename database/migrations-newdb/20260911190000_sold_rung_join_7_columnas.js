/**
 * R.5 — MI JOIN ABANICABA. `mv_kepler_sold_rung` pasa de 5 a 7 columnas.
 *
 * ⚠️ **Este es un defecto mío, de anteayer, y estaba en prod.** `mv_kepler_sold_rung` (KX.5, mig
 * `20260910130000`) une `kdm2 ↔ kdm1` por **5 columnas** — `(sucursal, c2, c3, c4, c6)`. El cómputo
 * canónico del repo (`services/feeds-ingest/ods-derived.js:258-263`) usa las **7 de la PK** y
 * documenta explícitamente que unir de menos **casa el documento equivocado**. No lo seguí.
 *
 * ── Medido contra prod (2026-09-11) ─────────────────────────────────────────────────────────
 *
 * ```text
 * kdm1 (90 d) ......... 246,530 filas
 *   llaves por 5 col .. 196,892      <- 22,855 encabezados COMPARTEN la llave de 5
 *   llaves por 7 col .. 246,530      <- unica
 *
 * dano en la MV:  183 pares con rung_max DISTINTO
 *                 19,527 pares con `renglones` inflados
 *                 166 pares faltantes
 * ```
 *
 * `rung_max` es lo que usa el **piso del factor de caja** en `v_warehouse_box_factor`, así que un
 * `rung_max` contaminado puede aplicar el piso donde no corresponde — o no aplicarlo donde sí.
 *
 * ⚠️ Y el detalle que importa para no exagerar el hallazgo: **la medición de `U-D-8` que abrió la
 * Fase R NO depende de este defecto** — da idéntica con 5 y con 7 columnas (16,928 renglones,
 * $16,197,173, `c58` 99.97%). Esos doctypes no comparten la llave corta.
 *
 * ── ⛔ Por qué NO se hace con DROP, y esto es la parte que importa ───────────────────────────
 *
 * El primer intento fue `DROP VIEW v_warehouse_box_factor` + `DROP MATERIALIZED VIEW` + recrear.
 * Falló, y por una razón que conviene dejar escrita: **la cadena es más larga de lo que parece.**
 *
 * ```text
 * mv_kepler_sold_rung  <-  v_warehouse_box_factor  <-  v_unit_truth
 *                                                  <-  v_existencia_dictamen
 *                                                  <-  v_unit_rung_audit
 * ```
 *
 * Tirar la vista de en medio obliga a recrear **cuatro** objetos vivos que otras sesiones están
 * leyendo, y cada uno con sus `reloptions` y sus `GRANT` que no se heredan (lección U.7). Demasiada
 * superficie para arreglar un join.
 *
 * El camino correcto usa la propiedad de que **`CREATE OR REPLACE VIEW` conserva a los dependientes**
 * mientras la lista de columnas no cambie, y que **las vistas referencian por OID, no por nombre**:
 *
 *   1. crear la matvista corregida con nombre temporal;
 *   2. `CREATE OR REPLACE VIEW v_warehouse_box_factor` apuntando a ella — sus tres dependientes ni
 *      se enteran;
 *   3. tirar la matvista vieja, que ya no la referencia nadie;
 *   4. renombrar la nueva al nombre canónico — la vista la sigue por OID.
 *
 * Todo en la transacción de la migración: o entra completo o no entra.
 *
 * ⛔ `CREATE INDEX CONCURRENTLY` sigue siendo una trampa en esta base (espera transacciones ajenas
 * más viejas; una migración se sentó 575 s en `Lock/virtualxid`). El índice va normal.
 *
 * @param { import("knex").Knex } knex
 */

const TMP = 'mv_kepler_sold_rung_r5';

// Las SIETE columnas de la PK de kdm1. Unir por 5 casa el documento equivocado.
const MV = `
CREATE MATERIALIZED VIEW analytics.${TMP} AS
SELECT d.sucursal,
       btrim(d.c8)                                              AS sku,
       max(NULLIF(btrim(d.c58::text), '')::numeric)             AS rung_max,
       mode() WITHIN GROUP (ORDER BY NULLIF(btrim(d.c58::text), '')::numeric) AS rung_modal,
       count(DISTINCT NULLIF(btrim(d.c58::text), '')::numeric)  AS peldanos,
       count(*)                                                 AS renglones,
       sum(d.c13::numeric)                                      AS importe,
       min(h.c9)::date                                          AS primer_visto,
       max(h.c9)::date                                          AS ultimo_visto
  FROM kepler_ods.kdm2 d
  -- R.5: las 7 columnas de la PK. Con 5, 22,855 encabezados comparten la llave y el join
  -- abanica: 183 pares tenian rung_max distinto y 19,527 los renglones inflados.
  JOIN kepler_ods.kdm1 h
    ON h.sucursal = d.sucursal AND h.c1 = d.c1 AND h.c2 = d.c2 AND h.c3 = d.c3
   AND h.c4 = d.c4 AND h.c5 = d.c5 AND h.c6 = d.c6
 WHERE d.c2 = 'U' AND d.c3 = 'D'
   AND btrim(d.c4::text) IN ('8','10','12')
   AND h.c9 >= current_date - 365
   AND d.sucursal = btrim(d.c1)
   AND NULLIF(btrim(d.c58::text), '')::numeric > 0
 GROUP BY 1, 2`;

exports.up = async function up(knex) {
  // ── El antes, para poder decir qué se movió ──
  const antes = (await knex.raw(`
    SELECT count(*)::int pares, sum(renglones)::bigint renglones
      FROM analytics.mv_kepler_sold_rung`)).rows[0];
  const pisoAntes = (await knex.raw(`
    SELECT count(*)::int n FROM analytics.v_warehouse_box_factor
     WHERE factor_source = 'kepler_peldano_vendido'`)).rows[0].n;

  // ── 1. La matvista corregida, con nombre temporal ──
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.${TMP}`);
  await knex.raw(MV);
  await knex.raw(`CREATE UNIQUE INDEX ${TMP}_pk ON analytics.${TMP} (sucursal, sku)`);
  await knex.raw(`ANALYZE analytics.${TMP}`);
  await knex.raw(`GRANT SELECT ON analytics.${TMP} TO app_runtime`);

  // ── 2. La vista apunta a la nueva. CREATE OR REPLACE conserva a sus 3 dependientes ──
  const vdef = (await knex.raw(
    `SELECT pg_get_viewdef('analytics.v_warehouse_box_factor'::regclass, true) d`)).rows[0].d;
  if (!vdef.includes('mv_kepler_sold_rung')) {
    throw new Error('v_warehouse_box_factor ya no referencia mv_kepler_sold_rung: abortado');
  }
  const vopts = (await knex.raw(`
    SELECT COALESCE(array_to_string(c.reloptions, ','), '') o
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = 'v_warehouse_box_factor'`)).rows[0].o;

  const vdefNueva = vdef.replace(/mv_kepler_sold_rung\b/g, TMP);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor AS ${vdefNueva}`);

  // ── 3 y 4. Tirar la vieja y renombrar: la vista la sigue por OID ──
  await knex.raw(`DROP MATERIALIZED VIEW analytics.mv_kepler_sold_rung`);
  await knex.raw(`ALTER MATERIALIZED VIEW analytics.${TMP} RENAME TO mv_kepler_sold_rung`);
  await knex.raw(`ALTER INDEX analytics.${TMP}_pk RENAME TO mv_kepler_sold_rung_pk`);

  // ⚠️ U.7: security_invoker y el GRANT NO se heredan tras CREATE OR REPLACE.
  if (vopts.includes('security_invoker')) {
    await knex.raw(`ALTER VIEW analytics.v_warehouse_box_factor SET (security_invoker = true)`);
  }
  await knex.raw(`GRANT SELECT ON analytics.v_warehouse_box_factor TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_kepler_sold_rung IS
    'KX.5 + R.5: el peldano COBRADO por sucursal x SKU (max kdm2.c58, ventana 365 d), unido a kdm1 por las SIETE columnas de la PK -- con 5 abanicaba (22,855 encabezados comparten la llave corta): 183 pares tenian rung_max distinto y 19,527 los renglones inflados. NO es el factor de caja: solo se usa como piso cuando el factor publicado es 1. Refresca AnalyticsRefreshService (job analytics_refresh_sold_rung).'`);

  // ── Auto-verificación ──
  const despues = (await knex.raw(`
    SELECT count(*)::int pares, sum(renglones)::bigint renglones
      FROM analytics.mv_kepler_sold_rung`)).rows[0];
  const pisoDespues = (await knex.raw(`
    SELECT count(*)::int n FROM analytics.v_warehouse_box_factor
     WHERE factor_source = 'kepler_peldano_vendido'`)).rows[0].n;

  console.log(`  [sold-rung] pares ${antes.pares} -> ${despues.pares}`
    + ` · renglones ${Number(antes.renglones).toLocaleString('en-US')}`
    + ` -> ${Number(despues.renglones).toLocaleString('en-US')}`
    + ` · piso del factor de caja ${pisoAntes} -> ${pisoDespues}`);

  if (Number(despues.renglones) >= Number(antes.renglones)) {
    throw new Error(`los renglones no bajaron (${antes.renglones} -> ${despues.renglones}): `
      + 'el join corregido tendría que deshacer el abanico');
  }
  if (despues.pares < antes.pares) {
    throw new Error(`se perdieron pares (${antes.pares} -> ${despues.pares})`);
  }
  // El nombre temporal no puede sobrevivir: dos matvistas del mismo dato es lo que la regla
  // principal del proyecto prohibe.
  const sobra = (await knex.raw(`SELECT to_regclass('analytics.${TMP}') t`)).rows[0].t;
  if (sobra) throw new Error(`quedo ${TMP} viva: habria dos matvistas del mismo dato`);
  // Y las tres dependientes siguen en pie.
  for (const v of ['v_unit_truth', 'v_existencia_dictamen', 'v_unit_rung_audit']) {
    const t = (await knex.raw(`SELECT to_regclass('analytics.${v}') t`)).rows[0].t;
    if (!t) throw new Error(`${v} desaparecio al recrear v_warehouse_box_factor`);
  }
  const filas = (await knex.raw(
    `SELECT count(*)::int n FROM analytics.v_warehouse_box_factor`)).rows[0].n;
  if (filas < 150000) throw new Error(`v_warehouse_box_factor quedo con ${filas} filas`);
  if (pisoDespues > 400) throw new Error(`el piso aplico a ${pisoDespues} filas: muchas mas`);
};

exports.down = async function down() {
  // No se revierte a 5 columnas: seria volver a casar el documento equivocado.
};
