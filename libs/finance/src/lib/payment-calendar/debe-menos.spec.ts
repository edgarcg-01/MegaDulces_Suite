import { cargoDeLaFactura, cubiertoAntesPorRenglon, debeMenosDelPago, debeParaEsteRenglon, facturasQueDebenMenos, seAjustaSolo, tipoDeAbono, type FacturaParaDebeMenos } from './debe-menos';

/**
 * `[PGP.147]` La factura ya debe menos de lo que el pago le lleva. Forma tomada del caso real (Mondelez, 13-nov):
 * factura 20-1-0010007 programada por $469,071.93; el 12-nov dos notas de crédito bajaron su saldo a $346,929.24.
 */
const f = (o: Partial<FacturaParaDebeMenos> = {}): FacturaParaDebeMenos => ({
  id: 'it1', applied_amount: 469071.93, kepler_debe: 346929.24, kepler_saldada: false,
  entity_ref: 'oblig:00|20|1|0010007', payee_code: 'CM009', ...o,
});
const abonos = new Map([['00|20|1|0010007', [
  { doc: '55-0001512', clase: 'Nota de crédito', fecha: '2026-11-12', monto: 120000 },
  { doc: '55-0001513', clase: 'Nota de crédito', fecha: '2026-11-12', monto: 2142.69 },
]]]);

describe('[PGP.147] la factura ya debe menos de lo que el pago le lleva', () => {
  it('el caso Mondelez: $122,142.69 de más, con las dos notas que lo explican', () => {
    expect(debeMenosDelPago([f()], abonos)).toEqual({
      de_mas: 122142.69,
      facturas: [{ item_id: 'it1', factura: '20-1-0010007', programado: 469071.93, debe: 346929.24, de_mas: 122142.69, abonos: abonos.get('00|20|1|0010007') }],
    });
  });

  it('NEGATIVA: lo que debe igual (o con $1 de redondeo) no se dice', () => {
    expect(debeMenosDelPago([f({ kepler_debe: 469071.93 })], abonos)).toBeNull();
    expect(debeMenosDelPago([f({ kepler_debe: 469071.0 })], abonos)).toBeNull();
    expect(facturasQueDebenMenos([f({ kepler_debe: 469070.0 })])).toHaveLength(1);
  });

  it('la saldada por completo y la que no se midió van por otro lado', () => {
    expect(facturasQueDebenMenos([f({ kepler_debe: 0, kepler_saldada: true })])).toHaveLength(0);
    expect(facturasQueDebenMenos([f({ kepler_debe: null })])).toHaveLength(0);
  });

  it('el pago suma sólo las facturas que deben menos; sin llave legible se dice la factura sin abonos', () => {
    const r = debeMenosDelPago([f(), f({ id: 'it2', applied_amount: 100, kepler_debe: 100 }), f({ id: 'it3', applied_amount: 50, kepler_debe: 20, entity_ref: null })], abonos);
    expect(r?.de_mas).toBe(122172.69);
    expect(r?.facturas.map((x) => x.item_id)).toEqual(['it1', 'it3']);
    expect(r?.facturas[1]).toMatchObject({ factura: '—', abonos: [] });
  });

  it('la llave del cargo sale de la llave natural de la factura y el acreedor', () => {
    expect(cargoDeLaFactura(f())).toEqual({ llave: '00|20|1|0010007', sucursal: '00', acreedor: 'CM009', tipo: 20, sub: 1, folio: '0010007' });
    expect(cargoDeLaFactura(f({ payee_code: null }))).toBeNull();
  });
});

