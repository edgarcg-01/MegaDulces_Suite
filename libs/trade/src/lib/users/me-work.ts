import type { Knex } from 'knex';
import { Permission } from '@megadulces/contracts/authz/permissions';
import { branchKeySql } from '@megadulces/platform-core';

/**
 * `[SN.7]` — El registro de BANDEJAS de trabajo pendiente que alimenta `GET /users/me/work`.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * La landing mostraba a qué proyectos podés ENTRAR. No decía qué te toca HACER. Este registro es
 * la lista de colas de trabajo que la suite ya construyó (y que ya tienen su pantalla), con su
 * conteo de pendientes al momento y la ruta que las resuelve.
 *
 * ── ⚠️ `[SN.15]` Corrección de una medición vencida ─────────────────────────────────────────
 * Acá decía —y la landing publicaba— que las tres tablas de asignación nominal estaban en CERO
 * filas (medición del 2026-09-10). **Era falso.** Medido de nuevo el 2026-09-11 contra prod:
 * `finance.recon_tasks` 15 abiertas · `commercial.supervisor_tasks` 2 · `inventory_count_
 * assignments` 18 · `trade.daily_assignments` 119 → **151 tareas vivas sobre 38 de 118 personas**.
 * La frase «Nadie te asignó trabajo hoy» mentía para un tercio del padrón.
 *
 * Lo asignado se mudó a `me-tasks.ts`, que es donde vive la tercera pregunta. Este archivo se
 * queda con las otras dos, y **la regla que las separa** (`work/task.contract.ts`) es:
 *
 *   > El PERMISO decide si podés ABRIRLO; la RESPONSABILIDAD decide si es TUYO; la TAREA dice que
 *   > alguien te lo asignó. **Una cola sin `assigned_to` no es una tarea: es una bandeja.**
 *
 * Por eso `conteos-asignados` YA NO ESTÁ ACÁ: su fila trae `assigned_by`, o sea que alguien te la
 * repartió — es una tarea. Lo que queda es:
 *   · `'mio'`     — trabajo propio que esta persona EMPEZÓ (nadie se lo asignó): su borrador.
 *   · `'bandeja'` — cola COMPARTIDA que abre su permiso. Nadie la repartió.
 *
 * ── Reglas duras ────────────────────────────────────────────────────────────────────────────
 *  1. `anyOf` DEBE ser el permiso que gatea `ruta`. Si no, el número lleva a un rebote — el mismo
 *     defecto que `landing-guards.spec.ts` encontró en tres destinos. Lo verifica el **bloque 4 de
 *     `database/tests/test-newdb-me-context.js`** contra `app.routes.ts`.
 *     ⚠️ Acá decía "y `me-work.spec.ts`": ese archivo NO EXISTE, y `libs/trade` no tiene runner de
 *     pruebas (sólo `lint`), así que crearlo habría sido una prueba huérfana más — la Fase VP contó
 *     21. Los candados de este registro viven todos en el smoke, que sí corre en `run-all-tests.js`.
 *  2. Un conteo es información: sólo se cuenta la bandeja cuyo permiso tiene la persona.
 *  3. Lo que no se pudo contar se DECLARA (`no_medido` con motivo), nunca baja a 0 — un cero
 *     dibujado se lee igual que "estás al día" (ADR-056).
 *  4. Una bandeja en 0 NO se pinta. La pantalla no tiene cajas vacías.
 *  5. `responsabilidad` es la MISMA clave que `identity.responsibilities` (catálogo de `[OR.1b]`).
 *     Eran dos vocabularios para las mismas ocho colas (`cuadre` acá, `almacen.cuadre` allá) sin
 *     mapeo en código; sin esta columna, el día que `[OR.3]` enrute no va a poder cruzar.
 *
 * Conexión: `KNEX_CONNECTION` bypassa RLS (igual que `ReportsService`/`CommercialMapService`), así
 * que el aislamiento es por filtro `tenant_id` EXPLÍCITO en cada conteo. No usar TenantKnexService.
 */

export type AlcancePendiente = 'mio' | 'bandeja';

/** Las 8 claves de `identity.responsibilities` (`[OR.1b]`). Biyección verificada por el candado. */
export type ResponsabilidadKey =
  | 'finanzas.hallazgos'
  | 'finanzas.acciones'
  | 'almacen.cuadre'
  | 'compras.reabasto'
  | 'almacen.conteo'
  | 'tienda.caducidades'
  | 'logistica.flota'
  | 'comercial.thot';

