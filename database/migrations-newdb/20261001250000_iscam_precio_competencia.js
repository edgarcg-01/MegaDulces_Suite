'use strict';
/**
 * [PR.M6] -- El PRECIO de la competencia, derivado. Lo unico parecido a un precio que existe.
 *
 * -- ⛔ Una correccion a mi propio criterio -----------------------------------------------------
 * [PR.M1] descarto la columna PcioDisp del archivo con este argumento, que sigue siendo cierto:
 * su formula es Val/Vol/24, un divisor FIJO de 24 para todo el catalogo, y para un producto que
 * viene de 12 o de 30 el numero esta mal.
 *
 * De ahi saque la conclusion equivocada de que ISCAM no trae precio. Lo que no trae es un precio
 * ABSOLUTO defendible. El precio RELATIVO si se puede derivar, y el divisor fijo que arruinaba
 * a PcioDisp SE CANCELA en la razon, porque los dos lados salen de la misma celda y llevan la
 * misma unidad:
 *
 *   precio nuestro      = valor_nuestro / volumen_nuestro
 *   precio competencia  = (valor_mercado - valor_nuestro) / (volumen_mercado - volumen_nuestro)
 *
 * ⭐ La resta es lo que lo convierte en competencia y no en "mercado": excluye nuestra propia
 *   venta del denominador, que si no se hace arrastra nuestro precio adentro del de ellos.
 *
 * -- El control: que NO sea una identidad algebraica -------------------------------------------
 * Si la razon diera 1.000 en todas partes estaria midiendo una tautologia. Medido sobre
 * julio-2026, Region III / Mayoreo Puro / DULCES: n=1,028, mediana 1.001, desviacion 0.4747,
 * minimo 0.107, maximo 12.172. Hay dispersion real, y el candado la vigila.
 *
 * -- ⚠️ Cuando la cifra NO es confiable, medido ------------------------------------------------
 * El ruido viene de NUESTRO lado cuando vendemos poco de esa marca, no del lado de ellos:
 *
 *   share nuestro en volumen >= 10%  ->  608 celdas, desviacion 0.14 a 0.22   (confianza alta)
 *   share nuestro en volumen  < 10%  ->  420 celdas, desviacion 0.64 a 0.73   (confianza baja)
 *
 * Con q_n chico, valor_nuestro/volumen_nuestro se vuelve inestable. Por eso la confianza sale
 * del share NUESTRO, no del tamano del mercado.
 *
 * -- ⛔⛔ Lo que esta cifra NO es, y hay que decirlo donde se lee --------------------------------
 *  1. NO es el precio de lista de nadie, ni un precio de anaquel. Es el precio promedio
 *     IMPLICITO al que el resto del canal movio esa submarca, en el grano de la entrega.
 *  2. La unidad de volumen es la del archivo y NO esta verificada. Por eso solo se compara
 *     DENTRO de la celda: comparar el precio de dos submarcas distintas entre si no significa
 *     nada, y la vista no publica el precio absoluto como si fuera comparable.
 *  3. Nuestro lado arrastra el residuo de ~10% que [PR.M5] dejo sin explicar: si una parte de
 *     nuestro valor viaja a un precio distinto del de venta, nuestro precio implicito esta
 *     sesgado por ahi.
 *  4. En 1,129 de 2,236 celdas no vendemos nada de esa marca y en 340 somos el unico vendedor
 *     medido: ahi NO hay comparacion posible y se declara, no se dibuja un cero.
 */

