import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type Routes } from '@angular/router';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * E.9 — la ruta del módulo pasó a `/telemarketing` y `/televenta/*` quedó como redirect.
 *
 * Dos cosas distintas se prueban acá, porque fallan por motivos distintos:
 *
 *   1. que el PATRÓN funcione en Angular — un `redirectTo` funcional bajo un `**` que
 *      reconstruye los segmentos. Si `url` no trajera los segmentos restantes (el supuesto
 *      del que depende todo), el enlace guardado `/televenta/lead/123` aterrizaría en
 *      `/telemarketing` y el operador perdería el cliente que venía a atender;
 *   2. que la CONFIGURACIÓN real de la app tenga esa forma — la canónica en
 *      `/telemarketing` y la vieja SIN componente (dos componentes montados en dos URLs
 *      serían dos copias de la misma pantalla, no un redirect).
 *
 * El (2) se lee del archivo como texto en vez de importar `app.routes.ts`: ese módulo
 * arrastra guards, layout y constantes de toda la app, y un gate no debería depender de
 * que 300 imports transitivos carguen en jsdom.
 */

@Component({ standalone: true, template: 'ok' })
class Dummy {}

/** Misma forma que el bloque legacy de `app.routes.ts` (ver el gate estático de abajo). */
const routes: Routes = [
  {
    path: 'telemarketing',
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      { path: 'dashboard', component: Dummy },
      { path: 'queue', component: Dummy },
      { path: 'lead/:customer_id', component: Dummy },
      { path: 'lead/:customer_id/take-order', component: Dummy },
    ],
  },
  {
    path: 'televenta',
    children: [
      {
        path: '**',
        redirectTo: ({ url, queryParams, fragment }) =>
          inject(Router).createUrlTree(['/telemarketing', ...url.map((s) => s.path)], {
            queryParams,
            fragment: fragment ?? undefined,
          }),
      },
    ],
  },
];

describe('E.9 · /televenta → /telemarketing', () => {
  let router: Router;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideRouter(routes)] });
    router = TestBed.inject(Router);
    await router.navigateByUrl('/telemarketing/dashboard');
  });

  it('el enlace guardado más profundo conserva TODOS los segmentos', async () => {
    await router.navigateByUrl('/televenta/lead/123/take-order');
    expect(router.url).toBe('/telemarketing/lead/123/take-order');
  });

  it('la raíz vieja cae en el resumen (sin barra colgando)', async () => {
    await router.navigateByUrl('/televenta');
    expect(router.url).toBe('/telemarketing/dashboard');
  });

  it('conserva los query params del enlace viejo', async () => {
    await router.navigateByUrl('/televenta/queue?limit=50');
    expect(router.url).toBe('/telemarketing/queue?limit=50');
  });

  it('la ruta nueva funciona sin pasar por el redirect', async () => {
    await router.navigateByUrl('/telemarketing/lead/999');
    expect(router.url).toBe('/telemarketing/lead/999');
  });

  // Prueba NEGATIVA del patrón: sin el bloque legacy la URL vieja no resuelve. Es lo que
  // hace que los casos de arriba signifiquen algo — si Angular "arreglara" solo la URL
  // vieja, este test pasaría igual y los otros no probarían nada.
  it('sin el bloque legacy, la URL vieja NO resuelve', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideRouter([routes[0]])] });
    const solo = TestBed.inject(Router);
    await expect(solo.navigateByUrl('/televenta/lead/123')).rejects.toThrow();
  });
});

describe('E.9 · la configuración real de la app tiene esa forma', () => {
  const src = readFileSync(join(__dirname, 'app.routes.ts'), 'utf8');

  it('la ruta canónica del módulo es /telemarketing', () => {
    expect(src).toContain("path: 'telemarketing',");
  });

  it('la ruta vieja existe (los enlaces guardados no mueren)', () => {
    expect(src).toContain("path: 'televenta',");
  });

  it('la ruta vieja NO monta el shell: es redirect, no una segunda copia', () => {
    const legacy = src.slice(src.indexOf("path: 'televenta',"));
    const bloque = legacy.slice(0, legacy.indexOf('\n  {'));
    expect(bloque).toContain('redirectTo:');
    expect(bloque).not.toContain('loadComponent');
    expect(bloque).not.toContain('TeleventaShellComponent');
  });

  it('el redirect real conserva query params (devuelve UrlTree, no string)', () => {
    // El caso de arriba corre sobre el espejo; esto ata el espejo a la config real. Un
    // `redirectTo` funcional que devuelve string compila igual y tira los query params.
    const legacy = src.slice(src.indexOf("path: 'televenta',"));
    const bloque = legacy.slice(0, legacy.indexOf('\n  {'));
    expect(bloque).toContain('createUrlTree');
    expect(bloque).toContain('queryParams');
  });

  it('ninguna navegación del código apunta ya a /televenta/', () => {
    // El shell y las 4 páginas navegan entre sí con rutas absolutas; una sola que quede en
    // la vieja manda al usuario por el redirect en cada clic (y rompe routerLinkActive).
    const modulo = join(__dirname, 'modules', 'televenta');
    const archivos = [
      join(modulo, 'televenta-shell.component.ts'),
      join(modulo, 'pages', 'televenta-dashboard.component.ts'),
      join(modulo, 'pages', 'televenta-queue.component.ts'),
      join(modulo, 'pages', 'televenta-lead.component.ts'),
      join(modulo, 'pages', 'televenta-take-order.component.ts'),
    ];
    const culpables = archivos.filter((f) => readFileSync(f, 'utf8').includes("'/televenta/"));
    expect(culpables).toEqual([]);
  });
});
