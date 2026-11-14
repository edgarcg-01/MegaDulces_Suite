/**
 * `[GX.112]` ¿Este dispositivo puede mostrar un PDF **incrustado** en un `<iframe>`?
 *
 * ⛔ El WebView de Android y Chrome móvil **no traen visor de PDF**: un `<iframe>` apuntado a un
 * PDF queda en blanco —el recuadro gris con la carita triste— y, peor, **no dispara `error`**, así
 * que no hay forma de caerle con un `(error)` como al `<img>`. En escritorio el mismo iframe sí
 * pinta el PDF, por eso el defecto sólo se veía en el teléfono y nunca desde la oficina.
 *
 * El puntero decide, porque es exactamente el conjunto de equipos donde incrustar un PDF es
 * confiable: con puntero **fino** (mouse/trackpad, escritorio) se incrusta; con puntero **grueso**
 * (táctil: el teléfono de sucursal) se abre en el visor nativo del equipo.
 *
 * `(pointer: coarse)` = el puntero **primario** es táctil. Un portátil Windows con trackpad es
 * `fine` y sigue incrustando; un teléfono es `coarse` y abre aparte.
 *
 * `matcher` se inyecta para poder probar las dos ramas. Sin `matchMedia` (SSR, jsdom) se asume
 * escritorio —el caso que incrusta— para no cambiar lo que ya funcionaba.
 */
export function puedeIncrustarPdf(
  matcher: ((q: string) => { matches: boolean }) | null =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? (q: string) => window.matchMedia(q)
      : null,
): boolean {
  if (!matcher) return true;
  try {
    return !matcher('(pointer: coarse)').matches;
  } catch {
    return true;
  }
}
