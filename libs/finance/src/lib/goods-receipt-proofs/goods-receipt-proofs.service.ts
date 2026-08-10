import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService, applySmartSearch } from '@megadulces/platform-core';
import { LlmExtractorService, RemisionFields } from '@megadulces/platform-core';

/**
 * Fase CC (extensión) — Comprobantes de ORDEN DE ENTRADA. Adjunta la REMISIÓN/
 * FACTURA del proveedor (imagen/PDF) a una orden de entrada de Kepler (documento
 * `X-A-40` "Orden de entrada", enriquecida con su vale `X-A-37`), le corre OCR de
 * remisión y guarda la evidencia en `finance.goods_receipt_proofs` ligada por
 * `(sucursal, folio)`. NO escribe a Kepler: las entradas se leen del espejo
 * `analytics.erp_goods_receipts`. Flujo `recibido → validado | rechazado`.
 */

// Set de evidencia de una recepción: lo normal son 3–4 fotos (remisión/factura del
// proveedor + vale de recepción firmado + Aplica Orden Entrada de Kepler + ticket de compra).
// `evidencia_1` se mantiene por compatibilidad con registros viejos.
export const RECEIPT_FILE_ROLES = ['remision', 'factura', 'vale', 'orden_entrada', 'ticket', 'evidencia', 'evidencia_1'] as const;
export type ReceiptFileRole = (typeof RECEIPT_FILE_ROLES)[number];
const TOLERANCIA = 1.0; // pesos: cuadra si el total (o subtotal) de la remisión ≈ el valor Kepler

export interface ReceiptFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

export interface ListReceiptsQuery {
  estado?: 'pendiente' | 'con_comprobante' | 'validado' | string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
}

export interface AttachReceiptDto {
  sucursal?: string;
  folio?: string;
  files?: ReceiptFile[];
  ocr?: Partial<RemisionFields> & { ocr_status?: string };
  comentarios?: string;
}

@Injectable()
export class GoodsReceiptProofsService {
  private readonly logger = new Logger(GoodsReceiptProofsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly ocr: LlmExtractorService,
  ) {}

