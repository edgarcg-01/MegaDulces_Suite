import type { Knex } from 'knex';
import { Permission } from '@megadulces/contracts/authz/permissions';
import {
  ESTADOS_ABIERTOS,
  adaptadorDe,
  type AdaptadorTarea,
  type FuenteTarea,
} from '@megadulces/contracts';
import type { ResponsabilidadKey } from './me-work';

/**
 * `[SN.15]` — Lo que ALGUIEN te asignó a vos, con nombre y fecha.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 * `me-work.ts` respondía UNA pregunta —*¿qué colas abre tu permiso?*— y la pantalla la presentaba
 * como si fuera otra: *¿qué te toca a vos?*. La regla que separa las tres la dejó escrita
 * `libs/contracts/src/work/task.contract.ts`:
 *
 *   > El PERMISO decide si podés ABRIRLO; la RESPONSABILIDAD decide si es TUYO; la TAREA dice que
 *   > alguien te lo asignó a vos, con nombre y fecha. Una cola sin `assigned_to` no es una tarea:
 *   > es una bandeja.
 *
 * Este archivo contesta la tercera. La segunda todavía no se puede contestar:
 * `identity.position_responsibilities` está VACÍA a propósito (medido hoy: 0 filas) y la pantalla
 * lo declara en vez de derivarla del permiso.
 *
 * ── La medición que lo disparó (prod, 2026-09-11) ───────────────────────────────────────────
 * `me-work.ts` afirmaba —y la landing repetía— que las tablas de asignación nominal estaban en
 * CERO. Medido de nuevo hoy contra `railway`:
 *
 *     finance.recon_tasks                     22 filas ·  15 abiertas ·  14 con dueño activo
 *     commercial.supervisor_tasks              2       ·   2          ·   2
 *     commercial.inventory_count_assignments  18       ·  18          ·  18
 *     trade.daily_assignments                119       · 119          · 117
 *                                                        ───────────────────
 *                                          151 tareas abiertas, sobre 38 de 118 personas (32%)
 *
 * O sea que la frase «Nadie te asignó trabajo hoy» era falsa para un tercio del padrón.
 *
 * ── Reglas ──────────────────────────────────────────────────────────────────────────────────
 *  1. **No se crea una quinta tabla.** Se lee de las cuatro que ya existen, con el mapeo declarado
 *     en `ADAPTADORES`. Los estados abiertos se DERIVAN del contrato — duplicarlos acá sería la
 *     quinta copia del vocabulario que el contrato vino a cerrar.
 *  2. **Si el dueño no tiene el permiso que abre la ruta, la fila se muestra SIN enlace** y dice
 *     por qué. Esconderla taparía una discrepancia real entre quién reparte y quién puede abrir;
 *     enlazarla invitaría a un 403 (medido hoy: 2 conteos asignados a gente sin el permiso).
 *  3. Lo que una fuente NO puede contestar se DECLARA (`no_responde` del adaptador), no se rellena.
 *
 * Conexión: `KNEX_CONNECTION` bypassa RLS — aislamiento por filtro `tenant_id` EXPLÍCITO, igual
 * que `me-work.ts`.
 */

export interface MedidaTarea {
  total: number;
  mas_viejo_at: string | null;
  /** El vencimiento MÁS PRÓXIMO. `null` = la fuente no maneja vencimiento (no es "no vence"). */
  vence_at: string | null;
  /** Cuántas ya pasaron su fecha. `null` cuando la fuente no puede contestarlo. */
  vencidas: number | null;
}

export interface FuenteTareaDef {
  fuente: FuenteTarea;
  /** Qué hay que hacer, en una línea. No el nombre de la tabla. */
  label: string;
  detalle: string;
  ruta: string;
  icono: string;
  /** Cualquiera de estas claves abre `ruta`. Verificado contra `app.routes.ts` por el candado. */
  anyOf: readonly Permission[];
  /**
   * La cola en el catálogo de `[OR.1b]`, cuando esta fuente ES una de las ocho. Tres de las cuatro
   * fuentes de tarea no lo son (`recon_tasks`, `supervisor_tasks`, `daily_assignments` no están en
   * `identity.responsibilities`), y eso se declara con `undefined` en vez de inventarles una clave.
   */
  responsabilidad?: ResponsabilidadKey;
  medir: (knex: Knex, tenantId: string, userId: string) => Promise<MedidaTarea>;
}

/**
 * Los valores que ESTA fuente usa para decir "todavía le toca a alguien", derivados del mapeo del
 * contrato. Si mañana `recon_tasks` admite un estado nuevo, se declara allá y acá se hereda.
 */
function dialectosAbiertos(a: AdaptadorTarea): string[] {
  if (!a.col_estado) return [];
  return Object.entries(a.estados)
    .filter(([, canonico]) => ESTADOS_ABIERTOS.includes(canonico))
    .map(([dialecto]) => dialecto);
}

/**
 * Cuenta y fecha en UNA pasada. `colVence` es `null` cuando el adaptador declara que la fuente no
 * maneja vencimiento — y entonces `vence_at`/`vencidas` salen `null`, que NO es lo mismo que cero.
 */
