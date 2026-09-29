import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import type {
  CreatePurchaseDeliveryDto, DeliveryDateBasis, DeliveryRecipient, PendingReceiptRow, PendingReceiptsResponse,
  PurchaseDeliveryDetail, PurchaseDeliveryLine, PurchaseDeliveryStatus, PurchaseDeliverySummary, ReceiptEvidenceStatus,
  ReceiptKey,
} from '@megadulces/contracts';

/** Tope de renglones por entrega: una semana del CEDIS son ~100; 500 es holgura, no un límite de negocio. */
const MAX_ITEMS = 500;
/** Tope de la lista de pendientes (medido: ~32 entradas/día en toda la red). Se declara si se alcanza. */
const MAX_PENDING = 3000;
/** Departamentos cuya gente puede RECIBIR una entrega (además de tener FINANCE_PAYMENTS_GESTIONAR). */
const RECIPIENT_DEPARTMENTS = ['finanzas', 'tesoreria'];

interface Readiness { view: boolean; tables: boolean; internal: boolean }
type Trx = Knex.Transaction;

interface RawPending {
  sucursal: string; doc_prefix: string; folio: string; oc_folio: string | null;
  supplier_code: string | null; supplier_name: string | null;
  invoice_date: string | null; reception_date: string | null; reception_source: 'vale' | 'aplicacion' | null;
  amount: string | number; kepler_due_date: string | null; evidence_status: string | null;
  days_waiting: number | null; times_rejected: number | null; last_rejection_reason: string | null;
}

/**
 * `[RE.32]` — Entrega de compras recibidas a Finanzas.
 *
 * Pendientes = órdenes de entrada de `analytics.erp_goods_receipts` (vista viva sobre `kepler_ods`)
 * que no están en una entrega VIVA. Orden: sucursal (el "brinco"), fecha elegida, proveedor A-Z
 * (Francisco, 2026-09-29). La fecha puede ser la de RECEPCIÓN (captura del vale en Kepler, RE.31) o
 * la de FACTURA.
 *
 * El check del auxiliar es su CONSTANCIA de que tiene el papel y está validado; el estado de la
 * evidencia en `/compras/entradas` se muestra como referencia y no bloquea (medido: 0 de ~970
 * entradas de 30 días están "validadas" en el sistema).
 *
 * Las tablas y la columna de recepción llegan por migraciones que aplica el PM aparte del despliegue:
 * cada pieza se sondea por separado y, si falta, se DECLARA (`schema_ready: false`) en vez de dar 500.
 */
@Injectable()
export class PurchaseDeliveriesService {
  private readonly logger = new Logger(PurchaseDeliveriesService.name);
  /** Sólo se recuerda el SÍ (si se aplica la migración con la API arriba, se ve en la siguiente consulta). */
  private readyCache: Readiness | null = null;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private async readiness(trx: Trx): Promise<Readiness> {
    if (this.readyCache) return this.readyCache;
    const { rows } = await trx.raw(`SELECT
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('analytics.erp_goods_receipts')
                  AND attname = 'fecha_recepcion' AND NOT attisdropped) AS view,
        (to_regclass('commercial.purchase_deliveries') IS NOT NULL
          AND to_regclass('commercial.purchase_delivery_lines') IS NOT NULL
          AND to_regclass('commercial.purchase_delivery_sequences') IS NOT NULL) AS tables,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'catalog.suppliers'::regclass
                  AND attname = 'is_internal' AND NOT attisdropped) AS internal`);
    const r: Readiness = { view: !!rows[0]?.view, tables: !!rows[0]?.tables, internal: !!rows[0]?.internal };
    if (r.view && r.tables && r.internal) this.readyCache = r;
    else this.logger.warn(`RE.32: migraciones pendientes — vista=${r.view} tablas=${r.tables} internos=${r.internal}`);
    return r;
  }

  private static readonly ymd = /^\d{4}-\d{2}-\d{2}$/;

