import type { Knex } from 'knex';
import { Permission } from '@megadulces/contracts/authz/permissions';

/**
 * `[SN.7]` — El registro de BANDEJAS de trabajo pendiente que alimenta `GET /users/me/work`.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * La landing mostraba a qué proyectos podés ENTRAR. No decía qué te toca HACER. Este registro es
 * la lista de colas de trabajo que la suite ya construyó (y que ya tienen su pantalla), con su
 * conteo de pendientes al momento y la ruta que las resuelve.
 *
 * ── Lo que se midió en prod antes de escribir esto (2026-09-10) ─────────────────────────────
 * La asignación POR PERSONA existe como diseño en tres tablas y está VACÍA en las tres:
 * `finance.recon_tasks` 0 · `commercial.supervisor_tasks` 0 · `trade.daily_assignments` 0.
 * O sea: hoy nadie reparte trabajo nominalmente. Lo que sí tiene volumen son colas COMPARTIDAS
 * (1,871 descuadres · 1,283 hallazgos de finanzas · 99 acciones de Thot · 76 de Maat · 19 de
 * reabasto · 7 alertas de flota). Por eso cada bandeja declara su `alcance`:
 *   · `'mio'`     — la fila lleva el `user_id` de la persona.
 *   · `'bandeja'` — cola compartida que abre su permiso; NADIE se la asignó.
 * Mezclar las dos sería decirle "tu trabajo" a una cola de la que nadie es responsable.
 *
 * ── Reglas duras ────────────────────────────────────────────────────────────────────────────
 *  1. `anyOf` DEBE ser el permiso que gatea `ruta`. Si no, el número lleva a un rebote — es el
 *     mismo defecto que `landing-guards.spec.ts` encontró en tres destinos de la landing. Hay una
 *     prueba estática que lo verifica contra `app.routes.ts` (`me-work.spec.ts`).
 *  2. Un conteo es información: sólo se cuenta la bandeja cuyo permiso tiene la persona.
 *  3. Lo que no se pudo contar se DECLARA (`no_medido` con motivo), nunca baja a 0 — un cero
 *     dibujado se lee igual que "estás al día" (ADR-056).
 *  4. Una bandeja en 0 NO se pinta. La pantalla no tiene cajas vacías.
 *
 * Conexión: `KNEX_CONNECTION` bypassa RLS (igual que `ReportsService`/`CommercialMapService`), así
 * que el aislamiento es por filtro `tenant_id` EXPLÍCITO en cada conteo. No usar TenantKnexService.
 */

export type AlcancePendiente = 'mio' | 'bandeja';

export interface BandejaDef {
  id: string;
  label: string;
  detalle: string;
  ruta: string;
  icono: string;
  alcance: AlcancePendiente;
  /** Cualquiera de estas claves abre la bandeja. Debe coincidir con el guard de `ruta`. */
  anyOf: readonly Permission[];
  contar: (knex: Knex, tenantId: string, userId: string) => Promise<number>;
}

/** Estados de una sesión de conteo todavía EN VUELO (mig 20260613100000 L110). */
const CONTEO_ACTIVO = ['open', 'counting', 'review', 'ready_to_reconcile'];

async function contarFilas(q: Knex.QueryBuilder): Promise<number> {
  const row = await q.count<{ n: string }[]>({ n: '*' }).first();
  return Number(row?.n ?? 0);
}

