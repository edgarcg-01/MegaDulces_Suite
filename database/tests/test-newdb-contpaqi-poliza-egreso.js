/**
 * `[CP.8.3]` — Candado del armador de asientos de egreso para ContPAQi.
 *
 * Carga el `.ts` REAL vía ts-node (`libs/finance/.../contpaqi/poliza-egreso.ts`), no una copia:
 * si alguien cambia el criterio del armador, esto se pone rojo.
 *
 * ⭐ Las FIXTURES son pólizas REALES, leídas el 2026-10-08 de la contabilidad en vivo
 * (`192.168.0.35\COMPAC`, `ctLUIS_FRANCISCO_LOPEZ_GUTIERREZ`, ejercicio 2026, TipoPol=2). No
 * son inventadas: si el armador reproduce estas tres al centavo, reproduce el asiento que esa
 * contabilidad ya acepta.
 *
 * Y traen el caso que justifica todo el diseño: en los dos traslados, `subtotal x 0.16` NO da
 * el IVA asentado (difiere 1 y 2 centavos). Un armador que calcule el IVA falla estas fixtures.
 *
 * No necesita base de datos: es lógica pura. Corre en `run-all-tests` igual.
 */
'use strict';

const path = require('path');

// `skipProject`: sin esto ts-node toma el tsconfig del monorepo y falla con TS5011.
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});

const SRC = path.resolve(__dirname, '..', '..', 'libs', 'finance', 'src', 'lib', 'contpaqi');
const {
  armarAsientoEgreso, asientoCuadra, AsientoRechazado, CARGO, ABONO, TIPO_POLIZA_EGRESO,
} = require(path.join(SRC, 'poliza-egreso.ts'));

