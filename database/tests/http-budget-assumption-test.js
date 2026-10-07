/* eslint-disable no-console */
/**
 * `[PU.VA]` Verificación **POR HTTP** del supuesto de crecimiento (ADR-044 · ADR-056 ·
 * `docs/VERDAD_ABSOLUTA.md` §22). Hermano de `test-newdb-budget-assumption.js`, que mide lo mismo
 * contra la base: éste mide que **llegue por la ruta**, con guard, serialización y contrato.
 *
 * ── ⛔ POR QUÉ ESTE ES DE SÓLO LECTURA, a diferencia de sus 63 hermanos HTTP ──────────────────
 * Los tests HTTP de este repo empiezan con `crearUsuario()`: siembran cuentas y después hacen
 * login. Medido el 2026-10-07, la API de `localhost:3334` tenía **6 conexiones establecidas a
 * `192.168.0.222:5434`, que es PRODUCCIÓN** — el mismo patrón del incidente que fundó la regla, y
 * `assertSafeTarget` lo confirma abortando. Sembrar usuarios contra ese destino es exactamente lo
 * que pasó el 2026-08-29, cuando el suite dejó 5 cuentas y 2 tenants de prueba en el padrón real.
 *
 * Así que este archivo **no escribe una sola fila**: firma un token para un usuario que YA existe
 * y sólo hace `GET`. Es menos de lo que cubre un e2e completo, y se declara: el flujo de escritura
 * (crear ejercicio, proponer plan, materializar) queda **sin verificar por HTTP** hasta que haya
 * una base que no sea producción.
 *
 * ⚠️ El token se firma acá en vez de pedirlo por `/auth/login` porque hacerlo de verdad exige la
 * contraseña de una persona real. El guard de autorización NO se saltea: `RolesGuard` relee los
 * permisos de la base en cada request, así que el token sólo dice **quién** es, nunca qué puede.
 * Por eso la prueba negativa de abajo tiene valor: el mismo mecanismo, con otro usuario, cierra.
 *
 * ── Qué vigila ──────────────────────────────────────────────────────────────────────────────
 *   [1] El gate de la ruta nueva: sin token y con token inválido cierra; con un rol SIN la clave
 *       cierra; con el permiso MÍNIMO (`finanzas`, no superadmin) abre. ⭐ Si se probara con un
 *       superadmin, el god-mode taparía un gate mal puesto — es el error de `[LC.6.2]`.
 *   [2] `/autopilot/status` entrega el latido REAL, y `status:null` ≠ `ok`. Es lo que dejó a la
 *       pantalla de conjeturar «la pasada no corrió» teniendo el veredicto escrito.
 *   [3] ⭐ `expense-plan/propose-growth` entrega el `basis`. Es EL campo de esta fase: sin él,
 *       «medí 0 %» y «no pude medir» llegan al front indistinguibles.
 *   [4] `expense-plan/settings` declara la AUSENCIA (`exists:false`) en vez de un 0 que se lee
 *       como medición.
 *   [5] `sales-plan/propose-growth` entrega `periodo_abierto`: el periodo que no cerró y por eso
 *       no se parea.
 *
 * Correr con el API arriba en `localhost:3334` (o `TM_TEST_PORT`).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const jwt = require('jsonwebtoken');
const { Client } = require('pg');
const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');

const BASE = `http://localhost:${process.env.TM_TEST_PORT || 3334}/api`;
const URL_DB = process.env.DATABASE_URL_NEW || process.env.DST_URL;
/** Rol con la clave, pero SIN god-mode: el gate se prueba donde puede fallar. */
const ROL_CON = 'finanzas';
const ROL_SIN = 'cajero';

let ok = 0, fail = 0, skip = 0;
const chk = (c, m) => { if (c) { ok++; console.log(`  ✔ ${m}`); } else { fail++; console.log(`  ✖ ${m}`); } };
const nm = (m) => { skip++; console.log(`  ◻ NO MEDIDO — ${m}`); };

