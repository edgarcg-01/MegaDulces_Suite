'use strict';
/**
 * [PR.M5] -- El Cubo de ISCAM: NUESTRA venta por producto y sucursal, 31 meses.
 *            Y la correccion de una advertencia que publique mal.
 *
 * -- Lo que los Cubos resultaron ser ----------------------------------------------------------
 * Los describi como "nuestro dato devuelto con su taxonomia" y los use solo para sacar 3,895
 * codigos de barras. Son mucho mas: **445,310 registros, 31 meses (ene-2024 -> jul-2026), 11
 * nombres de sucursal nuestros, 8,207 presentaciones**, con Vol y Val por celda, taxonomia de
 * siete niveles (Segmento > Categoria > SubCategoria > Fabricante > Marca > SubMarca > Producto)
 * y el empaque escrito en el nombre.
 *
 * Los DOS Cubos (CM y SubCanales) traen medidas IDENTICAS -- $1,885.44M y 9,018,964 unidades los
 * dos -- y solo difieren en la etiqueta de subcanal. Se carga uno.
 *
 * El Cubo es el numerador del SURF desagregado: jul-2026 da $55.62M, que es exactamente el
 * MedActMayo de Region III / Mayoreo Puro / DULCES.
 *
 * -- ⛔⛔ La correccion: la advertencia que publique estaba MAL ---------------------------------
 * [PR.M1] publico, en una columna de la vista y en los motivos de C1/H3/H4, que "el numerador
 * viene inflado por traspasos; la brecha contra sales_daily es de $19.5M a $21.6M por mes".
 * La brecha existe. La causa, no.
 *
 * Medido el 2026-10-01 con control de cobertura -- comparando SOLO las sucursales que nuestro
 * propio fact ya tiene ese mes:
 *
 *   razon ISCAM / nosotros, mismas sucursales:  1.105 a 1.371  (mediana ~1.25)
 *   razon ISCAM / nosotros, todo contra todo:   1.54
 *
 * La diferencia entre 1.54 y 1.11 NO es traspaso: es que **analytics.sales_daily no tenia esas
 * sucursales**. Arranca 2025-01 para 01/02/06, 2026-01 para 03/04/05, y **2026-09 para 07 y 08**
 * -- y 08 (Morelia Abastos) es la sucursal MAS grande del Cubo, $18.7M al mes, el 34% de la
 * venta que ISCAM nos publica. De 2024 nuestro fact no tiene **nada**.
 *
 * ⚠️ Lo que SI queda en pie es un residuo de ~10% sobre sucursales comunes en los meses
 *    recientes (1.106 en jun-2026, 1.105 en jul-2026). Ese residuo sigue SIN explicar, y ahora
 *    se declara como lo que es -- un 10%, no un 54%.
 *
 * ⭐ Y se cae la conclusion derivada: yo escribi "si la distorsion fuera solo nuestra el share
 *    seria ~3.80% y no 5.36%". Esa resta descontaba del numerador una inflacion que en su mayor
 *    parte no existe.
 *
 * -- ⭐ Por que esto vale, mas alla de corregirme ---------------------------------------------
 * ISCAM es **el unico lugar de la plataforma donde existe** la venta de Morelia Abastos antes de
 * sep-2026, la de 8 Esquinas / Yurecuaro / Zamora Centro antes de ene-2026, y la de 2024 entera.
 * No se puede derivar del ODS: ese dato no esta ahi. Entra como snapshot historico, que es
 * justo la excepcion que la regla principal reserva para tablas reales.
 */

