import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANDINGS_BY_PROJECT, type LandingCandidate } from './permission.guard';
import { SUITE_SPACES, entryPermissions, findProject } from '../constants/suite-map';
import { Permission } from '../constants/permissions';

/**
 * `[SN.4]` — La puerta que la landing abre NO rebota en el índice del proyecto.
 *
 * Dos compuertas, porque fallan por motivos distintos:
 *
 *  1. COBERTURA — toda clave con la que `/projects` abre un proyecto tiene un candidato en su
 *     `*HomeGuard`. Sin esto, la expansión de visibilidad de ADR-061 reproduce `[AUTHZ.6]`:
 *     medido en prod, 32 cajeros con sólo FINANCE_EXPENSES_CAPTURAR habrían aterrizado en
 *     `/sin-acceso` porque `/finanzas` mandaba fijo a `egresos`.
 *
 *  2. NO REBOTE — la ruta a la que manda cada candidato acepta ESA clave. Se lee `app.routes.ts`
 *     como texto (importarlo arrastra ~300 módulos a jsdom) y se saca, por proyecto, el guard de
 *     cada ruta hija. Un candidato cuya ruta exige OTRA clave es un rebote con dos saltos, y el
 *     árbol y los guards discrepan en varios módulos. Esas discrepancias se DECLARAN en `DEUDA`
 *     con motivo: una nueva pone esto en rojo, y arreglar una obliga a borrarla de la lista (si
 *     no, el spec la acusa como "deuda que ya no existe").
 */

const ROUTES = readFileSync(join(__dirname, '../../app.routes.ts'), 'utf8');

