import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  RequireAuthGuard,
  RolesGuard,
  RequireAnyPermission,
  Permission,
} from '@megadulces/platform-core';
import { LogisticsReportsService } from './logistics-reports.service';

/** `[AUTHZ-HARD.1]` Antes sin gate: PDFs con nombres de chofer, gastos y comisiones abiertos a
 * cualquier autenticado. Gate por la familia logística. */
@ApiTags('logistics-reports')
@Controller('logistics/reports')
@UseGuards(RequireAuthGuard, RolesGuard)
@RequireAnyPermission(
  Permission.LOGISTICS_SHIPMENTS_VER,
  Permission.LOGISTICS_FLEET_VER,
  Permission.LOGISTICS_PAYROLL_VER,
  Permission.LOGISTICS_EXPENSES_VER,
)
export class LogisticsReportsController {
  constructor(private readonly service: LogisticsReportsService) {}

  @Get('shipment/:id/pdf')
  @ApiOperation({ summary: 'PDF resumen del shipment (jspdf)' })
  async shipmentPdf(@Param('id') id: string, @Res() res: Response) {
    const buf = await this.service.shipmentSummaryPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="shipment-${id}.pdf"`,
    );
    res.send(buf);
  }

  @Get('kpi')
  @ApiOperation({ summary: 'KPIs operativos (JSON). Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD' })
  kpi(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.kpiSummary(from, to);
  }

  @Get('kpi/pdf')
  @ApiOperation({ summary: 'KPIs operativos como PDF descargable' })
  async kpiPdf(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Res() res: Response,
  ) {
    const buf = await this.service.kpiSummaryPdf(from, to);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="kpi-logistica.pdf"`,
    );
    res.send(buf);
  }
}
