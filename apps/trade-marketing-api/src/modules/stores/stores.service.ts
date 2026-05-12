import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class StoresService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  private async resolveZonaId(zonaName?: string): Promise<string | null> {
    if (!zonaName) return null;
    const cleaned = zonaName.trim();
    const zone = await this.knex('zones')
      .whereRaw('LOWER(name) = ?', [cleaned.toLowerCase()])
      .select('id')
      .first();
    return zone?.id || null;
  }

  async findAll(zona_id?: string, ruta_id?: string) {
    const query = this.knex('stores as s')
      .leftJoin('zones as z', 's.zona_id', 'z.id')
      .leftJoin('catalogs as c', 's.ruta_id', 'c.id')
      .where({ 's.activo': true })
      .select(
        's.id', 's.nombre', 's.direccion', 's.latitud', 's.longitud',
        's.activo', 's.zona_id', 's.ruta_id', 's.created_at',
        'z.name as zona', 'c.value as ruta_nombre'
      )
      .orderBy('s.nombre', 'asc');

    if (zona_id) {
      query.where('s.zona_id', zona_id);
    }

    if (ruta_id) {
      query.where('s.ruta_id', ruta_id);
    }

    return query;
  }

  async create(data: {
    nombre: string;
    direccion?: string;
    zona?: string;
    ruta_id?: string;
    latitud?: number;
    longitud?: number;
  }, userZona?: string) {
    const { zona, ruta_id, ...rest } = data;
    const zonaName = zona || userZona;
    const zona_id = await this.resolveZonaId(zonaName);
    const [store] = await this.knex('stores')
      .insert({ ...rest, zona_id })
      .returning('*');
    return { ...store, zona: zonaName };
  }

  async remove(id: string) {
    const [store] = await this.knex('stores').where({ id }).del().returning('*');
    if (!store)
      throw new NotFoundException(
        'Requerimiento fallido: Tienda o Punto de Venta no encontrado.',
      );
    return store;
  }

  async update(id: string, data: Record<string, any>) {
    const { zona, zona_id, ...rest } = data;
    const updateData: any = { ...rest };

    if (zona_id !== undefined) {
      updateData.zona_id = zona_id;
    } else if (zona !== undefined) {
      updateData.zona_id = await this.resolveZonaId(zona);
    }

    const [store] = await this.knex('stores')
      .where({ id })
      .update({
        ...updateData,
        activo: data.activo !== undefined ? data.activo : true,
      })
      .returning('*');

    if (!store)
      throw new NotFoundException(
        'Requerimiento fallido: Tienda o Punto de Venta no encontrado.',
      );

    const zoneName =
      zona !== undefined
        ? zona
        : (
            await this.knex('zones')
              .where({ id: store.zona_id })
              .select('name')
              .first()
          )?.name;

    const routeName = store.ruta_id
      ? (await this.knex('catalogs').where({ id: store.ruta_id }).select('value').first())?.value
      : null;

    return { ...store, zona: zoneName, ruta_nombre: routeName };
  }
}
