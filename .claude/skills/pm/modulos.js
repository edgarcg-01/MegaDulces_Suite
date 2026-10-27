#!/usr/bin/env node
// [PM.13] Hoja de seguimiento de módulos — una fila por submódulo de la Suite, una columna por etapa.
//   node .claude/skills/pm/modulos.js --dry   → calcula y muestra el embudo, no escribe
//   node .claude/skills/pm/modulos.js         → crea/actualiza el GitHub Project «Módulos» (privado)
//
// Filas: AUTHZ_TREE (libs/contracts/src/authz/authz-tree.ts), app `view` — el catálogo canónico que ya
// vigilan las pruebas de cobertura. NO el menú: el menú está escrito a mano y se desfasa.
// Columnas AUTOMÁTICAS (se recalculan en cada corrida): Espacio, Módulo, Ruta, Permisos, En producción,
// Personas con permiso, Etapa, Medido el. Las MANUALES (Fase, dueños, Desarrollo, Capacitación,
// Aceptación) las llena el dev dueño y este guion NUNCA las pisa.
// Uso por pantalla y errores: NO MEDIDO hasta [PM.13 H3] — se declara, no se dibuja como 0.
//
// Lee: git (origin/main y origin/prod-release) + pg-prod en SÓLO LECTURA (system_identifier verificado).
// Escribe: sólo el Project «Módulos» de edgarcg-01.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const raiz = path.resolve(__dirname, '..', '..', '..');
require(path.join(raiz, 'node_modules/dotenv')).config({ path: path.join(raiz, '.env'), quiet: true });
const ts = require(path.join(raiz, 'node_modules/typescript'));
const { Client } = require(path.join(raiz, 'node_modules/pg'));

const DRY = process.argv.includes('--dry');
const OWNER = 'edgarcg-01', TITULO = 'Módulos — seguimiento de implementación';
const TENANT = '00000000-0000-0000-0000-00000000d01c', PROD_ID = '7688376744939610156';
const ADMINS = new Set(['superadmin', 'admin']); // ven todo: no cuentan como «permiso repartido»
const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
const espera = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const git = (a) => execFileSync('git', a, { cwd: raiz, encoding: 'utf8', maxBuffer: 64 << 20 });

// ── 1. El catálogo, tal como está en una rama (TS → JS en un temporal) ─────────────────────────
function catalogo(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modulos-'));
  const base = 'libs/contracts/src/authz';
  const archivos = git(['ls-tree', '--name-only', `${ref}:${base}`]).split('\n').filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));
  for (const f of archivos) {
    const src = git(['show', `${ref}:${base}/${f}`]);
    const { outputText } = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    fs.writeFileSync(path.join(dir, f.replace(/\.ts$/, '.js')), outputText);
  }
  const tree = require(path.join(dir, 'authz-tree.js'));
  const map = require(path.join(dir, 'suite-map.js'));
  const view = tree.AUTHZ_TREE.find((a) => a.id === 'view');
  const espacioDe = new Map(); // clave → etiqueta del espacio
  for (const s of map.SUITE_SPACES) for (const e of s.entries) for (const m of map.entryModules(e)) {
    const clave = `${e.project}.${m.id}`;
    if (!espacioDe.has(clave)) espacioDe.set(clave, s.label);
  }
  const filas = [];
  for (const p of view.projects) for (const m of p.modules) {
    filas.push({ clave: `${p.id}.${m.id}`, modulo: p.label, submodulo: m.label, ruta: m.route || '', view: m.view || [], espacio: espacioDe.get(`${p.id}.${m.id}`) || 'Sin espacio' });
  }
  return filas;
}

