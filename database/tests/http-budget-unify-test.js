/* eslint-disable no-console */
/**
 * HTTP smoke — el UNIFY del gasto (Fase PU, Bloques B1/B2, ADR-066), por la ruta de verdad.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * Cerrar las «dos verdades del gasto» sólo se prueba EJERCIENDO el Calendario de Pagos y mirando el
 * ledger de la partida moverse. Un smoke DB-direct no ejerce el puerto BUDGET_LEDGER_PORT ni los
 * guards/RLS; por eso ADR-044 exige HTTP. Este archivo lo aplica: siembra el escenario por pg,
 * autoriza/paga/cancela por HTTP, y VERIFICA el ledger de la partida por pg.
 *
 * ── Qué ejerce (el mapeo §16.3 default) ─────────────────────────────────────
 *   1. authorize(obligaciones) → COMPROMETE la partida ligada (committed += original).
 *   2. NEGATIVA: autorizar sobre una partida 'bloqueo' que sobregira FALLA (400) y NO deja rastro
 *      (committed sigue 0, la obligación sigue 'propuesta') — atomicidad del control de presupuesto.
 *   3. crear pago + preparar + EJECUTAR → EJERCE+PAGA la partida (committed→exercised→paid).
 *   4. cancelar una obligación PENDING → LIBERA su compromiso (committed vuelve).
 *
 * Self-contained: siembra su rol + usuario + presupuesto + partidas + obligaciones, y limpia al final.
 * ⛔ NO corre contra producción (`assertSafeTarget`). Requiere API en :3334 con ENABLE_MULTITENANT=true
 * y la mig `20260921200000` aplicada. Si la API no está, declara NO MEDIDO (exit 2), no verde.
 *
 * Correr: node database/tests/http-budget-unify-test.js
 */
const BASE = `http://localhost:${process.env.TM_TEST_PORT || 3334}/api`;
const { Client } = require('pg');
try { require('dotenv').config(); } catch (e) { /* dotenv opcional */ }
require('./_lib/assert-safe-target').assertSafeTarget('http-budget-unify-test');

const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@127.0.0.1:5432/postgres_platform';
const M = '00000000-0000-0000-0000-00000000d01c';
const ROL = 'unify_smoke_rol';
const USER = 'unify_smoke_user';
const CLAVE = 'unify_smoke_2026';
const stamp = Date.now();

let ok = 0, fail = 0, sinMedir = 0;
const check = (t, cond, extra = '') => { if (cond) { ok++; console.log(`  ✅ ${t}`); } else { fail++; console.log(`  ❌ ${t}${extra ? ` — ${extra}` : ''}`); } };
const declarar = (t, motivo) => { sinMedir++; console.log(`  ⓘ NO MEDIDO ${t} — ${motivo}`); };

async function req(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (e) { /* puede venir vacío */ }
  return { status: r.status, json };
}
async function login(username, password) {
  const r = await req('POST', '/auth-mt/login', null, { tenant_slug: 'mega_dulces', username, password });
  return r.json?.access_token || null;
}

