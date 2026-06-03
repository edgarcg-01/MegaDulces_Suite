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
import {
  CommercialPromotionsService,
  CreatePromotionDto,
  UpdatePromotionDto,
  PromotionType,
} from './commercial-promotions.service';
import { RolesGuard } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';

@ApiTags('commercial-promotions')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/promotions')
export class CommercialPromotionsController {
  constructor(private readonly service: CommercialPromotionsService) {}

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Crear promoción' })
  create(@Body() body: CreatePromotionDto) {
    return this.service.create(body);
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_VER)
  @ApiOperation({
    summary:
      'Listar promociones (paginado + filtros). Admin-only — el listing expone applies_to_customer_ids (qué clientes están en programas custom) y usage_limit/count (info operacional).',
  })
  list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('active') active?: string,
    @Query('promotion_type') promotion_type?: PromotionType,
    @Query('onlyActive') onlyActive?: string,
  ) {
    return this.service.list({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      active: active === undefined ? undefined : active === 'true',
      promotion_type,
      onlyActive: onlyActive === 'true',
    });
  }

  @Get(':id')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_VER)
  @ApiOperation({ summary: 'Obtener promoción por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Actualizar promoción (parcial)' })
  update(@Param('id') id: string, @Body() body: UpdatePromotionDto) {
    return this.service.update(id, body);
  }

  @Patch(':id/active')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Toggle rápido de activo (pausar/reanudar promoción)' })
  setActive(@Param('id') id: string, @Body() body: { active: boolean }) {
    return this.service.setActive(id, body.active === true);
  }

  @Delete(':id')
  @RequirePermissions(Permission.COMMERCIAL_PROMOTIONS_GESTIONAR)
  @ApiOperation({ summary: 'Soft-delete promoción (deleted_at + active=false)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
