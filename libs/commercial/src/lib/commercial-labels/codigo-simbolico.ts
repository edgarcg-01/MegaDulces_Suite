/**
 * `[ETQ-PROMO.1]` Los códigos SIMBÓLICOS de Kepler: no son mercancía, no llevan etiqueta.
 *
 * Kepler no permite una línea de venta sin precio, así que las promociones («10 CJS OREO BASE 9 KG = GRATIS
 * 1 CJ MAS»), las bonificaciones («1 EN 10 EN GUMMY POP», «3X2 EN CH POOSH») y los ajustes («PACA DE CARTON
 * P/RECICLAR», «* DESCONTINUADO») viven en el catálogo **como un código más** con un precio de **$0.01**.
 *
 * La pantalla de etiquetas los clasificaba como «precio 0 en la tienda: hay que ponerle precio en Kepler»,
 * que es **falso en las dos mitades**: el precio no es 0 (es $0.01) y nadie debe ponérselo, porque no se
 * vende como producto. Medido en producción el 2026-10-22: **206 códigos** están a $0.01 en las 9 plazas;
 * **188** llevan «= GRATIS» en el nombre; **186 de 318** códigos sin precio usable son de promoción.
 *
 * ── Qué cuenta como simbólico (dos señales, cualquiera basta) ──────────────────────────────────────
 *  1. El nombre trae «= GRATIS»: el propio nombre describe una bonificación. Cubre además los que en
 *     alguna tienda sí traen precio real (11 códigos: `78171`, `04023`…), que el precio solo no detecta.
 *  2. **$0.01 en TODAS las plazas donde existe el código** (en la pieza y en el paquete/caja): cubre
 *     «3X2 EN…», «1 EN 10 EN…», «PEGAR 2 SABRITONES…» y el typo «= GRATUS», que el nombre no.
 *
 * ⛔ Lo que NO es una señal: un precio en **0.00**. Un producto nuevo sin precio todavía está a 0 en todas
 * las plazas y sí hay que ponerle precio en Kepler: seguirá saliendo como `sin_precio`. Tampoco basta
 * $0.01 en UNA plaza: un producto real puede tener un precio de paso en una tienda.
 */

/** «= GRATIS» con o sin espacios, en cualquier mayúscula. No casa «GRATUS» (el typo lo agarra la señal 2). */
const PATRON_GRATIS = /=\s*GRATIS\b/i;

export function esNombreDePromocion(nombre: string | null | undefined): boolean {
  return PATRON_GRATIS.test(String(nombre ?? ''));
}

/**
 * @param nombre           el nombre del código en Kepler (`kdii.c2`)
 * @param centavoEnTodas   `true` si en TODAS las plazas el precio es exactamente $0.01 en pieza y
 *                         paquete/caja; `false` si alguna cotiza distinto; `null` = no se pudo medir
 */
export function esCodigoSimbolico(nombre: string | null | undefined, centavoEnTodas: boolean | null): boolean {
  return esNombreDePromocion(nombre) || centavoEnTodas === true;
}
