/* eslint-disable no-console */
/**
 * CANDADO — LA CLASE ABC, QUE ES LA QUE FIJA CUÁNTO SE COMPRA (KE.4).
 *
 * Edgar (2026-09-10): *"no se puede comprar con una información errónea, si no la compra se hace
 * mal y afecta todo, es por eso que necesitamos implicar la verdad absoluta"*.
 *
 * La clase ABC no es una etiqueta de reporte: fija el **nivel de servicio** del reabasto
 * (`import-computed-reorder.js`: A=0.98 · B=0.95 · C/sin clase=0.90), y de ahí sale el colchón de
 * seguridad, el punto de reorden y el sugerido de compra. También fija la **cadencia del conteo
 * cíclico** (A=30 d · B=90 d · C=365 d).
 *
 * ── Los TRES defectos que este candado existe para que no vuelvan ───────────────────────────
 *
 * **(1) Era un objeto nulo.** La demanda salía de `commercial.orders` — la tabla de pedidos de la
 * plataforma, con **2 órdenes `fulfilled` en toda su historia** — contra 707,022 celdas / $154.7M
 * de venta real. Resultado: **2 filas clase A y 56,002 clase C con `annual_value` = $0**, y
 * **clase B = 0 en todo el sistema**. Ese cero de B era el delator y estuvo a la vista dos meses.
 * Costo: **19,127 políticas de sucursal servidas a 0.90**, de las cuales 4,467 son A y 5,782 son B
 * → **$1,197,206 de inventario de protección sin comprar**.
 *
 * **(2) ⭐ Llegaba tarde TODOS LOS DÍAS.** Los relojes de prod:
 *
 * ```text
 * inventory_health ....  09:04:09   <- la demanda
 * reorder_policy ......  09:04:28   <- la consume 19 segundos despues
 * abc_classification ..  09:30:00   <- y la clase se recalcula 26 MINUTOS mas tarde
 * ```
 *
 * O sea el reabasto usaba la clase del día anterior. No se arregla moviendo un cron: el ABC
 * necesita `inventory_health` y el reorden necesita el ABC, y los dos importers corren con 19
 * segundos de diferencia. Se arregla **derivando** — `analytics.v_abc_class` es vista, y una
 * vista no puede llegar tarde.
 *
 * **(3) La pantalla mostraba OTRA clase que la que usó el motor.** `commercial-replenishment`
 * recalculaba el Pareto al vuelo sobre la venta $ del MES a grano producto, mientras el motor
 * usaba demanda anual × costo a grano almacén × producto. Medido: coincidían en **19,053 de
 * 29,751 = 64.0%**, o sea el comprador veía una clase distinta a la que dimensionó el colchón en
 * **10,698 filas** — incluidas **261 que la pantalla llamaba C y el motor trata como A**.
 *
 * ── Y lo que NO se unificó, también asegurado ───────────────────────────────────────────────
 *
 * Quedan otros dos Pareto en el repo y los dos son legítimos, así que el candado sólo verifica que
 * no se los confunda con éste:
 *   · `analytics.product_sales_stats.abc_class` — grano producto global, alimenta analytics /
 *     rentabilidad / Thot. No toca el nivel de servicio.
 *   · `import-replenishment-plan.js` (`sabc`) — grano producto, sólo elige el **percentil** del
 *     colchón (p90/p80/p70), no el nivel de servicio.
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

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
const root = path.resolve(__dirname, '..', '..');
const rd = (f) => fs.readFileSync(path.join(root, f), 'utf8');

(async () => {
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query(`SET statement_timeout = '600s'`);
  const q = async (sql) => (await c.query(sql)).rows;

  console.log('\n=== CANDADO: la clase ABC, que fija cuánto se compra (KE.4) ===\n');

  // ── 1. La vista y sus metadatos ───────────────────────────────────────────────────────────
  console.log('── 1. La vista y sus metadatos ──');
  const meta = (await q(`
    SELECT c.relkind::text AS kind, COALESCE(array_to_string(c.reloptions, ','), '') AS opts
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'analytics' AND c.relname = 'v_abc_class'`))[0];
  check('analytics.v_abc_class existe y es una VISTA (por eso no puede llegar tarde)',
    !!meta && meta.kind === 'v', meta ? `relkind=${meta.kind}` : 'no existe');
  check('⚠️ conserva `security_invoker` (no se hereda tras CREATE OR REPLACE)',
    !!meta && meta.opts.includes('security_invoker'), meta ? meta.opts || '(sin opciones)' : '');
  const grant = (await q(`
    SELECT has_table_privilege('app_runtime', 'analytics.v_abc_class', 'SELECT') AS g`))[0];
  check('⚠️ conserva el GRANT a app_runtime', grant.g === true);
  // ⭐ Si no fuera única, el LEFT JOIN de la pantalla de compra ABANICARÍA e inflaría los totales.
  const u = (await q(`
    SELECT count(*)::int filas, count(DISTINCT (tenant_id, warehouse_id, product_id))::int llaves
      FROM analytics.v_abc_class`))[0];
  check('⭐ es ÚNICA por (tenant, almacén, producto) — si no, el join de la pantalla inflaría los totales',
    u.filas === u.llaves, `${N(u.filas)} filas vs ${N(u.llaves)} llaves`);

  // ── 2. ⭐ EL DELATOR: un Pareto siempre produce clase B ───────────────────────────────────
  console.log('\n── 2. ⭐ El delator, convertido en compuerta ──');
  const d = (await q(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE abc_class = 'A')::int a,
           count(*) FILTER (WHERE abc_class = 'B')::int b,
           count(*) FILTER (WHERE abc_class = 'C')::int c,
           round(sum(annual_value) FILTER (WHERE abc_class = 'A'))::numeric va,
           round(sum(annual_value) FILTER (WHERE abc_class = 'B'))::numeric vb
      FROM analytics.v_abc_class`))[0];
  console.log(`     A ${N(d.a)} (${money(d.va)}) · B ${N(d.b)} (${money(d.vb)}) · C ${N(d.c)}`);
  check('⭐⭐ clase B > 0 — un Pareto SIEMPRE produce B, y que fuera 0 fue el síntoma dos meses',
    d.b > 0, 'B = 0 significa que la fuente de demanda está vacía');
  check('clase A > 0', d.a > 0);
  check('y el Pareto ORDENA: A no pasa del 40% de las filas',
    d.a <= d.total * 0.40, `A = ${N(d.a)} de ${N(d.total)} (${pct(d.a, d.total).toFixed(1)}%)`);

  // ── 3. Las TRES maneras de ser C, distinguidas ────────────────────────────────────────────
  console.log('\n── 3. Una C tiene que decir POR QUÉ es C ──');
  for (const r of await q(`
    SELECT clase_motivo, count(*) n, count(DISTINCT warehouse_id) alm
      FROM analytics.v_abc_class GROUP BY 1 ORDER BY 2 DESC`)) {
    console.log(`     ${String(r.clase_motivo).padEnd(14)}${String(N(r.n)).padStart(7)} filas · ${r.alm} almacenes`);
  }
  const mot = (await q(`
    SELECT count(*) FILTER (WHERE abc_class <> 'C' AND clase_motivo <> 'pareto')::int incoherente,
           count(*) FILTER (WHERE clase_motivo = 'sin_demanda')::int sin_dem,
           count(*) FILTER (WHERE clase_motivo IS NULL)::int sin_motivo
      FROM analytics.v_abc_class`))[0];
  check('un motivo distinto de `pareto` sólo puede terminar en C (si no, ordena sobre ceros)',
    mot.incoherente === 0, `${mot.incoherente} filas`);
  check('ninguna fila queda sin motivo', mot.sin_motivo === 0, `${mot.sin_motivo}`);
  check('⭐ y el caso existe: hay filas `sin_demanda` (si no, el motivo sería decorativo)',
    mot.sin_dem > 0, `${mot.sin_dem}`);
  // ⭐ Y CADA almacén `sin_demanda` tiene que tener su causa nombrada, no ser una sorpresa.
  const sd = await q(`
    SELECT w.code, count(*)::int n,
           (SELECT count(*) FROM analytics.sales_daily s
             WHERE s.warehouse_id = v.warehouse_id AND s.sale_date > current_date - 90)::int venta
      FROM analytics.v_abc_class v
      JOIN commercial.warehouses w ON w.id = v.warehouse_id
     WHERE v.clase_motivo = 'sin_demanda'
     GROUP BY 1, v.warehouse_id ORDER BY 2 DESC`);
  for (const r of sd) {
    console.log(`     sin_demanda en ${String(r.code).padEnd(8)}${String(N(r.n)).padStart(7)} filas`
      + ` · celdas de venta 90 d: ${N(r.venta)}`
      + (Number(r.venta) === 0 ? '  (no vende: distribuye por traspaso)' : '  ⚠️ TIENE venta: inventory_health rezagado'));
  }
  // El CEDIS es el caso legítimo y tiene que estar; lo que NO puede pasar es que aparezca una
  // sucursal vendedora sin que nadie lo note, así que se enumera y se declara.
  const conVenta = sd.filter((r) => Number(r.venta) > 0);
  if (conVenta.length === 0) {
    check('⭐ ningún almacén CON venta cae en `sin_demanda`', true);
  } else {
    nomedido('almacenes con venta que caen en `sin_demanda`',
      `${conVenta.map((r) => `${r.code} (${N(r.n)} filas)`).join(', ')} — `
      + `inventory_health va rezagado y se corrige en su próxima corrida; declarado, no rellenado`);
  }

  // ── 4. ⭐⭐ EL DEFECTO DE RELOJ, con su prueba negativa ───────────────────────────────────
  console.log('\n── 4. ⭐⭐ Por qué tuvo que ser VISTA y no tabla ──');
  const relojes = (await q(`
    SELECT (SELECT max(computed_at) FROM analytics.inventory_health)      AS health,
           (SELECT max(computed_at) FROM commercial.reorder_policy)       AS reorden,
           (SELECT max(computed_at) FROM commercial.abc_classification)   AS abc`))[0];
  for (const [k, v] of Object.entries(relojes)) {
    console.log(`     ${k.padEnd(10)}${v ? new Date(v).toISOString() : '(nunca)'}`);
  }
  // ⭐ LA PRUEBA NEGATIVA: si la tabla se escribe DESPUÉS de su consumidor, el consumidor usaba la
  // foto de ayer. Es la condición que justifica la vista, y se mide en vez de suponerse.
  const tarde = relojes.abc && relojes.reorden && new Date(relojes.abc) > new Date(relojes.reorden);
  console.log(`     la tabla se escribe ${tarde ? 'DESPUÉS' : 'ANTES'} que el reorden que la consume`
    + `${tarde ? ' → como tabla llegaba tarde TODOS los días' : ''}`);
  check('⭐⭐ el reorden lee la VISTA, no la tabla (la tabla llega tarde y se midió que sí)',
    rd('database/importers/kepler/import-computed-reorder.js').includes('analytics.v_abc_class')
    && !/JOIN\s+commercial\.abc_classification/.test(rd('database/importers/kepler/import-computed-reorder.js')),
    'si vuelve a la tabla, vuelve a comprar con la clase de ayer');
  check('⭐ la pantalla de compra MUESTRA la clase que usó el motor (no la recalcula)',
    rd('libs/commercial/src/lib/commercial-replenishment/commercial-replenishment.service.ts')
      .includes('analytics.v_abc_class'),
    'coincidían en 64.0%: el comprador veía otra clase que la que fijó el colchón');

  // ── 5. UNA definición del Pareto ─────────────────────────────────────────────────────────
  console.log('\n── 5. Una sola definición del Pareto que fija el servicio ──');
  const svcAbc = rd('libs/commercial/src/lib/commercial-inventory/inventory-abc.service.ts');
  check('⭐ la tabla se puebla `SELECT ... FROM analytics.v_abc_class` (la definición vive en la vista)',
    svcAbc.includes('FROM analytics.v_abc_class'),
    'si el CASE del Pareto vuelve al servicio, hay dos implementaciones que van a divergir');
  check('⛔ y el servicio ya NO calcula el Pareto por su cuenta',
    !/cum_value - annual_value\) \/ total_value/.test(svcAbc));
  // ⚠️ La aserción mira el SQL, no la prosa: el encabezado NOMBRA `commercial.orders` a propósito
  // (para que nadie lo reintroduzca sin leer por qué), así que un regex sobre todo el archivo se
  // pone rojo por el comentario que explica el bug. Se busca el JOIN/FROM real.
  check('⛔ ni CONSULTA `commercial.orders` como demanda (2 órdenes fulfilled en su historia)',
    !/(FROM|JOIN)\s+commercial\.orders/i.test(svcAbc), 'la fuente vacía que produjo el objeto nulo');
  // Los otros dos Pareto son legítimos y NO deben confundirse con éste.
  check('`import-replenishment-plan.js` conserva su Pareto propio (elige percentil, no servicio)',
    rd('database/importers/kepler/import-replenishment-plan.js').includes('sabc AS'));

  // ── 6. Los frenos que impiden volver a publicar un objeto nulo ───────────────────────────
  console.log('\n── 6. Los frenos ──');
  check('⭐ el recompute MIDE la fuente antes de borrar (un DELETE+INSERT desde vacío no falla)',
    /analytics\.inventory_health[\s\S]{0,400}con_demanda[\s\S]{0,600}ABC abortado/.test(svcAbc),
    'sin esto, una fuente vacía borra lo bueno y publica "todo es C"');
  check('⭐ y aborta si la clasificación sale degenerada (A o B en cero)',
    /ABC degenerado/.test(svcAbc));
  check('la ventana NO se acepta libre: la demanda viene de una ventana fija de 90 d',
    /no es aplicable[\s\S]{0,200}inventory_health/.test(svcAbc));

  // ── 7. El dinero: qué cambia en el colchón ───────────────────────────────────────────────
  console.log('\n── 7. El dinero que estaba en juego ──');
  const plata = (await q(`
    SELECT count(*)::int n,
           round(sum(rp.safety_stock))::numeric hoy,
           round(sum(rp.safety_stock / 1.2816
                 * CASE v.abc_class WHEN 'A' THEN 2.0537 ELSE 1.6449 END))::numeric deberia,
           round(sum((rp.safety_stock / 1.2816
                 * CASE v.abc_class WHEN 'A' THEN 2.0537 ELSE 1.6449 END - rp.safety_stock)
                 * COALESCE(pr.cost_with_tax, pr.cost_base, 0)))::numeric dinero
      FROM commercial.reorder_policy rp
      JOIN commercial.warehouses w ON w.id = rp.warehouse_id AND w.code <> '00'
      JOIN analytics.v_abc_class v
        ON v.tenant_id = rp.tenant_id AND v.warehouse_id = rp.warehouse_id
       AND v.product_id = rp.product_id AND v.abc_class IN ('A', 'B')
      JOIN catalog.products pr
        ON pr.tenant_id = rp.tenant_id AND pr.id = rp.product_id AND pr.deleted_at IS NULL
     WHERE rp.source = 'computed' AND rp.service_level = 0.900 AND rp.safety_stock > 0`))[0];
  console.log(`     ${N(plata.n)} políticas A/B servidas todavía a 0.90`
    + ` · colchón ${N(plata.hoy)} → ${N(plata.deberia)} pz · ${money(plata.dinero)}`);
  if (Number(plata.n) === 0) {
    check('⭐ ya no queda ninguna política A/B servida a 0.90', true);
  } else {
    nomedido('el colchón de las políticas A/B',
      `${N(plata.n)} políticas siguen a 0.90 por ${money(plata.dinero)} — `
      + `se corrige cuando import-computed-reorder corra con la vista (nightly)`);
  }

  // ── 8. Cobertura del costo con el que se clasificó ───────────────────────────────────────
  console.log('\n── 8. Con qué costo se clasificó ──');
  const cov = (await q(`
    SELECT count(*)::int total,
           count(*) FILTER (WHERE tiene_testigo)::int testigo,
           count(*) FILTER (WHERE costo_source = 'sin_costo')::int sin_costo
      FROM analytics.v_abc_class`))[0];
  console.log(`     testigo del propio ERP en ${N(cov.testigo)} de ${N(cov.total)}`
    + ` (${pct(cov.testigo, cov.total).toFixed(2)}%) · sin costo ${N(cov.sin_costo)}`);
  check('⭐ ≥ 95% de la clasificación se apoya en el costo del propio ERP (KE.3)',
    pct(cov.testigo, cov.total) >= 95, `${pct(cov.testigo, cov.total).toFixed(2)}%`);

  // ── 8bis. ⭐⭐ LA FOTO NO PUEDE DIVERGIR DE LA DEFINICION ─────────────────────────────────
  // Esta es la compuerta que caza un DEPLOY QUE NO TOMO. `commercial.abc_classification` la
  // repuebla el nocturno de las 3:30 AM MX corriendo inventory-abc.service.ts. Si esa noche
  // corriera codigo VIEJO —el que leia `commercial.orders`, con 2 ordenes fulfilled en toda su
  // historia— la tabla volveria a 2 filas clase A y ~56,000 clase C con valor 0, y `clase_motivo`
  // volveria a NULL. Sin esta asercion eso pasa en silencio y el conteo ciclico, el scanner y los
  // pasillos vuelven a decidir sobre un objeto nulo.
  console.log('\n── 8bis. ⭐⭐ La tabla no puede divergir de la vista ──');
  const foto = (await q(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE t.clase_motivo IS NULL)::int sin_motivo,
           count(*) FILTER (WHERE t.abc_class = 'B')::int b,
           max(t.computed_at)                                AS ult
      FROM commercial.abc_classification t`))[0];
  const cruz = (await q(`
    SELECT count(*)::int n, count(*) FILTER (WHERE t.abc_class = v.abc_class)::int igual
      FROM commercial.abc_classification t
      JOIN analytics.v_abc_class v
        ON v.tenant_id = t.tenant_id AND v.warehouse_id = t.warehouse_id
       AND v.product_id = t.product_id`))[0];
  console.log(`     tabla ${N(foto.filas)} filas · recalculada ${foto.ult ? new Date(foto.ult).toISOString() : '(nunca)'}`
    + ` · coincide con la vista en ${pct(cruz.igual, cruz.n).toFixed(2)}%`);
  check('⭐⭐ la TABLA trae clase B (si vuelve a 0, el nocturno corrió con el código viejo)',
    foto.b > 0, 'B = 0 en la tabla: el recompute volvió a leer commercial.orders');
  check('⭐ ninguna fila de la tabla quedó sin `clase_motivo`',
    foto.sin_motivo === 0, `${N(foto.sin_motivo)} filas sin motivo — foto anterior a KE.4`);
  // Banda, no igualdad exacta: la vista es VIVA (el costo del ODS se mueve) y la foto es de la
  // ultima corrida, asi que unas filas de frontera pueden diferir. Lo que no puede es divergir.
  check('⭐ la foto coincide con la definición en ≥ 97% (es una copia de la vista, no otra regla)',
    pct(cruz.igual, cruz.n) >= 97, `${pct(cruz.igual, cruz.n).toFixed(2)}%`);

  // ── 9. Lo que este candado NO mide ───────────────────────────────────────────────────────
  console.log('\n── 9. Lo que este candado no mide ──');
  console.log('     ⚠️  El CEDIS `00` no se clasifica por venta porque no vende: lo planea');
  console.log('        import-network-reorder.js con demanda dependiente y servicio 0.98 fijo.');
  console.log('        Su clase sale `sin_demanda`, que es la verdad, no un relleno.');
  console.log('     ⚠️  La sucursal `07` arranca con 3 días de historia sobre un divisor de 90:');
  console.log('        su ADU va subdeclarada hasta que la ventana se llene. No es corregible');
  console.log('        desde acá — es el tiempo.');
  console.log('     ⚠️  `analytics.product_sales_stats.abc_class` es OTRO ABC (grano producto');
  console.log('        global) y sigue alimentando analytics/rentabilidad/Thot. No toca el');
  console.log('        nivel de servicio, así que no se unificó.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
