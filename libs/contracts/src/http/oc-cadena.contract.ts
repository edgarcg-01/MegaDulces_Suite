/**
 * `[RA-PRO.67]` Por qué una orden de compra de Kepler sigue abierta — el vocabulario COMPARTIDO.
 *
 * Vive acá y no en `libs/commercial` porque lo usan los dos lados: el servicio clasifica cada
 * orden y la pantalla pinta el chip con la misma etiqueta y la misma regla. Una regla escrita dos
 * veces diverge, y este proyecto ya lo pagó (ADR-056: un tipo nació un martes y el viernes ya
 * estaba copiado a mano en el frontend).
 *
 * ── Dos testigos, y ninguno alcanza solo (ADR-059) ──────────────────────────────────────────
 * `/compras/oc-abiertas` pintaba 292 renglones iguales. Medido contra prod el 2026-10-02, ahí
 * había cuatro cosas distintas que resuelve gente distinta:
 *
 *     sin vale        + el ERP la tiene pendiente   252 filas   $30,255,216   reclamar al proveedor
 *     vale VIVO       (cualquier c43)                28 filas   $ 1,300,137   almacén no capturó la entrada
 *     vale CANCELADO  (cualquier c43)                10 filas   $ 1,177,569   la compra se abortó
 *     sin vale        + el ERP ya no la ve pendiente   2 filas   $   837,662   limpieza en Kepler
 *
 * El primer testigo es el DOCUMENTO (el vale `X-A-37`) y el segundo es la palabra del ERP
 * (`kdm1.c43`). Se contradicen en 4 de esas 292 filas, así que no se colapsan en uno.
 *
 * ⭐ El documento fue el que resolvió el estatus `A`, que el decode de Kepler no documenta: en vez
 * de adivinar la letra se miraron sus 19 órdenes y **17 tenían todos sus vales cancelados**. Si se
 * hubiera adivinado al revés ("Autorizada" = pendiente), $1,110,521 habrían quedado del lado
 * equivocado.
 */

/** Lo que la cadena de documentos puede DEMOSTRAR. Lo calcula `analytics.erp_purchase_orders`. */
export const ESTADOS_CADENA = ['cerrada', 'sin_vale', 'vale_cancelado', 'vale_vivo'] as const;
export type EstadoCadena = (typeof ESTADOS_CADENA)[number];

/** Las cuatro cosas distintas que la bandeja pintaba iguales. */
export const CLASES_OC = ['pendiente', 'falta_entrada', 'abortada', 'cerrada_sin_rastro'] as const;
export type ClaseOc = (typeof CLASES_OC)[number];

export const CLASE_OC_LABEL: Record<ClaseOc, string> = {
  pendiente: 'Pendiente',
  falta_entrada: 'Falta orden de entrada',
  abortada: 'Compra abortada',
  cerrada_sin_rastro: 'El ERP ya la cerró',
};

/** Qué hacer con cada una. Va en el `title` del chip: el nombre solo no dice a quién le toca. */
export const CLASE_OC_ACCION: Record<ClaseOc, string> = {
  pendiente: 'Sigue en juego: reclamársela al proveedor.',
  falta_entrada: 'Hay un vale vivo y la mercancía nunca se capturó: es de almacén, no de compras.',
  abortada: 'El vale está cancelado, la compra no va a ocurrir: cerrar la orden en Kepler.',
  cerrada_sin_rastro: 'El ERP ya no la tiene pendiente y no hay vale que lo explique: revisar en Kepler.',
};

/** Las dos que no van a salir solas: alguien tiene que ir a Kepler a cerrarlas. */
export const CLASES_MUERTAS: readonly ClaseOc[] = ['abortada', 'cerrada_sin_rastro'];

/**
 * Cruza los dos testigos.
 *
 *  - El documento manda cuando dice algo: un vale cancelado prueba que la compra se abortó y un
 *    vale vivo prueba que la mercancía está apartada, sin importar qué diga `c43`.
 *  - Cuando el documento no dice nada (`sin_vale`), el único testigo es el ERP.
 *
 * `cerrada` nunca llega acá: esas órdenes ya salieron de la bandeja.
 *
 * ⚠️ Con la migración sin aplicar los dos argumentos llegan `null` y el resultado es `pendiente`
 * — exactamente lo que la pantalla hacía con TODAS antes de esta fase. No inventa una clase; el
 * que declara que no se midió es `clasificacion_disponible`.
 */
export function clasificarOc(
  estado: EstadoCadena | null | undefined,
  pendienteEnErp: boolean | null | undefined,
): ClaseOc {
  if (estado === 'vale_cancelado') return 'abortada';
  if (estado === 'vale_vivo') return 'falta_entrada';
  return pendienteEnErp === false ? 'cerrada_sin_rastro' : 'pendiente';
}
