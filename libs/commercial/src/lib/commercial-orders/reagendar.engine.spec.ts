import { FechaDeEntregaInvalida, cambioDeFechaDe, detalleDeCambioDeFecha, diaCorto, esFechaReal, fechaDeEntregaNueva, razonDeHistoria } from './reagendar.engine';

/** `[MCP.29]` Cambiar el día de entrega: calendario libre hacia adelante, domingos sí, el pasado no. */
describe('[MCP.29] fechaDeEntregaNueva', () => {
  const HOY = '2026-11-20'; // viernes

  it('hoy y cualquier día hacia adelante valen, domingo incluido (D5: «dejémoslo libre»)', () => {
    expect(fechaDeEntregaNueva('2026-11-20', HOY)).toBe('2026-11-20');
    expect(fechaDeEntregaNueva('2026-11-22', HOY)).toBe('2026-11-22'); // domingo
    expect(fechaDeEntregaNueva(' 2027-01-15 ', HOY)).toBe('2027-01-15');
  });

  it('el pasado NO: el surtidor lo vería atrasado desde que nace', () => {
    expect(() => fechaDeEntregaNueva('2026-11-19', HOY)).toThrow(FechaDeEntregaInvalida);
    expect(() => fechaDeEntregaNueva('2026-11-19', HOY)).toThrow('antes de hoy');
  });

  it('lo que no es un día real se rechaza con un mensaje para la vendedora', () => {
    for (const malo of ['2026-02-30', '2026-13-01', '21/11/2026', '', null, undefined, 20261121]) {
      expect(() => fechaDeEntregaNueva(malo, HOY)).toThrow('Elige un día de entrega válido');
    }
  });

  it('esFechaReal: bisiesto sí, 29 de febrero de un año no bisiesto no', () => {
    expect(esFechaReal('2028-02-29')).toBe(true);
    expect(esFechaReal('2026-02-29')).toBe(false);
  });
});

describe('[MCP.29] detalle del justificante', () => {
  it('«del vie 21 nov al lun 23 nov», sin puntos de abreviatura', () => {
    expect(diaCorto('2026-11-21')).toMatch(/^sáb 21 nov$/);
    expect(detalleDeCambioDeFecha('2026-11-20', '2026-11-23')).toBe('del vie 20 nov al lun 23 nov');
  });

  it('sin fecha anterior (pedido viejo sin fecha): sólo a dónde se movió', () => {
    expect(detalleDeCambioDeFecha(null, '2026-11-23')).toBe('al lun 23 nov');
  });
});

/** `[MCP.29]` Las líneas de tiempo «de estado → a estado + motivo» (Comercial, Almacén y el portal del cliente). */
describe('[MCP.29] razonDeHistoria', () => {
  const dd = { delivery_date: { from: '2026-11-21', to: '2026-11-23' } };
  it('un cambio de día dice qué pasó, con su motivo (el snapshot llega como objeto o como texto)', () => {
    expect(razonDeHistoria({ from_status: 'confirmed', to_status: 'confirmed', reason: 'Cambiar la fecha de entrega', snapshot: dd }))
      .toBe('Cambió el día de entrega del sáb 21 nov al lun 23 nov · Cambiar la fecha de entrega');
    expect(razonDeHistoria({ from_status: 'confirmed', to_status: 'confirmed', reason: null, snapshot: JSON.stringify(dd) }))
      .toBe('Cambió el día de entrega del sáb 21 nov al lun 23 nov');
  });
  it('negativa: las demás filas salen tal cual (un snapshot de totales, o una transición de verdad)', () => {
    expect(razonDeHistoria({ from_status: 'confirmed', to_status: 'cancelled', reason: 'Pedido duplicado', snapshot: dd })).toBe('Pedido duplicado');
    expect(razonDeHistoria({ from_status: 'draft', to_status: 'confirmed', reason: null, snapshot: { total: '10.00' } })).toBeNull();
    expect(cambioDeFechaDe('no es json')).toBeNull();
    expect(cambioDeFechaDe({ delivery_date: { from: null, to: '2026-02-30' } })).toBeNull();
  });
});
