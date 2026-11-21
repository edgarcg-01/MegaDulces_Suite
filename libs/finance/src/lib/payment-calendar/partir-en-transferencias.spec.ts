import { ErrorAlPartir, MAX_TRANSFERENCIAS, partirEnTransferencias, type RenglonParaPartir } from './partir-en-transferencias';

const r = (id: string, applied_amount: number, discount_amount = 0): RenglonParaPartir => ({ id, applied_amount, discount_amount, factura: `20-1-${id}` });

describe('[PGP.190] partir un pago en varias transferencias', () => {
  it('una sola factura en dos transferencias: se abona en dos tramos (forma de CE012 del 31-ago en Kepler)', () => {
    expect(partirEnTransferencias([r('0000101', 1075000.5)], [1000000, 75000.5])).toEqual([
      { importe: 1000000, tramos: [{ item_id: '0000101', applied_amount: 1000000 }] },
      { importe: 75000.5, tramos: [{ item_id: '0000101', applied_amount: 75000.5 }] },
    ]);
  });

  it('varias facturas: llenan la 1ª en orden y sólo la de la frontera se parte', () => {
    const partes = partirEnTransferencias([r('A', 600000), r('B', 500000), r('C', 50000.25)], [1000000, 150000.25]);
    expect(partes).toEqual([
      { importe: 1000000, tramos: [{ item_id: 'A', applied_amount: 600000 }, { item_id: 'B', applied_amount: 400000 }] },
      { importe: 150000.25, tramos: [{ item_id: 'B', applied_amount: 100000 }, { item_id: 'C', applied_amount: 50000.25 }] },
    ]);
  });

  it('cada parte suma su importe al centavo, y cada factura suma lo que llevaba (sin perder ni inventar centavos)', () => {
    const renglones = [r('A', 0.1), r('B', 0.2), r('C', 333333.33), r('D', 0.37)];
    const importes = [111111.11, 111111.11, 111111.78];
    const partes = partirEnTransferencias(renglones, importes);
    const c = (n: number) => Math.round(n * 100);
    partes.forEach((p, i) => expect(p.tramos.reduce((s, t) => s + c(t.applied_amount), 0)).toBe(c(importes[i])));
    for (const x of renglones) {
      const suma = partes.flatMap((p) => p.tramos).filter((t) => t.item_id === x.id).reduce((s, t) => s + c(t.applied_amount), 0);
      expect(suma).toBe(c(x.applied_amount));
    }
    expect(partes.flatMap((p) => p.tramos).every((t) => t.applied_amount > 0)).toBe(true);
  });

  it('una frontera justo entre dos facturas no parte ninguna', () => {
    expect(partirEnTransferencias([r('A', 700), r('B', 300)], [700, 300])).toEqual([
      { importe: 700, tramos: [{ item_id: 'A', applied_amount: 700 }] },
      { importe: 300, tramos: [{ item_id: 'B', applied_amount: 300 }] },
    ]);
  });

  it('⛔ la factura con descuento al pagar no se parte: dice a cuánto dejar la transferencia', () => {
    const fn = () => partirEnTransferencias([r('A', 100), r('B', 500, 25), r('C', 200)], [300, 500]);
    expect(fn).toThrow(ErrorAlPartir);
    // La 1ª empieza en 0; B ocupa de 100 a 600: terminar en $100 o en $600.
    expect(fn).toThrow(/20-1-B lleva descuento al pagar.*1ª transferencia en \$100\.00 o en \$600\.00/);
  });

  it('⛔ con descuento y al final del pago: sólo se propone terminar antes', () => {
    expect(() => partirEnTransferencias([r('A', 100), r('B', 500, 25)], [300, 300])).toThrow(/en \$100\.00\.$/);
  });

  it('⛔ una sola factura con descuento: no hay frontera posible y se dice', () => {
    expect(() => partirEnTransferencias([r('A', 500, 25)], [200, 300])).toThrow(/sale en una sola transferencia/);
  });

  it('la factura con descuento entera en una transferencia sí se reparte', () => {
    expect(partirEnTransferencias([r('A', 500, 25), r('B', 200)], [500, 200])[0].tramos).toEqual([{ item_id: 'A', applied_amount: 500 }]);
  });

  it('⛔ importes que no suman el pago, en cero o negativos, una sola o de más: se rechazan con su razón', () => {
    expect(() => partirEnTransferencias([r('A', 1000)], [600, 300])).toThrow(/suman \$900\.00 y el pago es de \$1,000\.00/);
    expect(() => partirEnTransferencias([r('A', 1000)], [1000, 0])).toThrow(/mayor que cero/);
    expect(() => partirEnTransferencias([r('A', 1000)], [1100, -100])).toThrow(/mayor que cero/);
    expect(() => partirEnTransferencias([r('A', 1000)], [Number.NaN, 1000])).toThrow(/mayor que cero/);
    expect(() => partirEnTransferencias([r('A', 1000)], [1000])).toThrow(/al menos dos/);
    expect(() => partirEnTransferencias([r('A', 1000)], Array(MAX_TRANSFERENCIAS + 1).fill(1000 / (MAX_TRANSFERENCIAS + 1)))).toThrow(/como máximo/);
    expect(() => partirEnTransferencias([], [1, 1])).toThrow(/no tiene facturas/);
  });

  it('un centavo de diferencia por redondeo del navegador no pasa (al centavo exacto)', () => {
    expect(() => partirEnTransferencias([r('A', 1150000.25)], [1000000, 150000.24])).toThrow(ErrorAlPartir);
    expect(partirEnTransferencias([r('A', 1150000.25)], [1000000, 150000.25 + 1e-9])).toHaveLength(2);
  });
});
