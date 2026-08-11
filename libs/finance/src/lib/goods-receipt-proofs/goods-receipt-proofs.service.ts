import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { TenantKnexService, TenantContextService, CloudinaryService, ObjectStorageService, applySmartSearch } from '@megadulces/platform-core';
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

export interface ReceiptFile {
  role: string; url: string; public_id?: string; kind?: string; name?: string;
  // Por-archivo (RE.5.2): hash del contenido (anti-hoja-duplicada) + OCR propio (cada hoja se lee).
  sha256?: string;
  ocr_folio?: string | null;
  ocr_total?: number | null;
  ocr_fecha?: string | null;
  ocr_rfc?: string | null;
}

/** Coincidencia de duplicado (misma hoja por hash, o folio ya subido). */
export interface DuplicateHit { reason: 'file' | 'folio'; sucursal: string; folio: string; proveedor?: string | null; }

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
    private readonly storage: ObjectStorageService,
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

  /**
   * FOTO-PRIMERO — dado el OCR de la **Aplica Orden Entrada** (folio + total), busca la(s)
   * entrada(s) de Kepler que le corresponden, para enlazar sin elegir a mano. Match por
   * FOLIO (tolerante a ceros: "8625"="0008625") ∪ por MONTO (±$2). Si `search` viene (pick
   * manual), busca por proveedor/folio/OC. Prioriza las que aún NO tienen comprobante.
   */
  async matchByOcr(q: { folio?: string; total?: number; fecha?: string; search?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(30, Math.max(1, Number(q.limit) || 15));
    const folio = (q.folio || '').trim();
    const total = q.total != null && isFinite(Number(q.total)) ? Number(q.total) : null;
    const search = (q.search || '').trim();
    if (!folio && total == null && !search) return { entradas: [] as any[] };
    // candidatos de folio (igualdad tolerante a ceros; dedup filter+indexOf, NO Set-spread)
    const cands: string[] = [];
    if (folio) {
      const stripped = folio.replace(/^0+/, '') || folio;
      const forms = [folio, stripped, stripped.padStart(6, '0'), stripped.padStart(7, '0'), stripped.padStart(8, '0')];
      for (const v of forms) if (v && cands.indexOf(v) < 0) cands.push(v);
    }
    return this.tk.run(async (trx) => {
      const dep = trx('finance.goods_receipt_proofs')
        .select('sucursal', 'folio').count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .groupBy('sucursal', 'folio').as('d');
      const sel = () => trx('analytics.erp_goods_receipts as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId)
        .select('c.sucursal', 'c.folio', 'c.receipt_date', 'c.proveedor_code', 'c.proveedor_nombre',
          'c.proveedor_rfc', 'c.oc_folio', 'c.concepto', trx.raw('c.monto::numeric AS monto'),
          trx.raw('COALESCE(d.n,0)::int AS deposits'), trx.raw('d.last_id AS deposit_id'),
          trx.raw('d.last_status AS deposit_status'));
      const order = (qb: any) => qb.orderByRaw('COALESCE(d.n,0) ASC').orderBy('c.receipt_date', 'desc').limit(limit);
      let rows: any[] = [];
      if (search) {
        const b = sel();
        applySmartSearch(b, search, { columns: ['c.proveedor_nombre', 'c.proveedor_code', 'c.proveedor_rfc', 'c.folio', 'c.oc_folio'], numeric: ['c.monto'] });
        rows = await order(b);
      } else {
        // FOLIO primero (preciso, evita falsos positivos). Solo si NO hay match por folio, cae a MONTO (±$2).
        if (cands.length) rows = await order(sel().whereIn('c.folio', cands));
        if (!rows.length && total != null) rows = await order(sel().whereRaw('c.monto BETWEEN ? AND ?', [total - 2, total + 2]));
      }
      const entradas = rows.map((r: any) => ({
        ...r, monto: Number(r.monto), monto_match: false,
        folio_match: cands.length ? cands.indexOf(String(r.folio).trim()) >= 0 : false,
        total_match: total != null ? Math.abs(Number(r.monto) - total) <= 2 : false,
      }));
      return { entradas };
    });
  }

  /** Sube UN archivo (remisión/factura/evidencia) a Cloudinary. Imagen o PDF. */
  async uploadFile(dataUri: string, role = 'remision'): Promise<ReceiptFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!RECEIPT_FILE_ROLES.includes(role as ReceiptFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      // Solo PDF → Railway Bucket (privado). Se guarda la KEY en public_id; la URL de lectura
      // es prefirmada al mostrar (signFiles), no permanente.
      const f = await this.storage.putPdf(dataUri, `finance/${tenantId}/goods-receipts`);
      // url = key (placeholder truthy para no romper filtros `f.url`); la lectura la firma (signFiles).
      return { role, url: f.key, public_id: f.key, kind: f.kind };
    } catch (e: any) {
      if (e?.status === 400) throw e; // "Solo PDF" / "no configurado" → mensaje directo al usuario
      this.logger.error(`fallo subiendo remisión (${role}): ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /**
   * Corre OCR sobre CUALQUIER hoja (imagen/PDF) — ahora cada archivo se lee, no solo la ★.
   * Además detecta DUPLICADOS: la misma hoja (hash de contenido) o un folio de remisión/factura
   * ya subido antes. Preview, no guarda. `role` afina el dedup de folio (solo remisión/factura).
   */
  async runOcr(dataUri: string, role?: string): Promise<RemisionFields & { ocr_status: string; sha256: string; duplicate: DuplicateHit | null }> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const { mediaType, base64 } = this.parseDataUri(dataUri);
    const sha256 = createHash('sha256').update(base64).digest('hex');
    let fields: RemisionFields;
    let ocr_status: string;
    if (!process.env.ANTHROPIC_API_KEY) {
      fields = { folio: null, fecha: null, proveedor: null, rfc: null, subtotal: null, iva: null, total: null };
      ocr_status = 'sin_key';
    } else {
      fields = await this.ocr.extractRemision(base64, mediaType);
      const any = fields.total != null || fields.folio || fields.proveedor || fields.rfc;
      ocr_status = any ? 'ok' : 'ilegible';
    }
    // El dedup por FOLIO aplica al documento del proveedor (remisión/factura); el de HASH, a cualquier hoja.
    const checkFolio = !role || role === 'remision' || role === 'factura';
    const duplicate = await this.findDuplicate({ sha256, folio: checkFolio ? fields.folio : null, rfc: fields.rfc });
    return { ...fields, ocr_status, sha256, duplicate };
  }

  /**
   * ¿Esta hoja ya se subió? Por HASH de contenido (misma imagen/PDF) o por FOLIO de
   * remisión/factura ya capturado. Devuelve la entrada donde ya vive, o null.
   */
  private async findDuplicate(q: { sha256?: string | null; folio?: string | null; rfc?: string | null }): Promise<DuplicateHit | null> {
    const sha = (q.sha256 || '').trim();
    const folio = (q.folio || '').trim().toLowerCase();
    const rfc = (q.rfc || '').trim().toLowerCase();
    const folioOk = folio.length >= 3 && /[^0]/.test(folio); // evita folios triviales ("1", "000")
    if (!sha && !folioOk) return null;
    return this.tk.run(async (trx) => {
      if (sha) {
        const hit = await trx.raw(
          `SELECT sucursal, folio, proveedor_nombre
             FROM finance.goods_receipt_proofs
            WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(files,'[]'::jsonb)) e WHERE e->>'sha256' = ?)
            ORDER BY created_at DESC LIMIT 1`, [sha]);
        const r = hit.rows?.[0];
        if (r) return { reason: 'file' as const, sucursal: r.sucursal, folio: r.folio, proveedor: r.proveedor_nombre };
      }
      if (folioOk) {
        const hit = await trx.raw(
          `SELECT sucursal, folio, proveedor_nombre
             FROM finance.goods_receipt_proofs p
            WHERE (
                    lower(btrim(COALESCE(p.ocr_folio,''))) = ?
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.files,'[]'::jsonb)) e
                             WHERE (e->>'role') IN ('remision','factura')
                               AND lower(btrim(COALESCE(e->>'ocr_folio',''))) = ?)
                  )
              AND ( ? = '' OR lower(btrim(COALESCE(p.proveedor_rfc,''))) IN ('', ?) )
            ORDER BY p.created_at DESC LIMIT 1`, [folio, folio, rfc, rfc]);
        const r = hit.rows?.[0];
        if (r) return { reason: 'folio' as const, sucursal: r.sucursal, folio: r.folio, proveedor: r.proveedor_nombre };
      }
      return null;
    });
  }

  /** Crea el registro de evidencia ligado a la entrada Kepler. Calcula `monto_match`. */
  async attach(dto: AttachReceiptDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const sucursal = (dto.sucursal || '').trim();
    const folio = (dto.folio || '').trim();
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!sucursal || !folio) throw new BadRequestException('sucursal y folio de la entrada requeridos');
    if (!files.length) throw new BadRequestException('se requiere al menos la remisión/factura');

    // Backstop server-side: rechaza si alguna hoja ya se había subido (misma imagen o folio ya capturado).
    for (const f of files) {
      const dup = await this.findDuplicate({
        sha256: f.sha256,
        folio: f.role === 'remision' || f.role === 'factura' ? f.ocr_folio : null,
        rfc: f.ocr_rfc,
      });
      if (dup) {
        throw new BadRequestException(
          dup.reason === 'file'
            ? `Una de las hojas ya se había subido (entrada ${dup.sucursal}/${dup.folio}). Quitala.`
            : `El folio ${f.ocr_folio} ya se subió (entrada ${dup.sucursal}/${dup.folio}${dup.proveedor ? ' · ' + dup.proveedor : ''}). Quitá esa hoja.`,
        );
      }
    }

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
      // URL de lectura prefirmada (bucket privado). Legacy Cloudinary (url http) se deja como está.
      const depSigned = await Promise.all(deposits.map(async (d: any) => {
        const files = typeof d.files === 'string' ? JSON.parse(d.files || '[]') : (d.files || []);
        return { ...d, files: await this.storage.signFiles(files) };
      }));
      return { entrada: { ...entrada, monto: Number(entrada.monto) }, lineas, deposits: depSigned };
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
