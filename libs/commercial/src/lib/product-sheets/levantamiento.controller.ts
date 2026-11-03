import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  LevantamientoBusquedaFila, LevantamientoContexto, LevantamientoEscaneoDto, LevantamientoEscaneoRespuesta, LevantamientoFotoRespuesta, LevantamientoSaltoDto,
  LevantamientoSugeridosRespuesta,
} from '@megadulces/contracts';
import { Permission, RequirePermissions, SkipTenantTx } from '@megadulces/platform-core';
import { LevantamientoService, MAX_FOTO_BYTES, type ArchivoSubido, type Quien } from './levantamiento.service';

interface Sesion {
  user?: { sub?: string; username?: string };
}

/** Quién captura, leído de la SESIÓN (nunca del cuerpo): las fotos se atribuyen a esa persona. */
const quien = (req: Sesion | undefined): Quien => ({ userId: String(req?.user?.sub ?? ''), username: req?.user?.username ?? null });

/**
 * `[NP.7.L.2]` Levantamiento del Catálogo digital desde el celular (`/levantamiento`). Todo con
 * `CATALOGO_LEVANTAR`, repartido a todo rol con personas (NP.7.L.7b: es universal). Responde
 * lista blanca: nada de costo, precio, margen ni lectura de la IA (§10b.2).
 *
 * `branch` es opcional: sin él, la sucursal del perfil; quien no tiene una en el perfil la elige (D25);
 * con sucursal en el perfil, pedir otra exige alcance de escritura.
 */
@ApiTags('catalog-levantamiento')
@Controller('catalog/levantamiento')
export class LevantamientoController {
  constructor(private readonly service: LevantamientoService) {}

  @Get('context')
  @RequirePermissions(Permission.CATALOGO_LEVANTAR)
  @ApiOperation({ summary: 'NP.7: sucursal, quién captura, cuántos productos faltan y su semana' })
  contexto(@Query('branch') branch: string | undefined, @Req() req: Sesion): Promise<LevantamientoContexto> {
    return this.service.contexto(quien(req), branch);
  }

  @Get('branches')
  @RequirePermissions(Permission.CATALOGO_LEVANTAR)
  @ApiOperation({ summary: 'NP.7: sucursales para elegir (quien no tiene sucursal en su perfil)' })
  sucursales(): Promise<Array<{ code: string; name: string }>> {
    return this.service.sucursales();
  }

  @Get('suggested')
  @RequirePermissions(Permission.CATALOGO_LEVANTAR)
  @ApiOperation({ summary: 'NP.7: lo que hay en el anaquel sin ficha, los que más venden primero (paginado, con total)' })
  sugeridos(
    @Query('branch') branch: string | undefined, @Query('limit') limit: string | undefined, @Query('offset') offset: string | undefined,
    @Req() req: Sesion,
  ): Promise<LevantamientoSugeridosRespuesta> {
    return this.service.sugeridos(quien(req), branch, Number(limit) || 30, Number(offset) || 0);
  }

  @Get('search')
  @RequirePermissions(Permission.CATALOGO_LEVANTAR)
  @ApiOperation({ summary: 'NP.7: buscador de respaldo por código, SKU o nombre (lista blanca: sin precio ni venta)' })
  buscar(@Query('q') q: string | undefined, @Query('branch') branch: string | undefined, @Req() req: Sesion): Promise<LevantamientoBusquedaFila[]> {
    return this.service.buscar(quien(req), q, branch);
  }

  @Post('scan')
  @RequirePermissions(Permission.CATALOGO_LEVANTAR)
  @ApiOperation({ summary: 'NP.7: resuelve el código (o el SKU elegido en el buscador) y aparta la unidad principal 30 min' })
  escanear(@Body() dto: LevantamientoEscaneoDto, @Query('branch') branch: string | undefined, @Req() req: Sesion): Promise<LevantamientoEscaneoRespuesta> {
    return this.service.escanear(quien(req), dto, branch);
  }

  @Post('sheets/:id/photos')
  @RequirePermissions(Permission.CATALOGO_LEVANTAR)
  // La subida al bucket puede tardar: sin la transacción automática del interceptor, la conexión no
  // queda ociosa mientras sube (patrón de daily-captures). El servicio abre transacciones cortas.
  @SkipTenantTx()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FOTO_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'NP.7: sube UNA cara (file + face) con su medición de calidad hecha en el teléfono' })
  foto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: ArchivoSubido | undefined,
    @Body() body: { face?: string; sharpness?: string; contrast?: string; quality_version?: string; width?: string; height?: string },
    @Req() req: Sesion,
  ): Promise<LevantamientoFotoRespuesta> {
    return this.service.foto(quien(req), id, file, body ?? {});
  }

  @Post('sheets/:id/skip')
  @RequirePermissions(Permission.CATALOGO_LEVANTAR)
  @ApiOperation({ summary: 'NP.7: no se puede tomar esa cara (con motivo); la ficha irá a revisión' })
  saltar(@Param('id', ParseUUIDPipe) id: string, @Body() dto: LevantamientoSaltoDto, @Req() req: Sesion): Promise<LevantamientoFotoRespuesta> {
    return this.service.saltar(quien(req), id, dto);
  }

  @Post('sheets/:id/release')
  @RequirePermissions(Permission.CATALOGO_LEVANTAR)
  @ApiOperation({ summary: 'NP.7: suelta el apartado propio (salir sin terminar / no es éste)' })
  soltar(@Param('id', ParseUUIDPipe) id: string, @Req() req: Sesion): Promise<{ ok: true }> {
    return this.service.soltar(quien(req), id);
  }
}
