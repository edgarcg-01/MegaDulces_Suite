import { SEGUIMIENTO_COMPRA_LABEL, SEGUIMIENTO_COMPRA_TABS } from './seguimiento-compra-tabs';
import { ALERTAS_ABASTO_LABEL, ALERTAS_ABASTO_TABS } from './alertas-abasto-tabs';
import { PAGO_PROVEEDOR_LABEL, PAGO_PROVEEDOR_TABS } from './pago-proveedor-tabs';
import { COSTOS_COMPRA_LABEL, COSTOS_COMPRA_TABS } from './costos-compra-tabs';
import { PARAMETROS_COMPRA_LABEL, PARAMETROS_COMPRA_TABS } from './parametros-compra-tabs';
import { ENTRADAS_CONTROL_TABS } from './entradas-control-tabs';
import { CATALOGO_TABS } from './catalogo-tabs';
import type { PageTab } from '../../shared/components/page-tabs/page-tabs.component';

/**
 * `[NAV.6]` Los apartados del sidebar de Compras.
 *
 * Dos cosas que se rompen sin que nada truene:
 *  1. `[AUD-A5]` Un apartado que se llama como una de sus pestañas hace que la migaja nombre la
 *     pantalla equivocada (medido en Ruta Directa el 2026-10-20).
 *  2. Plegar renglones en pestañas puede PERDER una pantalla (`[NAV.2]` dejó 19 sin camino) o
 *     repetirla en dos apartados. Acá se fija el universo: las 15 rutas que dejaron de ser
 *     renglones siguen estando, cada una en UN solo apartado.
 */
const APARTADOS: Array<[string, readonly PageTab[]]> = [
  [SEGUIMIENTO_COMPRA_LABEL, SEGUIMIENTO_COMPRA_TABS],
  [ALERTAS_ABASTO_LABEL, ALERTAS_ABASTO_TABS],
  [PAGO_PROVEEDOR_LABEL, PAGO_PROVEEDOR_TABS],
  [COSTOS_COMPRA_LABEL, COSTOS_COMPRA_TABS],
  [PARAMETROS_COMPRA_LABEL, PARAMETROS_COMPRA_TABS],
];

describe('[NAV.6] apartados del sidebar de Compras', () => {
  it('⛔ NEGATIVA — ningún apartado se llama como una de sus pestañas', () => {
    for (const [nombre, tabs] of APARTADOS) {
      expect(tabs.map((t) => t.label)).not.toContain(nombre);
    }
  });

  it('⛔ NEGATIVA — ningún apartado se llama como una pestaña del Catálogo (están en el mismo grupo)', () => {
    const delCatalogo = CATALOGO_TABS.map((t) => t.label);
    for (const [nombre] of APARTADOS) expect(delCatalogo).not.toContain(nombre);
  });

  it('CONTROL — cada pestaña tiene ruta de Compras y permiso, para que las negativas no midan el vacío', () => {
    for (const [, tabs] of APARTADOS) {
      expect(tabs.length).toBeGreaterThan(1);
      for (const t of tabs) {
        expect(t.route.startsWith('/compras/')).toBe(true);
        expect(typeof t.permission === 'string' && t.permission.length > 0).toBe(true);
      }
    }
  });

  it('las rutas que dejaron de ser renglones siguen alcanzables, y cada una en UN solo apartado', () => {
    const plegadas = [
      '/compras/requisiciones', '/compras/ordenes', '/compras/oc-abiertas',
      '/compras/hallazgos', '/compras/faltantes',
      '/compras/obligaciones', '/compras/vencimientos',
      '/compras/costo-neto', '/compras/costo-estandar', '/compras/descuentos',
      '/compras/proveedores', '/compras/categorias', '/compras/red',
      '/compras/reclamos',
    ];
    const todas = [...APARTADOS.flatMap(([, tabs]) => tabs.map((t) => t.route)), ...ENTRADAS_CONTROL_TABS.map((t) => t.route)];
    for (const r of plegadas) {
      expect(todas.filter((x) => x === r)).toHaveLength(1);
    }
  });
});
