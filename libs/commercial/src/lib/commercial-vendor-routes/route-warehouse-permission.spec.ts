import { ANY_PERMISSIONS_KEY, PERMISSIONS_KEY } from '@megadulces/platform-core';
import { Permission } from '@megadulces/contracts/authz/permissions';
import { AUTHZ_TREE } from '@megadulces/contracts/authz/authz-tree';
import { PERMISSION_META } from '@megadulces/contracts/authz/permission-meta';
import { CommercialVendorRoutesController } from './commercial-vendor-routes.controller';

/**
 * `[MCP.3.11]` La sucursal de surtido de una ruta se cambia con CUALQUIERA de dos llaves:
 * administrar la cartera (la grande) o `COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR` (la acotada, la del
 * supervisor). Lo que se prueba es la METADATA que lee `RolesGuard`, no el texto del archivo:
 *  · los dos handlers declaran el grupo OR con las dos llaves;
 *  · ⛔ ninguno conserva el grupo AND con la grande — si quedara, el guard exigiría los dos grupos
 *    y la llave nueva no serviría de nada (fallaría en silencio: 403 al supervisor);
 *  · la llave existe en el editor de perfiles como módulo PROPIO (si viviera dentro de «Cartera»,
 *    dar G a cartera daría las dos juntas).
 * El recorte por tipo de ruta (el vecinal no toca camiones) lo prueba `cartera-route-scope.spec.ts`.
 */
const proto = CommercialVendorRoutesController.prototype as unknown as Record<string, object>;
const meta = (key: string, handler: string): string[] | undefined => Reflect.getMetadata(key, proto[handler]);

describe('[MCP.3.11] permiso de la sucursal de surtido por ruta', () => {
  for (const handler of ['routesWarehouses', 'setRouteWarehouse']) {
    it(`${handler}: OR de las dos llaves y SIN el AND de la grande`, () => {
      expect(meta(ANY_PERMISSIONS_KEY, handler)).toEqual([
        Permission.COMMERCIAL_CARTERA_GESTIONAR,
        Permission.COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR,
      ]);
      expect(meta(PERMISSIONS_KEY, handler)).toBeUndefined();
    });
  }

  it('⛔ lo demás de la cartera sigue pidiendo la grande (asignar, orden de visita)', () => {
    expect(meta(PERMISSIONS_KEY, 'assign')).toEqual([Permission.COMMERCIAL_CARTERA_GESTIONAR]);
  });

  it('la llave tiene etiqueta y vive en su propio módulo del editor de perfiles, sólo como G', () => {
    expect(PERMISSION_META[Permission.COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR]?.label).toBe('Cambiar sucursal de surtido de ruta');
    const modulos = AUTHZ_TREE.flatMap((app) => (app.projects ?? []).flatMap((p) => p.modules));
    const dueños = modulos.filter((m) => [...m.view, ...m.manage].includes(Permission.COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR));
    expect(dueños.map((m) => m.id)).toEqual(['route-warehouse']);
    expect(dueños[0].view).toEqual([]);
    const cartera = modulos.find((m) => m.id === 'cartera')!;
    expect(cartera.manage).not.toContain(Permission.COMMERCIAL_ROUTE_WAREHOUSE_GESTIONAR);
  });
});