/** Deuda árbol-vs-guard conocida: la clave abre el módulo en el árbol, pero su ruta exige otra. */
const DEUDA: ReadonlyArray<{ perm: Permission; url: string; motivo: string }> = [
  // comercial
  { perm: Permission.COMMERCIAL_INTELLIGENCE_VER, url: '/comercial/command-center', motivo: 'el módulo intelligence apunta a command-center, que exige ANALYTICS_VER; no hay ruta gateada por INTELLIGENCE_VER' },
  { perm: Permission.COMMERCIAL_CARGA_VER, url: '/comercial/orders', motivo: 'el módulo carga apunta a orders (ORDERS_VER)' },
  { perm: Permission.COMMERCIAL_CARGA_GESTIONAR, url: '/comercial/orders', motivo: 'ídem carga' },
  { perm: Permission.COMMERCIAL_SELLOUT_TARGETS_GESTIONAR, url: '/comercial/analisis', motivo: 'la ruta exige SELLOUT_ANALYSIS_VER' },
  { perm: Permission.COMMERCIAL_ORDERS_CREAR, url: '/comercial/orders', motivo: 'manage sin view: la ruta exige ORDERS_VER' },
  { perm: Permission.COMMERCIAL_ORDERS_CONFIRMAR, url: '/comercial/orders', motivo: 'ídem' },
  { perm: Permission.COMMERCIAL_ORDERS_CANCELAR, url: '/comercial/orders', motivo: 'ídem' },
  { perm: Permission.COMMERCIAL_ORDERS_FULFILL, url: '/comercial/orders', motivo: 'ídem' },
  { perm: Permission.COMMERCIAL_PAYMENTS_REGISTRAR, url: '/comercial/orders', motivo: 'ídem' },
  { perm: Permission.COMMERCIAL_PAYMENTS_VERIFICAR, url: '/comercial/orders', motivo: 'ídem' },
  { perm: Permission.COMMERCIAL_PAYMENTS_REVERSAR, url: '/comercial/orders', motivo: 'ídem' },
  { perm: Permission.COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR, url: '/comercial/orders', motivo: 'ídem' },
  { perm: Permission.COMMERCIAL_COMMISSIONS_GESTIONAR, url: '/comercial/comisiones', motivo: 'manage sin view: la ruta exige COMMISSIONS_VER' },
  { perm: Permission.COMMERCIAL_CUSTOMERS_GESTIONAR, url: '/comercial/customers', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_CARTERA_GESTIONAR, url: '/comercial/cartera', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_PRICING_GESTIONAR, url: '/comercial/pricing', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_PROMOTIONS_GESTIONAR, url: '/comercial/promotions', motivo: 'manage sin view (la ruta /empuje sí lo acepta, pero el árbol apunta a /promotions)' },
  { perm: Permission.COMMERCIAL_PRODUCTS_GESTIONAR, url: '/comercial/products', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_THOT_GESTIONAR, url: '/comercial/thot-chat', motivo: 'manage sin view (la ruta /thot-curation sí lo acepta)' },
  { perm: Permission.ROUTE_TICKET_CAPTURE, url: '/comercial/route-tickets', motivo: 'manage sin view: la ruta exige ROUTE_CONTROL_VER' },
  // almacen
  { perm: Permission.EXISTENCIA_GESTIONAR, url: '/almacen/inventory/existencia', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_INVENTORY_AJUSTAR, url: '/almacen/inventory', motivo: 'manage sin view: la ruta exige INVENTORY_VER' },
  { perm: Permission.COMMERCIAL_WAREHOUSES_GESTIONAR, url: '/almacen/warehouses', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_INVENTORY_RECONCILIAR, url: '/almacen/inventory/sessions', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_INVENTORY_ASIGNAR, url: '/almacen/inventory/sessions', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_PREVENTION_GESTIONAR, url: '/almacen/prevencion', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_EXPIRY_CAPTURAR, url: '/almacen/inventory/caducidades', motivo: 'la ruta de almacén exige EXPIRY_VER (la de tienda acepta las dos)' },
  { perm: Permission.RECONCILIATION_GESTIONAR, url: '/almacen/cuadre', motivo: 'manage sin view' },
  { perm: Permission.COMMERCIAL_MOVEMENTS_GESTIONAR, url: '/almacen/movimientos', motivo: 'manage sin view' },
  // compras
  { perm: Permission.EXISTENCIA_GESTIONAR, url: '/compras/existencia', motivo: 'manage sin view' },
  { perm: Permission.COMPRAS_PEDIDO_GESTIONAR, url: '/compras/pedido', motivo: 'manage sin view' },
  { perm: Permission.COMPRAS_RED_GESTIONAR, url: '/compras/red', motivo: 'manage sin view' },
  { perm: Permission.COMPRAS_REQUISICIONES_GESTIONAR, url: '/compras/requisiciones', motivo: 'manage sin view' },
  { perm: Permission.COMPRAS_ORDENES_GESTIONAR, url: '/compras/ordenes', motivo: 'manage sin view' },
  { perm: Permission.COMPRAS_ENTRADAS_VALIDAR, url: '/compras/entradas', motivo: 'la bandeja exige GESTIONAR; VALIDAR solo no abre nada' },
  { perm: Permission.COMPRAS_360_VER, url: '/compras/costo-por-compra', motivo: 'la ruta exige ENTRADAS_VER; medido 2026-08-29: todo rol con 360 tiene ENTRADAS_VER' },
  { perm: Permission.COMPRAS_DESCUENTOS_GESTIONAR, url: '/compras/descuentos', motivo: 'manage sin view' },
  { perm: Permission.COMPRAS_HALLAZGOS_GESTIONAR, url: '/compras/hallazgos', motivo: 'manage sin view' },
  { perm: Permission.COMPRAS_PROVEEDORES_GESTIONAR, url: '/compras/proveedores', motivo: 'manage sin view' },
  { perm: Permission.COMPRAS_CATEGORIAS_GESTIONAR, url: '/compras/categorias', motivo: 'manage sin view' },
  // logistica
  { perm: Permission.LOGISTICS_CARTAPORTE_VER, url: '/logistica/shipments', motivo: 'el módulo cartaporte apunta a shipments (SHIPMENTS_VER)' },
  { perm: Permission.LOGISTICS_CARTAPORTE_GESTIONAR, url: '/logistica/shipments', motivo: 'ídem' },
  { perm: Permission.LOGISTICS_SHIPMENTS_GESTIONAR, url: '/logistica/shipments', motivo: 'manage sin view' },
  { perm: Permission.LOGISTICS_GUIDES_GESTIONAR, url: '/logistica/guides', motivo: 'manage sin view' },
  { perm: Permission.LOGISTICS_FLEET_GESTIONAR, url: '/logistica/fleet', motivo: 'manage sin view' },
  { perm: Permission.LOGISTICS_ROUTE_EXPENSES_GESTIONAR, url: '/logistica/gasto-ruta', motivo: 'manage sin view' },
  { perm: Permission.LOGISTICS_EXPENSES_GESTIONAR, url: '/logistica/costs', motivo: 'manage sin view' },
  { perm: Permission.LOGISTICS_PAYROLL_GESTIONAR, url: '/logistica/payroll', motivo: 'manage sin view' },
  // finanzas
  { perm: Permission.FINANCE_BANK_GESTIONAR, url: '/finanzas/bancos', motivo: 'manage sin view' },
  { perm: Permission.FINANCE_COLLECTIONS_GESTIONAR, url: '/finanzas/cobranza', motivo: 'manage sin view' },
  { perm: Permission.FINANCE_PAYMENTS_GESTIONAR, url: '/finanzas/pagos-comprobantes', motivo: 'manage sin view' },
  { perm: Permission.FINANCE_RECON_ASIGNAR, url: '/finanzas/tareas', motivo: 'la ruta exige BANK_VER' },
  { perm: Permission.FINANCE_RECON_RECIBIR, url: '/finanzas/tareas', motivo: 'la ruta exige BANK_VER (es un marcador para repartir tareas, no un permiso de pantalla)' },
  { perm: Permission.FINANCE_EXPENSES_VER_ALL, url: '/finanzas/solicitudes', motivo: 'la ruta exige EXPENSES_VER' },
  { perm: Permission.FINANCE_EXPENSES_COMPROBAR, url: '/finanzas/solicitudes', motivo: 'ídem' },
  { perm: Permission.FINANCE_FINDINGS_GESTIONAR, url: '/finanzas/solicitudes', motivo: 'ídem' },
  // contabilidad
  { perm: Permission.FISCAL_LISTAS_GESTIONAR, url: '/contabilidad/listas-sat', motivo: 'manage sin view' },
  { perm: Permission.FISCAL_PURCHASE_BOOK_GESTIONAR, url: '/contabilidad/movimientos-no-asociados', motivo: 'manage sin view' },
  { perm: Permission.FISCAL_FACTURAR_GESTIONAR, url: '/contabilidad/facturar', motivo: 'manage sin view' },
  { perm: Permission.FISCAL_DESCARGA_GESTIONAR, url: '/contabilidad/descarga', motivo: 'manage sin view' },
  { perm: Permission.FISCAL_MATERIALIDAD_VER, url: '/contabilidad/materialidad', motivo: 'la ruta exige LISTAS_VER, no MATERIALIDAD_VER' },
  { perm: Permission.FISCAL_MATERIALIDAD_GESTIONAR, url: '/contabilidad/materialidad', motivo: 'ídem' },
  { perm: Permission.FISCAL_CONTAB_GESTIONAR, url: '/contabilidad/contabilidad', motivo: 'manage sin view' },
  { perm: Permission.FISCAL_IMPUESTOS_VER, url: '/contabilidad/impuestos', motivo: 'la ruta exige DIOT_VER, no IMPUESTOS_VER' },
  // admin
  { perm: Permission.ROLES_CONFIGURAR, url: '/admin/roles', motivo: 'manage sin view: la ruta exige ROLES_VER' },
];

