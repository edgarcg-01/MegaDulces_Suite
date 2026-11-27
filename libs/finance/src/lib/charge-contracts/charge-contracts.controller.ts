import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, RolesGuard } from '@megadulces/platform-core';
import type {
  CargosSinContratoResponse, ConfirmarContratoCargoBody, ContratoCargoEscrito, ContratosCargoResponse, CrearContratoCargoBody,
  DocumentoContratoCargoBody, DocumentoContratoCargoUrl, EditarContratoCargoBody, MotivoContratoCargoBody, PasadaCargosDelBanco,
  ResultadoPropuestaContratos,
} from '@megadulces/contracts';
import { ChargeContractsService } from './charge-contracts.service';

interface AuthedRequest { user?: { username?: string } }
const quien = (req: AuthedRequest): string => req.user?.username || 'sistema';

/**
 * `[PGP.213]` C2 — **Los contratos que sustentan los cargos del banco** (anexo CR, DCR1: «el sistema propone, Tesorería
 * confirma»). Ver = `FINANCE_PAYMENTS_VER` (quien ve el Calendario ve de dónde salen sus cargos automáticos). Todo lo que
 * escribe = `FINANCE_CHARGE_CONTRACTS_GESTIONAR`: tesoreria, finanzas_operativo y finanzas (Francisco, 2026-11-26), no la
 * clave de Pagos, que tienen también Marketing, Compras, Crédito y Contabilidad. La pantalla es `[PGP.214]`.
 */
@ApiTags('finance-charge-contracts')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/charge-contracts')
export class ChargeContractsController {
  constructor(private readonly svc: ChargeContractsService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: '[PGP.213] Todos los contratos de cargos del banco (propuestos primero), con su cuenta, renglones, tabla, evidencia del banco y lo que le falta a cada propuesta para confirmarse.' })
  listar(): Promise<ContratosCargoResponse> {
    return this.svc.listar();
  }

  @Get('sin-contrato')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: '[PGP.213] Los cargos automáticos del banco que no sustenta un contrato confirmado (por omisión, este mes y el anterior), con su motivo. `total` e `importe_total` son del rango completo aunque la lista se tope (`has_more`).' })
  sinContrato(@Query('desde') desde?: string, @Query('hasta') hasta?: string, @Query('limit') limit?: string): Promise<CargosSinContratoResponse> {
    return this.svc.sinContrato({ desde, hasta, limit });
  }

  @Get(':id/documento')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: '[PGP.213] El PDF del contrato: URL prefirmada de 600 s (se pide en cada clic, no se guarda).' })
  documento(@Param('id') id: string): Promise<DocumentoContratoCargoUrl> {
    return this.svc.urlDocumento(id);
  }

  @Post('proponer')
  @HttpCode(200)
  @RequirePermissions(Permission.FINANCE_CHARGE_CONTRACTS_GESTIONAR)
  @ApiOperation({ summary: '[PGP.213] El sistema propone un contrato por cada serie del banco que ningún contrato cita (DCR1). Idempotente; también corre solo con cada carga del banco.' })
  proponer(@Req() req: AuthedRequest): Promise<ResultadoPropuestaContratos> {
    return this.svc.proponer(quien(req));
  }

  @Post('pasada')
  @HttpCode(200)
  @RequirePermissions(Permission.FINANCE_CHARGE_CONTRACTS_GESTIONAR)
  @ApiOperation({ summary: '[PGP.213] Correr ahora la pasada de cada carga del banco: proponer, recalcular el interés, programar el cargo del mes y cerrar lo cobrado. Cada paso que falla se dice en `fallas`.' })
  pasada(@Req() req: AuthedRequest): Promise<PasadaCargosDelBanco> {
    return this.svc.pasada(quien(req));
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_CHARGE_CONTRACTS_GESTIONAR)
  @ApiOperation({ summary: '[PGP.213] Dar de alta un contrato que el detector no ve. Nace propuesto: confirmar es otro acto.' })
  crear(@Body() body: CrearContratoCargoBody, @Req() req: AuthedRequest): Promise<ContratoCargoEscrito> {
    return this.svc.crear(body, quien(req));
  }

  @Patch(':id')
  @RequirePermissions(Permission.FINANCE_CHARGE_CONTRACTS_GESTIONAR)
  @ApiOperation({ summary: '[PGP.213] Corregir una PROPUESTA: encabezado y renglones (con `id` se corrige; sin `id` se agrega; con `tabla` se reemplaza su tabla). Un contrato confirmado no se corrige: 409.' })
  editar(@Param('id') id: string, @Body() body: EditarContratoCargoBody, @Req() req: AuthedRequest): Promise<ContratoCargoEscrito> {
    return this.svc.editar(id, body, quien(req));
  }

  @Post(':id/confirmar')
  @HttpCode(200)
  @RequirePermissions(Permission.FINANCE_CHARGE_CONTRACTS_GESTIONAR)
  @ApiOperation({ summary: '[PGP.213] Tesorería confirma (con las correcciones que traiga). Se niega con lo que falta en llano (DCR11: arrendamiento, crédito, seguro y FONACOT llevan su PDF). Al confirmar se programa el cargo del mes.' })
  confirmar(@Param('id') id: string, @Body() body: ConfirmarContratoCargoBody, @Req() req: AuthedRequest): Promise<ContratoCargoEscrito> {
    return this.svc.confirmar(id, body, quien(req));
  }

  @Post(':id/terminar')
  @HttpCode(200)
  @RequirePermissions(Permission.FINANCE_CHARGE_CONTRACTS_GESTIONAR)
  @ApiOperation({ summary: '[PGP.213] Un contrato confirmado que ya no cobra (se pagó el crédito, venció el arrendamiento), con motivo y fecha de fin.' })
  terminar(@Param('id') id: string, @Body() body: MotivoContratoCargoBody, @Req() req: AuthedRequest): Promise<ContratoCargoEscrito> {
    return this.svc.terminar(id, body, quien(req));
  }

  @Post(':id/rechazar')
  @HttpCode(200)
  @RequirePermissions(Permission.FINANCE_CHARGE_CONTRACTS_GESTIONAR)
  @ApiOperation({ summary: '[PGP.213] Rechazar una propuesta («no es un contrato»), con motivo. No se vuelve a proponer.' })
  rechazar(@Param('id') id: string, @Body() body: MotivoContratoCargoBody, @Req() req: AuthedRequest): Promise<ContratoCargoEscrito> {
    return this.svc.rechazar(id, body, quien(req));
  }

  @Post(':id/documento')
  @HttpCode(200)
  @RequirePermissions(Permission.FINANCE_CHARGE_CONTRACTS_GESTIONAR)
  @ApiOperation({ summary: '[PGP.213] Subir el PDF del contrato (data URI, sólo PDF) a una propuesta o a un contrato confirmado (DCR11).' })
  subirDocumento(@Param('id') id: string, @Body() body: DocumentoContratoCargoBody, @Req() req: AuthedRequest): Promise<ContratoCargoEscrito> {
    return this.svc.subirDocumento(id, body, quien(req));
  }
}
