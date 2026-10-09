/* eslint-disable no-console */
/**
 * `[CP.8.21]` — Candado del **armado por lote** y del ramificado por `tipo_regla`.
 *
 * Lo que este candado defiende, y por qué cada cosa:
 *
 *  1. **La unidad es (banco × día), no el movimiento.** Medido: 4,067 de 4,457 pólizas de egreso
 *     de 2026 (91.2 %) tienen UN solo renglón de banco. Armar una por movimiento produciría
 *     4,727 pólizas donde la contadora hace ~500.
 *  2. **Los cuatro tipos de regla se ven distinto.** `no_aplica` ≠ `sin_medir` ≠ `sin_centro_costo`
 *     ≠ `sin_regla`: cuatro motivos, cuatro arreglos distintos, cuatro dueños distintos.
 *  3. **Un pago a proveedor no lleva renglón de IVA** — y DECLARA que le falta el traspaso.
 *  4. **Una fila mala no tumba el lote**, pero mezclar bancos o fechas sí tiene que romper.
 *
 * Corre sin DB: carga el módulo tal cual vía ts-node, igual que el resto de los smokes de CP.8.
 */
const path = require('path');

require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const M = require(path.resolve(__dirname, '../../libs/finance/src/lib/contpaqi/poliza-egreso.ts'));

let ok = 0;
let fail = 0;
const t = (nombre, cond) => {
  if (cond) { ok += 1; console.log(`  ✓ ${nombre}`); } else { fail += 1; console.log(`  ✗ ${nombre}`); }
};
const rechaza = (nombre, fn, motivoEsperado) => {
  try { fn(); t(`${nombre} — NO rechazó`, false); } catch (e) {
    t(`${nombre} → ${e.motivo || e.name}`, e.motivo === motivoEsperado);
  }
};

const BANCO = '1020220000';
const FECHA = '2026-01-15';
const base = (over = {}) => ({
  regla: {
    categoria_code: 'x', cuenta_gasto: '5200600000', cuenta_iva: '1060000000',
    confianza_pct: 97, estado: 'aprobada', ...(over.regla || {}),
  },
  subtotal: 100, iva: 16, total: 116, cuenta_banco: BANCO, concepto: 'PRUEBA', fecha: FECHA,
  ...over,
});

console.log('\n[1] Los cuatro tipos de regla dan motivos DISTINTOS');
rechaza('no_aplica', () => M.armarAsientoEgreso(base({ regla: { tipo_regla: 'no_aplica' } })), 'no_aplica');
rechaza('sin_medir', () => M.armarAsientoEgreso(base({ regla: { tipo_regla: 'sin_medir' } })), 'sin_medir');
rechaza('por_sucursal', () => M.armarAsientoEgreso(
  base({ regla: { tipo_regla: 'por_sucursal', cuenta_prefijo: '215011' } })), 'sin_centro_costo');
rechaza('sin_regla', () => M.armarAsientoEgreso(
  base({ regla: { tipo_regla: 'por_categoria', estado: 'sin_regla' } })), 'sin_regla');
rechaza('por_proveedor sin cuenta resuelta', () => M.armarAsientoEgreso(
  base({ regla: { tipo_regla: 'por_proveedor', cuenta_gasto: null, cuenta_prefijo: '2120' } })),
'proveedor_sin_cuenta');

// ⛔ El motivo de `por_sucursal` tiene que decir que falta el DATO, no la regla: es lo que
// decide quién lo arregla (Sistemas/negocio, no el contador).
try {
  M.armarAsientoEgreso(base({ regla: { tipo_regla: 'por_sucursal' } }));
} catch (e) {
  t('por_sucursal explica que falta el dato de entrada', /centro de costo/i.test(e.message));
}

console.log('\n[2] Pago a proveedor: 2 renglones, sin IVA, y DECLARA lo que le falta');
const pp = M.armarAsientoEgreso(base({
  regla: { tipo_regla: 'por_proveedor', cuenta_gasto: '2120000108', cuenta_prefijo: '2120' },
  subtotal: 100, iva: 16, total: 116,
}));
t('tiene exactamente 2 renglones', pp.movimientos.length === 2);
t('ningún renglón es de IVA', !pp.movimientos.some((m) => m.cuenta.startsWith('106') || m.cuenta.startsWith('1470')));
t('el cargo va por el TOTAL, no por el subtotal', pp.movimientos[0].importe === 116);
t('carga a la cuenta del proveedor', pp.movimientos[0].cuenta === '2120000108' && pp.movimientos[0].abono === M.CARGO);
t('abona al banco por el total', pp.movimientos[1].cuenta === BANCO && pp.movimientos[1].importe === 116);
t('cuadra', M.asientoCuadra(pp));
t('⭐ DECLARA que falta el traspaso de impuesto', pp.iva_traspaso === 'no_emitido');
t('y dice por qué', /facturas/i.test(pp.iva_traspaso_motivo || ''));