  async pending(q: { date_basis?: DeliveryDateBasis; from?: string; to?: string; sucursal?: string }): Promise<PendingReceiptsResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const from = q.from && PurchaseDeliveriesService.ymd.test(q.from) ? q.from : null;
    const to = q.to && PurchaseDeliveriesService.ymd.test(q.to) ? q.to : null;
    if (from && to && from > to) throw new BadRequestException('La fecha inicial es posterior a la final.');

    return this.tk.run(async (trx) => {
      const ready = await this.readiness(trx);
      // Sin la columna de recepción no se puede filtrar por ella: se cae a factura y se DECLARA.
      const basis: DeliveryDateBasis = q.date_basis === 'factura' || !ready.view ? 'factura' : 'recepcion';
      const recepCol = ready.view ? 'r.fecha_recepcion' : 'NULL::date';
      const recepSrc = ready.view ? 'r.fecha_recepcion_fuente' : 'NULL::text';
      const dateExpr = basis === 'recepcion' ? 'r.fecha_recepcion' : 'r.receipt_date';

      const where: string[] = ['r.tenant_id = :t', 'r.dup_of_folio IS NULL', 'r.monto > 0'];
      const b: Record<string, unknown> = { t: tenantId, max: MAX_PENDING + 1 };
      if (from) { where.push(`${dateExpr} >= :from::date`); b.from = from; }
      if (to) { where.push(`${dateExpr} <= :to::date`); b.to = to; }
      if (q.sucursal) { where.push('r.sucursal = :suc'); b.suc = q.sucursal; }
      if (ready.tables) {
        where.push(`NOT EXISTS (SELECT 1 FROM commercial.purchase_delivery_lines l
                     WHERE l.tenant_id = r.tenant_id AND l.receipt_sucursal = r.sucursal AND l.receipt_doc_prefix = r.doc_prefix
                       AND l.receipt_folio = r.folio AND l.status IN ('entregado','aceptado'))`);
      }
      const internal = ready.internal ? 'COALESCE(s.is_internal, false)' : 'false';

      const rejJoin = ready.tables
        ? `LEFT JOIN LATERAL (SELECT count(*)::int AS n,
               (array_agg(l.rejection_reason ORDER BY l.decided_at DESC))[1] AS last_reason
             FROM commercial.purchase_delivery_lines l
            WHERE l.tenant_id = r.tenant_id AND l.receipt_sucursal = r.sucursal AND l.receipt_doc_prefix = r.doc_prefix
              AND l.receipt_folio = r.folio AND l.status = 'rechazado') rj ON true`
        : 'LEFT JOIN LATERAL (SELECT 0 AS n, NULL::text AS last_reason) rj ON true';

      const base = `
        FROM analytics.erp_goods_receipts r
        LEFT JOIN catalog.suppliers s ON s.tenant_id = r.tenant_id AND btrim(s.code) = r.proveedor_code AND s.deleted_at IS NULL
        LEFT JOIN LATERAL (SELECT p.status FROM finance.goods_receipt_proofs p
                            WHERE p.tenant_id = r.tenant_id AND p.sucursal = r.sucursal AND p.folio = r.folio
                            ORDER BY p.created_at DESC LIMIT 1) ev ON true
        ${rejJoin}
        WHERE ${where.join(' AND ')}`;

      const { rows } = await trx.raw(`
        SELECT r.sucursal, r.doc_prefix, r.folio, r.oc_folio,
               r.proveedor_code AS supplier_code, r.proveedor_nombre AS supplier_name,
               to_char(r.receipt_date, 'YYYY-MM-DD') AS invoice_date,
               to_char(${recepCol}, 'YYYY-MM-DD') AS reception_date,
               ${recepSrc} AS reception_source,
               r.monto AS amount,
               to_char(r.fecha_vence, 'YYYY-MM-DD') AS kepler_due_date,
               ev.status AS evidence_status,
               (current_date - COALESCE(${recepCol}, r.receipt_date))::int AS days_waiting,
               rj.n AS times_rejected, rj.last_reason AS last_rejection_reason
        ${base} AND NOT ${internal}
        ORDER BY r.sucursal, ${dateExpr} NULLS LAST, r.proveedor_nombre NULLS LAST, r.folio
        LIMIT :max`, b);

      const { rows: cnt } = await trx.raw(`
        SELECT count(*) FILTER (WHERE ${internal})::int AS internos
        ${base}`, b);
      let sinRecepcion = 0;
      if (basis === 'recepcion') {
        const wb = { ...b };
        const w2 = where.filter((x) => !x.startsWith(dateExpr));
        const { rows: nr } = await trx.raw(
          `SELECT count(*)::int AS n FROM analytics.erp_goods_receipts r WHERE ${w2.join(' AND ')} AND r.fecha_recepcion IS NULL`, wb);
        sinRecepcion = nr[0]?.n ?? 0;
      }

      if (rows.length > MAX_PENDING) {
        throw new BadRequestException(`Hay más de ${MAX_PENDING} entradas pendientes en ese rango: acórtalo o filtra por sucursal.`);
      }
      return {
        date_basis: basis,
        from, to,
        rows: (rows as RawPending[]).map((r): PendingReceiptRow => ({
          sucursal: r.sucursal,
          doc_prefix: r.doc_prefix,
          folio: r.folio,
          oc_folio: r.oc_folio,
          supplier_code: r.supplier_code,
          supplier_name: r.supplier_name,
          invoice_date: r.invoice_date,
          reception_date: r.reception_date,
          reception_source: r.reception_source,
          amount: Number(r.amount),
          kepler_due_date: r.kepler_due_date,
          evidence_status: (r.evidence_status ?? 'sin_evidencia') as ReceiptEvidenceStatus,
          days_waiting: r.days_waiting,
          times_rejected: Number(r.times_rejected || 0),
          last_rejection_reason: r.last_rejection_reason,
        })),
        excluded_without_reception_date: sinRecepcion,
        excluded_internal: cnt[0]?.internos ?? 0,
        schema_ready: ready.view && ready.tables && ready.internal,
      };
    });
  }

  /** Quién puede recibir: gente activa de Finanzas/Tesorería con FINANCE_PAYMENTS_GESTIONAR. Derivado, sin nombres fijos. */
  async recipients(): Promise<DeliveryRecipient[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => this.recipientsIn(trx, tenantId));
  }

  /** Misma consulta dentro de una transacción ya abierta (GOTCHAS §2: una petición, una trx). */
  private async recipientsIn(trx: Trx, tenantId: string): Promise<DeliveryRecipient[]> {
    const { rows } = await trx.raw(`
      SELECT DISTINCT u.username, COALESCE(u.nombre, u.username) AS name, u.position_code
        FROM identity.users u
        JOIN identity.role_permissions rp ON rp.tenant_id = u.tenant_id AND lower(rp.role_name) = lower(u.role_name)
                                         AND rp.deleted_at IS NULL
       WHERE u.tenant_id = :t AND u.deleted_at IS NULL AND u.activo
         AND u.department_code = ANY(:deps::text[])
         AND (rp.permissions->>'FINANCE_PAYMENTS_GESTIONAR')::boolean IS TRUE
       ORDER BY 2`, { t: tenantId, deps: RECIPIENT_DEPARTMENTS });
    return rows as DeliveryRecipient[];
  }

  async list(q: { status?: PurchaseDeliveryStatus; mine?: string }): Promise<PurchaseDeliverySummary[]> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await this.readiness(trx)).tables) return [];
      const b = trx('commercial.purchase_deliveries').where({ tenant_id: tenantId });
      if (q.status) b.andWhere('status', q.status);
      if (q.mine) b.andWhere('recipient_username', q.mine);
      const rows = await b.select(this.summaryCols(trx)).orderBy('delivered_at', 'desc').limit(200);
      return rows.map((r: Record<string, unknown>) => this.toSummary(r));
    });
  }

  async detail(id: string): Promise<PurchaseDeliveryDetail> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await this.readiness(trx)).tables) throw new NotFoundException('Entrega no encontrada');
      return this.loadDetail(trx, tenantId, id);
    });
  }

  async create(dto: CreatePurchaseDeliveryDto, username: string): Promise<PurchaseDeliveryDetail> {
    const items = this.dedupe(dto.items || []);
    if (!items.length) throw new BadRequestException('Marca al menos una entrada para entregar.');
    if (items.length > MAX_ITEMS) throw new BadRequestException(`Máximo ${MAX_ITEMS} entradas por entrega.`);
    if (!dto.recipient_username) throw new BadRequestException('Elige a la persona de Finanzas que recibe.');
    const basis: DeliveryDateBasis = dto.date_basis === 'factura' ? 'factura' : 'recepcion';
    const tenantId = this.tenantCtx.requireTenantId();

    try {
      return await this.tk.run(async (trx) => {
        const ready = await this.readiness(trx);
        if (!ready.tables || !ready.view) {
          throw new ServiceUnavailableException('Faltan las migraciones de entregas (RE.31/RE.32). Por ahora sólo se puede consultar.');
        }
        const recipient = (await this.recipientsIn(trx, tenantId)).find((r) => r.username === dto.recipient_username);
        if (!recipient) throw new BadRequestException('Esa persona no puede recibir entregas (debe ser de Finanzas o Tesorería con permiso de pagos).');
        if (recipient.username === username) throw new BadRequestException('Quien entrega no puede ser quien recibe.');

        // Las entradas se leen de la vista viva: nada del cliente se toma como dato, sólo la llave.
        const { rows: recs } = await trx.raw(`
          SELECT r.sucursal, r.doc_prefix, r.folio, r.oc_folio, r.proveedor_code, r.proveedor_nombre,
                 r.receipt_date, r.fecha_recepcion, r.fecha_recepcion_fuente, r.monto, r.fecha_vence, r.dup_of_folio,
                 COALESCE(s.is_internal, false) AS is_internal,
                 (SELECT p.status FROM finance.goods_receipt_proofs p
                   WHERE p.tenant_id = r.tenant_id AND p.sucursal = r.sucursal AND p.folio = r.folio
                   ORDER BY p.created_at DESC LIMIT 1) AS evidence_status
            FROM analytics.erp_goods_receipts r
            JOIN unnest(:s::text[], :p::text[], :f::text[]) AS k(sucursal, doc_prefix, folio)
              ON k.sucursal = r.sucursal AND k.doc_prefix = r.doc_prefix AND k.folio = r.folio
            LEFT JOIN catalog.suppliers s ON s.tenant_id = r.tenant_id AND btrim(s.code) = r.proveedor_code AND s.deleted_at IS NULL
           WHERE r.tenant_id = :t`,
          { t: tenantId, s: items.map((i) => i.sucursal), p: items.map((i) => i.doc_prefix), f: items.map((i) => i.folio) });

        const found = new Map<string, Record<string, unknown>>((recs as Record<string, unknown>[]).map((r) => [this.key(r.sucursal as string, r.doc_prefix as string, r.folio as string), r]));
        const missing = items.filter((i) => !found.has(this.key(i.sucursal, i.doc_prefix, i.folio)));
        if (missing.length) throw new BadRequestException(`No se encontraron en Kepler: ${missing.slice(0, 5).map((m) => `${m.sucursal}-${m.folio}`).join(', ')}${missing.length > 5 ? '…' : ''}`);
        const invalid = [...found.values()].filter((r) => r.dup_of_folio || r.is_internal || !(Number(r.monto) > 0));
        if (invalid.length) throw new BadRequestException(`No se pueden entregar (duplicada, interna o sin importe): ${invalid.slice(0, 5).map((r) => `${r.sucursal}-${r.folio}`).join(', ')}`);

        const { rows: seq } = await trx.raw(`
          INSERT INTO commercial.purchase_delivery_sequences AS q (tenant_id, year, current_value)
          VALUES (:t, extract(year FROM now() AT TIME ZONE 'America/Mexico_City')::int, 1)
          ON CONFLICT (tenant_id, year) DO UPDATE SET current_value = q.current_value + 1, updated_at = now()
          RETURNING year, current_value`, { t: tenantId });
        const code = `ENT-${seq[0].year}-${String(seq[0].current_value).padStart(5, '0')}`;

        const deliverer = await trx('identity.users').where({ tenant_id: tenantId, username }).first('nombre');
        const total = [...found.values()].reduce((a, r) => a + Number(r.monto), 0);
        const [del] = await trx('commercial.purchase_deliveries').insert({
          tenant_id: tenantId,
          code,
          date_basis: basis,
          period_from: dto.period_from || null,
          period_to: dto.period_to || null,
          delivered_by: username,
          delivered_by_name: deliverer?.nombre ?? null,
          recipient_username: recipient.username,
          recipient_name: recipient.name,
          line_count: found.size,
          total_amount: Math.round(total * 100) / 100,
          notes: dto.notes?.trim() || null,
          created_by: username,
        }).returning('id');

        await trx('commercial.purchase_delivery_lines').insert([...found.values()].map((r) => ({
          tenant_id: tenantId,
          delivery_id: del.id,
          receipt_sucursal: r.sucursal,
          receipt_doc_prefix: r.doc_prefix,
          receipt_folio: r.folio,
          oc_folio: r.oc_folio,
          supplier_code: r.proveedor_code,
          supplier_name: r.proveedor_nombre,
          invoice_date: r.receipt_date,
          reception_date: r.fecha_recepcion,
          reception_source: r.fecha_recepcion_fuente,
          amount: r.monto,
          kepler_due_date: r.fecha_vence,
          evidence_status: r.evidence_status ?? 'sin_evidencia',
          created_by: username,
        })));
        return this.loadDetail(trx, tenantId, del.id);
      });
    } catch (e: unknown) {
      // El índice único parcial es quien garantiza "una entrada, una entrega viva" (dos auxiliares a la vez).
      if ((e as { code?: string })?.code === '23505') {
        throw new ConflictException('Alguna de esas entradas ya se entregó en otra entrega (quizá otro auxiliar acaba de hacerlo). Recarga la lista.');
      }
      throw e;
    }
  }

  /** Finanzas confirma: lo no rechazado queda aceptado; lo rechazado (con motivo) regresa a pendientes. */
  async receive(id: string, dto: { rejections?: { line_id: string; reason: string }[] }, username: string): Promise<PurchaseDeliveryDetail> {
    const rejections = dto.rejections || [];
    if (rejections.some((r) => !r.reason?.trim())) throw new BadRequestException('Cada renglón rechazado necesita un motivo.');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await this.readiness(trx)).tables) throw new ServiceUnavailableException('Falta la migración de entregas (RE.32).');
      const del = await trx('commercial.purchase_deliveries').where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!del) throw new NotFoundException('Entrega no encontrada');
      if (del.status !== 'entregada') throw new BadRequestException(`La entrega ${del.code} ya está ${del.status}.`);
      if (del.recipient_username !== username) throw new ForbiddenException(`Esta entrega la recibe ${del.recipient_name || del.recipient_username}.`);

      const lines = await trx('commercial.purchase_delivery_lines').where({ tenant_id: tenantId, delivery_id: id, status: 'entregado' }).select('id');
      const ids = new Set(lines.map((l: { id: string }) => l.id));
      const bad = rejections.filter((r) => !ids.has(r.line_id));
      if (bad.length) throw new BadRequestException('Algún renglón rechazado no pertenece a esta entrega.');

      for (const r of rejections) {
        await trx('commercial.purchase_delivery_lines').where({ tenant_id: tenantId, id: r.line_id })
          .update({ status: 'rechazado', rejection_reason: r.reason.trim(), decided_by: username, decided_at: trx.fn.now(), updated_by: username, updated_at: trx.fn.now() });
      }
      await trx('commercial.purchase_delivery_lines').where({ tenant_id: tenantId, delivery_id: id, status: 'entregado' })
        .update({ status: 'aceptado', decided_by: username, decided_at: trx.fn.now(), updated_by: username, updated_at: trx.fn.now() });
      await trx('commercial.purchase_deliveries').where({ tenant_id: tenantId, id }).update({
        status: rejections.length ? 'recibida_parcial' : 'recibida',
        received_by: username, received_at: trx.fn.now(), updated_by: username, updated_at: trx.fn.now(),
      });
      return this.loadDetail(trx, tenantId, id);
    });
  }

  /** Compras cancela una entrega que Finanzas todavía no confirma: todo vuelve a pendientes. */
  async cancel(id: string, reason: string | undefined, username: string): Promise<PurchaseDeliveryDetail> {
    if (!reason?.trim()) throw new BadRequestException('Cancelar una entrega requiere un motivo.');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      if (!(await this.readiness(trx)).tables) throw new ServiceUnavailableException('Falta la migración de entregas (RE.32).');
      const del = await trx('commercial.purchase_deliveries').where({ tenant_id: tenantId, id }).forUpdate().first();
      if (!del) throw new NotFoundException('Entrega no encontrada');
      if (del.status !== 'entregada') throw new BadRequestException(`La entrega ${del.code} ya está ${del.status}: no se puede cancelar.`);
      await trx('commercial.purchase_delivery_lines').where({ tenant_id: tenantId, delivery_id: id, status: 'entregado' })
        .update({ status: 'cancelado', updated_by: username, updated_at: trx.fn.now() });
      await trx('commercial.purchase_deliveries').where({ tenant_id: tenantId, id }).update({
        status: 'cancelada', cancelled_by: username, cancelled_at: trx.fn.now(), cancel_reason: reason.trim(),
        updated_by: username, updated_at: trx.fn.now(),
      });
      return this.loadDetail(trx, tenantId, id);
    });
  }

  // ── internos ───────────────────────────────────────────────────────────────────────────
  private key(s: string, p: string, f: string): string { return `${s}|${p}|${f}`; }

  private dedupe(items: ReceiptKey[]): ReceiptKey[] {
    const seen = new Set<string>();
    const out: ReceiptKey[] = [];
    for (const i of items) {
      if (!i?.sucursal || !i?.doc_prefix || !i?.folio) continue;
      const k = this.key(i.sucursal, i.doc_prefix, i.folio);
      if (!seen.has(k)) { seen.add(k); out.push({ sucursal: i.sucursal, doc_prefix: i.doc_prefix, folio: i.folio }); }
    }
    return out;
  }

  private summaryCols(trx: Trx) {
    return ['id', 'code', 'status', 'date_basis',
      trx.raw(`to_char(period_from, 'YYYY-MM-DD') AS period_from`), trx.raw(`to_char(period_to, 'YYYY-MM-DD') AS period_to`),
      'delivered_by', 'delivered_by_name', 'delivered_at', 'recipient_username', 'recipient_name',
      'received_by', 'received_at', 'line_count', 'total_amount', 'notes'];
  }

  private toSummary(r: Record<string, unknown>): PurchaseDeliverySummary {
    return { ...(r as unknown as PurchaseDeliverySummary), line_count: Number(r.line_count), total_amount: Number(r.total_amount) };
  }

  private async loadDetail(trx: Trx, tenantId: string, id: string): Promise<PurchaseDeliveryDetail> {
    const head = await trx('commercial.purchase_deliveries').where({ tenant_id: tenantId, id }).first(this.summaryCols(trx));
    if (!head) throw new NotFoundException('Entrega no encontrada');
    const lines = await trx('commercial.purchase_delivery_lines').where({ tenant_id: tenantId, delivery_id: id })
      .select('id', 'receipt_sucursal as sucursal', 'receipt_doc_prefix as doc_prefix', 'receipt_folio as folio', 'oc_folio',
        'supplier_code', 'supplier_name',
        trx.raw(`to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date`), trx.raw(`to_char(reception_date, 'YYYY-MM-DD') AS reception_date`),
        'reception_source', 'amount', trx.raw(`to_char(kepler_due_date, 'YYYY-MM-DD') AS kepler_due_date`),
        'evidence_status', 'status', 'rejection_reason', 'decided_by', 'decided_at')
      .orderByRaw(`receipt_sucursal, COALESCE(reception_date, invoice_date), supplier_name NULLS LAST, receipt_folio`);
    return {
      ...this.toSummary(head as Record<string, unknown>),
      lines: (lines as Record<string, unknown>[]).map((l) => ({ ...(l as unknown as PurchaseDeliveryLine), amount: Number(l.amount) })),
    };
  }
}
