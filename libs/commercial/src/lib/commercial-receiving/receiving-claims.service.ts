import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import {
  TenantKnexService,
  TenantContextService,
  applySmartSearch,
} from '@megadulces/platform-core';
import { classifyReceivingOrigin } from './receiving-origin';
import {
  CLAIMABLE_KINDS,
  OPEN_STATUSES,
  ReceivingClaimStatus,
  claimAmount,
  claimDedupKey,
  claimQtyFor,
  nextClaimStatus,
  responsibleFor,
} from './receiving-claim';

/**
 * **WMS-REC.8 — Reclamo diferenciado de faltantes de recepción (ADR-053).**
 *
 * Cierra el circuito que hoy se evapora: el Andén detecta el faltante, lo pinta, y al
 * cerrar el vale no quedaba registro de que se reclamó, ni a quién, ni si se resolvió.
 *
 * **Dónde se levanta:** en `close()` del vale, dentro de SU MISMA transacción y
 * **después** de que `pending → faltante` quedó firme. Ese es el único momento en que
 * el faltante es un hecho. No suma un solo toque en la Puerta 1: el operador no ve nada
 * nuevo con el camión enfrente.
 *
 * **Ruteo:** `origin.kind` (la función pura `classifyReceivingOrigin`, la misma que pinta
 * el chip) decide si el responsable es el **proveedor** —y entonces le pega en el fill
 * rate de RA— o la **sucursal que embarcó** un traspaso, donde la merma es de la casa.
 *
 * **No ajusta stock ni dinero** (decisión 2026-09-08): el faltante nunca entró al
 * inventario (`close()` da de alta sólo `received_qty`) y la nota de crédito real vive en
 * Kepler, que es read-only. El monto es estimación para priorizar y lo dice.
 */
@Injectable()
export class ReceivingClaimsService {
  private readonly logger = new Logger(ReceivingClaimsService.name);

  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private uuid(v: string | null | undefined, field: string): string {
    if (!v || !ReceivingClaimsService.UUID.test(v)) throw new BadRequestException(`${field} inválido`);
    return v;
  }

  // ── Alta: la llama close() del vale, en su misma trx ────────────────────────

