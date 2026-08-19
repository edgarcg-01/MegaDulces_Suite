import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService, ObjectStorageService, LlmExtractorService } from '@megadulces/platform-core';

/**
 * GX.7 — Solicitud de autorización de gastos (reembolso). Captura de la solicitud
 * de reembolso ligada por folio a la solicitud de Kepler (XA1501), con múltiples
 * adjuntos. Vive en `finance.expense_proofs`; NO escribe a Kepler (se concilia por
 * folio). Flujo `recibida → validada | rechazada`.
 */

/** Roles de archivo fijos del formulario (Google Form → plataforma). */
export const PROOF_FILE_ROLES = ['comprobante_1', 'comprobante_2', 'solicitud_kepler', 'evidencia_1', 'evidencia_2', 'evidencia_3'] as const;
export type ProofFileRole = (typeof PROOF_FILE_ROLES)[number];
const REQUIRED_ROLES: ProofFileRole[] = ['comprobante_1', 'solicitud_kepler'];

export interface ProofFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

export interface CreateExpenseProofDto {
  solicitante?: string;
  departamento?: string;
  departamento_code?: string;
  sucursal?: string;
  fecha_gasto?: string;
  folio_solicitud?: string;
  proveedor?: string;
  importe?: number;
  comentarios?: string;
  files?: ProofFile[];
  // Validación por vision de la foto del comprobante (preview vía validate-photo):
  monto_ocr?: number | null;    // total leído de la foto
  subtotal_ocr?: number | null; // subtotal leído (se compara si el total no cuadra)
  receipt_legible?: boolean;    // false si la foto era ilegible / no era comprobante
}

/** Resultado de validar la foto del comprobante contra el importe de la solicitud. */
interface ValidatePhotoResult {
  ocr_status: 'ok' | 'ilegible' | 'sin_key';
  importe_esperado: number;
  monto_ocr: number | null;
  monto_match: boolean;
  diff: number | null;
}

export interface ListExpenseProofsQuery {
  status?: string;
  folio_solicitud?: string;
  search?: string;
  from?: string;
  to?: string;
  limit?: number;
}

@Injectable()
export class ExpenseProofsService {
  private readonly logger = new Logger(ExpenseProofsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly storage: ObjectStorageService,
    private readonly ocr: LlmExtractorService,
  ) {}

