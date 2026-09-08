import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * RD.4 — Gasto de flota de la Ruta Directa.
 *
 * Dato PROPIO: no existe en ningún ERP, sólo en la hoja `CONTROL DE GASTOS RD` del workbook
 * `INDICADORES RD 2026.xlsx`. El histórico entró por
 * `database/importers/logistics/import-route-expenses.js` (782 filas, $848,610.04, cuadrado
 * al centavo contra la columna cruda de la hoja); de acá en adelante la captura es por esta
 * pantalla, con la misma validación. Mismo camino que CB.1 → CB.2.1.
 *
 * Se captura contra la RUTA, que es el grano que el dato tiene. `vehicle_id` es opcional:
 * sólo 13 de 50 `logistics.trackers` tienen `route_number`, así que exigir vehículo dejaría
 * fuera la mayoría del gasto.
 */

export interface RouteExpenseDto {
  route_code: string;
  expense_date: string;
  expense_type?: number;
  folio?: string;
  supplier?: string | null;
  description?: string | null;
  liters?: number | null;
  total: number;
  is_remote?: boolean;
  vehicle_id?: string | null;
  period_no?: number | null;
  notes?: string | null;
}

export interface ListQuery {
  from?: string; to?: string; route_code?: string; expense_type?: number;
  sin_clasificar?: boolean; limit?: number; offset?: number;
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

@Injectable()
export class LogisticsRouteExpensesService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  types() {
    return this.tk.run((trx) =>
      trx('logistics.route_expense_types').where({ activo: true })
        .orderBy('code').select('code', 'nombre', 'lleva_litros', 'notes'));
  }

