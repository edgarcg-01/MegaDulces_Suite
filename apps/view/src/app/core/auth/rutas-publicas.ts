/**
 * ⭐⭐ `[CG.203]` **Las pantallas que se abren SIN sesión, en UNA sola lista.**
 *
 * Edgar, 2026-10-23: *«pide usuario, y no debería pedir iniciar sesión»*. La pantalla del teléfono
 * que firma un recibo de caja (`/firmar`) no tiene guard desde `[CG.84]`, y aun así mandaba al
 * login. No era la pantalla: era el ARRANQUE de la app, que corre igual en cualquier ruta.
 *
 *     el teléfono guardó un token en `localStorage` (alguna vez inició sesión: el del cajero,
 *     el del mostrador) → `restoreSession()` lo carga sin mirar si venció
 *     → el initializer `resolverAccesoInicial()` y `refreshAccess()` piden `/users/me/access`
 *     → 401 → `authInterceptor` hace `logout()` y navega a `/login`
 *
 * La excepción que ya tenía el interceptor (`/finance/captura`) miraba la URL de la PETICIÓN, y eso
 * no alcanza: el 401 no lo provoca la pantalla pública, lo provoca el arranque. Lo que hay que mirar
 * es **en qué pantalla está la persona**.
 *
 * ⛔ Por qué una lista y no un `if` en cada lugar: la leen TRES (el arranque, el interceptor y el
 * auto-update) y la tiene que respetar el router. Tres copias son tres listas que divergen el día que
 * se agregue una pantalla pública — y la que quede vieja vuelve a mandar al login a alguien que no
 * tiene cuenta. `rutas-publicas.spec.ts` compara esta lista contra `app.routes.ts` en los dos sentidos.
 *
 * Se guarda el PRIMER segmento: `captura/:token` y `empleo/liga/:token` cuelgan de él.
 */
export const RUTAS_PUBLICAS: readonly string[] = ['firmar', 'captura', 'empleo'];

/**
 * ¿Esta URL es una pantalla pública? Acepta lo que venga: con query, con hash o con el outlet del
 * panel (`/firmar(panel:…)`), porque la leen el router y `location` y cada uno la escribe distinto.
 */
export function esRutaPublica(url: string | null | undefined): boolean {
  const primero = String(url ?? '')
    .replace(/^\/+/, '')
    .split(/[/?#(;]/)[0];
  return RUTAS_PUBLICAS.includes(primero);
}

/**
 * ¿La persona está HOY en una pantalla pública? Lee `location` y no el router a propósito: el
 * initializer corre antes de la primera navegación, cuando `router.url` todavía vale `/`.
 */
export function enRutaPublica(): boolean {
  return typeof location !== 'undefined' && esRutaPublica(location.pathname);
}
