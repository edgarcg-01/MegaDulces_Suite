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
 * ── IndexedDB: se borra, salvo a quien hace trabajo de campo ─────────────────────────────────
 * Decisión del usuario (2026-09-28): **se borra para toda persona que no sea vendedor ni
 * colaborador.** La base offline guarda visitas, fotos, pings de ruta y conteos, o sea el
 * trabajo de quien anda en la calle; para quien trabaja en oficina no hay nada que conservar y
 * sí hay una foto de la tienda de otra persona esperando a la siguiente.
 *
 * ⚠️ Esta función **no decide quién es de campo**: recibe `borrarIndexedDb` ya resuelto. La
 * decisión vive en la app, que es la única que conoce los permisos de la persona y el esquema de
 * su base (cuántas filas quedaron sin sincronizar). Acá sólo se ejecuta y se informa.
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
  /** Bases de IndexedDB efectivamente borradas. */
  basesBorradas: string[];
  /**
   * Bases que el navegador NO pudo borrar porque alguien las tiene abiertas. Se DECLARAN: una
   * base bloqueada sigue ahí, y decir `borradas: []` sin más se leería como «no había ninguna».
   */
  basesBloqueadas: string[];
  /** Lo que se DECLARA que sigue ahí y por qué. */
  declarado: string[];
}

export interface OpcionesDeLimpieza {
  /**
   * Borrar además las bases de IndexedDB. Lo decide el llamador: sólo él sabe si esta persona
   * hace trabajo de campo y si quedó algo sin sincronizar.
   */
  borrarIndexedDb?: boolean;
  /** Cuánto se espera a cada borrado antes de declararlo bloqueado. */
  timeoutMs?: number;
}

/**
 * Las bases que esta suite crea. Es el **respaldo** para navegadores sin `indexedDB.databases()`
 * (Firefox no lo implementa): ahí no se pueden enumerar y hay que nombrarlas.
 */
const BASES_CONOCIDAS = ['TradeMarketingOfflineDB'];

/** Borra las bases de IndexedDB. Nunca cuelga: lo que no se puede borrar se declara. */
export async function borrarBasesIndexedDb(
  timeoutMs = 3000,
): Promise<{ borradas: string[]; bloqueadas: string[]; declarado: string[] }> {
  const r = { borradas: [] as string[], bloqueadas: [] as string[], declarado: [] as string[] };
  if (typeof indexedDB === 'undefined') return r;

  let nombres: string[] = [];
  try {
    const api = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
    if (typeof api.databases === 'function') {
      nombres = (await api.databases()).map((d) => d.name ?? '').filter(Boolean);
    } else {
      // Sin enumeración sólo se puede borrar lo que se sabe de memoria. Se declara, porque la
      // diferencia entre «no había bases» y «no se pudieron listar» es justamente el riesgo.
      nombres = [...BASES_CONOCIDAS];
      r.declarado.push('el navegador no enumera bases: se borraron solo las conocidas');
    }
  } catch {
    nombres = [...BASES_CONOCIDAS];
    r.declarado.push('fallo al enumerar bases: se borraron solo las conocidas');
  }

  for (const nombre of nombres) {
    const ok = await new Promise<boolean>((resolve) => {
      let resuelto = false;
      const fin = (v: boolean) => { if (!resuelto) { resuelto = true; resolve(v); } };
      // `deleteDatabase` se queda esperando si alguien tiene la base ABIERTA (Dexie la deja
      // abierta). Por eso hay tope: un cierre de sesión no puede quedarse colgado.
      const t = setTimeout(() => fin(false), timeoutMs);
      try {
        const req = indexedDB.deleteDatabase(nombre);
        req.onsuccess = () => { clearTimeout(t); fin(true); };
        req.onerror = () => { clearTimeout(t); fin(false); };
        req.onblocked = () => { clearTimeout(t); fin(false); };
      } catch { clearTimeout(t); fin(false); }
    });
    (ok ? r.borradas : r.bloqueadas).push(nombre);
  }
  return r;
}

/** Los caches de ngsw se nombran `ngsw:<scope>:<version>:data:...` y `...:assets`. */
const ES_CACHE_DE_DATOS = (nombre: string): boolean =>
  /ngsw/i.test(nombre) && /:data(:|$)/i.test(nombre);

/**
 * Borra el rastro de la sesión que se va. Es idempotente y **nunca lanza**: un cierre de sesión
 * que falla a la mitad es peor que uno que limpia de menos y lo dice.
 */
export async function limpiarRastroDeSesion(
  opts: OpcionesDeLimpieza = {},
): Promise<RastroLimpiado> {
  const out: RastroLimpiado = {
    localStorage: 0, sessionStorage: 0, cachesApi: 0,
    basesBorradas: [], basesBloqueadas: [], declarado: [],
  };

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

  // ── IndexedDB ──────────────────────────────────────────────────────────────
  if (opts.borrarIndexedDb) {
    const r = await borrarBasesIndexedDb(opts.timeoutMs);
    out.basesBorradas = r.borradas;
    out.basesBloqueadas = r.bloqueadas;
    out.declarado.push(...r.declarado);
    if (r.bloqueadas.length) {
      // Una base que no se pudo borrar SIGUE AHÍ con los datos de quien se fue. Decirlo es lo
      // único que permite notar que hubo que cerrar la conexión antes.
      out.declarado.push(`bases bloqueadas (siguen con datos): ${r.bloqueadas.join(', ')}`);
    }
  } else {
    out.declarado.push('IndexedDB intacta: trabajo de campo que puede no estar sincronizado');
  }
  return out;
}
