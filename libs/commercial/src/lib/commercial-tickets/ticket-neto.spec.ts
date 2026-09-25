import { CommercialTicketsService, TicketDetalle } from './commercial-tickets.service';

/**
 * `[TK.10]` La aritmética de los dos NETOS, donde se calcula: `armar()`.
 *
 * «Neto» = precio SIN IMPUESTOS. El precio de Kepler ya lo trae adentro (medido en el propio
 * servicio: Σ renglones = total en 99.84%), así que el neto se DESCOMPONE con la misma cascada
 * fiscal que ya se usa para el IVA y el IEPS — no con una segunda fórmula.
 *
 * Lo que se fija acá:
 *
 *  1. **El neto por unidad sale del precio que está al lado**, sin el factor de prorrateo del
 *     descuento del documento. Si se le aplicara, la columna no reconciliaría con su vecina y el
 *     papel diría dos precios distintos para el mismo renglón. El prorrateo es aritmética de
 *     DOCUMENTO y vive en `importe_neto`.
 *  2. **Sin cuadre del impuesto, los tres campos son `null`.** Un neto que no reconstruye el
 *     total es peor que no tenerlo (ADR-056).
 *  3. **`null` con dos motivos distintos**: sin cuadre no se puede publicar; sin precio de lista
 *     no hay «antes de descuento». Nunca se rellena con el pagado — eso diría «no hubo
 *     descuento» donde lo cierto es «no se sabe».
 *  4. **El total cierra**: `importe_neto + IEPS + IVA = total`.
 *
 * `armar()` es privado y PURO (no toca la base), así que se llama por cast. Es la única forma de
 * probar esta aritmética sin levantar Postgres, y es aritmética de dinero.
 */

type Fila = Record<string, unknown>;

interface Cabecera {
  total: number; iva: number | null; ieps: number | null; impuestos_incluidos: boolean;
}

const svc = new CommercialTicketsService({} as never, {} as never, {} as never, {} as never);

const armar = (h: Partial<Cabecera>, raw: Fila[]): TicketDetalle =>
  (svc as unknown as { armar(h: unknown, raw: Fila[]): TicketDetalle }).armar({
    id: '05UD1005-0006440', origen: 'mostrador', doc_label: null,
    sucursal: '05', sucursal_nombre: 'Zamora Centro', caja: 5,
    folio: '0006440', fecha: '2026-09-18',
    cliente_nombre: null, cliente_rfc: null, atendio: null, atendio_rol: null,
    descuento_pct_erp: null,
    total: 60, iva: 8.28, ieps: null, impuestos_incluidos: true, ...h,
  }, raw);

/** Una paleta: lista 6.00, pagada 5.00, 12 piezas, IVA 16%. */
const PALETA: Fila = {
  linea: 1, sku: '900', descripcion: 'PALETA PAYASO CHICO 20G', unidad: 'PZA',
  cantidad: 12, precio_unitario: 5, precio_lista: 6, importe: 60,
  iva_tasa: 0.16, ieps_tasa: 0,
};

describe('TK.10 · el neto por renglón', () => {
  it('descompone los dos precios con la tasa del renglón', () => {
    const d = armar({}, [PALETA]);
    // 6.00/1.16 = 5.172... → 5.17 · 5.00/1.16 = 4.310... → 4.31
    expect(d.lineas[0].precio_neto).toBe(5.17);
    expect(d.lineas[0].precio_neto_desc).toBe(4.31);
  });

  it('el importe neto cierra contra el total: neto + IVA = total', () => {
    const d = armar({}, [PALETA]);
    const c = d.cascada;
    expect(c.importe_neto).not.toBeNull();
    const suma = Math.round(((c.importe_neto as number) + c.iva_lineas + c.ieps_lineas) * 100) / 100;
    expect(suma).toBe(c.total);
  });

  /**
   * ⛔ El candado que evita publicar una columna que no suma. Se fuerza un descuadre poniendo en
   * la cabecera un IVA que los renglones no pueden reproducir.
   */
  it('sin cuadre del impuesto, los tres campos quedan en null', () => {
    const d = armar({ iva: 999 }, [PALETA]);
    expect(d.cascada.impuesto_desglosado).toBe(false);
    expect(d.cascada.importe_neto).toBeNull();
    expect(d.lineas[0].precio_neto).toBeNull();
    expect(d.lineas[0].precio_neto_desc).toBeNull();
  });

  it('sin precio de lista, el neto de ANTES es null y el de DESPUÉS no', () => {
    const d = armar({ iva: 8.28 }, [{ ...PALETA, precio_lista: null }]);
    expect(d.lineas[0].lista_conocida).toBe(false);
    expect(d.lineas[0].precio_neto).toBeNull();
    expect(d.lineas[0].precio_neto_desc).toBe(4.31);
  });

  /**
   * ⚠️ El defecto que esta prueba impide: derivar el neto del importe YA prorrateado. Con un
   * descuento de documento, ese camino da 4.13 y la columna de al lado sigue diciendo 5.00 —
   * dos precios distintos para el mismo renglón en el mismo papel.
   */
  it('el neto por unidad NO lleva el prorrateo del descuento del documento', () => {
    // Total 57.50 contra 60.00 de renglones: hay descuento de documento.
    const d = armar({ total: 57.5, iva: 7.93 }, [PALETA]);
    expect(d.cascada.descuento_documento).toBe(2.5);
    // Sigue saliendo del precio impreso (5.00), no del importe prorrateado.
    expect(d.lineas[0].precio_neto_desc).toBe(4.31);
  });

  it('en un pedido propio el precio ya es neto: el neto es el precio', () => {
    const d = armar(
      { impuestos_incluidos: false, total: 60, iva: 9.6 },
      [{ ...PALETA, precio_lista: 6, precio_unitario: 5, importe: 60 }],
    );
    // Sin impuesto adentro el divisor es 1: cada neto ES su propio precio.
    expect(d.lineas[0].precio_neto).toBe(6);
    expect(d.lineas[0].precio_neto_desc).toBe(5);
    expect(d.cascada.importe_neto).toBe(60);
  });

  it('IEPS en vez de IVA: la cascada usa la tasa que trae el renglón', () => {
    const d = armar(
      { iva: null, ieps: 4.44, total: 60 },
      [{ ...PALETA, iva_tasa: 0, ieps_tasa: 0.08 }],
    );
    // 6.00/1.08 = 5.555... → 5.56 · 5.00/1.08 = 4.629... → 4.63
    expect(d.lineas[0].precio_neto).toBe(5.56);
    expect(d.lineas[0].precio_neto_desc).toBe(4.63);
  });
});
