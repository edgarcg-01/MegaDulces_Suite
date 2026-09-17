/* eslint-disable no-console */
/**
 * CG.13 — CANDADO: la tolerancia de conciliación caja↔bancos es UNA, está declarada, y el
 * matcher la RESPETA de los dos lados.
 *
 * Nace del pedido de Finanzas (2026-09-17): *"hay que permitir que caja general y bancos se
 * concilien hasta por 5 pesos"*. Al ir a cambiarla aparecieron dos defectos que el pedido, por
 * sí solo, no habría destapado:
 *
 *  1. **La tolerancia estaba escrita TRES veces a mano** — `MATCH_EPS`, el `AMT_TOL` del matcher
 *     por movimiento (en centavos) y el `EPS` del cuadre por día. Mover una sola dejaba la
 *     pantalla rotulando un número y el matcher usando otro.
 *  2. ⛔ **El matcher depósito↔banco NO tenía tolerancia**, aunque su comentario decía "±$1".
 *     Indexaba por `canon|round(monto)` y pedía el balde EXACTO: eso no es ±$1, es "que
 *     redondeen al mismo peso". `$100.49` y `$100.51` **no casaban** (dos centavos, baldes 100 y
 *     101) mientras `$100.01` y `$100.99` sí. Y un balde no se amplía: subir la constante no
 *     cambiaba nada ahí, así que la pantalla iba a decir ±$5 con un matcher que no toleraba un
 *     centavo.
 *
 * Lo que este archivo protege:
 *
 *  · Que exista UNA constante y que las otras dos se DERIVEN de ella (fuente, no comportamiento:
 *    es lo único que impide que vuelvan a divergir en silencio).
 *  · ⭐ Que ningún par casado difiera por más que la tolerancia — contra los datos VIVOS. Es la
 *    aserción que vale: si alguien vuelve a poner un balde exacto o se le va la mano con la
 *    tolerancia, este número lo dice.
 *  · Que ampliar la tolerancia sea MONÓTONO (±$5 casa al menos lo que casaba ±$1). Un matcher
 *    greedy mal escrito puede casar MENOS al ampliar, porque consume candidatos antes.
 *  · Que lo que no se puede medir se DECLARE: si el período no trae movimientos, el bloque
 *    reporta NO MEDIDO, no ✔ (ADR-056).
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-caja-tolerancia.js
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const T = '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW'); })();
const SRC = path.join(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'caja', 'caja-general.service.ts');

let ok = 0, fail = 0, nm = 0;
const check = (cond, label, detalle) => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detalle ? `\n      ${detalle}` : ''}`); }
};
const nomedido = (label, motivo) => { nm++; console.log(`  ⊘ NO MEDIDO — ${label}\n      ${motivo}`); };

const n = (x) => Number(x) || 0;
const cents = (v) => Math.round(n(v) * 100);
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * El MISMO algoritmo greedy de `conciliacionDia`, parametrizado por tolerancia en centavos.
 * Devuelve además los PARES, que es lo que permite auditar que la tolerancia se respetó.
 */
function matchDir(caja, other, AMT_TOL) {
  const byAmt = new Map();
  for (const o of other) { const k = cents(o.amt); (byAmt.get(k) ?? byAmt.set(k, []).get(k)).push(o); }
  const pairs = []; let cajaOnly = 0;
  for (const c of caja) {
    const t = cents(c.amt); let hit = null;
    for (let d = 0; d <= AMT_TOL && !hit; d++) {
      for (const cand of d === 0 ? [t] : [t - d, t + d]) {
        const b = byAmt.get(cand);
        if (b && b.length) { hit = b.shift(); break; }
      }
    }
    if (hit) pairs.push({ a: c.amt, b: hit.amt }); else cajaOnly++;
  }
  return { pairs, cajaOnly };
}

