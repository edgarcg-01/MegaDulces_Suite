/* eslint-disable no-console */
'use strict';
/**
 * Relleno de una VENTANA DE FECHAS de una tabla del ODS — `replica md.* → kepler_ods.*`.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * `replicate-ods-live.js` tiene DOS formas de traer una tabla y ninguna sabe de fechas:
 *   · carril `ctid`  → `ctid > watermark`. Con el watermark en `(0,0)` (tabla nueva en el carril)
 *     arrastra la tabla ENTERA. Medido el 2026-09-21 en `kdpv_bitacora_precios`: **8.2M filas**
 *     leídas para dejar **163k** útiles, porque el ODS ya tenía el resto.
 *   · carril `hash`  → re-lee todo y compara md5. Peor todavía para una tabla grande append-only.
 *
 * Y sembrar el watermark a mano tampoco alcanza: el `ctid` NO está ordenado por fecha en un
 * SUBSCRIBER de replicación lógica (el heap reusa espacio). Medido: para traer los últimos 3 días
 * habría que arrancar en un `ctid` que arrastra **1.45M** filas — 8.9× el objetivo.
 *
 * Ésta es la pieza que faltaba: **traé desde tal fecha, y nada más**. Se usa a mano, una vez, para
 * el arranque de una tabla en el ODS; el régimen lo sigue llevando el carril vivo.
 *
 * ── Cómo se combina con el carril ───────────────────────────────────────────────────────────
 *   1. `replicate-ods-live.js --prime --tables=X`  → watermark al MÁXIMO, no manda una fila.
 *   2. este script `--tabla=X --col=c1 --dias=N --apply` → manda sólo la ventana.
 *   3. el carril vivo sigue con lo NUEVO (`ctid > watermark`), que es lo barato.
 * Invertir 1 y 2 no rompe nada, pero desperdicia: el paso 3 arrastraría la historia igual.
 *
 * ⚠️ NO deja red de seguridad. El `ctid` no monótono puede saltar filas, y una tabla que no está
 * en `RECENT_COL` de `ods-recent-window.js` tampoco la recupera nadie. Volver a correr este script
 * con `--dias=3` repone la ventana (el destino es UPSERT idempotente) — hasta que se decida si la
 * tabla merece carril propio.
 *
 * ⛔ Si la columna de fecha no existe o no es fecha, ABORTA. El helper de la red de seguridad
 * degrada a `null` en silencio a propósito (allá la ventana es un extra); acá la ventana ES el
 * trabajo, y un no-op silencioso se lee igual que "no había filas".
 *
 * Uso:
 *   node database/scripts/ods-backfill-ventana.js --tabla=kdpv_bitacora_precios --col=c1 --dias=3
 *   …mismo + --apply             # manda de verdad
 *   …mismo + --branch=08         # una sola rama
 *   …mismo + --desde=2026-09-01  # corte explícito en vez de --dias
 */
const { Client } = require('pg');
const sink = require('../importers/lib/sink');
const { replicaDbName, BRANCHES: CATALOGO } = require('../importers/lib/kepler-branches');

const arg = (n) => (process.argv.find((a) => a.startsWith('--' + n + '=')) || '').split('=')[1] || null;
const APPLY = process.argv.includes('--apply');
const TABLA = arg('tabla');
const COL = arg('col') || 'c1';
const DESDE = arg('desde');
const DIAS = Number(arg('dias') || 3);
const ONLY_BRANCH = arg('branch');
const LOTE = Math.max(500, Number(arg('lote') || 5000));
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

const IDENT = /^[a-z_][a-z0-9_]*$/i;
if (!TABLA || !IDENT.test(TABLA)) { console.error('x falta --tabla=<nombre> (identificador simple)'); process.exit(2); }
if (!IDENT.test(COL)) { console.error('x --col no es un identificador simple: ' + COL); process.exit(2); }
if (DESDE && !/^\d{4}-\d{2}-\d{2}$/.test(DESDE)) { console.error('x --desde debe ser YYYY-MM-DD'); process.exit(2); }
if (!DESDE && (!Number.isFinite(DIAS) || DIAS < 0)) { console.error('x --dias debe ser un entero >= 0'); process.exit(2); }

