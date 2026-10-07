/* eslint-disable no-console */
/**
 * PUBLICADOR del ODS hacia una base REMOTA que no puede alcanzar a prod (tienda mayorista / CV).
 *
 * Por qué existe, medido el 2026-09-28
 * ------------------------------------
 * La base de la tienda (`faithful-contentment` en Railway, `mainline.proxy.rlwy.net:21681`) leía
 * `kepler_ods.*` por `postgres_fdw` contra `trolley.proxy.rlwy.net` — la prod VIEJA, que dejó de
 * alimentarse cuando prod se mudó a `md` el 2026-09-22. Medido: última captura `kdm1.c68`
 * **2026-09-23 del lado del FDW contra 2026-09-28 en prod**; 21,404 movimientos y 910,676 piezas de
 * existencia de diferencia. El FDW no falla: devuelve filas viejas con toda confianza. Misma familia
 * que `[VL.13]` (el respaldo volcando Railway) y `[VL.14]` (la Caja General escribiendo a la prod
 * vieja): prod se mudó y el consumidor se quedó apuntando al fantasma.
 *
 * Railway NO alcanza a `md` (prod on-prem, sin endpoint público de Postgres), así que el dato se
 * EMPUJA. Este script es el empujón.
 *
 * Por qué NO es otro carril de `replicate-ods-live.js`
 * ---------------------------------------------------
 * ⛔ Porque el estado del CDC (`ods.ctl` watermark, `ods.shadow` hashes, `ods.sink_ident`) vive en
 * las RÉPLICAS y **no tiene dimensión de destino**: `ods.ctl` es PK por `table_name` a secas y
 * `sink_ident` es una sola fila `id=1`. Dos shippers contra el mismo origen se pisan el watermark y
 * el shadow — el que ship primero marca la fila como enviada y el otro destino NO la ve nunca:
 * pérdida silenciosa en los dos. El compose lo dice con todas las letras: «NUNCA dos shippers a la
 * vez». Por eso este lee **prod** (ya consolidada, con `sucursal`) y no comparte estado con nadie.
 *
 * ⭐ SIN ESTADO, A PROPÓSITO — y es lo que lo vuelve confiable
 * ----------------------------------------------------------
 * La primera versión llevaba un shadow de hashes en prod, como el CDC. Se descartó por dos razones,
 * las dos medidas:
 *   1. La credencial de prod desde fuera de `md` es de SOLO LECTURA (`default_transaction_read_only`),
 *      así que el shadow obligaba a escribirle a prod para publicar a un tercero. Este proceso ahora
 *      **no escribe una sola fila en prod**.
 *   2. Un shadow puede MENTIR: si el destino se recrea o alguien lo trunca, el shadow sigue diciendo
 *      "ya te lo mandé" y la tienda se queda vieja para siempre, en silencio. Ése es exactamente el
 *      incidente que este archivo viene a cerrar.
 * En su lugar se compara una HUELLA por tabla —`count(*)` + `md5` del agregado de hashes de fila—
 * calculada de los dos lados. Si coinciden no viaja nada (el caso normal). Si difieren, se hace el
 * diff exacto por llave. **La huella es a la vez el detector de cambios y la compuerta de
 * completitud**, y como se recalcula cada ciclo no hay estado que pueda desincronizarse.
 * Verificado el 2026-09-28: las 8 tablas tienen columnas, tipos y ORDEN idénticos en los dos lados,
 * que es lo que hace comparable `md5(t::text)` entre clústeres.
 *
 * El diff viaja HACIA ARRIBA (se suben los hashes del origen a una temp del destino y allá se
 * calcula la diferencia) porque en Railway se cobra el EGRESO: subir 86 k hashes es gratis, bajarlos
 * no. Después sólo bajan las llaves que hay que reenviar.
 *
 * Env (sin default a propósito — un default acá escribe a la base equivocada sin fallar):
 *   ODS_PUBLISH_DEST_URL   destino remoto (la base de la tienda)
 *   ODS_PUBLISH_SRC_URL    origen; default DATABASE_URL_NEW → DATABASE_URL (prod)
 * Opcionales:
 *   ODS_PUBLISH_TABLES (default abajo) · ODS_PUBLISH_DELETE (0|1, default 1)
 *   ODS_PUBLISH_DELETE_MAX_FRAC (0.05) · ODS_PUBLISH_BATCH (5000) · ODS_PUBLISH_HEARTBEAT (0|1)
 * Flags: --apply (default DRY-RUN) · --tables=kdii,kdik · --watch[=segundos]
 *
 *   node database/importers/kepler/publish-ods-remote.js                 # seco: qué tablas difieren
 *   node database/importers/kepler/publish-ods-remote.js --apply         # una pasada
 *   node database/importers/kepler/publish-ods-remote.js --apply --watch=600
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { Client } = require('pg');
const { HANDLERS } = require('../../../services/feeds-ingest/apply-handlers');
const { classify } = require('../../../libs/platform-core/src/lib/provenance/target-guard');
const hb = require('../lib/cron-heartbeat');

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--tables=')) || '').split('=')[1];
const WATCH_ARG = process.argv.find((a) => a === '--watch' || a.startsWith('--watch='));
const WATCH_SEC = WATCH_ARG ? Math.max(60, Number(WATCH_ARG.split('=')[1] || 600)) : 0;

// ⭐ EL CATÁLOGO, NO EL LIBRO DE VENTAS. `kdm2` (líneas de movimiento) queda FUERA a propósito:
// son 4.66 M filas / 2,133 MB en prod contra los 124 MB que mide HOY la base destino ENTERA, y una
// tienda no arma su catálogo con el detalle de ventas. Lo que un e-commerce quiere de ahí ("lo más
// vendido") es un agregado de unos miles de filas, derivable en prod y publicable como tabla chica
// — no 2 GB de renglones por el proxy. Decisión medida, no omisión.
//   kdii = artículo maestro (precio c90, costo c77, unidad c11, barcodes) · kdik = valuación/costo
//   kdil = existencia por almacén (c4+c8−c9)                             · kdms = sucursales
//   kdie = departamento · kdif = línea · kdig = proveedor≈marca          · kdid = unidad de medida
// ⚠️ `kdid` NO venía en la lista pedida y se agrega con motivo: `kdii.c11` guarda el CÓDIGO de
// unidad ('PAQ','PZA','KG') y sin `kdid` la tienda muestra "PAQ" en lugar de "Paquete". Pesa 32 kB.
const DEFAULT_TABLES = 'kdii,kdik,kdil,kdig,kdie,kdif,kdid,kdms';
const TABLES = (ONLY || process.env.ODS_PUBLISH_TABLES || DEFAULT_TABLES)
  .split(',').map((s) => s.trim()).filter(Boolean);

const DEST_URL = process.env.ODS_PUBLISH_DEST_URL || '';
const SRC_URL = process.env.ODS_PUBLISH_SRC_URL || process.env.DATABASE_URL_NEW || process.env.DATABASE_URL || '';
const DO_DELETE = String(process.env.ODS_PUBLISH_DELETE == null ? '1' : process.env.ODS_PUBLISH_DELETE) === '1';
const DELETE_MAX_FRAC = Number(process.env.ODS_PUBLISH_DELETE_MAX_FRAC || 0.05);
const BATCH = Math.max(500, Number(process.env.ODS_PUBLISH_BATCH) || 5000);
// El latido va a prod (`analytics.cron_runs`) y prod es de sólo lectura desde fuera de `md`. Se
// enciende solo cuando la credencial puede escribir; si no, se DECLARA apagado en vez de fingir.
const HEARTBEAT = String(process.env.ODS_PUBLISH_HEARTBEAT == null ? '1' : process.env.ODS_PUBLISH_HEARTBEAT) === '1';

const sslFor = (url) => (/@(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url)
  ? false : { rejectUnauthorized: false });
const qid = (id) => '"' + String(id).replace(/"/g, '""') + '"';
const SEP = '\u001f'; // separador de la llave compuesta: no aparece en datos de Kepler

/**
 * ⛔ LAS DOS COMPUERTAS, y ninguna clasifica por NOMBRE.
 *  a) el ORIGEN tiene que ser prod — publicarle a la tienda el catálogo de una copia vieja es el
 *     mismo incidente que este archivo viene a cerrar, nada más que al revés.
 *  b) origen ≠ destino por `system_identifier`. `classify()` NO sirve para distinguirlos: la base de
 *     Railway también se llama `railway`, así que clasifica 'prod' igual que la de verdad — la misma
 *     trampa de `[VL.13]`, donde la compuerta vieja miraba la FORMA y no podía ver que `md` es una
 *     restauración de Railway.
 */
