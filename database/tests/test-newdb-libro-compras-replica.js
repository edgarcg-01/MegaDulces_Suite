/* eslint-disable no-console */
/**
 * `[LC.18]` — Candado de ACEPTACIÓN del libro de compras: **¿el generador arma la misma póliza
 * que la contadora sube a mano?**
 *
 * El criterio del plan (FASE_LC «Criterio de aceptación»): *si no reproduce el pasado, no se usa
 * para el futuro*. Los testigos son los libros reales de ContPAQi (Diario folio 1) de
 * jul/ago/sep-2026, armados a mano. Por cada abono a proveedor (212) del libro real se busca su
 * CFDI —cuenta del proveedor + últimos 5 del folio + total— y se regenera su asiento con el
 * servicio REAL (`getMes` + `construirMovimientos` + `cuentasImpuesto`). Se exige:
 *
 *   1. ⭐ cada factura: sus patas 212 / 501 / 502 IGUALES al centavo a las del libro real;
 *   2. la referencia del renglón = la del libro real (últimos 5 del folio);
 *   3. las cuentas de IVA e IEPS = las que usó ese libro (sep-2026 cambió de cuentas);
 *   4. el renglón global de IVA e IEPS = el real, menos lo de las facturas que no se pudieron
 *      casar (que se DECLARAN, con monto, no se esconden);
 *   5. ⛔ prueba negativa: con el reparto anterior (subtotal de conceptos + todo el IEPS) el
 *      punto 1 se pone rojo. Si no, el candado no está midiendo nada.
 *
 * Sólo lectura: corre contra prod (los testigos sólo existen ahí). En un destino sin pólizas
 * reales se declara NO MEDIDO.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'commonjs', target: 'es2020', esModuleInterop: true,
    experimentalDecorators: true, emitDecoratorMetadata: true,
    moduleResolution: 'node', ignoreDeprecations: '6.0',
  },
});
const ALIAS = {};
for (const m of fs.readFileSync(path.join(ROOT, 'tsconfig.base.json'), 'utf8')
  .matchAll(/"(@megadulces\/[^"]+)"\s*:\s*\[\s*"([^"]+)"/g)) {
  ALIAS[m[1]] = path.join(ROOT, m[2]);
}
const Module = require('module');
const resolveOriginal = Module._resolveFilename;
Module._resolveFilename = function resolver(pedido, ...resto) {
  return ALIAS[pedido] ? ALIAS[pedido] : resolveOriginal.call(this, pedido, ...resto);
};

const knexLib = require('knex');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { classify } = require('./_lib/assert-safe-target');

const SRC = path.join(ROOT, 'libs', 'finance', 'src', 'lib', 'purchase-book');
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const MESES = ['2026-07', '2026-08', '2026-09'];

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};
const noMedido = (label) => { nm += 1; console.log(`  ⚠ NO MEDIDO: ${label}`); };
const fin = () => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} LC.18 réplica del libro manual: ${ok} ✓ / ${fail} ✗`
    + (nm ? ` · ${nm} NO MEDIDO` : '') + '\n');
  process.exit(fail === 0 ? 0 : 1);
};
const r2 = (n) => Math.round(Number(n) * 100) / 100;
const pesos = (n) => Number(n).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

async function main(url) {
  const pool = knexLib({
    client: 'pg', connection: url,
    pool: { min: 0, max: 2, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) },
  });
  try {
    const { PurchaseBookService, repartirFactura } = require(path.join(SRC, 'purchase-book.service.ts'));
    const tk = {
      run: async (cb) => pool.transaction(async (trx) => {
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
        return cb(trx);
      }),
    };
    const svc = new PurchaseBookService(tk, { get: () => ({ userId: null }), requireTenantId: () => MEGA });
    svc.logger = { log() {}, warn() {}, error() {} };

    console.log('\n[0] El reparto, sobre facturas reales con su resultado a mano');
    // 06268 (jul): IEPS al 26.5 % dentro de la base del IVA — se queda en el 502.
    let p = repartirFactura(329991.16, 27376.70, 0);
    check(p.subtotal16 === 171104.38 && p.base_exenta === 131510.08, `06268: 502 ${p.subtotal16} / 501 ${p.base_exenta} (libro: 171,104.38 / 131,510.08)`);
    // 61749 (jul): exenta con IEPS al 8 %.
    p = repartirFactura(110500.20, 0, 8185.20);
    check(p.subtotal16 === 0 && p.base_exenta === 102315, `61749: 501 ${p.base_exenta} (libro: 102,315.00)`);
    // 9347 (jul): 100 % gravada, IVA ÷ 0.16 se pasa del neto por 2 centavos — todo al 502.
    p = repartirFactura(35148.20, 4848.03, 0);
    check(p.subtotal16 === 30300.17 && p.base_exenta === 0, `9347: 502 ${p.subtotal16} / 501 ${p.base_exenta} (libro: 30,300.17 / sin 501)`);

    console.log('\n[0b] LC.18.2 — la puerta exacta con ventana de meses = la vista entera');
    // getMes ya no une a v_purchase_book_uuid_prueba entera: filtra por mes ± 12 y repite la
    // prioridad de la vista (ORDEN_PRUEBA_SQL). Si una de las dos cambia y la otra no, esto se
    // pone rojo. Meses con prueba exacta de los tres tipos: histórico (2023-04, el mes del UUID
    // corrido), y los de 2026 con libro y con corridas.
    const tipoDe = (src) => (!src ? null : src === 'historico_xlsx' ? 'uuid_libro_historico'
      : src.startsWith('contpaqi_') ? 'uuid_concepto_contpaqi' : src.startsWith('run_') ? 'uuid_entregado' : 'otro');
    let cruzadas = 0; let distintas = 0; let conPrueba = 0;
    for (const mes of ['2023-04', '2025-06', '2026-06', '2026-07', '2026-10']) {
      const d = await svc.getMes(mes, 'libro');
      const { rows: vista } = await tk.run((k) => k.raw(
        `SELECT p.cfdi_uuid, p.source FROM finance.v_purchase_book_uuid_prueba p WHERE p.cfdi_uuid = ANY (?)`,
        [d.facturas.map((f) => f.uuid)]));
      const porUuid = new Map(vista.map((v) => [v.cfdi_uuid, v.source]));
      for (const f of d.facturas) {
        cruzadas++;
        const esperado = tipoDe(porUuid.get(f.uuid));
        const dado = f.prueba_en_libro && f.prueba_en_libro.startsWith('uuid_') ? f.prueba_en_libro : null;
        if (esperado) conPrueba++;
        if (esperado !== dado) distintas++;
      }
    }
    check(distintas === 0 && conPrueba > 0,
      `⭐ ${cruzadas} facturas de 5 meses, ${conPrueba} con prueba exacta: ${distintas} difieren de la vista`);

    for (const mes of MESES) {
      console.log(`\n[${mes}] contra el libro real (Diario folio 1)`);
      const reales = await tk.run((k) => k('analytics.gl_poliza_lines')
        .where({ source: 'contpaqi', anio_mes: mes })
        .whereRaw(`tenant_id = current_tenant_id() AND tipo_pol::text = '3' AND folio::text = '1'`)
        .select('cuenta', 'cargo_abono', 'importe', 'referencia'));
      if (!reales.length) { noMedido(`${mes}: no hay libro en ContPAQi`); continue; }

      const d = await svc.getMes(mes, 'libro');
      const ctas = await tk.run((k) => svc.cuentasImpuesto(k, mes));
      const cta = (c) => String(c).trim();
      const imp = reales.filter((r) => !/^(212|501|502)/.test(cta(r.cuenta)));
      const ivaReal = imp.find((r) => cta(r.cuenta) === ctas.iva.cuenta);
      const iepsReal = imp.find((r) => cta(r.cuenta) === ctas.ieps.cuenta);
      check(!!ivaReal && !!iepsReal && imp.length === 2,
        `cuentas de impuesto = las del libro: IVA ${ctas.iva.cuenta}, IEPS ${ctas.ieps.cuenta}`);

      // Casar cada abono a 212 del libro real con su factura.
      const usadas = new Set();
      const casadas = [];
      const sinCasar = [];
      for (const r of reales.filter((x) => cta(x.cuenta).startsWith('212') && x.cargo_abono === 'A')) {
        const suf = cta(r.cuenta).slice(3);
        const ref = String(r.referencia ?? '').trim();
        const f = d.facturas.find((x) => !usadas.has(x.uuid) && x.account_suffix === suf
          && String(x.folio ?? '').trim().slice(-5) === ref && r2(x.total) === r2(r.importe));
        if (f) { usadas.add(f.uuid); casadas.push(f); } else sinCasar.push(r);
      }
      const montoSin = r2(sinCasar.reduce((a, r) => a + Number(r.importe), 0));
      check(casadas.length / (casadas.length + sinCasar.length) >= 0.95,
        `${casadas.length} de ${casadas.length + sinCasar.length} facturas del libro casadas con su CFDI y su cuenta`);
      if (sinCasar.length) {
        console.log(`      ${sinCasar.length} por ${pesos(montoSin)} de proveedores fuera del mapa `
          + `(${[...new Set(sinCasar.map((r) => cta(r.cuenta)))].join(', ')}): se asignan desde la pantalla`);
      }
      // Lo que haría «Asignar cuenta»: la factura sin cuenta del mismo folio y total, con la
      // cuenta que le puso la contadora. Sólo si el CFDI es ÚNICO — si no, no se adivina.
      const simuladas = [];
      for (const r of sinCasar) {
        const suf = cta(r.cuenta).slice(3);
        const ref = String(r.referencia ?? '').trim();
        const cands = d.facturas.filter((x) => !usadas.has(x.uuid) && !x.account_suffix
          && String(x.folio ?? '').trim().slice(-5) === ref && r2(x.total) === r2(r.importe));
        if (cands.length !== 1) continue;
        usadas.add(cands[0].uuid);
        simuladas.push({
          ...cands[0], account_suffix: suf, cuenta_proveedor: `212${suf}`,
          cuenta_compra_exenta: `501${suf}`, cuenta_compra_iva: `502${suf}`, cuenta_existe: true,
        });
      }
      if (sinCasar.length) {
        check(simuladas.length === sinCasar.length,
          `con «Asignar cuenta», las ${sinCasar.length} quedan casadas (${simuladas.length} con un CFDI único)`);
      }
      casadas.push(...simuladas);

      // 1 y 2. Factura por factura: las patas 212/501/502 y su referencia.
      const movs = svc.construirMovimientos(casadas, 'global', false, { iva: ctas.iva.cuenta, ieps: ctas.ieps.cuenta });
      const llave = (m) => `${cta(m.cuenta).slice(3)}|${String(m.referencia ?? '').trim()}`;
      const agrupar = (arr, esAbono) => {
        const g = new Map();
        for (const m of arr) {
          if (!/^(212|501|502)/.test(cta(m.cuenta))) continue;
          const k = llave(m);
          if (!g.has(k)) g.set(k, []);
          g.get(k).push(`${cta(m.cuenta).slice(0, 3)}${esAbono(m) ? 'A' : 'C'} ${r2(m.importe).toFixed(2)}`);
        }
        for (const v of g.values()) v.sort();
        return g;
      };
      const GR = agrupar(reales, (m) => m.cargo_abono === 'A');
      const GG = agrupar(movs, (m) => m.abono);
      let iguales = 0;
      const distintas = [];
      for (const [k, v] of GG) {
        if ((GR.get(k) || []).join(';') === v.join(';')) iguales++;
        else distintas.push(`${k}: real [${(GR.get(k) || []).join('; ')}] · generado [${v.join('; ')}]`);
      }
      check(iguales === GG.size, `⭐ ${iguales} de ${GG.size} facturas con sus patas 212/501/502 IGUALES al centavo`);
      for (const x of distintas.slice(0, 5)) console.log(`      · ${x}`);

      // 4. Los renglones globales de IVA e IEPS.
      const ivaGen = r2(movs.filter((m) => m.cuenta === ctas.iva.cuenta).reduce((a, m) => a + m.importe, 0));
      const iepsGen = r2(movs.filter((m) => m.cuenta === ctas.ieps.cuenta).reduce((a, m) => a + m.importe, 0));
      if (simuladas.length === sinCasar.length) {
        check(ivaGen === r2(ivaReal.importe) && iepsGen === r2(iepsReal.importe),
          `IVA ${pesos(ivaGen)} e IEPS ${pesos(iepsGen)} = los del libro, al centavo`);
      } else {
        noMedido(`igualdad exacta de IVA/IEPS de ${mes}: ${sinCasar.length - simuladas.length} factura(s) sin un CFDI único`);
      }
      // El libro ENTERO, renglón por renglón (cuenta + cargo/abono + importe), como multiconjunto.
      const bolsa = (arr, esAbono) => {
        const m = new Map();
        for (const x of arr) {
          const k = `${cta(x.cuenta)}|${esAbono(x) ? 'A' : 'C'}|${r2(x.importe).toFixed(2)}`;
          m.set(k, (m.get(k) || 0) + 1);
        }
        return m;
      };
      const BR = bolsa(reales, (x) => x.cargo_abono === 'A');
      const BG = bolsa(movs, (x) => x.abono);
      let difs = 0;
      for (const k of new Set([...BR.keys(), ...BG.keys()])) difs += Math.abs((BR.get(k) || 0) - (BG.get(k) || 0));
      check(simuladas.length === sinCasar.length ? difs === 0 : true,
        `⭐ la póliza entera: ${reales.length} renglones reales, ${movs.length} generados, ${difs} distintos`);
      // El asiento cuadra.
      const cargos = r2(movs.filter((m) => !m.abono).reduce((a, m) => a + m.importe, 0));
      const abonos = r2(movs.filter((m) => m.abono).reduce((a, m) => a + m.importe, 0));
      check(cargos === abonos, `el asiento generado cuadra: cargos = abonos = ${pesos(cargos)}`);

      // 5. Prueba negativa: el reparto anterior no reproduce el libro.
      const viejas = casadas.map((f) => ({
        ...f, ieps: f.ieps_total, subtotal16: r2(f.subtotal16_conceptos ?? f.subtotal16),
      }));
      const { rows: conceptos } = await tk.run((k) => k.raw(
        `SELECT upper(uuid) AS uuid, coalesce((impuestos->>'subtotal_iva_16')::numeric, 0) AS s16
           FROM fiscal.cfdis WHERE tenant_id = current_tenant_id() AND upper(uuid) = ANY (?)`,
        [casadas.map((f) => f.uuid)]));
      const s16 = new Map(conceptos.map((c) => [c.uuid, r2(c.s16)]));
      for (const v of viejas) {
        v.subtotal16 = s16.get(v.uuid) ?? v.subtotal16;
        v.base_exenta = r2(v.total - v.iva - v.ieps - v.subtotal16);
      }
      const GV = agrupar(svc.construirMovimientos(viejas, 'global', false, { iva: ctas.iva.cuenta, ieps: ctas.ieps.cuenta }), (m) => m.abono);
      let igualesViejo = 0;
      for (const [k, v] of GV) if ((GR.get(k) || []).join(';') === v.join(';')) igualesViejo++;
      check(igualesViejo < GV.size, `⛔ prueba negativa: con el reparto anterior sólo ${igualesViejo} de ${GV.size} coinciden — el candado sí distingue`);
    }
  } finally {
    await pool.destroy();
  }
}

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  const kind = classify(url).kind;
  if (kind !== 'prod') noMedido(`destino ${kind}: los libros testigo sólo existen en prod`);
  else await main(url);
  fin();
})().catch((e) => {
  console.log(`  ✗ excepción: ${e && e.message}`);
  fail += 1;
  fin();
});
