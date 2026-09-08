import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import {
  TenantKnexService,
  TenantContextService,
  CloudinaryService,
  ObjectStorageService,
  ScopeService,
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
/**
 * Unidades reales de recepción en tienda: al almacén no todo llega en piezas.
 * caja (lo común con código numérico de anaquel) · pieza (piñatas, suelto) ·
 * bulto (las bolsas grandes) · kg (granel). Espeja el CHECK de la migración
 * 20260825180000.
 */
const VALID_UNITS = ['caja', 'pieza', 'bulto', 'kg'] as const;
export type LineUnit = (typeof VALID_UNITS)[number];
type Condition = (typeof VALID_CONDITIONS)[number];

export interface ReviewFile {
  role: string;
  url: string;
  public_id?: string;
  kind?: string;
  name?: string;
  /** Firma efímera que devuelve /upload solo para la vista previa; NO se persiste. */
  preview_url?: string;
}

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
  unit?: LineUnit; // caja | pieza | bulto | kg
  files?: ReviewFile[];
}

/** Un producto candidato para un código escaneado/tecleado. */
export interface ResolveHit {
  id: string;
  sku: string | null;
  nombre: string | null;
  brand_id: string | null;
  brand_name: string | null;
  barcode: string | null;
  /** Presentación de venta del catálogo (`unit_sale` × `factor_sale`): "PAQ x 24". */
  unit_sale: string | null;
  factor_sale: number | null;
  /** Ubicación de anaquel que el catálogo ya conoce (`products.location`). */
  location: string | null;
  /** Unidad a la que apunta el CÓDIGO leído (`catalog.product_barcodes.unit`): PZA | CJA | PAQ… */
  scanned_unit: string | null;
  /** Piezas por esa unidad (1 = pieza, 24 = caja de 24). */
  factor: number | null;
  /** Traducción a las unidades de la hoja. null = el código no dice nada. */
  unit_hint: LineUnit | null;
}

export interface ResolveResult {
  code: string;
  /** Único match. null si no hubo ninguno o si el código es ambiguo. */
  match: ResolveHit | null;
  /** >1 cuando el código coincide con varios productos: el operador elige. */
  candidates: ResolveHit[];
  /** Por dónde entró el match (para explicarlo en pantalla y depurar). */
  source: 'barcode' | 'sku' | 'legacy_barcode' | 'none';
  /** Hubo match, pero es de una marca que este promotor no lleva. */
  out_of_scope: boolean;
}

export interface ListReviewsQuery {
  warehouse_id?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Alta directa de UNA caducidad — la captura de tienda (2026-09-08).
 *
 * El colaborador de sucursal no maneja el concepto de "hoja": escanea un
 * producto, pone fecha y cantidad, guarda, y la pantalla queda limpia para el
 * siguiente. Cada alta entra ya cerrada (`status='submitted'`) y alimenta FEFO
 * en el acto, así que **no queda nada en borrador esperando que alguien lo
 * cierre** — el agujero del modelo de hoja abierta.
 *
 * La sucursal NO viaja en el body salvo que el usuario tenga alcance `all`:
 * sale de `identity.users.warehouse_code` vía `ScopeService`. Un colaborador no
 * puede, ni por error ni a mano, cargarle caducidades a otra sucursal.
 */
export interface EntryDto extends ReviewLineDto {
  /** Solo lo respeta quien tiene alcance de sucursal `all` (admin/superuser). */
  warehouse_id?: string;
}

@Injectable()
export class CommercialExpiryReviewsService {
  private readonly logger = new Logger(CommercialExpiryReviewsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cloudinary: CloudinaryService,
    private readonly storage: ObjectStorageService,
    private readonly scope: ScopeService,
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

    const userId = this.tenantCtx.get()?.userId;
    // Se resuelve FUERA del `tk.run`: `scope.apply()` devuelve una Promise del
    // builder, y `await` sobre un query builder de Knex (que es thenable) lo
    // EJECUTA en vez de devolverlo. Con `current()` + `applyTo()` síncrono el
    // builder se compone sin dispararse.
    const sc = await this.scope.current();
    return this.tk.run(async (trx) => {
      let q = trx('commercial.expiry_reviews as r')
        .leftJoin('commercial.warehouses as w', 'w.id', 'r.warehouse_id');

      // Alcance de sucursal SERVER-SIDE (2026-09-08). El encargado ve el historial
      // de SU sucursal y de ninguna otra; quien tiene alcance `all` (admin) sigue
      // viendo todo. Antes esto no se filtraba: la pantalla mostraba las hojas de
      // las 7 sucursales a cualquiera con COMMERCIAL_EXPIRY_VER, y filtrarlo en el
      // front no habría sido un filtro — solo un adorno sobre una API abierta.
      // Se aplica sobre `w.code` porque el alcance habla en códigos de 2 dígitos
      // (`identity.users.warehouse_code`), no en UUIDs.
      q = this.scope.applyTo(q, sc, 'warehouse', 'w.code');

      // Promotor (tiene marcas asignadas) → solo ve SUS hojas.
      if (userId) {
        const isPromoter = await trx('commercial.promoter_brands').where('user_id', userId).first();
        if (isPromoter) q = q.where('r.created_by', userId);
      }
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

      // Mismo alcance que la lista: si el filtro solo viviera en `listReviews`,
      // pegarle al detalle con un id de otra sucursal la dejaría abierta.
      const sc = await this.scope.current();
      if (!this.scope.canRead(sc, 'warehouse', String(header.warehouse_code || '')))
        throw new ForbiddenException('Esa hoja es de otra sucursal.');

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
          'l.unit',
          'l.files',
          'l.fed_to_fefo',
          'l.fefo_qty',
          'l.created_at',
        )
        .orderBy('l.created_at', 'asc');
      // URL de lectura prefirmada (bucket privado); legacy Cloudinary queda igual.
      for (const l of lines) l.files = await this.storage.signFiles(typeof l.files === 'string' ? JSON.parse(l.files || '[]') : (l.files || []));

      return { ...header, lines };
    });
  }

