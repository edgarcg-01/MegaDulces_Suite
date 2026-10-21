/* eslint-disable no-console */
/**
 * `[CSU.10]` Lo común de las pruebas de Cortes/Sucursales: sacar la SQL REAL del servicio (la
 * vigente del árbol y la de un commit anterior, sin copiarla a mano), y correr el camino nuevo
 * completo (consulta de cortes + consulta única de cobros + casado en memoria) igual que el servicio.
 *
 * ⚠️ El casado en memoria de `nueva()` replica `CortesSucursalesService.completarCobros`. Si cambias
 * uno, cambia el otro: la paridad compararía contra una lógica que ya no existe.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../../..');
const REL = 'libs/finance/src/lib/cortes-sucursales/cortes-sucursales.service.ts';
/** `origin/main` justo antes de CSU.10: la versión con un LATERAL por corte. */
const ANTES_CSU10 = 'ceaa4d6d2';
const TENANT = '00000000-0000-0000-0000-00000000d01c';

/** Extrae `const <nombre> = \`…\`;` y pasa los `?` de knex a `$n` de pg. */
function sacar(src, nombre) {
  const m = src.match(new RegExp(`const ${nombre} = \`([\\s\\S]*?)\`;`));
  if (!m) throw new Error(`no encontré const ${nombre} en ${REL}`);
  // Un acento grave adentro CIERRA el template literal del .ts: el archivo no compila, pero este
  // regex lo saltaría y Postgres ignoraría el comentario — la paridad daría verde sobre código roto.
  // Medido en CSU.10: pasó con «-- … `a` …» y lo atrapó el pre-push (sql-backticks + boundary).
  if (m[1].includes('`')) throw new Error(`const ${nombre} contiene un acento grave: rompe el template literal del .ts`);
  let i = 0;
  return m[1].replace(/\?/g, () => `$${++i}`);
}

function sqlVieja(ref = ANTES_CSU10) {
  return sacar(execSync(`git show ${ref}:${REL}`, { cwd: REPO, encoding: 'utf8' }), 'SQL');
}

function sqlNueva() {
  const src = fs.readFileSync(path.join(REPO, REL), 'utf8');
  return { SQL: sacar(src, 'SQL'), SQL_COBROS: sacar(src, 'SQL_COBROS') };
}

/** Parámetros de la SQL vieja (8) y de la nueva (7), para "todas las sucursales". */
const paramsVieja = (from, to) => [from, to, true, [], from, to, TENANT, TENANT];
const paramsNueva = (from, to) => [from, to, true, [], from, to, TENANT];

/** El camino nuevo completo. Devuelve las filas y el tiempo de cada tramo. */
async function nueva(c, sql, from, to) {
  const t0 = Date.now();
  const filas = (await c.query(sql.SQL, paramsNueva(from, to))).rows;
  const t1 = Date.now();
  const sucs = new Set(), pre = new Set(), fol = new Set();
  for (const f of filas) for (const x of f.cobros || []) { sucs.add(f.sucursal); pre.add(x.doc_prefix); fol.add(x.folio); }
  const det = new Map();
  if (fol.size) {
    for (const x of (await c.query(sql.SQL_COBROS, [TENANT, [...sucs], [...pre], [...fol]])).rows) {
      det.set(`${x.sucursal}|${x.doc_prefix}|${x.folio}`, x);
    }
  }
  for (const f of filas) {
    if (!f.cobros) continue;
    f.cobros = f.cobros.map((x) => {
      const d = det.get(`${f.sucursal}|${x.doc_prefix}|${x.folio}`);
      return { ...x, fecha: d?.fecha ?? null, forma_pago: d?.forma_pago ?? null, concepto: d?.concepto ?? null,
        medio_cobro: d?.medio_cobro ?? null, cuenta_tesoreria: d?.cuenta_tesoreria ?? null };
    });
  }
  return { filas, ms: Date.now() - t0, msCortes: t1 - t0, msCobros: Date.now() - t1 };
}

/** JSON con llaves ordenadas: jsonb y JS no ordenan las llaves igual. */
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const iguales = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const mediana = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Diferencias fila por fila (las primeras `max`). */
function diferencias(a, b, max = 5) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < max; i++) {
    const x = JSON.stringify(canon(a[i])), y = JSON.stringify(canon(b[i]));
    if (x !== y) out.push(` vieja ${x}\n nueva ${y}`);
  }
  return out;
}

/**
 * Las pruebas locales ESCRIBEN (en una transacción con ROLLBACK): sólo contra localhost.
 * La clave va en PGPASSWORD, no en la URL ni en el repo.
 */
function urlLocal() {
  const url = process.env.LOCAL_DB_URL || 'postgresql://postgres@127.0.0.1:5442/postgres_platform';
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`LOCAL_DB_URL apunta a ${host}: estas pruebas cargan datos y sólo corren contra localhost`);
  }
  return url;
}

/** La base local va atrasada: estas migraciones dan a la vista erp_collections su forma de CSU.8. */
async function vistaCobrosAlDia(c) {
  for (const mig of ['20261006160000_caja_vistas_anclaje_y_definer.js', '20261009174500_erp_collections_banco_deposito.js']) {
    await c.query('SAVEPOINT vista');
    try {
      await require(path.join(REPO, 'database/migrations-newdb', mig)).up({ raw: (sql, b) => c.query(sql, b) });
      await c.query('RELEASE SAVEPOINT vista');
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT vista');
      console.log(`  (vista) ${mig} no aplicó: ${e.message}`);
    }
  }
  const n = (await c.query(`SELECT count(*)::int n FROM information_schema.columns
     WHERE table_schema = 'analytics' AND table_name = 'erp_collections' AND column_name IN ('medio_cobro', 'cuenta_tesoreria')`)).rows[0].n;
  if (n !== 2) throw new Error('la vista local analytics.erp_collections no tiene medio_cobro/cuenta_tesoreria');
}

module.exports = {
  REPO, REL, ANTES_CSU10, TENANT, sqlVieja, sqlNueva, paramsVieja, paramsNueva, nueva,
  canon, iguales, mediana, diferencias, urlLocal, vistaCobrosAlDia,
};
