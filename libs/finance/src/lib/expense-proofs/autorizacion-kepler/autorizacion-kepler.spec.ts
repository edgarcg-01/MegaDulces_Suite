import { escrituraDeAutorizacionEncendida, llaveDeSolicitud, veredictoAutorizacion } from './autorizacion-kepler';

describe('[PGP.79] escrituraDeAutorizacionEncendida — apagada por default', () => {
  it('sólo «encendida» la prende', () => {
    expect(escrituraDeAutorizacionEncendida({})).toBe(false);
    expect(escrituraDeAutorizacionEncendida({ KEPLER_GASTO_AUTORIZACION: 'true' })).toBe(false);
    expect(escrituraDeAutorizacionEncendida({ KEPLER_GASTO_AUTORIZACION: ' encendida ' })).toBe(true);
  });
});

describe('[PGP.79] llaveDeSolicitud', () => {
  it('sucursal de dos dígitos y folio de 7, como kdm1.c1/c6', () => {
    expect(llaveDeSolicitud({ sucursal: '00', folio_solicitud: '0010750' })).toEqual({ ok: true, valor: { sucursal: '00', folio: '0010750' } });
  });
  it('⛔ NEGATIVA — un folio sin ceros a la izquierda no se rellena: no se adivina la llave', () => {
    expect(llaveDeSolicitud({ sucursal: '00', folio_solicitud: '10750' }).ok).toBe(false);
    expect(llaveDeSolicitud({ sucursal: '00', folio_solicitud: null }).ok).toBe(false);
  });
  it('⛔ NEGATIVA — una camioneta (01-005) o una sucursal vacía no tienen servidor', () => {
    expect(llaveDeSolicitud({ sucursal: '01-005', folio_solicitud: '0000163' }).ok).toBe(false);
    expect(llaveDeSolicitud({ sucursal: '', folio_solicitud: '0000163' }).ok).toBe(false);
  });
});

describe('[PGP.79] veredictoAutorizacion', () => {
  it('una fila cambiada: la Suite la autorizó', () => {
    expect(veredictoAutorizacion(1, null)).toEqual({ estado: 'escrito' });
  });
  it('ya autorizada o aplicada en Kepler: nada que escribir, y se dice cuál', () => {
    expect(veredictoAutorizacion(0, 'A')).toEqual({ estado: 'ya_estaba', kepler: 'A' });
    expect(veredictoAutorizacion(0, 'F')).toEqual({ estado: 'ya_estaba', kepler: 'F' });
  });
  it('⛔ cancelada, inexistente o desconocida: NO escrita, con motivo — nunca «ya estaba»', () => {
    expect(veredictoAutorizacion(0, 'C')).toEqual({ estado: 'no_escrito', motivo: expect.stringMatching(/cancelada/) });
    expect(veredictoAutorizacion(0, null)).toEqual({ estado: 'no_escrito', motivo: expect.stringMatching(/no tiene esa solicitud/) });
    expect(veredictoAutorizacion(0, 'X')).toEqual({ estado: 'no_escrito', motivo: expect.stringMatching(/no se conoce/) });
  });
  it('⛔ más de una fila es imposible por la llave primaria, pero no se da por buena', () => {
    expect(veredictoAutorizacion(2, null).estado).toBe('no_escrito');
  });
});
