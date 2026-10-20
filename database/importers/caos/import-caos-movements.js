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
const ETIQUETA = 'CAOS — movimientos de caja fuerte';
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

/**
 * `[CG.80]` **EL ADAPTER VIVE FUERA DEL CICLO**, y es lo que hace posible el pedido de ≤1 s.
 *
 * Estaba adentro, o sea que cada pasada abría sesión de cero. Medido contra el aparato real
 * (dentro del pod, 2026-10-10):
 *
 *     ensureSession (leer pubKey + RSA + POST /adminlogin) .... 759 ms   ← 88 % de la pasada
 *     getTransactions con la sesión YA abierta ................ 11–48 ms
 *
 * O sea que los 865 ms que cuesta hoy una pasada **son el login**, y se pagan cada 2 minutos
 * porque `crond` levanta un proceso nuevo cada vez. Con la sesión viva, sondear cada segundo
 * cuesta ~4,100 s/día — por debajo de los 7,487 s/día que `[CPU.3]` retiró por caros.
 *
 * ⚠️ El adapter RELOGUEA solo cuando la sesión expira (ve el HTML del login o un no-2xx), así que
 * mantenerlo vivo no lo vuelve frágil: lo vuelve barato. Es el mismo patrón del adapter de flota.
 */
let ADAPTER = null;
const adapterVivo = () => (ADAPTER || (ADAPTER = new CaosAdapter()));

/**
 * ⭐ `[CGA-A.14]` **Qué latido le corresponde a un ciclo que no movió filas.** Está afuera, en
 * una función pura, para poder PROBARLA: la regla que importa acá —«no poder correr late en
 * ERROR, no en verde»— vivía incrustada en un ternario dentro de un `catch`, donde nadie la
 * podía ejercer sin credenciales, sin red y sin escribir en prod.
 *
 *   node database/importers/caos/import-caos-movements.js --probar-latido
 */
function latidoDe(r) {
  return r.fatal
    ? { status: 'error', rows: 0, error: r.nota }
    : { status: 'ok', rows: 0, note: r.nota };
}

// ── `[CGA-A.33]` La FOTO del contenido (reporte «Contenidos» del equipo) ───────────────────────

/**
 * Normaliza la respuesta de `getCounting` a renglones planos + un hash de su CONTENIDO.
 *
 * Pura a propósito, por la misma razón que `latidoDe`: es la pieza que decide qué se guarda como
 * «lo que la máquina dice tener», y tiene que poder ejercerse sin red ni base.
 *
 * ⚠️ El hash NO incluye `online`: que el equipo parpadee de conexión no es una foto distinta.
 * ⚠️ Acepta UNA sola máquina. Con dos no sabríamos a qué `device` de los movimientos atarla, y
 *    adivinarlo mezclaría dos cajas — se declara en vez de elegir (`maquinas` en la salida).
 */
function normalizarConteo(j) {
  const maquinas = Array.isArray(j && j.machineCashList) ? j.machineCashList : [];
  if (maquinas.length !== 1) return { maquinas: maquinas.length, lines: [] };
  const m = maquinas[0];
  const lines = [];
  const tomar = (kind, conts) => {
    for (const ct of conts || []) {
      for (const d of ct.content || []) {
        const denom = Number(d.denom);
        const quantity = Number(d.quantity);
        if (!Number.isFinite(denom) || denom <= 0 || !Number.isFinite(quantity) || quantity < 0) continue;
        lines.push({
          kind, index: Number(ct.index), currency: String(d.currency || 'MXN'),
          denom, pieza: String(d.type || 'B'), quantity, miscount: Boolean(ct.miscount),
        });
      }
    }
  };
  tomar('stock', m.stocksContent);
  tomar('bag', m.bagsContent);
  lines.sort((a, b) => a.kind.localeCompare(b.kind) || a.index - b.index || b.denom - a.denom);
  const total = Math.round(lines.reduce((s, l) => s + l.denom * l.quantity, 0) * 100) / 100;
  const hash = crypto.createHash('md5')
    .update(JSON.stringify(lines.map((l) => [l.kind, l.index, l.currency, l.denom, l.pieza, l.quantity, l.miscount])))
    .digest('hex');
  return {
    maquinas: 1, online: m.online == null ? null : Boolean(m.online),
    anyMiscount: lines.some((l) => l.miscount), total, lines, hash,
  };
}

