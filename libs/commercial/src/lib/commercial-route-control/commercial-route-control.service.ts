import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  TenantKnexService,
  TenantContextService,
  CloudinaryService,
  LlmExtractorService,
} from '@megadulces/platform-core';
import {
  GuardarRouteTicketDto,
  ListRouteTicketsQuery,
  ProcesarRouteTicketResult,
  RouteReportQuery,
  RouteTicketType,
  ROUTE_TICKET_TYPES,
  UpdateRouteTicketDto,
} from './dto/route-ticket.dto';

const ACCEPTED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_BYTES = 8 * 1024 * 1024; // límite vision Anthropic
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

    const ctx = this.tenantCtx.get();
    const folder = `route-tickets/${ctx?.tenantId ?? 'unknown'}/${ctx?.userId ?? 'unknown'}`;
    const t0 = Date.now();
    const uploaded = await this.cloudinary.uploadImage(file, folder);

    const base64 = file.buffer.toString('base64');
    const mediaType = file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    const fields = await this.llm.extractRouteTicket(base64, mediaType, ticketType);
    this.logger.log(`[route-ticket] ${ticketType} OCR (+${Date.now() - t0}ms)`);

    return {
      ticket_type: ticketType,
      cloudinary_public_id: uploaded.public_id,
      photo_url: uploaded.secure_url,
      photo_preview_url: uploaded.secure_url,
      fields,
    };
  }

  // ── 2) Guardar (tras revisión) ──────────────────────────────────────────
  async guardar(dto: GuardarRouteTicketDto) {
    this.assertType(dto.ticket_type);
    if (!dto.route_code?.trim()) throw new BadRequestException('route_code requerido');
    if (!dto.ticket_date || !DATE_RE.test(dto.ticket_date))
      throw new BadRequestException('ticket_date requerido (YYYY-MM-DD)');

    const corte = dto.ticket_type === 'venta' ? dto.corte_number?.trim() || null : null;
    const reference = dto.ticket_type === 'combustible' ? dto.reference?.trim() || null : null;
    const liters = dto.ticket_type === 'combustible' ? dto.liters ?? null : null;

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

      try {
        const [row] = await trx('commercial.route_tickets')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            vendor_user_id: userId,
            ticket_type: dto.ticket_type,
            route_code: dto.route_code.trim(),
            ticket_date: dto.ticket_date,
            total: dto.total ?? null,
            corte_number: corte,
            reference,
            liters,
            cloudinary_public_id: dto.cloudinary_public_id ?? null,
            photo_url: dto.photo_url ?? null,
            photo_preview_url: dto.photo_preview_url ?? null,
            ocr_text: dto.ocr_text ?? null,
            ocr_json: dto.ocr_json != null ? JSON.stringify(dto.ocr_json) : null,
            reviewed: true,
            created_by: userId,
          })
          .returning('*');
        return row;
      } catch (e: any) {
        if (e?.code === '23505')
          throw new ConflictException('Ticket duplicado (corte o referencia ya registrados)');
        throw e;
      }
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
