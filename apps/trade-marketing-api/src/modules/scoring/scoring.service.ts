import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

export interface ScoringCalculateDto {
  posicion: string;
  tipo: string;
  nivel_ejecucion: string;
  photo_url?: string;
}

@Injectable()
export class ScoringService {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  async getConfig() {
    const record = await this.knex('scoring_config')
      .orderBy('updated_at', 'desc')
      .first();
    if (!record) return {};
    return typeof record.config === 'string'
      ? JSON.parse(record.config)
      : record.config;
  }

  async setConfig(configData: Record<string, any>) {
    // Truco Knex para "update si existe o insert si está vacío". Al estar trabajando con gen_random_uuid se asume update directo y luego fallback.
    const records = await this.knex('scoring_config').limit(1);
    if (records.length > 0) {
      const updated = await this.knex('scoring_config')
        .where({ id: records[0].id })
        .update({
          config: JSON.stringify(configData),
          updated_at: this.knex.fn.now(),
        })
        .returning('*');
      return updated[0];
    } else {
      const [inserted] = await this.knex('scoring_config')
        .insert({ config: JSON.stringify(configData) })
        .returning('*');
      return inserted;
    }
  }

  async calculateScore(
    dto: ScoringCalculateDto,
  ): Promise<{ score: number; reason?: string }> {
    // REGLA ABSOLUTA DEL DUEÑO:
    // "No, tiene que subir explícitamente la foto para dar un scoring"
    if (!dto.photo_url || dto.photo_url.trim() === '') {
      return {
        score: 0,
        reason: 'Ausencia de Evidencia Fotográfica anula la puntuación.',
      };
    }

    const config = await this.getConfig();

    const pesoPosicion =
      config.pesos_posicion?.[dto.posicion?.toLowerCase()] ?? 0;
    const factorTipo = config.tipos_exhibicion?.[dto.tipo?.toLowerCase()] ?? 0;
    const multiplicador =
      config.niveles_ejecucion?.[dto.nivel_ejecucion?.toLowerCase()] ?? 0;

    // Ecuación definida en Documentación Técnica: Score = peso_posición × factor_tipo_exhibición × nivel_ejecución
    const scoreVal = pesoPosicion * factorTipo * multiplicador;

    return { score: Number(scoreVal.toFixed(2)) };
  }
}
