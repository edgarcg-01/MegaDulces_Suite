import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, Permission } from '@megadulces/platform-core';
import { proponerAreas, type AreaCandidata, type MotivoPropuesta } from './area-match';

/**
 * `[GX.16]` — **Asignación asistida de áreas de gasto.**
 *
 * El motor propone, **la persona confirma**. Nunca asigna solo: un área da visibilidad
 * sobre el gasto de otro, así que la decisión es de quien administra usuarios, no de una
 * heurística de nombres. (Mismo criterio que ADR-016 y que la bandeja HITL de Maat.)
 *
 * ## Por qué existe
 * Medido en prod el 2026-09-24: **0 de 76 usuarios** con permiso de capturar gastos tenían
 * un área asignada. El selector existe en `/admin/usuarios` desde GX.8 y nunca se usó —
 * son 76 diálogos que alguien tendría que abrir uno por uno. Acá se ven todos juntos, con
 * la propuesta y su evidencia al lado.
 *
 * ## Lo que esto NO resuelve, y se declara
 * Con la regla estricta (ver `area-match.ts`) **47 de los 76 quedan sin propuesta**. Para
 * esos la asignación sigue siendo a mano — la pantalla los lista igual, con su buscador,
 * porque el problema real es que estaban invisibles, no que faltara automatismo.
 */

/** Cada persona, con lo que tiene hoy y lo que se le propone. */
export interface FilaAsignacion {
  user_id: string;
  username: string;
  nombre: string | null;
  role_name: string | null;
  /** Lo que ya tiene asignado (ids de `finance.expense_areas`). */
  areas_actuales: string[];
  /** ¿Ve todo? Entonces no necesita áreas y no se propone nada. */
  ve_todo: boolean;
  motivo: MotivoPropuesta | 've_todo';
  propuestas: AreaCandidata[];
  explicacion: string;
}

export interface EstadoAsignacion {
  /** Ventana usada para contar solicitudes por área (la evidencia). */
  ventana_dias: number;
  resumen: {
    usuarios: number;
    ya_asignados: number;
    ven_todo: number;
    con_propuesta: number;
    sin_propuesta: number;
  };
  areas: AreaCandidata[];
  filas: FilaAsignacion[];
}

export interface AsignacionPedida {
  user_id: string;
  /** Reemplaza la lista completa del usuario. Vacío = quitarle todas. */
  area_ids: string[];
}

