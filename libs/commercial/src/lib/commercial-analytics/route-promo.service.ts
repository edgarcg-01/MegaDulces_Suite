import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, AnthropicService } from '@megadulces/platform-core';

/**
 * RR-PROMO — Evaluador de mecánicas de incentivo de RUTA (RD) a partir de un ENUNCIADO en
 * lenguaje natural. Patrón ADR-016: el LLM (Haiku) SOLO traduce el enunciado a una regla
 * estructurada; el PAGO lo calcula un motor SQL determinista sobre `analytics.v_route_sales_lines`
 * (el mismo dato que /ventas-por-ruta). El LLM nunca toca la aritmética → auditable y reproducible.
 *
 * Ejemplo de enunciado:
 *   "RD: $6.00 por cada venta de choyitas 14 gr./40 cód:97192, solo participan clientes distintos
 *    a los que se les haya vendido una o más piezas"
 * → { canal:'ruta', sku:'97192', metric:'clientes_distintos', rate:6, min_qty:1 }
 * → pago por ruta = $6 × (clientes distintos con ≥1 pza del 97192 en el periodo).
 */

export type PromoMetric = 'clientes_distintos' | 'piezas' | 'tickets' | 'monto';

export interface PromoRule {
  canal: 'ruta' | 'todos';
  sku: string | null;
  producto_texto: string | null;
  metric: PromoMetric;
  rate: number;
  min_qty: number;
  descripcion: string;
  supuestos: string;
}

export interface PromoRouteRow {
  warehouse_code: string;
  warehouse_name: string;
  route_no: string;
  label: string;
  base: number;   // clientes / piezas / tickets / monto según la métrica
  payout: number; // rate × base
}

export interface PromoResult {
  enunciado: string;
  rule: PromoRule;
  product: { sku: string; nombre: string } | null;
  candidates?: { sku: string; nombre: string }[];
  period: { from: string; to: string; label: string };
  metric_label: string;
  base_label: string;
  rows: PromoRouteRow[];
  total_base: number;
  total_payout: number;
  note: string;
  generated_at: string;
}

export interface PromoQuery {
  enunciado?: string;
  rule?: Partial<PromoRule>; // permite saltar el LLM (regla ya estructurada / edición manual)
  sku?: string;              // fuerza el SKU (cuando el usuario resolvió la ambigüedad)
  year?: number;
  from?: string;
  to?: string;
}

