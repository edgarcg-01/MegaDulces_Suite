/**
 * `[MCP.32]` / `[MCP.33]` El código que identifica un PEDIDO de la Suite (`PD-2026-00012`) en su etiqueta,
 * y cómo se lee de vuelta. Lo comparten quien imprime (Surtir y Revisión, en `apps/view`) y quien lee
 * (el lector del vendedor en `apps/vendor` y las listas de la Suite). Sin Angular ni base: se prueba solo.
 *
 * - **QR:** `[MCP.36]` la LIGA del pedido, `https://<suite>/pedido/PD-2026-00012?k=<firma>` (`ligaDePedido`):
 *   la cámara de cualquier celular la abre y muestra el pedido, con o sin usuario (David, 2026-11-25, aprobado
 *   por Edgar: «para todos sin excepciones», con montos). La autoridad es la firma `k`, que vence; sin ella no se
 *   ve nada. El folio va a la vista en la liga para que los lectores de la Suite lo sigan sacando. Si al
 *   imprimir no se pudo firmar, el QR lleva el folio solo (como las etiquetas impresas antes del MCP.36).
 * - **Código de barras:** 12 DÍGITOS `99` + año + número a 6 (`992026000012`). Sólo dígitos y longitud par
 *   para que CODE128 use su juego compacto C (~101 módulos ≈ 25 mm a 0.25 mm/módulo): así cabe en la
 *   etiqueta TSC de 32 mm, igual que las del checado (`checado-etiquetas.ts`). El folio completo
 *   (`PD-2026-00012`, juego B) mediría ~44 mm y no cabe. El `99` lo separa de las etiquetas del checado
 *   (empiezan con el folio de Kepler a 7 dígitos, `000…`) y de un EAN-13 (13 dígitos).
 */

const FOLIO = /^PD-(\d{4})-(\d{1,6})$/;
/**
 * Lo que manda un lector: el folio con cualquier separador (un lector de mano con la distribución de teclado
 * en español escribe `'` en lugar de `-`) o los 12 dígitos del código de barras.
 */
const LEIDO_FOLIO = /^PD[^0-9A-Z]?(\d{4})[^0-9A-Z]?(\d{1,6})$/;
const LEIDO_BARRAS = /^99(\d{4})(\d{6})$/;
/**
 * `[MCP.36]` La liga del QR (`…/pedido/PD-2026-00012?k=…`). El folio se busca justo después del segmento
 * `pedido`, con cualquier separador: la pistola con el teclado en español no escribe `/` ni `-` como tales.
 * Anclado a `pedido` a propósito: la firma `k` también trae letras y números, y nunca se lee de ahí.
 */
const LEIDO_LIGA = /PEDIDO[^0-9A-Z]{1,3}PD[^0-9A-Z]?(\d{4})[^0-9A-Z]?(\d{1,6})(?![0-9])/;

/** `[MCP.36]` El primer segmento de la pantalla pública del pedido (`/pedido/:folio`). */
export const RUTA_PEDIDO_PUBLICO = 'pedido';

/**
 * `[MCP.36]` La liga que va en el QR. `origen` es el de la Suite que imprime (`https://megadulcessuite.com`):
 * la etiqueta apunta a la misma Suite que la firmó. Sin firma o con un folio que no es de la Suite, `null`.
 */
export function ligaDePedido(origen: string | null | undefined, folio: string | null | undefined, k: string | null | undefined): string | null {
  const f = String(folio ?? '').trim().toUpperCase();
  const o = String(origen ?? '').trim().replace(/\/+$/, '');
  const firma = String(k ?? '').trim();
  if (!FOLIO.test(f) || !/^https?:\/\/[^/\s]+$/i.test(o) || !firma) return null;
  return `${o}/${RUTA_PEDIDO_PUBLICO}/${f}?k=${encodeURIComponent(firma)}`;
}

/** `[MCP.36]` La firma de la etiqueta que da la API a quien imprime (Surtir y Revisión). */
export interface FirmaEtiquetaPedido {
  folio: string;
  k: string;
  /**
   * La liga completa para el QR. La arma el SERVIDOR con el dominio público de la Suite (`origenPublicoParaEnlace`):
   * quien imprime puede estar en la IP de la oficina, que desde el celular de un cliente no abre.
   */
  liga: string;
  /** ISO: hasta cuándo abre la liga. */
  vence: string;
}

