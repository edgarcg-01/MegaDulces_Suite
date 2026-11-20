import { CSS_FILA_TSC_3X, anchoBarrasMm, barrasSvg, escHtml, filasHtml } from '@megadulces/ui-web';

/**
 * `[UB.RF.14]` La etiqueta de una ubicación de TIENDA, para la **TSC TE200 con el rollo amarillo** (Edgar,
 * 2026-11-20: «las etiquetas deben salir con la TSC 200, etiqueta amarilla»). El rollo amarillo es igual al
 * blanco de checado (Edgar, mismo día): 3 por fila, 32 × 48 mm, 2 mm entre etiquetas, 100 mm de ancho.
 *
 * No es otra impresora ni otro módulo: es la etiquetera compartida (`@megadulces/ui-web`, ADR-056), la misma
 * fila de 3 que imprimen el checado (GP.4) y la etiqueta de caja (RE). Reemplaza a la hoja carta tipo 5160 de
 * `[UB.RF.12]`, que nunca se imprimió en piso.
 *
 * El código de barras va a **2 puntos por módulo** (0.25 mm a 203 dpi): con un ancho que no es múltiplo del
 * punto, la impresora redondea cada barra distinto. `TA011` son 90 módulos = 22.5 mm, centrados en los 29 mm
 * útiles: 3.25 mm de zona quieta por lado, más de los 2.5 mm (10 módulos) que pide CODE128. Las barras van
 * paralelas al avance del rollo, que es como una térmica directa las imprime más nítidas.
 */

export interface EtiquetaUbicacion {
  code: string;
  label: string | null;
  almacen: string | null;
}

/** `TA011` (5) cabe a 7.5 mm en 29 mm; un código viejo más largo se achica, nunca se corta. */
export function tamanoCodigo(code: string): '' | 'eu-c-m' | 'eu-c-s' {
  if (code.length <= 5) return '';
  return code.length <= 7 ? 'eu-c-m' : 'eu-c-s';
}

export function etiquetaUbicacionHtml(u: EtiquetaUbicacion): string {
  const arriba = [u.almacen, u.label].filter((x) => !!x).join(' · ');
  return `
          <div class="et eu">
            <div class="eu-arriba">${escHtml(arriba)}</div>
            <div class="eu-centro">
              <div class="eu-code ${tamanoCodigo(u.code)}">${escHtml(u.code)}</div>
              ${barrasSvg(u.code, 'eu-bar', anchoBarrasMm(u.code))}
            </div>
          </div>`;
}

/** Las etiquetas en filas de 3, como sale el rollo. La última fila puede ir incompleta. */
export function etiquetasUbicacionHtml(us: readonly EtiquetaUbicacion[]): string {
  return filasHtml(us, etiquetaUbicacionHtml);
}

/** Medidas en mm de la etiqueta de 32 × 47.6. En negro: es térmica directa, el amarillo lo pone el papel. */
export const CSS_ETIQUETA_UBICACION = [
  CSS_FILA_TSC_3X,
  '.et{box-sizing:border-box;width:32mm;height:100%;padding:1.5mm;display:flex;flex-direction:column;align-items:stretch;',
  'color:black;font-family:Arial,Helvetica,sans-serif;overflow:hidden}',
  '.eu-arriba{font-size:2.4mm;font-weight:700;line-height:1.1;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.eu-centro{margin:auto 0;display:flex;flex-direction:column;align-items:center;gap:2mm}',
  // 7.5 mm: el más ancho medido (TB044) ocupa ~27 de los 29 mm útiles; a 8 mm eran 28.84, sin aire.
  '.eu-code{font-size:7.5mm;font-weight:900;line-height:1;letter-spacing:.02em;white-space:nowrap}',
  '.eu-c-m{font-size:6mm}',
  '.eu-c-s{font-size:4.5mm}',
  '.eu-bar{display:block;height:14mm;max-width:29mm}',
].join('');