  /**
   * Levanta un reclamo por cada renglón en `faltante` / `dañado` / `producto_incorrecto`.
   *
   * Idempotente por `(tenant_id, dedup_key)`: un reintento del cierre (timeout, doble
   * clic) no duplica reclamos, y el `DO NOTHING` protege el trabajo humano — si alguien
   * ya lo reclamó y el cierre se re-ejecuta, no se le pisa el estado.
   *
   * Corre DENTRO de la trx del cierre a propósito: si el reclamo no se puede escribir,
   * el cierre falla entero. Un vale que cierra sin dejar el reclamo es justo el bug que
   * este item viene a arreglar.
   */
  async raiseForSessionInTx(
    trx: any,
    session: {
      id: string;
      folio: string;
      warehouse_id: string;
      supplier_code: string | null;
      source_ref: string | null;
      closed_at?: Date | string | null;
    },
  ): Promise<{ raised: number; items: Array<Record<string, unknown>> }> {
    const tenantId = this.tenantCtx.get()?.tenantId || null;
    const userId = this.tenantCtx.get()?.userId || null;

    const lines = await trx('commercial.receiving_lines as l')
      .leftJoin('public.products as p', 'p.id', 'l.product_id')
      .where('l.session_id', session.id)
      .whereIn('l.discrepancy_kind', CLAIMABLE_KINDS as unknown as string[])
      .select(
        'l.id',
        'l.product_id',
        'l.expected_sku',
        'l.expected_name',
        'l.expected_qty',
        'l.received_qty',
        'l.discrepancy_kind',
        'l.notes',
        'p.sku',
        'p.nombre as product_name',
      );
    if (!lines.length) return { raised: 0, items: [] };

    // Costo y unidad DEL DOCUMENTO, en una sola pasada por el folio del ERP (no una
    // subconsulta por renglón: `analytics.erp_goods_receipt_lines` es una VISTA viva
    // sobre `kepler_ods` en prod). `analytics.*` NO tiene RLS → tenant explícito
    // (GOTCHAS §1).
    const costBySku = new Map<string, { unit_cost: number | null; unidad: string | null }>();
    if (session.source_ref) {
      const [suc, fol] = String(session.source_ref).split('/');
      if (suc && fol) {
        const rows = await trx('analytics.erp_goods_receipt_lines')
          .where({ tenant_id: tenantId, sucursal: suc, folio: fol })
          .whereNotNull('sku')
          .groupBy('sku')
          .select(
            'sku',
            // El costo por unidad se DERIVA de importe/cantidad (las dos columnas que ya
            // usa el vale) en vez de leer `costo_unitario`: así es auto-consistente con el
            // importe del documento. Verificado en `postgres_platform`: coinciden exacto.
            trx.raw(`CASE WHEN SUM(cantidad) > 0
                          THEN ROUND(SUM(importe) / SUM(cantidad), 4) END AS unit_cost`),
            // Centinela 'ambigua' (nunca un signo de interrogación: knex lo toma como
            // binding incluso dentro de un literal SQL — GOTCHAS §5).
            trx.raw(`CASE WHEN COUNT(DISTINCT TRIM(unidad)) > 1 THEN 'ambigua'
                          ELSE MIN(TRIM(unidad)) END AS unidad`),
          );
        for (const r of rows as any[])
          costBySku.set(String(r.sku), {
            unit_cost: r.unit_cost == null ? null : Number(r.unit_cost),
            unidad: r.unidad || null,
          });
      }
    }

    // A quién. El nombre sale del documento del ERP cuando está; si no, del código.
    let docName: string | null = null;
    if (session.source_ref) {
      const [suc, fol] = String(session.source_ref).split('/');
      const h = await trx('analytics.erp_goods_receipts')
        .where({ tenant_id: tenantId, sucursal: suc, folio: fol })
        .first('proveedor_nombre');
      docName = h?.proveedor_nombre || null;
    }
    const origin = classifyReceivingOrigin(session.supplier_code, docName);
    const responsible = responsibleFor(origin, session.supplier_code);

    // Proveedor del catálogo (para que el reclamo le pegue al fill rate). Traspaso:
    // almacén de origen SÓLO si el crosswalk capturado a mano lo resuelve.
    const supplier =
      responsible.responsible_kind === 'supplier' && session.supplier_code
        ? await trx('catalog.suppliers')
            .whereRaw('UPPER(TRIM(code)) = UPPER(TRIM(?))', [session.supplier_code])
            .whereNull('deleted_at')
            .first('id')
        : null;
    const transferOrigin =
      responsible.responsible_kind === 'branch' && session.supplier_code
        ? await this.findTransferOriginTx(trx, session.supplier_code)
        : null;

    const items: Array<Record<string, unknown>> = [];
    for (const l of lines as any[]) {
      const kind = l.discrepancy_kind as (typeof CLAIMABLE_KINDS)[number];
      const qty = claimQtyFor(l.expected_qty, l.received_qty);
      const cost = costBySku.get(String(l.expected_sku ?? ''))?.unit_cost ?? null;
      const amount = claimAmount(qty, cost);
      const row = {
        tenant_id: trx.raw('public.current_tenant_id()'),
        session_id: session.id,
        receiving_line_id: l.id,
        warehouse_id: session.warehouse_id,
        product_id: l.product_id || null,
        folio: session.folio,
        source_ref: session.source_ref || null,
        sku: l.sku || l.expected_sku || null,
        product_name: l.product_name || l.expected_name || null,
        kind,
        expected_qty: Number(l.expected_qty) || 0,
        received_qty: Number(l.received_qty) || 0,
        qty_claimed: qty,
        qty_unit: costBySku.get(String(l.expected_sku ?? ''))?.unidad ?? null,
        responsible_kind: responsible.responsible_kind,
        responsible_code: session.supplier_code || null,
        responsible_label: responsible.responsible_label,
        supplier_id: supplier?.id || null,
        responsible_warehouse_id: transferOrigin?.warehouse_id || null,
        unit_cost: cost,
        amount,
        amount_source: amount == null ? 'sin_dato' : 'erp_line',
        status: 'open' as ReceivingClaimStatus,
        opened_at: session.closed_at || trx.fn.now(),
        notes: l.notes || null,
        dedup_key: claimDedupKey(l.id),
        created_by: userId,
      };
      const inserted = await trx('commercial.receiving_claims')
        .insert(row)
        .onConflict(['tenant_id', 'dedup_key'])
        .ignore()
        .returning(['id', 'kind', 'qty_claimed', 'qty_unit', 'amount', 'sku', 'product_name']);
      if (inserted?.length) items.push(inserted[0]);
    }

    if (items.length)
      this.logger.log(
        `Vale ${session.folio}: ${items.length} reclamo(s) levantados a ` +
          `${responsible.responsible_kind === 'supplier' ? 'proveedor' : 'traspaso'} ` +
          `${responsible.responsible_label ?? session.supplier_code ?? 'sin identificar'}`,
      );
    return { raised: items.length, items };
  }

