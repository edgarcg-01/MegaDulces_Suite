/* eslint-disable no-console */
/**
 * `[AUTHZ.5]` — Candado de COBERTURA de autorización. Estático: lee el código, no toca la DB.
 *
 * Por qué existe. `RolesGuard` es global pero **no-op** en rutas sin `@RequirePermissions` (devuelve
 * `true` sin mirar nada, que es lo correcto para `@Public` y para rutas sólo-auth). Esa combinación
 * hace que **olvidarse del decorador no rompa nada visible**: la ruta simplemente queda abierta a
 * cualquier usuario autenticado. Así fue como los 8 controllers de Logística —flota, embarques,
 * guías, **nómina**, config, checklists, fotos y gastos— pasaron 9 sprints sin una sola línea de
 * autorización, con la puerta cerrada únicamente en el `permissionGuard` del frontend.
 *
 * Un test de runtime no sirve acá: habría que ejercitar 474 escrituras con N roles. Lo que se
 * vigila es la **forma del código**, que es donde vive el olvido.
 *
 * Verifica tres cosas:
 *   1. Toda ruta de ESCRITURA declara permiso, o está en la lista blanca CON MOTIVO escrito.
 *   2. El catálogo de permisos cuadra: enum back == enum front == permission-meta, y **ninguna
 *      clave queda fuera de `authz-tree`** (una clave invisible ahí no se puede otorgar desde
 *      `/admin/roles`, aunque el guard la exija — pasó con 4).
 *   3. CASL sigue retirado (ADR-054): cero `@casl` en el código.
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

/**
 * Rutas de escritura que a propósito son **sólo-auth**. Para entrar acá hace falta que la
 * operación sea self-scoped (el id sale del JWT, no del body) o que tenga su propio guard.
 * Agregar una fila sin motivo real es exactamente lo que este test existe para evitar.
 */
const PERMITIDAS = {
  'libs/trade/src/lib/catalogs/catalogs.controller.ts':
    'valida adentro con checkCatalogManageAccess() (clave exacta + platform-admin)',
  'apps/api/src/modules/tenants-admin/tenants-admin.controller.ts':
    'cross-tenant: PlatformAdminGuard (secreto de despliegue + sesión admin), no un permiso por-tenant',
  'libs/commercial/src/lib/commercial-push/commercial-push.controller.ts':
    'self-scoped: el userId/tenantId sale del contexto del JWT, nunca del body',
  'libs/trade/src/lib/supervisor-ai/supervisor-field.controller.ts':
    'self-scoped: acuses que se resuelven contra @ReqUser(), nadie puede acusar por otro',
  'libs/trade/src/lib/reports/reports.controller.ts':
    'route-pings: telemetría self-scoped de campo (decisión documentada en el propio método)',
};

// ── 1. Cobertura de rutas ────────────────────────────────────────────────────
const controllers = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); continue; }
    if (/\.controller\.ts$/.test(e.name)) controllers.push(f);
  }
};
walk(path.join(REPO, 'libs'));
walk(path.join(REPO, 'apps/api/src'));