/**
 * `[SN.15]` Lo que cada conteo necesita saber de quién pregunta.
 *
 * `sucursales` viene de `ScopeService` (dimensión `warehouse`, ADR-050) y son **códigos**
 * (`'00'..'06'`, `'MD-30'`), que es lo que guarda la ficha — las tablas guardan el uuid del
 * almacén, así que el filtro pasa por `commercial.warehouses`.
 *
 * ⛔ `null` significa **"no acotar"**, y cubre dos casos que NO se deben confundir con "nada":
 * alcance `all`, y una ficha sin sucursal (`resolvable: false`). Medido en prod: el **74%** de
 * quienes ven la bandeja de reabasto no tienen `warehouse_code`. Si a esa gente se le acotara a
 * `[]`, vería **0** y leería "estoy al día" — el default disfrazado que ADR-056 prohíbe. Un array
 * vacío nunca llega acá: se convierte en `null` y la fila se rotula "de toda la red".
 */
export interface MedirCtx {
  tenantId: string;
  userId: string;
  sucursales: string[] | null;
}

/**
 * `[SN.12]` Lo que una bandeja reporta. El `total` solo no alcanza para ordenar: el orden por
 * volumen pone 1,865 descuadres arriba y 5 alertas de flota abajo, cuando un vehículo sin señal
 * probablemente urge más. `mas_viejo_at` es el segundo dato —cuándo entró el pendiente más
 * antiguo— y es lo que convierte una lista en una prioridad. `null` = no se pudo medir; se
 * DECLARA, no se asume "reciente" (ADR-056).
 */
export interface MedidaCola {
  total: number;
  mas_viejo_at: string | null;
}

export interface BandejaDef {
  id: string;
  label: string;
  detalle: string;
  ruta: string;
  icono: string;
  alcance: AlcancePendiente;
  /** La misma cola en el catálogo de `[OR.1b]`. Un solo vocabulario para las dos mitades. */
  responsabilidad: ResponsabilidadKey;
  /**
   * `true` si la tabla tiene columna de sucursal y el conteo SE ACOTA cuando la ficha lo permite.
   * La pantalla lo usa para rotular honestamente: acotado, o "de toda la red".
   * Medido en la mig `20260911140000`: sólo 3 de las 8 colas tienen eje, y de esas, 2 ya filtran
   * por persona — así que la única que gana algo real acá es el reabasto.
   */
  acotablePorSucursal: boolean;
  /** Cualquiera de estas claves abre la bandeja. Debe coincidir con el guard de `ruta`. */
  anyOf: readonly Permission[];
  medir: (knex: Knex, ctx: MedirCtx) => Promise<MedidaCola>;
}

/**
 * Cuenta y fecha la cola en UNA sola pasada (`count(*)` + `min(<fecha>)`). Dos consultas por
 * bandeja duplicarían el trabajo de las ocho sin comprar nada: el filtro es el mismo.
 * `columnaFecha` se declara por bandeja porque en una cola con JOIN importa cuál de las dos
 * fechas es la que le habla a la persona.
 */
async function medirCola(knex: Knex, q: Knex.QueryBuilder, columnaFecha: string): Promise<MedidaCola> {
  const row = await q
    .clearSelect()
    .select(knex.raw('count(*) as n'), knex.raw('min(??) as viejo', [columnaFecha]))
    .first<{ n: string | number; viejo: Date | string | null }>();
  const viejo = row?.viejo ?? null;
  return {
    total: Number(row?.n ?? 0),
    mas_viejo_at: viejo ? new Date(viejo).toISOString() : null,
  };
}

