import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class PlanogramsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  async getAll() {
    const brands = await this.knex('brands').orderBy('orden', 'asc');
    const products = await this.knex('products').orderBy('orden', 'asc');

    return brands.map((brand) => ({
      ...brand,
      productos: products.filter((p) => p.brand_id === brand.id),
    }));
  }

  async createBrand(data: any) {
    const [brand] = await this.knex('brands').insert(data).returning('*');
    return brand;
  }

  async addProduct(brandId: string, data: any) {
    const brand = await this.knex('brands').where({ id: brandId }).first();
    if (!brand) throw new Error('Brand not found');

    const [product] = await this.knex('products')
      .insert({ ...data, brand_id: brandId })
      .returning('*');
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
