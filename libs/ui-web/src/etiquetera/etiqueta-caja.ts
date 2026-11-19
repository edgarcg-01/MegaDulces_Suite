import type { EtiquetaCaja } from '@megadulces/contracts';
import { CSS_FILA_TSC_3X, anchoBarrasMm, barrasSvg, escHtml, filasHtml } from './etiquetera';

/**
 * `[RE.ETQ.1.2]` La etiqueta de caja de la orden de entrada (vía A: navegador + controlador de Windows de la
 * TSC TE200). Reemplaza la de Kepler (`Md_etiq_OE_fto`) con lo que el plan midió que le falta:
 *
 *  · Barra CODE128 a **2 puntos por módulo** con el ancho calculado (`C70106` = 90 módulos = 22.5 mm). La de
 *    Kepler era Code 39 metido en ~2 cm (~1.7 puntos por barra delgada): no se lee.
 *  · Nombre **completo**: la letra se achica con el largo y nunca se corta a 24 (226 productos quedaban iguales).
 *  · El pie igual en las tres etiquetas de la fila (Kepler lo cortaba en la 2.ª y la 3.ª).
 *  · La caja incompleta lleva su etiqueta y la dice en negativo (Kepler no la imprimía).
 *
 * El contenido lo calcula el SERVIDOR al registrar el envío (fecha D6 y datos congelados): esta plantilla sólo
 * dibuja lo que le llega.
 */

/** El nombre completo cabe en 3 renglones de 29 mm achicando la letra; nunca se corta. */
export function tamanoNombre(nombre: string): '' | 'ec-n-m' | 'ec-n-s' {
  const n = nombre.trim().length;
  if (n <= 40) return '';
  return n <= 60 ? 'ec-n-m' : 'ec-n-s';
}

/** `7:20` cabe grande; `120:120` se achica. */
export function tamanoConsecutivo(c: string): '' | 'ec-c-s' {
  return c.length <= 5 ? '' : 'ec-c-s';
}

export function etiquetaCajaHtml(e: EtiquetaCaja): string {
  return `
          <div class="et ec${e.incompleta ? ' ec-inc' : ''}">
            <div class="ec-top"><span class="ec-clave">${escHtml(e.clave)}</span><span class="ec-cons ${tamanoConsecutivo(e.consecutivo)}">${escHtml(e.consecutivo)}</span></div>
            ${barrasSvg(e.codigo, 'ec-bar', anchoBarrasMm(e.codigo))}
            <div class="ec-codigo">${escHtml(e.codigo)}</div>
            <div class="ec-uxc"><span class="ec-cont">${escHtml(e.contenido)}</span><span class="ec-fecha">${escHtml(e.fecha)}</span></div>
            <div class="ec-nombre ${tamanoNombre(e.nombre)}">${escHtml(e.nombre)}</div>
            <div class="ec-pie">${escHtml(e.pie)}</div>
          </div>`;
}

/** Las etiquetas en filas de 3, como sale el rollo. */
export function etiquetasCajaHtml(etiquetas: readonly EtiquetaCaja[]): string {
  return filasHtml(etiquetas, etiquetaCajaHtml);
}

/** Colores con palabra (black/white): es papel térmico. Medidas en mm de la etiqueta de 32 × 47.6. */
export const CSS_ETIQUETA_CAJA = [
  CSS_FILA_TSC_3X,
  '.et{box-sizing:border-box;width:32mm;height:100%;padding:1.5mm;display:flex;flex-direction:column;align-items:stretch;',
  'background:white;color:black;font-family:Arial,Helvetica,sans-serif;overflow:hidden}',
  '.ec-top{display:flex;justify-content:space-between;align-items:baseline;line-height:1}',
  '.ec-clave{font-size:4.2mm;font-weight:700}',
  '.ec-cons{font-size:5.5mm;font-weight:900}',
  '.ec-c-s{font-size:4.2mm}',
  '.ec-bar{display:block;height:8.5mm;margin:0.8mm auto 0;max-width:29mm}',
  '.ec-codigo{font-size:2mm;text-align:center;line-height:1.1}',
  '.ec-uxc{display:flex;justify-content:space-between;align-items:baseline;font-size:3.4mm;font-weight:700;line-height:1.1;margin-top:0.6mm}',
  '.ec-inc .ec-cont{background:black;color:white;padding:0 0.8mm}',
  '.ec-nombre{font-size:2.8mm;line-height:1.15;margin-top:0.6mm;overflow:hidden;overflow-wrap:anywhere}',
  '.ec-n-m{font-size:2.4mm}',
  '.ec-n-s{font-size:2mm}',
  '.ec-pie{font-size:1.9mm;line-height:1.1;margin-top:auto}',
].join('');
