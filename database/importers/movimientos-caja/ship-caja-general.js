'use strict';
/* eslint-disable no-console */
/**
 * CG.9c — **SHIPPER** del espejo crudo de la caja general → `caja_general_ods.*` de la plataforma.
 *
 *     Z:/…/BDatos.mdb            ──(Jet, hash-delta)──>  :5433/caja_general.cg20
 *     Z:/…/BMovimientosCajas.mdb ──(Jet, hash-delta)──>  :5433/caja_general.cgarq20
 *                                                               │
 *                                                               │  ESTE archivo (delta)
 *                                                               ▼
 *                                                        caja_general_ods.*
 *                                                               │ derive-no-copy
 *                                                               ▼
 *                                                        analytics.caja_general_* / caja_arqueos
 *
 * ── Por qué hay dos saltos y no uno ────────────────────────────────────────────────────────────
 *
 * La tentación es apuntar el replicador directo a la plataforma y ahorrarse este archivo. **Se
 * midió y no conviene:** el motor de réplica hace hash-delta mandando la tabla ENTERA al destino y
 * dejando que Postgres decida con `IS DISTINCT` — 117,018 filas por pasada. Local eso cuesta 144 s;
 * contra la plataforma serían ~40 MB de subida en CADA pasada, cambie algo o no.
 *
 * Acá el delta es real: el UPSERT del espejo sólo mueve `_synced_at` cuando el hash CAMBIÓ
 * (`... DO UPDATE SET …, _synced_at=now() WHERE _row_hash IS DISTINCT FROM excluded._row_hash`),
 * así que `_synced_at` es una marca de cambio honesta y se shipea sólo lo que se movió. Medido el
 * 2026-09-18: entre dos pasadas del mismo día entraron **23 movimientos**, no 117,018.
 *
 * ── Dónde vive la marca, y por qué ahí ─────────────────────────────────────────────────────────
 *
 * En el **DESTINO**, no en el espejo. No es simetría con el ODS: es la única opción que falla del
 * lado seguro. Si la marca viviera en el espejo y alguien recreara el destino, la marca sobreviviría
 * y el destino se quedaría **vacío para siempre**. Viviendo en el destino, recrearlo borra la marca
 * y fuerza un re-ship completo — ruidoso pero correcto.
 *
 * ── El traslape es a propósito ─────────────────────────────────────────────────────────────────
 *
 * Se lee `_synced_at >= marca`, no `>`. Un UPSERT toca muchas filas con el MISMO `now()`, así que
 * un `>` estricto puede cortar a la mitad de un lote y dejar filas invisibles para siempre. Re-shipear
 * el lote del borde es gratis (el UPSERT del destino también está gateado por hash); un hueco no.
 * Es la misma lección del reconciliador del ODS: el traslape se ve, el hueco no.
 *
 * ── El candado que importa ─────────────────────────────────────────────────────────────────────
 *
 * Si el `.mdb` gana una columna, el espejo la gana sola (el DDL se auto-genera) y el landing NO.
 * Sin candado, esa columna se dejaría de shipear **en silencio**. Por eso, antes de mover un byte,
 * se compara columna por columna y se ABORTA si al destino le falta alguna.
 *
 *   node database/importers/movimientos-caja/ship-caja-general.js                 # dry-run
 *   node database/importers/movimientos-caja/ship-caja-general.js --apply
 *   node database/importers/movimientos-caja/ship-caja-general.js --apply --full  # ignora la marca
 *   node database/importers/movimientos-caja/ship-caja-general.js --apply --watch=5   # loop 5 min
 */
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const cfg = require('./caja-general-replica-config');

const APPLY = process.argv.includes('--apply');
const FULL = process.argv.includes('--full');
const WATCH_ARG = process.argv.find((a) => a === '--watch' || a.startsWith('--watch='));
const WATCH_MIN = WATCH_ARG ? Math.max(1, Number(WATCH_ARG.split('=')[1] || 5)) : 0;
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const BATCH = Math.max(200, Number(process.env.CAJA_GENERAL_SHIP_BATCH) || 2000);

const SRC_URL = process.env.CAJA_GENERAL_REPLICA_URL || cfg.REPLICA_URL;
const DST_URL = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;

/**
 * El mapa espejo → landing. Es EXPLÍCITO a propósito: una tabla nueva en el `.mdb` no debe empezar
 * a viajar sola, y una que deje de viajar tiene que notarse acá, no en una pantalla vacía.
 */
