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
/**
 * `[UB.RF.20]` **Hay DOS rollos amarillos y conviven** (Edgar, 2026-11-25): distintas sucursales tienen
 * uno u otro, así que el tamaño dejó de ser una constante y se elige al imprimir. Las dos medidas están
 * tomadas **con regla**, no de una configuración — que es la lección que costó `[UB.RF.16]`: Kepler dice
 * «Amarilla 60 × 30» y ese rollo medía 55 × 25.
 *
 * El alto de la etiqueta va 0.4 mm por debajo del alto del rollo: con la etiqueta exacta a la hoja, el
 * redondeo del navegador mete una hoja en blanco entre una y otra.
 *
 * ⚠️ El **ancho** del código de barras NO depende del rollo: lo fija la densidad (2 puntos por módulo,
 * 0.25 mm a 203 dpi), así que `TA011` mide 22.5 mm en los dos. Lo que el rollo grande gana es **altura
 * de barras, tamaño de código y margen para códigos largos**, que es lo que se lee caminando.
 */
export type RolloAmarillo = '55x25' | '60x29';

export const ROLLOS_AMARILLOS = {
  '55x25': { anchoMm: 55, altoMm: 25, etiquetaAltoMm: 24.6, margenMm: 1.5, rotuloMm: 2.4, codigoMm: 9, codigoMedioMm: 7, codigoChicoMm: 5.5, barrasAltoMm: 7, rotulo: '55 × 25 mm', cm: '5.5 × 2.5 cm' },
  // Código 10.5 y barras 8.5, no 11 y 9: con esos sumaba 26.08 contra un tope de 26.1 — pasaba por
  // 0.02 mm, que es una casualidad, no un diseño. Así quedan ~1 mm de aire y el `space-between` respira.
  '60x29': { anchoMm: 60, altoMm: 29, etiquetaAltoMm: 28.6, margenMm: 1.5, rotuloMm: 2.8, codigoMm: 10.5, codigoMedioMm: 8.5, codigoChicoMm: 6.5, barrasAltoMm: 8.5, rotulo: '60 × 29 mm', cm: '6 × 2.9 cm' },
} as const;

export const ROLLO_POR_OMISION: RolloAmarillo = '55x25';

/** Lo que queda para el contenido una vez quitados los dos márgenes. */
export function anchoUtilMm(rollo: RolloAmarillo): number {
  const r = ROLLOS_AMARILLOS[rollo];
  return Math.round((r.anchoMm - 2 * r.margenMm) * 100) / 100;
}

export function paginaTscAmarilla(rollo: RolloAmarillo): string {
  const r = ROLLOS_AMARILLOS[rollo];
  return `size: ${r.anchoMm}mm ${r.altoMm}mm; margin: 0;`;
}

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
export function cssEtiquetaUbicacion(rollo: RolloAmarillo): string {
  const r = ROLLOS_AMARILLOS[rollo];
  return [
    'body{margin:0}',
    `.et{box-sizing:border-box;width:${r.anchoMm}mm;height:${r.etiquetaAltoMm}mm;padding:${r.margenMm}mm;display:flex;flex-direction:column;align-items:center;justify-content:space-between;`,
    'color:black;font-family:Arial,Helvetica,sans-serif;overflow:hidden;break-after:page;page-break-after:always}',
    '.et:last-child{break-after:auto;page-break-after:auto}',
    `.eu-arriba{max-width:100%;font-size:${r.rotuloMm}mm;font-weight:700;line-height:1.1;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}`,
    `.eu-code{font-size:${r.codigoMm}mm;font-weight:900;line-height:1;letter-spacing:.02em;white-space:nowrap}`,
    `.eu-c-m{font-size:${r.codigoMedioMm}mm}`,
    `.eu-c-s{font-size:${r.codigoChicoMm}mm}`,
    `.eu-bar{display:block;height:${r.barrasAltoMm}mm;max-width:${anchoUtilMm(rollo)}mm}`,
  ].join('');
}