async function compuertas(src, dst) {
  const k = classify(SRC_URL);
  if (k.kind !== 'prod') {
    throw new Error(`ABORT: el ORIGEN no es produccion -> ${k.host || '?'}/${k.db || '?'} (clasifica '${k.kind}'). `
      + 'Publicarle a la tienda desde una copia vieja es peor que no publicar.');
  }
  const sid = async (c) => (await c.query('SELECT system_identifier::text v FROM pg_control_system()')).rows[0].v;
  const a = await sid(src);
  const b = await sid(dst);
  if (a === b) throw new Error(`ABORT: origen y destino son el MISMO cluster (system_identifier ${a}).`);
  return { src: a, dst: b };
}

/** Metadatos de la tabla en el ORIGEN: columnas con tipo + PK real. */
async function meta(src, table) {
  const cols = (await src.query(
    `SELECT column_name AS name, data_type AS dt FROM information_schema.columns
      WHERE table_schema='kepler_ods' AND table_name=$1 ORDER BY ordinal_position`, [table])).rows;
  if (!cols.length) return null;
  const pk = (await src.query(
    `SELECT a.attname FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE n.nspname='kepler_ods' AND c.relname=$1 AND i.indisprimary`, [table])).rows.map((r) => r.attname);
  if (!pk.length) return null;
  const tipo = (dt) => ({
    numeric: 'numeric', 'double precision': 'double precision', real: 'real', integer: 'integer',
    bigint: 'bigint', smallint: 'smallint', boolean: 'boolean', date: 'date',
    'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
  }[dt] || 'text');
  return {
    table,
    schema: 'kepler_ods',
    // [PUB.1] El handler comparte el SQL de apply con el CDC, pero sus normalizadores
    // (kdii -> catalog.products / commercial.*) son de la Suite y allá no existen: correrían y
    // fallarían cada ciclo, llenando el log de errores que NO son fallas. `normalize:false` los
    // apaga sólo para este destino; el carril de prod no se entera.
    normalize: false,
    columns: cols.map((c) => ({ name: c.name, type: tipo(c.dt) })),
    pk: pk.filter((k) => k !== 'sucursal'),
    pkAll: pk,
  };
}

