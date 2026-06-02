import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { MegaDulcesSyncService } from './mega-dulces-sync.service';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';

/**
 * Endpoints admin del sync Mega_Dulces ERP. El cron corre @3am MX automático;
 * estos endpoints son para forzar un run ad-hoc o ver el estado.
 *
 * Gate: COMMERCIAL_ORDERS_FULFILL (mismo nivel que admin tooling — refresh MV,
 * etc). Throttle estricto en run-now (operación cara que toca DB externa).
 */
@ApiTags('mega-dulces-sync')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('admin/mega-dulces-sync')
export class MegaDulcesSyncController {
  constructor(private readonly service: MegaDulcesSyncService) {}

  @Post('run-now')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_FULFILL)
  @Throttle({ short: { limit: 2, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Disparar manualmente el sync Mega_Dulces. Tarda ~2 min. Throttle 2/min anti-DoS.',
  })
  async runNow() {
    return this.service.runManual();
  }

  @Get('status')
  @RequirePermissions(Permission.COMMERCIAL_ORDERS_VER)
  @ApiOperation({ summary: 'Último resumen del sync + flag de in-progress' })
  status() {
    return {
      in_progress: this.service.isInProgress(),
      last_summary: this.service.getLastSummary(),
    };
  }
}
