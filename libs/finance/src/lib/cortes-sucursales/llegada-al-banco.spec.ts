/**
 * `[CSU.26]` Pruebas de «¿dónde está cada depósito aplicado a un corte?».
 *
 * Los casos son los REALES de Morelia Abastos y Padre Hidalgo, noviembre de 2026, tal como los devolvió `SQL_LLEGADA`
 * en prod el 2026-11-26 (`database/scripts/csu26-llegada-prod.js`, que además los verifica allá):
 *  · `UA0501-0000363` Santander 1604, 3-nov, $8,600.00: la conciliación lo casó → en el banco.
 *  · `UA0501-0000366` cuenta 0011: su entrada `CI-2026-00343` cerró en `CC-2026-00023` → en Caja General.
 *  · `UA0501-0000538` Santander 1604, 24-nov: el libro de esa cuenta en Bancos termina el 10-nov → «todavía no se
 *    puede saber», NUNCA «no llegó».
 *  · `UA0501-0000401` BBVA 4176, 4-nov, libro hasta el 26-nov, sin pareo → sin conciliar. (El abono está en Banorte
 *    7744: lo ve Bancos, no esta pantalla.)
 *  · `UA0501-0000495` cuenta 0001 DEVOLUCIONES → puente.
 */
import { clasificarLlegada, llaveDeDocumento, parametrosLlegada, tipoDeConciliacion, LLEGO, type EvidenciaCruda } from './llegada-al-banco';

const ev = (x: Partial<EvidenciaCruda>): EvidenciaCruda => ({
  sucursal: '08', c4: 5, c5: 1, folio: '0000000', fecha: '2026-11-03', total: '0.00', cuenta: '1604',
  renglones: [], asientos: [], cuenta_bancos: 'STDR 1604', libro_hasta: '2026-11-10', ...x,
});

const R363 = ev({
  folio: '0000363', total: '8600.00',
  renglones: [{ cuenta: 'STDR 1604', fecha: '2026-11-03', monto: 8600, concepto: 'VENTA MORELIA ABASTOS', pareo: 'motor-tes' }],
});
const R366 = ev({
  folio: '0000366', fecha: '2026-11-05', total: '44636.66', cuenta: '0011', cuenta_bancos: 'CAJA GENERAL', libro_hasta: '2026-10-10',
  asientos: [{ entrada: 'CI-2026-00343', fecha: '2026-11-05', monto: 44636.66, estado: 'en_corte', corte: 'CC-2026-00023', corte_estado: 'cerrado' }],
});
const R538 = ev({ folio: '0000538', fecha: '2026-11-24', total: '90000.00' });
const R401 = ev({ folio: '0000401', fecha: '2026-11-04', total: '8335.54', cuenta: '4176', cuenta_bancos: 'BBVA 4176', libro_hasta: '2026-11-26' });
const R495 = ev({ sucursal: '01', folio: '0000495', total: '16824.55', cuenta: '0001', cuenta_bancos: null, libro_hasta: null });

describe('[CSU.26] la llave del depósito', () => {
  it('UA0501 es el «U-A-5» que escribe la conciliación, y c4=5 c5=1 en kdm1', () => {
    expect(tipoDeConciliacion('UA0501')).toBe('U-A-5');
    expect(tipoDeConciliacion('UA0701')).toBe('U-A-7');
    expect(llaveDeDocumento('UA0501')).toEqual({ c4: 5, c5: 1 });
    expect(llaveDeDocumento('UA2501')).toEqual({ c4: 25, c5: 1 });
  });
  it('un prefijo que no es de un documento U no inventa llave', () => {
    expect(tipoDeConciliacion('XD2601')).toBeNull();
    expect(llaveDeDocumento('')).toBeNull();
    expect(llaveDeDocumento('UA05')).toBeNull();
  });
  it('los parámetros van como listas paralelas, y un prefijo sin llave se queda fuera (no desalinea las listas)', () => {
    const p = parametrosLlegada([
      { sucursal: '08', doc_prefix: 'UA0501', folio: '0000363' },
      { sucursal: '08', doc_prefix: '???', folio: '0000999' },
      { sucursal: '01', doc_prefix: 'UA0701', folio: '0000363' },
    ], 'T');
    expect(p).toEqual([['08', '01'], [5, 7], [1, 1], ['0000363', '0000363'], 'T', ['0000363'], 'T', 'T']);
  });
});

