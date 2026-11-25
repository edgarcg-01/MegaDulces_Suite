import { codigoDeBarrasDePedido } from '@megadulces/contracts';
import { anchoBarrasMm, barrasSvg, escHtml, qrSvg } from '@megadulces/ui-web';
import { printIsolated } from '../../shared/util/print-isolated';

/**
 * `[MCP.32]` La **etiqueta del pedido** de preventa: para que quien recoge (el vendedor) sepa de qué pedido es
 * cada bolsa y para quién, sin preguntar. Sale en la **impresora de tickets** de 80 mm (área útil ~72 mm, como
 * `ticket-arqueo.ts`), la misma para el **surtidor** (al terminar en Surtir) y la **cajera** (en Revisión): David,
 * 2026-11-24, «la etiqueta será impresa en la de tickets». Antes el surtidor la mandaba a la TSC (fila de 3 de
 * 32 × 48 mm): en la impresora de tickets esa hoja salía mal, y se retiró.
 *
 * Lleva folio, cliente, vendedor, día de entrega, cuántos productos, un **QR** con el folio y un **código de
 * barras** (`codigoDeBarrasDePedido`: 12 dígitos, cabe en 25 mm). Lo que codifican es SÓLO el folio; el resto va
 * en texto. La lectura es `folioDeLectura` (los dos viven en `libs/contracts/src/http/pedido-etiqueta.ts`).
 *
 * Sólo pedidos de la Suite (`PD-…`); un folio de otra forma sale sin barras (el QR y el texto sí).
 * Colores con palabra (black/white): papel térmico, y no suma a la deuda de hex.
 */
export interface DatosEtiquetaPedido {
  folio: string;
  cliente: string | null;
  vendedor: string | null;
  /** `YYYY-MM-DD` del día de entrega, o `null`. */
  entrega: string | null;
  /** Cuántos productos (renglones) lleva. */
  productos?: number | null;
}

/** Los códigos ya dibujados (SVG en texto). `null` = no se pudo dibujar ese código; la etiqueta sale sin él. */
export interface CodigosEtiqueta {
  qr: string | null;
  barras: string | null;
}

/** ¿Es un pedido de la Suite? Sólo esos llevan esta etiqueta. */
export const esFolioDeSuite = (folio: string | null | undefined): boolean => /^PD-\d{4}-\d+$/i.test(String(folio ?? '').trim());

// Tablas fijas (no `Intl`): el papel debe decir lo mismo en cualquier equipo.
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «vie 21 nov»; lo que no es fecha `YYYY-MM-DD`, vacío (nunca un día inventado). */
export function diaDeEntrega(v: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1) return '';
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
}

const esc = (s: string | null | undefined): string => escHtml(String(s ?? ''));
const productosTexto = (n: number | null | undefined): string =>
  n == null || !(n >= 0) ? '' : `${n} ${n === 1 ? 'producto' : 'productos'}`;

/** El ticket de 80 mm (área útil 72 mm): los mismos datos, en grande. */
export function ticketPedidoHtml(d: DatosEtiquetaPedido, c: CodigosEtiqueta): string {
  const entrega = diaDeEntrega(d.entrega);
  const prods = productosTexto(d.productos);
  return `
      <div class="pt">
        <div class="pt-t">Pedido de preventa</div>
        <div class="pt-folio">${esc(d.folio)}</div>
        <div class="pt-cli">${esc(d.cliente || 'Cliente sin nombre')}</div>
        <div class="pt-dato">Vendedor: ${esc(d.vendedor || 'Sin vendedor')}</div>
        ${entrega ? `<div class="pt-dato">Entrega: ${esc(entrega)}</div>` : ''}
        ${prods ? `<div class="pt-dato">${esc(prods)}</div>` : ''}
        ${c.qr ? `<div class="pt-qr">${c.qr}</div>` : ''}
        ${c.barras ? `${c.barras}<div class="pt-num">${esc(codigoDeBarrasDePedido(d.folio))}</div>` : ''}
      </div>`;
}

export const PAGINA_TICKET_80 = 'size: 80mm auto; margin: 0;';

export const CSS_TICKET_PEDIDO = [
  '.pt{box-sizing:border-box;width:72mm;padding:3mm;background:white;color:black;font-family:Arial,Helvetica,sans-serif;text-align:center}',
  '.pt-t{font-size:3.2mm;text-transform:uppercase;letter-spacing:.3mm}',
  '.pt-folio{font-size:7mm;font-weight:900;line-height:1.15;margin-top:1mm}',
  '.pt-cli{font-size:5mm;font-weight:700;line-height:1.2;margin:1.5mm 0}',
  '.pt-dato{font-size:3.6mm;line-height:1.35}',
  '.pt-qr{display:flex;justify-content:center;margin-top:3mm}',
  '.pt-qr svg{display:block;width:38mm;height:38mm}',
  '.pt-bar{display:block;height:12mm;margin:3mm auto 0}',
  '.pt-num{font-size:3mm;line-height:1.2}',
].join('');

/**
 * El QR del folio como SVG en texto, que escala sin pixelarse. El codificador lo pone con ancho y alto en px:
 * se le da su `viewBox` para que el CSS lo lleve a milímetros sin recortarlo. `null` si no se pudo.
 */
async function qrTexto(folio: string, clase: string): Promise<string | null> {
  const svg = await qrSvg(folio, 160);
  if (!svg) return null;
  const w = parseFloat(svg.getAttribute('width') || '');
  const h = parseFloat(svg.getAttribute('height') || '');
  if (w > 0 && h > 0 && !svg.getAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('aria-label', `Código QR del pedido ${folio}`);
  svg.setAttribute('class', clase);
  return svg.outerHTML;
}

/** Dibuja los dos códigos para el ticket. Las barras, a 1.5× su ancho mínimo: más fáciles de leer con la pistola. */
export async function dibujarCodigos(folio: string): Promise<CodigosEtiqueta> {
  const codigo = codigoDeBarrasDePedido(folio);
  const ancho = codigo ? anchoBarrasMm(codigo) : null;
  const barras = codigo ? barrasSvg(codigo, 'pt-bar', ancho == null ? null : Math.round(ancho * 1.5 * 100) / 100) || null : null;
  return { qr: await qrTexto(folio, 'pt-qrsvg'), barras };
}

/** El ticket de 80 mm: lo imprimen el surtidor (Surtir) y la cajera (Revisión). */
export async function imprimirTicketPedido(d: DatosEtiquetaPedido, onDone?: () => void): Promise<void> {
  const c = await dibujarCodigos(d.folio);
  printIsolated({
    html: ticketPedidoHtml(d, c),
    page: PAGINA_TICKET_80,
    css: CSS_TICKET_PEDIDO,
    bodyClass: 'pedido-ticket-printing',
    fallbackClass: 'pedido-ticket-fallback',
    onDone,
  });
}
