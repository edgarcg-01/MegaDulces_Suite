import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[SN.3]` — Gate estático sobre la configuración REAL de rutas (mismo criterio que
 * `telemarketing-route.spec.ts`: se lee `app.routes.ts` como texto porque importarlo arrastra
 * ~300 módulos que no cargan en jsdom).
 *
 * Lo que se fija:
 *  1. `/projects` sigue existiendo (la URL se CONSERVÓ a propósito) y monta la landing nueva,
 *     lazy, detrás de `authGuard`;
 *  2. la landing vieja desapareció del árbol de rutas y del disco — dos componentes para la
 *     misma URL serían dos copias de la misma pantalla;
 *  3. el login sigue aterrizando en `/projects` (si alguien renombra la ruta, esto lo acusa).
 */
describe('SN.3 · /projects monta "Mi trabajo"', () => {
  const routes = readFileSync(join(__dirname, 'app.routes.ts'), 'utf8');
  const login = readFileSync(join(__dirname, 'modules/auth/login/login.component.ts'), 'utf8');

  it('la ruta projects es lazy, con authGuard, y carga MiTrabajoComponent', () => {
    const bloque = routes.match(/\{\s*path: 'projects',[\s\S]*?\},/);
    expect(bloque).not.toBeNull();
    expect(bloque![0]).toMatch(/canActivate: \[authGuard\]/);
    expect(bloque![0]).toMatch(/loadComponent: \(\) => import\('\.\/modules\/mi-trabajo\/mi-trabajo\.component'\)\.then\(m => m\.MiTrabajoComponent\)/);
    expect(bloque![0]).not.toMatch(/component:/);
  });

  it('la landing vieja no existe: ni import, ni referencia, ni archivo', () => {
    expect(routes).not.toMatch(/ProjectsComponent/);
    expect(routes).not.toMatch(/modules\/projects\//);
    let existe = true;
    try {
      readFileSync(join(__dirname, 'modules/projects/projects/projects.component.ts'), 'utf8');
    } catch {
      existe = false;
    }
    expect(existe).toBe(false);
  });

  it('el login sigue aterrizando en /projects', () => {
    expect(login).toMatch(/'\/projects'/);
  });

  it('nadie navega a la ruta vieja de "proyectos" con otro nombre', () => {
    // Si alguien creara `/mi-trabajo` como segunda URL de la misma pantalla, serían dos copias.
    expect(routes).not.toMatch(/path: 'mi-trabajo'/);
  });
});
