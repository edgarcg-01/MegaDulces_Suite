import JsBarcode from 'jsbarcode';

/**
 * `[RE.ETQ.1.1]` La etiquetera: lo que comparten todas las etiquetas que la Suite manda a la **TSC TE200**
 * (térmica directa, 203 dpi) con rollo de **3 etiquetas por fila**, 100 mm de ancho total, cada etiqueta de
 * 32 × 48 mm con 2 mm entre etiquetas (medido por Francisco el 2026-10-08 para GP.4).
 *
 * Nació dentro de GP.4 (`apps/view/.../almacen/checado-etiquetas.ts`). Al llegar el segundo consumidor (la
 * etiqueta de caja de la orden de entrada, Fase RE) sube a `libs/` (ADR-056): un primitivo copiado diverge.
 * GP.4 la consume sin cambiar un carácter de su salida (candado en `checado-etiquetas.spec.ts`).
 *
 * El navegador manda cada FILA como una hoja de 100 × 48 mm con el controlador de Windows (vía A). La vía B
 * (TSPL directo) está en `tspl.ts`.
 */

/** La hoja que el navegador manda a la TSC: UNA fila de 3 etiquetas. */
export const PAGINA_TSC_3X = 'size: 100mm 48mm; margin: 0;';

/**
 * El CSS de la fila. 47.6 y no 48: con la fila exacta a la hoja, el redondeo del navegador mete una hoja en
 * blanco, que en la etiquetera es una fila de 3 etiquetas tirada.
 */
export const CSS_FILA_TSC_3X = [
  'body{margin:0}',
  '.et-fila{display:flex;gap:2mm;width:100mm;height:47.6mm;box-sizing:border-box;break-after:page;page-break-after:always;overflow:hidden}',
  '.et-fila:last-child{break-after:auto;page-break-after:auto}',
].join('');

/** Un módulo de código de barras a 2 puntos de 203 dpi: 0.25 mm. Menos que eso, el lector falla. */
export const MM_POR_MODULO = 0.25;

/** En filas de 3, que es como sale el rollo. La última fila puede ir incompleta. */
export function enFilas<T>(xs: readonly T[], porFila = 3): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += porFila) out.push(xs.slice(i, i + porFila));
  return out;
}

/** Escape para texto dentro del HTML aislado de impresión. */
export const escHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** El formato CODE128 que usa la etiquetera: el juego C (compacto) si son sólo dígitos en número par. */
export const formatoCode128 = (codigo: string): 'CODE128C' | 'CODE128' =>
  /^(\d\d)+$/.test(codigo) ? 'CODE128C' : 'CODE128';

/** Cuántos módulos ocupa el código (incluye inicio, control y fin). `null` si CODE128 no lo representa. */
export function modulosCode128(codigo: string): number | null {
  try {
    const d: { encodings?: Array<{ data: string }> } = {};
    JsBarcode(d, codigo, { format: formatoCode128(codigo) });
    const n = (d.encodings ?? []).reduce((s, e) => s + e.data.length, 0);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** El ancho de la barra a 2 puntos por módulo. `null` si no se puede representar. */
export function anchoBarrasMm(codigo: string): number | null {
  const n = modulosCode128(codigo);
  return n == null ? null : Math.round(n * MM_POR_MODULO * 100) / 100;
}

/**
 * El código de barras como SVG en texto, para el documento aislado de impresión. Con `anchoMm`, el SVG sale con
 * ese ancho fijo (la etiqueta de caja: 2 puntos por módulo); sin él, el ancho lo pone el CSS de quien llama
 * (GP.4). Un código que CODE128 no representa sale sin barras: la etiqueta igual se lee por su texto.
 */
export function barrasSvg(codigo: string, clase = 'et-bar', anchoMm?: number | null): string {
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svg, codigo, { format: formatoCode128(codigo), displayValue: false, width: 2, height: 60, margin: 0 });
    const w = parseFloat(svg.getAttribute('width') || '');
    const h = parseFloat(svg.getAttribute('height') || '');
    // Sin el viewBox numérico se ve bien en pantalla y sale cortado al imprimir (lección del andén).
    if (w > 0 && h > 0) {
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    }
    svg.setAttribute('class', clase);
    if (anchoMm != null && anchoMm > 0) {
      // JsBarcode deja su propio `style` (transform): se conserva y se le agrega el ancho.
      const previo = (svg.getAttribute('style') ?? '').trim().replace(/;?$/, '');
      svg.setAttribute('style', `${previo ? `${previo};` : ''}width:${anchoMm}mm`);
    }
    return svg.outerHTML;
  } catch {
    return '';
  }
}

/** Las etiquetas en filas de 3, cada una dibujada por `celda`. */
export function filasHtml<T>(xs: readonly T[], celda: (x: T) => string): string {
  return enFilas(xs)
    .map((fila) => `<div class="et-fila">${fila.map(celda).join('')}</div>`)
    .join('');
}
