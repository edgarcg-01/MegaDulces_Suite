import { TicketCartaService } from './ticket-carta.service';
import { CommercialTicketsService, TicketDetalle } from './commercial-tickets.service';

/**
 * `[TK.15]` — **El código del producto va en la misma línea que el nombre.**
 *
 * Pedido textual del usuario (2026-10-01), con su propósito dicho: *«quiero que el codigo del
 * producto este en seguida del nombre del producto, el proposito es que quiero que optimice el
 * interlineado para no gastar tanto papel»*.
 *
 * ## Qué se prueba, y por qué no es sólo «el código aparece»
 * El código aparecía antes también. Lo que cambia es que **ya no estrena un renglón propio**, y
 * eso es lo único que ahorra papel. Una prueba que sólo buscara el número se quedaría verde si
 * alguien devolviera el bloque de abajo.
 *
 * ## La medición que sostiene el cambio (maqueta sobre el PDF real del usuario)
 * Renderizando con Chromium el mismo documento antes y después:
 *
 *   · alto de la tabla, 16 renglones: **171.7 mm → 140 mm (−18.5%)**
 *   · renglones que entran en UNA hoja carta: **13 → 18 (+38%)**
 *
 * ⚠️ Lo que NO logra, dicho acá para que nadie lo repita como logro: el ticket de 30 renglones
 * que originó el pedido **sigue ocupando 2 páginas**. 30 productos no entran en una hoja con
 * este encabezado y este resumen. Lo que se gana es que todo ticket de 14 a 18 renglones pasa
 * de dos hojas a una.
 */

type Fila = Record<string, unknown>;
const tickets = new CommercialTicketsService({} as never, {} as never);
const carta = new TicketCartaService({ logo: () => '' } as never, {} as never);

const doc = (raw: Fila[], h: Record<string, unknown> = {}): TicketDetalle =>
  (tickets as unknown as { armar(h: unknown, raw: Fila[]): TicketDetalle }).armar({
    id: '08UD1003-0001247', origen: 'mostrador', doc_label: 'Ticket Contado Caja 3',
    sucursal: '08', sucursal_nombre: 'VENTA PISO MORELIA ABASTOS', caja: 3,
    folio: '0001247', fecha: '2026-10-01',
    cliente_nombre: 'CONTADO', cliente_rfc: 'XAXX010101000', atendio: null, atendio_rol: null,
    total: 34.89, iva: null, ieps: 2.58, descuento_pct_erp: null, impuestos_incluidos: true, ...h,
  }, raw);

const html = (d: TicketDetalle): string =>
  (carta as unknown as { html(d: TicketDetalle, e: unknown): string })
    .html(d, { rfc: 'LOGL851014AQ5', nombre: 'LUIS FRANCISCO LOPEZ GUTIERREZ', cp: '36910' });

/** El primero de la página 1 del PDF real: 3 piezas, con IEPS, sin descuento. */
const TOTIS: Fila = {
  linea: 1, sku: '83243', descripcion: 'TOTIS DONITA SAL Y LIMON 55 GR', unidad: 'PZA',
  cantidad: 3, precio_unitario: 11.63, precio_lista: 11.63, importe: 34.89,
  iva_tasa: 0, ieps_tasa: 0.08,
};

/** El que trae equivalencia: se cobró en piezas y el renglón vino por paquete. */
const VUALA: Fila = {
  linea: 1, sku: '20606', descripcion: 'VUALA CHOCLATE (60GR) / 6', unidad: 'PZA',
  cantidad: 6, precio_unitario: 15.54, precio_lista: 16.35, importe: 93.24,
  iva_tasa: 0, ieps_tasa: 0.08, unidad_vendida: 'PAQ', cantidad_vendida: 1,
};

/** Sólo la celda del producto del primer renglón. */
const celda = (h: string) => (h.match(/<td class="p-td">[\s\S]*?<\/td>/) ?? [''])[0];

describe('[TK.15] el código del producto, en la línea del nombre', () => {
  it('el código sale pegado al nombre, dentro de la MISMA celda', () => {
    const c = celda(html(doc([TOTIS])));
    expect(c).toContain('TOTIS DONITA SAL Y LIMON 55 GR');
    expect(c).toContain('83243');
    // El nombre es un span en línea, no un bloque: un div volvería a partir el renglón.
    expect(c).toContain('<span class="p-name">');
    expect(c).toContain('<span class="p-sku">');
  });

  /**
   * ⭐ **La prueba que de verdad cubre el pedido.** Lo que ahorra papel no es que el código
   * esté, es que no tenga renglón propio. Si alguien devuelve el `div`, acá se pone rojo.
   */
  it('⛔ el código ya NO vive en un bloque debajo del nombre', () => {
    const h = html(doc([TOTIS]));
    expect(h).not.toContain('<div class="p-sku">');
    expect(h).not.toContain('<div class="p-name">');
    // Y la palabra «Código», que ocupaba 7 caracteres en cada renglón, tampoco.
    expect(h).not.toContain('Código 83243');
  });

  /**
   * ⚠️ Un código partido en dos líneas no se puede leer ni dictar en caja. El `nowrap` es lo
   * único que lo garantiza ahora que comparte flujo de texto con el nombre.
   */
  it('el código no se puede partir en dos líneas', () => {
    expect(html(doc([TOTIS]))).toContain('.p-sku{font-size:7pt;color:var(--muted);font-weight:700;white-space:nowrap}');
  });

  /**
   * ⛔ **Este defecto se vio en la maqueta renderizada, no leyendo el código.** Sin el espacio
   * entre los dos spans el PDF imprimía «20606· equivale a 1 PAQ», todo pegado.
   */
  it('la equivalencia queda separada del código', () => {
    const c = celda(html(doc([VUALA], { total: 93.24, ieps: 6.91 })));
    expect(c).toContain('equivale a');
    expect(c).not.toMatch(/20606<span/);
    expect(c).toContain('</span> <span class="p-eq">');
  });

  /** Sin equivalencia no se pinta el span: uno vacío deja un separador suelto. */
  it('sin equivalencia no hay separador de más', () => {
    expect(celda(html(doc([TOTIS])))).not.toContain('p-eq');
  });

  /** Un renglón sin SKU dice «s/c», no deja el separador colgando. */
  it('un producto sin código lo declara', () => {
    const c = celda(html(doc([{ ...TOTIS, sku: null }])));
    expect(c).toContain('s/c');
  });

  /**
   * ⭐ **La medición, como prueba.** Es lo único que traduce el cambio a papel: el bloque de
   * producto de cada renglón pasó de dos líneas de texto a una. Se cuenta sobre el HTML
   * —cuántos arranques de línea de texto hay en la celda— porque medir milímetros exige un
   * navegador y esto tiene que correr en la suite.
   */
  it('cada producto aporta UN arranque de línea, no dos', () => {
    const h = html(doc([TOTIS, { ...VUALA, linea: 2 }], { total: 128.13, ieps: 9.49 }));
    // Antes: 2 celdas de producto × 2 divs = 4 bloques. Ahora: 0.
    expect((h.match(/<div class="p-/g) ?? []).length).toBe(0);
    expect((h.match(/<td class="p-td">/g) ?? []).length).toBe(2);
  });
});
