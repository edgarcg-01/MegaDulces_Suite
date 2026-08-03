import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService } from '@megadulces/platform-core';
import { LlmExtractorService, DepositSlipFields } from '@megadulces/platform-core';

/**
 * Fase CC — Comprobantes de Cobranza. Adjunta el comprobante de DEPÓSITO
 * (imagen/PDF) a un COBRO de Kepler (documento `Collect1`/`UA0501`, U-A-5-1
 * "Cobro PUE"), le corre OCR y guarda la evidencia en `finance.collection_deposits`
 * ligada por `(sucursal, folio)`. NO escribe a Kepler: los cobros se leen del
 * espejo read-only `analytics.erp_collections`. Flujo `recibido → validado | rechazado`.
 */

export const DEPOSIT_FILE_ROLES = ['deposito', 'evidencia_1', 'evidencia_2'] as const;
export type DepositFileRole = (typeof DEPOSIT_FILE_ROLES)[number];
const TOLERANCIA = 1.0; // pesos: |ocr_monto - cobro_monto| <= 1 → cuadra (redondeo)

export interface DepositFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

export interface ListCobrosQuery {
  estado?: 'pendiente' | 'con_comprobante' | 'validado' | string;
  forma_pago?: string;
  tipo_cuenta?: string;
  incluir_todas?: string; // '1' = no restringir a deposito/transferencia/tarjeta
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
}

export interface AttachDepositDto {
  sucursal?: string;
  folio?: string;
  files?: DepositFile[];
  ocr?: Partial<DepositSlipFields> & { ocr_status?: string };
  comentarios?: string;
}

/** Formas de pago que llevan ficha de depósito (las que reciben comprobante). */
const CON_FICHA = ['deposito', 'transferencia', 'tarjeta'];

@Injectable()
export class CollectionDepositsService {
  private readonly logger = new Logger(CollectionDepositsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly ocr: LlmExtractorService,
  ) {}

