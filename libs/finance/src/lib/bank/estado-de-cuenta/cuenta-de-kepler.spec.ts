import { categoriaDeCuenta, cuentaDelMovimiento, type MapaDeCuentas } from './cuenta-de-kepler';
import { sqlLlaveKeplerPayable } from './evidencia-de-kepler.query';
import { sqlKeplerPayableId } from '@megadulces/contracts/finance/kepler-payable-key';

const MAPA: MapaDeCuentas = [['511', 'compra_mercancia'], ['601', 'nomina'], ['601-015', 'imss_sua'], ['611', 'gasto_venta'],
  ['611-003', 'comision_bancaria'], ['602', 'gasto_logistico']];

describe('[BFU.7.1] categoriaDeCuenta: el prefijo más largo gana', () => {
  it('subcuenta antes que mayor; la cuenta exacta también cuenta', () => {
    expect(categoriaDeCuenta('611-003', MAPA)).toBe('comision_bancaria');
    expect(categoriaDeCuenta('611-006', MAPA)).toBe('gasto_venta');
    expect(categoriaDeCuenta('601-015', MAPA)).toBe('imss_sua');
    expect(categoriaDeCuenta('601-001', MAPA)).toBe('nomina');
    expect(categoriaDeCuenta('511', MAPA)).toBe('compra_mercancia');
  });
  it('[negativa] un prefijo no se confunde con otra cuenta que empieza igual; sin mapeo → null', () => {
    expect(categoriaDeCuenta('6110-001', MAPA)).toBeNull();
    expect(categoriaDeCuenta('607-002', MAPA)).toBeNull();
    expect(categoriaDeCuenta('', MAPA)).toBeNull();
  });
});

describe('[BFU.7.1] cuentaDelMovimiento', () => {
  it('el renglón con el importe EXACTO del movimiento gana sobre el más grande', () => {
    const c = cuentaDelMovimiento([{ cuenta: '602-007', importe: 8209.63, departamento: 'A' }, { cuenta: '611-006', importe: 4421.76, departamento: 'B' }], 4421.76, MAPA);
    expect(c).toEqual({ categoria: 'gasto_venta', cuenta: '611-006', departamento: 'B', por: 'importe_exacto', mixta: false });
  });
  it('si no hay exacto, el de mayor importe por categoría, y se declara mixta', () => {
    const c = cuentaDelMovimiento([{ cuenta: '602-007', importe: 100 }, { cuenta: '602-003', importe: 100 }, { cuenta: '611-006', importe: 150 }], 999, MAPA);
    expect(c && c.categoria).toBe('gasto_logistico'); // 602 suma 200 contra 150
    expect(c && 'mixta' in c && c.mixta).toBe(true);
  });
  it('⛔ cuenta sin mapeo → motivo con la cuenta; renglones sin cuenta → otro motivo; sin renglones → null', () => {
    expect(cuentaDelMovimiento([{ cuenta: '607-002', importe: 20000, departamento: 'CONTABILIDAD' }], 20000, MAPA))
      .toEqual({ categoria: null, motivo: 'cuenta_sin_categoria', cuenta: '607-002', departamento: 'CONTABILIDAD' });
    expect(cuentaDelMovimiento([{ cuenta: null, importe: 10 }], 10, MAPA)).toEqual({ categoria: null, motivo: 'documento_sin_cuenta' });
    expect(cuentaDelMovimiento([], 10, MAPA)).toBeNull();
  });
});

describe('[BFU.7.2] la llave del Calendario es la del contrato', () => {
  it('⛔ sqlLlaveKeplerPayable === sqlKeplerPayableId (si alguien cambia una, esta prueba se pone roja)', () => {
    expect(sqlLlaveKeplerPayable('d')).toBe(sqlKeplerPayableId('d'));
    expect(sqlLlaveKeplerPayable('v')).toBe(sqlKeplerPayableId('v'));
  });
});