// ── 2. Quién puede abrir cada submódulo en prod (sólo lectura) ─────────────────────────────────
async function permisosProd() {
  const c = new Client({ connectionString: process.env.PROD_DB_URL, options: '-c default_transaction_read_only=on', statement_timeout: 30000 });
  await c.connect();
  try {
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== PROD_ID) throw new Error(`no es pg-prod (${id})`);
    const q = (sql) => c.query(sql, [TENANT]).then((r) => r.rows);
    const roles = await q(`SELECT lower(role_name) AS role, permissions FROM identity.role_permissions WHERE tenant_id = $1 AND deleted_at IS NULL`);
    const users = await q(`SELECT id, lower(role_name) AS role FROM identity.users WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active'`);
    const extra = await q(`SELECT ur.user_id, lower(ur.role_name) AS role FROM identity.user_roles ur WHERE ur.tenant_id = $1`);
    const ajustes = await q(`SELECT user_id, permission_key, allow FROM identity.user_permissions WHERE tenant_id = $1`);
    const grants = new Map(roles.map((r) => [r.role, new Set(Object.entries(r.permissions || {}).filter(([, v]) => v === true).map(([k]) => k))]));
    const porUsuario = new Map(users.map((u) => [u.id, { roles: new Set([u.role]), allow: new Set(), deny: new Set() }]));
    for (const e of extra) porUsuario.get(e.user_id)?.roles.add(e.role);
    for (const a of ajustes) porUsuario.get(a.user_id)?.[a.allow ? 'allow' : 'deny'].add(a.permission_key);
    return (perms) => {
      let n = 0;
      for (const u of porUsuario.values()) {
        if ([...u.roles].some((r) => ADMINS.has(r))) continue;
        const puede = perms.some((p) => !u.deny.has(p) && (u.allow.has(p) || [...u.roles].some((r) => grants.get(r)?.has(p))));
        if (puede) n++;
      }
      return n;
    };
  } finally { await c.end().catch(() => undefined); }
}

// ── 3. La etapa: la PRIMERA que falta ──────────────────────────────────────────────────────────
const ETAPAS = ['0 · Sin pantalla', '1 · Por desplegar', '2 · Por repartir permiso', '3 · Por capacitar', '4 · Por aceptar', '5 · Uso sin medir', '5 · Sin uso', '6 · En uso'];
function etapa(f, manual) {
  if (!f.ruta) return ETAPAS[0];
  if (f.enProd !== 'Sí') return ETAPAS[1];
  if (!f.personas) return ETAPAS[2];
  if (!manual['Capacitado (fecha)']) return ETAPAS[3];
  if (!manual['Aceptado (fecha)']) return ETAPAS[4];
  if (manual['Medición de uso'] !== 'Exacta' && manual['Medición de uso'] !== 'Aproximada') return ETAPAS[5];
  return Number(manual['Uso 30 d (personas)'] || 0) > 0 ? ETAPAS[7] : ETAPAS[6];
}

