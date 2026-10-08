import JsBarcode from 'jsbarcode';
import type { ChecadoEtiquetaCJ, ChecadoEtiquetaP } from '@megadulces/contracts';
import { printIsolated } from '../../shared/util/print-isolated';

/**
 * `[GP.4]` Etiquetas del checado para la **TSC TE200** (térmica directa, 203 dpi) con rollo de
 * **3 etiquetas por fila**: 100 mm de ancho total, cada etiqueta **32 × 48 mm**, 2 mm entre
 * etiquetas y 2 mm entre filas (Francisco, 2026-10-08).
 *
 * Se imprime desde el navegador con el controlador de Windows de la TSC configurado en papel de
 * **100 × 48 mm**: cada "hoja" que manda el navegador es UNA FILA de 3 etiquetas, y el sensor de la
 * impresora salta los 2 mm entre filas. Mismo mecanismo que el cartel del andén (`printIsolated` +
 * JsBarcode); la Suite no manda TSPL/ZPL directo.
 *
 *  · Caja P: sale al CERRARLA y **por triplicado** (la misma etiqueta 3 veces en la fila): dos lados
 *    de la caja y una para la hoja del pedido (decisión de Francisco: no se desperdicia ni se espera).
 *  · Unidad mayor: al terminar, "1/7 … 7/7" en filas de 3; la última fila puede llevar huecos.
 *
 * Colores con palabra (black/white), no hex: es papel térmico, y así no suma a la deuda de hex.
 */
export interface Etiqueta {
  /** Folio del pedido, arriba. */
  pedido: string;
  destino: string | null;
  /** Lo que se lee de lejos: "3/7" o "P3". */
  grande: string;
  /** Producto (caja) o "12 artículos · 4 productos" (caja P). */
  detalle: string;
  /** Lo que codifica el código de barras (corto, para que quepa en 29 mm). */
  codigo: string;
}

/** Folio sin el prefijo de serie: "UD4001-0002781" → "0002781". */
const folioCorto = (code: string): string => code.split('-').pop() ?? code;

export function etiquetaDeCajaP(e: ChecadoEtiquetaP): Etiqueta {
  return {
    pedido: e.order_code,
    destino: e.destino,
    grande: `P${e.numero}`,
    detalle: `${e.articulos} ${e.articulos === 1 ? 'artículo' : 'artículos'} · ${e.productos} ${e.productos === 1 ? 'producto' : 'productos'}`,
    codigo: `${folioCorto(e.order_code)}P${e.numero}`,
  };
}

export function etiquetaDeCaja(e: ChecadoEtiquetaCJ, orderCode: string, destino: string | null): Etiqueta {
  return {
    pedido: orderCode,
    destino,
    grande: `${e.n}/${e.total}`,
    detalle: e.producto ?? e.sku ?? '',
    codigo: `${folioCorto(orderCode)}C${e.n}`,
  };
}

/** En filas de 3, que es como sale el rollo. La última fila puede ir incompleta. */
export function enFilas<T>(xs: T[], porFila = 3): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += porFila) out.push(xs.slice(i, i + porFila));
  return out;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** El código de barras como SVG en texto (para el documento aislado de impresión). */
function barras(codigo: string): string {
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svg, codigo, { format: 'CODE128', displayValue: false, width: 2, height: 60, margin: 0 });
    const w = parseFloat(svg.getAttribute('width') || '');
    const h = parseFloat(svg.getAttribute('height') || '');
    // Sin el viewBox numérico se ve bien en pantalla y sale cortado al imprimir (lección del andén).
    if (w > 0 && h > 0) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    }
    svg.setAttribute('class', 'et-bar');
    return svg.outerHTML;
  } catch {
    return ''; // un código que CODE128 no representa sale sin barras; la etiqueta igual se lee
  }
}

export function etiquetasHtml(etiquetas: Etiqueta[]): string {
  return enFilas(etiquetas)
    .map((fila) => {
      const celdas = fila
        .map((e) => `
          <div class="et">
            <div class="et-pedido">${esc(e.pedido)}</div>
            <div class="et-destino">${esc(e.destino ?? '')}</div>
            <div class="et-grande">${esc(e.grande)}</div>
            <div class="et-detalle">${esc(e.detalle)}</div>
            ${barras(e.codigo)}
            <div class="et-codigo">${esc(e.codigo)}</div>
          </div>`)
        .join('');
      return `<div class="et-fila">${celdas}</div>`;
    })
    .join('');
}

const CSS = [
  'body{margin:0}',
  '.et-fila{display:flex;gap:2mm;width:100mm;height:48mm;box-sizing:border-box;break-after:page;page-break-after:always;overflow:hidden}',
  '.et-fila:last-child{break-after:auto;page-break-after:auto}',
  '.et{box-sizing:border-box;width:32mm;height:48mm;padding:1.5mm;display:flex;flex-direction:column;align-items:stretch;',
  'background:white;color:black;font-family:Arial,Helvetica,sans-serif;overflow:hidden}',
  '.et-pedido{font-size:2.6mm;font-weight:700;line-height:1.1;white-space:nowrap;overflow:hidden}',
  '.et-destino{font-size:2.3mm;line-height:1.1;max-height:5mm;overflow:hidden}',
  '.et-grande{font-size:11mm;font-weight:900;line-height:1;text-align:center;margin:auto 0}',
  '.et-detalle{font-size:2.3mm;line-height:1.1;max-height:7.5mm;overflow:hidden;text-align:center}',
  '.et-bar{display:block;width:29mm;height:7mm;margin-top:1mm}',
  '.et-codigo{font-size:2mm;text-align:center;line-height:1.1}',
].join('');

/** Manda las etiquetas a la etiquetera. `onDone` se llama al terminar (imprimió o canceló). */
export function imprimirEtiquetas(etiquetas: Etiqueta[], onDone?: () => void): void {
  if (!etiquetas.length) {
    onDone?.();
    return;
  }
  printIsolated({
    html: etiquetasHtml(etiquetas),
    page: 'size: 100mm 48mm; margin: 0;',
    css: CSS,
    bodyClass: 'checado-etiquetas-printing',
    fallbackClass: 'checado-etiquetas-fallback',
    onDone,
  });
}
