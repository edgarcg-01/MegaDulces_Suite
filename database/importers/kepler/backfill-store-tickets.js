/* eslint-disable no-console */
/**
 * Backfill puntual de `analytics.store_live_tickets` para huecos del poller live.
 *
 * El poller (`live-tickets-poller.js`) empuja los tickets del POS en vivo; si un día
 * el proceso no corrió (caída de conexión / servicio detenido), esa sucursal queda sin
 * tickets ese día — la VENTA ($) igual está en `analytics.sales_daily` (fact nightly),
 * pero el chart de "Tickets" y "Productos/ticket" de /tienda/analisis-semanal salen en 0.
 *
 * Este script relee esos días desde `KP_CONCENTRADA` (kp.kdm1/kdm2, misma consulta que
 * el poller pero con rango de fecha fijo y filtro por `sucursal`) y hace UPSERT directo
 * en la tabla destino — SIN WebSocket ni alertas de "ticket grande" (son históricos).
 * Idempotente: re-correrlo no duplica (ON CONFLICT tenant+sucursal+serie+folio).
 *
 * Uso:
 *   node database/importers/kepler/backfill-store-tickets.js --branch=05 --from=2026-07-23 --to=2026-07-24 [--apply]
 *   node database/importers/kepler/backfill-store-tickets.js --branch=all --from=2026-06-11 --to=2026-08-02 --apply
 *   (--branch acepta '05', lista '01,03,05', o 'all' = 01..05; sin --apply = dry-run)
 *
 * Env:
 *   KP_SRC_URL   fuente Kepler concentrada (default KP_DEST_URL del .env)
 *   DEST_URL     destino newdb (default DATABASE_URL_NEW). Para prod: pasar el proxy Railway.
 */
const { Client } = require('pg');
const knexLib = require('knex');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const BRANCH_NAMES = {
  '00': 'CEDIS', '01': 'Padre Hidalgo', '02': 'La Piedad Abastos',
  '03': '8ESQ', '04': 'Yurécuaro', '05': 'Zamora Centro',
};

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
}
const APPLY = process.argv.includes('--apply');
const BRANCH_ARG = arg('branch', '05');
const BRANCHES = BRANCH_ARG === 'all'
  ? ['01', '02', '03', '04', '05']
  : BRANCH_ARG.split(',').map((s) => s.trim()).filter(Boolean);
const FROM = arg('from');
const TO = arg('to', FROM);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
if (!ISO.test(FROM || '') || !ISO.test(TO || '')) {
  console.error('Falta --from / --to (YYYY-MM-DD). Ej: --from=2026-07-23 --to=2026-07-24');
  process.exit(1);
}

const KP_SRC = process.env.KP_SRC_URL || process.env.KP_DEST_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA';
const DEST = process.env.DEST_URL || process.env.DATABASE_URL_NEW;
if (!DEST) { console.error('Falta DEST_URL / DATABASE_URL_NEW'); process.exit(1); }

async function readTickets(c, BRANCH) {
  {
    // Misma consulta que el poller (live-tickets-poller.js) pero: schema kp, filtro por
    // `sucursal`, y rango de fecha fijo [FROM..TO] en vez de ventana deslizante.
    const { rows } = await c.query(
      `SELECT h.c6 folio, rtrim(btrim(h.c63),'-') serie, to_char(h.c9::date,'YYYY-MM-DD') fecha, h.c62 hora, h.c5 caja,
              coalesce(h.c16,0) total, h.c10 forma_pago, btrim(h.c67) cajero,
              d.c8 sku, d.c10 nombre, coalesce(d.c9,0) cant, coalesce(d.c13,0) importe, d.c7 linea
         FROM kp.kdm1 h
         JOIN kp.kdm2 d ON d.sucursal=h.sucursal AND h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
        WHERE h.sucursal=$1 AND h.c2='U' AND h.c3='D' AND h.c4=10
          AND h.c62 ~ '^[0-9]{1,2}:[0-9]{2}'
          AND h.c9::date >= $2::date AND h.c9::date <= $3::date
          AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> ''
        ORDER BY h.c9, h.c62, h.c6, d.c7`,
      [BRANCH, FROM, TO]);

    const byTicket = new Map();
    for (const r of rows) {
      const key = `${r.serie}|${r.folio}`;
      let t = byTicket.get(key);
      if (!t) {
        t = {
          warehouse_code: BRANCH, warehouse_name: BRANCH_NAMES[BRANCH] || null,
          serie: r.serie, folio: r.folio,
          ticket_ts: `${r.fecha}T${r.hora.length === 4 ? '0' + r.hora : r.hora}:00-06:00`,
          total: Number(r.total) || 0, forma_pago: r.forma_pago, cajero: r.cajero || null,
          caja: r.caja != null ? String(r.caja).trim() : null, items: [],
        };
        byTicket.set(key, t);
      }
      t.items.push({ sku: r.sku, nombre: r.nombre, cant: Number(r.cant) || 0, importe: Number(r.importe) || 0 });
    }
    return [...byTicket.values()];
  }
}

const CHUNK = 500; // filas por INSERT (upsert por lotes, evita miles de round-trips a Railway)
async function upsert(knex, tickets) {
  let processed = 0;
  for (let i = 0; i < tickets.length; i += CHUNK) {
    const rows = tickets.slice(i, i + CHUNK).map((t) => ({
      tenant_id: TENANT, warehouse_code: t.warehouse_code, warehouse_name: t.warehouse_name,
      serie: t.serie, folio: t.folio, ticket_ts: t.ticket_ts, total: t.total,
      forma_pago: t.forma_pago || null, cajero: t.cajero || null, caja: t.caja || null, items: JSON.stringify(t.items),
    }));
    await knex('analytics.store_live_tickets')
      .insert(rows)
      .onConflict(['tenant_id', 'warehouse_code', 'serie', 'folio'])
      .merge(['warehouse_name', 'ticket_ts', 'total', 'forma_pago', 'cajero', 'caja', 'items']);
    processed += rows.length;
  }
  return { processed };
}

(async () => {
  console.log(`Backfill store_live_tickets · sucursales [${BRANCHES.join(',')}] · ${FROM}..${TO} · ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  fuente: ${KP_SRC.replace(/:[^@/]*@/, ':****@')}`);
  console.log(`  destino: ${DEST.replace(/:[^@/]*@/, ':****@')}`);

  const src = new Client({ connectionString: KP_SRC, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
  await src.connect();
  const knex = APPLY ? knexLib({ client: 'pg', connection: { connectionString: DEST, ssl: { rejectUnauthorized: false } }, pool: { min: 0, max: 4 } }) : null;
  try {
    let grand = 0;
    for (const BRANCH of BRANCHES) {
      const tickets = await readTickets(src, BRANCH);
      const byDay = {};
      for (const t of tickets) { const d = t.ticket_ts.slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
      console.log(`\n· ${BRANCH} ${BRANCH_NAMES[BRANCH] || '?'} — ${tickets.length} tickets`, byDay);
      if (APPLY && tickets.length) {
        const r = await upsert(knex, tickets);
        console.log(`  ✅ upsert ${r.processed}`);
        grand += r.processed;
      }
    }
    console.log(APPLY ? `\n✅ TOTAL upsert: ${grand}` : '\n(dry-run — sin --apply no se escribe)');
  } finally {
    await src.end().catch(() => {});
    if (knex) await knex.destroy();
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
