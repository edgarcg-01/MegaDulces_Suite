import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '@megadulces/platform-core';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { UpdateAssignmentDto } from './dto/update-assignment.dto';
import { getDataScope } from '@megadulces/platform-core';

interface RequesterContext {
  sub: string;
  rules?: unknown[];
}

@Injectable()
export class DailyAssignmentsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  /**
   * Verifica que el target sea asignable por el requester:
   *  - sí mismo, o
   *  - miembro de su equipo, o
   *  - cualquiera, si tiene scope global (reports_global)
   *
   * Devuelve la fila del usuario para evitar un segundo SELECT.
   */
  private async assertCanAssignTo(
    targetUserId: string,
    requester: RequesterContext,
  ): Promise<{ id: string; zona_id: string | null; supervisor_id: string | null }> {
    const target = await this.knex('users')
      .where({ id: targetUserId })
      .select('id', 'zona_id', 'supervisor_id')
      .first();
    if (!target) throw new NotFoundException('Usuario no encontrado');

    if (target.id === requester.sub) return target;

    const scope = getDataScope({ sub: requester.sub, rules: requester.rules as never });
    if (scope.type === 'all') return target;
    if (target.supervisor_id === requester.sub) return target;

    throw new ForbiddenException(
      'Solo puedes asignar rutas a miembros de tu equipo.',
    );
  }

  /**
   * Valida que la ruta exista, esté activa, y pertenezca a la zona del usuario
   * asignado. Esto evita que se asignen rutas de zonas ajenas.
   */
  private async assertRouteValidForUser(
    routeId: string,
    userZonaId: string | null,
  ): Promise<void> {
    const route = await this.knex('catalogs')
      .where({ id: routeId, catalog_id: 'rutas' })
      .select('id', 'parent_id', 'deleted_at')
      .first();
    if (!route) throw new NotFoundException('Ruta no encontrada');
    if (route.deleted_at !== null) {
      throw new BadRequestException('La ruta seleccionada está inactiva');
    }
    if (userZonaId && route.parent_id && route.parent_id !== userZonaId) {
      throw new BadRequestException(
        'La ruta no pertenece a la zona del colaborador.',
      );
    }
  }

  async create(data: CreateAssignmentDto, requester: RequesterContext) {
    const target = await this.assertCanAssignTo(data.user_id, requester);
    await this.assertRouteValidForUser(data.route_id, target.zona_id);

    // El UNIQUE en DB es (tenant_id, user_id, day_of_week). Postgres exige
    // que el ON CONFLICT matchee exactamente las columnas del índice unique;
    // antes pasábamos solo (user_id, day_of_week) y el INSERT fallaba con
    // "no unique or exclusion constraint matching" → frontend recibía 500
    // "No se pudo guardar la asignación".
    const [assignment] = await this.knex('daily_assignments')
      .insert({
        user_id: data.user_id,
        route_id: data.route_id,
        assigned_by: requester.sub,
        day_of_week: data.day_of_week,
        status: data.status || 'pendiente',
      })
      .onConflict(['tenant_id', 'user_id', 'day_of_week'])
      .merge({
        route_id: data.route_id,
        status: data.status || 'pendiente',
        updated_by: requester.sub,
        updated_at: this.knex.fn.now(),
      })
      .returning('*');
    return assignment;
  }

  /**
   * Lista asignaciones respetando el scope del requester:
   *  - global: ve todo
   *  - team (supervisor): solo su equipo (+sí mismo)
   *  - own: solo las propias
   */
  async findAll(
    filters: {
      supervisor_id?: string;
      user_id?: string;
      day_of_week?: number;
    },
    requester: RequesterContext,
  ) {
    const scope = getDataScope({
      sub: requester.sub,
      rules: requester.rules as never,
    });

    const query = this.knex('daily_assignments as da')
      .join('users as u', 'da.user_id', 'u.id')
      .leftJoin('zones as z', 'u.zona_id', 'z.id')
      .join('catalogs as c', 'da.route_id', 'c.id')
      .where('c.catalog_id', 'rutas')
      .select(
        'da.*',
        'u.nombre as user_nombre',
        'z.name as user_zona',
        'c.value as route_name',
      );

    if (scope.type === 'team') {
      query.where((qb) => {
        qb.where('u.supervisor_id', requester.sub).orWhere(
          'u.id',
          requester.sub,
        );
      });
    } else if (scope.type === 'own') {
      query.where('u.id', requester.sub);
    }

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

  async findOne(id: string, requester: RequesterContext) {
    const assignment = await this.knex('daily_assignments')
      .where({ id })
      .first();
    if (!assignment) throw new NotFoundException('Asignación no encontrada');
    await this.assertCanAssignTo(assignment.user_id, requester);
    return assignment;
  }

  async update(
    id: string,
    dto: UpdateAssignmentDto,
    requester: RequesterContext,
  ) {
    const existing = await this.knex('daily_assignments')
      .where({ id })
      .first();
    if (!existing) {
      throw new NotFoundException('Asignación no encontrada para actualizar');
    }

    const target = await this.assertCanAssignTo(existing.user_id, requester);

    if (dto.route_id) {
      await this.assertRouteValidForUser(dto.route_id, target.zona_id);
    }

    const [assignment] = await this.knex('daily_assignments')
      .where({ id })
      .update({
        ...dto,
        updated_by: requester.sub,
        updated_at: this.knex.fn.now(),
      })
      .returning('*');
    return assignment;
  }

  async remove(id: string, requester: RequesterContext) {
    const existing = await this.knex('daily_assignments')
      .where({ id })
      .first();
    if (!existing) {
      throw new NotFoundException('Asignación no encontrada para eliminar');
    }
    await this.assertCanAssignTo(existing.user_id, requester);

    await this.knex('daily_assignments').where({ id }).del();
    return { success: true };
  }
}
