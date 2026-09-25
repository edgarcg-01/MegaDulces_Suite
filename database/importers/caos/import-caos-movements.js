/**
 * CS.1 — Feed de movimientos de CAOS → `analytics.caos_cash_movements` (+ denominaciones).
 *
 * Corre ON-PREM en `md` (única máquina que alcanza 192.168.0.110), agendado en `crontab.feeds`
 * vía `run-feed.sh` (que carga `feeds.env` con `CAOS_USER`/`CAOS_PASS`). Escribe a prod
 * (`DATABASE_URL_NEW`). Ver `docs/CAOS_CASH_SYSTEM.md` y la Fase CS.
 *
 * ── Cómo trae el dato ──────────────────────────────────────────────────────────────────────────
 * CAOS filtra `getTransactions` por FECHA, no por id, así que el feed pide una VENTANA MÓVIL
 * (`--days`, default 3) y hace UPSERT sin churn: la identidad es `(tenant, device, external_id)` y
 * el `_row_hash` evita reescribir una fila que no cambió. El `getTransactionDetails` (una llamada
 * por movimiento, lo caro) se pide SÓLO para ids nuevos o cuyo encabezado cambió.
 *
 *   node database/importers/caos/import-caos-movements.js --apply            # ventana de 3 días
 *   node database/importers/caos/import-caos-movements.js --apply --days=30
 *   node database/importers/caos/import-caos-movements.js --apply --from=2026-05-01 --to=2026-09-24
 *
 * ── Latido / NOTIFY ────────────────────────────────────────────────────────────────────────────
 * Latido `caos_movimientos` a `analytics.cron_runs` (ADR-053: mide ENTREGA, no "corrió"). Tras un
 * ciclo con novedad, emite `pg_notify('caos_movimientos', firma)` para que la pantalla se entere al
 * momento (mismo puente LISTEN→WS de CG.23.2). La firma lleva conteo + max id + suma, no las filas.
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const crypto = require('crypto');
const { Client } = require('pg');
const { CaosAdapter } = require('./caos-adapter');

// `.trim()` a propósito: `crontab.feeds` se exportó una vez con CRLF y `includes('--apply')`
// —comparación exacta— no matcheaba `--apply\r` (nueve carriles corrieron en seco diciendo "ok").
const ARGS = process.argv.slice(2).map((a) => a.trim());
const APPLY = ARGS.includes('--apply');
const KEY = 'caos_movimientos';
const CANAL = 'caos_movimientos';
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

const argVal = (name, def) => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};

function conexion() {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) throw new Error('sin DATABASE_URL_NEW/DATABASE_URL');
  const ssl = /@(localhost|127\.0\.0\.1|192\.168\.|pg-prod)/.test(cs) ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: cs, ssl, statement_timeout: 60000 });
}

// ── Parseo de la forma de CAOS ─────────────────────────────────────────────────────────────────

/** "10890.00 MXN" | ["10890.00 MXN"] → { total:number, currency:string }. */
function parseTotal(t) {
  const s = Array.isArray(t) ? (t[0] || '') : String(t || '');
  const total = Number(s.replace(/[^0-9.\-]/g, '')) || 0;
  const cur = (s.match(/[A-Z]{3}/) || ['MXN'])[0];
  return { total, currency: cur };
}