/**
 * Guard(s) de cada ruta hija de un proyecto, leídos del texto de `app.routes.ts`.
 * `null` = la ruta existe y no tiene permissionGuard/anyPermissionGuard.
 */
function guardsDelProyecto(prefix: string): Map<string, Permission[] | null> {
  const out = new Map<string, Permission[] | null>();
  // Bloque del proyecto: desde `path: '<prefix>',` (4 espacios) hasta el siguiente top-level path.
  const inicio = ROUTES.search(new RegExp(`^    path: '${prefix}',$`, 'm'));
  if (inicio < 0) return out;
  const resto = ROUTES.slice(inicio + 1);
  const finRel = resto.search(/^    path: '[^']*',$/m);
  const bloque = finRel < 0 ? resto : resto.slice(0, finRel);
  // Rutas hijas (8 espacios de indentación) con lo que sigue hasta la próxima hija.
  const re = /^        path: '([^']*)',([\s\S]*?)(?=^        path: '|^      \}|\n    \]|$(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bloque))) {
    const child = m[1];
    const cuerpo = m[2];
    const one = cuerpo.match(/permissionGuard\(Permission\.([A-Z0-9_]+)\)/);
    const any = cuerpo.match(/anyPermissionGuard\(([^)]*)\)/);
    let perms: Permission[] | null = null;
    if (any) perms = [...any[1].matchAll(/Permission\.([A-Z0-9_]+)/g)].map((x) => x[1] as Permission);
    else if (one) perms = [one[1] as Permission];
    out.set(`/${prefix}${child ? '/' + child : ''}`, perms);
  }
  return out;
}

