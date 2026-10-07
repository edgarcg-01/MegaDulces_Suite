/**
 * `[GX.65.4a]` Simulación por niveles de la pirámide, contra la API LOCAL (127.0.0.1:3334) y la base LOCAL.
 * Crea vales marcados SIMGX65-*, prueba cada rol, compara con lo esperado y borra lo que creó.
 * Prod NO se toca: se aborta si la base no es localhost.
 *
 * Uso (con la API local arriba en 127.0.0.1:3334):
 *   node database/scripts/sim-gx65-niveles.js
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env'), quiet: true });
const { Client } = require(path.join(ROOT, 'node_modules/pg'));
const jwt = require(path.join(ROOT, 'node_modules/jsonwebtoken'));

const API = 'http://127.0.0.1:3334/api/finance/expenses/proofs';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const url = process.env.DATABASE_URL_NEW;
if (!/@(127\.0\.0\.1|localhost):/.test(url)) { console.error('ABORTA: la base no es local'); process.exit(1); }

const NIVELES = [
  { u: 'demo_ana',        nivel: '1 · levanta (cajero, suc 01)' },
  { u: 'demo_encargada',  nivel: '2 · encargada de tienda (suc 01)' },
  { u: 'test_supervisor', nivel: '3 · direccion (VER + VER_ALL, sin autorizar)' },
  { u: 'maria_gutierrez', nivel: '4 · Maripaz, tesorería' },
  { u: 'jesus_carrillo',  nivel: '4 · Jesús, permiso dado por persona' },
  { u: 'guillermo_lopez', nivel: '4 · Guillermo, superadmin' },
  { u: 'superuser',       nivel: '5 · director general, superadmin' },
];

const resultados = [];
const ok = (caso, quien, esperado, obtenido, nota = '') => {
  const pasa = esperado === obtenido;
  resultados.push({ pasa: pasa ? '✅' : '❌', caso, quien, esperado, obtenido, nota });
};

(async () => {
  const db = new Client({ connectionString: url });
  await db.connect();
  await db.query(`SELECT set_config('app.tenant_id', $1, false)`, [TENANT]);

  // ── usuarios y tokens (misma forma que el login real; RolesGuard relee permisos de la base) ──
  const us = (await db.query(`SELECT id, username, nombre, role_name FROM identity.users
    WHERE tenant_id=$1 AND username = ANY($2)`, [TENANT, NIVELES.map((n) => n.u)])).rows;
  const porU = Object.fromEntries(us.map((r) => [r.username, r]));
  const faltan = NIVELES.filter((n) => !porU[n.u]).map((n) => n.u);
  if (faltan.length) { console.error('Faltan usuarios en local:', faltan); process.exit(1); }
  const token = (u) => jwt.sign({ sub: porU[u].id, tenant_id: TENANT, username: u, role_name: porU[u].role_name },
    process.env.JWT_SECRET, { expiresIn: 600 });
  const call = async (u, method, ruta, body) => {
    const r = await fetch(API + ruta, { method, headers: { Authorization: 'Bearer ' + token(u), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch { /* sin cuerpo */ }
    return { status: r.status, body: j };
  };

  // ── vales de prueba ──
  const files = JSON.stringify([{ role: 'comprobante_1', url: 'https://sim.local/ticket.jpg' }]);
  const vales = {
    A: 'demo_ana',                       // de la cajera
    E: 'demo_encargada',                 // de la encargada
    M: 'maria_gutierrez',                // de Maripaz
    J: 'jesus_carrillo',                 // de Jesús
    S: 'superuser',                      // del director general
    N: porU['jesus_carrillo'].nombre,    // de Jesús, guardado con su NOMBRE (el bug del token sin full_name)
  };
  const id = {};
  for (const [k, dueno] of Object.entries(vales)) {
    const r = await db.query(`INSERT INTO finance.expense_proofs
      (tenant_id, solicitante, proveedor, sucursal, folio_solicitud, importe, status, clasificacion, files, comentarios, created_by)
      VALUES ($1,'SIMULACION','SIM PROVEEDOR','01',$2,100,'recibida','fiscal',$3::jsonb,'[SIM-GX65]',$4) RETURNING id`,
      [TENANT, 'SIMGX65-' + k, files, dueno]);
    id[k] = r.rows[0].id;
  }

  try {
    // 1 · «Mis gastos» de cada uno: sólo lo suyo, y con los campos nuevos
    for (const n of NIVELES) {
      const r = await call(n.u, 'GET', '/mine?limit=500');
      const sim = (r.body?.rows || []).filter((x) => String(x.folio_solicitud || '').startsWith('SIMGX65-')).map((x) => x.folio_solicitud.slice(-1));
      const esperado = Object.entries(vales).filter(([, d]) => d === n.u).map(([k]) => k).sort().join(',') || '(ninguno)';
      ok('Mis gastos ve sólo lo suyo', n.u, esperado, sim.sort().join(',') || '(ninguno)');
      if (r.status === 200) ok('Mis gastos trae los campos nuevos', n.u, 'sí',
        ('abiertos_truncados' in r.body) && (r.body.rows.length === 0 || 'proveedor_clave' in r.body.rows[0]) ? 'sí' : 'no');
    }

    // 2 · quienes NO deben poder aprobar
    for (const u of ['demo_ana', 'demo_encargada', 'test_supervisor']) {
      const r = await call(u, 'POST', `/${id.A}/approve`, {});
      ok('Sin permiso de autorizar: no aprueba', u, 403, r.status);
    }
    // 3 · el dueño no aprueba lo suyo (incluido god-mode)
    for (const [k, u] of [['M', 'maria_gutierrez'], ['S', 'superuser']]) {
      const r = await call(u, 'POST', `/${id[k]}/approve`, {});
      ok('No aprueba su propio vale', u, 403, r.status, r.body?.message || '');
    }
    const rj = await call('jesus_carrillo', 'POST', `/${id.J}/reject`, { motivo: 'prueba' });
    ok('No rechaza su propio vale', 'jesus_carrillo', 403, rj.status, rj.body?.message || '');
    // 3b · el bug: vale guardado con su NOMBRE, el token sólo trae username
    const rn = await call('jesus_carrillo', 'POST', `/${id.N}/approve`, {});
    ok('Vale guardado con su NOMBRE: igual es suyo', 'jesus_carrillo', 403, rn.status, rn.body?.message || '');

    // 4 · otra persona sí decide
    for (const [k, u] of [['A', 'maria_gutierrez'], ['M', 'jesus_carrillo'], ['S', 'guillermo_lopez'], ['J', 'superuser']]) {
      const r = await call(u, 'POST', `/${id[k]}/approve`, {});
      ok(`Aprueba el vale de otra persona (${vales[k]})`, u, 201, r.status, r.body?.message || r.body?.status || '');
    }
    const rr = await call('maria_gutierrez', 'POST', `/${id.E}/reject`, { motivo: 'prueba de simulación' });
    ok('Rechaza el vale de otra persona (demo_encargada)', 'maria_gutierrez', 201, rr.status, rr.body?.message || '');

    // 5 · el Expediente: quién entra, y el protocolo sin la comprobación forzosa
    for (const n of NIVELES) {
      const r = await call(n.u, 'GET', '/expediente');
      const puede = ['maria_gutierrez', 'jesus_carrillo', 'guillermo_lopez', 'superuser'].includes(n.u);
      ok('Expediente: entra sólo quien autoriza', n.u, puede ? 200 : 403, r.status);
      if (r.status === 200 && n.u === 'maria_gutierrez') {
        const vs = r.body.personas.flatMap((p) => p.vales);
        const simA = vs.find((v) => v.folio_solicitud === 'SIMGX65-A');
        ok('Expediente: nadie pide «comprobación de Kepler»', n.u, 0,
          vs.filter((v) => v.protocolo.faltan.some((f) => f.id === 'comprobacion_kepler')).length);
        ok('Expediente: no queda ninguno «sin medir»', n.u, 0, vs.filter((v) => v.protocolo.etapa === 'sin_medir').length);
        ok('Vale de la cajera aprobado: etapa del protocolo', n.u, 'no en captura', simA ? (simA.protocolo.etapa === 'en_captura' ? 'en captura' : 'no en captura') : 'no aparece',
          simA ? `${simA.status} → ${simA.protocolo.etapa}` : '');
        ok('Expediente: ve a personas de toda la empresa (hueco GX.65.4b)', n.u, 'toda la empresa',
          r.body.personas.length > 1 ? 'toda la empresa' : 'sólo una', `${r.body.personas.length} personas`);
      }
    }
  } finally {
    const del = await db.query(`DELETE FROM finance.expense_proofs WHERE tenant_id=$1 AND folio_solicitud LIKE 'SIMGX65-%'`, [TENANT]);
    const quedan = (await db.query(`SELECT count(*)::int n FROM finance.expense_proofs WHERE folio_solicitud LIKE 'SIMGX65-%'`)).rows[0].n;
    console.log(`\nLimpieza: ${del.rowCount} vales de prueba borrados · quedan ${quedan}`);
    await db.end();
  }

  console.table(resultados);
  const malos = resultados.filter((r) => r.pasa === '❌').length;
  console.log(`\n${resultados.length - malos} de ${resultados.length} casos como se esperaba${malos ? ` · ${malos} FALLAN` : ''}`);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
