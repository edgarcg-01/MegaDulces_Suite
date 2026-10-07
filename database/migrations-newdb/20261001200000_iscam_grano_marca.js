'use strict';
/**
 * [PR.M3] -- ISCAM baja al grano de FABRICANTE y SUBMARCA: la competencia deja de ser un total.
 *
 * -- Por que se cambia el grano de una tabla que ya esta en prod -------------------------------
 * La carga de [PR.M1] agrego por categoria y tiro dos dimensiones que el archivo YA traia:
 * Fabricante (8,247 en el diccionario) y SubMarca (35,164). Con eso "el mercado" era un numero
 * unico y la competencia, invisible. Con el grano fino se puede decir QUIEN nos gana y DONDE.
 *
 * Medido el 2026-10-01 sobre la entrega de julio: 406,799 filas finas contra 13,483 gruesas.
 *
 * El cambio es seguro y esta medido: el grano fino suma EXACTO al que hoy publica prod.
 * Cruce de las dos implementaciones: 13,483 claves gruesas, 0 que no cuadran, peor diferencia
 * 0.0000. Ninguna cifra publicada se mueve.
 *
 * Y por eso es UNA tabla, no dos: la regla principal pide una sola tabla principal y derivar el
 * resto. analytics.v_iscam_share conserva su contrato (grano de categoria) como ROLLUP, y la foto
 * fina sale por analytics.v_iscam_competencia. Nada se materializa dos veces.
 *
 * -- Por que se retira el CHECK "el mercado contiene lo nuestro" -------------------------------
 * A grano de categoria ese CHECK rechazaba 58 filas. A grano de marca rechaza 4,674, que cargan
 * 9.51 millones de pesos de venta NUESTRA. Esas filas no son basura: son los casos donde el panel
 * de ISCAM no ve bajo esa marca lo que nosotros vendemos (clasificacion distinta, marca propia, o
 * el traspaso que infla nuestro numerador). Un CHECK que las rechaza no las corrige: las
 * DESAPARECE, y con ellas 9.51 millones de evidencia.
 *
 * Lo que no se puede medir se DECLARA, nunca se descarta en silencio (ADR-056). El CHECK se
 * reemplaza por la columna mercado_menor_que_nuestro, que viaja con la fila, y por una banda
 * vigilada en el candado: si una entrega llega deformada, ese conteo se dispara y se ve.
 * Lo que SI queda como CHECK es lo que no se puede violar legitimamente: medidas no negativas.
 */