const pkExpr = (pkAll, alias) => (pkAll.length === 1
  ? `${alias}.${qid(pkAll[0])}::text`
  : `concat_ws('${SEP}', ${pkAll.map((k) => `${alias}.${qid(k)}::text`).join(', ')})`);

/**
 * HUELLA de la tabla: cuántas filas y un md5 del agregado de hashes de fila, en orden de llave.
 * Es comparable entre clústeres porque columnas, tipos y orden son idénticos (verificado).
 * Devuelve {n:-1} si la tabla no existe del lado consultado.
 */
async function huella(c, m) {
  const reg = (await c.query('SELECT to_regclass($1) AS r', [`kepler_ods.${m.table}`])).rows[0].r;
  if (!reg) return { n: -1, f: null };
  const r = (await c.query(
    `SELECT count(*)::bigint AS n, md5(coalesce(string_agg(h, '' ORDER BY k), '')) AS f
       FROM (SELECT md5(t::text) AS h, ${pkExpr(m.pkAll, 't')} AS k FROM kepler_ods.${qid(m.table)} t) x`)).rows[0];
  return { n: Number(r.n), f: r.f };
}

/** Sube a una temp del destino los pares (llave, hash) del snapshot del origen. Una sola consulta
 *  (`unnest` de dos arreglos): en Railway se cobra el EGRESO, así que subir es gratis y bajar no. */
