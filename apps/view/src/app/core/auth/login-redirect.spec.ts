import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, provideRouter, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { authGuard } from '../guards/auth.guard';
import { permissionGuard } from '../guards/permission.guard';
import { repartoGuard } from '../../modules/reparto/reparto.guard';
import { televentaGuard } from '../../modules/televenta/televenta.guard';
import { AuthService } from '../services/auth.service';
import { PermissionsService } from '../services/permissions.service';
import { Permission } from '../constants/permissions';
import { destinoValido, loginUrlTree } from './login-redirect';

/**
 * El destino SOBREVIVE a que te manden al login.
 *
 * El defecto que persigue: el interceptor guardaba '?returnUrl=' desde que se
 * arregló el "logout mudo", pero los guards navegaban al login pelados. Y el
 * login sin 'returnUrl' cae a '/projects'. Consecuencia medida: si la sesión se
 * caía MIENTRAS trabajabas volvías a tu pantalla, pero si abrías una ventana
 * nueva sobre esa misma URL perdías el destino y aterrizabas en "Mi trabajo" —
 * justo el caso de trabajar con dos ventanas abiertas.
 *
 * Las dos mitades se prueban por separado a propósito, porque fallan distinto:
 *   1. Los guards PRODUCEN el destino (la regresión de arriba).
 *   2. 'destinoValido' lo DESCARTA cuando volver ahí no tiene sentido o no es
 *      una ruta interna — sin esta mitad, el punto 1 se pone verde con un guard
 *      que reenvía cualquier cosa.
 */

/** Doble de sesión: lo único que los guards preguntan. */
function auth(autenticado: boolean, role = 'vendedor') {
  return { isAuthenticated: autenticado, user: () => ({ role_name: role, permissions: {} }) };
}

function snapshots(url: string) {
  return [{} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot] as const;
}

function montar(sesion: ReturnType<typeof auth>, perms: Partial<PermissionsService> = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: sesion },
      { provide: PermissionsService, useValue: { has: () => true, hasAny: () => true, ...perms } },
    ],
  });
}

/** Corre el guard y devuelve la URL serializada del redirect (o null si dejó pasar). */
function redirigeA(guard: () => unknown, url: string): string | null {
  const [route, state] = snapshots(url);
  const r = TestBed.runInInjectionContext(() => (guard as never as (a: unknown, b: unknown) => unknown)(route, state));
  if (r === true) return null;
  return TestBed.inject(Router).serializeUrl(r as UrlTree);
}

describe('El destino sobrevive al login', () => {
  afterEach(() => TestBed.resetTestingModule());

  describe('los guards se llevan a dónde ibas', () => {
    const DESTINO = '/compras/ordenes/9f3c1a2b';

    it('authGuard: sin sesión, el login sabe a dónde volver', () => {
      montar(auth(false));
      const url = redirigeA(authGuard as never, DESTINO);
      expect(url).toContain('/login');
      expect(url).toContain(`returnUrl=${encodeURIComponent(DESTINO)}`);
      expect(url).toContain('reason=required');
    });

    it('permissionGuard: sin sesión, ídem — no se pierde por pasar por otro guard', () => {
      montar(auth(false));
      const url = redirigeA(permissionGuard(Permission.COMPRAS_ORDENES_VER) as never, DESTINO);
      expect(url).toContain(`returnUrl=${encodeURIComponent(DESTINO)}`);
    });

    it('repartoGuard y televentaGuard: sin sesión, ídem', () => {
      montar(auth(false));
      expect(redirigeA(repartoGuard as never, '/reparto/surtido')).toContain('returnUrl=%2Freparto%2Fsurtido');
      TestBed.resetTestingModule();
      montar(auth(false));
      expect(redirigeA(televentaGuard as never, '/televenta/queue')).toContain('returnUrl=%2Fteleventa%2Fqueue');
    });

    /**
     * NEGATIVA. Sin esto, las tres de arriba se ponen verdes con un guard que
     * reenvía SIEMPRE, y eso sería un bucle: el 'customer_b2b' tiene sesión
     * válida y la app equivocada, así que devolverlo a la ruta lo vuelve a
     * echar. La ausencia del parámetro es la conducta correcta, no un olvido.
     */
    it('customer_b2b NO se lleva el destino — volver ahí sería un bucle', () => {
      montar(auth(true, 'customer_b2b'));
      const url = redirigeA(repartoGuard as never, '/reparto/surtido');
      expect(url).toContain('/login');
      expect(url).not.toContain('returnUrl');
    });

    it('con sesión y permiso, el guard deja pasar (no redirige a nada)', () => {
      montar(auth(true));
      expect(redirigeA(authGuard as never, DESTINO)).toBeNull();
    });
  });

  describe('qué destinos se descartan', () => {
    it('conserva una ruta interna', () => {
      expect(destinoValido('/finanzas/bancos?mes=2026-09')).toBe('/finanzas/bancos?mes=2026-09');
    });

    it('descarta el propio login y la pantalla de 403 — volver ahí es un rebote', () => {
      expect(destinoValido('/login')).toBeNull();
      expect(destinoValido('/sin-acceso?from=%2Fcompras')).toBeNull();
    });

    it('descarta lo que no es ruta interna', () => {
      expect(destinoValido(null)).toBeNull();
      expect(destinoValido('')).toBeNull();
      // '//host' lo lee el navegador como otro sitio, no como una ruta.
      expect(destinoValido('//evil.example/x')).toBeNull();
      expect(destinoValido('https://evil.example/x')).toBeNull();
    });
  });

  describe('la URL que se arma', () => {
    beforeEach(() => montar(auth(false)));

    it('sin destino no arrastra un returnUrl vacío', () => {
      const router = TestBed.inject(Router);
      const url = router.serializeUrl(loginUrlTree(router, null, 'expired'));
      expect(url).toBe('/login?reason=expired');
    });
  });
});