const RUTAS = [
  { src_schema: 'cg20', src_table: 'Doctos', dst: 'doctos', source_caja: '20' },
  { src_schema: 'cg20', src_table: 'Cuenta', dst: 'cuenta', source_caja: '20' },
  { src_schema: 'cgarq20', src_table: '0 T Movimientos', dst: 'arqueo_movimientos', source_caja: '20' },
];

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

async function ensureWatermarkTable(dst) {
  await dst.query(`
    CREATE TABLE IF NOT EXISTS caja_general_ods._ship_watermark (
      src_schema   text NOT NULL,
      src_table    text NOT NULL,
      wm           timestamptz,
      rows_shipped bigint NOT NULL DEFAULT 0,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (src_schema, src_table)
    )`);
}

async function getWatermark(dst, r) {
  if (FULL) return null;
  const x = await dst.query(
    'SELECT wm FROM caja_general_ods._ship_watermark WHERE src_schema=$1 AND src_table=$2',
    [r.src_schema, r.src_table]);
  return x.rows[0]?.wm || null;
}

async function setWatermark(dst, r, wm, n) {
  await dst.query(`
    INSERT INTO caja_general_ods._ship_watermark (src_schema, src_table, wm, rows_shipped)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (src_schema, src_table) DO UPDATE
      SET wm = GREATEST(caja_general_ods._ship_watermark.wm, excluded.wm),
          rows_shipped = caja_general_ods._ship_watermark.rows_shipped + excluded.rows_shipped,
          updated_at = now()`, [r.src_schema, r.src_table, wm, n]);
}

