import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { ScoringService } from '../scoring/scoring.service';

@Injectable()
export class ExhibitionsService {
  constructor(
    @Inject(KNEX_CONNECTION) private readonly knex: Knex,
    private readonly scoringService: ScoringService
  ) {}

  async create(data: { visit_id: string; posicion: string; tipo: string; nivel_ejecucion: string; notas?: string }) {
    // Al crearse, carece de foto, forzando un Score temporal de 0.
    const [ex] = await this.knex('exhibitions')
      .insert({
        visit_id: data.visit_id,
        posicion: data.posicion,
        tipo: data.tipo,
        nivel_ejecucion: data.nivel_ejecucion,
        notas: data.notas,
        score: 0
      })
      .returning('*');
    return ex;
  }

  async uploadPhoto(exhibitionId: string, photoUrl: string) {
    const ex = await this.knex('exhibitions').where({ id: exhibitionId }).first();
    if (!ex) throw new NotFoundException('Exhibición invalida para atar evidencia fotográfica');

    // 1. Guardar metadatos fotográficos 
    const [photoData] = await this.knex('exhibition_photos')
      .insert({ exhibition_id: exhibitionId, photo_url: photoUrl })
      .returning('*');

    // 2. DISPARADOR DE NEGOCIO AL TENER FOTO (Reglas Fase 2)
    const scoreResult = await this.scoringService.calculateScore({
      posicion: ex.posicion,
      tipo: ex.tipo,
      nivel_ejecucion: ex.nivel_ejecucion,
      photo_url: photoUrl
    });

    // 3. Persistir en la Exhibición hija para promediar en CheckOut de Fase 4
    await this.knex('exhibitions')
      .where({ id: exhibitionId })
      .update({ score: scoreResult.score });

    return photoData;
  }
}