const METRIC_LABEL: Record<PromoMetric, string> = {
  clientes_distintos: 'Clientes distintos',
  piezas: 'Piezas',
  tickets: 'Tickets',
  monto: 'Monto vendido',
};
const PROMO_MODEL = process.env.PROMO_MODEL || 'claude-haiku-4-5-20251001';
const DRX = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class RoutePromoService {
  private readonly logger = new Logger(RoutePromoService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly anthropic: AnthropicService,
  ) {}

  /** Traduce el enunciado a una regla estructurada con Haiku (tool forzada = salida estructurada). */
  async parse(enunciado: string): Promise<PromoRule> {
    const text = (enunciado || '').trim();
    if (!text) throw new BadRequestException('enunciado vacío');
    if (!this.anthropic.hasApiKey) throw new BadRequestException('IA no configurada (falta ANTHROPIC_API_KEY)');

    const tool = {
      name: 'emitir_regla',
      description: 'Extrae la mecánica de incentivo de ventas de ruta del enunciado.',
      input_schema: {
        type: 'object',
        properties: {
          canal: { type: 'string', enum: ['ruta', 'todos'], description: 'RD / reparto / ruta / venta a bordo → "ruta". Si no se menciona canal → "todos".' },
          sku: { type: ['string', 'null'], description: 'Código del producto si aparece (ej "cód:97192", "clave 97192" → "97192"). Si no hay código → null.' },
          producto_texto: { type: ['string', 'null'], description: 'Nombre del producto como se menciona (ej "choyitas 14 gr/40"), para resolverlo por catálogo si no hay código. null si no aplica.' },
          metric: { type: 'string', enum: ['clientes_distintos', 'piezas', 'tickets', 'monto'], description: '"clientes_distintos" si el pago es por CLIENTE/cuenta distinta que compró el producto (aunque compre varias piezas, cuenta una vez). "piezas" si es por cada pieza/unidad. "tickets" por ticket/venta. "monto" si es $/% sobre el importe vendido.' },
          rate: { type: 'number', description: 'Monto en pesos por cada unidad de la métrica (ej $6.00 → 6).' },
          min_qty: { type: 'number', description: 'Piezas mínimas por cliente para calificar (ej "una o más piezas" → 1). Default 1.' },
          descripcion: { type: 'string', description: 'La regla reformulada, clara, en una línea.' },
          supuestos: { type: 'string', description: 'Ambigüedades o supuestos que tomaste; "" si ninguno.' },
        },
        required: ['canal', 'metric', 'rate', 'min_qty', 'descripcion'],
      },
    };
    const system =
      'Traduces mecánicas de incentivo a vendedores de RUTA (RD = reparto = venta a bordo) a parámetros ' +
      'estructurados. "clientes distintos a los que se les vendió una o más piezas" = métrica clientes_distintos ' +
      'con min_qty=1 (cada cliente cuenta UNA vez sin importar cuántas piezas compre). No inventes datos: si el ' +
      'enunciado no lo dice, usa los defaults y anótalo en supuestos. Responde SOLO llamando la herramienta.';

    const resp = await this.anthropic.messages({
      model: PROMO_MODEL,
      maxTokens: 500,
      system,
      messages: [{ role: 'user', content: text }],
      tools: [tool],
      toolChoice: { type: 'tool', name: 'emitir_regla' },
    });
    const block = (resp?.content || []).find((b: any) => b.type === 'tool_use' && b.name === 'emitir_regla');
    if (!block?.input) throw new BadRequestException('No se pudo interpretar el enunciado');
    const r = block.input;
    return {
      canal: r.canal === 'todos' ? 'todos' : 'ruta',
      sku: r.sku ? String(r.sku).trim() : null,
      producto_texto: r.producto_texto ? String(r.producto_texto).trim() : null,
      metric: (['clientes_distintos', 'piezas', 'tickets', 'monto'] as PromoMetric[]).includes(r.metric) ? r.metric : 'clientes_distintos',
      rate: Number(r.rate) || 0,
      min_qty: Number(r.min_qty) > 0 ? Number(r.min_qty) : 1,
      descripcion: String(r.descripcion || '').trim(),
      supuestos: String(r.supuestos || '').trim(),
    };
  }

  /** Resuelve el rango del periodo: from/to explícito · año completo · o mes anterior (default). */
  private resolvePeriod(q: PromoQuery): { from: string; to: string; label: string } {
    if (q.from && q.to && DRX.test(q.from) && DRX.test(q.to)) {
      return { from: q.from, to: this.nextDay(q.to), label: `${q.from} – ${q.to}` };
    }
    if (q.year) {
      const y = Number(q.year);
      if (y < 2020 || y > 2100) throw new BadRequestException('year inválido');
      return { from: `${y}-01-01`, to: `${y + 1}-01-01`, label: `Año ${y}` };
    }
    // default: mes calendario anterior (cerrado)
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const from = this.iso(first);
    const to = this.iso(new Date(now.getFullYear(), now.getMonth(), 1));
    return { from, to, label: this.monthLabel(first) };
  }
  private iso(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  private nextDay(iso: string) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + 1); return this.iso(d); }
  private monthLabel(d: Date) {
    const M = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    return `${M[d.getMonth()]} ${d.getFullYear()}`;
  }

  /** Punto de entrada: enunciado (+ periodo) → regla + pago por ruta. */
  async evaluate(q: PromoQuery): Promise<PromoResult> {
    this.tenantCtx.requireTenantId();
    const enunciado = (q.enunciado || '').trim();
    // Regla: del enunciado (LLM) o pre-estructurada (edición manual / test).
    const rule: PromoRule = q.rule?.metric
      ? {
          canal: q.rule.canal === 'todos' ? 'todos' : 'ruta',
          sku: q.rule.sku ? String(q.rule.sku).trim() : null,
          producto_texto: q.rule.producto_texto ?? null,
          metric: q.rule.metric as PromoMetric,
          rate: Number(q.rule.rate) || 0,
          min_qty: Number(q.rule.min_qty) > 0 ? Number(q.rule.min_qty) : 1,
          descripcion: q.rule.descripcion || '',
          supuestos: q.rule.supuestos || '',
        }
      : await this.parse(enunciado);
    if (q.sku) rule.sku = String(q.sku).trim();

    const period = this.resolvePeriod(q);

    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();

      // 1) Resolver producto → SKU único.
      let product: { sku: string; nombre: string } | null = null;
      let candidates: { sku: string; nombre: string }[] | undefined;
      if (rule.sku) {
        const p = await trx('catalog.products').where({ tenant_id: tenantId, sku: rule.sku })
          .whereNull('deleted_at').select('sku', 'nombre').first();
        product = p ? { sku: p.sku, nombre: p.nombre } : { sku: rule.sku, nombre: rule.producto_texto || rule.sku };
      } else if (rule.producto_texto) {
        const tokens = rule.producto_texto.split(/\s+/).filter((t) => t.length >= 3).slice(0, 5);
        let qb = trx('catalog.products').where('tenant_id', tenantId).whereNull('deleted_at');
        for (const t of tokens) qb = qb.andWhereRaw('unaccent(nombre) ILIKE unaccent(?)', [`%${t}%`]);
        const hits = await qb.select('sku', 'nombre').limit(8);
        if (hits.length === 1) product = { sku: hits[0].sku, nombre: hits[0].nombre };
        else if (hits.length > 1) candidates = hits.map((h: any) => ({ sku: h.sku, nombre: h.nombre }));
      }

      if (!product) {
        return {
          enunciado, rule, product: null, candidates,
          period, metric_label: METRIC_LABEL[rule.metric], base_label: METRIC_LABEL[rule.metric],
          rows: [], total_base: 0, total_payout: 0,
          note: candidates?.length
            ? 'El producto es ambiguo — elegí el SKU correcto y recalculá.'
            : 'No se encontró el producto del enunciado (SKU o nombre). Verificá el código.',
          generated_at: new Date().toISOString(),
        };
      }

      // 2) Motor determinista: base por (ruta, cliente) → agregado por ruta según la métrica.
      const rows: any[] = (await trx.raw(
        `WITH base AS (
           SELECT b.source_branch AS route_no,
                  w.code AS wcode, COALESCE(w.name, initcap(pb.branch_name)) AS wname,
                  sl.cliente,
                  SUM(sl.qty) AS qty, SUM(sl.importe) AS importe,
                  COUNT(DISTINCT sl.consecutivo) AS tickets
           FROM analytics.v_route_sales_lines sl
           JOIN wincaja.branches b  ON b.tenant_id=sl.tenant_id AND b.source_branch=sl.source_branch AND b.is_route=true
           JOIN wincaja.branches pb ON pb.tenant_id=b.tenant_id AND pb.source_branch=b.parent_branch
           LEFT JOIN commercial.warehouses w ON w.tenant_id=b.tenant_id
                AND w.code=COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
           WHERE sl.tenant_id=? AND sl.sale_channel='ruta_venta'
             AND sl.business_date>=? AND sl.business_date<? AND sl.business_date<=CURRENT_DATE
             AND sl.sku=?
           GROUP BY b.source_branch, w.code, w.name, pb.branch_name, sl.cliente
         )
         SELECT route_no, wcode, wname,
           COUNT(*) FILTER (WHERE cliente IS NOT NULL AND btrim(cliente)<>'' AND cliente<>'0001' AND qty >= ?) AS clientes,
           COALESCE(SUM(qty),0) AS piezas,
           COALESCE(SUM(tickets),0) AS tickets,
           COALESCE(SUM(importe),0) AS monto
         FROM base
         GROUP BY route_no, wcode, wname
         ORDER BY wname, route_no`,
        [tenantId, period.from, period.to, product.sku, rule.min_qty],
      )).rows;

      const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
      const baseOf = (r: any): number => {
        switch (rule.metric) {
          case 'clientes_distintos': return Number(r.clientes) || 0;
          case 'piezas': return round(Number(r.piezas) || 0, 2);
          case 'tickets': return Number(r.tickets) || 0;
          case 'monto': return round(Number(r.monto) || 0, 2);
        }
      };
      const out: PromoRouteRow[] = rows
        .map((r) => {
          const base = baseOf(r);
          return {
            warehouse_code: r.wcode, warehouse_name: r.wname, route_no: String(r.route_no ?? '—'),
            label: `${r.wname} · Ruta ${r.route_no ?? ''}`.trim(),
            base, payout: round(base * rule.rate, 2),
          };
        })
        .filter((r) => r.base > 0)
        .sort((a, b) => b.payout - a.payout);

      const total_base = round(out.reduce((s, r) => s + r.base, 0), 2);
      const total_payout = round(out.reduce((s, r) => s + r.payout, 0), 2);

      return {
        enunciado, rule, product, period,
        metric_label: METRIC_LABEL[rule.metric],
        base_label: rule.metric === 'clientes_distintos' ? `Clientes (≥${rule.min_qty} pza)` : METRIC_LABEL[rule.metric],
        rows: out, total_base, total_payout,
        note: out.length
          ? `${out.length} ruta(s) con actividad · $${rule.rate.toFixed(2)} × ${METRIC_LABEL[rule.metric].toLowerCase()}.`
          : 'Sin ventas del producto en ruta para el periodo.',
        generated_at: new Date().toISOString(),
      };
    });
  }
}
