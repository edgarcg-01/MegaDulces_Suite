/**
 * `[PGP.219]` C0 — EL INTERÉS DEL CRÉDITO, CALCULADO (anexo CR §3.3, DCR8/DCR10): la regla real
 * (`interesDelPeriodo`, `@megadulces/contracts`) contra la historia de los créditos que el banco cobra solo, en prod y
 * en SÓLO LECTURA.
 *
 *   A. LA HISTORIA — por crédito (cuenta + número del crédito, que viene en el concepto y aquí no se imprime): capital,
 *      «pago de intereses», «intereses no reales» e IVA de cada mes. El día del contrato es el menor día de cobro.
 *   B. TESTIGOS que la regla no usa:
 *      · el IVA es el 16 % del «pago de intereses» (al centavo casi todos los meses; los que no, se nombran);
 *      · el saldo que deriva la regla es un múltiplo exacto del capital (un crédito de pagos iguales de capital);
 *      · «intereses no reales» ÷ saldo es la MISMA en todos los créditos el mismo mes (la inflación del mes).
 *   C. ⭐ PREDECIR CADA MES CON LOS ANTERIORES — octubre y noviembre (y todo mes con 3 cobros previos): el interés total
 *      casa con lo cobrado ±$1. Contra el método de `[PGP.211]` («lo último que cobró el banco»): se mide su error.
 *   D. NEGATIVA — el día del cobro en vez del día del contrato: el interés por día deja de ser una recta (el porqué de
 *      la regla de días).
 *   Sin los datos de prod (CI): NO MEDIDO, nunca verde.
 */
const path = require('path');
const fs = require('fs');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
{
  const ts = require('typescript');
  const RAIZ = path.resolve(__dirname, '..', '..');
  const cfg = ts.parseConfigFileTextToJson('tsconfig.base.json', fs.readFileSync(path.join(RAIZ, 'tsconfig.base.json'), 'utf8')).config;
  const paths = cfg.compilerOptions.paths || {};
  const Module = require('module');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, ...rest) {
    return orig.call(this, paths[req] ? path.join(RAIZ, paths[req][0]) : req, ...rest);
  };
}
const { interesDelPeriodo, diasDelPeriodo, mesesEntre, TASA_IVA_DEL_INTERES } = require('../../libs/contracts/src/finance/interes-del-credito.contract.ts');

const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const knex = require('knex')(require('../knexfile-newdb.js').development);
const salir = async () => {
  await knex.destroy();
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
};
const $ = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dias = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

