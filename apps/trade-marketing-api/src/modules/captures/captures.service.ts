import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { CreateCaptureDto } from './dto/create-capture.dto';

@Injectable()
export class CapturesService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  private async generateFolio(): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');

    // Contamos cuántas capturas hay en la bbdd de hoy.
    const result = await this.knex('captures')
      .count('id as count')
      .whereRaw('DATE(fecha_captura) = CURRENT_DATE');

    const count = parseInt(String(result[0].count), 10);
    const seq = String(count + 1).padStart(4, '0');
    return `TM-${dateStr}-${seq}`;
  }

  async create(
    createCaptureDto: CreateCaptureDto,
    userId: string,
    username: string,
    zona: string,
  ) {
    const folio = await this.generateFolio();

    const [capture] = await this.knex('captures')
      .insert({
        folio,
        user_id: userId,
        captured_by_username: username,
        zona_captura: zona,
        kpis_data: JSON.stringify(createCaptureDto.kpis_data),
      })
      .returning([
        'id',
        'folio',
        'user_id',
        'zona_captura',
        'fecha_captura',
        'kpis_data',
      ]);

    return capture;
  }

  async findAll(
    zona?: string,
    ejecutivo?: string,
    fecha_inicio?: string,
    fecha_fin?: string,
  ) {
    const query = this.knex('captures').select('*');
    if (zona) query.where({ zona_captura: zona });
    if (ejecutivo) query.where({ captured_by_username: ejecutivo });
    if (fecha_inicio) query.where('fecha_captura', '>=', fecha_inicio);
    if (fecha_fin) query.where('fecha_captura', '<=', fecha_fin);

    return query;
  }

  async findOne(id: string) {
    const capture = await this.knex('captures').where({ id }).first();
    if (!capture) {
      throw new NotFoundException(`Captura con ID ${id} no encontrada`);
    }
    return capture;
  }

  async remove(id: string) {
    const count = await this.knex('captures').where({ id }).del();
    if (count === 0) {
      throw new NotFoundException(`Captura con ID ${id} no encontrada`);
    }
    return { message: 'La captura ha sido eliminada exitosamente' };
  }
}