  // ── Bandeja ────────────────────────────────────────────────────────────────

  /**
   * Bandeja con seguimiento: estado, responsable, monto y antigüedad.
   *
   * Los KPIs del encabezado se calculan con TODOS los filtros MENOS el de estado: si
   * cambiaran al mirar los cerrados, el número de "abiertos" dejaría de ser el del
   * trabajo pendiente y se volvería el de lo que estás viendo.
   */
  async list(q: {
    status?: string;
    responsible_kind?: string;
    kind?: string;
    supplier_id?: string;
    warehouse_id?: string;
    date_from?: string;
    date_to?: string;
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    if (q.supplier_id) this.uuid(q.supplier_id, 'supplier_id');
    if (q.warehouse_id) this.uuid(q.warehouse_id, 'warehouse_id');

    return this.tk.run(async (trx) => {
      const base = () => {
        const b = trx('commercial.receiving_claims as c')
          .leftJoin('commercial.warehouses as w', function () {
            this.on('w.tenant_id', '=', 'c.tenant_id').andOn('w.id', '=', 'c.warehouse_id');
          })
          .leftJoin('commercial.warehouses as ow', function () {
            this.on('ow.tenant_id', '=', 'c.tenant_id').andOn('ow.id', '=', 'c.responsible_warehouse_id');
          })
          .leftJoin('catalog.suppliers as s', function () {
            this.on('s.tenant_id', '=', 'c.tenant_id').andOn('s.id', '=', 'c.supplier_id');
          });
        if (q.responsible_kind && ['supplier', 'branch'].includes(q.responsible_kind))
          b.where('c.responsible_kind', q.responsible_kind);
        if (q.kind && (CLAIMABLE_KINDS as unknown as string[]).includes(q.kind)) b.where('c.kind', q.kind);
        if (q.supplier_id) b.where('c.supplier_id', q.supplier_id);
        if (q.warehouse_id) b.where('c.warehouse_id', q.warehouse_id);
        if (q.date_from) b.where('c.opened_at', '>=', `${q.date_from} 00:00:00`);
        if (q.date_to) b.where('c.opened_at', '<=', `${q.date_to} 23:59:59`);
        applySmartSearch(b, q.search, {
          columns: ['c.folio', 'c.sku', 'c.product_name', 'c.responsible_label', 'c.responsible_code', 's.name'],
          numeric: ['c.amount'],
        });
        return b;
      };

      const rowsQ = base();
      if (q.status === 'abiertos') rowsQ.whereIn('c.status', OPEN_STATUSES as unknown as string[]);
      else if (q.status && ['open', 'claimed', 'accepted', 'discarded', 'written_off'].includes(q.status))
        rowsQ.where('c.status', q.status);

      const rows = await rowsQ
        .select(
          'c.id', 'c.folio', 'c.source_ref', 'c.kind', 'c.status',
          'c.sku', 'c.product_name', 'c.product_id',
          'c.expected_qty', 'c.received_qty', 'c.qty_claimed', 'c.qty_unit',
          'c.unit_cost', 'c.amount', 'c.amount_source',
          'c.responsible_kind', 'c.responsible_code', 'c.responsible_label',
          'c.supplier_id', 's.name as supplier_name',
          'c.responsible_warehouse_id', 'ow.code as responsible_warehouse_code', 'ow.name as responsible_warehouse_name',
          'c.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
          'c.opened_at', 'c.claimed_at', 'c.claimed_by_username', 'c.claim_channel',
          'c.resolved_at', 'c.resolved_by_username', 'c.resolution_note', 'c.notes',
          trx.raw(`GREATEST(0, (CURRENT_DATE - c.opened_at::date))::int AS age_days`),
          trx.raw(`COUNT(*) OVER()::int AS _total`),
        )
        .orderByRaw(`CASE WHEN c.status IN ('open','claimed') THEN 0 ELSE 1 END`)
        .orderBy('c.opened_at', 'asc')
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      // KPIs: sin el filtro de estado (ver docstring).
      const k: any = await base()
        .first(
          trx.raw(`COUNT(*) FILTER (WHERE c.status IN ('open','claimed'))::int AS open_count`),
          trx.raw(`COALESCE(SUM(c.amount) FILTER (WHERE c.status IN ('open','claimed')), 0)::numeric AS open_amount`),
          trx.raw(`COUNT(*) FILTER (WHERE c.status IN ('open','claimed') AND c.amount IS NULL)::int AS open_without_amount`),
          trx.raw(`COALESCE(MAX(CURRENT_DATE - c.opened_at::date) FILTER (WHERE c.status IN ('open','claimed')), 0)::int AS oldest_days`),
          trx.raw(`COUNT(DISTINCT c.supplier_id) FILTER (WHERE c.status IN ('open','claimed') AND c.responsible_kind = 'supplier')::int AS suppliers_open`),
          trx.raw(`COUNT(*) FILTER (WHERE c.status IN ('open','claimed') AND c.responsible_kind = 'branch')::int AS transfer_open`),
          trx.raw(`COUNT(*) FILTER (WHERE c.status IN ('open','claimed') AND c.responsible_kind = 'branch' AND c.responsible_warehouse_id IS NULL)::int AS transfer_without_owner`),
          trx.raw(`COUNT(*) FILTER (WHERE c.status IN ('open','claimed') AND c.qty_claimed IS NULL)::int AS needs_qty`),
        );

      return {
        data: (rows as any[]).map((r) => this.shape(r)),
        total: Number((rows as any[])[0]?._total) || 0,
        page,
        pageSize,
        kpis: {
          open_count: Number(k?.open_count) || 0,
          open_amount: Number(k?.open_amount) || 0,
          open_without_amount: Number(k?.open_without_amount) || 0,
          oldest_days: Number(k?.oldest_days) || 0,
          suppliers_open: Number(k?.suppliers_open) || 0,
          transfer_open: Number(k?.transfer_open) || 0,
          transfer_without_owner: Number(k?.transfer_without_owner) || 0,
          needs_qty: Number(k?.needs_qty) || 0,
        },
      };
    });
  }

  /** Los `numeric` llegan como STRING por JSON → se coercionan acá, una sola vez. */
  private shape(r: any) {
    const num = (v: unknown) => (v == null ? null : Number(v));
    const { _total, ...rest } = r;
    return {
      ...rest,
      expected_qty: Number(r.expected_qty) || 0,
      received_qty: Number(r.received_qty) || 0,
      qty_claimed: num(r.qty_claimed),
      unit_cost: num(r.unit_cost),
      amount: num(r.amount),
      age_days: Number(r.age_days) || 0,
    };
  }

  async detail(id: string) {
    this.uuid(id, 'id');
    return this.tk.run(async (trx) => {
      const c = await this.detailTx(trx, id);
      return c;
    });
  }

  private async detailTx(trx: any, id: string) {
    const row = await trx('commercial.receiving_claims as c')
      .leftJoin('commercial.warehouses as w', function () {
        this.on('w.tenant_id', '=', 'c.tenant_id').andOn('w.id', '=', 'c.warehouse_id');
      })
      .leftJoin('commercial.warehouses as ow', function () {
        this.on('ow.tenant_id', '=', 'c.tenant_id').andOn('ow.id', '=', 'c.responsible_warehouse_id');
      })
      .leftJoin('catalog.suppliers as s', function () {
        this.on('s.tenant_id', '=', 'c.tenant_id').andOn('s.id', '=', 'c.supplier_id');
      })
      .leftJoin('commercial.receiving_sessions as sess', function () {
        this.on('sess.tenant_id', '=', 'c.tenant_id').andOn('sess.id', '=', 'c.session_id');
      })
      .where('c.id', id)
      .first(
        'c.*',
        'w.code as warehouse_code', 'w.name as warehouse_name',
        'ow.code as responsible_warehouse_code', 'ow.name as responsible_warehouse_name',
        's.name as supplier_name',
        'sess.closed_at as vale_closed_at', 'sess.status as vale_status',
        trx.raw(`GREATEST(0, (CURRENT_DATE - c.opened_at::date))::int AS age_days`),
      );
    if (!row) throw new NotFoundException('Reclamo no encontrado');
    return this.shape(row);
  }

  // ── Seguimiento ────────────────────────────────────────────────────────────

  /** Lo pasó al responsable (con canal y nota): `open → claimed`. */
  async markClaimed(id: string, dto: { channel?: string; note?: string }) {
    this.uuid(id, 'id');
    return this.tk.run(async (trx) => {
      const current = await this.lockTx(trx, id);
      const next = nextClaimStatus(current.status, 'claim');
      if (!next)
        throw new ConflictException(
          current.status === 'claimed'
            ? 'Este reclamo ya se pasó al responsable'
            : `El reclamo está ${current.status}: ya se cerró`,
        );
      const who = this.tenantCtx.get();
      await trx('commercial.receiving_claims').where({ id }).update({
        status: next,
        claimed_at: trx.fn.now(),
        claimed_by: who?.userId || null,
        claimed_by_username: who?.username || null,
        claim_channel: (dto?.channel || '').trim().slice(0, 24) || null,
        resolution_note: dto?.note ? String(dto.note).trim() : current.resolution_note,
        updated_at: trx.fn.now(),
        updated_by: who?.userId || null,
      });
      return this.detailTx(trx, id);
    });
  }

  /**
   * Captura la cantidad reclamada de un `dañado` / `producto_incorrecto`.
   *
   * El andén no tiene columna que diga cuánto llegó dañado y **no se le va a agregar un
   * toque al camión esperando**: la cantidad se teclea acá, en la bandeja, que es la
   * superficie tranquila. Recalcula el monto con el costo del documento ya guardado.
   */
  async setQty(id: string, qty: unknown) {
    this.uuid(id, 'id');
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0)
      throw new BadRequestException('La cantidad reclamada tiene que ser mayor que cero');
    return this.tk.run(async (trx) => {
      const current = await this.lockTx(trx, id);
      if (!OPEN_STATUSES.includes(current.status))
        throw new ConflictException(`El reclamo está ${current.status}: ya se cerró`);
      const tope = Math.max(Number(current.expected_qty) || 0, Number(current.received_qty) || 0);
      if (tope > 0 && n > tope)
        throw new BadRequestException(
          `No se puede reclamar ${n} si el renglón esperaba ${Number(current.expected_qty) || 0} y llegaron ${Number(current.received_qty) || 0}`,
        );
      const amount = claimAmount(n, current.unit_cost);
      const who = this.tenantCtx.get();
      await trx('commercial.receiving_claims').where({ id }).update({
        qty_claimed: n,
        amount,
        amount_source: amount == null ? 'sin_dato' : 'erp_line',
        updated_at: trx.fn.now(),
        updated_by: who?.userId || null,
      });
      return this.detailTx(trx, id);
    });
  }