  /**
   * Catálogo canónico de departamentos = dimensión `dpto` del ERP
   * (analytics.expense_entries), deduplicada por código y sin ruido. Cada uno con
   * su `sucursal` derivada del código (o "Oficinas / Corporativo").
   */
  async departamentos(): Promise<{ code: string; nombre: string; sucursal: string }[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx
        .with('ranked', (qb) => {
          qb.from('analytics.expense_entries')
            .where('tenant_id', tenantId)
            .whereNotNull('dpto').whereNotNull('dpto_nombre')
            .whereNot('dpto', 'S/A')
            .whereRaw(`dpto_nombre NOT ILIKE '%NO USAR%'`)
            .whereRaw(`dpto_nombre NOT ILIKE 'TRASPASO%'`)
            .whereRaw(`dpto_nombre NOT ILIKE 'SIN ASIGNAR%'`)
            .groupBy('dpto', 'dpto_nombre')
            .select('dpto', 'dpto_nombre', trx.raw('COUNT(*) AS n'),
              trx.raw('row_number() OVER (PARTITION BY dpto ORDER BY COUNT(*) DESC) AS rn'));
        })
        .from('ranked').where('rn', 1)
        .orderBy('dpto_nombre')
        .select('dpto AS code', 'dpto_nombre AS nombre');
      return rows.map((r: any) => ({ code: r.code, nombre: r.nombre, sucursal: this.deriveSucursal(r.code) }));
    });
  }

  /** Plaza/sucursal a partir del código dpto Kepler `1-RR-SS-XX`. Corporativo → "Oficinas / Corporativo". */
  private deriveSucursal(code: string): string {
    const seg = String(code || '').split('-');
    const rr = seg[1] || '';
    if (['09', '10', '11', '90'].includes(rr)) return 'Oficinas / Corporativo';
    if (rr === '08') return 'CEDIS / Logística';
    const PLAZA: Record<string, string> = {
      '10': 'Padre Hidalgo', '40': 'Ocho Esquinas', '42': 'La Piedad Abastos', '44': 'Yurécuaro',
      '30': 'Morelia Abastos', '32': 'Morelia Madero', '35': 'Bodega Casahuates', '88': 'Deliciate',
      '50': 'Canindo', '54': 'Zamora Centro', '53': 'Zamora Centro',
    };
    // seg[2] normal (1-RR-SS-XX); fallback para códigos malformados tipo "142-00" (seg[0]="142" → "42").
    return PLAZA[seg[2] || ''] || PLAZA[(seg[0] || '').replace(/^1/, '')] || 'Otra';
  }

  /**
   * Sube UN archivo a Cloudinary (comprobante/solicitud/evidencia). Se llama una
   * vez por archivo para no rebasar el límite de body (hasta 6 × 10MB por form).
   */
  async uploadFile(dataUri: string, role: string): Promise<ProofFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!PROOF_FILE_ROLES.includes(role as ProofFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      // putFile: imagen o PDF (antes solo PDF). El comprobante suele ser FOTO y Claude
      // Vision necesita leerla para el cuadre; los demás roles también aceptan ambos.
      const f = await this.storage.putFile(dataUri, `finance/${tenantId}/expense-proofs`);
      return { role, url: f.key, public_id: f.key, kind: f.kind };
    } catch (e: any) {
      if (e?.status === 400) throw e; // "no configurado"
      this.logger.error(`fallo subiendo ${role}: ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /** Tolerancia del cuadre: $1 o 1% del importe (lo mayor), para absorber redondeo/IVA. */
  private tolerancia(importe: number): number {
    return Math.max(1, Math.abs(importe) * 0.01);
  }

  /** ¿El monto leído de la foto cuadra contra el importe esperado (total, o subtotal)? */
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
   * Vision AUTORITATIVO en el servidor: re-lee el comprobante YA SUBIDO (bucket) con
   * Claude Vision, en vez de confiar en el `monto_ocr` que reporta el cliente. Si no hay
   * `ANTHROPIC_API_KEY` o el archivo no se puede leer, cae a lo que reportó el cliente
   * (best-effort). Se corre FUERA de la transacción (I/O de segundos).
   */
  private async serverReadReceipt(
    files: ProofFile[],
    dto: CreateExpenseProofDto,
  ): Promise<{ total: number | null; subtotal: number | null; legible: boolean; source: 'servidor' | 'cliente' }> {
    const fallback = {
      total: dto.monto_ocr ?? null,
      subtotal: dto.subtotal_ocr ?? null,
      legible: dto.receipt_legible !== false && (dto.monto_ocr != null || dto.subtotal_ocr != null),
      source: 'cliente' as const,
    };
    if (!process.env.ANTHROPIC_API_KEY) return fallback;
    const comp = files.find((f) => f.role === 'comprobante_1') || files.find((f) => f.role === 'comprobante_2') || files[0];
    const key = comp?.public_id || comp?.url || '';
    const dataUri = key ? await this.storage.getDataUri(key) : null;
    if (!dataUri) return fallback;
    const m = /^data:([^;,]+)[;,]/.exec(dataUri);
    const mediaType = (m ? m[1] : 'image/jpeg').toLowerCase();
    const base64 = dataUri.replace(/^data:[^,]*,/, '');
    try {
      const f = await this.ocr.extractExpenseReceipt(base64, mediaType as any);
      return { total: f.total, subtotal: f.subtotal, legible: f.legible && (f.total != null || f.subtotal != null), source: 'servidor' };
    } catch (e: any) {
      this.logger.warn(`Vision servidor falló, uso OCR del cliente: ${e?.message || e}`);
      return fallback;
    }
  }

  /**
   * Preview de la validación: lee la foto del comprobante con Claude Vision y la cuadra
   * contra el importe esperado (de la solicitud). El front la llama al adjuntar para
   * mostrar "cuadra / en revisión" antes de enviar. No guarda.
   */
  async validatePhoto(dataUri: string, importeEsperado: number): Promise<ValidatePhotoResult & { total: number | null; subtotal: number | null }> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const esperado = Number(importeEsperado) || 0;
    if (!process.env.ANTHROPIC_API_KEY) {
      return { total: null, subtotal: null, ocr_status: 'sin_key', importe_esperado: esperado, monto_ocr: null, monto_match: false, diff: null };
    }
    const m = /^data:([^;,]+)[;,]/.exec(dataUri || '');
    const mediaType = (m ? m[1] : 'image/jpeg').toLowerCase();
    const base64 = dataUri.replace(/^data:[^,]*,/, '');
    const f = await this.ocr.extractExpenseReceipt(base64, mediaType as any);
    const legible = f.legible && (f.total != null || f.subtotal != null);
    const { match, usado, diff } = this.montoCuadra(esperado, f.total, f.subtotal);
    return { total: f.total, subtotal: f.subtotal, ocr_status: legible ? 'ok' : 'ilegible', importe_esperado: esperado, monto_ocr: usado, monto_match: legible && match, diff };
  }

  /** Alta de la solicitud de reembolso (con los archivos ya subidos vía uploadFile). */
  async create(dto: CreateExpenseProofDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const req = (v?: string) => (v || '').trim();
    const solicitante = req(dto.solicitante) || actor || '';
    const departamento = req(dto.departamento);
    const folioSolicitud = req(dto.folio_solicitud);
    const proveedor = req(dto.proveedor);
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!solicitante) throw new BadRequestException('solicitante requerido');
    if (!departamento) throw new BadRequestException('departamento requerido');
    if (!folioSolicitud) throw new BadRequestException('folio de la solicitud requerido');
    if (!proveedor) throw new BadRequestException('proveedor requerido');
    const roles = new Set(files.map((f) => f.role));
    for (const r of REQUIRED_ROLES) {
      if (!roles.has(r)) throw new BadRequestException(`falta el archivo obligatorio: ${r}`);
    }

    // Vision autoritativo FUERA de la trx (I/O lento): re-lee el comprobante en el servidor.
    const srv = await this.serverReadReceipt(files, dto);

    return this.tk.run(async (trx) => {
      // Importe esperado = el de la solicitud Kepler (XA1501, fuente de verdad); si no se
      // encuentra, cae al del DTO (auto-rellenado por el front desde la misma solicitud).
      const sol = await trx('analytics.expense_requests')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), folio: folioSolicitud })
        .first(trx.raw('importe::numeric AS importe'));
      const importe = Number(sol?.importe) || Number(dto.importe) || 0;

      // Cuadre por vision: cuadra → validada (por Claude Vision); si no → revisión.
      const legible = srv.legible;
      const { match, usado, diff } = this.montoCuadra(importe, srv.total, srv.subtotal);
      const cuadra = legible && match;
      const fmt = (v: number | null) => (v == null ? '—' : `$${(Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      const status = cuadra ? 'validada' : 'revision';
      const revisionNota = cuadra ? null
        : (!legible ? 'Foto ilegible o sin lectura — validar a mano'
          : `Monto no cuadra: foto ${fmt(usado)} vs solicitud ${fmt(importe)}${diff != null ? ` (Δ ${fmt(diff)})` : ''}`);

      const [row] = await trx('finance.expense_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          solicitante, departamento, departamento_code: req(dto.departamento_code) || null,
          sucursal: req(dto.sucursal) || null,
          fecha_gasto: dto.fecha_gasto || null,
          folio_solicitud: folioSolicitud, proveedor,
          importe,
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
        .returning(['id', 'folio_solicitud', 'status']);
      this.logger.log(`solicitud de reembolso folio ${row.folio_solicitud} → ${status} [vision:${srv.source}]${cuadra ? '' : ` (${revisionNota})`} · ${files.length} archivos, por ${actor || '?'}`);
      return row;
    });
  }

  /** Bandeja + KPIs por estado. */
  async list(q: ListExpenseProofsQuery) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    return this.tk.run(async (trx) => {
      const b = trx('finance.expense_proofs')
        .select('id', 'solicitante', 'departamento', 'departamento_code', 'sucursal',
          'fecha_gasto', 'folio_solicitud', 'proveedor',
          trx.raw('importe::numeric AS importe'), trx.raw('monto_ocr::numeric AS monto_ocr'), 'monto_match', 'revision_nota',
          'files', 'comentarios', 'status',
          'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at')
        .orderBy('created_at', 'desc').limit(limit);
      if (q.status) b.where('status', q.status);
      if (q.folio_solicitud) b.where('folio_solicitud', q.folio_solicitud.trim());
      if (q.from) b.where('created_at', '>=', q.from);
      if (q.to) b.where('created_at', '<=', `${q.to} 23:59:59`);
      if (q.search) {
        const s = `%${q.search.trim()}%`;
        b.where((w) => w.whereILike('proveedor', s).orWhereILike('folio_solicitud', s).orWhereILike('solicitante', s));
      }
      const rows = await Promise.all((await b).map(async (r: any) => ({
        ...r, importe: Number(r.importe), monto_ocr: r.monto_ocr == null ? null : Number(r.monto_ocr),
        files: await this.storage.signFiles(typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || [])), // URL prefirmada (bucket privado)
      })));

      const agg = await trx('finance.expense_proofs').groupBy('status').select('status', trx.raw('COUNT(*)::int AS n'));
      const by = Object.fromEntries(agg.map((r: any) => [r.status, Number(r.n)]));
      return {
        kpis: { total: rows.length, recibidas: by['recibida'] || 0, validadas: by['validada'] || 0, rechazadas: by['rechazada'] || 0, en_revision: by['revision'] || 0 },
        rows,
      };
    });
  }

  /** (C) Mapa folio_solicitud → estado, para el indicador en /finanzas/solicitudes. */
  async statusByFolio(): Promise<Record<string, string>> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      // estado más reciente por folio
      const rows = await trx
        .with('ranked', (qb) => {
          qb.from('finance.expense_proofs')
            .select('folio_solicitud', 'status',
              trx.raw('row_number() OVER (PARTITION BY folio_solicitud ORDER BY created_at DESC) AS rn'));
        })
        .from('ranked').where('rn', 1)
        .select('folio_solicitud', 'status');
      return Object.fromEntries(rows.map((r: any) => [r.folio_solicitud, r.status]));
    });
  }

  /** El contador valida la solicitud de reembolso. */
  async validate(id: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_proofs').where({ id }).whereIn('status', ['recibida', 'rechazada', 'revision'])
        .update({ status: 'validada', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: null, revision_nota: null, updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('solicitud no encontrada o ya validada');
      return row;
    });
  }

  /** Rechaza (con motivo). */
  async reject(id: string, actor?: string, motivo?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_proofs').where({ id }).whereIn('status', ['recibida', 'validada', 'revision'])
        .update({ status: 'rechazada', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: (motivo || '').trim() || 'rechazada', updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('solicitud no encontrada o ya rechazada');
      return row;
    });
  }
}
