import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import type { ArqueoCajaDto, ArqueoGuardadoDto, DocumentosEnCajaDto, NuevoArqueoCajaInput } from '@megadulces/contracts';
import { CajaArqueoService } from './caja-arqueo.service';

interface AuthedRequest {
  user?: { id?: string; sub?: string; userId?: string; username?: string };
}

/**
 * `[CGS.45]` El arqueo completo de la caja: lo que contaba el Access de Control (jubilado el
 * 2026-10-22). Controlador aparte para no tocar la firma inyectada de `CashLedgerController`.
 */
@ApiTags('finance-cash-ledger')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/cash-ledger/arqueos-caja')
export class CajaArqueoController {
  constructor(private readonly arqueos: CajaArqueoService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CGS.45] Los arqueos completos de la caja (efectivo, caja fuerte, cheques, papeles, dolares), de la Suite y del historico de Control, del mas nuevo al mas viejo.' })
  listar(@Query('limit') limit?: string): Promise<{ rows: ArqueoCajaDto[]; limit: number; fuente: string }> {
    return this.arqueos.listar({ limit: limit ? Number(limit) : undefined });
  }

  @Get('documentos')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: '[CGS.59] Los cheques y papeles que estaban en el ultimo arqueo que conto cada apartado, para marcarlos al contar (sigue o salio), y la llave contra dos conteos a la vez.' })
  documentos(): Promise<DocumentosEnCajaDto> {
    return this.arqueos.documentosEnCaja();
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: '[CGS.45] Registra un arqueo completo: recuento (a ciegas, de un corte cerrado, por otra persona) o intermedio. Solo se agrega. Lo que selló el corte se revela al guardar.' })
  registrar(@Body() body: Partial<NuevoArqueoCajaInput>, @Req() req: AuthedRequest): Promise<ArqueoGuardadoDto> {
    const u = req?.user ?? {};
    return this.arqueos.registrar(body ?? {}, { id: u.id ?? u.sub ?? u.userId, username: u.username });
  }
}
