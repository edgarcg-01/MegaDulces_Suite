import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * SM.8 / P5 — Acciones sobre hallazgos + efectividad (cierra el loop).
 *
 * El motor detecta (reglas) → el humano propone una palanca anclada a un foco con
 * fecha de intervención (HITL, ADR-013) → luego se mide si el faltante bajó en ese
 * alcance comparando 30d antes vs 30d después (diff-in-diff, Horus-L L3), con la red
 * como control para descontar la tendencia general.
 *
 * reconciliation.actions con RLS → TenantKnexService.run().
 */

const PALANCAS = ['arqueo_ciego', 'arqueo_relevo', 'limitar_jornada', 'supervision', 'otro'];

export interface ActionDto {
  discrepancy_id?: string;
  palanca: string;
  titulo: string;
  detalle?: string;
  warehouse_code?: string;
  caja?: string;
  cajero_code?: string;
  fecha_intervencion: string;   // 'YYYY-MM-DD'
  responsable?: string;
}

@Injectable()
export class ReconciliationActionsService {
  private readonly logger = new Logger(ReconciliationActionsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async create(dto: ActionDto, username?: string) {
    if (!dto?.palanca || !dto?.titulo || !dto?.fecha_intervencion) {
      throw new BadRequestException('palanca, titulo y fecha_intervencion son obligatorios');
    }
    if (!PALANCAS.includes(dto.palanca)) throw new BadRequestException(`palanca inválida: ${dto.palanca}`);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // baseline = faltante 30d antes de la intervención en el alcance.
      const baseQ = trx('analytics.cash_cuts').where('tenant_id', tenantId)
        .whereRaw('business_date >= (DATE ? - 30) AND business_date < DATE ?', [dto.fecha_intervencion, dto.fecha_intervencion]);
      if (dto.warehouse_code) baseQ.where('warehouse_code', dto.warehouse_code);
      if (dto.caja) baseQ.where('caja', dto.caja);
      if (dto.cajero_code) baseQ.where('cajero_cierre', dto.cajero_code);
      const base: any = await baseQ.select(trx.raw('ROUND(SUM(GREATEST(efectivo_diff,0))::numeric,2) AS f')).first();
      const [row] = await trx('reconciliation.actions').insert({
        tenant_id: tenantId, discrepancy_id: dto.discrepancy_id || null, palanca: dto.palanca,
        titulo: dto.titulo, detalle: dto.detalle || null,
        warehouse_code: dto.warehouse_code || null, caja: dto.caja || null, cajero_code: dto.cajero_code || null,
        fecha_intervencion: dto.fecha_intervencion, responsable: dto.responsable || null,
        baseline_faltante: Number(base?.f || 0), created_by: username || null,
      }).returning('id');
      this.logger.log(`acción ${dto.palanca} suc${dto.warehouse_code || '?'} baseline ${base?.f || 0}`);
      return { id: row?.id || row, baseline_faltante: Number(base?.f || 0) };
    });
  }

  async setStatus(id: string, status: string, username?: string) {
    const valid = ['propuesta', 'aceptada', 'en_curso', 'hecha', 'descartada'];
    if (!valid.includes(status)) throw new BadRequestException(`status inválido: ${status}`);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      await trx('reconciliation.actions').where({ tenant_id: tenantId, id }).update({ status, updated_at: trx.fn.now() });
      return { id, status };
    });
  }

  /** Lista acciones con su efectividad (before/after en el alcance + red como control). */
  async list(q: { status?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const b = trx('reconciliation.actions').where('tenant_id', trx.raw('current_tenant_id()'))
        .orderBy('fecha_intervencion', 'desc').limit(limit);
      if (q.status) b.where('status', q.status);
      const rows = await b;
      const out: any[] = [];
      for (const a of rows) {
        const fecha = a.fecha_intervencion instanceof Date ? a.fecha_intervencion.toISOString().slice(0, 10) : String(a.fecha_intervencion).slice(0, 10);
        const scope = { warehouse_code: a.warehouse_code, caja: a.caja, cajero_code: a.cajero_code };
        // before/after del alcance
        const before = await this.faltanteRange(trx, tenantId, scope, `DATE '${fecha}' - 30`, `DATE '${fecha}'`);
        const after = await this.faltanteRange(trx, tenantId, scope, `DATE '${fecha}'`, `DATE '${fecha}' + 30`);
        // red (control): mismo antes/después sin filtro de alcance
        const netBefore = await this.faltanteRange(trx, tenantId, {}, `DATE '${fecha}' - 30`, `DATE '${fecha}'`);
        const netAfter = await this.faltanteRange(trx, tenantId, {}, `DATE '${fecha}'`, `DATE '${fecha}' + 30`);
        const deltaScope = Math.round((after.faltante - before.faltante) * 100) / 100;
        const netDelta = Math.round((netAfter.faltante - netBefore.faltante) * 100) / 100;
        // diff-in-diff: cambio del alcance menos el cambio de la red (descuenta la tendencia general)
        const did = Math.round((deltaScope - netDelta) * 100) / 100;
        out.push({
          id: a.id, palanca: a.palanca, titulo: a.titulo, detalle: a.detalle,
          sucursal: a.warehouse_code, caja: a.caja, cajero: a.cajero_code,
          fecha_intervencion: fecha, responsable: a.responsable, status: a.status,
          efectividad: {
            faltante_antes: before.faltante, faltante_despues: after.faltante,
            delta: deltaScope, red_delta: netDelta, diff_in_diff: did,
            mejoro: deltaScope < 0, dias_post: after.cortes > 0 ? 'con data' : 'sin data aún',
          },
        });
      }
      return out;
    });
  }

  private async faltanteRange(trx: any, tenantId: string, scope: { warehouse_code?: string; caja?: string; cajero_code?: string }, desdeExpr: string, hastaExpr: string) {
    const q = trx('analytics.cash_cuts').where('tenant_id', tenantId)
      .whereRaw(`business_date >= ${desdeExpr} AND business_date < ${hastaExpr}`);
    if (scope.warehouse_code) q.where('warehouse_code', scope.warehouse_code);
    if (scope.caja) q.where('caja', scope.caja);
    if (scope.cajero_code) q.where('cajero_cierre', scope.cajero_code);
    const r: any = await q.select(
      trx.raw('COUNT(*)::int AS cortes'),
      trx.raw('ROUND(SUM(GREATEST(efectivo_diff,0))::numeric,2) AS faltante'),
    ).first();
    return { cortes: Number(r?.cortes || 0), faltante: Number(r?.faltante || 0) };
  }
}
