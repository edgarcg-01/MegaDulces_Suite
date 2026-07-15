import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { ConciliacionService, ConciliacionFilters } from './conciliacion.service';
import { PolizaCruceService, CruceFilters } from './poliza-cruce.service';

/** FISCAL.5 — API de conciliación: PUE/PPD ↔ REP (5.1) + CFDI ↔ póliza (5.2). */
@ApiTags('fiscal-conciliacion')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/conciliacion')
export class ConciliacionController {
  constructor(
    private readonly svc: ConciliacionService,
    private readonly cruce: PolizaCruceService,
  ) {}

  @Get('stats')
  @RequirePermissions(Permission.FISCAL_CONCILIACION_VER)
  @ApiOperation({ summary: 'Resumen: PPD totales, sin REP, con saldo, saldo total.' })
  stats(@Query() q: ConciliacionFilters) { return this.svc.stats(q); }

  @Get('ppd-sin-rep')
  @RequirePermissions(Permission.FISCAL_CONCILIACION_VER)
  @ApiOperation({ summary: 'Facturas PPD sin ningún complemento de pago (REP).' })
  ppdSinRep(@Query() q: ConciliacionFilters) { return this.svc.ppdSinRep(q); }

  @Get('saldo-insoluto')
  @RequirePermissions(Permission.FISCAL_CONCILIACION_VER)
  @ApiOperation({ summary: 'Facturas PPD con saldo insoluto (pagos parciales).' })
  saldoInsoluto(@Query() q: ConciliacionFilters) { return this.svc.saldoInsoluto(q); }

  @Post('scan')
  @RequirePermissions(Permission.FISCAL_CONCILIACION_VER)
  @Throttle({ long: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Recalcula hallazgos de conciliación del tenant → bandeja de Maat.' })
  scan() { return this.svc.scanCurrent(); }

  // ── FISCAL.5.2 — CFDI ↔ póliza (heurística RFC+importe+fecha) ──────────────
  @Get('cruce/stats')
  @RequirePermissions(Permission.FISCAL_CONCILIACION_VER)
  @ApiOperation({ summary: 'Resumen del cruce CFDI↔póliza: CFDI sin póliza + póliza sin CFDI.' })
  cruceStats(@Query() q: CruceFilters) { return this.cruce.stats(q); }

  @Get('cruce/cfdi-sin-poliza')
  @RequirePermissions(Permission.FISCAL_CONCILIACION_VER)
  @ApiOperation({ summary: 'CFDI recibidos sin póliza que los registre.' })
  cfdiSinPoliza(@Query() q: CruceFilters) { return this.cruce.cfdiSinPoliza(q); }

  @Get('cruce/poliza-sin-cfdi')
  @RequirePermissions(Permission.FISCAL_CONCILIACION_VER)
  @ApiOperation({ summary: 'Gastos registrados sin CFDI (dentro de periodos con descarga).' })
  polizaSinCfdi(@Query() q: CruceFilters) { return this.cruce.polizaSinCfdi(q); }

  @Post('cruce/scan')
  @RequirePermissions(Permission.FISCAL_CONCILIACION_VER)
  @Throttle({ long: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Recalcula hallazgos del cruce CFDI↔póliza → bandeja de Maat.' })
  scanCruce() { return this.cruce.scanCurrent(); }
}