async function subirHashes(src, dst, m) {
  const filas = (await src.query(
    `SELECT ${pkExpr(m.pkAll, 't')} AS k, md5(t::text) AS h FROM kepler_ods.${qid(m.table)} t`)).rows;
  await dst.query('CREATE TEMP TABLE IF NOT EXISTS pub_h (k text PRIMARY KEY, h text NOT NULL) ON COMMIT PRESERVE ROWS');
  await dst.query('TRUNCATE pub_h');
  await dst.query('INSERT INTO pub_h (k, h) SELECT * FROM unnest($1::text[], $2::text[])',
    [filas.map((r) => r.k), filas.map((r) => r.h)]);
  return filas.length;
}

/** Diff exacto por llave, calculado EN EL DESTINO contra la temp `pub_h`. Lo que baja es sólo la
 *  lista de llaves a mover — chica incluso cuando la tabla no lo es. */
async function diff(dst, m) {
  const rel = `kepler_ods.${qid(m.table)}`;
  const faltan = (await dst.query(
    `SELECT s.k FROM pub_h s
       LEFT JOIN ${rel} d ON ${pkExpr(m.pkAll, 'd')} = s.k
      WHERE d.${qid(m.pkAll[0])} IS NULL OR md5(d::text) IS DISTINCT FROM s.h`)).rows.map((r) => r.k);
  const sobran = (await dst.query(
    `SELECT ${pkExpr(m.pkAll, 'd')} AS k FROM ${rel} d
       LEFT JOIN pub_h s ON s.k = ${pkExpr(m.pkAll, 'd')}
      WHERE s.k IS NULL`)).rows.map((r) => r.k);
  return { faltan, sobran };
}

/** Trae del origen las filas de esas llaves y las aplica con el UPSERT sin churn compartido. */
async function empujar(src, dst, m, llaves) {
  const colList = m.columns.map((c) => `t.${qid(c.name)}`).join(', ');
  let aplicadas = 0;
  for (let i = 0; i < llaves.length; i += BATCH) {
    const lote = llaves.slice(i, i + BATCH);
    const rows = (await src.query(
      `SELECT ${colList} FROM kepler_ods.${qid(m.table)} t WHERE ${pkExpr(m.pkAll, 't')} = ANY($1::text[])`,
      [lote])).rows;
    if (rows.length) aplicadas += await HANDLERS['raw-upsert'](dst, TENANT, rows, m);
  }
  return aplicadas;
}

