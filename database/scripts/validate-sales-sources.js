/* eslint-disable */
/**
 * validate-sales-sources.js — Verificador de integridad de las fuentes de venta.
 *
 * READ-ONLY. No escribe nada. Consolida los chequeos de la auditoría de ventas
 * (2026-08) para poder correrlos contra CUALQUIER base (local o prod) y confirmar:
 *   - qué doctype se cuenta como venta (y su magnitud),
 *   - que NO se cuelen traspasos (U-D-41 "Embarque Sucursal", c4=6, N-A/X-A),
 *   - que NO se dupliquen ventas (réplica cruzada del mirror; Kepler↔Wincaja),
 *   - el hueco de cobertura de mayoreo/telemarketing (U-D-41 "Embarque Telemarketing"),
 *   - materialidad de cancelados (c43).
 *
 * Fuentes (por env, todas opcionales excepto ODS_URL):
 *   ODS_URL       kepler_ods mirror (kdm1/kdm2/kdmm)         [requerido]
 *   ANALYTICS_URL postgres_platform con analytics.sales_daily [opcional]
 *   WIN_URL       DB con el landing wincaja.* (= ANALYTICS_URL) [opcional]
 *   AS_OF         fecha ancla YYYY-MM-DD (default: hoy en SQL)
 *   WINDOW_DAYS   ventana hacia atrás (default 30)
 *
 * Uso local:
 *   ODS_URL="$DATABASE_URL_NEW" WIN_URL="postgresql://postgres:...@localhost:5433/wincaja" \
 *     node database/scripts/validate-sales-sources.js
 *
 * Uso prod (tras rotar credencial):
 *   ODS_URL="<prod>" ANALYTICS_URL="<prod>" node database/scripts/validate-sales-sources.js
 */
const { Client } = require('pg');

const AS_OF = process.env.AS_OF || null;             // null => CURRENT_DATE en SQL
const WIN_DAYS = Number(process.env.WINDOW_DAYS || 30);
const anchor = AS_OF ? `DATE '${AS_OF}'` : 'CURRENT_DATE';
const WIN = `sucursal = c1 AND c9::date >= (${anchor} - ${WIN_DAYS})`; // sucursal=c1 => dedup réplica cruzada

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const flag = (level) => ({ OK: '✅', WARN: '⚠️', FAIL: '❌', INFO: 'ℹ️' }[level] || '·');
const findings = [];
const add = (level, title, detail) => { findings.push({ level, title, detail }); console.log(`\n${flag(level)} ${title}\n   ${detail}`); };

async function connect(url) { const c = new Client({ connectionString: url }); await c.connect(); return c; }

