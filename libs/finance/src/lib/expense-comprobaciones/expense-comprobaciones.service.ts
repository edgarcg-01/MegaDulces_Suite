import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService, ObjectStorageService, LlmExtractorService, KeplerGastosFields, ExpenseReceiptFields } from '@megadulces/platform-core';

/**
 * GX.8 — Comprobación de Gastos (2ª etapa). Captura de la comprobación de un gasto,
 * ligada por folio al gasto de Kepler (XA1001), con su archivo comprobatorio. Vive
 * en `finance.expense_comprobaciones`; NO escribe a Kepler (se concilia por folio).
 * Al crear resuelve el `folio_solicitud` (XA1501) del gasto para el seguimiento
 * cruzado con /finanzas/solicitudes. Flujo `recibida → validada | rechazada`.
 */

export const COMPROBACION_FILE_ROLES = ['comprobacion', 'evidencia_1', 'evidencia_2'] as const;
export type ComprobacionFileRole = (typeof COMPROBACION_FILE_ROLES)[number];
const REQUIRED_ROLES: ComprobacionFileRole[] = ['comprobacion'];

export interface ComprobacionFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

export interface CreateComprobacionDto {
  solicitante?: string;
  departamento?: string;
  departamento_code?: string;
  sucursal?: string;
  folio_gasto?: string;
  fecha_comprobacion?: string;
  folio_comprobacion?: string;
  proveedor?: string;
  importe?: number;
  comentarios?: string;
  files?: ComprobacionFile[];
  // Validación por vision de la foto del gasto (preview vía validate-photo):
  monto_ocr?: number | null;    // total leído de la foto
  subtotal_ocr?: number | null; // subtotal leído (se compara si el total no cuadra)
  receipt_legible?: boolean;    // false si la foto era ilegible / no era comprobante
}

/** Resultado de validar la foto del gasto contra el importe del gasto Kepler. */
export interface ValidatePhotoResult extends ExpenseReceiptFields {
  ocr_status: 'ok' | 'ilegible' | 'sin_key';
  importe_esperado: number;
  monto_ocr: number | null;   // el importe usado para cuadrar (total, o subtotal si el total no cuadra)
  monto_match: boolean;       // cuadró contra el importe esperado
  diff: number | null;        // |monto_ocr − importe_esperado|
}

export interface ListComprobacionesQuery {
  status?: string;
  folio_gasto?: string;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ListGastosQuery {
  estado?: 'pendiente' | 'comprobada' | 'validada' | string;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
}

@Injectable()
export class ExpenseComprobacionesService {
  private readonly logger = new Logger(ExpenseComprobacionesService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly storage: ObjectStorageService,
    private readonly ocr: LlmExtractorService,
  ) {}

  /** OCR del documento "Gastos" de Kepler (XA1001, imagen/PDF) → auto-rellena la captura. Preview. */
  async runOcr(dataUri: string): Promise<KeplerGastosFields & { ocr_status: string }> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const m = /^data:([^;,]+)[;,]/.exec(dataUri || '');
    const mediaType = (m ? m[1] : 'image/jpeg').toLowerCase();
    const base64 = dataUri.replace(/^data:[^,]*,/, '');
    const empty: KeplerGastosFields = { documento: null, folio: null, solicitante: null, proveedor_code: null, proveedor: null, a_nombre_de: null, autoriza: null, departamento: null, proyecto: null, cuenta: null, concepto: null, descripcion: null, moneda: null, fecha: null, fecha_pago: null, poliza: null, sucursal: null, comentarios: null, subtotal: null, iva: null, ieps: null, otro_impuesto: null, importe: null, anticipos: null };
    if (!process.env.ANTHROPIC_API_KEY) return { ...empty, ocr_status: 'sin_key' };
    const f = await this.ocr.extractKeplerGastos(base64, mediaType as any);
    const any = f.folio || f.importe != null || f.solicitante || f.proveedor;
    return { ...f, ocr_status: any ? 'ok' : 'ilegible' };
  }

  /** Tolerancia del cuadre: $1 o 1% del importe (lo mayor), para absorber redondeo/IVA. */
  private tolerancia(importe: number): number {
    return Math.max(1, Math.abs(importe) * 0.01);
  }

  /** ¿El monto leído de la foto cuadra contra el importe esperado del gasto? */
  private montoCuadra(esperado: number, total: number | null, subtotal: number | null): { match: boolean; usado: number | null; diff: number | null } {
    if (!(esperado > 0)) return { match: false, usado: total ?? subtotal, diff: null };
    const tol = this.tolerancia(esperado);
    for (const v of [total, subtotal]) {
      if (v != null && Number.isFinite(v)) {
        const d = Math.abs(v - esperado);
        if (d <= tol) return { match: true, usado: v, diff: d };
      }
    }
    const usado = total ?? subtotal;
    return { match: false, usado, diff: usado != null ? Math.abs(usado - esperado) : null };
  }

