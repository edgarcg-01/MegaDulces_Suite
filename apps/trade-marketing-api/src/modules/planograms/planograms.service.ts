import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class PlanogramsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

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
    const [brandsResult, productsResult] = await Promise.all([
      this.knex('brands').max('updated_at as max_updated').first(),
      this.knex('products').max('updated_at as max_updated').first(),
    ]);
    const dates = [brandsResult?.max_updated, productsResult?.max_updated].filter(Boolean);
    const maxDate = dates.length > 0
      ? new Date(Math.max(...dates.map(d => new Date(d).getTime()))).toISOString()
      : null;
    return { version: maxDate };
  }

  async createBrand(data: any) {
    const [brand] = await this.knex('brands').insert({ ...data, updated_at: this.knex.fn.now() }).returning('*');
    return brand;
  }

  async addProduct(brandId: string, data: any) {
    console.log('[PlanogramsService] addProduct - brandId:', brandId);
    console.log('[PlanogramsService] addProduct - data:', JSON.stringify(data, null, 2));

    const brand = await this.knex('brands').where({ id: brandId }).first();
    if (!brand) throw new Error('Brand not found');

    const insertData = { ...data, brand_id: brandId };
    console.log('[PlanogramsService] addProduct - insertData:', JSON.stringify(insertData, null, 2));

    const [product] = await this.knex('products')
      .insert({ ...insertData, updated_at: this.knex.fn.now() })
      .returning('*');
    
    console.log('[PlanogramsService] addProduct - inserted product:', JSON.stringify(product, null, 2));
    
    if (!product.nombre && data.nombre) {
      product.nombre = data.nombre;
      console.log('[PlanogramsService] addProduct - added nombre from data:', data.nombre);
    }

    await this.knex('brands').where({ id: brandId }).update({ updated_at: this.knex.fn.now() });
    
    return product;
  }

  async getProduct(id: string) {
    const product = await this.knex('products').where({ id }).first();
    if (!product) throw new Error('Product not found');
    return product;
  }

  async updateBrand(id: string, data: any) {
    const [brand] = await this.knex('brands')
      .where({ id })
      .update({ ...data, updated_at: this.knex.fn.now() })
      .returning('*');
    return brand;
  }

  async updateProduct(id: string, data: any) {
    const [product] = await this.knex('products')
      .where({ id })
      .update({ ...data, updated_at: this.knex.fn.now() })
      .returning('*');
    return product;
  }

  async deleteProduct(id: string) {
    await this.knex('products').where({ id }).update({ updated_at: this.knex.fn.now() });
    const deleted = await this.knex('products').where({ id }).del();
    return { deleted };
  }

  async deleteBrand(id: string) {
    await this.knex('products').where({ brand_id: id }).update({ updated_at: this.knex.fn.now() });
    await this.knex('brands').where({ id }).update({ updated_at: this.knex.fn.now() });
    await this.knex('brands').where({ id }).del();
    return { success: true };
  }
}
