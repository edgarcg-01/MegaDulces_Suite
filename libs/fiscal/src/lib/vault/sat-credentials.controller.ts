import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { SatCredentialsService, UpsertCredInput } from './sat-credentials.service';

/**
 * FISCAL.2 — API de la bóveda de credenciales SAT. Solo estado NO sensible sale
 * por aquí; el material cifrado (.key/pwd/ciec) jamás se devuelve. Gate único:
 * FISCAL_CREDENCIALES_GESTIONAR (dato altamente sensible).
 */
@ApiTags('fiscal-credentials')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/credentials')
export class SatCredentialsController {
  constructor(private readonly svc: SatCredentialsService) {}

  @Get('status')
  @RequirePermissions(Permission.FISCAL_CREDENCIALES_GESTIONAR)
  @ApiOperation({ summary: 'Estado no sensible de la e.firma cargada (RFC, vigencia, días para vencer, bóveda OK).' })
  status() { return this.svc.status(); }

  @Post()
  @RequirePermissions(Permission.FISCAL_CREDENCIALES_GESTIONAR)
  @Throttle({ long: { limit: 6, ttl: 60_000 } })
  @ApiOperation({ summary: 'Alta/actualización de e.firma (cer_b64 + key_b64 + password, opcional ciec). Cifra en reposo.' })
  upsert(@Body() body: UpsertCredInput) { return this.svc.upsert(body); }

  @Delete(':rfc')
  @RequirePermissions(Permission.FISCAL_CREDENCIALES_GESTIONAR)
  @ApiOperation({ summary: 'Elimina la e.firma de un RFC.' })
  remove(@Param('rfc') rfc: string) { return this.svc.remove(rfc); }
}
