import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * MAAT.3 — Tool registry del chat de Maat (ADR-028, patrón Thot Chat/ADR-026).
 *
 * Cada tool envuelve una query DETERMINISTA tenant-scoped (TenantKnexService →
 * RLS/filtro explícito). El LLM nunca toca SQL ni calcula: orquesta estas tools
 * y narra. Namespacing `maat_*`. Ante error devuelve `{ error }` accionable
 * (self-correction), nunca lanza.
 *
 * Fuentes (todo ya existente — MAAT.1 sumará balanza y cadena):
 *   analytics.expense_entries        pólizas de egreso (511 + 6xx/7xx)
 *   analytics.expense_documents      cabecera del documento (proveedor/RFC/IVA)
 *   analytics.expense_document_lines líneas de producto de compras
 *   analytics.ap_provider            auxiliar 201 (compra/pagos/saldo/DPO)
 *   analytics.expense_findings       hallazgos v1 (iva_bug/prov_203/anticipo_107)
 *   finance.knowledge                base de conocimiento curada (L0)
 */

export interface MaatToolDef {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export interface MaatScope {
  userName?: string | null;
}

/** Dimensiones permitidas de maat_egresos (whitelist anti-injection). */
const EGRESO_DIMS: Record<string, { group: string; key: string; label: string }> = {
  cuenta: { group: 'e.cuenta, e.cuenta_nombre', key: 'e.cuenta', label: 'COALESCE(e.cuenta_nombre, e.cuenta)' },
  cuenta_mayor: { group: 'e.cuenta_mayor, e.cuenta_mayor_nombre', key: "COALESCE(e.cuenta_mayor,'-')", label: 'COALESCE(e.cuenta_mayor_nombre, e.cuenta_mayor)' },
  beneficiario: { group: 'e.beneficiario', key: "COALESCE(e.beneficiario,'(sin beneficiario)')", label: "COALESCE(e.beneficiario,'(sin beneficiario)')" },
  sucursal: { group: 'e.sucursal', key: 'e.sucursal', label: 'e.sucursal' },
  area: { group: 'e.area', key: "COALESCE(e.area,'(sin área)')", label: "COALESCE(e.area,'(sin área)')" },
  doc_tipo: { group: 'e.doc_tipo', key: 'e.doc_tipo', label: 'e.doc_tipo' },
  mes: { group: "to_char(e.fecha,'YYYY-MM')", key: "to_char(e.fecha,'YYYY-MM')", label: "to_char(e.fecha,'YYYY-MM')" },
};

const num = (v: any) => (v == null ? null : Number(v));

@Injectable()
export class MaatToolsService {
  private readonly logger = new Logger(MaatToolsService.name);

  constructor(private readonly tk: TenantKnexService) {}

  // ── System prompt: identidad + reglas duras + TODO el conocimiento activo ──
  async buildSystemPrompt(scope: MaatScope, ctx: { today: string }): Promise<string> {
    const knowledge = await this.tk.run(async (trx) =>
      trx('finance.knowledge')
        .where('status', 'active')
        .select('kind', 'title', 'body')
        .orderBy(['kind', 'title']),
    ).catch(() => [] as { kind: string; title: string; body: string }[]);

    const KIND_LABEL: Record<string, string> = {
      definicion: 'DEFINICIONES (el modelo contable Kepler)',
      hecho: 'HECHOS VERIFICADOS (cifras ancla)',
      regla_negocio: 'REGLAS DE NEGOCIO (cómo leer los números sin equivocarse)',
      issue_conocido: 'ISSUES CONOCIDOS (bugs de captura ya diagnosticados — no re-descubrir)',
    };
    const byKind = new Map<string, string[]>();
    for (const k of knowledge) {
      if (!byKind.has(k.kind)) byKind.set(k.kind, []);
      byKind.get(k.kind)!.push(`• ${k.title}: ${k.body}`);
    }
    const knowledgeBlock = ['definicion', 'hecho', 'regla_negocio', 'issue_conocido']
      .filter((k) => byKind.has(k))
      .map((k) => `### ${KIND_LABEL[k]}\n${byKind.get(k)!.join('\n')}`)
      .join('\n\n');

    return `Eres **Maat**, la analista financiera AI de Mega Dulces (distribuidora de dulces en México). Tu nombre viene de la diosa egipcia de la verdad y la balanza: tu trabajo es que los números digan la verdad.

Hoy es ${ctx.today} (México).${scope.userName ? ` Hablas con ${scope.userName}.` : ''}

## REGLAS DURAS (no negociables)
1. **NUNCA inventes un número.** Todo dato cuantitativo debe salir de una tool. Si una tool no lo devuelve, di explícitamente que no tienes ese dato.
2. Responde SIEMPRE en español, montos en MXN (formato $1,234,567). Cita el período de cada cifra.
3. Los datos de egresos vienen del ERP Kepler vía feeds curados — cuando un número pueda estar afectado por un issue conocido (abajo), adviértelo.
4. Sé directa y ejecutiva: primero la respuesta, luego el detalle. Usa tablas markdown para comparaciones.
5. Si la pregunta es ambigua (¿qué período? ¿qué sucursal?), asume el default razonable (90 días, todas las sucursales) y DILO.
6. Cuando el usuario valide un hecho nuevo importante ("esto es así porque..."), ofrécele guardarlo con maat_guardar_conocimiento.

## LO QUE SABES (base de conocimiento curada — úsala para interpretar, no para citar cifras actuales; las cifras vigentes salen de las tools)

${knowledgeBlock}

## ALCANCE ACTUAL
Tienes acceso a: egresos contables (compras 511 + gastos 6xx/7xx, ~12 meses, 6 sucursales), documentos fuente con líneas de producto, auxiliar de proveedores (cuenta 201: saldo/pagos/DPO), y hallazgos contables. AÚN NO tienes: balanza completa (ingresos/activo/pasivo detallado) ni flujo de caja — si te preguntan por eso, dilo y ofrece lo que sí puedes responder con egresos/proveedores.`;
  }