let ok = 0;
let fail = 0;
const check = (cond, label) => {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const rechaza = (fn, motivo, label) => {
  try { fn(); fail++; console.log(`  ✗ ${label} — NO rechazó`); }
  catch (e) {
    if (e instanceof AsientoRechazado && e.motivo === motivo) { ok++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} — rechazó con "${e.motivo || e.name}", se esperaba "${motivo}"`); }
  }
};

const reglaRenta = {
  categoria_code: 'renta', cuenta_gasto: '5200510001', cuenta_iva: '1060000000',
  confianza_pct: 97.9, estado: 'derivada',
};
const reglaTraslado = {
  categoria_code: 'traslado_valores', cuenta_gasto: '5200680000', cuenta_iva: '1060000000',
  confianza_pct: 100.0, estado: 'derivada',
};

// ── Fixtures: las tres pólizas reales ────────────────────────────────────────────────────────
const REALES = [
  { nombre: 'PAGO RENTA (folio 261, 2026-03-04)', regla: reglaRenta,
    subtotal: 135000.00, iva: 21600.00, total: 156600.00, cuenta_banco: '1020220000',
    concepto: 'PAGO RENTA', fecha: '2026-03-04', seg_negocio: 0 },
  { nombre: 'PAGO TRASLADO DE EFECTIVO (folio 260, 2026-03-01)', regla: reglaTraslado,
    subtotal: 134082.29, iva: 21453.18, total: 155535.47, cuenta_banco: '1020020000',
    concepto: 'PAGO TRASLADO DE EFECTIVO', fecha: '2026-03-01', seg_negocio: 8 },
  { nombre: 'PAGO TRASLADO DE EFECTIVO (folio 464, 2026-04-20)', regla: reglaTraslado,
    subtotal: 121981.94, iva: 19517.13, total: 141499.07, cuenta_banco: '1020220000',
    concepto: 'PAGO TRASLADO DE EFECTIVO', fecha: '2026-04-20', seg_negocio: 8 },
];

(async () => {
  console.log('\n[1] Reproduce al centavo las 3 pólizas reales de ContPAQi');
  for (const f of REALES) {
    // ⚠️ Un throw acá NO debe matar la corrida. Lo midió la prueba de mutación: con el motor
    // calculando el IVA, la excepción abortaba todo con stack trace y el conteo nunca se
    // imprimía — en `run-all-tests` eso se lee como error de infra, no como aserción roja.
    // Un candado REPORTA fallas; no se cae.
    let a;
    try {
      a = armarAsientoEgreso(f);
    } catch (e) {
      fail++;
      console.log(`  ✗ ${f.nombre}: el armador RECHAZÓ una póliza real — ${e.message}`);
      continue;
    }
    check(a.tipo_poliza === TIPO_POLIZA_EGRESO, `${f.nombre}: tipo 2 (Egreso)`);
    check(a.movimientos.length === 3, `${f.nombre}: 3 renglones`);
    check(a.movimientos[0].cuenta === f.regla.cuenta_gasto && a.movimientos[0].abono === CARGO
      && a.movimientos[0].importe === f.subtotal, `${f.nombre}: #1 cargo al gasto por el subtotal`);
    check(a.movimientos[1].cuenta === '1060000000' && a.movimientos[1].abono === CARGO
      && a.movimientos[1].importe === f.iva, `${f.nombre}: #2 cargo al IVA acreditable`);
    check(a.movimientos[2].cuenta === f.cuenta_banco && a.movimientos[2].abono === ABONO
      && a.movimientos[2].importe === f.total, `${f.nombre}: #3 abono al banco por el total`);
    check(asientoCuadra(a), `${f.nombre}: cuadra (cargos == abonos)`);
    check(a.movimientos[0].seg_negocio === (f.seg_negocio ?? 0),
      `${f.nombre}: el segmento viaja en el renglón del gasto`);
  }

  console.log('\n[2] ⭐ El IVA viene del CFDI, NO de multiplicar — la premisa del diseño');
  for (const f of REALES.slice(1)) {
    const calculado = Math.round(f.subtotal * 0.16 * 100) / 100;
    check(calculado !== f.iva,
      `${f.nombre}: subtotal x 0.16 = ${calculado.toFixed(2)} != ${f.iva.toFixed(2)} asentado`);
    // Prueba NEGATIVA: si alguien "mejora" el armador calculando el IVA, esto se vuelve descuadre.
    rechaza(() => armarAsientoEgreso({ ...f, iva: calculado }), 'descuadre',
      `${f.nombre}: con el IVA calculado, el armador RECHAZA`);
  }

  console.log('\n[3] Pruebas negativas — los cuatro rechazos');
  rechaza(() => armarAsientoEgreso({
    ...REALES[0],
    regla: { categoria_code: 'imss_sua', cuenta_gasto: null, cuenta_iva: '1060000000',
             confianza_pct: 10.2, estado: 'sin_regla' },
  }), 'sin_regla', 'una categoría medida y no concluyente NO se asienta');

  rechaza(() => armarAsientoEgreso({
    ...REALES[0],
    regla: { ...reglaRenta, cuenta_gasto: null },
  }), 'regla_sin_cuenta', 'una regla aprobada sin cuenta NO pasa (el nulo de [LC.9])');

  rechaza(() => armarAsientoEgreso({ ...REALES[0], subtotal: 0, iva: 0, total: 0 }),
    'importe_invalido', 'importes en cero NO son un pago');

  rechaza(() => armarAsientoEgreso({ ...REALES[0], total: 156600.01 }),
    'descuadre', 'un centavo de descuadre RECHAZA (sin tolerancia)');

  console.log('\n[4] Gasto exento: sin IVA son 2 renglones, no 3 con un cero');
  const exento = armarAsientoEgreso({
    ...REALES[0], subtotal: 10000.00, iva: 0, total: 10000.00,
  });
  check(exento.movimientos.length === 2, 'sin IVA, el asiento tiene 2 renglones');
  check(!exento.movimientos.some((m) => m.importe === 0), 'no hay renglones en cero');
  check(asientoCuadra(exento), 'el asiento exento cuadra');

  console.log('\n[5] `asientoCuadra` detecta de verdad (prueba negativa del verificador)');
  const roto = armarAsientoEgreso(REALES[0]);
  roto.movimientos[0].importe += 0.01;
  check(!asientoCuadra(roto), 'un centavo de más en un renglón lo marca descuadrado');

  console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8 armador de egresos: ${ok} ✓ / ${fail} ✗\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  // ⚠️ La red de seguridad, y la puso la prueba de mutación: con el motor calculando el IVA,
  // los bloques [4] y [5] lanzaban y la corrida moría SIN imprimir el conteo. Un candado que
  // se cae sin tally no dice "rojo" — dice "no corrió", y eso se confunde con infra.
  fail++;
  console.log(`  ✗ excepción no esperada: ${e && e.message}`);
  console.log(`\n❌ CP.8 armador de egresos: ${ok} ✓ / ${fail} ✗\n`);
  process.exit(1);
});
