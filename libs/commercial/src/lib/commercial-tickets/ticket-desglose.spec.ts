import { CommercialTicketsService, TicketDetalle } from './commercial-tickets.service';

/**
 * `[TK.13]` El desglose que se le entrega al cliente: por pieza y por partida.
 *
 *     lista − descuento = con_descuento  →  sin_impuestos + IVA + IEPS = neto
 *
 * Lo que se fija acá, todo aritmética de dinero:
 *  1. Cada fila se suma sola (unitaria y de partida).
 *  2. El descuento del CLIENTE se reparte en las partidas y los impuestos salen del precio YA
 *     descontado.
 *  3. Σ neto de las partidas = total del documento, al centavo, aunque el reparto redondee.
 *  4. Sin contra qué comparar, la lista es `null` (nunca 0); sin cuadre fiscal, los impuestos
 *     también.
 */

type Fila = Record<string, unknown>;
const svc = new CommercialTicketsService({} as never, {} as never);

const armar = (h: Record<string, unknown>, raw: Fila[]): TicketDetalle =>
  (svc as unknown as { armar(h: unknown, raw: Fila[]): TicketDetalle }).armar({
    id: '05UD1005-0006440', origen: 'mostrador', doc_label: null,
    sucursal: '05', sucursal_nombre: 'Zamora Centro', caja: 5, folio: '0006440', fecha: '2026-09-18',
    cliente_nombre: null, cliente_rfc: null, atendio: null, atendio_rol: null, descuento_pct_erp: null,
    impuestos_incluidos: true, ...h,
  }, raw);

const linea = (o: Fila): Fila => ({
  linea: 1, sku: '900', descripcion: 'PRODUCTO', unidad: 'PZA', iva_tasa: 0, ieps_tasa: 0, ...o,
});

const cierra = (m: { sin_impuestos: number | null; iva: number | null; ieps: number | null; neto: number }) =>
  Math.round(((m.sin_impuestos ?? 0) + (m.iva ?? 0) + (m.ieps ?? 0)) * 100) / 100;

describe('[TK.13] desglose por pieza y por partida', () => {
  it('descuento de producto: lista − descuento = precio c/desc, y el IVA sale de ahí', () => {
    const d = armar({ total: 60, iva: 8.28, ieps: null }, [
      linea({ cantidad: 12, precio_unitario: 5, precio_lista: 6, importe: 60, iva_tasa: 0.16 }),
    ]);
    const { unitario: u, partida: p } = d.lineas[0].desglose;
    expect(p).toEqual({ lista: 72, descuento: 12, con_descuento: 60, sin_impuestos: 51.72, iva: 8.28, ieps: 0, neto: 60 });
    expect(u.lista).toBe(6);
    expect(u.descuento).toBe(1);
    expect(u.con_descuento).toBe(5);
    expect(u.neto).toBe(5);
    expect(cierra(u)).toBe(u.neto);
    expect(cierra(p)).toBe(p.neto);
  });

  it('descuento de CLIENTE: se reparte en cada partida y los impuestos van sobre lo descontado', () => {
    // 10% de descuento del documento sobre dos partidas: una con IVA y otra con IEPS.
    const d = armar({ total: 135, iva: 12.41, ieps: 3.33 }, [
      linea({ linea: 1, cantidad: 1, precio_unitario: 100, importe: 100, iva_tasa: 0.16 }),
      linea({ linea: 2, sku: '901', cantidad: 5, precio_unitario: 10, importe: 50, ieps_tasa: 0.08 }),
    ]);
    const [a, b] = d.lineas.map((l) => l.desglose);
    expect(a.descuento_cliente).toBe(10);
    expect(b.descuento_cliente).toBe(5);
    // Sin lista en el ERP, la referencia es el precio ANTES del descuento del cliente.
    expect(a.partida).toMatchObject({ lista: 100, descuento: 10, con_descuento: 90, iva: 12.41, neto: 90 });
    expect(b.partida).toMatchObject({ lista: 50, descuento: 5, con_descuento: 45, ieps: 3.33, neto: 45 });
    expect(b.unitario).toMatchObject({ lista: 10, descuento: 1, con_descuento: 9, neto: 9 });
    for (const x of [a, b]) {
      expect(cierra(x.partida)).toBe(x.partida.neto);
      expect(cierra(x.unitario)).toBe(x.unitario.neto);
    }
    const t = d.cascada.desglose_total;
    expect(t).toMatchObject({ lista: 150, descuento: 15, con_descuento: 135, neto: 135 });
    expect(cierra(t)).toBe(135);
  });

  it('el reparto redondea, pero Σ neto de las partidas da el total del documento al centavo', () => {
    const tres = [1, 2, 3].map((n) => linea({ linea: n, sku: String(900 + n), cantidad: 1, precio_unitario: 10, importe: 10 }));
    const d = armar({ total: 29.99, iva: null, ieps: null }, tres);
    const suma = d.lineas.reduce((a, l) => a + l.desglose.partida.neto, 0);
    expect(Math.round(suma * 100) / 100).toBe(29.99);
    expect(d.cascada.desglose_total.neto).toBe(29.99);
  });

  it('sin lista en el ERP y sin descuento de cliente: la lista es null, nunca 0, y no hay descuento', () => {
    const d = armar({ total: 20, iva: null, ieps: null }, [
      linea({ cantidad: 2, precio_unitario: 10, importe: 20 }),
    ]);
    const { unitario: u, partida: p } = d.lineas[0].desglose;
    expect(u.lista).toBeNull();
    expect(p.lista).toBeNull();
    expect(p.descuento).toBe(0);
    expect(d.cascada.desglose_total.lista).toBeNull();
  });

  it('si el impuesto de los renglones no reproduce la cabecera, no se publican sin_impuestos ni impuestos', () => {
    const d = armar({ total: 60, iva: 30, ieps: null }, [
      linea({ cantidad: 12, precio_unitario: 5, importe: 60, iva_tasa: 0.16 }),
    ]);
    const { unitario: u, partida: p } = d.lineas[0].desglose;
    expect(p.sin_impuestos).toBeNull();
    expect(p.iva).toBeNull();
    expect(u.sin_impuestos).toBeNull();
    // El neto y el precio sí: son lo cobrado, no dependen del cuadre fiscal.
    expect(p.neto).toBe(60);
    expect(d.cascada.desglose_total.sin_impuestos).toBeNull();
  });

  it('pedido de la plataforma (impuestos NO incluidos): c/desc sin IVA, neto con IVA', () => {
    const d = armar({ origen: 'pedido', total: 116, iva: 16, ieps: null, impuestos_incluidos: false }, [
      linea({ cantidad: 4, precio_unitario: 25, importe: 100, iva_tasa: 0.16 }),
    ]);
    const { unitario: u, partida: p } = d.lineas[0].desglose;
    expect(p).toMatchObject({ con_descuento: 100, sin_impuestos: 100, iva: 16, neto: 116 });
    expect(u).toMatchObject({ con_descuento: 25, sin_impuestos: 25, iva: 4, neto: 29 });
  });
});