async function checkKeplerOds(ods) {
  console.log(`\n════════ KEPLER ODS — ventana ${WIN_DAYS}d (ancla ${AS_OF || 'hoy'}) ════════`);

  // CHK1 — mapa de doctypes de venta y magnitud (join correcto 6 col + dedup)
  const J = `m1.sucursal=m2.sucursal AND m1.c2=m2.c2 AND m1.c3=m2.c3 AND m1.c4=m2.c4 AND m1.c5=m2.c5 AND m1.c6=m2.c6`;
  const dt = (await ods.query(`
    SELECT 'U-D-'||m1.c4 doctype,
           count(DISTINCT (m1.sucursal||m1.c5||m1.c6)) docs,
           round(sum(m2.c13::numeric),0) importe
      FROM kepler_ods.kdm1 m1 JOIN kepler_ods.kdm2 m2 ON ${J}
     WHERE m1.c2='U' AND m1.c3='D' AND m1.c4 IN ('10','5','12','13','40','41')
       AND m1.sucursal=m1.c1 AND m1.c9::date >= (${anchor} - ${WIN_DAYS})
     GROUP BY m1.c4 ORDER BY importe DESC NULLS LAST`)).rows;
  console.log('\nCHK1 · doctypes U-D-* (join 6-col, dedup):');
  console.table(dt.map(r => ({ doctype: r.doctype, docs: Number(r.docs), importe: money(r.importe) })));

  // CHK2 — U-D-41 mezcla venta (c5=1 telemarketing) vs traspaso (c5=2 sucursal)
  const s41 = (await ods.query(`
    SELECT m1.c5 serie,
           coalesce(nullif(m1.c27,''),'(cliente)') destino,
           count(DISTINCT (m1.sucursal||m1.c5||m1.c6)) docs,
           round(sum(m1.c16::numeric),0) importe
      FROM kepler_ods.kdm1 m1
     WHERE m1.c2='U' AND m1.c3='D' AND m1.c4='41' AND coalesce(m1.c43,'')<>'C'
       AND m1.sucursal=m1.c1 AND m1.c9::date >= (${anchor} - ${WIN_DAYS})
     GROUP BY m1.c5, 2 ORDER BY importe DESC NULLS LAST`)).rows;
  console.log('\nCHK2 · U-D-41 por serie/destino (1=telemarketing venta, 2=sucursal traspaso):');
  console.table(s41.map(r => ({ serie: r.serie, destino: r.destino, docs: Number(r.docs), importe: money(r.importe) })));
  const traspaso41 = s41.filter(r => r.serie === '2').reduce((a, r) => a + Number(r.importe || 0), 0);
  const venta41 = s41.filter(r => r.serie === '1').reduce((a, r) => a + Number(r.importe || 0), 0);
  if (traspaso41 > 0) add('WARN', 'U-D-41 mezcla venta y traspaso',
    `Agregar U-D-41 sin filtrar colaría ${money(traspaso41)} de traspasos (serie 2 "Embarque Sucursal"). Venta real telemarketing (serie 1) = ${money(venta41)}.`);

  // CHK3 — hueco de cobertura: telemarketing NO se cuenta; ¿solapa con U-D-10 TI%?
  const suc41 = (await ods.query(`SELECT DISTINCT sucursal FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND c4='41' AND c5='1' AND ${WIN} ORDER BY 1`)).rows.map(r => r.sucursal);
  const sucTI = (await ods.query(`SELECT DISTINCT sucursal FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND c4='10' AND upper(c10) LIKE 'TI%' AND ${WIN} ORDER BY 1`)).rows.map(r => r.sucursal);
  const overlap = suc41.filter(s => sucTI.includes(s));
  add(overlap.length ? 'WARN' : 'OK', 'Mayoreo/telemarketing (U-D-41 serie 1) hoy NO se cuenta',
    `Sucursales con venta telemarketing: [${suc41.join(',') || '—'}]. Con U-D-10 TI% (mayoreo ya contado): [${sucTI.join(',') || '—'}]. ` +
    (overlap.length ? `SOLAPE en [${overlap.join(',')}] → verificar antes de sumar para no duplicar.` : `Sin solape → se puede agregar como venta sin duplicar (filtrando serie 1).`));

  // CHK4 — duplicación por réplica cruzada del mirror
  const rep = (await ods.query(`
    SELECT (sucursal=c1) nativo, count(*) rows
      FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND c4='10' AND c9::date >= (${anchor} - ${WIN_DAYS})
     GROUP BY 1`)).rows;
  const nativo = Number(rep.find(r => r.nativo)?.rows || 0);
  const replica = Number(rep.find(r => !r.nativo)?.rows || 0);
  add(replica > 0 ? 'INFO' : 'OK', 'Réplica cruzada del mirror kepler_ods',
    `kdm1 U-D-10: ${nativo} filas nativas (sucursal=c1) + ${replica} réplicas de otras sucursales. ` +
    `Regla obligatoria al leer el mirror: WHERE sucursal=c1 (el importer canónico evita esto leyendo por-sucursal).`);

  // CHK5 — cancelados (c43) materialidad
  const c43 = (await ods.query(`
    SELECT coalesce(nullif(c43,''),'(vacío)') c43, count(*) docs, round(sum(c16::numeric),0) importe
      FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND c4='10' AND ${WIN}
     GROUP BY 1 ORDER BY docs DESC`)).rows;
  const tot = c43.reduce((a, r) => a + Number(r.importe || 0), 0);
  const sospechoso = c43.filter(r => ['R', 'A', 'C'].includes(r.c43)).reduce((a, r) => a + Number(r.importe || 0), 0);
  const pct = tot ? (sospechoso / tot * 100) : 0;
  console.log('\nCHK5 · U-D-10 por estatus c43:');
  console.table(c43.map(r => ({ c43: r.c43, docs: Number(r.docs), importe: money(r.importe) })));
  add(pct > 1 ? 'WARN' : 'OK', 'Cancelados U-D-10 (el mart no filtra c43)',
    `Estatus R/A/C = ${money(sospechoso)} (${pct.toFixed(2)}% del importe). ${pct > 1 ? 'Material: conviene filtrar.' : 'Despreciable.'}`);
}

