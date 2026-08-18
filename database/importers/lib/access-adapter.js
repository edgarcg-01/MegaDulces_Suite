'use strict';
/**
 * Adapter Access -> Postgres (Fases WR / CA) — LECTOR ÚNICO de bases Access 97 (.mdb) desde Node.
 *
 * Es la pieza que a Kepler le da la replicación lógica nativa, pero para Access: un puente
 * Node -> PowerShell 32-bit -> Jet 4.0 (Mode=Read, sobre copia-sombra) -> JSONL -> Node.
 * Jet 4.0 NO tiene build 64-bit y ACE 12/16 RECHAZAN Access 97 (ADR-031) -> PS32 obligatorio.
 *
 * Se construye UNA vez y se reusa (FASE_WR §7): Wincaja (MaestroMovAlmacen…) y CEDIS Kepler-Access (kdXX).
 *
 * API:
 *   discoverSchema(mdb, {pattern, noCounts})  -> [{table, rows, columns:[{name,jet,ord}], pk:[...]}]
 *   readTable(mdb, table, {columns, where, orderBy})  -> [rowObj, ...]
 *   readIncremental(mdb, table, {sinceCol, sinceVal, columns})  -> filas con [sinceCol] > sinceVal
 *   query(mdb, sql)  -> filas de un SELECT arbitrario
 *   jetToPg(jetType) -> tipo Postgres del espejo crudo (numeric/text/boolean, tolerante a corruptos)
 *
 * On-prem only: Jet 32-bit + la copia-sombra (Z:) viven en la máquina de feeds. NO en Railway.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const PS32 = process.env.PS32 || 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe';
const READ_PS = path.join(__dirname, 'access-read.ps1');
const SCHEMA_PS = path.join(__dirname, 'access-schema.ps1');
const STDOUT_MAX = 64 * 1024 * 1024; // stdout del PS es minúsculo (ROWS=n); el volumen va al archivo Out

function tmpOut(tag) {
  return path.join(os.tmpdir(), `acc_${tag}_${Date.now()}_${Math.round(process.hrtime()[1] % 1e6)}.jsonl`);
}

/** Corre un .ps1 en PS 32-bit. Lanza si status != 0. Devuelve el stdout (para el "ROWS=n"/"TABLES=n"). */
function runPs(psFile, args) {
  const res = spawnSync(PS32, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, ...args], {
    encoding: 'utf8', maxBuffer: STDOUT_MAX,
  });
  if (res.error) throw new Error(`PS32 no arrancó (${psFile}): ${res.error.message}`);
  if (res.status !== 0) throw new Error(`PS32 falló (${path.basename(psFile)}): ${(res.stderr || res.stdout || '').slice(0, 400)}`);
  return res.stdout || '';
}

/** Lee el JSONL de salida, lo parsea y borra el temp. */
function readJsonl(out) {
  let rows = [];
  try {
    if (!fs.existsSync(out)) return rows;
    const txt = fs.readFileSync(out, 'utf8');
    rows = txt.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } finally { try { fs.unlinkSync(out); } catch { /* noop */ } }
  return rows;
}

/** SELECT arbitrario (con WHERE/JOIN) -> filas. */
function query(mdb, sql) {
  const out = tmpOut('q');
  runPs(READ_PS, ['-Mdb', mdb, '-Query', sql, '-Out', out]);
  return readJsonl(out);
}

/** Tabla completa (o proyección/filtro). */
function readTable(mdb, table, { columns = '*', where = '', orderBy = '' } = {}) {
  const out = tmpOut('t');
  const args = ['-Mdb', mdb, '-Table', table, '-Columns', columns, '-Out', out];
  if (where) args.push('-Where', where);
  if (orderBy) args.push('-OrderBy', orderBy);
  runPs(READ_PS, args);
  return readJsonl(out);
}

/** Formatea un valor de watermark para el WHERE de Jet. Números crudos; strings entre comillas. */
function fmtWatermark(v) {
  if (v === null || v === undefined) return '0';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return v; // numérico en string
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Carril incremental: filas con [sinceCol] > sinceVal. */
function readIncremental(mdb, table, { sinceCol, sinceVal, columns = '*' }) {
  if (!sinceCol) throw new Error('readIncremental requiere sinceCol');
  const where = `[${sinceCol}] > ${fmtWatermark(sinceVal)}`;
  return readTable(mdb, table, { columns, where, orderBy: `[${sinceCol}]` });
}

/** Descubre esquema: tablas + columnas + tipos Jet + PK best-effort + row counts. */
function discoverSchema(mdb, { pattern = '', noCounts = false } = {}) {
  const out = tmpOut('schema');
  const args = ['-Mdb', mdb, '-Out', out];
  if (pattern) args.push('-Pattern', pattern);
  if (noCounts) args.push('-NoCounts');
  runPs(SCHEMA_PS, args);
  const raw = readJsonl(out);
  // Normaliza el gotcha de PS 5.1 (array de 1 elemento se serializa como escalar).
  return raw.map((t) => ({
    table: t.table,
    rows: typeof t.rows === 'number' ? t.rows : -1,
    columns: Array.isArray(t.columns) ? t.columns : (t.columns ? [t.columns] : []),
    pk: Array.isArray(t.pk) ? t.pk : (t.pk ? [t.pk] : []),
  }));
}

/**
 * Tipo Postgres del ESPEJO CRUDO. Filosofía (FASE_WR §5 gotcha 3): tolerar valores corruptos
 * (CostoPromedio 2.29e16, ventas de $995 billones) -> numéricos sin precisión, fechas como texto
 * (Jet 1899 rompe pg timestamp). El saneamiento vive en silver, NO en la réplica cruda.
 */
function jetToPg(jetType) {
  switch (String(jetType)) {
    case 'Int16': case 'Int32': case 'Int64':
    case 'Byte': case 'SByte': case 'UInt16': case 'UInt32': case 'UInt64':
    case 'Double': case 'Single': case 'Decimal':
      return 'numeric';
    case 'Boolean':
      return 'boolean';
    case 'DateTime':
      return 'text';   // ISO string desde el PS; evita el rechazo de Jet-1899 por pg
    default:
      return 'text';   // String, Guid, byte[]->null, y cualquier tipo desconocido
  }
}

/** Hash estable de una fila para el carril hash-delta (md5 del JSON con claves ordenadas). */
function rowHash(row) {
  const keys = Object.keys(row).sort();
  const canon = keys.map((k) => `${k}=${row[k] === null || row[k] === undefined ? '' : row[k]}`).join('\u0001');
  return crypto.createHash('md5').update(canon).digest('hex');
}

module.exports = {
  PS32, READ_PS, SCHEMA_PS,
  query, readTable, readIncremental, discoverSchema,
  jetToPg, rowHash, fmtWatermark,
};
