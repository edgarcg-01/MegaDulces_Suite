'use strict';
/**
 * Adapter Access -> Postgres (Fases WR-hist / CA) — LECTOR BULK vía **mdbtools** en contenedor.
 *
 * Es el hermano rápido de `access-adapter.js` (Node -> PS32 -> Jet -> JSONL). Mismo problema, otra
 * herramienta: mdbtools parsea el `.mdb` directo en C, sin Jet, sin PowerShell y sin dependencia de
 * 32 bits. Se usa para CARGA MASIVA (histórico, one-shot); el carril VIVO sigue con Jet, que está
 * probado en producción bajo PM2 y no se toca.
 *
 * Medido 2026-09-01 sobre `Z:\Salidas\Bases\2025\44 YURECUARO.MDB` (JET3 = Access 97, 69.8 MB):
 *   · `mdb-export` de las 70 tablas: **67 s** vs **554 s** del carril Jet+PS32 → 8.3x
 *   · fidelidad EXACTA: 152,718 filas en DetallesMovAlmacen y ΣValorVenta $7,629,584.75,
 *     iguales al centavo a lo que devolvió Jet.
 *   · el cuello del carril Jet era `ConvertTo-Json` por fila en PowerShell (~129 s de los 160 s
 *     de esa tabla), no Postgres: escribir las mismas 152k filas tardaba 16-31 s.
 *
 * Gotchas:
 *  - `mdb-schema` **baja a minúsculas** todos los identificadores. El nombre EXACTO (CamelCase, el
 *    que usa el espejo del carril vivo) sale del **encabezado del CSV** de `mdb-export`, que sí lo
 *    preserva. Acá se cruzan por nombre case-insensitive.
 *  - Las fechas se espejan como `text` (igual que en el carril Jet): Access guarda tiempos 1899 que
 *    Postgres rechaza como timestamp. El saneamiento vive en silver, no en la réplica cruda.
 *  - Requiere Docker corriendo en la máquina de feeds. `ensureImage()` construye la imagen si falta.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const IMAGE = process.env.MDBTOOLS_IMAGE || 'mdbtools:local';
const DOCKERFILE = path.join(__dirname, 'mdbtools.Dockerfile');
const MOUNT = '/data';

/** Corre docker y devuelve stdout; lanza con el stderr si falla. */
function docker(args, { maxBuffer = 256 * 1024 * 1024 } = {}) {
  const res = spawnSync('docker', args, { encoding: 'utf8', maxBuffer, windowsHide: true });
  if (res.error) throw new Error(`docker no arrancó: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`docker falló: ${(res.stderr || res.stdout || '').slice(0, 400)}`);
  return res.stdout || '';
}

/** Docker vivo + imagen presente (la construye si falta). Idempotente y barato. */
function ensureImage() {
  docker(['version', '--format', '{{.Server.Version}}']);
  try {
    docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
  } catch {
    if (!fs.existsSync(DOCKERFILE)) throw new Error(`falta ${DOCKERFILE} para construir ${IMAGE}`);
    docker(['build', '-q', '-t', IMAGE, '-f', DOCKERFILE, path.dirname(DOCKERFILE)]);
  }
  return IMAGE;
}

/**
 * Args de `docker run` con el directorio del .mdb montado en /data.
 *
 * ⚠️ CADA llamada arranca un contenedor (~1.5 s). Medido 2026-09-01: hacer una llamada por tabla
 * (header + export = 2 por tabla × 70) se comía ~4 min por archivo y borraba toda la ventaja de
 * mdbtools. Para cargar un `.mdb` completo usá **`dumpAll`**, que hace TODO en un solo contenedor.
 */
function runArgs(mdb, cmd, { rw = false } = {}) {
  const dir = path.dirname(path.resolve(mdb)).replace(/\\/g, '/');
  return ['run', '--rm', '-v', `${dir}:${MOUNT}${rw ? '' : ':ro'}`, IMAGE, 'sh', '-c', cmd];
}
/** Ruta del .mdb vista desde dentro del contenedor. */
function inner(mdb) { return `${MOUNT}/${path.basename(mdb)}`; }
/** Cita para `sh -c` (comillas simples). */
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Versión del motor Jet del archivo ('JET3' = Access 97, 'JET4' = 2000+). */
function jetVersion(mdb) {
  return docker(runArgs(mdb, `mdb-ver ${shq(inner(mdb))}`)).trim();
}

/** Lista de tablas del .mdb. */
function tables(mdb) {
  return docker(runArgs(mdb, `mdb-tables -1 ${shq(inner(mdb))}`))
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Tipo del espejo CRUDO a partir del tipo que emite `mdb-schema ... postgres`.
 * Misma filosofía que `access-adapter.jetToPg`: laxo y tolerante a corruptos.
 */
function mdbToPg(sqlType) {
  const t = String(sqlType).toUpperCase();
  if (/^(INTEGER|SMALLINT|BIGINT|DOUBLE PRECISION|REAL|NUMERIC|DECIMAL|SERIAL)/.test(t)) return 'numeric';
  if (/^BOOL/.test(t)) return 'boolean';
  return 'text'; // VARCHAR/CHAR/TEXT/TIMESTAMP/DATE/TIME/BYTEA/desconocidos → text
}

/**
 * Esquema completo del archivo en UNA llamada: `{ tableLower: {types:Map, pk:[...]} }`.
 * Devuelve nombres en MINÚSCULA (como los emite mdb-schema); el case exacto se recupera del
 * encabezado del CSV — ver `describe()`.
 */
function schemaRaw(mdb) {
  return parseSchema(docker(runArgs(mdb, `mdb-schema --indexes ${shq(inner(mdb))} postgres`)));
}

/** Parsea la salida de `mdb-schema ... postgres --indexes`. */
function parseSchema(out) {
  const byTable = new Map();
  let cur = null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^CREATE TABLE IF NOT EXISTS "([^"]+)"/i.exec(line) || /^CREATE TABLE "([^"]+)"/i.exec(line);
    if (m) { cur = { types: new Map(), pk: [] }; byTable.set(m[1].toLowerCase(), cur); continue; }
    if (line === ');') { cur = null; continue; }
    if (cur) {
      m = /^"([^"]+)"\s+(.+?),?$/.exec(line);
      if (m) cur.types.set(m[1].toLowerCase(), mdbToPg(m[2]));
      continue;
    }
    m = /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "[^"]*" PRIMARY KEY \(([^)]+)\)/i.exec(line);
    if (m) {
      const t = byTable.get(m[1].toLowerCase());
      if (t) t.pk = m[2].split(',').map((s) => s.trim().replace(/^"|"$/g, '').toLowerCase());
    }
  }
  return byTable;
}

/** Encabezado del CSV de una tabla → nombres de columna con el case EXACTO de Access. */
function headerOf(mdb, table) {
  const out = docker(runArgs(mdb, `mdb-export ${shq(inner(mdb))} ${shq(table)} | head -1`));
  return parseCsvLine(out.split(/\r?\n/)[0] || '');
}

/**
 * VOLCADO COMPLETO en UN SOLO contenedor: version Jet + lista de tablas + esquema + un CSV por
 * tabla. Es la forma correcta de cargar un `.mdb` entero (ver la advertencia de `runArgs`).
 *
 * Los CSV se nombran por ÍNDICE (`0.csv`, `1.csv`…) siguiendo el orden de `_tables.txt`, para no
 * depender de que el nombre de la tabla sea un nombre de archivo válido.
 *
 * `outSubdir` es relativo al directorio del `.mdb` (que se monta rw) → un solo mount.
 * Devuelve `{ jet, tables:[...], schema:Map, dir }` con `dir` = ruta local de los CSV.
 */
function dumpAll(mdb, outSubdir) {
  const dir = path.join(path.dirname(path.resolve(mdb)), outSubdir);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const o = `${MOUNT}/${outSubdir}`;
  const f = shq(inner(mdb));
  // Se escribe primero en el FS del contenedor (/tmp) y al final se copia todo de una a /data.
  // Medido 2026-09-01: exportar directo al bind-mount de Docker Desktop tardaba 128 s contra 67 s
  // escribiendo en /tmp — mdb-export emite en chunks chicos y cada uno cruza el puente de archivos
  // de Windows. Un `cp` secuencial al final de 45 MB cuesta segundos.
  const cmd = [
    'mkdir -p /tmp/o',
    `mdb-ver ${f} > /tmp/o/_ver.txt`,
    `mdb-tables -1 ${f} > /tmp/o/_tables.txt`,
    `mdb-schema --indexes ${f} postgres > /tmp/o/_schema.sql`,
    `i=0; while IFS= read -r t; do mdb-export -D '%Y-%m-%dT%H:%M:%S' ${f} "$t" > "/tmp/o/$i.csv" 2>> /tmp/o/_err.txt || echo "FAIL $t" >> /tmp/o/_err.txt; i=$((i+1)); done < /tmp/o/_tables.txt`,
    `cp /tmp/o/. ${o}/ -r`,
  ].join('; ');
  docker(runArgs(mdb, cmd, { rw: true }), { maxBuffer: 8 * 1024 * 1024 });

  const rd = (n) => { try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch { return ''; } };
  const tables = rd('_tables.txt').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return {
    jet: rd('_ver.txt').trim(),
    tables,
    schema: parseSchema(rd('_schema.sql')),
    errors: rd('_err.txt').split(/\r?\n/).filter((l) => l.startsWith('FAIL ')).map((l) => l.slice(5)),
    dir,
    csvOf: (idx) => path.join(dir, `${idx}.csv`),
  };
}

/** Primera línea de un CSV ya volcado → nombres de columna con el case EXACTO de Access. */
function headerOfCsv(csvPath) {
  let fd;
  try {
    fd = fs.openSync(csvPath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const txt = buf.slice(0, n).toString('utf8');
    const nl = txt.indexOf('\n');
    return parseCsvLine((nl >= 0 ? txt.slice(0, nl) : txt).replace(/\r$/, ''));
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Como `describe`, pero tomando el header de un CSV ya volcado (sin arrancar contenedor). */
function describeFromCsv(table, csvPath, schema) {
  const meta = schema.get(String(table).toLowerCase()) || { types: new Map(), pk: [] };
  const names = headerOfCsv(csvPath);
  const columns = names.map((n) => ({ name: n, pg: meta.types.get(n.toLowerCase()) || 'text' }));
  const exact = new Map(names.map((n) => [n.toLowerCase(), n]));
  return { table, columns, pk: meta.pk.map((p) => exact.get(p)).filter(Boolean) };
}

/** Parser de una línea CSV (mdb-export usa comillas dobles duplicadas). */
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Descripción de una tabla lista para el espejo: columnas con case exacto + tipo laxo + PK.
 * `{ table, columns:[{name, pg}], pk:[nombres con case exacto] }`
 */
function describe(mdb, table, schema) {
  const meta = schema.get(String(table).toLowerCase()) || { types: new Map(), pk: [] };
  const names = headerOf(mdb, table);
  const columns = names.map((n) => ({ name: n, pg: meta.types.get(n.toLowerCase()) || 'text' }));
  const exact = new Map(names.map((n) => [n.toLowerCase(), n]));
  const pk = meta.pk.map((p) => exact.get(p)).filter(Boolean);
  return { table, columns, pk };
}

/**
 * Lanza `mdb-export` de una tabla y devuelve el proceso, para canalizar su stdout a
 * `psql \copy ... FROM STDIN CSV HEADER`. El CSV nunca toca el disco.
 */
function exportProcess(mdb, table) {
  return spawn('docker', runArgs(mdb, `mdb-export -D '%Y-%m-%dT%H:%M:%S' ${shq(inner(mdb))} ${shq(table)}`),
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

module.exports = {
  IMAGE, MOUNT, DOCKERFILE,
  ensureImage, jetVersion, tables, schemaRaw, parseSchema, describe, headerOf, exportProcess,
  dumpAll, headerOfCsv, describeFromCsv,
  mdbToPg, parseCsvLine,
};
