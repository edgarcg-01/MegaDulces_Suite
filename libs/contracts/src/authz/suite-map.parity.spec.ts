import { Permission } from './permissions';
import {
  SUITE_SPACES,
  entryPermissions,
  visibleSuiteMap,
  type SuiteEntry,
  type SuiteSpace,
} from './suite-map';

/**
 * `[SN.1]` — PARIDAD: nadie que veía una tarjeta en la landing vieja deja de ver su destino.
 *
 * Es el criterio de salida de la Etapa 2 de la especificación (§24: "funciones existentes
 * accesibles sin pérdida de permisos"). La fixture de abajo es la copia CONGELADA de los `anyOf`
 * de las 11 tarjetas de `apps/view/.../projects.component.ts` al 2026-09-10, el día que esa
 * lista dejó de existir. No se deriva del árbol a propósito: derivarla sería comparar el mapa
 * consigo mismo.
 *
 * Dos aserciones por tarjeta:
 *  1. cada clave legacy sigue estando entre las que ABREN la entrada destino;
 *  2. una persona con UNA sola de esas claves (y sin rol excluido) ve la entrada destino.
 * La segunda es la que importa: la primera puede ser verdad y la segunda falsa si un `alsoAnyOf`
 * cierra la puerta por otro lado.
 *
 * Y la prueba negativa: quitarle una clave al gate de Trade tiene que poner esto en rojo.
 */

interface TarjetaLegacy {
  card: string;
  destino: string;
  anyOf: readonly Permission[];
  hideForRoles?: readonly string[];
  /**
   * Claves cuyo destino SE MUDÓ a propósito después del 2026-09-10.
   *
   * ⛔ No es una lista de excepciones: es la misma garantía apuntando a otro lado. La clave sigue
   * teniendo que abrir *algo*, sólo que otro espacio. Borrar la clave de `anyOf` habría hecho
   * pasar el spec dejando de vigilarla, que es exactamente cómo una puerta se pierde en silencio.
   */
  movidas?: readonly { perm: Permission; a: string; motivo: string }[];
}

