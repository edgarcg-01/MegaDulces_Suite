/* eslint-disable no-console */
/**
 * RECONCILER de PROCEDENCIA de venta-ruta (Fase VP / ADR-056, deuda "D").
 *
 * NO es un importer de negocio: no copia ningún hecho ni mueve el gold. Lee READ-ONLY los DOS
 * universos que chocan en la misma llave de `analytics.sales_by_route_monthly` y DECLARA, por llave,
 * qué universo ganó el `GREATEST` y cuánto tapó — la única forma de hacer auditable ese máximo ciego,
 * porque las dos fuentes no son alcanzables desde prod (por eso no es una vista):
 *
 *   PUSH   = runner `.249 / mart.ventas` (ruta_NN)         ← import-route-push-monthly
 *   BRANCH = réplica lógica `kepler_md_06` (c67 = 500N)    ← ya NO escribe el gold; queda como TESTIGO
 *
 * ⚠️ 2026-09-10: para Canindo el gold dejó de salir de un GREATEST entre esos dos. Medido, la
 * réplica de sucursal es un SUBCONJUNTO DEGRADADO (ve 3 de 5 rutas, en ventanas de días sueltos)
 * y `import-canindo-routes-monthly` pasó a COMPONER la serie —Wincaja hasta la frontera + push
 * desde la frontera— y a escribirla con overwrite. Este reconciler sigue siendo el que declara,
 * pero ahora también lee el GOLD: cuando el gold supera al ganador de los dos universos del
 * runner, es porque carga una era que ninguno de los dos tiene (la de Wincaja) y se declara
 * `composite`. El sensor `stall` no cambia de sentido: branch > push sigue siendo push atorado.
 *
 * Escribe SOLO metadata a `analytics.route_monthly_provenance` (clase observabilidad). El sensor
 * `route_provenance` de db-health la lee y dispara si `stall` (branch gana una métrica ⇒ push atorado)
 * o si el reconciler dejó de correr. Las queries de origen son VERBATIM de los dos importers, así los
 * números coinciden al peso con lo que ellos upsertan.
 *
 *   node database/importers/kepler/reconcile-route-provenance.js            # dry-run (plan)
 *   node database/importers/kepler/reconcile-route-provenance.js --apply    # UPSERT a prod
 *
 * Env: DATABASE_URL_NEW/DST_URL = destino (prod). SRC_URL = runner (default .249). CANINDO_SRC = réplica.
 */
const { Client } = require('pg');
const { branchUrl } = require('../lib/kepler-branches');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW (prod Railway)'); })();
const SRC_PUSH = process.env.SRC_URL || 'postgresql://postgres:superoot@192.168.0.249:5433/kepler_consolidado';
const SRC_BRANCH = process.env.CANINDO_SRC || branchUrl('06'); // réplica local kepler_md_06
const APPLY = process.argv.includes('--apply');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

// c67 = '500N' → ruta 50N (idéntico a import-canindo-routes-monthly).
const ROUTE_SALES = `h.c2='U' AND h.c3='D' AND h.c4=10 AND btrim(h.c67) ~ '^500[1-9]$'`;
const monthKey = (d) => new Date(d).toISOString().slice(0, 7); // 'YYYY-MM'

