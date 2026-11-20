import { cajaDeSalidaTexto, nombreDeBase, porEntregar, xd60DeLaEntrega } from './entrega-efectivo.contract';

/**
 * `[PGP.157]` El anticipo en efectivo sale de la Caja General de SU base (cada base cuadra sola): uno de Morelia
 * Abastos sale de la 08, se captura en su Kepler y se aplica a su factura.
 */
describe('[PGP.157] de qué caja sale el anticipo', () => {
  it('la caja es la de la base del anticipo; la 00 se llama Oficinas (no CEDIS)', () => {
    expect(cajaDeSalidaTexto('08')).toBe('Caja General · Morelia Abastos');
    expect(cajaDeSalidaTexto('00')).toBe('Caja General · Oficinas');
    expect(nombreDeBase('00')).toBe('Oficinas');
    // Un código desconocido se devuelve tal cual: nunca se adivina el nombre de otra plaza.
    expect(nombreDeBase('99')).toBe('99');
  });
});

describe('[PGP.157] cuándo Caja General tiene un anticipo por entregar', () => {
  const base = { pago_metodo: 'efectivo', pago_estado: 'pending', pago_autorizado: true, etapa: 'programado' as const, con_xd60: false };

  it('⭐ autorizado, en efectivo, pendiente y sin SU X-D-60 en Kepler: por entregar', () => {
    expect(porEntregar(base)).toBe(true);
    // Un X-D-60 que no es el de esta entrega (de antes de autorizar) no lo saca: la etapa del seguimiento no manda aquí.
    expect(porEntregar({ ...base, etapa: 'en_kepler', con_xd60: false })).toBe(true);
  });

  it('⛔ NEGATIVA — sin autorizar, en transferencia, cancelado, ya marcado pagado o con su X-D-60: no', () => {
    expect(porEntregar({ ...base, pago_autorizado: false })).toBe(false);
    expect(porEntregar({ ...base, pago_metodo: 'transferencia' })).toBe(false);
    expect(porEntregar({ ...base, pago_metodo: null })).toBe(false);
    expect(porEntregar({ ...base, etapa: 'cancelado' })).toBe(false);
    expect(porEntregar({ ...base, pago_estado: 'executed', etapa: 'pagado' })).toBe(false);
    expect(porEntregar({ ...base, etapa: 'en_kepler', con_xd60: true })).toBe(false);
  });

  it('⛔ NEGATIVA — un X-D-60 de ANTES de la autorización no es el de esta entrega; el del mismo día o después, sí', () => {
    const k = (fecha: string) => ({ fecha });
    expect(xd60DeLaEntrega(k('2026-11-17'), '2026-11-19T16:40')).toBe(false);
    expect(xd60DeLaEntrega(k('2026-11-19'), '2026-11-19T16:40')).toBe(true);
    expect(xd60DeLaEntrega(k('2026-11-20'), '2026-11-19')).toBe(true);
    expect(xd60DeLaEntrega(null, '2026-11-19')).toBe(false);
    expect(xd60DeLaEntrega(k('2026-11-17'), null)).toBe(true);   // sin corte, cuenta
  });
});