  /**
   * GX.8 (validación por vision) — Lee la FOTO/EVIDENCIA del gasto con Claude Vision
   * y la valida contra el importe del gasto Kepler (XA1001). Preview: el front la
   * llama al adjuntar la foto para mostrar "cuadra / en revisión" antes de enviar.
   */
  async validatePhoto(dataUri: string, importeEsperado: number): Promise<ValidatePhotoResult> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const esperado = Number(importeEsperado) || 0;
    const empty: ExpenseReceiptFields = { total: null, subtotal: null, iva: null, fecha: null, comercio: null, rfc: null, folio: null, legible: false };
    if (!process.env.ANTHROPIC_API_KEY) {
      return { ...empty, ocr_status: 'sin_key', importe_esperado: esperado, monto_ocr: null, monto_match: false, diff: null };
    }
    const m = /^data:([^;,]+)[;,]/.exec(dataUri || '');
    const mediaType = (m ? m[1] : 'image/jpeg').toLowerCase();
    const base64 = dataUri.replace(/^data:[^,]*,/, '');
    const f = await this.ocr.extractExpenseReceipt(base64, mediaType as any);
    const legible = f.legible && (f.total != null || f.subtotal != null);
    const { match, usado, diff } = this.montoCuadra(esperado, f.total, f.subtotal);
    return {
      ...f,
      ocr_status: legible ? 'ok' : 'ilegible',
      importe_esperado: esperado,
      monto_ocr: usado,
      monto_match: legible && match,
      diff,
    };
  }

  /**
   * Autocomplete del "Folio del Gasto": busca gastos de Kepler (XA1001) en el espejo
   * `analytics.expense_documents`. Devuelve folio + proveedor + importe + fecha + la
   * solicitud ligada (XA1501) para auto-rellenar la captura.
   */
  async searchGastos(search: string, limit = 20) {
    const tenantId = this.tenantCtx.requireTenantId();
    const term = (search || '').trim();
    if (term.length < 2) return [];
    const lim = Math.min(50, Math.max(1, Number(limit) || 20));
    return this.tk.run(async (trx) => {
      const s = `%${term}%`;
      const rows = await trx('analytics.expense_documents')
        .where('tenant_id', tenantId)
        .where('doc_tipo', 'XA1001')
        .andWhere((w: any) => w.whereILike('doc_folio', s).orWhereILike('beneficiario', s))
        .orderBy('fecha', 'desc')
        .limit(lim)
        .select('sucursal', 'doc_folio AS folio_gasto', 'fecha',
          'beneficiario AS proveedor', trx.raw('importe::numeric AS importe'),
          'solicitud_folio', 'area');
      return rows.map((r: any) => ({ ...r, importe: Number(r.importe) || 0 }));
    });
  }

  /** Sube UN archivo a Cloudinary (comprobación/evidencia). Uno por archivo (body chico). */
  async uploadFile(dataUri: string, role: string): Promise<ComprobacionFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!COMPROBACION_FILE_ROLES.includes(role as ComprobacionFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      const f = await this.storage.putFile(dataUri, `finance/${tenantId}/expense-comprobaciones`); // imagen o PDF (el doc Kepler suele fotografiarse)
      return { role, url: f.key, public_id: f.key, kind: f.kind };
    } catch (e: any) {
      if (e?.status === 400) throw e; // "no configurado" (faltan env S3_*)
      this.logger.error(`fallo subiendo ${role}: ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /** Alta de la comprobación (con los archivos ya subidos vía uploadFile). */
  async create(dto: CreateComprobacionDto, actor?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const req = (v?: string) => (v || '').trim();
    const solicitante = req(dto.solicitante) || actor || '';
    const departamento = req(dto.departamento);
    const folioGasto = req(dto.folio_gasto);
    const proveedor = req(dto.proveedor);
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!solicitante) throw new BadRequestException('solicitante requerido');
    if (!departamento) throw new BadRequestException('departamento requerido');
    if (!folioGasto) throw new BadRequestException('folio del gasto requerido');
    if (!proveedor) throw new BadRequestException('proveedor requerido');
    const roles = new Set(files.map((f) => f.role));
    for (const r of REQUIRED_ROLES) {
      if (!roles.has(r)) throw new BadRequestException(`falta el archivo obligatorio: ${r}`);
    }

    // Validación por vision: cuadra → validada (por Claude Vision); si no → revisión.
    const importe = Number(dto.importe) || 0;
    const legible = dto.receipt_legible !== false && (dto.monto_ocr != null || dto.subtotal_ocr != null);
    const { match, usado, diff } = this.montoCuadra(importe, dto.monto_ocr ?? null, dto.subtotal_ocr ?? null);
    const cuadra = legible && match;
    const fmt = (v: number | null) => (v == null ? '—' : `$${(Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    const status = cuadra ? 'validada' : 'revision';
    const revisionNota = cuadra ? null
      : (!legible ? 'Foto ilegible o sin lectura — validar a mano'
        : `Monto no cuadra: foto ${fmt(usado)} vs gasto ${fmt(importe)}${diff != null ? ` (Δ ${fmt(diff)})` : ''}`);

    return this.tk.run(async (trx) => {
      // Resuelve la solicitud (XA1501) del gasto para el seguimiento cruzado (best-effort).
      const gasto = await trx('analytics.expense_documents')
        .where({ tenant_id: tenantId, doc_tipo: 'XA1001', doc_folio: folioGasto })
        .first('solicitud_folio');
      const [row] = await trx('finance.expense_comprobaciones')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          solicitante, departamento, departamento_code: req(dto.departamento_code) || null,
          sucursal: req(dto.sucursal) || null,
          folio_gasto: folioGasto,
          folio_solicitud: (gasto && gasto.solicitud_folio) || null,
          fecha_comprobacion: dto.fecha_comprobacion || null,
          folio_comprobacion: req(dto.folio_comprobacion) || null,
          proveedor, importe,
          files: JSON.stringify(files),
          comentarios: req(dto.comentarios) || null,
          status,
          monto_ocr: usado,
          monto_match: legible ? match : null,
          revision_nota: revisionNota,
          validated_by: cuadra ? 'Claude Vision' : null,
          validated_at: cuadra ? trx.fn.now() : null,
          created_by: actor || null,
        })
        .returning(['id', 'folio_gasto', 'folio_solicitud', 'status']);
      this.logger.log(`comprobación gasto ${row.folio_gasto} → ${status}${cuadra ? '' : ` (${revisionNota})`} · ${files.length} archivos, por ${actor || '?'}`);
      return row;
    });
  }

  /** Bandeja + KPIs por estado. */
  async list(q: ListComprobacionesQuery) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    return this.tk.run(async (trx) => {
      const b = trx('finance.expense_comprobaciones')
        .select('id', 'solicitante', 'departamento', 'departamento_code', 'sucursal',
          'folio_gasto', 'folio_solicitud', 'fecha_comprobacion', 'folio_comprobacion', 'proveedor',
          trx.raw('importe::numeric AS importe'), trx.raw('monto_ocr::numeric AS monto_ocr'), 'monto_match', 'revision_nota',
          'files', 'comentarios', 'status',
          'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at')
        .orderBy('created_at', 'desc').limit(limit);
      if (q.status) b.where('status', q.status);
      if (q.folio_gasto) b.where('folio_gasto', q.folio_gasto.trim());
      if (q.from) b.where('created_at', '>=', q.from);
      if (q.to) b.where('created_at', '<=', `${q.to} 23:59:59`);
      if (q.search) {
        const s = `%${q.search.trim()}%`;
        b.where((w) => w.whereILike('proveedor', s).orWhereILike('folio_gasto', s)
          .orWhereILike('folio_comprobacion', s).orWhereILike('solicitante', s));
      }
      const rows = await Promise.all((await b).map(async (r: any) => ({
        ...r, importe: Number(r.importe), monto_ocr: r.monto_ocr == null ? null : Number(r.monto_ocr),
        files: await this.storage.signFiles(typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || [])), // URL prefirmada (bucket privado)
      })));

      const agg = await trx('finance.expense_comprobaciones').groupBy('status').select('status', trx.raw('COUNT(*)::int AS n'));
      const by = Object.fromEntries(agg.map((r: any) => [r.status, Number(r.n)]));
      return {
        kpis: { total: rows.length, recibidas: by['recibida'] || 0, validadas: by['validada'] || 0, rechazadas: by['rechazada'] || 0, en_revision: by['revision'] || 0 },
        rows,
      };
    });
  }

  /**
   * Lista los GASTOS de Kepler (XA1001, espejo `analytics.expense_documents`) con el
   * estado de su comprobación adjunta (LEFT JOIN a `finance.expense_comprobaciones` por
   * folio). Es la vista "manejada por gasto" (como Cobranza/Pagos/Entradas): el capturista
   * ve qué gastos faltan de comprobar. No escribe a Kepler.
   */
  async listGastos(q: ListGastosQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 500));
    return this.tk.run(async (trx) => {
      const comp = trx('finance.expense_comprobaciones')
        .select('folio_gasto')
        .count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .select(trx.raw(`(array_agg(folio_comprobacion ORDER BY created_at DESC))[1] AS last_folio_comp`))
        .select(trx.raw(`(array_agg(revision_nota ORDER BY created_at DESC))[1] AS last_revision_nota`))
        .select(trx.raw(`(array_agg(files ORDER BY created_at DESC))[1] AS last_files`))
        .whereNotNull('folio_gasto')
        .groupBy('folio_gasto')
        .as('d');

      const b = trx('analytics.expense_documents as g')
        .leftJoin(comp, 'g.doc_folio', 'd.folio_gasto')
        .where('g.tenant_id', tenantId)
        .where('g.doc_tipo', 'XA1001')
        .select(
          'g.sucursal', 'g.doc_folio AS folio_gasto', 'g.fecha',
          'g.beneficiario AS proveedor', trx.raw('g.importe::numeric AS importe'),
          'g.solicitud_folio', 'g.area',
          trx.raw('COALESCE(d.n, 0)::int AS comprobaciones'),
          trx.raw('d.last_id AS comprobacion_id'),
          trx.raw('d.last_status AS comprobacion_status'),
          trx.raw('d.last_folio_comp AS folio_comprobacion'),
          trx.raw('d.last_revision_nota AS revision_nota'),
          trx.raw('d.last_files AS files'),
        )
        .orderBy('g.fecha', 'desc')
        .orderBy('g.doc_folio', 'desc')
        .limit(limit);

      if (q.from) b.where('g.fecha', '>=', q.from);
      if (q.to) b.where('g.fecha', '<=', q.to);
      if (q.estado === 'pendiente') b.whereRaw('d.n IS NULL');
      if (q.estado === 'comprobada') b.whereRaw('d.n > 0');
      if (q.estado === 'validada') b.whereRaw(`d.last_status = 'validada'`);
      if (q.estado === 'revision') b.whereRaw(`d.last_status = 'revision'`);
      if (q.search) {
        const s = `%${q.search.trim()}%`;
        b.where((w: any) => w.whereILike('g.doc_folio', s).orWhereILike('g.beneficiario', s)
          .orWhereILike('g.solicitud_folio', s).orWhereRaw('g.importe::text ILIKE ?', [s]));
      }

      const rows = await Promise.all((await b).map(async (r: any) => ({
        ...r, importe: Number(r.importe),
        files: await this.storage.signFiles(typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || [])), // URL prefirmada (bucket privado)
      })));

      const kpiBase = trx('analytics.expense_documents as g')
        .leftJoin(comp, 'g.doc_folio', 'd.folio_gasto')
        .where('g.tenant_id', tenantId).where('g.doc_tipo', 'XA1001');
      if (q.from) kpiBase.where('g.fecha', '>=', q.from);
      if (q.to) kpiBase.where('g.fecha', '<=', q.to);
      const [k] = await kpiBase.select(
        trx.raw('COUNT(*)::int AS gastos'),
        trx.raw('COUNT(d.n)::int AS comprobados'),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='validada')::int AS validados`),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='revision')::int AS en_revision`),
        trx.raw('COALESCE(SUM(g.importe::numeric) FILTER (WHERE d.n IS NULL), 0)::numeric AS monto_pendiente'),
      );

      return {
        kpis: {
          gastos: Number(k.gastos), comprobados: Number(k.comprobados),
          validados: Number(k.validados), en_revision: Number(k.en_revision), monto_pendiente: Number(k.monto_pendiente),
        },
        rows,
      };
    });
  }

  /** Mapa folio_gasto → estado (último), para el seguimiento por gasto. */
  async statusByGasto(): Promise<Record<string, string>> {
    return this.latestStatusBy('folio_gasto');
  }

  /** Mapa folio_solicitud → estado (último), para el overlay en /finanzas/solicitudes. */
  async statusBySolicitud(): Promise<Record<string, string>> {
    return this.latestStatusBy('folio_solicitud');
  }

  private latestStatusBy(col: 'folio_gasto' | 'folio_solicitud'): Promise<Record<string, string>> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx
        .with('ranked', (qb: any) => {
          qb.from('finance.expense_comprobaciones')
            .whereNotNull(col)
            .select(col, 'status',
              trx.raw(`row_number() OVER (PARTITION BY ?? ORDER BY created_at DESC) AS rn`, [col]));
        })
        .from('ranked').where('rn', 1)
        .select(col, 'status');
      return Object.fromEntries(rows.map((r: any) => [r[col], r.status]));
    });
  }

  /** El contador valida la comprobación. */
  async validate(id: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_comprobaciones').where({ id }).whereIn('status', ['recibida', 'rechazada', 'revision'])
        .update({ status: 'validada', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: null, revision_nota: null, updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('comprobación no encontrada o ya validada');
      return row;
    });
  }

  /** Rechaza (con motivo). */
  async reject(id: string, actor?: string, motivo?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_comprobaciones').where({ id }).whereIn('status', ['recibida', 'validada', 'revision'])
        .update({ status: 'rechazada', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: (motivo || '').trim() || 'rechazada', updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('comprobación no encontrada o ya rechazada');
      return row;
    });
  }
}
