#!/usr/bin/env node
/**
 * [CXC.25] A quién le estás cobrando — el resolvedor de tipo de cuenta.
 *
 * ── QUÉ AFIRMA ───────────────────────────────────────────────────────────────────────────
 * `/finanzas/cartera` publicaba **$57,780,190.86** como si fueran clientes. Medido en prod el
 * 2026-09-24, **$26,583,657.82 (46.0%) son OCHO cuentas entre plazas propias** — `30-73 TLMKT
 * Morelia Abastos`, `10-00 P.V. Padre Hidalgo Piso`… y la balanza de contabilidad, que sí las
 * excluye, dice $9.1M. No estaban en desacuerdo: contaban cosas distintas.
 *
 * Este archivo afirma cuatro cosas, y cada una con su prueba negativa:
 *
 *  1. **El reparto no inventa ni pierde un peso.** Los tres tipos suman EXACTO el KPI.
 *  2. **El código afirma, el nombre rescata, `cliente_final` es el ELSE.** Los 5 casos que
 *     motivaron la precedencia, incluidos los dos que se contradicen entre sí.
 *  3. **La segunda señal sirve de verdad.** Hay cuentas que sólo el NOMBRE de Kepler delata; si
 *     el resolvedor fuera sólo el código, caerían como clientes.
 *  4. **`disputed` existe aunque hoy valga 0.** Una compuerta que nunca se ejerce igual tiene
 *     que estar: el día que las dos señales se peleen, no se elige en silencio.
 *
 * ⛔ El SQL del filtro se lee **del servicio real**, no se copia.
 * ⚠️ Sin datos reporta **NO MEDIDO**, nunca ✔.
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const DST = process.env.DATABASE_URL_NEW
  || (() => { throw new Error('falta DATABASE_URL_NEW'); })();
const TENANT = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const SRC = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib',
  'customer-ledger', 'customer-ledger.service.ts');

let ok = 0, fail = 0, nm = 0;
const P = (m) => { ok++; console.log(`  ✔ ${m}`); };
const F = (m) => { fail++; console.log(`  ✘ ${m}`); };
const NM = (m) => { nm++; console.log(`  ○ NO MEDIDO — ${m}`); };
const eq = (a, b, tol = 0.05) => Math.abs(Number(a) - Number(b)) <= tol;
const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function sqlDelServicio(filtros) {
  const src = fs.readFileSync(SRC, 'utf8');
  const i = src.indexOf("const VIVA = 'd.res > 0.005';");
  const j = src.indexOf('AS almacenes`;', i);
  if (i < 0 || j < 0) throw new Error('no se encontró el bloque SQL en customer-ledger.service.ts');
  const chunk = src.slice(i, j + 'AS almacenes`;'.length).replace('(extra: string)', '(extra)');
  return new Function('filtros', `${chunk}\nreturn sql;`)(filtros);
}
function aPg(sql) {
  let out = '', n = 0, dentro = false;
  for (const ch of sql) { if (ch === "'") dentro = !dentro; out += (ch === '?' && !dentro) ? `$${++n}` : ch; }
  return out;
}
/** Repite el plegado que el servicio hace en Node sobre las filas del SQL. */
function plegar(clientes) {
  const por = {}; let total = 0, n = 0, sinKind = 0;
  for (const c of clientes) {
    const saldo = Math.max(Number(c.saldo_cliente) || 0, 0);
    if (saldo <= 0.005) continue;
    const k = c.cuenta_kind;
    if (!k) sinKind++;
    por[k || '(null)'] = por[k || '(null)'] || { saldo: 0, n: 0, fuentes: {} };
    por[k || '(null)'].saldo += saldo; por[k || '(null)'].n++;
    const s = c.cuenta_kind_source || '(null)';
    por[k || '(null)'].fuentes[s] = (por[k || '(null)'].fuentes[s] || 0) + 1;
    total += saldo; n++;
  }
  return { por, total, n, sinKind };
}

