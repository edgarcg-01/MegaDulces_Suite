/* eslint-disable no-console */
/**
 * U.9.1 — CANDADO: el renglón de venta trae su propia conversión, y la vista la LEE sin inventarla.
 *
 * Nació de la pregunta de Edgar: *"¿por qué Kepler UI puede sacar las unidades correctamente y
 * nosotros no?"* La respuesta es que Kepler **no resuelve** la unidad — nunca la pierde. Cada
 * renglón de `kdm2` trae la escalera completa (`c11`/`c9`/`c12` la base · `c55`/`c56`/`c57`/`c58`
 * lo que el cliente compró, cuántos, a qué precio y con qué factor) y la pantalla del ERP la
 * imprime. Nosotros leíamos media línea y reconstruíamos la otra mitad desde catálogos.
 *
 * Lo que este candado protege, en orden de importancia:
 *
 *  1. **Los invariantes del renglón.** Si dejan de sostenerse, la premisa de toda la fase se cayó
 *     y hay que enterarse por acá, no por una cifra rara en una pantalla.
 *  2. **La NO CIRCULARIDAD.** La vista no puede tomar el factor de la etiquetera ni del resolvedor
 *     — si lo hiciera, "el renglón confirma al catálogo" sería una tautología. Se verifica sobre
 *     la definición de la vista, no sobre sus datos.
 *  3. **Que no se rellene con 1.** `sin_declarar` tiene que existir. Un 0 ahí significa que la
 *     vista está inventando un factor donde la fuente no lo da (ADR-056).
 *  4. **El hueco declarado.** Wincaja NO tiene conversión por renglón, y eso se afirma con su
 *     tamaño medido para que nadie lea esta fase como "la unidad ya está resuelta".
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-sales-line-units.js
 */
