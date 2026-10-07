import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import {
  PriceExperimentService,
  PriceExperimentReadService,
  ESTRATOS,
} from './price-experiment.service';

/**
 * `[PR.D2]` — Los endpoints del experimento de precio.
 *
 * ⭐ **Dos permisos, no uno.** `_VER` lee resultados y la lista de captura; `_GESTIONAR` diseña.
 * Diseñar decide **qué precios se van a mover y sobre qué venta**, así que no viaja de paquete
 * con "ver precios". El precedente del repo es `COMPRAS_ENTRADAS_GESTIONAR` / `_VALIDAR`.
 *
 * ⛔ Y **capturar** va con `_VER`, no con `_GESTIONAR`: quien teclea los precios en Kepler no
 * tiene por qué poder diseñar experimentos.
 */
@ApiTags('commercial-price-experiments')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/price-experiments')
export class PriceExperimentController {
  constructor(
    private readonly disenador: PriceExperimentService,
    private readonly lectura: PriceExperimentReadService,
  ) {}

  @Get('estratos')
  @RequirePermissions(Permission.COMMERCIAL_PRICE_EXPERIMENT_VER)
  @ApiOperation({ summary: 'Los estratos con su δ, su n exigido y sus elegibles medidos' })
  estratos() {
    // Se devuelven TODOS, viables y no viables, con el número que los descalifica. Ocultar los
    // imposibles haría creer que el experimento cubre el catálogo entero.
    //
    // ⛔ `elegibles` se CUENTA, ya no se lee de una constante. Los números de `ESTRATOS` se
    //    midieron una vez y se escribieron en el código: hoy el diálogo mostraba «hay 6,120»
    //    donde hay **6,028**, y nadie se iba a enterar — un número medido y persistido no avisa
    //    cuando deja de ser cierto.
    //
    // ⭐ Contarlo era caro y por eso estaba clavado; con la matvista de `[PR.D5]` cuesta entre
    //    15 y 48 ms por estrato. El arreglo de rendimiento es lo que vuelve pagable la verdad.
    return this.disenador.estratosConConteoVivo();
  }

  @Get()
  @RequirePermissions(Permission.COMMERCIAL_PRICE_EXPERIMENT_VER)
  @ApiOperation({ summary: 'Experimentos, con su avance de captura' })
  listar() {
    return this.lectura.listar();
  }

  @Post()
  @RequirePermissions(Permission.COMMERCIAL_PRICE_EXPERIMENT_GESTIONAR)
  @ApiOperation({ summary: 'Diseña y asigna un experimento (no aplica ningún precio)' })
  disenar(@Body() dto: {
    nombre: string; modo: '00' | '50' | '90' | '99'; semilla: number; estratos?: string[];
  }) {
    return this.disenador.disenar(dto.nombre, dto.modo, dto.semilla, dto.estratos);
  }

  @Get(':id/captura')
  @RequirePermissions(Permission.COMMERCIAL_PRICE_EXPERIMENT_VER)
  @ApiOperation({ summary: 'La lista para capturar en Kepler — sólo el tratamiento' })
  captura(@Param('id') id: string) {
    return this.lectura.listaDeCaptura(id);
  }

  @Patch('units/:unitId/aplicada')
  @RequirePermissions(Permission.COMMERCIAL_PRICE_EXPERIMENT_VER)
  @ApiOperation({ summary: 'Marca que el precio YA se capturó en Kepler' })
  aplicar(@Param('unitId') unitId: string, @Req() req: { user?: { username?: string } }) {
    // El actor queda escrito: un experimento sin saber quién capturó qué no se puede auditar.
    return this.lectura.marcarAplicada(unitId, req.user?.username ?? 'desconocido');
  }

  @Get(':id/resultados')
  @RequirePermissions(Permission.COMMERCIAL_PRICE_EXPERIMENT_VER)
  @ApiOperation({ summary: 'El veredicto de no-inferioridad, por estrato' })
  resultados(@Param('id') id: string) {
    return this.lectura.resultados(id);
  }
}
