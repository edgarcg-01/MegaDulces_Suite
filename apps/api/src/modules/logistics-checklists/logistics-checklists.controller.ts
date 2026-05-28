import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  LogisticsChecklistsService,
  CreateChecklistDto,
  CompleteChecklistDto,
  ChecklistType,
} from './logistics-checklists.service';

@ApiTags('logistics-checklists')
@Controller('logistics/checklists')
export class LogisticsChecklistsController {
  constructor(private readonly service: LogisticsChecklistsService) {}

  @Get('template/:type')
  @ApiOperation({ summary: 'Template default de checklist (salida|llegada)' })
  template(@Param('type') type: ChecklistType) {
    return this.service.getTemplate(type);
  }

  @Post()
  @ApiOperation({ summary: 'Crear checklist (pendiente) para shipment' })
  create(@Body() body: CreateChecklistDto) {
    return this.service.create(body);
  }

  @Get('shipment/:shipmentId')
  @ApiOperation({ summary: 'Listar checklists de un shipment' })
  listByShipment(@Param('shipmentId') shipmentId: string) {
    return this.service.findByShipment(shipmentId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener checklist por id' })
  findOne(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post(':id/complete')
  @ApiOperation({ summary: 'Completar checklist (respuestas requeridas)' })
  complete(@Param('id') id: string, @Body() body: CompleteChecklistDto) {
    return this.service.complete(id, body);
  }
}