if (process.argv.includes('--probar-conteo')) {
  // Fixture: la respuesta REAL del 2026-10-20 10:04:38 MX, recortada a lo que se lee.
  const casete = (index, denom, quantity, miscount = false) => ({
    index, miscount, content: [{ currency: 'MXN', denom, type: 'B', quantity }],
  });
  const real = { machineCashList: [{ online: true, bagsContent: [], stocksContent: [
    casete(1, 20, 121), casete(2, 50, 46), casete(3, 100, 252), casete(4, 200, 191),
    casete(5, 200, 192), casete(6, 500, 194), casete(7, 500, 139), casete(8, 500, 174),
  ] }] };
  const n = normalizarConteo(real);
  const desordenado = { machineCashList: [{ ...real.machineCashList[0], online: false,
    stocksContent: [...real.machineCashList[0].stocksContent].reverse() }] };
  const conMiscount = { machineCashList: [{ ...real.machineCashList[0],
    stocksContent: [casete(1, 20, 121, true), ...real.machineCashList[0].stocksContent.slice(1)] }] };
  const dos = { machineCashList: [real.machineCashList[0], real.machineCashList[0]] };
  const casos = [
    ['el total de la foto real es $360,020', n.total === 360020],
    ['8 renglones, sin bolsas', n.lines.length === 8 && n.lines.every((l) => l.kind === 'stock')],
    ['sin miscount en la foto real', n.anyMiscount === false],
    ['el orden y `online` NO cambian el hash', normalizarConteo(desordenado).hash === n.hash],
    // ⛔ Negativos: si el hash ignorara el miscount, o si dos máquinas se mezclaran, esto se pone rojo.
    ['un miscount SÍ cambia el hash y se marca', (() => { const x = normalizarConteo(conMiscount); return x.anyMiscount && x.hash !== n.hash; })()],
    ['dos máquinas NO se mezclan: se declaran', (() => { const x = normalizarConteo(dos); return x.maquinas === 2 && x.lines.length === 0; })()],
  ];
  let fallas = 0;
  console.log('\n[prueba] la foto del contenido de CAOS\n');
  for (const [que, ok] of casos) { if (!ok) fallas++; console.log(`  ${ok ? '✓' : '✗'} ${que}`); }
  console.log('');
  process.exit(fallas ? 1 : 0);
}

/**
 * Toma la foto y la guarda amarrada al último movimiento sincronizado.
 *
 * ⛔ **La foto sólo vale si se sabe qué movimientos contiene.** Se lee el watermark ANTES, se pide
 * el contenido, y se vuelve a preguntar al equipo por movimientos: si entró uno mientras tanto, la
 * foto puede contenerlo o no, y no hay forma de saberlo — **se descarta** y la toma el ciclo
 * siguiente. Guardarla igual fabricaría un descuadre (o lo escondería) en el cuadre continuo.
 */
