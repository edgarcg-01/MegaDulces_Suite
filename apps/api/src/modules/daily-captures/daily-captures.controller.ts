import { Controller, Get, Post, Body, Param, Query, UseGuards, Req } from '@nestjs/common';
import { DailyCapturesService } from './daily-captures.service';
import { CreateDailyCaptureDto } from './dto/create-daily-capture.dto';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { ReqUser } from '../../shared/decorators/req-user.decorator';
import { ApiTags, ApiBearerAuth, ApiQuery, ApiOperation } from '@nestjs/swagger';

@ApiTags('daily-captures')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('daily-captures')
export class DailyCapturesController {
  constructor(private readonly dailyCapturesService: DailyCapturesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @Roles('ejecutivo', 'superadmin')
  @ApiOperation({ summary: 'Registrar una auditoría completada en un PDV' })
  create(
    @Body() createDailyCaptureDto: CreateDailyCaptureDto,
    @ReqUser() user: any
  ) {
    return this.dailyCapturesService.create(createDailyCaptureDto, user.sub, user.username, user.zona);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles('ejecutivo', 'superadmin', 'reportes')
  @ApiOperation({ summary: 'Consultar Cierres de Auditoría/Visitas' })
  @ApiQuery({ name: 'fecha', required: false })
  @ApiQuery({ name: 'zona', required: false })
  @ApiQuery({ name: 'ejecutivo', required: false })
  findAll(
    @Query('fecha') fecha?: string,
    @Query('zona') zona?: string,
    @Query('ejecutivo') ejecutivo?: string,
    @ReqUser() user?: any
  ) {
    // Protección de datos: un 'ejecutivo' sólo debe ver sus propios registros
    const userIdFilter = (user?.rol === 'ejecutivo') ? user.sub : undefined;
    
    return this.dailyCapturesService.findAll(fecha, zona, ejecutivo, userIdFilter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener visita por Folio o ID' })
  findOne(@Param('id') id: string) {
    return this.dailyCapturesService.findOne(id);
  }
}
