import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DailyCapturesService } from './daily-captures.service';
import { CreateDailyCaptureDto } from './dto/create-daily-capture.dto';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { RequirePermissions } from '../../shared/decorators/permissions.decorator';
import { Permission } from '../../shared/constants/permissions';
import { ReqUser } from '../../shared/decorators/req-user.decorator';
import {
  ApiTags,
  ApiBearerAuth,
  ApiQuery,
  ApiOperation,
} from '@nestjs/swagger';

@ApiTags('daily-captures')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('daily-captures')
export class DailyCapturesController {
  constructor(private readonly dailyCapturesService: DailyCapturesService) {}

  @Post()
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({ summary: 'Registrar una auditoría completada en un PDV' })
  create(
    @Body() createDailyCaptureDto: CreateDailyCaptureDto,
    @ReqUser() user: any,
  ) {
    return this.dailyCapturesService.create(
      createDailyCaptureDto,
      user.sub,
      user.username,
      user.zona,
    );
  }

  @Get()
  @RequirePermissions(Permission.VISITAS_VER)
  @ApiOperation({ summary: 'Consultar Cierres de Auditoría/Visitas' })
  @ApiQuery({ name: 'fecha', required: false })
  @ApiQuery({ name: 'zona', required: false })
  @ApiQuery({ name: 'ejecutivo', required: false })
  findAll(
    @Query('fecha') fecha?: string,
    @Query('zona') zona?: string,
    @Query('ejecutivo') ejecutivo?: string,
    @ReqUser() user?: any,
  ) {
    // Protección de datos: un colaborador con permiso VISITAS_VER pero sin permisos globales
    // sólo debe ver sus propios registros si su rol es 'colaborador' o 'ejecutivo'
    const userIdFilter = user?.permissions?.[Permission.REPORTES_VER_GLOBAL]
      ? undefined
      : user.sub;

    return this.dailyCapturesService.findAll(
      fecha,
      zona,
      ejecutivo,
      userIdFilter,
    );
  }

  @Get(':id')
  @RequirePermissions(Permission.VISITAS_VER)
  @ApiOperation({ summary: 'Obtener visita por Folio o ID' })
  findOne(@Param('id') id: string) {
    return this.dailyCapturesService.findOne(id);
  }
}
