import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AcuerdoGuardado, AcuerdosDeReunion, CapturarAcuerdoDto, CerrarAcuerdoDto, ListaAcuerdos } from '@megadulces/contracts';
import { Permission, RequireAnyPermission, RequirePermissions } from '@megadulces/platform-core';
import { quien, type Sesion } from '../supplier-meetings/supplier-meetings.controller';
import { SupplierAgreementsService } from './supplier-agreements.service';

/**
 * `[PQ.3.10]` Compras › Proveedores › Acuerdos (anexo C §10.20). Con las llaves de Citas, sin llaves nuevas (DC44):
 * leer con cualquiera de las dos (Dirección consulta); capturar, editar, iniciar, cumplir y cancelar, sólo con
 * `COMPRAS_CITAS_AGENDAR`.
 */
@ApiTags('compras-acuerdos')
@Controller('compras/proveedores/acuerdos')
export class SupplierAgreementsController {
  constructor(private readonly service: SupplierAgreementsService) {}

  @Get()
  @RequireAnyPermission(Permission.COMPRAS_CITAS_VER, Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.10: los acuerdos abiertos (lo vencido primero) y los últimos cerrados' })
  lista(): Promise<ListaAcuerdos> {
    return this.service.lista();
  }

  @Get('reunion/:meetingId')
  @RequireAnyPermission(Permission.COMPRAS_CITAS_VER, Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.10: los acuerdos de una reunión, si recibe más y lo abierto con el mismo proveedor' })
  deReunion(@Param('meetingId', ParseUUIDPipe) meetingId: string): Promise<AcuerdosDeReunion> {
    return this.service.deReunion(meetingId);
  }

  @Post('reunion/:meetingId')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.10: capturar un acuerdo de una reunión realizada (el del proveedor lo sigue el organizador)' })
  capturar(@Param('meetingId', ParseUUIDPipe) meetingId: string, @Body() dto: CapturarAcuerdoDto, @Req() req: Sesion): Promise<AcuerdoGuardado> {
    return this.service.capturar(quien(req), meetingId, dto);
  }

  @Post(':id/editar')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.10: cambiar lo acordado, el área, el responsable o la fecha de un acuerdo abierto' })
  editar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CapturarAcuerdoDto, @Req() req: Sesion): Promise<AcuerdoGuardado> {
    return this.service.editar(quien(req), id, dto);
  }

  @Post(':id/iniciar')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.10: el acuerdo pasa de pendiente a en curso' })
  iniciar(@Param('id', ParseUUIDPipe) id: string, @Req() req: Sesion): Promise<AcuerdoGuardado> {
    return this.service.iniciar(quien(req), id);
  }

  @Post(':id/cumplir')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.10: el acuerdo se cumplió, con nota (final)' })
  cumplir(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CerrarAcuerdoDto, @Req() req: Sesion): Promise<AcuerdoGuardado> {
    return this.service.cumplir(quien(req), id, dto);
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.COMPRAS_CITAS_AGENDAR)
  @ApiOperation({ summary: 'PQ.3.10: el acuerdo ya no procede, con nota (final; nada se borra)' })
  cancelar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CerrarAcuerdoDto, @Req() req: Sesion): Promise<AcuerdoGuardado> {
    return this.service.cancelar(quien(req), id, dto);
  }
}
