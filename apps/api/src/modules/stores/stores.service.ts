import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class StoresService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  private async resolveZonaId(zonaName?: string): Promise<string | null> {
    if (!zonaName) return null;
    const zone = await this.knex('zones').where({ name: zonaName }).select('id').first();
    return zone ? zone.id : null;
  }

  async findAll() {
    return this.knex('stores as s')
      .leftJoin('zones as z', 's.zona_id', 'z.id')
      .where({ 's.activo': true })
      .select('s.*', 'z.name as zona')
      .orderBy('s.nombre', 'asc');
  }

  async create(data: { nombre: string; direccion?: string; zona?: string; latitud?: number; longitud?: number }) {
    const { zona, ...rest } = data;
    const zona_id = await this.resolveZonaId(zona);
    const [store] = await this.knex('stores').insert({ ...rest, zona_id }).returning('*');
    return { ...store, zona };
  }

  async update(id: string, data: Record<string, any>) {
    const { zona, ...rest } = data;
    const updateData: any = { ...rest };
    
    if (zona !== undefined) {
      updateData.zona_id = await this.resolveZonaId(zona);
    }

    const [store] = await this.knex('stores')
      .where({ id })
      .update({ ...updateData, activo: data.activo !== undefined ? data.activo : true })
      .returning('*');
    
    if (!store) throw new NotFoundException('Requerimiento fallido: Tienda o Punto de Venta no encontrado.');
    
    const zoneName = zona !== undefined ? zona : (await this.knex('zones').where({ id: store.zona_id }).select('name').first())?.name;
    return { ...store, zona: zoneName };
  }

}
