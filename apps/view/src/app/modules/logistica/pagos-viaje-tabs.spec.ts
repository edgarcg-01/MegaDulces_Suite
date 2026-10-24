import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Permission } from '../../core/constants/permissions';
import { pestanaVisible, primeraPestanaVisible } from '../../shared/components/page-tabs/pestanas-de-area';
import { PAGOS_VIAJE_TABS } from './pagos-viaje-tabs';

/**
 * `[EMB.43]` **Logística › Pagos de viaje: una entrada en el menú, tres pantallas en pestañas.**
 *
 * Lo que se cuida: las tres pestañas y su orden; que se abren con el permiso PROPIO del módulo (y
 * nadie sin él las ve); que cada ruta conserva su guard dentro del shell; que el menú las muestra
 * como UNA entrada; y que Finanzas › Comisiones de logística es la MISMA pantalla que «Por persona».
 */
const con = (...ps: Permission[]) => (p: Permission) => ps.includes(p);
const rutas = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');
const menu = readFileSync(join(__dirname, '../dashboard/layout/layout.component.ts'), 'utf8');

describe('[EMB.43] las pestañas de Pagos de viaje', () => {
  it('son Operaciones, Por persona y Tarifas, en ese orden', () => {
    expect(PAGOS_VIAJE_TABS.map((t) => [t.label, t.route])).toEqual([
      ['Operaciones', '/logistica/pagos/viajes'],
      ['Por persona', '/logistica/pagos/personas'],
      ['Tarifas', '/logistica/pagos/tarifas'],
    ]);
  });

  it('con VER del módulo se ven las tres y se entra por «Operaciones»', () => {
    const ver = con(Permission.LOGISTICS_PAGOS_VER);
    expect(PAGOS_VIAJE_TABS.filter((t) => pestanaVisible(t, ver))).toHaveLength(3);
    expect(primeraPestanaVisible(PAGOS_VIAJE_TABS, ver)?.route).toBe('/logistica/pagos/viajes');
  });

  it('PRUEBA NEGATIVA: con permisos de embarques o de gastos, pero sin el del módulo, no se ve ninguna', () => {
    const otro = con(Permission.LOGISTICS_SHIPMENTS_GESTIONAR, Permission.FINANCE_EXPENSES_COMPROBAR);
    expect(PAGOS_VIAJE_TABS.filter((t) => pestanaVisible(t, otro))).toHaveLength(0);
  });

  it('cada ruta del shell conserva su guard con el permiso propio', () => {
    for (const p of ['viajes', 'personas', 'tarifas']) {
      expect(rutas).toMatch(new RegExp(`path: '${p}',[\\s\\S]*?canActivate: \\[permissionGuard\\(Permission\\.LOGISTICS_PAGOS_VER\\)\\]`));
    }
    expect(rutas).toMatch(/path: 'pagos',[\s\S]*?pagos-viaje-area-shell[\s\S]*?canActivate: \[permissionGuard\(Permission\.LOGISTICS_PAGOS_VER\)\]/);
  });

  it('el menú lo muestra como UNA entrada con las tres pestañas', () => {
    expect(menu).toMatch(/label: 'Pagos de viaje',[^\n]*route: '\/logistica\/pagos\/viajes', tabs: PAGOS_VIAJE_TABS/);
    expect(menu).not.toMatch(/route: '\/logistica\/pagos\/personas'/);
  });

  it('Finanzas › Comisiones de logística es la MISMA pantalla que «Por persona» (una sola implementación)', () => {
    expect(rutas).toMatch(/path: 'comisiones-logistica',\s*loadComponent: \(\) => import\('\.\/modules\/logistica\/pages\/logistica-pagos-personas\.component'\)/);
    expect(rutas).not.toMatch(/finanzas-comisiones-logistica\.component/);
  });
});