async function capturarConteo(c) {
  const adapter = adapterVivo();
  if (!adapter.isConfigured()) return { nota: 'CAOS sin credenciales', fatal: true };

  const dev = await c.query(
    `SELECT device, max(external_id)::bigint AS wm FROM analytics.caos_cash_movements
      WHERE tenant_id = $1 GROUP BY device ORDER BY max(occurred_at) DESC`, [TENANT],
  );
  if (dev.rows.length !== 1) {
    return { nota: `conteo omitido: ${dev.rows.length} dispositivos en los movimientos — no se adivina a cuál pertenece la foto` };
  }
  const { device } = dev.rows[0];
  const wm = Number(dev.rows[0].wm);

  const j = await adapter.getCounting();
  const n = normalizarConteo(j);
  if (n.maquinas !== 1) return { nota: `conteo omitido: el equipo reporta ${n.maquinas} máquinas` };

  // ¿Entró un movimiento mientras se leía? Se pregunta al EQUIPO, no a la base: la base es la que
  // todavía no lo tendría.
  const hoy = new Date();
  const recientes = await adapter.getTransactions({ from: new Date(hoy.getTime() - 86400000), to: hoy });
  const maxEquipo = recientes.reduce((mx, t) => Math.max(mx, Number(t.id) || 0), 0);
  if (maxEquipo > wm) return { nota: `conteo descartado: el equipo ya tiene el movimiento #${maxEquipo} y la base llega a #${wm}` };

  await c.query('BEGIN');
  try {
    const ya = await c.query(
      `UPDATE analytics.caos_cash_counts SET confirmed_at = now(), online = $5, updated_at = now()
        WHERE tenant_id = $1 AND device = $2 AND after_external_id = $3 AND content_hash = $4
        RETURNING id`,
      [TENANT, device, wm, n.hash, n.online],
    );
    if (ya.rows.length) { await c.query('COMMIT'); return { nueva: false, total: n.total, wm }; }

    const ins = await c.query(
      `INSERT INTO analytics.caos_cash_counts
         (tenant_id, device, after_external_id, captured_at, confirmed_at, online, any_miscount,
          total, content_hash, raw)
       VALUES ($1,$2,$3, now(), now(), $4,$5,$6,$7,$8::jsonb) RETURNING id`,
      [TENANT, device, wm, n.online, n.anyMiscount, n.total, n.hash, JSON.stringify(j)],
    );
    const id = ins.rows[0].id;
    for (const l of n.lines) {
      await c.query(
        `INSERT INTO analytics.caos_cash_count_lines
           (tenant_id, count_id, container_kind, container_index, currency, denom, pieza_tipo, quantity, miscount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [TENANT, id, l.kind, l.index, l.currency, l.denom, l.pieza, l.quantity, l.miscount],
      );
    }
    await c.query('COMMIT');
    // La pantalla escucha el mismo canal: una foto nueva es una novedad que tiene que ver.
    await c.query(`SELECT pg_notify('${CANAL}', $1)`, [JSON.stringify({
      tenant_id: TENANT, device, firma: `conteo|${wm}|${n.hash}`,
    })]);
    return { nueva: true, total: n.total, wm };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}

if (process.argv.includes('--probar-latido')) {
  const casos = [
    ['sin credenciales (NO puede correr)', { fatal: true, nota: 'CAOS sin credenciales' }, 'error'],
    ['sin novedad (corrió y no hubo nada)', { nota: 'nada nuevo' }, 'ok'],
  ];
  let fallas = 0;
  console.log('\n[prueba] un carril que NO PUEDE correr late en error, no en verde\n');
  for (const [que, r, esperado] of casos) {
    const got = latidoDe(r).status;
    const bien = got === esperado;
    if (!bien) fallas++;
    console.log(`  ${bien ? '✓' : '✗'} ${que} → ${got} (esperado ${esperado})`);
  }
  // ⛔ El defecto, explícito: si alguien quita el `fatal`, esto tiene que ponerse rojo.
  if (latidoDe({ nota: 'CAOS sin credenciales' }).status !== 'ok') fallas++;
  console.log('');
  process.exit(fallas ? 1 : 0);
}

async function ciclo(c) {
  const adapter = adapterVivo();
  if (!adapter.isConfigured()) {
    /**
     * ⛔⛔ `[CGA-A.14]` **ESTO LATÍA EN VERDE, y por eso nadie vio 24 horas sin CAOS.**
     *
     * Hasta el 2026-10-16 este caso devolvía sólo `nota` y el lazo escribía
     * `status: 'ok', rows: 0`. O sea que un carril que **no puede correr** —el pod arrancó sin
     * `CAOS_USER`/`CAOS_PASS` porque el secreto `ingest-env` no las tenía— se publicaba como
     * sano, con cero filas. Y «cero filas porque no hay credenciales» se ve **exactamente
     * igual** que «cero filas porque hoy no hubo movimientos».
     *
     * ⭐ Es la violación directa de ADR-056: **lo que no se pudo medir se DECLARA, nunca se
     * dibuja como verde.** Un latido verde no es una cortesía: es lo que mira el vigilante
     * para decidir que no hay nada que arreglar.
     *
     * `fatal` lo marca para que el lazo escriba `status: 'error'` —el único de los tres
     * estados que dice la verdad acá— y lo haga **sin acotar por tiempo**: una falla de
     * configuración es el hecho que hay que ver, no ruido a espaciar.
     */
    return {
      nota: 'CAOS sin credenciales (CAOS_USER/CAOS_PASS) — el feed NO puede correr en este entorno',
      fatal: true, filas: 0, nuevos: 0,
    };
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

/**
 * `[CG.80]` **MODO DEMONIO** — `--watch=<segundos>`, para el pedido de ≤1 s de la caja.
 *
 * Sin la bandera se comporta EXACTAMENTE como antes: una pasada y sale. Con ella, mantiene viva
 * la conexión a Postgres y la sesión del aparato, y repite el ciclo.
 *
 * ⛔ **Un error NO mata al demonio** (el aparato se reinicia, la sesión caduca, la red parpadea):
 * se reporta por latido y se sigue. Lo que SÍ sale con código 1 es no poder conectar a Postgres al
 * arrancar — ahí no hay nada que reintentar en caliente y el kubelet lo levanta de nuevo.
 *
 * ⚠️ **El latido se ACOTA, y no es un detalle de eficiencia.** A 1 s serían 86,400 escrituras por
 * día contra `analytics.cron_runs` **en prod** — el carril dejaría de ser gratis justo del lado
 * del destino, que es la pata que nadie estaba midiendo. Se escribe como mucho una vez cada
 * `CAOS_HB_SEG` (30 s por defecto), y SIEMPRE de inmediato cuando el ciclo trajo filas o falló:
 * acotar la frecuencia del latido no puede hacer que un hecho se pierda, sólo que un "no pasó
 * nada" se repita menos. El umbral de `db-health` está en horas, así que 30 s sobran.
 */
const WATCH_ARG = ARGS.find((a) => a === '--watch' || a.startsWith('--watch='));
// Piso de 1 s por la misma razón que en `replicate-ods-live.js`: por debajo, el latido y el
// `pg_notify` contra prod dejan de ser despreciables.
const WATCH_SEG = WATCH_ARG ? Math.max(1, Number(WATCH_ARG.split('=')[1] || 60)) : 0;
const HB_MIN_MS = Math.max(0, Number(process.env.CAOS_HB_SEG || 30)) * 1000;
const CONTEO_MIN_MS = Math.max(30, Number(process.env.CAOS_CONTEO_SEG || 300)) * 1000;
const KEY_CONTEO = 'caos_conteo';
const ETIQUETA_CONTEO = 'CAOS — foto del contenido (reporte Contenidos)';
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!APPLY && !WATCH_SEG) { console.log('dry-run: no se escribe nada. Agregá --apply.'); return; }
  const hb = require(path.join(__dirname, '..', 'lib', 'cron-heartbeat'));
  const c = conexion();
  try {
    await c.connect();
  } catch (e) {
    console.error('no conecta a Postgres:', e.message);
    process.exit(1);
  }

  let ultimoLatido = 0;

  /**
   * `[CGA-A.33]` La foto del contenido, con SU latido (`caos_conteo`). Separado a propósito: si
   * el reporte «Contenidos» falla, el carril de movimientos sigue sano y lo tiene que decir — un
   * latido compartido tiñe de rojo lo que sí está funcionando.
   *
   * Ritmo: después de cada ciclo con movimientos nuevos (es cuando el contenido cambia) y, si no
   * pasó nada, cada `CAOS_CONTEO_SEG` (300 s) para CONFIRMAR que sigue igual. Una foto igual no se
   * reescribe: sólo mueve `confirmed_at`.
   */
  let ultimoConteo = 0;
  const conteo = async (hubo) => {
    if (!hubo && Date.now() - ultimoConteo < CONTEO_MIN_MS) return;
    ultimoConteo = Date.now();
    await hb.begin(KEY_CONTEO, ETIQUETA_CONTEO).catch((e) => console.warn(`[latido] begin ${KEY_CONTEO}: ${e.message}`));
    try {
      const r = await capturarConteo(c);
      if (r.nota) {
        console.log(r.nota);
        // «descartado porque entró un movimiento» es normal y se resuelve solo: late ok con nota.
        await hb.end(KEY_CONTEO, latidoDe(r)).catch((x) => console.warn(`[latido] end ${KEY_CONTEO}: ${x.message}`));
        return;
      }
      if (r.nueva) console.log(`CAOS conteo: foto nueva $${r.total} tras el movimiento #${r.wm}`);
      await hb.end(KEY_CONTEO, { status: 'ok', rows: r.nueva ? 1 : 0 }).catch((x) => console.warn(`[latido] end ${KEY_CONTEO}: ${x.message}`));
    } catch (e) {
      console.error('conteo falló:', e.message);
      await hb.end(KEY_CONTEO, { status: 'error', error: e.message }).catch((x) => console.warn(`[latido] end ${KEY_CONTEO}: ${x.message}`));
    }
  };

  /** Una pasada con su latido. Devuelve false sólo si hay que abortar el proceso entero. */
  const pasada = async () => {
    const debeLatir = (hubo) => hubo || Date.now() - ultimoLatido >= HB_MIN_MS;
    try {
      const r = await ciclo(c);
      const hubo = !r.nota && (r.nuevos + r.actualizados) > 0;
      if (r.nota) {
        console.log(r.nota);
        // `[CGA-A.14]` Un carril que NO PUEDE correr late en `error`, y late SIEMPRE: el
        // acotado por tiempo es para el ruido, no para una falla de configuración.
        if (r.fatal || debeLatir(false)) {
          ultimoLatido = Date.now();
          await hb.begin(KEY, ETIQUETA).catch((e) => console.warn(`[latido] begin ${KEY}: ${e.message}`));
          await hb.end(KEY, latidoDe(r)).catch((e) => console.warn(`[latido] end ${KEY}: ${e.message}`));
        }
        return true;
      }
      // En modo demonio sólo se imprime cuando hay novedad: a 1 s, un renglón por ciclo son
      // 86,400 líneas diarias de "0 nuevos" que entierran justo lo que hay que ver.
      if (hubo || !WATCH_SEG) {
        console.log(`CAOS: ${r.filas} filas totales · ${r.nuevos} nuevos · ${r.actualizados} actualizados (${r.device})`);
      }
      if (debeLatir(hubo)) {
        ultimoLatido = Date.now();
        await hb.begin(KEY, ETIQUETA).catch((e) => console.warn(`[latido] begin ${KEY}: ${e.message}`));
        await hb.end(KEY, { status: 'ok', rows: r.nuevos + r.actualizados }).catch((x) => console.warn(`[latido] end ${KEY}: ${x.message}`));
      }
      await conteo(hubo);
      return true;
    } catch (e) {
      console.error('falló:', e.message);
      // Una falla SIEMPRE late, sin importar el acotado: es el hecho que hay que ver.
      ultimoLatido = Date.now();
      await hb.begin(KEY, ETIQUETA).catch((e) => console.warn(`[latido] begin ${KEY}: ${e.message}`));
      await hb.end(KEY, { status: 'error', error: e.message }).catch((x) => console.warn(`[latido] end ${KEY}: ${x.message}`));
      if (!WATCH_SEG) { process.exitCode = 1; return false; }
      // En demonio: la sesión del aparato puede haber caducado de una forma que el adapter no
      // detectó. Se tira y el próximo ciclo abre una nueva — 759 ms una vez, no por ciclo.
      ADAPTER = null;
      return true;
    }
  };

  if (!WATCH_SEG) {
    await pasada();
    await c.end().catch(() => {});
    return;
  }

  console.log(`CAOS en modo demonio: ciclo cada ${WATCH_SEG}s · latido como mucho cada ${HB_MIN_MS / 1000}s`);
  for (;;) {
    if (!(await pasada())) break;
    await dormir(WATCH_SEG * 1000);
  }
})();
