#!/usr/bin/env node
/**
 * `[CAT-COSTO.1]` Verificación previa de la pestaña Costos — SÓLO LECTURA.
 *
 * Responde, contra prod y antes de construir, las preguntas que el código no puede contestar:
 *
 *   A. Punto 1 (costo estándar distinto entre sucursales)
 *      A1. cuántos SKUs tienen ficha en 2+ plazas, cuántos con costo distinto (>0.5 %) y cuántos
 *          con UNIDAD BASE distinta (esos no se comparan: darían diferencias falsas de ×20).
 *      A2. tiempo de la consulta (gate: < 1 s).
 *
 *   B. Punto 2 (costo aplicado en la orden de entrada XA2001 contra el estándar)
 *      B1. ¿`kdm2.c12` es costo UNITARIO de la unidad `c11`? → ¿`c13 = c9 × c12`?
 *      B2. ¿trae IVA o descuento? → Σ`c13` del documento contra el total del encabezado `c16`.
 *      B3. ¿la unidad `c11` se resuelve en la escalera de la ficha (u1/u2/u3 de la sucursal que
 *          registró)? ¿`f3_cap` es relativo a la base o al peldaño 2?
 *      B4. ¿a qué plaza se atribuye cada línea (origen_veredicto) y si esa plaza TIENE ficha de
 *          costo estándar en Kepler (las plazas Wincaja pueden no tenerla).
 *      B5. distribución de la desviación contra el estándar con tolerancia 0.5 %.
 *      B6. tiempo de la consulta (gate: < 1 s).
 *
 * Uso:  PROD_RO_URL=postgresql://<rol_ro>@192.168.0.222:5434/<db> node database/scripts/verify-cat-costo-estandar.js
 * No lee DATABASE_URL_NEW a propósito: esa variable apunta a otra base según la máquina.
 * Lo que no se pueda medir se imprime como NO MEDIDO, nunca como cero.
 */
const { Client } = require('pg');

const URL = process.env.PROD_RO_URL;
if (!URL) {
  console.error('Falta PROD_RO_URL (credencial de SÓLO LECTURA a pg-prod).');
  process.exit(2);
}

const TOL = 0.005;
const DIAS = 90;

async function medir(c, nombre, sql, params = []) {
  const t0 = Date.now();
  try {
    const r = await c.query(sql, params);
    const ms = Date.now() - t0;
    console.log(`\n── ${nombre}  (${ms} ms)`);
    console.table(r.rows);
    return { rows: r.rows, ms };
  } catch (e) {
    console.log(`\n── ${nombre}  NO MEDIDO: ${e.message}`);
    return { rows: null, ms: null };
  }
}

// Líneas XA2001 de la ventana, con su encabezado y su plaza atribuida. Se arma aquí y no se
// lee `analytics.erp_goods_receipt_lines` porque esa vista no trae la fecha del documento.
const LINEAS = `
  WITH l AS (
    SELECT ap.sucursal::text AS sucursal, btrim(ap.c6::text) AS folio,
           ap.c68::date AS fecha,
           NULLIF(btrim(l.c8::text),'') AS sku,
           NULLIF(upper(btrim(l.c11::text)),'') AS unidad,
           nullif(regexp_replace(l.c9::text ,'[^0-9.-]','','g'),'')::numeric AS cantidad,
           nullif(regexp_replace(l.c12::text,'[^0-9.-]','','g'),'')::numeric AS costo,
           nullif(regexp_replace(l.c13::text,'[^0-9.-]','','g'),'')::numeric AS importe,
           nullif(regexp_replace(ap.c16::text,'[^0-9.-]','','g'),'')::numeric AS total_doc
      FROM kepler_ods.kdm1 ap
      JOIN kepler_ods.kdm2 l
        ON l.sucursal=ap.sucursal AND l.c1=ap.c1 AND l.c2=ap.c2 AND l.c3=ap.c3 AND l.c4=ap.c4 AND l.c6=ap.c6
     WHERE ap.c2='X' AND ap.c3='A' AND btrim(ap.c4::text)='20'
       AND btrim(ap.c1::text)=ap.sucursal::text
       AND btrim(coalesce(ap.c43::text,'')) <> 'C'
       AND ap.c68::date >= current_date - ${DIAS}
  )`;

