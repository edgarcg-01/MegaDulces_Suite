import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireAuthGuard } from '../guards/require-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { RequirePermissions } from '../decorators/permissions.decorator';
import { Permission } from '../constants/permissions';
import { AiProductMatcherService } from './ai-product-matcher.service';
import { EmbeddingSyncService } from './embedding-sync.service';
import { MatchAiDto } from './dto/match-ai.dto';

@ApiTags('ai-product-matcher')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
@Controller('ai/products')
export class AiProductMatcherController {
  constructor(
    private readonly service: AiProductMatcherService,
    private readonly sync: EmbeddingSyncService,
  ) {}

  /**
   * Identifica semánticamente productos del catálogo a partir de una lista
   * en texto libre. Usado por el wizard de captures paso 5.
   *
   * Rate limit dedicado: 10 req/min en el tier `long` (override del 200/min
   * global). Evita que alguien pegue un libro y vacíe la cuenta de Voyage.
   * Los tiers `short` (10/seg) y `medium` (60/10seg) globales siguen
   * aplicando — el primero que se viole gana.
   *
   * IMPORTANTE: la key debe coincidir con un tier de `ThrottlerModule.forRoot`
   * en app.module.ts. La app tiene short/medium/long; un `default` aquí no
   * se aplica porque el tier no existe.
   */
  @Post('match-ai')
  @HttpCode(200)
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @Throttle({ long: { ttl: 60_000, limit: 10 } })
  @ApiOperation({
    summary:
      'Identifica productos del catálogo TM desde una lista de texto libre (AI: Claude Haiku 4.5 → Voyage voyage-3 → pgvector KNN)',
  })
  @ApiResponse({ status: 200, description: 'Lista de items con matches sugeridos + alternativas.' })
  @ApiResponse({ status: 400, description: 'rawText vacío o supera limites.' })
  @ApiResponse({ status: 429, description: 'Throttled (10 req/min por user).' })
  async matchAi(@Body() dto: MatchAiDto) {
    return this.service.match(dto.rawText);
  }

  /**
   * Fuerza una iteración del scanner de sincronización (procesa hasta 50
   * embeddings stale en un batch). Útil para no esperar al próximo tick del
   * cron (cada 15 min) o cuando hay una sincronización Docker↔.245 con
   * muchos products pendientes.
   *
   * Requiere permiso de gestión de planogramas (admin-level).
   */
  @Post('sync-now')
  @HttpCode(200)
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({
    summary: 'Fuerza un tick del scanner de sincronización (re-embed manual de hasta tickBatch stale)',
  })
  @ApiResponse({ status: 200, description: '{ processed, failed, pending }' })
  async syncNow() {
    return this.sync.syncBatch();
  }

  /** Re-embed manual del corpus ACTIVO ERP (inventory.products_active, ticket vendedor). */
  @Post('sync-active-now')
  @HttpCode(200)
  @RequirePermissions(Permission.PLANOGRAMAS_GESTIONAR)
  @ApiOperation({
    summary: 'Fuerza re-embed del corpus activo ERP (active_product_embeddings, hasta tickBatch stale)',
  })
  @ApiResponse({ status: 200, description: '{ processed, failed, deleted, pending }' })
  async syncActiveNow() {
    return this.sync.syncActiveBatch();
  }
}