console.log('\n[3] El lote agrupa: N cargos, UN abono al banco');
const lote = M.armarLoteEgresos(BANCO, FECHA, [
  base({ subtotal: 100, iva: 16, total: 116 }),
  base({ subtotal: 200, iva: 32, total: 232, regla: { cuenta_gasto: '5200580000' } }),
  base({ subtotal: 50, iva: 0, total: 50, regla: { cuenta_gasto: '5201000000' } }),
], 'LOTE DE PRUEBA');
t('el lote se armó', lote.asiento !== null);
t('3 entradas incluidas', lote.incluidas === 3);
const abonos = lote.asiento.movimientos.filter((m) => m.abono);
t('⭐ UN solo renglón de banco', abonos.length === 1);
t('el abono es la suma exacta', abonos[0].importe === 398);
t('el total del lote es 398', lote.asiento.total === 398);
t('cuadra', M.asientoCuadra(lote.asiento));
// 2 gastos con IVA (2 renglones c/u) + 1 exento (1 renglón) = 5 cargos + 1 abono
t('5 cargos + 1 abono', lote.asiento.movimientos.length === 6);

console.log('\n[4] Una fila mala NO tumba el lote (y sale con su motivo)');
const mixto = M.armarLoteEgresos(BANCO, FECHA, [
  base({ subtotal: 100, iva: 16, total: 116 }),
  base({ regla: { tipo_regla: 'no_aplica' } }),
  base({ regla: { tipo_regla: 'sin_medir' } }),
  base({ subtotal: 10, iva: 0, total: 10 }),
], 'MIXTO');
t('el lote sobrevive', mixto.asiento !== null);
t('2 incluidas', mixto.incluidas === 2);
t('2 rechazadas', mixto.rechazadas.length === 2);
t('cada rechazo trae su índice', mixto.rechazadas[0].indice === 1 && mixto.rechazadas[1].indice === 2);
t('y motivos DISTINTOS', mixto.rechazadas[0].motivo !== mixto.rechazadas[1].motivo);
t('el total sólo cuenta lo incluido', mixto.asiento.total === 126);
t('cuadra', M.asientoCuadra(mixto.asiento));

console.log('\n[5] Si TODO se rechaza, el lote es null — no un asiento vacío que cuadra');
const vacio = M.armarLoteEgresos(BANCO, FECHA, [
  base({ regla: { tipo_regla: 'no_aplica' } }),
  base({ regla: { tipo_regla: 'sin_medir' } }),
], 'VACIO');
t('asiento null', vacio.asiento === null);
t('incluidas 0', vacio.incluidas === 0);
t('⭐ y las 2 razones quedan', vacio.rechazadas.length === 2);

console.log('\n[6] Prueba negativa: mezclar banco o fecha TIENE que romper');
let rompio = 0;
try {
  M.armarLoteEgresos(BANCO, FECHA, [base(), base({ cuenta_banco: '1020070000' })], 'X');
} catch (e) { rompio += /Mezclar bancos o fechas/.test(e.message) ? 1 : 0; }
try {
  M.armarLoteEgresos(BANCO, FECHA, [base(), base({ fecha: '2026-01-16' })], 'X');
} catch (e) { rompio += /Mezclar bancos o fechas/.test(e.message) ? 1 : 0; }
t('otro banco en el lote rompe', rompio >= 1);
t('otra fecha en el lote rompe', rompio === 2);

console.log('\n[7] Un lote con pagos a proveedor arrastra la declaración del traspaso');
const conProv = M.armarLoteEgresos(BANCO, FECHA, [
  base({ subtotal: 100, iva: 16, total: 116 }),
  base({ regla: { tipo_regla: 'por_proveedor', cuenta_gasto: '2120000108' }, total: 500 }),
], 'CON PROVEEDOR');
t('el lote declara el traspaso pendiente', conProv.asiento.iva_traspaso === 'no_emitido');
t('y dice cuántos pagos', /1 pago/.test(conProv.asiento.iva_traspaso_motivo || ''));
t('cuadra', M.asientoCuadra(conProv.asiento));

console.log('\n[8] Compatibilidad: una regla SIN `tipo_regla` sigue siendo `por_categoria`');
const viejo = M.armarAsientoEgreso(base());
t('se arma igual que antes', viejo.movimientos.length === 3 && viejo.total === 116);
t('no declara traspaso', viejo.iva_traspaso === undefined);

console.log(`\n${fail === 0 ? '✅' : '❌'} CP.8 lote y tipos de regla: ${ok} ✓ / ${fail} ✗\n`);
process.exit(fail === 0 ? 0 : 1);
