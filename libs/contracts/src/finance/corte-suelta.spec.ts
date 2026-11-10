/**
 * `[PGP.113]` La regla que suelta una factura de sucursal anterior al corte.
 *
 * Los vectores son SINTÉTICOS (el repo es público): reproducen la FORMA de los casos medidos en prod
 * —la factura que Oficinas nunca registró, la que sí copió y pagó, la que tiene un pago por su importe,
 * la que ya lleva algo aplicado— sin nombres ni montos reales.
 */
import { anteriorAlCorte, bloqueadaPorCorte, sueltaPorCorte, CORTE_OFICINAS } from './corte-suelta.contract';

const ob = (o: Partial<{ obligation_source: string; branch_code: string | null; original_due_date: string | null; entity_ref: string | null }> = {}) => ({
  obligation_source: 'kepler_payable', branch_code: '01', original_due_date: '2026-09-20', entity_ref: 'oblig:01|20|1|0000100', ...o,
});

describe('[PGP.13] anteriorAlCorte', () => {
  it('sucursal, Kepler y vence antes del corte: cae en el candado', () => {
    expect(anteriorAlCorte(ob())).toBe(true);
  });
  it('Oficinas nunca cae: es desde donde se pagaba', () => {
    expect(anteriorAlCorte(ob({ branch_code: '00' }))).toBe(false);
    expect(anteriorAlCorte(ob({ branch_code: ' 00 ' }))).toBe(false);
  });
  it('vence el día del corte o después: no cae', () => {
    expect(anteriorAlCorte(ob({ original_due_date: CORTE_OFICINAS }))).toBe(false);
    expect(anteriorAlCorte(ob({ original_due_date: '2026-10-15T00:00:00.000Z' }))).toBe(false);
  });
  it('lo que no viene de Kepler no cae', () => {
    expect(anteriorAlCorte(ob({ obligation_source: 'supplier_payable' }))).toBe(false);
  });
  it('sin sucursal o sin vencimiento no se inventa: no cae', () => {
    expect(anteriorAlCorte(ob({ branch_code: null }))).toBe(false);
    expect(anteriorAlCorte(ob({ original_due_date: null }))).toBe(false);
  });
});

describe('[PGP.113] sueltaPorCorte', () => {
  const base = { copia_en_oficinas: false, pago_en_oficinas: false, importe: 1000, pendiente: 1000 };
  it('sin copia en Oficinas, sin pago y sin nada aplicado: se suelta', () => {
    expect(sueltaPorCorte(base)).toBe(true);
  });
  it('⛔ con copia en Oficinas (el mecanismo de antes del corte): se queda bloqueada', () => {
    expect(sueltaPorCorte({ ...base, copia_en_oficinas: true })).toBe(false);
  });
  it('⛔ con un pago o anticipo de Oficinas por su importe: se queda bloqueada', () => {
    expect(sueltaPorCorte({ ...base, pago_en_oficinas: true })).toBe(false);
  });
  it('⛔ con algo ya aplicado: se queda bloqueada (un pago parcial pide revisión)', () => {
    expect(sueltaPorCorte({ ...base, pendiente: 400 })).toBe(false);
  });
  it('tolera medio centavo de redondeo, no más', () => {
    expect(sueltaPorCorte({ ...base, pendiente: 999.996 })).toBe(true);
    expect(sueltaPorCorte({ ...base, pendiente: 999.99 })).toBe(false);
  });
  it('⛔ importes que no son número o no son positivos: se queda bloqueada', () => {
    expect(sueltaPorCorte({ ...base, importe: Number.NaN })).toBe(false);
    expect(sueltaPorCorte({ ...base, importe: 0, pendiente: 0 })).toBe(false);
  });
});

describe('[PGP.113] bloqueadaPorCorte', () => {
  const sueltas = new Set(['oblig:01|20|1|0000100']);
  it('la que se soltó ya no está bloqueada', () => {
    expect(bloqueadaPorCorte(ob(), sueltas)).toBe(false);
  });
  it('la que no se soltó sigue bloqueada', () => {
    expect(bloqueadaPorCorte(ob({ entity_ref: 'oblig:01|20|1|0000200' }), sueltas)).toBe(true);
  });
  it('⛔ si la lista no se pudo leer (null), TODAS siguen bloqueadas: falla cerrado', () => {
    expect(bloqueadaPorCorte(ob(), null)).toBe(true);
  });
  it('⛔ sin llave no se suelta aunque la lista traiga algo', () => {
    expect(bloqueadaPorCorte(ob({ entity_ref: null }), sueltas)).toBe(true);
  });
  it('lo que no cae en el candado nunca se bloquea', () => {
    expect(bloqueadaPorCorte(ob({ branch_code: '00' }), null)).toBe(false);
  });
});
