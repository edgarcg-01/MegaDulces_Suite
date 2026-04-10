import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class DailyAssignmentsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  async create(data: any) {
    const [assignment] = await this.knex('daily_assignments')
      .insert({
        user_id: data.user_id,
        route_id: data.route_id,
        assigned_by: data.assigned_by,
        day_of_week: data.day_of_week,
        status: data.status || 'pendiente',
      })
      .onConflict(['user_id', 'day_of_week'])
      .merge()
      .returning('*');
    return assignment;
  }

  async findAll(filters: {
    supervisor_id?: string;
    user_id?: string;
    day_of_week?: number;
  }) {
    const query = this.knex('daily_assignments as da')
      .join('users as u', 'da.user_id', 'u.id')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .join('catalogs as c', 'da.route_id', 'c.id')
      .select(
        'da.*',
        'u.nombre as user_nombre',
        'z.name as user_zona',
        'c.value as route_name',
      );

    if (filters.supervisor_id) {
      query.where('u.supervisor_id', filters.supervisor_id);
    }
    if (filters.user_id) {
      query.where('da.user_id', filters.user_id);
    }
    if (filters.day_of_week) {
      query.where('da.day_of_week', filters.day_of_week);
    }

    return query.orderBy('da.day_of_week', 'asc');
  }

  async findOne(id: string) {
    const assignment = await this.knex('daily_assignments').where({ id }).first();
    if (!assignment) throw new NotFoundException('Asignación no encontrada');
    return assignment;
  }

  async update(id: string, data: any) {
    const [assignment] = await this.knex('daily_assignments')
      .where({ id })
      .update(data)
      .returning('*');
    if (!assignment)
      throw new NotFoundException('Asignación no encontrada para actualizar');
    return assignment;
  }

  async remove(id: string) {
    const deleted = await this.knex('daily_assignments').where({ id }).del();
    if (deleted === 0)
      throw new NotFoundException('Asignación no encontrada para eliminar');
    return { success: true };
  }
}