export const BANDEJAS: readonly BandejaDef[] = [
  // ── Trabajo propio: lo empezó esta persona, nadie se lo asignó ─────────────────────────────
  {
    id: 'caducidades-mias',
    label: 'Revisiones de caducidad a tu nombre',
    detalle: 'hojas de revisión que iniciaste y no has enviado',
    ruta: '/tienda/caducidades',
    icono: 'pi pi-clock',
    alcance: 'mio',
    responsabilidad: 'tienda.caducidades',
    // La tabla tiene `warehouse_id`, pero ya filtra por `responsible_user_id`: acotar por sucursal
    // no quitaría ni una fila y sí sugeriría una precisión que no aporta.
    acotablePorSucursal: false,
    anyOf: [Permission.COMMERCIAL_EXPIRY_VER, Permission.COMMERCIAL_EXPIRY_CAPTURAR],
    medir: (knex, { tenantId, userId }) =>
      medirCola(knex,
        knex('commercial.expiry_reviews')
          .where({ tenant_id: tenantId, responsible_user_id: userId, status: 'draft' }),
        'created_at'),
  },

  // ── Colas compartidas ──────────────────────────────────────────────────────────────────────
  {
    id: 'cuadre',
    label: 'Descuadres por revisar',
    detalle: 'caja, inventario y cruce · sin clasificar todavía',
    ruta: '/almacen/cuadre',
    icono: 'pi pi-exclamation-triangle',
    alcance: 'bandeja',
    responsabilidad: 'almacen.cuadre',
    acotablePorSucursal: false, // medido: la tabla NO tiene ninguna columna de ruteo
    anyOf: [Permission.RECONCILIATION_VER],
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('reconciliation.discrepancies').where({ tenant_id: tenantId, status: 'nuevo' }), 'created_at'),
  },
  {
    id: 'finanzas-hallazgos',
    label: 'Hallazgos de finanzas sin triage',
    detalle: 'detectados por Maat · nadie los ha confirmado ni descartado',
    ruta: '/finanzas/hallazgos',
    icono: 'pi pi-flag',
    alcance: 'bandeja',
    responsabilidad: 'finanzas.hallazgos',
    acotablePorSucursal: false,
    anyOf: [Permission.FINANCE_AI_CHAT],
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('finance.findings').where({ tenant_id: tenantId, status: 'nuevo' }), 'created_at'),
  },
  {
    id: 'maat-acciones',
    label: 'Acciones de finanzas por aprobar',
    detalle: 'propuestas de Maat esperando una decisión humana',
    ruta: '/finanzas/pagos-control',
    icono: 'pi pi-check-square',
    alcance: 'bandeja',
    responsabilidad: 'finanzas.acciones',
    acotablePorSucursal: false,
    anyOf: [Permission.FINANCE_AI_CHAT],
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('finance.proposed_actions').where({ tenant_id: tenantId, estado: 'pending_approval' }), 'created_at'),
  },
  {
    id: 'thot-acciones',
    label: 'Acciones comerciales por aprobar',
    detalle: 'propuestas de Thot esperando curación',
    ruta: '/comercial/thot-curation',
    icono: 'pi pi-check-square',
    alcance: 'bandeja',
    responsabilidad: 'comercial.thot',
    acotablePorSucursal: false,
    anyOf: [Permission.COMMERCIAL_THOT_GESTIONAR],
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('commercial.commercial_actions').where({ tenant_id: tenantId, status: 'pending_approval' }), 'created_at'),
  },
  {
    id: 'compras-hallazgos',
    label: 'Hallazgos de reabastecimiento',
    detalle: 'agotados y bajo reorden detectados en el barrido nocturno',
    ruta: '/compras/hallazgos',
    icono: 'pi pi-flag',
    alcance: 'bandeja',
    responsabilidad: 'compras.reabasto',
    /*
     * La ÚNICA cola que gana algo real con el acotado: 21,940 abiertos repartidos en 9 almacenes
     * (`00` 5,621 · `MD-30` 2,813 · `01` 2,709 · `06` 2,429 · `03` 2,249 …). Para quien tiene
     * sucursal en su ficha, el número pasa de "toda la red" a lo suyo.
     */
    acotablePorSucursal: true,
    anyOf: [Permission.COMPRAS_HALLAZGOS_VER],
    medir: (knex, { tenantId, sucursales }) => {
      const q = knex('commercial.replenishment_findings as f')
        .where({ 'f.tenant_id': tenantId, 'f.status': 'open' });
      if (sucursales) {
        /*
         * La tabla guarda el uuid del almacén y la ficha guarda el código: el puente es
         * `warehouses`. ⚠️ Pero NO se une por `w.code`, sino por la LLAVE CANÓNICA (`[RE.23]`):
         * las 7 sucursales Kepler guardan `'00'..'06'` en `code`, y las de Morelia guardan
         * `'MD-30'`/`'MD-32'` con el código de 2 dígitos en `wincaja_source_branch`. Medido en
         * prod: la ficha de esas 2 personas dice `'30'`/`'32'`, así que `whereIn('w.code', …)`
         * les habría devuelto **0** teniendo 2,813 y 1,944 hallazgos — el cero disfrazado exacto
         * que esta fase existe para no dibujar.
         */
        q.join('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'f.warehouse_id').andOn('w.tenant_id', '=', 'f.tenant_id');
        }).whereRaw(
          `(${branchKeySql('w')}) IN (${sucursales.map(() => '?').join(', ')})`,
          sucursales,
        );
      }
      return medirCola(knex, q, 'f.created_at');
    },
  },
  {
    id: 'flota-alertas',
    label: 'Alertas de flota abiertas',
    detalle: 'sin señal o exceso de velocidad · sin acuse',
    ruta: '/logistica/rastreo',
    icono: 'pi pi-bell',
    alcance: 'bandeja',
    responsabilidad: 'logistica.flota',
    acotablePorSucursal: false,
    anyOf: [Permission.LOGISTICS_FLEET_VER],
    medir: (knex, { tenantId }) =>
      medirCola(knex, knex('logistics.fleet_alerts').where({ tenant_id: tenantId, status: 'open' }), 'created_at'),
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
