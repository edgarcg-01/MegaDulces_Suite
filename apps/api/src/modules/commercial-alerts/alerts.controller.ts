import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';
import { AlertsGateway } from './alerts.gateway';
import { AlertsScannerService } from './alerts-scanner.service';
import { TenantContextService } from '../../shared/tenant/tenant-context.service';

@ApiTags('commercial-alerts')
@Controller('commercial/alerts')
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly gateway: AlertsGateway,
    private readonly scanner: AlertsScannerService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  @Post('test')
  @ApiOperation({ summary: 'Emite una alerta de prueba al tenant del JWT (smoke testing)' })
  test(@Body() body?: { message?: string }) {
    const tenantId = this.tenantCtx.requireTenantId();
    this.alerts.emitTest(tenantId, body?.message);
    return { emitted: true, tenant_id: tenantId };
  }

  @Post('scan-now')
  @ApiOperation({
    summary:
      'Dispara el scanner cron manualmente (admin only — escanea TODOS los tenants)',
  })
  async scanNow() {
    this.scanner.resetCooldown();
    const result = await this.scanner.scanAllTenants();
    return result;
  }

  @Get('stats')
  @ApiOperation({ summary: 'Métricas del gateway: sockets conectados por tenant' })
  stats() {
    return this.gateway.getStats();
  }
}
