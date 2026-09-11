/* eslint-disable no-console */
/**
 * CANDADO — EL COSTO UNITARIO, UN SOLO RESOLVEDOR PARA LOS DOS ERPs (KE.3).
 *
 * Pedido de Edgar (2026-09-10): *"ya aplicamos esto en sell-out, pedido, existencias. en todas
 * las tablas que necesitan de la misma verdad?"* — la medición dijo **no**. La verdad se había
 * aplicado en el eje de la UNIDAD y no en el del COSTO.
 *
 * ── Lo que este candado protege ─────────────────────────────────────────────────────────────
 *
 * `analytics.v_erp_unit_cost` resuelve el costo por **almacén × producto** con el testigo del
 * MISMO ERP que la cantidad: `kdik.c16` en Kepler, `existencias.costo_promedio` en Wincaja. El
 * catálogo queda de fallback DECLARADO, y sin nada es NULL — nunca cero.
 *
 * Seis consumidores lo leen: capital parado, clase ABC, inventario (lista + caducidad),
 * rentabilidad y conteo cíclico (incluido **el costo que se congela al reconciliar**, que era el
 * que más importaba porque queda escrito).
 *
 * ⛔ **Y dos consumidores NO lo leen, a propósito**: `commercial-replenishment.service.ts` y
 * `replenishment-scanner.service.ts` valorizan **el sugerido de compra**, o sea lo que se va a
 * PAGAR, y ahí el costo correcto es `cost_with_tax` — confirmado midiendo en U.0:
 * `cost_with_tax = u1_cost × (1+impuesto)`, con razones 1.0000/1.0800/1.1600/1.2400 exactas sobre
 * 6,626 SKUs. El árbitro de acá es el promedio ponderado HISTÓRICO y neto de impuesto: usarlo
 * para una orden de compra respondería otra pregunta y la subdeclararía 8–24%. Eso también se
 * asegura acá, para que nadie lo "unifique" por prolijidad.
 *
 * ── Las trampas que ya cobraron y este archivo vigila ───────────────────────────────────────
 *
 * ⭐ **3,164 filas de Kepler empatan también contra un testigo de Wincaja** (mismo SKU, otra
 * plaza). Un `COALESCE(kepler, wincaja, catálogo)` les daría el costo del ERP equivocado sin que
 * nadie lo note. Por eso la vista usa un `CASE` sobre `erp`, y el bloque 2 lo prueba en cero —
 * **con prueba negativa**: el mismo bloque demuestra que el COALESCE ingenuo SÍ contaminaba.
 *
 * ⭐ La vista **enumera los 191,012 pares completos**, no sólo los que tienen costo: una fila
 * ausente llega NULL a un LEFT JOIN y se lee como sana (lección de `v_unit_truth_coverage`).
 *
 * ── Medido al escribirlo (prod, 2026-09-10) ─────────────────────────────────────────────────
 *
 *     pares ....................... 191,012  (el mismo grano exacto que v_unit_truth)
 *     con testigo del ERP ......... 25,324 de 25,573 filas CON EXISTENCIA  (99.03%)
 *     cruces entre ERPs ........... 0
 *     capital hoy vs resolvedor ... $71,744,359 -> $69,493,270   (-$2,251,089)
 *     Wincaja, identidad interna .. costo_existencia/existencia == costo_promedio en 99.56%
 */

const { Client } = require('pg');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();

