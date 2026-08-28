/* eslint-disable no-console */
/**
 * CDC.7b — deduplica el ODS donde el corrimiento de timestamps metió la MISMA fila lógica dos veces.
 *
 * EL BUG (ver GOTCHAS §21). `replicate-ods-live.js` (poll) hacía `SELECT` y node-postgres devolvía
 * un `Date` de JS, que interpreta el `timestamp without time zone` como hora LOCAL (MX) y al
 * re-escribirlo lo serializa como UTC → **+6 h**. `ods-cdc-wal.js` no: pgoutput entrega texto y
 * nunca pasa por un `Date`. Como el timestamp está EN LA PK, la fila que el poll ya había escrito a
 * las 06:00 no se colapsa con la que el WAL escribe a las 00:00: quedan las dos.
 *
 * ALCANCE MEDIDO EN PROD (2026-08-27). 39 tablas tienen timestamp en la PK; 5,709,506 filas están a
 * las 06:00 (las escribió el poll en el backfill histórico) y 50,264 a las 00:00 (las del WAL).
 * Pero DUPLICADAS —misma fila lógica dos veces— son sólo 7,482 en 6 tablas:
 *
 *   orglogtbl_26           5,731    tabla de LOG, hora real  → NO se toca (ver abajo)
 *   kdc22608               1,120    pólizas del mes ABIERTO  → esto corrompe la balanza
 *   orglogtbl_25             533    LOG                      → NO se toca
 *   orglogtbl_24              77    LOG                      → NO se toca
 *   kduf                      15
 *   kdpv_bitacora_precios      6
 *
 * DOS PROBLEMAS DISTINTOS, UNO SOLO SE ARREGLA ACÁ:
 *   (a) DUPLICADOS: la fila está dos veces → se suma dos veces. Es lo que arregla este script.
 *   (b) CORRIMIENTO a secas: fila ÚNICA con la hora +6 h. No duplica nada y, mientras el origen
 *       guarde medianoche (verificado: 100 % de `kdm1.c9` y `kdc22607.c2`, 0 % después de las
 *       18:00), el `::date` de todos los consumidores sigue dando la fecha correcta. Corregir 5.7 M
 *       filas en 39 PKs es otra migración, planificada aparte. Con el poll ya deshabilitado no
 *       entran filas corridas nuevas.
 *
 * LA REGLA, Y POR QUÉ SE AUTO-PROTEGE. Sólo actúa sobre una tabla si comprueba EN EL ORIGEN que esa
 * columna está SIEMPRE a medianoche. Si el origen guarda hora real no hay forma de saber cuál de
 * las dos filas es la fiel, así que se omite la tabla — y eso es exactamente lo que excluye a las
 * `orglogtbl_*` (donde además la llave normalizada al día puede agrupar filas legítimamente
 * distintas). Dentro de cada grupo se conserva la fila a medianoche (la del WAL, fiel al origen) y
 * se borran las corridas.
 *
 * EL TIMESTAMP VIAJA COMO TEXTO, a propósito: si se mandara como `Date` de JS, el borrado sufriría
 * el MISMO round-trip que causó el bug y apuntaría a la hora equivocada. Se lee con `to_char` y se
 * envía `'YYYY-MM-DD HH24:MI:SS'`, que el COPY del handler parsea literal, sin timezone de por medio.
 *
 *   node database/importers/kepler/dedupe-ods-timestamp-shift.js                  # dry-run
 *   node database/importers/kepler/dedupe-ods-timestamp-shift.js --tables=kdc22608 --apply
 */

