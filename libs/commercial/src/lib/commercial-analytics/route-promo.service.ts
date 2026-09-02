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
  // Vigencia detectada por el AI en el enunciado (auto-inteligente). null si el enunciado no la menciona.
  date_from?: string | null;   // YYYY-MM-DD (inclusive)
  date_to?: string | null;     // YYYY-MM-DD (inclusive)
  periodo_texto?: string | null;
}

export interface PromoRouteRow {
  warehouse_code: string;
  warehouse_name: string;
  route_no: string;
  label: string;
  clientes: number;                // clientes distintos que califican (≥ min_qty, en unidad base)
  clientes_indeterminados: number; // no califican por lo resuelto, pero tienen línea sin peldaño
  unidades: number;                // cantidad en la unidad BASE del SKU (ver PromoResult.unit_base)
  unidades_sin_resolver: number;   // cantidad cuyo peldaño el precio no pudo identificar
  importe: number;                 // dinero de esas ventas (no depende de la unidad)
  base: number;                    // clientes / unidades / tickets / monto según la métrica
  payout: number;                  // rate × base
}

/** Detalle de un cliente que participó (para "cuáles fueron"). */
export interface PromoClientRow {
  warehouse_name: string;
  route_no: string;
  route_label: string;
  cliente: string;
  nombre: string;
  unidades: number;
  importe: number;
}

/**
 * Cómo quedó la unidad de medida del cálculo. Se DECLARA siempre: la mecánica se paga
 * por cantidad, y la cantidad no significa nada sin su unidad.
 */
export interface PromoUnitInfo {
  /** Rótulo base real del ERP (`kdii.c11`): PZA / PAQ / CJA… null si el ERP no lo declara. */
  unit_base: string | null;
  /** Producto de peso (granel): la cuenta por unidades no aplica. */
  is_weight: boolean;
  /** El SKU no está en `kepler_ods.kdii` → no hay escalera con qué resolver nada. */
  sin_escalera: boolean;
  lineas_sin_resolver: number;
  unidades_sin_resolver: number;
  importe_sin_resolver: number;
  /** true = hay evidencia suficiente para pagar por cantidad sin inventar nada. */
  confiable: boolean;
  /** Explicación en una línea para la pantalla y el PDF. */
  nota: string;
}

export interface PromoResult {
  enunciado: string;
  rule: PromoRule;
  product: { sku: string; nombre: string } | null;
  candidates?: { sku: string; nombre: string }[];
  period: { from: string; to: string; label: string };
  metric_label: string;
  base_label: string;
  unit: PromoUnitInfo;
  rows: PromoRouteRow[];
  clientes_detalle: PromoClientRow[];
  total_base: number;
  total_payout: number;
  total_clientes: number;
  total_clientes_indeterminados: number;
  total_unidades: number;
  total_importe: number;
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
  // 'piezas' es la clave HISTÓRICA de la métrica (viaja en la regla del LLM y en payloads
  // guardados); el rótulo dice "Unidades" porque la cantidad está en la unidad BASE del SKU,
  // que para la mayoría del catálogo es el PAQUETE, no la pieza. Ver LADDER_CTE.
  piezas: 'Unidades',
  tickets: 'Tickets',
  monto: 'Monto vendido',
};
const PROMO_MODEL = process.env.PROMO_MODEL || 'claude-haiku-4-5-20251001';
const DRX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ── NORMALIZACIÓN DE UNIDAD (RR-PROMO.1) ────────────────────────────────────────────────
 * La venta de ruta registra cada línea en el peldaño en que se vendió (pieza / paquete /
 * caja) y el RÓTULO no es confiable: medido en prod (ago-2026) el mismo rótulo 'PZA' de un
 * SKU trae 361 líneas a $6.12 (pieza) y 45 líneas a $90.96 (paquete de 16). Sumar `qty` a
 * ciegas **subcuenta 9.1% global, y >5% en 140 SKUs que son el 19% de la venta de ruta**
 * (hasta 43% en 97245). Es la cantidad con la que se le paga a la gente.
 *
 * El peldaño se identifica por el PRECIO REALMENTE COBRADO contra la escalera del ERP
 * (`analytics.v_product_unit_ladder`, vista derive-no-copy sobre `kepler_ods.kdii`).
 * Funciona porque los peldaños distan entre sí ≥ el factor (≥2×), mucho más que cualquier
 * descuento. La banda 0.5×–2× es la que `docs/UNIDADES_DE_MEDIDA.md` §6 usa para declarar
 * "misma unidad que la base".
 *
 * Fuera de la banda NO se adivina: la línea queda `f IS NULL` y se DECLARA como
 * no resuelta (medido: 0.17% de las líneas / 0.11% del importe).
 *
 * `qty * f` deja la cantidad en la unidad BASE del SKU (`kdii.c11`) — que puede ser PZA
 * **o PAQ**: para 97192 la base es el paquete, así que `c84=24` son paquetes por caja.
 * Por eso el resultado se llama `unidades` y viaja con su rótulo, nunca "piezas".
 */
