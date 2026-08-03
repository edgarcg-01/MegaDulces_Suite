import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService } from '@megadulces/platform-core';
import { LlmExtractorService, DepositSlipFields } from '@megadulces/platform-core';

/**
 * Fase CC (extensión) — Comprobantes de PAGO A PROVEEDOR. Adjunta el comprobante
 * de TRANSFERENCIA bancaria (imagen/PDF) a un pago de Kepler (documento `XD2501`
 * "Pago a proveedor"), le corre OCR (mismo shape que la ficha de depósito) y guarda
 * la evidencia en `finance.supplier_payment_proofs` ligada por `(sucursal, folio)`.
 * NO escribe a Kepler: los pagos se leen del espejo `analytics.erp_supplier_payments`.
 * Flujo `recibido → validado | rechazado`.
 */

export const PAYMENT_FILE_ROLES = ['comprobante', 'evidencia_1', 'evidencia_2'] as const;
export type PaymentFileRole = (typeof PAYMENT_FILE_ROLES)[number];
const TOLERANCIA = 1.0; // pesos: |ocr_monto - pago_monto| <= 1 → cuadra (redondeo)

export interface PaymentFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

export interface ListPaymentsQuery {
  estado?: 'pendiente' | 'con_comprobante' | 'validado' | string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
}

export interface AttachPaymentDto {
  sucursal?: string;
  folio?: string;
  files?: PaymentFile[];
  ocr?: Partial<DepositSlipFields> & { ocr_status?: string };
  comentarios?: string;
}

@Injectable()
export class SupplierPaymentProofsService {
  private readonly logger = new Logger(SupplierPaymentProofsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly ocr: LlmExtractorService,
  ) {}