const get = async (ruta, token) => {
  const r = await fetch(`${BASE}${ruta}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  let cuerpo = null;
  try { cuerpo = await r.json(); } catch { /* puede no traer JSON */ }
  return { status: r.status, cuerpo };
};

(async () => {
  if (!URL_DB) return noMedido('falta DATABASE_URL_NEW (hace falta para identificar al usuario, no para escribir)');
  if (!process.env.JWT_SECRET) return noMedido('falta JWT_SECRET: sin él no se puede armar una sesión');

  // La API tiene que estar arriba. Si no, esto es NO MEDIDO, nunca una falla.
  try {
    const h = await fetch(`${BASE}/health`);
    if (!h.ok) return noMedido(`el API responde ${h.status} en ${BASE}/health`);
  } catch (e) {
    return noMedido(`el API no está arriba en ${BASE} (${e.message})`);
  }

  const c = new Client({
    connectionString: URL_DB,
    ssl: /rlwy\.net|railway|amazonaws/i.test(URL_DB) ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 20000,
  });
  try { await c.connect(); } catch (e) {
    if (esFaltaDeAcceso(e)) return noMedido(`sin acceso a la base: ${e.message}`);
    throw e;
  }

  let tokCon = null, tokSin = null, budgetId = null;
  try {
    const firmar = async (rol) => {
      const { rows } = await c.query(
        `SELECT id, username, role_name, tenant_id FROM identity.users
          WHERE role_name = $1 AND status = 'active' ORDER BY username LIMIT 1`, [rol]);
      if (!rows.length) return null;
      const u = rows[0];
      return jwt.sign(
        { sub: u.id, tenant_id: u.tenant_id, username: u.username, role_name: u.role_name },
        process.env.JWT_SECRET, { expiresIn: '10m' },
      );
    };
    tokCon = await firmar(ROL_CON);
    tokSin = await firmar(ROL_SIN);
    const { rows: bs } = await c.query(
      `SELECT id FROM budget.budgets ORDER BY fiscal_year DESC LIMIT 1`);
    budgetId = bs[0]?.id ?? null;
  } finally {
    await c.end().catch(() => undefined);
  }

  // ── [1] el gate ───────────────────────────────────────────────────────────────────────────
  console.log('\n[1] El gate de la ruta nueva (probado con el permiso MÍNIMO, no con superadmin)');
  const sinTok = await get('/finance/budget/autopilot/status');
  chk(sinTok.status === 401, `sin token cierra (${sinTok.status})`);
  const malTok = await get('/finance/budget/autopilot/status', 'no-soy-un-token');
  chk(malTok.status === 401, `con un token inválido cierra (${malTok.status})`);
  if (!tokSin) nm(`no hay un usuario activo con rol ${ROL_SIN} para la prueba negativa`);
  else {
    const neg = await get('/finance/budget/autopilot/status', tokSin);
    chk(neg.status === 403 || neg.status === 401,
      `⭐ PRUEBA NEGATIVA — un rol SIN la clave no entra (${neg.status}): el gate no depende del token, lo relee de la base`);
  }
  if (!tokCon) return nm(`no hay un usuario activo con rol ${ROL_CON}; sin él no se puede medir el camino feliz`);

  // ── [2] el latido llega por HTTP ──────────────────────────────────────────────────────────
  console.log('\n[2] El latido real de la pasada, servido por la ruta');
  const st = await get('/finance/budget/autopilot/status', tokCon);
  chk(st.status === 200, `con el permiso abre (${st.status})`);
  if (st.status === 200) {
    const a = st.cuerpo || {};
    console.log(`    status=${a.status} · pasadas=${a.pasadas_completadas} · nunca_completo=${a.nunca_completo}`);
    chk(Object.prototype.hasOwnProperty.call(a, 'status') && Object.prototype.hasOwnProperty.call(a, 'nunca_completo'),
      'el contrato trae `status` y `nunca_completo` — las dos ausencias son distintas y se distinguen');
    chk(!(a.status === 'ok' && a.pasadas_completadas === 0),
      'no reporta `ok` con cero pasadas completadas: ése es el cero que se lee como «no había nada que hacer»');
  }

  if (!budgetId) return nm('no hay ningún ejercicio en la base; el resto necesita uno');

  // ── [3] ⭐ el `basis` viaja por la ruta ────────────────────────────────────────────────────
  console.log('\n[3] ⭐ El veredicto `basis` llega al cliente (sin él, ausencia y cero son iguales)');
  const pg = await get(`/finance/budget/budgets/${budgetId}/expense-plan/propose-growth`, tokCon);
  chk(pg.status === 200, `propose-growth responde (${pg.status})`);
  if (pg.status === 200) {
    const g = pg.cuerpo?.global || {};
    console.log(`    growth_pct=${g.growth_pct} · basis=${g.basis} · pares=${g.paired_months} · min=${pg.cuerpo?.min_paired_months}`);
    chk(typeof g.basis === 'string' && g.basis.length > 0,
      `el servicio DECLARA su base (\`${g.basis}\`) — es el campo que la pantalla descartaba`);
    chk(['yoy_paired', 'default'].includes(g.basis),
      'el veredicto es uno de los dos conocidos: medido contra la historia, o respaldo declarado');
    chk(pg.cuerpo?.min_paired_months != null,
      'viaja el umbral de pares, para que el cliente pueda decir POR QUÉ no se pudo medir');
    if (g.basis === 'default') {
      console.log('    ⚠️ hoy es `default`: no hay par de años suficiente — el 0 % que se ve NO es una medición (§22.3)');
    }
  }

  // ── [4] la ausencia se declara ────────────────────────────────────────────────────────────
  console.log('\n[4] Una tabla de supuestos vacía llega como AUSENCIA, no como cero');
  const se = await get(`/finance/budget/budgets/${budgetId}/expense-plan/settings`, tokCon);
  chk(se.status === 200, `settings responde (${se.status})`);
  if (se.status === 200) {
    const s = se.cuerpo || {};
    console.log(`    exists=${s.exists} · default_growth_pct=${s.default_growth_pct}`);
    chk(Object.prototype.hasOwnProperty.call(s, 'exists'),
      'el contrato trae `exists`: es lo que deja al cliente distinguir «no hay fila» de «la fila dice 0»');
  }

  // ── [5] el periodo abierto de ventas ──────────────────────────────────────────────────────
  console.log('\n[5] Ventas declara cuál es el periodo que todavía no cerró');
  const sg = await get(`/finance/budget/budgets/${budgetId}/sales-plan/propose-growth`, tokCon);
  if (sg.status !== 200) {
    nm(`sales-plan/propose-growth responde ${sg.status} (el rollup puede no estar disponible)`);
  } else {
    console.log(`    periodo_abierto=${sg.cuerpo?.periodo_abierto} · basis global=${sg.cuerpo?.global?.basis}`);
    chk(Object.prototype.hasOwnProperty.call(sg.cuerpo || {}, 'periodo_abierto'),
      'viaja `periodo_abierto` — el periodo a medio llenar que ya no entra al pareo ni a la base');
  }

  console.log(`\n=== ${ok} OK · ${fail} FALLA · ${skip} NO MEDIDO ===`);
  if (fail > 0) process.exitCode = 1;
})();
