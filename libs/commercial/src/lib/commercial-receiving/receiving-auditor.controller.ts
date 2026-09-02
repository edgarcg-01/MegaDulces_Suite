import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  ReceivingAuditorService,
  EvaluateDto,
  PolicyDto,
  Verdict,
} from './receiving-auditor.service';

/**
 * Fase WMS-REC (Pieza 2, ADR-044) — Auditor de recepción por caducidad.
 *
 * Captura/OCR/veredicto: `RECIBIR`. Autorizar un rojo / administrar políticas:
 * `SUPERVISAR` (segregación: quien recibe no libera su propia NC).
 */
@ApiTags('commercial-receiving')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/receiving')
export class ReceivingAuditorController {
  constructor(private readonly service: ReceivingAuditorService) {}

  @Post('lot-capture')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'OCR de la foto de lote/caducidad (preview, no persiste)' })
  ocr(@Body() body: { photo_data_uri: string }) {
    return this.service.ocrLabel(body?.photo_data_uri);
  }

  @Get('resolve')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({
    summary:
      'Resolver un código escaneado → producto FECHABLE (con product_id real). Distinto del resolve de conteo, que devuelve product_id null.',
  })
  resolveForDating(@Query('code') code: string) {
    return this.service.resolveForDating(code);
  }

  @Post('evaluate')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({
    summary:
      'Evalúa la captura de caducidad vs inventario existente + política → semáforo. green/yellow escribe stock; red queda pendiente de autorización.',
  })
  evaluate(@Body() body: EvaluateDto) {
    return this.service.evaluate(body);
  }

  @Get('captures')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({
    summary:
      'Capturas de recepción (filtros: warehouse/supplier/verdict/status/from/to + receiving_line_id o session_id para los lotes de un renglón/vale — ADR-044)',
  })
  listCaptures(
    @Query('warehouse_id') warehouseId?: string,
    @Query('supplier_code') supplierCode?: string,
    @Query('verdict') verdict?: Verdict,
    @Query('status') status?: string,
    @Query('receiving_line_id') receivingLineId?: string,
    @Query('session_id') sessionId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listCaptures({
      warehouse_id: warehouseId,
      supplier_code: supplierCode,
      verdict,
      status,
      receiving_line_id: receivingLineId,
      session_id: sessionId,
      from,
      to,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('scorecard')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Scorecard de proveedor: recepciones vs no conformidades de caducidad' })
  scorecard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.service.scorecard({ from, to });
  }

  @Post('captures/:id/authorize')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Autorizar una NC (rojo): libera y escribe el stock' })
  authorize(@Param('id') id: string, @Body() body: { notes?: string }) {
    return this.service.authorize(id, body?.notes);
  }

  @Post('captures/:id/reject')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Rechazar mercancía (rojo): no escribe stock' })
  reject(@Param('id') id: string, @Body() body: { notes?: string }) {
    return this.service.reject(id, body?.notes);
  }

  @Get('policy')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Listar políticas de caducidad en recepción' })
  listPolicies() {
    return this.service.listPolicies();
  }

  @Post('policy')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Crear/actualizar una política de caducidad (por producto/categoría/proveedor)' })
  upsertPolicy(@Body() body: PolicyDto) {
    return this.service.upsertPolicy(body);
  }

  @Delete('policy/:id')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_SUPERVISAR)
  @ApiOperation({ summary: 'Eliminar una política de caducidad' })
  deletePolicy(@Param('id') id: string) {
    return this.service.deletePolicy(id);
  }
}
