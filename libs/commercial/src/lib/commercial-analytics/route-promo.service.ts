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
  /** Qué mercancía cuenta: un SKU suelto o TODA una marca/proveedor (ej "Vidis" = 160 SKUs). */
  alcance?: 'sku' | 'marca';
  marca_texto?: string | null;
  sku: string | null;
  producto_texto: string | null;
  /** Canales cuyos vendedores participan. Vacío = todos los de venta con vendedor. */
  canales?: PromoCanal[];
  metric: PromoMetric;
  rate: number;
  min_qty: number;
  /**
   * Umbral en PESOS por cliente para calificar (ej "al que se le venda $500"). 0 = sin
   * umbral de dinero. Es acumulado del cliente con ESE vendedor en todo el periodo.
   */
  min_importe?: number;
  descripcion: string;
  supuestos: string;
  // Vigencia detectada por el AI en el enunciado (auto-inteligente). null si el enunciado no la menciona.
  date_from?: string | null;   // YYYY-MM-DD (inclusive)
  date_to?: string | null;     // YYYY-MM-DD (inclusive)
  periodo_texto?: string | null;
}

export interface PromoRouteRow {
  /** Canal del que salió la fila: en RD el vendedor es la ruta; en los demás, el código del POS. */
  canal: PromoCanal;
  vendedor: string;
  /** Nombre de la persona, resuelto por (sucursal, código). null si el ERP no lo tiene. */
  vendedor_nombre: string | null;
  /** La sucursal es parte de la IDENTIDAD del vendedor, no un adorno: el código se repite. */
  source_branch: string;
  sucursal_nombre: string | null;
  warehouse_code: string;
  warehouse_name: string;
  /** @deprecated alias de `vendedor`, se conserva para no romper consumidores. */
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

/** Qué se le vendió a un cliente, por producto, con su unidad declarada. */
export interface PromoClientItem {
  sku: string;
  nombre: string;
  /** Cantidad en la unidad BASE del SKU (peldaño resuelto por precio). */
  unidades: number;
  /** Rótulo real de esa unidad (PZA/PAQ/CJA…). null si el ERP no la declara. */
  unidad: string | null;
  /** Cantidad cuyo peldaño no se pudo identificar: se muestra aparte, no se suma. */
  unidades_sin_resolver: number;
  importe: number;
}

/** Detalle de un cliente que participó (para "cuáles fueron y qué se les vendió"). */
export interface PromoClientRow {
  canal: PromoCanal;
  vendedor: string;
  warehouse_name: string;
  route_no: string;
  route_label: string;
  cliente: string;
  nombre: string;
  /**
   * El código de cliente se repite entre sucursales (la PK de `wincaja.clientes` es
   * (tenant, sucursal, dataset, cliente)). Cuando el mismo código existe en más de una,
   * el nombre mostrado puede ser el de OTRO cliente: se marca en vez de afirmarlo.
   */
  nombre_ambiguo: boolean;
  unidades: number;
  importe: number;
  tickets: number;
  /** Si llegó al umbral (cantidad y/o dinero) y por lo tanto genera bono. */
  califica: boolean;
  /** Qué se le vendió. Vacío si no se pidió el desglose. */
  items: PromoClientItem[];
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
  /**
   * ¿Se puede SUMAR la cantidad entre productos? Con alcance de marca casi nunca: Vidis
   * mezcla globos en PAQ con velas en PZA, y un total de "1,198" no significa nada.
   * Cuando es false, la cantidad agregada NO se publica — el detalle por producto sí,
   * porque ahí cada renglón lleva su unidad.
   */
  unidades_sumables: boolean;
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
  /**
   * Traer el desglose cliente×producto. Es la mitad del costo de la corrida (medido en
   * prod: 6.2 s el agregado, 8.8 s el desglose con 185 clientes), así que la pantalla
   * pide primero el pago y el desglose sólo cuando se abre. Los exportables lo piden
   * siempre, porque el documento tiene que llevarlo.
   */
  detalle?: boolean;
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
/**
 * JOIN que resuelve el peldaño de cada línea contra la escalera del SKU. Sirve igual para
 * un SKU que para los 160 de una marca: la escalera se une por `sl.sku`, no por parámetro.
 * Espera un alias `sl` con `sku`, `qty` e `importe`.
 */
const TIER_JOIN = `
      LEFT JOIN analytics.v_product_unit_ladder lad ON lad.sku = sl.sku
      LEFT JOIN LATERAL (
        SELECT t.f
        FROM (VALUES (1::numeric, lad.p1), (COALESCE(lad.f2, 1), lad.p2), (COALESCE(lad.f3, 1), lad.p3)) AS t(f, p)
        WHERE t.p > 0 AND sl.qty <> 0 AND (sl.importe / sl.qty) > 0
          AND abs(ln((sl.importe / sl.qty) / t.p)) < ln(2)
        ORDER BY abs(ln((sl.importe / sl.qty) / t.p))
        LIMIT 1
      ) tier ON true`;

/**
 * ── ALCANCE Y CANALES (RR-PROMO.2) ──────────────────────────────────────────────────────
 * Una mecánica real no siempre habla de un SKU. La que originó esto:
 *
 *     Proveedor: vidis · del 01/06/2026 al 31/08/2026
 *     Participan: vendedores de RD, vendedores de ruta vecinal y vendedores de mayoreo
 *     Dinámica: bono de $50 por cliente distinto al que se le venda $500 de Vidis
 *
 * Trae tres cosas que el motor de un solo SKU no podía: alcance por MARCA (Vidis son 160
 * SKUs), TRES canales con el vendedor como dimensión de pago, y un umbral en DINERO por
 * cliente ($500) en vez de en cantidad.
 *
 * El umbral de dinero es, además, el único inmune a la unidad de medida: $500 son $500
 * vengan en pieza, paquete o caja. Por eso `min_importe` no arrastra la incertidumbre de
 * `min_qty` — y cuando la mecánica se puede expresar en dinero, es la forma más segura.
 */
export const PROMO_CANALES = ['ruta', 'vecinal', 'mayoreo', 'mostrador'] as const;
export type PromoCanal = (typeof PROMO_CANALES)[number];

const CANAL_LABEL: Record<PromoCanal, string> = {
  ruta: 'RD / reparto',
  vecinal: 'Ruta vecinal',
  mayoreo: 'Mayoreo',
  mostrador: 'Mostrador',
};

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
          canal: { type: 'string', enum: ['ruta', 'todos'], description: 'RD / reparto / ruta / venta a bordo → "ruta". Si no se menciona canal → "todos". (Heredado: para varios canales usá "canales".)' },
          canales: {
            type: 'array', items: { type: 'string', enum: ['ruta', 'vecinal', 'mayoreo', 'mostrador'] },
            description: 'Canales cuyos VENDEDORES participan, del renglón "Participan:". Mapeo: "RD"/"reparto"/"venta a bordo"/"ruta" → "ruta"; "ruta vecinal"/"vecinal"/"preventa" → "vecinal"; "mayoreo"/"crédito" → "mayoreo"; "mostrador"/"piso"/"tienda" → "mostrador". Ej "vendedores de RD, de ruta vecinal y de mayoreo" → ["ruta","vecinal","mayoreo"]. Si el enunciado no dice quién participa, dejá el arreglo vacío.',
          },
          alcance: { type: 'string', enum: ['sku', 'marca'], description: '"sku" si la promo es de UN producto concreto. "marca" si aplica a TODA la mercancía de un proveedor/marca/línea (ej "Proveedor: vidis", "mercancía de Vidis", "productos Ricolino") — en ese caso llená marca_texto y dejá sku/producto_texto en null.' },
          marca_texto: { type: ['string', 'null'], description: 'Nombre de la marca o proveedor tal como se menciona (ej "vidis"). Sólo cuando alcance="marca"; si no, null.' },
          sku: { type: ['string', 'null'], description: 'Código del producto si aparece (ej "cód:97192", "clave 97192" → "97192"). Si no hay código → null.' },
          producto_texto: { type: ['string', 'null'], description: 'Nombre del producto como se menciona (ej "choyitas 14 gr/40"), para resolverlo por catálogo si no hay código. null si no aplica.' },
          metric: { type: 'string', enum: ['clientes_distintos', 'piezas', 'tickets', 'monto'], description: '"clientes_distintos" si el pago es por CLIENTE/cuenta distinta que compró el producto (aunque compre varias piezas, cuenta una vez). "piezas" si es por cada pieza/unidad. "tickets" por ticket/venta. "monto" si es $/% sobre el importe vendido.' },
          rate: { type: 'number', description: 'Monto en pesos por cada unidad de la métrica (ej $6.00 → 6).' },
          min_qty: { type: 'number', description: 'Cantidad mínima por cliente para calificar (ej "una o más piezas" → 1). Default 1. Si el umbral está en DINERO, dejá 1 acá y usá min_importe.' },
          min_importe: { type: 'number', description: 'Umbral en PESOS por cliente para calificar, cuando la mecánica lo pide en dinero (ej "al que se le venda $500 de mercancía" → 500). 0 si el enunciado no pone un umbral de dinero. Es acumulado del cliente en todo el periodo.' },
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
      'Traduces mecánicas de incentivo a vendedores (RD = reparto = venta a bordo; también ruta vecinal, ' +
      'mayoreo y mostrador) a parámetros estructurados. "clientes distintos a los que se les vendió una o ' +
      'más piezas" = métrica clientes_distintos con min_qty=1 (cada cliente cuenta UNA vez sin importar ' +
      'cuántas piezas compre). "bono de $X por cliente distinto al que se le venda $Y de mercancía de M" = ' +
      'metric clientes_distintos, rate=X, min_importe=Y, alcance="marca", marca_texto=M. Un renglón ' +
      '"Proveedor: M" o "mercancía de M" es alcance="marca", NO un SKU. El renglón "Participan:" define ' +
      '"canales". No inventes datos: si el enunciado no lo dice, usa los defaults y anótalo en supuestos. ' +
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
    const canales = Array.isArray(r.canales)
      ? (r.canales as any[]).map((x) => String(x).trim()).filter((x): x is PromoCanal => (PROMO_CANALES as readonly string[]).includes(x))
      : [];
    const alcance: 'sku' | 'marca' = r.alcance === 'marca' || (!r.sku && !r.producto_texto && r.marca_texto) ? 'marca' : 'sku';
    return {
      canal: r.canal === 'todos' ? 'todos' : 'ruta',
      alcance,
      marca_texto: r.marca_texto ? String(r.marca_texto).trim() : null,
      canales: [...new Set(canales)],
      min_importe: Number(r.min_importe) > 0 ? Number(r.min_importe) : 0,
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

  /** Resultado vacío tipado, para las salidas tempranas (sin producto, sin alcance…). */
  private emptyResult(enunciado: string, rule: PromoRule, period: { from: string; to: string; label: string }): PromoResult {
    return {
      enunciado, rule, product: null, period,
      metric_label: METRIC_LABEL[rule.metric], base_label: METRIC_LABEL[rule.metric],
      unit: {
        unit_base: null, is_weight: false, sin_escalera: true,
        lineas_sin_resolver: 0, unidades_sin_resolver: 0, importe_sin_resolver: 0,
        confiable: false, unidades_sumables: false,
        nota: 'Sin alcance resuelto no hay unidad que declarar.',
      },
      rows: [], clientes_detalle: [], total_base: 0, total_payout: 0,
      total_clientes: 0, total_clientes_indeterminados: 0, total_unidades: 0, total_importe: 0,
      note: '', generated_at: new Date().toISOString(),
    };
  }
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
        // la MISMA normalización de unidad que evaluate() (TIER_JOIN): si las dos rutas de
        // código dieran cantidades distintas para la misma promo, no serviría ninguna.
        rows = (await trx.raw(
          `WITH base AS (
             SELECT b.source_branch AS dim0, COALESCE(w.name, initcap(pb.branch_name)) AS wname, sl.cliente,
                    SUM(sl.qty * tier.f) FILTER (WHERE tier.f IS NOT NULL) AS qty_base,
                    SUM(sl.importe) AS importe, COUNT(DISTINCT sl.consecutivo) AS tickets
             FROM analytics.v_route_sales_lines sl
             JOIN wincaja.branches b  ON b.tenant_id=sl.tenant_id AND b.source_branch=sl.source_branch AND b.is_route=true
             JOIN wincaja.branches pb ON pb.tenant_id=b.tenant_id AND pb.source_branch=b.parent_branch
             LEFT JOIN commercial.warehouses w ON w.tenant_id=b.tenant_id AND w.code=COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
             ${TIER_JOIN}
             WHERE sl.tenant_id=? AND sl.sale_channel='ruta_venta' AND sl.business_date>=? AND sl.business_date<? AND sl.business_date<=CURRENT_DATE AND sl.sku=?
             GROUP BY b.source_branch, w.name, pb.branch_name, sl.cliente
           )
           SELECT (wname||' · Ruta '||dim0) AS dim,
             COUNT(*) FILTER (WHERE cliente IS NOT NULL AND btrim(cliente)<>'' AND cliente<>'0001' AND COALESCE(qty_base,0) >= ?) AS clientes,
             COALESCE(SUM(qty_base),0) AS piezas, COALESCE(SUM(tickets),0) AS tickets, COALESCE(SUM(importe),0) AS monto
           FROM base GROUP BY wname, dim0 ORDER BY dim`,
          [tenantId, period.from, period.to, product.sku, minQty],
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
          alcance: q.rule.alcance === 'marca' ? 'marca' : 'sku',
          marca_texto: q.rule.marca_texto ?? null,
          canales: Array.isArray(q.rule.canales)
            ? q.rule.canales.filter((x): x is PromoCanal => (PROMO_CANALES as readonly string[]).includes(x))
            : [],
          min_importe: Number(q.rule.min_importe) > 0 ? Number(q.rule.min_importe) : 0,
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
      // Una promo de marca × 3 canales × 3 meses es cara (medido en prod: ~8 s el desglose
      // con 185 clientes). Con tope explícito falla claro en vez de dejar la pantalla colgada.
      await trx.raw(`SET LOCAL statement_timeout = '60s'`);

      // 1) Resolver el ALCANCE → conjunto de SKUs que cuentan.
      //    Puede ser un producto suelto o toda una marca/proveedor ("Proveedor: vidis").
      let product: { sku: string; nombre: string } | null = null;
      let candidates: { sku: string; nombre: string }[] | undefined;
      let skus: string[] = [];
      let brand: { id: string; nombre: string } | null = null;

      if (rule.alcance === 'marca' && rule.marca_texto) {
        const b = await trx('catalog.brands')
          .where('tenant_id', tenantId).whereNull('deleted_at')
          .andWhereRaw('unaccent(nombre) ILIKE unaccent(?)', [rule.marca_texto])
          .select('id', 'nombre').first()
          // Sin match exacto, se intenta por contención — pero sólo si es UNA.
          ?? (await trx('catalog.brands')
            .where('tenant_id', tenantId).whereNull('deleted_at')
            .andWhereRaw('unaccent(nombre) ILIKE unaccent(?)', [`%${rule.marca_texto}%`])
            .select('id', 'nombre').limit(2))[0];
        if (b) {
          brand = { id: b.id, nombre: b.nombre };
          const rows = await trx('catalog.products')
            .where({ tenant_id: tenantId, brand_id: b.id }).whereNull('deleted_at').pluck('sku');
          skus = rows.map((s: string) => String(s).trim()).filter(Boolean);
          // El "producto" pasa a ser la marca: es lo que se muestra como alcance.
          product = { sku: `marca:${b.nombre}`, nombre: `${b.nombre} · ${skus.length} SKU(s)` };
        }
      } else if (rule.sku) {
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
      // Alcance de un solo producto → la lista de SKUs es ese SKU.
      if (!skus.length && product) skus = [product.sku];

      // Una marca sin productos no es "cero ventas": es un alcance vacío. Se dice.
      if (brand && !skus.length) {
        return {
          ...this.emptyResult(enunciado, rule, period),
          product,
          note: `La marca "${brand.nombre}" no tiene productos activos en el catálogo: no hay mercancía que contar.`,
        };
      }

      if (!product) {
        return {
          enunciado, rule, product: null, candidates,
          period, metric_label: METRIC_LABEL[rule.metric], base_label: METRIC_LABEL[rule.metric],
          unit: {
            unit_base: null, is_weight: false, sin_escalera: true,
            lineas_sin_resolver: 0, unidades_sin_resolver: 0, importe_sin_resolver: 0,
            confiable: false, unidades_sumables: false,
            nota: 'Sin producto resuelto no hay unidad que declarar.',
          },
          rows: [], clientes_detalle: [], total_base: 0, total_payout: 0,
          total_clientes: 0, total_clientes_indeterminados: 0, total_unidades: 0, total_importe: 0,
          note: candidates?.length
            ? 'El producto es ambiguo — elegí el SKU correcto y recalculá.'
            : rule.alcance === 'marca'
              ? `No se encontró la marca/proveedor "${rule.marca_texto || ''}" en el catálogo. Verificá el nombre.`
              : 'No se encontró el producto del enunciado (SKU o nombre). Verificá el código.',
          generated_at: new Date().toISOString(),
        };
      }

      // 2) Motor determinista: base por (canal, vendedor, cliente) → agregado por vendedor.
      //    · `qty` se normaliza a la unidad BASE resolviendo el peldaño por precio (TIER_JOIN).
      //    · El universo es `analytics.v_seller_sales_lines`: los 4 canales con el vendedor ya
      //      resuelto y sin doble conteo (en RD la ruta ES el vendedor; el vecinal no se
      //      cuenta dos veces). El filtro de canales sale de la mecánica.
      //    · Un cliente califica por lo acumulado CON ESE VENDEDOR en todo el periodo, en
      //      cantidad (min_qty) y/o en dinero (min_importe). El de dinero es inmune a la
      //      unidad de medida: $500 son $500 vengan en pieza, paquete o caja.
      const canales: PromoCanal[] = rule.canales?.length
        ? rule.canales
        : (rule.canal === 'ruta' ? ['ruta'] : [...PROMO_CANALES]);
      const minImporte = Number(rule.min_importe) > 0 ? Number(rule.min_importe) : 0;

      const rows: any[] = (await trx.raw(
        `WITH base AS (
           -- La identidad del vendedor es (sucursal, código): el código solo se repite
           -- entre sucursales y son PERSONAS distintas (33 en la 30 y en la 50). Agrupar
           -- por código a secas las fusionaba y juntaba sus clientes para el umbral.
           SELECT sl.canal, sl.source_branch, sl.vendedor, sl.cliente,
                  SUM(sl.qty * tier.f) FILTER (WHERE tier.f IS NOT NULL)      AS qty_base,
                  SUM(sl.qty)          FILTER (WHERE tier.f IS NULL)          AS qty_unres,
                  COUNT(*)             FILTER (WHERE tier.f IS NULL)          AS lineas_unres,
                  SUM(sl.importe)      FILTER (WHERE tier.f IS NULL)          AS importe_unres,
                  SUM(sl.importe) AS importe,
                  COUNT(DISTINCT sl.consecutivo) AS tickets
           FROM analytics.v_seller_sales_lines sl
           ${TIER_JOIN}
           WHERE sl.tenant_id=?
             AND sl.business_date>=? AND sl.business_date<? AND sl.business_date<=CURRENT_DATE
             AND sl.sku = ANY(?) AND sl.canal = ANY(?)
           GROUP BY sl.canal, sl.source_branch, sl.vendedor, sl.cliente
         ),
         agg AS (
         SELECT canal, source_branch, vendedor,
           -- Califica por lo RESUELTO, en cantidad Y en dinero. Un cliente al que no se le
           -- pudo determinar el peldaño no se cuenta como que compró ni como que no: aparte.
           COUNT(*) FILTER (WHERE cliente IS NOT NULL AND btrim(cliente)<>'' AND cliente<>'0001'
                              AND COALESCE(qty_base,0) >= ? AND COALESCE(importe,0) >= ?) AS clientes,
           COUNT(*) FILTER (WHERE cliente IS NOT NULL AND btrim(cliente)<>'' AND cliente<>'0001'
                              AND COALESCE(importe,0) >= ?
                              AND COALESCE(qty_base,0) < ? AND COALESCE(qty_unres,0) > 0) AS clientes_indet,
           COALESCE(SUM(qty_base),0)     AS unidades,
           COALESCE(SUM(qty_unres),0)    AS unidades_unres,
           COALESCE(SUM(lineas_unres),0) AS lineas_unres,
           COALESCE(SUM(importe_unres),0) AS importe_unres,
           COALESCE(SUM(tickets),0)      AS tickets,
           COALESCE(SUM(importe),0)      AS monto
         FROM base
         GROUP BY canal, source_branch, vendedor
         ),
         -- Nombre real del vendedor. Dentro de UNA sucursal el código sí es único
         -- (verificado), así que el par resuelve a una persona sin ambigüedad.
         vend AS (
           SELECT DISTINCT ON (source_branch, btrim(vendedor))
                  source_branch, btrim(vendedor) AS vendedor, nombre
           FROM wincaja.vendedores WHERE tenant_id=? AND nombre IS NOT NULL
           ORDER BY source_branch, btrim(vendedor), source_dataset DESC
         )
         -- El nombre de la sucursal sólo aplica al canal ruta, donde el vendedor ES la ruta.
         SELECT agg.*, w.code AS wcode, COALESCE(w.name, initcap(pb.branch_name)) AS wname,
                vn.nombre AS vendedor_nombre,
                COALESCE(sb.branch_name, agg.source_branch) AS sucursal_nombre
         FROM agg
         LEFT JOIN vend vn ON vn.source_branch=agg.source_branch AND vn.vendedor=btrim(agg.vendedor)
         LEFT JOIN wincaja.branches sb ON sb.tenant_id=? AND sb.source_branch=agg.source_branch
         LEFT JOIN wincaja.branches b  ON agg.canal='ruta' AND b.tenant_id=?
              AND b.source_branch=agg.vendedor AND b.is_route=true
         LEFT JOIN wincaja.branches pb ON pb.tenant_id=b.tenant_id AND pb.source_branch=b.parent_branch
         LEFT JOIN commercial.warehouses w ON w.tenant_id=b.tenant_id
              AND w.code=COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
         ORDER BY agg.canal, wname NULLS LAST, agg.vendedor`,
        [tenantId, period.from, period.to, skus, canales, rule.min_qty, minImporte, minImporte, rule.min_qty,
          tenantId, tenantId, tenantId],
      )).rows;

      // Rótulo y salud de la unidad. Con alcance de MARCA hay muchos SKUs: la unidad base sólo
      // se puede nombrar si TODOS coinciden; si no, se declara mixta en vez de elegir una.
      const lads: any[] = (await trx.raw(
        `SELECT DISTINCT unit_base, is_weight FROM analytics.v_product_unit_ladder WHERE sku = ANY(?)`,
        [skus],
      )).rows;
      const unitBases = [...new Set(lads.map((l) => l.unit_base).filter(Boolean))];
      const lad = lads.length
        ? { unit_base: unitBases.length === 1 ? unitBases[0] : null, is_weight: lads.some((l) => l.is_weight) }
        : null;
      const unidadMixta = unitBases.length > 1;

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
          // En ruta el vendedor ES la ruta y se nombra con su sucursal. En los demás canales
          // se nombra a la PERSONA (resuelta por sucursal+código) y se dice de qué sucursal
          // es, porque el mismo código en otra sucursal es alguien más.
          const label = r.canal === 'ruta'
            ? `${r.wname ? r.wname + ' · ' : ''}Ruta ${r.vendedor}`
            : `${CANAL_LABEL[r.canal as PromoCanal] || r.canal} · ${r.vendedor_nombre || `Vendedor ${r.vendedor}`}`
              + `${r.sucursal_nombre ? ` (${r.sucursal_nombre})` : ''}`;
          return {
            canal: r.canal, vendedor: String(r.vendedor ?? '—'),
            vendedor_nombre: r.vendedor_nombre || null,
            source_branch: String(r.source_branch ?? ''),
            sucursal_nombre: r.sucursal_nombre || null,
            warehouse_code: r.wcode, warehouse_name: r.wname, route_no: String(r.vendedor ?? '—'),
            label,
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
      // Sólo la cuenta por CANTIDAD depende de la unidad. Clientes/tickets/monto no — y un
      // umbral en DINERO tampoco: $500 son $500 vengan en pieza, paquete o caja.
      const dependeDeUnidad = rule.metric === 'piezas' || rule.min_qty > 1;
      const pctUnres = impTotal > 0 ? (impUnres / impTotal) * 100 : 0;
      const unit: PromoUnitInfo = {
        unit_base: lad?.unit_base ?? null,
        is_weight: isWeight,
        sin_escalera: sinEscalera,
        lineas_sin_resolver: linUnres,
        unidades_sin_resolver: uniUnres,
        importe_sin_resolver: impUnres,
        confiable: !dependeDeUnidad || (!sinEscalera && !isWeight && !unidadMixta && pctUnres < 1),
        // Sumar cantidades sólo tiene sentido si TODO el alcance está en la misma unidad.
        // Con marca casi nunca: Vidis mezcla globos en PAQ con velas en PZA, y el total de
        // "1,198" que se publicaba no significaba nada. El detalle por producto sí se muestra,
        // porque ahí cada renglón lleva su unidad.
        unidades_sumables: !sinEscalera && !isWeight && !unidadMixta,
        nota: !dependeDeUnidad
          ? (minImporte > 0
            ? `El umbral es en dinero (${this.money(minImporte)} por cliente), así que no depende de la unidad de medida.`
            : 'La mecánica cuenta clientes/tickets/monto: no depende de la unidad de medida.')
          : sinEscalera
            ? `El alcance no está en el maestro del ERP: no hay escalera de unidades con qué normalizar la cantidad.`
            : isWeight
              ? `El alcance incluye mercancía a GRANEL: la cuenta por unidades no aplica; usá clientes, tickets o monto.`
              : unidadMixta
                ? `El alcance mezcla ${unitBases.length} unidades base distintas (${unitBases.join(', ')}): sumar cantidades entre ellas no significa nada. Usá clientes, tickets o un umbral en dinero.`
                : linUnres > 0
                  ? `${linUnres} línea(s) por ${this.money(impUnres)} (${pctUnres.toFixed(2)}% del importe) no se pudieron ubicar en ningún peldaño de precio del ERP: no se sumaron a las unidades.`
                  : `Cantidad normalizada a ${lad.unit_base || 'la unidad base del ERP'}: todas las líneas se ubicaron en un peldaño de precio del ERP.`,
      };

      // 3) Detalle: QUÉ clientes participaron (los que califican ≥ min_qty), con piezas + importe.
      //    Nombre resuelto best-effort desde wincaja.clientes (los códigos de ruta no siempre resuelven → código).
      //    El desglose baja UN nivel más: (vendedor, cliente, SKU) con la unidad de cada
      //    producto. Se trae a TODOS los clientes con venta —no sólo a los que califican—
      //    porque un desglose que sólo muestra a los que cobran no deja auditar por qué el
      //    resto no; los que no llegaron vienen marcados `califica=false`.
      //
      //    El NOMBRE se resuelve con las dos fuentes: `wincaja.clientes` cubre el POS y
      //    `analytics.erp_customers` cubre a los clientes de las rutas del push, que no
      //    existen en Wincaja (medido: resuelve 400 de los 2,812 códigos de ruta, justo los
      //    que salían en blanco). Y se marca `nombre_ambiguo` cuando el código vive en más
      //    de una sucursal, porque ahí el nombre puede ser el de otro cliente.
      // Lazy: sólo si lo piden. Es la mitad del tiempo de la corrida y en la pantalla el
      // primer número que importa es el pago, no la lista de 185 clientes.
      const det: any[] = !q.detalle ? [] : (await trx.raw(
        `WITH lines AS (
           SELECT sl.canal, sl.vendedor, sl.cliente, sl.sku, sl.consecutivo,
                  sl.qty * tier.f AS qty_base,
                  CASE WHEN tier.f IS NULL THEN sl.qty END AS qty_unres,
                  sl.importe
           FROM analytics.v_seller_sales_lines sl
           ${TIER_JOIN}
           WHERE sl.tenant_id=?
             AND sl.business_date>=? AND sl.business_date<? AND sl.business_date<=CURRENT_DATE
             AND sl.sku = ANY(?) AND sl.canal = ANY(?)
             AND sl.cliente IS NOT NULL AND btrim(sl.cliente)<>'' AND sl.cliente<>'0001'
         ),
         por_cliente AS (
           SELECT canal, vendedor, cliente,
                  COALESCE(SUM(qty_base),0) AS qty_base, SUM(importe) AS importe,
                  COUNT(DISTINCT consecutivo) AS tickets
           FROM lines GROUP BY 1,2,3
         ),
         por_item AS (
           SELECT canal, vendedor, cliente, sku,
                  COALESCE(SUM(qty_base),0) AS qty_base,
                  COALESCE(SUM(qty_unres),0) AS qty_unres,
                  SUM(importe) AS importe
           FROM lines GROUP BY 1,2,3,4
         ),
         nombres AS (
           SELECT btrim(cliente) AS cliente,
                  MIN(nombre) AS nombre,
                  COUNT(DISTINCT source_branch) > 1 AS ambiguo
           FROM wincaja.clientes WHERE tenant_id=? AND nombre IS NOT NULL
           GROUP BY 1
         ),
         -- Los items se agregan UNA vez y se pegan por JOIN. Como subconsulta correlacionada
         -- re-escaneaba por_item por cada cliente y la query tardaba 37 s (medido; ahora 8 s).
         -- (sin backticks: este comentario vive dentro de un template literal de JS)
         items AS (
           SELECT pi.canal, pi.vendedor, pi.cliente,
                  json_agg(json_build_object(
                    'sku', pi.sku, 'nombre', COALESCE(p.nombre, pi.sku),
                    'unidades', round(pi.qty_base, 2),
                    'unidad', lad.unit_base,
                    'unidades_sin_resolver', round(pi.qty_unres, 2),
                    'importe', round(pi.importe, 2))
                  ORDER BY pi.importe DESC) AS items
           FROM por_item pi
           LEFT JOIN catalog.products p ON p.tenant_id=? AND btrim(p.sku)=btrim(pi.sku) AND p.deleted_at IS NULL
           LEFT JOIN analytics.v_product_unit_ladder lad ON lad.sku = pi.sku
           GROUP BY 1,2,3
         )
         SELECT pc.canal, pc.vendedor, pc.cliente, pc.qty_base, pc.importe, pc.tickets,
                COALESCE(nm.nombre, ec.name) AS nombre,
                COALESCE(nm.ambiguo, false) AS nombre_ambiguo,
                COALESCE(w.name, initcap(pb.branch_name)) AS wname,
                (COALESCE(pc.qty_base,0) >= ? AND COALESCE(pc.importe,0) >= ?) AS califica,
                COALESCE(it.items, '[]'::json) AS items
         FROM por_cliente pc
         LEFT JOIN items it ON it.canal=pc.canal AND it.vendedor=pc.vendedor AND it.cliente=pc.cliente
         LEFT JOIN nombres nm ON nm.cliente = btrim(pc.cliente)
         LEFT JOIN analytics.erp_customers ec ON ec.tenant_id=? AND btrim(ec.erp_code)=btrim(pc.cliente)
         LEFT JOIN wincaja.branches b  ON pc.canal='ruta' AND b.tenant_id=?
              AND b.source_branch=pc.vendedor AND b.is_route=true
         LEFT JOIN wincaja.branches pb ON pb.tenant_id=b.tenant_id AND pb.source_branch=b.parent_branch
         LEFT JOIN commercial.warehouses w ON w.tenant_id=b.tenant_id
              AND w.code=COALESCE(pb.kepler_code, pb.warehouse_code) AND w.deleted_at IS NULL
         ORDER BY califica DESC, pc.importe DESC
         LIMIT 5000`,
        [tenantId, period.from, period.to, skus, canales, tenantId, tenantId,
          rule.min_qty, minImporte, tenantId, tenantId],
      )).rows;
      const clientes_detalle: PromoClientRow[] = det.map((r) => ({
        canal: r.canal, vendedor: String(r.vendedor ?? '—'),
        warehouse_name: r.wname, route_no: String(r.vendedor ?? '—'),
        route_label: r.canal === 'ruta'
          ? `${r.wname ? r.wname + ' · ' : ''}Ruta ${r.vendedor}`
          : `${CANAL_LABEL[r.canal as PromoCanal] || r.canal} · Vendedor ${r.vendedor}`,
        cliente: String(r.cliente), nombre: r.nombre || String(r.cliente),
        nombre_ambiguo: !!r.nombre_ambiguo && !!r.nombre,
        unidades: round(Number(r.qty_base) || 0, 2), importe: round(Number(r.importe) || 0, 2),
        tickets: Number(r.tickets) || 0,
        califica: !!r.califica,
        items: (r.items || []).map((i: any) => ({
          sku: String(i.sku), nombre: String(i.nombre),
          unidades: Number(i.unidades) || 0,
          unidad: i.unidad ?? null,
          unidades_sin_resolver: Number(i.unidades_sin_resolver) || 0,
          importe: Number(i.importe) || 0,
        })),
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
        // La etiqueta dice el umbral REAL con el que se calificó — en dinero si lo hay.
        base_label: rule.metric === 'clientes_distintos'
          ? (minImporte > 0
            ? `Clientes (≥${this.money(minImporte)})`
            : `Clientes (≥${rule.min_qty} ${uLbl})`)
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
