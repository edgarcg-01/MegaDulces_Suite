/* eslint-disable no-console */
/**
 * Proyecto Tienda (TDA.1) — POLLER de tickets en vivo. Proceso ON-PREM de larga
 * duración: cada ~25s lee de las 6 sucursales los tickets de VENTA (c4=10) de una
 * ventana deslizante (últimos ~5 min) con su canasta (kdm2), y los EMPUJA al API de
 * prod (`POST /store/live/ingest`, header x-store-ingest-key). El ingest es
 * idempotente (upsert), así que el solape de ventana no duplica; solo los nuevos se
 * emiten por WebSocket (/store). Único punto de polling del pipeline (runner→Kepler).
 *
 * Env:
 *   STORE_INGEST_URL   = https://<api-prod>/api/store/live/ingest
 *   STORE_INGEST_KEY   = <clave compartida> (match STORE_INGEST_KEY del API)
 *   POLL_SECONDS       = 25 (opcional)  ·  WINDOW_MINUTES = 5 (opcional)
 *   SALES_BRANCH_MAP   = JSON opcional para override de sucursales
 *
 *   node database/importers/kepler/live-tickets-poller.js
 */
const { Client } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });

const INGEST_URL = process.env.STORE_INGEST_URL || 'http://localhost:3000/api/store/live/ingest';
const INGEST_KEY = process.env.STORE_INGEST_KEY || 'dev_store_ingest_key';
const POLL_MS = (Number(process.env.POLL_SECONDS) || 25) * 1000;
const WINDOW_MIN = Number(process.env.WINDOW_MINUTES) || 5;
// --dry: lee y arma tickets pero NO empuja al API; corre 1 ciclo y sale (verificación).
const DRY = process.argv.includes('--dry');

// Fuente única del mapa de sucursales (paso 3 normalización almacén). Incluye CEDIS '00' y
// Canindo '06' (este último leído del replica lógico local kepler_md_06 vía clientConfig).
const { salesMap, clientConfig, replicaConfig } = require('../lib/kepler-branches');
const BRANCHES = process.env.SALES_BRANCH_MAP ? JSON.parse(process.env.SALES_BRANCH_MAP) : salesMap();

// ── LATIDO (VL.4b) ───────────────────────────────────────────────────────────────────────────
// Este carril era MUDO: no escribía `analytics.cron_runs`, así que db-health no tenía nada que
// vigilar y su única señal era el mtime de un .log — que sigue moviéndose aunque no llegue un solo
// ticket. El 2026-09-11 costó 137 min: tras mudar la fuente a `md` (VL.2b) y dejar las suscripciones
// viejas en DISABLE (VL.2c), las réplicas de `.249` quedaron CONGELADAS; el poller siguió
// conectando, consultando y escribiendo "N tickets vistos · 0 nuevos" sin un error, y /tienda/live
// mostró "hace 137 min" en Canindo y Morelia Madero hasta que lo vio un humano.
//
// ⚠️ VARIABLE PROPIA, igual que en replicate-ods-live.js (GOTCHAS §17/§18): el latido tiene que
// viajar a PROD y por un canal DISTINTO del que vigila. El canal de este carril es HTTP al API;
// el latido va por Postgres. Si fuera por el mismo camino, un API caído se llevaría las dos cosas.
const HB_URL = process.env.STORE_HB_URL || process.env.FLEET_DB_URL || null;

/**
 * ⛔ CERRAR UNA CONEXIÓN TAMBIÉN PUEDE COLGARSE, y este archivo ya tenía la lección a medias.
 *
 * `client.end()` de node-postgres NO tiene timeout: manda el mensaje 'X' y espera a que el peer
 * cierre. Si el peer se fue sin completar el handshake (un firewall/NAT en el camino que se comió
 * la conexión, cosa habitual con 8 sucursales detrás de VPN), el socket queda en FIN_WAIT1 y el
 * `await` no vuelve NUNCA.
 *
 * Medido el 2026-09-11, 20 min después de mudar el carril a `md`: un solo socket abierto,
 * `172.18.0.9:51818 → 192.168.44.44:5432 FIN_WAIT1` con 6 bytes en Send-Q. El ciclo quedó trabado
 * ahí, las sucursales 05/06/07 no se leyeron, el guard `running` bloqueó todos los ticks
 * siguientes, y el contenedor siguió reportando `healthy` con el proceso vivo y el log mudo — 6
 * minutos. El archivo ya se protegía de esto para `fetch` (`AbortSignal.timeout`, tras el incidente
 * del 2026-08-04) pero no para el cierre de la conexión.
 *
 * Acá se acota: si el cierre limpio no vuelve en 5 s, se mata el socket a mano. Perder un cierre
 * ordenado no cuesta nada; colgar el carril cuesta todo.
 */
