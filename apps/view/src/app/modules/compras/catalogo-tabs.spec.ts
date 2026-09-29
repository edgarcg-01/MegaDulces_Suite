import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOGO_TABS } from './catalogo-tabs';

describe('CATALOGO_TABS', () => {
  const routes = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');

  it('expone todos los apartados del centro de catálogo en orden operativo', () => {
    expect(CATALOGO_TABS.map((tab) => [tab.label, tab.route])).toEqual([
      ['Resumen', '/compras/catalogo/resumen'],
      ['Productos', '/compras/catalogo'],
      ['Solicitudes', '/compras/catalogo/solicitudes'],
      ['Incidencias', '/compras/catalogo/incidencias'],
      ['Costos y precios', '/compras/catalogo/costos'],
      ['Listas de precios', '/compras/catalogo/listas-precios'],
      ['Códigos', '/compras/catalogo/codigos'],
      ['Reportes', '/compras/catalogo/reporte'],
    ]);
  });

  it('mantiene Precios distintos dentro del apartado Costos y precios', () => {
    const costos = CATALOGO_TABS.find(
      (tab) => tab.route === '/compras/catalogo/costos',
    );
    expect(costos?.alsoActiveOn).toContain('/compras/catalogo/precios');
  });

  it('registra cada apartado nuevo en el router con permiso de catálogo', () => {
    for (const apartado of [
      'resumen',
      'solicitudes',
      'incidencias',
      'costos',
      'listas-precios',
    ]) {
      expect(routes).toContain(`path: 'catalogo/${apartado}'`);
      expect(routes).toContain(`data: { catalogoApartado: '${apartado}' }`);
    }

    const bloques = routes.match(
      /path: 'catalogo\/(?:resumen|solicitudes|incidencias|costos|listas-precios)'[\s\S]*?data: \{ catalogoApartado: '[^']+' \}/g,
    );
    expect(bloques).toHaveLength(5);
    for (const bloque of bloques ?? []) {
      expect(bloque).toContain('ComprasCatalogoApartadoComponent');
      expect(bloque).toContain(
        'permissionGuard(Permission.COMMERCIAL_PRODUCTS_VER)',
      );
    }
  });
});
