import { anchoBarrasMm, barrasSvg, escHtml } from '@megadulces/ui-web';

/**
 * `[UB.RF.14]` La etiqueta de una ubicación de TIENDA, para la **TSC TE200 con el rollo amarillo** (Edgar,
 * 2026-11-20: «las etiquetas deben salir con la TSC 200, etiqueta amarilla»).
 *
 * `[UB.RF.16]` El rollo amarillo es de **UNA etiqueta a lo ancho, de 55 × 25 mm**, medida con regla (Edgar,
 * 2026-11-20). Kepler lo tiene configurado como «Amarilla 60 × 30 mm» y ESA medida resultó falsa: la primera
 * corrección la usó y siguió saliendo mal. La versión original lo suponía igual al blanco de checado (3 por
 * fila de 32 × 48, hoja de 100 × 48). Ahora el navegador manda UNA hoja de 55 × 25 por etiqueta; el sensor de
 * la TSC salta el hueco entre etiquetas.
 *
 * El código de barras va a **2 puntos por módulo** (0.25 mm a 203 dpi): con un ancho que no es múltiplo del
 * punto, la impresora redondea cada barra distinto. `TA011` son 90 módulos = 22.5 mm, centrados en los 52 mm
 * útiles. Las barras van paralelas al avance del rollo, que es como una térmica directa las imprime más nítidas.
 */

/** La hoja que el navegador manda a la TSC con el rollo amarillo: UNA etiqueta de 55 × 25 mm (medida con regla). */
export const PAGINA_TSC_AMARILLA = 'size: 55mm 25mm; margin: 0;';

/** El rollo amarillo, en mm: lo que la plantilla y sus pruebas usan para medir que todo quepa. */
export const GEOMETRIA_AMARILLA = { anchoMm: 55, altoMm: 25, margenMm: 1.5 } as const;

export interface EtiquetaUbicacion {
  code: string;
  label: string | null;
  almacen: string | null;
}

/** `TA011` (5) cabe a 9 mm en 52 mm; un código viejo más largo se achica, nunca se corta. */
export function tamanoCodigo(code: string): '' | 'eu-c-m' | 'eu-c-s' {
  if (code.length <= 5) return '';
  return code.length <= 7 ? 'eu-c-m' : 'eu-c-s';
}

export function etiquetaUbicacionHtml(u: EtiquetaUbicacion): string {
  const arriba = [u.almacen, u.label].filter((x) => !!x).join(' · ');
  return `
          <div class="et eu">
            <div class="eu-arriba">${escHtml(arriba)}</div>
            <div class="eu-code ${tamanoCodigo(u.code)}">${escHtml(u.code)}</div>
            ${barrasSvg(u.code, 'eu-bar', anchoBarrasMm(u.code))}
          </div>`;
}

/** Una etiqueta por hoja, como sale el rollo amarillo. */
export function etiquetasUbicacionHtml(us: readonly EtiquetaUbicacion[]): string {
  return us.map(etiquetaUbicacionHtml).join('');
}

/**
 * Medidas en mm de la etiqueta de 55 × 24.6: 24.6 y no 25 porque, con la etiqueta exacta a la hoja, el redondeo
 * del navegador mete una hoja en blanco (la misma lección de la fila de 47.6 en la etiquetera). En negro: es
 * térmica directa, el amarillo lo pone el papel.
 *
 * Alto, de arriba abajo: 1.5 margen · 2.6 rótulo · 9 código · 7 barras · 1.5 margen = 21.6, y ~3 mm de aire repartido.
 */
export const CSS_ETIQUETA_UBICACION = [
  'body{margin:0}',
  '.et{box-sizing:border-box;width:55mm;height:24.6mm;padding:1.5mm;display:flex;flex-direction:column;align-items:center;justify-content:space-between;',
  'color:black;font-family:Arial,Helvetica,sans-serif;overflow:hidden;break-after:page;page-break-after:always}',
  '.et:last-child{break-after:auto;page-break-after:auto}',
  '.eu-arriba{max-width:100%;font-size:2.4mm;font-weight:700;line-height:1.1;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.eu-code{font-size:9mm;font-weight:900;line-height:1;letter-spacing:.02em;white-space:nowrap}',
  '.eu-c-m{font-size:7mm}',
  '.eu-c-s{font-size:5.5mm}',
  '.eu-bar{display:block;height:7mm;max-width:52mm}',
].join('');
