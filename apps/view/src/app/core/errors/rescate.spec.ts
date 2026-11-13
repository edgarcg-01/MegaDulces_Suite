import { describe, it, expect, vi } from 'vitest';
import {
  MARCA_REPARADO,
  hayServiceWorker,
  yaSeReparo,
  purgarCopiaLocal,
  repararYRecargar,
  versionDelServidor,
  bundleDeLaPestaña,
} from './rescate';
import { clasificarFallaDeCarga } from './global-error-handler';
import { AVISOS, AVISO_REPARADO_Y_FALLA } from './app-error-outlet.component';

/**
 * `[AUD.7]` — recargar no arregla una copia local rota.
 *
 * ⭐ La prueba que importa vuelve a ser la NEGATIVA, y acá son dos:
 *   1. **sin service worker no se culpa a la copia local** — sin ese testigo no hay nadie
 *      entre el navegador y el servidor, y acusarlo sería inventar una causa;
 *   2. **no se repara dos veces** — una cura que ya falló no se vuelve a ofrecer.
 */

function storeFalso(inicial: Record<string, string> = {}) {
  const datos = new Map(Object.entries(inicial));
  return {
    getItem: (k: string) => datos.get(k) ?? null,
    setItem: (k: string, v: string) => { datos.set(k, v); },
    removeItem: (k: string) => { datos.delete(k); },
    clear: () => datos.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

function navConSw(opts: { controlado: boolean; registros?: { unregister: () => Promise<boolean> }[] }) {
  return {
    serviceWorker: {
      controller: opts.controlado ? {} : null,
      getRegistrations: () => Promise.resolve(opts.registros ?? []),
    },
  } as unknown as Navigator;
}

function cachesFalso(claves: string[]) {
  const borradas: string[] = [];
  const api = {
    keys: () => Promise.resolve(claves),
    delete: (k: string) => { borradas.push(k); return Promise.resolve(true); },
  } as unknown as CacheStorage;
  return { api, borradas };
}

function docCon(bundle: string | null): Document {
  return {
    querySelectorAll: () => (bundle ? [{ src: `https://x/${bundle}` }] : []),
  } as unknown as Document;
}

describe('[AUD.7] purgar la copia local', () => {
  it('da de baja TODOS los service workers y vacía TODAS las cachés', async () => {
    const bajas: number[] = [];
    const registros = [0, 1, 2].map((i) => ({
      unregister: () => { bajas.push(i); return Promise.resolve(true); },
    }));
    const { api, borradas } = cachesFalso(['ngsw:db', 'ngsw:1:assets', 'otra']);

    const r = await purgarCopiaLocal({ nav: navConSw({ controlado: true, registros }), cacheStorage: api });

    expect(bajas).toEqual([0, 1, 2]);
    expect(borradas).toEqual(['ngsw:db', 'ngsw:1:assets', 'otra']);
    expect(r).toEqual({ registros: 3, cachés: 3 });
  });

  it('no explota si el navegador no soporta nada de eso', async () => {
    const r = await purgarCopiaLocal({ nav: {} as Navigator, cacheStorage: undefined });
    expect(r).toEqual({ registros: 0, cachés: 0 });
  });

  it('⛔ NO toca la sesión: lo que hay en localStorage sobrevive a la reparación', async () => {
    // La cura no puede costar el trabajo de la persona. El rescate de arranque de `index.html`
    // sí limpia la sesión —ahí la app ni montó—, pero acá está viva y alguien capturando.
    if (typeof localStorage === 'undefined') {
      expect.unreachable('el entorno de pruebas no expone localStorage');
    }
    localStorage.setItem('auth_token', 'centinela-de-sesión');
    await repararYRecargar({
      store: storeFalso(),
      nav: navConSw({ controlado: true, registros: [{ unregister: () => Promise.resolve(true) }] }),
      cacheStorage: cachesFalso(['ngsw:db']).api,
      recargar: () => { /* no se navega en la prueba */ },
    });
    expect(localStorage.getItem('auth_token')).toBe('centinela-de-sesión');
    localStorage.removeItem('auth_token');
  });
});

describe('[AUD.7] reparar y recargar', () => {
  it('marca ANTES de purgar, así una purga colgada no repite el ciclo', async () => {
    const store = storeFalso();
    const nav = {
      serviceWorker: {
        controller: {},
        // Una purga que nunca contesta: es el caso que el cinturón tiene que cubrir.
        getRegistrations: () => new Promise<never[]>(() => { /* jamás resuelve */ }),
      },
    } as unknown as Navigator;

    vi.useFakeTimers();
    const destinos: string[] = [];
    const corriendo = repararYRecargar({ store, nav, recargar: (u) => destinos.push(u) });

    // La marca ya está puesta aunque la purga siga en el aire.
    expect(store.getItem(MARCA_REPARADO)).toBeTruthy();
    expect(yaSeReparo({ store })).toBe(true);

    await vi.advanceTimersByTimeAsync(6000);
    await corriendo;
    vi.useRealTimers();

    expect(destinos).toHaveLength(1);
    expect(destinos[0]).toMatch(/__r=\d+/);
  });

  it('recarga UNA sola vez aunque la purga termine justo con el cinturón', async () => {
    const store = storeFalso();
    const destinos: string[] = [];
    await repararYRecargar({
      store,
      nav: navConSw({ controlado: true, registros: [] }),
      cacheStorage: cachesFalso([]).api,
      recargar: (u) => destinos.push(u),
    });
    expect(destinos).toHaveLength(1);
  });

  it('sin sessionStorage se asume que YA se reparó — no se repara de más', () => {
    const roto = {
      getItem: () => { throw new Error('modo privado'); },
      setItem: () => { throw new Error('modo privado'); },
    } as unknown as Storage;
    expect(yaSeReparo({ store: roto })).toBe(true);
  });
});

describe('[AUD.7] qué versión corre esta pestaña', () => {
  const html = (b: string) => ({ ok: true, text: () => Promise.resolve(`<script src="/${b}">`) }) as Response;

  it('saca el bundle de los script de la propia pestaña', () => {
    expect(bundleDeLaPestaña(docCon('main-AAA111.js'))).toBe('main-AAA111.js');
    expect(bundleDeLaPestaña(docCon(null))).toBe('');
  });

  it('nombres distintos = esta pestaña quedó vieja', async () => {
    const v = await versionDelServidor({
      documento: docCon('main-VIEJO1.js'),
      fetch: (() => Promise.resolve(html('main-NUEVO2.js'))) as unknown as typeof fetch,
    });
    expect(v).toBe('vieja');
  });

  it('mismo nombre = está al día', async () => {
    const v = await versionDelServidor({
      documento: docCon('main-IGUAL1.js'),
      fetch: (() => Promise.resolve(html('main-IGUAL1.js'))) as unknown as typeof fetch,
    });
    expect(v).toBe('al-dia');
  });

  it('si no se puede preguntar, se DECLARA — no se asume ninguna de las dos', async () => {
    const caido = await versionDelServidor({
      documento: docCon('main-AAA111.js'),
      fetch: (() => Promise.reject(new Error('sin red'))) as unknown as typeof fetch,
    });
    expect(caido).toBe('no-se-pudo');

    const sinScript = await versionDelServidor({
      documento: docCon(null),
      fetch: (() => Promise.resolve(html('main-AAA111.js'))) as unknown as typeof fetch,
    });
    expect(sinScript).toBe('no-se-pudo');
  });
});

describe('[AUD.7] el veredicto cuando el servidor NO acusa al archivo', () => {
  const url = 'https://megadulcessuite.com/chunk-ABC123.js';
  const enLinea = () => true;

  /** Contesta 200 al HEAD del chunk y sirve el index.html que se le pida. */
  function fetchQue(indexBundle: string): typeof fetch {
    return ((entrada: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return Promise.resolve({ status: 200 } as Response);
      return Promise.resolve({ ok: true, text: () => Promise.resolve(`<script src="/${indexBundle}">`) } as Response);
    }) as unknown as typeof fetch;
  }

  it('el archivo está, la versión es la de hoy y hay service worker → la copia local', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: fetchQue('main-HOY999.js'),
      enLinea,
      documento: docCon('main-HOY999.js'),
      nav: navConSw({ controlado: true }),
    });
    expect(kind).toBe('local-copy');
  });

  it('⛔ SIN service worker NO se culpa a la copia local: se declara indeterminado', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: fetchQue('main-HOY999.js'),
      enLinea,
      documento: docCon('main-HOY999.js'),
      nav: navConSw({ controlado: false }),
    });
    expect(kind).toBe('load-unknown');
    expect(kind).not.toBe('local-copy');
    expect(kind).not.toBe('stale-version');
  });

  it('el archivo está pero la pestaña corre un bundle viejo → sí hubo versión nueva', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: fetchQue('main-NUEVO2.js'),
      enLinea,
      documento: docCon('main-VIEJO1.js'),
      nav: navConSw({ controlado: true }),
    });
    expect(kind).toBe('stale-version');
  });

  it('sin archivo que preguntar la medición SIGUE: compara versiones igual', async () => {
    const kind = await clasificarFallaDeCarga(null, {
      fetch: fetchQue('main-NUEVO2.js'),
      enLinea,
      documento: docCon('main-VIEJO1.js'),
      nav: navConSw({ controlado: true }),
    });
    expect(kind).toBe('stale-version');
  });

  it('sin conexión gana el offline antes de medir nada local', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: fetchQue('main-HOY999.js'),
      enLinea: () => false,
      documento: docCon('main-HOY999.js'),
      nav: navConSw({ controlado: true }),
    });
    expect(kind).toBe('load-offline');
  });
});

