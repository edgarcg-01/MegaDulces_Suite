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
  ObjectStorageService,
  LlmExtractorService,
} from '@megadulces/platform-core';
import { CommercialInventoryService } from '../commercial-inventory/commercial-inventory.service';

/**
 * Fase WMS-REC (Pieza 2 — Auditor de recepción por caducidad, ADR-044).
 *
 * Captura lote+caducidad con foto→OCR en la RECEPCIÓN, compara contra el
 * inventario existente + la política, da semáforo 🟢🟡🔴, y:
 *   - green/yellow → escribe stock (vía CommercialInventoryService, alimenta FEFO)
 *   - red          → NO escribe; queda pending_authorization (NC) hasta que un
 *                    supervisor autorice o rechace.
 *
 * El motor decide (computeVerdict, determinista); el OCR solo propone; el LLM
 * está fuera de la decisión (ADR-016).
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type Verdict = 'green' | 'yellow' | 'red';

export interface VerdictResult {
  verdict: Verdict;
  rule_broken: string | null;
}

export interface EvaluateDto {
  warehouse_id: string;
  product_id: string;
  supplier_code?: string;
  source_ref?: string;
  quantity: number;
  confirmed_lot?: string;
  confirmed_expiry?: string; // YYYY-MM-DD
  ocr_lot?: string;
  ocr_expiry?: string;
  ocr_confidence?: number;
  photo_data_uri?: string; // opcional; se sube a object storage
}

export interface PolicyDto {
  product_id?: string | null;
  category?: string | null;
  supplier_code?: string | null;
  min_shelf_life_days?: number | null;
  allow_older_than_existing?: boolean;
  notes?: string | null;
}

@Injectable()
export class ReceivingAuditorService {
  private readonly logger = new Logger(ReceivingAuditorService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly inventory: CommercialInventoryService,
    private readonly storage: ObjectStorageService,
    private readonly ocr: LlmExtractorService,
  ) {}

  /**
   * MOTOR DE REGLAS — determinista y puro. Dado lo confirmado + el contexto,
   * decide el semáforo. Sin efectos secundarios (testeable en aislamiento).
   *
   * - null expiry           → green (producto sin caducidad / no perecedero)
   * - bajo la mínima        → red (min_shelf_life)
   * - más viejo que existente y NO permitido → red (older_than_existing)
   * - más viejo que existente y permitido    → yellow (older_than_existing_allowed)
   * - cerca de la mínima (<1.5×) → yellow (near_min_shelf_life)
   * - resto                 → green
   */
  static computeVerdict(params: {
    confirmedExpiry: string | null;
    daysOfLife: number | null;
    existingMinExpiry: string | null;
    minShelfLifeDays: number | null;
    allowOlder: boolean;
  }): VerdictResult {
    const { confirmedExpiry, daysOfLife, existingMinExpiry, minShelfLifeDays, allowOlder } = params;
    if (!confirmedExpiry) return { verdict: 'green', rule_broken: null };

    const belowMin =
      minShelfLifeDays != null && daysOfLife != null && daysOfLife < minShelfLifeDays;
    // Comparación lexicográfica válida sobre ISO YYYY-MM-DD.
    const olderThanExisting =
      !!existingMinExpiry && confirmedExpiry < existingMinExpiry;
    const nearMin =
      minShelfLifeDays != null &&
      daysOfLife != null &&
      !belowMin &&
      daysOfLife < Math.ceil(minShelfLifeDays * 1.5);

    if (belowMin) return { verdict: 'red', rule_broken: 'min_shelf_life' };
    if (olderThanExisting && !allowOlder) return { verdict: 'red', rule_broken: 'older_than_existing' };
    if (olderThanExisting && allowOlder) return { verdict: 'yellow', rule_broken: 'older_than_existing_allowed' };
    if (nearMin) return { verdict: 'yellow', rule_broken: 'near_min_shelf_life' };
    return { verdict: 'green', rule_broken: null };
  }

  /** OCR de la foto de lote/caducidad (preview; NO persiste). */
  async ocrLabel(dataUri: string): Promise<{ lot_code: string | null; expiry_date: string | null; confidence: number | null }> {
    const parsed = this.parseDataUri(dataUri);
    if (!parsed) throw new BadRequestException('Imagen inválida (se espera data URI base64)');
    return this.ocr.extractExpiryLabel(parsed.base64, parsed.mediaType as any);
  }

  /**
   * Evalúa una captura: resuelve política, calcula el contexto, decide veredicto,
   * persiste la captura y (si green/yellow) escribe stock. El rojo queda pendiente.
   */
  async evaluate(dto: EvaluateDto) {
    if (!UUID_REGEX.test(dto.warehouse_id)) throw new BadRequestException('warehouse_id inválido');
    if (!UUID_REGEX.test(dto.product_id)) throw new BadRequestException('product_id inválido');
    if (typeof dto.quantity !== 'number' || dto.quantity <= 0)
      throw new BadRequestException('quantity debe ser > 0');
    if (dto.confirmed_expiry && !ISO_DATE.test(dto.confirmed_expiry))
      throw new BadRequestException('confirmed_expiry debe ser YYYY-MM-DD');

    const confirmedLot = (dto.confirmed_lot || 'NA').trim().slice(0, 60) || 'NA';
    const confirmedExpiry = dto.confirmed_expiry || null;

    // Foto (opcional) → object storage. Degrada si no está configurado.
    let photoKey: string | null = null;
    if (dto.photo_data_uri) {
      try {
        if (this.storage.isConfigured()) {
          const up = await this.storage.putFile(dto.photo_data_uri, 'receiving-labels');
          photoKey = up.key;
        }
      } catch (e: any) {
        this.logger.warn(`Foto de recepción no se pudo subir: ${e?.message || e}`);
      }
    }

    const captureId = await this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;

      // Categoría del producto (para resolver política por categoría).
      const prod = await trx('public.products').where({ id: dto.product_id }).first('category');
      const category: string | null = prod?.category || null;

      const policy = await this.resolvePolicy(trx, {
        product_id: dto.product_id,
        category,
        supplier_code: dto.supplier_code || null,
      });

      // Contexto: días de vida + caducidad más próxima ya en stock.
      const ctxRows = await trx.raw(
        `SELECT
           ${confirmedExpiry ? `(?::date - CURRENT_DATE)::int` : `NULL::int`} AS days_of_life,
           (SELECT MIN(expiry_date) FROM commercial.stock_lots
              WHERE warehouse_id = ? AND product_id = ?
                AND quantity > 0 AND expiry_date IS NOT NULL) AS existing_min_expiry`,
        confirmedExpiry
          ? [confirmedExpiry, dto.warehouse_id, dto.product_id]
          : [dto.warehouse_id, dto.product_id],
      );
      const ctx = ctxRows.rows[0] || {};
      const daysOfLife: number | null = ctx.days_of_life != null ? Number(ctx.days_of_life) : null;
      const existingMinExpiry: string | null = ctx.existing_min_expiry
        ? this.toIso(ctx.existing_min_expiry)
        : null;

      const { verdict, rule_broken } = ReceivingAuditorService.computeVerdict({
        confirmedExpiry,
        daysOfLife,
        existingMinExpiry,
        minShelfLifeDays: policy?.min_shelf_life_days ?? null,
        allowOlder: policy?.allow_older_than_existing ?? false,
      });

      const status = verdict === 'red' ? 'pending_authorization' : 'accepted';

      const [cap] = await trx('commercial.receiving_lot_captures')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          product_id: dto.product_id,
          supplier_code: dto.supplier_code || null,
          source_ref: dto.source_ref || null,
          quantity: dto.quantity,
          photo_key: photoKey,
          ocr_lot: dto.ocr_lot || null,
          ocr_expiry: dto.ocr_expiry && ISO_DATE.test(dto.ocr_expiry) ? dto.ocr_expiry : null,
          ocr_confidence:
            typeof dto.ocr_confidence === 'number' ? Math.min(1, Math.max(0, dto.ocr_confidence)) : null,
          confirmed_lot: confirmedLot,
          confirmed_expiry: confirmedExpiry,
          existing_min_expiry: existingMinExpiry,
          days_of_life: daysOfLife,
          verdict,
          rule_broken,
          status,
          created_by: userId,
        })
        .returning('id');
      return cap.id as string;
    });

    // green/yellow → escribe stock (fuera de la trx de captura; recordMovement
    // abre la suya). El rojo NO escribe: espera autorización.
    const capture = await this.getCapture(captureId);
    if (capture.verdict !== 'red') {
      await this.writeStockForCapture(capture);
    }
    return this.getCapture(captureId);
  }

  /** Autoriza una NC (rojo) — un supervisor libera y se escribe el stock. */
  async authorize(id: string, notes?: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    const capture = await this.getCapture(id);
    if (capture.verdict !== 'red') throw new BadRequestException('Solo se autorizan capturas con veredicto rojo');
    if (capture.status !== 'pending_authorization')
      throw new ConflictException(`La captura ya está ${capture.status}`);

    await this.writeStockForCapture(capture);
    await this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      await trx('commercial.receiving_lot_captures')
        .where({ id })
        .update({
          status: 'authorized',
          authorized_by: userId,
          authorized_at: trx.fn.now(),
          resolution_notes: notes || null,
        });
    });
    return this.getCapture(id);
  }

  /** Rechaza mercancía (rojo) — no se escribe stock. */
  async reject(id: string, notes?: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    const capture = await this.getCapture(id);
    if (capture.status !== 'pending_authorization')
      throw new ConflictException(`La captura ya está ${capture.status}`);
    await this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      await trx('commercial.receiving_lot_captures')
        .where({ id })
        .update({
          status: 'rejected',
          authorized_by: userId,
          authorized_at: trx.fn.now(),
          resolution_notes: notes || null,
        });
    });
    return this.getCapture(id);
  }

  async listCaptures(query: {
    warehouse_id?: string;
    supplier_code?: string;
    verdict?: Verdict;
    status?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) {
    if (query.warehouse_id && !UUID_REGEX.test(query.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 200));
    return this.tk.run(async (trx) => {
      let q = trx('commercial.receiving_lot_captures as c')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.tenant_id', '=', 'c.tenant_id').andOn('w.id', '=', 'c.warehouse_id');
        })
        .leftJoin('public.products as p', 'p.id', 'c.product_id');
      if (query.warehouse_id) q = q.where('c.warehouse_id', query.warehouse_id);
      if (query.supplier_code) q = q.where('c.supplier_code', query.supplier_code);
      if (query.verdict) q = q.where('c.verdict', query.verdict);
      if (query.status) q = q.where('c.status', query.status);
      if (query.from) q = q.where('c.created_at', '>=', query.from);
      if (query.to) q = q.where('c.created_at', '<=', query.to);
      const rows = await q
        .select(
          'c.id', 'c.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
          'c.product_id', 'p.sku', 'p.nombre as product_name',
          'c.supplier_code', 'c.source_ref', 'c.quantity',
          'c.confirmed_lot', 'c.confirmed_expiry', 'c.existing_min_expiry', 'c.days_of_life',
          'c.ocr_lot', 'c.ocr_expiry', 'c.ocr_confidence', 'c.photo_key',
          'c.verdict', 'c.rule_broken', 'c.status',
          'c.authorized_by', 'c.authorized_at', 'c.resolution_notes',
          'c.created_at', 'c.created_by',
        )
        .orderBy('c.created_at', 'desc')
        .limit(limit);
      // Firma la foto para abrirla inline.
      return Promise.all(
        rows.map(async (r) => ({
          ...r,
          photo_url: r.photo_key ? await this.storage.signedUrl(r.photo_key).catch(() => '') : '',
        })),
      );
    });
  }

  /** Scorecard de proveedor: recepciones vs no conformidades (verdict != green). */
  async scorecard(query: { from?: string; to?: string }) {
    return this.tk.run(async (trx) => {
      let q = trx('commercial.receiving_lot_captures')
        .whereNotNull('supplier_code');
      if (query.from) q = q.where('created_at', '>=', query.from);
      if (query.to) q = q.where('created_at', '<=', query.to);
      return q
        .select('supplier_code')
        .count({ receptions: '*' })
        .select(
          trx.raw(`COUNT(*) FILTER (WHERE verdict <> 'green') AS nonconformities`),
          trx.raw(`COUNT(*) FILTER (WHERE verdict = 'red') AS reds`),
          trx.raw(`COUNT(*) FILTER (WHERE status = 'rejected') AS rejected`),
          trx.raw(`ROUND(100.0 * COUNT(*) FILTER (WHERE verdict <> 'green') / NULLIF(COUNT(*),0), 1) AS nc_rate_pct`),
        )
        .groupBy('supplier_code')
        .orderByRaw(`COUNT(*) FILTER (WHERE verdict <> 'green') DESC`);
    });
  }

  // ───── política ─────

  async listPolicies() {
    return this.tk.run(async (trx) =>
      trx('commercial.expiry_receiving_policy as pol')
        .leftJoin('public.products as p', 'p.id', 'pol.product_id')
        .select(
          'pol.id', 'pol.product_id', 'p.sku', 'p.nombre as product_name',
          'pol.category', 'pol.supplier_code',
          'pol.min_shelf_life_days', 'pol.allow_older_than_existing',
          'pol.source', 'pol.notes', 'pol.updated_at',
        )
        .orderBy('pol.updated_at', 'desc'),
    );
  }

  async upsertPolicy(dto: PolicyDto) {
    if (dto.product_id && !UUID_REGEX.test(dto.product_id))
      throw new BadRequestException('product_id inválido');
    if (dto.min_shelf_life_days != null && (dto.min_shelf_life_days < 0 || !Number.isInteger(dto.min_shelf_life_days)))
      throw new BadRequestException('min_shelf_life_days debe ser entero >= 0');
    if (!dto.product_id && !dto.category && !dto.supplier_code)
      throw new BadRequestException('Debe indicar ámbito: product_id, category o supplier_code');

    return this.tk.run(async (trx) => {
      const userId = this.tenantCtx.get()?.userId || null;
      const scope = {
        product_id: dto.product_id || null,
        category: dto.category || null,
        supplier_code: dto.supplier_code || null,
      };
      const existing = await trx('commercial.expiry_receiving_policy').where(scope).first();
      const patch = {
        min_shelf_life_days: dto.min_shelf_life_days ?? null,
        allow_older_than_existing: !!dto.allow_older_than_existing,
        source: 'manual',
        notes: dto.notes || null,
        updated_at: trx.fn.now(),
        updated_by: userId,
      };
      if (existing) {
        await trx('commercial.expiry_receiving_policy').where({ id: existing.id }).update(patch);
        return { ...existing, ...patch, updated_at: undefined };
      }
      const [row] = await trx('commercial.expiry_receiving_policy')
        .insert({ tenant_id: trx.raw('public.current_tenant_id()'), ...scope, ...patch })
        .returning('*');
      return row;
    });
  }

  async deletePolicy(id: string) {
    if (!UUID_REGEX.test(id)) throw new BadRequestException('id inválido');
    return this.tk.run(async (trx) => {
      const n = await trx('commercial.expiry_receiving_policy').where({ id }).del();
      if (!n) throw new NotFoundException('Política no encontrada');
      return { deleted: true };
    });
  }

  // ───── helpers ─────

  private async getCapture(id: string) {
    return this.tk.run(async (trx) => {
      const row = await trx('commercial.receiving_lot_captures').where({ id }).first();
      if (!row) throw new NotFoundException('Captura no encontrada');
      return row;
    });
  }

  /** Escribe el 'in' de stock (alimenta stock_lots/FEFO) y liga el movement a la captura. */
  private async writeStockForCapture(capture: any): Promise<void> {
    if (capture.stock_movement_id) return; // idempotente: ya escrito
    const movement = await this.inventory.recordMovement({
      warehouse_id: capture.warehouse_id,
      product_id: capture.product_id,
      movement_type: 'in',
      quantity: Number(capture.quantity),
      lot_code: capture.confirmed_lot || 'NA',
      expiry_date: capture.confirmed_expiry ? this.toIso(capture.confirmed_expiry) : undefined,
      reference_type: 'receiving_audit',
      notes: `Recepción auditada (${capture.verdict}${capture.rule_broken ? ' · ' + capture.rule_broken : ''})`,
    });
    await this.tk.run(async (trx) => {
      await trx('commercial.receiving_lot_captures')
        .where({ id: capture.id })
        .update({ stock_movement_id: movement.id });
    });
  }

  /** Resuelve la política por ámbito en cascada: producto → categoría → proveedor. */
  private async resolvePolicy(
    trx: any,
    scope: { product_id: string | null; category: string | null; supplier_code: string | null },
  ) {
    if (scope.product_id) {
      const byProduct = await trx('commercial.expiry_receiving_policy')
        .where({ product_id: scope.product_id })
        .first();
      if (byProduct) return byProduct;
    }
    if (scope.category) {
      const byCategory = await trx('commercial.expiry_receiving_policy')
        .whereNull('product_id')
        .where({ category: scope.category })
        .whereNull('supplier_code')
        .first();
      if (byCategory) return byCategory;
    }
    if (scope.supplier_code) {
      const bySupplier = await trx('commercial.expiry_receiving_policy')
        .whereNull('product_id')
        .whereNull('category')
        .where({ supplier_code: scope.supplier_code })
        .first();
      if (bySupplier) return bySupplier;
    }
    return null;
  }

  private parseDataUri(dataUri: string): { base64: string; mediaType: string } | null {
    if (!dataUri) return null;
    const m = /^data:([^;,]+)[;,]/.exec(dataUri);
    const mediaType = (m ? m[1] : 'image/jpeg').toLowerCase();
    const base64 = dataUri.replace(/^data:[^,]*,/, '');
    if (!base64) return null;
    return { base64, mediaType };
  }

  /** Normaliza un Date/valor de pg a ISO YYYY-MM-DD. */
  private toIso(v: any): string {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v).slice(0, 10);
  }
}
