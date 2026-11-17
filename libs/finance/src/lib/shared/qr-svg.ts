import { BarcodeFormat, EncodeHintType, QRCodeWriter } from '@zxing/library';

/**
 * `[CC.20]` Un código QR como SVG en línea, para los PDF que se arman con HTML (`chromium-pdf`). Usa el codificador de
 * `@zxing/library`, que ya es dependencia del monorepo (la app lo usa para LEER códigos): no hace falta otra librería.
 *
 * Un solo `<path>` con un cuadro por módulo: nítido a cualquier tamaño y se imprime bien. Corrección de errores M
 * (la que zxing usa por omisión): aguanta una mancha o un doblez del papel.
 */
export function qrSvg(texto: string, ladoPx = 140): string {
  const hints = new Map<EncodeHintType, unknown>();
  hints.set(EncodeHintType.MARGIN, 2);
  const m = new QRCodeWriter().encode(texto, BarcodeFormat.QR_CODE, 0, 0, hints as never);
  const w = m.getWidth(); const h = m.getHeight();
  let d = '';
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m.get(x, y)) d += `M${x} ${y}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ladoPx}" height="${ladoPx}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" role="img" aria-label="Código QR">`
    + `<rect width="${w}" height="${h}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
