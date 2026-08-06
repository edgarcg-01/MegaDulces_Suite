import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService, applySmartSearch } from '@megadulces/platform-core';
import { LlmExtractorService, SupplierPaymentFields } from '@megadulces/platform-core';

/**
 * Fase CC (extensión) — Comprobantes de PAGO A PROVEEDOR. Adjunta el comprobante
 * (imagen/PDF) a un pago de Kepler, le corre OCR (mismo shape que la ficha de depósito)
 * y guarda la evidencia en `finance.supplier_payment_proofs` ligada por
 * `(sucursal, doc_prefix, folio)`. El pago vive en DOS doctypes según el método:
 * `XD2601` (transferencia) y `XD2501` (cheque) — el folio NO es único entre ambos, por
 * eso `doc_prefix` es parte de la clave. NO escribe a Kepler: los pagos se leen del
 * espejo `analytics.erp_supplier_payments`. Flujo `recibido → validado | rechazado`.
 */

export const PAYMENT_FILE_ROLES = ['comprobante', 'evidencia_1', 'evidencia_2'] as const;
export type PaymentFileRole = (typeof PAYMENT_FILE_ROLES)[number];
const TOLERANCIA = 1.0; // pesos: |ocr_monto - pago_monto| <= 1 → cuadra (redondeo)
const BANK_TOL = 1.0;   // pesos: |monto comprobante - cargo banco| para casar el movimiento
const BANK_DAYS_BEFORE = 1; // el cargo puede postearse el día del pago o 1 antes
const BANK_DAYS_AFTER = 6;  // …o unos días después