(async () => {
  console.log('[PGP.219] el interés del crédito, calculado — la regla real contra la historia de prod, sólo lectura\n');
  await knex.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
    const filas = (await trx.raw(`
      SELECT m.bank_account_id::text AS cuenta, a.bank, right(a.account_label, 4) AS cta,
             substring(m.concept FROM '([0-9]{6,})') AS credito,
             CASE WHEN m.concept ~* '^\\s*PAGO DE CAPITAL' THEN 'capital' WHEN m.concept ~* '^\\s*PAGO DE INTERESES' THEN 'real'
                  WHEN m.concept ~* '^\\s*INTERESES NO REALES' THEN 'no_real' ELSE 'iva' END AS parte,
             to_char(m.movement_date, 'YYYY-MM-DD') AS fecha, m.amount_out::float AS importe
        FROM finance.bank_movements m JOIN finance.bank_accounts a ON a.id = m.bank_account_id
       WHERE m.tenant_id = ? AND m.deleted_at IS NULL AND m.amount_out > 0 AND m.movement_date >= current_date - 400
         AND m.concept ~* '^\\s*(PAGO DE CAPITAL|PAGO DE INTERESES|INTERESES NO REALES|PAGO DE IVA)\\s+[0-9]{6,}'
       ORDER BY 1, 4, 6`, [T])).rows;
    if (!filas.length) { noMedido('no hay cobros de crédito en esta base (CI): la regla la cubre la prueba unitaria'); return; }

    // A. La historia por crédito.
    const creditos = new Map();
    for (const f of filas) {
      const k = `${f.cuenta}|${f.credito}`;
      if (!creditos.has(k)) creditos.set(k, { cuenta: `${f.bank} ${f.cta}`, filas: [] });
      creditos.get(k).filas.push(f);
    }
    let n = 0;
    const porMes = new Map(); // periodo → [inflación de cada crédito]
    for (const cr of creditos.values()) {
      n++;
      const nombre = `${cr.cuenta} · crédito ${n}`;
      const capitales = cr.filas.filter((f) => f.parte === 'capital');
      const capital = capitales.length ? capitales[capitales.length - 1].importe : 0;
      const dia = Math.min(...cr.filas.map((f) => Number(f.fecha.slice(8))));
      const cob = new Map();
      for (const f of cr.filas.filter((x) => x.parte !== 'capital')) {
        const p = f.fecha.slice(0, 7);
        const c = cob.get(p) || { periodo: p, real: 0, no_real: 0, iva: 0, fecha: f.fecha };
        c[f.parte] += f.importe;
        if (f.fecha > c.fecha) c.fecha = f.fecha;
        cob.set(p, c);
      }
      const cobros = [...cob.values()].sort((a, b) => (a.periodo < b.periodo ? -1 : 1)).map((c) => ({ ...c, real: +c.real.toFixed(2), no_real: +c.no_real.toFixed(2), iva: +c.iva.toFixed(2) }));
      console.log(`\n A. ${nombre}: capital fijo ${$(capital)} (${capitales.length} de ${capitales.length} iguales: ${capitales.every((c) => Math.abs(c.importe - capital) < 0.005)}), día del contrato ${dia}, ${cobros.length} meses con interés (${cobros[0]?.periodo}…${cobros[cobros.length - 1]?.periodo})`);
      if (cobros.length < 4) { noMedido(`${nombre}: menos de 4 meses de historia`); continue; }

      // B. Testigos.
      // El IVA es el 16 % del «pago de intereses» casi siempre al centavo; en algunos meses difiere unos pesos (medido el
      // 2026-11-26: 7 de 10 por crédito al centavo; enero, agosto —de la hoja— y septiembre, hasta $20). Se dice cuáles.
      const conIva = cobros.filter((c) => c.iva > 0);
      const difIva = conIva.map((c) => ({ p: c.periodo, d: c.iva - c.real * TASA_IVA_DEL_INTERES }));
      const alCentavo = difIva.filter((x) => Math.abs(x.d) <= 0.02);
      ok(alCentavo.length * 3 >= conIva.length * 2 && difIva.every((x) => Math.abs(x.d) <= 25),
        `${nombre}: el IVA es el ${TASA_IVA_DEL_INTERES * 100} % del «pago de intereses» al centavo en ${alCentavo.length} de ${conIva.length} meses; los otros difieren ${difIva.filter((x) => Math.abs(x.d) > 0.02).map((x) => `${x.p} ${$(x.d)}`).join(', ') || '—'} (techo $25); «intereses no reales» no lleva IVA`);

      // C. Cada mes con los anteriores.
      const resultados = [];
      for (const c of cobros) {
        const previos = cobros.filter((x) => x.periodo < c.periodo);
        if (previos.length < 3) continue;
        const r = interesDelPeriodo({ dia, capital, cobros: previos }, c.periodo);
        const real = c.real + c.no_real;
        const ultimo = previos[previos.length - 1];
        resultados.push({ p: c.periodo, r, real, errUltimo: Math.abs(ultimo.real + ultimo.no_real - real), c });
      }
      for (const x of resultados) {
        if (x.r.ok) console.log(`    · ${x.p}: calculado ${$(x.r.interes)} (saldo ${$(x.r.saldo)}, ${(x.r.tasa_anual * 100).toFixed(4)} % base 360, ${x.r.dias} días) · cobrado ${$(x.real)} · error ${$(Math.abs(x.r.interes - x.real))} · «lo último cobrado» erraba ${$(x.errUltimo)}`);
        else console.log(`    · ${x.p}: sin cálculo — ${x.r.motivo}`);
      }
      const objetivo = resultados.filter((x) => x.p === '2026-10' || x.p === '2026-11');
      if (objetivo.length < 2) noMedido(`${nombre}: falta octubre o noviembre en la historia`);
      else {
        ok(objetivo.every((x) => x.r.ok && Math.abs(x.r.interes - x.real) <= 1),
          `${nombre}: octubre y noviembre calculados con los meses anteriores casan con lo cobrado ±$1 (errores ${objetivo.map((x) => (x.r.ok ? $(Math.abs(x.r.interes - x.real)) : 'sin cálculo')).join(' y ')})`);
        ok(objetivo.every((x) => x.r.ok && Math.abs(x.r.interes - x.real) < x.errUltimo),
          `${nombre}: y yerran menos que «lo último que cobró el banco» (que yerra ${objetivo.map((x) => $(x.errUltimo)).join(' y ')})`);
      }
      const todos = resultados.filter((x) => x.r.ok);
      const malos = todos.filter((x) => Math.abs(x.r.interes - x.real) > 1);
      ok(todos.length >= 3 && malos.length === 0, `${nombre}: ${todos.length - malos.length} de ${todos.length} meses calculados casan ±$1${malos.length ? ` (no: ${malos.map((x) => x.p).join(', ')})` : ''}`);
      // Lo que va ESTIMADO (DCR10): el reparto real / no real y el IVA usan la inflación del último cobro, que cambia
      // cada mes. Se mide su error y el del cargo completo (interés + IVA), contra «lo último cobrado».
      const conIvaR = todos.filter((x) => x.r.iva !== null && x.c.iva > 0);
      if (conIvaR.length) {
        const errIva = conIvaR.map((x) => Math.abs(x.r.iva - x.c.iva));
        const errCargo = conIvaR.map((x) => Math.abs(x.r.interes + x.r.iva - (x.real + x.c.iva)));
        const errCargoUltimo = conIvaR.map((x) => {
          const u = cobros.filter((c) => c.periodo < x.p).slice(-1)[0];
          return Math.abs(u.real + u.no_real + u.iva - (x.real + x.c.iva));
        });
        const max = (a) => Math.max(...a);
        console.log(`    → estimado (inflación del mes anterior): error del IVA hasta ${$(max(errIva))}; del cargo de interés + IVA hasta ${$(max(errCargo))}, contra ${$(max(errCargoUltimo))} de «lo último cobrado»`);
        ok(errCargo.reduce((t, e) => t + e, 0) < errCargoUltimo.reduce((t, e) => t + e, 0),
          `${nombre}: el cargo de interés + IVA calculado yerra menos que «lo último cobrado» en la suma de ${conIvaR.length} meses (${$(errCargo.reduce((t, e) => t + e, 0))} contra ${$(errCargoUltimo.reduce((t, e) => t + e, 0))})`);
      }

      // B. El saldo es un múltiplo del capital, y la inflación del mes.
      const ultimoR = todos[todos.length - 1];
      if (ultimoR) {
        const pagos = ultimoR.r.saldo / capital;
        ok(Math.abs(pagos - Math.round(pagos)) < 0.001, `${nombre}: el saldo derivado (${$(ultimoR.r.saldo)}) es ${Math.round(pagos)} pagos de capital exactos (testigo: un crédito de capital igual cada mes)`);
        for (const x of todos) {
          const saldoMes = x.r.saldo; // el saldo durante ese periodo
          if (x.c.no_real > 0) porMes.set(x.p, [...(porMes.get(x.p) || []), x.c.no_real / saldoMes]);
        }
      }

      // D. NEGATIVA: con el día del COBRO, el interés por día deja de ser una recta.
      const recta = (diasDe) => {
        const d = cobros.slice(1).map((c, i) => ({ p: c.periodo, porDia: (c.real + c.no_real) / diasDe(cobros[i], c) }))
          .filter((x, i, a) => i > 0 && mesesEntre(a[i - 1].p, x.p) === 1 && x.p >= '2026-05');
        const caidas = d.slice(1).map((x, i) => d[i].porDia - x.porDia);
        return caidas.length ? Math.max(...caidas) - Math.min(...caidas) : null;
      };
      const conContrato = recta((a, b) => diasDelPeriodo(b.periodo, dia));
      const conCobro = recta((a, b) => dias(a.fecha, b.fecha));
      ok(conContrato !== null && conContrato <= 0.02 && conCobro > 1,
        `${nombre}: con el día del contrato el interés por día baja lo mismo cada mes (diferencia ${$(conContrato)}); con el día del cobro, no (${$(conCobro)}): por eso los días van de día del contrato a día del contrato`);
    }

    // B. La inflación del mes es la misma en todos los créditos.
    const comparables = [...porMes.entries()].filter(([, v]) => v.length >= 2);
    if (!comparables.length) noMedido('un solo crédito con «intereses no reales»: no hay contra qué comparar la inflación');
    else {
      const iguales = comparables.filter(([, v]) => Math.max(...v) - Math.min(...v) < 0.000005);
      ok(iguales.length === comparables.length,
        `«intereses no reales» ÷ saldo es la misma en todos los créditos en ${iguales.length} de ${comparables.length} meses (${comparables.map(([p, v]) => `${p} ${(v[0] * 100).toFixed(4)} %`).join(' · ')}): es la inflación del mes, y confirma el saldo derivado`);
    }
  });
  return salir();
})().catch(async (e) => { console.error('ERROR:', e.message); fail++; return salir(); });
