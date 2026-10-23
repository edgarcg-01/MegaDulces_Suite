import { afterEach, describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { routes } from '../../app.routes';
import { RUTAS_PUBLICAS, esRutaPublica } from './rutas-publicas';
import { authInterceptor } from '../http/auth.interceptor';
import { AuthService } from '../services/auth.service';

/**
 * ⭐⭐ `[CG.203]` **El teléfono que viene a firmar NUNCA ve el login.**
 *
 * Edgar, 2026-10-23: *«pide usuario, y no debería pedir iniciar sesión»*. La cadena que lo
 * provocaba: token vencido en `localStorage` → el arranque pide `/users/me/access` → 401 →
 * el interceptor hace `logout()` y navega a `/login`. Estas pruebas clavan los tres eslabones.
 *
 * ⚠️ PRUEBA NEGATIVA (corrida el 2026-10-23): quitando `'firmar'` de `RUTAS_PUBLICAS` se ponen
 * ROJAS 4 de 6 —la 1, la 3 (el router tiene `firmar` sin guard y la lista no), la 4 (sale a
 * `/users/me/access`) y la 5 (pega el token y navega a `/login`)—; anulando el
 * `if (enRutaPublica())` del interceptor, sólo la 5. La 6 es el control: queda verde en los dos.
 */
describe('[CG.203] rutas públicas', () => {
  afterEach(() => { window.history.replaceState({}, '', '/'); localStorage.clear(); TestBed.resetTestingModule(); });

  it('1 · reconoce la pantalla de firma en todas las formas en que llega la URL', () => {
    for (const u of ['/firmar', '/firmar?c=ABC234&pase=x.y.z', '/firmar#top', '/firmar(panel:x)',
      'firmar', '/captura/tok123', '/empleo', '/empleo/liga/tok']) {
      expect(esRutaPublica(u), u).toBe(true);
    }
  });

  it('2 · NO confunde una ruta de la Suite que empieza parecido', () => {
    for (const u of ['/', '/login', '/finanzas/caja-general/firma', '/firmarx', '/finanzas/captura',
      '/rh/empleo', null, undefined, '']) {
      expect(esRutaPublica(u as string), String(u)).toBe(false);
    }
  });

  /**
   * ⛔ La lista y el router no pueden divergir, en ninguno de los dos sentidos. Una pantalla que se
   * declara pública acá y no existe es basura; una ruta al tope sin guard ni layout que NO está acá
   * es la próxima que va a mandar al login a alguien sin cuenta.
   */
  it('3 · la lista coincide con las rutas del tope del router que no tienen guard', () => {
    const exentas = new Set(['', '**', 'login', 'sin-acceso']);
    const sinGuard = routes
      .filter((r) => !r.redirectTo && !r.canActivate?.length && !r.canMatch?.length && !r.children?.length)
      .map((r) => String(r.path ?? '').split('/')[0])
      .filter((p) => !exentas.has(p));
    for (const p of new Set(sinGuard)) expect(RUTAS_PUBLICAS, `ruta sin guard «${p}» no declarada`).toContain(p);
    for (const p of RUTAS_PUBLICAS) {
      expect(routes.some((r) => String(r.path ?? '').split('/')[0] === p), `«${p}» no existe en el router`).toBe(true);
    }
  });

  function montarHttp(url: string) {
    window.history.replaceState({}, '', url);
    // El token que un teléfono arrastra: alguna vez inició sesión y ya venció.
    // Se arma acá y no como literal: un JWT escrito a mano lo marca gitleaks como secreto.
    localStorage.setItem('auth_token', ['cabecera', btoa(JSON.stringify({ exp: 1 })), 'firma'].join('.'));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    const auth = TestBed.inject(AuthService);
    const router = TestBed.inject(Router);
    const nav: string[] = [];
    router.navigateByUrl = ((u: unknown) => { nav.push(String(u)); return Promise.resolve(true); }) as Router['navigateByUrl'];
    return { auth, nav, http: TestBed.inject(HttpClient), ctrl: TestBed.inject(HttpTestingController) };
  }

  it('4 · en /firmar el arranque NO pregunta por la sesión: cero llamadas a /users/me/access', async () => {
    const { auth, ctrl } = montarHttp('/firmar?c=ABC234&pase=x.y.z');
    auth.refreshAccess();
    await auth.resolverAccesoInicial();
    ctrl.expectNone((r) => r.url.includes('/users/me/access'));
    ctrl.verify();
  });

  it('5 · en /firmar un 401 no navega al login, no cierra la sesión y no se pega el token', () => {
    const { auth, nav, http, ctrl } = montarHttp('/firmar?c=ABC234&pase=x.y.z');
    const antes = auth.token();
    http.get('/api/cualquier-cosa').subscribe({ error: () => undefined });
    const req = ctrl.expectOne('/api/cualquier-cosa');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(nav.some((u) => u.includes('/login'))).toBe(false);
    expect(auth.token()).toBe(antes);
  });

  it('6 · CONTROL: fuera de una pantalla pública el 401 SÍ manda al login (el candado sigue puesto)', () => {
    const { nav, http, ctrl } = montarHttp('/finanzas/caja-general');
    http.get('/api/cualquier-cosa').subscribe({ error: () => undefined });
    const req = ctrl.expectOne('/api/cualquier-cosa');
    expect(req.request.headers.get('Authorization')).toContain('Bearer ');
    req.flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(nav.some((u) => u.includes('/login'))).toBe(true);
  });
});
