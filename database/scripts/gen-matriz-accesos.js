/**
 * Genera `docs/MATRIZ_ACCESOS.md`: la matriz de accesos y restricciones por puesto.
 *
 * Por qué es un generador y no un documento a mano: el permiso que de verdad tiene un rol vive en
 * `identity.role_permissions` de PROD (lo reparten migraciones y la pantalla /admin/roles), no en
 * las plantillas de `role-presets.ts` — medido el 2026-10-05, las plantillas ya no se parecen a
 * los roles vivos (37 roles en prod, 13 plantillas, casi ningún nombre coincide). Una matriz
 * escrita a mano se habría quedado vieja con la primera migración de reparto.
 *
 * Fuentes:
 *   - Código: `libs/contracts/src/authz/authz-tree.ts` (App → Proyecto → Módulo → Ver/Gestionar)
 *     y `permission-meta.ts` (etiqueta de cada permiso).
 *   - Prod, en sesión de SÓLO LECTURA (`default_transaction_read_only=on`): puestos,
 *     departamentos, roles, roles complementarios, ajustes por persona y alcances.
 *
 * ⛔ El repo es PÚBLICO: el documento lleva CONTEOS de personas, nunca nombres ni usuarios.
 *
 * Uso:  npm run docs:matriz-accesos        (usa DATABASE_URL_NEW, o PROD_DB_URL si está)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ quiet: true });
const ts = require('typescript');
const { Client } = require('pg');

const REPO = path.resolve(__dirname, '../..');
const AUTHZ = path.join(REPO, 'libs/contracts/src/authz');
const OUT = path.join(REPO, 'docs/MATRIZ_ACCESOS.md');
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const PLATFORM_ADMIN_ROLES = new Set(['superadmin', 'admin']); // = platform-admin.ts

// ── 1. Cargar el árbol de autorización del código (TS → JS en un temporal) ──────────────────────
function loadContracts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authz-'));
  // Se transpila la carpeta entera (sin specs): los archivos se importan entre sí con rutas `./`.
  const files = fs.readdirSync(AUTHZ).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => f.slice(0, -3));
  for (const f of files) {
    const src = fs.readFileSync(path.join(AUTHZ, `${f}.ts`), 'utf8');
    const { outputText } = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    fs.writeFileSync(path.join(dir, `${f}.js`), outputText);
  }
  return {
    ...require(path.join(dir, 'authz-tree.js')),
    ...require(path.join(dir, 'permission-meta.js')),
  };
}

// ── 2. Leer prod (sólo lectura) ────────────────────────────────────────────────────────────────
async function loadProd() {
  const url = process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
  if (!url) throw new Error('Falta PROD_DB_URL o DATABASE_URL_NEW');
  const c = new Client({ connectionString: url, options: '-c default_transaction_read_only=on' });
  await c.connect();
  // Un solo `Client` no admite consultas en paralelo: se encadenan aunque abajo vayan en Promise.all.
  let cola = Promise.resolve();
  const enCola = (fn) => (cola = cola.then(fn, fn));
  const q = (sql) => enCola(() => c.query(sql, [TENANT]).then((r) => r.rows));
  try {
    const [roles, positions, departments, users, userRoles, overrides, scopes, mig] = await Promise.all([
      q(`SELECT lower(role_name) AS role, permissions FROM identity.role_permissions
          WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY 1`),
      q(`SELECT code, name, department_code, nivel, orden, lower(default_role) AS default_role,
                coalesce(default_complements, '{}') AS default_complements
           FROM identity.positions WHERE tenant_id = $1 AND deleted_at IS NULL`),
      q(`SELECT code, name, scope_axis, orden FROM identity.departments
          WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY orden`),
      q(`SELECT id, lower(role_name) AS role, position_code, department_code FROM identity.users
          WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active'`),
      q(`SELECT ur.user_id, lower(ur.role_name) AS role FROM identity.user_roles ur
           JOIN identity.users u ON u.id = ur.user_id AND u.deleted_at IS NULL AND u.status = 'active'
          WHERE ur.tenant_id = $1`),
      q(`SELECT up.permission_key, up.allow FROM identity.user_permissions up
           JOIN identity.users u ON u.id = up.user_id AND u.deleted_at IS NULL AND u.status = 'active'
          WHERE up.tenant_id = $1`),
      q(`SELECT lower(role_name) AS role, dimension, mode, mode_write FROM identity.role_scopes
          WHERE tenant_id = $1 ORDER BY 1, 2`),
      enCola(() => c.query(`SELECT max(name) AS m FROM public.knex_migrations`).then((r) => r.rows)),
    ]);
    return { roles, positions, departments, users, userRoles, overrides, scopes, lastMig: mig[0]?.m };
  } finally {
    await c.end().catch(() => undefined);
  }
}

// ── 3. Armar el documento ──────────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const table = (head, rows) =>
  rows.length === 0
    ? '_(sin filas)_\n'
    : [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n') + '\n';

/** Permisos sensibles: los que separan funciones (quien prepara ≠ quien autoriza). */
const SENSITIVE = /(AUTORIZAR|VALIDAR|APROBAR|REVERSAR|PASSWORDS|ROLES_CONFIGURAR|SUPERVISAR|RECONCILIAR|USUARIOS_GESTIONAR)/;