const TARJETAS_2026_09_10: readonly TarjetaLegacy[] = [
  {
    card: 'trade-marketing · Auditoría en Ruta',
    destino: 'rutas-auditoria',
    anyOf: [
      Permission.VISITAS_REGISTRAR,
      Permission.REPORTES_VER_PROPIO,
      Permission.REPORTES_VER_EQUIPO,
      Permission.REPORTES_VER_GLOBAL,
      Permission.TIENDAS_VER,
      Permission.VER_SEGUIMIENTO,
      Permission.PLANOGRAMAS_GESTIONAR,
      Permission.CATALOGO_GESTIONAR,
      Permission.USUARIOS_ASIGNAR_RUTA,
    ],
  },
  {
    card: 'comercial · Ventas',
    destino: 'ventas-backoffice',
    anyOf: [
      Permission.COMMERCIAL_ORDERS_VER,
      Permission.COMMERCIAL_ORDERS_CREAR,
      Permission.COMMERCIAL_CUSTOMERS_VER,
      Permission.COMMERCIAL_CUSTOMERS_GESTIONAR,
      Permission.COMMERCIAL_PRICING_VER,
      Permission.COMMERCIAL_ANALYTICS_VER,
      Permission.COMMERCIAL_SELLOUT_VER,
      Permission.COMMERCIAL_SALIDAS_VER,
      Permission.COMMERCIAL_ROUTE_SALES_VER,
      Permission.COMMERCIAL_SALES_DOCS_VER,
      Permission.COMMERCIAL_CUSTOMERS360_VER,
      Permission.COMMERCIAL_HISTORICAL_VER,
      Permission.COMMERCIAL_ERP_PROMOS_VER,
      Permission.COMMERCIAL_VENDOR_SALES_VER,
    ],
    hideForRoles: ['vendedor'],
    // `[MKT.0]` (posterior al congelado): Promos del ERP se mudó de `/comercial/erp-promos` al
    // proyecto propio MKT (`/mkt/erp-promos`), mismo espacio Comercial. La clave sigue abriendo
    // su pantalla — la única que abría —, ahora bajo la tarjeta MKT en vez de Ventas.
    movidas: [
      {
        perm: Permission.COMMERCIAL_ERP_PROMOS_VER,
        a: 'mkt',
        motivo: '[MKT.0] Promos del ERP pasó de /comercial/erp-promos a /mkt/erp-promos',
      },
    ],
  },
  {
    card: 'almacen · Almacén',
    destino: 'almacenes',
    anyOf: [
      Permission.COMMERCIAL_INVENTORY_VER,
      Permission.COMMERCIAL_WAREHOUSES_VER,
      Permission.COMMERCIAL_DEADSTOCK_VER,
      Permission.COMMERCIAL_INVHEALTH_VER,
      Permission.RECONCILIATION_VER,
      Permission.COMMERCIAL_INVENTORY_RECIBIR,
      Permission.COMMERCIAL_INVENTORY_SUPERVISAR,
      Permission.COMMERCIAL_INVENTORY_CONTAR,
      Permission.COMMERCIAL_INVENTORY_ASIGNAR,
      Permission.COMMERCIAL_EXPIRY_VER,
      Permission.COMMERCIAL_EXPIRY_CAPTURAR,
      Permission.COMMERCIAL_MOVEMENTS_VER,
      Permission.COMMERCIAL_PREVENTION_VER,
    ],
    // `[SM.9]` (posterior al congelado): el Cuadre / Supervisor de Movimientos se mudó de
    // `/almacen/cuadre` a `/finanzas/cuadre` — cuadra el arqueo ciego contra el corte de caja, no
    // era de almacén. Con eso `RECONCILIATION_VER` dejó de abrir «Almacenes» y pasó a abrir
    // «Administración y Finanzas». Es el destino el que se movió, no la puerta la que se cerró.
    //
    // Medido en prod (2026-09-21) antes de aceptarlo: los 10 roles que tienen RECONCILIATION_VER
    // tienen ADEMÁS COMMERCIAL_INVENTORY_VER (9 de ellos, 22 usuarios) o FINANCE_BANK_VER
    // (`auditor_externo`, 0 usuarios) — **ningún usuario real perdió acceso a nada**. La aserción
    // sigue vigilando la clave; sólo cambia contra qué espacio.
    movidas: [
      {
        perm: Permission.RECONCILIATION_VER,
        a: 'finanzas',
        motivo: '[SM.9] Cuadre pasó de /almacen/cuadre a /finanzas/cuadre (ADR-029)',
      },
    ],
  },
  {
    card: 'compras · Compras',
    destino: 'compras',
    anyOf: [
      Permission.COMPRAS_PEDIDO_VER, Permission.COMPRAS_RED_VER, Permission.COMPRAS_REQUISICIONES_VER,
      Permission.COMPRAS_ORDENES_VER, Permission.COMPRAS_ENTRADAS_VER, Permission.COMPRAS_360_VER,
      Permission.COMPRAS_COSTO_NETO_VER, Permission.COMPRAS_DESCUENTOS_VER, Permission.COMPRAS_HALLAZGOS_VER,
      Permission.COMPRAS_PROVEEDORES_VER, Permission.COMPRAS_CATEGORIAS_VER,
    ],
  },
  {
    card: 'televenta · Telemarketing',
    destino: 'mayoreo-telemarketing',
    anyOf: [Permission.COMMERCIAL_TELEVENTA_OPERATE, Permission.COMMERCIAL_TELEVENTA_VER],
  },
  {
    card: 'logistica · Logística',
    destino: 'transporte-y-embarques',
    anyOf: [
      Permission.LOGISTICS_SHIPMENTS_VER,
      Permission.LOGISTICS_FLEET_VER,
      Permission.LOGISTICS_PAYROLL_VER,
      Permission.LOGISTICS_EXPENSES_VER,
      Permission.LOGISTICS_TRANSFERS_VER,
    ],
  },
  {
    card: 'tienda · Tienda',
    destino: 'pisos-de-venta',
    anyOf: [
      Permission.STORE_LIVE_VER,
      Permission.STORE_LABELS_VER,
      Permission.STORE_ARQUEO_VER,
      Permission.STORE_ARQUEO_CAPTURAR,
      Permission.COMMERCIAL_EXPIRY_VER,
      Permission.COMMERCIAL_EXPIRY_CAPTURAR,
    ],
  },
  { card: 'reparto · Reparto', destino: 'entregas-reparto', anyOf: [Permission.REPARTO_DESPACHAR] },
  { card: 'finanzas · Finanzas', destino: 'finanzas', anyOf: [Permission.FINANCE_EXPENSES_VER] },
  {
    card: 'contabilidad · Contabilidad',
    destino: 'contabilidad',
    anyOf: [
      Permission.FISCAL_LISTAS_VER,
      Permission.FISCAL_CFDI_VER,
      Permission.FISCAL_CONCILIACION_VER,
      Permission.FISCAL_DIOT_VER,
      Permission.FISCAL_CONTAB_VER,
      Permission.FISCAL_DESCARGA_VER,
      Permission.FISCAL_CREDENCIALES_GESTIONAR,
    ],
  },
  {
    card: 'admin · Administración',
    destino: 'configuracion-suite',
    anyOf: [Permission.USUARIOS_GESTIONAR, Permission.ROLES_CONFIGURAR],
  },
];

const buscar = (mapa: readonly SuiteSpace[], id: string): SuiteEntry => {
  const e = mapa.flatMap((s) => s.entries).find((x) => x.id === id);
  if (!e) throw new Error(`la entrada destino ${id} no existe en el mapa`);
  return e;
};

/**
 * Puertas que se pierden: (tarjeta, clave) tal que una persona con SÓLO esa clave ya no ve el
 * destino. Una clave declarada en `movidas` se juzga contra su destino NUEVO — sigue exigiéndosele
 * que abra algo, que es la garantía entera; lo único que cambia es contra qué.
 */
