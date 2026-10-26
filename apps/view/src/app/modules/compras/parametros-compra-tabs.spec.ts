import { PARAMETROS_COMPRA_TABS, PARAMETROS_COMPRA_LABEL } from './parametros-compra-tabs';

/**
 * `[NAV.5]` + `[AUD-A5]` **El apartado no se puede llamar como una de sus partes**, y sus tres
 * pantallas tienen que seguir siendo alcanzables con su propio permiso.
 *
 * La migaja toma la etiqueta del ítem del sidebar. Si el conjunto se llamara «Proveedores» (su
 * primera pestaña), estando en Red de abasto la migaja marcaría como página actual a OTRA
 * pantalla — el defecto medido en Ruta Directa el 2026-10-20.
 */
describe('[NAV.5] el apartado Parámetros de compra', () => {
  it('⛔ NEGATIVA — el nombre del conjunto NO es el de ninguna de sus pestañas', () => {
    const partes = PARAMETROS_COMPRA_TABS.map((t) => t.label);
    // Con el conjunto llamado como su primera pestaña («Proveedores») esta línea se cae.
    expect(partes).not.toContain(PARAMETROS_COMPRA_LABEL);
  });

  it('CONTROL — las tres pantallas siguen ahí, cada una con su ruta y su permiso propio', () => {
    expect(PARAMETROS_COMPRA_TABS.map((t) => t.route)).toEqual([
      '/compras/proveedores',
      '/compras/categorias',
      '/compras/red',
    ]);
    const permisos = PARAMETROS_COMPRA_TABS.map((t) => t.permission);
    expect(permisos.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
    // Tres permisos distintos: plegar no puede fundir el acceso de una pantalla con otra.
    expect(new Set(permisos).size).toBe(3);
  });

  it('el nombre del conjunto no está vacío ni es un genérico', () => {
    expect(PARAMETROS_COMPRA_LABEL.trim().length).toBeGreaterThan(2);
    expect(['Compras', 'Catálogo', 'Configuración', 'Página Actual']).not.toContain(PARAMETROS_COMPRA_LABEL);
  });
});
