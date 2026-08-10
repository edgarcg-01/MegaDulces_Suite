import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  CommercialExpiryReviewsService,
  CreateReviewDto,
  ReviewLineDto,
} from './commercial-expiry-reviews.service';

/**
 * Fase P2.6 — Control de Caducidades. Lectura gateada por COMMERCIAL_EXPIRY_VER,
 * escritura/submit por COMMERCIAL_EXPIRY_CAPTURAR (permisos dedicados, ADR-022).
 */
@ApiTags('commercial-expiry-reviews')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/expiry-reviews')
export class CommercialExpiryReviewsController {
  constructor(private readonly service: CommercialExpiryReviewsService) {}

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_VER)
  @ApiOperation({ summary: 'Listar hojas de Control de Caducidades (paginado, filtros)' })
  list(
    @Query('warehouse_id') warehouseId?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.listReviews({
      warehouse_id: warehouseId,
      status,
      from,
      to,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_VER)
  @ApiOperation({ summary: 'Detalle de una hoja (encabezado + renglones)' })
  get(@Param('id') id: string) {
    return this.service.getReview(id);
  }

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Crear hoja (draft)' })
  create(@Body() body: CreateReviewDto) {
    return this.service.createReview(body);
  }

  @Post('upload')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Subir foto de evidencia (base64 → Cloudinary). Devuelve {url,public_id,kind}.' })
  upload(@Body() body: { file_base64?: string; role?: string }) {
    return this.service.uploadFile(body?.file_base64 || '', body?.role || 'evidencia');
  }

  @Post(':id/lines')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Agregar renglón a la hoja' })
  addLine(@Param('id') id: string, @Body() body: ReviewLineDto) {
    return this.service.addLine(id, body);
  }

  @Patch('lines/:lineId')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Editar un renglón' })
  updateLine(@Param('lineId') lineId: string, @Body() body: ReviewLineDto) {
    return this.service.updateLine(lineId, body);
  }

  @Delete('lines/:lineId')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Borrar un renglón' })
  deleteLine(@Param('lineId') lineId: string) {
    return this.service.deleteLine(lineId);
  }

  @Post(':id/submit')
  @RequirePermissions(Permission.COMMERCIAL_EXPIRY_CAPTURAR)
  @ApiOperation({ summary: 'Enviar la hoja: marca submitted y alimenta FEFO (lotes fechados en stock_lots)' })
  submit(@Param('id') id: string) {
    return this.service.submitReview(id);
  }
}