describe('[PGP.148] cuándo el pago se ajusta SOLO (D19 b)', () => {
  const nc = (fecha: string | null, doc = '55-0001512') => ({ doc, clase: 'Nota de crédito', fecha, monto: 120000 });
  const pago = (fecha: string | null) => ({ doc: '26-0000377', clase: 'Transferencia', fecha, monto: 111036.87 });

  it('el caso Mondelez: sólo notas de crédito después de armarlo → se ajusta solo', () => {
    expect(seAjustaSolo([nc('2026-11-12'), nc('2026-11-12', '55-0001513')], '2026-10-26')).toBe(true);
  });

  it('⛔ un pago (transferencia, cheque, anticipo) después de armarlo: puede ser ESTE pago → lo decide una persona', () => {
    expect(seAjustaSolo([pago('2026-10-30')], '2026-10-26')).toBe(false);
    expect(seAjustaSolo([nc('2026-11-12'), pago('2026-11-13')], '2026-10-26')).toBe(false);
    expect(seAjustaSolo([{ doc: '25-0000010', clase: 'Cheque', fecha: '2026-11-01', monto: 1 }], '2026-10-26')).toBe(false);
    expect(seAjustaSolo([{ doc: '60-0000004', clase: 'Anticipo', fecha: '2026-11-01', monto: 1 }], '2026-10-26')).toBe(false);
  });

  it('⛔ sin nada que no sea dinero que lo explique, o con un abono sin fecha: no se ajusta solo', () => {
    expect(seAjustaSolo([], '2026-10-26')).toBe(false);
    expect(seAjustaSolo([nc(null)], '2026-10-26')).toBe(false);
    // Sólo dinero, aunque sea anterior a armarlo: no hay nota que lo explique.
    expect(seAjustaSolo([pago('2026-09-01')], '2026-10-26')).toBe(false);
  });

  it('⭐ la nota ANTERIOR a armarlo también cuenta: un pago reprogramado nace con el importe viejo (d0bc010a, prod 2026-11-18)', () => {
    expect(seAjustaSolo([nc('2026-11-10'), nc('2026-11-10', '55-0001507')], '2026-11-14')).toBe(true);
  });

  it('un pago viejo, anterior a armarlo, no estorba a la nota nueva', () => {
    expect(seAjustaSolo([pago('2026-09-01'), nc('2026-11-12')], '2026-10-26')).toBe(true);
    expect(tipoDeAbono('55-0001512')).toBe(55);
  });
});

/**
 * `[PGP.190]` Una factura partida en dos transferencias ($1,000,000 + $150,000.25) y una nota de crédito que baja su
 * saldo: la suma de las partes no puede pasar de lo que se debe. La última transferencia absorbe primero.
 */
describe('[PGP.190] la factura partida entre varios pagos vivos', () => {
  const vivos = [
    { item_id: 'p1', obligation_id: 'F', cubierto: 1000000 },
    { item_id: 'p2', obligation_id: 'F', cubierto: 150000.25 },
    { item_id: 'otra', obligation_id: 'G', cubierto: 5000 },
  ];
  const antes = cubiertoAntesPorRenglon(vivos);
  const parte = (id: string, applied: number, debe: number): FacturaParaDebeMenos =>
    f({ id, applied_amount: applied, kepler_debe: debeParaEsteRenglon(debe, antes.get(id) ?? 0), partida: (antes.get(id) ?? 0) > 0.005 });

  it('cada renglón ve lo que cubren los anteriores de la MISMA factura', () => {
    expect([...antes]).toEqual([['p1', 0], ['p2', 1000000], ['otra', 0]]);
  });

  it('sin nota: ninguna parte lleva de más', () => {
    expect(facturasQueDebenMenos([parte('p1', 1000000, 1150000.25), parte('p2', 150000.25, 1150000.25)])).toEqual([]);
  });

  it('una nota de $100,000: la última lleva $100,000 de más y baja a $50,000.25; la primera no se toca', () => {
    const malas = facturasQueDebenMenos([parte('p1', 1000000, 1050000.25), parte('p2', 150000.25, 1050000.25)]);
    expect(malas.map((m) => [m.id, m.kepler_debe])).toEqual([['p2', 50000.25]]);
    expect(debeMenosDelPago(malas, new Map())?.de_mas).toBe(100000);
  });

  it('NEGATIVA: comparar cada parte contra el saldo completo (lo de antes) no veía los $100,000', () => {
    const contraElSaldo = (id: string, applied: number) => f({ id, applied_amount: applied, kepler_debe: 1050000.25 });
    expect(facturasQueDebenMenos([contraElSaldo('p1', 1000000), contraElSaldo('p2', 150000.25)])).toEqual([]);
  });

  it('una nota mayor que la última parte: esa parte queda en cero y sí se dice (se quita del pago); la primera baja', () => {
    const malas = facturasQueDebenMenos([parte('p1', 1000000, 900000), parte('p2', 150000.25, 900000)]);
    expect(malas.map((m) => [m.id, m.kepler_debe])).toEqual([['p1', 900000], ['p2', 0]]);
  });

  it('una factura SIN partir en cero sigue siendo la saldada de [PGP.35], no un «de más»', () => {
    expect(facturasQueDebenMenos([f({ kepler_debe: 0 })])).toEqual([]);
    expect(debeParaEsteRenglon(null, 5)).toBeNull();
  });
});
