import type { CamposDelCheque, PlantillaCheque, ZonaCheque } from '@megadulces/contracts';
// ⛔ Sólo tipos: este módulo no carga nada en tiempo de ejecución (lo usa también un script de verificación fuera de Nest).

/**
 * `[PGP.165]` **El cheque, dibujado en milímetros.** Lo arma el servidor y lo pasa a PDF del tamaño exacto del cheque
 * (puppeteer, igual que el Preliminar): un PDF del tamaño del papel de SU banco (BanBajío 160 × 70 mm, Santander
 * 162.3 × 72.1) se imprime a escala real con más fidelidad que una regla `@page` del navegador, que cada impresora
 * interpreta a su manera.
 *
 * Es SVG porque `<text y>` pone la **línea base** exactamente donde se le dice (en un `<div>` la base depende de la
 * fuente), y el `viewBox` hace que 1 unidad sea 1 mm.
 *
 * ── Cuando un dato no cabe ─────────────────────────────────────────────────────────────────
 * Se mide en el navegador que imprime (con la fuente que de verdad tiene), y en este orden: se achica la letra hasta
 * su mínimo; la cantidad con letra se parte en dos renglones; si aun así no cabe, se comprime el ancho de las letras.
 * ⛔ **Nunca se corta**: un beneficiario o una cantidad con letra incompletos son un cheque rechazado.
 */

export interface OpcionesCheque {
  /** Corrimiento de la impresora, en mm (positivo = a la derecha / hacia abajo). Se acota a ±`DESPLAZAMIENTO_MAX_MM`. */
  dx?: number;
  dy?: number;
}

/** Más de 1.5 cm de corrimiento no es calibración: es el cheque mal metido. */
export const DESPLAZAMIENTO_MAX_MM = 15;

const FUENTE = `Arial, 'Liberation Sans', 'DejaVu Sans', Helvetica, sans-serif`;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

/** Un número de mm para un atributo: sin notación científica ni 15 decimales. */
function mm(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** mm → cm a un decimal, para una persona con regla: 160 → «16», 162.3 → «16.2». */
function cm(n: number): string {
  return String(Math.round(n) / 10);
}

/** El corrimiento acotado. Un valor que no es número cuenta como 0, no como error: es un parámetro de la URL. */
export function desplazamiento(o: OpcionesCheque | undefined): { dx: number; dy: number } {
  const acota = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-DESPLAZAMIENTO_MAX_MM, Math.min(DESPLAZAMIENTO_MAX_MM, n)) : 0;
  };
  return { dx: acota(o?.dx), dy: acota(o?.dy) };
}

function textoEnZona(z: ZonaCheque, texto: string, clase: string): string {
  const x = z.alinear === 'izquierda' ? z.x : z.alinear === 'centro' ? z.x + z.ancho / 2 : z.x + z.ancho;
  const anchor = z.alinear === 'izquierda' ? 'start' : z.alinear === 'centro' ? 'middle' : 'end';
  return `<text class="fit ${clase}" x="${mm(x)}" y="${mm(z.base)}" font-size="${mm(z.letraMax)}" text-anchor="${anchor}"`
    + ` data-ancho="${mm(z.ancho)}" data-max="${mm(z.letraMax)}" data-min="${mm(z.letraMin)}" data-renglones="${z.renglones}"`
    + ` data-interlinea="${mm(z.interlinea)}" data-max2="${mm(z.letraDosRenglones)}">${esc(texto)}</text>`;
}

/**
 * El SVG del cheque: SÓLO los datos (el papel ya trae todo lo demás). Con `guias`, además el contorno punteado del
 * cheque, sus líneas impresas en gris y las zonas que nunca se tapan — para la hoja de prueba.
 */
