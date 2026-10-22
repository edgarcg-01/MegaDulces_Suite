import { RUTA_DIRECTA_TABS, RUTA_DIRECTA_LABEL } from './ruta-directa-tabs';

/**
 * `[AUD-A5]` **El conjunto no se puede llamar como una de sus partes.**
 *
 * Medido en producción el 2026-10-20, con la pantalla viva: estando en
 * `/comercial/comisiones`, el eslabón de la migaja marcado `aria-current="page"` decía
 * **«Ventas por ruta»** — el nombre de OTRA pestaña del mismo sub-módulo. Un rótulo que dice
 * dónde estás y señala otro lado es peor que no tenerlo.
 *
 * ⭐ La causa no estaba en la migaja: `currentPageTitle()` resuelve por `isNavActive()` y
 * devuelve la etiqueta del **ítem del sidebar**, que se llamaba como su primera pestaña. El
 * arreglo fue nombrar al conjunto, no parchear la migaja.
 *
 * ⛔ **Por qué este archivo y no el de la migaja.** La primera versión de este candado vivía en
 * `layout-crumbs.spec.ts` y era un **no-op**: `construirMigas()` devuelve espacio + proyecto
 * («Comercial / Ventas») y **nunca** produjo el eslabón que mentía, así que la prueba pasaba
 * igual con el defecto puesto. Un candado que no puede ponerse rojo no es un candado.
 */
describe('[AUD-A5] el nombre del sub-módulo Ruta Directa', () => {
  it('⛔ NEGATIVA — el nombre del conjunto NO es el de ninguna de sus pestañas', () => {
    const partes = RUTA_DIRECTA_TABS.map((t) => t.label);
    // Con el defecto puesto (label 'Ventas por ruta') esta sola línea se cae.
    expect(partes).not.toContain(RUTA_DIRECTA_LABEL);
  });

  it('CONTROL — las pestañas existen y tienen nombre, para que la negativa no mida el vacío', () => {
    expect(RUTA_DIRECTA_TABS.length).toBeGreaterThan(1);
    for (const t of RUTA_DIRECTA_TABS) {
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.route.startsWith('/comercial/')).toBe(true);
    }
  });

  it('el nombre del conjunto no está vacío ni es un genérico', () => {
    expect(RUTA_DIRECTA_LABEL.trim().length).toBeGreaterThan(2);
    expect(['Reportes', 'Página Actual', 'Comercial']).not.toContain(RUTA_DIRECTA_LABEL);
  });
});