const T = 'analytics.iscam_market';

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");

  const col = async (c) => (await knex.raw(
    'SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?',
    ['analytics', 'iscam_market', c])).rows.length > 0;

  if (!(await col('fabricante'))) await knex.raw(`ALTER TABLE ${T} ADD COLUMN fabricante text`);
  if (!(await col('submarca'))) await knex.raw(`ALTER TABLE ${T} ADD COLUMN submarca text`);
  // ⭐ GENERADA, no escrita por el importador. La primera version la calculaba en JS con los
  //   valores en coma flotante y la columna guarda numeric(18,4): 4,389 de 4,674 filas quedaban
  //   marcadas por una diferencia menor a 0.0001 que, ya redondeada, era CERO. La bandera decia
  //   una cosa y los numeros de su propia fila decian otra.
  //   Dos campos del mismo hecho salen del mismo calculo, o uno de los dos miente.
  if (!(await col('mercado_menor_que_nuestro'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN mercado_menor_que_nuestro boolean
      GENERATED ALWAYS AS (med_act_mdo < med_act_mayo) STORED`);
  }

  // Las filas viejas son del grano grueso: no se pueden partir en marcas, y el importador las
  // repone desde el archivo. Se borra el CONTENIDO regenerable, no la tabla.
  const viejas = (await knex.raw(`SELECT count(*)::int AS n FROM ${T} WHERE fabricante IS NULL`)).rows[0].n;
  if (viejas > 0) await knex.raw(`DELETE FROM ${T} WHERE fabricante IS NULL`);

  await knex.raw(`ALTER TABLE ${T} ALTER COLUMN fabricante SET NOT NULL`);
  await knex.raw(`ALTER TABLE ${T} ALTER COLUMN submarca   SET NOT NULL`);

  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS iscam_market_pk`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT iscam_market_pk PRIMARY KEY
    (tenant_id, periodo, region, subcanal, mercado, division, categoria, fabricante, submarca, tipo_medida)`);

  // Los dos CHECK que obligaban a tirar evidencia. Ver la cabecera.
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS iscam_mdo_contiene_mayo`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS iscam_ant_contiene_mayo`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS iscam_medidas_no_negativas`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT iscam_medidas_no_negativas CHECK (
    med_act_mayo >= 0 AND med_act_mdo >= 0 AND med_ant_mayo >= 0 AND med_ant_mdo >= 0)`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS iscam_market_fab_idx ON ${T} (fabricante, periodo DESC)`);

  await knex.raw(`COMMENT ON COLUMN ${T}.mercado_menor_que_nuestro IS
    'La entrega mide MENOS mercado que venta nuestra bajo esa marca. No es basura: el panel no ve ahi lo que vendemos (clasificacion distinta, marca propia, o el traspaso que infla nuestro numerador). Se declara, no se descarta. [PR.M3]'`);

  // -- v_iscam_share: MISMO contrato de antes, ahora como rollup a categoria ------------------
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
      FROM ${T}
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
           true AS numerador_inflado_por_traspasos,
           'a ISCAM se le trasladan todas las salidas, traspasos entre sucursales incluidos (deuda '
           || 'tecnica de Wincaja). La brecha medida contra analytics.sales_daily es de $19.5M a '
           || '$21.6M por mes, estable en cinco meses. Si la distorsion fuera SOLO nuestra el share '
           || 'de Region III seria mas bajo que el publicado; si los demas mayoristas del panel cargan '
           || 'la misma deuda, el share esta bien. Cual de las dos es NO se puede saber desde el archivo.'
             AS advertencia,
           g.entrega, g.importado_at
    FROM g`);
  await knex.raw('GRANT SELECT ON analytics.v_iscam_share TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_iscam_share IS
    'Share por CATEGORIA. Es un rollup del grano fino (fabricante x submarca): medido sobre julio 2026 el fino suma exacto al grueso que publicaba la version anterior, 0 claves fuera y diferencia 0.0000. [PR.M3]'`);

  // -- v_iscam_competencia: la foto fina. Quien nos gana, donde, y cuanto --------------------
  await knex.raw('DROP VIEW IF EXISTS analytics.v_iscam_competencia');
  await knex.raw(`
    CREATE VIEW analytics.v_iscam_competencia WITH (security_invoker = true) AS
    SELECT
      m.tenant_id, m.periodo, m.region, m.subcanal, m.mercado, m.division, m.categoria,
      m.fabricante, m.submarca, m.tipo_medida,
      m.med_act_mayo AS nuestro,
      m.med_act_mdo  AS mercado_total,
      -- ⛔ NULL, no cero, cuando el panel mide menos mercado que venta nuestra: ahi la venta de
      --   la competencia NO se puede calcular desde esta fila, porque sus dos insumos se
      --   contradicen. Recortarlo a cero publicaba "la competencia no vendio nada" sobre
      --   $0.84M de venta nuestra, y de paso rompia la identidad nuestro + competencia = mercado.
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
      true AS numerador_inflado_por_traspasos,
      m.entrega, m.importado_at
    FROM ${T} m`);
  await knex.raw('GRANT SELECT ON analytics.v_iscam_competencia TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_iscam_competencia IS
    'La competencia por marca: cuanto vendio el RESTO del canal bajo cada fabricante/submarca, cuanto nosotros, y si ganamos o perdimos terreno. competencia = mercado - nuestro. Veredicto de CINCO estados: ausentes y sin_comparativo NO son la misma ausencia, y con tres estados lo que no se puede juzgar sale verde. [PR.M3]'`);

  // eslint-disable-next-line no-console
  console.log('[PR.M3] iscam_market a grano fabricante x submarca · ' + viejas
    + ' filas gruesas retiradas (el importador las repone) · v_iscam_competencia lista.');
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");
  await knex.raw('DROP VIEW IF EXISTS analytics.v_iscam_competencia');
  await knex.raw(`DELETE FROM ${T}`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS iscam_market_pk`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS fabricante`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS submarca`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS mercado_menor_que_nuestro`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT iscam_market_pk PRIMARY KEY
    (tenant_id, periodo, region, subcanal, mercado, division, categoria, tipo_medida)`);
};
