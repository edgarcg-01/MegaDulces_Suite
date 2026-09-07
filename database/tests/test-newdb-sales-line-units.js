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

  const base = `FROM analytics.v_erp_sales_line_units
                WHERE tenant_id='${T}'::uuid AND fecha > current_date - 365`;

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
  for (const prohibida of ['v_product_unit_ladder', 'v_product_box_factor', 'v_warehouse_box_factor',
    'product_label_prices', 'factor_sale', 'v_supplier_cost_ladder']) {
    check(`⛔ NO consulta ${prohibida} — si lo hiciera, "el renglón confirma al catálogo" sería tautología`,
      !new RegExp(prohibida, 'i').test(def));
  }
  check('⛔ no une kdm1 (el join al encabezado duplica 2× — ERP_KEPLER §146-149)',
    !/kdm1/i.test(def));

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

  // ── 5. El renglón coincide con el catálogo — SIN habérselo preguntado ──────────────────────
  // Acá sí se cruza contra la etiquetera, pero DESDE EL TEST, no desde la vista. Es la prueba de
  // que los dos testigos independientes dicen lo mismo.
  console.log('\n── 5. Dos testigos independientes que coinciden ──');
  const conf = (await c.query(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE abs(l.factor_declarado - k.f2) <= 0.01)::int es_f2,
           count(*) FILTER (WHERE abs(l.factor_declarado - k.f3) <= 0.01)::int es_f3
      FROM analytics.v_erp_sales_line_units l
      JOIN analytics.v_product_unit_ladder k ON k.sku = l.sku
     WHERE l.tenant_id='${T}'::uuid AND l.fecha > current_date - 365 AND l.factor_declarado > 1`)).rows[0];
  const coincide = conf.es_f2 + conf.es_f3;
  console.log(`     factor del renglón vs escalera del catálogo: =f2 ${N(conf.es_f2)} · =f3 ${N(conf.es_f3)} de ${N(conf.n)}`);
  check('⭐ el factor del renglón confirma la escalera del catálogo en ≥ 50,000 renglones',
    coincide >= 50000, `${N(coincide)}`);

  // ── 6. Las tres pruebas de fondo, SKU por SKU ──────────────────────────────────────────────
  // `70031` es el SKU que docs/UNIDADES_DE_MEDIDA.md cita como prueba de que "el rótulo c11
  // miente". No miente: la cantidad SÍ está en piezas, y c55/c56/c58 dicen que fueron 3 paquetes
  // de 16. Si esta aserción cae, la corrección de esa sección del doc quedó sin sustento.
  console.log('\n── 6. Las pruebas de fondo ──');
  const t70031 = (await c.query(`
    SELECT count(*)::int n FROM analytics.v_erp_sales_line_units
     WHERE tenant_id='${T}'::uuid AND sku='70031'
       AND unidad_base='PZA' AND unidad_vendida='PAQ' AND factor_declarado=16 AND cuadra`)).rows[0];
  check('⭐ `70031`: los renglones marcados PZA que "mentían" son paquetes de 16 declarados',
    t70031.n > 0, `${N(t70031.n)} renglones`);

  // `42029` en `01` es la celda donde el árbitro de dinero dijo que NINGÚN divisor acierta. El
  // renglón explica por qué: se vende en TRES unidades dentro del mismo almacén.
  const t42029 = (await c.query(`
    SELECT count(DISTINCT unidad_vendida)::int unidades,
           string_agg(DISTINCT unidad_vendida || ':' || factor_declarado::text, ' · ') detalle
      FROM analytics.v_erp_sales_line_units
     WHERE tenant_id='${T}'::uuid AND sku='42029' AND warehouse_code='01'
       AND fecha > current_date - 365 AND factor_declarado > 0`)).rows[0];
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
    SELECT count(*)::int n FROM analytics.v_erp_sales_line_units
     WHERE tenant_id='${T}'::uuid AND sucursal='03' AND almacen_erp='02'`)).rows[0];
  check('⛔ la réplica (suc 03 con almacén 02, 112k renglones/$7.5M) queda FUERA',
    rep.n === 0, `${N(rep.n)} renglones colados`);
  const sub = (await c.query(`
    SELECT count(DISTINCT almacen_erp)::int n FROM analytics.v_erp_sales_line_units
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