  /**
   * Lista las órdenes de entrada de Kepler (espejo `analytics.erp_goods_receipts`)
   * con el estado de su remisión adjunta (LEFT JOIN a `finance.goods_receipt_proofs`).
   */
  async listReceipts(q: ListReceiptsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));

    return this.tk.run(async (trx) => {
      const dep = trx('finance.goods_receipt_proofs')
        .select('sucursal', 'folio')
        .count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .select(trx.raw(`bool_or(monto_match) AS any_match`))
        .groupBy('sucursal', 'folio')
        .as('d');

      const b = trx('analytics.erp_goods_receipts as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId)
        .select(
          'c.sucursal', 'c.folio', 'c.receipt_date', 'c.proveedor_code', 'c.proveedor_nombre',
          'c.proveedor_rfc', 'c.oc_folio', 'c.concepto', trx.raw('c.monto::numeric AS monto'),
          trx.raw('COALESCE(d.n, 0)::int AS deposits'),
          trx.raw('d.last_id AS deposit_id'),
          trx.raw('d.last_status AS deposit_status'),
          trx.raw('COALESCE(d.any_match, false) AS monto_match'),
        )
        .orderBy('c.receipt_date', 'desc')
        .orderBy('c.folio', 'desc')
        .limit(limit);

      if (q.from) b.where('c.receipt_date', '>=', q.from);
      if (q.to) b.where('c.receipt_date', '<=', q.to);
      if (q.estado === 'pendiente') b.whereRaw('d.n IS NULL');
      if (q.estado === 'con_comprobante') b.whereRaw('d.n > 0');
      if (q.estado === 'validado') b.whereRaw(`d.last_status = 'validado'`);
      applySmartSearch(b, q.search, {
        columns: ['c.proveedor_nombre', 'c.proveedor_code', 'c.proveedor_rfc', 'c.folio', 'c.oc_folio'],
        numeric: ['c.monto'],
      });

      const rows = (await b).map((r: any) => ({ ...r, monto: Number(r.monto) }));

      const kpiBase = trx('analytics.erp_goods_receipts as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId);
      if (q.from) kpiBase.where('c.receipt_date', '>=', q.from);
      if (q.to) kpiBase.where('c.receipt_date', '<=', q.to);
      const [k] = await kpiBase.select(
        trx.raw('COUNT(*)::int AS entradas'),
        trx.raw('COUNT(d.n)::int AS con_comprobante'),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='validado')::int AS validados`),
        trx.raw('COALESCE(SUM(c.monto::numeric) FILTER (WHERE d.n IS NULL), 0)::numeric AS monto_pendiente'),
      );

      return {
        kpis: {
          entradas: Number(k.entradas), con_comprobante: Number(k.con_comprobante),
          validados: Number(k.validados), monto_pendiente: Number(k.monto_pendiente),
        },
        rows,
      };
    });
  }

  /** Sube UN archivo (remisión/factura/evidencia) a Cloudinary. Imagen o PDF. */
  async uploadFile(dataUri: string, role = 'remision'): Promise<ReceiptFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!RECEIPT_FILE_ROLES.includes(role as ReceiptFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      const f = await this.cloudinary.uploadDocumentBase64(dataUri, `finance/${tenantId}/goods-receipts`);
      return { role, url: f.url, public_id: f.public_id, kind: f.kind };
    } catch (e: any) {
      this.logger.error(`fallo subiendo remisión (${role}): ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /** Corre OCR sobre la remisión/factura (imagen/PDF). Preview, no guarda. */
  async runOcr(dataUri: string): Promise<RemisionFields & { ocr_status: string }> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const { mediaType, base64 } = this.parseDataUri(dataUri);
    if (!process.env.ANTHROPIC_API_KEY) {
      return { folio: null, fecha: null, proveedor: null, rfc: null, subtotal: null, iva: null, total: null, ocr_status: 'sin_key' };
    }
    const fields = await this.ocr.extractRemision(base64, mediaType);
    const any = fields.total != null || fields.folio || fields.proveedor || fields.rfc;
    return { ...fields, ocr_status: any ? 'ok' : 'ilegible' };
  }

  /** Crea el registro de evidencia ligado a la entrada Kepler. Calcula `monto_match`. */
  async attach(dto: AttachReceiptDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const sucursal = (dto.sucursal || '').trim();
    const folio = (dto.folio || '').trim();
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!sucursal || !folio) throw new BadRequestException('sucursal y folio de la entrada requeridos');
    if (!files.length) throw new BadRequestException('se requiere al menos la remisión/factura');

    return this.tk.run(async (trx) => {
      const entrada = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), sucursal, folio })
        .first('proveedor_nombre', 'proveedor_rfc', 'oc_folio', 'receipt_date', trx.raw('monto::numeric AS monto'));
      if (!entrada) throw new BadRequestException(`entrada ${sucursal}/${folio} no existe en el espejo de Kepler`);

      const o = dto.ocr || {};
      const receiptMonto = Number(entrada.monto) || 0;
      const ocrTotal = o.total != null ? Number(o.total) : null;
      const ocrSubtotal = o.subtotal != null ? Number(o.subtotal) : null;
      // Cuadra si el total O el subtotal de la remisión ≈ el valor Kepler (IVA
      // puede o no estar incluido según el producto — dulce a granel suele ser 0%).
      const near = (v: number | null) => v != null && Math.abs(v - receiptMonto) <= TOLERANCIA;
      const montoMatch = ocrTotal != null || ocrSubtotal != null ? (near(ocrTotal) || near(ocrSubtotal)) : null;
      // RE.2 — clasifica y persiste el descuadre factura-vs-entrada (antes solo en vivo).
      const disc = this.classifyDiscrepancy(receiptMonto, ocrTotal, ocrSubtotal, montoMatch);

      const [row] = await trx('finance.goods_receipt_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          sucursal, folio,
          proveedor_nombre: entrada.proveedor_nombre || null,
          proveedor_rfc: entrada.proveedor_rfc || null,
          oc_folio: entrada.oc_folio || null,
          receipt_date: entrada.receipt_date || null,
          receipt_monto: receiptMonto,
          files: JSON.stringify(files),
          ocr_folio: o.folio || null,
          ocr_fecha: o.fecha || null,
          ocr_proveedor: o.proveedor || null,
          ocr_rfc: o.rfc || null,
          ocr_subtotal: ocrSubtotal,
          ocr_iva: o.iva != null ? Number(o.iva) : null,
          ocr_monto: ocrTotal,
          ocr_raw: o ? JSON.stringify(o) : null,
          ocr_status: (o.ocr_status as string) || 'manual',
          monto_match: montoMatch,
          discrepancy_kind: disc.kind,
          discrepancy_amount: disc.amount,
          comentarios: (dto.comentarios || '').trim() || null,
          created_by: actor || null,
        })
        .returning(['id', 'sucursal', 'folio', 'status', 'monto_match']);
      this.logger.log(`remisión adjunta a entrada ${sucursal}/${folio} (match=${montoMatch}) por ${actor || '?'}`);
      return row;
    });
  }

  /** Detalle: la entrada + sus remisiones adjuntas. */
  async detail(sucursal: string, folio: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const entrada = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: tenantId, sucursal, folio })
        .first('sucursal', 'folio', 'receipt_date', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc',
          'oc_folio', 'vale_folio', 'concepto', trx.raw('monto::numeric AS monto'));
      if (!entrada) throw new BadRequestException('entrada no encontrada');
      // Detalle por renglón (auditoría): qué SKU/cantidad/costo entró en este documento.
      const lineasRaw = await trx('analytics.erp_goods_receipt_lines')
        .where({ tenant_id: tenantId, sucursal, folio })
        .orderByRaw(`NULLIF(regexp_replace(linea, '[^0-9]', '', 'g'), '')::int NULLS LAST, linea`)
        .select('linea', 'sku', 'nombre', 'unidad',
          trx.raw('cantidad::numeric AS cantidad'),
          trx.raw('costo_unitario::numeric AS costo_unitario'),
          trx.raw('importe::numeric AS importe'));
      const lineas = lineasRaw.map((l: any) => ({
        ...l, cantidad: Number(l.cantidad), costo_unitario: Number(l.costo_unitario), importe: Number(l.importe),
      }));
      const deposits = await trx('finance.goods_receipt_proofs')
        .where({ sucursal, folio })
        .orderBy('created_at', 'desc')
        .select('id', 'files', 'ocr_folio', 'ocr_fecha', 'ocr_proveedor', 'ocr_rfc',
          trx.raw('ocr_subtotal::numeric AS ocr_subtotal'), trx.raw('ocr_iva::numeric AS ocr_iva'),
          trx.raw('ocr_monto::numeric AS ocr_monto'), 'ocr_status', 'monto_match',
          'discrepancy_kind', trx.raw('discrepancy_amount::numeric AS discrepancy_amount'), 'status',
          'comentarios', 'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');
      return { entrada: { ...entrada, monto: Number(entrada.monto) }, lineas, deposits };
    });
  }

  /** El revisor valida la evidencia. Auditado. */
  async validate(id: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.goods_receipt_proofs').where({ id }).whereIn('status', ['recibido', 'rechazado'])
        .update({ status: 'validado', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: null, updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('evidencia no encontrada o ya validada');
      return row;
    });
  }

  /** Rechaza (con motivo). Auditado. */
  async reject(id: string, actor?: string, motivo?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.goods_receipt_proofs').where({ id }).whereIn('status', ['recibido', 'validado'])
        .update({ status: 'rechazado', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: (motivo || '').trim() || 'rechazada', updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('evidencia no encontrada o ya rechazada');
      return row;
    });
  }

  /**
   * RE.2 — clasifica el descuadre factura/remisión vs valor de la entrada (Kepler),
   * a partir de lo que hoy ya se calcula al adjuntar (no llama al auto-explain de
   * ajustes, que es un paso aparte). Devuelve el `kind` + el monto de la diferencia:
   *   - sin OCR (montoMatch null)     → sin clasificar (null/null)
   *   - cuadra                        → 'cuadra', 0
   *   - Δ ≈ 16% del valor             → 'iva'   (remisión con/ sin IVA vs entrada)
   *   - Δ > 70% del valor             → 'typo'  (error de captura grueso)
   *   - resto                         → 'otro'  (faltante/devolución/descuento → auto-explain)
   */
  private classifyDiscrepancy(receipt: number, ocrTotal: number | null, ocrSubtotal: number | null, montoMatch: boolean | null): { kind: string | null; amount: number | null } {
    if (montoMatch === null) return { kind: null, amount: null };
    if (montoMatch === true) return { kind: 'cuadra', amount: 0 };
    const cands = [ocrTotal, ocrSubtotal].filter((v): v is number => v != null);
    if (!cands.length) return { kind: null, amount: null };
    const amount = Math.min(...cands.map((v) => Math.abs(v - receipt)));
    const ratio = receipt > 0 ? amount / receipt : 0;
    if (ratio >= 0.14 && ratio <= 0.175) return { kind: 'iva', amount };
    if (ratio > 0.7) return { kind: 'typo', amount };
    return { kind: 'otro', amount };
  }

  private parseDataUri(dataUri: string): { mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf'; base64: string } {
    const m = /^data:([^;,]+)[;,]/.exec(dataUri || '');
    const raw = (m ? m[1] : 'image/jpeg').toLowerCase();
    const base64 = String(dataUri || '').replace(/^data:[^,]*,/, '');
    const mediaType = raw === 'application/pdf' ? 'application/pdf'
      : /^image\/(jpeg|png|webp|gif)$/.test(raw) ? (raw as any) : 'image/jpeg';
    return { mediaType, base64 };
  }
}
