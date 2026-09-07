/* eslint-disable no-console */
/**
 * `[W3]` CANDADO — el alcance por tenant es fail-CLOSED, no fail-open.
 *
 * ── Qué protege ────────────────────────────────────────────────────────────────────────────
 * El patrón `if (tenantId) q.where('tenant_id', tenantId)` es fail-**OPEN**: cuando el tenant viene
 * vacío la query corre SIN alcance. Y lo que lo vuelve peligroso no es la fealdad: esos services
 * inyectan `KNEX_CONNECTION`, que conecta como `postgres` (superuser), y
 * `FORCE ROW LEVEL SECURITY` **no aplica a superusers ni a `BYPASSRLS`** — el filtro manual es la
 * ÚNICA defensa. En `analytics.*` no hay RLS en absoluto (1 de 60 tablas), así que tampoco la habría
 * con el pool `app_runtime`.
 *
 * Con un solo tenant con datos nunca se manifestó. Es un arma cargada esperando al segundo tenant.
 *
 * ── Los cuatro bloques ─────────────────────────────────────────────────────────────────────
 *   1. `requireTenantOf` existe y LANZA — se carga el .ts real, no una copia.
 *   2. Ningún helper `tenantId(...)` declara `string | undefined` (eran 15).
 *   3. ⭐ PRUEBA NEGATIVA de W3.2: el lookup de permisos sin tenant devuelve CERO, no los de otro
 *      tenant. Se corre con el rol que de verdad está duplicado entre tenants — si no lo estuviera,
 *      el bloque se declara NO MEDIDO en vez de pasar en vacío.
 *   4. Las escrituras de los caminos ya arreglados siguen llevando `tenant_id` en el WHERE.
 *
 * Read-only: no escribe una fila. Apunta a `DATABASE_URL_NEW`.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-authz-tenant-failclosed.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..', '..');
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0; let skip = 0;
const chk = (cond, msg) => {
  if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { fail++; console.log(`  ✖ ${msg}`); }
};
const nomedido = (msg) => { skip++; console.log(`  ◻ NO MEDIDO — ${msg}`); };

/** Los ficheros que NO deben volver a declarar el helper fail-open. */
function grepRepo(re, dirs) {
  const hits = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        const txt = fs.readFileSync(p, 'utf8');
        txt.split(/\r?\n/).forEach((ln, i) => {
          if (re.test(ln)) hits.push(`${path.relative(ROOT, p)}:${i + 1}`);
        });
      }
    }
  };
  dirs.forEach((d) => walk(path.join(ROOT, d)));
  return hits;
}

