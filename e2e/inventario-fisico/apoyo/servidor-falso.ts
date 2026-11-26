import type { Page, Route } from '@playwright/test';
import type { Persona } from './personas';

/**
 * El servidor falso: **toda** llamada a `/api` se contesta dentro del navegador.
 *
 * ⛔⛔ La garantía de seguridad de esta suite vive acá, y es una sola frase:
 * **`route.fulfill()` y `route.abort()` NO salen a la red.** Mientras el patrón atrapa-todo
 * esté puesto, ninguna peticion de la aplicacion llega a produccion — ni de lectura.
 * Lo unico que se descarga de verdad es el bundle estatico (HTML, JS, CSS), que es publico.
 *
 * Y una red de seguridad encima: **cualquier peticion que no sea GET se aborta y queda
 * registrada**, para que una prueba que por error intente escribir salga roja en vez de
 * escribir.
 */

/** Lo que el servidor falso vio pasar. Las pruebas lo revisan al final. */
export interface Bitacora {
  /** Llamadas que ningun mock atendio: la prueba decide si eso importa. */
  sinSimular: string[];
  /** ⛔ Cualquier intento de escritura. Tiene que quedar SIEMPRE vacio. */
  escrituras: string[];
  /** Todo lo que paso por `/api`, en orden. */
  todas: string[];
}

/** Un JWT de mentira: el front **decodifica** el payload y no verifica la firma. */
export function tokenDe(persona: Persona): string {
  const ahora = Math.floor(Date.now() / 1000);
  const payload = {
    sub: `00000000-0000-0000-0000-0000000000${Math.abs(hash(persona.username)) % 90 + 10}`,
    username: persona.username,
    rol: persona.role_name,
    role_name: persona.role_name,
    tenant_id: '00000000-0000-0000-0000-00000000d01c',
    ...(persona.warehouse_code ? { warehouse_code: persona.warehouse_code } : {}),
    permissions: persona.permissions,
    iat: ahora,
    exp: ahora + 12 * 3600,
  };
  // ⚠️ `atob` del navegador NO entiende base64url. El payload es ASCII puro a proposito
  // (sin acentos en los nombres de prueba), asi que base64 estandar se decodifica bien.
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.firma-de-mentira`;
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

/** Una respuesta simulada: ruta (substring o regex) → cuerpo, o una funcion. */
export interface Mock {
  /** Se compara contra la URL completa. */
  cuando: string | RegExp;
  /** Codigo HTTP; 200 por defecto. */
  estado?: number;
  /** Cuerpo JSON, o una funcion que lo arma a partir de la URL. */
  cuerpo?: unknown | ((url: string) => unknown);
  /** Simula que la peticion nunca contesta (para probar el estado «cargando»). */
  colgar?: boolean;
}

export interface Sesion {
  persona: Persona;
  mocks?: Mock[];
  /** Respuestas a `/api` que no interesan y no deben ensuciar la bitacora. */
  ignorar?: (string | RegExp)[];
}

const coincide = (url: string, patron: string | RegExp) =>
  typeof patron === 'string' ? url.includes(patron) : patron.test(url);

/**
 * Deja la pagina lista: sesion fabricada + `/api` simulada.
 * Devuelve la bitacora, que se revisa al final de cada prueba.
 */
export async function prepararSesion(page: Page, s: Sesion): Promise<Bitacora> {
  const bitacora: Bitacora = { sinSimular: [], escrituras: [], todas: [] };
  const token = tokenDe(s.persona);

  // La sesion se siembra ANTES de que corra un solo script de la aplicacion.
  await page.addInitScript((t) => {
    try { localStorage.setItem('auth_token', t); } catch { /* modo privado */ }
  }, token);

  // ── El atrapa-todo de `/api`. Los mocks especificos se registran DESPUES, y por eso
  //    se evaluan antes.
  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = req.url();
    const metodo = req.method();
    bitacora.todas.push(`${metodo} ${url}`);

    if (metodo !== 'GET') {
      // ⛔ Red de seguridad: una escritura nunca sale, y la prueba se entera.
      bitacora.escrituras.push(`${metodo} ${url}`);
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'servidor falso: las escrituras estan bloqueadas' }),
      });
    }

    // El mapa de permisos que `[ID.30]` resuelve antes de la primera navegacion.
    if (url.includes('/users/me/access')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permissions: s.persona.permissions }),
      });
    }

    if ((s.ignorar || []).some((pat) => coincide(url, pat))) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }

    bitacora.sinSimular.push(`${metodo} ${url}`);
    // Se contesta igual —vacio— para que la pantalla siga su curso y la prueba pueda
    // mirar la bitacora, en vez de morir en el primer fetch inesperado.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  for (const m of s.mocks || []) {
    await page.route('**/api/**', async (route: Route) => {
      const url = route.request().url();
      if (!coincide(url, m.cuando)) return route.fallback();
      if (m.colgar) return new Promise<void>(() => { /* nunca contesta, a proposito */ });
      const cuerpo = typeof m.cuerpo === 'function'
        ? (m.cuerpo as (u: string) => unknown)(url)
        : m.cuerpo;
      return route.fulfill({
        status: m.estado ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(cuerpo ?? null),
      });
    });
  }

  return bitacora;
}

/**
 * ⛔ Se llama al final de CADA prueba. Si alguna escritura intento salir, la prueba se cae
 * aunque sus aserciones hayan pasado: una suite que escribe contra prod no es una suite.
 */
export function exigirQueNadaEscribio(bitacora: Bitacora): void {
  const relevantes = bitacora.escrituras.filter(
    (e) => !ESCRITURAS_DE_LA_CASA.some((pat) => pat.test(e)),
  );
  if (relevantes.length) {
    throw new Error(
      `El servidor falso bloqueo ${relevantes.length} escritura(s) que no deberian ` +
      `haber ocurrido:\n  ${relevantes.join('\n  ')}`,
    );
  }
}

/**
 * Escrituras que la propia suite hace al entrar a cualquier pantalla y que **no** son de la
 * prueba. ⚠️ **Se bloquean igual** —nada sale a la red—; lo unico que cambia es que no tumban
 * la prueba. Medido el 2026-11-25: al abrir la lista de folios sale un
 * `POST /api/telemetry/suite`.
 *
 * ⛔ Esta lista es corta a proposito y **no se amplia para callar un fallo**: si aparece una
 * escritura nueva, primero se averigua de donde sale.
 */
const ESCRITURAS_DE_LA_CASA: RegExp[] = [
  /\/api\/telemetry\//,
  /\/api\/uso(\/|$|\?)/,
];