async function cerrar(c) {
  let t;
  try {
    await Promise.race([
      c.end(),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error('end() no volvió en 5s')), 5000); }),
    ]);
  } catch {
    try { c.connection?.stream?.destroy(); } catch { /* ya no hay socket */ }
  } finally { clearTimeout(t); }
}
const HB_KEY = 'store_poller';
const HB_LABEL = 'Poller de tickets en vivo (Kepler → /tienda/live)';
const HB_CONN = { ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000, statement_timeout: 30000, query_timeout: 30000 };
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
// Cada cuánto se le pregunta a las réplicas si siguen recibiendo. No en cada ciclo (son 25 s):
// una suscripción no se cae y se levanta en segundos, y son conexiones extra a la fuente.
const CHECK_MS = Number(process.env.STORE_REPLICA_CHECK_SEC || 240) * 1000;
// Minutos sin recibir WAL antes de declarar congelada una réplica. Holgado a propósito: una rama
// puede pasar minutos sin vender (de noche, o simplemente sin clientes) y eso NO mueve el WAL.
const REPLICA_MAX_MIN = Number(process.env.STORE_REPLICA_MAX_MIN || 15);

/** Latido DIRECTO a prod. Nunca tira: un latido que rompe el carril es peor que no tenerlo. */
async function latir(fase, { status, rows, note, error, ms } = {}) {
  if (!HB_URL) return;
  const c = new Client({ connectionString: HB_URL, ...HB_CONN });
  try {
    await c.connect();
    if (fase === 'begin') {
      await c.query(
        `UPDATE analytics.cron_runs SET status='error', last_finish=now(),
                error=COALESCE(error,'la corrida anterior no reportó cierre (proceso caído)')
          WHERE tenant_id=$1 AND job_key=$2 AND status='running'`, [TENANT, HB_KEY]);
      await c.query(`
        INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, status, host, updated_at)
        VALUES ($1,$2,$3, now(), 'running', $4, now())
        ON CONFLICT (tenant_id, job_key) DO UPDATE SET
          label=EXCLUDED.label, last_start=now(), status='running', host=EXCLUDED.host, updated_at=now()`,
      [TENANT, HB_KEY, HB_LABEL, require('os').hostname()]);
    } else {
      await c.query(`
        UPDATE analytics.cron_runs
           SET last_finish=now(), status=$3, rows_affected=$4, duration_ms=$5,
               note=left($6,500), error=left($7,500), updated_at=now()
         WHERE tenant_id=$1 AND job_key=$2`,
      [TENANT, HB_KEY, status || 'ok', rows ?? null, ms ?? null, note || null, error || null]);
    }
  } catch (e) { console.log(`⚠️  latido (${fase}) falló: ${e.message.split('\n')[0].slice(0, 80)}`); }
  finally { await cerrar(c); }
}

/**
 * ⭐ El detector que faltaba. Las ramas `replica` (06 Canindo, 07 Morelia Madero) no se leen de su
 * POS sino de una réplica lógica — y el poller se conecta a ESE MISMO cluster, así que puede
 * preguntarle a la suscripción si sigue recibiendo. Es una medida DIRECTA, no una heurística:
 *   · `subenabled=false`  → alguien la deshabilitó (exactamente lo que hizo VL.2c en `.249`);
 *   · `latest_end_time` viejo → el publicador dejó de mandar.
 * Ninguna de las dos depende del horario de la tienda, que es lo que hace inservible el criterio
 * obvio ("hace mucho que no llega un ticket"): a las 21:00 una sucursal cerrada lo dispararía todas
 * las noches, y una alarma que grita en falso enseña a ignorar el tablero.
 * Devuelve [] si todo bien, o la lista de motivos.
 */
async function revisarReplicas() {
  const malas = [];
  for (const b of BRANCHES.filter((x) => x.replica)) {
    // ⚠️ replicaConfig, NO clientConfig: este chequeo interroga a la RÉPLICA (su suscripción), y
    // desde 2026-09-12 la 06/07 tienen host → clientConfig/urlOf devuelven el POS, que es publicador
    // y no tiene suscripción (daba un falso "la réplica no tiene suscripción"). El detector apunta a
    // la réplica pase lo que pase con la ruta de lectura de datos.
    const c = new Client(replicaConfig(b, { connectionTimeoutMillis: 6000, statement_timeout: 15000 }));
    try {
      await c.connect();
      const { rows } = await c.query(`
        SELECT s.subname, s.subenabled,
               EXTRACT(epoch FROM (now() - st.latest_end_time))/60.0 AS min
          FROM pg_subscription s
          LEFT JOIN pg_stat_subscription st ON st.subid = s.oid
         WHERE s.subdbid = (SELECT oid FROM pg_database WHERE datname = current_database())`);
      if (!rows.length) { malas.push(`${b.code}: la réplica ${b.replica} no tiene suscripción`); continue; }
      for (const r of rows) {
        if (!r.subenabled) malas.push(`${b.code}: ${r.subname} DESHABILITADA (réplica congelada)`);
        else if (r.min === null) malas.push(`${b.code}: ${r.subname} sin worker activo`);
        else if (Number(r.min) > REPLICA_MAX_MIN) malas.push(`${b.code}: ${r.subname} sin recibir hace ${Number(r.min).toFixed(0)} min`);
      }
    } catch (e) { malas.push(`${b.code}: no se pudo revisar la réplica (${e.message.split('\n')[0].slice(0, 60)})`); }
    finally { await cerrar(c); }
  }
  return malas;
}

