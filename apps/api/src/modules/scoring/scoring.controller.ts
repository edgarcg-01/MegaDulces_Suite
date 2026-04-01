import { Controller, Get, Put, Body, UseGuards, Query } from '@nestjs/common';
import { ScoringService, ScoringCalculateDto } from './scoring.service';
import { RequireAuthGuard } from '../../shared/guards/require-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('scoring')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard)
@Controller('scoring')
export class ScoringController {
  constructor(private readonly scoringService: ScoringService) {}

  @Get('config')
  @UseGuards(RolesGuard)
  @Roles('superadmin', 'reportes', 'ejecutivo')
  @ApiOperation({ summary: 'Obtener configuración del motor de JSONB' })
  getConfig() {
    return this.scoringService.getConfig();
  }

  @Put('config')
  @UseGuards(RolesGuard)
  @Roles('superadmin')
  @ApiOperation({ summary: 'Re-setear los pesos de la fórmula paramétrica' })
  setConfig(@Body() body: any) {
    return this.scoringService.setConfig(body);
  }

  @Get('calculate')
  @ApiOperation({ summary: 'Calculadora dinámica de simulación de Exibiciones. IMPORTANTE: Exige URL Foto' })
  calculate(@Query() query: any) {
    return this.scoringService.calculateScore(query as ScoringCalculateDto);
  }
}