export function chequeSvg(pl: PlantillaCheque, c: CamposDelCheque, o?: OpcionesCheque & { guias?: boolean }): string {
  const { dx, dy } = desplazamiento(o);
  const z = pl.zonas;
  const datos = [
    textoEnZona(z.fecha, c.fecha, 'ch-fecha'),
    textoEnZona(z.beneficiario, c.beneficiario, 'ch-benef'),
    textoEnZona(z.importe, c.importe, 'ch-importe'),
    textoEnZona(z.letra, c.letra, 'ch-letra'),
    c.leyenda ? textoEnZona(z.leyenda, c.leyenda, 'ch-leyenda') : '',
  ].join('');
  const guias = o?.guias
    ? `<g class="ch-guias" fill="none" stroke="#9a9a9a" stroke-width="0.2">`
      // El contorno, medio trazo adentro: sobre el borde exacto del SVG la mitad se recorta y a la derecha no se veía.
      + `<rect x="0.15" y="0.15" width="${mm(pl.anchoMm - 0.3)}" height="${mm(pl.altoMm - 0.3)}" stroke="#000" stroke-width="0.25" stroke-dasharray="1.5 1"/>`
      + pl.guias.map((g) => `<line x1="${mm(g.x1)}" y1="${mm(g.y)}" x2="${mm(g.x2)}" y2="${mm(g.y)}"/>`).join('')
      + `<rect x="${mm(pl.cajaImporte.x)}" y="${mm(pl.cajaImporte.y)}" width="${mm(pl.cajaImporte.ancho)}" height="${mm(pl.cajaImporte.alto)}"/>`
      + pl.reservadas.map((r) => `<rect x="${mm(r.x)}" y="${mm(r.y)}" width="${mm(r.ancho)}" height="${mm(r.alto)}" stroke-dasharray="0.6 0.8"/>`
        + `<text x="${mm(r.x + 1)}" y="${mm(r.y + 2.6)}" font-size="1.8" fill="#9a9a9a" stroke="none">${esc(r.nombre)}</text>`).join('')
      + `</g>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" class="cheque" width="${mm(pl.anchoMm)}mm" height="${mm(pl.altoMm)}mm"`
    + ` viewBox="0 0 ${mm(pl.anchoMm)} ${mm(pl.altoMm)}" font-family="${esc(FUENTE)}">`
    + guias
    + `<g transform="translate(${mm(dx)} ${mm(dy)})" fill="#000">${datos}</g>`
    + `</svg>`;
}

/**
 * Lo que corre en el navegador que imprime: acomoda cada dato en su ancho (ver la nota de arriba) y avisa con
 * `window.__chequeListo` cuando terminó, ya con la fuente cargada (medir antes mide otra fuente).
 */
export const AJUSTAR_CHEQUE_JS = `(function () {
  var NS = 'http://www.w3.org/2000/svg';
  function largo(el) { return el.getComputedTextLength(); }
  function linea(t, texto, y) {
    var s = document.createElementNS(NS, 'tspan');
    s.setAttribute('x', t.getAttribute('x')); s.setAttribute('y', String(y)); s.textContent = texto;
    t.appendChild(s); return s;
  }
  function partir(texto) {
    var p = texto.split(' '), mejor = null;
    for (var i = 1; i < p.length; i++) {
      var a = p.slice(0, i).join(' '), b = p.slice(i).join(' ');
      var peor = Math.max(a.length, b.length);
      if (!mejor || peor < mejor.peor) mejor = { a: a, b: b, peor: peor };
    }
    return mejor;
  }
  function ajustar(t) {
    var ancho = +t.getAttribute('data-ancho'), min = +t.getAttribute('data-min'), max = +t.getAttribute('data-max');
    var fs = max, estado = 'cabe';
    while (largo(t) > ancho && fs > min + 1e-9) { fs = Math.max(min, Math.round((fs - 0.1) * 100) / 100); t.setAttribute('font-size', String(fs)); estado = 'achicada'; }
    if (largo(t) <= ancho) { t.setAttribute('data-ajuste', estado); return; }
    if (+t.getAttribute('data-renglones') === 2) {
      var dos = partir(t.textContent || '');
      if (dos) {
        var base = +t.getAttribute('y'), inter = +t.getAttribute('data-interlinea');
        t.textContent = '';
        var l1 = linea(t, dos.a, base - inter), l2 = linea(t, dos.b, base);
        fs = Math.min(max, +t.getAttribute('data-max2') || inter * 0.9);
        var piso = Math.min(min, fs);
        t.setAttribute('font-size', String(fs));
        while (Math.max(largo(l1), largo(l2)) > ancho && fs > piso + 1e-9) { fs = Math.max(piso, Math.round((fs - 0.1) * 100) / 100); t.setAttribute('font-size', String(fs)); }
        estado = 'dos-renglones';
        [l1, l2].forEach(function (l) { if (largo(l) > ancho) { l.setAttribute('textLength', String(ancho)); l.setAttribute('lengthAdjust', 'spacingAndGlyphs'); estado = 'comprimida'; } });
        t.setAttribute('data-ajuste', estado); return;
      }
    }
    t.setAttribute('textLength', String(ancho)); t.setAttribute('lengthAdjust', 'spacingAndGlyphs');
    t.setAttribute('data-ajuste', 'comprimida');
  }
  function todo() { document.querySelectorAll('text.fit').forEach(ajustar); window.__chequeListo = true; }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(todo, todo); else todo();
})();`;

const CSS_BASE = `html,body{margin:0;padding:0;background:#fff}svg{display:block}`
  + `.ch-benef,.ch-importe{font-weight:700}.ch-fecha,.ch-letra,.ch-leyenda{font-weight:600}`;

/**
 * Las opciones de `page.pdf` (puppeteer): la página exacta del cheque, o carta para la hoja de prueba, sin márgenes y
 * con el tamaño que pide el propio documento. Las comparte el servicio con cualquier verificación, para que lo probado
 * sea lo que se imprime.
 */
