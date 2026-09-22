import { Router, UrlTree } from '@angular/router';

/**
 * Por qué te mandamos al login. No es cosmético: son dos causas distintas y sólo
 * una se puede afirmar.
 *
 *  - 'expired': TENÍAS sesión y el backend la rechazó (401 en vuelo). Lo pone el
 *    interceptor, que es el único que lo presenció.
 *  - 'required': no hay token en esta ventana. Puede ser que nunca entraste, que
 *    cerraste sesión en otra pestaña, o que el token venció y se borró.
 *    'isAuthenticated' es '!!token()', así que NO se puede distinguir cuál —
 *    se declara lo que se sabe ("entrá para continuar"), no se inventa un
 *    "tu sesión expiró" que en la mitad de los casos sería falso.
 */
export type LoginReason = 'expired' | 'required';

/** No tiene sentido volver al propio login ni a una pantalla de error. */
const SIN_RETORNO = ['/login', '/sin-acceso'];

/**
 * A dónde mandar a alguien sin sesión, CONSERVANDO a dónde iba.
 *
 * Por qué existe. El interceptor guardaba el destino en '?returnUrl=' desde que
 * se arregló el "logout mudo", pero los 6 guards que también echan al login
 * navegaban pelados — y el login sin 'returnUrl' cae a '/projects'. O sea: si la
 * sesión se caía MIENTRAS trabajabas volvías a tu pantalla, y si abrías una
 * ventana nueva sobre esa misma URL perdías el destino y aterrizabas en "Mi
 * trabajo". El mecanismo estaba inventado en UN lugar y nunca se generalizó, que
 * es exactamente lo que ADR-056 llama un primitivo sin subir a compartido.
 *
 * Devuelve 'UrlTree' a propósito, no navega. Un guard que hace 'navigate()' y
 * devuelve 'false' arranca una SEGUNDA navegación mientras la primera se está
 * cancelando; el 'UrlTree' es la misma navegación, redirigida.
 */
export function loginUrlTree(router: Router, desde: string | null, motivo: LoginReason): UrlTree {
  return router.createUrlTree(['/login'], {
    // 'createUrlTree' descarta las claves en null (verificado en el
    // 'removeEmptyProps' del router, no asumido), así que sin destino al que
    // volver la URL queda limpia en vez de traer un '?returnUrl=null'.
    queryParams: { reason: motivo, returnUrl: destinoValido(desde) },
  });
}

/**
 * El destino, sólo si vale la pena volver a él.
 *
 * Se exige ruta interna: 'startsWith("/")' y no '//', que el navegador lee como
 * host. Acá el valor lo pone el router, pero la misma regla la aplica el login
 * al LEER el parámetro, donde sí viene de la barra de direcciones.
 */
export function destinoValido(desde: string | null | undefined): string | null {
  if (!desde || !desde.startsWith('/') || desde.startsWith('//')) return null;
  return SIN_RETORNO.some((p) => desde.startsWith(p)) ? null : desde;
}