(async () => {
  try {
    const ping = await fetch(`${BASE}/health`).catch(() => null);
    if (!ping) throw new Error('sin respuesta');
  } catch (e) {
    declarar('la suite entera', `la API en ${BASE} no contesta: levantala con ENABLE_MULTITENANT=true`);
    console.log(`\nⓘ 0 ok, 0 fallos, ${sinMedir} no medido(s) — no es «pasó», es que no había con qué comprobarlo.`);
    process.exit(2);
  }

  const db = new Client({ connectionString: DST });
  await db.connect();
  const q = async (s, p) => (await db.query(s, p)).rows;
  const ids = { budget: null, lineA: null, lineB: null, o1: null, o2: null, o3: null, obl: [] };

  const limpiar = async () => {
    if (ids.obl.length) {
      const al = await q('SELECT DISTINCT allocation_id FROM finance.payment_allocation_items WHERE obligation_id = ANY($1)', [ids.obl]);
      const allocIds = al.map((r) => r.allocation_id);
      await q('DELETE FROM finance.payment_allocation_items WHERE obligation_id = ANY($1)', [ids.obl]);
      if (allocIds.length) {
        const lots = await q('SELECT DISTINCT lot_id FROM finance.payment_allocations WHERE id = ANY($1)', [allocIds]);
        await q('DELETE FROM finance.payment_allocations WHERE id = ANY($1)', [allocIds]);
        for (const l of lots) {
          const [{ n }] = await q('SELECT count(*)::int n FROM finance.payment_allocations WHERE lot_id = $1', [l.lot_id]);
          if (Number(n) === 0) await q('DELETE FROM finance.payment_calendar_lots WHERE id = $1', [l.lot_id]);
        }
      }
    }
    const lineIds = [ids.lineA, ids.lineB].filter(Boolean);
    if (lineIds.length) await q('DELETE FROM budget.line_movements WHERE budget_line_id = ANY($1)', [lineIds]);
    if (ids.obl.length) await q('DELETE FROM budget.expense_obligations WHERE id = ANY($1)', [ids.obl]);
    if (ids.budget) {
      await q('DELETE FROM budget.budget_lines WHERE budget_id = $1', [ids.budget]);
      await q('DELETE FROM budget.budgets WHERE id = $1', [ids.budget]);
    }
    await q('DELETE FROM identity.users WHERE tenant_id = $1 AND username = $2', [M, USER]);
    await q('DELETE FROM identity.role_permissions WHERE tenant_id = $1 AND role_name = $2', [M, ROL]);
  };

  const line = async (id) => (await q('SELECT committed_amount c, exercised_amount e, paid_amount p, reserved_amount r FROM budget.budget_lines WHERE id = $1', [id]))[0];
  const oblStatus = async (id) => (await q('SELECT status FROM budget.expense_obligations WHERE id = $1', [id]))[0]?.status;
  const n = (v) => Math.round(Number(v) * 100) / 100;

  try {
    await limpiar();

    // ── Precondición: la mig del unify/fallback debe estar aplicada ────────────
    const chk = await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='budget_sales_plan_method_valid'`);
    if (!chk.length || !/proxy_canal/.test(chk[0].d)) {
      declarar('unify', 'falta aplicar la mig 20260921200000 (el CHECK no tiene proxy_canal)');
    }

    // ── Siembra (pg) ──────────────────────────────────────────────────────────
    const perms = { PRESUPUESTOS_VER: true, PRESUPUESTOS_GESTIONAR: true, FINANCE_PAYMENTS_VER: true, FINANCE_PAYMENTS_GESTIONAR: true };
    await q(`INSERT INTO identity.role_permissions (tenant_id, role_name, permissions) VALUES ($1,$2,$3::jsonb)`, [M, ROL, JSON.stringify(perms)]);
    const hash = await require('bcryptjs').hash(CLAVE, 10);
    await q(`INSERT INTO identity.users (tenant_id, username, nombre, password_hash, role_name, department_code, kind, status, must_change_password)
             VALUES ($1,$2,'Unify smoke',$3,$4,'sistemas','interno','active',false)`, [M, USER, hash, ROL]);

    const [bud] = await q(`INSERT INTO budget.budgets (tenant_id, name, fiscal_year, status, created_by) VALUES ($1,$2,2026,'aprobado','seed') RETURNING id`, [M, 'unify smoke ' + stamp]);
    ids.budget = bud.id;
    const mkLine = async (concept, vigente, control, sref) => (await q(
      `INSERT INTO budget.budget_lines (tenant_id, budget_id, concept, line_type, original_amount, vigente_amount, control_level, status, source, source_ref, created_by)
       VALUES ($1,$2,$3,'gasto',$4,$4,$5,'activa','plan',$6,'seed') RETURNING id`, [M, ids.budget, concept, vigente, control, sref]))[0].id;
    ids.lineA = await mkLine('Renta A', 100000, 'advertencia', `gasto:UNIFYA:${stamp}`);
    ids.lineB = await mkLine('Renta B', 20000, 'bloqueo', `gasto:UNIFYB:${stamp}`);
    const mkObl = async (amount, lineId, tag) => (await q(
      `INSERT INTO budget.expense_obligations (tenant_id, concept, beneficiary, original_amount, status, source, source_ref, budget_line_id, created_by)
       VALUES ($1,$2,'ARRENDADOR',$3,'propuesta','plan',$4,$5,'seed') RETURNING id`, [M, 'Renta ' + tag, amount, `plan:unify:${stamp}:${tag}`, lineId]))[0].id;
    ids.o1 = await mkObl(40000, ids.lineA, 'o1');
    ids.o2 = await mkObl(30000, ids.lineA, 'o2');
    ids.o3 = await mkObl(40000, ids.lineB, 'o3');
    ids.obl = [ids.o1, ids.o2, ids.o3];

    const tok = await login(USER, CLAVE);
    if (!tok) { declarar('login del smoke', 'la API no emitió token (¿ENABLE_MULTITENANT?)'); throw new Error('__SIN_TOKEN__'); }

    // ── 1. authorize → COMPROMISO en la partida A ─────────────────────────────
    const r1 = await req('POST', '/finance/budget/expenses/authorize', tok, { ids: [ids.o1, ids.o2] });
    check('authorize responde 2xx', r1.status >= 200 && r1.status < 300, `status ${r1.status}`);
    const a1 = await line(ids.lineA);
    check('authorize COMPROMETE la partida (committed = 40k+30k)', n(a1.c) === 70000, `committed=${a1?.c}`);
    check('authorize deja las obligaciones en pending', (await oblStatus(ids.o1)) === 'pending', await oblStatus(ids.o1));

    // ── 2. NEGATIVA: autorizar sobre partida 'bloqueo' que sobregira FALLA ─────
    const r2 = await req('POST', '/finance/budget/expenses/authorize', tok, { ids: [ids.o3] });
    const b2 = await line(ids.lineB);
    check('autorizar sobre partida bloqueo (sobregiro) NO deja committed (atómico)', n(b2.c) === 0, `committed=${b2?.c}, status ${r2.status}`);
    check('la obligación sobregirada sigue en propuesta (rollback)', (await oblStatus(ids.o3)) === 'propuesta', await oblStatus(ids.o3));

    // ── 3. pago (crear + preparar + ejecutar) → EJERCE+PAGA la partida A ───────
    const fecha = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const rAlloc = await req('POST', '/finance/payment-calendar/allocations', tok, { date: fecha, items: [{ obligation_source: 'budget_expense', obligation_id: ids.o1, applied_amount: 40000 }] });
    const allocId = rAlloc.json?.id;
    check('crear pago responde 2xx con id', !!allocId, `status ${rAlloc.status}`);
    if (allocId) {
      const rPrep = await req('POST', `/finance/payment-calendar/allocations/${allocId}/preparar`, tok, { payment_method: 'efectivo', cash_register_text: 'CAJA-UNIFY' });
      check('preparar pago responde 2xx', rPrep.status >= 200 && rPrep.status < 300, `status ${rPrep.status}`);
      const rExec = await req('POST', `/finance/payment-calendar/allocations/${allocId}/ejecutar`, tok, {});
      check('ejecutar pago responde 2xx', rExec.status >= 200 && rExec.status < 300, `status ${rExec.status}`);
      const a3 = await line(ids.lineA);
      check('ejecutar EJERCE la partida (exercised = 40k)', n(a3.e) === 40000, `exercised=${a3?.e}`);
      check('ejecutar PAGA la partida (paid = 40k)', n(a3.p) === 40000, `paid=${a3?.p}`);
      check('ejercer bajó el compromiso (committed 70k→30k)', n(a3.c) === 30000, `committed=${a3?.c}`);
    }

    // ── 4. cancelar obligación PENDING → LIBERA su compromiso ──────────────────
    const rCancel = await req('POST', `/finance/budget/expenses/${ids.o2}/cancelar`, tok, { reason: 'smoke' });
    check('cancelar responde 2xx', rCancel.status >= 200 && rCancel.status < 300, `status ${rCancel.status}`);
    const a4 = await line(ids.lineA);
    check('cancelar LIBERA el compromiso de o2 (committed 30k→0)', n(a4.c) === 0, `committed=${a4?.c}`);
  } catch (e) {
    if (e.message !== '__SIN_TOKEN__') throw e;
  } finally {
    await limpiar().catch(() => undefined);
    await db.end().catch(() => undefined);
  }

  console.log(`\n${fail === 0 && sinMedir === 0 ? '✅' : fail === 0 ? 'ⓘ' : '❌'} http-budget-unify: ${ok} ok, ${fail} fallo(s), ${sinMedir} no medido(s)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
