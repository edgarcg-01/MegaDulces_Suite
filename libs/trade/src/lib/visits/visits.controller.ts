import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { VisitsService } from './visits.service';
import { RequireAuthGuard } from '@megadulces/platform-core';
import { ReqUser } from '@megadulces/platform-core';
import { RequirePermissions } from '@megadulces/platform-core';
import { Permission } from '@megadulces/platform-core';
import { RolesGuard } from '@megadulces/platform-core';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('visits')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('visits')
export class VisitsController {
  constructor(private readonly visitsService: VisitsService) {}

  @Get()
  @RequirePermissions(Permission.VISITAS_VER)
  @ApiOperation({ summary: 'Consultar todas las visitas reportadas' })
  findAll(@ReqUser() user: any) {
    return this.visitsService.findAll(user);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Desglosar Checkin mostrando todos sus exhibidores y fotos',
  })
  findOne(@Param('id') id: string) {
    return this.visitsService.findOne(id);
  }

  @Post('checkin')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({ summary: 'Iniciar la auditoría de Campo en una tienda GPS' })
  checkIn(
    @ReqUser() user: any,
    @Body() body: { store_id: string; lat: number; lng: number },
  ) {
    // Tomamos payload extraido puramente del JWT Inmutable para evitar JOIN a Users
    return this.visitsService.checkIn(
      user.sub,
      user.username,
      body.store_id,
      body.lat,
      body.lng,
    );
  }

  @Put(':id/checkout')
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({
    summary:
      'Sella y audita matemáticamente la Visita. Retorna Status final y Promedio Acumulado',
  })
  checkOut(@Param('id') id: string, @ReqUser() user: any) {
    return this.visitsService.checkOut(id, user.sub);
  }
}
