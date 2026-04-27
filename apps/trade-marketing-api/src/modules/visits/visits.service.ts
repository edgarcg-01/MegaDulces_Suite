import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

@Injectable()
export class VisitsService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  async checkIn(
    userId: string,
    username: string,
    storeId: string,
    lat: number,
    lng: number,
  ) {
    const store = await this.knex('stores')
      .where({ id: storeId, activo: true })
      .first();
    if (!store)
      throw new NotFoundException(
        'Punto de Venta no existente en base de datos',
      );

    const [visit] = await this.knex('visits')
      .insert({
        store_id: storeId,
        user_id: userId,
        captured_by_username: username,
        checkin_lat: lat,
        checkin_lng: lng,
        status: 'in_progress',
        checkin_at: this.knex.fn.now(),
      })
      .returning('*');

    return visit;
  }

  async checkOut(visitId: string, userId: string) {
    const visit = await this.knex('visits')
      .where({ id: visitId, user_id: userId })
      .first();
    if (!visit)
      throw new NotFoundException('Visita no pertenece a este ejecutivo');
    if (visit.status === 'completed')
      throw new BadRequestException('El Checkout ya había sido disparado');

    // Compilar todas las evaluaciones guardadas en las Exhibitions hijas
    const exhibitions = await this.knex('exhibitions').where({
      visit_id: visitId,
    });

    let totalScoreSum = 0;
    for (const ex of exhibitions) {
      totalScoreSum += Number(ex.score);
    }

    // La documentación no aclara si es suma o promedio, aplicaremos score total acumulado
    // Las reglas genéricas favorecen sumatorias para rankeos a menos que se limite la base (100 pts tope)
    const finalScore =
      exhibitions.length > 0 ? totalScoreSum / exhibitions.length : 0; // Promedio de perfección de toda la tienda 0-100%

    const [closedVisit] = await this.knex('visits')
      .where({ id: visitId })
      .update({
        checkout_at: this.knex.fn.now(),
        total_score: Number(finalScore.toFixed(2)),
        status: 'completed',
      })
      .returning('*');

    // Almacenado transaccional finalizado.
    return closedVisit;
  }

  async findAll(user: any) {
    const query = this.knex('visits').orderBy('checkin_at', 'desc').limit(500);

    if (user.role_name === 'colaborador') {
      query.where('user_id', user.sub);
    } else if (user.role_name === 'supervisor_v') {
      const subquery = this.knex('users')
        .select('id')
        .where('supervisor_id', user.sub)
        .orWhere('id', user.sub);
      query.whereIn('user_id', subquery);
    }

    return query;
  }

  async findOne(id: string) {
    const visit = await this.knex('visits').where({ id }).first();
    if (!visit) throw new NotFoundException();

    // Retornamos la visita con sus estantes y evidencias atadas
    visit.exhibitions = await this.knex('exhibitions').where({ visit_id: id });
    for (const ex of visit.exhibitions) {
      ex.photos = await this.knex('exhibition_photos').where({
        exhibition_id: ex.id,
      });
    }
    return visit;
  }
}