const LADDER_CTE = `lad AS (SELECT * FROM analytics.v_product_unit_ladder WHERE sku = ?)`;

/** LATERAL que elige el peldaño de la línea por su precio. Requiere `lad` en el WITH. */
const TIER_LATERAL = `
      LEFT JOIN lad ON true
      LEFT JOIN LATERAL (
        SELECT t.f
        FROM (VALUES (1::numeric, lad.p1), (COALESCE(lad.f2, 1), lad.p2), (COALESCE(lad.f3, 1), lad.p3)) AS t(f, p)
        WHERE t.p > 0 AND sl.qty <> 0 AND (sl.importe / sl.qty) > 0
          AND abs(ln((sl.importe / sl.qty) / t.p)) < ln(2)
        ORDER BY abs(ln((sl.importe / sl.qty) / t.p))
        LIMIT 1
      ) tier ON true`;

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
          date_from: { type: ['string', 'null'], description: 'Inicio de la VIGENCIA de la promo en YYYY-MM-DD, si el enunciado la menciona (ej "del 1 al 15 de agosto", "vigencia agosto", "primera quincena de septiembre", "esta semana"). Resolvé el año con la fecha de HOY que se te da. null si el enunciado NO menciona periodo.' },
          date_to: { type: ['string', 'null'], description: 'Fin (INCLUSIVE) de la vigencia en YYYY-MM-DD. Mes completo ("agosto") → último día del mes. "primera quincena" → día 15; "segunda quincena" → fin de mes. null si no hay periodo.' },
          periodo_texto: { type: ['string', 'null'], description: 'El periodo tal como se menciona, en texto corto para mostrar (ej "1–15 de agosto 2026", "Agosto 2026"). null si no aplica.' },
        },
        required: ['canal', 'metric', 'rate', 'min_qty', 'descripcion'],
      },
    };
    const hoy = this.iso(new Date()); // contenedor en TZ MX
    const system =
      'Traduces mecánicas de incentivo a vendedores de RUTA (RD = reparto = venta a bordo) a parámetros ' +
      'estructurados. "clientes distintos a los que se les vendió una o más piezas" = métrica clientes_distintos ' +
      'con min_qty=1 (cada cliente cuenta UNA vez sin importar cuántas piezas compre). No inventes datos: si el ' +
      'enunciado no lo dice, usa los defaults y anótalo en supuestos. ' +
      `Hoy es ${hoy} (zona horaria de México). Si el enunciado indica una vigencia o periodo (fechas, mes, ` +
      'quincena, "esta semana"), extraela en date_from/date_to (YYYY-MM-DD, resolviendo el año con la fecha de hoy); ' +
      'si NO menciona periodo, dejá date_from/date_to en null. Responde SOLO llamando la herramienta.';

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
    // Vigencia auto: válida solo si ambas fechas son ISO y from <= to; si no, null (cae al picker/default).
    let df = DRX.test(String(r.date_from || '')) ? String(r.date_from) : null;
    let dt = DRX.test(String(r.date_to || '')) ? String(r.date_to) : null;
    if (df && dt && df > dt) { const tmp = df; df = dt; dt = tmp; } // por si vienen invertidas
    if (!df || !dt) { df = null; dt = null; }
    return {
      canal: r.canal === 'todos' ? 'todos' : 'ruta',
      sku: r.sku ? String(r.sku).trim() : null,
      producto_texto: r.producto_texto ? String(r.producto_texto).trim() : null,
      metric: (['clientes_distintos', 'piezas', 'tickets', 'monto'] as PromoMetric[]).includes(r.metric) ? r.metric : 'clientes_distintos',
      rate: Number(r.rate) || 0,
      min_qty: Number(r.min_qty) > 0 ? Number(r.min_qty) : 1,
      descripcion: String(r.descripcion || '').trim(),
      supuestos: String(r.supuestos || '').trim(),
      date_from: df, date_to: dt,
      periodo_texto: (df && r.periodo_texto) ? String(r.periodo_texto).trim() : null,
    };
  }

  /**
   * Resuelve el rango del periodo. Prioridad:
   *   1) override MANUAL del usuario (q.from/q.to, ej picker tocado o test),
   *   2) vigencia AUTO detectada por el AI en el enunciado (rule.date_from/to),
   *   3) año completo, 4) mes anterior cerrado (default).
   * El `to` interno es EXCLUSIVE (business_date < to).
   */
  private resolvePeriod(q: PromoQuery, rule?: Partial<PromoRule>): { from: string; to: string; label: string } {
    if (q.from && q.to && DRX.test(q.from) && DRX.test(q.to)) {
      return { from: q.from, to: this.nextDay(q.to), label: `${q.from} – ${q.to}` };
    }
    if (rule?.date_from && rule?.date_to && DRX.test(rule.date_from) && DRX.test(rule.date_to) && rule.date_from <= rule.date_to) {
      return { from: rule.date_from, to: this.nextDay(rule.date_to), label: (rule.periodo_texto || '').trim() || `${rule.date_from} – ${rule.date_to}` };
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
  private money(v: number) { return `$${(Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
  private nextDay(iso: string) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + 1); return this.iso(d); }
  private monthLabel(d: Date) {
    const M = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    return `${M[d.getMonth()]} ${d.getFullYear()}`;
  }

  /**
   * Motor GENERAL de incentivos para Thot (todos los canales, no solo ruta). El LLM (Thot)
   * ya extrajo los parámetros del enunciado del usuario → aquí solo se calcula, determinista,
   * sobre `wincaja.v_sales_lines` (detalle con vendedor + cliente + canal + sucursal). Agrupa por
   * la dimensión pedida (vendedor/ruta/canal/sucursal). El LLM nunca hace la aritmética.
   */
  async evaluateIncentive(p: {
    sku?: string; producto_texto?: string;
    metric: PromoMetric; rate: number; min_qty?: number;
    canal?: 'ruta' | 'mayoreo' | 'mostrador' | 'preventa' | 'todos';
    dimension?: 'vendedor' | 'ruta' | 'canal' | 'sucursal';
    from?: string; to?: string; year?: number;
  }): Promise<any> {
    this.tenantCtx.requireTenantId();
    const metric: PromoMetric = (['clientes_distintos', 'piezas', 'tickets', 'monto'] as PromoMetric[]).includes(p.metric) ? p.metric : 'clientes_distintos';
    const rate = Number(p.rate) || 0;
    const minQty = Number(p.min_qty) > 0 ? Number(p.min_qty) : 1;
    const canal = p.canal || 'todos';
    let dimension = (['vendedor', 'ruta', 'canal', 'sucursal'] as const).includes(p.dimension as any) ? p.dimension! : 'vendedor';
    const period = this.resolvePeriod(p);

    // RD (ruta/reparto): fuente AUTORITATIVA = analytics.v_route_sales_lines (une rutas Kepler-push +
    // Wincaja + vecinal). NO tiene vendedor → en RD la ruta ES el vendedor, así que la dimensión
    // colapsa a ruta (coincide 1:1 con la tarjeta de /ventas-por-ruta). Otros canales: wincaja.v_sales_lines.
    const routeUniverse = canal === 'ruta' || dimension === 'ruta';
    if (routeUniverse) dimension = 'ruta';

    const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
    const baseOf = (r: any) => metric === 'clientes_distintos' ? Number(r.clientes) || 0
      : metric === 'piezas' ? round(Number(r.piezas) || 0, 2)
      : metric === 'tickets' ? Number(r.tickets) || 0
      : round(Number(r.monto) || 0, 2);

    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();
      await trx.raw(`SET LOCAL statement_timeout = '45s'`);

      // Resolver producto → SKU.
      let product: { sku: string; nombre: string } | null = null;
      let candidates: { sku: string; nombre: string }[] | undefined;
      if (p.sku) {
        const row = await trx('catalog.products').where({ tenant_id: tenantId, sku: p.sku }).whereNull('deleted_at').select('sku', 'nombre').first();
        product = row ? { sku: row.sku, nombre: row.nombre } : { sku: p.sku, nombre: p.producto_texto || p.sku };
      } else if (p.producto_texto) {
        const tokens = p.producto_texto.split(/\s+/).filter((t) => t.length >= 3).slice(0, 5);
        let qb = trx('catalog.products').where('tenant_id', tenantId).whereNull('deleted_at');
        for (const t of tokens) qb = qb.andWhereRaw('unaccent(nombre) ILIKE unaccent(?)', [`%${t}%`]);
        const hits = await qb.select('sku', 'nombre').limit(8);
        if (hits.length === 1) product = { sku: hits[0].sku, nombre: hits[0].nombre };
        else if (hits.length > 1) candidates = hits.map((h: any) => ({ sku: h.sku, nombre: h.nombre }));
      }
      if (!product) {
        return { ok: false, error: candidates?.length ? 'producto_ambiguo' : 'producto_no_encontrado', candidates, metric, dimension, period };
      }

      let rows: any[];
      let unitBase: string | null = null;
      if (routeUniverse) {
        // Idéntico al motor validado de /ventas-por-ruta (v_route_sales_lines), por ruta, y con
        // la MISMA normalización de unidad que evaluate() (LADDER_CTE/TIER_LATERAL): si las dos
        // rutas de código dieran cantidades distintas para la misma promo, no serviría ninguna.
        rows = (await trx.raw(
          `WITH ${LADDER_CTE},
           base AS (
             SELECT b.source_branch AS dim0, COALESCE(w.name, initcap(pb.branch_name)) AS wname, sl.cliente,
                    SUM(sl.qty * tier.f) FILTER (WHERE tier.f IS NOT NULL) AS qty_base,
                    SUM(sl.importe) AS importe, COUNT(DISTINCT sl.consecutivo) AS tickets
             FROM analytics.v_route_sales_lines sl
             JOIN wincaja.branches b  ON b.tenant_id=sl.tenant_id AND b.source_branch=sl.source_branch AND b.is_route=true
             JOIN wincaja.branches pb ON pb.tenant_id=b.tenant_id AND pb.source_branch=b.parent_branch
             LEFT JOIN commercial.warehouses w ON w.tenant_id=b.tenant_id AND w.code=COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
             ${TIER_LATERAL}
             WHERE sl.tenant_id=? AND sl.sale_channel='ruta_venta' AND sl.business_date>=? AND sl.business_date<? AND sl.business_date<=CURRENT_DATE AND sl.sku=?
             GROUP BY b.source_branch, w.name, pb.branch_name, sl.cliente
           )
           SELECT (wname||' · Ruta '||dim0) AS dim,
             COUNT(*) FILTER (WHERE cliente IS NOT NULL AND btrim(cliente)<>'' AND cliente<>'0001' AND COALESCE(qty_base,0) >= ?) AS clientes,
             COALESCE(SUM(qty_base),0) AS piezas, COALESCE(SUM(tickets),0) AS tickets, COALESCE(SUM(importe),0) AS monto
           FROM base GROUP BY wname, dim0 ORDER BY dim`,
          [product.sku, tenantId, period.from, period.to, product.sku, minQty],
        )).rows;
        unitBase = (await trx.raw(
          `SELECT unit_base FROM analytics.v_product_unit_ladder WHERE sku = ?`, [product.sku],
        )).rows[0]?.unit_base ?? null;
      } else {
        // Otros canales (mostrador/mayoreo/preventa): wincaja.v_sales_lines, dimensión libre.
        const CHAN = `CASE vl.sale_channel WHEN 'ruta_venta' THEN 'Ruta' WHEN 'mayoreo_credito' THEN 'Mayoreo' WHEN 'preventa_vecinal' THEN 'Preventa' ELSE 'Mostrador' END`;
        const DIM: Record<string, string> = {
          vendedor: `COALESCE(NULLIF(btrim(vl.vendedor),''),'(sin vendedor)')`,
          canal: CHAN,
          sucursal: `COALESCE(w.name, initcap(pb.branch_name), vl.warehouse_code, vl.source_branch)`,
        };
        const dimExpr = DIM[dimension] || DIM['vendedor'];
        const CHAN_MAP: Record<string, string> = { mayoreo: 'mayoreo_credito', mostrador: 'mostrador', preventa: 'preventa_vecinal' };
        const chanWhere = canal !== 'todos' && CHAN_MAP[canal] ? ` AND vl.sale_channel='${CHAN_MAP[canal]}'` : '';
        rows = (await trx.raw(
          `WITH base AS (
             SELECT ${dimExpr} AS dim, vl.cliente,
                    SUM(vl.qty) AS qty, SUM(vl.importe) AS importe, COUNT(DISTINCT vl.consecutivo) AS tickets
             FROM wincaja.v_sales_lines vl
             LEFT JOIN wincaja.branches b  ON b.tenant_id=vl.tenant_id AND b.source_branch=vl.source_branch
             LEFT JOIN wincaja.branches pb ON pb.tenant_id=b.tenant_id AND pb.source_branch=COALESCE(b.parent_branch, b.source_branch)
             LEFT JOIN commercial.warehouses w ON w.tenant_id=vl.tenant_id AND w.code=COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
             WHERE vl.tenant_id=? AND vl.sku=? AND vl.business_date>=? AND vl.business_date<? AND vl.business_date<=CURRENT_DATE${chanWhere}
             GROUP BY ${dimExpr}, vl.cliente
           )
           SELECT dim,
             COUNT(*) FILTER (WHERE cliente IS NOT NULL AND btrim(cliente)<>'' AND cliente<>'0001' AND qty >= ?) AS clientes,
             COALESCE(SUM(qty),0) AS piezas, COALESCE(SUM(tickets),0) AS tickets, COALESCE(SUM(importe),0) AS monto
           FROM base GROUP BY dim ORDER BY dim`,
          [tenantId, product.sku, period.from, period.to, minQty],
        )).rows;
      }

      const out = rows.map((r) => ({ label: r.dim, base: baseOf(r), payout: round(baseOf(r) * rate, 2) }))
        .filter((r) => r.base > 0).sort((a, b) => b.payout - a.payout);

      return {
        ok: true,
        producto: product,
        periodo: period.label,
        metrica: METRIC_LABEL[metric],
        base_label: metric === 'clientes_distintos' ? `clientes (≥${minQty} pza)` : METRIC_LABEL[metric].toLowerCase(),
        rate, dimension, canal,
        // El rótulo de la unidad viaja con la cifra: sin él, "3,971 unidades" no dice nada.
        unidad: routeUniverse ? (unitBase || 'unidad base del ERP (no declarada)') : 'cantidad cruda de la fuente',
        unidad_normalizada: routeUniverse,
        fuente: routeUniverse ? 'rutas (RD)' : 'wincaja (mostrador/mayoreo/preventa)',
        filas: out,
        total_base: round(out.reduce((s, r) => s + r.base, 0), 2),
        total_pago: round(out.reduce((s, r) => s + r.payout, 0), 2),
        nota: out.length
          ? `$${rate.toFixed(2)} × ${METRIC_LABEL[metric].toLowerCase()} por ${dimension}.`
          : 'Sin ventas del producto en el periodo/canal.',
      };
    });
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
          // conserva la vigencia AUTO ya interpretada (evita re-llamar al LLM en recalcular/descargar)
          date_from: DRX.test(String(q.rule.date_from || '')) ? String(q.rule.date_from) : null,
          date_to: DRX.test(String(q.rule.date_to || '')) ? String(q.rule.date_to) : null,
          periodo_texto: q.rule.periodo_texto ?? null,
        }
      : await this.parse(enunciado);
    if (q.sku) rule.sku = String(q.sku).trim();

    const period = this.resolvePeriod(q, rule);

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
          unit: {
            unit_base: null, is_weight: false, sin_escalera: true,
            lineas_sin_resolver: 0, unidades_sin_resolver: 0, importe_sin_resolver: 0,
            confiable: false, nota: 'Sin producto resuelto no hay unidad que declarar.',
          },
          rows: [], clientes_detalle: [], total_base: 0, total_payout: 0,
          total_clientes: 0, total_clientes_indeterminados: 0, total_unidades: 0, total_importe: 0,
          note: candidates?.length
            ? 'El producto es ambiguo — elegí el SKU correcto y recalculá.'
            : 'No se encontró el producto del enunciado (SKU o nombre). Verificá el código.',
          generated_at: new Date().toISOString(),
        };
      }

      // 2) Motor determinista: base por (ruta, cliente) → agregado por ruta según la métrica.
      //    `qty` se normaliza a la unidad BASE del SKU resolviendo el peldaño por precio
      //    (ver LADDER_CTE / TIER_LATERAL). Lo que no resuelve NO se suma: se declara.
      const rows: any[] = (await trx.raw(
        `WITH ${LADDER_CTE},
         base AS (
           SELECT b.source_branch AS route_no,
                  w.code AS wcode, COALESCE(w.name, initcap(pb.branch_name)) AS wname,
                  sl.cliente,
                  SUM(sl.qty * tier.f) FILTER (WHERE tier.f IS NOT NULL)      AS qty_base,
                  SUM(sl.qty)          FILTER (WHERE tier.f IS NULL)          AS qty_unres,
                  COUNT(*)             FILTER (WHERE tier.f IS NULL)          AS lineas_unres,
                  SUM(sl.importe)      FILTER (WHERE tier.f IS NULL)          AS importe_unres,
                  SUM(sl.importe) AS importe,
                  COUNT(DISTINCT sl.consecutivo) AS tickets
           FROM analytics.v_route_sales_lines sl
           JOIN wincaja.branches b  ON b.tenant_id=sl.tenant_id AND b.source_branch=sl.source_branch AND b.is_route=true
           JOIN wincaja.branches pb ON pb.tenant_id=b.tenant_id AND pb.source_branch=b.parent_branch
           LEFT JOIN commercial.warehouses w ON w.tenant_id=b.tenant_id
                AND w.code=COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
           ${TIER_LATERAL}
           WHERE sl.tenant_id=? AND sl.sale_channel='ruta_venta'
             AND sl.business_date>=? AND sl.business_date<? AND sl.business_date<=CURRENT_DATE
             AND sl.sku=?
           GROUP BY b.source_branch, w.code, w.name, pb.branch_name, sl.cliente
         )
         SELECT route_no, wcode, wname,
           -- Califica por lo RESUELTO. Un cliente al que no se le pudo determinar el peldaño
           -- no se cuenta como que compró ni como que no: se reporta aparte.
           COUNT(*) FILTER (WHERE cliente IS NOT NULL AND btrim(cliente)<>'' AND cliente<>'0001'
                              AND COALESCE(qty_base,0) >= ?) AS clientes,
           COUNT(*) FILTER (WHERE cliente IS NOT NULL AND btrim(cliente)<>'' AND cliente<>'0001'
                              AND COALESCE(qty_base,0) < ? AND COALESCE(qty_unres,0) > 0) AS clientes_indet,
           COALESCE(SUM(qty_base),0)     AS unidades,
           COALESCE(SUM(qty_unres),0)    AS unidades_unres,
           COALESCE(SUM(lineas_unres),0) AS lineas_unres,
           COALESCE(SUM(importe_unres),0) AS importe_unres,
           COALESCE(SUM(tickets),0)      AS tickets,
           COALESCE(SUM(importe),0)      AS monto
         FROM base
         GROUP BY route_no, wcode, wname
         ORDER BY wname, route_no`,
        [product.sku, tenantId, period.from, period.to, product.sku, rule.min_qty, rule.min_qty],
      )).rows;

      // Rótulo y salud de la unidad (una fila, o ninguna si el SKU no está en el maestro del ERP).
      const lad: any = (await trx.raw(
        `SELECT unit_base, is_weight FROM analytics.v_product_unit_ladder WHERE sku = ?`,
        [product.sku],
      )).rows[0];

      const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
      const baseOf = (r: any): number => {
        switch (rule.metric) {
          case 'clientes_distintos': return Number(r.clientes) || 0;
          case 'piezas': return round(Number(r.unidades) || 0, 2);
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
            clientes: Number(r.clientes) || 0,
            clientes_indeterminados: Number(r.clientes_indet) || 0,
            unidades: round(Number(r.unidades) || 0, 2),
            unidades_sin_resolver: round(Number(r.unidades_unres) || 0, 2),
            importe: round(Number(r.monto) || 0, 2),
            base, payout: round(base * rule.rate, 2),
          };
        })
        // Toda ruta con venta del producto (aunque el pago sea $0 por ser todo a público):
        // así se ven las unidades e importe reales; el pago refleja solo los clientes que califican.
        .filter((r) => r.unidades > 0 || r.unidades_sin_resolver > 0 || r.base > 0)
        .sort((a, b) => b.payout - a.payout || b.importe - a.importe);

      // Salud de la unidad, agregada. Se declara SIEMPRE, aunque salga limpia.
      const linUnres = rows.reduce((s, r) => s + (Number(r.lineas_unres) || 0), 0);
      const uniUnres = round(rows.reduce((s, r) => s + (Number(r.unidades_unres) || 0), 0), 2);
      const impUnres = round(rows.reduce((s, r) => s + (Number(r.importe_unres) || 0), 0), 2);
      const impTotal = round(rows.reduce((s, r) => s + (Number(r.monto) || 0), 0), 2);
      const sinEscalera = !lad;
      const isWeight = !!lad?.is_weight;
      // Sólo la cuenta por CANTIDAD depende de la unidad. Clientes/tickets/monto no.
      const dependeDeUnidad = rule.metric === 'piezas' || rule.min_qty > 1;
      const pctUnres = impTotal > 0 ? (impUnres / impTotal) * 100 : 0;
      const unit: PromoUnitInfo = {
        unit_base: lad?.unit_base ?? null,
        is_weight: isWeight,
        sin_escalera: sinEscalera,
        lineas_sin_resolver: linUnres,
        unidades_sin_resolver: uniUnres,
        importe_sin_resolver: impUnres,
        confiable: !dependeDeUnidad || (!sinEscalera && !isWeight && pctUnres < 1),
        nota: sinEscalera
          ? `El SKU ${product.sku} no está en el maestro del ERP: no hay escalera de unidades con qué normalizar la cantidad.`
          : isWeight
            ? `${product.nombre} se vende a GRANEL (${lad.unit_base || 'peso'}): la cuenta por unidades no aplica; usá clientes, tickets o monto.`
            : linUnres > 0
              ? `${linUnres} línea(s) por ${this.money(impUnres)} (${pctUnres.toFixed(2)}% del importe) no se pudieron ubicar en ningún peldaño de precio del ERP: no se sumaron a las unidades.`
              : `Cantidad normalizada a ${lad.unit_base || 'la unidad base del ERP'}: todas las líneas se ubicaron en un peldaño de precio del ERP.`,
      };

      // 3) Detalle: QUÉ clientes participaron (los que califican ≥ min_qty), con piezas + importe.
      //    Nombre resuelto best-effort desde wincaja.clientes (los códigos de ruta no siempre resuelven → código).
      const det: any[] = (await trx.raw(
        `WITH ${LADDER_CTE},
         base AS (
           SELECT b.source_branch AS route_no, COALESCE(w.name, initcap(pb.branch_name)) AS wname, sl.cliente,
                  SUM(sl.qty * tier.f) FILTER (WHERE tier.f IS NOT NULL) AS qty_base,
                  SUM(sl.importe) AS importe
           FROM analytics.v_route_sales_lines sl
           JOIN wincaja.branches b  ON b.tenant_id=sl.tenant_id AND b.source_branch=sl.source_branch AND b.is_route=true
           JOIN wincaja.branches pb ON pb.tenant_id=b.tenant_id AND pb.source_branch=b.parent_branch
           LEFT JOIN commercial.warehouses w ON w.tenant_id=b.tenant_id AND w.code=COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
           ${TIER_LATERAL}
           WHERE sl.tenant_id=? AND sl.sale_channel='ruta_venta'
             AND sl.business_date>=? AND sl.business_date<? AND sl.business_date<=CURRENT_DATE AND sl.sku=?
           GROUP BY b.source_branch, w.name, pb.branch_name, sl.cliente
         )
         SELECT base.route_no, base.wname, base.cliente, base.qty_base, base.importe, cn.nombre
         FROM base
         LEFT JOIN (SELECT DISTINCT ON (cliente) cliente, nombre FROM wincaja.clientes WHERE tenant_id=? ORDER BY cliente, source_dataset DESC) cn
           ON cn.cliente = base.cliente
         WHERE base.cliente IS NOT NULL AND btrim(base.cliente)<>'' AND base.cliente<>'0001'
           AND COALESCE(base.qty_base,0) >= ?
         ORDER BY base.wname, base.route_no, base.importe DESC
         LIMIT 5000`,
        [product.sku, tenantId, period.from, period.to, product.sku, tenantId, rule.min_qty],
      )).rows;
      const clientes_detalle: PromoClientRow[] = det.map((r) => ({
        warehouse_name: r.wname, route_no: String(r.route_no ?? '—'),
        route_label: `${r.wname} · Ruta ${r.route_no ?? ''}`.trim(),
        cliente: String(r.cliente), nombre: r.nombre || String(r.cliente),
        unidades: round(Number(r.qty_base) || 0, 2), importe: round(Number(r.importe) || 0, 2),
      }));

      const total_base = round(out.reduce((s, r) => s + r.base, 0), 2);
      const total_payout = round(out.reduce((s, r) => s + r.payout, 0), 2);
      const total_clientes = out.reduce((s, r) => s + r.clientes, 0);
      const total_clientes_indeterminados = out.reduce((s, r) => s + r.clientes_indeterminados, 0);
      const total_unidades = round(out.reduce((s, r) => s + r.unidades, 0), 2);
      const total_importe = round(out.reduce((s, r) => s + r.importe, 0), 2);

      // La unidad se nombra en la etiqueta: "≥3 PAQ" dice algo, "≥3 pza" mentía.
      const uLbl = unit.unit_base || 'u';
      return {
        enunciado, rule, product, period,
        metric_label: rule.metric === 'piezas' ? `Unidades (${uLbl})` : METRIC_LABEL[rule.metric],
        base_label: rule.metric === 'clientes_distintos'
          ? `Clientes (≥${rule.min_qty} ${uLbl})`
          : rule.metric === 'piezas' ? `Unidades (${uLbl})` : METRIC_LABEL[rule.metric],
        unit,
        rows: out, clientes_detalle,
        total_base, total_payout, total_clientes, total_clientes_indeterminados,
        total_unidades, total_importe,
        note: out.length
          ? `${out.length} ruta(s) con actividad · $${rule.rate.toFixed(2)} × ${(rule.metric === 'piezas' ? `unidades (${uLbl})` : METRIC_LABEL[rule.metric].toLowerCase())}.`
          : 'Sin ventas del producto en ruta para el periodo.',
        generated_at: new Date().toISOString(),
      };
    });
  }
}