let ok = 0; let fail = 0; let skip = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const nomedido = (label, why) => { skip++; console.log(`  ○ NO MEDIDO — ${label}: ${why}`); };
const N = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const money = (n) => `$${N(n)}`;
const pct = (a, b) => (b ? (100 * Number(a) / Number(b)) : 0);

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '600s'`);
  const q = async (sql) => (await c.query(sql)).rows;

  console.log('\n=== CANDADO: el costo unitario, un solo resolvedor (KE.3) ===\n');

  // ── 1. La vista existe, con sus metadatos ─────────────────────────────────────────────────
  console.log('── 1. La vista y sus metadatos ──');
  const meta = (await q(`
    SELECT c.relkind::text AS kind, COALESCE(array_to_string(c.reloptions, ','), '') AS opts
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = 'v_erp_unit_cost'`))[0];
  check('analytics.v_erp_unit_cost existe y es una VISTA (derivar, no copiar)',
    !!meta && meta.kind === 'v', meta ? `relkind=${meta.kind}` : 'no existe');
  // ⚠️ U.7: `CREATE OR REPLACE VIEW` no hereda security_invoker ni el GRANT. Ya se perdió una vez
  // en esta base y sólo lo cazó una aserción de metadata como ésta.
  check('⚠️ conserva `security_invoker` (no se hereda tras CREATE OR REPLACE)',
    !!meta && meta.opts.includes('security_invoker'), meta ? meta.opts || '(sin opciones)' : '');
  const grant = (await q(`
    SELECT has_table_privilege('app_runtime', 'analytics.v_erp_unit_cost', 'SELECT') AS g`))[0];
  check('⚠️ conserva el GRANT a app_runtime', grant.g === true);

  // ── 2. ⛔ EL GUARD: cada ERP con SU evidencia ─────────────────────────────────────────────
  console.log('\n── 2. ⛔ Cada ERP con su propia evidencia ──');
  const cruce = (await q(`
    SELECT count(*) FILTER (WHERE erp = 'kepler'  AND costo_source LIKE 'wincaja%')::int k,
           count(*) FILTER (WHERE erp = 'wincaja' AND costo_source LIKE 'kepler%')::int w
      FROM analytics.v_erp_unit_cost`))[0];
  check('⭐⭐ CERO filas toman el costo del OTRO ERP', cruce.k === 0 && cruce.w === 0,
    `${cruce.k} Kepler con costo Wincaja · ${cruce.w} al revés`);

  // ⭐⭐ LA PRUEBA NEGATIVA, Y ES LA QUE HACE QUE EL CERO DE ARRIBA SIGNIFIQUE ALGO. Sin ella,
  // "cruces = 0" puede ser que el riesgo no exista y no que el guard funcione (ADR-056: un gate
  // sin prueba negativa es una intención). Acá se ejecuta la versión INGENUA
  // —`COALESCE(kepler, wincaja)`— y se mide exactamente qué habría contaminado.
  // Medido al escribir esto: 944,173 pares, de los cuales 5,147 CON existencia = $2,016,789
  // valuados con el costo del ERP equivocado.
  const ingenuo = (await q(`
    WITH ing AS (
      SELECT CASE WHEN w.kepler_code IS NOT NULL THEN 'kepler' ELSE 'wincaja' END AS erp,
             w.id wid, p.id pid,
             COALESCE(kc.costo_unitario, wv.costo_promedio) AS costo,
             CASE WHEN kc.costo_unitario > 0 THEN 'kepler_kdik'
                  WHEN wv.costo_promedio > 0 THEN 'wincaja_costo_promedio'
                  ELSE 'sin_costo' END AS src
        FROM commercial.warehouses w
        JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
        LEFT JOIN analytics.v_kepler_unit_cost kc
               ON kc.tenant_id = w.tenant_id AND kc.warehouse_id = w.id AND kc.product_id = p.id
        LEFT JOIN wincaja.v_stock wv
               ON wv.tenant_id = w.tenant_id AND wv.sku = p.sku::text AND wv.costo_promedio > 0
       WHERE w.deleted_at IS NULL
         AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL))
    SELECT count(*) FILTER (WHERE i.erp = 'kepler' AND i.src LIKE 'wincaja%')::int pares,
           count(s.product_id) FILTER (WHERE i.erp = 'kepler' AND i.src LIKE 'wincaja%')::int con_stock,
           round(sum(s.quantity * i.costo) FILTER (WHERE i.erp = 'kepler'
                                               AND i.src LIKE 'wincaja%'))::numeric dinero
      FROM ing i
      LEFT JOIN commercial.stock s
             ON s.warehouse_id = i.wid AND s.product_id = i.pid AND s.quantity > 0`))[0];
  console.log(`     la versión ingenua habría cruzado ${N(ingenuo.pares)} pares`
    + ` · ${N(ingenuo.con_stock)} CON existencia = ${money(ingenuo.dinero)} con el ERP equivocado`);
  check('⭐⭐ PRUEBA NEGATIVA: el `COALESCE` ingenuo SÍ contamina, o sea el guard no es decorativo',
    ingenuo.con_stock > 0, `${ingenuo.con_stock} — sin exposición real, el cero de arriba no prueba nada`);

  // ── 3. El fallback se DECLARA y el NULL nunca es cero ─────────────────────────────────────
  console.log('\n── 3. Nada se dibuja en cero (ADR-056) ──');
  const dec = (await q(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE costo_source = 'sin_costo' AND costo_unitario IS NOT NULL)::int miente,
           count(*) FILTER (WHERE costo_unitario IS NOT NULL AND costo_unitario <= 0)::int cero,
           count(*) FILTER (WHERE tiene_testigo AND costo_source LIKE 'catalogo%')::int incoherente
      FROM analytics.v_erp_unit_cost`))[0];
  check('ninguna fila dice `sin_costo` y publica un número', dec.miente === 0, `${dec.miente}`);
  check('⛔ ningún costo publicado es <= 0 (un 0 se leería como "gratis")', dec.cero === 0, `${dec.cero}`);
  check('`tiene_testigo` y `costo_source` no se contradicen', dec.incoherente === 0, `${dec.incoherente}`);
  // La enumeración completa es el mecanismo anti-hueco: si la vista se cayera a los pares CON
  // costo, los que no tienen desaparecerían del LEFT JOIN y se leerían como sanos.
  const esperado = (await q(`
    SELECT (SELECT count(*) FROM commercial.warehouses
             WHERE deleted_at IS NULL
               AND (kepler_code IS NOT NULL OR wincaja_source_branch IS NOT NULL))
         * (SELECT count(*) FROM catalog.products WHERE deleted_at IS NULL) AS n`))[0];
  check('⭐ enumera TODOS los pares almacén × producto, no sólo los que tienen costo',
    dec.total === Number(esperado.n), `${N(dec.total)} filas vs ${N(esperado.n)} pares posibles`);

  // ── 4. Cobertura del testigo donde importa: las filas CON existencia ──────────────────────
  console.log('\n── 4. Cobertura del testigo propio ──');
  const cov = (await q(`
    SELECT v.erp, count(*)::int filas,
           count(*) FILTER (WHERE v.tiene_testigo)::int con_testigo,
           count(*) FILTER (WHERE v.costo_unitario IS NULL)::int sin_costo,
           round(sum(s.quantity * v.costo_unitario))::numeric valor
      FROM commercial.stock s
      JOIN analytics.v_erp_unit_cost v
        ON v.tenant_id = s.tenant_id AND v.warehouse_id = s.warehouse_id
       AND v.product_id = s.product_id
     WHERE s.quantity > 0
     GROUP BY 1 ORDER BY 1`));
  let filas = 0; let testigo = 0;
  for (const r of cov) {
    filas += r.filas; testigo += r.con_testigo;
    console.log(`     ${String(r.erp).padEnd(8)}${String(N(r.filas)).padStart(7)} filas`
      + ` · testigo ${pct(r.con_testigo, r.filas).toFixed(2).padStart(6)}%`
      + ` · sin costo ${String(N(r.sin_costo)).padStart(4)} · ${money(r.valor).padStart(14)}`);
  }
  check('⭐ ≥ 98% de la existencia se valúa con el testigo de su propio ERP (medido 99.03%)',
    pct(testigo, filas) >= 98, `${pct(testigo, filas).toFixed(2)}% (${N(testigo)}/${N(filas)})`);
  // Wincaja al 100% no es casualidad: su costo vive en la MISMA tabla que su existencia.
  const win = cov.find((r) => r.erp === 'wincaja');
  if (win) {
    check('Wincaja: 100% con testigo propio (costo y existencia salen de la misma tabla)',
      win.con_testigo === win.filas, `${N(win.con_testigo)}/${N(win.filas)}`);
  } else nomedido('cobertura de Wincaja', 'no hay filas de Wincaja con existencia');

  // ── 5. El testigo de Wincaja, verificado por dentro ──────────────────────────────────────
  console.log('\n── 5. El testigo de Wincaja no se adivinó: se midió ──');
  const ident = (await q(`
    SELECT count(*)::int n,
           count(*) FILTER (WHERE abs(costo_existencia / NULLIF(existencia, 0) - costo_promedio)
                              <= 0.01 * GREATEST(costo_promedio, 0.01))::int pega
      FROM wincaja.existencias
     WHERE existencia > 0 AND costo_promedio > 0 AND costo_existencia > 0`))[0];
  console.log(`     identidad interna: ${N(ident.pega)} de ${N(ident.n)} (${pct(ident.pega, ident.n).toFixed(2)}%)`);
  check('⭐ `costo_existencia / existencia == costo_promedio` en ≥ 99% (medido 99.56%)',
    pct(ident.pega, ident.n) >= 99, `${pct(ident.pega, ident.n).toFixed(2)}%`);
  // Y que esté en la MISMA unidad que el catálogo — si no, valuar mezclaría escalas.
  const uni = (await q(`
    SELECT count(*)::int n,
           round(percentile_cont(0.5) WITHIN GROUP (ORDER BY v.costo_catalogo / v.costo_erp)::numeric, 4) med
      FROM analytics.v_erp_unit_cost v
     WHERE v.erp = 'wincaja' AND v.costo_erp > 0 AND v.costo_catalogo > 0`))[0];
  console.log(`     mediana cost_base / costo_promedio = ${uni.med} sobre ${N(uni.n)} pares`);
  check('⭐ y está en la MISMA unidad que el catálogo (mediana 0.95–1.05; medido 0.9994)',
    Number(uni.med) >= 0.95 && Number(uni.med) <= 1.05, `mediana ${uni.med}`);

  // ── 6. El antes/después que justifica el cambio ──────────────────────────────────────────
  console.log('\n── 6. El antes/después, sobre el capital que se publica ──');
  const d = (await q(`
    SELECT round(sum(s.quantity * COALESCE(p.cost_base, 0)))::numeric            hoy,
           round(sum(s.quantity * COALESCE(p.cost_with_tax, p.cost_base, 0)))::numeric hoy_tax,
           round(sum(s.quantity * v.costo_unitario))::numeric                    nuevo
      FROM commercial.stock s
      JOIN catalog.products p
        ON p.tenant_id = s.tenant_id AND p.id = s.product_id AND p.deleted_at IS NULL
      JOIN analytics.v_erp_unit_cost v
        ON v.tenant_id = s.tenant_id AND v.warehouse_id = s.warehouse_id
       AND v.product_id = s.product_id
     WHERE s.quantity > 0`))[0];
  console.log(`     cost_base ${money(d.hoy)} · cost_with_tax ${money(d.hoy_tax)}`
    + ` · resolvedor ${money(d.nuevo)}`);
  check('⭐ el resolvedor valúa POR DEBAJO del catálogo (el catálogo sobrevalúa, medido -$2.25M)',
    Number(d.nuevo) < Number(d.hoy), `${money(Number(d.nuevo) - Number(d.hoy))}`);
  // Banda, no cifra exacta: `kdik` lo refresca el shipper del ODS todo el tiempo y clavar un
  // entero vivo es una carrera, no un candado (misma lección que KE.2 y la paridad de K.3).
  const delta = Number(d.nuevo) - Number(d.hoy);
  check('y la brecha sigue en el orden medido (entre -$0.5M y -$6M)',
    delta <= -500000 && delta >= -6000000, money(delta));

  // ── 7. ⛔ Compras NO usa este costo, y eso es correcto ───────────────────────────────────
  console.log('\n── 7. ⛔ Lo que deliberadamente NO se unificó ──');
  const fs = require('fs'); const path = require('path');
  const root = path.resolve(__dirname, '..', '..');
  const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const rep = rd('libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts');
  const sca = rd('libs/commercial/src/lib/commercial-replenishment/replenishment-scanner.service.ts');
  check('⭐ Compras sigue valorizando el sugerido con `cost_with_tax` (es el costo de COMPRA)',
    rep.includes("COALESCE(pr.cost_with_tax, pr.cost_base, 0)")
    && sca.includes("COALESCE(pr.cost_with_tax, pr.cost_base, 0)"),
    'si esto falla, alguien "unificó" el costo de compra con el de valuación');
  check('⛔ y NO leen el resolvedor de valuación (responden otra pregunta)',
    !rep.includes('v_erp_unit_cost') && !sca.includes('v_erp_unit_cost'));

  // ── 8. Los consumidores que SÍ tienen que leerlo ─────────────────────────────────────────
  console.log('\n── 8. Los consumidores cableados ──');
  const consumidores = [
    ['capital parado (sell-out)', 'libs/commercial/src/lib/commercial-analytics/commercial-analytics.service.ts'],
    ['clase ABC', 'libs/commercial/src/lib/commercial-inventory/inventory-abc.service.ts'],
    ['inventario (lista + caducidad)', 'libs/commercial/src/lib/commercial-inventory/commercial-inventory.service.ts'],
    ['rentabilidad (inventario/GMROI)', 'libs/commercial/src/lib/commercial-profitability/commercial-profitability.service.ts'],
    ['conteo cíclico', 'libs/commercial/src/lib/commercial-inventory/inventory-count.service.ts'],
  ];
  for (const [label, file] of consumidores) {
    check(`${label} lee analytics.v_erp_unit_cost`, rd(file).includes('v_erp_unit_cost'));
  }
  // ⭐ El que más importa: el costo que QUEDA ESCRITO al reconciliar un conteo.
  const cnt = rd('libs/commercial/src/lib/commercial-inventory/inventory-count.service.ts');
  check("⭐⭐ el conteo ya NO congela el costo desde `public.products` (la base legacy)",
    !/trx\('public\.products'\)[\s\S]{0,120}cost_base/.test(cnt),
    'el costo congelado seguía saliendo del catálogo legacy');
  // La clase ABC carga con su procedencia: una C por AUSENCIA de costo no es una C por bajo valor.
  const abcCol = (await q(`
    SELECT count(*)::int n FROM information_schema.columns
     WHERE table_schema = 'commercial' AND table_name = 'abc_classification'
       AND column_name = 'costo_source'`))[0];
  check('la clase ABC declara con qué costo se calculó (`costo_source`)', abcCol.n === 1);

  // ── 9. Lo que este candado NO mide, declarado ────────────────────────────────────────────
  console.log('\n── 9. Lo que este candado no mide ──');
  console.log('     ⚠️  La CANTIDAD sigue saliendo de `commercial.stock`, que KE.1 midió al 91.0%');
  console.log('        contra el POS mientras `analytics.v_erp_stock_on_hand` acierta al 100%.');
  console.log('        Acá sólo se arbitró el COSTO. Cambiar la cantidad es otro commit.');
  console.log('     ⚠️  El fallback al catálogo NO es un árbitro: reduce el error, no lo elimina.');
  console.log('        Por eso `tiene_testigo` viaja aparte de `costo_unitario`.');
  console.log('     ⚠️  `kdik.c16` es un PROMEDIO PONDERADO HISTÓRICO (probado: c8/c5 = c16, y c5');
  console.log('        == entradas acumuladas de kdil en 100.00%). Valúa; no es el costo de hoy.');
  if (abcCol.n === 1) {
    const abcNull = (await q(`
      SELECT count(*) FILTER (WHERE costo_source IS NULL)::int n, count(*)::int t
        FROM commercial.abc_classification`))[0];
    if (abcNull.n === abcNull.t && abcNull.t > 0) {
      nomedido('la procedencia del costo en la clase ABC',
        `las ${N(abcNull.t)} filas son anteriores a KE.3 — se puebla en el próximo recálculo`);
    }
  }

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
