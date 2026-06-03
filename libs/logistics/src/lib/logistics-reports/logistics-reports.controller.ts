import {
  Controller,
  Get,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Response } from 'express';
import { LogisticsReportsService } from './logistics-reports.service';

@ApiTags('logistics-reports')
@Controller('logistics/reports')
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
