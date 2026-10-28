import { PRECIOS_APARTADO_LABEL, PRECIOS_APARTADO_TABS } from './precios-apartado-tabs';
import { VENDEDORES_LABEL, VENDEDORES_TABS } from './vendedores-tabs';
import { VENTAS_RENTABILIDAD_LABEL, VENTAS_RENTABILIDAD_TABS } from './ventas-rentabilidad-tabs';
import { ANALYTICS_LABEL, ANALYTICS_TABS } from './analytics-tabs';
import { REPORTES_GENERALES_TABS } from './reports-tabs';
import { TELEMARKETING_TABS } from './telemarketing-tabs';
import { CUSTOMERS_TABS } from './customers-tabs';
import { RUTA_DIRECTA_TABS } from './ruta-directa-tabs';
import { Permission } from '../../core/constants/permissions';
import type { PageTab } from '../../shared/components/page-tabs/page-tabs.component';

/**
 * `[NAV.8]` Los apartados del sidebar de Comercial.
 *
 * Lo que se rompe sin que nada truene al plegar renglones en pestañas:
 *  1. `[AUD-A5]` un apartado que se llama como una de sus pestañas hace que la migaja nombre la
 *     pantalla equivocada;
 *  2. `[NAV.2]` una pantalla puede quedar SIN camino, o repetida en dos apartados;
 *  3. una pestaña con un permiso distinto al de su renglón cambia quién la ve. Acá se calca.
 */
const APARTADOS: Array<[string, readonly PageTab[]]> = [
  [PRECIOS_APARTADO_LABEL, PRECIOS_APARTADO_TABS],
  [VENDEDORES_LABEL, VENDEDORES_TABS],
  [VENTAS_RENTABILIDAD_LABEL, VENTAS_RENTABILIDAD_TABS],
  [ANALYTICS_LABEL, ANALYTICS_TABS],
];

/** Los renglones que dejaron de existir, con el permiso que tenían en el sidebar (HEAD antes de [NAV.8]). */
const RENGLONES_PLEGADOS: Array<[string, Permission]> = [
  ['/comercial/pricing', Permission.COMMERCIAL_PRICING_VER],
  ['/comercial/cartera', Permission.USUARIOS_ASIGNAR_RUTA],
  ['/comercial/route-tickets', Permission.ROUTE_CONTROL_VER],
  ['/comercial/vendor-sales', Permission.COMMERCIAL_VENDOR_SALES_VER],
  ['/comercial/rentabilidad', Permission.COMMERCIAL_PROFITABILITY_VER],
  ['/comercial/ventas-generales', Permission.COMMERCIAL_ANALYTICS_VER],
  ['/comercial/wincaja', Permission.COMMERCIAL_ANALYTICS_VER],
  ['/comercial/command-center', Permission.COMMERCIAL_ORDERS_VER],
  ['/comercial/razonamiento', Permission.COMMERCIAL_THOT_VER],
  // `[NAV.8.2]`
  ['/comercial/empuje', Permission.COMMERCIAL_PROMOTIONS_GESTIONAR],
];

describe('[NAV.8] apartados del sidebar de Comercial', () => {
  it('⛔ NEGATIVA — ningún apartado se llama como una de sus pestañas', () => {
    for (const [nombre, tabs] of APARTADOS) expect(tabs.map((t) => t.label)).not.toContain(nombre);
  });

  it('⛔ NEGATIVA — ningún apartado se llama como una entrada que sigue existiendo', () => {
    for (const [nombre] of APARTADOS) {
      expect(['Pedidos', 'Clientes', 'Tickets', 'Facturación', 'Promociones', 'Ruta Directa', 'Reportes de venta']).not.toContain(nombre);
    }
  });

  it('CONTROL — cada pestaña tiene ruta de Comercial y gate, para que las negativas no midan el vacío', () => {
    for (const [, tabs] of APARTADOS) {
      expect(tabs.length).toBeGreaterThan(1);
      for (const t of tabs) {
        expect(t.route.startsWith('/comercial/')).toBe(true);
        expect(Boolean(t.permission) || Boolean(t.anyOf?.length)).toBe(true);
      }
    }
  });

  it('cada renglón plegado sigue alcanzable en UN solo apartado, con el MISMO permiso que tenía', () => {
    const todas = APARTADOS.flatMap(([, tabs]) => tabs);
    for (const [ruta, permiso] of RENGLONES_PLEGADOS) {
      const hits = todas.filter((t) => t.route === ruta);
      expect(hits).toHaveLength(1);
      expect(hits[0].permission).toBe(permiso);
    }
  });

  it('ninguna pestaña nueva se repite en las barras que ya existían (Clientes, Ruta Directa, Reportes de venta)', () => {
    const existentes = [...CUSTOMERS_TABS, ...RUTA_DIRECTA_TABS, ...REPORTES_GENERALES_TABS].map((t) => t.route);
    for (const [, tabs] of APARTADOS) for (const t of tabs) expect(existentes).not.toContain(t.route);
  });

  it('[NAV.8.1] ⛔ NEGATIVA — Reportes de venta y Ruta Directa no comparten pestañas (una barra por entrada)', () => {
    const rd = RUTA_DIRECTA_TABS.map((t) => t.route);
    for (const t of REPORTES_GENERALES_TABS) expect(rd).not.toContain(t.route);
  });

  it('[NAV.8.2] ⛔ NEGATIVA — Facturación TM no cuelga de Reportes de venta: su barra es la que pinta su página', () => {
    // /comercial/documentos pinta TELEMARKETING_TABS; colgarla de otra barra hace que al abrirla
    // la barra salte de apartado.
    expect(REPORTES_GENERALES_TABS.map((t) => t.route)).not.toContain('/comercial/documentos');
    expect(TELEMARKETING_TABS.map((t) => t.route)).toContain('/comercial/documentos');
  });

  it('«En vivo» (el Centro de Control) es la PRIMERA de Analítica: la entrada sigue llevando ahí', () => {
    expect(ANALYTICS_TABS[0].route).toBe('/comercial/command-center');
  });

  it('Control de margen se mudó a Precios entero: mismo orden, después de Listas', () => {
    expect(PRECIOS_APARTADO_TABS.map((t) => t.route)).toEqual([
      '/comercial/pricing',
      '/comercial/precios/motor',
      '/comercial/precios/competencia',
      '/comercial/precios/experimentos',
    ]);
    // Experimentos conserva su anyOf (VER o GESTIONAR): con un permiso único, quien sólo
    // gestiona perdería la pestaña aunque la ruta lo dejara entrar.
    expect(PRECIOS_APARTADO_TABS[3].anyOf).toEqual([
      Permission.COMMERCIAL_PRICE_EXPERIMENT_VER,
      Permission.COMMERCIAL_PRICE_EXPERIMENT_GESTIONAR,
    ]);
  });
});
