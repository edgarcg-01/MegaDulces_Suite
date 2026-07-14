import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { legacyTxStorage } from '@megadulces/platform-core';
import { CreateBrandDto, UpdateBrandDto } from './dto/brand.dto';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { EmbeddingsService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

@Injectable()
export class PlanogramsService {
  private readonly logger = new Logger(PlanogramsService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly embeddings: EmbeddingsService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Dado un set de SKUs (del set activo ERP, ej. los que devuelve el OCR del
   * ticket del vendedor), resuelve cada uno a su `product_id` canónico (catalog
   * UUID) — el universo que usa el reporte (catalog.products por id).
   *
   * Resolución en dos pasos:
   *   1. `trade.planogram_sku_aliases` (erp_sku → product_id): maneja variantes
   *      ERP agrupadas a un producto del planograma (distinto nombre/sku).
   *   2. Fallback `catalog.products.sku` directo: el sku del set activo comparte
   *      namespace con catalog.products.sku, así que la mayoría resuelve directo
   *      aunque NO esté aliaseado (solo ~9% lo está). Sin este fallback la visita
   *      quedaba vacía para productos no-aliaseados aunque sí están en catálogo.
   */
  async matchPlanogramSkus(
    skus: string[],
  ): Promise<{ sku: string; product_id: string }[]> {
    const list = Array.from(
      new Set((skus || []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())),
    );
    if (list.length === 0) return [];
    const tenantId = this.tenantCtx.requireTenantId();
    const map = new Map<string, string>();

    const aliasRows = await this.knex('trade.planogram_sku_aliases')
      .where('tenant_id', tenantId)
      .whereNull('deleted_at')
      .whereIn('erp_sku', list)
      .distinct('erp_sku', 'product_id')
      .select('erp_sku as sku', 'product_id');
    for (const r of aliasRows) map.set(r.sku, r.product_id);

    const unresolved = list.filter((s) => !map.has(s));
    if (unresolved.length) {
      // El código ERP del producto puede estar en `sku` (entorno local enriquecido)
      // o en `articulo` (prod: el sku quedó null y el código vive en articulo).
      // Matcheamos por ambas columnas para cubrir los dos casos.
      const catRows = await this.knex('catalog.products')
        .where('tenant_id', tenantId)
        .whereNull('deleted_at')
        .where((qb) =>
          qb.whereIn('sku', unresolved).orWhereIn('articulo', unresolved),
        )
        .select('id', 'sku', 'articulo');
      for (const r of catRows) {
        if (r.sku && !map.has(r.sku)) map.set(r.sku, r.id);
        if (r.articulo && !map.has(r.articulo)) map.set(r.articulo, r.id);
      }
    }

    return Array.from(map.entries()).map(([sku, product_id]) => ({ sku, product_id }));
  }

  /**
   * Fase K — re-embed síncrono del producto.
   *
   * Llamado tras add/update cuando cambia `nombre` o `brand_id`. Acepta
   * latencia +200ms en el path admin para evitar staleness en el endpoint
   * de match-ai. Si Voyage está caído, loguea warning pero NO rompe la
   * operación admin — el producto queda con embedding=null y se re-intenta
   * en el próximo update o vía backfill script.
   *
   * Source text: "MARCA — NOMBRE" (mismo formato que el backfill).
   */
  private async embedProduct(productId: string): Promise<void> {
    try {
      const row = await this.knex('products as p')
        .leftJoin('brands as b', 'b.id', 'p.brand_id')
        .where('p.id', productId)
        .select('p.nombre as product_name', 'b.nombre as brand_name')
        .first();
      if (!row) return;

      const sourceText = [row.brand_name, row.product_name]
        .filter((s) => s && s.trim())
        .map((s) => s.trim())
        .join(' — ');

      const vec = await this.embeddings.embedSingle(sourceText, 'document');
      const vecLiteral = `[${vec.join(',')}]`;

      // El UPDATE con cast `?::vector` es lo único que puede fallar duro: si la
      // DB no tiene la extensión pgvector, tira `type "vector" does not exist` y
      // aborta la trx de la request entera — el INSERT/UPDATE del producto que
      // la disparó haría rollback silencioso al COMMIT del interceptor (el admin
      // ve 200 OK pero el producto no se persiste). Lo envolvemos en un savepoint
      // sobre la MISMA trx (así ve la fila recién insertada aún sin commitear);
      // un fallo hace ROLLBACK TO SAVEPOINT y deja la trx de la request viva.
      const updateSql = `UPDATE products
           SET embedding = ?::vector,
               embedding_source_text = ?,
               embedding_updated_at = NOW()
         WHERE id = ?`;
      const params = [vecLiteral, sourceText, productId];
      const store = legacyTxStorage.getStore();
      if (store?.tx) {
        await store.tx.transaction((sp) => sp.raw(updateSql, params));
      } else {
        await this.knex.raw(updateSql, params);
      }
    } catch (err: any) {
      // No-throw: el feature debe degradar elegante. El producto queda
      // marcado sin embedding y el backfill script lo recoge.
      this.logger.warn(
        `embedProduct(${productId}) falló: ${err.message}. El producto quedará sin embedding hasta el próximo update o backfill.`,
      );
    }
  }

  private timestampColumnCache: Record<string, 'updated_at' | 'created_at' | null> = {};

  private async getTimestampColumn(
    tableName: string,
  ): Promise<'updated_at' | 'created_at' | null> {
    if (tableName in this.timestampColumnCache) {
      return this.timestampColumnCache[tableName];
    }

    const hasUpdatedAt = await this.knex.schema.hasColumn(
      tableName,
      'updated_at',
    );
    if (hasUpdatedAt) {
      this.timestampColumnCache[tableName] = 'updated_at';
      return 'updated_at';
    }

    const hasCreatedAt = await this.knex.schema.hasColumn(
      tableName,
      'created_at',
    );
    if (hasCreatedAt) {
      this.timestampColumnCache[tableName] = 'created_at';
      return 'created_at';
    }

    this.timestampColumnCache[tableName] = null;
    return null;
  }

  private async getMaxTimestamp(tableName: string): Promise<string | null> {
    const column = await this.getTimestampColumn(tableName);
    if (!column) return null;

    const result = await this.knex(tableName)
      .where('tenant_id', this.tenantCtx.requireTenantId())
      .max(`${column} as max_updated`)
      .first();
    return result?.max_updated ?? null;
  }

  private async withTimestamp(
    tableName: string,
    data: Record<string, any>,
  ): Promise<Record<string, any>> {
    const timestampColumn = await this.getTimestampColumn(tableName);
    return timestampColumn
      ? { ...data, [timestampColumn]: this.knex.fn.now() }
      : data;
  }

  /**
   * Catálogo jerárquico marcas → productos.
   *
   * `planogramOnly=true` (default) devuelve SOLO el planograma de trade
   * (`in_planogram=true`) y recorta las marcas sin productos del planograma —
   * es lo que consume la captura en ruta y la vista curada del admin.
   * `planogramOnly=false` devuelve el catálogo completo (ERP incluido) para
   * que el admin busque y agregue productos al planograma.
   */
  async getAll(includeInactive = false, planogramOnly = true) {
    // `KNEX_CONNECTION` corre como `postgres` (superuser) que bypassa RLS aun con
    // FORCE — el filtro de tenant_id debe ser explícito en cada query.
    const tenantId = this.tenantCtx.requireTenantId();
    const brandsQuery = this.knex('brands')
      .where('tenant_id', tenantId)
      .orderBy('orden', 'asc')
      .orderBy('nombre', 'asc');
    const productsQuery = this.knex('products')
      .where('tenant_id', tenantId)
      .orderBy('orden', 'asc')
      .orderBy('nombre', 'asc');

    if (!includeInactive) {
      brandsQuery.andWhere({ activo: true });
      productsQuery.andWhere({ activo: true });
    }

    if (planogramOnly) {
      productsQuery.andWhere('in_planogram', true);
    }

    const [brands, products] = await Promise.all([brandsQuery, productsQuery]);

    const productsByBrand = new Map<string, any[]>();
    for (const product of products) {
      const bucket = productsByBrand.get(product.brand_id);
      if (bucket) bucket.push(product);
      else productsByBrand.set(product.brand_id, [product]);
    }

    const result = brands.map((brand) => ({
      ...brand,
      productos: productsByBrand.get(brand.id) ?? [],
    }));

    // En modo planograma, oculta marcas sin ningún producto del planograma
    // (razones sociales de proveedores / buckets ERP quedan fuera).
    return planogramOnly
      ? result.filter((b) => (b.productos?.length ?? 0) > 0)
      : result;
  }

  /**
   * Agrega/quita un producto del planograma (curación desde /admin/planograma).
   * Bump de `updated_at` para invalidar el cache del cliente móvil (getVersion).
   */
  async setPlanogramMembership(productId: string, inPlanogram: boolean) {
    const tenantId = this.tenantCtx.requireTenantId();
    const payload = await this.withTimestamp('products', {
      in_planogram: !!inPlanogram,
    });
    const [product] = await this.knex('products')
      .where({ id: productId, tenant_id: tenantId })
      .update(payload)
      .returning('*');
    if (!product) {
      throw new NotFoundException(`Producto con ID ${productId} no encontrado.`);
    }
    return product;
  }

  async getVersion() {
    try {
      const [brandsMax, productsMax] = await Promise.all([
        this.getMaxTimestamp('brands'),
        this.getMaxTimestamp('products'),
      ]);
      const dates = [brandsMax, productsMax].filter(
        (d): d is string => Boolean(d),
      );
      const maxDate =
        dates.length > 0
          ? new Date(
              Math.max(...dates.map((d) => new Date(d).getTime())),
            ).toISOString()
          : null;
      return { version: maxDate };
    } catch (error: any) {
      this.logger.error(`Error getting version: ${error.message}`);
      return { version: null };
    }
  }

  async createBrand(data: CreateBrandDto) {
    const payload = await this.withTimestamp('brands', {
      tenant_id: this.tenantCtx.requireTenantId(),
      activo: true,
      ...data,
    });
    try {
      const [brand] = await this.knex('brands').insert(payload).returning('*');
      return brand;
    } catch (error: any) {
      if (error.code === '23505') {
        throw new ConflictException(
          `Ya existe una marca con el nombre "${data.nombre}".`,
        );
      }
      throw error;
    }
  }

  async addProduct(brandId: string, data: CreateProductDto) {
    const tenantId = this.tenantCtx.requireTenantId();
    const brand = await this.knex('brands')
      .where({ id: brandId, tenant_id: tenantId })
      .first();
    if (!brand) {
      throw new NotFoundException(`Marca con ID ${brandId} no encontrada.`);
    }

    const insertData = await this.withTimestamp('products', {
      tenant_id: tenantId,
      activo: true,
      // Crear desde /admin/planograma = producto del planograma por default.
      in_planogram: true,
      ...data,
      brand_id: brandId,
    });

    try {
      const [product] = await this.knex('products')
        .insert(insertData)
        .returning('*');

      // Bump del `updated_at` de la marca padre para que el cache
      // busting del cliente móvil (getVersion) detecte el cambio.
      const brandUpdatePayload = await this.withTimestamp('brands', {});
      if (Object.keys(brandUpdatePayload).length > 0) {
        await this.knex('brands')
          .where({ id: brandId, tenant_id: tenantId })
          .update(brandUpdatePayload);
      }

      // Fase K: embebe el producto recién creado para que aparezca en match-ai.
      // No-blocking en caso de falla — el catch interno loguea warning.
      await this.embedProduct(product.id);

      return product;
    } catch (error: any) {
      if (error.code === '23505') {
        throw new ConflictException(
          `Ya existe un producto con el nombre "${data.nombre}" en esta marca.`,
        );
      }
      throw error;
    }
  }

  async getProduct(id: string) {
    const product = await this.knex('products')
      .where({ id, tenant_id: this.tenantCtx.requireTenantId() })
      .first();
    if (!product) {
      throw new NotFoundException(`Producto con ID ${id} no encontrado.`);
    }
    return product;
  }

  async updateBrand(id: string, data: UpdateBrandDto) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (Object.keys(data).length === 0) {
      const existing = await this.knex('brands')
        .where({ id, tenant_id: tenantId })
        .first();
      if (!existing) {
        throw new NotFoundException(`Marca con ID ${id} no encontrada.`);
      }
      return existing;
    }

    // Fase K integridad: si cambia el nombre del brand, el `source_text` de
    // sus products queda stale. Capturamos el nombre previo para comparar.
    const willRenameBrand = Object.prototype.hasOwnProperty.call(data, 'nombre');
    const previousNombre = willRenameBrand
      ? (
          await this.knex('brands')
            .where({ id, tenant_id: tenantId })
            .first('nombre')
        )?.nombre
      : null;

    const payload = await this.withTimestamp('brands', data);

    try {
      const [brand] = await this.knex('brands')
        .where({ id, tenant_id: tenantId })
        .update(payload)
        .returning('*');
      if (!brand) {
        throw new NotFoundException(`Marca con ID ${id} no encontrada.`);
      }

      // Fase K integridad: si efectivamente cambió el nombre del brand,
      // marcar como stale los embeddings de sus products. El scanner los
      // recoge en el próximo tick. NOTA: este UPDATE NO recalcula el
      // embedding ni dispara el trigger de products (que solo reacciona a
      // cambios de products.nombre o products.brand_id).
      if (
        willRenameBrand &&
        previousNombre &&
        previousNombre !== brand.nombre
      ) {
        const result = await this.knex('products')
          .where({ brand_id: id, tenant_id: tenantId })
          .update({
            embedding_updated_at: null,
            embedding_source_text: null,
          });
        this.logger.log(
          `updateBrand(${id}): brand renamed ${previousNombre} → ${brand.nombre}. ${result} products marked stale.`,
        );
      }

      return brand;
    } catch (error: any) {
      if (error.code === '23505') {
        throw new ConflictException(
          `Ya existe una marca con el nombre "${data.nombre}".`,
        );
      }
      throw error;
    }
  }

  async updateProduct(id: string, data: UpdateProductDto) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (Object.keys(data).length === 0) {
      const existing = await this.knex('products')
        .where({ id, tenant_id: tenantId })
        .first();
      if (!existing) {
        throw new NotFoundException(`Producto con ID ${id} no encontrado.`);
      }
      return existing;
    }

    const payload = await this.withTimestamp('products', data);

    try {
      const [product] = await this.knex('products')
        .where({ id, tenant_id: tenantId })
        .update(payload)
        .returning('*');
      if (!product) {
        throw new NotFoundException(`Producto con ID ${id} no encontrado.`);
      }

      // Fase K: re-embed solo si cambió algo que afecta el source text.
      // Cambiar `activo` o `orden` no requiere re-embed (no aparece en text).
      if (
        Object.prototype.hasOwnProperty.call(data, 'nombre') ||
        Object.prototype.hasOwnProperty.call(data, 'brand_id')
      ) {
        await this.embedProduct(id);
      }

      return product;
    } catch (error: any) {
      if (error.code === '23505') {
        throw new ConflictException(
          `Ya existe un producto con el nombre "${data.nombre}" en esta marca.`,
        );
      }
      throw error;
    }
  }

  /**
   * Soft-delete inteligente: si el producto está marcado en
   * `daily_captures.exhibiciones[].productosMarcados` (JSONB), se marca
   * `activo=false` para preservar el historial. Si no, hard-delete.
   */
  async deleteProduct(id: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const product = await this.knex('products')
      .where({ id, tenant_id: tenantId })
      .first();
    if (!product) {
      throw new NotFoundException(`Producto con ID ${id} no encontrado.`);
    }

    const referenced = await this.isProductReferenced(id);
    if (referenced) {
      const payload = await this.withTimestamp('products', { activo: false });
      await this.knex('products').where({ id, tenant_id: tenantId }).update(payload);
      return {
        success: true,
        soft_deleted: true,
        message:
          'El producto está referenciado en capturas históricas; se marcó como inactivo para preservar el historial.',
      };
    }

    await this.knex('products').where({ id, tenant_id: tenantId }).del();
    return { success: true, soft_deleted: false };
  }

  /**
   * Soft-delete inteligente para marca: si CUALQUIER producto de la marca
   * está referenciado en capturas, se soft-deletea la marca y todos sus
   * productos (cascada lógica). Si no, hard-delete (la FK cascade ya borra
   * los productos físicamente).
   */
  async deleteBrand(id: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const brand = await this.knex('brands')
      .where({ id, tenant_id: tenantId })
      .first();
    if (!brand) {
      throw new NotFoundException(`Marca con ID ${id} no encontrada.`);
    }

    const products = await this.knex('products')
      .where({ brand_id: id, tenant_id: tenantId })
      .select('id');
    const productIds = products.map((p) => p.id);

    const anyReferenced =
      productIds.length > 0 &&
      (await this.isAnyProductReferenced(productIds));

    if (anyReferenced) {
      await this.knex.transaction(async (trx) => {
        const prodPayload = await this.withTimestamp('products', {
          activo: false,
        });
        const brandPayload = await this.withTimestamp('brands', {
          activo: false,
        });
        await trx('products')
          .where({ brand_id: id, tenant_id: tenantId })
          .update(prodPayload);
        await trx('brands').where({ id, tenant_id: tenantId }).update(brandPayload);
      });
      return {
        success: true,
        soft_deleted: true,
        message:
          'La marca tiene productos referenciados en capturas históricas; se marcó la marca y sus productos como inactivos para preservar el historial.',
      };
    }

    await this.knex('brands').where({ id, tenant_id: tenantId }).del();
    return { success: true, soft_deleted: false };
  }

  /**
   * ¿El producto está referenciado en `daily_captures.exhibiciones[].productosMarcados`?
   * Usa JSONB containment para verificación rápida.
   */
  private async isProductReferenced(productId: string): Promise<boolean> {
    const containment = JSON.stringify([{ productosMarcados: [productId] }]);
    const ref = await this.knex('daily_captures')
      .where('tenant_id', this.tenantCtx.requireTenantId())
      .whereRaw('exhibiciones @> ?::jsonb', [containment])
      .select('id')
      .first();
    return !!ref;
  }

  /**
   * ¿Algún producto de la lista está referenciado? Construye un OR de
   * containments (`exhibiciones @> ?::jsonb`) — la única forma segura
   * porque el operador JSONB `?|` colisiona con el placeholder `?` de Knex.
   * Con un GIN index sobre `exhibiciones` esto sigue siendo eficiente.
   */
  private async isAnyProductReferenced(
    productIds: string[],
  ): Promise<boolean> {
    if (productIds.length === 0) return false;
    const orClauses = productIds
      .map(() => 'exhibiciones @> ?::jsonb')
      .join(' OR ');
    const params = productIds.map((id) =>
      JSON.stringify([{ productosMarcados: [id] }]),
    );
    const ref = await this.knex('daily_captures')
      .where('tenant_id', this.tenantCtx.requireTenantId())
      .whereRaw(`(${orClauses})`, params)
      .select('id')
      .first();
    return !!ref;
  }
}
