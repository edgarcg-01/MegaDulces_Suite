#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[GP.A.2]` **Simulación de la migración de la bitácora contra la base de PRODUCCIÓN, con ROLLBACK.**
 *
 * Pedido de Edgar (2026-11-20): «apliquemos una simulación con la BD de producción». Corre, en UNA transacción de
 * pg-prod que al final se DESHACE:
 *   1. la migración REAL (`20261120145451_gpa2_bitacora_autorizacion_pedidos.js`, su `up`, dos veces: idempotente),
 *      sobre el esquema, los roles y la restricción que prod tiene HOY;
 *   2. como `app_runtime` (el rol de la API, con RLS), las verificaciones de la bitácora
 *      (`database/tests/_lib/bitacora-autorizacion.js`, las mismas de la prueba local) con las sentencias del servicio;
 *   3. ROLLBACK; y con OTRA conexión, en sólo lectura, el CONTROL: prod quedó igual que antes (la tabla no existe, la
 *      restricción es la misma, no hay renglones `autorizacion` ni la llave nueva). Si algo quedó, sale con código 2.
 *
 *   node ops/prod/simulacion-bitacora-autorizacion/simular.js
 *
 * Cómo le habla a prod: `pgprod.sh` en `md` (psql como postgres), una sola sesión por `ssh`, con un SAVEPOINT antes de
 * cada sentencia para que un error esperado (las pruebas negativas) no tire la transacción. ⚠️ `pgprod.sh` se come
 * las diagonales invertidas (y con ellas los `\echo` de psql): una sentencia con diagonal se rechaza antes de mandarse.
 *
 * Candados: `lock_timeout` de 3 s (si algo tiene tomada la tabla del interruptor, se rinde en vez de hacer cola),
 * `statement_timeout` de 20 s, y si el proceso se cae, psql cierra y Postgres deshace la transacción solo.
 */
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const SERVIDOR = 'superoot@192.168.0.222';
/** Sólo para probar ESTE script contra un Postgres desechable: el comando psql local (con -At). Sin él, va a prod. */
const LOCAL = process.env.SIM_PSQL_LOCAL || null;
const PSQL = LOCAL ? ['bash', ['-c', LOCAL + ' 2>&1']] : ['ssh', [SERVIDOR, 'sh ~/ops/prod/pgprod.sh -At 2>&1']];
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000aa';
const MIGRACION = path.join(RAIZ, 'database', 'migrations-newdb', '20261120145451_gpa2_bitacora_autorizacion_pedidos.js');
const { verificarBitacora } = require(path.join(RAIZ, 'database', 'tests', '_lib', 'bitacora-autorizacion.js'));

/** Un valor como literal de SQL. Sin diagonales: pgprod.sh las altera. */
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`número no finito: ${v}`); return String(v); }
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'object') return literal(JSON.stringify(v));
  return `'${String(v).replace(/'/g, "''")}'`;
}
const conValores = (sql, valores = []) => sql.replace(/\$(\d+)/g, (_, n) => {
  const i = Number(n) - 1;
  if (i >= valores.length) throw new Error(`falta el valor $${n}`);
  return literal(valores[i]);
});
const codigoDe = (msg) => /duplicate key/.test(msg) ? '23505'
  : /violates check constraint/.test(msg) ? '23514'
  : /permission denied/.test(msg) ? '42501'
  : /violates not-null/.test(msg) ? '23502'
  : /lock timeout|canceling statement due to lock/.test(msg) ? '55P03'
  : 'XX000';

/** Una sesión de psql abierta en pg-prod, por ssh; `query` devuelve `{ rows, rowCount, command }` o lanza con `code`. */
class SesionProd {
  constructor() {
    this.p = spawn(PSQL[0], PSQL[1], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.lineas = []; this.esperando = null; this.k = 0; this.sentencias = 0;
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) { this.lineas.push(this.buf.slice(0, i).replace(/\r$/, '')); this.buf = this.buf.slice(i + 1); }
      this.revisar();
    });
    this.p.on('exit', (code) => { this.cerrada = code ?? -1; this.revisar(); });
  }
  revisar() {
    if (!this.esperando) return;
    const { fin, resolver, rechazar } = this.esperando;
    const j = this.lineas.findIndex(fin);
    if (j >= 0) { const out = this.lineas.splice(0, j + 1); this.esperando = null; resolver(out); }
    else if (this.cerrada !== undefined) { this.esperando = null; rechazar(new Error(`la sesión con prod se cerró (${this.cerrada}): ${this.lineas.join(' | ')}`)); }
  }
  /** Manda texto y junta lo que imprime hasta la línea que cumple `fin`. */
  intercambio(texto, fin) {
    if (/\\/.test(texto)) return Promise.reject(new Error('sentencia con diagonal invertida: pgprod.sh la alteraría'));
    return new Promise((resolver, rechazar) => {
      this.esperando = { fin, resolver, rechazar };
      this.p.stdin.write(`${texto}\n`);
      this.revisar();
    });
  }
  async marca(texto) {
    const m = `<<FIN ${++this.k}>>`;
    return this.intercambio(`${texto}\nSELECT '${m}';`, (l) => l === m);
  }
  async query(sql, valores = []) {
    const texto = conValores(sql.trim().replace(/;\s*$/, ''), valores);
    const filas = /^\s*(select|with)\b/i.test(texto) || /\breturning\b/i.test(texto);
    const cuerpo = filas ? `WITH q AS (${texto}) SELECT coalesce(jsonb_agg(q), '[]'::jsonb) FROM q` : texto;
    const k = ++this.k; const m = `<<FIN ${k}>>`;
    this.sentencias++;
    const out = await this.intercambio(`SAVEPOINT sim_${k};\n${cuerpo};\nSELECT '${m}';`,
      (l) => l === m || /current transaction is aborted/.test(l));
    const err = out.find((l) => /^ERROR:/.test(l) && !/current transaction is aborted/.test(l));
    if (out[out.length - 1] !== m) await this.marca(`ROLLBACK TO SAVEPOINT sim_${k};`);
    if (err) { const msg = err.replace(/^ERROR:\s*/, ''); throw Object.assign(new Error(msg), { code: codigoDe(msg) }); }
    const utiles = out.slice(0, -1).filter((l) => l && l !== 'SAVEPOINT' && !/^(NOTICE|WARNING|AVISO|NOTA|ADVERTENCIA):/.test(l));
    if (filas) {
      const json = utiles.find((l) => l.startsWith('['));
      const rows = json ? JSON.parse(json) : [];
      return { rows, rowCount: rows.length, command: 'SELECT' };
    }
    const tag = utiles[utiles.length - 1] || '';
    const n = tag.match(/(\d+)\s*$/);
    return { rows: [], rowCount: n ? Number(n[1]) : 0, command: tag.split(' ')[0] };
  }
  async terminar() { this.p.stdin.end(); await new Promise((r) => (this.cerrada !== undefined ? r() : this.p.on('exit', r))); }
}

