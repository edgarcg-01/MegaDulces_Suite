import { Injectable, BadRequestException, Logger, Optional } from '@nestjs/common';
import { TenantKnexService, TenantContextService, CloudinaryService, ObjectStorageService, applySmartSearch } from '@megadulces/platform-core';
import { LlmExtractorService, OcrReadingsService, DepositSlipFields } from '@megadulces/platform-core';
import { CobranzaGateway } from './cobranza.gateway';

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
// `[CC.12]` Topes de la enumeración de combinaciones (un pago que cubre varias pólizas).
// 18 cobros = 262,143 subconjuntos, ~10 ms. Por encima la respuesta deja de ser una sugerencia.
const COMBO_MAX_COBROS = 18;
const COMBO_MAX_OPCIONES = 5;

export interface DepositFile {
  role: string; url: string; public_id?: string; kind?: string; name?: string;
  /** Hash del contenido: con él `attach` recupera la lectura que hizo el servidor. */
  sha256?: string;
}

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
    private readonly storage: ObjectStorageService,
    private readonly ocr: LlmExtractorService,
    private readonly readings: OcrReadingsService,
    @Optional() private readonly gateway?: CobranzaGateway,
  ) {}

  /**
   * COMM-P1 — Empuja el cambio a la room del tenant (best-effort; nunca bloquea ni
   * tumba la operación). Se llama SIEMPRE fuera de la transacción, ya con el commit
   * hecho: el evento dispara un reload en las pantallas conectadas y no queremos que
   * lean una fila que todavía no existe.
   */
  private emit(
    action: 'attached' | 'validated' | 'rejected' | 'bank_matched' | 'bank_unmatched',
    ev: { sucursal: string; folio: string; status?: string | null; cliente?: string | null; monto?: number | null; actor?: string | null },
  ): void {
    try {
      this.gateway?.emitChange(this.tenantCtx.requireTenantId(), {
        action, sucursal: ev.sucursal, folio: ev.folio,
        status: ev.status ?? null, cliente: ev.cliente ?? null,
        monto: ev.monto ?? null, actor: ev.actor ?? null,
      });
    } catch (e: any) { this.logger.warn(`WS emit ${action} falló: ${e?.message || e}`); }
  }

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

  /**
   * FICHA-FIRST — dado el OCR de una ficha (monto + fecha), busca el/los cobros de
   * Kepler que le corresponden (mismo monto ±$1, fecha cercana), para adjuntar sin
   * tener que elegir el cobro a mano. Prioriza los que aún NO tienen comprobante.
   */
  async matchCobrosByOcr(q: { monto?: number; fecha?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const target = q.monto != null ? Number(q.monto) : NaN;
    if (!isFinite(target) || target <= 0) return { cobros: [] };
    const limit = Math.min(20, Math.max(1, Number(q.limit) || 12));
    return this.tk.run(async (trx) => {
      const dep = trx('finance.collection_deposits')
        .select('sucursal', 'folio').count('* as n')
        .select(trx.raw(`(array_agg(status ORDER BY created_at DESC))[1] AS last_status`))
        .groupBy('sucursal', 'folio').as('d');
      const b = trx('analytics.erp_collections as c')
        .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
        .where('c.tenant_id', tenantId)
        .whereIn('c.forma_pago', CON_FICHA)
        .whereRaw('c.monto BETWEEN ? AND ?', [target - BANK_TOL, target + BANK_TOL])
        .select('c.sucursal', 'c.folio', 'c.cobro_date', 'c.cliente_code', 'c.cliente_nombre',
          'c.forma_pago', trx.raw('c.monto::numeric AS monto'), 'c.tipo_cuenta',
          trx.raw('COALESCE(d.n,0)::int AS deposits'), trx.raw('d.last_status AS deposit_status'))
        .orderByRaw('COALESCE(d.n,0) ASC') // sin comprobante primero
        .orderBy('c.cobro_date', 'desc')
        .limit(limit);
      // Ventana de fechas alrededor de la fecha de la ficha (si el OCR la trajo).
      const base = q.fecha ? new Date(q.fecha) : null;
      if (base && !isNaN(base.getTime())) {
        const from = new Date(base); from.setDate(from.getDate() - 7);
        const to = new Date(base); to.setDate(to.getDate() + 7);
        b.whereBetween('c.cobro_date', [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]);
      }
      const cobros = (await b).map((r: any) => ({ ...r, monto: Number(r.monto) }));
      return { cobros };
    });
  }

  /** Sube UN archivo (ficha/evidencia) a Cloudinary y devuelve su referencia. Imagen o PDF. */
  async uploadFile(dataUri: string, role = 'deposito'): Promise<DepositFile> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    if (!DEPOSIT_FILE_ROLES.includes(role as DepositFileRole)) throw new BadRequestException(`role inválido: ${role}`);
    try {
      const f = await this.storage.putPdf(dataUri, `finance/${tenantId}/collection-deposits`); // solo PDF → Railway Bucket
      return { role, url: f.key, public_id: f.key, kind: f.kind };
    } catch (e: any) {
      if (e?.status === 400) throw e; // "Solo PDF" / "no configurado"
      this.logger.error(`fallo subiendo ficha (${role}): ${e?.message || e}`);
      throw new BadRequestException('no se pudo subir el archivo');
    }
  }

  /**
   * Corre OCR sobre la ficha (imagen/PDF) y devuelve los campos extraídos (preview, no
   * guarda). Devuelve además el `sha256` de la hoja: el cliente lo echa de vuelta al
   * adjuntar y `attach` recupera con él ESTA lectura, en vez de creerle al request.
   */
  async runOcr(dataUri: string): Promise<DepositSlipFields & { ocr_status: string; sha256: string }> {
    const scope = this.tenantCtx.requireTenantId();
    if (!dataUri) throw new BadRequestException('archivo requerido');
    const { mediaType, base64 } = this.parseDataUri(dataUri);
    const sha256 = this.readings.hash(base64);
    if (!process.env.ANTHROPIC_API_KEY) {
      // Degradación explícita: sin key no hay lectura, y el cuadre lo hace una persona.
      const vacio: DepositSlipFields = { monto: null, fecha: null, banco: null, cuenta_dest: null, referencia: null, ordenante: null, metodo: null };
      this.readings.remember(scope, sha256, vacio, 'sin_key');
      return { ...vacio, ocr_status: 'sin_key', sha256 };
    }
    const fields = await this.ocr.extractDepositSlip(base64, mediaType);
    const any = fields.monto != null || fields.fecha || fields.banco || fields.referencia;
    const ocr_status = any ? 'ok' : 'ilegible';
    this.readings.remember(scope, sha256, fields, ocr_status);
    return { ...fields, ocr_status, sha256 };
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

      // Lo que se guarda como lectura del modelo tiene que venir del modelo: de `o` salen
      // `monto_match` y el control de cuenta propia. Ver `OcrReadingsService`.
      const verificada = this.readings.recall<DepositSlipFields>(
        this.tenantCtx.requireTenantId(), files.find((f) => f.sha256)?.sha256);
      const o: Partial<DepositSlipFields> & { ocr_status?: string } =
        verificada ? { ...verificada.fields, ocr_status: verificada.status } : (dto.ocr || {});
      if (!verificada && dto.ocr) {
        this.logger.warn(`cobro ${sucursal}/${folio}: sin lectura verificada en memoria; se usa la del request`);
      }
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

      const [rowIns] = await trx('finance.collection_deposits')
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
      return {
        ...rowIns, cuenta_propia: cuentaPropia, ref_duplicada: refOtros.length > 0, ref_otros: refOtros,
        // solo para el evento WS de afuera; no forma parte del contrato del endpoint
        _ws: { cliente: cobro.cliente_nombre || null, monto: cobroMonto },
      };
    }).then((res: any) => {
      const { _ws, ...out } = res;
      this.emit('attached', { sucursal, folio, status: out.status, cliente: _ws?.cliente, monto: _ws?.monto, actor: actor || null });
      return out;
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
      // URL de lectura prefirmada (bucket privado); legacy Cloudinary queda igual.
      for (const d of deposits) d.files = await this.storage.signFiles(typeof d.files === 'string' ? JSON.parse(d.files || '[]') : (d.files || []));

      // Referencia duplicada: ¿algún ref_norm de estas fichas aparece en OTRO cobro (viva)?
      // Dedup SIN `[...new Set()]`: webpack lo downlevela a `[Set]` en el bundle de
      // la API (target ES2022 igual) → param inválido → 25P02. Usar filter+indexOf.
      const refs = deposits.map((d: any) => d.ref_norm).filter(Boolean)
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i);
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
        // sucursal/folio/cliente/monto viajan para el evento WS (aditivo: el front solo lee id+status)
        .returning(['id', 'status', 'sucursal', 'folio', 'cliente_nombre', trx.raw('cobro_monto::numeric AS cobro_monto')]);
      if (!row) throw new BadRequestException('evidencia no encontrada o ya validada');
      return row;
    }).then((row: any) => {
      this.emit('validated', { sucursal: row.sucursal, folio: row.folio, status: row.status, cliente: row.cliente_nombre, monto: Number(row.cobro_monto) || null, actor: actor || null });
      return row;
    });
  }

  /** Rechaza (con motivo). Auditado. */
  async reject(id: string, actor?: string, motivo?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.collection_deposits').where({ id }).whereIn('status', ['recibido', 'validado'])
        .update({ status: 'rechazado', validated_by: actor || null, validated_at: trx.fn.now(), motivo_rechazo: (motivo || '').trim() || 'rechazada', updated_at: trx.fn.now() })
        .returning(['id', 'status', 'sucursal', 'folio', 'cliente_nombre', trx.raw('cobro_monto::numeric AS cobro_monto')]);
      if (!row) throw new BadRequestException('evidencia no encontrada o ya rechazada');
      return row;
    }).then((row: any) => {
      this.emit('rejected', { sucursal: row.sucursal, folio: row.folio, status: row.status, cliente: row.cliente_nombre, monto: Number(row.cobro_monto) || null, actor: actor || null });
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
      const res = await this.writeReconMatch(trx, dep.sucursal, dep.folio, Number(dep.cobro_monto) || 0, bankMovementId, actor);
      return { ...res, _ws: { sucursal: dep.sucursal, folio: dep.folio, monto: Number(dep.cobro_monto) || null } };
    }).then((res: any) => {
      const { _ws, ...out } = res;
      this.emit('bank_matched', { sucursal: _ws.sucursal, folio: _ws.folio, monto: _ws.monto, actor: actor || null });
      return out;
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
   *
   * ── `[CC.8]` EL FILTRO QUE MIRABA EL 30% DEL DINERO ──────────────────────────────────────
   * Acá se buscaban candidatos **sólo** entre los cobros con `forma_pago IN (deposito,
   * transferencia, tarjeta)` (`CON_FICHA`). Pero `forma_pago` es un **regex sobre el concepto
   * capturado a mano** (`kdm1.c24`, ver `analytics.erp_collections`), y medido contra prod el
   * 2026-09-24 el cajón `'otro'` —el ELSE, o sea *"el texto no trajo la palabra"*— se lleva
   * **17,675 cobros y $318,562,566.39: el 70.1% del dinero cobrado en 2026**.
   *
   * `'otro'` NO significa "sin ficha". Filtrar por eso es **inferir de un silencio**, y el
   * efecto se midió con el mismo cruce cambiando sólo el universo de candidatos (17,662 abonos
   * sin ligar, feb–ago 2026), cada uno contra su placebo —las mismas fechas corridas +90 días,
   * dentro del rango poblado— porque un cruce por importe sin piso de ruido no dice nada:
   *
   *     universo                      casan            ruido      margen
   *     CON_FICHA (lo que había) .... 18.7%  (3,303)    2.2%      16.5 pp
   *     sin el filtro ............... 78.0% (13,772)    7.6%      70.4 pp
   *
   * Quitarlo recupera **10,469 abonos por $192,631,803.14** y baja los huérfanos de **14,359 a
   * 3,890** ($284,995,182.13 → $92,363,378.99). `CON_FICHA` **se conserva** donde sí
   * corresponde: en el listado de fichas (`listar`), porque la ficha de depósito sólo existe
   * para esas formas de pago. Acá no se buscaba una ficha, se buscaba un cobro.
   *
   * ⚠️ **Con 7.6% de ruido, 1 de cada 10 «candidatos» puede ser casualidad.** Por eso esto
   * **propone** y nunca liga: el cruce marca `tiene_candidato` y el humano elige en
   * `cobroCandidates()` + `linkBankToCobro()`. Cero auto-ligado.
   *
   * ⚠️ Además: la consulta anterior **no filtraba `deleted_at`**, así que los movimientos
   * borrados entraban al conteo. Ahora sí.
   */
  async listUnmatchedBank(q: { from?: string; to?: string; search?: string; solo_huerfanos?: string; limit?: number }) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
    return this.tk.run(async (trx) => {
      // ⚠️ Los filtros del usuario van DENTRO de `mov`, que es el segundo `?` de la consulta.
      // El orden de los bindings lo fija el TEXTO del SQL (ligados → mov → filtros → cobx), no
      // el orden en que uno los piensa; por eso se arma explícito abajo y no acumulando.
      const cond: string[] = [];
      const filtros: any[] = [];
      if (q.from) { cond.push('AND m.movement_date >= ?'); filtros.push(q.from); }
      if (q.to) { cond.push('AND m.movement_date <= ?'); filtros.push(q.to); }
      if (q.search) { cond.push('AND m.concept ILIKE ?'); filtros.push(`%${q.search}%`); }

      const sql = `
        -- [CC.9] Los folios YA ligados, aparte y materializados. Meter este NOT EXISTS dentro
        -- de "cob" era lo que mataba la consulta: el planificador estima esa CTE en rows=1
        -- cuando trae ~24,000, elige Nested Loop Anti Join y recorre bank_recon_matches por
        -- cada cobro. Es la misma mala estimacion que documento [PERF.4b] para
        -- erp_sales_invoices, y aca costaba lo mismo: >5 min sin terminar.
        WITH ligados AS MATERIALIZED (
          SELECT DISTINCT kepler_doc_folio AS folio
            FROM finance.bank_recon_matches
           WHERE tenant_id = ? AND kepler_doc_tipo = 'UA0501'
        ),
        mov AS MATERIALIZED (
          SELECT m.id, m.movement_date, m.amount_in::numeric AS amount_in, m.concept,
                 a.bank, a.account_label, round(m.amount_in)::bigint AS cubeta,
                 m.customer_code, m.customer_nota, m.customer_declared_by,
                 m.customer_declared_at
            FROM finance.bank_movements m
            JOIN finance.bank_accounts a ON a.id = m.bank_account_id
            JOIN finance.movement_categories c ON c.id = m.category_id
           WHERE m.tenant_id = ? AND c.code = 'cobranza' AND m.amount_in > 0
             AND m.deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM finance.bank_recon_matches r
                              WHERE r.bank_movement_id = m.id)
             ${cond.join(' ')}
        ),
        -- [CC.8] Los cobros de Kepler que TODAVIA no estan ligados a ningun abono.
        -- NO se filtra por forma_pago. El porque, con sus numeros, en el JSDoc del metodo.
        --
        -- [CC.9] Cada cobro se expande a SUS TRES CUBETAS de monto. Con tolerancia de
        -- ${BANK_TOL} peso, un cobro que case esta a lo sumo una cubeta de distancia, asi que
        -- tres filas por cobro convierten el cruce en una IGUALDAD -- y por igualdad Postgres
        -- hace hash join. Se expande este lado (24k -> 72k) y no el de los abonos porque es
        -- el que despues se sondea.
        cobx AS MATERIALIZED (
          SELECT ec.cobro_date, ec.monto, b.cubeta
            FROM analytics.erp_collections ec
            LEFT JOIN ligados l ON l.folio = ec.folio
            CROSS JOIN LATERAL (VALUES (round(ec.monto)::bigint - 1),
                                       (round(ec.monto)::bigint),
                                       (round(ec.monto)::bigint + 1)) AS b(cubeta)
           WHERE ec.tenant_id = ? AND l.folio IS NULL
        ),
        cand AS (
          SELECT DISTINCT m.id
            FROM mov m
            JOIN cobx k ON k.cubeta = m.cubeta
           WHERE abs(k.monto - m.amount_in) <= ${BANK_TOL}
             AND k.cobro_date BETWEEN m.movement_date - INTERVAL '${BANK_DAYS_AFTER} days'
                                  AND m.movement_date + INTERVAL '${BANK_DAYS_BEFORE} days'
        ),
        marcado AS (
          SELECT m.*, (c.id IS NOT NULL) AS tiene_candidato
            FROM mov m LEFT JOIN cand c ON c.id = m.id
        )
        SELECT
          (SELECT jsonb_build_object(
              'abonos', count(*)::int,
              'monto', COALESCE(sum(amount_in), 0)::numeric,
              'huerfanos', count(*) FILTER (WHERE NOT tiene_candidato)::int,
              -- [CC.11] De los que no tienen cobro, cuantos YA tienen duenio declarado: es la
              -- parte del callejon sin salida que alguien ya desatoro.
              'con_cliente', count(*) FILTER (
                 WHERE NOT tiene_candidato AND customer_code IS NOT NULL)::int)
             FROM marcado) AS kpis,
          -- [CC.11] El nombre del cliente declarado se resuelve DESPUES del LIMIT, sobre las
          -- ${limit} filas que se devuelven y no sobre las ~20 mil del universo. Resolverlo
          -- arriba costaba 20,386 ms contra 361: el LATERAL contra kdud (18 mil filas, sin
          -- indice por btrim(c2)) se planifica por fila aunque el ON sea falso.
          -- Si el codigo ya no existe en el catalogo, viaja el codigo pelado y NO se esconde:
          -- es la senal de que esa declaracion hay que revisarla.
          COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.movement_date DESC) FROM (
              SELECT p.*, n.cliente_nombre AS customer_nombre
                FROM (
                  SELECT id, movement_date, amount_in, concept, bank, account_label,
                         tiene_candidato, customer_code, customer_nota,
                         customer_declared_by, customer_declared_at
                    FROM marcado
                   WHERE ${q.solo_huerfanos === '1' ? 'NOT tiene_candidato' : 'true'}
                   ORDER BY movement_date DESC
                   LIMIT ${limit}
                ) p
                LEFT JOIN LATERAL (
                  SELECT NULLIF(btrim(u.c3), '') AS cliente_nombre
                    FROM kepler_ods.kdud u
                   WHERE btrim(u.c2) = btrim(p.customer_code) LIMIT 1
                ) n ON p.customer_code IS NOT NULL
              ) x), '[]'::jsonb) AS rows`;

      const r = await trx.raw(sql, [tenantId, tenantId, ...filtros, tenantId]);
      const out = r.rows[0];
      const k = out.kpis || { abonos: 0, monto: 0, huerfanos: 0 };
      return {
        kpis: {
          abonos: Number(k.abonos), monto: Number(k.monto), huerfanos: Number(k.huerfanos),
          con_cliente: Number(k.con_cliente) || 0,
        },
        rows: ((out.rows as any[]) || []).map((x) => ({ ...x, amount_in: Number(x.amount_in) })),
      };
    });
  }

  /**
   * `[CC.11]` **Declara de quién es un depósito que Kepler todavía no registró.**
   *
   * Para los **5,240 abonos por $118.9M** que ningún cobro explica, «Ligar» no tiene a qué
   * ligar: se acaba el camino. Y el dato **no existe en ninguna fuente** —el banco no dice quién
   * pagó, ContPAQi lleva clientes por sucursal × régimen de IVA, no hay CFDIs emitidos—, así que
   * **lo pone una persona o no se sabe**.
   *
   * ⛔ **Esto NO es el cobro y no lo sustituye.** No escribe a Kepler, no salda nada, no toca la
   * cartera. Dice *«este depósito es de tal cliente y Kepler aún no lo tiene»*, que es lo que
   * cobranza necesita para dejar de llamar a quien ya pagó, y la pista para que alguien capture
   * el cobro. Cuando el cobro aparezca, se liga por el camino que ya existe (`linkBankToCobro`).
   *
   * ⚠️ El código de cliente **se valida contra el catálogo de Kepler**: una declaración con un
   * código inventado sería peor que ninguna, porque se vería igual de firme.
   */
  async declararCliente(
    bankMovementId: string,
    dto: { customer_code?: string | null; nota?: string | null },
    actor?: string,
  ) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!bankMovementId) throw new BadRequestException('bank_movement_id requerido');
    const code = (dto?.customer_code ?? '').trim();

    return this.tk.run(async (trx) => {
      const mov = await trx('finance.bank_movements')
        .where({ id: bankMovementId, tenant_id: tenantId })
        .whereNull('deleted_at')
        .first('id', 'amount_in', 'movement_date');
      if (!mov) throw new BadRequestException('movimiento bancario no encontrado');

      // Quitar la declaración es legítimo (alguien se equivocó): código vacío la borra entera,
      // incluido el autor — una firma sin afirmación no dice nada.
      if (!code) {
        await trx('finance.bank_movements').where({ id: bankMovementId }).update({
          customer_code: null, customer_nota: null,
          customer_declared_by: null, customer_declared_at: null,
          updated_at: trx.fn.now(),
        });
        return { ok: true, bank_movement_id: bankMovementId, customer_code: null };
      }

      const cli = (await trx.raw(
        `SELECT NULLIF(btrim(u.c3), '') AS nombre FROM kepler_ods.kdud u
          WHERE btrim(u.c2) = ? LIMIT 1`, [code])).rows[0];
      if (!cli) {
        throw new BadRequestException(
          `el cliente "${code}" no existe en el catálogo de Kepler. Una declaración con un `
          + 'código inventado se ve igual de firme que una buena.');
      }

      await trx('finance.bank_movements').where({ id: bankMovementId }).update({
        customer_code: code,
        customer_nota: (dto?.nota ?? '').trim() || null,
        customer_declared_by: actor || null,
        customer_declared_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
      this.emit('bank_matched', { sucursal: '00', folio: `mov:${bankMovementId}` });
      return {
        ok: true, bank_movement_id: bankMovementId,
        customer_code: code, customer_nombre: cli.nombre || null,
      };
    });
  }

  /**
   * Cobros candidatos para un abono (mismo monto ±$1, fecha cercana, sin ligar).
   *
   * `[CC.8]` Sin el filtro de `forma_pago` — mismo motivo que en `listUnmatchedBank`: dejaba
   * fuera el 70.1% del dinero cobrado. Se expone `forma_pago` en cada candidato para que el
   * revisor lo vea, que es distinto de usarlo como compuerta.
   */
  async cobroCandidates(bankMovementId: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const mov = await trx('finance.bank_movements').where({ id: bankMovementId, tenant_id: tenantId })
        .first('id', trx.raw('amount_in::numeric AS amount_in'), 'movement_date', 'customer_code');
      if (!mov) throw new BadRequestException('movimiento bancario no encontrado');
      const target = Number(mov.amount_in);
      const cobros = await trx('analytics.erp_collections as ec')
        .where('ec.tenant_id', tenantId)
        .whereRaw('ec.monto BETWEEN ? AND ?', [target - BANK_TOL, target + BANK_TOL])
        .whereRaw(`ec.cobro_date BETWEEN ?::date - INTERVAL '${BANK_DAYS_AFTER} days' AND ?::date + INTERVAL '${BANK_DAYS_BEFORE} days'`, [mov.movement_date, mov.movement_date])
        .whereNotExists((qb: any) => qb.select(1).from('finance.bank_recon_matches as r')
          .whereRaw(`r.tenant_id = ec.tenant_id AND r.kepler_doc_tipo='UA0501' AND r.kepler_doc_folio = ec.folio`))
        .select('ec.sucursal', 'ec.folio', 'ec.cobro_date', 'ec.cliente_code', 'ec.cliente_nombre',
          'ec.forma_pago', trx.raw('ec.monto::numeric AS monto'))
        .orderBy('ec.cobro_date', 'desc').limit(15);
      // [CC.12] La combinacion: SOLO si alguien ya declaro de quien es el deposito.
      const combos = mov.customer_code
        ? await this.combinaciones(trx, tenantId, String(mov.customer_code), target, mov.movement_date)
        : null;

      return {
        movimiento: {
          id: mov.id, amount_in: target, movement_date: mov.movement_date,
          customer_code: mov.customer_code || null,
        },
        cobros: cobros.map((c: any) => ({ ...c, monto: Number(c.monto) })),
        suma: combos ?? {
          disponible: false,
          motivo: 'sin_cliente_declarado',
          detalle: 'Sin dueno declarado no se ofrecen combinaciones: contra todos los clientes, '
            + '4 de cada 10 sumas que cuadran son casualidad (28.3% contra 11.7% de placebo). '
            + 'Declara el cliente y la combinacion se busca solo entre SUS cobros.',
        },
      };
    });
  }

  /**
   * `[CC.12]` **Las combinaciones de cobros que suman el deposito — de UN cliente declarado.**
   *
   * El caso que motiva esto: *un abono de $50,000 que paga tres polizas*. El pareo 1:1 no puede
   * funcionar ahi **por construccion**. Medido contra prod el 2026-09-24 sobre las aplicaciones
   * del ERP (`kepler_ods.kdm5` filtrado a `U-A-5`): **293 cobros por $11,083,196.14 aplican a 2
   * o mas facturas — el 2.5% del dinero cobrado**, y uno de ellos a **45**.
   *
   * ⚠️ Esta cifra estuvo **inflada a 12.0% / $56.1M / 186 facturas** en la primera medicion,
   * por agrupar `kdm5` sin filtrar el doctype: el folio **no es unico entre doctypes** y se
   * mezclaban los `U-A-7` (embarques) con los cobros. Es la misma trampa que ya cobro en
   * `[CC ext]` con las ordenes de entrada. El total cuadra: $440,145,499.57 de un solo
   * documento + $11,083,196.14 de varios = $451.2M, el universo cobrado.
   *
   * ⛔ **La combinacion NO se ofrece a ciegas.** Buscar que subconjunto suma, contra todos los
   * clientes, se midio: explica el **28.3%** de los huerfanos grandes contra un **placebo del
   * 11.7%** (las mismas fechas corridas +90 dias, dentro del rango poblado). Margen 16.7 pp, o
   * sea **4 de cada 10 aciertos serian casualidad** — inservible para proponerselo a una
   * persona. Contra el 1:1, que da 78.0% sobre 7.6% de ruido.
   *
   * Lo que cambia el resultado es **el cliente declarado** (`[CC.11]`): restringe el universo de
   * 2,269 grupos a los de una sola cuenta, donde un grupo tipico tiene 2 a 4 cobros (≤16
   * combinaciones). Por eso esto **depende** de que alguien haya puesto el dueno, y si no lo
   * hay **se declara el motivo**, no se ofrece una lista debil.
   *
   * La enumeracion va en JS y no en SQL a proposito: subset-sum en SQL exige una recursiva que
   * el planificador no puede acotar. Aca el universo ya viene recortado a un cliente y una
   * ventana, y se mide: 600 depositos contra 2,269 grupos tardaron 424 ms.
   */
  private async combinaciones(
    trx: any, tenantId: string, customerCode: string, target: number, movementDate: any,
  ) {
    const libres = await trx('analytics.erp_collections as ec')
      .where('ec.tenant_id', tenantId)
      .whereRaw('btrim(ec.cliente_code) = ?', [customerCode.trim()])
      .whereRaw(
        `ec.cobro_date BETWEEN ?::date - INTERVAL '${BANK_DAYS_AFTER} days'
                           AND ?::date + INTERVAL '${BANK_DAYS_BEFORE} days'`,
        [movementDate, movementDate])
      .whereNotExists((qb: any) => qb.select(1).from('finance.bank_recon_matches as r')
        .whereRaw("r.tenant_id = ec.tenant_id AND r.kepler_doc_tipo='UA0501' AND r.kepler_doc_folio = ec.folio"))
      .select('ec.sucursal', 'ec.folio', 'ec.cobro_date', 'ec.cliente_nombre', 'ec.forma_pago',
        trx.raw('ec.monto::numeric AS monto'))
      .orderBy('ec.cobro_date', 'desc')
      .limit(COMBO_MAX_COBROS + 1);

    const items = libres.map((c: any) => ({ ...c, monto: Number(c.monto) }));
    if (items.length < 2) {
      return { disponible: false, motivo: 'sin_cobros_libres', cobros_libres: items.length,
        detalle: 'Ese cliente no tiene 2 o mas cobros sin ligar en la ventana.' };
    }
    // El tope no se esconde: por encima de el la enumeracion se vuelve 2^n y la respuesta
    // dejaria de ser una sugerencia para ser una lista de todo lo posible.
    if (items.length > COMBO_MAX_COBROS) {
      return { disponible: false, motivo: 'demasiados_cobros', cobros_libres: items.length,
        detalle: `Ese cliente tiene ${items.length} cobros sin ligar en la ventana (tope `
          + `${COMBO_MAX_COBROS}). Conviene ligar de a uno los que si casan y volver.` };
    }

    const n = items.length;
    const opciones: { total: number; cobros: any[] }[] = [];
    for (let mask = 1; mask < (1 << n) && opciones.length < COMBO_MAX_OPCIONES; mask++) {
      let suma = 0; let cuantos = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) { suma += items[i].monto; cuantos++; }
      if (cuantos < 2) continue;  // el de 1 ya lo ofrece la lista individual
      if (Math.abs(suma - target) > BANK_TOL) continue;
      const elegidos = items.filter((_: any, i: number) => mask & (1 << i));
      opciones.push({ total: Number(suma.toFixed(2)), cobros: elegidos });
    }
    opciones.sort((a, b) => a.cobros.length - b.cobros.length);
    return {
      disponible: opciones.length > 0,
      motivo: opciones.length ? null : 'ninguna_suma_cuadra',
      cobros_libres: n,
      opciones,
      detalle: opciones.length
        ? 'Cada opcion liga VARIOS cobros a este abono. Revisala antes de confirmar: cuadrar '
          + 'por monto no prueba que sean estos.'
        : 'Ninguna combinacion de sus cobros sin ligar suma este deposito.',
    };
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
      const res = await this.writeReconMatch(trx, sucursal, folio, Number(cobro.monto) || 0, bankMovementId, actor);
      return { ...res, _ws: { monto: Number(cobro.monto) || null } };
    }).then((res: any) => {
      const { _ws, ...out } = res;
      this.emit('bank_matched', { sucursal, folio, monto: _ws.monto, actor: actor || null });
      return out;
    });
  }

  /**
   * `[CC.12]` **Liga UN abono a VARIOS cobros, en una sola transacción.**
   *
   * Es el caso del pedido: *un pago de $50,000 que cubre tres pólizas*. No hace falta tocar el
   * schema — la UNIQUE de `bank_recon_matches` es `(tenant, movimiento, tipo, folio)`, o sea que
   * 1:N ya cabía y **ya se usa en prod** (hay abonos con 2, 3 y hasta 5 documentos). Lo que
   * faltaba era que las N filas entraran **juntas**: ligarlas de a una desde la pantalla deja
   * medio abono conciliado si la segunda falla.
   *
   * ⚠️ `match_type` se decide contra la **suma**, no contra cada cobro: cada pieza por separado
   * es menor que el depósito y se marcaría `manual` (confianza 0.5) aunque el grupo cuadre
   * exacto. Juzgar la parte con la vara del todo era describir mal un cruce bueno.
   */
  async linkBankToCobros(
    bankMovementId: string, items: { sucursal: string; folio: string }[], actor?: string,
  ) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!bankMovementId) throw new BadRequestException('bank_movement_id requerido');
    const lista = (items || []).filter((i) => i?.sucursal && i?.folio);
    if (!lista.length) throw new BadRequestException('hay que elegir al menos un cobro');

    return this.tk.run(async (trx) => {
      const mov = await trx('finance.bank_movements')
        .where({ id: bankMovementId, tenant_id: tenantId }).whereNull('deleted_at')
        .first('id', trx.raw('amount_in::numeric AS amount_in'));
      if (!mov) throw new BadRequestException('movimiento bancario no encontrado');

      const cobros: any[] = [];
      for (const it of lista) {
        const c = await trx('analytics.erp_collections')
          .where({ tenant_id: tenantId, sucursal: it.sucursal, folio: it.folio })
          .first(trx.raw('monto::numeric AS monto'));
        if (!c) throw new BadRequestException(`cobro ${it.sucursal}/${it.folio} no existe en Kepler`);
        cobros.push({ ...it, monto: Number(c.monto) || 0 });
      }
      const suma = cobros.reduce((a, c) => a + c.monto, 0);
      const exacto = Math.abs(Number(mov.amount_in) - suma) <= BANK_TOL;

      for (const c of cobros) {
        await trx('finance.bank_recon_matches').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          bank_movement_id: bankMovementId,
          kepler_sucursal: c.sucursal, kepler_doc_tipo: 'UA0501', kepler_doc_folio: c.folio,
          kepler_cuenta: '102', kepler_amount: c.monto,
          match_type: exacto ? 'exact' : 'manual',
          match_confidence: exacto ? 1 : 0.5,
          matched_by: actor || null,
        })
        .onConflict(['tenant_id', 'bank_movement_id', 'kepler_doc_tipo', 'kepler_doc_folio'])
        .merge({ kepler_amount: c.monto, match_type: exacto ? 'exact' : 'manual',
                 matched_by: actor || null });
      }
      await trx('finance.bank_movements').where({ id: bankMovementId })
        .update({ recon_status: 'matched', updated_at: trx.fn.now() });

      this.logger.log(
        `abono ${bankMovementId} conciliado con ${cobros.length} cobros (suma ${suma.toFixed(2)} `
        + `vs ${Number(mov.amount_in).toFixed(2)}, ${exacto ? 'exact' : 'manual'}) por ${actor || '?'}`);
      return {
        ok: true, bank_movement_id: bankMovementId, cobros: cobros.length,
        suma: Number(suma.toFixed(2)), amount_in: Number(mov.amount_in),
        match_type: exacto ? 'exact' : 'manual',
        _ws: { monto: suma },
      };
    }).then((res: any) => {
      const { _ws, ...out } = res;
      this.emit('bank_matched', { sucursal: '00', folio: `mov:${bankMovementId}`,
        monto: _ws.monto, actor: actor || null });
      return out;
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
      return { ok: true, _ws: { sucursal: dep.sucursal, folio: dep.folio } };
    }).then((res: any) => {
      const { _ws, ...out } = res;
      this.emit('bank_unmatched', { sucursal: _ws.sucursal, folio: _ws.folio });
      return out;
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
