import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type { RequestConCabeceras } from '@megadulces/platform-core';
import { CarteraTelefonosService } from './cartera-telefonos.service';
// `import type`: con `emitDecoratorMetadata` + `isolatedModules`, un tipo en la firma de un método decorado entra así (TS1272).
import type { CambioTelefonoCliente, TelefonosCuenta } from './cartera-telefonos.service';

interface AuthedRequest extends RequestConCabeceras { user?: { username?: string } }

/**
 * `[CXC.48]` Los teléfonos de la cartera: ver (con la llave de Cartera) y corregir (con la llave de teléfonos).
 * Prefijo propio para no competir con `:sucursal/:cliente` de `CustomerLedgerController`.
 */
@ApiTags('finance-cartera-telefonos')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/cartera-telefonos')
export class CarteraTelefonosController {
  constructor(private readonly svc: CarteraTelefonosService) {}

  /** De 4 segmentos (`vendedor/…/telefono`): no lo casa ninguna ruta de 2 o 3. */
  @Put('vendedor/:sucursal/:vendedor/telefono')
  @RequirePermissions(Permission.FINANCE_CARTERA_TELEFONOS)
  @ApiOperation({ summary: '[CXC.48] Guarda el teléfono del vendedor (en la Suite: Kepler no lo tiene).' })
  cambiarVendedor(
    @Param('sucursal') sucursal: string, @Param('vendedor') vendedor: string,
    @Body('telefono') telefono: string, @Req() req: AuthedRequest,
  ): Promise<{ sucursal: string; code: string; telefono: string }> {
    return this.svc.cambiarVendedor(sucursal, vendedor, telefono, req.user?.username);
  }

  @Get(':sucursal/:cliente')
  @RequirePermissions(Permission.FINANCE_RECEIVABLES_VER)
  @ApiOperation({ summary: '[CXC.48] El teléfono del cliente en cada sucursal de Kepler, el del vendedor y si se puede escribir.' })
  ver(@Param('sucursal') sucursal: string, @Param('cliente') cliente: string, @Query('vendedor') vendedor?: string): Promise<TelefonosCuenta> {
    return this.svc.ver(sucursal, cliente, vendedor);
  }

  @Post(':sucursal/:cliente/telefono')
  @RequirePermissions(Permission.FINANCE_CARTERA_TELEFONOS)
  @ApiOperation({ summary: '[CXC.48] Escribe el teléfono del cliente en Kepler, en cada sucursal donde está dado de alta.' })
  cambiarCliente(
    @Param('sucursal') sucursal: string, @Param('cliente') cliente: string,
    @Body('telefono') telefono: string, @Req() req: AuthedRequest,
  ): Promise<CambioTelefonoCliente> {
    return this.svc.cambiarCliente(sucursal, cliente, telefono, req.user?.username);
  }
}
