import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService, applySmartSearch } from '@megadulces/platform-core';
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
const BANK_TOL = 1.0;   // pesos: |monto ficha - abono banco| para casar el movimiento
const BANK_DAYS_BEFORE = 1; // el abono puede postearse el día del depósito o 1 antes (fecha valor)
const BANK_DAYS_AFTER = 6;  // …o hasta unos días después (efectivo en ventanilla)

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

/** Folio electrónico → solo dígitos (llave determinista de dedup). null si no hay. */
const normRef = (s: unknown): string | null => {
  const d = String(s ?? '').replace(/\D/g, '');
  return d || null;
};

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
      // Folios electrónicos que aparecen en MÁS DE UN cobro vivo (mismo depósito
      // aplicado a varios cobros) → se marcan para revisión.
      const dupRefs: string[] = await trx('finance.collection_deposits')
        .where('tenant_id', tenantId)
        .whereNot('status', 'rechazado')
        .whereNotNull('ref_norm')
        .groupBy('ref_norm')
        .havingRaw('count(distinct sucursal || \'/\' || folio) > 1')
        .pluck('ref_norm');
      const dupSet = new Set(dupRefs);

      // Evidencia agregada por (sucursal, folio): cuántas, último estado, si alguna cuadra.
      const dep = trx('finance.collection_deposits')
        .select('sucursal', 'folio')
        .count('* as n')
        .select(trx.raw(`(array_agg(id ORDER BY created_at DESC))[1] AS last_id`))
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .select(trx.raw(`bool_or(monto_match) AS any_match`))
        .select(trx.raw(`bool_or(cuenta_propia = false) AS cuenta_ajena`))
        .select(trx.raw(`array_remove(array_agg(DISTINCT ref_norm) FILTER (WHERE status <> 'rechazado'), NULL) AS refs`))
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
          trx.raw('COALESCE(d.cuenta_ajena, false) AS cuenta_ajena'),
          trx.raw('d.refs AS refs'),
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
      applySmartSearch(b, q.search, {
        columns: ['c.cliente_nombre', 'c.cliente_code', 'c.folio'],
        numeric: ['c.monto'],
      });

      const rows = (await b).map((r: any) => {
        const refs: string[] = Array.isArray(r.refs) ? r.refs : [];
        const refDup = refs.some((x) => dupSet.has(x));
        const cuentaAjena = r.cuenta_ajena === true;
        const { refs: _drop, ...rest } = r;
        return { ...rest, monto: Number(r.monto), cuenta_ajena: cuentaAjena, ref_dup: refDup, alerta: cuentaAjena || refDup };
      });

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
        trx.raw('COUNT(*) FILTER (WHERE d.cuenta_ajena)::int AS cuentas_ajenas'),
      );

      return {
        kpis: {
          cobros: Number(k.cobros), con_comprobante: Number(k.con_comprobante),
          validados: Number(k.validados), monto_pendiente: Number(k.monto_pendiente),
          cuentas_ajenas: Number(k.cuentas_ajenas), refs_duplicadas: dupSet.size,
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

      // Control 1: ¿la cuenta destino de la ficha es una cuenta propia de la empresa?
      const tails = await this.ownBankTails(trx);
      const cuentaPropia = this.isOwnAccount(o.cuenta_dest, tails);

      // Control 2: ¿el folio electrónico ya está en otra ficha viva (mismo depósito
      // aplicado a dos cobros)? Se informa; el revisor decide (multi-folio legítimo vs doble).
      const ref = normRef(o.referencia);
      const refOtros = ref
        ? await trx('finance.collection_deposits')
            .where('ref_norm', ref)
            .whereNot('status', 'rechazado')
            .whereNot((qb: any) => { qb.where('sucursal', sucursal).andWhere('folio', folio); })
            .distinct('sucursal', 'folio')
            .then((rs: any[]) => rs.map((r) => `${r.sucursal}/${r.folio}`))
        : [];

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
          cuenta_propia: cuentaPropia,
          comentarios: (dto.comentarios || '').trim() || null,
          created_by: actor || null,
        })
        .returning(['id', 'sucursal', 'folio', 'status', 'monto_match']);
      this.logger.log(`ficha adjunta a cobro ${sucursal}/${folio} (match=${montoMatch}, cuenta_propia=${cuentaPropia}, ref_dup=${refOtros.length}) por ${actor || '?'}`);
      return { ...row, cuenta_propia: cuentaPropia, ref_duplicada: refOtros.length > 0, ref_otros: refOtros };
    });
  }

  /** Detalle: el cobro + sus fichas adjuntas (con los flags de control). */
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
          'ocr_referencia', 'ocr_ordenante', 'ocr_metodo', 'ocr_status', 'monto_match', 'cuenta_propia', 'ref_norm', 'status',
          'comentarios', 'validated_by', 'validated_at', 'motivo_rechazo', 'created_by', 'created_at');

      // Referencia duplicada: ¿algún ref_norm de estas fichas aparece en OTRO cobro (viva)?
      const refs = [...new Set(deposits.map((d: any) => d.ref_norm).filter(Boolean))];
      const otrosPorRef: Record<string, string[]> = {};
      if (refs.length) {
        const otros = await trx('finance.collection_deposits')
          .whereIn('ref_norm', refs as string[])
          .whereNot('status', 'rechazado')
          .whereNot((qb: any) => { qb.where('sucursal', sucursal).andWhere('folio', folio); })
          .distinct('ref_norm', 'sucursal', 'folio')
          .select('ref_norm', 'sucursal', 'folio');
        for (const r of otros) (otrosPorRef[r.ref_norm] ||= []).push(`${r.sucursal}/${r.folio}`);
      }
      // Conciliación YA persistida de este cobro (nivel cobro, no depósito): links en
      // finance.bank_recon_matches (tabla de CB) con kepler_doc_tipo='UA0501'.
      const matched = await this.linkedBankMovements(trx, sucursal, folio);
      const conciliado = matched.length > 0;

      const enriched = [] as any[];
      for (const d of deposits) {
        const otros = d.ref_norm ? otrosPorRef[d.ref_norm] || [] : [];
        // Three-way match: candidatos de abono (solo si aún no está conciliado).
        const cand = conciliado ? { estado: 'confirmado' as const, movimientos: [] } : await this.bankMatch(trx, {
          cuenta_dest: d.ocr_cuenta_dest,
          monto: d.ocr_monto != null ? Number(d.ocr_monto) : Number(cobro.monto),
          fecha: d.ocr_fecha || cobro.cobro_date,
        });
        enriched.push({
          ...d, ref_duplicada: otros.length > 0, ref_otros: otros,
          banco: { conciliado, estado: cand.estado, matched, candidatos: cand.movimientos },
        });
      }
      return { cobro: { ...cobro, monto: Number(cobro.monto) }, deposits: enriched };
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

  /**
   * Three-way match: busca en el estado de cuenta (finance.bank_movements, fase CB)
   * el ABONO real que corresponde a este depósito — por cuenta propia + monto (tol $1)
   * + fecha cercana. Es lo que prueba que el dinero ENTRÓ (la ficha solo prueba que se
   * depositó). Read-only: no escribe la conciliación, solo la informa.
   */
  private async bankMatch(
    trx: any,
    dep: { cuenta_dest?: string | null; monto?: number | null; fecha?: string | Date | null },
  ): Promise<{ estado: 'confirmado' | 'multiple' | 'sin_match' | 'sin_dato'; movimientos: any[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const target = dep.monto != null ? Number(dep.monto) : NaN;
    if (!isFinite(target) || target <= 0 || !dep.fecha) return { estado: 'sin_dato', movimientos: [] };

    // Ventana de fechas alrededor del depósito.
    const base = new Date(dep.fecha as any);
    if (isNaN(base.getTime())) return { estado: 'sin_dato', movimientos: [] };
    const from = new Date(base); from.setDate(from.getDate() - BANK_DAYS_BEFORE);
    const to = new Date(base); to.setDate(to.getDate() + BANK_DAYS_AFTER);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    // Si la ficha trae cuenta destino, restringir a esa cuenta propia; si no, todas.
    const acctId = await this.findOwnAccountId(trx, dep.cuenta_dest);

    const q = trx('finance.bank_movements as m')
      .join('finance.bank_accounts as a', 'a.id', 'm.bank_account_id')
      .leftJoin('finance.movement_categories as cat', 'cat.id', 'm.category_id')
      .where('m.tenant_id', tenantId)
      .whereRaw('m.amount_in BETWEEN ? AND ?', [target - BANK_TOL, target + BANK_TOL])
      .whereBetween('m.movement_date', [iso(from), iso(to)])
      .select('m.id', 'm.movement_date', trx.raw('m.amount_in::numeric AS amount_in'),
        'm.concept', 'a.bank', 'a.account_label', trx.raw(`cat.code AS categoria`))
      .orderBy('m.movement_date', 'asc')
      .limit(6);
    if (acctId) q.where('m.bank_account_id', acctId);

    const movimientos = (await q).map((r: any) => ({ ...r, amount_in: Number(r.amount_in) }));
    const estado = movimientos.length === 1 ? 'confirmado' : movimientos.length > 1 ? 'multiple' : 'sin_match';
    return { estado, movimientos };
  }

  /** ID de la cuenta de banco propia cuyo `account_label` es sufijo de la cuenta destino. */
  private async findOwnAccountId(trx: any, cuentaDest?: string | null): Promise<string | null> {
    const digits = String(cuentaDest ?? '').replace(/\D/g, '');
    if (!digits) return null;
    const accts = await trx('finance.bank_accounts')
      .where({ tenant_id: this.tenantCtx.requireTenantId(), kind: 'bank', active: true })
      .whereRaw(`account_label ~ '^[0-9]{3,}$'`)
      .select('id', 'account_label');
    const hit = accts.find((a: any) => digits.endsWith(a.account_label));
    return hit ? hit.id : null;
  }

  /** Etiquetas de cuenta (dígitos finales) de las cuentas de banco propias de la empresa. */
  private async ownBankTails(trx: any): Promise<string[]> {
    return trx('finance.bank_accounts')
      .where({ tenant_id: this.tenantCtx.requireTenantId(), kind: 'bank', active: true })
      .whereRaw(`account_label ~ '^[0-9]{3,}$'`)
      .pluck('account_label');
  }

  /** ¿La cuenta destino de la ficha termina en una cuenta propia? null = no verificable. */
  private isOwnAccount(cuentaDest: unknown, tails: string[]): boolean | null {
    const digits = String(cuentaDest ?? '').replace(/\D/g, '');
    if (!digits || !tails.length) return null;
    return tails.some((t) => t.length >= 3 && digits.endsWith(t));
  }

  /** Movimientos de banco ya ligados a este cobro (bank_recon_matches, UA0501). */
  private async linkedBankMovements(trx: any, sucursal: string, folio: string): Promise<any[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    const recon = await trx('finance.bank_recon_matches')
      .where({ tenant_id: tenantId, kepler_doc_tipo: 'UA0501', kepler_doc_folio: folio, kepler_sucursal: sucursal })
      .select('bank_movement_id', 'match_type', 'match_confidence', 'matched_by', 'created_at', trx.raw('kepler_amount::numeric AS kepler_amount'));
    if (!recon.length) return [];
    const byId = new Map(recon.map((r: any) => [r.bank_movement_id, r]));
    const movs = await trx('finance.bank_movements as m')
      .join('finance.bank_accounts as a', 'a.id', 'm.bank_account_id')
      .leftJoin('finance.movement_categories as cat', 'cat.id', 'm.category_id')
      .where('m.tenant_id', tenantId)
      .whereIn('m.id', recon.map((r: any) => r.bank_movement_id))
      .select('m.id', 'm.movement_date', trx.raw('m.amount_in::numeric AS amount_in'),
        'm.concept', 'a.bank', 'a.account_label', trx.raw('cat.code AS categoria'));
    return movs.map((m: any) => {
      const r: any = byId.get(m.id) || {};
      return { ...m, amount_in: Number(m.amount_in), match_type: r.match_type, matched_by: r.matched_by, matched_at: r.created_at, kepler_amount: r.kepler_amount != null ? Number(r.kepler_amount) : null };
    });
  }

  /**
   * El revisor CONFIRMA que el abono `bank_movement_id` corresponde a este cobro.
   * Persiste el cruce en finance.bank_recon_matches (tabla de CB) y marca el
   * movimiento como conciliado. Idempotente. Es el cierre del three-way match.
   */
  async confirmBank(depositId: string, bankMovementId: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    if (!bankMovementId) throw new BadRequestException('bank_movement_id requerido');
    return this.tk.run(async (trx) => {
      const dep = await trx('finance.collection_deposits').where({ id: depositId })
        .first('sucursal', 'folio', trx.raw('cobro_monto::numeric AS cobro_monto'));
      if (!dep) throw new BadRequestException('comprobante no encontrado');
      return this.writeReconMatch(trx, dep.sucursal, dep.folio, Number(dep.cobro_monto) || 0, bankMovementId, actor);
    });
  }

  /** Escribe el cruce cobro↔abono en bank_recon_matches + marca el movimiento matched. */
  private async writeReconMatch(trx: any, sucursal: string, folio: string, cobroMonto: number, bankMovementId: string, actor?: string) {
    const mov = await trx('finance.bank_movements').where({ id: bankMovementId })
      .first('id', trx.raw('amount_in::numeric AS amount_in'));
    if (!mov) throw new BadRequestException('movimiento bancario no encontrado');
    const matchType = Math.abs(Number(mov.amount_in) - cobroMonto) <= BANK_TOL ? 'exact' : 'manual';
    await trx('finance.bank_recon_matches')
      .insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        bank_movement_id: bankMovementId,
        kepler_sucursal: sucursal, kepler_doc_tipo: 'UA0501', kepler_doc_folio: folio,
        kepler_cuenta: '102', kepler_amount: cobroMonto,
        match_type: matchType, match_confidence: matchType === 'exact' ? 1 : 0.5,
        matched_by: actor || null,
      })
      .onConflict(['tenant_id', 'bank_movement_id', 'kepler_doc_tipo', 'kepler_doc_folio'])
      .merge({ kepler_amount: cobroMonto, match_type: matchType, matched_by: actor || null });
    await trx('finance.bank_movements').where({ id: bankMovementId }).update({ recon_status: 'matched', updated_at: trx.fn.now() });
    this.logger.log(`cobro ${sucursal}/${folio} conciliado con abono ${bankMovementId} (${matchType}) por ${actor || '?'}`);
    return { ok: true, cobro: `${sucursal}/${folio}`, bank_movement_id: bankMovementId, match_type: matchType };
  }

  /**
   * CASO B — bandeja de abonos que ENTRARON como cobranza pero NO están ligados a
   * ningún cobro de Kepler. Bank-first (lo inverso al three-way): banco → cobro.
   * `tiene_candidato=false` = abono huérfano de verdad (ingreso sin origen → investigar).
   */
  async listUnmatchedBank(q: { from?: string; to?: string; search?: string; solo_huerfanos?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
    return this.tk.run(async (trx) => {
      const candSql = `EXISTS (
        SELECT 1 FROM analytics.erp_collections ec
         WHERE ec.tenant_id = m.tenant_id
           AND ec.forma_pago IN ('deposito','transferencia','tarjeta')
           AND ec.monto BETWEEN m.amount_in - ${BANK_TOL} AND m.amount_in + ${BANK_TOL}
           AND ec.cobro_date BETWEEN m.movement_date - INTERVAL '${BANK_DAYS_AFTER} days' AND m.movement_date + INTERVAL '${BANK_DAYS_BEFORE} days'
           AND NOT EXISTS (SELECT 1 FROM finance.bank_recon_matches r2
                            WHERE r2.tenant_id = m.tenant_id AND r2.kepler_doc_tipo='UA0501' AND r2.kepler_doc_folio = ec.folio)
      )`;
      const base = () => {
        const b = trx('finance.bank_movements as m')
          .join('finance.bank_accounts as a', 'a.id', 'm.bank_account_id')
          .join('finance.movement_categories as c', 'c.id', 'm.category_id')
          .where('m.tenant_id', tenantId).where('c.code', 'cobranza').where('m.amount_in', '>', 0)
          .whereNotExists((qb: any) => qb.select(1).from('finance.bank_recon_matches as r').whereRaw('r.bank_movement_id = m.id'));
        if (q.from) b.where('m.movement_date', '>=', q.from);
        if (q.to) b.where('m.movement_date', '<=', q.to);
        if (q.search) b.whereRaw('m.concept ILIKE ?', [`%${q.search}%`]);
        return b;
      };
      const rowsQ = base()
        .select('m.id', 'm.movement_date', trx.raw('m.amount_in::numeric AS amount_in'), 'm.concept',
          'a.bank', 'a.account_label', trx.raw(`${candSql} AS tiene_candidato`))
        .orderBy('m.movement_date', 'desc').limit(limit);
      if (q.solo_huerfanos === '1') rowsQ.whereRaw(`NOT ${candSql}`);
      const rows = (await rowsQ).map((r: any) => ({ ...r, amount_in: Number(r.amount_in) }));

      const [k] = await base().select(
        trx.raw('COUNT(*)::int AS abonos'),
        trx.raw('COALESCE(SUM(m.amount_in),0)::numeric AS monto'),
        trx.raw(`COUNT(*) FILTER (WHERE NOT ${candSql})::int AS huerfanos`),
      );
      return { kpis: { abonos: Number(k.abonos), monto: Number(k.monto), huerfanos: Number(k.huerfanos) }, rows };
    });
  }

  /** Cobros candidatos para un abono huérfano (mismo monto ±$1, fecha cercana, sin ligar). */
  async cobroCandidates(bankMovementId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const mov = await trx('finance.bank_movements').where({ id: bankMovementId, tenant_id: tenantId })
        .first('id', trx.raw('amount_in::numeric AS amount_in'), 'movement_date');
      if (!mov) throw new BadRequestException('movimiento bancario no encontrado');
      const target = Number(mov.amount_in);
      const cobros = await trx('analytics.erp_collections as ec')
        .where('ec.tenant_id', tenantId)
        .whereIn('ec.forma_pago', CON_FICHA)
        .whereRaw('ec.monto BETWEEN ? AND ?', [target - BANK_TOL, target + BANK_TOL])
        .whereRaw(`ec.cobro_date BETWEEN ?::date - INTERVAL '${BANK_DAYS_AFTER} days' AND ?::date + INTERVAL '${BANK_DAYS_BEFORE} days'`, [mov.movement_date, mov.movement_date])
        .whereNotExists((qb: any) => qb.select(1).from('finance.bank_recon_matches as r')
          .whereRaw(`r.tenant_id = ec.tenant_id AND r.kepler_doc_tipo='UA0501' AND r.kepler_doc_folio = ec.folio`))
        .select('ec.sucursal', 'ec.folio', 'ec.cobro_date', 'ec.cliente_code', 'ec.cliente_nombre',
          'ec.forma_pago', trx.raw('ec.monto::numeric AS monto'))
        .orderBy('ec.cobro_date', 'desc').limit(15);
      return { movimiento: { id: mov.id, amount_in: target, movement_date: mov.movement_date }, cobros: cobros.map((c: any) => ({ ...c, monto: Number(c.monto) })) };
    });
  }

  /** Liga (bank-first) un abono a un cobro elegido. GESTIONAR. */
  async linkBankToCobro(bankMovementId: string, sucursal: string, folio: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    if (!bankMovementId || !sucursal || !folio) throw new BadRequestException('bank_movement_id, sucursal y folio requeridos');
    return this.tk.run(async (trx) => {
      const cobro = await trx('analytics.erp_collections')
        .where({ tenant_id: this.tenantCtx.requireTenantId(), sucursal, folio })
        .first(trx.raw('monto::numeric AS monto'));
      if (!cobro) throw new BadRequestException(`cobro ${sucursal}/${folio} no existe en Kepler`);
      return this.writeReconMatch(trx, sucursal, folio, Number(cobro.monto) || 0, bankMovementId, actor);
    });
  }

  /** Deshace la conciliación cobro↔abono. Revierte recon_status si el abono queda libre. */
  async unlinkBank(depositId: string, bankMovementId: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const dep = await trx('finance.collection_deposits').where({ id: depositId }).first('sucursal', 'folio');
      if (!dep) throw new BadRequestException('comprobante no encontrado');
      await trx('finance.bank_recon_matches')
        .where({ kepler_doc_tipo: 'UA0501', kepler_doc_folio: dep.folio, kepler_sucursal: dep.sucursal, bank_movement_id: bankMovementId })
        .del();
      const [rest] = await trx('finance.bank_recon_matches').where({ bank_movement_id: bankMovementId }).count('* as n');
      if (Number(rest.n) === 0) await trx('finance.bank_movements').where({ id: bankMovementId }).update({ recon_status: 'pending', updated_at: trx.fn.now() });
      return { ok: true };
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