(async () => {
  const c = new Client({ connectionString: DST, statement_timeout: 300000 });
  await c.connect();
  const dest = (await c.query('SELECT inet_server_addr()::text h, current_database() d')).rows[0];
  console.log(`\n[CXC.25] tipo de cuenta de cliente  —  ${dest.h || 'local'}/${dest.d}\n`);

  const existe = (await c.query(
    `SELECT to_regclass('analytics.v_customer_account_kind') v,
            to_regprocedure('analytics.customer_account_kind(text,text)') f`)).rows[0];
  if (!existe.v || !existe.f) {
    NM('falta la migración 20260924180000 (v_customer_account_kind + funciones): no hay resolvedor '
      + 'que comprobar. Aplicarla ANTES de desplegar el servicio, que ya la consume.');
    console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
    await c.end(); process.exit(0);
  }

  // ── 1. Los 5 casos de la precedencia ───────────────────────────────────────────────────
  console.log('1) El código afirma · el nombre rescata · cliente_final es el ELSE');
  const casos = [
    ['2-32-RV01', 'R.V. MORELIA MADERO 01', 'ruta', 'nombre', 'el código calla y el nombre lo delata'],
    ['2-32-321', 'RD MORELIA 321 JOSEPH AGUSTIN', 'ruta', 'nombre', 'ídem, con otro formato de nombre'],
    ['RUTA 505', 'TAMPORAL', 'ruta', 'codigo', 'el código afirma sobre un nombre basura'],
    ['30-73', 'TLMKT Morelia Abastos', 'interno', 'codigo', 'la cuenta interna más grande de la red'],
    ['C1015', 'JUAN PABLO FONSECA GUTIÉRREZ', 'cliente_final', 'ninguno', 'un cliente de verdad'],
  ];
  for (const [code, nombre, kind, src, porque] of casos) {
    const r = (await c.query(
      'SELECT analytics.customer_account_kind($1,$2) k, analytics.customer_account_kind_source($1,$2) s',
      [code, nombre])).rows[0];
    (r.k === kind && r.s === src)
      ? P(`${code} → ${kind}/${src} — ${porque}`)
      : F(`${code} dio ${r.k}/${r.s} y se esperaba ${kind}/${src}`);
  }
  // ⚠️ NEGATIVA: los dos casos de arriba se CONTRADICEN si se aplica una sola señal. Con sólo
  // el código, `2-32-RV01` sería cliente; con sólo el nombre, `RUTA 505` también. La precedencia
  // es lo único que resuelve los dos, y esto lo demuestra en vez de afirmarlo.
  const soloCodigo = (await c.query(
    `SELECT analytics.customer_account_kind_by_code('2-32-RV01') a,
            analytics.customer_account_kind_by_name('TAMPORAL') b`)).rows[0];
  (soloCodigo.a === null && soloCodigo.b === null)
    ? P('prueba negativa: con UNA sola señal los dos casos se van a cliente_final — hacen falta las dos')
    : F(`una señal sola ya resolvía los casos (código=${soloCodigo.a}, nombre=${soloCodigo.b}): la precedencia no está probando nada`);

  // ── 2. El reparto cuadra con el KPI ────────────────────────────────────────────────────
  console.log('\n2) El reparto no inventa ni pierde un peso');
  const t0 = Date.now();
  const row = (await c.query(aPg(sqlDelServicio('')), [TENANT, TENANT])).rows[0];
  const ms = Date.now() - t0;
  const A = plegar(row.clientes || []);
  if (!A.n) {
    NM('la cartera no tiene cuentas con saldo en esta base: no hay reparto que comprobar');
  } else {
    const suma = Object.values(A.por).reduce((s, v) => s + v.saldo, 0);
    eq(suma, A.total)
      ? P(`los ${Object.keys(A.por).length} tipos suman el total: $${money(suma)} (${A.n} cuentas, ${ms} ms)`)
      : F(`los tipos suman $${money(suma)} y el total es $${money(A.total)}`);
    A.sinKind === 0
      ? P('ninguna cuenta con saldo quedó sin tipo (un NULL se leería como cliente)')
      : F(`${A.sinKind} cuentas con saldo llegaron sin cuenta_kind`);
    for (const [k, v] of Object.entries(A.por).sort((x, y) => y[1].saldo - x[1].saldo)) {
      console.log(`      ${k.padEnd(14)} $${money(v.saldo).padStart(16)}  ${String(v.n).padStart(5)} cuentas  ${JSON.stringify(v.fuentes)}`);
    }
  }

  // ── 3. La segunda señal sirve ──────────────────────────────────────────────────────────
  console.log('\n3) El nombre rescata cuentas que el código deja pasar');
  const rescate = (await c.query(`
    SELECT count(*)::int n, COALESCE(string_agg(cliente_code, ', ' ORDER BY cliente_code), '') codigos
      FROM analytics.v_customer_account_kind WHERE kind_source = 'nombre'`)).rows[0];
  if (Number(rescate.n) > 0) {
    P(`${rescate.n} cuentas las clasifica SÓLO el nombre: ${rescate.codigos}`);
    // NEGATIVA: sin la señal del nombre, esas mismas caerían a cliente_final.
    const caerian = (await c.query(`
      SELECT count(*)::int n FROM analytics.v_customer_account_kind
       WHERE kind_source = 'nombre' AND analytics.customer_account_kind_by_code(cliente_code) IS NOT NULL`)).rows[0];
    Number(caerian.n) === 0
      ? P('prueba negativa: sin el nombre, esas cuentas no tendrían NINGUNA señal y serían «cliente»')
      : F(`${caerian.n} de ellas ya las resolvía el código: el rescate del nombre no está probando nada`);
  } else {
    NM('hoy ninguna cuenta se resuelve sólo por el nombre. No significa que la señal sobre — '
      + 'significa que hoy no hay caso que ejercer. Vuelve a tener sentido con un código nuevo.');
  }

  // ── 4. La compuerta de la disputa ──────────────────────────────────────────────────────
  console.log('\n4) Cuando las dos señales se peleen, no se elige en silencio');
  const dis = (await c.query(`
    SELECT count(*) FILTER (WHERE disputed)::int disputadas, count(*)::int total
      FROM analytics.v_customer_account_kind`)).rows[0];
  Number(dis.disputadas) === 0
    ? P(`0 disputadas de ${dis.total} — y la columna existe para el día que no sea 0`)
    : F(`${dis.disputadas} cuentas donde código y nombre afirman distinto: hay que arbitrarlas a mano`);

  // ── 5. El filtro filtra, y no se recorta a sí mismo ────────────────────────────────────
  console.log('\n5) El filtro por tipo');
  const kinds = (row.opciones?.cuentas || []);
  if (!kinds.length) {
    NM('el universo no ofrece ningún tipo de cuenta: nada que filtrar');
  } else {
    const uno = kinds.includes('interno') ? 'interno' : kinds[0];
    const f = (await c.query(aPg(sqlDelServicio('WHERE d.cuenta_kind = ?')), [TENANT, uno, TENANT])).rows[0];
    const B = plegar(f.clientes || []);
    const soloUno = Object.keys(B.por);
    (soloUno.length === 1 && soloUno[0] === uno)
      ? P(`cuenta='${uno}' devuelve sólo ese tipo ($${money(B.total)}, ${B.n} cuentas)`)
      : F(`el filtro dejó pasar ${soloUno.join(', ')}`);
    JSON.stringify((f.opciones?.cuentas || []).slice().sort()) === JSON.stringify(kinds.slice().sort())
      ? P('con el tipo filtrado, el desplegable sigue ofreciendo todos')
      : F('filtrar por tipo recortó el propio desplegable: quedaría sin forma de volver');
    eq(B.total, (A.por[uno] || { saldo: 0 }).saldo)
      ? P(`el filtrado coincide con su renglón del reparto sin filtro: $${money(B.total)}`)
      : F(`filtrado $${money(B.total)} contra $${money((A.por[uno] || {}).saldo)} del reparto`);
  }

  console.log(`\n${ok} ✔ · ${fail} ✘ · ${nm} ○ NO MEDIDO\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n✘ ', e.message); process.exit(1); });
