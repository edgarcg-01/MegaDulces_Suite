import { armarDescuentos } from './commercial-televenta.service';

/**
 * `[E.15]` La cascada del descuento del canal: `lista − producto = subtotal − cliente = facturado`.
 *
 * Lo que se fija acá (la consulta trae una fila por operador × % del maestro × % del documento):
 *
 *  1. **La cascada cierra**: lista = subtotal + producto, y subtotal − cliente = facturado.
 *  2. **Una factura sin renglones no entra a la cuenta**: se cuenta aparte con su total. Sumar su
 *     total sin su lista rompía el cierre — medido en prod el 2026-10-21, $6,289.71 de una
 *     factura cuya cabecera llegó antes que su detalle.
 *  3. **Negociado contra aplicado**, por la diferencia de % sobre el subtotal, en las dos
 *     direcciones y nunca mezcladas.
 *  4. **El reparto por operador** suma lo mismo que la cascada.
 */
describe('armarDescuentos', () => {
  const fila = (o: Record<string, unknown>): Record<string, unknown> => ({
    vendedor_code: '30003', vendedor_nombre: 'DANIEL', pct_maestro: '2', pct_documento: '2',
    facturas: 1, facturas_sin_renglones: 0, total_sin_renglones: '0', renglones: 3, renglones_sin_lista: 0,
    subtotal: '1000.00', producto: '50.00', cliente: '20.00', facturado: '980.00', ...o,
  });

  it('la cascada cierra al centavo', () => {
    const { resumen: r } = armarDescuentos([
      fila({}),
      fila({ vendedor_code: '10002', vendedor_nombre: 'SERGIO', subtotal: '500.10', producto: '0.10', cliente: '15.00', facturado: '485.10', pct_maestro: '3', pct_documento: '3' }),
    ]);
    expect(r.lista).toBe(1550.2);
    expect(centavos(r.lista - r.producto)).toBe(r.subtotal);
    expect(centavos(r.subtotal - r.cliente)).toBe(r.facturado);
    expect(r.facturas).toBe(2);
  });

  it('una factura sin renglones se declara aparte y no rompe el cierre', () => {
    const { resumen: r } = armarDescuentos([
      fila({}),
      fila({ facturas: 0, facturas_sin_renglones: 1, total_sin_renglones: '6289.71', renglones: 0,
        subtotal: '0', producto: '0', cliente: '0', facturado: '0' }),
    ]);
    expect(r.facturas).toBe(1);
    expect(r.facturas_sin_renglones).toBe(1);
    expect(r.total_sin_renglones).toBe(6289.71);
    expect(centavos(r.subtotal - r.cliente)).toBe(r.facturado);
    // y no cuenta como «descuento no aplicado» ni como «sin respaldo»
    expect(r.negociado_no_aplicado.facturas).toBe(0);
    expect(r.sin_respaldo_maestro.facturas).toBe(0);
  });

  it('negociado contra aplicado: las dos direcciones, por separado', () => {
    const { resumen: r } = armarDescuentos([
      fila({ pct_maestro: '2', pct_documento: '0', facturas: 4, subtotal: '10000', cliente: '0', facturado: '10000' }),
      fila({ pct_maestro: '0', pct_documento: '3', facturas: 2, subtotal: '5000', cliente: '150', facturado: '4850' }),
      fila({ pct_maestro: '2', pct_documento: '2' }),
    ]);
    expect(r.negociado_no_aplicado).toMatchObject({ facturas: 4, monto: 200 });
    expect(r.sin_respaldo_maestro).toMatchObject({ facturas: 2, monto: 150 });
    // filas agrupadas no traen folio: no hay a qué documento apuntar, y no se inventa
    expect(r.negociado_no_aplicado.detalle).toEqual([]);
  });

  it('[E.16] por factura, la lista de diferencias llega a N y va de mayor a menor', () => {
    const porFactura = (folio: string, subtotal: string, pm: string, pd: string): Record<string, unknown> =>
      fila({ folio_digital: folio, fecha: '2026-10-20', cliente_nombre: 'X', pct_maestro: pm, pct_documento: pd, subtotal });
    const { resumen: r } = armarDescuentos([
      porFactura('01UD0801-1', '1000', '2', '0'),
      porFactura('01UD0801-2', '9000', '3', '0'),
      porFactura('01UD0801-3', '500', '0', '2'),
      porFactura('01UD0801-4', '700', '2', '2'),
    ]);
    expect(r.negociado_no_aplicado.facturas).toBe(2);
    expect(r.negociado_no_aplicado.detalle.map((d) => d.folio_digital)).toEqual(['01UD0801-2', '01UD0801-1']);
    expect(r.negociado_no_aplicado.detalle.map((d) => d.diferencia)).toEqual([270, 20]);
    expect(r.negociado_no_aplicado.detalle.reduce((a, d) => a + d.diferencia, 0)).toBe(r.negociado_no_aplicado.monto);
    expect(r.sin_respaldo_maestro.detalle).toHaveLength(r.sin_respaldo_maestro.facturas);
    expect(r.sin_respaldo_maestro.detalle[0]).toMatchObject({ folio_digital: '01UD0801-3', diferencia: 10 });
  });

  it('el reparto por operador suma lo mismo que la cascada', () => {
    const rows = [
      fila({}),
      fila({ pct_maestro: '0', pct_documento: '0', subtotal: '200', producto: '5', cliente: '0', facturado: '200' }),
      fila({ vendedor_code: null, vendedor_nombre: null, subtotal: '100', producto: '1', cliente: '2', facturado: '98' }),
    ];
    const { resumen: r, porOperador } = armarDescuentos(rows);
    expect(porOperador.get('30003|DANIEL')).toEqual({ lista: 1255, producto: 55, cliente: 20 });
    expect(porOperador.get('|')).toEqual({ lista: 101, producto: 1, cliente: 2 });
    const suma = [...porOperador.values()].reduce((a, o) => a + o.producto + o.cliente, 0);
    expect(centavos(suma)).toBe(centavos(r.producto + r.cliente));
  });
});

function centavos(n: number): number {
  return Math.round(n * 100) / 100;
}
