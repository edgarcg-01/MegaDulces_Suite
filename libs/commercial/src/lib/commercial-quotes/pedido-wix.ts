import { MARCA_CANAL, type PedidoTienda, type RenglonTienda } from './pedido-tienda-a-cotizacion';

/**
 * `[COT.7.50]` — **Traduce el pedido de Wix a `PedidoTienda`, y nada más.**
 *
 * Pieza pura: no toca la red, ni la base, ni el ERP. La forma de la que parte **no se dedujo del
 * manual de Wix: se midió** contra la tienda viva el 2026-11-26, sobre los 1,228 pedidos reales.
 * Lo que se midió, y que manda sobre cualquier suposición:
 *
 * | Dónde vive el dato                                      | Medido |
 * |---------------------------------------------------------|--------|
 * | `lineItems[].physicalProperties.sku`                      | 2,491 de 2,491 renglones lo traen |
 * | `catalogReference.options.options['Presentación']`        | la presentación, cuando existe |
 * | `descriptionLines[]` con `name.original = 'Presentación'` | segundo testigo del mismo rótulo |
 * | `recipientInfo.contactDetails.{firstName,lastName}`       | 21 de 21 pedidos vivos |
 * | `number`, `status`, `paymentStatus`                       | `'11229'`, `'APPROVED'`, `'PAID'` |
 *
 * ⛔⛔ **Por qué NO hay regla de «la única opción».** Era la regla obvia, y medirla la mató: de las
 * 308 opciones únicas que llevan los pedidos, **209 eran SABORES** —`CHAMOY`, `MANGO`, `FRESA`,
 * `MENTA`— y no presentaciones. Tomarlas como presentación habría mandado un rótulo inventado al
 * resolvedor de unidades, que con un SKU de unidad única lo habría aceptado **por el motivo
 * equivocado**. Acá la presentación sale sólo de un campo que se llama *Presentación*; si no está,
 * se devuelve `null` y es `unidadDePresentacion` quien decide (y rechaza si no puede).
 *
 * ⚠️ **Lo que este mapeo NO arregla, medido el mismo día:** de los 277 pedidos pagados históricos,
 * sólo 13 entran solos. Pero el corte es de FECHA, no de catálogo: **antes de 2026-09 ningún
 * renglón traía presentación; desde 2026-09 la trae el 97–100 %**, y 9 de 12 pedidos pagados de esa
 * ventana entran enteros. Lo que frena a los otros 3 son variantes que `[CV.30]` marcó OCULTAR o
 * RETIRAR y que **siguen a la venta**: eso se arregla en la tienda, no acá.
 */

/** El nombre de la opción de Wix que lleva la presentación, normalizado. */
const OPCION_PRESENTACION = 'presentacion';

/** Sin acentos, sin mayúsculas, sin espacios de sobra: `Presentación` y `presentacion` son la misma. */
const norm = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

/** El pedido de Wix, reducido a los campos que este mapeo lee. El resto se ignora a propósito. */
export interface PedidoWix {
  number?: string | number | null;
  status?: string | null;
  paymentStatus?: string | null;
  lineItems?: RenglonWix[] | null;
  recipientInfo?: ContactoWix | null;
  billingInfo?: ContactoWix | null;
}

interface ContactoWix {
  contactDetails?: { firstName?: string | null; lastName?: string | null } | null;
}

interface RenglonWix {
  quantity?: number | string | null;
  physicalProperties?: { sku?: string | null } | null;
  productName?: { original?: string | null } | null;
  price?: { amount?: string | number | null } | null;
  catalogReference?: { options?: { options?: Record<string, unknown> | null } | null } | null;
  descriptionLines?: {
    name?: { original?: string | null } | null;
    plainText?: { original?: string | null } | null;
  }[] | null;
}

/**
 * La presentación que eligió el comprador, o `null`.
 *
 * Dos lugares, en orden, y **los dos exigen que el campo se llame «Presentación»**:
 *   1. `catalogReference.options.options` — la opción de la variante (lo que el carrito guardó);
 *   2. `descriptionLines` — el mismo rótulo, como se le muestra al comprador.
 */
export function presentacionDeRenglon(renglon: RenglonWix): string | null {
  const opciones = renglon?.catalogReference?.options?.options;
  if (opciones && typeof opciones === 'object') {
    const par = Object.entries(opciones).find(([clave]) => norm(clave) === OPCION_PRESENTACION);
    if (par && String(par[1]).trim()) return String(par[1]).trim();
  }
  const lineas = Array.isArray(renglon?.descriptionLines) ? renglon.descriptionLines : [];
  const linea = lineas.find((l) => norm(l?.name?.original) === OPCION_PRESENTACION);
  const texto = (linea?.plainText?.original ?? '').trim();
  return texto || null;
}

/** Quién compró: para la nota del pedido en Kepler, que es por donde telemarketing lo ubica. */
export function compradorDe(pedido: PedidoWix): string | null {
  for (const bloque of [pedido?.recipientInfo, pedido?.billingInfo]) {
    const c = bloque?.contactDetails;
    const nombre = `${(c?.firstName ?? '').trim()} ${(c?.lastName ?? '').trim()}`.trim();
    if (nombre) return nombre;
  }
  return null;
}

/**
 * El pedido de Wix como `PedidoTienda`. **No decide si entra**: eso es `pedidoTiendaACotizacion`,
 * que ya sabe rechazar un pedido cancelado, sin pagar, sin renglones o con una unidad que no
 * resuelve. Acá sólo se traduce, y lo que no viene se deja en `null` en vez de rellenarse.
 */
export function pedidoWixAPedidoTienda(pedido: PedidoWix): PedidoTienda {
  const renglones: RenglonTienda[] = (Array.isArray(pedido?.lineItems) ? pedido.lineItems : []).map(
    (r) => ({
      sku: (r?.physicalProperties?.sku ?? '').toString().trim() || null,
      cantidad: Number(r?.quantity ?? 0),
      presentacion: presentacionDeRenglon(r),
      precio_tienda: r?.price?.amount == null ? null : Number(r.price.amount),
      nombre: (r?.productName?.original ?? '').toString().trim() || null,
    }),
  );
  return {
    numero: String(pedido?.number ?? '').trim(),
    // Wix no manda `paymentStatus` cuando el pedido nace sin pago: que falte NO es que esté pagado.
    pago: (pedido?.paymentStatus ?? 'DESCONOCIDO').toString().trim() || 'DESCONOCIDO',
    estado: (pedido?.status ?? 'DESCONOCIDO').toString().trim() || 'DESCONOCIDO',
    comprador: compradorDe(pedido),
    renglones,
  };
}

/** Lo que el webhook contesta. Se exporta para que la prueba de arranque lea la misma forma. */
export interface RespuestaWebhookTienda {
  recibido: true;
  numero: string;
  estado: 'creado' | 'ya_estaba' | 'rechazado';
  motivo?: string;
  quote_code?: string;
  kepler_folio?: string;
}

/** La marca del canal, re-exportada para que el controlador no importe dos módulos por un texto. */
export { MARCA_CANAL };