/** El candado: toda columna del espejo tiene que existir en el landing, o se aborta. */
async function columnasCompatibles(src, dst, r) {
  const a = await src.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [r.src_schema, r.src_table]);
  const b = await dst.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='caja_general_ods' AND table_name=$1`, [r.dst]);
  const destino = new Set(b.rows.map((x) => x.column_name));
  const mapa = a.rows.map((x) => ({ src: x.column_name, dst: x.column_name.toLowerCase() }));
  const faltan = mapa.filter((m) => !destino.has(m.dst)).map((m) => m.src);
  if (faltan.length) {
    throw new Error(
      `${r.src_schema}."${r.src_table}" tiene ${faltan.length} columna(s) que el landing NO tiene: `
      + `${faltan.join(', ')}. El .mdb cambió de forma — hay que migrar caja_general_ods.${r.dst} `
      + 'ANTES de seguir shipeando, o esas columnas se perderían en silencio.');
  }
  return mapa;
}

async function shipTabla(src, dst, r) {
  const mapa = await columnasCompatibles(src, dst, r);
  const wm = await getWatermark(dst, r);

  // >= a propósito (traslape, no hueco). Ver la cabecera.
  const where = wm ? `WHERE "_synced_at" >= $1` : '';
  const args = wm ? [wm] : [];
  const cnt = await src.query(
    `SELECT count(*)::int n, max("_synced_at") mx FROM ${q(r.src_schema)}.${q(r.src_table)} ${where}`, args);
  const total = cnt.rows[0].n;
  const maxWm = cnt.rows[0].mx;

  if (!APPLY) return { leidas: total, escritas: 0, wm, maxWm };
  if (!total) return { leidas: 0, escritas: 0, wm, maxWm };

  const colsSrc = mapa.map((m) => q(m.src)).join(', ');
  const colsDst = ['source_caja', ...mapa.map((m) => m.dst), '_shipped_at'];
  const identidad = {
    doctos: ['source_caja', 'tipodto', 'iddocto', 'fecha', 'horad', 'cuenta'],
    cuenta: ['source_caja', 'idcuenta'],
    arqueo_movimientos: ['source_caja', 'id'],
  }[r.dst];
  // El destino también está gateado por hash: re-shipear el lote del borde no escribe nada.
  const setList = [...mapa.map((m) => `${q(m.dst)}=excluded.${q(m.dst)}`), '_shipped_at=now()'].join(', ');

  // ⛔ El techo de 65,535 parámetros de bind del protocolo de Postgres, y **da la vuelta en
  // silencio**: el contador es int16, así que 2,000 filas × 39 columnas = 78,000 llega como
  // 78,000 − 65,536 = **12,464** y el error que se ve es "tiene 12464 formatos de parámetro pero 0
  // parámetros" — que no menciona ni el lote ni el límite. Ya costó una corrida. El lote se calcula
  // por PARÁMETROS, no por filas, y se deja margen.
  const porFila = mapa.length + 1;                       // +1 = source_caja
  const lote = Math.max(1, Math.min(BATCH, Math.floor(60000 / porFila)));

  let escritas = 0;
  for (let off = 0; off < total; off += lote) {
    const page = await src.query(
      `SELECT ${colsSrc} FROM ${q(r.src_schema)}.${q(r.src_table)} ${where}
        ORDER BY "_synced_at", "_row_hash" LIMIT ${lote} OFFSET ${off}`, args);
    if (!page.rowCount) break;

    const vals = [];
    const ph = [];
    let i = 1;
    for (const row of page.rows) {
      const one = [r.source_caja, ...mapa.map((m) => row[m.src])];
      ph.push('(' + one.map(() => `$${i++}`).join(',') + ', now())');
      vals.push(...one);
    }
    const res = await dst.query(
      `INSERT INTO caja_general_ods.${q(r.dst)} (${colsDst.map(q).join(',')})
       VALUES ${ph.join(',')}
       ON CONFLICT (${identidad.map(q).join(',')}) DO UPDATE SET ${setList}
        WHERE caja_general_ods.${q(r.dst)}."_row_hash" IS DISTINCT FROM excluded."_row_hash"`, vals);
    escritas += res.rowCount;
  }

  if (maxWm) await setWatermark(dst, r, maxWm, escritas);
  return { leidas: total, escritas, wm, maxWm };
}

async function ciclo() {
  if (!DST_URL) throw new Error('falta DATABASE_URL_NEW: no hay destino al que shipear.');
  const src = new Client({ connectionString: SRC_URL, statement_timeout: 300000 });
  const dst = new Client({ connectionString: DST_URL, statement_timeout: 300000 });
  await src.connect();
  await dst.connect();
  try {
    await ensureWatermarkTable(dst);
    const rutas = RUTAS.filter((r) => !ONLY || ONLY.split(',').includes(r.dst));
    console.log(`=== CG.9c ship caja general → caja_general_ods (${APPLY ? 'APPLY' : 'DRY-RUN'}${FULL ? ' FULL' : ''}) ===`);
    let leidas = 0;
    let escritas = 0;
    for (const r of rutas) {
      const t0 = Date.now();
      const x = await shipTabla(src, dst, r);
      leidas += x.leidas;
      escritas += x.escritas;
      console.log(`  ${r.dst.padEnd(20)} desde=${x.wm ? new Date(x.wm).toISOString().slice(0, 19) : '(todo)'}`
        + `  leidas=${String(x.leidas).padStart(7)}  escritas=${String(x.escritas).padStart(7)}`
        + `  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    console.log(`  → leidas ${leidas} · escritas ${escritas}`);
    return { leidas, escritas };
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
}

(async () => {
  // Latido SÓLO en watch (proceso largo desatendido), igual que el replicador. Una corrida a mano
  // no debe pisar la marca de frescura del carril agendado.
  const hb = (WATCH_MIN && APPLY) ? require(path.join(__dirname, '..', 'lib', 'cron-heartbeat')) : null;
  const KEY = 'caja_general_ship';
  const uno = async () => {
    if (hb) await hb.begin(KEY, 'Caja General — ship a caja_general_ods').catch(() => {});
    try {
      const r = await ciclo();
      if (hb) await hb.end(KEY, { status: 'ok', rows: r.escritas }).catch(() => {});
    } catch (e) {
      if (hb) await hb.end(KEY, { status: 'error', error: e.message }).catch(() => {});
      throw e;
    }
  };
  try { await uno(); } catch (e) {
    if (!WATCH_MIN) throw e;
    console.error('primer ciclo falló:', e.message);
  }
  if (WATCH_MIN && APPLY) {
    console.log(`\n(loop cada ${WATCH_MIN} min — Ctrl+C para salir)`);
    setInterval(() => { uno().catch((e) => console.error('ciclo falló:', e.message)); }, WATCH_MIN * 60000);
  } else if (!APPLY) {
    console.log('\n(dry-run: no se escribió nada. Agregá --apply)');
  }
})().catch((e) => { console.error('\n💥', e.message); process.exitCode = 1; });
