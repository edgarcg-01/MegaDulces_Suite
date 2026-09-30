'use strict';
/**
 * `[CGU.10]` — **Familias de costo: que "Combustible" sea UNA linea y no tres.**
 *
 * ── Por que ───────────────────────────────────────────────────────────────────────────
 *
 * Reporte del usuario: *"no incluiste un gasto operativo clave que era el combustible"*. Estaba
 * incluido -- **$294,991 en 30 dias, el 13.0 % del costo** -- pero **partido en tres conceptos y
 * dos cuentas**, y ninguno se llama solo "combustible":
 *
 *     COMBUSTIBLES VENTAS              cuenta 611    $246,694
 *     COMBUSTIBLE LOGISTICOS ADMINIS   cuenta 602     $47,285
 *     GASOLINA LOGISTICA               cuenta 602      $1,012
 *
 * Juntos son el segundo gasto del negocio; por separado, el mayor es el 11 % y los otros dos se
 * pierden entre **97 conceptos**. ⭐ **Un gasto que existe pero no se puede encontrar es, para
 * quien mira la pantalla, un gasto que falta** -- y tenia razon en reclamarlo.
 *
 * ── La familia sale del CONCEPTO, no de la cuenta ─────────────────────────────────────
 *
 * ⛔ Agrupar por cuenta mayor NO junta el combustible: vive en `611` (ventas) y en `602`
 * (logisticos) a la vez. La cuenta responde "de que bolsa contable salio"; la familia responde
 * "en que se gasto", que es la pregunta de la pantalla. La cuenta queda como respaldo para lo que
 * el concepto no alcanza a clasificar.
 *
 * ── Las familias, derivadas de los conceptos que mueven el dinero (medido, 30 d) ──────
 *
 *     personal      nomina, SUA, comisiones, bonos, finiquito, caja de ahorro   ~$1,151,418
 *     combustible   los tres de arriba                                            $294,991
 *     vehiculo      arrendamiento, mantenimiento, reparacion, llantas, seguro     ~$267,352
 *     valores       traslado de valores                                            $152,418
 *     local         renta y mantenimiento del local                                 $88,814
 *     viaje         casetas, viaticos, taxis y carretas de entrega                  ~$64,767
 *     tecnologia    GPS, telefonia, sistemas                                         $28,918
 *     otros         lo que no cae en ninguna, con su nombre a la vista
 *
 * ⚠️ `otros` NO es un cajon de sastre silencioso: la pantalla lo muestra como familia propia y al
 * expandirla se ven sus conceptos. Si crece, es que falta una regla -- y se nota.
 *
 * @param { import("knex").Knex } knex
 */

