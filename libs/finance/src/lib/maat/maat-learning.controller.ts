import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { MaatLearningService } from './maat-learning.service';
import { MaatEvalService } from './maat-eval.service';

/**
 * MAAT-IQ · MIQ.2/6 — El modelo que aprende. Entrena desde el feedback humano
 * (confirmar/descartar), scorea la bandeja, expone la cola de active-learning y
 * el backtest que demuestra la mejora. Lectura = FINANCE_AI_CHAT; escritura
 * (entrenar/scorear) = FINANCE_FINDINGS_GESTIONAR.
 */
@ApiTags('finance-maat')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/maat/learning')
export class MaatLearningController {
  constructor(
    private readonly learning: MaatLearningService,
    private readonly evalSvc: MaatEvalService,
  ) {}

  @Get('status')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MIQ.2 — Estado del modelo vigente (versión, métricas, feature importance) + tamaño del dataset etiquetado.' })
  status() { return this.learning.status(); }

  @Get('uncertain')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MIQ.2 — Active learning: hallazgos donde el modelo está más inseguro. Etiquetar estos rinde más señal por clic.' })
  uncertain(@Query('limit') limit?: string) { return this.learning.uncertain(limit ? Number(limit) : undefined); }

  @Get('backtest')
  @RequirePermissions(Permission.FINANCE_AI_CHAT)
  @ApiOperation({ summary: 'MIQ.6 — Backtest time-split: AUC/precisión/recall del modelo vs el score del detector (lift). Demuestra que aprende.' })
  backtest() { return this.evalSvc.backtest(); }

  @Post('train')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @Throttle({ long: { limit: 4, ttl: 60_000 } })
  @ApiOperation({ summary: 'MIQ.2 — Reconstruye el feature store y entrena una versión nueva del modelo desde el feedback.' })
  async train() {
    const features = await this.learning.syncFeatures();
    const train = await this.learning.train();
    return { features, train };
  }

  @Post('score')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @Throttle({ long: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'MIQ.2 — Scorea (prioriza) los hallazgos abiertos con el modelo vigente.' })
  score() { return this.learning.score(); }

  @Post('run')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @Throttle({ long: { limit: 2, ttl: 60_000 } })
  @ApiOperation({ summary: 'MIQ.2 — Ciclo completo: syncFeatures → train → score (lo mismo que corre el cron nocturno).' })
  run() { return this.learning.runLearning(); }
}