  // ───── resolver un código (pistola de cajera · cámara · tecleado) ─────

  /**
   * Código → producto. Es lo que hace rápida la captura de anaquel: el operador
   * dispara la pistola (que teclea el código y manda Enter), lo lee con la cámara
   * del teléfono, o lo teclea; los tres caminos terminan acá.
   *
   * **Por qué no basta `products.barcode`:** esa columna es escalar y guarda solo
   * el EAN de la PIEZA (Kepler `kdii.c7`). La caja trae OTRO código (`c82`), y es
   * el que más se escanea en bodega. `catalog.product_barcodes` es el 1→N real
   * (barcode → sku + unidad + factor), así que además de resolver el producto nos
   * dice **en qué unidad se escaneó** — y de ahí sale la sugerencia caja/pieza del
   * renglón, que hasta hoy adivinaba "numérico = caja" (un EAN de pieza también
   * es numérico: adivinaba mal).
   *
   * **Nunca lanza por "no encontrado"**: un código sin match devuelve `match: null`
   * y la hoja lo guarda como renglón raw (regla P2.6: renglón sin catálogo se
   * captura igual, solo que no alimenta FEFO). Tirar 404 en una ráfaga de escaneo
   * convertiría un dato válido en un error.
   *
   * **Ambiguo tampoco lanza** (a diferencia del andén, que sí corta): devuelve los
   * candidatos para que el operador elija. En una hoja de caducidades elegir de
   * una lista de 2 es más barato que bloquear la captura.
   */
  async resolveCode(rawCode: string): Promise<ResolveResult> {
    const code = String(rawCode || '').trim();
    if (!code) throw new BadRequestException('code requerido');
    if (code.length > 64) throw new BadRequestException('code demasiado largo');

    const userId = this.tenantCtx.get()?.userId;

    return this.tk.run(async (trx) => {
      // Variantes del mismo código: una UPC-A de 12 dígitos y su EAN-13 con cero
      // al frente son el mismo producto, y la pistola puede entregar cualquiera
      // de las dos según cómo esté configurada. Sin esto, "no existe" en bodega.
      const variants = this.codeVariants(code);

      // (1) catálogo 1→N de barcodes: barcode → sku + unidad + factor.
      let bcRows: any[] = [];
      const hasPB = (await trx.raw(`SELECT to_regclass('catalog.product_barcodes') IS NOT NULL AS ok`)).rows?.[0]?.ok;
      if (hasPB) {
        bcRows = await trx('catalog.product_barcodes')
          .whereIn('barcode', variants)
          .whereNull('deleted_at')
          .select('sku', 'unit', 'factor');
      }
      const bcSkus = Array.from(new Set(bcRows.map((r) => String(r.sku))));
      const unitBySku = new Map<string, { unit: string | null; factor: number | null }>();
      for (const r of bcRows) unitBySku.set(String(r.sku), { unit: r.unit ?? null, factor: r.factor != null ? Number(r.factor) : null });

      // (2) candidatos: por sku-del-barcode ∪ sku == código ∪ barcode legacy == código.
      //     NO se filtra por `activo`: en el anaquel puede haber producto
      //     descontinuado — justo el que urge fechar y sacar.
      const cands = await trx('public.products as p')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .whereNull('p.deleted_at')
        .andWhere((w: any) => {
          if (bcSkus.length) w.whereIn('p.sku', bcSkus);
          w.orWhere('p.sku', code).orWhereIn('p.barcode', variants);
        })
        .distinct(
          'p.id', 'p.sku', 'p.nombre', 'p.barcode', 'p.brand_id', 'b.nombre as brand_name',
          // Prellenado del renglón: presentación de venta y ubicación que el catálogo
          // ya sabe. Escanear tiene que dejar el renglón listo salvo cantidad y fecha.
          'p.unit_sale', 'p.factor_sale', 'p.location',
        );

      const hits: ResolveHit[] = cands.map((r: any) => {
        const bc = r.sku ? unitBySku.get(String(r.sku)) : undefined;
        return {
          id: r.id,
          sku: r.sku ?? null,
          nombre: r.nombre ?? null,
          brand_id: r.brand_id ?? null,
          brand_name: r.brand_name ?? null,
          barcode: r.barcode ?? null,
          unit_sale: r.unit_sale ?? null,
          factor_sale: r.factor_sale != null ? Number(r.factor_sale) : null,
          location: r.location ?? null,
          scanned_unit: bc?.unit ?? null,
          factor: bc?.factor ?? null,
          unit_hint: this.unitHint(bc?.unit ?? null, bc?.factor ?? null),
        };
      });

      const source: ResolveResult['source'] = !hits.length
        ? 'none'
        : bcSkus.length
          ? 'barcode'
          : hits.some((h) => h.sku === code)
            ? 'sku'
            : 'legacy_barcode';

      // (3) scoping de promotor de marca propia: si lleva marcas, un código de otra
      //     marca NO se autocompleta — se le dice por qué, en vez de dejarlo capturar
      //     algo que su hoja no debería tocar.
      const brandIds = userId
        ? (await trx('commercial.promoter_brands').where('user_id', userId).select('brand_id')).map((r: any) => r.brand_id)
        : [];
      let visible = hits;
      let outOfScope = false;
      if (brandIds.length) {
        visible = hits.filter((h) => h.brand_id && brandIds.includes(h.brand_id));
        outOfScope = hits.length > 0 && visible.length === 0;
      }

      // Un solo candidato = match. Varios = que elija el operador.
      // Desempate: si el barcode normalizado apunta a UN solo sku, ése gana sobre
      // la colisión de sku legacy (mismo criterio que la estación de recepción).
      let match: ResolveHit | null = null;
      if (visible.length === 1) match = visible[0];
      else if (visible.length > 1 && bcSkus.length === 1) {
        const only = visible.filter((h) => h.sku === bcSkus[0]);
        if (only.length === 1) match = only[0];
      }

      return {
        code,
        match,
        candidates: match ? [] : visible,
        source: visible.length ? source : 'none',
        out_of_scope: outOfScope,
      };
    });
  }