const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
/** Lo que no se puede medir se DECLARA, no se pinta de verde (ADR-056). */
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const N = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const pct = (a, b) => (b ? (100 * a / b) : 0);

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query("SET statement_timeout = '900s'");
  console.log('\n=== U.9.1 · el renglón declara su propia conversión de unidad ===\n');

  // ⚠️ VENTANA DE 90 DÍAS, y es una decisión medida, no una comodidad. Con los dos testigos de
  // K.0 la vista une `kdm2` (4M filas / 2 GB) contra las dos escaleras de Kepler, y una pasada
  // sobre 365 días cuesta ~17 s; el candado hace una docena y se iba de 600 s. 90 días es además
  // la ventana de TODAS las cifras que este archivo verifica, así que los pisos y la población
  // coinciden por construcción en vez de por casualidad.
  const DIAS = Number(process.env.LINE_UNITS_DAYS || 90);

  const exists = (await c.query(
    `SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.v_erp_sales_line_units')`)).rows[0];
  if (!exists) {
    nomedido('la vista no existe en este destino', 'corré la mig 20260907240000 primero');
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end();
    process.exit(fail ? 1 : 0);
  }

  // ── 1. Forma: vista derive-no-copy, con RLS y grant ────────────────────────────────────────
  console.log('── 1. La forma ──');
  check('es VISTA, no tabla copiada (regla ⭐ del proyecto)', exists.relkind === 'v', `relkind=${exists.relkind}`);

  const inv = (await c.query(`SELECT reloptions FROM pg_class
     WHERE oid = to_regclass('analytics.v_erp_sales_line_units')`)).rows[0];
  check('⭐ conserva security_invoker (se pierde en cada CREATE OR REPLACE — lección U.7)',
    (inv.reloptions || []).some((o) => /security_invoker\s*=\s*true/i.test(o)),
    `reloptions=${JSON.stringify(inv.reloptions)}`);

  const grant = (await c.query(
    `SELECT has_table_privilege('app_runtime','analytics.v_erp_sales_line_units','SELECT') AS g`)).rows[0];
  check('app_runtime puede leerla (el GRANT tampoco se hereda)', grant.g);

  // ── 2. NO CIRCULARIDAD ⭐ ──────────────────────────────────────────────────────────────────
  // Es la aserción más importante del archivo. El valor de este trabajo es que el renglón es un
  // testigo INDEPENDIENTE del catálogo; si la vista leyera el catálogo, no probaría nada.
  console.log('\n── 2. El testigo es independiente ──');
  const def = (await c.query(
    `SELECT pg_get_viewdef(to_regclass('analytics.v_erp_sales_line_units'), true) AS d`)).rows[0].d;
  check('⭐ lee kepler_ods.kdm2 (la fuente cruda)', /kepler_ods\.kdm2/i.test(def));

  // ⚠️ Esta aserción CAMBIÓ de forma, y el motivo importa. Antes prohibía todo catálogo, para que
  // "el renglón confirma al catálogo" no fuera tautología. Pero K.0 agregó a propósito dos testigos
  // de KEPLER — la escalera de lo PAGADO (`v_supplier_cost_ladder`, derivada de
  // `kepler_ods.kdpv_prov_prod`) y la de precios (`v_product_unit_ladder`, de `kdii`) — porque el
  // punto de la fase es que **Kepler se juzgue con Kepler**. Lo que sigue prohibido, y es lo que de
  // verdad rompería la independencia, son las fuentes AJENAS a Kepler: la etiquetera y Wincaja.
  for (const permitida of ['v_supplier_cost_ladder', 'v_product_unit_ladder']) {
    check(`✔ SÍ usa ${permitida} — es Kepler juzgando a Kepler, no un catálogo ajeno`,
      new RegExp(permitida, 'i').test(def));
  }
  for (const prohibida of ['product_label_prices', 'factor_sale', 'wincaja',
    'v_product_box_factor', 'v_warehouse_box_factor']) {
    check(`⛔ NO consulta ${prohibida} — una fuente ajena a Kepler rompería la independencia`,
      !new RegExp(prohibida, 'i').test(def));
  }
  check('⛔ no une kdm1 (el join al encabezado duplica 2× — ERP_KEPLER §146-149)',
    !/kdm1/i.test(def));

  // ── UNA SOLA PASADA ⭐ ────────────────────────────────────────────────────────────────────
  // ⚠️ Esto no es una optimización cosmética: es la diferencia entre un candado que corre y uno
  // que muere. Con los dos testigos de K.0 la vista une `kdm2` (4M filas / 2 GB) contra DOS
  // escaleras que a su vez son vistas sobre el ODS, así que **cada aserción re-derivaba las
  // escaleras**. Medido: una pasada ~13-17 s, y el archivo hacía una docena → `statement timeout`
  // primero a 365 días y después también a 90.
  //
  // Se materializa UNA vez a una tabla temporal (de la sesión, se muere con ella — no es una copia
  // de las que la regla ⭐ del proyecto prohíbe) y todas las aserciones van contra ella. De paso:
  // el candado deja de golpear prod doce veces.
  const t0 = Date.now();
  await c.query(`
    CREATE TEMP TABLE lin AS
    SELECT tenant_id, fecha, doctype, sku, importe, cantidad_base, cantidad_vendida, precio_base, precio_vendido,
           factor_declarado, factor_resuelto, factor_source, cuadra,
           costo_linea, costo_base_pagado, factor_por_costo, factor_por_precio, certeza,
           unidad_base, unidad_vendida, warehouse_code, almacen_erp, sucursal
      FROM analytics.v_erp_sales_line_units
     WHERE tenant_id='${T}'::uuid AND fecha > current_date - ${DIAS}`);
  const nLin = (await c.query('SELECT count(*)::int n FROM lin')).rows[0].n;
  await c.query('ANALYZE lin');
  console.log(`(ventana ${DIAS} días · ${N(nLin)} renglones materializados en ${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
  const base = 'FROM lin WHERE true';

  // ── 2b. El corte de doctypes ⛔ ────────────────────────────────────────────────────────────
  // Este candado nace de un defecto propio: la primera versión de la vista incluía `U-D-6`
  // (Factura GLOBAL), que RE-FACTURA los tickets de `U-D-10` — medido: 93.1% de sus renglones
  // traen la MISMA cantidad del mismo SKU el mismo día. También entraron `U-D-40` (Pedido) y
  // `U-D-90` (Saldar Documentos), que ni siquiera son venta. El síntoma fue el invariante del
  // importe cayendo a 61.22% (18.29% dentro de U-D-6): una factura global agrega varios tickets
  // en un renglón, así que su `c56` no multiplica su `c57`.
  console.log('\n── 2b. El corte de doctypes (anti-regresión del defecto de U.10.0) ──');
  const docs = (await c.query(`SELECT DISTINCT doctype ${base}`)).rows.map((r) => r.doctype).sort();
  console.log(`     doctypes en la vista: ${docs.join(' · ')}`);
  for (const prohibido of ['U-D-6', 'U-D-5', 'U-D-40', 'U-D-41', 'U-D-90']) {
    check(`⛔ ${prohibido} NO entra`, !docs.includes(prohibido));
  }
  check('⭐ el corte es el MISMO que mv_kepler_sales_daily (8/10/12) — si divergen, comparar peldaño contra cifra publicada mediría dos poblaciones',
    docs.join(',') === 'U-D-10,U-D-12,U-D-8', `visto=${docs.join(',')}`);

  // ── 3. Los tres invariantes del renglón ────────────────────────────────────────────────────
  console.log('\n── 3. Los invariantes (los pisos son lo MEDIDO en prod 2026-09-07) ──');

  const i1 = (await c.query(`
    SELECT count(*) FILTER (WHERE factor_declarado > 0)::int con_c58,
           count(*) FILTER (WHERE factor_declarado > 0 AND cuadra)::int cuadran,
           round(sum(importe) FILTER (WHERE factor_declarado > 0 AND NOT cuadra)::numeric,0) imp_malo
      ${base}`)).rows[0];
  const p1 = pct(i1.cuadran, i1.con_c58);
  console.log(`     cantidad = cuantos × factor: ${N(i1.cuadran)}/${N(i1.con_c58)} = ${p1.toFixed(2)}% · no cierra ${money(i1.imp_malo)}`);
  check('⭐ el invariante c9 = c56 × c58 se sostiene (≥ 99%)', p1 >= 99, `${p1.toFixed(2)}%`);

  const i2 = (await c.query(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE abs(importe - cantidad_vendida * precio_vendido) <= 0.05)::int cuadran
      ${base} AND cantidad_vendida > 0 AND precio_vendido > 0 AND importe > 0`)).rows[0];
  const p2 = pct(i2.cuadran, i2.n);
  console.log(`     importe = cuantos × precio_vendido: ${N(i2.cuadran)}/${N(i2.n)} = ${p2.toFixed(2)}%`);
  check('el invariante c13 = c56 × c57 se sostiene (≥ 98%)', p2 >= 98, `${p2.toFixed(2)}%`);

  // ⚠️ La tolerancia es RELATIVA al factor, y eso NO es aflojar el umbral: el factor es un ENTERO
  // y los dos precios vienen redondeados (2 a 6 decimales), así que el error admisible escala con
  // el factor. Con tolerancia absoluta de $0.02 un factor de 140 revienta por una diferencia de
  // precio del 0.015%. Medido: absoluta 92.82% · relativa 2% 96.89% · relativa 10% 96.90% — subirla
  // más no rescata nada, o sea el residuo NO es redondeo.
  //
  // Ese residuo es DESCUENTO, y la asimetría lo prueba: 2,246 renglones traen `c12` rebajado contra
  // 41 inflados, y la mediana de (c57/c12)/c58 es exactamente 1.0000. El precio unitario se
  // descuenta y el del paquete no. Se imprime por doctype para que se vea de dónde sale: la
  // Factura Telemarketing (`U-D-8`) descuenta mucho más (75.3%) que el mostrador (95.7%).
  const i3 = (await c.query(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE abs(precio_vendido / NULLIF(precio_base,0) - factor_declarado)
                                  <= 0.02 * factor_declarado)::int cuadran
      ${base} AND unidad_vendida IS DISTINCT FROM unidad_base
        AND precio_base > 0 AND precio_vendido > 0 AND factor_declarado > 0`)).rows[0];
  const p3 = pct(i3.cuadran, i3.n);
  const porDoc = (await c.query(`
    SELECT doctype, count(*)::int n,
           count(*) FILTER (WHERE abs(precio_vendido / NULLIF(precio_base,0) - factor_declarado)
                                  <= 0.02 * factor_declarado)::int ok
      ${base} AND unidad_vendida IS DISTINCT FROM unidad_base
        AND precio_base > 0 AND precio_vendido > 0 AND factor_declarado > 0
     GROUP BY 1 ORDER BY n DESC`)).rows;
  console.log(`     precio_vendido / precio_base = factor: ${N(i3.cuadran)}/${N(i3.n)} = ${p3.toFixed(2)}%`
    + `  [${porDoc.map((r) => `${r.doctype} ${pct(r.ok, r.n).toFixed(1)}%`).join(' · ')}]`);
  check('el invariante c57/c12 = c58 se sostiene (≥ 96%, tolerancia relativa; el resto es descuento)',
    p3 >= 96, `${p3.toFixed(2)}%`);

  // ── 4. Cobertura, y que NO se rellene con 1 ────────────────────────────────────────────────
  console.log('\n── 4. Cobertura, y el hueco declarado ──');
  const cov = (await c.query(`
    SELECT factor_source, count(*)::int n, round(sum(importe)::numeric,0) imp ${base}
     GROUP BY 1 ORDER BY n DESC`)).rows;
  const tot = cov.reduce((s, r) => s + r.n, 0);
  for (const r of cov) console.log(`     ${String(r.factor_source).padEnd(14)} ${N(r.n).padStart(9)} (${pct(r.n, tot).toFixed(2)}%) ${money(r.imp)}`);
  const sinDecl = cov.find((r) => r.factor_source === 'sin_declarar');
  const resueltos = tot - (sinDecl ? sinDecl.n : 0);
  check('⭐ la conversión del renglón resuelve ≥ 95% de los renglones',
    pct(resueltos, tot) >= 95, `${pct(resueltos, tot).toFixed(2)}%`);
  check('⛔ `sin_declarar` EXISTE — un 0 significaría que la vista inventa el factor (ADR-056)',
    !!sinDecl && sinDecl.n > 0, sinDecl ? `${N(sinDecl.n)} renglones` : 'ninguno');

  const relleno = (await c.query(`
    SELECT count(*)::int n ${base} AND factor_source = 'sin_declarar' AND factor_resuelto IS NOT NULL`)).rows[0];
  check('⛔ `sin_declarar` viaja con factor NULL, jamás con 1 de relleno', relleno.n === 0, `${relleno.n} con factor`);

  // ── 4c. ⭐ EL ÁRBITRO: el COSTO de Kepler confirma la unidad del renglón ───────────────────
  // Es la verdad absoluta de la fase, y la regla es una sola:
  //     c62 (costo del renglón) = u1_cost (lo que Kepler pagó por una unidad base) × c58 (el factor)
  // Medido: 98.36% de 674,182 renglones, mediana EXACTAMENTE 1.0000, parejo en las 6 sucursales.
  console.log('\n── 4c. ⭐ El COSTO de Kepler como árbitro de la unidad ──');
  const cer = (await c.query(`
    SELECT certeza, count(*)::int n, round(sum(importe)::numeric,0) imp ${base}
     GROUP BY 1 ORDER BY n DESC`)).rows;
  const totCer = cer.reduce((s, r) => s + r.n, 0);
  for (const r of cer) {
    console.log(`     ${String(r.certeza).padEnd(13)} ${N(r.n).padStart(8)} (${pct(r.n, totCer).toFixed(2)}%)  ${money(r.imp)}`);
  }
  const conf = cer.find((r) => r.certeza === 'confirmado');
  const contra = cer.find((r) => r.certeza === 'contradicho');
  check('⭐ el COSTO de Kepler confirma la unidad del renglón en ≥ 94%',
    !!conf && pct(conf.n, totCer) >= 94, conf ? `${pct(conf.n, totCer).toFixed(2)}%` : 'ninguno');
  // Si el costo NUNCA contradijera, no seria un arbitro: seria un espejo del factor declarado.
  check('⛔ `contradicho` EXISTE — un árbitro que nunca contradice es un espejo, no un testigo',
    !!contra && contra.n > 0, contra ? `${N(contra.n)} renglones ${money(contra.imp)}` : 'ninguno');
  check('⛔ y `contradicho` no se come la población (≤ 5%)',
    !contra || pct(contra.n, totCer) <= 5, contra ? `${pct(contra.n, totCer).toFixed(2)}%` : '0');

  const regla = (await c.query(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE abs(costo_linea / NULLIF(costo_base_pagado * factor_resuelto, 0) - 1) <= 0.15)::int cuadra,
           round(percentile_cont(0.5) WITHIN GROUP (
             ORDER BY costo_linea / NULLIF(costo_base_pagado * factor_resuelto, 0))::numeric, 4) mediana
      ${base} AND costo_linea > 0 AND costo_base_pagado > 0 AND factor_resuelto > 0`)).rows[0];
  console.log(`     la regla c62 = u1_cost × c58: ${N(regla.cuadra)}/${N(regla.n)} = ${pct(regla.cuadra, regla.n).toFixed(2)}% · mediana ${regla.mediana}`);
  check('⭐ la regla `c62 = u1_cost × c58` se sostiene (≥ 97%)',
    pct(regla.cuadra, regla.n) >= 97, `${pct(regla.cuadra, regla.n).toFixed(2)}%`);
  check('⭐ y su mediana es 1.0000 — el costo no está sesgado hacia ningún peldaño',
    Math.abs(Number(regla.mediana) - 1) <= 0.02, `mediana=${regla.mediana}`);

  // ── 4d. ⛔ El PRECIO no vota, y por qué ───────────────────────────────────────────────────
  // Mi primera version puso los tres testigos a votar y `en_conflicto` cargaba $21.6M. Casi todo
  // lo generaba el precio: dice "factor 1" cuando el renglon declara 12 y el costo dice 10. Es
  // DESCUENTO, no conflicto de unidad. En U-D-8 (Telemarketing) fallaba en el 56.9%.
  console.log('\n── 4d. ⛔ El precio se conserva pero NO vota ──');
  const px = (await c.query(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE factor_por_precio IS NOT NULL
                              AND factor_por_precio <> factor_resuelto)::int px_contradice,
           count(*) FILTER (WHERE factor_por_costo IS NOT NULL
                              AND factor_por_costo <> factor_resuelto)::int costo_contradice,
           round(sum(importe) FILTER (WHERE factor_por_precio IS NOT NULL
                              AND factor_por_precio <> factor_resuelto)::numeric,0) imp_px
      ${base} AND factor_resuelto IS NOT NULL`)).rows[0];
  console.log(`     el PRECIO contradice en ${N(px.px_contradice)} renglones (${money(px.imp_px)})`);
  console.log(`     el COSTO  contradice en ${N(px.costo_contradice)}`);
  check('⭐ el precio contradice MUCHO más que el costo — por eso no vota (es descuento, no unidad)',
    px.px_contradice > px.costo_contradice * 3,
    `precio ${N(px.px_contradice)} vs costo ${N(px.costo_contradice)}`);
  // ⛔ Que el precio no vote se verifica por COMPORTAMIENTO, no parseando la definición de la
  // vista. (Mi primer intento recortaba el SQL con `split` para aislar la expresión de `certeza` y
  // fallaba por la forma en que Postgres reimprime el CASE — un candado frágil que se rompe con un
  // reformateo es peor que no tenerlo.)
  //
  // El invariante: una fila donde el PRECIO contradice pero el COSTO confirma tiene que quedar
  // `confirmado`. Si `certeza` leyera el precio, esas filas caerían en conflicto — y son 59,299
  // renglones por $21.6M, así que la prueba es amplia.
  const noVota = (await c.query(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE certeza = 'confirmado')::int siguen_confirmadas
      ${base} AND factor_resuelto IS NOT NULL
        AND factor_por_precio IS NOT NULL AND factor_por_precio <> factor_resuelto
        AND factor_por_costo  IS NOT NULL AND factor_por_costo  = factor_resuelto`)).rows[0];
  console.log(`     filas donde el precio contradice y el costo confirma: ${N(noVota.n)}`);
  check('⛔ el precio NO vota: donde contradice pero el costo confirma, la fila sigue `confirmado`',
    noVota.n > 1000 && noVota.n === noVota.siguen_confirmadas,
    `${N(noVota.siguen_confirmadas)} de ${N(noVota.n)} — si no coinciden, el precio volvió al veredicto`);

  // ── 5. El renglón coincide con el catálogo — SIN habérselo preguntado ──────────────────────
  // Acá sí se cruza contra la etiquetera, pero DESDE EL TEST, no desde la vista. Es la prueba de
  // que los dos testigos independientes dicen lo mismo.
  console.log('\n── 5. Dos testigos independientes que coinciden ──');
  const escalera = (await c.query(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE abs(l.factor_declarado - k.f2) <= 0.01)::int es_f2,
           count(*) FILTER (WHERE abs(l.factor_declarado - k.f3) <= 0.01)::int es_f3
      FROM lin l
      JOIN analytics.v_product_unit_ladder k ON k.sku = l.sku
     WHERE l.tenant_id='${T}'::uuid AND l.fecha > current_date - ${DIAS} AND l.factor_declarado > 1`)).rows[0];
  const coincide = escalera.es_f2 + escalera.es_f3;
  console.log(`     factor del renglón vs escalera del catálogo: =f2 ${N(escalera.es_f2)} · =f3 ${N(escalera.es_f3)} de ${N(escalera.n)}`);
  check('⭐ el factor del renglón confirma la escalera del catálogo en ≥ 50,000 renglones',
    coincide >= 50000, `${N(coincide)}`);

  // ── 6. Las tres pruebas de fondo, SKU por SKU ──────────────────────────────────────────────
  // `70031` es el SKU que docs/UNIDADES_DE_MEDIDA.md cita como prueba de que "el rótulo c11
  // miente". No miente: la cantidad SÍ está en piezas, y c55/c56/c58 dicen que fueron 3 paquetes
  // de 16. Si esta aserción cae, la corrección de esa sección del doc quedó sin sustento.
  console.log('\n── 6. Las pruebas de fondo ──');
  const t70031 = (await c.query(`
    SELECT count(*)::int n FROM lin
     WHERE tenant_id='${T}'::uuid AND sku='70031'
       AND unidad_base='PZA' AND unidad_vendida='PAQ' AND factor_declarado=16 AND cuadra`)).rows[0];
  check('⭐ `70031`: los renglones marcados PZA que "mentían" son paquetes de 16 declarados',
    t70031.n > 0, `${N(t70031.n)} renglones`);

  // `42029` en `01` es la celda donde el árbitro de dinero dijo que NINGÚN divisor acierta. El
  // renglón explica por qué: se vende en TRES unidades dentro del mismo almacén.
  const t42029 = (await c.query(`
    SELECT count(DISTINCT unidad_vendida)::int unidades,
           string_agg(DISTINCT unidad_vendida || ':' || factor_declarado::text, ' · ') detalle
      FROM lin
     WHERE tenant_id='${T}'::uuid AND sku='42029' AND warehouse_code='01'
       AND fecha > current_date - ${DIAS} AND factor_declarado > 0`)).rows[0];
  console.log(`     42029 en 01 → ${t42029.detalle}`);
  check('⭐ `42029` en `01` se vende en ≥ 2 unidades distintas — por eso ningún divisor único acierta',
    t42029.unidades >= 2, `${t42029.unidades} unidades`);

  // ── 7. Las 6 rutas que el resolvedor NO puede cubrir, el renglón sí ────────────────────────
  console.log('\n── 7. Las rutas que el resolvedor declara sin cubrir ──');
  const rutas = (await c.query(`
    SELECT count(*)::int n, count(*) FILTER (WHERE factor_resuelto IS NOT NULL)::int con_factor,
           count(DISTINCT warehouse_code)::int almacenes
      ${base} AND warehouse_code LIKE 'RUTA-%'`)).rows[0];
  console.log(`     ${N(rutas.n)} renglones en ${rutas.almacenes} rutas · con factor ${pct(rutas.con_factor, rutas.n).toFixed(1)}%`);
  if (rutas.n === 0) {
    nomedido('las rutas de Kepler', 'no hay renglones de sub-almacén en la ventana');
  } else {
    check('⭐ el renglón cubre las rutas que `v_unit_truth_coverage` declara SIN cubrir (≥ 99%)',
      pct(rutas.con_factor, rutas.n) >= 99, `${pct(rutas.con_factor, rutas.n).toFixed(1)}%`);
  }

  // ── 8. El anti-réplica no se comió las rutas, y sí se comió la réplica ─────────────────────
  console.log('\n── 8. El anti-réplica ──');
  const rep = (await c.query(`
    SELECT count(*)::int n FROM lin
     WHERE tenant_id='${T}'::uuid AND sucursal='03' AND almacen_erp='02'`)).rows[0];
  check('⛔ la réplica (suc 03 con almacén 02, 112k renglones/$7.5M) queda FUERA',
    rep.n === 0, `${N(rep.n)} renglones colados`);
  const sub = (await c.query(`
    SELECT count(DISTINCT almacen_erp)::int n FROM lin
     WHERE tenant_id='${T}'::uuid AND almacen_erp LIKE '01-%'`)).rows[0];
  check('✔ pero los sub-almacenes de ruta (01-00N) quedan DENTRO', sub.n >= 5, `${sub.n} sub-almacenes`);

  // ── 9. LO QUE ESTA FASE NO RESUELVE — se declara, no se calla ⭐ ───────────────────────────
  // Sin esto, alguien lee "la unidad ya se resuelve por renglón" y lo aplica a todo el negocio.
  console.log('\n── 9. El hueco, declarado con su tamaño ──');
  const wc = (await c.query(`
    SELECT count(*)::int filas, round(sum(revenue)::numeric,0) venta,
           count(rung_factor)::int con_peldano
      FROM analytics.sales_daily
     WHERE tenant_id='${T}'::uuid AND sale_date > current_date - 365
       AND channel LIKE 'wincaja_%'`)).rows[0];
  const tt = (await c.query(`
    SELECT round(sum(revenue)::numeric,0) venta FROM analytics.sales_daily
     WHERE tenant_id='${T}'::uuid AND sale_date > current_date - 365`)).rows[0];
  console.log(`     Wincaja: ${N(wc.filas)} filas · ${money(wc.venta)} = ${pct(wc.venta, tt.venta).toFixed(1)}% de la venta`);
  check('⛔ Wincaja NO tiene conversión por renglón, y su importer NO escribe el peldaño',
    wc.con_peldano === 0,
    `${N(wc.con_peldano)} filas con peldaño — si esto deja de ser 0, alguien lo empezó a escribir y hay que revisar el candado`);
  console.log(`     ⚠️  Por eso HOY \`rung_factor IS NULL\` significa TRES cosas: peldaños mezclados,`);
  console.log(`        fila de Wincaja (${pct(wc.venta, tt.venta).toFixed(0)}% de la venta), o "todavía no se escribió".`);
  console.log(`        Cualquier auditoría con ese predicado barre Wincaja entera.`);

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
