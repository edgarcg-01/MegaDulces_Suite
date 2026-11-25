/**
 * `[COT.7.50]` — **Un pedido de la tienda de marca, en la forma de una cotización de la Suite.**
 *
 * Plan: [`FASE_COT7_ANEXO_DOS_ORIGENES_2026-11-25.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_COT7_ANEXO_DOS_ORIGENES_2026-11-25.md).
 *
 * ⭐ **No escribe en Kepler, y ese es el punto.** El camino ya existe y se usa todos los días:
 * telemarketing captura el pedido en línea como cotización con cliente `ONLINE`, y al aceptarla
 * COT.7 escribe el `U-D-40 TELEMARK` solo (45 de 45 con folio desde el 2026-11-12). Acá sólo se
 * arma la cotización; el resto es la puerta que ya corre. *ADR-056: se reusa el primitivo.*
 *
 * Pura a propósito, como `kepler-pedido-tlmk.ts`: ni HTTP ni base. El servicio la llama con el
 * pedido que leyó de la tienda y con la ficha de cada SKU que leyó de la nuestra.
 *
 * ⛔ **Falla cerrada:** un solo renglón que no se puede armar rechaza el pedido entero, con su SKU
 * y su porqué. Escribir media cotización deja un pedido incompleto que parece completo.
 *
 * ⛔ **El precio de la tienda NO manda.** Se cotiza al precio de HOY, igual que `[MCP.34]`: acá se
 * devuelve el de la tienda sólo para poder DECLARAR la diferencia, nunca para copiarlo.
 */

/** Cliente de Kepler contra el que caen los pedidos en línea (`kdud.c2`), medido en las 9 ramas. */
export const CLIENTE_TIENDA = 'ONLINE';

/**
 * Sucursal donde se crea el pedido. **Declarada, no derivada**: la tienda no está atada a una
 * sucursal (`[CV.29]`), y 322 de los 322 documentos `U-D-40 TELEMARK` de `ONLINE` están en `01`.
 */
export const SUCURSAL_TIENDA = '01';

/** De dónde vino, para la nota del pedido. Lo que telemarketing escribe a mano hoy. */
export const MARCA_CANAL = 'PEDIDO PAGINA WEB';

/** Un renglón del pedido, tal como lo da la tienda. */
export interface RenglonTienda {
  sku: string | null;
  cantidad: number;
  /** El rótulo de la presentación que eligió el comprador (`Caja`, `Paquete`, `Pieza`…). */
  presentacion: string | null;
  /** Lo que la tienda cobró por la presentación. Sólo para declarar la diferencia. */
  precio_tienda: number | null;
  nombre: string | null;
}

/** El pedido de la tienda, reducido a lo que importa. */
export interface PedidoTienda {
  /** El número visible del pedido (`11222`), para la nota. */
  numero: string;
  /** `PAID`, `NOT_PAID`, … */
  pago: string;
  /** `APPROVED`, `CANCELED`. */
  estado: string;
  comprador: string | null;
  renglones: RenglonTienda[];
}

/** La ficha del SKU en NUESTRO catálogo, leída por quien llama. */
export interface FichaTienda {
  /** `catalog.products.id`: lo que `commercial.quote_lines.product_id` necesita. */
  product_id: string;
  /** Unidades que el mostrador vende para este SKU: `{ unidad, factor }`. */
  unidades: { unidad: string; factor: number }[];
}

/** El renglón ya armado para `commercial.quote_lines`. */
export interface RenglonCotizado {
  product_id: string;
  sku: string;
  quantity: number;
  /** La unidad de Kepler (`PAQ`, `CJA`, `PZA`…), no el rótulo de la tienda. */
  qty_unit: string;
  /** Qué regla la resolvió. Se guarda para poder recorrerla después. */
  unidad_via: 'nombre' | 'codigo de unidad' | 'unidad unica';
  /** Lo que cobró la tienda. **No es el precio de la cotización**: ése lo pone el motor. */
  precio_tienda: number | null;
}

/** La cotización que hay que crear. */
export interface CotizacionDeTienda {
  cliente: string;
  sucursal: string;
  /** `commercial.quotes.order_notes`, de ahí sale el comentario del pedido en Kepler. */
  notas: string;
  renglones: RenglonCotizado[];
}

/** Un pedido que no se convierte. `motivo` es lo que se le dice a una persona. */
export class NoSeConvierte extends Error {
  constructor(
    readonly motivo: string,
    readonly sku?: string,
  ) {
    super(sku ? `${motivo} (SKU ${sku})` : motivo);
  }
}