const clave = (c: { perm: Permission; url: string }) => `${c.perm}→${c.url}`;
const DEUDA_SET = new Set(DEUDA.map(clave));

describe('SN.4 · la puerta que la landing abre no rebota en el índice del proyecto', () => {
  const proyectos = Object.keys(LANDINGS_BY_PROJECT);

  it('hay landing dinámico para cada proyecto con entrada primaria en el mapa (salvo los que tienen guard propio)', () => {
    const conGuardPropio = new Set(['pdv', 'trade', 'televenta', 'reparto']); // storeEntryRedirect, colaboradorGuard, televentaGuard, repartoGuard
    const primarios = SUITE_SPACES.flatMap((s) => s.entries)
      .filter((e) => e.kind === 'project' && !e.crossLink)
      .map((e) => e.project);
    for (const p of primarios) {
      if (conGuardPropio.has(p)) continue;
      expect(proyectos).toContain(p);
    }
  });

  for (const projectId of proyectos) {
    describe(projectId, () => {
      const candidatos: LandingCandidate[] = LANDINGS_BY_PROJECT[projectId];
      const project = findProject(projectId)!;
      const entrada = SUITE_SPACES.flatMap((s) => s.entries).find((e) => e.kind === 'project' && !e.crossLink && e.project === projectId)!;

      it('COBERTURA: toda clave que abre el proyecto desde la landing tiene un candidato', () => {
        const cubiertas = new Set(candidatos.map((c) => c.perm));
        const faltan = entryPermissions(entrada).filter((p) => !cubiertas.has(p));
        expect(faltan).toEqual([]);
      });

      it('los candidatos apuntan dentro del proyecto y sin duplicar clave', () => {
        const vistas = new Set<string>();
        for (const c of candidatos) {
          expect(c.url.startsWith(project.route + '/')).toBe(true);
          expect(vistas.has(c.perm)).toBe(false);
          vistas.add(c.perm);
        }
      });

      it('NO REBOTE: la ruta de cada candidato acepta su clave (o la discrepancia está declarada en DEUDA)', () => {
        const guards = guardsDelProyecto(project.route.slice(1));
        expect(guards.size).toBeGreaterThan(0); // el parser leyó el bloque: un mapa vacío no es coincidencia
        const rebotan: string[] = [];
        const deudaUsada = new Set<string>();
        for (const c of candidatos) {
          if (!guards.has(c.url)) {
            rebotan.push(`${clave(c)} — la ruta no existe en app.routes.ts`);
            continue;
          }
          const g = guards.get(c.url);
          const acepta = g === null || g.includes(c.perm);
          if (acepta) {
            if (DEUDA_SET.has(clave(c))) rebotan.push(`${clave(c)} — está en DEUDA pero YA NO rebota: borrarla de la lista`);
            continue;
          }
          if (DEUDA_SET.has(clave(c))) { deudaUsada.add(clave(c)); continue; }
          rebotan.push(`${clave(c)} — la ruta exige ${g?.join('|')}`);
        }
        expect(rebotan).toEqual([]);
      });
    });
  }

  it('la DEUDA declarada corresponde a candidatos reales (no quedó nada colgado)', () => {
    const todos = new Set(Object.values(LANDINGS_BY_PROJECT).flat().map(clave));
    const colgadas = DEUDA.map(clave).filter((k) => !todos.has(k));
    expect(colgadas).toEqual([]);
  });

  it('PRUEBA NEGATIVA: el parser detecta un candidato que exige otra clave', () => {
    const guards = guardsDelProyecto('finanzas');
    expect(guards.get('/finanzas/egresos')).toEqual([Permission.FINANCE_EXPENSES_VER]);
    // Un candidato inventado que mande a egresos con CAPTURAR rebotaría — y el mapa lo dice.
    expect(guards.get('/finanzas/egresos')!.includes(Permission.FINANCE_EXPENSES_CAPTURAR)).toBe(false);
    // Y anyPermissionGuard se lee como lista.
    expect(guardsDelProyecto('almacen').get('/almacen/movimientos')).toEqual([Permission.COMMERCIAL_MOVEMENTS_VER, Permission.RECONCILIATION_VER]);
  });
});
