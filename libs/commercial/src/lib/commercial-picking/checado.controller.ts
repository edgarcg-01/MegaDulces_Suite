import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequireAuthGuard, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  ChecadoCerrarCajaResponse,
  ChecadoEscanearDto,
  ChecadoEscaneoResponse,
  ChecadoEtiquetasResponse,
  ChecadoPedido,
  ChecadoSiguienteDto,
  ChecadoTerminarDto,
  ChecadoTerminarResponse,
  ChecadoTomarResponse,
  ConsolaSurtidoAlmacen,
} from '@megadulces/contracts';
import { ChecadoService } from './checado.service';

/**
 * `[GP.4]` El checado (`FASE_GP` §9). TODO con `ALMACEN_CHECADO_GESTIONAR`, incluida la lista de
 * almacenes: la pantalla del surtidor pedía los almacenes con un permiso de otro módulo y el
 * surtidor real no podía empezar (GP.3). Aquí nada depende de otra clave.
 */
@ApiTags('reparto-checado')
@ApiBearerAuth()
@UseGuards(RequireAuthGuard, RolesGuard)
@Controller('reparto/checado')
export class ChecadoController {
  constructor(private readonly service: ChecadoService) {}

  @Get('almacenes')
  @RequirePermissions(Permission.ALMACEN_CHECADO_GESTIONAR)
  @ApiOperation({ summary: 'Sucursales donde puede checar quien consulta (su alcance).' })
  almacenes(): Promise<ConsolaSurtidoAlmacen[]> {
    return this.service.almacenes();
  }

  @Get('mio')
  @RequirePermissions(Permission.ALMACEN_CHECADO_GESTIONAR)
  @ApiOperation({ summary: 'El pedido que el checador trae abierto (o null).' })
  mio(): Promise<ChecadoPedido | null> {
    return this.service.mio();
  }

  @Post('siguiente')
  @RequirePermissions(Permission.ALMACEN_CHECADO_GESTIONAR)
  @ApiOperation({ summary: 'Da el siguiente pedido surtido, ya en SURTIDO en Kepler y que quien pide no surtió.' })
  siguiente(@Body() body: ChecadoSiguienteDto): Promise<ChecadoTomarResponse> {
    return this.service.tomarSiguiente(body);
  }

  @Post(':id/escanear')
  @RequirePermissions(Permission.ALMACEN_CHECADO_GESTIONAR)
  @ApiOperation({ summary: 'Un escaneo: caja cerrada (CJA/BTO/CUB), o paquetería a la caja P abierta. Lo que sobra no se registra.' })
  escanear(@Param('id') id: string, @Body() body: ChecadoEscanearDto): Promise<ChecadoEscaneoResponse> {
    return this.service.escanear(id, body);
  }

  @Post(':id/escaneos/:scanId/deshacer')
  @RequirePermissions(Permission.ALMACEN_CHECADO_GESTIONAR)
  @ApiOperation({ summary: 'Deshace un escaneo (no si su caja P ya se cerró y etiquetó).' })
  deshacer(@Param('id') id: string, @Param('scanId') scanId: string): Promise<ChecadoPedido> {
    return this.service.deshacer(id, scanId);
  }

  @Post(':id/cerrar-caja')
  @RequirePermissions(Permission.ALMACEN_CHECADO_GESTIONAR)
  @ApiOperation({ summary: 'Cierra la caja P abierta y devuelve su etiqueta.' })
  cerrarCaja(@Param('id') id: string): Promise<ChecadoCerrarCajaResponse> {
    return this.service.cerrarCaja(id);
  }

  @Post(':id/terminar')
  @RequirePermissions(Permission.ALMACEN_CHECADO_GESTIONAR)
  @ApiOperation({ summary: 'Termina el checado: diferencias y etiquetas de cajas (1/N).' })
  terminar(@Param('id') id: string, @Body() body: ChecadoTerminarDto): Promise<ChecadoTerminarResponse> {
    return this.service.terminar(id, body);
  }

  @Post(':id/soltar')
  @RequirePermissions(Permission.ALMACEN_CHECADO_GESTIONAR)
  @ApiOperation({ summary: 'El checador suelta el pedido: vuelve a la fila y otro lo checa desde cero.' })
  soltar(@Param('id') id: string): Promise<{ id: string; soltado: true }> {
    return this.service.soltar(id);
  }

  @Get(':id/etiquetas')
  @RequirePermissions(Permission.ALMACEN_CHECADO_GESTIONAR)
  @ApiOperation({ summary: 'Las etiquetas de un pedido ya checado por quien consulta, para reimprimir.' })
  etiquetas(@Param('id') id: string): Promise<ChecadoEtiquetasResponse> {
    return this.service.etiquetas(id);
  }
}
