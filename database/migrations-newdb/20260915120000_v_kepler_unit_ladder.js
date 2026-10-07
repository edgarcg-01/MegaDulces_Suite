/* eslint-disable no-console */
/**
 * [UN.1] La ESTRUCTURA DE UNIDADES PARA POS de Kepler, decodificada y derivada.
 *
 * Edgar (2026-09-15): *"no ocupo parches ni hacer que los datos cuadren. necesito la formula que
 * usa Kepler que hace que estos cuadren con su unidad de medida, para nosotros poder convertir a
 * cajas correctamente"*. Tenia razon: lo anterior era rotular el hueco, no resolverlo.
 *
 * ── LA PIEDRA DE ROSETTA ────────────────────────────────────────────────────────────────────
 * Edgar mando la ficha de Kepler del SKU 96158 con los valores a la vista. Cada uno se busco en
 * kepler_ods.kdii y el mapeo quedo FIJADO por coincidencia exacta, no por suposicion:
 *
 *   Ficha "Estructura de Unidades para POS"   Unidades  Factor  Costo  %Margen   PV    CB1
 *     Base .................................    c11        1     c77     c87     c90    c7
 *     Unidad Dos ...........................    c80       c81    c78     c88     c91    c82
 *     Unidad Tres ..........................    c83       c84    c79     c89     c92    c85
 *
 *   (96158: c11=PZA, c77=145.00, c87=23.2600, c90=178.73, c7=96158 — identicos a la pantalla.)
 *
 * ── LAS DOS ECUACIONES, VALIDADAS CONTRA LAS 76,219 FILAS DEL MAESTRO ───────────────────────
 *
 *   (1)  costo_peldano_N = costo_base x factor_N
 *          Unidad Dos ... 68,526 de 69,487 = 98.6 %
 *          Unidad Tres .. 19,409 de 19,703 = 98.5 %
 *
 *   (2)  PV_peldano_N = costo_peldano_N x (1 + margen_N / 100)
 *          14030: 22.34 x 1.264 = 28.24 = c90 exacto; 223.44 x 1.107 = 247.35 = c91 exacto.
 *          A escala solo cuadra 32.3 % — el PV se sobreescribe a mano y el margen queda viejo.
 *          Por eso el PRECIO no sirve para derivar la unidad, y el COSTO si.
 *
 * ── LA CONSECUENCIA, QUE ES EL PUNTO DE ESTA VISTA ──────────────────────────────────────────
 * De (1) se despeja el factor SIN depender de que alguien lo capture:
 *
 *        factor_N = costo_peldano_N / costo_base
 *
 * Medido contra el factor que Kepler SI tiene capturado: 52,231 de 53,112 filas dan el mismo
 * entero (98.3 %), con mediana derivado/capturado = 1.00000 exacta.
 *
 * ⛔ Por que fracaso el intento anterior con el precio (acerto 10.7 %): PV2/PV1 no es el factor,
 * es factor x (1+m2)/(1+m1). Los margenes por peldano son distintos (14030: 26.40 % en la base
 * contra 10.70 % en la caja), asi que la razon de precios trae el margen adentro. El costo es
 * LINEAL en el factor; el precio no. Ahora esta probado con la formula, no supuesto.
 *
 * ── Y LO QUE LA FICHA DICE AL PIE, QUE VALE COMO REGLA ──────────────────────────────────────
 *   "Las Unidades se deben capturar en orden Ascendente en Factor"
 *   "La facturacion es siempre sobre la unidad Base"
 *   "Los inventarios estan en la unidad Base"
 *
 * De ahi: unidades_base = cantidad x factor_del_peldano. Y si NO hay rotulo de Unidad Dos ni de
 * Unidad Tres, el producto tiene UNA SOLA unidad y su factor es 1 — eso es un DATO del ERP, no
 * un hueco. Medido: 814 SKUs asi, y 793 de ellos traen el costo superior en cero, coherente.
 * ⚠️ Los otros 21 traen costo superior SIN rotulo: se declaran aparte, no se afirman.
 *
 * ⚠️ Lo que esta vista NO hace: no colapsa las plazas. El grano es (sucursal, sku) porque la
 * ficha es por sucursal. analytics.v_product_unit_ladder usa mode() sobre las 8 plazas y publica
 * una moda sin decirlo; esta no.
 *
 * ⚠️ ADITIVA: nace SIN consumidores a proposito. Cablearla a v_product_box_factor mueve la
 * conversion a cajas de toda la Suite (7 dependientes) y eso pide su propio antes/despues.
 */

