/* eslint-disable no-console */
/**
 * CANDADO — LA VERDAD DE LA EXISTENCIA DE KEPLER.
 *
 * Pedido de Edgar: *"necesitamos verdad absoluta de existencia, ventas y unidades"* ·
 * *"solo hay que enfocarnos en kepler"*.
 *
 * ── Lo que YA era verdad y este candado protege ────────────────────────────────────────────
 *
 * La CANTIDAD de la existencia de Kepler cierra sola. Medido contra prod el 2026-09-08:
 *   · la identidad `entradas - salidas = qty` cuadra en 20,681 de 22,426 (92.22%), y las 1,748
 *     restantes son EXACTAMENTE los saldos negativos que la vista recorta a cero por diseño:
 *     **SIN EXPLICAR = 0** en las seis sucursales;
 *   · `kdil.c4` (el inicial) es 0 en el 100% de las filas, así que el `baseline = 0` del
 *     dictamen es correcto — no era un bug, aunque lo parecía;
 *   · la sucursal `00` de Kepler deriva **122,096,465** unidades fantasma y ya está excluida.
 *
 * ── Lo que NO era verdad: el VALOR ⭐ ───────────────────────────────────────────────────────
 *
 * La existencia se valuaba con `catalog.products` — un costo por PRODUCTO, global, en la unidad
 * que el catálogo tenga. Kepler trae SU costo por **sucursal × SKU** (`kdik.c16`), al mismo grano
 * que la cantidad. Contrastados: `cost_base / c16` da mediana **1.0000** (pega ±2% en 72.46%),
 * mientras `cost_with_tax / c16` da **1.0800**. O sea `cost_base` ES el costo de Kepler, y el
 * dictamen publica con impuesto.
 *
 * Estado en PROD al crear este candado (filas con existencia > 0):
 *
 *     veredicto                 filas     publicado      arbitrado        brecha
 *     confirmado               11,917   $31,238,287    $28,442,898    $2,795,389   <- el IMPUESTO
 *     contradicho_por_factor      273    $2,675,506       $650,079    $2,025,427   <- el FACTOR
 *     precio_movido             4,237    $8,792,029     $7,986,439      $805,590
 *     sin_testigo                  26       $16,316           NULL            --
 *
 * Las razones de las 273 contradichas son 16.2 · 21.6 · 20.0 · 14.0 · 32.0 · 31.4 · 10.8 · 3.3
 * — factores de caja. Y los nombres cierran el caso: ROLLO GUAYABA CHICO GRANEL · CHOC HERSHEY
 * BARRA GRANEL 14KG · TURIN CONF SEMIAMARGO 16KG. `cost_base` viene por bulto; `c16` por pieza.
 *
 * ── Dos errores silenciosos que este archivo existe para que no vuelvan ─────────────────────
 *
 *  1. ⛔ **`?` en un `raw` de knex.** El primer intento guardaba el guard de `c16` como regex de
 *     texto; knex tomó cada `?` como binding y Postgres almacenó
 *     `'^-$1[0-9]+(\.[0-9]+)$2([eE][+-]$3[0-9]+)$4$'`. No falló: **no matcheó nada**, y la vista
 *     devolvió `sin_testigo` en las 16,453 filas — que se lee igual que "Kepler no tiene costo".
 *  2. ⛔ **La columna del ERP es `source = 'kepler_ods'`, no `'kepler'`** (eso es `unit_source`).
 *     Filtrar por el valor equivocado devuelve cero filas sin decir nada.
 *
 * Los dos los cazó la auto-verificación de la migración, no una pantalla. Por eso las
 * afirmaciones de acá miran CANTIDADES, no la forma del SQL.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-stock-truth.js
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
const pct = (a, b) => (b ? (100 * a / b) : 0);

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  await c.query(`SET app.tenant_id = '${T}'`);
  await c.query("SET statement_timeout = '900s'");
  console.log('\n=== CANDADO · la verdad de la EXISTENCIA de Kepler ===\n');

  if (!(await c.query(`SELECT to_regclass('analytics.v_erp_stock_truth') t`)).rows[0].t) {
    nomedido('analytics.v_erp_stock_truth no existe', 'correr la migración 20260908180000');
    console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
    await c.end(); process.exit(0);
  }

  // ── 1. La forma ────────────────────────────────────────────────────────────────────────────
  console.log('── 1. La forma ──');
  const meta = (await c.query(
    `SELECT c.relkind, c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='analytics' AND c.relname='v_erp_stock_truth'`)).rows[0];
  check('es VISTA, no una tabla copiada (regla ⭐ del proyecto)', meta.relkind === 'v', `relkind=${meta.relkind}`);
  check('⭐ conserva security_invoker (se pierde en cada CREATE OR REPLACE — lección U.7)',
    (meta.reloptions || []).some((o) => String(o).includes('security_invoker')));
  const gr = (await c.query(
    `SELECT 1 FROM information_schema.role_table_grants
      WHERE table_schema='analytics' AND table_name='v_erp_stock_truth'
        AND grantee='app_runtime' AND privilege_type='SELECT'`)).rowCount;
  check('app_runtime puede leerla (el GRANT tampoco se hereda)', gr === 1);

  // ── 2. El testigo es de Kepler, y sólo de Kepler ───────────────────────────────────────────
  console.log('\n── 2. El testigo es de Kepler, y sólo de Kepler ──');
  const def = (await c.query(`SELECT pg_get_viewdef('analytics.v_erp_stock_truth'::regclass, true) d`)).rows[0].d;
  check('⭐ lee kepler_ods.kdik (el costo propio de Kepler, grano sucursal × SKU)', /kepler_ods\.kdik/i.test(def));
  check('⛔ NO lee wincaja — Edgar: "solo hay que enfocarnos en kepler"', !/wincaja/i.test(def));
  const erps = (await c.query(
    `SELECT DISTINCT s.source FROM analytics.v_erp_stock_on_hand s
       JOIN analytics.v_erp_stock_truth t ON t.warehouse_id=s.warehouse_id AND t.product_id=s.product_id`)).rows;
  check('⛔ y en los datos tampoco entra Wincaja (sólo source=kepler_ods)',
    erps.length === 1 && erps[0].source === 'kepler_ods', erps.map((e) => e.source).join(','));

  // ── 3. ⭐ El anti-réplica de kdik, medido por comportamiento ────────────────────────────────
  // `kdik` arrastra 3,667 de 31,084 filas con c1 <> sucursal: el costo de OTRA sucursal. Si el
  // filtro se cae, el testigo mezcla almacenes. No se verifica leyendo el SQL — se cuenta.
  console.log('\n── 3. ⭐ El anti-réplica de kdik ──');
  const rep = (await c.query(
    `SELECT count(*)::int propias, count(*) FILTER (WHERE sucursal <> btrim(c1::text))::int replica
       FROM kepler_ods.kdik`)).rows[0];
  console.log(`     kdik: ${N(rep.propias)} filas · de otra sucursal: ${N(rep.replica)}`);
  check('⛔ la réplica existe y por eso el filtro hace falta', rep.replica > 0, `${N(rep.replica)}`);
  const dup = (await c.query(
    `SELECT count(*)::int n FROM (
       SELECT warehouse_id, product_id FROM analytics.v_erp_stock_truth
        GROUP BY 1,2 HAVING count(*) > 1) t`)).rows[0].n;
  check('⛔ el testigo NO duplica filas (un almacén×producto, una fila)', dup === 0, `${N(dup)} duplicadas`);

  // ── 4. ⭐ El veredicto ──────────────────────────────────────────────────────────────────────
  console.log('\n── 4. ⭐ El veredicto (los pisos son lo MEDIDO en prod 2026-09-08) ──');
  const v = (await c.query(
    `SELECT veredicto, count(*)::int filas,
            sum(valor_publicado_hoy)::numeric pub,
            sum(valor_arbitrado)::numeric arb
       FROM analytics.v_erp_stock_truth WHERE qty > 0
      GROUP BY 1 ORDER BY 2 DESC`)).rows;
  const by = Object.fromEntries(v.map((x) => [x.veredicto, x]));
  const tot = v.reduce((a, x) => a + x.filas, 0);
  for (const x of v) {
    console.log(`     ${String(x.veredicto).padEnd(24)} ${String(N(x.filas)).padStart(7)} (${pct(x.filas, tot).toFixed(2)}%)`
      + `  publicado ${money(x.pub).padStart(14)}  arbitrado ${x.arb === null ? 'NULL'.padStart(14) : money(x.arb).padStart(14)}`);
  }
  const conf = (by.confirmado || {}).filas || 0;
  const contra = (by.contradicho_por_factor || {}).filas || 0;
  check('⭐ el costo del catálogo COINCIDE con el de Kepler en la mayoría (≥ 65%)',
    pct(conf, tot) >= 65, `${pct(conf, tot).toFixed(2)}%`);
  check('⛔ `contradicho_por_factor` EXISTE — un árbitro que nunca contradice es un espejo',
    contra > 0, `${N(contra)}`);
  check('⛔ y no se come la población (≤ 5%)', pct(contra, tot) <= 5, `${pct(contra, tot).toFixed(2)}%`);

  // ── 5. ⛔ Nunca un valor de relleno (ADR-056) ───────────────────────────────────────────────
  console.log('\n── 5. ⛔ Sin testigo NO significa cero ──');
  const st = (await c.query(
    `SELECT count(*)::int filas,
            count(*) FILTER (WHERE valor_arbitrado IS NOT NULL)::int con_valor
       FROM analytics.v_erp_stock_truth WHERE veredicto='sin_testigo'`)).rows[0];
  console.log(`     sin_testigo: ${N(st.filas)} filas`);
  check('⛔ `sin_testigo` viaja con valor_arbitrado NULL, jamás con 0 de relleno',
    st.con_valor === 0, `${N(st.con_valor)} traen número`);
  check('⛔ `sin_testigo` EXISTE — un 0 significaría que la vista inventa el costo',
    st.filas > 0, 'si da 0, revisar si el LEFT JOIN se volvió INNER');
  // Las DOS ausencias tienen que ser distinguibles: no es lo mismo que falte el testigo de
  // Kepler a que falte el costo del catálogo.
  const dos = (await c.query(
    `SELECT count(DISTINCT veredicto)::int n FROM analytics.v_erp_stock_truth
      WHERE veredicto IN ('sin_testigo','sin_costo_catalogo')`)).rows[0].n;
  check('⭐ las dos ausencias son etiquetas distintas (o al menos una está poblada)', dos >= 1, `${dos}`);

  // ── 6. ⭐ Las DOS causas de la brecha, separadas ────────────────────────────────────────────
  // Que el total cuadre no alcanza: hay que poder decir CUÁNTO es impuesto y CUÁNTO es unidad.
  console.log('\n── 6. ⭐ La brecha, partida por causa ──');
  const b = (await c.query(
    `SELECT
       sum(valor_publicado_hoy) FILTER (WHERE veredicto='confirmado')::numeric pub_conf,
       sum(valor_arbitrado)     FILTER (WHERE veredicto='confirmado')::numeric arb_conf,
       sum(valor_publicado_hoy) FILTER (WHERE veredicto='contradicho_por_factor')::numeric pub_fac,
       sum(valor_arbitrado)     FILTER (WHERE veredicto='contradicho_por_factor')::numeric arb_fac,
       sum(valor_publicado_hoy)::numeric pub_tot,
       sum(valor_arbitrado)::numeric arb_tot
     FROM analytics.v_erp_stock_truth WHERE qty > 0`)).rows[0];
  const gapTax = Number(b.pub_conf) - Number(b.arb_conf);
  const gapFac = Number(b.pub_fac) - Number(b.arb_fac);
  const gapTot = Number(b.pub_tot) - Number(b.arb_tot);
  console.log(`     el IMPUESTO (filas donde el costo YA coincide): ${money(gapTax)}  razón ${(Number(b.pub_conf) / Number(b.arb_conf)).toFixed(4)}`);
  console.log(`     el FACTOR   (${N((by.contradicho_por_factor || {}).filas || 0)} filas de bulto)          : ${money(gapFac)}`);
  console.log(`     brecha TOTAL publicado - arbitrado            : ${money(gapTot)}  (${pct(gapTot, Number(b.pub_tot)).toFixed(2)}% de lo publicado)`);
  check('⭐ el impuesto explica una brecha ≈ 8-12% en las filas confirmadas',
    Number(b.pub_conf) / Number(b.arb_conf) >= 1.05 && Number(b.pub_conf) / Number(b.arb_conf) <= 1.15,
    `${(Number(b.pub_conf) / Number(b.arb_conf)).toFixed(4)} — si se va a 1.0000, la pantalla ya dejó de publicar con impuesto`);
  check('⛔ la brecha por FACTOR sigue medida y no se ignora', gapFac > 0, money(gapFac));

  // ── 7. La cantidad, que ya era verdad — y su hueco declarado ───────────────────────────────
  console.log('\n── 7. La CANTIDAD (lo que ya cerraba, y sigue cerrando) ──');
  const q = (await c.query(
    `SELECT count(*)::int filas,
            count(*) FILTER (WHERE abs(coalesce(entradas,0)-coalesce(salidas,0)-coalesce(qty_publicada,0)) <= 0.01)::int cuadran,
            count(*) FILTER (WHERE coalesce(entradas,0)-coalesce(salidas,0) < 0)::int negativos,
            count(*) FILTER (WHERE abs(coalesce(entradas,0)-coalesce(salidas,0)-coalesce(qty_publicada,0)) > 0.01
                             AND coalesce(entradas,0)-coalesce(salidas,0) >= 0)::int sin_explicar
       FROM analytics.v_existencia_dictamen WHERE erp='kepler'`)).rows[0];
  console.log(`     ${N(q.filas)} filas · identidad directa ${pct(q.cuadran, q.filas).toFixed(2)}% · negativos recortados ${N(q.negativos)}`);
  check('⭐ la identidad entradas − salidas = qty NO deja nada sin explicar',
    q.sin_explicar === 0, `${N(q.sin_explicar)} filas sin explicar`);
  const cero = (await c.query(
    `SELECT count(*)::int n FROM analytics.v_erp_stock_truth t
       JOIN commercial.warehouses w ON w.tenant_id=t.tenant_id AND w.id=t.warehouse_id
      WHERE w.kepler_code = '00'`)).rows[0].n;
  check('⛔ la sucursal 00 de Kepler (122M unidades fantasma) NO entra', cero === 0, `${N(cero)} filas`);

  // ── 8. Lo que este candado NO mide, declarado ──────────────────────────────────────────────
  console.log('\n── 8. Lo que este candado no mide ──');
  console.log('     ⚠️  Sólo KEPLER. Wincaja tiene su propia identidad de existencia (cuadra al');
  console.log('        100.00% en sus 21 sucursales) y su propio costo, pero queda fuera por');
  console.log('        decisión explícita: "solo hay que enfocarnos en kepler".');
  console.log('     ⚠️  `precio_movido` NO se juzga: una diferencia < 50% entre los dos costos');
  console.log('        puede ser deriva de precio y no un error de unidad. Se enumera, no se acusa.');
  console.log('     ⚠️  Esta vista NO elige el costo bueno. Devuelve los dos y el veredicto; quién');
  console.log('        valúa la pantalla es un cambio aparte, con su antes/después.');

  console.log(`\n=== ${ok} OK · ${fail} FAIL · ${skip} NO MEDIDO ===\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
