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

  async createBrand(data: any) {
    const [brand] = await this.knex('brands').insert(data).returning('*');
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
      .insert(insertData)
      .returning('*');
    
    console.log('[PlanogramsService] addProduct - inserted product:', JSON.stringify(product, null, 2));
    
    // Asegurar que el producto tiene todos los campos necesarios
    if (!product.nombre && data.nombre) {
      product.nombre = data.nombre;
      console.log('[PlanogramsService] addProduct - added nombre from data:', data.nombre);
    }
    
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
      .update(data)
      .returning('*');
    return brand;
  }

  async updateProduct(id: string, data: any) {
    const [product] = await this.knex('products')
      .where({ id })
      .update(data)
      .returning('*');
    return product;
  }

  async deleteProduct(id: string) {
    const deleted = await this.knex('products').where({ id }).del();
    return { deleted };
  }

  async deleteBrand(id: string) {
    await this.knex('brands').where({ id }).del();
    return { success: true };
  }
}