  /** Cierra el reclamo con el resultado de la negociación. */
  async resolve(id: string, dto: { resolution?: string; note?: string }) {
    this.uuid(id, 'id');
    const action = String(dto?.resolution || '').trim();
    if (!['accepted', 'discarded', 'written_off'].includes(action))
      throw new BadRequestException('resolution tiene que ser accepted, discarded o written_off');
    return this.tk.run(async (trx) => {
      const current = await this.lockTx(trx, id);
      const next = nextClaimStatus(current.status, action as 'accepted' | 'discarded' | 'written_off');
      if (!next) throw new ConflictException(`El reclamo está ${current.status}: ya se cerró`);
      // `discarded` es "nuestro conteo estaba mal": queda por escrito quién lo dijo, porque
      // es lo único que saca al responsable del fill rate.
      if (action === 'discarded' && !String(dto?.note || '').trim())
        throw new BadRequestException('Para descartar un reclamo hay que decir por qué (era error de conteo)');
      const who = this.tenantCtx.get();
      await trx('commercial.receiving_claims').where({ id }).update({
        status: next,
        resolved_at: trx.fn.now(),
        resolved_by: who?.userId || null,
        resolved_by_username: who?.username || null,
        resolution_note: dto?.note ? String(dto.note).trim() : null,
        updated_at: trx.fn.now(),
        updated_by: who?.userId || null,
      });
      return this.detailTx(trx, id);
    });
  }

