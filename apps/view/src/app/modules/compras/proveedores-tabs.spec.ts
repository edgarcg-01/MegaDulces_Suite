import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PROVEEDORES_LABEL, PROVEEDORES_TABS } from './proveedores-tabs';
import { SEGUIMIENTO_COMPRA_LABEL, SEGUIMIENTO_COMPRA_TABS } from './seguimiento-compra-tabs';
import { ALERTAS_ABASTO_LABEL, ALERTAS_ABASTO_TABS } from './alertas-abasto-tabs';
import { PAGO_PROVEEDOR_LABEL, PAGO_PROVEEDOR_TABS } from './pago-proveedor-tabs';
import { COSTOS_COMPRA_LABEL, COSTOS_COMPRA_TABS } from './costos-compra-tabs';
import { PARAMETROS_COMPRA_LABEL, PARAMETROS_COMPRA_TABS } from './parametros-compra-tabs';
import { ENTRADAS_CONTROL_TABS } from './entradas-control-tabs';
import { CATALOGO_TABS } from './catalogo-tabs';
import { primeraPestanaVisible } from '../../shared/components/page-tabs/pestanas-de-area';
import { Permission } from '../../core/constants/permissions';
import type { PageTab } from '../../shared/components/page-tabs/page-tabs.component';

/**
 * `[PQ.3.23]` El apartado «Proveedores» de Compras (DC32, anexo C §9).
 *
 * Tres cosas que se rompen sin que nada truene:
 *  1. `[AUD-A5]` Que otra pestaña del menú de Compras se siga llamando «Proveedores»: la de Parámetros de compra
 *     se llamaba así, y dos lugares del mismo menú con un nombre llevan a la persona al equivocado.
 *  2. `[PF.12.1]` Que una pestaña abra un marcador vacío («Contenido por desarrollar»): sólo es pestaña lo que existe.
 *  3. Que alguna de las tres llaves del calendario (DC7) se quede sin la entrada del menú.
 */
const TODAS_LAS_PESTANAS: Array<[string, readonly PageTab[]]> = [
  [SEGUIMIENTO_COMPRA_LABEL, SEGUIMIENTO_COMPRA_TABS],
  [ALERTAS_ABASTO_LABEL, ALERTAS_ABASTO_TABS],
  [PAGO_PROVEEDOR_LABEL, PAGO_PROVEEDOR_TABS],
  [COSTOS_COMPRA_LABEL, COSTOS_COMPRA_TABS],
  [PARAMETROS_COMPRA_LABEL, PARAMETROS_COMPRA_TABS],
  ['Control de entradas', ENTRADAS_CONTROL_TABS],
  ['Catálogo', CATALOGO_TABS],
  [PROVEEDORES_LABEL, PROVEEDORES_TABS],
];

/**
 * Las rutas de Compras que hoy son marcadores vacíos, leídas de `app.routes.ts` (no de una lista a mano): las que
 * abren `compras-catalogo-apartado.component.ts` con `data: { catalogoApartado }`. Se parte el archivo en un tramo
 * por `path:` para que la marca de una ruta no se le cuelgue a la anterior.
 */
const RUTAS = readFileSync(join(__dirname, '..', '..', 'app.routes.ts'), 'utf8');
const MARCADORES = RUTAS.split(/(?=path: ')/)
  .filter((tramo) => /catalogoApartado: '/.test(tramo))
  .map((tramo) => '/compras/' + (/path: '([^']+)'/.exec(tramo) as RegExpExecArray)[1]);

describe('[PQ.3.23] el apartado Proveedores de Compras', () => {
  it('⛔ NEGATIVA — ninguna pestaña del menú de Compras se llama «Proveedores» (es el nombre del apartado)', () => {
    // Con la pestaña de Parámetros de compra otra vez como «Proveedores», esta línea se cae.
    for (const [, tabs] of TODAS_LAS_PESTANAS) {
      expect(tabs.map((t) => t.label)).not.toContain(PROVEEDORES_LABEL);
    }
  });

  it('⛔ NEGATIVA — ninguna pestaña del apartado abre un marcador vacío (sólo es pestaña lo que existe)', () => {
    for (const t of PROVEEDORES_TABS) expect(MARCADORES).not.toContain(t.route);
  });

  it('CONTROL — la lectura de marcadores encuentra los cuatro de hoy, para que la negativa no mida el vacío', () => {
    // Incluye el de «Listas de precios de proveedores»: el apartado que se muda aquí cuando tenga pantalla (PQ.155).
    expect([...MARCADORES].sort()).toEqual([
      '/compras/catalogo/incidencias', '/compras/catalogo/listas-precios', '/compras/catalogo/resumen', '/compras/catalogo/solicitudes',
    ]);
  });

  it('el Calendario es la primera pestaña y la ve quien tenga CUALQUIERA de las tres llaves (DC7)', () => {
    expect(PROVEEDORES_TABS[0].route).toBe('/compras/calendario');
    const llaves = [Permission.COMPRAS_CALENDARIO_VER, Permission.COMPRAS_CALENDARIO_GESTIONAR, Permission.COMPRAS_CALENDARIO_CICLO];
    for (const llave of llaves) {
      expect(primeraPestanaVisible(PROVEEDORES_TABS, (p) => p === llave)?.route).toBe('/compras/calendario');
    }
    // Sin ninguna de las tres, la entrada no se pinta.
    expect(primeraPestanaVisible(PROVEEDORES_TABS, (p) => p === Permission.COMPRAS_PEDIDO_VER)).toBeNull();
  });

  it('el Calendario vive en UN solo apartado y la pestaña de Parámetros conserva su ruta', () => {
    const todas = TODAS_LAS_PESTANAS.flatMap(([, tabs]) => tabs.map((t) => t.route));
    expect(todas.filter((r) => r === '/compras/calendario')).toHaveLength(1);
    expect(PARAMETROS_COMPRA_TABS.find((t) => t.route === '/compras/proveedores')?.label).toBe('Por proveedor');
  });
});
