import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { EstadoDeCuentaService, type SubirEstadoDeCuentaBody } from './estado-de-cuenta.service';

type Svc = EstadoDeCuentaService;

interface AuthedRequest { user?: { username?: string; full_name?: string }; }

/**
 * `[CB.58]` El estado de cuenta descargado de la banca: revisar (no escribe) → confirmar (escribe).
 * Mismos permisos que subir el libro hoy: ver = FINANCE_BANK_VER · subir = FINANCE_BANK_GESTIONAR.
 * Controlador aparte (y no un método más de `FinanceBankController`) para no cambiar la firma
 * inyectada de ese constructor: es la familia del incidente de arranque de #414.
 */
@ApiTags('finance-bank')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/bank/statement-files')
export class EstadoDeCuentaController {
  constructor(private readonly svc: EstadoDeCuentaService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: 'Estados de cuenta subidos (del más reciente al más viejo), con su control de saldo.' })
  list(@Query('limit') limit?: string): ReturnType<Svc['archivos']> {
    return this.svc.archivos(limit ? Number(limit) : undefined);
  }

  @Get('contra-libro')
  @RequirePermissions(Permission.FINANCE_BANK_VER)
  @ApiOperation({ summary: '[CB.60] Cada cuenta con descarga contra el libro CUENTAS, día por día: cuadra, difiere (con lo que sobra de cada lado), sin libro o abierto. Sólo lee.' })
  contraLibro(@Query('dias') dias?: string): ReturnType<Svc['contraElLibro']> {
    return this.svc.contraElLibro(dias ? Number(dias) : undefined);
  }

  @Post('preview')
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Lee el archivo (base64) y dice qué entraría: banco, cuenta y cómo se fijó, cuadre de saldo, nuevos vs ya cargados y motivos de bloqueo. No escribe.' })
  preview(@Body() body: SubirEstadoDeCuentaBody): ReturnType<Svc['revisar']> {
    return this.svc.revisar(body);
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_BANK_GESTIONAR)
  @ApiOperation({ summary: 'Guarda el estado de cuenta si la revisión no tiene motivos de bloqueo. El mismo archivo dos veces no duplica; los renglones que ya venían en otra descarga tampoco.' })
  confirm(@Body() body: SubirEstadoDeCuentaBody, @Req() req: AuthedRequest): ReturnType<Svc['confirmar']> {
    return this.svc.confirmar(body, req?.user?.full_name || req?.user?.username);
  }
}