  private async lockTx(trx: any, id: string) {
    const row = await trx('commercial.receiving_claims').where({ id }).forUpdate().first();
    if (!row) throw new NotFoundException('Reclamo no encontrado');
    return row as {
      status: ReceivingClaimStatus;
      expected_qty: string;
      received_qty: string;
      unit_cost: string | null;
      resolution_note: string | null;
    };
  }

  // ── Scorecard: lo que ve Compras en /compras/proveedores ───────────────────

  /**
   * Reclamos por proveedor, para colgarlos del scorecard que ya existe.
   *
   * Es el complemento del fill rate: el número dice cuánto surtió de menos, esto dice
   * qué reclamos hay abiertos y por cuánto. Un reclamo que nadie mira no cambia nada.
   */
  async bySupplier(q: { window_days?: number } = {}) {
    const win = Math.min(730, Math.max(30, Number(q.window_days) || 180));
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.receiving_claims as c')
        .whereNotNull('c.supplier_id')
        .where('c.responsible_kind', 'supplier')
        .whereRaw(`c.opened_at >= now() - make_interval(days => ?::int)`, [win])
        .groupBy('c.supplier_id')
        .select(
          'c.supplier_id',
          trx.raw(`COUNT(*)::int AS claims_total`),
          trx.raw(`COUNT(*) FILTER (WHERE c.status IN ('open','claimed'))::int AS claims_open`),
          trx.raw(`COALESCE(SUM(c.amount) FILTER (WHERE c.status IN ('open','claimed')), 0)::numeric AS amount_open`),
          trx.raw(`COALESCE(SUM(c.amount), 0)::numeric AS amount_total`),
          trx.raw(`MAX(c.opened_at) AS last_claim_at`),
        );
      return (rows as any[]).map((r) => ({
        supplier_id: r.supplier_id,
        claims_total: Number(r.claims_total) || 0,
        claims_open: Number(r.claims_open) || 0,
        amount_open: Number(r.amount_open) || 0,
        amount_total: Number(r.amount_total) || 0,
        last_claim_at: r.last_claim_at,
      }));
    });
  }

  // ── Crosswalk TI### → almacén que embarcó (capturado a mano) ───────────────

  private async findTransferOriginTx(trx: any, code: string) {
    return trx('commercial.erp_transfer_origin')
      .whereRaw('UPPER(TRIM(code)) = UPPER(TRIM(?))', [code])
      .first('code', 'warehouse_id');
  }

  /** Mapa capturado + los códigos de traspaso que ya llegaron y siguen sin dueño. */
  async listTransferOrigins() {
    return this.tk.run(async (trx) => {
      const mapped = await trx('commercial.erp_transfer_origin as t')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 't.tenant_id').andOn('w.id', '=', 't.warehouse_id');
        })
        .orderBy('t.code')
        .select('t.code', 't.warehouse_id', 't.note', 't.updated_at', 'w.code as warehouse_code', 'w.name as warehouse_name');

      // Los códigos que la operación real ya trajo y nadie mapeó: sin esto el usuario
      // tendría que adivinar qué capturar.
      const pending = await trx('commercial.receiving_claims as c')
        .where('c.responsible_kind', 'branch')
        .whereNull('c.responsible_warehouse_id')
        .whereNotNull('c.responsible_code')
        .groupBy('c.responsible_code')
        .orderByRaw('COUNT(*) DESC')
        .select(
          'c.responsible_code as code',
          trx.raw(`MAX(c.responsible_label) AS doc_label`),
          trx.raw(`COUNT(*)::int AS claims`),
        );

      return {
        mapped,
        pending: (pending as any[]).map((p) => ({ ...p, claims: Number(p.claims) || 0 })),
      };
    });
  }

  /**
   * Captura (upsert) el almacén que embarcó un `TI###`.
   *
   * **Es una decisión humana, no un heurístico**: el ERP no permite deducirla (`TI005`
   * sale como "ZAMORA CANINDO" y como "ABASTOS LP" mientras `transfer_dest_map` dice que
   * Canindo es `TI006`). Al capturarla, los reclamos de ese código que estaban sin dueño
   * quedan asignados — incluidos los ya levantados, que es el caso normal: primero duele,
   * después se configura.
   */
  async setTransferOrigin(code: string, warehouseId: string, note?: string) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) throw new BadRequestException('code requerido');
    this.uuid(warehouseId, 'warehouse_id');
    return this.tk.run(async (trx) => {
      const wh = await trx('commercial.warehouses').where({ id: warehouseId }).whereNull('deleted_at').first('id');
      if (!wh) throw new NotFoundException('Almacén no encontrado');
      const userId = this.tenantCtx.get()?.userId || null;
      await trx.raw(
        `INSERT INTO commercial.erp_transfer_origin (tenant_id, code, warehouse_id, note, updated_by)
           VALUES (public.current_tenant_id(), ?, ?, ?, ?)
         ON CONFLICT (tenant_id, code)
           DO UPDATE SET warehouse_id = EXCLUDED.warehouse_id, note = EXCLUDED.note,
                         updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [c, warehouseId, note ? String(note).trim() : null, userId],
      );
      const reassigned = await trx('commercial.receiving_claims')
        .where('responsible_kind', 'branch')
        .whereRaw('UPPER(TRIM(responsible_code)) = ?', [c])
        .whereNull('responsible_warehouse_id')
        .update({ responsible_warehouse_id: warehouseId, updated_at: trx.fn.now(), updated_by: userId });
      this.logger.log(`Traspaso ${c} → almacén ${warehouseId}: ${reassigned} reclamo(s) con dueño`);
      return { code: c, warehouse_id: warehouseId, claims_reassigned: Number(reassigned) || 0 };
    });
  }
}