const pad = (n) => String(n).padStart(2, '0');
// "YYYY-MM-DD HH:MM" en hora local MX (offset fijo -06, Centro sin DST).
function sinceLocalMX(minutesAgo) {
  const nowMx = new Date(Date.now() - 6 * 3600 * 1000 - minutesAgo * 60 * 1000);
  return `${nowMx.getUTCFullYear()}-${pad(nowMx.getUTCMonth() + 1)}-${pad(nowMx.getUTCDate())} ${pad(nowMx.getUTCHours())}:${pad(nowMx.getUTCMinutes())}`;
}
// Inicio del día de HOY en hora local MX ("YYYY-MM-DD 00:00") — para el backfill.
function startOfTodayMX() {
  const nowMx = new Date(Date.now() - 6 * 3600 * 1000);
  return `${nowMx.getUTCFullYear()}-${pad(nowMx.getUTCMonth() + 1)}-${pad(nowMx.getUTCDate())} 00:00`;
}

async function pollBranch(b, since) {
  // clientConfig resuelve la conexión por rama: 01-05 su POS remoto (platform_ro), 06 Canindo
  // su replica lógica local (kepler_md_06). Schema md.* idéntico → mismo query.
  const c = new Client(clientConfig(b, { connectionTimeoutMillis: 6000, statement_timeout: 30000 }));
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT h.c6 folio, rtrim(btrim(h.c63),'-') serie, h.c9::date fecha, h.c62 hora, h.c5 caja,
              coalesce(h.c16,0) total, h.c10 forma_pago, btrim(h.c67) cajero,
              d.c8 sku, d.c10 nombre, coalesce(d.c9,0) cant, coalesce(d.c13,0) importe, d.c7 linea
         FROM md.kdm1 h
         JOIN md.kdm2 d ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
        WHERE h.c2='U' AND h.c3='D' AND h.c4=10
          AND h.c62 ~ '^[0-9]{1,2}:[0-9]{2}'
          AND (h.c9::date + h.c62::time) >= $1::timestamp
          AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> ''
        ORDER BY h.c9, h.c62, h.c6, d.c7`, [since]);

    const byTicket = new Map();
    for (const r of rows) {
      const key = `${r.serie}|${r.folio}`;
      let t = byTicket.get(key);
      if (!t) {
        const fecha = r.fecha.toISOString().slice(0, 10);
        t = {
          warehouse_code: b.code, warehouse_name: b.name, serie: r.serie, folio: r.folio,
          ticket_ts: `${fecha}T${r.hora.length === 4 ? '0' + r.hora : r.hora}:00-06:00`,
          total: Number(r.total) || 0, forma_pago: r.forma_pago, cajero: r.cajero || null,
          caja: r.caja != null ? String(r.caja).trim() : null, items: [],
        };
        byTicket.set(key, t);
      }
      t.items.push({ sku: r.sku, nombre: r.nombre, cant: Number(r.cant) || 0, importe: Number(r.importe) || 0 });
    }
    return [...byTicket.values()];
  } finally { await cerrar(c); }
}

const CHUNK = 300; // tickets por POST (evita exceder el límite de 2mb del body)
async function push(tickets, emit = true) {
  if (!tickets.length) return { inserted: 0 };
  if (DRY) {
    console.log(`   [dry] ${tickets.length} tickets (emit=${emit}) · muestra:`, JSON.stringify(tickets[0], null, 0).slice(0, 300));
    return { inserted: 0 };
  }
  let inserted = 0;
  for (let i = 0; i < tickets.length; i += CHUNK) {
    const batch = tickets.slice(i, i + CHUNK);
    // TIMEOUT obligatorio: sin él, un 502/hang de Railway deja el fetch colgado para
    // siempre → el await nunca resuelve → el guard `running` queda atascado en true →
    // el poller se congela mudo (proceso vivo pero sin tickear). Visto 2026-08-04.
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-store-ingest-key': INGEST_KEY },
      body: JSON.stringify({ tickets: batch, emit }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`ingest ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const r = await res.json();
    inserted += r.inserted || 0;
  }
  return { inserted };
}