(async () => {
  console.log('\n=== CG.13 — tolerancia de conciliación caja↔bancos ===\n');

  // ── Bloque 1 — la tolerancia es UNA y las otras se derivan (fuente) ──────────────────────
  console.log('1) UNA sola tolerancia declarada, las demás derivadas');
  const src = fs.readFileSync(SRC, 'utf8');
  const sinComentarios = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const m = /const MATCH_EPS = ([\d.]+);/.exec(sinComentarios);
  check(!!m, 'MATCH_EPS está declarada como constante');
  const EPS = m ? Number(m[1]) : NaN;
  check(EPS === 5, `MATCH_EPS = 5 (Finanzas, 2026-09-17) — leído: ${EPS}`);
  check(/const AMT_TOL = MATCH_EPS \* 100;/.test(sinComentarios),
    'el AMT_TOL del matcher por movimiento se DERIVA de MATCH_EPS (no es un literal en centavos)');
  check(/const EPS = MATCH_EPS;/.test(sinComentarios),
    'el EPS del cuadre por día se DERIVA de MATCH_EPS');
  // NEGATIVA del defecto 2: no puede volver el balde exacto.
  check(!/byKey\.get\(`\$\{canon\}\|\$\{Math\.round\(amt\)\}`\)/.test(sinComentarios),
    '⭐ el matcher depósito↔banco NO vuelve al balde exacto por peso redondeado',
    'ese índice ignora la tolerancia: $100.49 y $100.51 no casan y $100.01 y $100.99 sí');
  check(/Math\.abs\(b\.amt - amt\) <= MATCH_EPS/.test(sinComentarios),
    'depósito↔banco filtra por la diferencia REAL de importe contra MATCH_EPS');
  check(/Math\.abs\(x\.amt - b\.monto\) <= MATCH_EPS/.test(sinComentarios),
    'el 2º pase (cobranza) también filtra por la diferencia real');

  // ── Bloque 2 — contra los datos vivos: la tolerancia se respeta y ampliar es monótono ────
  console.log('\n2) contra datos VIVOS: ningún par casado excede la tolerancia');
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  try {
    const to = (await c.query('SELECT CURRENT_DATE::text d')).rows[0].d;
    const from = (await c.query(`SELECT (CURRENT_DATE - 90)::text d`)).rows[0].d;
    const mdb = (await c.query(
      `SELECT fecha, ingreso, gasto FROM analytics.caja_general_movimientos
        WHERE tenant_id=$1 AND fecha BETWEEN $2 AND $3`, [T, from, to])).rows;
    const man = (await c.query(
      `SELECT bm.movement_date AS fecha, bm.amount_in, bm.amount_out
         FROM finance.bank_movements bm JOIN finance.bank_accounts ba ON ba.id = bm.bank_account_id
        WHERE bm.tenant_id=$1 AND coalesce(ba.kind,'bank')='cash' AND bm.deleted_at IS NULL
          AND bm.movement_date BETWEEN $2 AND $3`, [T, from, to])).rows;

    /**
     * ⭐ El lado KEPLER es obligatorio acá, y casi lo dejo afuera. Con sólo el workbook, ±$1 y
     * ±$5 dan EXACTAMENTE lo mismo (4,051 pares, peor diferencia $0.31): la captura manual y el
     * .mdb ya coinciden al centavo, así que la ampliación es invisible. Los 18 pares que la
     * ampliación gana salen del ERP. Un candado que no puede observar lo que cuida no sirve.
     */
    const kep = (await c.query(
      `SELECT fecha_valor AS fecha, importe, signo FROM analytics.kepler_bank_movements
        WHERE tenant_id=$1 AND account_label='CG' AND fecha_valor BETWEEN $2 AND $3`, [T, from, to])).rows;

    if (!mdb.length || (!man.length && !kep.length)) {
      nomedido('el matcher contra datos vivos',
        `sin movimientos en ${from}..${to} (Control ${mdb.length}, banco ${man.length}, Kepler ${kep.length}) — el bloque NO se puede comprobar`);
    } else {
      const key = (f) => String(f instanceof Date ? f.toISOString() : f).slice(0, 10);
      const dias = [...new Set(mdb.map((r) => key(r.fecha)))].sort();
      const side = (rows, col) => rows.filter((r) => n(r[col]) > 0).map((r) => ({ amt: n(r[col]) }));

      const correr = (tol) => {
        let pares = 0, huerf = 0, peor = 0;
        for (const d of dias) {
          const md = mdb.filter((r) => key(r.fecha) === d);
          const mn = man.filter((r) => key(r.fecha) === d);
          const kp = kep.filter((r) => key(r.fecha) === d);
          const kepSide = (s) => kp.filter((r) => (n(r.signo) > 0 ? 1 : -1) === s).map((r) => ({ amt: n(r.importe) }));
          // Las CUATRO comparaciones del service: Control×workbook y Control×Kepler, por dirección.
          for (const [ca, ot] of [
            [side(md, 'ingreso'), side(mn, 'amount_in')], [side(md, 'gasto'), side(mn, 'amount_out')],
            [side(md, 'ingreso'), kepSide(1)], [side(md, 'gasto'), kepSide(-1)],
          ]) {
            const res = matchDir(ca, ot, tol);
            pares += res.pairs.length; huerf += res.cajaOnly;
            for (const p of res.pairs) peor = Math.max(peor, Math.abs(p.a - p.b));
          }
        }
        return { pares, huerf, peor: r2(peor) };
      };

      const a1 = correr(100), a5 = correr(EPS * 100);
      console.log(`     ±$1  → ${a1.pares} pares, ${a1.huerf} huérfanos, peor diferencia $${a1.peor}`);
      console.log(`     ±$${EPS}  → ${a5.pares} pares, ${a5.huerf} huérfanos, peor diferencia $${a5.peor}`);

      check(a5.peor <= EPS + 1e-9,
        `⭐ ningún par casado excede ±$${EPS} — peor diferencia real: $${a5.peor}`,
        'si esto falla, el matcher está casando cosas que no debería');
      check(a5.pares >= a1.pares,
        `ampliar la tolerancia es MONÓTONO: ${a1.pares} → ${a5.pares} pares`,
        'un greedy mal escrito puede casar MENOS al ampliar, porque consume candidatos antes');
      check(a5.huerf <= a1.huerf,
        `y no fabrica huérfanos: ${a1.huerf} → ${a5.huerf}`);
      if (a5.pares === a1.pares) {
        nomedido('el EFECTO de la ampliación',
          'en esta ventana ±$5 casa exactamente lo mismo que ±$1: el cambio no se puede observar acá (no es una falla)');
      } else {
        check(true, `la ampliación tiene efecto medible: +${a5.pares - a1.pares} pares que antes quedaban huérfanos`);
      }
    }
  } finally { await c.end(); }

  console.log(`\n=== ${ok} ✔ · ${fail} ✗ · ${nm} ⊘ NO MEDIDO ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
