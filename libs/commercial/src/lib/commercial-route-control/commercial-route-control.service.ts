import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  TenantKnexService,
  TenantContextService,
  CloudinaryService,
  LlmExtractorService,
  AiProductMatcherService,
} from '@megadulces/platform-core';
import {
  GuardarRouteTicketDto,
  ListRouteTicketsQuery,
  ProcesarRouteTicketResult,
  RouteReportQuery,
  RouteTicketLinePreview,
  RouteTicketType,
  ROUTE_TICKET_TYPES,
  UpdateRouteTicketDto,
} from './dto/route-ticket.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 8 * 1024 * 1024; // límite vision Anthropic
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Tope global del OCR: Cloudinary + Claude vision (+ Voyage en carga) se apilan;
 *  sin tope el request cuelga >2min y el navegador cancela (502). 504 limpio. */
const PROCESAR_DEADLINE_MS = 45_000;

/**
 * "Cierre de ruta" — tickets diarios del vendedor (venta/carga/combustible).
 * Port de `movimientos` de Automation_RD: OCR (Claude) → totales de control,
 * persistidos en commercial.route_tickets (multi-tenant, RLS). Regla de negocio:
 * `carga` NO es gasto → se excluye de los totales de gasto en los reportes.
 */
@Injectable()
export class CommercialRouteControlService {
  private readonly logger = new Logger(CommercialRouteControlService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly llm: LlmExtractorService,
    private readonly matcher: AiProductMatcherService,
  ) {}