const CONOCIDAS: Record<string, string> = {
  Caja: 'CJA',
  Paquete: 'PAQ',
  Pieza: 'PZA',
  Kilo: 'KG',
  Bulto: 'BTO',
};

/**
 * Qué unidad del mostrador es la presentación que eligió el comprador, en tres reglas y en este
 * orden (las mismas de `[CV.30]`, donde se midieron sobre los 1,642 renglones de la tienda):
 *
 *   1. el rótulo conocido (`Caja` → `CJA`);
 *   2. el **código de unidad** del mostrador guardado como rótulo (la tienda lo hizo: `500`, `Cub`);
 *   3. un SKU de **unidad única** → esa unidad, venga el rótulo que venga.
 *
 * Si ninguna aplica, devuelve `null`: **no se adivina**.
 */
export function unidadDePresentacion(
  presentacion: string | null,
  ficha: FichaTienda,
): { unidad: string; factor: number; via: RenglonCotizado['unidad_via'] } | null {
  const rotulo = (presentacion ?? '').trim();
  const conocida = CONOCIDAS[rotulo];
  if (conocida) {
    const u = ficha.unidades.find((x) => x.unidad === conocida);
    if (u) return { ...u, via: 'nombre' };
  }
  if (rotulo) {
    const porCodigo = ficha.unidades.find((x) => x.unidad.toUpperCase() === rotulo.toUpperCase());
    if (porCodigo) return { ...porCodigo, via: 'codigo de unidad' };
  }
  if (ficha.unidades.length === 1) return { ...ficha.unidades[0], via: 'unidad unica' };
  return null;
}

/** La nota del pedido: quién compró y por dónde. Se recorta al límite del comentario de Kepler. */
export function notaDelPedido(pedido: PedidoTienda, largoMaximo: number): string {
  const quien = (pedido.comprador ?? '').replace(/\s+/g, ' ').trim();
  const cola = `${MARCA_CANAL} #${pedido.numero}`;
  if (!quien) return cola.slice(0, largoMaximo);
  const completo = `${quien} ${cola}`;
  if (completo.length <= largoMaximo) return completo;
  // la marca y el número nunca se pierden: se recorta el nombre
  const espacio = largoMaximo - cola.length - 1;
  return espacio > 0 ? `${quien.slice(0, espacio).trim()} ${cola}` : cola.slice(0, largoMaximo);
}

/**
 * Arma la cotización, o explica por qué no se puede.
 *
 * @param fichaDe  devuelve la ficha de un SKU en nuestro catálogo, o `null` si no lo conocemos.
 * @param largoNota  el tope del comentario de Kepler (`LARGO_OBSERVACIONES`).
 */
export function pedidoTiendaACotizacion(
  pedido: PedidoTienda,
  fichaDe: (sku: string) => FichaTienda | null,
  largoNota: number,
): CotizacionDeTienda {
  if (pedido.estado === 'CANCELED') throw new NoSeConvierte('el pedido está cancelado');
  // D2: un pedido sin pagar escrito en el ERP es mercancía que nadie pagó.
  if (pedido.pago !== 'PAID') throw new NoSeConvierte(`el pedido no está pagado (${pedido.pago})`);
  if (!pedido.renglones.length) throw new NoSeConvierte('el pedido no tiene renglones');

  const renglones: RenglonCotizado[] = [];
  for (const r of pedido.renglones) {
    const sku = (r.sku ?? '').trim();
    if (!sku) throw new NoSeConvierte('un renglón de la tienda no trae SKU');
    if (!(Number(r.cantidad) > 0)) throw new NoSeConvierte('cantidad que no es positiva', sku);
    const ficha = fichaDe(sku);
    if (!ficha) throw new NoSeConvierte('el SKU no está en nuestro catálogo', sku);
    if (!ficha.unidades.length) throw new NoSeConvierte('el mostrador no vende este SKU', sku);
    const u = unidadDePresentacion(r.presentacion, ficha);
    if (!u) {
      throw new NoSeConvierte(
        `no se puede saber qué unidad es «${r.presentacion ?? '(sin presentación)'}»`,
        sku,
      );
    }
    renglones.push({
      product_id: ficha.product_id,
      sku,
      quantity: Number(r.cantidad),
      qty_unit: u.unidad,
      unidad_via: u.via,
      precio_tienda: r.precio_tienda == null ? null : Number(r.precio_tienda),
    });
  }

  return {
    cliente: CLIENTE_TIENDA,
    sucursal: SUCURSAL_TIENDA,
    notas: notaDelPedido(pedido, largoNota),
    renglones,
  };
}