export const BANDEJAS: readonly BandejaDef[] = [
  // ── A tu nombre ────────────────────────────────────────────────────────────────────────────
  {
    id: 'conteos-asignados',
    label: 'Conteos de inventario asignados a ti',
    detalle: 'sesiones de conteo abiertas donde apareces como contador',
    ruta: '/almacen/inventory/count',
    icono: 'pi pi-list-check',
    alcance: 'mio',
    anyOf: [Permission.COMMERCIAL_INVENTORY_CONTAR],
    contar: (knex, tenantId, userId) =>
      contarFilas(
        knex('commercial.inventory_count_assignments as a')
          .join('commercial.inventory_counts as ic', function () {
            this.on('ic.id', '=', 'a.count_id').andOn('ic.tenant_id', '=', 'a.tenant_id');
          })
          .where('a.tenant_id', tenantId)
          .where('a.user_id', userId)
          .whereIn('ic.status', CONTEO_ACTIVO),
      ),
  },
  {
    id: 'caducidades-mias',
    label: 'Revisiones de caducidad a tu nombre',
    detalle: 'hojas de revisión que iniciaste y no has enviado',
    ruta: '/tienda/caducidades',
    icono: 'pi pi-clock',
    alcance: 'mio',
    anyOf: [Permission.COMMERCIAL_EXPIRY_VER, Permission.COMMERCIAL_EXPIRY_CAPTURAR],
    contar: (knex, tenantId, userId) =>
      contarFilas(
        knex('commercial.expiry_reviews')
          .where({ tenant_id: tenantId, responsible_user_id: userId, status: 'draft' }),
      ),
  },

  // ── Colas compartidas ──────────────────────────────────────────────────────────────────────
  {
    id: 'cuadre',
    label: 'Descuadres por revisar',
    detalle: 'caja, inventario y cruce · sin clasificar todavía',
    ruta: '/almacen/cuadre',
    icono: 'pi pi-exclamation-triangle',
    alcance: 'bandeja',
    anyOf: [Permission.RECONCILIATION_VER],
    contar: (knex, tenantId) =>
      contarFilas(knex('reconciliation.discrepancies').where({ tenant_id: tenantId, status: 'nuevo' })),
  },
  {
    id: 'finanzas-hallazgos',
    label: 'Hallazgos de finanzas sin triage',
    detalle: 'detectados por Maat · nadie los ha confirmado ni descartado',
    ruta: '/finanzas/hallazgos',
    icono: 'pi pi-flag',
    alcance: 'bandeja',
    anyOf: [Permission.FINANCE_AI_CHAT],
    contar: (knex, tenantId) =>
      contarFilas(knex('finance.findings').where({ tenant_id: tenantId, status: 'nuevo' })),
  },
  {
    id: 'maat-acciones',
    label: 'Acciones de finanzas por aprobar',
    detalle: 'propuestas de Maat esperando una decisión humana',
    ruta: '/finanzas/pagos-control',
    icono: 'pi pi-check-square',
    alcance: 'bandeja',
    anyOf: [Permission.FINANCE_AI_CHAT],
    contar: (knex, tenantId) =>
      contarFilas(knex('finance.proposed_actions').where({ tenant_id: tenantId, estado: 'pending_approval' })),
  },
  {
    id: 'thot-acciones',
    label: 'Acciones comerciales por aprobar',
    detalle: 'propuestas de Thot esperando curación',
    ruta: '/comercial/thot-curation',
    icono: 'pi pi-check-square',
    alcance: 'bandeja',
    anyOf: [Permission.COMMERCIAL_THOT_GESTIONAR],
    contar: (knex, tenantId) =>
      contarFilas(knex('commercial.commercial_actions').where({ tenant_id: tenantId, status: 'pending_approval' })),
  },
  {
    id: 'compras-hallazgos',
    label: 'Hallazgos de reabastecimiento',
    detalle: 'agotados y bajo reorden detectados en el barrido nocturno',
    ruta: '/compras/hallazgos',
    icono: 'pi pi-flag',
    alcance: 'bandeja',
    anyOf: [Permission.COMPRAS_HALLAZGOS_VER],
    contar: (knex, tenantId) =>
      contarFilas(knex('commercial.replenishment_findings').where({ tenant_id: tenantId, status: 'open' })),
  },
  {
    id: 'flota-alertas',
    label: 'Alertas de flota abiertas',
    detalle: 'sin señal o exceso de velocidad · sin acuse',
    ruta: '/logistica/rastreo',
    icono: 'pi pi-bell',
    alcance: 'bandeja',
    anyOf: [Permission.LOGISTICS_FLEET_VER],
    contar: (knex, tenantId) =>
      contarFilas(knex('logistics.fleet_alerts').where({ tenant_id: tenantId, status: 'open' })),
  },
];

/** ¿Esta persona puede abrir esta bandeja? God-mode ve todas; el resto, por clave exacta. */
export function puedeVerBandeja(
  b: BandejaDef,
  permisos: Record<string, boolean> | null | undefined,
  esAdmin: boolean,
): boolean {
  if (esAdmin) return true;
  const p = permisos ?? {};
  return b.anyOf.some((k) => p[k] === true);
}
