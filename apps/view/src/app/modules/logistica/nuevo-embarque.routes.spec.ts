import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Route } from '@angular/router';
import { routes } from '../../app.routes';

/**
 * EMB.12 — Las dos rutas de «Nuevo embarque», contra el árbol REAL de `app.routes.ts`.
 *
 * Lo que puede romperse sin que nada compile mal: el ORDEN. Angular toma la primera ruta que
 * empata, y `shipments/:id` empata con `shipments/nuevo` — si quedara antes, «nuevo» se
 * cargaría como el id de un embarque y la pantalla pediría `/logistics/shipments/nuevo`.
 *
 * El permiso se lee del fuente porque `permissionGuard(...)` devuelve una función que no
 * expone su clave (mismo criterio que `compras/catalogo-tabs.spec.ts`).
 */

function padreDe(path: string, rs: Route[] = routes): Route | undefined {
  for (const r of rs) {
    if (r.children?.some((c) => c.path === path)) return r;
    const x = padreDe(path, r.children ?? []);
    if (x) return x;
  }
  return undefined;
}

describe('rutas de «Nuevo embarque»', () => {
  const padre = padreDe('shipments/nuevo');
  const hijos = (padre?.children ?? []).map((c) => c.path);

  it('cuelgan de logística, junto al detalle del embarque', () => {
    expect(padre?.path).toBe('logistica');
    expect(hijos).toContain('shipments/nuevo/:sucursal/:guia');
    expect(hijos).toContain('shipments/:id');
  });

  it('van ANTES de shipments/:id, que si no se las come', () => {
    const detalle = hijos.indexOf('shipments/:id');
    expect(hijos.indexOf('shipments/nuevo')).toBeLessThan(detalle);
    expect(hijos.indexOf('shipments/nuevo/:sucursal/:guia')).toBeLessThan(detalle);
  });

  it('cargan su pantalla y piden GESTIONAR embarques (crear, no sólo ver)', () => {
    const fuente = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');
    const bloque = (path: string) => {
      const i = fuente.indexOf(`path: '${path}'`);
      expect(i).toBeGreaterThan(-1);
      return fuente.slice(i, fuente.indexOf('}', fuente.indexOf('canActivate', i)));
    };
    expect(bloque('shipments/nuevo')).toContain('LogisticaNuevoEmbarqueComponent');
    expect(bloque('shipments/nuevo')).toContain('permissionGuard(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)');
    expect(bloque('shipments/nuevo/:sucursal/:guia')).toContain('LogisticaNuevoEmbarqueFormComponent');
    expect(bloque('shipments/nuevo/:sucursal/:guia')).toContain('permissionGuard(Permission.LOGISTICS_SHIPMENTS_GESTIONAR)');
  });
});