/** La regla, en un solo lugar: la usan la vista y el candado. */
const FAMILIA_SQL = `
      CASE
        WHEN cc ~ 'COMBUST|GASOLIN|DIESEL'                                     THEN 'combustible'
        WHEN cc ~ 'NOMINA|SUELDO|FINIQUITO|AGUINALDO|VACACION|SUA|IMSS|INFONAVIT'
          OR cc ~ 'COMISION|BONO|CAJA DE AHORRO|PRESTAMO|PTU|INDEMNIZ'
          OR cm IN ('601', '762')                                              THEN 'personal'
        WHEN cc ~ 'ARRENDAM|MANTENIM|REPARACION|LLANTA|REFACCION|ACEITE|LUBRICANTE'
          OR cc ~ 'SUSPENSION|LAMINACION|VERIFICACION|TENENCIA|SEGURO'         THEN 'vehiculo'
        WHEN cc ~ 'CASETA|PEAJE|VIATICO|HOTEL|TAXI|CARRETA|ACARREO|ESTACIONAM' THEN 'viaje'
        WHEN cc ~ 'TRASLADO DE VALORES|CUSTODIA'                               THEN 'valores'
        WHEN cc ~ 'LOCAL|RENTA|LUZ|AGUA|PREDIAL|VIGILANCIA|LIMPIEZA'           THEN 'local'
        WHEN cc ~ 'GPS|TELEFON|SISTEMA|SOFTWARE|RECARGA|INTERNET|COMPUT'       THEN 'tecnologia'
        ELSE 'otros'
      END`;

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('analytics.v_logistics_expense_channel') IS NOT NULL
        AND to_regclass('analytics.mv_logistics_guide_cost')     IS NOT NULL) AS ok`)).rows;
  if (!ok) throw new Error('[CGU.10] faltan la vista de gasto o la matview de costo');

  // 1) La vista: `familia_costo` pasa a derivarse del CONCEPTO. Es la ultima columna, asi que
  //    CREATE OR REPLACE puede cambiar su expresion sin tocar el orden.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_logistics_expense_channel
      WITH (security_invoker = true) AS
    SELECT
      e.tenant_id,
      e.fecha::date AS dia,
      CASE
        WHEN e.dpto_nombre ~* 'TLMK'                           THEN 'cliente'
        WHEN e.dpto_nombre ~* '(^| )RD( |$)|RUTAS? +DIRECTAS?' THEN 'carga_ruta'
        WHEN e.dpto_nombre ~* 'LOGISTICA'                      THEN 'traspaso'
        WHEN e.dpto_nombre ~* 'VECINAL'                        THEN 'vecinal'
        WHEN e.dpto_nombre ~* 'PISO'                           THEN 'piso_venta'
        ELSE 'otros'
      END AS canal,
      COALESCE(NULLIF(btrim(e.concepto_nombre), ''), '(sin concepto)') AS concepto,
      left(e.cuenta, 3) AS cuenta_mayor,
      (e.dpto_nombre IS NULL OR btrim(e.dpto_nombre) = '') AS sin_dpto,
      count(*)::int AS lineas,
      round(sum(e.importe * CASE WHEN e.cargo_abono = 'A' THEN -1 ELSE 1 END)::numeric, 2) AS gasto,
      ${FAMILIA_SQL.replace(/\bcc\b/g, "upper(COALESCE(e.concepto_nombre,''))")
                   .replace(/\bcm\b/g, 'left(e.cuenta, 3)')} AS familia_costo
    FROM analytics.expense_entries e
    WHERE (left(e.cuenta, 1) = '6' OR left(e.cuenta, 3) = '762')
      AND left(e.cuenta, 3) NOT IN ('150', '511', '702', '761', '763')
    GROUP BY 1, 2, 3, 4, 5, 6, 9
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_logistics_expense_channel TO app_runtime`);

  // 2) La matview tiene que TRAER la familia: nombra sus columnas, asi que agregarla a la vista
  //    no basta. Se recrea con la columna nueva, derivada del concepto igual que arriba -- la
  //    regla vive en una sola constante para que no puedan divergir.
  // ⚠️ Renombrar la matview NO renombra sus indices: los nombres quedan ocupados por la vieja y
  // el CREATE de los nuevos choca con "already exists". Se renombran tambien, a mano.
  await knex.raw(`
    ALTER MATERIALIZED VIEW analytics.mv_logistics_guide_cost
      RENAME TO mv_logistics_guide_cost_old`);
  await knex.raw(`ALTER INDEX analytics.ux_mv_logistics_guide_cost RENAME TO ux_mv_lgc_old`);
  await knex.raw(`ALTER INDEX analytics.ix_mv_logistics_guide_cost_dia RENAME TO ix_mv_lgc_dia_old`);
  const [{ def }] = (await knex.raw(`
    SELECT pg_get_viewdef('analytics.mv_logistics_guide_cost_old'::regclass, true) AS def`)).rows;

  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_logistics_guide_cost AS
    SELECT z.*,
           ${FAMILIA_SQL.replace(/\bcc\b/g, 'upper(z.concepto)')
                        .replace(/\bcm\b/g, 'z.cuenta_mayor')} AS familia_costo
      FROM ( ${def.replace(/;\s*$/, '')} ) z
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_logistics_guide_cost
      ON analytics.mv_logistics_guide_cost
         (tenant_id, dia, sucursal, guia, canal, concepto, cuenta_mayor, fuente, ventana)`);
  await knex.raw(`
    CREATE INDEX ix_mv_logistics_guide_cost_dia
      ON analytics.mv_logistics_guide_cost (tenant_id, dia)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_logistics_guide_cost TO app_runtime`);
  await knex.raw(`DROP MATERIALIZED VIEW analytics.mv_logistics_guide_cost_old`);

  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW analytics.mv_logistics_guide_cost IS
    $$[CGU.10] Costo por guia y concepto, con familia_costo para que la pantalla agrupe. La
    familia sale del CONCEPTO y no de la cuenta: el combustible vive en 611 y 602 a la vez, asi
    que agrupar por cuenta lo deja partido -- que es justo lo que hizo que un gasto de 294,991
    (13.0% del total) pareciera ausente, repartido en tres conceptos entre 97. Un gasto que existe
    pero no se puede encontrar es, para quien mira, un gasto que falta. 'otros' se publica como
    familia propia y expandible: si crece, falta una regla y se nota.$$`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_logistics_guide_cost_old`);
};
