/**
 * Rescate de la copia local: borrar lo que este dispositivo tiene guardado y volver a cargar.
 *
 * ⛔⛔ **Recargar NO arregla una copia local rota, y eso está MEDIDO** (`[AUD.7]`, 2026-11-13).
 * Un teléfono en producción mostraba el aviso de `[AUD.6]` con causa «sin determinar», y
 * recargar lo devolvía al mismo aviso, una y otra vez. La explicación está en la configuración
 * del service worker de esta app (`apps/view/ngsw-config.json`):
 *
 *  - el grupo `chunks` toma **`/*.js`**, así que los trozos de código de cada pantalla los
 *    sirve el service worker desde su propia caché, no la red;
 *  - ngsw verifica cada archivo contra el **hash de su manifiesto**. Si el que tiene guardado
 *    no casa y el que baja tampoco (porque su manifiesto quedó viejo), la carga falla;
 *  - y el service worker **sobrevive a la recarga**. Vuelve a servir exactamente lo mismo.
 *
 * Por eso el archivo puede estar perfecto en el servidor —contesta 200— y la pantalla no
 * cargar nunca. El único que puede romper ese ciclo es borrar la copia: dar de baja los
 * service workers y vaciar las cachés.
 *
 * ⭐ **Lo que acá NO se toca: `localStorage`.** El rescate de arranque de `index.html` sí lo
 * limpia, y con eso cierra la sesión — es el precio aceptable cuando la app ni siquiera montó.
 * Acá la app está viva y la persona está trabajando: tirarle la sesión encima sería cobrarle
 * un defecto nuestro. Se borra el código guardado, no su trabajo.
 */

/** Marca de que ya se reparó en esta pestaña. Sirve para NO entrar en bucle. */
export const MARCA_REPARADO = 'md.reparo-copia.v1';

export interface RescateDeps {
  nav?: Navigator;
  cacheStorage?: CacheStorage;
  store?: Storage;
  recargar?: (url: string) => void;
  fetch?: typeof fetch;
  documento?: Document;
}

/** ¿Hay un service worker controlando ESTA página? Sin él, la copia local no es sospechosa. */
export function hayServiceWorker(deps: RescateDeps = {}): boolean {
  const nav = deps.nav ?? globalThis.navigator;
  try {
    return !!nav?.serviceWorker?.controller;
  } catch {
    return false;
  }
}

/**
 * ¿Ya se reparó en esta pestaña y volvió a fallar?
 *
 * ⭐ Es la diferencia entre ofrecer una salida y mentir dos veces. Si ya se limpió la copia y
 * la pantalla falla igual, la causa es otra y hay que DECIRLO, no volver a limpiar: una
 * reparación que se repite sola es una pantalla que parpadea para siempre y esconde el motivo.
 */
export function yaSeReparo(deps: RescateDeps = {}): boolean {
  try {
    const store = deps.store ?? globalThis.sessionStorage;
    return !!store?.getItem(MARCA_REPARADO);
  } catch {
    // Modo privado o storage bloqueado: sin marca no se puede garantizar el tope de un
    // intento, así que se asume que YA se reparó. Preferimos no reparar de más.
    return true;
  }
}

/**
 * Borra la copia local de código: da de baja los service workers y vacía las cachés.
 *
 * Devuelve lo que efectivamente borró, para poder declararlo en el detalle del error en vez
 * de afirmar que se limpió algo que quizá no existía.
 */
export async function purgarCopiaLocal(
  deps: RescateDeps = {},
): Promise<{ registros: number; cachés: number }> {
  const nav = deps.nav ?? globalThis.navigator;
  const cacheStorage = deps.cacheStorage ?? (globalThis as { caches?: CacheStorage }).caches;

  let registros = 0;
  let cachés = 0;

  try {
    const regs = (await nav?.serviceWorker?.getRegistrations?.()) ?? [];
    const bajas = await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    registros = bajas.filter(Boolean).length;
  } catch { /* sin permiso o sin soporte: se sigue con las cachés */ }

  try {
    const claves = cacheStorage ? await cacheStorage.keys() : [];
    const borradas = await Promise.all(claves.map((k) => cacheStorage!.delete(k).catch(() => false)));
    cachés = borradas.filter(Boolean).length;
  } catch { /* idem */ }

  return { registros, cachés };
}

