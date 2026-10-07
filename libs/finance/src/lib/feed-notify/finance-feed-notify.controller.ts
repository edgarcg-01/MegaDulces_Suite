import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { FinanceFeedScannerService } from './finance-feed-scanner.service';

/**
 * CB (WS) — Disparadores manuales del aviso de feed nuevo (Kepler/ContPAQi).
 * `scan-now` corre el scan de todos los tenants; `test` emite un aviso de prueba
 * al tenant del request. Gestión = FINANCE_BANK_GESTIONAR (mismo gate que el tablero).
 */
@ApiTags('finance-feed-notify')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/feed-notify')
export class FinanceFeedNotifyController {
  constructor(private readonly scanner: FinanceFeedScannerService) {}

  @Post('scan-now')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Corre el scan de crecimiento de feeds ahora (todos los tenants).' })
  scanNow() { return this.scanner.scanAll('manual'); }

  @Post('test')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Emite un aviso finance_feed de prueba al tenant del request.' })
  test() { return this.scanner.emitTest(); }
}