// ── 4. GitHub Project ──────────────────────────────────────────────────────────────────────────
const gql = (query, variables = {}) => {
  for (let i = 1; ; i++) {
    try {
      const out = execFileSync('gh', ['api', 'graphql', '--input', '-'], { encoding: 'utf8', input: JSON.stringify({ query, variables }), stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
      const r = JSON.parse(out);
      if (r.errors) throw Object.assign(new Error(JSON.stringify(r.errors).slice(0, 600)), { definitivo: true });
      return r.data;
    } catch (e) { if (e.definitivo || i >= 4) throw e; espera(4000 * i); }
  }
};
const CAMPOS = [
  // [nombre, tipo, opciones] — automáticos primero, manuales después
  ['Clave', 'TEXT'], ['Espacio', 'SINGLE_SELECT', 'espacios'], ['Módulo', 'SINGLE_SELECT', 'modulos'], ['Ruta', 'TEXT'], ['Permisos', 'TEXT'],
  ['En producción', 'SINGLE_SELECT', ['Sí', 'Sólo en main']], ['Personas con permiso', 'NUMBER'], ['Etapa', 'SINGLE_SELECT', ETAPAS], ['Medido el', 'DATE'],
  ['Fase', 'TEXT'], ['Dueño técnico', 'TEXT'], ['Dueño de negocio', 'TEXT'],
  ['Desarrollo', 'SINGLE_SELECT', ['Terminado', 'Mejoras pendientes', 'En desarrollo']],
  ['Capacitado (fecha)', 'DATE'], ['Capacitación (áreas · quién capacitó)', 'TEXT'],
  ['Aceptado (fecha)', 'DATE'], ['Aceptado por', 'TEXT'],
  ['Medición de uso', 'SINGLE_SELECT', ['NO MEDIDO', 'Aproximada', 'Exacta']], ['Uso 30 d (personas)', 'NUMBER'], ['Errores 5xx 30 d', 'NUMBER'],
];
const AUTO = new Set(['Clave', 'Espacio', 'Módulo', 'Ruta', 'Permisos', 'En producción', 'Personas con permiso', 'Etapa', 'Medido el']);

function proyecto() {
  const lista = gql(`{ user(login:"${OWNER}"){ id projectsV2(first:50){ nodes { id number title } } } }`).user;
  let p = lista.projectsV2.nodes.find((x) => x.title === TITULO);
  if (!p) p = gql(`mutation($o:ID!,$t:String!){ createProjectV2(input:{ownerId:$o,title:$t}){ projectV2 { id number title } } }`, { o: lista.id, t: TITULO }).createProjectV2.projectV2;
  return p;
}
function camposDe(pid) {
  return gql(`query($p:ID!){ node(id:$p){ ... on ProjectV2 { fields(first:50){ nodes {
    ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name } } } } } } }`, { p: pid }).node.fields.nodes;
}
function asegurarCampos(pid, opciones) {
  let campos = camposDe(pid);
  for (const [nombre, tipo, ops] of CAMPOS) {
    if (campos.some((c) => c.name === nombre)) continue;
    const lista = Array.isArray(ops) ? ops : opciones[ops];
    gql(`mutation($p:ID!,$n:String!,$t:ProjectV2CustomFieldType!,$o:[ProjectV2SingleSelectFieldOptionInput!]){
      createProjectV2Field(input:{projectId:$p,name:$n,dataType:$t,singleSelectOptions:$o}){ clientMutationId } }`,
    { p: pid, n: nombre, t: tipo, o: tipo === 'SINGLE_SELECT' ? lista.map((x) => ({ name: x, color: 'GRAY', description: '' })) : null });
  }
  campos = camposDe(pid);
  // Una opción nueva (otro módulo o espacio en el catálogo) se agrega sin borrar las que ya existen.
  for (const [nombre, tipo, ops] of CAMPOS) {
    if (tipo !== 'SINGLE_SELECT') continue;
    const c = campos.find((x) => x.name === nombre);
    const quiero = Array.isArray(ops) ? ops : opciones[ops];
    const faltan = quiero.filter((x) => !c.options.some((o) => o.name === x));
    if (!faltan.length) continue;
    gql(`mutation($f:ID!,$o:[ProjectV2SingleSelectFieldOptionInput!]!){ updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:$o}){ clientMutationId } }`,
      { f: c.id, o: [...c.options.map((o) => ({ name: o.name, color: 'GRAY', description: '' })), ...faltan.map((x) => ({ name: x, color: 'GRAY', description: '' }))] });
  }
  return camposDe(pid);
}
function itemsDe(pid) {
  const out = [];
  let after = null;
  do {
    const r = gql(`query($p:ID!,$a:String){ node(id:$p){ ... on ProjectV2 { items(first:100, after:$a){ pageInfo { hasNextPage endCursor } nodes { id
      fieldValues(first:30){ nodes {
        ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } } } } } } } }`, { p: pid, a: after }).node.items;
    for (const n of r.nodes) {
      const v = {};
      for (const f of n.fieldValues.nodes) if (f.field) v[f.field.name] = f.text ?? f.number ?? f.date ?? f.name;
      out.push({ id: n.id, v });
    }
    after = r.pageInfo.hasNextPage ? r.pageInfo.endCursor : null;
  } while (after);
  return out;
}

(async () => {
  git(['fetch', '-q', 'origin', 'main', 'prod-release']);
  const filas = catalogo('origin/main');
  const enProd = new Set(catalogo('origin/prod-release').map((f) => f.clave));
  const personasCon = await permisosProd();
  for (const f of filas) { f.enProd = enProd.has(f.clave) ? 'Sí' : 'Sólo en main'; f.personas = personasCon(f.view); }

  if (DRY) {
    const conteo = {};
    for (const f of filas) { const e = etapa(f, {}); conteo[e] = (conteo[e] || 0) + 1; }
    console.log(`Catálogo origin/main: ${filas.length} submódulos en ${new Set(filas.map((f) => f.modulo)).size} módulos · medido ${HOY}`);
    console.log('Embudo (sin datos manuales todavía):', conteo);
    console.log('En prod sin permiso repartido:', filas.filter((f) => f.ruta && f.enProd === 'Sí' && !f.personas).map((f) => f.clave).join(', ') || 'ninguno');
    console.log('Sólo en main:', filas.filter((f) => f.enProd !== 'Sí').map((f) => f.clave).join(', ') || 'ninguno');
    console.log('Sin pantalla:', filas.filter((f) => !f.ruta).map((f) => f.clave).join(', ') || 'ninguno');
    console.log('Sin espacio:', filas.filter((f) => f.espacio === 'Sin espacio').length);
    return;
  }

  const p = proyecto();
  const opciones = { espacios: [...new Set([...filas.map((f) => f.espacio)])], modulos: [...new Set(filas.map((f) => f.modulo))] };
  const campos = asegurarCampos(p.id, opciones);
  const campo = (n) => campos.find((c) => c.name === n);
  const existentes = new Map(itemsDe(p.id).filter((i) => i.v.Clave).map((i) => [i.v.Clave, i]));
  let creados = 0, actualizados = 0;

  for (const f of filas) {
    let it = existentes.get(f.clave);
    if (!it) {
      const id = gql(`mutation($p:ID!,$t:String!,$b:String){ addProjectV2DraftIssue(input:{projectId:$p,title:$t,body:$b}){ projectItem { id } } }`,
        { p: p.id, t: `${f.modulo} › ${f.submodulo}`, b: `Submódulo \`${f.clave}\` del catálogo \`AUTHZ_TREE\`. Columnas manuales: las llena el dev dueño al capacitar o liberar.` }).addProjectV2DraftIssue.projectItem.id;
      it = { id, v: {} }; creados++;
    }
    const valores = {
      Clave: f.clave, Espacio: f.espacio, 'Módulo': f.modulo, Ruta: f.ruta, Permisos: f.view.join(', '),
      'En producción': f.enProd, 'Personas con permiso': f.personas, Etapa: etapa(f, it.v), 'Medido el': HOY,
    };
    if (!it.v['Medición de uso']) valores['Medición de uso'] = 'NO MEDIDO';
    const cambios = Object.entries(valores).filter(([k, v]) => String(it.v[k] ?? '') !== String(v ?? '') && !(k === 'Medido el'));
    if (!cambios.length && it.v['Medido el'] === HOY) continue;
    cambios.push(['Medido el', HOY]);
    const partes = cambios.map(([k, v], i) => {
      const c = campo(k);
      let valor;
      if (c.dataType === 'SINGLE_SELECT') valor = `{singleSelectOptionId:${JSON.stringify(c.options.find((o) => o.name === v).id)}}`;
      else if (c.dataType === 'NUMBER') valor = `{number:${Number(v)}}`;
      else if (c.dataType === 'DATE') valor = `{date:${JSON.stringify(v)}}`;
      else valor = `{text:${JSON.stringify(String(v))}}`;
      return `c${i}: updateProjectV2ItemFieldValue(input:{projectId:${JSON.stringify(p.id)},itemId:${JSON.stringify(it.id)},fieldId:${JSON.stringify(c.id)},value:${valor}}){ clientMutationId }`;
    });
    gql(`mutation { ${partes.join('\n')} }`);
    actualizados++;
    espera(700); // límite secundario de GitHub para mutaciones
  }
  console.log(`Project #${p.number} «${p.title}»: ${filas.length} submódulos · ${creados} creados · ${actualizados} actualizados · https://github.com/users/${OWNER}/projects/${p.number}`);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
