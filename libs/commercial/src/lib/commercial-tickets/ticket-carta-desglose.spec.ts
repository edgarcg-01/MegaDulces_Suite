import { TicketCartaService, columnasDe } from './ticket-carta.service';
import { CommercialTicketsService, TicketDetalle } from './commercial-tickets.service';

/**
 * `[TK.13]` La hoja carta con el desglose pedido:
 *
 *   Producto (nombre, código) · Cantidad · Precio lista · Descuento* · Precio c/desc ·
 *   Sin impuestos · IVA* · IEPS* · Neto
 *
 * un renglón con los valores POR PIEZA y, si la cantidad no es 1, otro con el TOTAL de la
 * partida; al pie, la fila de totales. (* = sólo si el documento lo tiene.)
 *
 * Reemplaza a `ticket-carta-neto.spec.ts` (TK.10): las columnas «Neto» y «Neto c/desc» salieron
 * del papel porque este formato las sustituye. Lo que TK.10 fijaba y sigue vigente se conserva:
 * sin cuadre fiscal no se imprimen columnas de impuesto, y la ausencia de un dato no es un cero.
 *
 * El documento se arma con el `armar()` REAL, no a mano: así la carta se prueba con cifras que
 * de verdad cuadran entre sí, que es justo lo que un fixture escrito a mano no garantiza.
 */

type Fila = Record<string, unknown>;
const tickets = new CommercialTicketsService({} as never, {} as never);
const carta = new TicketCartaService({ logo: () => '' } as never, {} as never);

const doc = (h: Record<string, unknown>, raw: Fila[]): TicketDetalle =>
  (tickets as unknown as { armar(h: unknown, raw: Fila[]): TicketDetalle }).armar({
    id: '05UD1005-0006440', origen: 'mostrador', doc_label: null,
    sucursal: '05', sucursal_nombre: 'Zamora Centro', caja: 5, folio: '0006440', fecha: '2026-09-18',
    cliente_nombre: 'ABARROTES DOÑA MARÍA', cliente_rfc: null, atendio: null, atendio_rol: null,
    descuento_pct_erp: null, impuestos_incluidos: true, ...h,
  }, raw);

const html = (d: TicketDetalle): string =>
  (carta as unknown as { html(d: TicketDetalle, e: unknown): string })
    .html(d, { rfc: 'XAXX010101000', nombre: 'MEGA DULCES', cp: '59600' });

const PALETA: Fila = {
  linea: 1, sku: '900', descripcion: 'PALETA PAYASO CHICO 20G', unidad: 'PZA',
  cantidad: 12, precio_unitario: 5, precio_lista: 6, importe: 60, iva_tasa: 0.16, ieps_tasa: 0,
};
const CHICLE: Fila = {
  linea: 2, sku: '901', descripcion: 'CHICLE MENTA', unidad: 'PZA',
  cantidad: 1, precio_unitario: 10, precio_lista: 10, importe: 10, iva_tasa: 0, ieps_tasa: 0.08,
};

/** Sólo el encabezado de la tabla de productos: el CSS y el resumen también dicen «IVA». */
const encabezado = (h: string) => (h.match(/<thead>[\s\S]*?<\/thead>/) ?? [''])[0];

