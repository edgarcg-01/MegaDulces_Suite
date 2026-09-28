/**
 * `[SEG.2]` — **Lo que se va con la sesión.** Cerrar sesión tiene que borrar el rastro de la
 * persona que se fue, o la siguiente lo hereda en el mismo navegador.
 *
 * ── Qué se midió antes de escribir esto (2026-09-28) ─────────────────────────────────────────
 * `AuthService.logout()` limpiaba el token, el usuario, los permisos y el alcance. Lo que
 * quedaba vivo:
 *
 *   · **Los caches del service worker.** `ngsw-config.json` cachea respuestas de la API por
 *     **URL, sin el usuario en la llave** — el SW no mira el `Authorization`. El grupo
 *     `api-performance` usa `strategy: "performance"` (cache-first) con `maxAge: 1d` sobre
 *     `/api/users/**`, `/api/stores/**`, `/api/commercial/warehouses/**` y
 *     `/api/commercial/pricing/**`: durante 24 h la respuesta que se sirve puede ser la que
 *     descargó **otra persona**, sin una sola llamada a la red. El grupo `api-freshness` (1 h)
 *     cae al cache cuando la red tarda más de 10 s, que es justo lo que pasa en una tablet de
 *     sucursal.
 *   · **`localStorage`**, con cosas que son de la persona y no del aparato: la última posición
 *     GPS, los errores y diagnósticos capturados (que llevan las peticiones de su sesión), sus
 *     accesos recientes, sus filtros guardados.
 *   · **`sessionStorage`** entero.
 *   · **25 servicios `providedIn: 'root'` con estado cacheado**, de los cuales el logout
 *     limpiaba **2**. Esto no se arregla acá: se arregla **recargando** (ver abajo).
 *
 * ── Por qué una LISTA DE LO QUE SOBREVIVE y no una de lo que se borra ────────────────────────
 * Porque la de lo que se borra envejece mal: la clave que alguien agregue el mes que viene no
 * estaría en ella y se quedaría. Con una lista de sobrevivientes, lo nuevo **se borra por
 * default** y sólo se conserva lo que alguien declaró explícitamente que es del APARATO.
 * Es el mismo criterio con el que este mismo `libs/` eligió un listener global antes que una
 * directiva para la guarda de la rueda: lo que hay que acordarse de agregar, no se agrega.
 *
 * ── Lo que NO hace, a propósito ──────────────────────────────────────────────────────────────
 * **No toca IndexedDB.** La base offline (`OfflineDatabaseService`) guarda visitas, fotos,
 * pings de ruta y conteos con una bandera `sincronizado`: puede haber **trabajo de campo que
 * todavía no llegó al servidor**, y borrarlo al cerrar sesión sería destruirlo. Eso necesita
 * decidirse aparte (¿se bloquea el cierre de sesión con pendientes? ¿se avisa?) y queda
 * declarado, no disimulado.
 */

/**
 * Claves de `localStorage` que **pertenecen al aparato, no a la persona**, y por eso
 * sobreviven al cierre de sesión. Todo lo demás se borra.
 *
 * ⚠️ `metas_kpi_v2` / `metas_furniture_v1` están acá por una razón incómoda: son configuración
 * (los rangos de los semáforos de KPI) que **sólo vive en el navegador**, sin respaldo en el
 * servidor. Borrarlas al cerrar sesión destruiría lo que alguien configuró. Que una
 * configuración del negocio viva por dispositivo ya es un defecto —dos personas ven metas
 * distintas— pero se arregla subiéndola al servidor, no borrándola acá.
 */
export const CLAVES_DEL_APARATO: readonly string[] = [
  'tradeMarketingThemeMode',
  'tradeMarketingThemeUserChoice',
  'md.table-density',
  'ec.unidad',
  'ex.unidad',
  'pwa-install-dismissed-at',
  'pwa-ios-hint-dismissed-at',
  // El verificador de mostrador ES el aparato: si olvida que es un kiosco al cerrar sesión,
  // deja de funcionar como kiosco.
  'tienda.verificador.kiosco',
  'tienda.verificador.contador',
  // Configuración local sin respaldo en servidor — ver la nota de arriba.
  'metas_kpi_v2',
  'metas_furniture_v1',
];

export interface RastroLimpiado {
  localStorage: number;
  sessionStorage: number;
  /** Caches de DATOS del service worker borrados (los de assets NO se tocan). */
  cachesApi: number;
  /** Lo que se DECLARA que sigue ahí y por qué. */
  declarado: string[];
}

/** Los caches de ngsw se nombran `ngsw:<scope>:<version>:data:...` y `...:assets`. */
const ES_CACHE_DE_DATOS = (nombre: string): boolean =>
  /ngsw/i.test(nombre) && /:data(:|$)/i.test(nombre);

/**
 * Borra el rastro de la sesión que se va. Es idempotente y **nunca lanza**: un cierre de sesión
 * que falla a la mitad es peor que uno que limpia de menos y lo dice.
 */
export async function limpiarRastroDeSesion(): Promise<RastroLimpiado> {
  const out: RastroLimpiado = { localStorage: 0, sessionStorage: 0, cachesApi: 0, declarado: [] };

  // ── localStorage: se conserva sólo lo declarado del aparato ────────────────
  try {
    const conservar = new Set(CLAVES_DEL_APARATO);
    const aBorrar: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && !conservar.has(k)) aBorrar.push(k);
    }
    for (const k of aBorrar) {
      try { localStorage.removeItem(k); out.localStorage++; } catch { /* clave trabada */ }
    }
  } catch {
    // Modo privado o almacenamiento bloqueado: no hay nada que borrar porque no hay nada guardado.
    out.declarado.push('localStorage inaccesible');
  }

  // ── sessionStorage: entero. Nada de acá es del aparato ─────────────────────
  try {
    out.sessionStorage = sessionStorage.length;
    sessionStorage.clear();
  } catch {
    out.declarado.push('sessionStorage inaccesible');
  }

  // ── Caches de DATOS del service worker ─────────────────────────────────────
  // Sólo los de datos. Los de assets llevan el código de la app: borrarlos dejaría sin app a un
  // aparato que cierra sesión estando sin red, y no contienen datos de nadie.
  try {
    if (typeof caches !== 'undefined') {
      const nombres = await caches.keys();
      const datos = nombres.filter(ES_CACHE_DE_DATOS);
      await Promise.all(datos.map((n) => caches.delete(n).catch(() => false)));
      out.cachesApi = datos.length;
      if (!datos.length && nombres.some((n) => /ngsw/i.test(n))) {
        // El SW está, pero ningún cache casó con el patrón: se DECLARA en vez de dar por hecho
        // que no había nada. Si ngsw cambia cómo nombra sus caches, esto es lo que avisa.
        out.declarado.push('service worker presente pero ningun cache de datos reconocido');
      }
    }
  } catch {
    out.declarado.push('CacheStorage inaccesible');
  }

  // Lo que a propósito sigue ahí.
  out.declarado.push('IndexedDB intacta: puede tener trabajo de campo sin sincronizar');
  return out;
}
