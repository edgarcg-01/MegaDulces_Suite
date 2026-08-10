import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import {
  TenantKnexService,
  TenantContextService,
  CloudinaryService,
} from '@megadulces/platform-core';

/**
 * Fase P2.6 — Control de Caducidades digital (ADR-022).
 *
 * Digitaliza la hoja manual de inspección de anaquel: un encargado recorre el
 * estante y captura, por producto, cantidad + fecha de caducidad + estado físico
 * (bueno/regular/malo) + observaciones + acción + foto de evidencia.
 *
 * Al ENVIAR la hoja (submit), cada renglón con producto + caducidad + cantidad
 * ALIMENTA FEFO: reclasifica cantidad del lote 'NA' (sin fecha) a un lote fechado
 * en commercial.stock_lots, SIN tocar commercial.stock.quantity (el total no
 * cambia → el trigger trg_rebalance_stock_lots NO dispara → invariante
 * SUM(lotes)=stock intacto). Así la mercancía aparece en /commercial/inventory/expiring
 * y dispara las alertas de vencimiento existentes.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CONDITIONS = ['bueno', 'regular', 'malo'] as const;
type Condition = (typeof VALID_CONDITIONS)[number];

export interface ReviewFile { role: string; url: string; public_id?: string; kind?: string; name?: string; }

export interface CreateReviewDto {
  warehouse_id: string;
  review_date?: string; // YYYY-MM-DD, default hoy
  notes?: string;
  default_location?: string; // ubicación por defecto (anaquel/bodega/exhibidor)
}

export interface ReviewLineDto {
  product_id?: string | null;
  product_code_raw?: string;
  product_name_raw?: string;
  quantity?: number;
  expiry_date?: string | null; // YYYY-MM-DD
  condition?: Condition;
  observations?: string;
  action?: string;
  location?: string; // ubicación física del renglón (anaquel/bodega/exhibidor)
  files?: ReviewFile[];
}

export interface ListReviewsQuery {
  warehouse_id?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class CommercialExpiryReviewsService {
  private readonly logger = new Logger(CommercialExpiryReviewsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  // ───── encabezado ─────

  async createReview(dto: CreateReviewDto) {
    if (!UUID_REGEX.test(dto.warehouse_id || ''))
      throw new BadRequestException('warehouse_id inválido');
    if (dto.review_date && !/^\d{4}-\d{2}-\d{2}$/.test(dto.review_date))
      throw new BadRequestException('review_date debe ser YYYY-MM-DD');

    const ctx = this.tenantCtx.get();
    return this.tk.run(async (trx) => {
      const [row] = await trx('commercial.expiry_reviews')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          review_date: dto.review_date || trx.raw('CURRENT_DATE'),
          responsible_user_id: ctx?.userId || null,
          responsible_name: ctx?.username || null,
          notes: dto.notes || null,
          default_location: dto.default_location || null,
          status: 'draft',
          created_by: ctx?.userId || null,
          updated_by: ctx?.userId || null,
        })
        .returning('*');
      return row;
    });
  }

  async listReviews(query: ListReviewsQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
    const offset = (page - 1) * pageSize;
    if (query.warehouse_id && !UUID_REGEX.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');

    return this.tk.run(async (trx) => {
      let q = trx('commercial.expiry_reviews as r')
        .leftJoin('commercial.warehouses as w', 'w.id', 'r.warehouse_id');
      if (query.warehouse_id) q = q.where('r.warehouse_id', query.warehouse_id);
      if (query.status) q = q.where('r.status', query.status);
      if (query.from) q = q.where('r.review_date', '>=', query.from);
      if (query.to) q = q.where('r.review_date', '<=', query.to);

      const [{ count }] = await q.clone().count<{ count: string }[]>('* as count');
      const data = await q
        .select(
          'r.id',
          'r.warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          'r.review_date',
          'r.responsible_name',
          'r.status',
          'r.notes',
          'r.submitted_at',
          'r.created_at',
          trx.raw('(SELECT COUNT(*) FROM commercial.expiry_review_lines l WHERE l.review_id = r.id)::int as line_count'),
        )
        .orderBy('r.review_date', 'desc')
        .orderBy('r.created_at', 'desc')
        .limit(pageSize)
        .offset(offset);

      return {
        data,
        pagination: { page, pageSize, total: Number(count), pageCount: Math.ceil(Number(count) / pageSize) || 0 },
      };
    });
  }

  async getReview(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const header = await trx('commercial.expiry_reviews as r')
        .leftJoin('commercial.warehouses as w', 'w.id', 'r.warehouse_id')
        .where('r.id', id)
        .select('r.*', 'w.code as warehouse_code', 'w.name as warehouse_name')
        .first();
      if (!header) throw new NotFoundException('Hoja de caducidades no encontrada');

      const lines = await trx('commercial.expiry_review_lines as l')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .where('l.review_id', id)
        .select(
          'l.id',
          'l.product_id',
          'l.product_code_raw',
          'l.product_name_raw',
          'p.sku',
          'p.nombre as product_name',
          'l.quantity',
          'l.expiry_date',
          'l.condition',
          'l.observations',
          'l.action',
          'l.location',
          'l.files',
          'l.fed_to_fefo',
          'l.fefo_qty',
          'l.created_at',
        )
        .orderBy('l.created_at', 'asc');

      return { ...header, lines };
    });
  }

  // ───── renglones ─────

  async addLine(reviewId: string, dto: ReviewLineDto) {
    if (!UUID_REGEX.test(reviewId)) throw new BadRequestException('review_id inválido');
    this.validateLine(dto);
    const ctx = this.tenantCtx.get();
    return this.tk.run(async (trx) => {
      await this.assertDraft(trx, reviewId);
      const [row] = await trx('commercial.expiry_review_lines')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          review_id: reviewId,
          product_id: dto.product_id || null,
          product_code_raw: dto.product_code_raw || null,
          product_name_raw: dto.product_name_raw || null,
          quantity: dto.quantity ?? 0,
          expiry_date: dto.expiry_date || null,
          condition: dto.condition || null,
          observations: dto.observations || null,
          action: dto.action || null,
          location: dto.location || null,
          files: JSON.stringify(dto.files || []),
          created_by: ctx?.userId || null,
          updated_by: ctx?.userId || null,
        })
        .returning('*');
      await this.touchReview(trx, reviewId, ctx?.userId);
      return row;
    });
  }

  async updateLine(lineId: string, dto: ReviewLineDto) {
    if (!UUID_REGEX.test(lineId)) throw new BadRequestException('line_id inválido');
    this.validateLine(dto);
    const ctx = this.tenantCtx.get();
    return this.tk.run(async (trx) => {
      const line = await trx('commercial.expiry_review_lines').where({ id: lineId }).first();
      if (!line) throw new NotFoundException('Renglón no encontrado');
      await this.assertDraft(trx, line.review_id);

      const patch: Record<string, unknown> = { updated_at: trx.fn.now(), updated_by: ctx?.userId || null };
      if (dto.product_id !== undefined) patch.product_id = dto.product_id || null;
      if (dto.product_code_raw !== undefined) patch.product_code_raw = dto.product_code_raw || null;
      if (dto.product_name_raw !== undefined) patch.product_name_raw = dto.product_name_raw || null;
      if (dto.quantity !== undefined) patch.quantity = dto.quantity ?? 0;
      if (dto.expiry_date !== undefined) patch.expiry_date = dto.expiry_date || null;
      if (dto.condition !== undefined) patch.condition = dto.condition || null;
      if (dto.observations !== undefined) patch.observations = dto.observations || null;
      if (dto.action !== undefined) patch.action = dto.action || null;
      if (dto.location !== undefined) patch.location = dto.location || null;
      if (dto.files !== undefined) patch.files = JSON.stringify(dto.files || []);

      const [row] = await trx('commercial.expiry_review_lines').where({ id: lineId }).update(patch).returning('*');
      await this.touchReview(trx, line.review_id, ctx?.userId);
      return row;
    });
  }

  async deleteLine(lineId: string) {
    if (!UUID_REGEX.test(lineId)) throw new BadRequestException('line_id inválido');
    const ctx = this.tenantCtx.get();
    return this.tk.run(async (trx) => {
      const line = await trx('commercial.expiry_review_lines').where({ id: lineId }).first();
      if (!line) throw new NotFoundException('Renglón no encontrado');
      await this.assertDraft(trx, line.review_id);
      await trx('commercial.expiry_review_lines').where({ id: lineId }).del();
      await this.touchReview(trx, line.review_id, ctx?.userId);
      return { deleted: true };
    });
  }

  // ───── foto de evidencia (base64 → Cloudinary, patrón Pattern A) ─────

  async uploadFile(dataUri: string, role = 'evidencia'): Promise<ReviewFile> {
    if (!dataUri) throw new BadRequestException('file_base64 requerido');
    const tenantId = this.tenantCtx.requireTenantId();
    const f = await this.cloudinary.uploadDocumentBase64(dataUri, `commercial/${tenantId}/expiry-reviews`);
    return { role, url: f.url, public_id: f.public_id, kind: f.kind };
  }

  // ───── submit → alimenta FEFO ─────

  async submitReview(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    const ctx = this.tenantCtx.get();

    return this.tk.run(async (trx) => {
      const review = await trx('commercial.expiry_reviews').where({ id }).forUpdate().first();
      if (!review) throw new NotFoundException('Hoja de caducidades no encontrada');
      if (review.status === 'submitted')
        throw new ConflictException('La hoja ya fue enviada');

      const lines = await trx('commercial.expiry_review_lines').where({ review_id: id });

      let fedCount = 0;
      for (const line of lines) {
        const qty = Number(line.quantity) || 0;
        // Alimenta FEFO solo si hay producto + caducidad + cantidad.
        if (!line.product_id || !line.expiry_date || qty <= 0) continue;

        // Lock del saldo total (evita race con reservas/movimientos concurrentes).
        const stockRow = await trx('commercial.stock')
          .where({ warehouse_id: review.warehouse_id, product_id: line.product_id })
          .forUpdate()
          .first();
        if (!stockRow) continue; // sin fila de stock → no hay NA que reclasificar

        // Lote 'NA' (balanceador sin fecha): cuánto podemos reclasificar a lote fechado
        // sin alterar el total (invariante SUM(lotes)=stock).
        const naLot = await trx('commercial.stock_lots')
          .where({ warehouse_id: review.warehouse_id, product_id: line.product_id, lot_code: 'NA' })
          .whereNull('expiry_date')
          .first();
        const naQty = naLot ? Number(naLot.quantity) : 0;
        const moveQty = Math.min(qty, naQty);
        if (moveQty <= 0) continue;

        // expiry_date puede venir como Date (pg parsea `date` a Date) o string.
        const expiryYmd = this.toYmd(line.expiry_date);
        const lotCode = `EXP-${expiryYmd}`;

        // Upsert del lote fechado (+moveQty) — mismo patrón que recordMovement('in').
        await trx.raw(
          `INSERT INTO commercial.stock_lots
             (tenant_id, warehouse_id, product_id, lot_code, expiry_date, quantity, reserved_quantity, received_at, updated_by)
           VALUES (public.current_tenant_id(), ?, ?, ?, ?, ?, 0, now(), ?)
           ON CONFLICT (tenant_id, warehouse_id, product_id, lot_code, expiry_date)
           DO UPDATE SET quantity = commercial.stock_lots.quantity + EXCLUDED.quantity,
                         received_at = now(), updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [review.warehouse_id, line.product_id, lotCode, expiryYmd, moveQty, ctx?.userId || null],
        );

        // Decrementa el lote 'NA' en la misma cantidad → total constante, invariante intacto.
        await trx('commercial.stock_lots')
          .where({ id: naLot.id })
          .update({ quantity: naQty - moveQty, updated_at: trx.fn.now(), updated_by: ctx?.userId || null });

        await trx('commercial.expiry_review_lines')
          .where({ id: line.id })
          .update({ fed_to_fefo: true, fefo_qty: moveQty, updated_at: trx.fn.now() });
        fedCount++;
      }

      const [updated] = await trx('commercial.expiry_reviews')
        .where({ id })
        .update({ status: 'submitted', submitted_at: trx.fn.now(), updated_at: trx.fn.now(), updated_by: ctx?.userId || null })
        .returning('*');

      this.logger.log(`[P2.6] Hoja ${id} enviada: ${fedCount}/${lines.length} renglones alimentaron FEFO.`);
      return { ...updated, fed_lines: fedCount, total_lines: lines.length };
    });
  }

  // ───── helpers ─────

  private validateLine(dto: ReviewLineDto): void {
    if (dto.product_id && !UUID_REGEX.test(dto.product_id))
      throw new BadRequestException('product_id inválido (UUID)');
    if (dto.expiry_date && !/^\d{4}-\d{2}-\d{2}$/.test(dto.expiry_date))
      throw new BadRequestException('expiry_date debe ser YYYY-MM-DD');
    if (dto.quantity != null && (typeof dto.quantity !== 'number' || dto.quantity < 0))
      throw new BadRequestException('quantity debe ser número >= 0');
    if (dto.condition && !VALID_CONDITIONS.includes(dto.condition))
      throw new BadRequestException(`condition debe ser: ${VALID_CONDITIONS.join(', ')}`);
  }

  /** Normaliza un valor de fecha (Date que devuelve pg para `date`, o string) a 'YYYY-MM-DD'. */
  private toYmd(v: unknown): string {
    if (v instanceof Date) {
      const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return String(v).slice(0, 10);
  }

  private async assertDraft(trx: any, reviewId: string): Promise<void> {
    const r = await trx('commercial.expiry_reviews').where({ id: reviewId }).first();
    if (!r) throw new NotFoundException('Hoja de caducidades no encontrada');
    if (r.status !== 'draft')
      throw new ConflictException('La hoja ya fue enviada; no admite cambios');
  }

  private async touchReview(trx: any, reviewId: string, userId?: string): Promise<void> {
    await trx('commercial.expiry_reviews')
      .where({ id: reviewId })
      .update({ updated_at: trx.fn.now(), updated_by: userId || null });
  }
}
