import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequireAnyPermission, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { CerrarHojaInput, HojaGastos, HojasDeGastos, MotivoHojaInput } from '@megadulces/contracts';
import { HojaGastosService } from './hoja-gastos.service';

interface AuthedRequest { user?: { id?: string; sub?: string; userId?: string; username?: string } }

/**
 * ⭐ `[CGA-A.65]` La hoja de gastos de zona (el Excel «Formato de autorización de gastos», armado de
 * Kepler). Tres firmas, tres permisos: la zona la cierra (`FINANCE_HOJA_GASTOS_CERRAR`), finanzas la
 * aprueba o la rechaza (`FINANCE_EXPENSES_COMPROBAR`, D18 de la Fase LE) y Caja General la paga
 * (la ve con `FINANCE_CAJA_VER`). Ruta propia: ningún `@Get(':id')` ajeno se la come.
 */
@ApiTags('finance-hoja-gastos')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/hoja-gastos')
export class HojaGastosController {
  constructor(private readonly svc: HojaGastosService) {}

  private user(req: AuthedRequest): { id?: string; username?: string } {
    const u = req?.user ?? {};
    return { id: u.id ?? u.sub ?? u.userId, username: u.username };
  }

  @Get()
  @RequireAnyPermission(Permission.FINANCE_CAJA_VER, Permission.FINANCE_HOJA_GASTOS_CERRAR, Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[CGA-A.65] La hoja abierta de cada zona (armada de Kepler) y las cerradas, con sus firmas y su pago reconocido (retiro de CAOS por folio, depósito en la cuenta de la zona).' })
  hojas(): Promise<HojasDeGastos> {
    return this.svc.hojas();
  }

  @Post(':zona/cerrar')
  @RequirePermissions(Permission.FINANCE_HOJA_GASTOS_CERRAR)
  @ApiOperation({ summary: '[CGA-A.65] La zona cierra (autoriza) su hoja con los pagos que elige; el importe lo vuelve a leer el servidor de Kepler.' })
  cerrar(@Param('zona') zona: string, @Body() body: CerrarHojaInput, @Req() req: AuthedRequest): Promise<HojaGastos> {
    return this.svc.cerrar(zona, body, this.user(req));
  }

  @Post(':id/aprobar')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[CGA-A.65] Finanzas aprueba la hoja (otra persona que quien la cerró). Desde aquí Caja General la puede pagar.' })
  aprobar(@Param('id') id: string, @Req() req: AuthedRequest): Promise<HojaGastos> {
    return this.svc.aprobar(id, this.user(req));
  }

  @Post(':id/rechazar')
  @RequirePermissions(Permission.FINANCE_EXPENSES_COMPROBAR)
  @ApiOperation({ summary: '[CGA-A.65] Finanzas rechaza la hoja con motivo: sus pagos vuelven a la hoja abierta.' })
  rechazar(@Param('id') id: string, @Body() body: MotivoHojaInput, @Req() req: AuthedRequest): Promise<HojaGastos> {
    return this.svc.rechazar(id, body, this.user(req));
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.FINANCE_HOJA_GASTOS_CERRAR)
  @ApiOperation({ summary: '[CGA-A.65] La zona cancela su hoja antes de que finanzas la apruebe, con motivo.' })
  cancelar(@Param('id') id: string, @Body() body: MotivoHojaInput, @Req() req: AuthedRequest): Promise<HojaGastos> {
    return this.svc.cancelar(id, body, this.user(req));
  }
}
