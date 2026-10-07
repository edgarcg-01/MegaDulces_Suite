'use strict';
/**
 * `[CGU.1]` — **`analytics.v_logistics_activity_daily`: que movio cada guia, por dia y por canal.**
 *
 * Es el denominador del reparto de `[CGU.2]`. El gasto llega a canal + dia (`[CGU.0]`); para
 * bajarlo a la guia hace falta saber cuanto trabajo hizo cada guia ese dia, y la unidad de trabajo
 * elegida (decision del usuario) es la **PARADA**: una parada = una entrega.
 *
 * ── El grano: (sucursal, guia, dia) ───────────────────────────────────────────────────
 *
 * Una fila de `erp_shipment_headers` es una PARADA (un embarque `U-D-41`); la **guia**
 * (`guia_embarque`) es el VIAJE que las agrupa. Medido: ~2,500 guias agrupan ~5,700 embarques,
 * hasta 19 paradas en una.
 *
 * ⚠️ El dia va en la llave **a proposito, aunque hoy no haga falta**: medido sobre agosto-2026,
 * **0 guias cruzan mas de un dia**. Pero el gasto se reparte por dia, asi que si alguna vez una
 * guia abarca dos dias, con el grano (sucursal, guia) a secas habria que decidir a cual de los dos
 * dias cargarla -- y esa decision se tomaria sola y en silencio. Con el dia en la llave, la guia
 * aporta sus paradas a cada dia y el reparto sigue cuadrando.
 *
 * ── La clasificacion de canal ─────────────────────────────────────────────────────────
 *
 * Por DESTINO (`cliente_code` / `destino_nombre`), no por la serie del documento:
 *
 *     cliente_code ~ '^TI' o destino ~ TRASPASO|SUCURSAL   -> traspaso    (entre almacenes propios)
 *     cliente_code ~ '^(RUTA|RD)' o destino ~ '^R.D.'      -> carga_ruta  (surtido a camioneta)
 *     resto                                                -> cliente     (el unico que factura)
 *
 * ⛔ **NO usar `erp_shipment_headers.canal`.** Solo tiene `SUCURSAL` / `TELEMARK`, que es la SERIE
 * del documento, y **la serie mezcla dos operaciones distintas**: medido, 52 embarques de serie 2
 * por **$803,113.99** son carga a camioneta de reparto y no traspaso a sucursal. Clasificar por
 * serie mete ese dinero en el canal equivocado.
 *
 * ⚠️ `SUSUCRSAL` esta en el regex a proposito: es un typo real del catalogo de Kepler
 * (`SUSUCRSAL 8 ESQUINAS`, $686.73 medidos). Sin el, esa fila cae en `cliente` y ensucia el unico
 * canal al que se le publica margen.
 *
 * ── Por que no vive aqui el reparto ───────────────────────────────────────────────────
 *
 * Esta vista solo cuenta trabajo. El cociente `paradas_guia / paradas_dia` y el reparto del bucket
 * `otros` se hacen en `[CGU.2]`, donde cada fila puede declarar su `origen`.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(
    `SELECT to_regclass('analytics.erp_shipment_headers') IS NOT NULL AS ok`
  )).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  falta analytics.erp_shipment_headers - vista omitida');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_logistics_activity_daily
      WITH (security_invoker = true) AS
    SELECT
      h.tenant_id,
      h.fecha::date AS dia,
      h.sucursal,
      COALESCE(NULLIF(btrim(h.guia_embarque), ''), '(sin guia)') AS guia,
      CASE
        WHEN h.cliente_code ~ '^TI'
          OR h.destino_nombre ~* 'TRASPASO|^SUCURSAL|SUSUCRSAL'      THEN 'traspaso'
        WHEN h.cliente_code ~* '^(RUTA|RD)[ 0-9]'
          OR h.destino_nombre ~* '^R\\.D\\.'                          THEN 'carga_ruta'
        ELSE 'cliente'
      END AS canal,
      count(*)::int                    AS paradas,
      round(sum(h.total)::numeric, 2)  AS mercancia,
      min(h.serie)::int                AS serie_min,
      max(h.serie)::int                AS serie_max,
      -- La unidad se conserva para poder cruzar con el GPS donde exista. NO se usa para costear:
      -- medido, el 64% de los embarques corre en unidades sin rastreador.
      min(h.transporte_clave_kepler)   AS transporte_clave,
      count(DISTINCT h.vehicle_id)::int AS unidades,
      max(h.computed_at)               AS computed_at
    FROM analytics.erp_shipment_headers h
    GROUP BY 1, 2, 3, 4, 5
  `);

  await knex.raw(`GRANT SELECT ON analytics.v_logistics_activity_daily TO app_runtime`);

  await knex.raw(`
    COMMENT ON VIEW analytics.v_logistics_activity_daily IS
    $$[CGU.1] Trabajo de cada guia por dia y canal: paradas (la unidad de reparto elegida),
    mercancia movida y la unidad que la hizo. Grano (sucursal, guia, dia); el dia va en la llave
    aunque hoy 0 guias crucen dias, para que un caso futuro no elija dia en silencio. El canal sale
    del DESTINO, NUNCA de la serie: la serie 2 mezcla traspaso a sucursal con carga a camioneta de
    reparto (medido, 52 embarques / 803,113.99). SUSUCRSAL es un typo real del catalogo de Kepler y
    esta en el regex a proposito. serie_min/serie_max delatan una guia que lleva dos series.$$
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_logistics_activity_daily`);
};