/** Clave de rastreo → alfanumérico (llave determinista de dedup). null si no hay. */
const normRef = (s: unknown): string | null => {
  const d = String(s ?? '').replace(/[^0-9A-Za-z]/g, '');
  return d || null;
};

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
  doc_prefix?: string; // XD2601 (transferencia) | XD2501 (cheque) — desambigua el folio
  files?: PaymentFile[];
  ocr?: Partial<SupplierPaymentFields> & { ocr_status?: string };
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
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 500));

    return this.tk.run(async (trx) => {
      // Claves de rastreo que aparecen en MÁS DE UN pago vivo → transferencia repetida.
      const dupRefs: string[] = await trx('finance.supplier_payment_proofs')
        .where('tenant_id', tenantId).whereNot('status', 'rechazado').whereNotNull('ref_norm')
        .groupBy('ref_norm')
        .havingRaw(`count(distinct doc_prefix || ' ' || sucursal || '/' || folio) > 1`)
        .pluck('ref_norm');
      const dupSet = new Set(dupRefs);

      const dep = trx('finance.supplier_payment_proofs')
        .select('sucursal', 'doc_prefix', 'folio')
        .count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .select(trx.raw(`bool_or(monto_match) AS any_match`))
        .select(trx.raw(`bool_or(cuenta_propia = false) AS cuenta_ajena`))
        .select(trx.raw(`array_remove(array_agg(DISTINCT ref_norm) FILTER (WHERE status <> 'rechazado'), NULL) AS refs`))
        .groupBy('sucursal', 'doc_prefix', 'folio')
        .as('d');

      const b = trx('analytics.erp_supplier_payments as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.doc_prefix', 'd.doc_prefix').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId)
        .select(
          'c.sucursal', 'c.folio', 'c.doc_prefix', 'c.metodo_pago', 'c.pago_date', 'c.proveedor_code', 'c.proveedor_nombre',
          'c.proveedor_rfc', 'c.concepto', trx.raw('c.monto::numeric AS monto'),
          trx.raw('COALESCE(d.n, 0)::int AS deposits'),
          trx.raw('d.last_id AS deposit_id'),
          trx.raw('d.last_status AS deposit_status'),
          trx.raw('COALESCE(d.any_match, false) AS monto_match'),
          trx.raw('COALESCE(d.cuenta_ajena, false) AS cuenta_ajena'),
          trx.raw('d.refs AS refs'),
        )
        .orderBy('c.pago_date', 'desc')
        .orderBy('c.folio', 'desc')
        .limit(limit);

      if (q.from) b.where('c.pago_date', '>=', q.from);
      if (q.to) b.where('c.pago_date', '<=', q.to);
      if (q.estado === 'pendiente') b.whereRaw('d.n IS NULL');
      if (q.estado === 'con_comprobante') b.whereRaw('d.n > 0');
      if (q.estado === 'validado') b.whereRaw(`d.last_status = 'validado'`);
      applySmartSearch(b, q.search, {
        columns: ['c.proveedor_nombre', 'c.proveedor_code', 'c.proveedor_rfc', 'c.folio'],
        numeric: ['c.monto'],
      });

      const rows = (await b).map((r: any) => {
        const refs: string[] = Array.isArray(r.refs) ? r.refs : [];
        const refDup = refs.some((x) => dupSet.has(x));
        const cuentaAjena = r.cuenta_ajena === true;
        const { refs: _drop, ...rest } = r;
        return { ...rest, monto: Number(r.monto), cuenta_ajena: cuentaAjena, ref_dup: refDup, alerta: cuentaAjena || refDup };
      });

      const kpiBase = trx('analytics.erp_supplier_payments as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.doc_prefix', 'd.doc_prefix').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId);
      if (q.from) kpiBase.where('c.pago_date', '>=', q.from);
      if (q.to) kpiBase.where('c.pago_date', '<=', q.to);
      const [k] = await kpiBase.select(
        trx.raw('COUNT(*)::int AS pagos'),
        trx.raw('COUNT(d.n)::int AS con_comprobante'),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='validado')::int AS validados`),
        trx.raw('COALESCE(SUM(c.monto::numeric) FILTER (WHERE d.n IS NULL), 0)::numeric AS monto_pendiente'),
        trx.raw('COUNT(*) FILTER (WHERE d.cuenta_ajena)::int AS cuentas_ajenas'),
      );

      return {
        kpis: {
          pagos: Number(k.pagos), con_comprobante: Number(k.con_comprobante),
          validados: Number(k.validados), monto_pendiente: Number(k.monto_pendiente),
          cuentas_ajenas: Number(k.cuentas_ajenas), refs_duplicadas: dupSet.size,
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

  /** Corre OCR sobre el comprobante de pago a proveedor (imagen/PDF). Preview, no guarda. */
  async runOcr(dataUri: string): Promise<SupplierPaymentFields & { ocr_status: string }> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const { mediaType, base64 } = this.parseDataUri(dataUri);
    if (!process.env.ANTHROPIC_API_KEY) {
      return { monto: null, fecha: null, concepto: null, cuenta_origen: null, cuenta_destino: null, beneficiario: null, clave_rastreo: null, banco_destino: null, metodo: null, ocr_status: 'sin_key' };
    }
    const fields = await this.ocr.extractSupplierPayment(base64, mediaType);
    const any = fields.monto != null || fields.fecha || fields.concepto || fields.clave_rastreo;
    return { ...fields, ocr_status: any ? 'ok' : 'ilegible' };
  }

  /** Crea el registro de evidencia ligado al pago Kepler. Calcula `monto_match`. */
  async attach(dto: AttachPaymentDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const sucursal = (dto.sucursal || '').trim();
    const folio = (dto.folio || '').trim();
    const docPrefix = (dto.doc_prefix || '').trim();
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!sucursal || !folio) throw new BadRequestException('sucursal y folio del pago requeridos');
    if (!files.length) throw new BadRequestException('se requiere al menos el comprobante');

    return this.tk.run(async (trx) => {
      const pagoQ = trx('analytics.erp_supplier_payments')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), sucursal, folio });
      if (docPrefix) pagoQ.where('doc_prefix', docPrefix); // desambigua transferencia vs cheque (folio compartido)
      const pago = await pagoQ.first('doc_prefix', 'metodo_pago', 'proveedor_nombre', 'proveedor_rfc', 'pago_date', trx.raw('monto::numeric AS monto'));
      if (!pago) throw new BadRequestException(`pago ${sucursal}/${folio} no existe en el espejo de Kepler`);

      const o = dto.ocr || {};
      const pagoMonto = Number(pago.monto) || 0;
      const ocrMonto = o.monto != null ? Number(o.monto) : null;
      const montoMatch = ocrMonto != null ? Math.abs(ocrMonto - pagoMonto) <= TOLERANCIA : null;

      // Control: ¿el pago salió de una cuenta de banco PROPIA? (cuenta de origen/retiro)
      const tails = await this.ownBankTails(trx);
      const cuentaPropia = this.isOwnAccount(o.cuenta_origen, tails);

      // Control: ¿la clave de rastreo ya está en otro comprobante vivo? (transferencia repetida)
      const ref = normRef(o.clave_rastreo);
      const refOtros = ref
        ? await trx('finance.supplier_payment_proofs')
            .where('ref_norm', ref)
            .whereNot('status', 'rechazado')
            .whereNot((qb: any) => { qb.where('sucursal', sucursal).andWhere('doc_prefix', pago.doc_prefix).andWhere('folio', folio); })
            .distinct('sucursal', 'doc_prefix', 'folio')
            .then((rs: any[]) => rs.map((r) => `${r.doc_prefix} ${r.sucursal}/${r.folio}`))
        : [];

      const [row] = await trx('finance.supplier_payment_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          sucursal, folio,
          doc_prefix: pago.doc_prefix || docPrefix || null,
          metodo_pago: pago.metodo_pago || null,
          proveedor_nombre: pago.proveedor_nombre || null,
          proveedor_rfc: pago.proveedor_rfc || null,
          pago_date: pago.pago_date || null,
          pago_monto: pagoMonto,
          files: JSON.stringify(files),
          ocr_monto: ocrMonto,
          ocr_fecha: o.fecha || null,
          ocr_banco: o.banco_destino || null,
          ocr_cuenta_dest: o.cuenta_destino || null,
          ocr_cuenta_origen: o.cuenta_origen || null,
          ocr_concepto: o.concepto || null,
          ocr_referencia: o.clave_rastreo || null,
          ocr_ordenante: o.beneficiario || null,
          ocr_metodo: o.metodo || null,
          ocr_raw: o ? JSON.stringify(o) : null,
          ocr_status: (o.ocr_status as string) || 'manual',
          monto_match: montoMatch,
          cuenta_propia: cuentaPropia,
          comentarios: (dto.comentarios || '').trim() || null,
          created_by: actor || null,
        })
        .returning(['id', 'sucursal', 'folio', 'status', 'monto_match']);
      this.logger.log(`comprobante adjunto a pago ${sucursal}/${folio} (match=${montoMatch}, cuenta_propia=${cuentaPropia}, ref_dup=${refOtros.length}) por ${actor || '?'}`);
      return { ...row, cuenta_propia: cuentaPropia, ref_duplicada: refOtros.length > 0, ref_otros: refOtros };
    });
  }

  /** Detalle: el pago + sus comprobantes adjuntos (con flags de control + three-way). */
  async detail(sucursal: string, folio: string, docPrefix?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const dp = (docPrefix || '').trim();
    return this.tk.run(async (trx) => {
      const pagoQ = trx('analytics.erp_supplier_payments')
        .where({ tenant_id: tenantId, sucursal, folio });
      if (dp) pagoQ.where('doc_prefix', dp);
      const pago = await pagoQ
        .first('sucursal', 'folio', 'doc_prefix', 'metodo_pago', 'pago_date', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc', 'concepto', trx.raw('monto::numeric AS monto'));
      if (!pago) throw new BadRequestException('pago no encontrado');
      const depQ = trx('finance.supplier_payment_proofs').where({ sucursal, folio });
      if (dp) depQ.where('doc_prefix', dp);
      const deposits = await depQ
        .orderBy('created_at', 'desc')
        .select('id', 'files', trx.raw('ocr_monto::numeric AS ocr_monto'), 'ocr_fecha', 'ocr_banco', 'ocr_cuenta_dest',
          'ocr_cuenta_origen', 'ocr_concepto', 'ocr_referencia', 'ocr_ordenante', 'ocr_metodo', 'ocr_status',
          'monto_match', 'cuenta_propia', 'ref_norm', 'status',
          'comentarios', 'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');

      // referencia duplicada (misma clave de rastreo en otro pago)
      const refs = deposits.map((d: any) => d.ref_norm).filter(Boolean)
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
      const otrosPorRef: Record<string, string[]> = {};
      if (refs.length) {
        const otros = await trx('finance.supplier_payment_proofs')
          .whereIn('ref_norm', refs).whereNot('status', 'rechazado')
          .whereNot((qb: any) => { qb.where('sucursal', sucursal).andWhere('folio', folio).andWhere('doc_prefix', pago.doc_prefix); })
          .distinct('ref_norm', 'sucursal', 'doc_prefix', 'folio')
          .select('ref_norm', 'sucursal', 'doc_prefix', 'folio');
        for (const r of otros) (otrosPorRef[r.ref_norm] ||= []).push(`${r.doc_prefix} ${r.sucursal}/${r.folio}`);
      }

      // three-way: conciliación persistida + candidatos de cargo en banco
      const matched = await this.linkedBankMovements(trx, pago.doc_prefix, sucursal, folio);
      const conciliado = matched.length > 0;

      // descuentos/apoyos que explican el delta factura vs pago (X-D-40/X-D-55 del proveedor)
      const adjustments = await this.relatedAdjustments(trx, pago);

      const enriched = [] as any[];
      for (const d of deposits) {
        const otros = d.ref_norm ? otrosPorRef[d.ref_norm] || [] : [];
        const cand = conciliado ? { estado: 'confirmado' as const, movimientos: [] } : await this.bankMatch(trx, {
          cuenta_origen: d.ocr_cuenta_origen,
          monto: d.ocr_monto != null ? Number(d.ocr_monto) : Number(pago.monto),
          fecha: d.ocr_fecha || pago.pago_date,
        });
        enriched.push({
          ...d, ref_duplicada: otros.length > 0, ref_otros: otros,
          banco: { conciliado, estado: cand.estado, matched, candidatos: cand.movimientos },
        });
      }
      return { pago: { ...pago, monto: Number(pago.monto) }, deposits: enriched, adjustments };
    });
  }

  /**
   * Descuentos y apoyos del proveedor que explican por qué el banco pagó ≠ factura:
   * notas de crédito (X-D-55) y devoluciones de compra (X-D-40) de Kepler
   * (`analytics.erp_purchase_adjustments`, RE.10). Liga por `proveedor_code` (fallback
   * nombre) en una ventana alrededor de la fecha del pago; marca `factura_match` cuando
   * la factura de la nota coincide con algún folio del concepto del pago. NO es cuadre al
   * peso — es el contexto que /compras/descuentos ya contabiliza. Read-only.
   */
  private async relatedAdjustments(trx: any, pago: any) {
    const tenantId = this.tenantCtx.requireTenantId();
    const code = (pago.proveedor_code || '').trim();
    const nombre = (pago.proveedor_nombre || '').trim();
    if (!code && !nombre) return { rows: [], total_monto: 0, total_factura: 0, deep_link_q: null };
    // folios de factura del concepto del pago ("F 906 907" → ['906','907'])
    const tokens = String(pago.concepto || '').match(/\d{2,}/g) || [];
    const WINDOW = 60; // días alrededor del pago (la nota puede emitirse antes o después)
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const q = trx('analytics.erp_purchase_adjustments')
      .where('tenant_id', tenantId)
      .select('doctype', 'adjustment_date', 'factura_ref', 'motivo', 'categoria',
        trx.raw('monto::numeric AS monto'))
      .orderBy('adjustment_date', 'desc')
      .limit(25);
    if (code) q.where('proveedor_code', code);
    else q.whereRaw('proveedor_nombre ILIKE ?', [nombre]);
    if (pago.pago_date) {
      const base = new Date(pago.pago_date);
      if (!isNaN(base.getTime())) {
        const from = new Date(base); from.setDate(from.getDate() - WINDOW);
        const to = new Date(base); to.setDate(to.getDate() + WINDOW);
        q.whereBetween('adjustment_date', [iso(from), iso(to)]);
      }
    }
    const rows = (await q).map((r: any) => {
      const hay = `${r.factura_ref || ''} ${r.motivo || ''}`;
      const facturaMatch = tokens.length > 0 && tokens.some((t) => hay.includes(t));
      return { ...r, monto: Number(r.monto) || 0, factura_match: facturaMatch };
    }).sort((a: any, b: any) => Number(b.factura_match) - Number(a.factura_match));
    const total = rows.reduce((s: number, r: any) => s + r.monto, 0);
    const totalFactura = rows.filter((r: any) => r.factura_match).reduce((s: number, r: any) => s + r.monto, 0);
    return { rows, total_monto: total, total_factura: totalFactura, deep_link_q: nombre || code };
  }

  /**
   * FICHA-FIRST — dado el OCR de un comprobante (monto + fecha + concepto), busca el
   * pago de Kepler que le corresponde. El `concepto` (folio de factura "F 451") casa
   * contra el `concepto` del pago; el monto es la señal fuerte. Prioriza sin comprobante.
   */
  async matchPaymentsByOcr(q: { monto?: number; fecha?: string; concepto?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const target = q.monto != null ? Number(q.monto) : NaN;
    if (!isFinite(target) || target <= 0) return { pagos: [] };
    const limit = Math.min(20, Math.max(1, Number(q.limit) || 12));
    // tokens del concepto (folios de factura): "F 906 907 908" → ['906','907','908']
    const tokens = String(q.concepto || '').match(/\d{2,}/g) || [];
    return this.tk.run(async (trx) => {
      const dep = trx('finance.supplier_payment_proofs')
        .select('sucursal', 'doc_prefix', 'folio').count('* as n')
        .groupBy('sucursal', 'doc_prefix', 'folio').as('d');
      const b = trx('analytics.erp_supplier_payments as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.doc_prefix', 'd.doc_prefix').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId)
        .whereRaw('c.monto BETWEEN ? AND ?', [target - BANK_TOL, target + BANK_TOL])
        .select('c.sucursal', 'c.folio', 'c.doc_prefix', 'c.metodo_pago', 'c.pago_date', 'c.proveedor_code',
          'c.proveedor_nombre', 'c.proveedor_rfc', 'c.concepto', trx.raw('c.monto::numeric AS monto'),
          trx.raw('COALESCE(d.n,0)::int AS deposits'))
        .orderByRaw('COALESCE(d.n,0) ASC')
        .orderBy('c.pago_date', 'desc')
        .limit(limit);
      const base = q.fecha ? new Date(q.fecha) : null;
      if (base && !isNaN(base.getTime())) {
        const from = new Date(base); from.setDate(from.getDate() - 7);
        const to = new Date(base); to.setDate(to.getDate() + 7);
        b.whereBetween('c.pago_date', [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
      }
      const pagos = (await b).map((r: any) => {
        // boost: el concepto del pago contiene alguno de los folios de la ficha
        const conc = String(r.concepto || '');
        const conceptoMatch = tokens.length > 0 && tokens.some((t) => conc.includes(t));
        return { ...r, monto: Number(r.monto), concepto_match: conceptoMatch };
      }).sort((a: any, b2: any) => Number(b2.concepto_match) - Number(a.concepto_match));
      return { pagos };
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

  /**
   * Three-way match: busca en el estado de cuenta (finance.bank_movements) el CARGO
   * real (amount_out) de este pago — por cuenta de origen propia + monto (tol $1) +
   * fecha cercana. Prueba que el dinero SALIÓ. Read-only.
   */
  private async bankMatch(
    trx: any,
    dep: { cuenta_origen?: string | null; monto?: number | null; fecha?: string | Date | null },
  ): Promise<{ estado: 'confirmado' | 'multiple' | 'sin_match' | 'sin_dato'; movimientos: any[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const target = dep.monto != null ? Number(dep.monto) : NaN;
    if (!isFinite(target) || target <= 0 || !dep.fecha) return { estado: 'sin_dato', movimientos: [] };
    const base = new Date(dep.fecha as any);
    if (isNaN(base.getTime())) return { estado: 'sin_dato', movimientos: [] };
    const from = new Date(base); from.setDate(from.getDate() - BANK_DAYS_BEFORE);
    const to = new Date(base); to.setDate(to.getDate() + BANK_DAYS_AFTER);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const acctId = await this.findOwnAccountId(trx, dep.cuenta_origen);

    const q = trx('finance.bank_movements as m')
      .join('finance.bank_accounts as a', 'a.id', 'm.bank_account_id')
      .leftJoin('finance.movement_categories as cat', 'cat.id', 'm.category_id')
      .where('m.tenant_id', tenantId)
      .whereRaw('m.amount_out BETWEEN ? AND ?', [target - BANK_TOL, target + BANK_TOL])
      .whereBetween('m.movement_date', [iso(from), iso(to)])
      .select('m.id', 'm.movement_date', trx.raw('m.amount_out::numeric AS amount_out'),
        'm.concept', 'a.bank', 'a.account_label', trx.raw('cat.code AS categoria'))
      .orderBy('m.movement_date', 'asc').limit(6);
    if (acctId) q.where('m.bank_account_id', acctId);
    const movimientos = (await q).map((r: any) => ({ ...r, amount_out: Number(r.amount_out) }));
    const estado = movimientos.length === 1 ? 'confirmado' : movimientos.length > 1 ? 'multiple' : 'sin_match';
    return { estado, movimientos };
  }

  /** Cargos ya ligados a este pago (bank_recon_matches, kepler_doc_tipo = doc_prefix). */
  private async linkedBankMovements(trx: any, docPrefix: string, sucursal: string, folio: string): Promise<any[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    const recon = await trx('finance.bank_recon_matches')
      .where({ tenant_id: tenantId, kepler_doc_tipo: docPrefix, kepler_doc_folio: folio, kepler_sucursal: sucursal })
      .select('bank_movement_id', 'match_type', 'matched_by', 'created_at', trx.raw('kepler_amount::numeric AS kepler_amount'));
    if (!recon.length) return [];
    const byId = new Map(recon.map((r: any) => [r.bank_movement_id, r]));
    const movs = await trx('finance.bank_movements as m')
      .join('finance.bank_accounts as a', 'a.id', 'm.bank_account_id')
      .where('m.tenant_id', tenantId)
      .whereIn('m.id', recon.map((r: any) => r.bank_movement_id))
      .select('m.id', 'm.movement_date', trx.raw('m.amount_out::numeric AS amount_out'), 'm.concept', 'a.bank', 'a.account_label');
    return movs.map((m: any) => {
      const r: any = byId.get(m.id) || {};
      return { ...m, amount_out: Number(m.amount_out), match_type: r.match_type, matched_by: r.matched_by, matched_at: r.created_at, kepler_amount: r.kepler_amount != null ? Number(r.kepler_amount) : null };
    });
  }

  /** El revisor confirma que un cargo del banco corresponde a este pago. Persiste en CB. */
  async confirmBank(proofId: string, bankMovementId: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    if (!bankMovementId) throw new BadRequestException('bank_movement_id requerido');
    return this.tk.run(async (trx) => {
      const p = await trx('finance.supplier_payment_proofs').where({ id: proofId })
        .first('sucursal', 'doc_prefix', 'folio', trx.raw('pago_monto::numeric AS pago_monto'));
      if (!p) throw new BadRequestException('comprobante no encontrado');
      const mov = await trx('finance.bank_movements').where({ id: bankMovementId }).first('id', trx.raw('amount_out::numeric AS amount_out'));
      if (!mov) throw new BadRequestException('movimiento bancario no encontrado');
      const pagoMonto = Number(p.pago_monto) || 0;
      const matchType = Math.abs(Number(mov.amount_out) - pagoMonto) <= BANK_TOL ? 'exact' : 'manual';
      await trx('finance.bank_recon_matches')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          bank_movement_id: bankMovementId,
          kepler_sucursal: p.sucursal, kepler_doc_tipo: p.doc_prefix, kepler_doc_folio: p.folio,
          kepler_cuenta: '102', kepler_amount: pagoMonto,
          match_type: matchType, match_confidence: matchType === 'exact' ? 1 : 0.5, matched_by: actor || null,
        })
        .onConflict(['tenant_id', 'bank_movement_id', 'kepler_doc_tipo', 'kepler_doc_folio'])
        .merge({ kepler_amount: pagoMonto, match_type: matchType, matched_by: actor || null });
      await trx('finance.bank_movements').where({ id: bankMovementId }).update({ recon_status: 'matched', updated_at: trx.fn.now() });
      this.logger.log(`pago ${p.doc_prefix} ${p.sucursal}/${p.folio} conciliado con cargo ${bankMovementId} (${matchType}) por ${actor || '?'}`);
      return { ok: true, pago: `${p.doc_prefix} ${p.sucursal}/${p.folio}`, bank_movement_id: bankMovementId, match_type: matchType };
    });
  }

  /** Deshace la conciliación pago↔cargo. */
  async unlinkBank(proofId: string, bankMovementId: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const p = await trx('finance.supplier_payment_proofs').where({ id: proofId }).first('sucursal', 'doc_prefix', 'folio');
      if (!p) throw new BadRequestException('comprobante no encontrado');
      await trx('finance.bank_recon_matches')
        .where({ kepler_doc_tipo: p.doc_prefix, kepler_doc_folio: p.folio, kepler_sucursal: p.sucursal, bank_movement_id: bankMovementId }).del();
      const [rest] = await trx('finance.bank_recon_matches').where({ bank_movement_id: bankMovementId }).count('* as n');
      if (Number(rest.n) === 0) await trx('finance.bank_movements').where({ id: bankMovementId }).update({ recon_status: 'pending', updated_at: trx.fn.now() });
      return { ok: true };
    });
  }

  /** ID de la cuenta de banco propia cuyo `account_label` es sufijo de la cuenta de origen. */
  private async findOwnAccountId(trx: any, cuenta?: string | null): Promise<string | null> {
    const digits = String(cuenta ?? '').replace(/\D/g, '');
    if (!digits) return null;
    const accts = await trx('finance.bank_accounts')
      .where({ tenant_id: this.tenantCtx.requireTenantId(), kind: 'bank', active: true })
      .whereRaw(`account_label ~ '^[0-9]{3,}$'`).select('id', 'account_label');
    const hit = accts.find((a: any) => digits.endsWith(a.account_label));
    return hit ? hit.id : null;
  }

  /** Etiquetas de cuenta (dígitos finales) de las cuentas de banco propias. */
  private async ownBankTails(trx: any): Promise<string[]> {
    return trx('finance.bank_accounts')
      .where({ tenant_id: this.tenantCtx.requireTenantId(), kind: 'bank', active: true })
      .whereRaw(`account_label ~ '^[0-9]{3,}$'`).pluck('account_label');
  }

  /** ¿La cuenta de origen del pago termina en una cuenta propia? null = no verificable. */
  private isOwnAccount(cuenta: unknown, tails: string[]): boolean | null {
    const digits = String(cuenta ?? '').replace(/\D/g, '');
    if (!digits || !tails.length) return null;
    return tails.some((t) => t.length >= 3 && digits.endsWith(t));
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
