import { describe, it, expect } from 'vitest';
import { fallaDeCarga, recursoDe, clasificarFallaDeCarga } from './global-error-handler';
import { AVISOS } from './app-error-outlet.component';
import { AppErrorService } from './app-error.service';

/**
 * `[AUD.6]` — el aviso de carga no puede afirmar un despliegue que no ocurrió.
 *
 * ⭐ La prueba que importa es la NEGATIVA: antes de este cambio, los cuatro casos de abajo
 * terminaban en `stale-version` y la pantalla decía «se publicó una versión». Tres de ellos
 * eran mentira. Por eso cada caso que NO es 404 verifica explícitamente que el veredicto no
 * sea `stale-version`, no sólo que sea el suyo.
 */

const MSG_VITE = 'TypeError: Failed to fetch dynamically imported module: https://megadulcessuite.com/chunk-ABC123.js';

function respuesta(status: number): Response {
  return { status } as Response;
}

describe('[AUD.6] la falla de carga se detecta, pero no se interpreta sola', () => {
  it('reconoce los cinco textos de bundler y el ChunkLoadError', () => {
    expect(fallaDeCarga(new Error('x'), MSG_VITE)).toBe(true);
    expect(fallaDeCarga({ name: 'ChunkLoadError' }, 'cualquier cosa')).toBe(true);
    expect(fallaDeCarga(null, 'Error loading chunk 42 failed')).toBe(true);
    expect(fallaDeCarga(null, 'importing a module script failed')).toBe(true);
  });

  it('NO toma por falla de carga un error cualquiera', () => {
    expect(fallaDeCarga(new Error('boom'), 'TypeError: x is not a function')).toBe(false);
  });

  it('saca del mensaje el archivo que falló', () => {
    expect(recursoDe(null, MSG_VITE)).toBe('https://megadulcessuite.com/chunk-ABC123.js');
    expect(recursoDe({ request: 'https://megadulcessuite.com/otro.js' }, 'sin url')).toBe(
      'https://megadulcessuite.com/otro.js',
    );
    expect(recursoDe(null, 'sin ninguna url adentro')).toBeNull();
  });
});

describe('[AUD.6] la causa la decide el servidor, no el navegador', () => {
  const url = 'https://megadulcessuite.com/chunk-ABC123.js';

  it('404 es el ÚNICO caso que afirma versión nueva', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: async () => respuesta(404),
      enLinea: () => true,
    });
    expect(kind).toBe('stale-version');
  });

  it('410 también: el archivo ya no está', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: async () => respuesta(410),
      enLinea: () => true,
    });
    expect(kind).toBe('stale-version');
  });

  it('⭐ sin conexión NO afirma versión nueva', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: async () => { throw new Error('no debería preguntarse estando offline'); },
      enLinea: () => false,
    });
    expect(kind).toBe('load-offline');
    expect(kind).not.toBe('stale-version');
  });

  it('⭐ la red se cae mientras se pregunta: tampoco afirma versión nueva', async () => {
    let online = true;
    const kind = await clasificarFallaDeCarga(url, {
      fetch: async () => { online = false; throw new TypeError('Failed to fetch'); },
      enLinea: () => online,
    });
    expect(kind).toBe('load-offline');
    expect(kind).not.toBe('stale-version');
  });

  it('⭐ el servidor responde 503: tampoco afirma versión nueva', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: async () => respuesta(503),
      enLinea: () => true,
    });
    expect(kind).toBe('load-server');
    expect(kind).not.toBe('stale-version');
  });

  it('⭐ el archivo SÍ está (200): fue pasajero y se DECLARA, no se inventa', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: async () => respuesta(200),
      enLinea: () => true,
    });
    expect(kind).toBe('load-unknown');
    expect(kind).not.toBe('stale-version');
  });

  it('⭐ sin archivo que preguntar se declara indeterminado, no versión nueva', async () => {
    const kind = await clasificarFallaDeCarga(null, {
      fetch: async () => respuesta(404),
      enLinea: () => true,
    });
    expect(kind).toBe('load-unknown');
    expect(kind).not.toBe('stale-version');
  });

  it('si el servidor no contesta a tiempo, no se queda colgado ni inventa', async () => {
    const kind = await clasificarFallaDeCarga(url, {
      fetch: () => new Promise<Response>(() => { /* nunca resuelve */ }),
      enLinea: () => true,
      timeoutMs: 20,
    });
    expect(kind).toBe('load-unknown');
    expect(kind).not.toBe('stale-version');
  });
});

describe('[AUD.6] ningún texto afirma lo que no se comprobó', () => {
  const PALABRAS_DE_DESPLIEGUE = /versi[óo]n nueva|se public[óo]|actualizaci[óo]n lista/i;

  it('sólo el aviso de versión nueva habla de un despliegue', () => {
    for (const [kind, aviso] of Object.entries(AVISOS)) {
      const dice = PALABRAS_DE_DESPLIEGUE.test(`${aviso.rotulo} ${aviso.titulo}`);
      expect(dice, `${kind}: el rótulo o el título hablan de un despliegue`).toBe(
        kind === 'stale-version',
      );
    }
  });

  it('los tres que no son versión nueva lo niegan explícitamente', () => {
    expect(AVISOS['load-offline'].texto).toMatch(/no se public[óo] ninguna versi[óo]n nueva/i);
    expect(AVISOS['load-server'].texto).toMatch(/no es una versi[óo]n nueva/i);
    expect(AVISOS['load-unknown'].texto).toMatch(/no fue una versi[óo]n nueva/i);
  });

  it('sólo manda a recargar cuando recargar sirve', () => {
    // `[AUD.7]` cambió el booleano por el tipo de acción, porque aparecieron TRES salidas y
    // no dos: recargar, reintentar y limpiar la copia local.
    expect(AVISOS['stale-version'].accionTipo).toBe('recargar');
    expect(AVISOS['load-offline'].accionTipo).toBe('reintentar');
    expect(AVISOS['load-server'].accionTipo).toBe('reintentar');
    expect(AVISOS['load-unknown'].accionTipo).toBe('reintentar');
    expect(AVISOS['local-copy'].accionTipo).toBe('reparar');
  });

  it('mientras se pregunta no se afirma ninguna causa', () => {
    expect(AVISOS['load-checking'].texto).not.toMatch(PALABRAS_DE_DESPLIEGUE);
    expect(AVISOS['load-checking'].texto).not.toMatch(/conexi[óo]n|servidor/i);
  });
});

describe('[AUD.6] el aviso se resuelve sobre el mismo error, no sobre otro', () => {
  it('cambia la causa del error que se está mostrando', () => {
    const svc = new AppErrorService();
    const e = svc.report('load-checking', MSG_VITE);
    svc.resolver(e.id, 'load-offline');
    expect(svc.current()?.kind).toBe('load-offline');
    expect(svc.current()?.id).toBe(e.id);
  });

  it('un veredicto viejo NO pisa un error posterior', () => {
    const svc = new AppErrorService();
    const viejo = svc.report('load-checking', MSG_VITE);
    const nuevo = svc.report('load-checking', 'otro chunk: Loading chunk 9 failed');
    svc.resolver(viejo.id, 'stale-version');
    expect(svc.current()?.id).toBe(nuevo.id);
    expect(svc.current()?.kind).toBe('load-checking');
  });

  it('una falla de carga gana sobre un error inesperado posterior', () => {
    const svc = new AppErrorService();
    const carga = svc.report('load-checking', MSG_VITE);
    svc.report('unexpected', 'TypeError: x is not a function');
    expect(svc.current()?.id).toBe(carga.id);
  });
});
