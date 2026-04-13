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
import { Roles } from '../../shared/decorators/roles.decorator';
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
  @Roles('ejecutivo', 'superadmin')
  @ApiOperation({
    summary: 'Crear nueva captura (Requiere rol ejecutivo o superadmin)',
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
  @Roles('superadmin', 'reportes')
  @ApiOperation({
    summary: 'Consultar capturas (Requiere rol superadmin o reportes)',
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
  @Roles('superadmin')
  @ApiOperation({
    summary: 'Eliminar una captura por ID (Requiere rol superadmin)',
  })
  remove(@Param('id') id: string) {
    return this.capturesService.remove(id);
  }
}
