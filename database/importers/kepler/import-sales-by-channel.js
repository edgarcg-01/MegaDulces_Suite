/* eslint-disable no-console */
/**
 * Reclasifica la VENTA CONTABLE (cuenta 401 de `md.kdc2YYMM`) por CANAL real desde el
 * concepto `c6` → `analytics.sales_by_channel_monthly`. La subcuenta 401-NNN no separa
 * canal y su nombre engaña ('VENTA FLETES A TERCEROS'/'VENTAS VECINAL'); el canal vive en c6:
 *   P.V. → mostrador · TLMKT → telemarketing · R.D./RUTA → ruta · R.V. → reparto_vecinal.
 * Ver docs/IMPLEMENTACION/KEPLER_CONTABILIDAD_MODELO.md §Familia 4.
 *
 * Lee las DBs de sucursal (LAN, igual que import-ledger-chain), filtra a la sucursal propia
 * (c14) y suma neto acreedor (abonos - cargos). Idempotente por (sucursal, mes) reachable.
 *
 *   node database/importers/kepler/import-sales-by-channel.js            # dry-run (12m)
 *   node database/importers/kepler/import-sales-by-channel.js --apply
 *   ... --months 19
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;
function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def; }
const MONTHS = Math.max(1, Math.min(36, Number(arg('months', 12))));

const MAP = process.env.EXPENSES_BRANCH_MAP ? JSON.parse(process.env.EXPENSES_BRANCH_MAP) : [
  { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
  { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
  { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
  { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
  { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
  { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
];

function monthWindow(n) {
  const now = new Date();
  const t = [];
  let y = now.getFullYear(), m = now.getMonth() + 1;
  for (let i = 0; i < n; i++) { t.push({ tbl: `kdc2${String(y % 100).padStart(2, '0')}${String(m).padStart(2, '0')}`, ym: `${y}-${String(m).padStart(2, '0')}` }); m--; if (m === 0) { m = 12; y--; } }
  return t;
}

// c6 → { canal, plaza }. plaza en MAYÚSCULAS (clave única). null = baja/cancelación (skip).
// Orden: los prefijos de canal ganan; CONTADO y el residuo con nombre de cliente al final.
function classify(c6) {
  const s = String(c6 || '').replace(/\s+/g, ' ').trim();
  const up = s.toUpperCase();
  if (!s) return { canal: 'otro', plaza: '' };
  if (/BAJA|CANCELAD|P[Óo]LIZA CANC/i.test(up)) return null;
  const rm = up.match(/(?:R\.?D\.?|RUTA)\D*(\d+)/);
  if (rm) return { canal: 'ruta', plaza: `RUTA ${rm[1]}` };
  if (/^R\.?D\.?\b|RD MORELIA|R\.?D\.? MORELIA/.test(up)) return { canal: 'ruta', plaza: up.slice(0, 40) };
  if (/TLMKT|TLMK|TELEMK/.test(up)) return { canal: 'telemarketing', plaza: up.replace(/TLMKT?|TELEMK\w*/, '').replace(/\s+/g, ' ').trim().slice(0, 40) };
  if (/^R\.?V\.?\b/.test(up)) return { canal: 'reparto_vecinal', plaza: up.replace(/^R\.?V\.?\s*/, '').slice(0, 40) };
  // Piso de ventas: prefijo P.V. o los resúmenes sin prefijo (PISO / SUCURSAL <plaza>).
  if (/^P\.?V\.?\b|PISO|^SUCURSAL\b/.test(up)) return { canal: 'mostrador', plaza: up.replace(/^P\.?V\.?\s*/, '').slice(0, 40) };
  if (/CONTADO/.test(up)) return { canal: 'contado', plaza: up.slice(0, 40) };
  return { canal: 'otro', plaza: up.slice(0, 40) };
}

