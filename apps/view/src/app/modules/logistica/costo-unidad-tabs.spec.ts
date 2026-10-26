import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Permission } from '../../core/constants/permissions';
import { pestanaVisible, primeraPestanaVisible } from '../../shared/components/page-tabs/pestanas-de-area';
import { COSTO_UNIDAD_TABS } from './costo-unidad-tabs';
import { enCorte, rangoDe } from './costo-unidad-fechas';

/**
 * `[FCU.3]` **Logística › Costo por unidad: una entrada en el menú, cinco pantallas en pestañas.**
 *
 * Lo que se cuida: las cinco pestañas y su orden; que se abren con el permiso PROPIO del módulo (y
 * nadie sin él las ve); que la nómina administrativa —dato sensible— pide GESTIONAR en la pestaña Y
 * en la ruta; y que el menú las muestra como UNA entrada bajo «Costos y reportes».
 */
const con = (...ps: Permission[]) => (p: Permission) => ps.includes(p);
const rutas = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');
const menu = readFileSync(join(__dirname, '../dashboard/layout/layout.component.ts'), 'utf8');

describe('[FCU.3] las pestañas de Costo por unidad', () => {
  it('son Unidades, Gastos sin unidad, Presupuesto, Nómina administrativa y Reposición, en ese orden', () => {
    expect(COSTO_UNIDAD_TABS.map((t) => [t.label, t.route])).toEqual([
      ['Unidades', '/logistica/costo-unidad/unidades'],
      ['Gastos sin unidad', '/logistica/costo-unidad/pendientes'],
      ['Presupuesto', '/logistica/costo-unidad/presupuesto'],
      ['Nómina administrativa', '/logistica/costo-unidad/nomina'],
      ['Reposición', '/logistica/costo-unidad/reposicion'],
    ]);
  });

  it('con VER se ven cuatro (sin la nómina) y se entra por «Unidades»', () => {
    const ver = con(Permission.LOGISTICS_COSTO_UNIDAD_VER);
    expect(COSTO_UNIDAD_TABS.filter((t) => pestanaVisible(t, ver)).map((t) => t.label)).toEqual(['Unidades', 'Gastos sin unidad', 'Presupuesto', 'Reposición']);
    expect(primeraPestanaVisible(COSTO_UNIDAD_TABS, ver)?.route).toBe('/logistica/costo-unidad/unidades');
  });

  it('con GESTIONAR se ve también la nómina administrativa', () => {
    const gestionar = con(Permission.LOGISTICS_COSTO_UNIDAD_VER, Permission.LOGISTICS_COSTO_UNIDAD_GESTIONAR);
    expect(COSTO_UNIDAD_TABS.filter((t) => pestanaVisible(t, gestionar))).toHaveLength(5);
  });

  it('PRUEBA NEGATIVA: con permisos de flota, gastos o pagos de viaje, pero sin el del módulo, no se ve ninguna', () => {
    const otro = con(Permission.LOGISTICS_FLEET_VER, Permission.LOGISTICS_EXPENSES_VER, Permission.LOGISTICS_PAGOS_VER);
    expect(COSTO_UNIDAD_TABS.filter((t) => pestanaVisible(t, otro))).toHaveLength(0);
  });

  it('cada ruta conserva su guard; la nómina pide GESTIONAR', () => {
    for (const p of ['unidades', 'pendientes', 'presupuesto', 'reposicion']) {
      expect(rutas).toMatch(new RegExp(`path: '${p}',[\\s\\S]*?logistica-costo-unidad[\\s\\S]*?canActivate: \\[permissionGuard\\(Permission\\.LOGISTICS_COSTO_UNIDAD_VER\\)\\]`));
    }
    expect(rutas).toMatch(/path: 'nomina',\s*loadComponent: [^\n]*logistica-costo-unidad-nomina[^\n]*\n\s*canActivate: \[permissionGuard\(Permission\.LOGISTICS_COSTO_UNIDAD_GESTIONAR\)\]/);
    expect(rutas).toMatch(/path: 'costo-unidad',\s*canActivate: \[permissionGuard\(Permission\.LOGISTICS_COSTO_UNIDAD_VER\)\]/);
  });

  it('el menú lo muestra como UNA entrada en «Costos y reportes»', () => {
    expect(menu).toMatch(/title: 'Costos y reportes',[\s\S]*?label: 'Costo por unidad',[^\n]*route: '\/logistica\/costo-unidad\/unidades', tabs: COSTO_UNIDAD_TABS/);
    expect(menu).not.toMatch(/route: '\/logistica\/costo-unidad\/(pendientes|presupuesto|nomina|reposicion)'/);
  });
});

describe('[FCU.3.1] periodo y corte', () => {
  const hoy = new Date(2026, 9, 26);

  it('los atajos de periodo cuentan desde hoy, sin pasar por UTC', () => {
    expect(rangoDe('mes', hoy)).toEqual({ desde: '2026-10-01', hasta: '2026-10-26' });
    expect(rangoDe('mes_anterior', hoy)).toEqual({ desde: '2026-09-01', hasta: '2026-09-30' });
    expect(rangoDe('anio', hoy)).toEqual({ desde: '2026-01-01', hasta: '2026-10-26' });
    expect(rangoDe('doce', hoy)).toEqual({ desde: '2025-10-27', hasta: '2026-10-26' });
  });

  it('«total del periodo» deja el monto; un corte lo expresa como la columna de la hoja; sin monto no inventa', () => {
    expect(enCorte(3000, 30, 'periodo')).toBe(3000);
    expect(enCorte(3000, 30, 'dia')).toBe(100);
    expect(enCorte(null, 30, 'mes')).toBeNull();
  });
});
