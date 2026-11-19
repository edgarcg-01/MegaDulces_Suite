import { describe, expect, it } from 'vitest';
import { barrasSvg } from '@megadulces/ui-web';
import { codigoEtiqueta, etiquetasHtml, enFilas, tamanoGrande, type Etiqueta } from './checado-etiquetas';

/**
 * `[RE.ETQ.1.1]` Candado de la salida de GP.4: el HTML de las etiquetas del checado tiene que quedar IDÉNTICO
 * cuando sus primitivos (filas de 3, barras, escape) se mudan a `libs/ui-web/src/etiquetera`. Las huellas se
 * tomaron con el código de GP.4 ANTES de mudarlo (commit e9bc33818, #334).
 *
 * ⚠️ El SVG de las barras lo escribe jsbarcode y cambia con su versión: la huella del HTML COMPLETO era
 * `7993:78c7d562` con jsbarcode 3.11.6 (antes y después de mudar, con el código de GP.4 intacto) y en el CI,
 * que instala 3.12.3 del lockfile, salía `7801:2e05a640` (PR #571). Por eso el candado va en dos partes que
 * no dependen de la versión: el HTML de GP.4 con cada `<svg>` reemplazado, contra su huella; y cada `<svg>`,
 * idéntico al que dibuja la etiquetera compartida para ese código.
 */
const SVG = /<svg[\s\S]*?<\/svg>/g;
const FIXTURE: Etiqueta[] = [
  { pedido: 'U-D-40-0002781', destino: 'Ruta 12 <Zamora> & "Centro"', grande: 'P3', detalle: '12 artículos · 4 productos', codigo: codigoEtiqueta('U-D-40-0002781', 'P', 3) },
  { pedido: 'U-D-40-0002781', destino: null, grande: '1/7', detalle: 'LA ROSA BOTA GRANDE 418GR', codigo: codigoEtiqueta('U-D-40-0002781', 'C', 1) },
  { pedido: 'U-D-40-0002781', destino: null, grande: '100/120', detalle: 'X', codigo: codigoEtiqueta('U-D-40-0002781', 'C', 2) },
  { pedido: 'U-D-40-0002781', destino: 'Suc 08', grande: '7/7', detalle: 'Y', codigo: codigoEtiqueta('U-D-40-0002781', 'C', 7) },
];

/** Huella corta y estable de un texto (FNV-1a de 32 bits): basta para detectar un carácter distinto. */
function huella(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

describe('[RE.ETQ.1.1] GP.4 — la salida del checado no cambia al mudar la etiquetera a libs/', () => {
  it('código de la etiqueta', () => {
    expect(FIXTURE.map((e) => e.codigo)).toEqual(['000278110003', '000278120001', '000278120002', '000278120007']);
  });

  it('filas de 3', () => {
    expect(enFilas([1, 2, 3, 4, 5, 6, 7]).map((f) => f.length)).toEqual([3, 3, 1]);
  });

  it('tamaño del número grande', () => {
    expect(['1/7', '100/120', '1000/1200'].map(tamanoGrande)).toEqual(['', 'et-g-m', 'et-g-s']);
  });

  it('el HTML de GP.4 (con escape, filas y marco de cada etiqueta) es idéntico, sin depender de jsbarcode', () => {
    const html = etiquetasHtml(FIXTURE);
    expect(html).toContain('Ruta 12 &lt;Zamora&gt; &amp; &quot;Centro&quot;');
    expect((html.match(/class="et-fila"/g) ?? []).length).toBe(2);
    expect(huella(html.replace(SVG, '<svg/>'))).toBe(HUELLA_GP4_SIN_BARRAS);
  });

  it('cada barra es la que dibuja la etiquetera compartida para su código, en orden', () => {
    const html = etiquetasHtml(FIXTURE);
    const svgs = html.match(SVG) ?? [];
    expect(svgs).toHaveLength(4);
    expect(svgs).toEqual(FIXTURE.map((e) => barrasSvg(e.codigo, 'et-bar')));
    expect(svgs.every((s) => s.includes('viewBox=') && s.includes('class="et-bar"'))).toBe(true);
  });
});

/**
 * El HTML de GP.4 con cada `<svg>` reemplazado por `<svg/>`. Sale del mismo HTML cuya huella completa
 * (`7993:78c7d562`, jsbarcode 3.11.6) se tomó con el código de GP.4 sin cambios. Si cambia, la
 * refactorización cambió lo que se imprime.
 */
const HUELLA_GP4_SIN_BARRAS = '1389:65914818';