/** "24/09/2026 10:03:34" (DD/MM/YYYY, hora MX sin DST) → ISO con -06:00. */
function parseFecha(s) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/.exec(String(s || ''));
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '00', mi = '00', ss = '00'] = m;
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}-06:00`;
}

/** "24/09/2026" → "2026-09-24". */
function parseFechaContable(s) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** md5 del payload normalizado: si no cambió, el UPSERT no reescribe. */
function rowHash(mov, det) {
  const norm = {
    type: mov.type,
    date: mov.date,
    acc: mov.accountingDate,
    user: mov.user,
    total: mov.transactionTotal,
    ref: det.ref ?? null,
    shift: det.shiftID ?? null,
    cash: (det.cashDetails || []).map((c) => `${c.denom}:${c.type}:${c.quantity}`).sort(),
    cheques: det.cheques || [],
    tickets: det.tickets || [],
  };
  return crypto.createHash('md5').update(JSON.stringify(norm)).digest('hex');
}

// ── El ciclo ───────────────────────────────────────────────────────────────────────────────────

async function ciclo(c) {
  const adapter = new CaosAdapter();
  if (!adapter.isConfigured()) {
    return { nota: 'CAOS sin credenciales (CAOS_USER/CAOS_PASS) — feed inactivo en este entorno', filas: 0, nuevos: 0 };
  }

  const fromArg = argVal('from');
  const toArg = argVal('to');
  const days = Number(argVal('days', '3')) || 3;
  const to = toArg ? new Date(toArg + 'T00:00:00-06:00') : new Date();
  const from = fromArg ? new Date(fromArg + 'T00:00:00-06:00')
    : new Date(to.getTime() - days * 86400000);

  const lista = await adapter.getTransactions({ from, to });
  if (!lista.length) return { filas: 0, nuevos: 0, actualizados: 0 };

  const device = lista[0].devName || 'CAOS';
  const ids = lista.map((t) => Number(t.id)).filter(Number.isFinite);

  // Qué ya tenemos de esa ventana (id → hash), para no repedir el detalle de lo que no cambió.
  const prev = await c.query(
    `SELECT external_id, _row_hash FROM analytics.caos_cash_movements
      WHERE tenant_id = $1 AND device = $2 AND external_id = ANY($3::bigint[])`,
    [TENANT, device, ids],
  );
  const hashPrev = new Map(prev.rows.map((r) => [Number(r.external_id), r._row_hash]));

  let nuevos = 0; let actualizados = 0;
  for (const mov of lista) {
    const id = Number(mov.id);
    if (!Number.isFinite(id)) continue;
    // El detalle es lo caro: sólo se pide si el id es nuevo. Para uno ya visto, el encabezado no
    // trae denominaciones, así que si CAOS lo modificara no lo detectaríamos sin re-pedir; se acepta
    // porque los movimientos de una caja fuerte son inmutables una vez registrados.
    const yaEsta = hashPrev.has(id);
    if (yaEsta) continue;

    const det = await adapter.getTransactionDetails(id);
    const hash = rowHash(mov, det);
    const { total, currency } = parseTotal(mov.transactionTotal);

    await c.query('BEGIN');
    try {
      const up = await c.query(
        `INSERT INTO analytics.caos_cash_movements
           (tenant_id, device, external_id, type_id, type_label, occurred_at, accounting_date,
            user_external, total, currency, ref, shift_id, cheques, tickets, raw, _row_hash, synced_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16, now(), now())
         ON CONFLICT (tenant_id, device, external_id) DO UPDATE SET
            type_id=EXCLUDED.type_id, type_label=EXCLUDED.type_label, occurred_at=EXCLUDED.occurred_at,
            accounting_date=EXCLUDED.accounting_date, user_external=EXCLUDED.user_external,
            total=EXCLUDED.total, currency=EXCLUDED.currency, ref=EXCLUDED.ref, shift_id=EXCLUDED.shift_id,
            cheques=EXCLUDED.cheques, tickets=EXCLUDED.tickets, raw=EXCLUDED.raw,
            _row_hash=EXCLUDED._row_hash, synced_at=now(), updated_at=now()
          WHERE analytics.caos_cash_movements._row_hash IS DISTINCT FROM EXCLUDED._row_hash
          RETURNING id, (xmax = 0) AS insertado`,
        [
          TENANT, device, id, Number(det.type ?? -1), mov.type || String(det.type ?? ''),
          parseFecha(mov.date), parseFechaContable(mov.accountingDate),
          mov.user || null, total, currency, det.ref || null, det.shiftID || null,
          JSON.stringify(det.cheques || []), JSON.stringify(det.tickets || []),
          JSON.stringify(det), hash,
        ],
      );
      // Si el UPSERT no tocó nada (hash igual), `up.rows` viene vacío → nada que hacer.
      if (up.rows.length) {
        const movId = up.rows[0].id;
        if (up.rows[0].insertado) nuevos++; else actualizados++;
        // Denominaciones: se rehacen (borrar+insertar) sólo cuando la fila cambió.
        await c.query(`DELETE FROM analytics.caos_cash_denominations WHERE tenant_id=$1 AND movement_id=$2`, [TENANT, movId]);
        for (const d of det.cashDetails || []) {
          const q = Number(d.quantity) || 0;
          const dn = Number(d.denom);
          // `denom` NEGATIVO es válido: en un "Cambio" son los billetes que SALEN (el signo lleva la
          // dirección). Sólo se descarta el 0 o el no-numérico, que no es dinero.
          if (q <= 0 || !Number.isFinite(dn) || dn === 0) continue;
          await c.query(
            `INSERT INTO analytics.caos_cash_denominations (tenant_id, movement_id, denom, pieza_tipo, quantity)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (tenant_id, movement_id, denom, pieza_tipo) DO UPDATE SET quantity=EXCLUDED.quantity`,
            [TENANT, movId, dn, String(d.type || 'B'), q],
          );
        }
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  }

  // Firma del corte para el NOTIFY (conteo + max id + suma), no las filas.
  const resumen = await c.query(
    `SELECT count(*)::int n, max(external_id) mx, round(coalesce(sum(total),0),2)::text suma,
            max(synced_at)::text al
       FROM analytics.caos_cash_movements WHERE tenant_id=$1 AND device=$2`,
    [TENANT, device],
  );
  const rr = resumen.rows[0];
  if (nuevos + actualizados > 0) {
    const payload = JSON.stringify({
      tenant_id: TENANT, device, filas: rr.n, max_id: rr.mx,
      firma: `${rr.n}|${rr.mx}|${rr.suma}`, datos_al: rr.al,
    });
    await c.query(`SELECT pg_notify('${CANAL}', $1)`, [payload]);
  }
  return { filas: rr.n, nuevos, actualizados, device };
}

(async () => {
  if (!APPLY) { console.log('dry-run: no se escribe nada. Agregá --apply.'); return; }
  const hb = require(path.join(__dirname, '..', 'lib', 'cron-heartbeat'));
  await hb.begin(KEY, 'CAOS — movimientos de caja fuerte').catch(() => {});
  const c = conexion();
  try {
    await c.connect();
    const r = await ciclo(c);
    if (r.nota) {
      console.log(r.nota);
      await hb.end(KEY, { status: 'ok', rows: 0, note: r.nota }).catch(() => {});
      return;
    }
    console.log(`CAOS: ${r.filas} filas totales · ${r.nuevos} nuevos · ${r.actualizados} actualizados (${r.device})`);
    await hb.end(KEY, { status: 'ok', rows: r.nuevos + r.actualizados }).catch(() => {});
  } catch (e) {
    console.error('falló:', e.message);
    await hb.end(KEY, { status: 'error', error: e.message }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await c.end().catch(() => {});
  }
})();