function puertasPerdidas(
  mapa: readonly SuiteSpace[],
  tarjetas: readonly TarjetaLegacy[] = TARJETAS_2026_09_10,
): string[] {
  const perdidas: string[] = [];
  for (const t of tarjetas) {
    for (const perm of t.anyOf) {
      const mudanza = t.movidas?.find((m) => m.perm === perm);
      const destinoId = mudanza ? mudanza.a : t.destino;
      const destino = buscar(mapa, destinoId);
      const abren = new Set(entryPermissions(destino));
      if (!abren.has(perm)) perdidas.push(`${t.card} → ${perm} ya no abre ${destinoId}`);
      const vis = visibleSuiteMap({ [perm]: true }, false, null, mapa);
      const ve = vis.spaces.some((s) => s.entries.some((e) => e.entry.id === destinoId));
      if (!ve) perdidas.push(`${t.card} → con sólo ${perm} no se ve ${destinoId}`);
    }
  }
  return perdidas;
}

describe('paridad · la landing nueva no cierra ninguna puerta de la vieja', () => {
  it('las 11 tarjetas legacy conservan todas sus claves y todas sus puertas', () => {
    expect(puertasPerdidas(SUITE_SPACES)).toEqual([]);
  });

  /*
   * ⛔ `movidas` es la única puerta de escape de este spec, así que se le pone reja por los dos
   * lados: no puede declararse una mudanza que no ocurrió, ni una que lleve a la nada.
   */
  it('una mudanza declarada es REAL: la clave ya no abre el destino viejo', () => {
    for (const t of TARJETAS_2026_09_10) {
      for (const m of t.movidas ?? []) {
        const viejo = new Set(entryPermissions(buscar(SUITE_SPACES, t.destino)));
        // Si todavía abriera el destino original, la mudanza sería un pretexto para no vigilarla.
        expect(`${m.perm} sigue abriendo ${t.destino}: ${viejo.has(m.perm)}`).toBe(
          `${m.perm} sigue abriendo ${t.destino}: false`,
        );
        expect(m.motivo.length).toBeGreaterThan(20);
      }
    }
  });

  it('PRUEBA NEGATIVA: una mudanza hacia un espacio que la clave NO abre se detecta', () => {
    const mentira: TarjetaLegacy[] = TARJETAS_2026_09_10.map((t) =>
      t.destino === 'almacenes'
        ? {
            ...t,
            movidas: [
              {
                perm: Permission.RECONCILIATION_VER,
                a: 'compras',
                motivo: 'mudanza inventada para la prueba negativa',
              },
            ],
          }
        : t,
    );
    expect(puertasPerdidas(SUITE_SPACES, mentira).join('\n')).toMatch(
      /RECONCILIATION_VER.*compras/,
    );
  });

  it('cada tarjeta tiene su destino en el mapa (la fixture no quedó colgada)', () => {
    for (const t of TARJETAS_2026_09_10) expect(buscar(SUITE_SPACES, t.destino).id).toBe(t.destino);
    expect(TARJETAS_2026_09_10).toHaveLength(11);
  });

  it('el recorte al vendedor se conserva tal cual (era de la tarjeta, no del árbol)', () => {
    const ventas = buscar(SUITE_SPACES, 'ventas-backoffice');
    expect(ventas.hideForRoles).toEqual(['vendedor']);
    const t = TARJETAS_2026_09_10.find((x) => x.destino === 'ventas-backoffice')!;
    expect(t.hideForRoles).toEqual(['vendedor']);
  });

  it('PRUEBA NEGATIVA: quitarle una clave al gate de Trade se detecta', () => {
    const roto: SuiteSpace[] = SUITE_SPACES.map((s) => ({
      ...s,
      entries: s.entries.map((e) =>
        e.id === 'rutas-auditoria' && e.gate?.anyOf
          ? { ...e, gate: { ...e.gate, anyOf: e.gate.anyOf.filter((p) => p !== Permission.USUARIOS_ASIGNAR_RUTA) } }
          : e,
      ),
    }));
    const perdidas = puertasPerdidas(roto);
    expect(perdidas.length).toBeGreaterThan(0);
    expect(perdidas.join('\n')).toMatch(/USUARIOS_ASIGNAR_RUTA/);
  });

  it('PRUEBA NEGATIVA: un alsoAnyOf en una entrada de proyecto cierra puertas aunque las claves sigan ahí', () => {
    const roto: SuiteSpace[] = SUITE_SPACES.map((s) => ({
      ...s,
      entries: s.entries.map((e) =>
        e.id === 'compras'
          ? { ...e, gate: { alsoAnyOf: [Permission.REPORTES_VER_GLOBAL], reason: 'para probar' } }
          : e,
      ),
    }));
    const perdidas = puertasPerdidas(roto);
    // Las claves siguen abriendo (aserción 1 pasa) pero nadie con una sola clave la ve (aserción 2 cae).
    expect(perdidas.every((p) => /con sólo .* no se ve compras/.test(p))).toBe(true);
    expect(perdidas).toHaveLength(11);
  });
});
