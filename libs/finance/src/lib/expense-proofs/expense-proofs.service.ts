import { Injectable, BadRequestException, NotFoundException, Logger, Optional } from '@nestjs/common';
import { ExpenseProofsGateway } from './expense-proofs.gateway';
import { TenantKnexService, TenantContextService, CloudinaryService, ObjectStorageService, LlmExtractorService, isPlatformAdminRole, Permission } from '@megadulces/platform-core';

/**
 * GX.7 — Solicitud de autorización de gastos (reembolso). Captura de la solicitud
 * de reembolso ligada por folio a la solicitud de Kepler (XA1501), con múltiples
 * adjuntos. Vive en `finance.expense_proofs`; NO escribe a Kepler (se concilia por
 * folio). Flujo `recibida → validada | rechazada`.
 */

/**
 * Roles de archivo fijos (herencia del Google Form).
 *
 * `solicitud_kepler` es la solicitud **firmada**. No se pide para leerle los datos —esos
 * ya los tenemos de Kepler por folio— sino porque la firma es la evidencia de que alguien
 * autorizó. Por eso es OPCIONAL: lo que no puede faltar es el comprobante del gasto.
 */
export const PROOF_FILE_ROLES = ['comprobante_1', 'comprobante_2', 'solicitud_kepler', 'evidencia_1', 'evidencia_2', 'evidencia_3'] as const;
export type ProofFileRole = (typeof PROOF_FILE_ROLES)[number];

/**
 * Naturaleza del gasto — decide si la EVIDENCIA (factura/ticket) es obligatoria.
 * `fiscal` y `no_fiscal_comprobable` la exigen; `no_comprobable` cierra sin foto pero
 * con motivo. La comprobación XA1001 vive SIEMPRE en Kepler y es otra cosa.
 */
export const EXPENSE_CLASIFICACIONES = ['fiscal', 'no_fiscal_comprobable', 'no_comprobable'] as const;
export type ExpenseClasificacion = (typeof EXPENSE_CLASIFICACIONES)[number];
/**
 * ¿Este gasto debe llevar **evidencia** (factura/ticket) adjunta? Todo salvo lo declarado
 * no_comprobable.
 *
 * ⚠️ Esto condiciona la EVIDENCIA del gasto, **nunca la solicitud firmada**: esa se sube
 * siempre, sea el gasto fiscal, no fiscal o no comprobable (es la autorización que respalda
 * la salida de dinero). Ver `REQUEST_ROLE`.
 */
export function requiereEvidencia(c?: string | null): boolean {
  return c === 'fiscal' || c === 'no_fiscal_comprobable';
}
/** El archivo de evidencia que puede faltar (condicional a la clasificación). */
const EVIDENCE_ROLE: ProofFileRole = 'comprobante_1';
/** La solicitud de gasto firmada: **obligatoria siempre**, en los tres tipos de gasto. */
const REQUEST_ROLE: ProofFileRole = 'solicitud_kepler';

export interface ProofFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