  // ── 1) Procesar: OCR sin guardar (preview) ──────────────────────────────
  async procesar(
    file: Express.Multer.File,
    ticketType: RouteTicketType,
  ): Promise<ProcesarRouteTicketResult> {
    this.assertType(ticketType);
    if (!file) throw new BadRequestException('file requerido');
    if (!ACCEPTED_MIME.has(file.mimetype))
      throw new BadRequestException(`mimetype no soportado: ${file.mimetype}`);
    if (file.size > MAX_BYTES)
      throw new BadRequestException(`Imagen excede ${MAX_BYTES} bytes`);

    // Tope global: corta a los 45s con 504 limpio en vez de colgar hasta que el
    // navegador cancele (502). El pipeline sigue en background si pierde la carrera.
    let deadline: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () =>
          reject(
            new GatewayTimeoutException(
              'La lectura del ticket tardó demasiado. Revisá tu conexión y reintentá.',
            ),
          ),
        PROCESAR_DEADLINE_MS,
      );
    });
    const pipeline = this.runProcesar(file, ticketType);
    pipeline.catch(() => undefined); // evita unhandledRejection si gana el timeout
    try {
      return await Promise.race([pipeline, timeout]);
    } finally {
      clearTimeout(deadline!);
    }
  }

  private async runProcesar(
    file: Express.Multer.File,
    ticketType: RouteTicketType,
  ): Promise<ProcesarRouteTicketResult> {
    const ctx = this.tenantCtx.get();
    const folder = `route-tickets/${ctx?.tenantId ?? 'unknown'}/${ctx?.userId ?? 'unknown'}`;
    const t0 = Date.now();
    const uploaded = await this.cloudinary.uploadImage(file, folder);

    const base64 = file.buffer.toString('base64');
    const mediaType = file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    const fields = await this.llm.extractRouteTicket(base64, mediaType, ticketType);

    // Fase 2: carga descarga stock al camión → además del total, detectamos
    // los productos (líneas) vía Claude vision + matcher contra catálogo.
    let lines: RouteTicketLinePreview[] | undefined;
    if (ticketType === 'carga') {
      try {
        const items = await this.llm.extractFromTicketImage(base64, mediaType);
        const match = await this.matcher.matchExtractedItems(items, t0);
        lines = match.items.map((it) => ({
          raw: it.raw,
          normalized: it.normalized,
          quantity: it.quantity,
          product_id: it.suggested?.product_id ?? null,
          product_name: it.suggested?.product_name ?? null,
          confidence: it.confidence,
        }));
      } catch (e: any) {
        this.logger.warn(`[route-ticket] carga line-match falló: ${e.message}`);
        lines = [];
      }
    }
    this.logger.log(`[route-ticket] ${ticketType} OCR (+${Date.now() - t0}ms)`);

    // La ruta NO la edita el usuario: resolvemos lo que detectó el OCR contra
    // las rutas reales de SU zona. Si no matchea, el front bloquea el guardado.
    const resolved = await this.resolveZoneRoute(fields.route_code);

    return {
      ticket_type: ticketType,
      cloudinary_public_id: uploaded.public_id,
      photo_url: uploaded.secure_url,
      photo_preview_url: uploaded.secure_url,
      fields: { ...fields, route_code: resolved.code ?? fields.route_code },
      route_matched: resolved.matched,
      route_value: resolved.value,
      lines,
    };
  }

  /**
   * Resuelve un `route_code` crudo del OCR ("RD 21", "ruta 21", "21", "unknown")
   * contra las rutas del catálogo de la ZONA del vendedor (catalogs rutas:
   * parent_id = zona del vendedor, o sin zona). Match por NÚMERO ("RUTA 21" ⇆ 21).
   * Devuelve el código canónico (número) + el nombre ("RUTA 21") o matched=false.
   */
  private async resolveZoneRoute(
    raw: string | null | undefined,
  ): Promise<{ matched: boolean; code: string | null; value: string | null }> {
    const digits = String(raw ?? '').match(/\d+/)?.[0] ?? null;
    if (!digits) return { matched: false, code: null, value: null };
    return this.tk.run(async (trx) => {
      const userId = this.requireUserId();
      const user = await trx('users').where({ id: userId }).first('zona_id');
      const zonaId = user?.zona_id ?? null;
      const routes = await trx('catalogs')
        .where({ catalog_id: 'rutas' })
        .whereNull('deleted_at')
        .modify((q: any) => {
          // Solo rutas de su zona (+ rutas sin zona, legacy), como Captura Diaria.
          if (zonaId) q.where((b: any) => b.where('parent_id', zonaId).orWhereNull('parent_id'));
          else q.whereNull('parent_id');
        })
        .select('id', 'value');
      const hit = routes.find((r: any) => (String(r.value).match(/\d+/)?.[0] ?? null) === digits);
      return hit
        ? { matched: true, code: digits, value: hit.value as string }
        : { matched: false, code: digits, value: null };
    });
  }

  // ── 2) Guardar (tras revisión) ──────────────────────────────────────────
  async guardar(dto: GuardarRouteTicketDto) {
    this.assertType(dto.ticket_type);
    if (!dto.route_code?.trim()) throw new BadRequestException('route_code requerido');
    if (!dto.ticket_date || !DATE_RE.test(dto.ticket_date))
      throw new BadRequestException('ticket_date requerido (YYYY-MM-DD)');

    // Garantía dura (independiente del front): la ruta del ticket debe coincidir
    // con una ruta real de la zona del vendedor. "unknown" y rutas inexistentes
    // se rechazan; el código se normaliza al número canónico ("RD 21" → "21").
    const route = await this.resolveZoneRoute(dto.route_code);
    if (!route.matched || !route.code) {
      throw new BadRequestException(
        `Ruta no reconocida: "${dto.route_code}". Debe coincidir con una ruta registrada de tu zona (ej. RUTA 21). Vuelve a tomar la foto.`,
      );
    }
    const canonicalRouteCode = route.code;

    const corte = dto.ticket_type === 'venta' ? dto.corte_number?.trim() || null : null;
    const reference = dto.ticket_type === 'combustible' ? dto.reference?.trim() || null : null;
    const liters = dto.ticket_type === 'combustible' ? dto.liters ?? null : null;
    const folio = dto.ticket_type === 'carga' ? dto.folio?.trim() || null : null;

    return this.tk.run(async (trx) => {
      const userId = this.requireUserId();

      // Pre-check de unicidad (corte/reference vivos del tenant). Backstop 23505 abajo.
      if (corte) {
        const dup = await trx('commercial.route_tickets')
          .where({ corte_number: corte })
          .whereNull('deleted_at')
          .first();
        if (dup) throw new ConflictException(`Ya existe un ticket con corte ${corte}`);
      }
      if (reference) {
        const dup = await trx('commercial.route_tickets')
          .where({ reference })
          .whereNull('deleted_at')
          .first();
        if (dup) throw new ConflictException(`Ya existe un ticket con referencia ${reference}`);
      }
      if (folio) {
        const dup = await trx('commercial.route_tickets')
          .where({ folio })
          .whereNull('deleted_at')
          .first();
        if (dup) throw new ConflictException(`Ya existe una carga con folio ${folio}`);
      }

      let row;
      try {
        [row] = await trx('commercial.route_tickets')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            vendor_user_id: userId,
            ticket_type: dto.ticket_type,
            route_code: canonicalRouteCode,
            ticket_date: dto.ticket_date,
            total: dto.total ?? null,
            corte_number: corte,
            reference,
            liters,
            folio,
            cloudinary_public_id: dto.cloudinary_public_id ?? null,
            photo_url: dto.photo_url ?? null,
            photo_preview_url: dto.photo_preview_url ?? null,
            ocr_text: dto.ocr_text ?? null,
            ocr_json: dto.ocr_json != null ? JSON.stringify(dto.ocr_json) : null,
            reviewed: true,
            created_by: userId,
          })
          .returning('*');
      } catch (e: any) {
        if (e?.code === '23505')
          throw new ConflictException('Ticket duplicado (corte o referencia ya registrados)');
        throw e;
      }

      // Fase 2: carga con líneas → descarga stock al camión del vendedor,
      // ATÓMICO con el insert del ticket (mismo trx).
      if (dto.ticket_type === 'carga' && dto.lines?.length) {
        const lines = dto.lines.filter(
          (l) => l && UUID_RE.test(l.product_id) && Number(l.quantity) > 0,
        );
        if (lines.length) {
          const truckId = await this.ensureTruckWarehouse(trx, userId);
          for (const l of lines) {
            await this.stockInLine(trx, truckId, l.product_id, Number(l.quantity), row.id, userId);
          }
          return { ...row, warehouse_id: truckId, stocked_lines: lines.length };
        }
      }
      return row;
    });
  }

  /** Devuelve (o crea) el warehouse "camión" del vendedor. */
  private async ensureTruckWarehouse(trx: any, vendorUserId: string): Promise<string> {
    const existing = await trx('commercial.warehouses')
      .where({ kind: 'truck', owner_user_id: vendorUserId })
      .whereNull('deleted_at')
      .first();
    if (existing) return existing.id;
    const [wh] = await trx('commercial.warehouses')
      .insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        code: `TRUCK-${vendorUserId}`.slice(0, 50),
        name: `Camión ${vendorUserId.slice(0, 8)}`,
        kind: 'truck',
        owner_user_id: vendorUserId,
        is_default: false,
        active: true,
        created_by: vendorUserId,
      })
      .returning('id');
    return wh.id;
  }

  /** Stock-in inline (mismo trx que el ticket) — solo el caso 'in', con lock. */
  private async stockInLine(
    trx: any,
    warehouseId: string,
    productId: string,
    qty: number,
    ticketId: string,
    userId: string,
  ): Promise<void> {
    const stockRow = await trx('commercial.stock')
      .where({ warehouse_id: warehouseId, product_id: productId })
      .forUpdate()
      .first();
    const before = stockRow ? Number(stockRow.quantity) : 0;
    const after = before + qty;
    if (stockRow) {
      await trx('commercial.stock')
        .where({ id: stockRow.id })
        .update({ quantity: after, updated_at: trx.fn.now(), updated_by: userId });
    } else {
      await trx('commercial.stock').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        warehouse_id: warehouseId,
        product_id: productId,
        quantity: after,
        reserved_quantity: 0,
        updated_by: userId,
      });
    }
    await trx('commercial.stock_movements').insert({
      tenant_id: trx.raw('public.current_tenant_id()'),
      warehouse_id: warehouseId,
      product_id: productId,
      movement_type: 'in',
      quantity: qty,
      quantity_before: before,
      quantity_after: after,
      reference_type: 'route_ticket',
      reference_id: ticketId,
      notes: 'Carga de ruta',
      created_by: userId,
    });
  }

  // ── 3) Listar (propios del vendedor) ────────────────────────────────────
  async listMine(q: ListRouteTicketsQuery) {
    return this.tk.run(async (trx) => {
      const userId = this.requireUserId();
      const page = Math.max(1, Number(q.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20));

      const base = trx('commercial.route_tickets')
        .where({ vendor_user_id: userId })
        .whereNull('deleted_at');
      this.applyFilters(base, q);

      const [{ count }] = await base.clone().count<{ count: string }[]>('* as count');
      const data = await base
        .clone()
        .orderBy('ticket_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return { data, total: Number(count), page, pageSize };
    });
  }

  /** Admin: lista TODOS los tickets del tenant (no scoped al vendedor). */
  async listAll(q: ListRouteTicketsQuery) {
    return this.tk.run(async (trx) => {
      const page = Math.max(1, Number(q.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 30));
      const base = trx('commercial.route_tickets as rt')
        .leftJoin('public.users as u', function () {
          this.on('u.tenant_id', 'rt.tenant_id').andOn('u.id', 'rt.vendor_user_id');
        })
        .whereNull('rt.deleted_at');
      if (q.ticket_type) base.where('rt.ticket_type', q.ticket_type);
      if (q.route_code) base.where('rt.route_code', q.route_code);
      if (q.date_from && DATE_RE.test(q.date_from)) base.where('rt.ticket_date', '>=', q.date_from);
      if (q.date_to && DATE_RE.test(q.date_to)) base.where('rt.ticket_date', '<=', q.date_to);

      const [{ count }] = await base.clone().count<{ count: string }[]>('* as count');
      const data = await base
        .clone()
        .select('rt.*', 'u.nombre as vendor_name', 'u.username as vendor_username')
        .orderBy('rt.ticket_date', 'desc')
        .orderBy('rt.created_at', 'desc')
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return { data, total: Number(count), page, pageSize };
    });
  }

  async getOne(id: string) {
    return this.tk.run(async (trx) => {
      const userId = this.requireUserId();
      const row = await trx('commercial.route_tickets')
        .where({ id, vendor_user_id: userId })
        .whereNull('deleted_at')
        .first();
      if (!row) throw new NotFoundException(`Ticket ${id} no encontrado`);
      return row;
    });
  }

  async update(id: string, dto: UpdateRouteTicketDto) {
    if (dto.ticket_date && !DATE_RE.test(dto.ticket_date))
      throw new BadRequestException('ticket_date inválido (YYYY-MM-DD)');
    return this.tk.run(async (trx) => {
      const userId = this.requireUserId();
      const patch: Record<string, unknown> = { updated_at: trx.fn.now(), updated_by: userId };
      for (const k of ['route_code', 'ticket_date', 'total', 'corte_number', 'reference', 'liters'] as const) {
        if (dto[k] !== undefined) patch[k] = dto[k];
      }
      const [row] = await trx('commercial.route_tickets')
        .where({ id, vendor_user_id: userId })
        .whereNull('deleted_at')
        .update(patch)
        .returning('*');
      if (!row) throw new NotFoundException(`Ticket ${id} no encontrado`);
      return row;
    });
  }

  // ── Admin: soft-delete ──────────────────────────────────────────────────
  async remove(id: string) {
    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId ?? null;
      const [row] = await trx('commercial.route_tickets')
        .where({ id })
        .whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), deleted_by: userId })
        .returning('id');
      if (!row) throw new NotFoundException(`Ticket ${id} no encontrado`);
      return { deleted: true, id };
    });
  }

  // ── Admin: reportes (carga excluido de gasto) ───────────────────────────
  async resumen(q: RouteReportQuery) {
    return this.tk.run(async (trx) => {
      const base = trx('commercial.route_tickets').whereNull('deleted_at');
      this.applyDateRange(base, q);
      const rows = await base
        .clone()
        .select('ticket_type')
        .count<{ ticket_type: string; tickets: string; total: string }[]>('* as tickets')
        .sum('total as total')
        .groupBy('ticket_type');

      const porTipo = rows.map((r) => ({
        ticket_type: r.ticket_type,
        tickets: Number(r.tickets),
        total: Number(r.total) || 0,
      }));
      // gasto = combustible (+ otros futuros), NUNCA carga; venta es ingreso.
      const gasto = porTipo
        .filter((r) => r.ticket_type === 'combustible')
        .reduce((a, r) => a + r.total, 0);
      const ventas = porTipo
        .filter((r) => r.ticket_type === 'venta')
        .reduce((a, r) => a + r.total, 0);
      const tickets = porTipo.reduce((a, r) => a + r.tickets, 0);
      return { por_tipo: porTipo, ventas, gasto, rentabilidad: ventas - gasto, tickets };
    });
  }

  async porRuta(q: RouteReportQuery) {
    return this.tk.run(async (trx) => {
      const base = trx('commercial.route_tickets')
        .whereNull('deleted_at')
        .whereNot('ticket_type', 'carga'); // carga no cuenta como gasto/ingreso de ruta
      this.applyDateRange(base, q);
      return base
        .clone()
        .select('route_code')
        .sum('total as total')
        .count('* as tickets')
        .groupBy('route_code')
        .orderBy('total', 'desc');
    });
  }

  async porUsuario(q: RouteReportQuery) {
    return this.tk.run(async (trx) => {
      const base = trx('commercial.route_tickets as rt')
        .whereNull('rt.deleted_at')
        .whereNot('rt.ticket_type', 'carga');
      this.applyDateRange(base, q, 'rt');
      return base
        .clone()
        .leftJoin('public.users as u', function () {
          this.on('u.tenant_id', 'rt.tenant_id').andOn('u.id', 'rt.vendor_user_id');
        })
        .select('rt.vendor_user_id', 'u.nombre', 'u.username')
        .sum('rt.total as total')
        .count('* as tickets')
        .groupBy('rt.vendor_user_id', 'u.nombre', 'u.username')
        .orderBy('total', 'desc');
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private applyFilters(qb: any, q: ListRouteTicketsQuery) {
    if (q.ticket_type) qb.where('ticket_type', q.ticket_type);
    if (q.route_code) qb.where('route_code', q.route_code);
    this.applyDateRange(qb, q);
    return qb;
  }

  private applyDateRange(qb: any, q: { date_from?: string; date_to?: string }, alias?: string) {
    const col = alias ? `${alias}.ticket_date` : 'ticket_date';
    if (q.date_from && DATE_RE.test(q.date_from)) qb.where(col, '>=', q.date_from);
    if (q.date_to && DATE_RE.test(q.date_to)) qb.where(col, '<=', q.date_to);
    return qb;
  }

  private assertType(t: string) {
    if (!ROUTE_TICKET_TYPES.includes(t as RouteTicketType))
      throw new BadRequestException(`ticket_type inválido: ${t}`);
  }

  private requireUserId(): string {
    const ctx = this.tenantCtx.get();
    if (!ctx?.userId)
      throw new BadRequestException('Usuario no identificado — requiere request autenticado');
    return ctx.userId;
  }
}
