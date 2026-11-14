#!/usr/bin/env node
/**
 * `[RF.0]` Inventario de INTERFACES de las tres apps (view, vendor, portal), con su uso medido.
 * Paso 0 de `docs/REESTRUCTURA_FRONTEND.md`.
 *
 *   node e2e/reestructura/inventario.js            → resumen en consola + e2e/reestructura/.resultados/inventario.json
 *   node e2e/reestructura/inventario.js --sin-uso  → sólo el inventario (no toca la base)
 *
 * ── Cómo cuenta ─────────────────────────────────────────────────────────────────────────────────
 * Lee cada `app.routes.ts` con el COMPILADOR de TypeScript (sólo el árbol sintáctico: no compila
 * Angular ni levanta nada) y recorre el arreglo de rutas con sus `children`. Cada hoja es:
 *   · pantalla  — tiene `loadComponent` o `component` y no es el marco (`LayoutComponent`…)
 *   · redirección — `redirectTo`
 *   · marco     — sólo agrupa (`component: LayoutComponent` + `children`)
 * Una misma pantalla (mismo archivo de componente) servida en dos rutas cuenta una vez como
 * COMPONENTE y dos como RUTA: las dos cifras se publican.
 *
 * ── El uso (prod, SÓLO LECTURA, verificado por system_identifier) ────────────────────────────────
 * `commercial.portal_telemetry_events` (`web_vital` + `abrio_puerta`, env prod) da la ruta en que la
 * persona ENTRÓ o DEJÓ la app, no cada navegación interna (ver `uso.service.ts`): es una COTA
 * INFERIOR. ⛔ Una pantalla en 0 no es «sin uso»: es «nadie entró ni salió de la app ahí».
 *
 * ── Control ─────────────────────────────────────────────────────────────────────────────────────
 * Antes de publicar nada se comprueban tres rutas cuya respuesta se conoce por otro camino
 * (`/almacen/pedidos` = pantalla, `/almacen/surtido-consola` = redirección desde GP.10.4c,
 * `/almacen/pedidos/preventa` = pantalla con guard). Si el control falla, el inventario se tira.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const RAIZ = path.resolve(__dirname, '..', '..');
const APPS = [
  { app: 'view', archivo: 'apps/view/src/app/app.routes.ts', variable: 'routes' },
  { app: 'vendor', archivo: 'apps/vendor/src/app/app.routes.ts', variable: 'appRoutes' },
  { app: 'portal', archivo: 'apps/portal/src/app/app.routes.ts', variable: 'appRoutes' },
];
const MARCOS = /^(LayoutComponent|SplitShellComponent|ShellComponent|PortalShellComponent|VendorShellComponent)$/;

function texto(n, sf) { return n ? n.getText(sf).replace(/\s+/g, ' ').trim() : null; }
function prop(obj, nombre) {
  return obj.properties.find((p) => p.name && (p.name.text === nombre || p.name.escapedText === nombre));
}
function cadena(n) { return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null; }

function recorrer(arr, sf, base, out, rutaArchivo) {
  for (const el of arr.elements) {
    if (ts.isSpreadElement(el)) { out.push({ ruta: base || '/', tipo: 'sin_resolver', detalle: texto(el, sf) }); continue; }
    if (!ts.isObjectLiteralExpression(el)) continue;
    const p = prop(el, 'path');
    const seg = p ? cadena(p.initializer) : null;
    const matcher = prop(el, 'matcher');
    const outlet = prop(el, 'outlet');
    if (outlet) continue; // el espejo del panel lateral: no es una interfaz más
    const ruta = matcher ? `${base}/(matcher)` : seg == null ? base : seg === '' ? base : `${base}/${seg}`;
    const hijos = prop(el, 'children');
    const lc = prop(el, 'loadComponent');
    const comp = prop(el, 'component');
    const red = prop(el, 'redirectTo');
    const guards = ['canActivate', 'canMatch'].map((g) => prop(el, g)).filter(Boolean).map((g) => texto(g.initializer, sf)).join(' ');
    let componente = null;
    if (lc) {
      const m = /import\(['"]([^'"]+)['"]\)[\s\S]*?\.then\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.(\w+)/.exec(texto(lc.initializer, sf) || '');
      componente = m ? `${path.posix.join(path.posix.dirname(rutaArchivo), m[1])}#${m[2]}` : texto(lc.initializer, sf);
    } else if (comp) componente = texto(comp.initializer, sf);
    if (red) out.push({ ruta: ruta || '/', tipo: 'redireccion', destino: texto(red.initializer, sf), guards });
    else if (componente && !(comp && MARCOS.test(componente) && hijos)) out.push({ ruta: ruta || '/', tipo: 'pantalla', componente, guards });
    else if (hijos || componente) out.push({ ruta: ruta || '/', tipo: 'marco', componente, guards });
    if (hijos && ts.isArrayLiteralExpression(hijos.initializer)) recorrer(hijos.initializer, sf, ruta, out, rutaArchivo);
  }
}

function inventario({ app, archivo, variable }) {
  const fuente = fs.readFileSync(path.join(RAIZ, archivo), 'utf8');
  const sf = ts.createSourceFile(archivo, fuente, ts.ScriptTarget.Latest, true);
  let arr = null;
  sf.forEachChild((n) => {
    if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations) {
      if (d.name.getText(sf) === variable && d.initializer && ts.isArrayLiteralExpression(d.initializer)) arr = d.initializer;
    }
  });
  if (!arr) throw new Error(`${app}: no encontré el arreglo «${variable}» en ${archivo}`);
  const out = [];
  recorrer(arr, sf, '', out, archivo);
  return out.map((r) => ({ app, ...r }));
}

async function usoView(rutas) {
  require(path.join(RAIZ, 'node_modules/dotenv')).config({ path: path.join(RAIZ, '.env'), quiet: true });
  const { Client } = require(path.join(RAIZ, 'node_modules/pg'));
  const c = new Client({ connectionString: process.env.DATABASE_URL_NEW, statement_timeout: 60000 });
  await c.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== '7688376744939610156') throw new Error(`NO es pg-prod (${id})`);
    const { rows } = await c.query(`
      SELECT split_part(t.url, '?', 1) AS url, count(DISTINCT (t.user_id, (t.created_at AT TIME ZONE 'America/Mexico_City')::date))::int AS pd,
             count(DISTINCT t.user_id)::int AS personas
        FROM commercial.portal_telemetry_events t
       WHERE t.created_at >= now() - interval '30 days' AND t.env = 'prod' AND t.name IN ('web_vital', 'abrio_puerta')
       GROUP BY 1`);
    await c.query('ROLLBACK');
    // Cada url medida va a UNA ruta: la más específica que la case (menos parámetros, más larga).
    const patrones = rutas.filter((r) => r.app === 'view' && r.tipo !== 'marco' && !r.ruta.includes('(matcher)')).map((r) => ({
      r, re: new RegExp('^' + r.ruta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\?:[A-Za-z_]+/g, '[^/]+').replace(/\/\*\*$/, '(/.*)?') + '/?$'),
      params: (r.ruta.match(/:/g) || []).length,
    }));
    let sinRuta = 0;
    for (const u of rows) {
      const casan = patrones.filter((p) => p.re.test(u.url)).sort((a, b) => a.params - b.params || b.r.ruta.length - a.r.ruta.length);
      if (!casan.length) { sinRuta += u.pd; continue; }
      const r = casan[0].r;
      r.pd = (r.pd || 0) + u.pd;
      r.personas_max = Math.max(r.personas_max || 0, u.personas);
    }
    return { urls: rows.length, pd_total: rows.reduce((t, x) => t + x.pd, 0), pd_sin_ruta: sinRuta };
  } finally { await c.end(); }
}

(async () => {
  const rutas = APPS.flatMap(inventario);
  // CONTROL: tres respuestas conocidas por otro camino (GP.10.4c, 2026-11-14).
  const de = (r) => rutas.find((x) => x.app === 'view' && x.ruta === r);
  const control = [
    ['/almacen/pedidos', 'pantalla'], ['/almacen/surtido-consola', 'redireccion'], ['/almacen/pedidos/preventa', 'pantalla'],
  ].map(([r, t]) => ({ r, t, ok: de(r)?.tipo === t }));
  if (control.some((x) => !x.ok)) { console.error('⛔ CONTROL ROJO, el inventario no sirve:', control); process.exit(2); }
  console.log('control ok:', control.map((x) => `${x.r}=${x.t}`).join(' · '));

  let uso = null;
  if (!process.argv.includes('--sin-uso')) uso = await usoView(rutas);

  const resumen = {};
  for (const r of rutas) {
    const k = resumen[r.app] ??= { pantallas: 0, componentes: new Set(), redirecciones: 0, marcos: 0, sin_resolver: 0, con_uso: 0, sin_uso: 0 };
    if (r.tipo === 'pantalla') {
      k.pantallas++; k.componentes.add(r.componente);
      if (r.app === 'view' && uso) (r.pd ? k.con_uso++ : k.sin_uso++);
    } else if (r.tipo === 'redireccion') k.redirecciones++;
    else if (r.tipo === 'marco') k.marcos++;
    else k.sin_resolver++;
  }
  for (const [app, k] of Object.entries(resumen)) {
    console.log(`${app}: ${k.pantallas} rutas de pantalla · ${k.componentes.size} componentes distintos · ${k.redirecciones} redirecciones · ${k.marcos} marcos · ${k.sin_resolver} sin resolver` +
      (app === 'view' && uso ? ` · con entrada medida ${k.con_uso} · en 0 ${k.sin_uso}` : ''));
  }
  if (uso) console.log(`uso (30 d, cota inferior): ${uso.urls} urls · ${uso.pd_total} persona-días · ${uso.pd_sin_ruta} sin ruta que las case`);

  const dir = path.join(__dirname, '.resultados');
  fs.mkdirSync(dir, { recursive: true });
  const salida = { medido_at: new Date().toISOString(), uso, rutas };
  fs.writeFileSync(path.join(dir, 'inventario.json'), JSON.stringify(salida, null, 2));
  console.log(`escrito ${path.relative(RAIZ, path.join(dir, 'inventario.json'))}`);
})().catch((e) => { console.error('ERROR', e.stack || e.message); process.exit(1); });