  // ── Schema para Claude ───────────────────────────────────────────────
  definitions(): MaatToolDef[] {
    const dateRange = {
      from: { type: 'string', description: 'Fecha inicio ISO (YYYY-MM-DD). Default: hace 90 días.' },
      to: { type: 'string', description: 'Fecha fin ISO (YYYY-MM-DD). Default: hoy.' },
    };
    return [
      {
        name: 'maat_egresos',
        description:
          'Egresos contables (compras 511 + gastos 6xx/7xx) agregados por una dimensión. Para "cuánto gastamos", "en qué se va el dinero", top proveedores/cuentas/áreas de un período. Devuelve total + desglose con share %.',
        input_schema: {
          type: 'object',
          properties: {
            group_by: { type: 'string', enum: Object.keys(EGRESO_DIMS), description: 'Dimensión del desglose. mes = serie mensual.' },
            ...dateRange,
            familia: { type: 'string', enum: ['5', '6', '7'], description: '5=compras/costo, 6=gastos operación, 7=impuestos/financiero. Opcional.' },
            cuenta: { type: 'string', description: "Cuenta exacta ('511' o '601-001'). Opcional." },
            cuenta_mayor: { type: 'string', description: "Cuenta mayor ('601'). Opcional." },
            beneficiario: { type: 'string', description: 'Filtro ILIKE por beneficiario/proveedor. Opcional.' },
            sucursal: { type: 'string', description: "Código de sucursal ('00'=CEDIS, '01'..'05'). Opcional." },
            limit: { type: 'number', description: 'Default 25, máx 100.' },
          },
          required: ['group_by'],
        },
      },
      {
        name: 'maat_serie_mensual',
        description: 'Serie mensual de egresos: compras (511) vs gastos (6xx/7xx) por mes. Para tendencias y comparaciones mes a mes. Acepta los mismos filtros que maat_egresos.',
        input_schema: {
          type: 'object',
          properties: { ...dateRange, cuenta_mayor: { type: 'string' }, beneficiario: { type: 'string' }, sucursal: { type: 'string' } },
        },
      },
      {
        name: 'maat_proveedor',
        description:
          'Proveedor 360 (cuenta 201): compra 12m, pagos, SALDO POR PAGAR, #facturas, última compra, DPO (días de pago) + top productos que se le compran. Para "cuánto le debemos a X", "qué le compramos a X". search es ILIKE (acepta nombre parcial).',
        input_schema: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Nombre (o parte) del proveedor. Vacío = top proveedores por compra.' },
            limit: { type: 'number', description: 'Proveedores a devolver si search es amplio. Default 10, máx 50.' },
          },
        },
      },
      {
        name: 'maat_documento',
        description: 'Drill a un documento fuente: cabecera (proveedor/RFC/concepto/área/total/IVA) + posturas contables + líneas de producto (solo compras XA2001). Llave exacta: sucursal + doc_tipo + folio.',
        input_schema: {
          type: 'object',
          properties: {
            sucursal: { type: 'string', description: "Código sucursal ('00'..'05')." },
            doc_tipo: { type: 'string', description: "Tipo documento (ej. 'XA2001')." },
            folio: { type: 'string', description: "Folio (ej. '0000754')." },
          },
          required: ['sucursal', 'doc_tipo', 'folio'],
        },
      },
      {
        name: 'maat_hallazgos',
        description:
          'Hallazgos contables detectados: iva_bug (IVA huérfano XD5501), prov_203 (provisiones sin descargar), anticipo_107 (anticipos sin aplicar). Sin tipo → resumen de todos; con tipo → filas del tipo.',
        input_schema: {
          type: 'object',
          properties: {
            tipo: { type: 'string', enum: ['iva_bug', 'prov_203', 'anticipo_107'], description: 'Opcional.' },
            limit: { type: 'number', description: 'Default 20, máx 100.' },
          },
        },
      },
      {
        name: 'maat_conocimiento',
        description: 'Busca en la base de conocimiento curada (definiciones, hechos, reglas, issues). Para verificar si algo ya está documentado antes de responder sobre metodología o bugs conocidos.',
        input_schema: {
          type: 'object',
          properties: {
            q: { type: 'string', description: 'Texto a buscar (ILIKE en título y cuerpo).' },
            kind: { type: 'string', enum: ['definicion', 'hecho', 'regla_negocio', 'issue_conocido'], description: 'Opcional.' },
          },
          required: ['q'],
        },
      },
      {
        name: 'maat_guardar_conocimiento',
        description:
          'Guarda un hecho VALIDADO POR EL USUARIO en la base de conocimiento (L0). Úsala SOLO cuando el usuario confirme explícitamente algo nuevo que valga recordar (ej. "sí, ese proveedor es intercompañía"). Upsert por (kind, title).',
        input_schema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['definicion', 'hecho', 'regla_negocio', 'issue_conocido'] },
            title: { type: 'string', description: 'Título corto y único.' },
            body: { type: 'string', description: 'El hecho, 1-3 oraciones, con contexto.' },
          },
          required: ['kind', 'title', 'body'],
        },
      },
    ];
  }

  // ── Ejecución (determinista, tenant-scoped) ──────────────────────────
  async execute(name: string, input: any, scope: MaatScope): Promise<any> {
    try {
      switch (name) {
        case 'maat_egresos': return await this.egresos(input);
        case 'maat_serie_mensual': return await this.serieMensual(input);
        case 'maat_proveedor': return await this.proveedor(input);
        case 'maat_documento': return await this.documento(input);
        case 'maat_hallazgos': return await this.hallazgos(input);
        case 'maat_conocimiento': return await this.conocimiento(input);
        case 'maat_guardar_conocimiento': return await this.guardarConocimiento(input, scope);
        default: return { error: `Tool desconocida: ${name}` };
      }
    } catch (e: any) {
      this.logger.warn(`Tool ${name} error: ${e?.message || e}`);
      return { error: `La consulta falló (${String(e?.message || e).slice(0, 140)}). Reintenta con parámetros más simples.` };
    }
  }

  /** Rango default 90d (mismo criterio que /finanzas/egresos). */
  private range(q: { from?: string; to?: string }) {
    const to = q.to || new Date().toISOString().slice(0, 10);
    const from = q.from || (() => { const d = new Date(to); d.setDate(d.getDate() - 90); return d.toISOString().slice(0, 10); })();
    return { from, to };
  }

  private baseEgresos(trx: any, q: any, from: string, to: string) {
    const b = trx('analytics.expense_entries as e')
      .where('e.fecha', '>=', from)
      .andWhere('e.fecha', '<=', to);
    if (q.familia) b.where('e.familia', q.familia);
    if (q.cuenta) b.where('e.cuenta', q.cuenta);
    if (q.cuenta_mayor) b.where('e.cuenta_mayor', q.cuenta_mayor);
    if (q.beneficiario) b.whereRaw('e.beneficiario ILIKE ?', [`%${q.beneficiario}%`]);
    if (q.sucursal) b.where('e.sucursal', String(q.sucursal));
    return b;
  }

  private async egresos(q: any) {
    const dim = EGRESO_DIMS[q.group_by] || EGRESO_DIMS['cuenta'];
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const { from, to } = this.range(q);
    return this.tk.run(async (trx) => {
      const totalRow: any = await this.baseEgresos(trx, q, from, to)
        .select(trx.raw('COALESCE(SUM(importe),0)::numeric AS total'), trx.raw('COUNT(*)::int AS movs')).first();
      const total = Number(totalRow?.total || 0);
      const rows: any[] = await this.baseEgresos(trx, q, from, to)
        .groupByRaw(dim.group)
        .select(trx.raw(`${dim.key} AS key`), trx.raw(`${dim.label} AS label`),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS importe'), trx.raw('COUNT(*)::int AS movs'))
        .orderByRaw('SUM(importe) DESC')
        .limit(limit);
      return {
        from, to, total: +total.toFixed(2), movimientos: Number(totalRow?.movs || 0),
        rows: rows.map((r) => ({
          [q.group_by]: r.label, importe: Number(r.importe), movs: Number(r.movs),
          share_pct: total ? +((Number(r.importe) / total) * 100).toFixed(1) : 0,
        })),
      };
    });
  }

  private async serieMensual(q: any) {
    const { from, to } = this.range({ ...q, from: q.from || (() => { const d = new Date(); d.setMonth(d.getMonth() - 12); return d.toISOString().slice(0, 10); })() });
    return this.tk.run(async (trx) => {
      const rows: any[] = await this.baseEgresos(trx, q, from, to)
        .groupByRaw("to_char(e.fecha,'YYYY-MM')")
        .select(trx.raw("to_char(e.fecha,'YYYY-MM') AS mes"),
          trx.raw("ROUND(COALESCE(SUM(importe) FILTER (WHERE e.familia='5'),0)::numeric,2) AS compras"),
          trx.raw("ROUND(COALESCE(SUM(importe) FILTER (WHERE e.familia IN ('6','7')),0)::numeric,2) AS gastos"),
          trx.raw('ROUND(SUM(importe)::numeric,2) AS total'))
        .orderBy('mes');
      return { from, to, rows: rows.map((r) => ({ mes: r.mes, compras: Number(r.compras), gastos: Number(r.gastos), total: Number(r.total) })) };
    });
  }

  private async proveedor(q: any) {
    const search = (q.search || '').trim();
    const limit = Math.min(50, Math.max(1, Number(q.limit) || 10));
    return this.tk.run(async (trx) => {
      const b = trx('analytics.ap_provider');
      if (search) b.whereRaw('proveedor ILIKE ?', [`%${search}%`]);
      const provs: any[] = await b
        .groupBy('proveedor_norm')
        .select(trx.raw('MAX(proveedor) AS proveedor'),
          trx.raw('SUM(compra_12m)::numeric AS compra_12m'), trx.raw('SUM(pagos_12m)::numeric AS pagos_12m'),
          trx.raw('SUM(saldo)::numeric AS saldo'), trx.raw('SUM(num_facturas)::int AS num_facturas'),
          trx.raw('MAX(ultima_compra) AS ultima_compra'))
        .orderByRaw('SUM(compra_12m) DESC')
        .limit(limit);
      const out = provs.map((p) => {
        const compra = Number(p.compra_12m), saldo = Number(p.saldo);
        return {
          proveedor: p.proveedor, compra_12m: compra, pagos_12m: Number(p.pagos_12m), saldo,
          num_facturas: Number(p.num_facturas), ultima_compra: p.ultima_compra,
          dpo_dias: compra > 0 && saldo > 0 ? Math.round(saldo / (compra / 365)) : null,
        };
      });
      // Match único → anexar top productos comprados (detalle kdm2).
      if (out.length === 1) {
        const products: any[] = await trx('analytics.expense_document_lines as l')
          .join('analytics.expense_documents as d', function (this: any) {
            this.on('d.tenant_id', 'l.tenant_id').andOn('d.sucursal', 'l.sucursal')
              .andOn('d.doc_tipo', 'l.doc_tipo').andOn('d.doc_folio', 'l.doc_folio');
          })
          .whereRaw('d.beneficiario ILIKE ?', [`%${search || out[0].proveedor}%`])
          .groupBy('l.sku')
          .select('l.sku', trx.raw('MAX(l.producto) AS producto'),
            trx.raw('SUM(l.cantidad)::numeric AS cantidad'), trx.raw('SUM(l.importe)::numeric AS importe'),
            trx.raw('COUNT(DISTINCT l.doc_folio)::int AS docs'))
          .orderByRaw('SUM(l.importe) DESC')
          .limit(15);
        return {
          ...out[0],
          top_productos: products.map((r) => ({ sku: r.sku, producto: r.producto, cantidad: num(r.cantidad), importe: Number(r.importe), docs: Number(r.docs) })),
        };
      }
      return { proveedores: out };
    });
  }

  private async documento(q: any) {
    const { sucursal, doc_tipo, folio } = q;
    if (!sucursal || !doc_tipo || !folio) return { error: 'Faltan sucursal, doc_tipo o folio.' };
    return this.tk.run(async (trx) => {
      const header = await trx('analytics.expense_documents as d')
        .where({ 'd.sucursal': sucursal, 'd.doc_tipo': doc_tipo, 'd.doc_folio': folio })
        .select('d.sucursal', 'd.doc_tipo', 'd.doc_folio', 'd.fecha', 'd.fecha_doc', 'd.beneficiario', 'd.rfc',
          'd.concepto', 'd.area', trx.raw('d.importe::numeric AS importe'), trx.raw('d.iva::numeric AS iva'), 'd.usuario')
        .first();
      const postings = await trx('analytics.expense_entries')
        .where({ sucursal, doc_tipo, doc_folio: folio })
        .select('linea', 'cuenta', 'cuenta_nombre', trx.raw('importe::numeric AS importe'))
        .orderBy('linea');
      const lines = await trx('analytics.expense_document_lines')
        .where({ sucursal, doc_tipo, doc_folio: folio })
        .select('sku', 'producto', trx.raw('cantidad::numeric AS cantidad'), trx.raw('costo_unitario::numeric AS costo_unitario'), trx.raw('importe::numeric AS importe'))
        .orderBy('importe', 'desc');
      if (!header && !postings.length) return { error: `No existe el documento ${doc_tipo}-${folio} en sucursal ${sucursal}.` };
      return {
        header: header ? { ...header, importe: Number(header.importe), iva: Number(header.iva) } : null,
        posturas: postings.map((r: any) => ({ ...r, importe: Number(r.importe) })),
        lineas: lines.map((r: any) => ({ ...r, cantidad: num(r.cantidad), costo_unitario: num(r.costo_unitario), importe: Number(r.importe) })),
      };
    });
  }

  private async hallazgos(q: any) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    return this.tk.run(async (trx) => {
      const summary: any[] = await trx('analytics.expense_findings')
        .groupBy('tipo')
        .select('tipo', trx.raw('COUNT(*)::int AS num'), trx.raw('ROUND(SUM(importe)::numeric,2) AS total'))
        .orderByRaw('SUM(importe) DESC');
      let rows: any[] = [];
      if (q.tipo) {
        rows = await trx('analytics.expense_findings')
          .where('tipo', q.tipo)
          .select('fecha', 'sucursal', 'doc_tipo', 'doc_folio', 'beneficiario', 'cuenta', trx.raw('importe::numeric AS importe'), 'nota')
          .orderBy('importe', 'desc')
          .limit(limit);
      }
      return {
        resumen: summary.map((s) => ({ tipo: s.tipo, num: Number(s.num), total: Number(s.total) })),
        rows: rows.map((r) => ({ ...r, importe: Number(r.importe) })),
      };
    });
  }

  private async conocimiento(q: any) {
    return this.tk.run(async (trx) => {
      const b = trx('finance.knowledge').where('status', 'active');
      if (q.kind) b.where('kind', q.kind);
      if (q.q?.trim()) b.whereRaw('(title ILIKE ? OR body ILIKE ?)', [`%${q.q.trim()}%`, `%${q.q.trim()}%`]);
      const rows = await b.select('kind', 'title', 'body', 'source').orderBy(['kind', 'title']).limit(20);
      return rows.length ? { rows } : { rows: [], nota: 'Sin resultados en la base de conocimiento.' };
    });
  }

  private async guardarConocimiento(q: any, scope: MaatScope) {
    if (!q?.title?.trim() || !q?.body?.trim() || !q?.kind) return { error: 'kind, title y body son requeridos.' };
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.knowledge')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          kind: q.kind, title: String(q.title).trim().slice(0, 200), body: String(q.body).trim().slice(0, 2000),
          source: 'chat', created_by: scope.userName || 'maat-chat',
        })
        .onConflict(['tenant_id', 'kind', 'title'])
        .merge({ body: String(q.body).trim().slice(0, 2000), status: 'active', updated_at: trx.fn.now() })
        .returning(['kind', 'title']);
      this.logger.log(`knowledge guardado vía chat: [${row.kind}] ${row.title} (por ${scope.userName || '?'})`);
      return { guardado: true, kind: row.kind, title: row.title };
    });
  }
}
