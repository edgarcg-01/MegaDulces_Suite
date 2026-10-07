import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type Routes } from '@angular/router';
import { readFileSync, readdirSync } from 'node:fs';
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

  /**
   * `[E.13]` Este caso **estaba verde con el bug vivo**, y es la lección de la tanda.
   *
   * Buscaba `'/televenta/` —con comilla SIMPLE— porque así se escribe una ruta en TypeScript.
   * Pero en una plantilla se escribe `routerLink="/televenta/queue"`, con comilla DOBLE, y eso
   * era exactamente lo que tenía el dashboard en la línea 199: el enlace que este caso existe
   * para prohibir, en uno de los archivos que él mismo enumera, y pasaba.
   *
   * Dos cambios: se buscan las dos comillas, y la lista de archivos **se descubre** en vez de
   * escribirse a mano. Una lista a mano no cubre la página que nazca mañana — ni se entera
   * cuando un archivo se va, que es lo que pasó con el shell al mudarse al layout común.
   */
  it('ninguna navegación del código apunta ya a /televenta/', () => {
    const modulo = join(__dirname, 'modules', 'televenta');
    const archivos = [
      ...readdirSync(modulo).map((f) => join(modulo, f)),
      ...readdirSync(join(modulo, 'pages')).map((f) => join(modulo, 'pages', f)),
    ].filter((f) => f.endsWith('.ts'));

    // Prueba negativa: si el descubrimiento devolviera vacío, el caso pasaría sin mirar nada.
    expect(archivos.length).toBeGreaterThan(5);

    const culpables = archivos.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return src.includes("'/televenta/") || src.includes('"/televenta/');
    });
    expect(culpables).toEqual([]);
  });

  /**
   * `[E.13]` El proyecto monta el layout común, como los otros 13. Es lo que le da sidebar,
   * migaja y —derivado de `component === LayoutComponent` al final de `app.routes.ts`— el
   * outlet `panel` de la pantalla partida, que con el shell propio nunca le llegó.
   */
  it('telemarketing monta LayoutComponent, no un shell propio', () => {
    const i = src.indexOf("path: 'telemarketing',");
    const bloque = src.slice(i, i + 400);
    expect(bloque).toContain('component: LayoutComponent');
    expect(bloque).not.toContain('TeleventaShellComponent');
  });
});
