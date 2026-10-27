import { CORTES_ARQUEOS_LABEL, CORTES_ARQUEOS_TABS } from './cortes-arqueos-tabs';
import { BANCOS_CONCILIACION_LABEL, BANCOS_CONCILIACION_TABS } from './bancos-conciliacion-tabs';
import { DEUDA_PROVEEDORES_LABEL, DEUDA_PROVEEDORES_TABS } from './deuda-proveedores-tabs';
import { LIBROS_CONTABLES_LABEL, LIBROS_CONTABLES_TABS } from './libros-contables-tabs';
import { MAAT_LABEL, MAAT_TABS } from './maat-tabs';
import { PAGOS_TABS } from './pagos-tabs';
import { CAJA_TABS } from './caja-tabs';
import { GASTOS_TABS } from './gastos-tabs';
import type { PageTab } from '../../shared/components/page-tabs/page-tabs.component';

/**
 * `[NAV.7]` Los apartados del sidebar de Finanzas.
 *
 * Dos cosas que se rompen sin que nada truene:
 *  1. `[AUD-A5]` Un apartado que se llama como una de sus pestañas hace que la migaja nombre la
 *     pantalla equivocada (medido en Ruta Directa el 2026-10-20).
 *  2. Plegar renglones en pestañas puede PERDER una pantalla (`[NAV.2]` dejó 19 sin camino) o
 *     repetirla en dos apartados. Acá se fija el universo: las 12 rutas que dejaron de ser
 *     renglones siguen estando, cada una en UN solo apartado, sin chocar con Caja, Pagos ni Gastos.
 */
const APARTADOS: Array<[string, readonly PageTab[]]> = [
  [CORTES_ARQUEOS_LABEL, CORTES_ARQUEOS_TABS],
  [BANCOS_CONCILIACION_LABEL, BANCOS_CONCILIACION_TABS],
  [DEUDA_PROVEEDORES_LABEL, DEUDA_PROVEEDORES_TABS],
  [LIBROS_CONTABLES_LABEL, LIBROS_CONTABLES_TABS],
  [MAAT_LABEL, MAAT_TABS],
];
const EXISTENTES: readonly PageTab[] = [...PAGOS_TABS, ...CAJA_TABS, ...GASTOS_TABS];

describe('[NAV.7] apartados del sidebar de Finanzas', () => {
  it('⛔ NEGATIVA — ningún apartado se llama como una de sus pestañas', () => {
    for (const [nombre, tabs] of APARTADOS) expect(tabs.map((t) => t.label)).not.toContain(nombre);
  });

  it('⛔ NEGATIVA — ningún apartado se llama como una entrada que ya existe (Caja, Pagos, Gastos, Crédito)', () => {
    for (const [nombre] of APARTADOS) expect(['Caja', 'Pagos', 'Gastos', 'Crédito', 'Control (histórico)']).not.toContain(nombre);
  });

  it('CONTROL — cada pestaña tiene ruta de Finanzas y permiso, para que las negativas no midan el vacío', () => {
    for (const [, tabs] of APARTADOS) {
      expect(tabs.length).toBeGreaterThan(1);
      for (const t of tabs) {
        expect(t.route.startsWith('/finanzas/')).toBe(true);
        expect(typeof t.permission === 'string' && t.permission.length > 0).toBe(true);
      }
    }
  });

  it('las rutas que dejaron de ser renglones siguen alcanzables, cada una en UN solo apartado', () => {
    const plegadas = [
      '/finanzas/cortes-sucursales', '/finanzas/cuadre',
      '/finanzas/bancos', '/finanzas/tareas', '/finanzas/cancelados',
      '/finanzas/estado-cuenta-acreedores', '/finanzas/cuadre-proveedor', '/finanzas/pagos-control',
      '/finanzas/egresos', '/finanzas/ingresos',
      '/finanzas/hallazgos', '/finanzas/maat',
    ];
    const nuevas = APARTADOS.flatMap(([, tabs]) => tabs.map((t) => t.route));
    for (const r of plegadas) expect(nuevas.filter((x) => x === r)).toHaveLength(1);
    // y ninguna se repite en las barras que ya existían
    for (const r of nuevas) expect(EXISTENTES.map((t) => t.route)).not.toContain(r);
  });

  it('[PGP.7] Pagos sigue siendo sólo el ciclo vivo: la deuda NO se metió en su barra', () => {
    // `[PGP.20]` (2026-10-27) sumó «Cuentas de pago», que llegó de Compras. Entra porque es un
    // PASO del ciclo —sin la cuenta del proveedor no se prepara la transferencia—, no por tema.
    // Lo que `[PGP.7]` prohíbe sigue prohibido, y es lo que de verdad vigila esta prueba.
    expect(PAGOS_TABS.map((t) => t.route)).toEqual([
      '/finanzas/calendario-pagos',
      '/finanzas/cuentas-pago',
      '/finanzas/pagos-comprobantes',
    ]);
    // ⛔ La guarda que no se puede aflojar: ninguna pantalla de DEUDA entra a esta barra.
    for (const t of DEUDA_PROVEEDORES_TABS) {
      expect(PAGOS_TABS.map((x) => x.route)).not.toContain(t.route);
    }
  });

  it('[PGP.20] «Cuentas de pago» va pegada al Calendario, que es de quien es el paso siguiente', () => {
    const rutas = PAGOS_TABS.map((t) => t.route);
    expect(rutas.indexOf('/finanzas/cuentas-pago')).toBe(rutas.indexOf('/finanzas/calendario-pagos') + 1);
  });
});
