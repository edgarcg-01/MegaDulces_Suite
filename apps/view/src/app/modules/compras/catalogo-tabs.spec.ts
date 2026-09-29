import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Route } from '@angular/router';
import { CATALOGO_TABS } from './catalogo-tabs';
import { routes } from '../../app.routes';

/**
 * El árbol REAL de rutas, aplanado. Se prueba contra `app.routes.ts` importado como DATO
 * y no como texto: una ruta que existe, lleva su discriminador y está gateada son hechos
 * del objeto, y leerlos del fuente los vuelve sensibles a un reformateo que no rompe nada.
 * Mismo criterio que `core/panel/panel-routes.spec.ts`.
 *
 * No se llama a `loadComponent()`: montar los componentes de verdad arrastraría media app
 * a jsdom y la prueba diría más sobre PrimeNG que sobre las rutas.
 */
const TODAS: Route[] = (function aplanar(rs: Route[] = []): Route[] {
  return rs.flatMap((r) => [r, ...aplanar(r.children)]);
})(routes);

const APARTADOS = ['resumen', 'solicitudes', 'incidencias', 'costos', 'listas-precios'] as const;

describe('CATALOGO_TABS', () => {
  it('expone todos los apartados del centro de catálogo en orden operativo', () => {
    expect(CATALOGO_TABS.map((tab) => [tab.label, tab.route])).toEqual([
      ['Resumen', '/compras/catalogo/resumen'],
      ['Productos', '/compras/catalogo'],
      ['Solicitudes', '/compras/catalogo/solicitudes'],
      ['Incidencias', '/compras/catalogo/incidencias'],
      ['Costos y precios', '/compras/catalogo/precios'],
      ['Listas de precios', '/compras/catalogo/listas-precios'],
      ['Códigos', '/compras/catalogo/codigos'],
      ['Reportes', '/compras/catalogo/reporte'],
    ]);
  });

  /**
   * `[negativa]` El tab NO puede abrir el cascarón.
   *
   * `Precios distintos` era un tab propio y el comprador lo usa hoy. Apuntar el tab a
   * `/catalogo/costos` dejaría esa pantalla detrás de un «contenido por desarrollar» y de
   * un clic extra. El cascarón sólo mantiene el tab encendido mientras no tenga contenido.
   */
  it('Costos y precios abre la pantalla que YA funciona, no el cascarón', () => {
    const costos = CATALOGO_TABS.find((tab) => tab.label === 'Costos y precios');
    expect(costos?.route).toBe('/compras/catalogo/precios');
    expect(costos?.route).not.toBe('/compras/catalogo/costos');
    expect(costos?.alsoActiveOn).toContain('/compras/catalogo/costos');
  });

  it('cada tab apunta a una ruta que existe en el árbol real', () => {
    const caminos = new Set(
      TODAS.map((r) => r.path).filter((p): p is string => typeof p === 'string'),
    );
    for (const tab of CATALOGO_TABS) {
      // Los tabs del centro cuelgan todos de `/compras`.
      const rel = tab.route.replace(/^\/compras\/?/, '');
      expect(caminos.has(rel)).toBe(true);
    }
  });

  it('cada apartado nuevo existe en el router con su discriminador y su guard', () => {
    for (const apartado of APARTADOS) {
      const ruta = TODAS.find((r) => r.path === `catalogo/${apartado}`);
      expect(ruta).toBeDefined();
      expect(ruta?.data?.['catalogoApartado']).toBe(apartado);
      expect(ruta?.canActivate ?? []).toHaveLength(1);
      expect(typeof ruta?.loadComponent).toBe('function');
    }
  });

  /**
   * El permiso y el componente NO se pueden leer del objeto: `permissionGuard(...)` devuelve
   * una función que no expone su clave, y `loadComponent` es un import perezoso que habría
   * que ejecutar. Para eso —y sólo para eso— se lee el fuente, igual que hace
   * `core/guards/landing-guards.spec.ts`. El recorte va del `path` a su `data`, así que no
   * depende de saltos de línea ni de cuántas propiedades tenga el bloque.
   */
  it('los apartados nuevos se gatean con COMMERCIAL_PRODUCTS_VER', () => {
    const fuente = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');
    for (const apartado of APARTADOS) {
      const iPath = fuente.indexOf(`path: 'catalogo/${apartado}'`);
      const iData = fuente.indexOf(`catalogoApartado: '${apartado}'`);
      expect(iPath).toBeGreaterThan(-1);
      expect(iData).toBeGreaterThan(iPath);
      const bloque = fuente.slice(iPath, iData);
      expect(bloque).toContain('permissionGuard(Permission.COMMERCIAL_PRODUCTS_VER)');
      expect(bloque).toContain('ComprasCatalogoApartadoComponent');
    }
  });
});