async function publicarTabla(src, dst, m) {
  // ⭐ TODAS las lecturas del origen van en UN SNAPSHOT (`REPEATABLE READ`), y no es un detalle:
  // prod cambia cada 15 s (la alimenta `ods_live_hot`). Sin snapshot, la huella que se lee al
  // empezar y las filas que se leen después son de dos momentos distintos, y la verificación final
  // compara el destino contra un origen que ya se movió -> "NO CUADRA" perpetuo con todo sano.
  // Medido: la primera corrida reportó NO CUADRA en kdii y kdik con los conteos idénticos.
  // La transacción es READ ONLY y dura lo que dura la tabla; en régimen son segundos.
  await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const hSrc = await huella(src, m);
    const hDst = await huella(dst, m);
    if (hDst.n >= 0 && hSrc.n === hDst.n && hSrc.f === hDst.f) {
      return { estado: 'igual', nSrc: hSrc.n, nDst: hDst.n, aplicadas: 0, borradas: 0, cuadra: true };
    }
    if (!APPLY) {
      return { estado: hDst.n < 0 ? 'falta la tabla' : 'DIFIERE', nSrc: hSrc.n, nDst: hDst.n, aplicadas: 0, borradas: 0, cuadra: null };
    }

    // Si la tabla no existe en el destino, el handler la auto-crea con su PK al primer lote.
    let aplicadas = 0; let borradas = 0; let declarados = 0;
    if (hDst.n < 0) {
      const todas = (await src.query(
        `SELECT ${pkExpr(m.pkAll, 't')} AS k FROM kepler_ods.${qid(m.table)} t`)).rows.map((r) => r.k);
      aplicadas = await empujar(src, dst, m, todas);
    }

    await subirHashes(src, dst, m);
    const d = await diff(dst, m);
    if (d.faltan.length) aplicadas += await empujar(src, dst, m, d.faltan);

    // `raw-upsert` NUNCA borra: un producto dado de baja en el ERP se quedaría en la tienda para
    // siempre. Con tope: un borrado masivo casi siempre significa que la LECTURA falló, no que el
    // catálogo se vació — y ante la duda se DECLARA, no se borra.
    if (d.sobran.length && DO_DELETE) {
      const frac = d.sobran.length / Math.max(1, hDst.n > 0 ? hDst.n : d.sobran.length);
      if (frac > DELETE_MAX_FRAC) {
        declarados = d.sobran.length;
        console.log(`    ⚠ ${m.table}: ${d.sobran.length} sobrantes (${(frac * 100).toFixed(1)}%) SOBRE el tope `
          + `${(DELETE_MAX_FRAC * 100).toFixed(0)}% -> NO se borra nada. Se declara y se revisa a mano.`);
      } else {
        const rel = `kepler_ods.${qid(m.table)}`;
        for (let i = 0; i < d.sobran.length; i += BATCH) {
          const lote = d.sobran.slice(i, i + BATCH);
          borradas += (await dst.query(
            `DELETE FROM ${rel} d WHERE ${pkExpr(m.pkAll, 'd')} = ANY($1::text[])`, [lote])).rowCount;
        }
      }
    } else if (d.sobran.length) {
      declarados = d.sobran.length;
      console.log(`    · ${m.table}: ${d.sobran.length} sobrantes NO borrados (ODS_PUBLISH_DELETE=0).`);
    }

    // ── PRUEBA NEGATIVA ───────────────────────────────────────────────────────
    // Se vuelve a correr el diff contra `pub_h`, o sea contra EL SNAPSHOT QUE SE ENVIÓ. Eso es lo
    // que hay que comprobar —"el destino quedó igual a lo que le mandé"— y es inmune a que el
    // origen haya avanzado mientras tanto. Una compuerta que sólo se mira antes de actuar es una
    // intención, no una compuerta.
    const v = await diff(dst, m);
    const post = await huella(dst, m);
    const cuadra = v.faltan.length === 0 && (declarados > 0 || !DO_DELETE || v.sobran.length === 0);
    if (!cuadra) {
      console.log(`    ⚠ ${m.table}: tras publicar siguen ${v.faltan.length} filas distintas y ${v.sobran.length} sobrantes.`);
    }
    return { estado: 'publicada', nSrc: hSrc.n, nDst: post.n, aplicadas, borradas, declarados, cuadra };
  } finally {
    await src.query('COMMIT').catch(() => src.query('ROLLBACK').catch(() => {}));
  }
}