describe('[AUD.7] lo que el aviso promete', () => {
  it('la copia local ofrece LIMPIAR, no recargar: recargar está medido que no saca a nadie', () => {
    expect(AVISOS['local-copy'].accionTipo).toBe('reparar');
    expect(AVISOS['local-copy'].texto).toMatch(/[Rr]ecargar no la arregla/);
  });

  it('sólo la versión nueva manda a recargar', () => {
    const recargan = Object.entries(AVISOS)
      .filter(([, a]) => a.accionTipo === 'recargar')
      .map(([k]) => k);
    expect(recargan).toEqual(['stale-version']);
  });

  it('después de limpiar y fallar, el aviso lo ADMITE y no vuelve a ofrecer la misma cura', () => {
    expect(AVISO_REPARADO_Y_FALLA.accionTipo).not.toBe('reparar');
    expect(AVISO_REPARADO_Y_FALLA.texto).toMatch(/volvió a fallar/);
    expect(AVISO_REPARADO_Y_FALLA.texto).toMatch(/no la podemos determinar/);
  });

  it('ningún aviso salvo el de versión nueva menciona un despliegue', () => {
    for (const [kind, a] of Object.entries(AVISOS)) {
      if (kind === 'stale-version') continue;
      expect(`${a.rotulo} ${a.titulo} ${a.texto}`).not.toMatch(/se publicó una versión|actualización lista/i);
    }
  });

  it('sin controlador no hay service worker al que culpar', () => {
    expect(hayServiceWorker({ nav: navConSw({ controlado: false }) })).toBe(false);
    expect(hayServiceWorker({ nav: navConSw({ controlado: true }) })).toBe(true);
    expect(hayServiceWorker({ nav: {} as Navigator })).toBe(false);
  });
});
