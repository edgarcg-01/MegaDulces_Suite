import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CommercialAnalyticsService, SellOutExplainDim, SellOutExplainCompare } from './commercial-analytics.service';

/**
 * BI.5 — "Pregúntale al Sell-Out": catálogo de tools deterministas + system prompt.
 *
 * Regla dura (ADR-016, cero números del LLM): el modelo ELIGE la tool y NARRA; los
 * números salen SIEMPRE de estas queries, tenant-scoped y sobre el MISMO universo
 * que el reporte (v_sellout_daily/mv_sellout_monthly, is_promo=false, sin traspaso).
 * Ningún numero lo inventa el LLM. Reusa `explainChange()` para "por qué cambió".
 */

export interface ChatToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

/** Formato columnar "token-diet": el frontend re-expande. */
function col(columns: string[], rows: any[][]): { columns: string[]; data: any[][] } {
  return { columns, data: rows };
}

const DIMS = ['brand', 'branch', 'channel', 'product'];

@Injectable()
export class SelloutChatToolsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly analytics: CommercialAnalyticsService,
  ) {}

  // ── Catálogo de tools ──────────────────────────────────────────────────────
  definitions(): ChatToolDef[] {
    const dateProps = {
      from: { type: 'string', description: 'Fecha inicio ISO YYYY-MM-DD.' },
      to: { type: 'string', description: 'Fecha fin ISO YYYY-MM-DD (inclusive).' },
    };
    const filterProps = {
      brand: { type: 'string', description: 'Nombre (o parte) de la marca/empresa. Opcional.' },
      channel: { type: 'string', enum: ['mostrador', 'ruta', 'credito', 'preventa'], description: 'Canal. credito = mayoreo. Opcional.' },
      warehouse: { type: 'string', description: 'Nombre (o parte) de la sucursal. Opcional.' },
    };
    return [
      {
        name: 'sellout_total',
        description: 'Total de venta (monto y cajas) del sell-out en un rango, con filtros opcionales por marca/canal/sucursal. Usalo para "cuánto vendió X", "total de agosto".',
        input_schema: { type: 'object', properties: { ...dateProps, ...filterProps }, required: ['from', 'to'] },
      },
      {
        name: 'sellout_top',
        description: 'Ranking (top N) de una dimensión por monto en un rango. dim=brand|branch|channel|product. Usalo para "top 5 marcas", "qué sucursal vendió más".',
        input_schema: {
          type: 'object',
          properties: {
            ...dateProps,
            dim: { type: 'string', enum: DIMS, description: 'Dimensión a rankear.' },
            n: { type: 'number', description: 'Cuántos (default 10, max 30).' },
            order: { type: 'string', enum: ['desc', 'asc'], description: 'desc (mayor) default, asc (menor).' },
            ...filterProps,
          },
          required: ['from', 'to', 'dim'],
        },
      },
      {
        name: 'sellout_explain',
        description: 'Explica el cambio: descompone al centavo quién movió la venta entre un periodo y su espejo, por dimensión. compare=prev (periodo anterior) | yoy (año anterior). Usalo para "¿por qué subió/bajó X?", "qué explica la caída".',
        input_schema: {
          type: 'object',
          properties: {
            ...dateProps,
            dim: { type: 'string', enum: ['brand', 'branch', 'channel'], description: 'Dimensión para descomponer.' },
            compare: { type: 'string', enum: ['prev', 'yoy'], description: 'Contra qué comparar.' },
            brand: { type: 'string', description: 'Acotar a una marca. Opcional.' },
          },
          required: ['from', 'to', 'dim', 'compare'],
        },
      },
      {
        name: 'sellout_series',
        description: 'Serie mensual de monto en un rango (para tendencia), con filtros opcionales. Usalo para "cómo viene la tendencia", "evolución de X".',
        input_schema: { type: 'object', properties: { ...dateProps, ...filterProps }, required: ['from', 'to'] },
      },
      {
        name: 'render_response',
        description: 'Respuesta FINAL al usuario. Llamala cuando ya tenés los datos. narrative en español, conciso, citando los números de las tools. NO inventes cifras.',
        input_schema: {
          type: 'object',
          properties: {
            narrative: { type: 'string', description: 'La respuesta en español (2-5 frases).' },
            suggested_follow_ups: { type: 'array', items: { type: 'string' }, description: '2-3 preguntas de seguimiento cortas.' },
          },
          required: ['narrative'],
        },
      },
    ];
  }

  buildSystemPrompt(ctx: { today: string }): string {
    return [
      'Sos el asistente de análisis del reporte Sell-Out (venta real) de Mega Dulces, distribuidora de dulces en México.',
      `Hoy es ${ctx.today} (zona America/Mexico_City).`,
      '',
      'REGLA #1 — NUNCA inventes un número. TODA cifra sale de las tools; si una tool no te dio el dato, decilo, no lo estimes.',
      'REGLA #2 — Las fechas SIEMPRE en ISO YYYY-MM-DD. "agosto 2026" = 2026-08-01 a 2026-08-31. "este mes"/"mes en curso" = el mes de hoy. Un mes completo va del día 01 al último día del mes.',
      'REGLA #3 — Elegí la tool correcta: "cuánto vendió X" -> sellout_total; "top/ranking/quién vendió más" -> sellout_top; "por qué subió/bajó / qué explica el cambio" -> sellout_explain (compare=prev si dicen "vs mes anterior", yoy si "vs año pasado"); "tendencia/evolución" -> sellout_series.',
      '',
      'Vocabulario: canales = mostrador, ruta, credito (=mayoreo), preventa. Las marcas son las EMPRESAS/proveedores. El monto es venta con IVA (bruto de línea). Podés cruzar varias tools antes de responder.',
      '',
      'Cuando ya tengas todo, llamá render_response con la respuesta en español (concisa, citando los números) y 2-3 suggested_follow_ups.',
    ].join('\n');
  }

  describeStep(name: string, input: any): string {
    switch (name) {
      case 'sellout_total': return `Sumando la venta${input?.brand ? ' de ' + input.brand : ''}...`;
      case 'sellout_top': return `Armando el ranking por ${input?.dim || 'dimensión'}...`;
      case 'sellout_explain': return `Descomponiendo el cambio por ${input?.dim || 'dimensión'}...`;
      case 'sellout_series': return 'Trazando la tendencia mensual...';
      case 'render_response': return 'Redactando la respuesta...';
      default: return 'Consultando...';
    }
  }

  // ── Dispatcher ──────────────────────────────────────────────────────────────
  async execute(name: string, input: any): Promise<any> {
    try {
      switch (name) {
        case 'sellout_total': return await this.total(input);
        case 'sellout_top': return await this.top(input);
        case 'sellout_explain': return await this.explain(input);
        case 'sellout_series': return await this.series(input);
        default: return { error: `tool desconocida: ${name}` };
      }
    } catch (e: any) {
      return { error: (e?.message || 'error en la tool').slice(0, 200) };
    }
  }

  // ── Fuente + filtros ─────────────────────────────────────────────────────────
  private currentMonthStartMx(): string {
    const mx = new Date(Date.now() - 6 * 3600 * 1000);
    return `${mx.getUTCFullYear()}-${String(mx.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }
  private isLastDayOfMonth(d: string): boolean {
    const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(8, 10) === '01';
  }
  /** Rollup si el rango son meses cerrados y alineados; si no, la vista diaria. */
  private pickSource(from: string, to: string): { table: string; dateCol: string; lo: string; hi: string } {
    const aligned = from.slice(8, 10) === '01' && this.isLastDayOfMonth(to);
    const closed = to < this.currentMonthStartMx();
    if (aligned && closed) return { table: 'analytics.mv_sellout_monthly', dateCol: 's.year_month', lo: from.slice(0, 7), hi: to.slice(0, 7) };
    return { table: 'analytics.v_sellout_daily', dateCol: 's.business_date', lo: from, hi: to };
  }
  private applyFilters(b: any, input: any) {
    b.andWhere('s.is_promo', false).andWhereRaw(`s.channel <> 'traspaso'`);
    if (input?.brand) b.andWhereRaw('s.brand_nombre ILIKE ?', [`%${String(input.brand).trim()}%`]);
    if (input?.channel) b.andWhere('s.channel', String(input.channel).trim().toLowerCase());
    if (input?.warehouse) b.andWhereRaw('s.branch_name ILIKE ?', [`%${String(input.warehouse).trim()}%`]);
  }
  private isoRange(input: any): { from: string; to: string } {
    const from = String(input?.from || '').slice(0, 10);
    const to = String(input?.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('from/to deben ser ISO YYYY-MM-DD');
    if (from > to) throw new Error('from posterior a to');
    return { from, to };
  }

  // ── Handlers ─────────────────────────────────────────────────────────────────
  private async total(input: any) {
    const { from, to } = this.isoRange(input);
    const s = this.pickSource(from, to);
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const r = await trx(`${s.table} as s`)
        .where('s.tenant_id', tenantId).andWhere(s.dateCol, '>=', s.lo).andWhere(s.dateCol, '<=', s.hi)
        .modify((b: any) => this.applyFilters(b, input))
        .select(trx.raw('COALESCE(SUM(s.monto),0)::numeric as monto'), trx.raw('COALESCE(SUM(s.monto_neto),0)::numeric as monto_neto'), trx.raw('COALESCE(SUM(s.units),0)::numeric as units'))
        .first();
      return {
        period: { from, to },
        monto: Math.round(Number(r?.monto || 0)),
        monto_neto: Math.round(Number(r?.monto_neto || 0)),
        unidades: Math.round(Number(r?.units || 0)),
        nota: 'monto = venta con IVA (bruto de línea); monto_neto = neto de descuento.',
      };
    });
  }

  private async top(input: any) {
    const { from, to } = this.isoRange(input);
    const dim = DIMS.includes(input?.dim) ? input.dim : 'brand';
    const n = Math.min(30, Math.max(1, Number(input?.n) || 10));
    const asc = input?.order === 'asc';
    const s = this.pickSource(from, to);
    const tenantId = this.tenantCtx.requireTenantId();
    const keyExpr = dim === 'branch' ? 's.warehouse_code' : dim === 'channel' ? 's.channel' : dim === 'product' ? 's.product_id' : 's.brand_id';
    const labelExpr = dim === 'branch' ? 'max(s.branch_name)' : dim === 'channel' ? `max(s.channel)` : dim === 'product' ? 'max(s.nombre)' : 'max(s.brand_nombre)';
    return this.tk.run(async (trx) => {
      const rows = await trx(`${s.table} as s`)
        .where('s.tenant_id', tenantId).andWhere(s.dateCol, '>=', s.lo).andWhere(s.dateCol, '<=', s.hi)
        .modify((b: any) => this.applyFilters(b, input))
        .select(trx.raw(`COALESCE(${labelExpr}, ${keyExpr}::text, 'N/D') as label`), trx.raw('SUM(s.monto)::numeric as monto'), trx.raw('SUM(s.units)::numeric as units'))
        .groupByRaw(keyExpr)
        .orderByRaw(`SUM(s.monto) ${asc ? 'asc' : 'desc'} NULLS LAST`)
        .limit(n);
      return { period: { from, to }, dim, ...col(['Empresa/Item', 'Monto', 'Unidades'], rows.map((r: any) => [r.label, Math.round(Number(r.monto || 0)), Math.round(Number(r.units || 0))])) };
    });
  }

  private async series(input: any) {
    const { from, to } = this.isoRange(input);
    const tenantId = this.tenantCtx.requireTenantId();
    // La serie mensual siempre puede salir del grano día de la vista o del rollup; uso el rollup
    // por mes cuando el rango es cerrado, si no la vista.
    const s = this.pickSource(from, to);
    const monthExpr = s.table.includes('mv_sellout_monthly') ? 's.year_month' : `to_char(s.business_date, 'YYYY-MM')`;
    return this.tk.run(async (trx) => {
      const rows = await trx(`${s.table} as s`)
        .where('s.tenant_id', tenantId).andWhere(s.dateCol, '>=', s.lo).andWhere(s.dateCol, '<=', s.hi)
        .modify((b: any) => this.applyFilters(b, input))
        .select(trx.raw(`${monthExpr} as mes`), trx.raw('SUM(s.monto)::numeric as monto'))
        .groupByRaw(monthExpr).orderByRaw(monthExpr);
      return { period: { from, to }, ...col(['mes', 'Monto'], rows.map((r: any) => [r.mes, Math.round(Number(r.monto || 0))])) };
    });
  }

  private async explain(input: any) {
    const { from, to } = this.isoRange(input);
    const dim: SellOutExplainDim = input?.dim === 'branch' || input?.dim === 'channel' ? input.dim : 'brand';
    const compare: SellOutExplainCompare = input?.compare === 'yoy' ? 'yoy' : 'prev';
    // Resolver marca -> brand_id si vino por nombre (explainChange filtra por id).
    let brandId: string | undefined;
    if (input?.brand) {
      const tenantId = this.tenantCtx.requireTenantId();
      const b = await this.tk.run(async (trx) =>
        trx('catalog.brands').where('tenant_id', tenantId).whereRaw('nombre ILIKE ?', [`%${String(input.brand).trim()}%`]).whereNull('deleted_at').select('id').first(),
      );
      brandId = b?.id;
    }
    const r = await this.analytics.explainChange({ from, to, dim, compare, brand_id: brandId });
    return {
      period: r.period, mirror: r.mirror, compare: r.compare, dimension: r.dimension,
      total: { actual: Math.round(r.total.curr), previo: Math.round(r.total.prev), delta: Math.round(r.total.delta), delta_pct: r.total.delta_pct == null ? null : Number(r.total.delta_pct.toFixed(1)) },
      ...col(['Miembro', 'Δ', 'Δ%', 'tipo'], r.movers.map((m) => [m.label, Math.round(m.delta), m.delta_pct == null ? null : Number(m.delta_pct.toFixed(0)), m.kind])),
      otros: { count: r.otros.count, delta: Math.round(r.otros.delta) },
    };
  }
}