  /**
   * Lista los pagos a proveedor de Kepler (espejo `analytics.erp_supplier_payments`)
   * con el estado de su comprobante adjunto (LEFT JOIN a `finance.supplier_payment_proofs`).
   */
  async listPayments(q: ListPaymentsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));

    return this.tk.run(async (trx) => {
      const dep = trx('finance.supplier_payment_proofs')
        .select('sucursal', 'folio')
        .count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .select(trx.raw(`bool_or(monto_match) AS any_match`))
        .groupBy('sucursal', 'folio')
        .as('d');

      const b = trx('analytics.erp_supplier_payments as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId)
        .select(
          'c.sucursal', 'c.folio', 'c.pago_date', 'c.proveedor_code', 'c.proveedor_nombre',
          'c.proveedor_rfc', 'c.concepto', trx.raw('c.monto::numeric AS monto'),
          trx.raw('COALESCE(d.n, 0)::int AS deposits'),
          trx.raw('d.last_id AS deposit_id'),
          trx.raw('d.last_status AS deposit_status'),
          trx.raw('COALESCE(d.any_match, false) AS monto_match'),
        )
        .orderBy('c.pago_date', 'desc')
        .orderBy('c.folio', 'desc')
        .limit(limit);

      if (q.from) b.where('c.pago_date', '>=', q.from);
      if (q.to) b.where('c.pago_date', '<=', q.to);
      if (q.estado === 'pendiente') b.whereRaw('d.n IS NULL');
      if (q.estado === 'con_comprobante') b.whereRaw('d.n > 0');
      if (q.estado === 'validado') b.whereRaw(`d.last_status = 'validado'`);
      if (q.search) {
        const s = `%${q.search.trim()}%`;
        b.where((w) => w.whereILike('c.proveedor_nombre', s).orWhereILike('c.proveedor_code', s)
          .orWhereILike('c.proveedor_rfc', s).orWhereILike('c.folio', s).orWhereRaw('c.monto::text ILIKE ?', [s]));
      }

      const rows = (await b).map((r: any) => ({ ...r, monto: Number(r.monto) }));

      const kpiBase = trx('analytics.erp_supplier_payments as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId);
      if (q.from) kpiBase.where('c.pago_date', '>=', q.from);
      if (q.to) kpiBase.where('c.pago_date', '<=', q.to);
      const [k] = await kpiBase.select(
        trx.raw('COUNT(*)::int AS pagos'),
        trx.raw('COUNT(d.n)::int AS con_comprobante'),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='validado')::int AS validados`),
        trx.raw('COALESCE(SUM(c.monto::numeric) FILTER (WHERE d.n IS NULL), 0)::numeric AS monto_pendiente'),
      );

      return {
        kpis: {
          pagos: Number(k.pagos), con_comprobante: Number(k.con_comprobante),
          validados: Number(k.validados), monto_pendiente: Number(k.monto_pendiente),
        },
        rows,
      };
    });
  }

  /** Sube UN archivo (comprobante/evidencia) a Cloudinary. Imagen o PDF. */
  async uploadFile(dataUri: string, role = 'comprobante'): Promise<PaymentFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!PAYMENT_FILE_ROLES.includes(role as PaymentFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      const f = await this.cloudinary.uploadDocumentBase64(dataUri, `finance/${tenantId}/supplier-payments`);
      return { role, url: f.url, public_id: f.public_id, kind: f.kind };
    } catch (e: any) {
      this.logger.error(`fallo subiendo comprobante (${role}): ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /** Corre OCR sobre el comprobante de transferencia (imagen/PDF). Preview, no guarda. */
  async runOcr(dataUri: string): Promise<DepositSlipFields & { ocr_status: string }> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const { mediaType, base64 } = this.parseDataUri(dataUri);
    if (!process.env.ANTHROPIC_API_KEY) {
      return { monto: null, fecha: null, banco: null, cuenta_dest: null, referencia: null, ordenante: null, metodo: null, ocr_status: 'sin_key' };
    }
    const fields = await this.ocr.extractDepositSlip(base64, mediaType);
    const any = fields.monto != null || fields.fecha || fields.banco || fields.referencia;
    return { ...fields, ocr_status: any ? 'ok' : 'ilegible' };
  }

  /** Crea el registro de evidencia ligado al pago Kepler. Calcula `monto_match`. */
  async attach(dto: AttachPaymentDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const sucursal = (dto.sucursal || '').trim();
    const folio = (dto.folio || '').trim();
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!sucursal || !folio) throw new BadRequestException('sucursal y folio del pago requeridos');
    if (!files.length) throw new BadRequestException('se requiere al menos el comprobante');

    return this.tk.run(async (trx) => {
      const pago = await trx('analytics.erp_supplier_payments')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), sucursal, folio })
        .first('proveedor_nombre', 'proveedor_rfc', 'pago_date', trx.raw('monto::numeric AS monto'));
      if (!pago) throw new BadRequestException(`pago ${sucursal}/${folio} no existe en el espejo de Kepler`);

      const o = dto.ocr || {};
      const pagoMonto = Number(pago.monto) || 0;
      const ocrMonto = o.monto != null ? Number(o.monto) : null;
      const montoMatch = ocrMonto != null ? Math.abs(ocrMonto - pagoMonto) <= TOLERANCIA : null;

      const [row] = await trx('finance.supplier_payment_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          sucursal, folio,
          proveedor_nombre: pago.proveedor_nombre || null,
          proveedor_rfc: pago.proveedor_rfc || null,
          pago_date: pago.pago_date || null,
          pago_monto: pagoMonto,
          files: JSON.stringify(files),
          ocr_monto: ocrMonto,
          ocr_fecha: o.fecha || null,
          ocr_banco: o.banco || null,
          ocr_cuenta_dest: o.cuenta_dest || null,
          ocr_referencia: o.referencia || null,
          ocr_ordenante: o.ordenante || null,
          ocr_metodo: o.metodo || null,
          ocr_raw: o ? JSON.stringify(o) : null,
          ocr_status: (o.ocr_status as string) || 'manual',
          monto_match: montoMatch,
          comentarios: (dto.comentarios || '').trim() || null,
          created_by: actor || null,
        })
        .returning(['id', 'sucursal', 'folio', 'status', 'monto_match']);
      this.logger.log(`comprobante adjunto a pago ${sucursal}/${folio} (match=${montoMatch}) por ${actor || '?'}`);
      return row;
    });
  }

  /** Detalle: el pago + sus comprobantes adjuntos. */
  async detail(sucursal: string, folio: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const pago = await trx('analytics.erp_supplier_payments')
        .where({ tenant_id: tenantId, sucursal, folio })
        .first('sucursal', 'folio', 'pago_date', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc', 'concepto', trx.raw('monto::numeric AS monto'));
      if (!pago) throw new BadRequestException('pago no encontrado');
      const deposits = await trx('finance.supplier_payment_proofs')
        .where({ sucursal, folio })
        .orderBy('created_at', 'desc')
        .select('id', 'files', trx.raw('ocr_monto::numeric AS ocr_monto'), 'ocr_fecha', 'ocr_banco', 'ocr_cuenta_dest',
          'ocr_referencia', 'ocr_ordenante', 'ocr_metodo', 'ocr_status', 'monto_match', 'status',
          'comentarios', 'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');
      return { pago: { ...pago, monto: Number(pago.monto) }, deposits };
    });
  }

  /** El revisor valida la evidencia. Auditado. */
  async validate(id: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.supplier_payment_proofs').where({ id }).whereIn('status', ['recibido', 'rechazado'])
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
      const [row] = await trx('finance.supplier_payment_proofs').where({ id }).whereIn('status', ['recibido', 'validado'])
        .update({ status: 'rechazado', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: (motivo || '').trim() || 'rechazada', updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('evidencia no encontrada o ya rechazada');
      return row;
    });
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
