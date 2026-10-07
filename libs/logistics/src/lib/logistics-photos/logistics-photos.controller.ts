import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  Permission,
  RequireAnyPermission,
  RequirePermissions,
} from '@megadulces/platform-core';
import {
  LogisticsPhotosService,
  UploadPhotoDto,
  PhotoCategory,
} from './logistics-photos.service';

/**
 * `[AUTHZ.5]` — Controller sin autorización hasta acá (ver `logistics-fleet.controller`). La foto es
 * **evidencia**: el POD de la entrega y el estado de la unidad.
 *
 * La foto cuelga de un embarque o de una guía, así que se aceptan los dos permisos. Subir es trabajo
 * de ruta (OR con `REPARTO_ENTREGAR`); **borrar no**: destruir evidencia queda sólo en `_GESTIONAR`.
 */
@ApiTags('logistics-photos')
@Controller('logistics/photos')
export class LogisticsPhotosController {
  constructor(private readonly service: LogisticsPhotosService) {}

  @Post()
  @RequireAnyPermission(
    Permission.LOGISTICS_SHIPMENTS_GESTIONAR,
    Permission.LOGISTICS_GUIDES_GESTIONAR,
    Permission.REPARTO_ENTREGAR,
  )
  @ApiOperation({ summary: 'Subir foto (base64 o registrar URL externa) con GPS opcional' })
  upload(@Body() body: UploadPhotoDto) {
    return this.service.upload(body);
  }

  @Get('shipment/:shipmentId')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_VER, Permission.LOGISTICS_GUIDES_VER)
  @ApiOperation({ summary: 'Listar fotos de un shipment (filtro opcional ?category=)' })
  listByShipment(
    @Param('shipmentId') shipmentId: string,
    @Query('category') category?: PhotoCategory,
  ) {
    return this.service.listByShipment(shipmentId, category);
  }

  @Get('guide/:guideId')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_VER, Permission.LOGISTICS_GUIDES_VER)
  @ApiOperation({ summary: 'Listar fotos de una guía específica' })
  listByGuide(@Param('guideId') guideId: string) {
    return this.service.listByGuide(guideId);
  }

  @Get(':id')
  @RequireAnyPermission(Permission.LOGISTICS_SHIPMENTS_VER, Permission.LOGISTICS_GUIDES_VER)
  @ApiOperation({ summary: 'Obtener foto por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Delete(':id')
  @RequireAnyPermission(
    Permission.LOGISTICS_SHIPMENTS_GESTIONAR,
    Permission.LOGISTICS_GUIDES_GESTIONAR,
  )
  @ApiOperation({ summary: 'Soft-delete (+ borra de Cloudinary si tiene public_id)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
