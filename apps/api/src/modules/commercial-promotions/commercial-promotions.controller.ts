import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  CommercialPromotionsService,
  CreatePromotionDto,
  UpdatePromotionDto,
  PromotionType,
} from './commercial-promotions.service';

@ApiTags('commercial-promotions')
@Controller('commercial/promotions')
export class CommercialPromotionsController {
  constructor(private readonly service: CommercialPromotionsService) {}

  @Post()
  @ApiOperation({ summary: 'Crear promoción' })
  create(@Body() body: CreatePromotionDto) {
    return this.service.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'Listar promociones (paginado + filtros)' })
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
  @ApiOperation({ summary: 'Obtener promoción por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar promoción (parcial)' })
  update(@Param('id') id: string, @Body() body: UpdatePromotionDto) {
    return this.service.update(id, body);
  }

  @Patch(':id/active')
  @ApiOperation({ summary: 'Toggle rápido de activo (pausar/reanudar promoción)' })
  setActive(@Param('id') id: string, @Body() body: { active: boolean }) {
    return this.service.setActive(id, body.active === true);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete promoción (deleted_at + active=false)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
