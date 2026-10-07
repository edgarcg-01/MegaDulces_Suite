'use strict';
/**
 * `[CGU.9]` — **El bucket que se reparte queda acotado: no se prorratea la administracion de
 * toda la empresa al costo de un viaje.**
 *
 * ── El error que esta migracion corrige, medido ───────────────────────────────────────
 *
 * `[CGU.8]` amplio el universo del gasto de 4 cuentas a toda la familia `6xx`, y eso estuvo bien:
 * destapo **$8.7 M de sueldos** de los departamentos logisticos que no se estaban contando. Pero
 * arrastro un efecto que no estaba previsto: el canal residual `otros` -- el que se **reparte**
 * entre las guias -- paso de **$356k a $2,922,778 en 30 dias**, porque ahora captura la familia
 * `6xx` de TODOS los departamentos.
 *
 * Lo que entro ahi: `FINANZAS` $230,294 · `CAPITAL HUMANO` $227,220 · `DIRECCION GENERAL`
 * $193,948 · `SISTEMAS` $135,419 · `MORELIA ABASTOS` $578,100. Prorratearlo significa **cargarle
 * el sueldo de Direccion General al costo de un viaje de reparto**.
 *
 * ⛔ **Sobre-atribuir es tan falso como subdeclarar, y es mas dificil de notar**: el total sube,
 * la pantalla se ve mas "completa", y nadie sospecha de un numero que crecio. Se detecto porque
 * el costo de 30 dias se multiplico por 3.9 cuando la medicion predecia 1.94, y esa diferencia
 * no cerraba contra el gasto anual de los departamentos ($4.85 M x 12 = $58 M contra $22.8 M).
 *
 * ── El criterio ───────────────────────────────────────────────────────────────────────
 *
 * Se reparte solo el gasto **inequivocamente logistico aunque su departamento no lo diga**:
 * cuentas `602` (transporte), `604` (mobiliario/equipo), `606` (acarreo) y `611` (venta). Un
 * combustible sin departamento se reparte; un sueldo de Finanzas no.
 *
 * ⭐ El gasto de los departamentos logisticos **no se toca**: ahi entra su familia `6xx` completa,
 * sueldos incluidos, porque de ese centro de costo si sabemos a que canal pertenece.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('analytics.v_logistics_expense_channel') IS NOT NULL
        AND to_regclass('analytics.v_logistics_activity_daily')  IS NOT NULL) AS ok`)).rows;
  if (!ok) throw new Error('[CGU.9] faltan las vistas de CGU.0/CGU.1');

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_logistics_guide_cost`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_logistics_guide_cost AS
    WITH canales AS (
      -- Los tres canales que mueven guias. 'vecinal' y 'piso_venta' NO embarcan: su gasto es real
      -- pero no tiene guia a la cual atribuirse, y meterlos aqui inventaria un denominador.
      SELECT unnest(ARRAY['cliente', 'carga_ruta', 'traspaso']) AS canal
    ), act AS (
      SELECT a.tenant_id, a.dia, date_trunc('month', a.dia)::date AS mes,
             a.sucursal, a.guia, a.canal, a.paradas
        FROM analytics.v_logistics_activity_daily a
        JOIN canales c ON c.canal = a.canal
    ), periodicidad AS (
      SELECT tenant_id, date_trunc('month', dia)::date AS mes, concepto,
             count(DISTINCT dia)::int AS dias_con_asiento,
             CASE WHEN count(DISTINCT dia) <= 5 THEN 'periodico' ELSE 'diario' END AS periodicidad
        FROM analytics.v_logistics_expense_channel
       GROUP BY 1, 2, 3
    ), otros_bucket AS (
      -- ⛔ ACOTADO A CUENTAS DE TRANSPORTE, y esto es una correccion medida, no una precaucion.
      -- Al ampliar el universo a toda la familia 6xx (CGU.8), el canal 'otros' paso de $356k a
      -- **$2,922,778 en 30 dias** y se llevo adentro a FINANZAS, CAPITAL HUMANO, DIRECCION
      -- GENERAL y SISTEMAS. Repartirlo cargaba el sueldo de Direccion al costo de un viaje de
      -- reparto -- tan falso como subdeclararlo, y mas dificil de notar porque el total sube.
      -- Se reparte solo lo que es inequivocamente logistico aunque su departamento no lo diga:
      -- combustible, mantenimiento, casetas, acarreo. Un sueldo de Finanzas NO se reparte.
      SELECT g.tenant_id, g.dia, date_trunc('month', g.dia)::date AS mes,
             g.concepto, g.cuenta_mayor, sum(g.gasto) AS gasto
        FROM analytics.v_logistics_expense_channel g
       WHERE g.canal = 'otros'
         AND g.cuenta_mayor IN ('602', '604', '606', '611')
       GROUP BY 1, 2, 3, 4, 5
    ), paradas_canal_dia AS (
      SELECT tenant_id, dia, canal, sum(paradas)::int AS paradas FROM act GROUP BY 1, 2, 3
    ), paradas_dia_total AS (
      SELECT tenant_id, dia, sum(paradas)::int AS paradas FROM act GROUP BY 1, 2
    ), gasto_otros AS (
      -- El bucket administrativo baja a canal proporcional a las paradas de ese dia.
      SELECT o.tenant_id, o.dia, o.mes, d.canal, o.concepto, o.cuenta_mayor,
             o.gasto * d.paradas::numeric / t.paradas AS gasto
        FROM otros_bucket o
        JOIN paradas_dia_total t ON t.tenant_id = o.tenant_id AND t.dia = o.dia
        JOIN paradas_canal_dia d ON d.tenant_id = o.tenant_id AND d.dia = o.dia
       WHERE t.paradas > 0
    ), gasto AS (
      SELECT g.tenant_id, g.dia, date_trunc('month', g.dia)::date AS mes, g.canal,
             g.concepto, g.cuenta_mayor, g.gasto, 'departamento'::text AS fuente
        FROM analytics.v_logistics_expense_channel g
        JOIN canales c ON c.canal = g.canal
      UNION ALL
      SELECT tenant_id, dia, mes, canal, concepto, cuenta_mayor, gasto, 'otros_admin'::text
        FROM gasto_otros
    ), gasto_marcado AS (
      SELECT g.*, p.periodicidad, p.dias_con_asiento
        FROM gasto g
        JOIN periodicidad p
          ON p.tenant_id = g.tenant_id AND p.mes = g.mes AND p.concepto = g.concepto
    ),
    -- Los dos buckets. El periodico se AGREGA por mes antes de repartir: si no, un concepto que
    -- se asienta 4 veces produciria 4 filas con el mismo grano para la misma guia y el UNIQUE
    -- reventaria (o peor, con otro grano, se contaria 4 veces).
    bucket_diario AS (
      SELECT tenant_id, dia, mes, canal, concepto, cuenta_mayor, fuente, sum(gasto) AS gasto
        FROM gasto_marcado WHERE periodicidad = 'diario'
       GROUP BY 1, 2, 3, 4, 5, 6, 7
    ), bucket_periodico AS (
      SELECT tenant_id, mes, canal, concepto, cuenta_mayor, fuente, sum(gasto) AS gasto
        FROM gasto_marcado WHERE periodicidad = 'periodico'
       GROUP BY 1, 2, 3, 4, 5, 6
    ), den_dia AS (
      SELECT tenant_id, dia, canal, sum(paradas)::int AS paradas, count(*)::int AS n_guias
        FROM act GROUP BY 1, 2, 3
    ), den_mes AS (
      SELECT tenant_id, mes, canal, sum(paradas)::int AS paradas, count(*)::int AS n_guias
        FROM act GROUP BY 1, 2, 3
    )
    -- A) Gasto DIARIO -> se reparte entre las guias del canal-DIA.
    SELECT
      a.tenant_id, a.dia, a.sucursal, a.guia, a.canal,
      b.concepto, b.cuenta_mayor, b.fuente,
      'diario'::text AS ventana,
      a.paradas::int AS paradas_guia,
      d.paradas      AS paradas_bucket,
      d.n_guias      AS n_guias_bucket,
      round((b.gasto * a.paradas / d.paradas)::numeric, 2) AS atribuido,
      CASE WHEN d.n_guias = 1 THEN 'directo' ELSE 'atribuido' END AS origen,
      now() AS computed_at
    FROM bucket_diario b
    JOIN den_dia d ON d.tenant_id = b.tenant_id AND d.dia = b.dia AND d.canal = b.canal
    JOIN act a     ON a.tenant_id = b.tenant_id AND a.dia = b.dia AND a.canal = b.canal
    UNION ALL
    -- B) Gasto PERIODICO -> se reparte entre las guias del canal-MES. La fila se cuelga del dia
    -- de la GUIA, no del dia en que se asento el gasto: el costo fijo pertenece al mes entero.
    SELECT
      a.tenant_id, a.dia, a.sucursal, a.guia, a.canal,
      b.concepto, b.cuenta_mayor, b.fuente,
      'mes'::text,
      a.paradas::int, m.paradas, m.n_guias,
      round((b.gasto * a.paradas / m.paradas)::numeric, 2),
      CASE WHEN m.n_guias = 1 THEN 'directo' ELSE 'atribuido' END,
      now()
    FROM bucket_periodico b
    JOIN den_mes m ON m.tenant_id = b.tenant_id AND m.mes = b.mes AND m.canal = b.canal
    JOIN act a     ON a.tenant_id = b.tenant_id AND a.mes = b.mes AND a.canal = b.canal
    UNION ALL
    -- C) Gasto diario de un canal-DIA sin guias. No se pierde ni se muda de fecha: se declara.
    SELECT
      b.tenant_id, b.dia, '(n/a)'::text, '(canal-dia sin guias)'::text, b.canal,
      b.concepto, b.cuenta_mayor, b.fuente, 'diario'::text,
      0, 0, 0, round(b.gasto::numeric, 2), 'sin_actividad'::text, now()
    FROM bucket_diario b
    WHERE NOT EXISTS (SELECT 1 FROM den_dia d
                       WHERE d.tenant_id = b.tenant_id AND d.dia = b.dia AND d.canal = b.canal)
    UNION ALL
    -- D) Gasto periodico de un canal-MES sin guias en todo el mes.
    SELECT
      b.tenant_id, b.mes, '(n/a)'::text, '(canal-mes sin guias)'::text, b.canal,
      b.concepto, b.cuenta_mayor, b.fuente, 'mes'::text,
      0, 0, 0, round(b.gasto::numeric, 2), 'sin_actividad'::text, now()
    FROM bucket_periodico b
    WHERE NOT EXISTS (SELECT 1 FROM den_mes m
                       WHERE m.tenant_id = b.tenant_id AND m.mes = b.mes AND m.canal = b.canal)
    UNION ALL
    -- E) El bucket administrativo de un dia en que NINGUN canal tuvo paradas: el filtro
    -- "paradas > 0" del reparto lo descartaba en silencio (1,608.46 medidos en agosto-2026).
    SELECT
      o.tenant_id, o.dia, '(n/a)'::text, '(dia sin guias)'::text, '(sin canal)'::text,
      o.concepto, o.cuenta_mayor, 'otros_admin'::text, 'diario'::text,
      0, 0, 0, round(o.gasto::numeric, 2), 'sin_actividad'::text, now()
    FROM otros_bucket o
    LEFT JOIN paradas_dia_total t ON t.tenant_id = o.tenant_id AND t.dia = o.dia
    WHERE COALESCE(t.paradas, 0) = 0
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_logistics_guide_cost
      ON analytics.mv_logistics_guide_cost
         (tenant_id, dia, sucursal, guia, canal, concepto, cuenta_mayor, fuente, ventana)
  `);
  await knex.raw(`
    CREATE INDEX ix_mv_logistics_guide_cost_dia
      ON analytics.mv_logistics_guide_cost (tenant_id, dia)
  `);
  await knex.raw(`GRANT SELECT ON analytics.mv_logistics_guide_cost TO app_runtime`);
  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW analytics.mv_logistics_guide_cost IS
    $$[CGU.9] Costo por guia y concepto. Universo = familia 6xx + 762 de los departamentos
    logisticos (CGU.8: incluir solo 602/604/606/611 dejaba fuera el 48.4%, sobre todo 601
    SUELDOS). El bucket residual que se REPARTE esta acotado a cuentas de transporte: al ampliar
    el universo, 'otros' paso de 356k a 2,922,778 en 30 dias con FINANZAS, CAPITAL HUMANO y
    DIRECCION GENERAL adentro, y prorratear eso carga el sueldo de Direccion a un viaje de
    reparto. Sobre-atribuir es tan falso como subdeclarar y mas dificil de notar, porque el total
    sube y nadie sospecha de un numero que crecio. Toda cifra por guia sigue siendo ATRIBUIDA
    (origen), con tres estados y el tercero -sin_actividad- es el que hace cuadrar.$$
  `);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_logistics_guide_cost`);
};