(async () => {
  console.log('\n=== W3 — alcance por tenant fail-CLOSED ===\n');

  // ── 1. el helper existe y lanza ──────────────────────────────────────────────────────────
  const helperPath = path.join(ROOT, 'libs/platform-core/src/lib/tenant/require-tenant.ts');
  chk(fs.existsSync(helperPath), 'existe libs/platform-core/.../require-tenant.ts');
  if (fs.existsSync(helperPath)) {
    const src = fs.readFileSync(helperPath, 'utf8');
    chk(/export function requireTenantOf/.test(src), 'exporta requireTenantOf');
    chk(/throw new ForbiddenException/.test(src), 'LANZA (ForbiddenException) en vez de devolver vacío');
    // ⚠️ La aserción mira SÓLO la línea del `export function`. La primera versión de este candado
    // buscaba `string | undefined` en todo el archivo y fallaba, porque el JSDoc de
    // require-tenant.ts CITA la firma vieja para explicar qué reemplaza. Un candado que confunde
    // un comentario con el código es un falso rojo, y un falso rojo se acaba silenciando.
    const firma = (src.split(/\r?\n/).find((l) => /export function requireTenantOf/.test(l)) || '');
    chk(/\)\s*:\s*string\s*\{/.test(firma) && !/undefined/.test(firma),
      `su firma devuelve string, nunca string | undefined  (${firma.trim().slice(0, 80)})`);
  }

  // ── 2. cero helpers fail-open ────────────────────────────────────────────────────────────
  // El propio require-tenant.ts cita la firma vieja en su comentario: se excluye por ruta.
  const malos = grepRepo(/tenantId\s*\([^)]*\)\s*:\s*string\s*\|\s*undefined/, ['libs', 'apps'])
    .filter((h) => !h.includes('require-tenant.ts'));
  chk(malos.length === 0,
    `ningún helper declara \`string | undefined\` (encontrados: ${malos.length ? malos.join(', ') : 'ninguno'})`);

  // ── 3. PRUEBA NEGATIVA de W3.2 ───────────────────────────────────────────────────────────
  const c = new Client({
    connectionString: URL,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
    statement_timeout: 60000,
  });
  await c.connect();
  console.log(`\n  destino: ${(await c.query('select current_database() d')).rows[0].d}\n`);

  const nn = await c.query(
    `select is_nullable from information_schema.columns
      where table_schema='identity' and table_name='role_permissions' and column_name='tenant_id'`);
  chk(nn.rows[0]?.is_nullable === 'NO',
    'identity.role_permissions.tenant_id es NOT NULL → el "IS NULL" del camino sin tenant no puede casar nunca');

  const dup = await c.query(
    `select lower(role_name) rol, count(distinct tenant_id)::int tenants
       from identity.role_permissions group by 1 having count(distinct tenant_id) > 1
      order by 2 desc, 1 limit 1`);
  if (!dup.rows.length) {
    nomedido('ningún role_name está duplicado entre tenants hoy: la prueba negativa no tendría con qué morder. Vuelve a medir cuando entre el 2º tenant con roles.');
  } else {
    const rol = dup.rows[0].rol;
    console.log(`  (rol duplicado en ${dup.rows[0].tenants} tenants: "${rol}")`);
    // ANTES: sin filtro, `.first()` es LIMIT 1 sin ORDER BY → elige una fila cualquiera.
    const antes = await c.query(
      `select count(*)::int n from identity.role_permissions where lower(role_name) = $1`, [rol]);
    chk(antes.rows[0].n > 1,
      `sin filtro de tenant el lookup ve ${antes.rows[0].n} filas → \`.first()\` elegía cross-tenant`);
    // AHORA: el camino sin tenant exige tenant_id IS NULL.
    const ahora = await c.query(
      `select count(*)::int n from identity.role_permissions
        where lower(role_name) = $1 and tenant_id is null`, [rol]);
    chk(ahora.rows[0].n === 0,
      'con la regla nueva el camino sin tenant devuelve 0 filas → cero permisos (fail-closed)');
    // El camino SANO no cambia.
    const sano = await c.query(
      `select count(*)::int n from identity.role_permissions
        where lower(role_name) = $1 and tenant_id = (select id from identity.tenants where slug = 'mega_dulces')`, [rol]);
    chk(sano.rows[0].n === 1, 'el camino SANO (con tenant explícito) sigue dando exactamente 1 fila');
  }

  // ── 4. las escrituras arregladas siguen scopeadas ────────────────────────────────────────
  const casos = [
    ['libs/platform-core/src/lib/ability/permissions-cache.service.ts', /else q\.whereNull\('tenant_id'\)/,
      'permissions-cache: el camino sin tenant exige tenant_id IS NULL'],
    ['libs/trade/src/lib/reports/reports.service.ts', /const baseWhere[^\n]*tenant_id: tenantId/,
      'reports.deleteReport: el WHERE del SELECT y del DELETE lleva tenant_id sin condicional'],
    ['libs/trade/src/lib/supervisor-ai/scoring-engine.service.ts', /\.where\(\{ id: u\.id, tenant_id: tenantId \}\)/,
      'scoring-engine: el UPDATE de execution_360 lleva tenant_id'],
  ];
  console.log('');
  for (const [rel, re, msg] of casos) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) { nomedido(`${rel} no existe (¿se movió?)`); continue; }
    chk(re.test(fs.readFileSync(p, 'utf8')), msg);
  }

  // Y que nadie reintroduzca el fail-open en deleteReport.
  const rep = path.join(ROOT, 'libs/trade/src/lib/reports/reports.service.ts');
  if (fs.existsSync(rep)) {
    chk(!/if \(tenantId\) baseWhere\['tenant_id'\]/.test(fs.readFileSync(rep, 'utf8')),
      '⛔ deleteReport NO volvió al filtro condicional');
  }

  await c.end();
  console.log(`\n=== ${ok} OK · ${fail} FAIL${skip ? ` · ${skip} NO MEDIDO` : ''} ===\n`);
  if (fail) process.exitCode = 1;
})().catch((e) => {
  console.error('FALLO:', e.message);
  process.exitCode = 1;
});