export function opcionesPdfCheque(pl: PlantillaCheque, carta: boolean) {
  const margin = { top: '0', right: '0', bottom: '0', left: '0' };
  return carta
    ? { format: 'letter' as const, printBackground: true, preferCSSPageSize: true, margin }
    : { width: `${mm(pl.anchoMm)}mm`, height: `${mm(pl.altoMm)}mm`, printBackground: true, preferCSSPageSize: true, margin };
}

/**
 * El documento que se imprime sobre el cheque: una página del tamaño del cheque, sin márgenes. El contenido va en una
 * caja 0.5 mm más baja que la página: con el contenido exacto a la hoja, el redondeo del navegador mete una hoja en
 * blanco (la lección de la etiqueta de 55 × 24.6 de `[UB.RF.16]`); lo que queda fuera es banda magnética, sin datos.
 */
export function chequeHtml(pl: PlantillaCheque, c: CamposDelCheque, o?: OpcionesCheque): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cheque</title>`
    + `<style>@page{size:${mm(pl.anchoMm)}mm ${mm(pl.altoMm)}mm;margin:0}${CSS_BASE}`
    + `.ch-hoja{width:${mm(pl.anchoMm)}mm;height:${mm(pl.altoMm - 0.5)}mm;overflow:hidden}</style></head>`
    + `<body><div class="ch-hoja">${chequeSvg(pl, c, o)}</div><script>${AJUSTAR_CHEQUE_JS}</script></body></html>`;
}

/**
 * **La hoja de prueba**: el mismo cheque, a tamaño real, sobre una hoja carta y con el contorno y las líneas del papel
 * dibujadas. Se imprime en papel blanco y se pone un cheque cancelado encima, a contraluz: así se calibra sin gastar
 * un cheque. Lleva las instrucciones escritas, porque la va a usar alguien que no leyó este archivo.
 */
export function hojaDePruebaHtml(pl: PlantillaCheque, c: CamposDelCheque, o?: OpcionesCheque): string {
  const { dx, dy } = desplazamiento(o);
  const corrido = dx || dy ? ` · corrimiento aplicado: ${mm(dx)} mm a lo ancho, ${mm(dy)} mm a lo alto` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Hoja de prueba del cheque</title>`
    + `<style>@page{size:letter;margin:0}${CSS_BASE}`
    + `.hoja{width:215.9mm;padding:14mm 0 0;font-family:${FUENTE};color:#000}`
    + `.cab{margin:0 0 5mm 28mm;font-size:3.4mm;font-weight:700}.cab small{display:block;font-weight:400;font-size:2.8mm;margin-top:1mm}`
    + `.cheque{margin:0 auto}`
    + `ol{margin:7mm 24mm 0 34mm;padding:0;font-size:3.2mm;line-height:1.45}li{margin-bottom:1.6mm}`
    + `.no{margin:6mm 0 0 28mm;font-size:3mm;font-weight:700;letter-spacing:.06em}</style></head>`
    + `<body><div class="hoja">`
    + `<div class="cab">HOJA DE PRUEBA · ${esc(pl.nombre)} (${mm(pl.anchoMm)} × ${mm(pl.altoMm)} mm)`
    + `<small>Medidas: ${esc(pl.medicion)}${pl.calibrada ? '' : ' · plantilla SIN CALIBRAR todavía'}${esc(corrido)}</small></div>`
    + chequeSvg(pl, c, { dx, dy, guias: true })
    + `<ol>`
    + `<li>Imprime esta hoja en papel blanco <b>al 100 %</b> (en la ventana de impresión: «Tamaño real», nunca «Ajustar a la página»).</li>`
    + `<li>Pon encima un cheque <b>cancelado</b>, alineado al recuadro punteado, y míralo a contraluz.</li>`
    + `<li>Cada dato debe quedar <b>sobre su línea</b> (fecha, beneficiario, cantidad con letra) y el importe dentro de su recuadro, sin tocar el logo, la firma, el titular ni la banda de números de abajo.</li>`
    + `<li>Si todo cae corrido hacia un mismo lado, mide cuántos milímetros y hacia dónde, y anótalo: es el ajuste de tu impresora.</li>`
    + `<li>Después imprime un cheque en una hoja <b>recortada a ${cm(pl.anchoMm)} × ${cm(pl.altoMm)} cm</b> (el tamaño de este cheque), metida centrada como el cheque de verdad, para comprobar que la impresora la deja en su lugar.</li>`
    + `</ol>`
    + `<div class="no">ESTA HOJA NO ES UN CHEQUE</div>`
    + `</div><script>${AJUSTAR_CHEQUE_JS}</script></body></html>`;
}
