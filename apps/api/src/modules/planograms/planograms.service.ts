import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class PlanogramsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  private timestampColumnCache: Record<string, 'updated_at' | 'created_at' | null> = {};

  private async getTimestampColumn(tableName: string): Promise<'updated_at' | 'created_at' | null> {
    if (tableName in this.timestampColumnCache) {
      return this.timestampColumnCache[tableName];
    }

    const hasUpdatedAt = await this.knex.schema.hasColumn(tableName, 'updated_at');
    if (hasUpdatedAt) {
      this.timestampColumnCache[tableName] = 'updated_at';
      return 'updated_at';
    }

    const hasCreatedAt = await this.knex.schema.hasColumn(tableName, 'created_at');
    if (hasCreatedAt) {
      this.timestampColumnCache[tableName] = 'created_at';
      return 'created_at';
    }

    this.timestampColumnCache[tableName] = null;
    return null;
  }

  private async getMaxTimestamp(tableName: string): Promise<string | null> {
    const column = await this.getTimestampColumn(tableName);
    if (!column) {
      console.warn(`[PlanogramsService] No timestamp column found for ${tableName}. Falling back to null version.`);
      return null;
    }

    const result = await this.knex(tableName).max(`${column} as max_updated`).first();
    return result?.max_updated ?? null;
  }

  async getAll() {
    const brands = await this.knex('brands').orderBy('orden', 'asc');
    const products = await this.knex('products').orderBy('orden', 'asc');

    console.log('[PlanogramsService] Brands:', JSON.stringify(brands, null, 2));
    console.log('[PlanogramsService] Products:', JSON.stringify(products, null, 2));

    const result = brands.map((brand) => ({
      ...brand,
      productos: products.filter((p) => p.brand_id === brand.id),
    }));

    console.log('[PlanogramsService] Result:', JSON.stringify(result, null, 2));

    return result;
  }

  async getVersion() {
    try {
      const [brandsMax, productsMax] = await Promise.all([
        this.getMaxTimestamp('brands'),
        this.getMaxTimestamp('products'),
      ]);
      const dates = [brandsMax, productsMax].filter((d): d is string => Boolean(d));
      const maxDate = dates.length > 0
        ? new Date(Math.max(...dates.map((d) => new Date(d).getTime()))).toISOString()
        : null;
      return { version: maxDate };
    } catch (error) {
      console.error('[PlanogramsService] Error getting version:', error);
      return { version: null };
    }
  }

  private async withTimestamp(tableName: string, data: Record<string, any>) {
    const timestampColumn = await this.getTimestampColumn(tableName);
    return timestampColumn ? { ...data, [timestampColumn]: this.knex.fn.now() } : data;
  }

  async createBrand(data: any) {
    const payload = await this.withTimestamp('brands', data);
    const [brand] = await this.knex('brands').insert(payload).returning('*');
    return brand;
  }

  async addProduct(brandId: string, data: any) {
    console.log('[PlanogramsService] addProduct - brandId:', brandId);
    console.log('[PlanogramsService] addProduct - data:', JSON.stringify(data, null, 2));

    const brand = await this.knex('brands').where({ id: brandId }).first();
    if (!brand) throw new Error('Brand not found');

    const insertData = await this.withTimestamp('products', { ...data, brand_id: brandId });
    console.log('[PlanogramsService] addProduct - insertData:', JSON.stringify(insertData, null, 2));

    const [product] = await this.knex('products')
      .insert(insertData)
      .returning('*');
    
    console.log('[PlanogramsService] addProduct - inserted product:', JSON.stringify(product, null, 2));
    
    if (!product.nombre && data.nombre) {
      product.nombre = data.nombre;
      console.log('[PlanogramsService] addProduct - added nombre from data:', data.nombre);
    }

    const brandUpdatePayload = await this.withTimestamp('brands', {});
    if (Object.keys(brandUpdatePayload).length > 0) {
      await this.knex('brands').where({ id: brandId }).update(brandUpdatePayload);
    }
    
    return product;
  }

  async getProduct(id: string) {
    const product = await this.knex('products').where({ id }).first();
    if (!product) throw new Error('Product not found');
    return product;
  }

  async updateBrand(id: string, data: any) {
    const payload = await this.withTimestamp('brands', data);
    const [brand] = await this.knex('brands')
      .where({ id })
      .update(payload)
      .returning('*');
    return brand;
  }

  async updateProduct(id: string, data: any) {
    const payload = await this.withTimestamp('products', data);
    const [product] = await this.knex('products')
      .where({ id })
      .update(payload)
      .returning('*');
    return product;
  }

  async deleteProduct(id: string) {
    const payload = await this.withTimestamp('products', {});
    if (Object.keys(payload).length > 0) {
      await this.knex('products').where({ id }).update(payload);
    }
    const deleted = await this.knex('products').where({ id }).del();
    return { deleted };
  }

  async deleteBrand(id: string) {
    const productPayload = await this.withTimestamp('products', {});
    if (Object.keys(productPayload).length > 0) {
      await this.knex('products').where({ brand_id: id }).update(productPayload);
    }

    const brandPayload = await this.withTimestamp('brands', {});
    if (Object.keys(brandPayload).length > 0) {
      await this.knex('brands').where({ id }).update(brandPayload);
    }

    await this.knex('brands').where({ id }).del();
    return { success: true };
  }
}
