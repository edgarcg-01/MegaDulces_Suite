import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class StoresService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  async findAll() {
    // Retorna todos los puntos de venta activos pre-ordenados
    return this.knex('stores').where({ activo: true }).orderBy('nombre', 'asc');
  }

  async create(data: { nombre: string; direccion?: string; zona?: string; latitud?: number; longitud?: number }) {
    const [store] = await this.knex('stores').insert(data).returning('*');
    return store;
  }

  async update(id: string, data: Record<string, any>) {
    const [store] = await this.knex('stores')
      .where({ id })
      .update({ ...data, activo: data.activo !== undefined ? data.activo : true })
      .returning('*');
    
    if (!store) throw new NotFoundException('Requerimiento fallido: Tienda o Punto de Venta no encontrado.');
    return store;
  }
}