(async () => {
  const tables = monthWindow(MONTHS);
  const yms = tables.map((t) => t.ym);
  const remote = !/@(localhost|127\.0\.0\.1|192\.168\.)/.test(DST);
  const db = new Client({ connectionString: DST, ssl: remote ? { rejectUnauthorized: false } : false, keepAlive: true, statement_timeout: 0 });
  await db.connect();
  const acc = new Map(); // sucursal|canal|plaza|ym → { ventas, movs }
  const okCodes = [];
  console.log(`\n=== Ventas por canal (cuenta 401, c6) → analytics.sales_by_channel_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
  console.log(`  ${MONTHS} meses (${yms[yms.length - 1]} … ${yms[0]})\n`);

  for (const b of MAP) {
    const src = new Client({ connectionString: b.url, statement_timeout: 120000 });
    try { await src.connect(); } catch (e) { console.log(`  ⚠ sucursal ${b.code}: sin conexión — skip`); continue; }
    okCodes.push(b.code);
    let filas = 0;
    try {
      for (const t of tables) {
        if (!(await src.query(`SELECT to_regclass('md.${t.tbl}') r`)).rows[0].r) continue;
        const rows = (await src.query(
          `SELECT c6, c4, c5::numeric v FROM md.${t.tbl}
            WHERE c3 LIKE '401%' AND COALESCE(c5,0) <> 0
              AND (c14 IS NULL OR btrim(c14)='' OR btrim(c14)=$1)`, [b.code])).rows;
        for (const r of rows) {
          const cl = classify(r.c6);
          if (!cl) continue;
          const key = `${b.code}|${cl.canal}|${cl.plaza}|${t.ym}`;
          const a = acc.get(key) || { sucursal: b.code, canal: cl.canal, plaza: cl.plaza, ym: t.ym, ventas: 0, movs: 0 };
          a.ventas += (r.c4 === 'A' ? Number(r.v) : -Number(r.v));
          a.movs += 1;
          acc.set(key, a);
          filas++;
        }
      }
      console.log(`  sucursal ${b.code}: ${filas} líneas 401 clasificadas`);
    } catch (e) { console.log(`  ⚠ sucursal ${b.code}: ${e.message}`); }
    finally { await src.end(); }
  }

  const rows = [...acc.values()].filter((a) => Math.abs(a.ventas) > 0.005);
  // resumen por canal
  const byCanal = {};
  for (const a of rows) { const c = byCanal[a.canal] ||= { ventas: 0, movs: 0 }; c.ventas += a.ventas; c.movs += a.movs; }
  console.log('\n  resumen por canal (todo el periodo):');
  console.table(Object.fromEntries(Object.entries(byCanal).map(([k, v]) => [k, { ventas: '$' + Math.round(v.ventas).toLocaleString(), movs: v.movs }])));
  console.log(`  filas a persistir: ${rows.length}`);

  if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); await db.end(); return; }
  if (!okCodes.length) { console.log('sin sucursales reachable — nada que hacer.'); await db.end(); return; }

  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`DELETE FROM analytics.sales_by_channel_monthly WHERE tenant_id=$1 AND sucursal = ANY($2) AND anio_mes = ANY($3)`, [M, okCodes, yms]);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((a, ri) => {
        const o = ri * 7;
        vals.push(`(gen_random_uuid(),$${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},now(),now())`);
        params.push(M, a.sucursal, a.canal, a.plaza, a.ym, Math.round(a.ventas * 100) / 100, a.movs);
      });
      await db.query(`INSERT INTO analytics.sales_by_channel_monthly (id,tenant_id,sucursal,canal,plaza,anio_mes,ventas,movs,computed_at,updated_at) VALUES ${vals.join(',')}`, params);
    }
    await db.query('COMMIT');
    await db.query(`ANALYZE analytics.sales_by_channel_monthly`);
    console.log(`\n[APPLY] COMMIT — ${rows.length} filas (sucursales ${okCodes.join(',')}).`);
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); console.error('ERROR (rollback):', e.message); process.exitCode = 1; }
  finally { await db.end(); }
})().catch((e) => { console.error(e); process.exit(1); });