(async () => {
  const c = new Client({ connectionString: URL, statement_timeout: 120000 });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const who = await c.query('SELECT current_user, current_database(), now()');
  console.log('Conectado como', who.rows[0]);

  // ── A1 / A2 ───────────────────────────────────────────────────────────────────────────
  await medir(c, 'A1 · costo estándar entre sucursales (plazas operativas)', `
    WITH s AS (
      SELECT sku, sucursal, unidad_base, costo_estandar
        FROM analytics.v_kepler_standard_cost
       WHERE es_plaza_operativa AND costo_estandar IS NOT NULL
    ), g AS (
      SELECT sku, count(*) AS plazas,
             count(DISTINCT unidad_base) AS unidades,
             max(costo_estandar) / nullif(min(costo_estandar), 0) - 1 AS spread
        FROM s GROUP BY sku
    )
    SELECT count(*)                                            AS skus,
           count(*) FILTER (WHERE plazas >= 2)                 AS en_2_o_mas_plazas,
           count(*) FILTER (WHERE plazas >= 2 AND unidades > 1) AS unidad_base_distinta,
           count(*) FILTER (WHERE plazas >= 2 AND unidades = 1 AND spread >  $1) AS costo_distinto,
           count(*) FILTER (WHERE plazas >= 2 AND unidades = 1 AND spread <= $1) AS iguales
      FROM g`, [TOL]);

  await medir(c, 'A1b · cuántas plazas operativas trae la vista', `
    SELECT sucursal, count(*) AS fichas, count(costo_estandar) AS con_estandar
      FROM analytics.v_kepler_standard_cost GROUP BY 1 ORDER BY 1`);

  // ── B1 / B2 ───────────────────────────────────────────────────────────────────────────
  await medir(c, 'B1 · ¿c13 = c9 × c12? (c12 es unitario de la unidad c11)', `${LINEAS}
    SELECT count(*) AS lineas,
           count(*) FILTER (WHERE abs(importe - cantidad*costo) <= 0.02)  AS cuadra_al_centavo,
           count(*) FILTER (WHERE abs(importe - cantidad*costo) >  0.02)  AS no_cuadra,
           count(*) FILTER (WHERE costo IS NULL OR costo = 0)             AS sin_costo
      FROM l`);

  await medir(c, 'B2 · Σ importe de líneas contra total del encabezado (¿IVA? ¿descuento?)', `${LINEAS},
    d AS (SELECT sucursal, folio, sum(importe) AS lineas, max(total_doc) AS total FROM l GROUP BY 1,2)
    SELECT count(*) AS documentos,
           count(*) FILTER (WHERE abs(total - lineas)        <= 0.05) AS total_igual_lineas,
           count(*) FILTER (WHERE abs(total - lineas*1.16)   <= 0.05) AS total_lineas_mas_iva16,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY total / nullif(lineas,0)) AS razon_mediana
      FROM d`);

  // ── B3 ────────────────────────────────────────────────────────────────────────────────
  await medir(c, 'B3 · ¿la unidad de la entrada se encuentra en la escalera de la ficha?', `${LINEAS}
    SELECT CASE WHEN l.unidad = e.u1_label THEN 'u1 (base)'
                WHEN l.unidad = e.u2_label THEN 'u2'
                WHEN l.unidad = e.u3_label THEN 'u3'
                WHEN e.sku IS NULL          THEN 'sin ficha en la sucursal que registró'
                ELSE 'etiqueta no está en la escalera' END AS peldano,
           count(*) AS lineas
      FROM l LEFT JOIN analytics.v_kepler_unit_ladder e
        ON e.sucursal = l.sucursal AND e.sku = l.sku
     GROUP BY 1 ORDER BY 2 DESC`);

  await medir(c, 'B3b · ¿f3 es relativo a la base o a u2? (costo3 / costo1 contra f3 y f2·f3)', `
    SELECT count(*) AS fichas_con_3_peldanos,
           count(*) FILTER (WHERE abs(costo3/costo1 - f3_cap)        <= 0.01*f3_cap)        AS costo3_igual_f3,
           count(*) FILTER (WHERE abs(costo3/costo1 - f2_cap*f3_cap) <= 0.01*f2_cap*f3_cap) AS costo3_igual_f2xf3
      FROM analytics.v_kepler_unit_ladder
     WHERE costo1 > 0 AND costo3 > 0 AND f2_cap > 1 AND f3_cap > 1`);

  // ── B4 ────────────────────────────────────────────────────────────────────────────────
  await medir(c, 'B4 · plaza atribuida de cada línea y si esa plaza tiene ficha estándar', `${LINEAS},
    o AS (
      SELECT l.*, coalesce(og.origen_veredicto, 'no_esta_en_origen') AS veredicto,
             coalesce(wo.kepler_code, CASE WHEN og.origen_veredicto = 'propio' THEN l.sucursal END) AS plaza_kepler,
             coalesce(og.origen_warehouse_name, CASE WHEN og.origen_veredicto = 'propio' THEN 'propia' END) AS plaza_nombre
        FROM l
        LEFT JOIN analytics.v_erp_goods_receipt_origin og ON og.sucursal = l.sucursal AND og.folio = l.folio
        LEFT JOIN commercial.warehouses wo ON wo.id = og.origen_warehouse_id
    )
    SELECT o.sucursal AS registrada_en, o.veredicto, o.plaza_nombre, o.plaza_kepler,
           count(*) AS lineas,
           count(sc.costo_estandar) AS con_estandar_en_la_plaza
      FROM o LEFT JOIN analytics.v_kepler_standard_cost sc
        ON sc.sucursal = o.plaza_kepler AND sc.sku = o.sku
     GROUP BY 1,2,3,4 ORDER BY 5 DESC`);

  // ── B5 / B6 ───────────────────────────────────────────────────────────────────────────
  await medir(c, 'B5 · desviación contra el estándar (tolerancia 0.5 %), sólo comparables', `${LINEAS},
    o AS (
      SELECT l.*, coalesce(wo.kepler_code, CASE WHEN og.origen_veredicto = 'propio' THEN l.sucursal END) AS plaza_kepler
        FROM l
        LEFT JOIN analytics.v_erp_goods_receipt_origin og ON og.sucursal = l.sucursal AND og.folio = l.folio
        LEFT JOIN commercial.warehouses wo ON wo.id = og.origen_warehouse_id
    ), f AS (
      -- factor = piezas por unidad comprada. Supone f3 relativo a la BASE; B3b dice si es así.
      SELECT o.*, sc.costo_estandar,
             CASE WHEN o.unidad = e.u1_label THEN 1
                  WHEN o.unidad = e.u2_label THEN nullif(e.f2_cap, 0)
                  WHEN o.unidad = e.u3_label THEN nullif(e.f3_cap, 0) END AS factor
        FROM o
        LEFT JOIN analytics.v_kepler_unit_ladder e ON e.sucursal = o.sucursal AND e.sku = o.sku
        LEFT JOIN analytics.v_kepler_standard_cost sc ON sc.sucursal = o.plaza_kepler AND sc.sku = o.sku
    ), b AS (SELECT f.*, f.costo / f.factor AS costo_base FROM f)
    SELECT CASE WHEN costo_base IS NULL       THEN 'unidad sin resolver'
                WHEN costo_estandar IS NULL   THEN 'plaza sin ficha estándar'
                WHEN costo_base > costo_estandar*(1+$1) THEN 'arriba'
                WHEN costo_base < costo_estandar*(1-$1) THEN 'abajo'
                ELSE 'igual' END AS veredicto,
           count(*) AS lineas,
           round(sum(cantidad * factor * (costo_base - costo_estandar)), 2) AS diferencia_pesos
      FROM b
     GROUP BY 1 ORDER BY 2 DESC`, [TOL]);

  // ── C · historial del costo estándar derivado de la venta ─────────────────────────────
  // Kepler no guarda historia de kdii.c77; cada renglón de venta congela el costo de la ficha
  // en kdm2.c62, por el peldaño vendido (c58 = piezas por ese peldaño). costo base = c62 / c58.
  // Sólo U-D-10 y U-D-6: en U-D-8 c62 viene vacío (VERDAD_ABSOLUTA §5).
  const VENTA = (filtroSku) => `
    SELECT l.sucursal::text AS sucursal, btrim(l.c8::text) AS sku, ap.c68::date AS fecha,
           nullif(regexp_replace(l.c62::text,'[^0-9.-]','','g'),'')::numeric
             / nullif(nullif(regexp_replace(l.c58::text,'[^0-9.-]','','g'),'')::numeric, 0) AS costo_base
      FROM kepler_ods.kdm1 ap
      JOIN kepler_ods.kdm2 l
        ON l.sucursal=ap.sucursal AND l.c1=ap.c1 AND l.c2=ap.c2 AND l.c3=ap.c3 AND l.c4=ap.c4 AND l.c6=ap.c6
     WHERE ap.c2='U' AND ap.c3='D' AND btrim(ap.c4::text) IN ('10','6')
       AND btrim(ap.c1::text)=ap.sucursal::text
       AND btrim(coalesce(ap.c43::text,'')) <> 'C'
       ${filtroSku}`;

  const SKU = process.env.SKU || '70001';

  await medir(c, `C1 · historial de UN producto (${SKU}, 365 d): escalones por plaza — gate < 1 s`, `
    WITH v AS (${VENTA(`AND btrim(l.c8) = $1 AND ap.c68::date >= current_date - 365`)}),
    d AS (SELECT sucursal, fecha, round(percentile_cont(0.5) WITHIN GROUP (ORDER BY costo_base)::numeric, 4) AS costo
            FROM v WHERE costo_base > 0 GROUP BY 1, 2),
    s AS (SELECT d.*, lag(costo) OVER (PARTITION BY sucursal ORDER BY fecha) AS antes FROM d)
    SELECT sucursal, fecha AS visto_desde, antes, costo AS despues
      FROM s WHERE antes IS DISTINCT FROM costo ORDER BY sucursal, fecha`, [SKU]);

  await medir(c, 'C2 · ¿el último costo congelado en la venta coincide con el c77 de hoy? (valida el método, 30 d)', `
    WITH v AS (${VENTA(`AND ap.c68::date >= current_date - 30`)}),
    u AS (SELECT DISTINCT ON (sucursal, sku) sucursal, sku, costo_base
            FROM v WHERE costo_base > 0 ORDER BY sucursal, sku, fecha DESC)
    SELECT count(*) AS pares,
           count(*) FILTER (WHERE abs(u.costo_base - sc.costo_estandar) <= 0.005 * sc.costo_estandar) AS coincide,
           count(*) FILTER (WHERE abs(u.costo_base - sc.costo_estandar) >  0.005 * sc.costo_estandar) AS no_coincide,
           count(*) FILTER (WHERE sc.costo_estandar IS NULL) AS sin_ficha
      FROM u LEFT JOIN analytics.v_kepler_standard_cost sc ON sc.sucursal = u.sucursal AND sc.sku = u.sku`);

  await medir(c, `C3 · compras del mismo producto (${SKU}, 365 d) — gate < 1 s`, `
    SELECT ap.sucursal, btrim(ap.c6::text) AS folio, ap.c68::date AS fecha,
           NULLIF(upper(btrim(l.c11::text)),'') AS unidad, l.c9 AS cantidad, l.c12 AS costo
      FROM kepler_ods.kdm2 l
      JOIN kepler_ods.kdm1 ap
        ON l.sucursal=ap.sucursal AND l.c1=ap.c1 AND l.c2=ap.c2 AND l.c3=ap.c3 AND l.c4=ap.c4 AND l.c6=ap.c6
     WHERE btrim(l.c8) = $1
       AND ap.c2='X' AND ap.c3='A' AND btrim(ap.c4::text)='20'
       AND btrim(ap.c1::text)=ap.sucursal::text
       AND btrim(coalesce(ap.c43::text,'')) <> 'C'
       AND ap.c68::date >= current_date - 365
     ORDER BY fecha DESC`, [SKU]);

  // ── D · la negociación: lista del proveedor → descuentos en cascada → costo estándar ──
  // Contexto de Compras (2026-10-04): el estándar ES la negociación. Se parte de la lista del
  // proveedor y caen descuentos (volumen, tipo de negocio, logística/recolección, pronto pago).
  // Kepler lo guarda en kdpv_prov_prod: c4 lista por unidad mayor, c5/c6/c7 % de descuento,
  // c8/c9/c10 neto por peldaño. Se prueba la aritmética y la liga con c77, no se supone.
  const NUM = (col) => `nullif(regexp_replace(p.${col}::text,'[^0-9.-]','','g'),'')::numeric`;
  await medir(c, 'D1 · ¿lista × (1−d1)(1−d2)(1−d3) = neto de la unidad mayor (c10)?', `
    WITH p AS (
      SELECT ${NUM('c4')} AS lista, coalesce(${NUM('c5')},0) AS d1, coalesce(${NUM('c6')},0) AS d2,
             coalesce(${NUM('c7')},0) AS d3, ${NUM('c8')} AS u1, ${NUM('c10')} AS u3
        FROM kepler_ods.kdpv_prov_prod p)
    SELECT count(*) AS filas,
           count(*) FILTER (WHERE d1>0 OR d2>0 OR d3>0) AS con_descuento,
           count(*) FILTER (WHERE abs(lista*(1-d1/100)*(1-d2/100)*(1-d3/100) - u3) <= 0.01*u3) AS cascada_cuadra_u3,
           count(*) FILTER (WHERE abs(lista*(1-d1/100)*(1-d2/100)*(1-d3/100) - u3) >  0.01*u3) AS no_cuadra
      FROM p WHERE lista > 0 AND u3 > 0`);

  await medir(c, 'D2 · ¿el neto por pieza del proveedor (c8) es el costo estándar de la ficha (c77)?', `
    WITH p AS (
      SELECT p.sucursal::text AS sucursal, btrim(p.c2::text) AS sku, btrim(p.c1::text) AS proveedor,
             ${NUM('c8')} AS u1
        FROM kepler_ods.kdpv_prov_prod p)
    SELECT count(*) AS pares,
           count(*) FILTER (WHERE abs(p.u1 - sc.costo_estandar) <= 0.005*sc.costo_estandar) AS igual_estandar,
           count(*) FILTER (WHERE abs(p.u1 - sc.costo_estandar) >  0.005*sc.costo_estandar) AS distinto,
           count(DISTINCT (p.sucursal, p.sku)) FILTER (WHERE true) AS fichas,
           count(*) - count(DISTINCT (p.sucursal, p.sku)) AS filas_de_2do_proveedor
      FROM p JOIN analytics.v_kepler_standard_cost sc ON sc.sucursal = p.sucursal AND sc.sku = p.sku
     WHERE p.u1 > 0 AND sc.costo_estandar > 0`);

  await medir(c, 'D3 · la cifra de Compras: ¿el 95 % de las líneas de entrada llega al estándar? y mercancía sin cargo', `${LINEAS}
    SELECT count(*) AS lineas,
           count(*) FILTER (WHERE costo = 0 OR costo IS NULL) AS sin_cargo_o_sin_costo,
           round(100.0 * count(*) FILTER (WHERE costo = 0 OR costo IS NULL) / nullif(count(*),0), 2) AS pct_sin_cargo
      FROM l`);
  console.log('D3: el % "apegado al estándar" sale de B5 (igual / comparables). Se contrasta contra el 95 % que reporta Compras.');

  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