@Injectable()
export class ExpenseAreasAssignService {
  private readonly logger = new Logger(ExpenseAreasAssignService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * El estado de todos los que capturan o ven gastos, con su propuesta.
   *
   * ⚠️ La evidencia (`solicitudes` por área) se cuenta en una **ventana**: contar sobre
   * toda la historia obliga a agrupar la vista entera del ODS. 365 días alcanza para que
   * quien confirma vea si un área tiene movimiento real o es un nombre suelto.
   */
  async estado(ventanaDias = 365): Promise<EstadoAsignacion> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ventana = Math.min(1095, Math.max(30, Number(ventanaDias) || 365));

    return this.tk.run(async (trx) => {
      // Sólo quien captura o revisa gastos: proponerle un área a un cajero de tienda que
      // nunca pide gastos sería ruido que hay que leer 76 veces.
      const usuarios = await trx('users as u')
        .whereNull('u.deleted_at')
        .whereExists(function (this: any) {
          this.select(trx.raw('1')).from('role_permissions as rp')
            .whereRaw('rp.role_name = u.role_name')
            .whereRaw(`((rp.permissions->>?)::boolean IS TRUE OR (rp.permissions->>?)::boolean IS TRUE)`,
              [Permission.FINANCE_EXPENSES_CAPTURAR, Permission.FINANCE_EXPENSES_VER]);
        })
        .orderBy('u.nombre')
        .select('u.id', 'u.username', 'u.nombre', 'u.role_name', 'u.finance_expense_area_ids',
          // Quien ve TODO no necesita área: proponerle una sería trabajo inventado.
          trx.raw(
            `EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_name = u.role_name
                       AND (rp.permissions->>?)::boolean IS TRUE) AS ve_todo`,
            [Permission.FINANCE_EXPENSES_VER_ALL],
          ));

      const areasRaw = await trx('finance.expense_areas')
        .where({ tenant_id: tenantId, active: true })
        .orderBy('name')
        .select('id', 'name', 'norm_key');

      // Cuántas solicitudes trae cada área. Es lo que distingue «PILAR GARCIA» (247) de un
      // nombre suelto que alguien tecleó una vez.
      const pesos = await trx('analytics.expense_requests')
        .where('tenant_id', tenantId)
        .whereRaw('fecha >= current_date - ?::int', [ventana])
        .whereRaw('fecha <= current_date')
        .whereNotNull('solicitante')
        .groupByRaw(`upper(regexp_replace(btrim(solicitante),'\\s+',' ','g'))`)
        .select(trx.raw(`upper(regexp_replace(btrim(solicitante),'\\s+',' ','g')) AS k`), trx.raw('count(*)::int AS n'));
      const porClave = new Map<string, number>(pesos.map((p: any) => [p.k, Number(p.n)]));

      const areas: AreaCandidata[] = areasRaw.map((a: any) => ({
        id: a.id, name: a.name, solicitudes: porClave.get(a.norm_key) ?? 0,
      }));

      const filas: FilaAsignacion[] = usuarios.map((u: any) => {
        const actuales: string[] = Array.isArray(u.finance_expense_area_ids) ? u.finance_expense_area_ids.filter(Boolean) : [];
        if (u.ve_todo) {
          return {
            user_id: u.id, username: u.username, nombre: u.nombre, role_name: u.role_name,
            areas_actuales: actuales, ve_todo: true, motivo: 've_todo', propuestas: [],
            explicacion: 'su rol ve todos los gastos: no necesita áreas',
          };
        }
        const p = proponerAreas(u.nombre, areas);
        return {
          user_id: u.id, username: u.username, nombre: u.nombre, role_name: u.role_name,
          areas_actuales: actuales, ve_todo: false,
          motivo: p.motivo, propuestas: p.areas, explicacion: p.explicacion,
        };
      });

      const resumen = {
        usuarios: filas.length,
        ya_asignados: filas.filter((f) => f.areas_actuales.length > 0).length,
        ven_todo: filas.filter((f) => f.ve_todo).length,
        con_propuesta: filas.filter((f) => !f.ve_todo && f.propuestas.length > 0).length,
        sin_propuesta: filas.filter((f) => !f.ve_todo && f.propuestas.length === 0).length,
      };

      return { ventana_dias: ventana, resumen, areas, filas };
    });
  }

  /**
   * Aplica las asignaciones que la persona confirmó.
   *
   * Reemplaza la lista completa de cada usuario (no suma): así el mismo camino sirve para
   * agregar y para quitar, y lo que se ve en pantalla es lo que queda.
   *
   * ⚠️ Valida que **todo id exista en el catálogo del tenant** antes de escribir nada. Sin
   * eso, un id de otro tenant —o inventado— quedaría guardado y el alcance lo ignoraría en
   * silencio: la persona creería tener acceso y seguiría viendo la lista vacía.
   */
  async asignar(pedidas: AsignacionPedida[], actor?: string): Promise<{ actualizados: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const items = (pedidas || []).filter((x) => x && x.user_id);
    if (!items.length) throw new BadRequestException('no vino ninguna asignación');

    return this.tk.run(async (trx) => {
      const pedidosIds = [...new Set(items.flatMap((i) => (i.area_ids || []).filter(Boolean)))];
      if (pedidosIds.length) {
        const validos = await trx('finance.expense_areas')
          .where({ tenant_id: tenantId })
          .whereIn('id', pedidosIds)
          .pluck('id');
        const invalidos = pedidosIds.filter((id) => !validos.includes(id));
        if (invalidos.length) {
          throw new BadRequestException(`áreas que no existen en el catálogo: ${invalidos.join(', ')}`);
        }
      }

      let actualizados = 0;
      for (const it of items) {
        const ids = [...new Set((it.area_ids || []).filter(Boolean))];
        const n = await trx('users')
          .where({ id: it.user_id })
          .whereNull('deleted_at')
          .update({ finance_expense_area_ids: ids, updated_at: trx.fn.now() });
        actualizados += n;
      }
      this.logger.log(`áreas de gasto asignadas a ${actualizados} usuario(s) por ${actor || '?'}`);
      return { actualizados };
    });
  }
}