const T = 'analytics.iscam_sales';

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");

  const hay = (await knex.raw(`SELECT to_regclass('${T}') IS NOT NULL AS hay`)).rows[0].hay;
  if (!hay) {
    await knex.raw(`
      CREATE TABLE ${T} (
        tenant_id        uuid NOT NULL,
        periodo          date NOT NULL,
        sucursal_iscam   text NOT NULL,
        -- ⛔ NULL cuando no se puede mapear, nunca una sucursal inventada. Hasta ene-2025 ISCAM
        --    agregaba en TRES plazas (LA PIEDAD, MORELIA, ZAMORA) y desde feb-2025 desagrega en
        --    ocho: una plaza agregada no es una sucursal nuestra y no se le asigna ninguna.
        warehouse_code   text,
        mapeo_nota       text,
        -- Identidad de escritura por hash de la tupla de dimensiones: medido, (periodo, sucursal,
        -- ProductoDetalle) tiene 1,289 colisiones y con CodBar todavia 695. Mismo patron que la
        -- replica de Wincaja, que ya usa _row_hash cuando no hay PK natural.
        dim_hash         text NOT NULL,
        codbar           text,
        producto_detalle text NOT NULL,
        producto         text,
        segmento         text,
        categoria        text,
        subcategoria     text,
        fabricante       text,
        marca            text,
        submarca         text,
        -- El empaque viene escrito en el nombre: "... [32 D/100 P] - 2.8 Grs". Parsea en el
        -- 100% de las 8,207 presentaciones (D de 1 a 360, P de 1 a 2000).
        -- ⚠️ Se guarda CRUDO y con el nombre que tiene en la fuente. Que D y P signifiquen
        --    display y pieza es lo que parece, NO lo que se verifico: no se usa como factor de
        --    caja ni se cablea a ningun resolvedor de unidades hasta probarlo contra el dinero.
        empaque_d        numeric(10,2),
        empaque_p        numeric(10,2),
        gramaje          numeric(12,3),
        gramaje_unidad   text,
        vol              numeric(18,4) NOT NULL,
        val              numeric(18,4) NOT NULL,
        entrega          text NOT NULL,
        importado_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT iscam_sales_pk PRIMARY KEY (tenant_id, periodo, sucursal_iscam, dim_hash),
        CONSTRAINT iscam_sales_no_negativo CHECK (vol >= 0 AND val >= 0)
      )`);
    await knex.raw(`CREATE INDEX iscam_sales_periodo_idx ON ${T} (periodo DESC, warehouse_code)`);
    await knex.raw(`CREATE INDEX iscam_sales_codbar_idx  ON ${T} (codbar)`);
    await knex.raw(`CREATE INDEX iscam_sales_fab_idx     ON ${T} (fabricante, periodo DESC)`);
    await knex.raw(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY iscam_sales_tenant ON ${T}
      USING (tenant_id = current_setting('app.tenant_id', true)::uuid)`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${T} TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE ${T} IS
      'ISCAM Cubo: NUESTRA venta por producto x sucursal x mes, 31 meses desde ene-2024, con taxonomia de siete niveles. Es el unico lugar de la plataforma donde existe la venta de Morelia Abastos antes de sep-2026, la de 8 Esquinas/Yurecuaro/Zamora Centro antes de ene-2026, y la de 2024 entera: analytics.sales_daily no las tiene. Snapshot externo, no derivable del ODS. [PR.M5]'`);
  }

  // -- La vista: nuestra venta segun ISCAM, al lado de la nuestra, con la brecha DECLARADA ----
  await knex.raw('DROP VIEW IF EXISTS analytics.v_iscam_vs_libros');
  await knex.raw(`
    CREATE VIEW analytics.v_iscam_vs_libros WITH (security_invoker = true) AS
    WITH iscam AS (
      SELECT tenant_id, periodo, warehouse_code, sum(val) AS val_iscam, sum(vol) AS vol_iscam,
             count(*)::int AS celdas
      FROM ${T} WHERE warehouse_code IS NOT NULL
      GROUP BY 1,2,3),
    libros AS (
      SELECT s.tenant_id, date_trunc('month', s.sale_date)::date AS periodo, w.code AS warehouse_code,
             sum(s.revenue) AS val_libros
      FROM analytics.sales_daily s
      JOIN commercial.warehouses w ON w.id = s.warehouse_id
      WHERE s.sale_date >= '2024-01-01'
      GROUP BY 1,2,3)
    SELECT
      COALESCE(i.tenant_id, l.tenant_id)             AS tenant_id,
      COALESCE(i.periodo, l.periodo)                 AS periodo,
      COALESCE(i.warehouse_code, l.warehouse_code)   AS warehouse_code,
      i.val_iscam, i.vol_iscam, i.celdas, l.val_libros,
      CASE WHEN i.val_iscam IS NOT NULL AND l.val_libros IS NOT NULL
           THEN i.val_iscam - l.val_libros END       AS brecha,
      CASE WHEN l.val_libros > 0 THEN round(i.val_iscam / l.val_libros, 3) END AS razon,
      -- ⭐ Las tres ausencias NO son la misma, y con una sola etiqueta la peor se disfraza de
      --   las otras dos. "sin_libros" es el hueco de cobertura de NUESTRO fact, que es lo que
      --   hacia parecer que ISCAM inflaba.
      CASE
        WHEN i.val_iscam IS NULL  THEN 'sin_iscam'
        WHEN l.val_libros IS NULL THEN 'sin_libros'
        ELSE 'comparable'
      END AS estado
    FROM iscam i
    FULL OUTER JOIN libros l
      ON l.tenant_id = i.tenant_id AND l.periodo = i.periodo
     AND l.warehouse_code = i.warehouse_code`);
  await knex.raw('GRANT SELECT ON analytics.v_iscam_vs_libros TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_iscam_vs_libros IS
    'ISCAM contra nuestros libros, por sucursal y mes. Medido el 2026-10-01: sobre sucursales COMUNES la razon es 1.105 a 1.371, no 1.54 -- la brecha grande era cobertura de analytics.sales_daily (arranca 2025-01 para 01/02/06, 2026-01 para 03/04/05 y 2026-09 para 07/08), no inflacion por traspasos. El residuo de ~10% en meses recientes sigue sin explicar. [PR.M5]'`);

  // -- ⛔ La correccion de lo publicado -------------------------------------------------------
  const ADV = 'ADVERTENCIA CORREGIDA 2026-10-01. La version anterior decia que el numerador '
    + 'viene inflado por traspasos entre sucursales, con una brecha de $19.5M a $21.6M por mes '
    + 'contra analytics.sales_daily. La brecha existe; la causa estaba mal. Medido con control '
    + 'de cobertura, comparando SOLO las sucursales que nuestro fact ya tiene ese mes, la razon '
    + 'ISCAM/nosotros es 1.105 a 1.371 y no 1.54: la diferencia era que sales_daily no tenia '
    + 'esas sucursales (arranca 2025-01 para 01/02/06, 2026-01 para 03/04/05 y 2026-09 para 07 '
    + 'y 08, siendo 08 Morelia Abastos el 34% de la venta que ISCAM nos publica). Queda un '
    + 'residuo de ~10% sobre sucursales comunes que sigue SIN explicar, y ese si podria ser '
    + 'traspaso. Ver analytics.v_iscam_vs_libros.';

  await knex.raw('DROP VIEW IF EXISTS analytics.v_iscam_share');
  await knex.raw(`
    CREATE VIEW analytics.v_iscam_share WITH (security_invoker = true) AS
    WITH g AS (
      SELECT tenant_id, periodo, region, subcanal, mercado, division, categoria, tipo_medida,
             sum(med_act_mayo) AS a_mayo, sum(med_act_mdo) AS a_mdo,
             sum(med_ant_mayo) AS p_mayo, sum(med_ant_mdo) AS p_mdo,
             count(*)::int AS submarcas,
             count(*) FILTER (WHERE mercado_menor_que_nuestro)::int AS submarcas_sin_respaldo,
             min(entrega) AS entrega, max(importado_at) AS importado_at
      FROM analytics.iscam_market
      GROUP BY 1,2,3,4,5,6,7,8)
    SELECT g.tenant_id, g.periodo, g.region, g.subcanal, g.mercado, g.division, g.categoria,
           g.tipo_medida,
           g.a_mayo AS nuestro,
           g.a_mdo  AS mercado_total,
           CASE WHEN g.a_mdo > 0 THEN round(100.0 * g.a_mayo / g.a_mdo, 2) END AS share_pct,
           CASE WHEN g.a_mdo > 0 AND g.p_mdo > 0
                THEN round(100.0 * g.a_mayo / g.a_mdo - 100.0 * g.p_mayo / g.p_mdo, 2) END AS share_delta_pp,
           CASE WHEN g.p_mayo > 0 THEN round(100.0 * (g.a_mayo / g.p_mayo - 1), 1) END AS crec_nuestro_pct,
           CASE WHEN g.p_mdo > 0 THEN round(100.0 * (g.a_mdo / g.p_mdo - 1), 1) END AS crec_mercado_pct,
           CASE WHEN (g.p_mdo - g.p_mayo) > 0
                THEN round(100.0 * ((g.a_mdo - g.a_mayo) / (g.p_mdo - g.p_mayo) - 1), 1) END AS crec_competencia_pct,
           g.submarcas, g.submarcas_sin_respaldo,
           -- Era una bandera verdadera incondicional. Hoy la inflacion esta MEDIDA y es ~10%,
           -- no el 54% que la version anterior daba por sentado, asi que ya no afirma mas de
           -- lo que se comprobo.
           true AS numerador_con_residuo_sin_explicar,
           10.5 AS residuo_pct_medido,
           '${ADV.replace(/'/g, "''")}' AS advertencia,
           g.entrega, g.importado_at
    FROM g`);
  await knex.raw('GRANT SELECT ON analytics.v_iscam_share TO app_runtime');

  await knex.raw('DROP VIEW IF EXISTS analytics.v_iscam_competencia');
  await knex.raw(`
    CREATE VIEW analytics.v_iscam_competencia WITH (security_invoker = true) AS
    SELECT
      m.tenant_id, m.periodo, m.region, m.subcanal, m.mercado, m.division, m.categoria,
      m.fabricante, m.submarca, m.tipo_medida,
      m.med_act_mayo AS nuestro,
      m.med_act_mdo  AS mercado_total,
      CASE WHEN m.med_act_mdo >= m.med_act_mayo
           THEN m.med_act_mdo - m.med_act_mayo END AS competencia,
      CASE WHEN m.med_ant_mdo >= m.med_ant_mayo
           THEN m.med_ant_mdo - m.med_ant_mayo END AS competencia_anterior,
      CASE WHEN m.med_act_mdo > 0
           THEN round(100.0 * m.med_act_mayo / m.med_act_mdo, 2) END AS share_pct,
      CASE WHEN m.med_act_mdo > 0 AND m.med_ant_mdo > 0
           THEN round(100.0 * m.med_act_mayo / m.med_act_mdo
                    - 100.0 * m.med_ant_mayo / m.med_ant_mdo, 2) END AS share_delta_pp,
      CASE WHEN m.med_ant_mayo > 0
           THEN round(100.0 * (m.med_act_mayo / m.med_ant_mayo - 1), 1) END AS crec_nuestro_pct,
      CASE WHEN m.med_ant_mdo > 0
           THEN round(100.0 * (m.med_act_mdo / m.med_ant_mdo - 1), 1) END AS crec_mercado_pct,
      CASE WHEN (m.med_ant_mdo - m.med_ant_mayo) > 0
           THEN round(100.0 * ((m.med_act_mdo - m.med_act_mayo)
                             / (m.med_ant_mdo - m.med_ant_mayo) - 1), 1) END AS crec_competencia_pct,
      CASE
        WHEN m.med_act_mdo < m.med_act_mayo             THEN 'sin_respaldo'
        WHEN m.med_act_mayo = 0 AND m.med_act_mdo > 0   THEN 'ausentes'
        WHEN m.med_ant_mdo = 0 OR m.med_act_mdo = 0     THEN 'sin_comparativo'
        WHEN (100.0 * m.med_act_mayo / m.med_act_mdo
            - 100.0 * m.med_ant_mayo / NULLIF(m.med_ant_mdo,0)) < -0.10 THEN 'perdiendo'
        WHEN (100.0 * m.med_act_mayo / m.med_act_mdo
            - 100.0 * m.med_ant_mayo / NULLIF(m.med_ant_mdo,0)) >  0.10 THEN 'ganando'
        ELSE 'estable'
      END AS veredicto,
      m.mercado_menor_que_nuestro,
      true AS numerador_con_residuo_sin_explicar,
      '${ADV.replace(/'/g, "''")}' AS advertencia,
      m.entrega, m.importado_at
    FROM analytics.iscam_market m`);
  await knex.raw('GRANT SELECT ON analytics.v_iscam_competencia TO app_runtime');

  // Y los motivos del registro de senales, que citaban la cifra vieja.
  const R = 'analytics.price_signal_registry';
  const hayReg = (await knex.raw(`SELECT to_regclass('${R}') IS NOT NULL AS hay`)).rows[0].hay;
  const n = !hayReg ? { rowCount: 0 } : await knex.raw(
    `UPDATE ${R} SET motivo_ausencia = replace(replace(motivo_ausencia,
        'el numerador viene INFLADO: a ISCAM se le trasladan todas las salidas, traspasos entre',
        'CORREGIDO 2026-10-01: el numerador tiene un residuo MEDIDO de ~10% sin explicar. Lo que decia antes -- que venia inflado por los traspasos entre'),
      'La brecha medida contra sales_daily es de',
      'era una hipotesis que la medicion por sucursal refuto: la brecha grande era cobertura de nuestro propio fact, no inflacion. Brecha bruta, ya sin causa atribuida, de'),
      updated_at = now()
     WHERE clave IN ('H3','H4') AND motivo_ausencia LIKE '%INFLADO%'`);

  // eslint-disable-next-line no-console
  console.log('[PR.M5] iscam_sales + v_iscam_vs_libros listas · advertencia corregida en 2 vistas y '
    + (n.rowCount || 0) + ' senales.');
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");
  await knex.raw('DROP VIEW IF EXISTS analytics.v_iscam_vs_libros');
  await knex.raw(`DROP TABLE IF EXISTS ${T}`);
};