/** `[MCP.36]` En qué paso va el pedido, en palabras de la gente. `desconocido` = un estado que esta regla no conoce. */
export type PasoPedidoClave =
  | 'por_confirmar' | 'por_surtir' | 'surtiendo' | 'surtido' | 'sin_mercancia' | 'revisado' | 'entregado' | 'cancelado' | 'desconocido';

export interface PasoPedido { clave: PasoPedidoClave; texto: string }

/**
 * `[MCP.36]` El paso del pedido a partir de su estado y de su surtido (`commercial.presale_picks`). Lo que no
 * se conoce se DICE (`desconocido`, con el estado tal cual), nunca se pinta como otro paso.
 */
export function pasoDelPedido(p: {
  status: string | null | undefined;
  /** `null` = nadie lo ha empezado a surtir. */
  pick_started_at?: string | Date | null;
  pick_finished_at?: string | Date | null;
  pick_outcome?: string | null;
  reviewed_at?: string | Date | null;
}): PasoPedido {
  const s = String(p.status ?? '');
  if (s === 'cancelled') return { clave: 'cancelado', texto: 'Cancelado' };
  if (s === 'fulfilled') return { clave: 'entregado', texto: 'Entregado' };
  if (s === 'draft' || s === 'pending_approval') return { clave: 'por_confirmar', texto: 'Por confirmar' };
  if (s !== 'confirmed') return { clave: 'desconocido', texto: s ? `Estado «${s}»` : 'Estado sin dato' };
  if (!p.pick_started_at) return { clave: 'por_surtir', texto: 'En espera de surtirse' };
  if (!p.pick_finished_at) return { clave: 'surtiendo', texto: 'Surtiéndose' };
  if (p.pick_outcome === 'sin_mercancia') return { clave: 'sin_mercancia', texto: 'No hubo mercancía' };
  const faltantes = p.pick_outcome === 'con_faltantes' ? ', con faltantes' : '';
  if (p.reviewed_at) return { clave: 'revisado', texto: `Revisado, listo para entregar${faltantes}` };
  return { clave: 'surtido', texto: `Surtido${faltantes}` };
}

/** `[MCP.36]` Un renglón del pedido tal como lo ve quien abre la liga. Dinero en número (pesos). */
export interface RenglonPedidoPublico {
  producto: string;
  sku: string | null;
  cantidad: number;
  unidad: string | null;
  precio: number | null;
  importe: number | null;
}

/** `[MCP.36]` El pedido que muestra la liga de la etiqueta (`GET /api/commercial/pedido-etiqueta/:folio?k=`). */
export interface PedidoPublico {
  folio: string;
  paso: PasoPedido;
  cliente: string | null;
  vendedor: string | null;
  sucursal: string | null;
  /** `YYYY-MM-DD` o `null`. */
  entrega: string | null;
  /** ISO de cuando se levantó. */
  creado: string | null;
  renglones: RenglonPedidoPublico[];
  subtotal: number | null;
  descuento: number | null;
  impuestos: number | null;
  total: number | null;
  moneda: string | null;
  /** ISO: hasta cuándo abre esta liga. */
  liga_vence: string | null;
}

/** Los 12 dígitos del código de barras del pedido, o `null` si el folio no tiene la forma de la Suite. */
export function codigoDeBarrasDePedido(folio: string | null | undefined): string | null {
  const m = FOLIO.exec(String(folio ?? '').trim().toUpperCase());
  if (!m) return null;
  return `99${m[1]}${m[2].padStart(6, '0')}`;
}

/**
 * El folio (`PD-2026-00012`) de lo que se leyó en una etiqueta de pedido, o `null` si no es una.
 * Acepta el QR, el código de barras y el folio tecleado a mano.
 */
export function folioDeLectura(texto: string | null | undefined): string | null {
  const t = String(texto ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!t) return null;
  const m = LEIDO_FOLIO.exec(t) ?? LEIDO_BARRAS.exec(t) ?? LEIDO_LIGA.exec(t);
  if (!m) return null;
  const numero = Number(m[2]);
  if (!Number.isInteger(numero) || numero <= 0) return null;
  return `PD-${m[1]}-${String(numero).padStart(5, '0')}`;
}
