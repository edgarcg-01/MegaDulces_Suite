/* eslint-disable no-console */
/**
 * DM.11 — Backfill del DESTINO de traspasos ya cargados (a quién va dirigido).
 *
 * Las filas `TrsfShip` (U/D/41) importadas ANTES de DM.11 no tienen dest_code/dest_label.
 * Este script las rellena SIN re-importar el feed: lee `kdm1.c10` + label de `md.kdud` de
 * cada servidor Kepler LAN y hace UPDATE de SOLO esas 2 columnas sobre las filas TrsfShip
 * (match por source_branch + folio + doc_serie). También auto-descubre destinos nuevos en
 * `analytics.transfer_dest_map` (sin tocar el warehouse_id curado).
 *
 * NO borra ni re-inserta nada del feed → seguro de correr en prod. Idempotente.
 * El nightly (`import-stock-movements`) ya trae dest para filas nuevas; esto es solo el
 * catch-up de lo viejo.
 *
 * Conexión destino por env (NO hardcodear credenciales):
 *   DATABASE_URL_NEW='postgresql://…railway'  STOCK_BRANCH_MAP='[…]'  node database/scripts/backfill-transfer-dest.js
 *   (sin STOCK_BRANCH_MAP usa el mapa LAN por defecto = mismos hosts que import-stock-movements)
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(2); }

const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      { suc: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { suc: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { suc: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { suc: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { suc: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { suc: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];
const sucOf = (m) => m.suc || (/(md_)?(\d{2})/i.exec(m.code || m.url || '') || [])[2] || null;
// Ventana de lectura de Kepler (default 200d). Ampliar si hay historia vieja backfilleada
// (p.ej. el one-shot 320d de DM.10b dejó traspasos >200d sin destino).
const WINDOW = Number(process.env.BACKFILL_DAYS) || 200;

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  let totalUpd = 0;
  const discovered = new Map();
  try {
    for (const m of MAP) {
      const suc = sucOf(m);
      if (!suc) { console.log(`⚠ ${m.code || m.url}: sin nº sucursal — skip`); continue; }
      let src;
      try { src = new Client({ connectionString: m.url, connectionTimeoutMillis: 8000, statement_timeout: 120000 }); await src.connect(); }
      catch (e) { console.log(`⚠ suc ${suc}: sin conexión (${e.message}) — skip`); continue; }
      try {
        const rows = (await src.query(`
          SELECT h.c6 folio, h.c5::text serie, h.c10 dest_code, dd.c3 dest_label
          FROM ${m.schema || 'md'}.kdm1 h
          LEFT JOIN (SELECT DISTINCT ON (c2) c2, c3 FROM ${m.schema || 'md'}.kdud ORDER BY c2) dd ON dd.c2 = h.c10
          WHERE h.c1=$1 AND h.c2='U' AND h.c3='D' AND (h.c4)::int=41 AND h.c9::date >= (CURRENT_DATE - $2::int)
        `, [suc, WINDOW])).rows;
        let upd = 0;
        for (const r of rows) {
          const label = r.dest_label || r.dest_code || null;
          if (r.dest_code) discovered.set(r.dest_code, label);
          const res = await db.query(`
            UPDATE analytics.stock_movements SET dest_code=$3, dest_label=$4
             WHERE tenant_id=$1 AND doc_code='TrsfShip' AND source_branch=$2
               AND folio=$5 AND coalesce(doc_serie,'')=coalesce($6,'')`,
            [M, suc, r.dest_code || null, label, r.folio, r.serie || '']);
          upd += res.rowCount;
        }
        console.log(`✅ suc ${suc}: ${rows.length} docs U/D/41 en Kepler → ${upd} líneas TrsfShip actualizadas`);
        totalUpd += upd;
      } catch (e) { console.log(`⚠ suc ${suc}: ${e.message}`); }
      finally { await src.end(); }
    }
    for (const [code, label] of discovered) {
      await db.query(`INSERT INTO analytics.transfer_dest_map (tenant_id, dest_code, dest_label)
        VALUES ($1,$2,$3) ON CONFLICT (tenant_id,dest_code) DO UPDATE
        SET dest_label=COALESCE(analytics.transfer_dest_map.dest_label, EXCLUDED.dest_label), updated_at=now()`, [M, code, label]);
    }
    const chk = (await db.query(`SELECT count(*) FILTER (WHERE dest_code IS NOT NULL) con, count(*) tot
      FROM analytics.stock_movements WHERE tenant_id=$1 AND doc_code='TrsfShip'`, [M])).rows[0];
    console.log(`\n=== TrsfShip: ${chk.con}/${chk.tot} líneas con destino · ${totalUpd} actualizadas ===`);
  } catch (e) {
    console.error('ERROR:', e.message); process.exitCode = 1;
  } finally { await db.end(); }
})();
