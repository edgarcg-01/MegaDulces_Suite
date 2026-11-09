import { cuentaDeOrigen } from './validacion-pago.sql';

describe('[PGP.104] la cuenta de origen del comprobante, por sus últimos dígitos', () => {
  const cuentas = [{ cuenta_id: 'BB', account_label: '4166' }, { cuenta_id: 'SA', account_label: '2169' }, { cuenta_id: 'CJ', account_label: 'CAJA' }];
  it('la CLABE o cuenta que termina en el número de una cuenta propia', () => {
    expect(cuentaDeOrigen('012180001234564166', cuentas)).toBe('BB');
    expect(cuentaDeOrigen('2169', cuentas)).toBe('SA');
  });
  it('⛔ sin dígitos, sin coincidencia o con dos cuentas del mismo final: no se adivina', () => {
    expect(cuentaDeOrigen('', cuentas)).toBeNull();
    expect(cuentaDeOrigen('0121800012345699', cuentas)).toBeNull();
    expect(cuentaDeOrigen('4166', [...cuentas, { cuenta_id: 'OTRA', account_label: '4166' }])).toBeNull();
  });
  it('un rótulo de menos de 4 dígitos no sirve para ligar', () => {
    expect(cuentaDeOrigen('0000123', [{ cuenta_id: 'X', account_label: '123' }])).toBeNull();
  });
});