const BASE = process.env.ODS_SOURCE_BASE || process.env.DATABASE_URL_NEW;
if (!BASE) { console.error('x falta ODS_SOURCE_BASE (base del contenedor de replicas)'); process.exit(2); }

// `[ODS.1]` La lista sale del catálogo canónico — ver la nota en `replicate-ods-live.js`.
const CODES = (ONLY_BRANCH
  ? [ONLY_BRANCH]
  : (process.env.ODS_LIVE_BRANCHES || CATALOGO.map((b) => b.code).join(',')).split(','))
  .map((s) => s.trim()).filter(Boolean);
const CONN = { ssl: false, connectionTimeoutMillis: 15000, statement_timeout: 600000, query_timeout: 600000, keepAlive: true };
const qid = (id) => '"' + String(id).replace(/"/g, '""') + '"';

// Copia del mapa de tipos de `replicate-ods-live.js` (mapType). NO se extrajo a un módulo
// compartido a propósito: eso obliga a tocar el archivo del carril que hoy alimenta prod, y esto
// es una herramienta de una corrida. Queda declarado como duplicación a resolver si el script se
// queda para siempre.
const TIPOS = {
  numeric: 'numeric', 'double precision': 'double precision', real: 'real', integer: 'integer',
  bigint: 'bigint', smallint: 'smallint', boolean: 'boolean', date: 'date',
  'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
};
const mapType = (dt) => TIPOS[dt] || 'text';

(async () => {
  const corte = DESDE ? "date '" + DESDE + "'" : 'current_date - ' + Math.trunc(DIAS);
  const rotulo = DESDE || 'hoy-' + Math.trunc(DIAS) + 'd';
  console.log('\n=== relleno de ventana — ' + TABLA + ' donde ' + COL + ' >= ' + rotulo
    + ' (' + (APPLY ? 'APPLY' : 'DRY-RUN') + ') ===');
  console.log('  sink: ' + sink.sinkMode() + '  ·  ramas: ' + CODES.join(',') + '  ·  lote: ' + LOTE);

  // ⛔ [NORM.3b] ESTA HERRAMIENTA ESTUVO ROTA DESDE [VL.11] Y NADIE SE ENTERÓ.
  // Se escribió cuando el ship iba por HTTP, así que pasaba `client: null` y alcanzaba. [VL.11]
  // cambió el sink a `pg` (escritura directa a pg-prod) y el sink `pg` EXIGE un Client conectado:
  // desde entonces cada corrida moría con 'raw-upsert requiere un Client de pg conectado' — o sea
  // que la única pieza capaz de reponer una ventana de fechas no reponía nada.
  // Mismo modo de falla que [DB-MEM.19] (el latido atado al sink): cambia CÓMO se embarcan las
  // filas y se apaga en silencio algo que no menciona el sink por ningún lado. Descubierto el
  // 2026-09-24 al intentar reponer 10,589 filas de kdpv_bitacora_precios.
  let DEST = null;
  if (sink.sinkMode() === 'pg') {
    const destStr = process.env.KP_DEST_URL || process.env.DATABASE_URL_NEW || BASE;
    DEST = new Client({ connectionString: destStr, ssl: false, ...CONN });
    await DEST.connect();
    console.log('  destino pg: ' + new URL(destStr).host + new URL(destStr).pathname);
  }

  const resumen = [];
  for (const code of CODES) {
    const u = new URL(BASE); u.pathname = '/' + replicaDbName(code);
    const p = new Client({ connectionString: u.toString(), ...CONN });
    try { await p.connect(); } catch (e) {
      console.log('  ! rama ' + code + ': no conecta — ' + e.message.slice(0, 60));
      resumen.push({ rama: code, error: 'no conecta' }); continue;
    }
    try {
      const cols = (await p.query(
        "SELECT column_name, data_type FROM information_schema.columns"
        + " WHERE table_schema='md' AND table_name=$1 ORDER BY ordinal_position", [TABLA])).rows;
      if (!cols.length) {
        console.log('  ! rama ' + code + ': sin tabla md.' + TABLA + ' — skip');
        resumen.push({ rama: code, error: 'sin tabla' }); continue;
      }

      // Fail-fast, no degradación: sin columna de fecha válida la ventana no existe, y un
      // resultado en cero se leería como "no hubo cambios".
      const tipo = (cols.find((c) => c.column_name === COL) || {}).data_type;
      if (!tipo) throw new Error('md.' + TABLA + ' no tiene la columna ' + COL);
      if (!/date|timestamp/.test(tipo)) throw new Error('md.' + TABLA + '.' + COL + ' es ' + tipo + ', no una fecha');

      const pk = (await p.query(
        "SELECT a.attname FROM pg_index i"
        + " JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)"
        + " WHERE i.indrelid=('md.'||$1)::regclass AND i.indisprimary"
        + " ORDER BY array_position(i.indkey, a.attnum)", [TABLA])).rows.map((r) => r.attname);
      if (!pk.length) throw new Error('md.' + TABLA + ' no tiene PK — el UPSERT del destino la necesita');

      const where = qid(COL) + ' >= ' + corte;
      const total = Number((await p.query(
        'SELECT count(*)::bigint n FROM md.' + qid(TABLA) + ' WHERE ' + where)).rows[0].n);

      if (!APPLY) {
        console.log('  · ' + code + ': ' + total + ' filas en la ventana');
        resumen.push({ rama: code, ventana: total }); continue;
      }
      if (!total) {
        console.log('  · ' + code + ': 0 filas en la ventana');
        resumen.push({ rama: code, ventana: 0, escritas: 0 }); continue;
      }

      const selList = cols.map((c) => qid(c.column_name)).join(', ');
      const meta = {
        table: TABLA,
        pk,
        columns: [{ name: 'sucursal', type: 'text' }, ...cols.map((c) => ({ name: c.column_name, type: mapType(c.data_type) }))],
      };

      let leidas = 0, escritas = 0, off = 0;
      for (;;) {
        // Orden estable por PK: sin desempate, dos páginas del mismo OFFSET pueden repetir o
        // SALTAR filas. El UPSERT perdona el repetido; el salto sería pérdida silenciosa.
        const rows = (await p.query(
          'SELECT ' + selList + ' FROM md.' + qid(TABLA) + ' WHERE ' + where
          + ' ORDER BY ' + pk.map(qid).join(', ') + ' OFFSET ' + off + ' LIMIT ' + LOTE)).rows;
        if (!rows.length) break;
        off += rows.length; leidas += rows.length;
        const buf = rows.map((row) => {
          const o = { sucursal: code };
          for (const c of cols) o[c.column_name] = row[c.column_name];
          return o;
        });
        const r = await sink.ship('raw-upsert', { rows: buf, tenantId: TENANT, meta, client: DEST });
        escritas += Number(r.rowCount || 0);
        process.stdout.write('\r  · ' + code + ': ' + leidas + '/' + total + ' leídas · ' + escritas + ' escritas   ');
      }
      console.log('\n  ok ' + code + ': ' + leidas + ' leídas · ' + escritas + ' escritas');
      resumen.push({ rama: code, ventana: total, leidas, escritas });
    } catch (e) {
      console.log('\n  x rama ' + code + ': ' + e.message.slice(0, 120));
      resumen.push({ rama: code, error: e.message.slice(0, 60) });
    } finally { await p.end().catch(() => {}); }
  }

  console.log('\n=== Resumen ===');
  if (DEST) await DEST.end().catch(() => {});
  console.table(resumen);
  if (!APPLY) console.log('DRY-RUN — nada cambió. Corré con --apply.');
  const fallas = resumen.filter((r) => r.error);
  if (fallas.length) {
    console.error('x ' + fallas.length + ' rama(s) con error — la ventana NO está completa.');
    process.exit(1);
  }
})().catch((e) => { console.error('x ' + e.message); process.exit(1); });