/** Cuánto se espera a que la purga termine antes de recargar igual. */
const TOPE_PURGA_MS = 6000;

/**
 * Repara y recarga: marca, purga, y recarga con un parámetro nuevo.
 *
 * ⚠️ **Se marca ANTES de purgar, no después.** Si la purga se cuelga y el cinturón recarga, la
 * marca tiene que estar puesta: sin eso la pestaña nueva creería que es su primer intento y
 * repetiría el ciclo. Marcar primero cuesta, como mucho, una reparación que no se intentó.
 *
 * ⚠️ `location.replace` y no `reload`: recargar vuelve a pedir la MISMA URL, que es justo la
 * que falló; y con un parámetro distinto además se esquiva cualquier caché intermedia.
 */
export async function repararYRecargar(deps: RescateDeps = {}): Promise<void> {
  try {
    const store = deps.store ?? globalThis.sessionStorage;
    store?.setItem(MARCA_REPARADO, new Date().toISOString());
  } catch { /* sin storage: el tope lo pone `yaSeReparo`, que sin marca devuelve true */ }

  const irA = deps.recargar ?? ((url: string) => globalThis.location?.replace(url));
  const destino = `${globalThis.location?.pathname ?? '/'}${separador()}__r=${Date.now()}`;

  let hecho = false;
  const recargarUnaVez = () => { if (!hecho) { hecho = true; irA(destino); } };

  // Cinturón: si una promesa se cuelga, se recarga igual. Quedarse esperando a la limpieza
  // deja a la persona mirando un botón que ya no hace nada.
  const cinturon = new Promise<void>((r) => setTimeout(r, TOPE_PURGA_MS));
  await Promise.race([purgarCopiaLocal(deps).then(() => undefined), cinturon]);
  recargarUnaVez();
}

function separador(): string {
  const q = globalThis.location?.search ?? '';
  return q ? `${q}&` : '?';
}

/**
 * ¿La pestaña está corriendo una versión más vieja que la que sirve el servidor?
 *
 * Compara el `main-*.js` que esta pestaña cargó contra el que nombra el `index.html` de hoy.
 * El nombre lleva hash, así que dos nombres distintos son dos builds distintos.
 *
 * ⭐ **Que el service worker intercepte esta consulta NO rompe la decisión**, y conviene
 * decirlo porque es contraintuitivo: `cache: 'no-store'` es una directiva HTTP y un service
 * worker la ignora, así que podría contestar con su propio `index.html` viejo. En ese caso los
 * dos nombres coinciden, el veredicto es «al día», y con un service worker presente el
 * resultado es `local-copy` — cuya cura es exactamente la que hacía falta. El peor caso de la
 * intercepción es llegar a la misma puerta por el otro pasillo.
 */
export async function versionDelServidor(
  deps: RescateDeps = {},
): Promise<'vieja' | 'al-dia' | 'no-se-pudo'> {
  const hacerFetch = deps.fetch ?? globalThis.fetch?.bind(globalThis);
  const doc = deps.documento ?? globalThis.document;
  if (!hacerFetch || !doc) return 'no-se-pudo';

  const aquí = bundleDeLaPestaña(doc);
  if (!aquí) return 'no-se-pudo';

  try {
    const r = await hacerFetch('/index.html', { cache: 'no-store' });
    if (!r.ok) return 'no-se-pudo';
    const html = await r.text();
    const allá = (/main-[A-Za-z0-9_-]+\.js/.exec(html) ?? [''])[0];
    if (!allá) return 'no-se-pudo';
    return allá === aquí ? 'al-dia' : 'vieja';
  } catch {
    return 'no-se-pudo';
  }
}

/** El `main-*.js` que esta pestaña está ejecutando, sacado de sus propios `<script>`. */
export function bundleDeLaPestaña(doc: Document): string {
  const src = Array.from(doc.querySelectorAll('script[src]'))
    .map((e) => (e as HTMLScriptElement).src)
    .find((u) => /\/main-[A-Za-z0-9_-]+\.js/.test(u));
  return src ? (/main-[A-Za-z0-9_-]+\.js/.exec(src) ?? [''])[0] : '';
}