/** Lo que el tablero necesita saber de un folio sin abrir el expediente. */
export interface ProofByFolio {
  id: string;
  status: string;
  /** ¿Está la evidencia del gasto (factura/ticket)? Obligatoria salvo no_comprobable. */
  comprobante: boolean;
  /** ¿Está la solicitud firmada? Aporta la firma, no los datos. */
  solicitud: boolean;
  /** Naturaleza del gasto: fiscal / no_fiscal_comprobable / no_comprobable. `null` = sin clasificar. */
  clasificacion: string | null;
  /** Derivado de la clasificación: ¿este gasto debe llevar evidencia adjunta? */
  requiere_evidencia: boolean;
  /** (XA1001, dormante) Lo declaraba quien valida. `null` = nadie lo dijo. */
  tiene_comprobacion: boolean | null;
  comprobacion_nota: string | null;
}

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
  /** Naturaleza del gasto — decide si la evidencia es obligatoria (ver ExpenseClasificacion). */
  clasificacion?: string;
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
  /** Sólo lo que capturó este usuario (para la vista del capturista). */
  mine?: string;
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
    @Optional() private readonly gateway?: ExpenseProofsGateway,
  ) {}

  /** Aviso WS al autorizador (best-effort; nunca rompe la operación). */
  private emit(action: 'captured' | 'validated' | 'rejected',
    row: { folio_solicitud: string; status?: string | null; solicitante?: string | null; importe?: number | null; sucursal?: string | null },
    actor?: string): void {
    try {
      const tenantId = this.tenantCtx.requireTenantId();
      this.gateway?.emitChange(tenantId, {
        action, folio_solicitud: row.folio_solicitud, status: row.status ?? null,
        solicitante: row.solicitante ?? null, sucursal: row.sucursal ?? null,
        importe: row.importe == null ? null : Number(row.importe), actor: actor ?? null,
      });
    } catch { /* el aviso no debe tumbar la operación */ }
  }

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

  /** Alta del expediente de gasto (con los archivos ya subidos vía uploadFile). */
  async create(dto: CreateExpenseProofDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const req = (v?: string) => (v || '').trim();
    const folioSolicitud = req(dto.folio_solicitud);
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!folioSolicitud) throw new BadRequestException('folio de la solicitud requerido');

    // Clasificación del gasto: decide si la evidencia (factura/ticket) es obligatoria.
    const clasificacion = req(dto.clasificacion) as ExpenseClasificacion | '';
    if (!clasificacion || !EXPENSE_CLASIFICACIONES.includes(clasificacion as ExpenseClasificacion)) {
      throw new BadRequestException('clasificación del gasto requerida (fiscal / no_fiscal_comprobable / no_comprobable)');
    }
    const llevaEvidencia = requiereEvidencia(clasificacion);
    const motivo = req(dto.comentarios);

    // La solicitud ya subida a Kepler ES la fuente de verdad: trae solicitante,
    // beneficiario, sucursal, fecha e importe. Pedirlos otra vez en el formulario era
    // hacer teclear lo que el sistema ya sabe —y abría la puerta a que la captura
    // contradiga a Kepler—. Lo que de verdad falta aportar es la evidencia.
    // Lo que venga en el DTO sigue mandando: permite capturar una solicitud que todavía
    // no llegó por el feed.
    const sol = await this.lookupSolicitud(folioSolicitud);
    const solicitante = req(dto.solicitante) || req(sol?.solicitante) || actor || '';
    const proveedor = req(dto.proveedor) || req(sol?.beneficiario);
    // `departamento` solo servía para derivar la sucursal; si la solicitud ya la trae,
    // exigirlo era un trámite. Se guarda la sucursal, que es el dato que importa.
    const sucursal = req(dto.sucursal) || req(sol?.sucursal);
    const departamento = req(dto.departamento) || (sucursal ? `Sucursal ${sucursal}` : '');
    if (!solicitante) throw new BadRequestException('solicitante requerido (no vino en la solicitud ni en el formulario)');
    if (!proveedor) throw new BadRequestException('proveedor requerido (no vino en la solicitud ni en el formulario)');
    if (!departamento) throw new BadRequestException('departamento o sucursal requerido');

    const roles = new Set(files.map((f) => f.role));
    // La solicitud firmada respalda la salida de dinero: va en los TRES tipos de gasto.
    // Un gasto puede no ser comprobable; la autorización nunca deja de existir.
    if (!roles.has(REQUEST_ROLE)) {
      throw new BadRequestException('falta la solicitud de gasto firmada (se adjunta siempre, incluso si el gasto no es comprobable)');
    }
    if (llevaEvidencia && !roles.has(EVIDENCE_ROLE)) {
      throw new BadRequestException('falta la evidencia del gasto (obligatoria salvo gasto no comprobable)');
    }
    // No comprobable: no se exige foto, pero sí el motivo — si no, el «no» no se audita.
    if (!llevaEvidencia && !motivo) {
      throw new BadRequestException('un gasto no comprobable exige un motivo (por qué no lleva evidencia)');
    }

    // Vision autoritativo FUERA de la trx (I/O lento): re-lee la evidencia en el servidor.
    // Sólo cuando hay evidencia que leer.
    const srv = llevaEvidencia ? await this.serverReadReceipt(files, dto) : null;

    return this.tk.run(async (trx) => {
      // Importe esperado = el de la solicitud Kepler (XA1501, fuente de verdad); si no se
      // encuentra, cae al del DTO (auto-rellenado por el front desde la misma solicitud).
      const solRow = await trx('analytics.expense_requests')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), folio: folioSolicitud })
        .first(trx.raw('importe::numeric AS importe'));
      const importe = Number(solRow?.importe) || Number(dto.importe) || 0;

      let status: string;
      let monto_ocr: number | null = null;
      let monto_match: boolean | null = null;
      let revisionNota: string | null = null;
      let validatedBy: string | null = null;
      let cuadra = false;

      if (!llevaEvidencia) {
        // Gasto no comprobable: entra a revisión para que el aprobador valide el motivo.
        status = 'recibida';
      } else {
        // Cuadre por vision: cuadra → validada (por Claude Vision); si no → revisión.
        const legible = srv!.legible;
        const { match, usado, diff } = this.montoCuadra(importe, srv!.total, srv!.subtotal);
        cuadra = legible && match;
        const fmt = (v: number | null) => (v == null ? '—' : `$${(Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
        status = cuadra ? 'validada' : 'revision';
        monto_ocr = usado;
        monto_match = legible ? match : null;
        revisionNota = cuadra ? null
          : (!legible ? 'Foto ilegible o sin lectura — validar a mano'
            : `Monto no cuadra: foto ${fmt(usado)} vs solicitud ${fmt(importe)}${diff != null ? ` (Δ ${fmt(diff)})` : ''}`);
        validatedBy = cuadra ? 'Claude Vision' : null;
      }

      const [row] = await trx('finance.expense_proofs')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          solicitante, departamento, departamento_code: req(dto.departamento_code) || null,
          sucursal: sucursal || null,
          fecha_gasto: dto.fecha_gasto || solRow?.fecha || null,
          folio_solicitud: folioSolicitud, proveedor,
          importe,
          clasificacion,
          // El motivo de un no_comprobable vive en comprobacion_nota (campo de "por qué falta").
          comprobacion_nota: llevaEvidencia ? null : motivo,
          files: JSON.stringify(files),
          comentarios: motivo || null,
          status,
          monto_ocr,
          monto_match,
          revision_nota: revisionNota,
          validated_by: validatedBy,
          validated_at: cuadra ? trx.fn.now() : null,
          created_by: actor || null,
        })
        .returning(['id', 'folio_solicitud', 'status']);
      this.logger.log(`expediente de gasto folio ${row.folio_solicitud} [${clasificacion}] → ${status}${srv ? ` [vision:${srv.source}]` : ''}${revisionNota ? ` (${revisionNota})` : ''} · ${files.length} archivos, por ${actor || '?'}`);
      this.emit('captured', { folio_solicitud: row.folio_solicitud, status: row.status, solicitante, importe: dto.importe, sucursal: dto.sucursal }, actor);
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
      if (q.mine) b.where('created_by', q.mine);
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

  /**
   * Una solicitud con sus adjuntos RE-FIRMADOS al momento de abrirla.
   *
   * La lista firma con TTL de 10 min. Quien revisa trabaja la bandeja un rato largo,
   * así que al abrir la fila 20 minutos después la URL ya venció y el archivo daba
   * error de firma — se veía como "no existe la imagen". Acá se firma de nuevo, y con
   * más aire (30 min) porque el visor queda abierto mientras se decide.
   */
  async detail(id: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const tieneCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'tiene_comprobacion');
      const clasCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'clasificacion');
      const r: any = await trx('finance.expense_proofs')
        .where({ id })
        .first(...(tieneCol ? ['tiene_comprobacion', 'comprobacion_nota'] : []),
          ...(clasCol ? ['clasificacion'] : []),
          'id', 'solicitante', 'departamento', 'departamento_code', 'sucursal',
          'fecha_gasto', 'folio_solicitud', 'proveedor',
          trx.raw('importe::numeric AS importe'), trx.raw('monto_ocr::numeric AS monto_ocr'), 'monto_match', 'revision_nota',
          'files', 'comentarios', 'status',
          'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');
      if (!r) throw new NotFoundException('solicitud de reembolso no encontrada');
      const files = typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []);
      return {
        ...r,
        importe: Number(r.importe),
        monto_ocr: r.monto_ocr == null ? null : Number(r.monto_ocr),
        requiere_evidencia: requiereEvidencia(clasCol ? r.clasificacion : null),
        files: await this.storage.signFiles(files, 1800),
        // El front no puede distinguir "no adjuntaron nada" de "hay archivo pero no lo
        // puedo servir" si sólo recibe una url rota. Se lo decimos explícito.
        storage_ok: this.storage.isConfigured(),
      };
    });
  }

  /**
   * Busca la SOLICITUD (XA1501) contra la que se va a subir el comprobante.
   *
   * Antes el capturista buscaba el GASTO (XA1001) y su captura caía en otra tabla, en
   * paralelo al tablero. Una sola llave: la solicitud.
   *
   * El folio se resuelve por VALOR NUMÉRICO, no por sufijo: el capturista teclea los
   * últimos dígitos ("23", "8489") y eso casa con `0000023` / `0008489`. Hacerlo con
   * `right(folio,4)` funcionaría hoy y empezaría a devolver el documento equivocado en
   * cuanto el consecutivo del CEDIS pase de 9,999 — va en 8,489.
   *
   * Alcance: con áreas asignadas se busca dentro de ellas. SIN áreas (hoy: los 113
   * usuarios) no se devuelve el catálogo entero ni se bloquea todo — se exige folio
   * EXACTO. Así el capturista sube lo que le dieron sin poder pasear por el gasto ajeno.
   */
  async searchSolicitudes(term: string, limit = 20, user?: { sub?: string; role_name?: string; permissions?: Record<string, boolean> }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const q = String(term || '').trim();
    // Un solo digito vale si es numero: la igualdad de folio es exacta y no genera ruido.
    // Para texto si se piden 2, porque ahi es LIKE.
    if (!q.length || (q.length < 2 && !/^[0-9]+$/.test(q))) return [];
    const lim = Math.min(50, Math.max(1, Number(limit) || 20));
    return this.tk.run(async (trx) => {
      const veTodo = isPlatformAdminRole(user?.role_name) || user?.permissions?.[Permission.FINANCE_EXPENSES_VER_ALL] === true;
      let claves: string[] = [];
      if (!veTodo && user?.sub) {
        const u = await trx('users').where({ id: user.sub }).first('nombre', 'finance_expense_area_ids');
        const norm = (v: any) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase() || null;
        const ids: string[] = Array.isArray(u?.finance_expense_area_ids) ? u.finance_expense_area_ids.filter(Boolean) : [];
        const areas = ids.length ? (await trx('finance.expense_areas').whereIn('id', ids).pluck('norm_key')).map(norm).filter(Boolean) : [];
        const n = norm(u?.nombre);
        for (const k of [...areas, ...(n ? [n] : [])]) if (k && claves.indexOf(k) === -1) claves.push(k);
      }
      const cols = await trx.raw(`SELECT 1 FROM information_schema.columns
        WHERE table_schema='analytics' AND table_name='expense_requests' AND column_name='acreedor'`);
      const conAcreedor = (cols.rows || []).length > 0;
      const soloNumeros = /^\d+$/.test(q);
      const b = trx('analytics.expense_requests as r').where('r.tenant_id', tenantId).where('r.estado', '<>', 'C');
      if (soloNumeros) {
        // Igualdad numérica: '23' encuentra '0000023' y nada más.
        b.whereRaw("NULLIF(regexp_replace(r.folio,'[^0-9]','','g'),'')::bigint = ?", [Number(q)]);
      } else if (veTodo || claves.length) {
        b.andWhere((w: any) => {
          w.whereILike('r.beneficiario', `%${q}%`);
          if (conAcreedor) w.orWhereILike('r.acreedor', `%${q}%`);
        });
      } else {
        return []; // sin áreas y sin folio: no se pasea el gasto ajeno
      }
      if (!veTodo && claves.length) {
        b.whereRaw("upper(regexp_replace(btrim(r.solicitante),'\\s+',' ','g')) = ANY(?::text[])", [claves]);
      }
      const rows = await b
        .orderBy('r.fecha', 'desc').limit(lim)
        .select('r.folio', 'r.sucursal', 'r.fecha', 'r.solicitante', 'r.concepto', 'r.estado', 'r.aplicada',
          trx.raw('r.importe::numeric AS importe'),
          trx.raw(conAcreedor ? 'COALESCE(r.acreedor, r.beneficiario) AS beneficiario' : 'r.beneficiario AS beneficiario'));
      return rows.map((r: any) => ({ ...r, importe: Number(r.importe) || 0 }));
    });
  }

  /**
   * (C) Mapa folio_solicitud → EXPEDIENTE, para el tablero de /finanzas/solicitudes.
   *
   * Devuelve el id (para poder resolver desde donde se ve), el estado, y qué documentos
   * hay. Sin los documentos el tablero no puede separar «falta el comprobante» de «falta
   * la solicitud firmada» de «falta la comprobación», que para quien aprueba son tres
   * pendientes distintos con tres acciones distintas.
   */
  async statusByFolio(): Promise<Record<string, ProofByFolio>> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const tieneCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'tiene_comprobacion');
      const clasCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'clasificacion');
      const rows = await trx
        .with('ranked', (qb: any) => {
          qb.from('finance.expense_proofs')
            .select('id', 'folio_solicitud', 'status', 'files',
              ...(tieneCol ? ['tiene_comprobacion', 'comprobacion_nota'] : []),
              ...(clasCol ? ['clasificacion'] : []),
              trx.raw('row_number() OVER (PARTITION BY folio_solicitud ORDER BY created_at DESC) AS rn'));
        })
        .from('ranked').where('rn', 1).select('*');
      return Object.fromEntries(rows.map((r: any) => {
        const files: any[] = typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []);
        const rol = (p: string) => files.some((f) => String(f?.role || '').startsWith(p) && f?.url);
        const clasificacion = clasCol ? (r.clasificacion || null) : null;
        return [r.folio_solicitud, {
          id: r.id,
          status: r.status,
          comprobante: rol('comprobante'),
          solicitud: rol('solicitud_kepler'),
          clasificacion,
          requiere_evidencia: requiereEvidencia(clasificacion),
          tiene_comprobacion: tieneCol ? r.tiene_comprobacion : null,
          comprobacion_nota: tieneCol ? (r.comprobacion_nota || null) : null,
        }];
      }));
    });
  }

  /**
   * La solicitud tal como la subieron a Kepler. Es la fuente de verdad de los datos de
   * cabecera; el formulario solo aporta la evidencia. Devuelve null si el feed todavía no
   * la trajo — en ese caso el DTO tiene que traer los datos.
   */
  private async lookupSolicitud(folio: string) {
    return this.tk.run(async (trx) =>
      trx('analytics.expense_requests')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), folio })
        .first('solicitante', 'beneficiario', 'sucursal', 'concepto',
          trx.raw(`to_char(fecha,'YYYY-MM-DD') AS fecha`), trx.raw('importe::numeric AS importe')),
    ) as Promise<{ solicitante?: string; beneficiario?: string; sucursal?: string; concepto?: string; fecha?: string; importe?: number } | undefined>;
  }

  /**
   * El aprobador valida el expediente. Puede RECLASIFICAR el gasto (si el capturista se
   * equivocó de naturaleza): al hacerlo se re-aplica la regla de evidencia. No se puede
   * validar un gasto comprobable sin su evidencia, ni cerrar un no_comprobable sin motivo.
   */
  async validate(id: string, actor?: string, dto?: { clasificacion?: string; comprobacion_nota?: string }) {
    this.tenantCtx.requireTenantId();
    const clasIn = (dto?.clasificacion || '').trim();
    if (clasIn && !EXPENSE_CLASIFICACIONES.includes(clasIn as ExpenseClasificacion)) {
      throw new BadRequestException('clasificación inválida');
    }
    const notaIn = (dto?.comprobacion_nota || '').trim();
    return this.tk.run(async (trx) => {
      const clasCol = await trx.schema.withSchema('finance').hasColumn('expense_proofs', 'clasificacion');
      const cur: any = await trx('finance.expense_proofs').where({ id }).whereIn('status', ['recibida', 'rechazada', 'revision'])
        .first('folio_solicitud', 'files', ...(clasCol ? ['clasificacion', 'comprobacion_nota'] : []));
      if (!cur) throw new BadRequestException('solicitud no encontrada o ya validada');

      const finalClas = clasIn || (clasCol ? cur.clasificacion : null);
      const files: any[] = typeof cur.files === 'string' ? JSON.parse(cur.files || '[]') : (cur.files || []);
      const hasEvidence = files.some((f) => String(f?.role || '').startsWith('comprobante') && f?.url);
      if (requiereEvidencia(finalClas) && !hasEvidence) {
        throw new BadRequestException('no se puede validar un gasto comprobable sin su evidencia adjunta');
      }
      const motivo = notaIn || (clasCol ? (cur.comprobacion_nota || '') : '');
      if (finalClas === 'no_comprobable' && !motivo) {
        throw new BadRequestException('un gasto no comprobable exige un motivo');
      }

      const [row] = await trx('finance.expense_proofs').where({ id }).whereIn('status', ['recibida', 'rechazada', 'revision'])
        .update({
          status: 'validada', validated_by: actor || null, validated_at: trx.fn.now(),
          motivo_rechazo: null, revision_nota: null, updated_at: trx.fn.now(),
          // Sonda: sin la migración de clasificación se valida igual, sin perder la acción.
          ...(clasCol ? { clasificacion: finalClas || null, comprobacion_nota: finalClas === 'no_comprobable' ? motivo : null } : {}),
        })
        .returning(['id', 'status']);
      if (!row) throw new BadRequestException('solicitud no encontrada o ya validada');
      const [full] = await trx('finance.expense_proofs').where({ id })
        .select('folio_solicitud', 'status', 'solicitante', 'importe', 'sucursal');
      if (full) this.emit('validated', full, actor);
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
      const [full] = await trx('finance.expense_proofs').where({ id })
        .select('folio_solicitud', 'status', 'solicitante', 'importe', 'sucursal');
      if (full) this.emit('rejected', full, actor);
      return row;
    });
  }
}
