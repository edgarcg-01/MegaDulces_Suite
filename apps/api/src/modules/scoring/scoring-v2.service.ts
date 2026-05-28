import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_CONNECTION } from '../../shared/database/database.module';
import { calcularPuntosExhibicion } from '@megadulces/shared-scoring';

export interface ScoringV2CalculateDto {
  posicion_id: string;
  exhibicion_id: string;
  nivel_ejecucion_id: string;
  config_version_id: string;
}

export interface ScoringV2VisitDto {
  exhibiciones: ScoringV2CalculateDto[];
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
    const pesos = await this.knex('scoring_weights')
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
    const pesos = await this.knex('scoring_weights')
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
   * CAPA 1: Calcula el score de una exhibición individual de forma síncrona
   * Puntos = puntuacion_base * factor_posicion * factor_nivel * factor_evidencia
   */
  private calcularScoreExhibicionSync(
    dto: ScoringV2CalculateDto,
    pesos: Record<string, Record<string, number>>,
    catalogMap: Map<string, string>
  ) {
    const nombrePosicion = catalogMap.get(dto.posicion_id);
    const nombreExhibicion = catalogMap.get(dto.exhibicion_id);
    const nombreNivel = catalogMap.get(dto.nivel_ejecucion_id);

    if (!nombrePosicion) {
      throw new BadRequestException(`Posición no encontrada en catálogo: id=${dto.posicion_id}`);
    }
    if (!nombreExhibicion) {
      throw new BadRequestException(`Exhibición no encontrada en catálogo: id=${dto.exhibicion_id}`);
    }
    if (!nombreNivel) {
      throw new BadRequestException(`Nivel de ejecución no encontrado en catálogo: id=${dto.nivel_ejecucion_id}`);
    }

    // Obtener parámetros desde la configuración versionada
    const factorPosicion = pesos.posicion[nombrePosicion] ? Number(pesos.posicion[nombrePosicion]) : 0;
    const nivelRaw = pesos.ejecucion[nombreNivel] ? Number(pesos.ejecucion[nombreNivel]) : 0;
    const puntuacionBase = pesos.exhibicion[nombreExhibicion] ? Number(pesos.exhibicion[nombreExhibicion]) : 0;

    if (nivelRaw > 1) {
      console.warn(`[ScoringV2] Factor nivel "${nombreNivel}" > 1: ${nivelRaw}. Revisar scoring_weights.`);
    }

    // Fórmula canónica compartida con el frontend
    const puntos = calcularPuntosExhibicion({
      posicionPuntuacion: factorPosicion,
      conceptoPuntuacion: puntuacionBase,
      nivelPuntuacion: nivelRaw,
    });
    const factorNivel = Math.min(nivelRaw, 1);

    return {
      puntos: Number(puntos.toFixed(2)),
      puntuacionBase,
      factorPosicion,
      factorNivel,
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
   * CAPA 2: Calcula los PUNTOS totales acumulados de una visita.
   * La visita ya no devuelve porcentaje. Solo devuelve la suma de capas 1.
   */
  async calculateVisitScore(dto: ScoringV2VisitDto) {
    // 1. Una sola carga de pesos para toda la visita
    const pesos = await this.getPesosByVersion(dto.config_version_id);

    // 2. Batch N+1 de IDs de catálogo — filtrar undefined/null
    const allCatalogIds = [
      ...dto.exhibiciones.map(e => e.posicion_id),
      ...dto.exhibiciones.map(e => e.exhibicion_id),
      ...dto.exhibiciones.map(e => e.nivel_ejecucion_id),
    ].filter(Boolean); // Eliminar undefined/null

    if (allCatalogIds.length === 0) {
      throw new BadRequestException('No hay IDs de catálogo válidos para calcular el score');
    }

    const catalogRows = await this.knex('catalogs')
      .whereIn('id', [...new Set(allCatalogIds)])
      .select('id', 'value');

    const catalogMap = new Map(catalogRows.map(r => [r.id, r.value]));

    // Verificar que todos los IDs fueron resueltos
    const missingIds = [...new Set(allCatalogIds)].filter(id => !catalogMap.has(id));
    if (missingIds.length > 0) {
      console.warn(`[ScoringV2] IDs de catálogo no encontrados: ${missingIds.join(', ')}`);
    }

    // 3. Evaluar exhibiciones pasivas a memoria local
    const exhibicionesScores = dto.exhibiciones.map(ex => 
      this.calcularScoreExhibicionSync(ex, pesos as any, catalogMap)
    );

    const puntosTotales = exhibicionesScores.reduce((sum, ex) => sum + ex.puntos, 0);

    return {
      puntos_obtenidos: Number(puntosTotales.toFixed(2)),
      exhibiciones_scores: exhibicionesScores
    };
  }

  /**
   * CAPA 3: Score del Colaborador
   * Suma de todos sus puntos históricos vs su meta personal
   */
  async calculateColaboradorScore(userId: string) {
    const user = await this.knex('users').where({ id: userId }).first();
    const metaPuntos = user?.meta_puntos || 5000;

    const captures = await this.knex('daily_captures').where({ user_id: userId });
    let totalPuntos = 0;
    
    for (const cap of captures) {
       const stats = typeof cap.stats === 'string' ? JSON.parse(cap.stats) : cap.stats;
       if (stats && typeof stats.puntuacionTotal === 'number') {
          totalPuntos += stats.puntuacionTotal;
       }
    }

    return {
      user_id: userId,
      meta_puntos: metaPuntos,
      puntos_acumulados: totalPuntos
    };
  }

  /**
   * Valida si una combinación posición × exhibición es válida.
   * `combinaciones_validas` no existe en el schema multi-tenant — el método
   * mantiene la firma para no romper imports, pero ahora siempre permite
   * (return true) salvo que la tabla exista (rollback path).
   */
  async validarCombinacion(configVersionId: string, posicionId: string, exhibicionId: string) {
    try {
      const combinacion = await this.knex('combinaciones_validas')
        .where({
          config_version_id: configVersionId,
          posicion_id: posicionId,
          exhibicion_id: exhibicionId,
          activo: true
        })
        .first();

      return !!combinacion;
    } catch (err: any) {
      if (err?.code === '42P01') return true;
      throw err;
    }
  }
}