let running = false;
let first = true; // primer ciclo = backfill del día completo (silencioso, sin WS)
let ultimoCheck = 0;       // cuándo se revisaron las réplicas por última vez
let replicasMalas = [];    // último veredicto conocido (persiste entre ciclos, ver abajo)
async function tick() {
  if (running) return; // evita solape si un ciclo tarda más que el intervalo
  running = true;
  // finally OBLIGATORIO: garantiza que `running` se libere pase lo que pase (throw o
  // no). Sin esto, un error fuera del try por-rama dejaba el guard atascado en true y
  // el poller se congelaba. Combinado con el timeout de fetch, ya no puede colgarse.
  const t0 = Date.now();
  await latir('begin');
  try {
    const backfill = first;
    const since = backfill ? startOfTodayMX() : sinceLocalMX(WINDOW_MIN);
    let total = 0, ins = 0;
    // ⛔ Los fallos por rama ya NO son mudos. Antes se imprimían y se seguía: un ciclo en el que las
    // 8 ramas fallaran terminaba idéntico a uno perfecto (y además `b.db` es undefined en las ramas
    // de réplica, así que el aviso decía "undefined:"). Mismo defecto que OBS.1 arregló en cycleAll.
    const fallas = [];
    for (const b of BRANCHES) {
      try {
        const tickets = await pollBranch(b, since);
        // backfill: emit=false (el navegador lo trae vía snapshot, sin inundar el WS).
        if (tickets.length) { const r = await push(tickets, !backfill); total += tickets.length; ins += (r.inserted || 0); }
      } catch (e) {
        const msg = `${b.code} ${b.name}: ${e.message.split('\n')[0].slice(0, 70)}`;
        fallas.push(msg); console.log(`⚠️  ${msg}`);
      }
    }
    if (total || backfill) {
      const tag = backfill ? `BACKFILL día≥${since}` : `ventana≥${since}`;
      console.log(`[${new Date().toISOString()}] ${tag} · ${total} tickets vistos · ${ins} nuevos${backfill ? ' (buffer)' : ' → WS'}`);
    }
    first = false;

    // Revisión de réplicas, espaciada. Su veredicto SOBREVIVE entre ciclos (`replicasMalas`): si no
    // se revisó en este ciclo, se reporta el último veredicto conocido — no "ok por no haber mirado".
    if (Date.now() - ultimoCheck > CHECK_MS) {
      replicasMalas = await revisarReplicas();
      ultimoCheck = Date.now();
      if (replicasMalas.length) console.log(`⚠️  réplica(s) en problemas: ${replicasMalas.join(' · ')}`);
    }

    const problemas = [...fallas, ...replicasMalas];
    await latir('end', {
      status: problemas.length ? 'error' : 'ok',
      rows: ins,
      ms: Date.now() - t0,
      note: `${BRANCHES.length - fallas.length}/${BRANCHES.length} ramas · ${total} vistos · ${ins} entregados`,
      error: problemas.length ? problemas.join(' · ') : null,
    });
  } catch (e) {
    await latir('end', { status: 'error', ms: Date.now() - t0, error: e.message.split('\n')[0] });
    throw e;
  } finally {
    running = false;
  }
}

// No dejar que un rechazo/excepción no manejada tumbe o mudee el loop en silencio.
process.on('unhandledRejection', (e) => console.log(`⚠️  unhandledRejection: ${(e && e.message) || e}`));
process.on('uncaughtException', (e) => console.log(`⚠️  uncaughtException: ${(e && e.message) || e}`));

console.log(`Tienda live poller — ${DRY ? 'DRY-RUN (1 ciclo, sin push)' : `cada ${POLL_MS / 1000}s, ventana ${WINDOW_MIN}min → ${INGEST_URL}`}`);
// Preflight del latido. En modo continuo se ABORTA antes que correr a ciegas: sin destino de latido
// este carril vuelve a ser mudo, que es exactamente cómo se perdieron 137 min el 2026-09-11. En
// --dry sólo se avisa (es una verificación a mano, no tiene por qué latir).
if (!DRY) {
  if (!HB_URL) {
    console.error('✖ falta STORE_HB_URL (destino del latido, = prod): sin ella db-health no puede vigilar este carril. Abortando.');
    process.exit(1);
  }
  console.log(`   latido → ${HB_KEY} · réplicas revisadas cada ${CHECK_MS / 1000}s (tope ${REPLICA_MAX_MIN} min sin recibir)`);
}
if (DRY) {
  tick().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  tick();
  setInterval(tick, POLL_MS);
}