exports.up = async function up(knex) {
  await knex.raw("SET LOCAL lock_timeout = '10s'");

  await knex.raw('DROP VIEW IF EXISTS analytics.v_iscam_precio_competencia');
  await knex.raw(`
    CREATE VIEW analytics.v_iscam_precio_competencia WITH (security_invoker = true) AS
    -- ⭐ UN solo barrido con agregados condicionales, no un auto-JOIN. Dos razones, y la
    --   segunda es de correccion, no de velocidad:
    --   (1) el auto-JOIN sobre nueve columnas tardaba 1,164 ms, por encima de la compuerta de 1 s;
    --   (2) y era un INNER JOIN: descartaba EN SILENCIO las celdas que traen valor pero no
    --       volumen, que es exactamente el estado "sin_volumen_en_la_entrega" que esta vista
    --       declara. Una rama declarada que el JOIN volvia inalcanzable.
    WITH base AS (
      SELECT tenant_id, periodo, region, subcanal, mercado, division, categoria,
             fabricante, submarca,
             max(entrega) AS entrega, max(importado_at) AS importado_at,
             sum(med_act_mayo) FILTER (WHERE tipo_medida = 'valor')   AS v_nuestro,
             sum(med_act_mdo)  FILTER (WHERE tipo_medida = 'valor')   AS v_mercado,
             sum(med_act_mayo) FILTER (WHERE tipo_medida = 'volumen') AS q_nuestro,
             sum(med_act_mdo)  FILTER (WHERE tipo_medida = 'volumen') AS q_mercado,
             sum(med_act_mdo)  FILTER (WHERE tipo_medida = 'volumen')
               - sum(med_act_mayo) FILTER (WHERE tipo_medida = 'volumen') AS q_competencia,
             sum(med_act_mdo)  FILTER (WHERE tipo_medida = 'valor')
               - sum(med_act_mayo) FILTER (WHERE tipo_medida = 'valor')   AS v_competencia
      FROM analytics.iscam_market
      GROUP BY 1,2,3,4,5,6,7,8,9),
    calc AS (
      SELECT b.*,
             CASE WHEN b.q_nuestro > 0 THEN b.v_nuestro / b.q_nuestro END AS precio_nuestro,
             CASE WHEN b.q_competencia > 0 AND b.v_competencia > 0
                  THEN b.v_competencia / b.q_competencia END AS precio_competencia,
             CASE WHEN b.q_mercado > 0 THEN b.q_nuestro / b.q_mercado END AS share_volumen
      FROM base b)
    SELECT
      c.tenant_id, c.periodo, c.region, c.subcanal, c.mercado, c.division, c.categoria,
      c.fabricante, c.submarca,
      c.v_nuestro AS venta_nuestra,
      round(c.precio_nuestro, 4)      AS precio_nuestro,
      round(c.precio_competencia, 4)  AS precio_competencia,
      CASE WHEN c.precio_nuestro IS NOT NULL AND c.precio_competencia > 0
           THEN round(100.0 * (c.precio_nuestro / c.precio_competencia - 1), 1) END AS dif_pct,
      round(100.0 * c.share_volumen, 2) AS share_volumen_pct,
      -- La confianza sale del share NUESTRO porque ahi esta el ruido: con volumen propio chico,
      -- valor_nuestro/volumen_nuestro se vuelve inestable. Medido, no supuesto.
      CASE
        WHEN c.precio_nuestro IS NULL OR c.precio_competencia IS NULL THEN NULL
        WHEN c.share_volumen >= 0.10 THEN 'alta'
        ELSE 'baja'
      END AS confianza,
      -- ⛔⛔ SIETE estados, y las cuatro ausencias NO son la misma: no venderla es una decision
      --   de surtido, ser el unico vendedor medido es una posicion, y que la entrega no traiga
      --   valor o no traiga volumen son dos huecos distintos de la fuente.
      --
      --   ⚠️ La primera version tenia un ELSE que decia 'al_mercado', y medido sobre el archivo
      --   hay 11,709 celdas que traen SOLO volumen, sin valor: con el precio en NULL caian por
      --   ese ELSE y se publicaban como "vendemos al precio del mercado". Un ELSE que absorbe lo
      --   que no se pudo medir lo pinta de verde. Por eso lo no calculable se nombra ANTES de
      --   cualquier comparacion, y el ELSE solo alcanza a lo que de verdad se comparo.
      CASE
        WHEN c.q_nuestro IS NULL OR c.q_mercado IS NULL   THEN 'sin_volumen_en_la_entrega'
        WHEN c.v_nuestro IS NULL OR c.v_mercado IS NULL   THEN 'sin_valor_en_la_entrega'
        WHEN c.q_nuestro = 0                              THEN 'no_la_vendemos'
        WHEN c.q_competencia <= 0 OR c.v_competencia <= 0 THEN 'somos_el_unico_vendedor_medido'
        WHEN c.precio_nuestro IS NULL
          OR c.precio_competencia IS NULL
          OR c.precio_competencia = 0                     THEN 'no_calculable'
        WHEN c.precio_nuestro / c.precio_competencia > 1.10 THEN 'arriba_del_mercado'
        WHEN c.precio_nuestro / c.precio_competencia < 0.90 THEN 'abajo_del_mercado'
        ELSE 'al_mercado'
      END AS veredicto,
      'precio IMPLICITO (valor/volumen), no de lista ni de anaquel. La unidad de volumen es la '
      || 'del archivo y NO esta verificada: solo tiene sentido comparar DENTRO de la misma '
      || 'submarca, nunca el precio de dos submarcas entre si. Nuestro lado arrastra el residuo '
      || 'de ~10% que la carga de [PR.M5] dejo sin explicar.' AS advertencia,
      c.entrega, c.importado_at
    FROM calc c`);
  await knex.raw('GRANT SELECT ON analytics.v_iscam_precio_competencia TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_iscam_precio_competencia IS
    'El precio IMPLICITO al que el resto del canal movio cada submarca, contra el nuestro. Es lo unico parecido a un precio de competencia que existe: PcioDisp del archivo no sirve porque su divisor es fijo (Val/Vol/24), pero ese divisor SE CANCELA en la razon. Medido jul-2026 Region III/Mayoreo Puro: 1,028 celdas calculables de 2,236, mediana 1.001 con desviacion 0.47 -- hay dispersion real, no es una identidad. 202 submarcas con $10.22M de venta nuestra estan ARRIBA del precio de la competencia y 131 con $5.02M por abajo. [PR.M6]'`);

  // eslint-disable-next-line no-console
  console.log('[PR.M6] v_iscam_precio_competencia lista.');
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_iscam_precio_competencia');
};
