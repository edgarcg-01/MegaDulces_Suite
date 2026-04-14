import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';

export interface ScoringV2CalculateDto {
  posicion_id: string;
  exhibicion_id: string;
  nivel_ejecucion_id: string;
  config_version_id: string;
}

export interface ScoringV2VisitDto {
  exhibiciones: ScoringV2CalculateDto[];
  exhibiciones_esperadas: number;
  config_version_id: string;
}

@Injectable()
export class ScoringV2Service {
  constructor(@Inject(KNEX_CONNECTION) private readonly knex: Knex) {}

  /**
   * Obtiene la versión de configuración vigente
   */
  async getActiveVersion() {
    const version = await this.knex('scoring_config_versions')
      .whereNull('fecha_fin')
      .orderBy('fecha_inicio', 'desc')
      .first();
    return version;
  }

  /**
   * Recalcula el score_maximo para una versión específica
   * Se debe llamar cuando cambian los valores del catálogo
   */
  async recalcularScoreMaximo(configVersionId: string) {
    const pesos = await this.knex('scoring_pesos')
      .where({ config_version_id: configVersionId })
      .select('*');
    
    const posicionValues = pesos
      .filter(p => p.tipo === 'posicion')
      .map(p => Number(p.valor));
    const exhibicionValues = pesos
      .filter(p => p.tipo === 'exhibicion')
      .map(p => Number(p.valor));
    const ejecucionValues = pesos
      .filter(p => p.tipo === 'ejecucion')
      .map(p => Number(p.valor));
    
    const maxPosicion = posicionValues.length > 0 ? Math.max(...posicionValues) : 0;
    const maxExhibicion = exhibicionValues.length > 0 ? Math.max(...exhibicionValues) : 0;
    const maxEjecucion = ejecucionValues.length > 0 ? Math.max(...ejecucionValues) : 0;
    
    const scoreMaximo = maxPosicion * maxExhibicion * maxEjecucion;
    
    // Actualizar la versión con el nuevo score_maximo
    await this.knex('scoring_config_versions')
      .where({ id: configVersionId })
      .orWhere({ version: configVersionId })
      .update({
        score_maximo: scoreMaximo,
        score_maximo_calculado_at: this.knex.fn.now()
      });
    
    return scoreMaximo;
  }

  /**
   * Obtiene los pesos de una versión de configuración
   */
  async getPesosByVersion(configVersionId: string) {
    const pesos = await this.knex('scoring_pesos')
      .where({ config_version_id: configVersionId })
      .select('*');
    
    // Agrupar por tipo
    const result = {
      posicion: {},
      exhibicion: {},
      ejecucion: {}
    };

    pesos.forEach(p => {
      result[p.tipo][p.nombre] = Number(p.valor);
    });

    return result;
  }

  /**
   * Calcula el score de una exhibición individual
   * Fórmula: peso_posicion × factor_exhibicion × nivel_ejecucion
   */
  async calculateExhibicionScore(dto: ScoringV2CalculateDto) {
    const pesos = await this.getPesosByVersion(dto.config_version_id);
    
    // Obtener valores de los catálogos
    const posicion = await this.knex('catalogs')
      .where({ id: dto.posicion_id })
      .first();
    
    const exhibicion = await this.knex('catalogs')
      .where({ id: dto.exhibicion_id })
      .first();
    
    const nivel = await this.knex('catalogs')
      .where({ id: dto.nivel_ejecucion_id })
      .first();

    if (!posicion || !exhibicion || !nivel) {
      throw new BadRequestException('Uno o más elementos del catálogo no existen');
    }

    // Validar combinación válida
    const combinacionValida = await this.knex('combinaciones_validas')
      .where({
        config_version_id: dto.config_version_id,
        posicion_id: dto.posicion_id,
        exhibicion_id: dto.exhibicion_id,
        activo: true
      })
      .first();

    if (!combinacionValida) {
      // Si no hay combinación explícita, permitir por defecto (puede cambiarse)
      console.warn(`Combinación no validada: ${posicion.value} × ${exhibicion.value}`);
    }

    // Calcular score
    const pesoPosicion = Number(posicion.puntuacion) || 0;
    const factorExhibicion = Number(exhibicion.puntuacion) || 0;
    const multiplicadorNivel = Number(nivel.puntuacion) || 1;

    const score = pesoPosicion * factorExhibicion * multiplicadorNivel;

    return {
      score: Number(score.toFixed(2)),
      pesoPosicion,
      factorExhibicion,
      multiplicadorNivel
    };
  }

  /**
   * Obtiene el score máximo posible por exhibición
   * Usa el valor guardado en scoring_config_versions
   */
  async getMaxScorePerExhibicion(configVersionId: string) {
    const version = await this.knex('scoring_config_versions')
      .where({ id: configVersionId })
      .orWhere({ version: configVersionId })
      .first();
    
    if (version && version.score_maximo) {
      return Number(version.score_maximo);
    }
    
    // Si no existe score_maximo, recalcularlo
    return await this.recalcularScoreMaximo(configVersionId);
  }

  /**
   * Calcula los scores de una visita completa
   * Fórmula objetivo:
   * - score_obtenido = Σ score_exhibicion
   * - score_maximo_visita = max_por_exhibicion × n_exhibiciones
   * - score_calidad = (score_obtenido / score_maximo_visita) × 100
   * - score_cobertura = (exhibiciones_reales / exhibiciones_esperadas) × 100 (tope 100%)
   * - score_final = score_calidad × score_cobertura
   */
  async calculateVisitScore(dto: ScoringV2VisitDto) {
    // Calcular score de cada exhibición
    const exhibicionesScores = await Promise.all(
      dto.exhibiciones.map(ex => this.calculateExhibicionScore(ex))
    );

    const scoreObtenido = exhibicionesScores.reduce((sum, ex) => sum + ex.score, 0);
    const nExhibiciones = dto.exhibiciones.length;

    // Calcular score máximo por exhibición
    const maxPorExhibicion = await this.getMaxScorePerExhibicion(dto.config_version_id);
    
    // Calcular score máximo de la visita
    const scoreMaximoVisita = maxPorExhibicion * nExhibiciones;

    // Calcular score de calidad
    const scoreCalidad = scoreMaximoVisita > 0 
      ? (scoreObtenido / scoreMaximoVisita) * 100 
      : 0;

    // Calcular score de cobertura con tope de 100%
    let scoreCobertura = dto.exhibiciones_esperadas > 0
      ? (nExhibiciones / dto.exhibiciones_esperadas) * 100
      : 100; // Si exhibiciones_esperadas = 0, asumir 100%

    if (scoreCobertura > 100) {
      scoreCobertura = 100; // Tope de 100%
    }

    // Calcular score final
    const scoreFinal = scoreCalidad * scoreCobertura;

    return {
      score_obtenido: Number(scoreObtenido.toFixed(2)),
      score_maximo: Number(scoreMaximoVisita.toFixed(2)),
      score_calidad_pct: Number(scoreCalidad.toFixed(2)),
      score_cobertura_pct: Number(scoreCobertura.toFixed(2)),
      score_final_pct: Number(scoreFinal.toFixed(2)),
      exhibiciones_scores: exhibicionesScores
    };
  }

  /**
   * Valida si una combinación posición × exhibición es válida
   */
  async validarCombinacion(configVersionId: string, posicionId: string, exhibicionId: string) {
    const combinacion = await this.knex('combinaciones_validas')
      .where({
        config_version_id: configVersionId,
        posicion_id: posicionId,
        exhibicion_id: exhibicionId,
        activo: true
      })
      .first();

    return !!combinacion;
  }
}