(async () => {
  console.log(`\n=== RECONCILE procedencia venta-ruta → analytics.route_monthly_provenance (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===\n`);
  const from = `${YEAR}-01-01`, to = `${YEAR + 1}-01-01`;

  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();

  // warehouse code → id (para resolver la llave del gold)
  const whById = new Map((await dst.query(
    `SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1 AND deleted_at IS NULL`, [M])).rows.map((r) => [r.code, r.id]));

  // --- PUSH (runner) — VERBATIM de import-route-push-monthly ---
  const push = new Client({ connectionString: SRC_PUSH, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
  await push.connect();
  let pushRows;
  try {
    ({ rows: pushRows } = await push.query(
      `SELECT COALESCE(NULLIF(split_part(max(almacen), '-', 1), ''), '01') AS wcode,
              substring(sucursal from 'ruta_(.*)') AS route_no,
              date_trunc('month', fecha)::date AS month,
              sum(cantidad)::numeric AS units, sum(importe)::numeric AS revenue,
              count(DISTINCT folio)::int AS tickets
         FROM mart.ventas
        WHERE sucursal LIKE 'ruta_%' AND fecha >= $1 AND fecha < $2 AND fecha <= CURRENT_DATE
        GROUP BY sucursal, date_trunc('month', fecha)`, [from, to]));
  } finally { await push.end().catch(() => {}); }

  // --- BRANCH (réplica kepler_md_06) — VERBATIM de import-canindo-routes-monthly ---
  const branch = new Client({ connectionString: SRC_BRANCH, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
  await branch.connect();
  let branchRows;
  try {
    ({ rows: branchRows } = await branch.query(
      `SELECT 'WIN-50' || right(btrim(h.c67),1) AS route_code, '50' || right(btrim(h.c67),1) AS route_no,
              date_trunc('month', h.c9)::date AS month,
              count(DISTINCT h.c6) AS tickets, sum(d.c9)::numeric AS units, sum(d.c13)::numeric AS revenue
         FROM md.kdm2 d
         JOIN md.kdm1 h ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
        WHERE ${ROUTE_SALES} AND h.c9 >= $1 AND h.c9 < $2
          AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> ''
        GROUP BY 1, 2, 3`, [from, to]));
  } finally { await branch.end().catch(() => {}); }

  // --- Merge por llave (warehouse_code, route_code, month) ---
  const K = new Map(); // key → { wcode, route_code, month, push?, branch? }
  const put = (wcode, route_code, month, universe, m) => {
    const key = `${wcode}|${route_code}|${monthKey(month)}`;
    if (!K.has(key)) K.set(key, { wcode, route_code, month: monthKey(month) + '-01' });
    K.get(key)[universe] = { revenue: +m.revenue || 0, tickets: +m.tickets || 0, units: +m.units || 0 };
  };
  for (const r of pushRows) if (r.route_no) put(r.wcode, `WIN-${r.route_no}`, r.month, 'push', r);
  for (const r of branchRows) put('06', r.route_code, r.month, 'branch', r); // Canindo siempre warehouse 06

  // --- GOLD publicado — para no declarar como ganador a un universo que ya no es el dueño ---
  const gold = new Map((await dst.query(
    `SELECT w.code wcode, s.route_code, to_char(s.month,'YYYY-MM') mes, s.revenue
       FROM analytics.sales_by_route_monthly s JOIN commercial.warehouses w ON w.id=s.warehouse_id
      WHERE s.tenant_id=$1 AND s.route_code LIKE 'WIN-%'`, [M])).rows
    .map((r) => [`${r.wcode}|${r.route_code}|${r.mes}`, Number(r.revenue)]));

  const out = [];
  for (const v of K.values()) {
    const wid = whById.get(v.wcode); if (!wid) continue; // sin warehouse resuelto → fuera
    const p = v.push, b = v.branch;
    let winner, discarded = 0, stall = false;
    if (p && b) {
      winner = p.revenue > b.revenue ? 'push' : b.revenue > p.revenue ? 'branch' : 'tie';
      discarded = Math.min(p.revenue, b.revenue);
      stall = b.revenue > p.revenue || b.tickets > p.tickets || b.units > p.units; // branch degradaría/swap
    } else winner = p ? 'push_only' : 'branch_only';
    // El gold por encima del mejor de los dos = carga una era que el runner no tiene (Wincaja,
    // pegada por import-canindo-routes-monthly). Declararlo `push` sería nombrar mal al dueño.
    const g = gold.get(`${v.wcode}|${v.route_code}|${v.month.slice(0, 7)}`);
    if (g != null && g > Math.max(p?.revenue || 0, b?.revenue || 0) + 1) winner = 'composite';
    out.push({ wid, ...v, p, b, winner, discarded, stall });
  }

  const stalls = out.filter((o) => o.stall);
  const dual = out.filter((o) => o.p && o.b);
  console.log(`  push: ${pushRows.length} filas · branch: ${branchRows.length} filas · llaves reconciliadas: ${out.length} (${dual.length} con AMBOS universos)`);
  console.log(`  máx descartado por GREATEST: $${Math.round(Math.max(0, ...out.map((o) => o.discarded))).toLocaleString()} · STALLS (push atorado): ${stalls.length}`);
  for (const o of dual.slice(0, 12)) {
    console.log(`    ${o.route_code} ${o.month.slice(0, 7)}: push $${Math.round(o.p.revenue).toLocaleString()}/${o.p.tickets}tkt vs branch $${Math.round(o.b.revenue).toLocaleString()}/${o.b.tickets}tkt → gana ${o.winner}${o.stall ? '  ⚠ STALL' : ''}`);
  }

  if (!APPLY) { console.log(`\n[DRY-RUN] no escribe. Corré con --apply.`); await dst.end(); return; }

  let ups = 0;
  for (const o of out) {
    await dst.query(
      `INSERT INTO analytics.route_monthly_provenance
         (tenant_id, warehouse_id, route_code, month, revenue_push, revenue_branch,
          tickets_push, tickets_branch, units_push, units_branch, source_winner, discarded_revenue, stall, reconciled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (tenant_id, warehouse_id, route_code, month) DO UPDATE SET
         revenue_push=EXCLUDED.revenue_push, revenue_branch=EXCLUDED.revenue_branch,
         tickets_push=EXCLUDED.tickets_push, tickets_branch=EXCLUDED.tickets_branch,
         units_push=EXCLUDED.units_push, units_branch=EXCLUDED.units_branch,
         source_winner=EXCLUDED.source_winner, discarded_revenue=EXCLUDED.discarded_revenue,
         stall=EXCLUDED.stall, reconciled_at=now()`,
      [M, o.wid, o.route_code, o.month, o.p?.revenue ?? null, o.b?.revenue ?? null,
       o.p?.tickets ?? null, o.b?.tickets ?? null, o.p?.units ?? null, o.b?.units ?? null,
       o.winner, o.discarded, o.stall]);
    ups++;
  }
  console.log(`\n[APPLY] ${ups} llaves upserted en analytics.route_monthly_provenance.${stalls.length ? `  ⚠ ${stalls.length} STALL — revisar push.` : ''}`);
  await dst.end();
})().catch((e) => { console.error('\nERROR:', e.message); process.exit(1); });