function build({ AUTHZ_TREE, LEGACY_PERMISSIONS, PERMISSION_META }, db) {
  const grants = new Map(); // role -> Set(perm)
  for (const r of db.roles) {
    grants.set(r.role, new Set(Object.entries(r.permissions || {}).filter(([, v]) => v === true).map(([k]) => k)));
  }
  const isAdmin = (role) => PLATFORM_ADMIN_ROLES.has(role);
  const has = (role, perm) => isAdmin(role) || grants.get(role)?.has(perm);
  const label = (p) => PERMISSION_META[p]?.label ?? p;

  // Personas por rol (principal / complemento) y por puesto
  const primaryCount = new Map();
  for (const u of db.users) primaryCount.set(u.role, (primaryCount.get(u.role) || 0) + 1);
  const userById = new Map(db.users.map((u) => [u.id, u]));
  const complCount = new Map();
  const extraRolesByUser = new Map();
  for (const ur of db.userRoles) {
    const u = userById.get(ur.user_id);
    if (!u || ur.role === u.role) continue;
    complCount.set(ur.role, (complCount.get(ur.role) || 0) + 1);
    if (!extraRolesByUser.has(u.id)) extraRolesByUser.set(u.id, new Set());
    extraRolesByUser.get(u.id).add(ur.role);
  }
  const proposedBy = new Map(); // role -> [position names]
  for (const p of db.positions) {
    for (const r of [p.default_role, ...p.default_complements.map((x) => x.toLowerCase())].filter(Boolean)) {
      if (!proposedBy.has(r)) proposedBy.set(r, []);
      proposedBy.get(r).push(p.name);
    }
  }
  const scopesByRole = new Map();
  for (const s of db.scopes) {
    if (!scopesByRole.has(s.role)) scopesByRole.set(s.role, []);
    scopesByRole.get(s.role).push(`${s.dimension}:${s.mode}${s.mode_write ? `/esc:${s.mode_write}` : ''}`);
  }

  const allRoles = [...grants.keys()].sort();
  const out = [];
  const now = new Date().toISOString().slice(0, 10);

  out.push(`# Matriz de accesos y restricciones por puesto

> ⚙️ **Generado — no editar a mano.** Regenerar con \`npm run docs:matriz-accesos\` (lee prod en
> sesión de sólo lectura + el árbol \`libs/contracts/src/authz/authz-tree.ts\`).
> Generado el **${now}** · última migración aplicada en prod: \`${db.lastMig}\`.
> El repo es público: aquí sólo hay **conteos** de personas, nunca nombres.

**Para qué sirve:** antes de construir un módulo nuevo, ver qué puesto/rol debe verlo y quién debe
poder operarlo; y al terminarlo, seguir la [checklist del §6](#6-checklist-para-un-módulo-nuevo).

## 1. Cómo se concede un acceso (léase primero)

| Pieza | Dónde vive | Qué decide |
|---|---|---|
| **Puesto** | \`identity.positions\` | **Propone** un rol (\`default_role\`) y complementos. ⛔ No concede nada por sí mismo. |
| **Rol principal** | \`identity.users.role_name\` → \`identity.role_permissions\` | Concede: mapa \`{ CLAVE: true }\`. Es lo que lee \`RolesGuard\` en cada request. |
| **Roles complementarios** | \`identity.user_roles\` | Se **suman** al principal (unión). |
| **Ajuste por persona** | \`identity.user_permissions\` | \`allow=true\` agrega, \`allow=false\` **quita** aunque el rol lo dé. |
| **Alcance (qué filas)** | \`identity.role_scopes\` → \`ScopeService\` (ADR-050) | El permiso **abre la pantalla**; el alcance decide **qué sucursales/zonas/clientes** ve. |
| **God-mode** | nombre de rol \`superadmin\` / \`admin\` (ADR-054) | Todo, sin mirar el mapa. |

Permiso = **clave exacta** (ADR-054, sin CASL). Convención: \`<MÓDULO>_VER\` abre, \`<MÓDULO>_GESTIONAR\`
opera; acciones de control (\`_AUTORIZAR\`, \`_VALIDAR\`, \`_APROBAR\`) van **aparte** para separar funciones.
Un cambio de permisos exige **re-login** (el menú sale del JWT).
`);

  // ── §2 Puestos ──
  out.push(`## 2. Puestos → rol\n`);
  out.push(`"Rol propuesto" es lo que dice el catálogo de puestos; "Roles reales" es lo que tienen hoy las
personas activas en ese puesto (principal + complementos). Cuando no coinciden, manda el real.\n`);
  const deptByCode = new Map(db.departments.map((d) => [d.code, d]));
  const deptOrder = [...db.departments.map((d) => d.code), ...new Set(db.positions.map((p) => p.department_code).filter((c) => !deptByCode.has(c)))];
  let posSinRol = 0, posConGente = 0, personasDesalineadas = 0;
  for (const dc of deptOrder) {
    const ps = db.positions.filter((p) => p.department_code === dc).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.name.localeCompare(b.name));
    if (!ps.length) continue;
    const d = deptByCode.get(dc);
    out.push(`### ${d?.name ?? dc} · alcance natural: \`${d?.scope_axis ?? '—'}\`\n`);
    const rows = ps.map((p) => {
      const people = db.users.filter((u) => u.position_code === p.code);
      if (people.length) posConGente++;
      if (!p.default_role) posSinRol++;
      const real = new Map();
      for (const u of people) {
        if (p.default_role && u.role !== p.default_role) personasDesalineadas++;
        for (const r of [u.role, ...(extraRolesByUser.get(u.id) || [])]) real.set(r, (real.get(r) || 0) + 1);
      }
      const realTxt = [...real.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} (${n})`).join(', ') || '—';
      return [p.name, p.nivel ?? '—', p.default_role ?? '⚠️ sin definir', p.default_complements.join(', ') || '—', people.length || '—', realTxt];
    });
    out.push(table(['Puesto', 'Nivel', 'Rol propuesto', 'Complementos', 'Personas', 'Roles reales (personas)'], rows));
  }
  const sinPuesto = db.users.filter((u) => !u.position_code);
  if (sinPuesto.length) {
    const byRole = new Map();
    for (const u of sinPuesto) byRole.set(u.role, (byRole.get(u.role) || 0) + 1);
    out.push(`### ⚠️ Personas activas sin puesto: ${sinPuesto.length}\n`);
    out.push(table(['Rol', 'Personas'], [...byRole.entries()].sort((a, b) => b[1] - a[1])));
  }

  // ── §3 Roles ──
  out.push(`## 3. Roles (lo que de verdad concede)\n`);
  out.push(table(
    ['Rol', 'Permisos', 'Personas (principal)', 'Personas (complemento)', 'Alcance (`role_scopes`)', 'Puestos que lo proponen'],
    allRoles.map((r) => [
      `\`${r}\``,
      isAdmin(r) ? 'TODOS (god-mode)' : grants.get(r).size,
      primaryCount.get(r) || 0,
      complCount.get(r) || 0,
      (scopesByRole.get(r) || []).join(', ') || '— (default)',
      (proposedBy.get(r) || []).join(', ') || '—',
    ]),
  ));

  // ── §4 Matriz por proyecto ──
  out.push(`## 4. Matriz rol × módulo, por proyecto

**G** = gestiona (tiene al menos una acción del módulo) · **V** = sólo ve · vacío = sin acceso.
\`superadmin\` se omite (lo tiene todo). Sólo aparecen los roles con algún acceso al proyecto.
`);
  const nonAdmin = allRoles.filter((r) => !isAdmin(r));
  const cell = (role, m) => (m.manage.some((p) => has(role, p)) ? 'G' : m.view.some((p) => has(role, p)) ? 'V' : '');
  const modulesSinNadie = [];
  for (const app of AUTHZ_TREE) {
    out.push(`### App: ${app.label}\n`);
    if (app.kind === 'access') {
      const p = app.accessPermission;
      const quien = nonAdmin.filter((r) => has(r, p));
      out.push(`Acceso único \`${p}\` → ${quien.map((r) => `\`${r}\``).join(', ') || '**nadie**'}\n`);
      continue;
    }
    for (const proj of app.projects) {
      const mods = proj.modules;
      const rolesIn = nonAdmin.filter((r) => mods.some((m) => cell(r, m)));
      for (const m of mods) if (!nonAdmin.some((r) => cell(r, m))) modulesSinNadie.push(`${proj.label} › ${m.label}`);
      out.push(`#### ${proj.label}${proj.route ? ` · \`${proj.route}\`` : ''}\n`);
      if (!rolesIn.length) { out.push('_Ningún rol (salvo superadmin) tiene acceso._\n'); continue; }
      out.push(table(['Rol', ...mods.map((m) => m.label)], rolesIn.map((r) => [`\`${r}\``, ...mods.map((m) => cell(r, m))])));
    }
  }

  // ── §5 Restricciones ──
  out.push(`## 5. Restricciones y separación de funciones

### 5.1 Reglas que todo módulo debe respetar

1. **Quien prepara no autoriza.** Las acciones de control (\`*_AUTORIZAR\`, \`*_VALIDAR\`, \`*_APROBAR\`)
   son una clave aparte del \`_GESTIONAR\` y se reparten a pocos roles. Ej.: Calendario de Pagos —
   \`FINANCE_PAYMENTS_GESTIONAR\` prepara, \`FINANCE_PAYMENT_CALENDAR_AUTORIZAR\` libera (fuera de todo
   grupo de plantilla para que nadie lo reciba "de paquete"). Ej.: Entradas — \`COMPRAS_ENTRADAS_GESTIONAR\`
   ≠ \`COMPRAS_ENTRADAS_VALIDAR\`.
2. **Quien audita no opera lo que audita.** Prevención/auditor externo reciben los módulos ajenos en
   **sólo-VER**.
3. **Conteo ciego.** Quien cuenta inventario (\`almacenista\`) tiene \`COMMERCIAL_INVENTORY_CONTAR\` pero **no**
   \`_SUPERVISAR\`: ese endpoint devuelve el teórico y rompería el conteo.
4. **El permiso abre, el alcance filtra.** La tienda ve sólo su sucursal vía \`role_scopes\`
   (\`warehouse = own\`), no con un permiso \`_VER_ALL\`.
5. **Externos encerrados.** \`customer_b2b\` sólo entra al Portal; \`auditor_externo\` tiene vencimiento
   (\`users.expires_at\`) y \`mode_write = none\`.
6. **Un permiso declarado no está entregado** hasta que una migración lo **reparte** en prod
   (lección LC.6.2: módulo en prod que nadie podía abrir).
7. **No pisar un \`false\` explícito** al repartir: es una decisión de alguien en \`/admin/roles\`.
8. **Claves a todos sin destino** (\`SERVICIO_REPORTAR\`): se reparten a todos pero no abren un
   espacio, o rompen la auto-entrada de \`/projects\`.
`);

  out.push(`### 5.2 Permisos sensibles: quién los tiene hoy\n`);
  const allTreePerms = new Set();
  for (const app of AUTHZ_TREE) {
    if (app.accessPermission) allTreePerms.add(app.accessPermission);
    for (const proj of app.projects) for (const m of proj.modules) [...m.view, ...m.manage].forEach((p) => allTreePerms.add(p));
  }
  const sensitive = [...allTreePerms].filter((p) => SENSITIVE.test(p)).sort();
  out.push(table(['Permiso', 'Qué hace', 'Roles que lo tienen (sin superadmin)'],
    sensitive.map((p) => [`\`${p}\``, label(p), nonAdmin.filter((r) => has(r, p)).map((r) => `\`${r}\``).join(', ') || '**nadie**'])));

  out.push(`### 5.3 Huecos medidos

- **Puestos sin rol propuesto:** ${posSinRol} de ${db.positions.length} (${posConGente} puestos tienen gente).
  Mientras \`default_role\` esté vacío, dar de alta a alguien en ese puesto **no le propone nada**.
- **Personas cuyo rol no es el que propone su puesto:** ${personasDesalineadas}.
- **Personas activas sin puesto:** ${sinPuesto.length}.
- **Roles sin ninguna persona (ni principal ni complemento):** ${allRoles.filter((r) => !primaryCount.get(r) && !complCount.get(r)).map((r) => `\`${r}\``).join(', ') || 'ninguno'}.
- **Ajustes por persona (\`user_permissions\`):** ${db.overrides.filter((o) => o.allow).length} que agregan, ${db.overrides.filter((o) => !o.allow).length} que quitan.
  Cada uno es una excepción que no se ve en la matriz de roles.
`);
  const nadie = [...allTreePerms].filter((p) => !nonAdmin.some((r) => has(r, p)) && !LEGACY_PERMISSIONS.includes(p)).sort();
  out.push(`- **Permisos que ningún rol tiene (sólo superadmin):** ${nadie.length}.${nadie.length ? ' Si el módulo ya está en prod, nadie más lo puede abrir:' : ''}\n`);
  if (nadie.length) out.push(table(['Permiso', 'Qué hace'], nadie.map((p) => [`\`${p}\``, label(p)])));
  if (modulesSinNadie.length) out.push(`- **Módulos a los que sólo entra superadmin:** ${modulesSinNadie.join(' · ')}\n`);

  // ── §6 Checklist ──
  out.push(`
## 6. Checklist para un módulo nuevo

1. **Decidir el acceso con esta matriz:** qué puestos lo usan → qué roles (§2/§3) → quién VE, quién
   GESTIONA y si hay una acción de control que deba ir aparte (§5.1 regla 1).
2. **Clave en el enum** \`libs/contracts/src/authz/permissions.ts\`: \`<MODULO>_VER\` + \`<MODULO>_GESTIONAR\`
   (+ \`_AUTORIZAR\`/\`_VALIDAR\` si aplica). Nombre en inglés snake_case mayúscula.
3. **Etiqueta** en \`permission-meta.ts\` (si no, sale la clave cruda en "Otros").
4. **Ubicarlo en \`authz-tree.ts\`** (proyecto → módulo con \`route\`, \`view\`/\`manage\`). Sin esto no se
   puede otorgar desde \`/admin/roles\` y falla \`database/tests/test-authz-route-coverage.js\`.
5. **Proyecto nuevo** → darle casa en \`suite-map.ts\` (o falla \`suite-map.spec.ts\`).
6. **Backend:** \`@RequirePermissions(...)\` en **toda** ruta de escritura (sin decorador queda abierta a
   cualquier autenticado).
7. **Frontend:** \`permissionGuard\` en la ruta + el ítem de navegación gateado con la misma clave.
8. **Alcance:** si los datos son por sucursal/zona/cliente, filtrar con \`ScopeService\`; revisar que los
   roles que lo reciben tengan su fila en \`identity.role_scopes\`.
9. **Migración de reparto** (\`database/migrations-newdb/\`): idempotente, \`SET LOCAL lock_timeout\`,
   \`permissions -> 'CLAVE' IS NULL\` (no el operador \`?\`), **derivada del estado vivo** (los roles de §3,
   no las plantillas de \`role-presets.ts\`), sin pisar \`false\`. Ejemplo:
   \`20261005210000_grant_finance_cortes_ver_tienda.js\`.
10. **Aplicar en prod + re-login** de los usuarios afectados.
11. **Regenerar esta matriz** (\`npm run docs:matriz-accesos\`) y commitearla con el módulo.
`);
  return out.join('\n');
}

(async () => {
  const contracts = loadContracts();
  const db = await loadProd();
  const md = build(contracts, db);
  fs.writeFileSync(OUT, md);
  console.log(`✓ ${path.relative(REPO, OUT)} — ${db.positions.length} puestos, ${db.roles.length} roles, ${db.users.length} personas activas`);
})().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});
