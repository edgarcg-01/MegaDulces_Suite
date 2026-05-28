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
  LogisticsPhotosService,
  UploadPhotoDto,
  PhotoCategory,
} from './logistics-photos.service';

@ApiTags('logistics-photos')
@Controller('logistics/photos')
export class LogisticsPhotosController {
  constructor(private readonly service: LogisticsPhotosService) {}

  @Post()
  @ApiOperation({ summary: 'Subir foto (base64 o registrar URL externa) con GPS opcional' })
  upload(@Body() body: UploadPhotoDto) {
    return this.service.upload(body);
  }

  @Get('shipment/:shipmentId')
  @ApiOperation({ summary: 'Listar fotos de un shipment (filtro opcional ?category=)' })
  listByShipment(
    @Param('shipmentId') shipmentId: string,
    @Query('category') category?: PhotoCategory,
  ) {
    return this.service.listByShipment(shipmentId, category);
  }

  @Get('guide/:guideId')
  @ApiOperation({ summary: 'Listar fotos de una guía específica' })
  listByGuide(@Param('guideId') guideId: string) {
    return this.service.listByGuide(guideId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener foto por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete (+ borra de Cloudinary si tiene public_id)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }
}