/** Knex con el dialecto de Postgres, pero cada sentencia va a la sesión de prod (la misma transacción). */
function knexSobre(sesion) {
  const PG = require(path.join(RAIZ, 'node_modules', 'knex', 'lib', 'dialects', 'postgres'));
  class ClienteSesion extends PG {
    async acquireConnection() { return { __knexUid: 'sesion-prod' }; }
    releaseConnection() { return Promise.resolve(); }
    async _query(_c, obj) { obj.response = await sesion.query(obj.sql, obj.bindings || []); return obj; }
  }
  return require(path.join(RAIZ, 'node_modules', 'knex'))({ client: ClienteSesion });
}

/** La foto de lo que la migración toca, en sólo lectura y con otra conexión. */
function foto() {
  const sql = `SET default_transaction_read_only = on;
SELECT jsonb_build_object(
  'sysid', (SELECT system_identifier::text FROM pg_control_system()),
  'tabla', to_regclass('finance.order_authorizations') IS NOT NULL,
  'check', (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'commercial.kepler_push_switch'::regclass AND conname = 'kepler_push_switch_tipo_ck'),
  'renglones', (SELECT count(*) FROM commercial.kepler_push_switch WHERE tipo = 'autorizacion'),
  'llave', (SELECT count(*) FROM identity.role_permissions WHERE permissions -> 'FINANCE_PEDIDOS_AUTORIZAR' IS NOT NULL),
  'migracion', (SELECT count(*) FROM public.knex_migrations WHERE name LIKE '20261120145451%'));`;
  const out = execFileSync(PSQL[0], PSQL[1], { input: sql, encoding: 'utf8' });
  return JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).pop());
}

async function main() {
  let ok = 0, fail = 0, nm = 0;
  const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
  const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
  const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };

  console.log(LOCAL ? 'DESTINO: Postgres LOCAL (prueba del script)' : 'DESTINO: pg-prod en md (con ROLLBACK)');
  const antes = foto();
  console.log(`ANTES: ${JSON.stringify(antes)}`);
  if (antes.tabla || antes.migracion > 0) throw new Error('la migración ya está en prod: esto es para ANTES de aplicarla');

  const s = new SesionProd();
  const t0 = Date.now();
  let usuario = '?';
  try {
    await s.marca(`SET application_name = 'simulacion-gpa2-rollback';\nBEGIN;\nSET LOCAL lock_timeout = '3s';\nSET LOCAL statement_timeout = '20s';`);
    const knex = knexSobre(s);
    const m = require(MIGRACION);
    console.log('\n== la migración real, dentro de la transacción (dos veces: idempotente)');
    await m.up(knex);
    await m.up(knex);
    console.log('\n== las verificaciones de la bitácora, como app_runtime');
    await s.query('SET LOCAL ROLE app_runtime');
    usuario = (await s.query('SELECT current_user AS u')).rows[0].u;
    await verificarBitacora(s, { P, F, NM }, { tenant: TENANT, otro: OTRO, usuario });
  } catch (e) {
    F(`la simulación se detuvo: ${e.message}`);
  } finally {
    await s.marca('ROLLBACK;').catch(() => undefined);
    await s.terminar();
  }
  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO · ${s.sentencias} sentencias en ${Date.now() - t0} ms · sesión ${usuario}`);

  const despues = foto();
  const igual = JSON.stringify(antes) === JSON.stringify(despues);
  console.log(`\nCONTROL (otra conexión, sólo lectura): ${igual ? 'prod quedó IGUAL que antes (se deshizo todo)' : '⛔ prod CAMBIÓ'}`);
  console.log(`DESPUÉS: ${JSON.stringify(despues)}`);
  if (!igual) process.exit(2);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
