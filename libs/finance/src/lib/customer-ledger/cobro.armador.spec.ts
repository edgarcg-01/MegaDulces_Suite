import {
  ABONO, CAPTURISTA_SUITE, CUENTA_BANCOS, CUENTA_CLIENTES, REFERENCIA_MAX,
  armarCobro, tablaDePoliza, type PeticionCobro,
} from './cobro.armador';

/**
 * `[CC.33]` Lo que decide un cobro antes de tocar Kepler. **Cada guarda con su prueba negativa** (regla 12): la
 * que impide el error y el control que demuestra que la guarda no está siempre en rojo.
 *
 * El caso de arriba es el real: el depósito de $15,539.63 del 2026-11-23 que paga, al centavo, la factura
 * `8-1-0001446` del cliente `C3065` en Canindo — el que se escribió a mano como `06/U-A-7/0000900`.
 */
const F = (folio: string, monto: number, saldo = monto) => ({ tipo: 8, serie: 1, folio, monto, saldo });
const P = (over: Partial<PeticionCobro> = {}): PeticionCobro => ({
  sucursal: '06', cliente: 'C3065', nombre: 'CLIENTE DE PRUEBA', referencia: 'SUITE-CC-abc123',
  fecha: '2026-11-23', hora: '09:00', caja: '30004', facturas: [F('0001446', 15539.63)], ...over,
});

describe('[CC.33] armarCobro', () => {
  it('el caso real: una factura al centavo', () => {
    const r = armarCobro(P());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valor.total).toBe(15539.63);
    expect(r.valor.facturas).toBe(1);
    expect(r.valor.kdm1['c67']).toBe(CAPTURISTA_SUITE);
    expect(r.valor.kdue['c29']).toBe(ABONO);
    expect(r.valor.kdm5).toHaveLength(1);
  });

  it('⭐ la fecha es la del DEPÓSITO, y la póliza es la de ESE mes', () => {
    const r = armarCobro(P({ fecha: '2026-11-23' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valor.kdm1['c9']).toBe('2026-11-23');   // no la de hoy
    expect(r.valor.tablaPoliza).toBe('kdc22611');
    expect(tablaDePoliza('2027-01-05')).toBe('kdc22701');  // el control: otro mes, otra tabla
  });

  it('⭐ la póliza CUADRA: el mismo total a bancos y a clientes, uno cargo y otro abono', () => {
    const r = armarCobro(P());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [banco, cliente] = r.valor.poliza;
    expect(banco.cuenta).toBe(CUENTA_BANCOS);
    expect(cliente.cuenta).toBe(CUENTA_CLIENTES);
    expect(banco.campos['c5']).toBe(cliente.campos['c5']);
    expect(banco.campos['c4']).not.toBe(cliente.campos['c4']);
  });

  it('varias facturas: suma, numera y conserva cada monto', () => {
    const r = armarCobro(P({ facturas: [F('A', 300), F('B', 200.5)] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valor.total).toBe(500.5);
    expect(r.valor.kdm5.map((x) => x['c7'])).toEqual([1, 2]);
    expect(r.valor.kdm5.map((x) => x['c12'])).toEqual([300, 200.5]);
    expect(r.valor.poliza[0].campos['c5']).toBe(500.5);
  });

  it('⛔ NUNCA abona más de lo que la factura debe hoy', () => {
    const de_mas = armarCobro(P({ facturas: [F('0001446', 200, 150)] }));
    expect(de_mas.ok).toBe(false);
    if (!de_mas.ok) expect(de_mas.motivo).toContain('no deja saldo a favor');
    expect(armarCobro(P({ facturas: [F('0001446', 150, 150)] })).ok).toBe(true);   // el control: justo, sí
  });

  it('⛔ la misma factura dos veces se rechaza', () => {
    const r = armarCobro(P({ facturas: [F('X', 100), F('X', 50)] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('dos veces');
    expect(armarCobro(P({ facturas: [F('X', 100), F('Y', 50)] })).ok).toBe(true);  // el control
  });

  it('⛔ sin caja NO se inventa una', () => {
    const r = armarCobro(P({ caja: '   ' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivo).toContain('no se inventa');
    expect(armarCobro(P({ caja: '30004' })).ok).toBe(true);                        // el control
  });

  it('⛔ la referencia tiene que caber en kdm1.c11', () => {
    expect(armarCobro(P({ referencia: 'x'.repeat(REFERENCIA_MAX + 1) })).ok).toBe(false);
    expect(armarCobro(P({ referencia: 'x'.repeat(REFERENCIA_MAX) })).ok).toBe(true);   // el control
    expect(armarCobro(P({ referencia: '  ' })).ok).toBe(false);
  });

  it('⛔ fecha y hora mal formadas se rechazan', () => {
    expect(armarCobro(P({ fecha: '23/11/2026' })).ok).toBe(false);
    expect(armarCobro(P({ hora: '9:00' })).ok).toBe(false);
    expect(armarCobro(P({ fecha: '2026-11-23', hora: '09:00' })).ok).toBe(true);   // el control
  });

  it('⛔ sin facturas, o con montos que no son números, no arma nada', () => {
    expect(armarCobro(P({ facturas: [] })).ok).toBe(false);
    expect(armarCobro(P({ facturas: [F('X', 0, 100)] })).ok).toBe(false);
    expect(armarCobro(P({ facturas: [F('X', Number.NaN, 100)] })).ok).toBe(false);
    expect(armarCobro(P({ facturas: [F('X', -5, 100)] })).ok).toBe(false);
  });

  it('⛔⛔ el plan DICE que no timbra, para que nadie lo suponga', () => {
    const r = armarCobro(P());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.valor.timbra).toBe(false);
  });

  it('el concepto de la póliza se corta, no truena', () => {
    const r = armarCobro(P({ nombre: 'N'.repeat(120) }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(String(r.valor.poliza[0].campos['c6'])).toHaveLength(40);
  });
});