describe('[CSU.26] dónde está cada depósito — los cinco casos reales', () => {
  it('0000363: la conciliación lo casó con Santander 1604 el 3-nov → en el banco', () => {
    const l = clasificarLlegada('banco', R363);
    expect(l.estado).toBe('en_banco');
    expect(l.renglones).toEqual([{ cuenta: 'STDR 1604', fecha: '2026-11-03', monto: 8600, concepto: 'VENTA MORELIA ABASTOS', pareo: 'motor-tes', debil: false }]);
    expect(LLEGO.has(l.estado)).toBe(true);
  });
  it('0000366: su entrada de Caja General cerró en CC-2026-00023 → en Caja General', () => {
    const l = clasificarLlegada('caja', R366);
    expect(l.estado).toBe('en_caja_general');
    expect(l.caja_general[0]).toMatchObject({ entrada: 'CI-2026-00343', corte: 'CC-2026-00023', monto: 44636.66 });
    expect(LLEGO.has(l.estado)).toBe(true);
  });
  it('0000538: el libro de Bancos termina antes del depósito → todavía no se puede saber (no es «no llegó»)', () => {
    const l = clasificarLlegada('banco', R538);
    expect(l.estado).toBe('banco_sin_libro');
    expect(l).toMatchObject({ cuenta_bancos: 'STDR 1604', libro_hasta: '2026-11-10' });
    expect(LLEGO.has(l.estado)).toBe(false);
  });
  it('0000401: el libro ya cubre su fecha y no hay pareo → sin conciliar', () => {
    const l = clasificarLlegada('banco', R401);
    expect(l.estado).toBe('sin_conciliar');
    expect(l.cuenta).toBe('4176');
  });
  it('0000495: cuenta de devoluciones → puente, fuera de lo que debió llegar', () => {
    expect(clasificarLlegada('puente', R495).estado).toBe('puente');
  });
});

describe('[CSU.26] lo que NO se puede afirmar', () => {
  it('sin evidencia (el depósito no está en kdm1) → sin cuenta, nunca «llegó»', () => {
    for (const medio of ['banco', 'caja', 'puente', null] as const) {
      const l = clasificarLlegada(medio, null);
      expect(l.estado).toBe('sin_cuenta');
      expect(LLEGO.has(l.estado)).toBe(false);
    }
  });
  it('cuenta de caja sin entrada en el libro de Caja General → caja sin asiento', () => {
    expect(clasificarLlegada('caja', { ...R366, asientos: [] }).estado).toBe('caja_sin_asiento');
  });
  it('un depósito a caja que la conciliación casó con el banco → en el banco (no se queda «sin asiento»)', () => {
    expect(clasificarLlegada('caja', { ...R366, asientos: [], renglones: R363.renglones }).estado).toBe('en_banco');
  });
  it('un pareo de la conciliación gana sobre la falta de libro (el libro de la cuenta mapeada puede ser otro)', () => {
    expect(clasificarLlegada('banco', { ...R538, renglones: R363.renglones }).estado).toBe('en_banco');
  });
  it('Bancos no tiene cuenta que concilie esa cuenta de Kepler → sin conciliar, no «sin libro»', () => {
    expect(clasificarLlegada('banco', { ...R401, cuenta_bancos: null, libro_hasta: null }).estado).toBe('sin_conciliar');
  });
  it('[CSU.31] el ÚLTIMO día del libro no lo cubre todavía (suele venir cortado): ese depósito está «por saber»', () => {
    expect(clasificarLlegada('banco', { ...R401, libro_hasta: '2026-11-04' }).estado).toBe('banco_sin_libro');
    expect(clasificarLlegada('banco', { ...R401, libro_hasta: '2026-11-03' }).estado).toBe('banco_sin_libro');
    // Un día después del depósito, el libro sí lo cubre: sin pareo es «sin conciliar».
    expect(clasificarLlegada('banco', { ...R401, libro_hasta: '2026-11-05' }).estado).toBe('sin_conciliar');
  });
  it('cuenta sin declarar o que no resuelve, sin pareo → sin cuenta', () => {
    expect(clasificarLlegada('sin_declarar', R401).estado).toBe('sin_cuenta');
    expect(clasificarLlegada('no_resuelve', R401).estado).toBe('sin_cuenta');
  });
  it('un pase débil de la conciliación se marca, para que la pantalla diga «probable»', () => {
    const l = clasificarLlegada('banco', { ...R363, renglones: [{ ...R363.renglones[0], pareo: 'motor-tes-group' }] });
    expect(l.estado).toBe('en_banco');
    expect(l.renglones[0].debil).toBe(true);
  });
  it('los montos de pg llegan como texto y salen como número a dos decimales', () => {
    const l = clasificarLlegada('banco', { ...R363, renglones: [{ ...R363.renglones[0], monto: '146040.000' }] });
    expect(l.renglones[0].monto).toBe(146040);
  });
});