  async list(q: ListQuery = {}) {
    const limit = Math.min(Math.max(Number(q.limit) || 300, 1), 2000);
    const offset = Math.max(Number(q.offset) || 0, 0);
    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('logistics.route_expenses as e').whereNull('e.deleted_at');
        if (q.from) b.where('e.expense_date', '>=', q.from);
        if (q.to) b.where('e.expense_date', '<=', q.to);
        if (q.route_code) b.where('e.route_code', q.route_code);
        if (q.expense_type !== undefined && q.expense_type !== null) b.where('e.expense_type', Number(q.expense_type));
        if (q.sin_clasificar) b.where('e.expense_type', 0);
        return b;
      };
      const [rows, [tot]] = await Promise.all([
        base()
          .leftJoin('logistics.route_expense_types as t', function join() {
            this.on('t.tenant_id', '=', 'e.tenant_id').andOn('t.code', '=', 'e.expense_type');
          })
          .orderBy([{ column: 'e.expense_date', order: 'desc' }, { column: 'e.route_code' }])
          .limit(limit).offset(offset)
          .select('e.*', 't.nombre as tipo_nombre', 't.lleva_litros'),
        base().select(
          trx.raw('count(*)::int as n'),
          trx.raw('COALESCE(sum(e.total),0)::float8 as total'),
          trx.raw('COALESCE(sum(e.liters),0)::float8 as litros'),
          trx.raw("count(*) FILTER (WHERE e.expense_type = 0)::int as sin_clasificar"),
        ),
      ]);
      return {
        rows,
        total_filas: tot.n,
        total_monto: r2(tot.total),
        total_litros: r2(tot.litros),
        // Se declara para que la pantalla lo pueda mostrar: el tipo NO se adivina, y si
        // quedan filas sin clasificar el resumen por tipo está incompleto a propósito.
        sin_clasificar: tot.sin_clasificar,
        limit, offset,
      };
    });
  }

  /** Resumen ruta × tipo del periodo. Es lo que el Excel arma con SUMIFS (y le sale mal). */
  async summary(from: string, to: string) {
    if (!FECHA.test(from || '') || !FECHA.test(to || '')) {
      throw new BadRequestException('from y to son obligatorios en formato YYYY-MM-DD');
    }
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT e.route_code,
                e.expense_type,
                t.nombre                       AS tipo_nombre,
                count(*)::int                  AS n,
                round(sum(e.total)::numeric,2)::float8   AS total,
                round(sum(e.liters)::numeric,2)::float8  AS litros,
                CASE WHEN sum(e.liters) > 0
                     THEN round((sum(e.total)/sum(e.liters))::numeric,4)::float8
                END                            AS costo_por_litro
           FROM logistics.route_expenses e
           LEFT JOIN logistics.route_expense_types t
             ON t.tenant_id = e.tenant_id AND t.code = e.expense_type
          WHERE e.deleted_at IS NULL AND e.expense_date >= ? AND e.expense_date <= ?
          GROUP BY 1,2,3 ORDER BY 1,2`, [from, to]);
      const totalGeneral = rows.reduce((s: number, r: any) => s + Number(r.total), 0);
      return {
        from, to, rows,
        total: r2(totalGeneral),
        litros: r2(rows.reduce((s: number, r: any) => s + Number(r.litros || 0), 0)),
        rutas: [...new Set(rows.map((r: any) => r.route_code))].length,
      };
    });
  }

  async create(dto: RouteExpenseDto) {
    const clean = this.validar(dto);
    const tenantId = this.tenantCtx.requireTenantId();
    const userId = this.tenantCtx.get()?.userId ?? null;
    return this.tk.run(async (trx) => {
      const [row] = await trx('logistics.route_expenses')
        .insert({ ...clean, tenant_id: tenantId, source: 'captura_web', created_by: userId, updated_by: userId })
        .returning('*');
      return row;
    });
  }

  async update(id: string, dto: Partial<RouteExpenseDto>) {
    const userId = this.tenantCtx.get()?.userId ?? null;
    return this.tk.run(async (trx) => {
      const actual = await trx('logistics.route_expenses').where({ id }).whereNull('deleted_at').first();
      if (!actual) throw new NotFoundException(`Gasto ${id} no existe`);
      const clean = this.validar({ ...actual, ...dto } as RouteExpenseDto);
      const [row] = await trx('logistics.route_expenses')
        .where({ id }).update({ ...clean, updated_at: trx.fn.now(), updated_by: userId }).returning('*');
      return row;
    });
  }

  async remove(id: string) {
    const userId = this.tenantCtx.get()?.userId ?? null;
    return this.tk.run(async (trx) => {
      const n = await trx('logistics.route_expenses').where({ id }).whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), deleted_by: userId });
      if (!n) throw new NotFoundException(`Gasto ${id} no existe`);
      return { id, deleted: true };
    });
  }

  private validar(dto: RouteExpenseDto) {
    if (!dto.route_code) throw new BadRequestException('route_code es obligatorio');
    const fecha = String(dto.expense_date).slice(0, 10);
    if (!FECHA.test(fecha)) throw new BadRequestException('expense_date debe ser YYYY-MM-DD');
    const total = Number(dto.total);
    if (!Number.isFinite(total) || total < 0) throw new BadRequestException('total debe ser un número >= 0');
    const litros = dto.liters === null || dto.liters === undefined ? null : Number(dto.liters);
    if (litros !== null && (!Number.isFinite(litros) || litros < 0)) {
      throw new BadRequestException('liters debe ser un número >= 0');
    }
    return {
      route_code: String(dto.route_code).trim(),
      expense_date: fecha,
      expense_type: dto.expense_type === undefined || dto.expense_type === null ? 0 : Number(dto.expense_type),
      folio: (dto.folio ?? '').toString().trim(),
      supplier: dto.supplier ?? null,
      description: dto.description ?? null,
      liters: litros,
      total: r2(total),
      is_remote: dto.is_remote === true,
      vehicle_id: dto.vehicle_id ?? null,
      period_no: dto.period_no ?? null,
      notes: dto.notes ?? null,
    };
  }
}