const VERBO = /@(Get|Post|Put|Patch|Delete)\(/;
const DECOR = /@RequirePermissions\(|@RequireAnyPermission\(/;
const abiertas = [];
for (const f of controllers) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(REPO, f).replace(/\\/g, '/');
  const cabecera = src.slice(src.indexOf('@Controller'), src.indexOf('export class'));
  const permClase = DECOR.test(cabecera);
  const lineas = src.split('\n');
  for (let i = 0; i < lineas.length; i++) {
    if (!VERBO.test(lineas[i])) continue;
    if (lineas[i].includes('@Get(')) continue; // esta suite vigila ESCRITURAS
    let tienePerm = permClase, esPublic = false;
    for (let k = i + 1; k < Math.min(i + 12, lineas.length); k++) {
      if (VERBO.test(lineas[k])) break;
      if (DECOR.test(lineas[k])) tienePerm = true;
      if (/@Public\(\)/.test(lineas[k])) esPublic = true;
      if (/^\s*(async\s+)?[a-zA-Z_$]+\s*\(/.test(lineas[k]) && !/@/.test(lineas[k])) break;
    }
    for (let j = i - 1; j >= 0 && !VERBO.test(lineas[j]); j--) {
      if (DECOR.test(lineas[j])) tienePerm = true;
      if (/@Public\(\)/.test(lineas[j])) esPublic = true;
      if (/^\s*}\s*$/.test(lineas[j])) break;
    }
    if (!tienePerm && !esPublic) abiertas.push({ rel, line: i + 1 });
  }
}
const sinExcusa = abiertas.filter((r) => !PERMITIDAS[r.rel]);
console.log('\n[1] Cobertura de rutas de escritura');
ok(sinExcusa.length === 0,
  `toda escritura declara permiso (abiertas sin motivo: ${sinExcusa.length}${sinExcusa.length ? ' → ' + sinExcusa.slice(0, 8).map((r) => `${r.rel}:${r.line}`).join(', ') : ''})`);

// Los 8 de Logística, uno por uno: es el agujero que originó esta suite.
for (const m of ['fleet', 'shipments', 'guides', 'payroll', 'config', 'checklists', 'photos', 'expenses']) {
  const f = path.join(REPO, `libs/logistics/src/lib/logistics-${m}/logistics-${m}.controller.ts`);
  const src = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const rutas = (src.match(/@(Get|Post|Put|Patch|Delete)\(/g) || []).length;
  const gates = (src.match(/@Require(Any)?Permissions?\(/g) || []).length;
  ok(rutas > 0 && gates >= rutas, `logistics-${m}: ${gates}/${rutas} rutas con permiso`);
}

// La nómina es el más sensible: ninguna de sus rutas puede quedar sin permiso.
const payroll = fs.readFileSync(path.join(REPO, 'libs/logistics/src/lib/logistics-payroll/logistics-payroll.controller.ts'), 'utf8');
ok(/LOGISTICS_PAYROLL_GESTIONAR/.test(payroll) && /LOGISTICS_PAYROLL_VER/.test(payroll),
  'nómina de logística usa sus propios permisos (no los de otro módulo)');

// El guard cross-tenant existe y es fail-closed sin el secreto.
const guard = fs.readFileSync(path.join(REPO, 'apps/api/src/modules/tenants-admin/platform-admin.guard.ts'), 'utf8');
ok(/PLATFORM_ADMIN_KEY/.test(guard) && /if \(!expected\)/.test(guard),
  'PlatformAdminGuard: fail-closed cuando falta PLATFORM_ADMIN_KEY');
ok(/isPlatformAdminRole/.test(guard), 'PlatformAdminGuard exige además sesión de plataforma-admin');

// ── 2. Coherencia del catálogo ───────────────────────────────────────────────
const claves = (file, re) => new Set([...fs.readFileSync(path.join(REPO, file), 'utf8').matchAll(re)].map((m) => m[1]));
const back = claves('libs/platform-core/src/lib/constants/permissions.ts', /^  [A-Z0-9_]+ = '([A-Z0-9_]+)'/gm);
const front = claves('apps/view/src/app/core/constants/permissions.ts', /^  [A-Z0-9_]+ = '([A-Z0-9_]+)'/gm);
const tree = claves('apps/view/src/app/core/constants/authz-tree.ts', /Permission\.([A-Z0-9_]+)/g);
const meta = claves('apps/view/src/app/core/constants/permission-meta.ts', /\[Permission\.([A-Z0-9_]+)\]/g);
const falta = (a, b) => [...a].filter((k) => !b.has(k));

console.log('\n[2] Coherencia del catálogo de permisos');
ok(back.size === front.size && falta(back, front).length === 0 && falta(front, back).length === 0,
  `enum back (${back.size}) == enum front (${front.size})`);
ok(falta(back, meta).length === 0, `todos con label en permission-meta (sin label: ${falta(back, meta).join(', ') || '0'})`);
ok(falta(back, tree).length === 0,
  `ninguno INVISIBLE en /admin/roles — si el guard lo exige, tiene que poder otorgarse (invisibles: ${falta(back, tree).join(', ') || '0'})`);
ok(falta(tree, back).length === 0, `sin casillas muertas en authz-tree (huérfanas: ${falta(tree, back).join(', ') || '0'})`);

// ── 3. CASL sigue retirado (ADR-054) ─────────────────────────────────────────
console.log('\n[3] ADR-054: CASL retirado');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
ok(!pkg.dependencies?.['@casl/ability'] && !pkg.devDependencies?.['@casl/ability'], '@casl/ability fuera del package.json');
const conCasl = [];
const scan = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') scan(f); continue; }
    if (!/\.ts$/.test(e.name)) continue;
    if (/@casl/.test(fs.readFileSync(f, 'utf8'))) conCasl.push(path.relative(REPO, f));
  }
};
scan(path.join(REPO, 'libs'));
scan(path.join(REPO, 'apps'));
ok(conCasl.length === 0, `cero imports de @casl en el código (encontrados: ${conCasl.join(', ') || '0'})`);

console.log(`\n${fail === 0 ? '✅' : '❌'} AUTHZ cobertura: ${pass} ok, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