async function checkAnalytics(an) {
  console.log(`\n════════ ANALYTICS.sales_daily ════════`);
  const has = (await an.query(`SELECT to_regclass('analytics.sales_daily') t`)).rows[0].t;
  if (!has) { add('INFO', 'analytics.sales_daily ausente/vacía', 'Saltando chequeos de consumidores (correr en prod).'); return; }
  const n = Number((await an.query(`SELECT count(*) c FROM analytics.sales_daily`)).rows[0].c);
  if (!n) { add('INFO', 'analytics.sales_daily vacía', 'Sin filas (esperado en local platform_test). Correr en prod.'); return; }

  // canales presentes
  const ch = (await an.query(`
    SELECT channel, count(*) rows, round(sum(revenue)::numeric,0) revenue
      FROM analytics.sales_daily WHERE sale_date >= (${anchor} - ${WIN_DAYS})
     GROUP BY channel ORDER BY revenue DESC NULLS LAST`)).rows;
  console.log('\nCanales en sales_daily:'); console.table(ch.map(r => ({ channel: r.channel, rows: Number(r.rows), revenue: money(r.revenue) })));

  // Kepler↔Wincaja: mismo warehouse/product/día con canal kepler Y canal wincaja (riesgo de doble conteo por cutover)
  const dup = (await an.query(`
    WITH k AS (SELECT DISTINCT tenant_id,product_id,warehouse_id,sale_date FROM analytics.sales_daily WHERE channel NOT LIKE 'wincaja_%' AND sale_date >= (${anchor} - ${WIN_DAYS})),
         w AS (SELECT DISTINCT tenant_id,product_id,warehouse_id,sale_date FROM analytics.sales_daily WHERE channel LIKE 'wincaja_%' AND sale_date >= (${anchor} - ${WIN_DAYS}))
    SELECT count(*) n_overlap FROM k JOIN w USING (tenant_id,product_id,warehouse_id,sale_date)`)).rows[0].n_overlap;
  add(Number(dup) > 0 ? 'FAIL' : 'OK', 'Solape Kepler↔Wincaja (mismo warehouse/producto/día en ambas fuentes)',
    `${dup} claves con canal Kepler Y canal Wincaja simultáneo. ${Number(dup) > 0 ? 'DOBLE CONTEO: cutover mal configurado en esas sucursales.' : 'Sin solape (cutover correcto).'}`);
}

async function checkWincaja(win) {
  console.log(`\n════════ WINCAJA réplica ════════`);
  // materialidad de devoluciones: ¿existen líneas tipo 'V' con valor negativo (netas) o hay otro tipo?
  try {
    const tipos = (await win.query(`
      SELECT d.tipo, count(*) lineas, round(sum(d.valor_venta::numeric),0) valor
        FROM wincaja.detalles_mov_almacen d GROUP BY d.tipo ORDER BY lineas DESC LIMIT 10`)).rows;
    console.log('\nTipos de movimiento en detalles_mov_almacen:'); console.table(tipos.map(r => ({ tipo: r.tipo, lineas: Number(r.lineas), valor: money(r.valor) })));
    const neg = (await win.query(`SELECT count(*) c FROM wincaja.detalles_mov_almacen WHERE tipo='V' AND valor_venta::numeric < 0`)).rows[0].c;
    add(Number(neg) > 0 ? 'OK' : 'INFO', 'Devoluciones Wincaja',
      Number(neg) > 0 ? `${neg} líneas tipo V con valor negativo → devoluciones netean en el SUM (correcto, neto).` : `0 líneas V negativas → las devoluciones NO están como V; el total es BRUTO (verificar si deberían restarse).`);
  } catch (e) { add('INFO', 'Wincaja no accesible / esquema distinto', e.message); }
}

(async () => {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  VALIDACIÓN DE FUENTES DE VENTA  (read-only)               ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  if (!process.env.ODS_URL) { console.error('ERROR: falta ODS_URL'); process.exit(2); }
  const ods = await connect(process.env.ODS_URL);
  try {
    await checkKeplerOds(ods);
    if (process.env.ANALYTICS_URL) { const an = await connect(process.env.ANALYTICS_URL); await checkAnalytics(an).finally(() => an.end()); }
    else add('INFO', 'ANALYTICS_URL no seteado', 'Chequeos de consumidores/dedup salteados.');
    if (process.env.WIN_URL) { const win = await connect(process.env.WIN_URL); await checkWincaja(win).finally(() => win.end()); }
    else add('INFO', 'WIN_URL no seteado', 'Chequeos de Wincaja salteados.');
  } finally { await ods.end(); }

  const fails = findings.filter(f => f.level === 'FAIL').length;
  const warns = findings.filter(f => f.level === 'WARN').length;
  console.log(`\n════════ RESUMEN: ${flag('FAIL')} ${fails} FAIL · ${flag('WARN')} ${warns} WARN ════════`);
  process.exit(fails > 0 ? 1 : 0);
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(3); });
