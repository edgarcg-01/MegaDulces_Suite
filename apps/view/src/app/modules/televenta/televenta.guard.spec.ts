import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, provideRouter, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { televentaGuard } from './televenta.guard';
import { TELEMARKETING_LANDING, telemarketingHomeGuard } from '../../core/guards/permission.guard';
import { AuthService } from '../../core/services/auth.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';

/**
 * `[AX.16]` La puerta de `/telemarketing` y su índice.
 *
 * Facturación TM se mudó de `/comercial/documentos` a `/telemarketing/documentos`. Medido en prod
 * (2026-10-29): 13 roles ven Facturación y **10 no tienen OPERATE** (vendedor_ruta 20 usuarios,
 * encargado_tienda 10…). Con la puerta vieja —OPERATE para todo el proyecto— la mudanza los habría
 * dejado fuera de una pantalla que ya usaban. Estas pruebas fijan las dos mitades: la puerta deja
 * pasar a quien sólo ve Facturación, y el índice no lo manda al dashboard del operador.
 */

function sesion(perms: Partial<Record<Permission, boolean>>, role = 'vendedor_ruta') {
  return { isAuthenticated: true, user: () => ({ role_name: role, permissions: perms }) };
}

function montar(perms: Partial<Record<Permission, boolean>>, role?: string) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: AuthService, useValue: sesion(perms, role) },
      {
        provide: PermissionsService,
        useValue: {
          has: (p: Permission) => perms[p] === true,
          hasAny: (...ps: Permission[]) => ps.some((p) => perms[p] === true),
        },
      },
    ],
  });
}

/** `true` si dejó pasar; si no, la URL a la que manda (o `false` si navegó por su cuenta). */
function correr(guard: unknown, url = '/telemarketing'): string | boolean {
  const r = TestBed.runInInjectionContext(() =>
    (guard as (a: unknown, b: unknown) => unknown)({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
  );
  if (r === true || r === false) return r;
  return TestBed.inject(Router).serializeUrl(r as UrlTree);
}

describe('[AX.16] puerta de /telemarketing', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('deja pasar a quien sólo ve Facturación TM (sin OPERATE)', () => {
    montar({ [Permission.COMMERCIAL_SALES_DOCS_VER]: true });
    expect(correr(televentaGuard)).toBe(true);
  });

  it('deja pasar al operador', () => {
    montar({ [Permission.COMMERCIAL_TELEVENTA_OPERATE]: true }, 'telemarketing');
    expect(correr(televentaGuard)).toBe(true);
  });

  it('NEGATIVA — sin ninguna de las dos llaves no entra (y QUOTES_VER sola tampoco abre la puerta)', () => {
    montar({ [Permission.COMMERCIAL_QUOTES_VER]: true }, 'supervisor_ventas');
    expect(correr(televentaGuard)).toBe(false);
  });

  it('customer_b2b sigue sin entrar aunque traiga la llave', () => {
    montar({ [Permission.COMMERCIAL_SALES_DOCS_VER]: true }, 'customer_b2b');
    expect(correr(televentaGuard)).toMatch(/^\/login/);
  });
});

describe('[AX.16] índice de /telemarketing', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('quien sólo ve Facturación aterriza en Facturación, no en el dashboard del operador', () => {
    montar({ [Permission.COMMERCIAL_SALES_DOCS_VER]: true });
    expect(correr(telemarketingHomeGuard)).toBe('/telemarketing/documentos');
  });

  it('el operador sigue aterrizando en su dashboard', () => {
    montar({ [Permission.COMMERCIAL_TELEVENTA_OPERATE]: true, [Permission.COMMERCIAL_SALES_DOCS_VER]: true }, 'telemarketing');
    expect(correr(telemarketingHomeGuard)).toBe('/telemarketing/dashboard');
  });

  it('ningún candidato apunta a la raíz del proyecto (sería este mismo índice: bucle)', () => {
    for (const c of TELEMARKETING_LANDING) expect(c.url.startsWith('/telemarketing/')).toBe(true);
  });
});
