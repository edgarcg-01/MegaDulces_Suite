import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CapturesService } from './captures.service';
import { CreateCaptureDto } from './dto/create-capture.dto';
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

@ApiTags('captures')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('captures')
export class CapturesController {
  constructor(private readonly capturesService: CapturesService) {}

  @Post()
  @UseGuards(RolesGuard)
  @RequirePermissions(Permission.VISITAS_REGISTRAR)
  @ApiOperation({
    summary: 'Crear nueva captura (Requiere permiso VISITAS_REGISTRAR)',
  })
  create(@Body() createCaptureDto: CreateCaptureDto, @ReqUser() user: any) {
    return this.capturesService.create(
      createCaptureDto,
      user.sub,
      user.username,
      user.zona,
    );
  }

  @Get()
  @UseGuards(RolesGuard)
  @RequirePermissions(Permission.VISITAS_VER)
  @ApiOperation({
    summary: 'Consultar capturas (Requiere permiso VISITAS_VER)',
  })
  @ApiQuery({ name: 'zona', required: false })
  @ApiQuery({ name: 'ejecutivo', required: false })
  @ApiQuery({ name: 'fecha_inicio', required: false })
  @ApiQuery({ name: 'fecha_fin', required: false })
  findAll(
    @Query('zona') zona?: string,
    @Query('ejecutivo') ejecutivo?: string,
    @Query('fecha_inicio') fecha_inicio?: string,
    @Query('fecha_fin') fecha_fin?: string,
  ) {
    return this.capturesService.findAll(
      zona,
      ejecutivo,
      fecha_inicio,
      fecha_fin,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener captura por ID' })
  findOne(@Param('id') id: string) {
    return this.capturesService.findOne(id);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @RequirePermissions(Permission.REPORTES_GESTIONAR)
  @ApiOperation({
    summary: 'Eliminar una captura por ID (Requiere permiso REPORTES_GESTIONAR)',
  })
  remove(@Param('id') id: string) {
    return this.capturesService.remove(id);
  }
}
