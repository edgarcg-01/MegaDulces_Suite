'use strict';
/**
 * Bootstrap del destino de una RÉPLICA CRUDA Access → Postgres, compartido (ADR-056).
 *
 * Nació como `wincaja/wincaja-replica-ddl.js` (Fase WR.2) y se subió acá con el motor
 * (`access-replicate.js`) cuando la Fase CG necesitó el mismo carril para `BDatos.mdb`.
 *
 *   1) asegura la DB destino (CREATE DATABASE si falta).
 *   2) por sucursal: CREATE SCHEMA + un CREATE TABLE espejo por cada tabla del .mdb
 *      (tipos vía access-mirror.jetToPg, PK natural o UNIQUE(_row_hash)).
 *
 * On-prem (Jet 32-bit + el share viven en la máquina de feeds). NO en Railway.
 */
const path = require('path');
const { Client } = require('pg');
const A = require(path.join(__dirname, 'access-adapter'));
const { mirrorDDL, conflictTarget } = require(path.join(__dirname, 'access-mirror'));

/**
 * `PK_OVERRIDE` — declarar la identidad de una tabla que el ORIGEN no declara.
 *
 * Access no siempre trae PK. El espejo entonces cae en el surrogate `UNIQUE(_row_hash)` con
 * `DO NOTHING`, que es correcto para movimientos INMUTABLES… y está MAL para una tabla que MUTA:
 * al cambiar cualquier columna cambia el hash, el UPSERT inserta una fila NUEVA y la vieja se
 * queda. El espejo acumula las dos versiones del mismo hecho.
 *
 * Lo destapó CG.9 con `Doctos`: su bandera `Corte` se prende DESPUÉS de capturar. Sin esto, cada
 * movimiento capturado y cortado el mismo día entraría dos veces.
 *
 * ⚠️ REGLAS, porque una identidad mal elegida hace daño en las dos direcciones:
 *   · Las columnas tienen que EXISTIR (se valida acá: una columna mal escrita daría una PK que
 *     Postgres rechaza al crear la tabla, o peor, un conflict target que nunca hace match).
 *   · Las columnas NO pueden ser de las que mutan — si lo son, vuelve el mismo bug.
 *   · Y la combinación tiene que ser ÚNICA sobre el corpus REAL, medido, no supuesto: si colapsa
 *     filas, el espejo deja de ser espejo.
 */
function aplicarPkOverride(t, cfg) {
  const ov = (cfg.PK_OVERRIDE || {})[t.table];
  if (!ov || !ov.length) return t;
  const nombres = new Set((t.columns || []).map((c) => c && c.name));
  const faltan = ov.filter((c) => !nombres.has(c));
  if (faltan.length) {
    // Silencio no: una identidad que no se pudo aplicar deja el surrogate puesto y el bug vivo.
    console.warn(`  ⚠️ ${t.table}: PK_OVERRIDE menciona columnas que no existen (${faltan.join(', ')}) `
      + '→ se ignora y queda el surrogate _row_hash. REVISAR: la tabla sigue sin soportar mutación.');
    return t;
  }
  // `_pkDeclarada` avisa al generador de DDL que esta identidad la pusimos nosotros, no la
  // fuente → va como UNIQUE NULLS NOT DISTINCT, no como PRIMARY KEY (ver access-mirror.js).
  return { ...t, pk: ov, _pkDeclarada: true };
}

/** Descubre el esquema de todos los archivos de la sucursal y devuelve tablas únicas. */
function discoverBranch(b, cfg = {}) {
  const files = [b.mdb, b.mov].filter(Boolean);
  const seen = new Map();
  for (const f of files) {
    let sc;
    try { sc = A.discoverSchema(f, { noCounts: true }); }
    catch (e) { console.warn(`  ⚠️ no pude leer ${path.basename(f)}: ${e.message}`); continue; }
    for (const t of sc) { if (t.columns.length && !seen.has(t.table)) seen.set(t.table, aplicarPkOverride(t, cfg)); }
  }
  return [...seen.values()];
}

/**
 * @param {object} cfg  BRANCHES, REPLICA_URL, ADMIN_URL, watermarkCol, REPLICA_DB, label
 */
function run(cfg, argv = process.argv) {
  const DRY = argv.includes('--dry');
  const APPLY = argv.includes('--apply');
  const branchArg = (argv.find((a) => a.startsWith('--branch=')) || '').split('=')[1];
  const DB = cfg.REPLICA_DB;

  async function ensureDatabase() {
    const c = new Client({ connectionString: cfg.ADMIN_URL, statement_timeout: 30000 });
    await c.connect();
    try {
      const r = await c.query('SELECT 1 FROM pg_database WHERE datname=$1', [DB]);
      if (r.rowCount) { console.log(`  DB ${DB}: ya existe`); return; }
      if (APPLY) { await c.query(`CREATE DATABASE "${DB}"`); console.log(`  DB ${DB}: ✓ CREATE DATABASE`); }
      else console.log(`  DB ${DB}: (falta — se crearía con --apply)`);
    } finally { await c.end(); }
  }

  async function ddlBranch(b) {
    console.log(`\n=== ${b.code} ${b.name} → schema ${b.schema} ===`);
    const tables = discoverBranch(b, cfg);
    const ddls = tables.map((t) => ({ t, sql: mirrorDDL(b.schema, t) })).filter((x) => x.sql);
    const inc = tables.filter((t) => cfg.watermarkCol(t.table)).length;
    console.log(`  ${ddls.length} tablas con estructura (${inc} incremental / ${ddls.length - inc} hash-delta)`);

    if (DRY) {
      console.log(`\nCREATE SCHEMA IF NOT EXISTS "${b.schema}";\n`);
      for (const { t, sql } of ddls.slice(0, 4)) {
        console.log(`-- carril=${cfg.watermarkCol(t.table) ? 'incremental(' + cfg.watermarkCol(t.table) + ')' : 'hash-delta'}  conflict=[${conflictTarget(t).join(',')}]`);
        console.log(sql, '\n');
      }
      if (ddls.length > 4) console.log(`... (${ddls.length - 4} tablas más con el mismo patrón)`);
      return;
    }
    if (APPLY) {
      const c = new Client({ connectionString: cfg.REPLICA_URL, statement_timeout: 60000 });
      await c.connect();
      try {
        await c.query(`CREATE SCHEMA IF NOT EXISTS "${b.schema}"`);
        let n = 0;
        for (const { t, sql } of ddls) { try { await c.query(sql); n++; } catch (e) { console.warn(`  ⚠️ ${t.table}: ${e.message}`); } }
        console.log(`  ✓ ${n}/${ddls.length} tablas espejo en ${b.schema}`);
      } finally { await c.end(); }
    }
  }

  return (async () => {
    const mode = DRY ? 'DRY' : APPLY ? 'APPLY' : 'sin acción (usa --dry o --apply)';
    console.log(`=== ${cfg.label} (${mode}) ===`);
    await ensureDatabase();
    if (!DRY && !APPLY) return;
    const list = branchArg ? cfg.BRANCHES.filter((b) => b.code === branchArg) : cfg.BRANCHES;
    if (!list.length) { console.log(`  (sin sucursal ${branchArg})`); return; }
    for (const b of list) await ddlBranch(b);
    console.log('\nlisto.');
  })().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
}

module.exports = { run, discoverBranch };
