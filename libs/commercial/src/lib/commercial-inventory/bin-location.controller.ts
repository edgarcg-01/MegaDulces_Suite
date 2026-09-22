import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import { BinLocationService, CreateBinDto, PutAwayDto } from './bin-location.service';

/**
 * Fase WMS-REC (Pieza 3 — Ubicación bin-level, ADR-044).
 *
 * Bins (layout) = ASIGNAR · put-away = RECIBIR · lecturas = VER.
 *
 * **WMS-REC.9 — cuatro puertas se abren también a quien RECIBE**, porque el gate
 * estaba mal partido y le negaba el trabajo a quien lo hace. Medido en prod: de
 * los 2 roles que pueden recibir, **`almacenista` (4 de los 5 usuarios) NO tiene
 * `VER` ni `ASIGNAR`** — o sea que el bodeguero entraba al Andén y la sección de
 * Ubicación le contestaba 403 entera: no podía leer su propia cola de pendientes,
 * ni saber si un rack existe, ni darlo de alta. Sólo `supervisor` (1 usuario)
 * podía acomodar.
 *
 * Se abren **sólo las cuatro que el Andén usa**, no el permiso completo:
 * `COMMERCIAL_INVENTORY_VER` gatea 14 endpoints en tres controladores, y
 * repartirlo entero para destrabar esto abriría el conteo físico y la existencia
 * a quien sólo tiene que acomodar una tarima.
 *
 * **`DELETE /bins` se queda en ASIGNAR**: crear la ubicación es parte de acomodar
 * (hay que rotular el rack con la mercancía en las manos), pero borrar el layout
 * no es trabajo del andén.
 */
@ApiTags('commercial-inventory')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('commercial/inventory')
export class BinLocationController {
  constructor(private readonly service: BinLocationService) {}

  // Crear es parte de acomodar: la bodega se rotula a medida que se usa y el
  // Andén imprime el cartel al crear. Borrar NO — ver el bloque de arriba.
  @Post('bins')
  @RequireAnyPermission(Permission.COMMERCIAL_INVENTORY_ASIGNAR, Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Crear un bin (posición física)' })
  createBin(@Body() body: CreateBinDto) {
    return this.service.createBin(body);
  }

  // Quien acomoda necesita saber si el código que escaneó existe; sin esto, un
  // rack inexistente sólo se descubre con un 404 al guardar.
  @Get('bins')
  @RequireAnyPermission(Permission.COMMERCIAL_INVENTORY_VER, Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Listar bins (?warehouse_id=) + unidades ubicadas' })
  listBins(@Query('warehouse_id') warehouseId?: string) {
    return this.service.listBins(warehouseId);
  }

  /**
   * Escaneá el cartel del rack y decime qué tiene adentro.
   *
   * **Va declarada ANTES de `bins/:id/contents`**: Nest matchea en orden, y con
   * `:id` primero la palabra `lookup` se leería como un id y contestaría
   * "bin_id inválido". Es la misma trampa que ya se documentó en Caducidades con
   * `resolve` y en el expediente con `no-asociados`.
   */
  @Get('bins/lookup')
  @RequireAnyPermission(Permission.COMMERCIAL_INVENTORY_VER, Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Resolver una ubicación por su código escaneado + su contenido' })
  lookupBin(@Query('code') code?: string, @Query('warehouse_id') warehouseId?: string) {
    return this.service.lookupBin(code || '', warehouseId);
  }

  @Delete('bins/:id')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_ASIGNAR)
  @ApiOperation({ summary: 'Eliminar un bin (debe estar vacío)' })
  deleteBin(@Param('id') id: string) {
    return this.service.deleteBin(id);
  }

  // Que hay en ESTE rack. Quien acomoda tiene que poder volver a mirarlo.
  @Get('bins/:id/contents')
  @RequireAnyPermission(Permission.COMMERCIAL_INVENTORY_VER, Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Contenido de un bin (lotes + cantidades)' })
  binContents(@Param('id') id: string) {
    return this.service.binContents(id);
  }

  @Post('put-away')
  @RequirePermissions(Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Ubicar (put-away) cantidad de un lote en un bin (por bin_id o bin_code)' })
  putAway(@Body() body: PutAwayDto) {
    return this.service.putAway(body);
  }

  // Donde esta un producto, para el que lo fue a dejar.
  @Get('locations')
  @RequireAnyPermission(Permission.COMMERCIAL_INVENTORY_VER, Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Auxiliar de ubicaciones: dónde está cada lote (?warehouse_id=&product_id=)' })
  locations(@Query('warehouse_id') warehouseId?: string, @Query('product_id') productId?: string) {
    return this.service.locations({ warehouse_id: warehouseId, product_id: productId });
  }

  // Es la cola de trabajo del que acomoda: negársela es negarle la pantalla.
  @Get('unlocated')
  @RequireAnyPermission(Permission.COMMERCIAL_INVENTORY_VER, Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'Lotes con cantidad por ubicar (recibidos, no colocados aún)' })
  unlocated(@Query('warehouse_id') warehouseId?: string, @Query('product_id') productId?: string) {
    return this.service.unlocated({ warehouse_id: warehouseId, product_id: productId });
  }

  // Dónde ya vive el SKU: es lo que evita que la misma mercancía termine repartida
  // en cuatro racks distintos.
  @Get('pick-suggestion')
  @RequireAnyPermission(Permission.COMMERCIAL_INVENTORY_VER, Permission.COMMERCIAL_INVENTORY_RECIBIR)
  @ApiOperation({ summary: 'FEFO físico: bins de un producto ordenados por caducidad (surtí primero el 1º)' })
  pickSuggestion(@Query('warehouse_id') warehouseId: string, @Query('product_id') productId: string) {
    return this.service.pickSuggestion(warehouseId, productId);
  }
}
