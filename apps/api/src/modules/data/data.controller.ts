import { Controller, Get, UseGuards } from '@nestjs/common';
import { DataService } from './data.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('data')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('data')
export class DataController {
  constructor(private readonly dataService: DataService) {}

  @Get('version')
  @ApiOperation({ summary: 'Obtener la versión actual de los datos del sistema' })
  getVersion() {
    return this.dataService.getVersion();
  }
}
