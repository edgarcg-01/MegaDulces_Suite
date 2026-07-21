import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService } from '@megadulces/platform-core';

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
      const f = await this.cloudinary.uploadDocumentBase64(dataUri, `finance/${tenantId}/expense-proofs`);
      return { role, url: f.url, public_id: f.public_id, kind: f.kind };
    } catch (e: any) {
      this.logger.error(`fallo subiendo ${role}: ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
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

    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          solicitante, departamento, departamento_code: req(dto.departamento_code) || null,
          sucursal: req(dto.sucursal) || null,
          fecha_gasto: dto.fecha_gasto || null,
          folio_solicitud: folioSolicitud, proveedor,
          importe: Number(dto.importe) || 0,
          files: JSON.stringify(files),
          comentarios: req(dto.comentarios) || null,
          created_by: actor || null,
        })
        .returning(['id', 'folio_solicitud', 'status']);
      this.logger.log(`solicitud de reembolso recibida folio ${row.folio_solicitud} (${files.length} archivos) por ${actor || '?'}`);
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
          trx.raw('importe::numeric AS importe'), 'files', 'comentarios', 'status',
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
      const rows = (await b).map((r: any) => ({ ...r, importe: Number(r.importe), files: r.files || [] }));

      const agg = await trx('finance.expense_proofs').groupBy('status').select('status', trx.raw('COUNT(*)::int AS n'));
      const by = Object.fromEntries(agg.map((r: any) => [r.status, Number(r.n)]));
      return {
        kpis: { total: rows.length, recibidas: by['recibida'] || 0, validadas: by['validada'] || 0, rechazadas: by['rechazada'] || 0 },
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
      const [row] = await trx('finance.expense_proofs').where({ id }).whereIn('status', ['recibida', 'rechazada'])
        .update({ status: 'validada', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: null, updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('solicitud no encontrada o ya validada');
      return row;
    });
  }

  /** Rechaza (con motivo). */
  async reject(id: string, actor?: string, motivo?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.expense_proofs').where({ id }).whereIn('status', ['recibida', 'validada'])
        .update({ status: 'rechazada', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: (motivo || '').trim() || 'rechazada', updated_at: trx.fn.now() })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('solicitud no encontrada o ya rechazada');
      return row;
    });
  }
}
