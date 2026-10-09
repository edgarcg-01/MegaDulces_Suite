import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { MaterialidadService } from './materialidad.service';
import { MaterialidadAssignmentsService, type AssignmentInput } from './materialidad-assignments.service';

/** FISCAL.10.1 — API del expediente de materialidad por proveedor. */
@ApiTags('fiscal-materialidad')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('fiscal/materialidad')
export class MaterialidadController {
  constructor(
    private readonly svc: MaterialidadService,
    private readonly assign: MaterialidadAssignmentsService,
  ) {}

  @Get()
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_VER)
  @ApiOperation({ summary: 'MAT — Descubrimiento: índice de proveedores rankeado por riesgo (lista negra / baja recepción / monto). Filtros: search, riesgo (all|lista|riesgo|sin_recepcion), limit.' })
  providers(@Query('search') search?: string, @Query('riesgo') riesgo?: string, @Query('limit') limit?: string) {
    return this.svc.providers({ search, riesgo, limit: limit ? Number(limit) : undefined });
  }

  @Get(':rfc')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_VER)
  @ApiOperation({ summary: 'Expediente de materialidad de un proveedor (listas + CFDIs + cadena de suministro + veredicto).' })
  dossier(@Param('rfc') rfc: string) { return this.svc.buildDossier(rfc); }

  @Get(':rfc/chains')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_VER)
  @ApiOperation({ summary: 'Desglose de la cadena de suministro: documentos (orden → recepción → factura → pago) por cada factura del proveedor.' })
  chains(@Param('rfc') rfc: string) { return this.svc.chains(rfc); }

  @Get(':rfc/reconcile')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_VER)
  @ApiOperation({ summary: 'Conciliación por proveedor: cada CFDI recibido con su asignación confirmada o la operación sugerida (RFC+importe+fecha).' })
  reconcile(@Param('rfc') rfc: string) { return this.assign.reconcile(rfc); }

  @Post('assignments/confirm')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_GESTIONAR)
  @ApiOperation({ summary: 'Confirma la asignación CFDI↔operación (evidencia de materialidad).' })
  confirm(@Body() body: AssignmentInput) { return this.assign.confirm(body); }

  @Post('assignments/reject')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_GESTIONAR)
  @ApiOperation({ summary: 'Descarta un par sugerido para que no vuelva a proponerse.' })
  reject(@Body() body: AssignmentInput) { return this.assign.reject(body); }

  /**
   * `[MAT.5]` La pasada masiva. ⛔ **Propone, no confirma**: escribe `status = 'auto'`, que la
   * base distingue de la evidencia que miró una persona.
   *
   * Pide `_GESTIONAR` porque ESCRIBE en la tabla, aunque lo que escriba no sea evidencia todavía.
   */
  @Post('assignments/auto')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_GESTIONAR)
  @ApiOperation({ summary: 'Propone en lote los pares CFDI↔operación estrictamente 1:1 (status=auto). NO confirma: eso lo hace una persona.' })
  auto(@Body() body: { dias?: number; limite?: number }) { return this.assign.autoProponer(body ?? {}); }

  @Post('assignments/confirm-batch')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_GESTIONAR)
  @ApiOperation({ summary: 'Confirma en lote las propuestas (auto → confirmed). Acá el casamiento se vuelve evidencia, y queda el nombre de quien la miró.' })
  confirmBatch(@Body() body: { ids: string[] }) { return this.assign.confirmarPropuestas(body?.ids ?? []); }

  @Delete('assignments/:id')
  @RequirePermissions(Permission.FISCAL_MATERIALIDAD_GESTIONAR)
  @ApiOperation({ summary: 'Revierte una asignación confirmada.' })
  unassign(@Param('id') id: string) { return this.assign.unassign(id); }
}