  /**
   * UPC-A (12) ↔ EAN-13 (13 con cero al frente) son el mismo código impreso; qué
   * dígitos entrega la pistola depende de su configuración, y el catálogo puede
   * tener guardada la otra forma.
   */
  private codeVariants(code: string): string[] {
    const out = new Set<string>([code]);
    if (/^\d{12}$/.test(code)) out.add('0' + code);
    if (/^0\d{12}$/.test(code)) out.add(code.slice(1));
    return Array.from(out);
  }

  /** Unidad del catálogo de barcodes → unidad de la hoja. Sin dato, no inventa. */
  private unitHint(unit: string | null, factor: number | null): LineUnit | null {
    const u = String(unit || '').trim().toUpperCase();
    if (u.startsWith('PZ') || u === 'PIEZA' || u === 'UN') return 'pieza';
    if (u.startsWith('CJ') || u === 'CAJA' || u.startsWith('PAQ') || u === 'BOX') return 'caja';
    if (u.startsWith('KG') || u === 'KILO') return 'kg';
    if (u.startsWith('BUL') || u.startsWith('COS')) return 'bulto';
    // Sin unidad declarada, el factor todavía dice algo: >1 pieza = empaque.
    if (factor != null && factor > 1) return 'caja';
    if (factor === 1) return 'pieza';
    return null;
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
          unit: dto.unit || null,
          files: JSON.stringify(dto.files || []),
          created_by: ctx?.userId || null,
          updated_by: ctx?.userId || null,
        })
        .returning('*');
      await this.touchReview(trx, reviewId, ctx?.userId);
      // El GET del detalle firma los files (signFiles) pero esta respuesta salía cruda,
      // así que el renglón recién agregado mostraba "sin vista previa" hasta recargar.
      return this.signRowFiles(row);
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
      if (dto.unit !== undefined) patch.unit = dto.unit || null;
      if (dto.files !== undefined) patch.files = JSON.stringify(dto.files || []);

      const [row] = await trx('commercial.expiry_review_lines').where({ id: lineId }).update(patch).returning('*');
      await this.touchReview(trx, line.review_id, ctx?.userId);
      return this.signRowFiles(row);
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

  // ───── foto de evidencia (base64 → Railway Bucket; acepta imagen o PDF) ─────

  /** Firma los `files` de un renglón para mostrarlos. No altera lo persistido. */
  private async signRowFiles<T extends { files?: unknown }>(row: T): Promise<T> {
    if (!row) return row;
    const raw = typeof row.files === 'string' ? JSON.parse((row.files as string) || '[]') : row.files || [];
    return { ...row, files: await this.storage.signFiles(raw as ReviewFile[]) };
  }

  async uploadFile(dataUri: string, role = 'evidencia'): Promise<ReviewFile> {
    if (!dataUri) throw new BadRequestException('file_base64 requerido');
    const tenantId = this.tenantCtx.requireTenantId();
    // Caducidad = fotos de producto → putFile (imagen o PDF). url = key; la lectura la firma.
    const f = await this.storage.putFile(dataUri, `commercial/${tenantId}/expiry-reviews`);
    // `url` = la KEY (es lo que se persiste; la lectura la firma con signFiles).
    // `preview_url` = firma efímera SOLO para que el operador vea lo que acaba de
    // adjuntar antes de guardar el renglón. Antes el <img> recibía la key cruda →
    // 404 → la caja de la foto se veía vacía. No se persiste ni reemplaza a `url`.
    const previewUrl = await this.storage.signedUrl(f.key).catch(() => '');
    return { role, url: f.key, public_id: f.key, kind: f.kind, preview_url: previewUrl || undefined };
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
        // Ya alimentado (alta directa de tienda, que alimenta al guardar) → no
        // se vuelve a mover: sin esta guarda, enviar la hoja duplicaría el lote.
        if (line.fed_to_fefo) continue;
        if (await this.feedLine(trx, review.warehouse_id, line, ctx?.userId)) fedCount++;
      }

      const [updated] = await trx('commercial.expiry_reviews')
        .where({ id })
        .update({ status: 'submitted', submitted_at: trx.fn.now(), updated_at: trx.fn.now(), updated_by: ctx?.userId || null })
        .returning('*');

      this.logger.log(`[P2.6] Hoja ${id} enviada: ${fedCount}/${lines.length} renglones alimentaron FEFO.`);
      return { ...updated, fed_lines: fedCount, total_lines: lines.length };
    });
  }

  // ───── FEFO por renglón (alimentar / revertir) ─────

  /**
   * Reclasifica `min(cantidad, saldo del lote NA)` del lote sin fecha al lote
   * fechado `EXP-<fecha>`. El total del producto NO cambia (es una
   * reclasificación, no un movimiento) → `commercial.stock.quantity` queda
   * intacto, el trigger del invariante no dispara y `SUM(lotes)=stock` se
   * sostiene. Devuelve `true` si movió algo.
   *
   * Salía inline dentro de `submitReview`. Se extrajo para que la **alta directa
   * de tienda** alimente FEFO al guardar un solo renglón, y para tener su
   * inverso (`unfeedLine`) sin duplicar la aritmética de lotes.
   */
  private async feedLine(trx: any, warehouseId: string, line: any, userId?: string): Promise<boolean> {
    const qty = Number(line.quantity) || 0;
    // Alimenta FEFO solo si hay producto + caducidad + cantidad.
    if (!line.product_id || !line.expiry_date || qty <= 0) return false;

    // Lock del saldo total (evita race con reservas/movimientos concurrentes).
    const stockRow = await trx('commercial.stock')
      .where({ warehouse_id: warehouseId, product_id: line.product_id })
      .forUpdate()
      .first();
    if (!stockRow) return false; // sin fila de stock → no hay NA que reclasificar

    // Lote 'NA' (balanceador sin fecha): cuánto podemos reclasificar a lote fechado
    // sin alterar el total (invariante SUM(lotes)=stock).
    const naLot = await trx('commercial.stock_lots')
      .where({ warehouse_id: warehouseId, product_id: line.product_id, lot_code: 'NA' })
      .whereNull('expiry_date')
      .first();
    const naQty = naLot ? Number(naLot.quantity) : 0;
    const moveQty = Math.min(qty, naQty);
    if (moveQty <= 0) return false;

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
      [warehouseId, line.product_id, lotCode, expiryYmd, moveQty, userId || null],
    );

    // Decrementa el lote 'NA' en la misma cantidad → total constante, invariante intacto.
    await trx('commercial.stock_lots')
      .where({ id: naLot.id })
      .update({ quantity: naQty - moveQty, updated_at: trx.fn.now(), updated_by: userId || null });

    await trx('commercial.expiry_review_lines')
      .where({ id: line.id })
      .update({ fed_to_fefo: true, fefo_qty: moveQty, updated_at: trx.fn.now() });
    return true;
  }

  /**
   * Inverso exacto de `feedLine`: devuelve `fefo_qty` del lote fechado al lote
   * 'NA'. Es lo que hace corregible una alta ya guardada (el colaborador puede
   * arreglar un dedazo de fecha en su turno).
   *
   * **Se niega si el lote ya no tiene esa cantidad disponible**: entre el alta y
   * la corrección pudo salir mercancía de ese lote (el decremento FEFO del
   * trigger consume no-vencido primero). Devolver algo que ya se despachó
   * inventaría producto; dejarlo a medias rompería el invariante. En ese caso
   * corta con 409 y lo manda con el encargado, que tiene el ajuste de inventario.
   */
  private async unfeedLine(trx: any, warehouseId: string, line: any, userId?: string): Promise<void> {
    const fedQty = Number(line.fefo_qty) || 0;
    if (!line.fed_to_fefo || fedQty <= 0 || !line.product_id || !line.expiry_date) return;

    const expiryYmd = this.toYmd(line.expiry_date);
    const lotCode = `EXP-${expiryYmd}`;

    await trx('commercial.stock')
      .where({ warehouse_id: warehouseId, product_id: line.product_id })
      .forUpdate()
      .first();

    const dated = await trx('commercial.stock_lots')
      .where({ warehouse_id: warehouseId, product_id: line.product_id, lot_code: lotCode })
      .first();
    const libre = dated ? Number(dated.quantity) - Number(dated.reserved_quantity || 0) : 0;
    if (libre < fedQty)
      throw new ConflictException(
        `Ya salió mercancía del lote ${lotCode} (quedan ${libre} de ${fedQty}). Esta alta no se puede corregir sola: pedile al encargado que ajuste el inventario.`,
      );

    await trx('commercial.stock_lots')
      .where({ id: dated.id })
      .update({ quantity: Number(dated.quantity) - fedQty, updated_at: trx.fn.now(), updated_by: userId || null });

    // Devuelve al lote 'NA' (expiry_date NULL). El UNIQUE de stock_lots es
    // NULLS NOT DISTINCT, así que el ON CONFLICT casa el NA existente.
    await trx.raw(
      `INSERT INTO commercial.stock_lots
         (tenant_id, warehouse_id, product_id, lot_code, expiry_date, quantity, reserved_quantity, received_at, updated_by)
       VALUES (public.current_tenant_id(), ?, ?, 'NA', NULL, ?, 0, now(), ?)
       ON CONFLICT (tenant_id, warehouse_id, product_id, lot_code, expiry_date)
       DO UPDATE SET quantity = commercial.stock_lots.quantity + EXCLUDED.quantity,
                     updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [warehouseId, line.product_id, fedQty, userId || null],
    );

    await trx('commercial.expiry_review_lines')
      .where({ id: line.id })
      .update({ fed_to_fefo: false, fefo_qty: null, updated_at: trx.fn.now() });
  }

  // ───── alta directa de UNA caducidad (captura de tienda) ─────

  /**
   * Sucursal donde se va a escribir. `own` (colaborador/encargado) → la de su
   * ficha, y el `warehouse_id` del body se **ignora**; `all` (admin) → hay que
   * pedirla explícita, porque no hay una "suya" que adivinar.
   */
  private async resolveWriteWarehouse(trx: any, wanted?: string): Promise<{ id: string; code: string; name: string }> {
    const sc = await this.scope.current();
    const dim = sc.dims.warehouse;

    if (dim.modeWrite === 'all') {
      if (!wanted || !UUID_REGEX.test(wanted))
        throw new BadRequestException('Elegí la sucursal (warehouse_id) — tu usuario no está asignado a una sola.');
      const w = await trx('commercial.warehouses').where({ id: wanted }).whereNull('deleted_at').first();
      if (!w) throw new NotFoundException('Almacén no encontrado');
      return { id: w.id, code: w.code, name: w.name };
    }

    const codes = dim.valuesWrite.length ? dim.valuesWrite : dim.values;
    if (!codes.length)
      throw new ForbiddenException(
        'Tu usuario no tiene sucursal asignada, así que no hay dónde registrar la caducidad. Pedile al administrador que te asigne una en tu ficha.',
      );

    const rows = await trx('commercial.warehouses').whereIn('code', codes).whereNull('deleted_at').select('id', 'code', 'name');
    if (!rows.length)
      throw new ForbiddenException(`Tu sucursal (${codes.join(', ')}) no existe en el catálogo de almacenes.`);

    if (rows.length === 1) return rows[0];
    // Alcance de varias sucursales: que diga en cuál.
    const pick = wanted ? rows.find((r: any) => r.id === wanted) : undefined;
    if (!pick) throw new BadRequestException('Tenés varias sucursales en tu alcance: elegí en cuál registrar.');
    return pick;
  }

  /**
   * La hoja-contenedor del día. El colaborador nunca la ve: existe porque los
   * renglones cuelgan de una hoja, y agrupar por (sucursal, día, persona) deja
   * el historial del encargado legible — "lo que capturó Ana el martes" — en vez
   * de una hoja por alta.
   *
   * Nace `submitted`: cada alta ya alimentó FEFO al guardarse, así que no hay
   * nada pendiente de enviar. Eso también hace que los endpoints de renglón
   * legacy (que exigen `draft`) no puedan tocar estas altas por accidente.
   */
  private async findOrCreateTodaySheet(trx: any, wh: { id: string }, ctx: { userId?: string; username?: string }) {
    const existing = await trx('commercial.expiry_reviews')
      .where({ warehouse_id: wh.id, created_by: ctx.userId || null, status: 'submitted' })
      .andWhereRaw('review_date = CURRENT_DATE')
      .orderBy('created_at', 'desc')
      .first();
    if (existing) return existing;

    const [row] = await trx('commercial.expiry_reviews')
      .insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        warehouse_id: wh.id,
        review_date: trx.raw('CURRENT_DATE'),
        responsible_user_id: ctx.userId || null,
        responsible_name: ctx.username || null,
        notes: 'Captura directa de tienda',
        status: 'submitted',
        submitted_at: trx.fn.now(),
        created_by: ctx.userId || null,
        updated_by: ctx.userId || null,
      })
      .returning('*');
    return row;
  }

  /**
   * Contexto de captura: **dónde va a escribir esta persona**, resuelto por el
   * server. Lo consume la pantalla para poner la sucursal como dato (no como
   * selector) y para saber si tiene que ofrecer un picker.
   *
   * Existe para no dejar que el front adivine: en el JWT solo viaja
   * `warehouse_code` (dos dígitos), y con eso no se puede escribir el NOMBRE de
   * la sucursal ni resolver su UUID — `GET /commercial/warehouses` exige un
   * permiso de catálogo que el colaborador no tiene. Sin este endpoint la
   * pantalla mostraría "Sucursal 03" y el "no tenés sucursal asignada" recién
   * aparecería como un 403 al intentar guardar, con la captura ya escrita.
   *
   *   `own`  → una sucursal: la de su ficha. El picker no se pinta.
   *   `many` → su alcance incluye varias: elige entre `options`.
   *   `all`  → admin/superuser: elige entre todas las sucursales.
   *   `none` → su usuario no tiene sucursal: la pantalla lo dice y no deja capturar.
   */
  async captureContext() {
    const sc = await this.scope.current();
    const dim = sc.dims.warehouse;

    return this.tk.run(async (trx) => {
      const pick = (qb: any) => qb.whereNull('deleted_at').select('id', 'code', 'name').orderBy('code');

      if (dim.modeWrite === 'all') {
        // Solo las sucursales de verdad: `commercial.warehouses` también tiene
        // almacenes-ruta (`RUTA-*`) y los de Morelia sin código Kepler, que no
        // son un lugar donde alguien recorra un anaquel. Mismo criterio que el
        // universo de la dimensión `warehouse` en ScopeService.
        const options = await pick(trx('commercial.warehouses').whereRaw(`code ~ '^[0-9]{2}$'`));
        return { mode: 'all' as const, warehouse: null, options };
      }

      const codes = dim.valuesWrite.length ? dim.valuesWrite : dim.values;
      if (!codes.length) return { mode: 'none' as const, warehouse: null, options: [] };

      const options = await pick(trx('commercial.warehouses').whereIn('code', codes));
      if (!options.length) return { mode: 'none' as const, warehouse: null, options: [] };
      return {
        mode: options.length > 1 ? ('many' as const) : ('own' as const),
        warehouse: options[0],
        options,
      };
    });
  }

  /**
   * Siguiente folio de hoja para una sucursal: `CAD-03-2026-00001`.
   *
   * UPSERT atómico de Postgres — el mismo patrón que el folio de pedido
   * (`PD-YYYY-NNNNN`): `ON CONFLICT DO UPDATE ... RETURNING` incrementa y
   * devuelve en una sola sentencia, así que dos capturas simultáneas en la misma
   * sucursal no pueden sacar el mismo número sin un lock explícito.
   *
   * El año sale de `CURRENT_DATE` en la base y no del reloj de Node: la hoja se
   * fecha con `CURRENT_DATE`, y en la madrugada del 1 de enero dos relojes en
   * husos distintos entregarían folios de años distintos para el mismo día.
   */
  private async nextFolio(trx: any, warehouseCode: string): Promise<string> {
    const { rows } = await trx.raw(
      `
      INSERT INTO commercial.expiry_folio_sequences (tenant_id, warehouse_code, year, current_value)
      VALUES (public.current_tenant_id(), ?, EXTRACT(YEAR FROM CURRENT_DATE)::int, 1)
      ON CONFLICT (tenant_id, warehouse_code, year) DO UPDATE
        SET current_value = commercial.expiry_folio_sequences.current_value + 1,
            updated_at = now()
      RETURNING current_value, year
      `,
      [warehouseCode],
    );
    const { current_value, year } = rows[0];
    return `CAD-${warehouseCode}-${year}-${String(current_value).padStart(5, '0')}`;
  }

  /** Alta de una caducidad: guarda el renglón y alimenta FEFO en el acto. */
  async createEntry(dto: EntryDto) {
    this.validateLine(dto);
    if (!dto.product_id && !String(dto.product_code_raw || '').trim() && !String(dto.product_name_raw || '').trim())
      throw new BadRequestException('Decí qué producto es (escaneado, buscado o al menos su código).');

    const ctx = this.tenantCtx.get();
    return this.tk.run(async (trx) => {
      const wh = await this.resolveWriteWarehouse(trx, dto.warehouse_id);
      const sheet = await this.findOrCreateTodaySheet(trx, wh, { userId: ctx?.userId, username: ctx?.username });

      const folio = await this.nextFolio(trx, wh.code);

      const [line] = await trx('commercial.expiry_review_lines')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          review_id: sheet.id,
          folio,
          product_id: dto.product_id || null,
          product_code_raw: dto.product_code_raw || null,
          product_name_raw: dto.product_name_raw || null,
          quantity: dto.quantity ?? 0,
          expiry_date: dto.expiry_date || null,
          condition: dto.condition || null,
          observations: dto.observations || null,
          action: dto.action || null,
          location: dto.location || null,
          unit: dto.unit || null,
          files: JSON.stringify(dto.files || []),
          created_by: ctx?.userId || null,
          updated_by: ctx?.userId || null,
        })
        .returning('*');

      await this.feedLine(trx, wh.id, line, ctx?.userId);
      await this.touchReview(trx, sheet.id, ctx?.userId);

      const fresh = await trx('commercial.expiry_review_lines').where({ id: line.id }).first();
      return this.signRowFiles({ ...fresh, warehouse_code: wh.code, warehouse_name: wh.name, review_id: sheet.id });
    });
  }

  /**
   * Lo que ESTA persona capturó HOY en su sucursal — el eco de su turno, para
   * ver lo que lleva y corregir un dedazo. No es el historial: no muestra lo de
   * otros ni lo de días anteriores (eso es `listReviews`, gateado a VER).
   */
  async listMyEntries(limit = 100) {
    const ctx = this.tenantCtx.get();
    if (!ctx?.userId) throw new ForbiddenException('Sin usuario en contexto');
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.expiry_review_lines as l')
        .join('commercial.expiry_reviews as r', 'r.id', 'l.review_id')
        .leftJoin('commercial.warehouses as w', 'w.id', 'r.warehouse_id')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .where('l.created_by', ctx.userId)
        .andWhereRaw('r.review_date = CURRENT_DATE')
        .select(
          'l.id',
          'l.folio',
          'l.review_id',
          'l.product_id',
          'l.product_code_raw',
          'l.product_name_raw',
          'p.sku',
          'p.nombre as product_name',
          'l.quantity',
          'l.unit',
          'l.expiry_date',
          'l.condition',
          'l.observations',
          'l.action',
          'l.location',
          'l.files',
          'l.fed_to_fefo',
          'l.fefo_qty',
          'l.created_at',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
        )
        .orderBy('l.created_at', 'desc')
        .limit(Math.min(500, Math.max(1, Number(limit) || 100)));

      for (const r of rows) r.files = await this.storage.signFiles(typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []));
      return { data: rows };
    });
  }

  /**
   * Renglón propio, de hoy. Es la llave de la corrección: sin esta guarda,
   * `PATCH /entries/:id` con un id ajeno sería una edición de la captura de otra
   * persona (o de otra sucursal).
   */
  private async loadOwnEntry(trx: any, lineId: string) {
    if (!UUID_REGEX.test(lineId)) throw new BadRequestException('line_id inválido');
    const ctx = this.tenantCtx.get();
    const row = await trx('commercial.expiry_review_lines as l')
      .join('commercial.expiry_reviews as r', 'r.id', 'l.review_id')
      .where('l.id', lineId)
      .select('l.*', 'r.warehouse_id', 'r.review_date')
      // "Es de hoy" se decide EN LA BASE (`CURRENT_DATE`), no comparando contra
      // el reloj de Node: la fecha se escribió con `CURRENT_DATE` y si el proceso
      // corre en UTC mientras la tienda vive en America/Mexico_City, las dos
      // respuestas difieren durante seis horas cada noche — justo en el turno que
      // cierra. Un `es_hoy` booleano que sale del mismo reloj que escribió el dato.
      .select(trx.raw('(r.review_date = CURRENT_DATE) AS es_hoy'))
      .first();
    if (!row) throw new NotFoundException('Renglón no encontrado');
    if (!ctx?.userId || row.created_by !== ctx.userId)
      throw new ForbiddenException('Esa captura la hizo otra persona. Pedile al encargado que la corrija.');
    if (!row.es_hoy)
      throw new ConflictException('Solo se corrige la captura del día. Para algo de días anteriores, encargado.');
    return row;
  }

  /** Corrige una alta del turno: revierte FEFO, actualiza y vuelve a alimentar. */
  async updateEntry(lineId: string, dto: ReviewLineDto) {
    this.validateLine(dto);
    const ctx = this.tenantCtx.get();
    return this.tk.run(async (trx) => {
      const line = await this.loadOwnEntry(trx, lineId);
      await this.unfeedLine(trx, line.warehouse_id, line, ctx?.userId);

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
      if (dto.unit !== undefined) patch.unit = dto.unit || null;
      if (dto.files !== undefined) patch.files = JSON.stringify(dto.files || []);

      await trx('commercial.expiry_review_lines').where({ id: lineId }).update(patch);
      const updated = await trx('commercial.expiry_review_lines').where({ id: lineId }).first();
      await this.feedLine(trx, line.warehouse_id, updated, ctx?.userId);
      await this.touchReview(trx, line.review_id, ctx?.userId);

      const fresh = await trx('commercial.expiry_review_lines').where({ id: lineId }).first();
      return this.signRowFiles(fresh);
    });
  }

  /** Borra una alta del turno, devolviendo al lote NA lo que había fechado. */
  async deleteEntry(lineId: string) {
    const ctx = this.tenantCtx.get();
    return this.tk.run(async (trx) => {
      const line = await this.loadOwnEntry(trx, lineId);
      await this.unfeedLine(trx, line.warehouse_id, line, ctx?.userId);
      await trx('commercial.expiry_review_lines').where({ id: lineId }).del();

      // Si era el último renglón, se va también la hoja-contenedor: dejarla
      // vacía llenaría el historial del encargado de renglones "0 registros"
      // que no son un día de trabajo, son un borrado.
      const [{ count }] = await trx('commercial.expiry_review_lines')
        .where({ review_id: line.review_id })
        .count<{ count: string }[]>('* as count');
      if (Number(count) === 0) {
        await trx('commercial.expiry_reviews').where({ id: line.review_id }).del();
        return { deleted: true, sheet_deleted: true };
      }

      await this.touchReview(trx, line.review_id, ctx?.userId);
      return { deleted: true, sheet_deleted: false };
    });
  }

  // ───── expediente por sucursal ─────

  /**
   * El expediente: **una hoja por producto**, archivada bajo su sucursal.
   *
   * Es la vista del encargado/dirección. Cada fila es una hoja citable (folio,
   * producto, cantidad, caducidad, quién la levantó) y NO el contenedor del día:
   * ese solo agrupa la jornada y no es lo que se archiva.
   *
   * Alcance server-side: `own` ve su sucursal, `all` ve las 7. El `warehouse_id`
   * del query es un filtro DENTRO de lo permitido, nunca una forma de salirse.
   */
  async listExpediente(q: {
    warehouse_id?: string;
    from?: string;
    to?: string;
    /** `vencido` · `riesgoso` (≤30d) · `intermedio` (31-90d) · `bueno` (>90d) */
    plazo?: string;
    /** Folio, nombre de producto o SKU. */
    search?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const offset = (page - 1) * pageSize;
    if (q.warehouse_id && !UUID_REGEX.test(q.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');

    const sc = await this.scope.current();

    return this.tk.run(async (trx) => {
      let qb = trx('commercial.expiry_review_lines as l')
        .join('commercial.expiry_reviews as r', 'r.id', 'l.review_id')
        .leftJoin('commercial.warehouses as w', 'w.id', 'r.warehouse_id')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id');

      qb = this.scope.applyTo(qb, sc, 'warehouse', 'w.code');

      if (q.warehouse_id) qb = qb.where('r.warehouse_id', q.warehouse_id);
      if (q.from) qb = qb.where('r.review_date', '>=', q.from);
      if (q.to) qb = qb.where('r.review_date', '<=', q.to);

      // El plazo se calcula en SQL contra `CURRENT_DATE` — el mismo reloj que
      // fechó la hoja. Filtrarlo en el front obligaría a bajar el expediente
      // completo para mostrar "los vencidos".
      const dias = `(l.expiry_date - CURRENT_DATE)`;
      switch (q.plazo) {
        case 'vencido': qb = qb.whereRaw(`l.expiry_date IS NOT NULL AND ${dias} < 0`); break;
        case 'riesgoso': qb = qb.whereRaw(`l.expiry_date IS NOT NULL AND ${dias} BETWEEN 0 AND 30`); break;
        case 'intermedio': qb = qb.whereRaw(`l.expiry_date IS NOT NULL AND ${dias} BETWEEN 31 AND 90`); break;
        case 'bueno': qb = qb.whereRaw(`l.expiry_date IS NOT NULL AND ${dias} > 90`); break;
        default: break;
      }

      const term = String(q.search || '').trim();
      if (term) {
        qb = qb.where((w: any) =>
          w.whereILike('l.folio', `%${term}%`)
            .orWhereILike('p.nombre', `%${term}%`)
            .orWhereILike('p.sku', `%${term}%`)
            .orWhereILike('l.product_name_raw', `%${term}%`)
            .orWhereILike('l.product_code_raw', `%${term}%`),
        );
      }

      const [{ count }] = await qb.clone().count<{ count: string }[]>('l.id as count');

      const data = await qb
        .select(
          'l.id',
          'l.folio',
          'l.review_id',
          'l.product_id',
          'l.product_code_raw',
          'l.product_name_raw',
          'p.sku',
          'p.nombre as product_name',
          'b.nombre as brand_name',
          'l.quantity',
          'l.unit',
          'l.expiry_date',
          'l.condition',
          'l.observations',
          'l.action',
          'l.location',
          'l.files',
          'l.fed_to_fefo',
          'l.fefo_qty',
          'l.created_at',
          'r.review_date',
          'r.warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          // Quién LEVANTÓ la hoja. `created_by` del renglón (no el responsable del
          // encabezado): con varias personas capturando el mismo día, el
          // encabezado dice quién abrió la jornada y el renglón quién hizo ESTA hoja.
          'l.created_by',
          trx.raw(`COALESCE(u.nombre, u.username, r.responsible_name) AS levantada_por`),
          trx.raw(`(l.expiry_date - CURRENT_DATE) AS dias_a_vencer`),
        )
        .leftJoin('public.users as u', 'u.id', 'l.created_by')
        .orderBy('r.review_date', 'desc')
        .orderBy('l.created_at', 'desc')
        .limit(pageSize)
        .offset(offset);

      for (const r of data) r.files = await this.storage.signFiles(typeof r.files === 'string' ? JSON.parse(r.files || '[]') : (r.files || []));

      return {
        data,
        pagination: { page, pageSize, total: Number(count), pageCount: Math.ceil(Number(count) / pageSize) || 0 },
      };
    });
  }

  /**
   * Índice del expediente: **una fila por sucursal** con lo que hay archivado.
   *
   * Es la portada — "8 Esquinas: 34 hojas, 6 por vencer, última el martes". Sale
   * de un solo query agregado en vez de N llamadas por sucursal, y devuelve
   * también las sucursales SIN hojas (LEFT JOIN): un expediente vacío es
   * información — nadie capturó ahí.
   */
  async expedienteBranches() {
    const sc = await this.scope.current();

    return this.tk.run(async (trx) => {
      let qb = trx('commercial.warehouses as w')
        .leftJoin('commercial.expiry_reviews as r', 'r.warehouse_id', 'w.id')
        .leftJoin('commercial.expiry_review_lines as l', 'l.review_id', 'r.id')
        // Solo sucursales de verdad: `commercial.warehouses` mezcla almacenes-ruta
        // (`RUTA-*`) y los de Morelia sin código Kepler. Mismo criterio que el
        // universo de la dimensión `warehouse` en ScopeService.
        .whereRaw(`w.code ~ '^[0-9]{2}$'`)
        .whereNull('w.deleted_at');

      qb = this.scope.applyTo(qb, sc, 'warehouse', 'w.code');

      const rows = await qb
        .groupBy('w.id', 'w.code', 'w.name')
        .select(
          'w.id',
          'w.code',
          'w.name',
          trx.raw(`COUNT(l.id)::int AS hojas`),
          trx.raw(`COUNT(l.id) FILTER (WHERE l.expiry_date IS NOT NULL AND l.expiry_date < CURRENT_DATE)::int AS vencidos`),
          trx.raw(`COUNT(l.id) FILTER (WHERE l.expiry_date IS NOT NULL AND (l.expiry_date - CURRENT_DATE) BETWEEN 0 AND 30)::int AS riesgosos`),
          trx.raw(`MAX(r.review_date) AS ultima_captura`),
        )
        .orderBy('w.code', 'asc');

      return { data: rows };
    });
  }

  /**
   * Una hoja del expediente, por folio o por id de renglón — todo lo que el
   * formato imprimible necesita, en una sola llamada.
   *
   * Acepta el folio porque es lo que alguien tiene a mano cuando viene con la
   * hoja impresa en la carpeta.
   */
  async getHoja(folioOrId: string) {
    const key = String(folioOrId || '').trim();
    if (!key) throw new BadRequestException('folio o id requerido');
    const sc = await this.scope.current();

    return this.tk.run(async (trx) => {
      const row = await trx('commercial.expiry_review_lines as l')
        .join('commercial.expiry_reviews as r', 'r.id', 'l.review_id')
        .leftJoin('commercial.warehouses as w', 'w.id', 'r.warehouse_id')
        .leftJoin('public.products as p', 'p.id', 'l.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .leftJoin('public.users as u', 'u.id', 'l.created_by')
        .where((q: any) => {
          if (UUID_REGEX.test(key)) q.where('l.id', key);
          else q.where('l.folio', key.toUpperCase());
        })
        .select(
          'l.id',
          'l.folio',
          'l.review_id',
          'l.product_id',
          'l.product_code_raw',
          'l.product_name_raw',
          'p.sku',
          'p.nombre as product_name',
          'b.nombre as brand_name',
          'l.quantity',
          'l.unit',
          'l.expiry_date',
          'l.condition',
          'l.observations',
          'l.action',
          'l.location',
          'l.files',
          'l.fed_to_fefo',
          'l.fefo_qty',
          'l.created_at',
          'r.review_date',
          'r.warehouse_id',
          'r.responsible_name',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          trx.raw(`COALESCE(u.nombre, u.username, r.responsible_name) AS levantada_por`),
          trx.raw(`(l.expiry_date - CURRENT_DATE) AS dias_a_vencer`),
        )
        .first();

      if (!row) throw new NotFoundException('Hoja no encontrada');
      // Mismo alcance que el resto: un folio de otra sucursal no se abre por URL.
      if (!this.scope.canRead(sc, 'warehouse', String(row.warehouse_code || '')))
        throw new ForbiddenException('Esa hoja es de otra sucursal.');

      row.files = await this.storage.signFiles(typeof row.files === 'string' ? JSON.parse(row.files || '[]') : (row.files || []));
      return row;
    });
  }

  /**
   * Búsqueda de producto por nombre/SKU **para la captura de caducidades**.
   *
   * Existe porque `GET /commercial/products` exige `COMMERCIAL_PRODUCTS_VER`: un
   * colaborador con solo `COMMERCIAL_EXPIRY_CAPTURAR` no podía buscar por nombre
   * (ni escanear, hasta que se corrigió ese gate). Antes que repartir un permiso
   * de catálogo entero para capturar una fecha, el módulo trae su propio buscador
   * — mínimo, de solo lectura y con el scoping de promotor ya aplicado.
   */
  async searchProducts(q: string, limit = 12) {
    const term = String(q || '').trim();
    if (term.length < 2) return { data: [] };
    const userId = this.tenantCtx.get()?.userId;

    return this.tk.run(async (trx) => {
      const brandIds = userId
        ? (await trx('commercial.promoter_brands').where('user_id', userId).select('brand_id')).map((r: any) => r.brand_id)
        : [];

      let qb = trx('public.products as p')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .whereNull('p.deleted_at')
        .andWhere((w: any) => w.whereILike('p.nombre', `%${term}%`).orWhereILike('p.sku', `%${term}%`));
      if (brandIds.length) qb = qb.whereIn('p.brand_id', brandIds);

      const data = await qb
        .select('p.id', 'p.sku', 'p.nombre', 'p.brand_id', 'b.nombre as brand_name')
        .orderBy('p.nombre', 'asc')
        .limit(Math.min(50, Math.max(1, Number(limit) || 12)));
      return { data };
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
    if (dto.unit && !VALID_UNITS.includes(dto.unit))
      throw new BadRequestException(`unit debe ser: ${VALID_UNITS.join(', ')}`);
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
