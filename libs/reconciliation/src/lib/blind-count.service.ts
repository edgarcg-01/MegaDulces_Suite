import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * SM.8 / P1 — Arqueo ciego. El cajero captura el conteo físico por denominación
 * ANTES de ver el esperado; recién al guardar el motor revela la diferencia REAL
 * (total ciego vs efectivo esperado de Kepler), independiente del c25 contaminado.
 *
 * `reconciliation.blind_counts` tiene RLS forzado → TenantKnexService.run().
 */

/** Denominaciones MXN válidas (billetes + monedas). */
const DENOMS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5];

export interface BlindCountDto {
  warehouse_code: string;
  caja: string;
  business_date: string;          // 'YYYY-MM-DD'
  turno?: string;
  cajero_code?: string;           // cierre: cajero que cierra · relevo: cajero SALIENTE
  cajero_entrante?: string;       // solo relevo: quién recibe la caja
  tipo?: 'cierre' | 'relevo';     // default 'cierre'
  denominations: Record<string, number>;  // {"1000":2,"0.5":10,…}
  nota?: string;
  photo_url?: string;
}

@Injectable()
export class BlindCountService {
  private readonly logger = new Logger(BlindCountService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private computeTotal(denoms: Record<string, number>): number {
    let total = 0;
    for (const [d, n] of Object.entries(denoms || {})) {
      const denom = Number(d); const count = Number(n);
      if (!DENOMS.includes(denom)) throw new BadRequestException(`Denominación inválida: ${d}`);
      if (!Number.isFinite(count) || count < 0) throw new BadRequestException(`Conteo inválido para ${d}`);
      total += denom * count;
    }
    return Math.round(total * 100) / 100;
  }

  /** Captura (o re-captura) un arqueo ciego y devuelve la comparación contra el corte de Kepler. */
  async submit(dto: BlindCountDto, username?: string) {
    if (!dto?.warehouse_code || !dto?.caja || !dto?.business_date) {
      throw new BadRequestException('warehouse_code, caja y business_date son obligatorios');
    }
    const tenantId = this.tenantCtx.requireTenantId();
    const total = this.computeTotal(dto.denominations || {});
    const tipo = dto.tipo === 'relevo' ? 'relevo' : 'cierre';
    return this.tk.run(async (trx) => {
      const row = {
        tenant_id: tenantId, tipo,
        warehouse_code: dto.warehouse_code, caja: dto.caja, business_date: dto.business_date,
        turno: dto.turno || null, cajero_code: dto.cajero_code || null, cajero_entrante: dto.cajero_entrante || null,
        denominations: JSON.stringify(dto.denominations || {}), total_contado: total,
        nota: dto.nota || null, photo_url: dto.photo_url || null, captured_by: username || null,
      };
      await trx('reconciliation.blind_counts')
        .insert(row)
        .onConflict(trx.raw("(tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code,''), tipo)"))
        .merge({ denominations: row.denominations, total_contado: total, cajero_entrante: row.cajero_entrante, nota: row.nota, photo_url: row.photo_url, captured_by: row.captured_by, captured_at: trx.fn.now() });
      // El relevo no se compara contra el corte del día (es intra-turno): solo sella el traspaso.
      if (tipo === 'relevo') {
        this.logger.log(`arqueo relevo suc${dto.warehouse_code} caja${dto.caja} ${dto.business_date}: ${dto.cajero_code || '?'}→${dto.cajero_entrante || '?'} entregó ${total}`);
        return { tipo, total_contado: total, matched: false, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false };
      }
      const cmp = await this.compare(trx, tenantId, dto, total);
      this.logger.log(`arqueo cierre suc${dto.warehouse_code} caja${dto.caja} ${dto.business_date}: contado ${total} vs esperado ${cmp.esperado ?? '?'}`);
      return { tipo, total_contado: total, ...cmp };
    });
  }

  /** Compara el total ciego vs el corte de Kepler (matchea por suc/caja/fecha[/cajero]). */
  private async compare(trx: any, tenantId: string, dto: BlindCountDto, total: number) {
    const q = trx('analytics.cash_cuts').where({ tenant_id: tenantId, warehouse_code: dto.warehouse_code, caja: dto.caja, business_date: dto.business_date });
    if (dto.cajero_code) q.where('cajero_cierre', dto.cajero_code);
    const cut: any = await q.orderBy('efectivo_esperado', 'desc').first();
    if (!cut) return { matched: false, esperado: null, kepler_contado: null, kepler_diff: null, diff_real: null, kepler_enmascaro: false };
    const esperado = Number(cut.efectivo_esperado);
    const keplerContado = Number(cut.efectivo_contado);
    const keplerDiff = Number(cut.efectivo_diff);
    const diffReal = Math.round((esperado - total) * 100) / 100;   // + faltante / − sobrante
    // Kepler dijo "cuadrado" (|diff|<50) pero el arqueo ciego revela ≥$50 → enmascaró.
    const keplerEnmascaro = Math.abs(keplerDiff) < 50 && Math.abs(diffReal) >= 50;
    return { matched: true, folio: cut.folio, esperado, kepler_contado: keplerContado, kepler_diff: keplerDiff, diff_real: diffReal, kepler_enmascaro: keplerEnmascaro };
  }

  /** Lista arqueos ciegos con su comparación (para la consola). */
  async list(q: { from?: string; to?: string; warehouse_code?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const b = trx('reconciliation.blind_counts as bc')
        .where('bc.tenant_id', trx.raw('current_tenant_id()'))
        .leftJoin('analytics.cash_cuts as cc', function (this: any) {
          this.on('cc.tenant_id', '=', 'bc.tenant_id').andOn('cc.warehouse_code', '=', 'bc.warehouse_code')
            .andOn('cc.caja', '=', 'bc.caja').andOn('cc.business_date', '=', 'bc.business_date')
            .andOn(trx.raw('cc.cajero_cierre IS NOT DISTINCT FROM bc.cajero_code'));
        })
        .leftJoin('analytics.pos_cashiers as pc', function (this: any) {
          this.on('pc.tenant_id', '=', 'bc.tenant_id').andOn('pc.warehouse_code', '=', 'bc.warehouse_code').andOn('pc.cajero_code', '=', 'bc.cajero_code');
        })
        .select('bc.id', 'bc.tipo', 'bc.warehouse_code', 'bc.caja', 'bc.business_date', 'bc.turno', 'bc.cajero_code', 'bc.cajero_entrante',
          trx.raw('pc.nombre AS cajero_nombre'), trx.raw('bc.total_contado::numeric AS total_contado'),
          'bc.captured_by', 'bc.captured_at', 'bc.nota',
          trx.raw('cc.efectivo_esperado::numeric AS esperado'), trx.raw('cc.efectivo_diff::numeric AS kepler_diff'))
        .orderBy('bc.captured_at', 'desc').limit(limit);
      if (q.warehouse_code) b.where('bc.warehouse_code', q.warehouse_code);
      if (q.from) b.where('bc.business_date', '>=', q.from);
      if (q.to) b.where('bc.business_date', '<=', q.to);
      const rows = await b;
      return rows.map((r: any) => {
        const total = Number(r.total_contado);
        // El relevo es intra-turno: no compara contra el corte del día.
        const esperado = r.tipo === 'relevo' ? null : (r.esperado != null ? Number(r.esperado) : null);
        const diffReal = esperado != null ? Math.round((esperado - total) * 100) / 100 : null;
        const keplerDiff = r.tipo === 'relevo' ? null : (r.kepler_diff != null ? Number(r.kepler_diff) : null);
        return {
          id: r.id, tipo: r.tipo, warehouse_code: r.warehouse_code, caja: r.caja, business_date: r.business_date, turno: r.turno,
          cajero_code: r.cajero_code, cajero_entrante: r.cajero_entrante || null, cajero_nombre: r.cajero_nombre || null, total_contado: total,
          captured_by: r.captured_by, captured_at: r.captured_at, nota: r.nota,
          esperado, kepler_diff: keplerDiff, diff_real: diffReal,
          kepler_enmascaro: keplerDiff != null && diffReal != null && Math.abs(keplerDiff) < 50 && Math.abs(diffReal) >= 50,
        };
      });
    });
  }
}
