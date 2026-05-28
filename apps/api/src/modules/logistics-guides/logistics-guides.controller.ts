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
  LogisticsGuidesService,
  CreateGuideDto,
  UpdateGuideDto,
  CreateRecipientDto,
  MarkDeliveredDto,
} from './logistics-guides.service';

@ApiTags('logistics-guides')
@Controller('logistics/guides')
export class LogisticsGuidesController {
  constructor(private readonly service: LogisticsGuidesService) {}

  @Post()
  @ApiOperation({ summary: 'Crear guía (autocálculo de comisiones opcional)' })
  create(@Body() body: CreateGuideDto) {
    return this.service.create(body);
  }

  @Get()
  @ApiOperation({ summary: 'Listar guías (filtra por shipment_id opcional)' })
  list(@Query('shipment_id') shipmentId?: string) {
    return this.service.list(shipmentId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener guía por id (incluye recipients)' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Actualizar guía (status transitions enforced)' })
  update(@Param('id') id: string, @Body() body: UpdateGuideDto) {
    return this.service.update(id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete (solo si cancelada)' })
  remove(@Param('id') id: string) {
    return this.service.softDelete(id);
  }

  // ── Recipients ─────────────────────────────────────────────────────────

  @Post(':id/recipients')
  @ApiOperation({ summary: 'Agregar destinatario a la guía' })
  addRecipient(@Param('id') guideId: string, @Body() body: CreateRecipientDto) {
    return this.service.addRecipient(guideId, body);
  }

  @Post('recipients/:recipientId/deliver')
  @ApiOperation({ summary: 'Marcar destinatario como entregado (foto + GPS opcional)' })
  markDelivered(@Param('recipientId') id: string, @Body() body: MarkDeliveredDto) {
    return this.service.markRecipientDelivered(id, body);
  }

  @Delete('recipients/:recipientId')
  @ApiOperation({ summary: 'Eliminar recipient (solo si pendiente)' })
  removeRecipient(@Param('recipientId') id: string) {
    return this.service.removeRecipient(id);
  }
}