const { Client } = require('pg');
const { ship } = require('../lib/sink');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC_BASE = process.env.ODS_SOURCE_BASE || process.env.DATABASE_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const argOf = (n, d) => { const h = process.argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const ONLY = (argOf('tables', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_PCT = Number(argOf('max-pct', 20));
const CHUNK = 5000;

const localDbName = (code) => (code === '03' ? 'kepler_pilot' : `kepler_md_${code}`);
const branchUrl = (code) => SRC_BASE.replace(/\/[^/]*$/, '/' + localDbName(code));
const TYPE_MAP = {
  text: 'text', 'character varying': 'text', character: 'text', uuid: 'text',
  numeric: 'numeric', 'double precision': 'double precision', real: 'real',
  integer: 'integer', bigint: 'bigint', smallint: 'smallint', boolean: 'boolean',
  date: 'date', 'timestamp without time zone': 'timestamp', 'timestamp with time zone': 'timestamptz',
};
const q = (id) => '"' + String(id).replace(/"/g, '""') + '"';

async function main() {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  await dst.query(`SET statement_timeout='900s'`);
  console.log(`\n=== Dedup del ODS por corrimiento de timestamps (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  // PK de cada tabla, marcando cuál columna es timestamp.
  const pk = new Map();
  for (const r of (await dst.query(`
    SELECT c.relname tabla, a.attname col, format_type(a.atttypid, a.atttypmod) decl,
           array_position(k.conkey, a.attnum) pos
    FROM pg_constraint k
    JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ANY(k.conkey)
    WHERE n.nspname='kepler_ods' AND k.contype='p' AND c.relkind='r'
    ORDER BY 1, pos`)).rows) {
    if (!pk.has(r.tabla)) pk.set(r.tabla, []);
    pk.get(r.tabla).push({ name: r.col, type: TYPE_MAP[r.decl] || 'text', ts: /^timestamp/.test(r.decl) });
  }
  let tablas = [...pk.entries()].filter(([t, cols]) => cols.some((c) => c.ts) && !t.startsWith('_'));
  if (ONLY.length) tablas = tablas.filter(([t]) => ONLY.includes(t));
  console.log(`  tablas con timestamp en la PK: ${tablas.length}\n`);

  // Una conexión por sucursal (para el chequeo de "siempre medianoche" en el origen).
  const branches = (await dst.query(
    `SELECT DISTINCT btrim(sucursal) s FROM kepler_ods.ctl WHERE btrim(coalesce(sucursal,''))<>'' ORDER BY 1`)).rows.map((r) => r.s);
  const src = {};
  for (const code of branches) {
    try { const cl = new Client({ connectionString: branchUrl(code), connectionTimeoutMillis: 8000, statement_timeout: 600000 }); await cl.connect(); src[code] = cl; }
    catch (e) { console.log(`  ⚠ sucursal ${code}: sin conexión a ${localDbName(code)} — se omite`); }
  }

  let totalBorradas = 0; const hechas = [];
  for (const [tabla, cols] of tablas) {
    const tsCols = cols.filter((c) => c.ts);
    const keyCols = cols.filter((c) => c.name !== 'sucursal');

    // GUARD: el origen tiene que guardar TODAS las columnas timestamp de la PK a medianoche.
    // Si hay hora real no se puede saber cuál fila es la fiel → se omite la tabla.
    let bloqueo = null;
    for (const code of Object.keys(src)) {
      for (const tc of tsCols) {
        let nz;
        try {
          nz = Number((await src[code].query(
            `SELECT count(*)::bigint n FROM md.${tabla} WHERE ${q(tc.name)} IS NOT NULL AND ${q(tc.name)}::time <> '00:00:00'`)).rows[0].n);
        } catch { nz = null; }             // la rama no tiene la tabla: no opina
        if (nz) { bloqueo = `${code}/${tc.name}: ${nz} filas con hora real en el origen`; break; }
      }
      if (bloqueo) break;
    }
    if (bloqueo) { console.log(`  ⏭ ${tabla}: OMITIDA — ${bloqueo}`); continue; }

    // Grupos duplicados: misma PK con el timestamp normalizado al día, con ≥1 fila a medianoche
    // (la fiel que se conserva) y ≥1 corrida (las que se borran).
    const norm = cols.map((c) => (c.ts ? `to_char(date_trunc('day', ${q(c.name)}), 'YYYY-MM-DD')` : `btrim(${q(c.name)}::text)`));
    const sel = keyCols.map((c) => (c.ts ? `to_char(${q(c.name)}, 'YYYY-MM-DD HH24:MI:SS') AS ${q(c.name)}` : q(c.name)));
    // Dos pasos, para no traer la tabla entera a memoria (kdpv_bitacora_precios son 5.3 M filas):
    // 1) el GROUP BY en el servidor devuelve SOLO las llaves de los grupos duplicados que además
    //    tienen al menos una fila fiel; 2) se traen únicamente las filas de esas llaves.
    const fiel = tsCols.map((c) => `${q(c.name)}::time = '00:00:00'`).join(' AND ');
    const total = Number((await dst.query(`SELECT count(*)::bigint n FROM kepler_ods.${tabla}`)).rows[0].n);
    const llaves = (await dst.query(`
      SELECT concat(${norm.join(', chr(1), ')}) AS k
      FROM kepler_ods.${tabla}
      GROUP BY ${norm.join(', ')}
      HAVING count(*) > 1 AND count(*) FILTER (WHERE ${fiel}) >= 1`)).rows.map((r) => r.k);
    if (!llaves.length) { console.log(`  · ${tabla}: sin duplicados con fila fiel`); continue; }

    const aBorrar = (await dst.query(`
      SELECT btrim(sucursal) AS sucursal, ${sel.join(', ')}
      FROM kepler_ods.${tabla}
      WHERE concat(${norm.join(', chr(1), ')}) = ANY($1::text[])
        AND NOT (${fiel})`, [llaves])).rows;
    if (!aBorrar.length) { console.log(`  · ${tabla}: ${llaves.length} grupos, pero nada corrido que borrar`); continue; }

    const pct = (aBorrar.length / total) * 100;
    if (pct > MAX_PCT) {
      console.log(`  ⛔ ${tabla}: ${aBorrar.length}/${total} a borrar (${pct.toFixed(1)}% > ${MAX_PCT}%) — SKIP por seguridad`);
      continue;
    }
    const porSuc = {};
    for (const r of aBorrar) porSuc[r.sucursal] = (porSuc[r.sucursal] || 0) + 1;
    console.log(`  ${APPLY ? '🗑' : '·'} ${tabla}: ${aBorrar.length} corridas a borrar de ${total} (${pct.toFixed(2)}%) · por sucursal ${Object.entries(porSuc).map(([s, n]) => s + '=' + n).join(' ')}`);
    hechas.push({ tabla, n: aBorrar.length });
    if (!APPLY) continue;

    const shipMeta = { table: tabla, pk: keyCols.map((c) => c.name), columns: [{ name: 'sucursal', type: 'text' }, ...keyCols.map((c) => ({ name: c.name, type: c.type }))] };
    for (let i = 0; i < aBorrar.length; i += CHUNK) {
      const batch = aBorrar.slice(i, i + CHUNK).map((r) => {
        const o = { sucursal: r.sucursal };
        for (const c of keyCols) o[c.name] = r[c.name];   // el timestamp ya viene como texto
        return o;
      });
      // `client: dst` para que funcione en los DOS modos del sink: en `pg` aplica en proceso contra
      // esta conexión (el modo pg lanza si no se le pasa cliente) y en `http` lo ignora.
      const r = await ship('raw-delete', { rows: batch, tenantId: M, client: dst, meta: shipMeta });
      totalBorradas += Number(r && (r.rowCount ?? r.rows ?? r)) || 0;
    }
  }

  // Verificación: los duplicados tienen que quedar en cero.
  if (APPLY && hechas.length) {
    console.log('\n  verificando…');
    for (const h of hechas) {
      const cols = pk.get(h.tabla);
      const norm = cols.map((c) => (c.ts ? `to_char(date_trunc('day', ${q(c.name)}), 'YYYY-MM-DD')` : `btrim(${q(c.name)}::text)`));
      const r = (await dst.query(`
        SELECT coalesce(sum(n-1),0)::int extra FROM (
          SELECT count(*) n FROM kepler_ods.${h.tabla}
          GROUP BY ${norm.join(', ')} HAVING count(*) > 1) x`)).rows[0];
      console.log(`    ${h.tabla}: quedan ${r.extra} filas duplicadas ${Number(r.extra) === 0 ? '✓' : '✗'}`);
    }
  }

  for (const c of Object.values(src)) await c.end();
  console.log(`\n${APPLY ? `APPLY — ${totalBorradas} filas borradas.` : 'DRY-RUN — nada se borró. Corré con --apply.'}`);
  await dst.end();
}

if (require.main === module) {
  main().catch((e) => { console.error('\nERROR: ' + e.message); process.exitCode = 1; });
}
module.exports = { main };
