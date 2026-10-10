import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Permission } from '../../core/constants/permissions';
import { pestanaVisible, primeraPestanaVisible } from '../../shared/components/page-tabs/pestanas-de-area';
import { GASTOS_TABS } from './gastos-tabs';

/**
 * `[GX.80]` **Gastos: una entrada en el menú, cuatro pantallas en pestañas.**
 *
 * Lo que se cuida:
 *  · a qué pestaña lleva la entrada según quién eres (quien firma no cae en una pantalla vacía);
 *  · que con una sola pestaña no haya barra;
 *  · que mover las rutas al shell NO les quitó su guard;
 *  · que el menú ya no repite las cuatro como renglones sueltos.
 */
const con = (...ps: Permission[]) => (p: Permission) => ps.includes(p);
const visibles = (tiene: (p: Permission) => boolean) => GASTOS_TABS.filter((t) => pestanaVisible(t, tiene)).map((t) => t.label);

describe('[GX.80] las pestañas de Gastos', () => {
  it('son las cuatro pantallas, en este orden', () => {
    expect(GASTOS_TABS.map((t) => t.route)).toEqual([
      '/finanzas/aprobacion-gastos', '/finanzas/mis-gastos', '/finanzas/expediente', '/finanzas/gastos-historial',
    ]);
  });

  it('quien firma entra a Aprobación y ve las cuatro', () => {
    const firma = con(Permission.FINANCE_EXPENSES_COMPROBAR, Permission.FINANCE_EXPENSES_VER);
    expect(primeraPestanaVisible(GASTOS_TABS, firma)?.route).toBe('/finanzas/aprobacion-gastos');
    expect(visibles(firma)).toEqual(['Aprobación de gastos', 'Mis gastos', 'Expediente', 'Historial']);
  });

  /** ⭐ Quien sólo captura entra a SUS gastos y no ve barra (una sola pestaña). */
  it('⭐ quien sólo captura entra a Mis gastos, y es su única pestaña', () => {
    const captura = con(Permission.FINANCE_EXPENSES_CAPTURAR);
    expect(primeraPestanaVisible(GASTOS_TABS, captura)?.route).toBe('/finanzas/mis-gastos');
    expect(visibles(captura)).toEqual(['Mis gastos']);
  });

  it('con la llave del historial de todos (sin más), entra al Historial', () => {
    expect(primeraPestanaVisible(GASTOS_TABS, con(Permission.FINANCE_EXPENSES_HISTORIAL_TODOS))?.route).toBe('/finanzas/gastos-historial');
  });

  /** ⛔ Sin ningún permiso de gastos, no hay a dónde llevarlo: la entrada no se pinta. */
  it('⛔ sin permisos de gastos no hay destino', () => {
    expect(primeraPestanaVisible(GASTOS_TABS, con(Permission.FINANCE_BANK_VER))).toBeNull();
  });
});

describe('[GX.80] las rutas viven en el shell, con su guard', () => {
  const rutas = readFileSync(join(__dirname, '..', '..', 'app.routes.ts'), 'utf8');
  const shell = rutas.match(/import\('\.\/modules\/finanzas\/gastos-area-shell\.component'\)[\s\S]*?\n {8}\],/);

  it('existe el shell y adentro están las cuatro pantallas', () => {
    expect(shell).not.toBeNull();
    for (const p of ['aprobacion-gastos', 'gastos-historial', 'expediente', 'mis-gastos']) {
      expect(shell?.[0]).toContain("path: '" + p + "'");
    }
  });

  /** ⛔ Mover una ruta no puede abrirla: cada una conserva el permiso que tenía. */
  it('⛔ cada pantalla conserva su guard', () => {
    const s = shell?.[0] ?? '';
    expect(s).toMatch(/path: 'aprobacion-gastos',[\s\S]*?canActivate: \[permissionGuard\(Permission\.FINANCE_EXPENSES_COMPROBAR\)\]/);
    expect(s).toMatch(/path: 'expediente',[\s\S]*?canActivate: \[permissionGuard\(Permission\.FINANCE_EXPENSES_COMPROBAR\)\]/);
    expect(s).toMatch(/path: 'mis-gastos',[\s\S]*?canActivate: \[anyPermissionGuard\(Permission\.FINANCE_EXPENSES_VER, Permission\.FINANCE_EXPENSES_CAPTURAR\)\]/);
    expect(s).toMatch(/path: 'gastos-historial',[\s\S]*?canActivate: \[anyPermissionGuard\(Permission\.FINANCE_EXPENSES_VER, Permission\.FINANCE_EXPENSES_COMPROBAR, Permission\.FINANCE_EXPENSES_HISTORIAL_TODOS\)\]/);
  });

  it('las cuatro ya no están fuera del shell (no hay rutas duplicadas)', () => {
    for (const p of ['aprobacion-gastos', 'gastos-historial', 'expediente', 'mis-gastos']) {
      expect(rutas.split("path: '" + p + "'").length - 1).toBe(1);
    }
  });
});

describe('[GX.80] el menú lateral', () => {
  const layout = readFileSync(join(__dirname, '..', 'dashboard', 'layout', 'layout.component.ts'), 'utf8');

  it('tiene UNA entrada «Gastos» que lleva las pestañas', () => {
    expect(layout).toContain("{ label: 'Gastos', icon: 'pi pi-wallet', route: '/finanzas/mis-gastos', tabs: GASTOS_TABS }");
  });

  it('ya no repite las cuatro pantallas como renglones sueltos', () => {
    for (const t of GASTOS_TABS) expect(layout).not.toContain("label: '" + t.label + "'");
    // La única mención de cada ruta en el menú es la de la entrada «Gastos» (su destino por omisión).
    expect(layout.split("route: '/finanzas/mis-gastos'").length - 1).toBe(1);
    for (const r of ['/finanzas/aprobacion-gastos', '/finanzas/expediente', '/finanzas/gastos-historial']) {
      expect(layout).not.toContain("route: '" + r + "'");
    }
  });
});
