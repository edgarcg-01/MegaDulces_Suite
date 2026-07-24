import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CommercialReplenishmentService } from '../../commercial-replenishment/commercial-replenishment.service';
import { ThotToolDef, ThotToolProvider, ThotScope } from './thot-tool-provider';
import { buildComprasSystemPrompt } from './thot-semantic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * TOT-C (Fase TOT / RA) — Asistente conversacional de COMPRAS dentro de /compras/pedido.
 * Arma requisiciones a proveedor conversando: el motor RA (existencia crítica + sugerido en
 * CAJAS) pone las cantidades y el costo; el comprador ajusta y CREA la requisición (queda
 * pending_approval — la aprueba un humano). El LLM nunca inventa cantidades ni precios.
 */
@Injectable()
export class ComprasToolsService implements ThotToolProvider {
  private readonly logger = new Logger(ComprasToolsService.name);

  constructor(
    private readonly rep: CommercialReplenishmentService,
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
  ) {}

  systemPrompt(scope: ThotScope, ctx: { today: string }): string {
    return buildComprasSystemPrompt({ today: ctx.today, userName: scope.userName || undefined });
  }

  definitions(_scope: ThotScope): ThotToolDef[] {
    return [
      { name: 'compras_resolve_supplier', description: 'Busca un proveedor por nombre o código; devuelve su id y sus parámetros de pedido (cadencia, colchón, mínimo en cajas). Úsala primero para obtener el supplier_id.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
      { name: 'compras_worklist', description: 'Qué proveedores TOCA pedir (ciclos vencidos/próximos por almacén) con su costo sugerido. Para "¿qué toca pedir?", "¿a quién le pido hoy?".', input_schema: { type: 'object', properties: { warehouse_code: { type: 'string', description: 'Opcional: código de almacén (01, 02, MD-30…).' } } } },
      { name: 'compras_suggested_order', description: 'El pedido SUGERIDO por el motor para un proveedor en un almacén (renglones en CAJAS + costo). basis: cadence (default, para el ciclo) | max | reorder | min. Requiere supplier_id + warehouse_code.', input_schema: { type: 'object', properties: { supplier_id: { type: 'string' }, warehouse_code: { type: 'string' }, basis: { type: 'string', description: 'cadence|max|reorder|min. Default cadence.' } }, required: ['supplier_id', 'warehouse_code'] } },
      { name: 'compras_create_requisition', description: 'CREA la requisición de compra (queda PENDIENTE DE APROBACIÓN). items = [{sku, cajas}]. Úsala SOLO cuando el comprador lo pida tras revisar. Requiere supplier_id + warehouse_code + items.', input_schema: { type: 'object', properties: { supplier_id: { type: 'string' }, warehouse_code: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, cajas: { type: 'number' } }, required: ['sku', 'cajas'] } }, notes: { type: 'string' } }, required: ['supplier_id', 'warehouse_code', 'items'] } },
      { name: 'compras_pending_requisitions', description: 'Requisiciones pendientes de aprobación (folio, proveedor, almacén, total).', input_schema: { type: 'object', properties: {} } },
      { name: 'compras_export_requisition', description: 'Prepara la descarga de una requisición en Excel (el formato estándar de compras). Para "expórtalo", "mándamelo en Excel". Requiere el folio (RQ-YYYY-NNNNN) o el id.', input_schema: { type: 'object', properties: { ref: { type: 'string', description: 'Folio (RQ-...) o id de la requisición.' } }, required: ['ref'] } },
    ];
  }

  async execute(name: string, input: any, _scope: ThotScope): Promise<any> {
    const args = input || {};
    try {
      switch (name) {
        case 'compras_resolve_supplier': return await this.resolveSupplier(String(args.query || ''));
        case 'compras_worklist': return await this.worklist(args.warehouse_code);
        case 'compras_suggested_order': return await this.suggestedOrder(String(args.supplier_id || ''), String(args.warehouse_code || ''), args.basis);
        case 'compras_create_requisition': return await this.createRequisition(String(args.supplier_id || ''), String(args.warehouse_code || ''), args.items, args.notes);
        case 'compras_pending_requisitions': return await this.pending();
        case 'compras_export_requisition': return await this.exportRequisition(String(args.ref || ''));
        default: return { error: `Tool no disponible en compras: ${name}` };
      }
    } catch (e: any) {
      this.logger.warn(`Compras tool ${name} falló: ${e?.message || e}`);
      return { error: e?.message || `No pude ejecutar ${name}.` };
    }
  }

  private async whId(code: string): Promise<string | null> {
    const tenantId = this.ctx.requireTenantId();
    return this.tk.run((trx) => trx('commercial.warehouses')
      .where({ tenant_id: tenantId }).whereNull('deleted_at')
      .andWhere((w: any) => w.where('code', code).orWhereRaw('name ILIKE ?', [`%${code}%`]))
      .first('id').then((r: any) => r?.id || null));
  }

  private async resolveSupplier(query: string) {
    const q = query.trim();
    if (q.length < 2) return { error: 'Escribe al menos 2 caracteres.' };
    const tenantId = this.ctx.requireTenantId();
    const like = `%${q}%`;
    return this.tk.run(async (trx) => {
      const rows = await trx('catalog.suppliers')
        .where('tenant_id', tenantId).whereNull('deleted_at')
        .andWhere((w: any) => w.whereRaw('name ILIKE ?', [like]).orWhereRaw('code ILIKE ?', [like]))
        .limit(8)
        .select('id', 'name', 'code', 'cadence_days_override', 'colchon_days', 'min_order_boxes', 'lead_time_days');
      return rows.length ? rows.map((r: any) => ({
        supplier_id: r.id, name: r.name, code: r.code,
        cadencia_dias: r.cadence_days_override, colchon_dias: r.colchon_days,
        minimo_cajas: r.min_order_boxes, lead_dias: r.lead_time_days,
      })) : { message: `No encontré proveedor "${q}".` };
    });
  }

  private async worklist(warehouseCode?: string) {
    const whId = warehouseCode ? await this.whId(String(warehouseCode)) : undefined;
    const res: any = await this.rep.worklist({ warehouse_id: whId || undefined, status: 'due', pageSize: 40 } as any);
    return {
      vencidos: res.vencidos, hoy: res.hoy, prox7: res.prox7,
      rows: (res.rows || []).slice(0, 25).map((r: any) => ({
        proveedor: r.supplier_name, almacen: r.warehouse_code, via: r.via,
        toca: r.next_due_date, dias: r.days_to_due, skus: r.n_skus,
        sugerido_costo: r.suggested_cost != null ? Number(r.suggested_cost) : null,
      })),
    };
  }

  private async suggestedOrder(supplierId: string, warehouseCode: string, basis?: string) {
    if (!UUID_RE.test(supplierId)) return { error: 'supplier_id inválido. Resuélvelo con compras_resolve_supplier.' };
    const whId = await this.whId(warehouseCode);
    if (!whId) return { error: `No encontré el almacén "${warehouseCode}".` };
    const b = ['cadence', 'max', 'reorder', 'min'].includes(String(basis)) ? String(basis) : 'cadence';
    const res: any = await this.rep.criticalStock({ supplier_id: supplierId, warehouse_id: whId, target_basis: b, scope: 'all', pageSize: 1000 } as any);
    const lines = (res.rows || []).filter((r: any) => Number(r.suggested_qty) > 0).map((r: any) => ({
      sku: r.sku, product: r.nombre, bucket: r.bucket,
      existencia: Number(r.on_hand), sugerido_cajas: Math.ceil(Number(r.suggested_qty)),
      costo_caja: Number(r.unit_cost) || 0, importe: Number(r.suggested_cost) || 0,
    }));
    const total = lines.reduce((s: number, l: any) => s + l.importe, 0);
    return { warehouse: warehouseCode, basis: b, n_lineas: lines.length, total_importe: Math.round(total), lines: lines.slice(0, 80) };
  }

  private async createRequisition(supplierId: string, warehouseCode: string, items: any[], notes?: string) {
    if (!UUID_RE.test(supplierId)) return { error: 'supplier_id inválido.' };
    if (!Array.isArray(items) || !items.length) return { error: 'Dame al menos un producto con cajas.' };
    const whId = await this.whId(warehouseCode);
    if (!whId) return { error: `No encontré el almacén "${warehouseCode}".` };
    // Trae el universo del proveedor×almacén (con costo/política) para construir las líneas completas.
    const res: any = await this.rep.criticalStock({ supplier_id: supplierId, warehouse_id: whId, target_basis: 'cadence', scope: 'all', pageSize: 5000 } as any);
    const bySku = new Map<string, any>((res.rows || []).map((r: any) => [String(r.sku), r]));
    const lines: any[] = [], failed: any[] = [];
    for (const it of items) {
      const sku = String(it?.sku || '').trim();
      const cajas = Number(it?.cajas);
      const row = bySku.get(sku);
      if (!row) { failed.push({ sku, reason: 'no es de este proveedor/almacén o no tiene política' }); continue; }
      if (!(cajas > 0)) { failed.push({ sku, reason: 'cantidad inválida' }); continue; }
      lines.push({
        product_id: row.product_id, supplier_id: supplierId, source_type: 'supplier',
        on_hand: Number(row.on_hand || 0), in_transit: Number(row.in_transit || 0),
        min_stock: Number(row.min_stock || 0), reorder_point: Number(row.reorder_point || 0), max_stock: Number(row.max_stock || 0),
        suggested_qty: Math.ceil(Number(row.suggested_qty || 0)), final_qty: cajas, unit_cost: Number(row.unit_cost || 0),
      });
    }
    if (!lines.length) return { error: 'Ninguna línea válida.', failed };
    const req: any = await this.rep.createRequisition({
      warehouse_id: whId, supplier_id: supplierId, source_type: 'supplier', source_warehouse_id: null,
      notes: notes || 'Requisición armada con el asistente de compras', lines,
    } as any);
    return { ok: true, requisition_id: req.id, folio: req.folio, estado: req.estado, total_lineas: req.total_lines, total: Math.round(Number(req.total_cost)), failed: failed.length ? failed : undefined, nota: 'Queda PENDIENTE DE APROBACIÓN. Puedes descargarla en Excel.', download_xlsx: true };
  }

  /** Resuelve una requisición (por folio o id) para que el front ofrezca su descarga XLSX. */
  private async exportRequisition(ref: string) {
    const r = (ref || '').trim();
    if (!r) return { error: 'Dame el folio o id de la requisición.' };
    const tenantId = this.ctx.requireTenantId();
    const row = await this.tk.run((trx) => {
      const q = trx('commercial.purchase_requisitions').where('tenant_id', tenantId);
      if (UUID_RE.test(r)) q.andWhere('id', r); else q.andWhere('folio', r.toUpperCase());
      return q.first('id', 'folio', 'estado', 'total_cost');
    });
    if (!row) return { error: `No encontré la requisición "${r}".` };
    return { requisition_id: row.id, folio: row.folio, estado: row.estado, total: Math.round(Number(row.total_cost)), download_xlsx: true, nota: 'Lista para descargar en Excel.' };
  }

  private async pending() {
    const res: any = await this.rep.listRequisitions({ estado: 'pending_approval', pageSize: 25 } as any);
    return (res.rows || []).map((r: any) => ({ folio: r.folio, proveedor: r.supplier_name, almacen: r.warehouse_code, total: Number(r.total_cost), lineas: r.total_lines, creada: r.created_at }));
  }
}