describe('[TK.13] hoja carta con desglose por pieza y por partida', () => {
  it('encabezados en el orden de la cuenta, con descuento e IVA/IEPS sólo porque el documento los trae', () => {
    const d = doc({ total: 70, iva: 8.28, ieps: 0.74 }, [PALETA, CHICLE]);
    const th = encabezado(html(d));
    const orden = ['Producto', 'Cantidad', 'Precio lista', 'Descuento', 'Precio c/desc', 'Sin impuestos', 'IVA', 'IEPS', 'Neto'];
    let desde = 0;
    for (const t of orden) {
      const i = th.indexOf(`>${t}<`);
      expect(i).toBeGreaterThan(desde - 1);
      desde = i;
    }
  });

  /**
   * Acomodo marcado por el usuario sobre el PDF: el renglón del producto dice «VALOR UNITARIO» y
   * NO lleva neto; el de la partida dice «PZA × 12» y sí. Con una pieza, un solo renglón «PZA × 1».
   */
  it('la partida de 12 piezas: renglón unitario sin neto + renglón de total; la de 1 pieza, uno solo', () => {
    const h = html(doc({ total: 70, iva: 8.28, ieps: 0.74 }, [PALETA, CHICLE]));
    expect((h.match(/<tr class="pt">/g) ?? []).length).toBe(1);
    expect((h.match(/<tr class="u">/g) ?? []).length).toBe(1);
    expect((h.match(/<tr class="u uno">/g) ?? []).length).toBe(1);
    expect(h).toContain('Valor unitario');
    expect(h).toMatch(/PZA <i>&times;<\/i> 12/);
    expect(h).toMatch(/PZA <i>&times;<\/i> 1</);
    // El renglón unitario termina en una celda de neto VACÍA: el neto por pieza no se imprime.
    const unit = (h.match(/<tr class="u">[\s\S]*?<\/tr>/) ?? [''])[0];
    expect(unit).toMatch(/<td class="r fuerte"><\/td>\s*<\/tr>$/);
    // Unitario de la paleta: 6.00 − 1.00 = 5.00 → 4.31 + 0.69 = 5.00
    expect(h).toContain('$6.00');
    expect(h).toContain('-$1.00');
    expect(h).toContain('$4.31');
    expect(h).toContain('$0.69');
    // Total de la partida: 72.00 − 12.00 = 60.00 → 51.72 + 8.28
    expect(h).toContain('$72.00');
    expect(h).toContain('-$12.00');
    expect(h).toContain('$51.72');
    // `[TK.15]` El código dejó de tener renglón propio: va pegado al nombre. Lo que esta
    // línea cuida sigue siendo lo mismo —que el código esté— y su forma la fija
    // `ticket-carta-codigo-inline.spec.ts`.
    expect(h).toContain('<span class="p-sku">&middot; 900</span>');
  });

  it('la fila de totales y el resumen salen del MISMO desglose y cierran contra el total pagado', () => {
    const d = doc({ total: 70, iva: 8.28, ieps: 0.74 }, [PALETA, CHICLE]);
    const t = d.cascada.desglose_total;
    expect(Math.round(((t.sin_impuestos ?? 0) + (t.iva ?? 0) + (t.ieps ?? 0)) * 100) / 100).toBe(70);
    const h = html(d);
    expect(h).toContain('<tfoot>');
    expect(h).toContain('Subtotal sin impuestos');
    expect(h).toContain(`$${(t.sin_impuestos as number).toFixed(2)}`);
  });

  it('lleva la marca de REIMPRESIÓN con fecha y hora de México bajo el título', () => {
    const d = doc({ total: 10, iva: null, ieps: 0.74 }, [CHICLE]);
    const h = (carta as unknown as { html(d: TicketDetalle, e: unknown, a: Date): string })
      .html(d, { rfc: 'XAXX010101000', nombre: 'MEGA DULCES', cp: '59600' }, new Date('2026-09-30T16:25:00Z'));
    expect(h).toContain('Reimpresión 30/09/26 10:25');
  });

  it('sin descuento no hay columnas de lista ni de descuento (un «-$0.00» invita a buscar uno)', () => {
    const d = doc({ total: 10, iva: null, ieps: 0.74 }, [CHICLE]);
    const th = encabezado(html(d));
    expect(th).not.toContain('>Descuento<');
    expect(th).not.toContain('>Precio lista<');
    expect(th).toContain('>Sin impuestos<');
    expect(th).not.toContain('>IVA<');
  });

  it('descuento de CLIENTE: se nombra en el resumen y ya viene repartido en la partida', () => {
    const d = doc({ total: 54, iva: 7.45, ieps: null, descuento_pct_erp: 10 }, [
      { ...PALETA, precio_lista: null },
    ]);
    const h = html(d);
    expect(h).toContain('Descuento de cliente');
    expect(h).toContain('-$6.00');
    // El IVA sale del precio YA descontado: 54 / 1.16 × 0.16.
    expect(h).toContain('$7.45');
  });

  it('sin cuadre fiscal no imprime columnas de impuesto, y lo dice', () => {
    const d = doc({ total: 60, iva: 30, ieps: null }, [PALETA]);
    const h = html(d);
    expect(columnasDe(d).imp).toBe(false);
    expect(encabezado(h)).not.toContain('>Sin impuestos<');
    expect(encabezado(h)).not.toContain('>IVA<');
    expect(h).toContain('No se desglosan impuestos');
  });
});
