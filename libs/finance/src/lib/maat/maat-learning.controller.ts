import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission, SkipTenantTx } from '@megadulces/platform-core';
import { MaatLearningService } from './maat-learning.service';
import { MaatEvalService } from './maat-eval.service';
import { FinanceJobsService } from '../jobs/finance-jobs.service';

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/** `?sync=true` (o `sync: true` en el body) fuerza el camino inline: CLI y smokes. */
function wantsInline(q?: string, b?: boolean): boolean {
  return b === true || q === 'true' || q === '1';
}

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
    private readonly jobs: FinanceJobsService,
  ) {}

  /**
   * COMM.7 — Delega a background (202 + WS `finance_job`). Estos tres endpoints
   * recorren TODOS los hallazgos (un upsert de features por hallazgo + dos UPDATE
   * por hallazgo abierto, sin límite) dentro de una sola transacción: es el mismo
   * perfil que el scan de detectores, que ya estaba delegado.
   */
  private delegate<T>(res: Response, name: string, label: string, actor: string | undefined, exec: () => Promise<T>) {
    res.status(202);
    return this.jobs.run({ name, label, actor: actor ?? null, exec });
  }

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
  @SkipTenantTx()
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'MIQ.2 — Reconstruye el feature store y entrena una versión nueva del modelo desde el feedback. Async: 202 + job_id, resultado por WS `finance_job`.' })
  train(
    @Body() body: { sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const actor = req?.user?.full_name || req?.user?.username;
    if (wantsInline(sync, body?.sync)) return this.trainInline();
    return this.delegate(res, 'maat-learning-train', 'Entrenar el modelo', actor, () => this.trainInline());
  }

  private async trainInline() {
    const features = await this.learning.syncFeatures();
    const train = await this.learning.train();
    return { features, train };
  }

  @Post('score')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @Throttle({ long: { limit: 6, ttl: 60_000 } })
  @SkipTenantTx()
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'MIQ.2 — Scorea (prioriza) los hallazgos abiertos con el modelo vigente. Async: 202 + job_id.' })
  score(
    @Body() body: { sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (wantsInline(sync, body?.sync)) return this.learning.score();
    const actor = req?.user?.full_name || req?.user?.username;
    return this.delegate(res, 'maat-learning-score', 'Priorizar hallazgos', actor, () => this.learning.score());
  }

  @Post('run')
  @RequirePermissions(Permission.FINANCE_FINDINGS_GESTIONAR)
  @Throttle({ long: { limit: 2, ttl: 60_000 } })
  @SkipTenantTx()
  @ApiQuery({ name: 'sync', required: false, description: 'true = corre inline y devuelve el resultado (CLI/smokes).' })
  @ApiOperation({ summary: 'MIQ.2 — Ciclo completo: syncFeatures → train → score (lo mismo que corre el cron nocturno). Async: 202 + job_id — es el más largo de los tres.' })
  run(
    @Body() body: { sync?: boolean },
    @Query('sync') sync: string,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (wantsInline(sync, body?.sync)) return this.learning.runLearning();
    const actor = req?.user?.full_name || req?.user?.username;
    return this.delegate(res, 'maat-learning-run', 'Entrenar y priorizar', actor, () => this.learning.runLearning());
  }
}