async function medirTareas(
  knex: Knex,
  q: Knex.QueryBuilder,
  colFecha: string,
  colVence: string | null,
): Promise<MedidaTarea> {
  const columnas = [knex.raw('count(*) as n'), knex.raw('min(??) as viejo', [colFecha])];
  if (colVence) {
    columnas.push(knex.raw('min(??) as vence', [colVence]));
    columnas.push(knex.raw('count(*) filter (where ?? < now()) as vencidas', [colVence]));
  }
  const row = await q
    .clearSelect()
    .select(...columnas)
    .first<{
      n: string | number;
      viejo: Date | string | null;
      vence?: Date | string | null;
      vencidas?: string | number;
    }>();
  const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
  return {
    total: Number(row?.n ?? 0),
    mas_viejo_at: iso(row?.viejo),
    vence_at: colVence ? iso(row?.vence) : null,
    vencidas: colVence ? Number(row?.vencidas ?? 0) : null,
  };
}

/** Estados de una sesión de conteo todavía EN VUELO (mig 20260613100000 L110). */
const CONTEO_ACTIVO = ['open', 'counting', 'review', 'ready_to_reconcile'];

export const FUENTES_VISIBLES: readonly FuenteTareaDef[] = [
  {
    fuente: 'finance.recon_tasks',
    label: 'Conciliaciones a tu nombre',
    detalle: 'diferencias que Maat te repartió · con fecha de compromiso',
    ruta: '/finanzas/tareas',
    icono: 'pi pi-inbox',
    anyOf: [Permission.FINANCE_BANK_VER],
    medir: (knex, tenantId, userId) => {
      const a = adaptadorDe('finance.recon_tasks');
      return medirTareas(
        knex,
        knex('finance.recon_tasks')
          .where({ tenant_id: tenantId })
          .where(a.col_asignado_a, userId)
          .whereIn(a.col_estado as string, dialectosAbiertos(a)),
        a.col_asignado_at,
        a.col_vence,
      );
    },
  },
  {
    fuente: 'commercial.supervisor_tasks',
    label: 'Tareas de supervisión asignadas',
    detalle: 'lo que Horus o tu jefe te pidió revisar',
    ruta: '/dashboard/supervisor-ai',
    icono: 'pi pi-verified',
    anyOf: [Permission.SUPERVISOR_AI_VER],
    medir: (knex, tenantId, userId) => {
      const a = adaptadorDe('commercial.supervisor_tasks');
      return medirTareas(
        knex,
        knex('commercial.supervisor_tasks')
          .where({ tenant_id: tenantId })
          .where(a.col_asignado_a, userId)
          .whereIn(a.col_estado as string, dialectosAbiertos(a)),
        a.col_asignado_at,
        a.col_vence,
      );
    },
  },
  {
    /*
     * Venía de `me-work.ts` como bandeja `conteos-asignados`, y ahí estaba mal ubicada: la fila
     * trae `assigned_by`, o sea que alguien te la repartió — es una tarea, no una cola. Se conserva
     * su filtro por sesión EN VUELO, que es más preciso que el `estado_fijo: 'pending'` del
     * adaptador (una asignación de una sesión ya cerrada no le toca a nadie).
     */
    fuente: 'commercial.inventory_count_assignments',
    label: 'Conteos de inventario asignados a ti',
    detalle: 'sesiones de conteo en vuelo donde apareces como contador',
    ruta: '/almacen/inventory/count',
    icono: 'pi pi-list-check',
    anyOf: [Permission.COMMERCIAL_INVENTORY_CONTAR],
    responsabilidad: 'almacen.conteo',
    medir: (knex, tenantId, userId) => {
      const a = adaptadorDe('commercial.inventory_count_assignments');
      return medirTareas(
        knex,
        knex('commercial.inventory_count_assignments as t')
          .join('commercial.inventory_counts as ic', function () {
            this.on('ic.id', '=', 't.count_id').andOn('ic.tenant_id', '=', 't.tenant_id');
          })
          .where('t.tenant_id', tenantId)
          .where(`t.${a.col_asignado_a}`, userId)
          .whereIn('ic.status', CONTEO_ACTIVO),
        `t.${a.col_asignado_at}`,
        a.col_vence,
      );
    },
  },
  {
    /*
     * ⚠️ Sólo la ruta de HOY. `day_of_week` es una RECURRENCIA semanal, no un vencimiento (lo
     * declara el adaptador), así que contar las 119 filas diría "tenés 5 pendientes" a quien tiene
     * una ruta por día de la semana. ISODOW (1=lun..7=dom) en TZ MX, igual que
     * `vendor-cartera.sql.ts` y `commercial-vendor-routes.service.ts` — NO `DOW`, que arranca en 0.
     */
    fuente: 'trade.daily_assignments',
    label: 'Tu ruta de hoy',
    detalle: 'la ruta que tenés asignada para el día',
    ruta: '/dashboard/daily-assignments',
    icono: 'pi pi-map',
    anyOf: [Permission.TRADE_ROUTE_PLAN_VER],
    medir: (knex, tenantId, userId) => {
      const a = adaptadorDe('trade.daily_assignments');
      return medirTareas(
        knex,
        knex('trade.daily_assignments')
          .where({ tenant_id: tenantId })
          .where(a.col_asignado_a, userId)
          .whereIn(a.col_estado as string, dialectosAbiertos(a))
          .whereRaw(
            `day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int`,
          ),
        a.col_asignado_at,
        a.col_vence,
      );
    },
  },
];

/** ¿Esta persona puede ABRIR la pantalla que resuelve la tarea? God-mode sí; el resto por clave. */
export function puedeAbrirTarea(
  f: FuenteTareaDef,
  permisos: Record<string, boolean> | null | undefined,
  esAdmin: boolean,
): boolean {
  if (esAdmin) return true;
  const p = permisos ?? {};
  return f.anyOf.some((k) => p[k] === true);
}