exports.up = async function up(knex) {
  const num = (col) => `NULLIF(regexp_replace(${col}::text, '[^0-9.]', '', 'g'), '')::numeric`;

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_kepler_unit_ladder AS
    WITH src AS (
      SELECT btrim(k.sucursal::text)          AS sucursal,
             btrim(k.c1)                      AS sku,
             NULLIF(upper(btrim(k.c11)), '')  AS u1_label,
             NULLIF(upper(btrim(k.c80)), '')  AS u2_label,
             NULLIF(upper(btrim(k.c83)), '')  AS u3_label,
             ${num('k.c81')} AS f2_cap,   ${num('k.c84')} AS f3_cap,
             ${num('k.c77')} AS costo1,   ${num('k.c78')} AS costo2,  ${num('k.c79')} AS costo3,
             ${num('k.c87')} AS margen1,  ${num('k.c88')} AS margen2, ${num('k.c89')} AS margen3,
             ${num('k.c90')} AS pv1,      ${num('k.c91')} AS pv2,     ${num('k.c92')} AS pv3
        FROM kepler_ods.kdii k
       WHERE btrim(COALESCE(k.c1, '')) <> ''
    ),
    d AS (
      SELECT src.*,
             -- ecuacion (1) despejada: el factor sale del COSTO, que es lineal en el factor.
             CASE WHEN costo1 > 0 AND costo2 > 0 THEN costo2 / costo1 END AS f2_costo,
             CASE WHEN costo1 > 0 AND costo3 > 0 THEN costo3 / costo1 END AS f3_costo,
             -- el peldano que hace de CAJA es el mas alto CON ROTULO: la ficha obliga a capturar
             -- en orden ascendente de factor, asi que el ultimo rotulado es el mayor.
             -- factor EFECTIVO de cada peldano: lo capturado manda, y si no lo hay se deriva del
             -- costo. Un peldano rotulado pero vacio (factor 0 y costo 0) NO es un peldano.
             CASE WHEN f2_cap > 1 THEN f2_cap
                  WHEN costo1 > 0 AND costo2 > 0 AND costo2 / costo1 > 1
                    THEN round(costo2 / costo1) END AS f2_eff,
             CASE WHEN f3_cap > 1 THEN f3_cap
                  WHEN costo1 > 0 AND costo3 > 0 AND costo3 / costo1 > 1
                    THEN round(costo3 / costo1) END AS f3_eff
        FROM src
    ),
    e AS (
      -- ⛔ EL PELDANO CAJA ES EL DE MAYOR FACTOR, NO EL ULTIMO ROTULADO. La escalera puede venir
      -- CORRIDA (ERP_KEPLER 2.1) y el ejemplo lo destapo: el SKU 14030 trae u2=CJA con factor 10
      -- y u3=PZA rotulada pero VACIA. Tomar el ultimo rotulo daba "sin dato" sobre un producto
      -- cuyo factor esta capturado y correcto.
      SELECT d.*,
             CASE WHEN f3_eff IS NOT NULL AND f3_eff >= COALESCE(f2_eff, 0) THEN 3
                  WHEN f2_eff IS NOT NULL THEN 2
                  ELSE 1 END AS peldano_caja
        FROM d
    )
    SELECT sucursal, sku, u1_label, u2_label, u3_label,
           f2_cap, f3_cap, round(f2_costo, 4) AS f2_costo, round(f3_costo, 4) AS f3_costo,
           costo1, costo2, costo3, margen1, margen2, margen3, pv1, pv2, pv3,
           peldano_caja,
           CASE peldano_caja WHEN 3 THEN u3_label WHEN 2 THEN u2_label ELSE u1_label END AS unidad_caja,
           CASE peldano_caja WHEN 3 THEN f3_cap   WHEN 2 THEN f2_cap   ELSE 1 END AS factor_capturado,
           CASE peldano_caja WHEN 3 THEN round(f3_costo, 4) WHEN 2 THEN round(f2_costo, 4) ELSE 1 END
             AS factor_del_costo,
           -- EL NUMERO PUBLICABLE. En el peldano 1 solo se afirma 1 cuando NO hay rotulo
           -- superior: un rotulo sin factor ni costo es ignorancia, no una unidad unica.
           CASE
             WHEN peldano_caja = 3 THEN f3_eff
             WHEN peldano_caja = 2 THEN f2_eff
             WHEN u2_label IS NULL AND u3_label IS NULL THEN 1
             ELSE NULL
           END AS factor_caja,
           -- CON QUE SE OBTUVO. Nunca un numero sin su fuente (ADR-056).
           CASE
             WHEN peldano_caja = 3 AND f3_cap > 1 AND f3_costo > 1
                  AND round(f3_cap) <> round(f3_costo) THEN 'capturado_contradice_al_costo'
             WHEN peldano_caja = 3 AND f3_cap > 1 THEN 'capturado'
             WHEN peldano_caja = 3 THEN 'derivado_del_costo'
             WHEN peldano_caja = 2 AND f2_cap > 1 AND f2_costo > 1
                  AND round(f2_cap) <> round(f2_costo) THEN 'capturado_contradice_al_costo'
             WHEN peldano_caja = 2 AND f2_cap > 1 THEN 'capturado'
             WHEN peldano_caja = 2 THEN 'derivado_del_costo'
             WHEN u2_label IS NULL AND u3_label IS NULL
                  AND COALESCE(costo2, 0) = 0 AND COALESCE(costo3, 0) = 0 THEN 'unidad_unica'
             WHEN u2_label IS NULL AND u3_label IS NULL THEN 'unidad_unica_con_costo_superior'
             ELSE 'rotulo_sin_factor_ni_costo'
           END AS factor_source,
           -- la ecuacion (2) como control de salud del renglon, no como fuente.
           CASE WHEN costo1 > 0 AND pv1 > 0 AND margen1 IS NOT NULL
                THEN abs(costo1 * (1 + margen1 / 100) - pv1) <= 0.02 END AS pv_base_cuadra
      FROM e
  `);

  await knex.raw('GRANT SELECT ON analytics.v_kepler_unit_ladder TO app_runtime');
  await knex.raw(
    'COMMENT ON VIEW analytics.v_kepler_unit_ladder IS '
    + "'[UN.1] Estructura de Unidades para POS de Kepler (kdii), grano sucursal x sku, sin mode(). "
    + 'Base c11/c77/c87/c90, Unidad Dos c80/c81/c78/c88/c91, Unidad Tres c83/c84/c79/c89/c92. '
    + 'costo_peldano = costo_base x factor (98.6 por ciento medido) y de ahi '
    + 'factor = costo_peldano / costo_base (98.3 por ciento identico al capturado). '
    + 'El PRECIO no sirve para derivar: trae el margen del peldano adentro. '
    + "Sin rotulo superior el factor es 1 y es un dato, no un hueco.'",
  );

  // ── Auto-verificacion: la migracion mide lo que acaba de crear ───────────────────────────
  const [v] = (await knex.raw(`
    SELECT count(*)::int AS filas,
           count(*) FILTER (WHERE factor_source = 'capturado')::int          AS capturado,
           count(*) FILTER (WHERE factor_source = 'derivado_del_costo')::int AS derivado,
           count(*) FILTER (WHERE factor_source = 'unidad_unica')::int       AS unica,
           count(*) FILTER (WHERE factor_source = 'capturado_contradice_al_costo')::int AS contradice,
           count(*) FILTER (WHERE factor_source = 'sin_dato')::int           AS sin_dato
      FROM analytics.v_kepler_unit_ladder
  `)).rows;
  console.log(`[UN.1] v_kepler_unit_ladder: ${v.filas} filas — capturado ${v.capturado}`
    + ` · derivado del costo ${v.derivado} · unidad unica ${v.unica}`
    + ` · contradice ${v.contradice} · sin dato ${v.sin_dato}`);

  if (!Number(v.filas)) throw new Error('[UN.1] la vista quedo vacia: revisar kepler_ods.kdii');

  // Trinquete: el derivado tiene que coincidir con el capturado donde los DOS existen. Si esta
  // asercion se pone roja, la ecuacion (1) dejo de valer y la derivacion ya no es defendible.
  const [p] = (await knex.raw(`
    SELECT count(*)::int AS pares,
           count(*) FILTER (WHERE round(factor_del_costo) = round(factor_capturado))::int AS iguales
      FROM analytics.v_kepler_unit_ladder
     WHERE factor_capturado > 1 AND factor_del_costo > 1
  `)).rows;
  const pct = Number(p.pares) ? (100 * Number(p.iguales)) / Number(p.pares) : 0;
  console.log(`[UN.1] derivado == capturado en ${p.iguales}/${p.pares} = ${pct.toFixed(1)}%`);
  if (pct < 95) {
    throw new Error('[UN.1] la ecuacion costo = costo_base x factor solo se cumple en '
      + `${pct.toFixed(1)}% (medido 98.3% el 2026-09-15). No derivar el factor hasta entenderlo.`);
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_kepler_unit_ladder');
};
