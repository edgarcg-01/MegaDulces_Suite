import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { PurchaseBookService, ImpuestosModo } from './purchase-book.service';

/**
 * Fase LC (ADR-052) — Libro de Compras. El trámite mensual se lleva aquí y a ContPAQi
 * solo va el TXT, que sigue subiendo contabilidad (ADR-040: no escribimos en el SoR).
 *
 * VER = consultar el mes, su cuadre y el estado del trámite.
 * GESTIONAR = decidir qué facturas entran, generar el archivo y mover el trámite.
 */
@ApiTags('finance-purchase-book')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/purchase-book')
export class PurchaseBookController {
  constructor(private readonly svc: PurchaseBookService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_PURCHASE_BOOK_VER)
  @ApiOperation({ summary: 'Tablero de meses: CFDIs, estado del trámite y qué tiene ContPAQi hoy.' })
  listMeses(@Query('limit') limit?: string) {
    return this.svc.listMeses(limit ? Number(limit) : undefined);
  }

  @Get(':mes')
  @RequirePermissions(Permission.FINANCE_PURCHASE_BOOK_VER)
  @ApiOperation({ summary: 'Las facturas del mes con su cuadre, sus cuentas y los avisos que impedirían generar.' })
  getMes(@Param('mes') mes: string) {
    return this.svc.getMes(mes);
  }

  @Get(':mes/cuadre')
  @RequirePermissions(Permission.FINANCE_PURCHASE_BOOK_VER)
  @ApiOperation({ summary: 'Compara lo entregado contra la póliza que quedó en ContPAQi.' })
  cuadre(@Param('mes') mes: string) {
    return this.svc.cuadrarContraContpaqi(mes);
  }

  @Post(':mes/inclusion')
  @RequirePermissions(Permission.FINANCE_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Incluye o excluye facturas del mes (con motivo si se excluye).' })
  setInclusion(
    @Param('mes') mes: string,
    @Body() body: { uuids: string[]; incluida: boolean; motivo?: string },
  ) {
    return this.svc.setInclusion(mes, body?.uuids ?? [], body?.incluida !== false, body?.motivo);
  }

  @Post(':mes/generar')
  @RequirePermissions(Permission.FINANCE_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Genera el TXT del mes y deja la corrida firmada por su hash.' })
  async generar(
    @Param('mes') mes: string,
    @Body() body: { impuestos?: ImpuestosModo; uuid?: boolean },
  ) {
    const r = await this.svc.generar(mes, body ?? {});
    // El contenido va aparte: el front lo descarga por /archivo cuando el usuario quiere.
    const { txt, ...resumen } = r;
    return resumen;
  }

  @Get(':mes/archivo')
  @RequirePermissions(Permission.FINANCE_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Descarga el TXT del mes tal como se importa a ContPAQi.' })
  async archivo(
    @Param('mes') mes: string,
    @Query('impuestos') impuestos: ImpuestosModo | undefined,
    @Query('uuid') uuid: string | undefined,
    @Res() res: Response,
  ) {
    const r = await this.svc.generar(mes, { impuestos, uuid: uuid !== '0' });
    // latin1: ContPAQi lee el archivo en la codificación de Windows, no en UTF-8. Con
    // acentos en UTF-8 los nombres de proveedor llegan rotos.
    res.setHeader('Content-Type', 'text/plain; charset=iso-8859-1');
    res.setHeader('Content-Disposition', `attachment; filename="${r.nombre}"`);
    res.send(Buffer.from(r.txt, 'latin1'));
  }

  @Post(':mes/estado')
  @RequirePermissions(Permission.FINANCE_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Mueve el trámite: entregado | aplicado | cancelado.' })
  marcar(
    @Param('mes') mes: string,
    @Body() body: { estado: 'entregado' | 'aplicado' | 'cancelado'; entregado_a?: string; notas?: string },
  ) {
    return this.svc.marcar(mes, body?.estado, { entregado_a: body?.entregado_a, notas: body?.notas });
  }
}
