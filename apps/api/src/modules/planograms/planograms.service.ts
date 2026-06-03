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

@Injectable()
export class PlanogramsService {
  private readonly logger = new Logger(PlanogramsService.name);

  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly embeddings: EmbeddingsService,
  ) {}

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

  async getAll(includeInactive = false) {
    const brandsQuery = this.knex('brands').orderBy('orden', 'asc');
    const productsQuery = this.knex('products').orderBy('orden', 'asc');

    if (!includeInactive) {
      brandsQuery.where({ activo: true });
      productsQuery.where({ activo: true });
    }

    const [brands, products] = await Promise.all([brandsQuery, productsQuery]);

    return brands.map((brand) => ({
      ...brand,
      productos: products.filter((p) => p.brand_id === brand.id),
    }));
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
    const payload = await this.withTimestamp('brands', { activo: true, ...data });
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
    const brand = await this.knex('brands').where({ id: brandId }).first();
    if (!brand) {
      throw new NotFoundException(`Marca con ID ${brandId} no encontrada.`);
    }

    const insertData = await this.withTimestamp('products', {
      activo: true,
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
        await this.knex('brands').where({ id: brandId }).update(brandUpdatePayload);
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
    const product = await this.knex('products').where({ id }).first();
    if (!product) {
      throw new NotFoundException(`Producto con ID ${id} no encontrado.`);
    }
    return product;
  }

  async updateBrand(id: string, data: UpdateBrandDto) {
    if (Object.keys(data).length === 0) {
      const existing = await this.knex('brands').where({ id }).first();
      if (!existing) {
        throw new NotFoundException(`Marca con ID ${id} no encontrada.`);
      }
      return existing;
    }

    // Fase K integridad: si cambia el nombre del brand, el `source_text` de
    // sus products queda stale. Capturamos el nombre previo para comparar.
    const willRenameBrand = Object.prototype.hasOwnProperty.call(data, 'nombre');
    const previousNombre = willRenameBrand
      ? (await this.knex('brands').where({ id }).first('nombre'))?.nombre
      : null;

    const payload = await this.withTimestamp('brands', data);

    try {
      const [brand] = await this.knex('brands')
        .where({ id })
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
          .where({ brand_id: id })
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
    if (Object.keys(data).length === 0) {
      const existing = await this.knex('products').where({ id }).first();
      if (!existing) {
        throw new NotFoundException(`Producto con ID ${id} no encontrado.`);
      }
      return existing;
    }

    const payload = await this.withTimestamp('products', data);

    try {
      const [product] = await this.knex('products')
        .where({ id })
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
    const product = await this.knex('products').where({ id }).first();
    if (!product) {
      throw new NotFoundException(`Producto con ID ${id} no encontrado.`);
    }

    const referenced = await this.isProductReferenced(id);
    if (referenced) {
      const payload = await this.withTimestamp('products', { activo: false });
      await this.knex('products').where({ id }).update(payload);
      return {
        success: true,
        soft_deleted: true,
        message:
          'El producto está referenciado en capturas históricas; se marcó como inactivo para preservar el historial.',
      };
    }

    await this.knex('products').where({ id }).del();
    return { success: true, soft_deleted: false };
  }

  /**
   * Soft-delete inteligente para marca: si CUALQUIER producto de la marca
   * está referenciado en capturas, se soft-deletea la marca y todos sus
   * productos (cascada lógica). Si no, hard-delete (la FK cascade ya borra
   * los productos físicamente).
   */
  async deleteBrand(id: string) {
    const brand = await this.knex('brands').where({ id }).first();
    if (!brand) {
      throw new NotFoundException(`Marca con ID ${id} no encontrada.`);
    }

    const products = await this.knex('products')
      .where({ brand_id: id })
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
        await trx('products').where({ brand_id: id }).update(prodPayload);
        await trx('brands').where({ id }).update(brandPayload);
      });
      return {
        success: true,
        soft_deleted: true,
        message:
          'La marca tiene productos referenciados en capturas históricas; se marcó la marca y sus productos como inactivos para preservar el historial.',
      };
    }

    await this.knex('brands').where({ id }).del();
    return { success: true, soft_deleted: false };
  }

  /**
   * ¿El producto está referenciado en `daily_captures.exhibiciones[].productosMarcados`?
   * Usa JSONB containment para verificación rápida.
   */
  private async isProductReferenced(productId: string): Promise<boolean> {
    const containment = JSON.stringify([{ productosMarcados: [productId] }]);
    const ref = await this.knex('daily_captures')
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
      .whereRaw(`(${orClauses})`, params)
      .select('id')
      .first();
    return !!ref;
  }
}