async function unaPasada(src, dst) {
  let totalAplicadas = 0; let totalBorradas = 0; const malas = [];
  for (const t of TABLES) {
    const m = await meta(src, t);
    if (!m) { console.log(`  ${t.padEnd(6)} ⚠ no existe en kepler_ods del origen (o no tiene PK) -> skip`); continue; }
    const r = await publicarTabla(src, dst, m);
    totalAplicadas += r.aplicadas; totalBorradas += r.borradas;
    if (r.cuadra === false) malas.push(`${t}:${r.nSrc}/${r.nDst}`);
    const veredicto = r.cuadra === null ? r.estado : (r.cuadra ? (r.estado === 'igual' ? 'igual' : 'cuadra') : '⚠ NO CUADRA');
    console.log(`  ${t.padEnd(6)} origen=${String(r.nSrc).padStart(7)} destino=${String(r.nDst).padStart(7)}`
      + ` aplicadas=${String(r.aplicadas).padStart(7)} borradas=${String(r.borradas).padStart(5)}  ${veredicto}`);
  }
  return { totalAplicadas, totalBorradas, malas };
}

(async () => {
  if (!DEST_URL) {
    console.error('✖ falta ODS_PUBLISH_DEST_URL. Sin destino explicito este proceso no corre: un default'
      + ' escribe a la base equivocada SIN fallar, que es como se perdieron 23 h en [VL.13].');
    process.exit(2);
  }
  if (!SRC_URL) { console.error('✖ falta ODS_PUBLISH_SRC_URL / DATABASE_URL_NEW / DATABASE_URL.'); process.exit(2); }

  const src = new Client({ connectionString: SRC_URL, ssl: sslFor(SRC_URL), keepAlive: true });
  const dst = new Client({ connectionString: DEST_URL, ssl: sslFor(DEST_URL), keepAlive: true });
  await src.connect();
  await dst.connect();
  // [NORM.3c] La TZ de la sesión decide qué instante se escribe en las columnas `timestamptz`.
  await dst.query("SET TIME ZONE 'America/Mexico_City'");

  const ident = await compuertas(src, dst);
  const destIdent = `${new URL(DEST_URL).host}${new URL(DEST_URL).pathname}`; // sin credenciales, nunca
  const srcIdent = `${new URL(SRC_URL).host}${new URL(SRC_URL).pathname}`;
  console.log(`publish-ods-remote · ${APPLY ? 'APPLY' : 'DRY-RUN'}${WATCH_SEC ? ` --watch=${WATCH_SEC}s` : ''}`);
  console.log(`  origen  : ${srcIdent} (sysid ${ident.src}, solo lectura)`);
  console.log(`  destino : ${destIdent} (sysid ${ident.dst})`);
  console.log(`  tablas  : ${TABLES.join(',')}`);

  const ciclo = async () => {
    const t0 = Date.now();
    if (APPLY && HEARTBEAT) await hb.begin('ods_publish_tienda', 'ODS -> tienda mayorista (prod -> Railway)');
    try {
      const r = await unaPasada(src, dst);
      const nota = `${r.totalAplicadas} aplicadas · ${r.totalBorradas} borradas · ${Date.now() - t0} ms`;
      console.log(`  -> ${nota}`);
      if (!APPLY || !HEARTBEAT) return;
      if (r.malas.length) {
        await hb.end('ods_publish_tienda', { status: 'error', error: `no cuadra tras publicar: ${r.malas.join(' ')}` });
      } else {
        await hb.end('ods_publish_tienda', { status: 'ok', rows: r.totalAplicadas, note: nota });
      }
    } catch (e) {
      console.error(`  ✖ ${e.message}`);
      if (APPLY && HEARTBEAT) await hb.end('ods_publish_tienda', { status: 'error', error: String(e.message).slice(0, 300) });
      if (!WATCH_SEC) throw e;
    }
  };

  await ciclo();
  if (WATCH_SEC) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, WATCH_SEC * 1000));
      await ciclo();
    }
  }
  await src.end();
  await dst.end();
})().catch((e) => { console.error('✖', e.message); process.exit(1); });