  /**
   * Lista los cobros de Kepler (espejo `analytics.erp_collections`) con el estado
   * de su evidencia adjunta (LEFT JOIN a `finance.collection_deposits`). Por
   * default acota a las formas de pago con ficha; `incluir_todas=1` muestra todo.
   */
  async listCobros(q: ListCobrosQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
    const soloFicha = q.incluir_todas !== '1' && !q.forma_pago;

    return this.tk.run(async (trx) => {
      // Evidencia agregada por (sucursal, folio): cuántas, último estado, si alguna cuadra.
      const dep = trx('finance.collection_deposits')
        .select('sucursal', 'folio')
        .count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .select(trx.raw(`bool_or(monto_match) AS any_match`))
        .groupBy('sucursal', 'folio')
        .as('d');

      const b = trx('analytics.erp_collections as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId)
        .select(
          'c.sucursal', 'c.folio', 'c.cobro_date', 'c.cliente_code', 'c.cliente_nombre',
          'c.concepto', 'c.forma_pago', trx.raw('c.monto::numeric AS monto'), 'c.tipo_cuenta',
          trx.raw('COALESCE(d.n, 0)::int AS deposits'),
          trx.raw('d.last_id AS deposit_id'),
          trx.raw('d.last_status AS deposit_status'),
          trx.raw('COALESCE(d.any_match, false) AS monto_match'),
        )
        .orderBy('c.cobro_date', 'desc')
        .orderBy('c.folio', 'desc')
        .limit(limit);

      if (soloFicha) b.whereIn('c.forma_pago', CON_FICHA);
      if (q.forma_pago) b.where('c.forma_pago', q.forma_pago);
      if (q.tipo_cuenta) b.where('c.tipo_cuenta', q.tipo_cuenta);
      if (q.from) b.where('c.cobro_date', '>=', q.from);
      if (q.to) b.where('c.cobro_date', '<=', q.to);
      if (q.estado === 'pendiente') b.whereRaw('d.n IS NULL');
      if (q.estado === 'con_comprobante') b.whereRaw('d.n > 0');
      if (q.estado === 'validado') b.whereRaw(`d.last_status = 'validado'`);
      if (q.search) {
        const s = `%${q.search.trim()}%`;
        b.where((w) => w.whereILike('c.cliente_nombre', s).orWhereILike('c.cliente_code', s).orWhereILike('c.folio', s).orWhereRaw('c.monto::text ILIKE ?', [s]));
      }

      const rows = (await b).map((r: any) => ({ ...r, monto: Number(r.monto) }));

      // KPIs sobre el universo con ficha (estable, no depende del filtro de estado).
      const kpiBase = trx('analytics.erp_collections as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId);
      if (soloFicha) kpiBase.whereIn('c.forma_pago', CON_FICHA);
      if (q.forma_pago) kpiBase.where('c.forma_pago', q.forma_pago);
      if (q.tipo_cuenta) kpiBase.where('c.tipo_cuenta', q.tipo_cuenta);
      if (q.from) kpiBase.where('c.cobro_date', '>=', q.from);
      if (q.to) kpiBase.where('c.cobro_date', '<=', q.to);
      const [k] = await kpiBase.select(
        trx.raw('COUNT(*)::int AS cobros'),
        trx.raw('COUNT(d.n)::int AS con_comprobante'),
        trx.raw(`COUNT(*) FILTER (WHERE d.last_status='validado')::int AS validados`),
        trx.raw('COALESCE(SUM(c.monto::numeric) FILTER (WHERE d.n IS NULL), 0)::numeric AS monto_pendiente'),
      );

      return {
        kpis: {
          cobros: Number(k.cobros), con_comprobante: Number(k.con_comprobante),
          validados: Number(k.validados), monto_pendiente: Number(k.monto_pendiente),
        },
        rows,
      };
    });
  }

  /** Sube UN archivo (ficha/evidencia) a Cloudinary y devuelve su referencia. Imagen o PDF. */
  async uploadFile(dataUri: string, role = 'deposito'): Promise<DepositFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!DEPOSIT_FILE_ROLES.includes(role as DepositFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      const f = await this.cloudinary.uploadDocumentBase64(dataUri, `finance/${tenantId}/collection-deposits`);
      return { role, url: f.url, public_id: f.public_id, kind: f.kind };
    } catch (e: any) {
      this.logger.error(`fallo subiendo ficha (${role}): ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /** Corre OCR sobre la ficha (imagen/PDF) y devuelve los campos extraídos (preview, no guarda). */
  async runOcr(dataUri: string): Promise<DepositSlipFields & { ocr_status: string }> {
    this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const { mediaType, base64 } = this.parseDataUri(dataUri);
    if (!process.env.ANTHROPIC_API_KEY) {
      // degradación explícita: sin key el capturista teclea los campos a mano
      return { monto: null, fecha: null, banco: null, cuenta_dest: null, referencia: null, ordenante: null, metodo: null, ocr_status: 'sin_key' };
    }
    const fields = await this.ocr.extractDepositSlip(base64, mediaType);
    const any = fields.monto != null || fields.fecha || fields.banco || fields.referencia;
    return { ...fields, ocr_status: any ? 'ok' : 'ilegible' };
  }

  /** Crea el registro de evidencia ligado al cobro Kepler. Calcula `monto_match`. */
  async attach(dto: AttachDepositDto, actor?: string) {
    this.tenantCtx.requireTenantId();
    const sucursal = (dto.sucursal || '').trim();
    const folio = (dto.folio || '').trim();
    const files = Array.isArray(dto.files) ? dto.files.filter((f) => f && f.url && f.role) : [];
    if (!sucursal || !folio) throw new BadRequestException('sucursal y folio del cobro requeridos');
    if (!files.length) throw new BadRequestException('se requiere al menos la ficha de depósito');

    return this.tk.run(async (trx) => {
      const cobro = await trx('analytics.erp_collections')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), sucursal, folio })
        .first('cliente_code', 'cliente_nombre', 'cobro_date', trx.raw('monto::numeric AS monto'));
      if (!cobro) throw new BadRequestException(`cobro ${sucursal}/${folio} no existe en el espejo de Kepler`);

      const o = dto.ocr || {};
      const cobroMonto = Number(cobro.monto) || 0;
      const ocrMonto = o.monto != null ? Number(o.monto) : null;
      const montoMatch = ocrMonto != null ? Math.abs(ocrMonto - cobroMonto) <= TOLERANCIA : null;

      const [row] = await trx('finance.collection_deposits')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          sucursal, folio,
          cliente_code: cobro.cliente_code || null,
          cliente_nombre: cobro.cliente_nombre || null,
          cobro_date: cobro.cobro_date || null,
          cobro_monto: cobroMonto,
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
      this.logger.log(`ficha adjunta a cobro ${sucursal}/${folio} (match=${montoMatch}) por ${actor || '?'}`);
      return row;
    });
  }

  /** Detalle: el cobro + sus fichas adjuntas. */
  async detail(sucursal: string, folio: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const cobro = await trx('analytics.erp_collections')
        .where({ tenant_id: tenantId, sucursal, folio })
        .first('sucursal', 'folio', 'cobro_date', 'cliente_code', 'cliente_nombre', 'concepto', 'forma_pago', trx.raw('monto::numeric AS monto'), 'tipo_cuenta');
      if (!cobro) throw new BadRequestException('cobro no encontrado');
      const deposits = await trx('finance.collection_deposits')
        .where({ sucursal, folio })
        .orderBy('created_at', 'desc')
        .select('id', 'files', trx.raw('ocr_monto::numeric AS ocr_monto'), 'ocr_fecha', 'ocr_banco', 'ocr_cuenta_dest',
          'ocr_referencia', 'ocr_ordenante', 'ocr_metodo', 'ocr_status', 'monto_match', 'status',
          'comentarios', 'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');
      return { cobro: { ...cobro, monto: Number(cobro.monto) }, deposits };
    });
  }

  /** El revisor valida la evidencia. Auditado. */
  async validate(id: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.collection_deposits').where({ id }).whereIn('status', ['recibido', 'rechazado'])
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
      const [row] = await trx('finance.collection_deposits').where({ id }).whereIn('status', ['recibido', 'validado'])
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
