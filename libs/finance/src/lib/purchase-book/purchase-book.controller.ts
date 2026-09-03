import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission } from '@megadulces/platform-core';
import { PurchaseBookService, ImpuestosModo, TipoCorrida } from './purchase-book.service';

/**
 * Fase LC (ADR-052) — Libro de Compras. El trámite mensual se lleva aquí y a ContPAQi
 * solo va el TXT, que sigue subiendo contabilidad (ADR-040: no escribimos en el SoR).
 *
 * Vive en el proyecto **Contabilidad**, junto a Pólizas y ContPAQi: es una póliza
 * contable, no un reporte de finanzas. Tiene sus propios permisos
 * (`FISCAL_PURCHASE_BOOK_VER` / `_GESTIONAR`), no los presta ni los toma de otro módulo.
 *
 * Dos sub-módulos sobre el mismo motor:
 *   - `/`              el libro completo del mes (para un mes que no se subió)
 *   - `/no-asociados`  SOLO los movimientos que ContPAQi no tiene atados a ninguna póliza.
 *                      Es el caso normal y el propósito del módulo: sacar lo que falta en
 *                      TXT para que contabilidad complete el trámite.
 */
@ApiTags('finance-purchase-book')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/purchase-book')
export class PurchaseBookController {
  constructor(private readonly svc: PurchaseBookService) {}

  @Get()
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_VER)
  @ApiOperation({ summary: 'Tablero de meses: CFDIs, estado del trámite y qué tiene ContPAQi hoy.' })
  listMeses(@Query('limit') limit?: string) {
    return this.svc.listMeses(limit ? Number(limit) : undefined);
  }

  // ── Sub-módulo: movimientos no asociados ────────────────────────────────────────────
  // Va ANTES de `:mes` a propósito: Nest resuelve por orden de declaración y
  // `@Get(':mes')` se comería `/no-asociados` como si fuera un mes.

  @Get('no-asociados')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_VER)
  @ApiOperation({ summary: 'Por mes: cuántos CFDIs no están asociados a ninguna póliza y cuánto falta por entregar.' })
  listNoAsociados(@Query('limit') limit?: string) {
    return this.svc.listNoAsociados(limit ? Number(limit) : undefined);
  }

  @Get('no-asociados/:mes')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_VER)
  @ApiOperation({ summary: 'Los movimientos no asociados del mes, con los que ya están posteados marcados aparte.' })
  getNoAsociados(@Param('mes') mes: string) {
    return this.svc.getMes(mes, 'complemento');
  }

  @Post('no-asociados/:mes/inclusion')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Incluye o excluye movimientos del complemento (con motivo si se excluye).' })
  setInclusionNoAsociados(
    @Param('mes') mes: string,
    @Body() body: { uuids: string[]; incluida: boolean; motivo?: string },
  ) {
    return this.svc.setInclusion(mes, body?.uuids ?? [], body?.incluida !== false, body?.motivo, 'complemento');
  }

  @Post('no-asociados/:mes/caratula')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Cambia con qué folio y concepto entra la póliza (para los meses que no tienen libro).' })
  setCaratulaNoAsociados(
    @Param('mes') mes: string,
    @Body() body: { folio_poliza?: number; concepto?: string },
  ) {
    return this.svc.setCaratula(mes, body ?? {}, 'complemento');
  }

  @Post('no-asociados/:mes/generar')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Genera el TXT del complemento: solo los movimientos que faltan por asociar.' })
  async generarNoAsociados(
    @Param('mes') mes: string,
    @Body() body: { impuestos?: ImpuestosModo; uuid?: boolean },
  ) {
    const r = await this.svc.generar(mes, { ...(body ?? {}), tipo: 'complemento' });
    const { txt, ...resumen } = r;
    return resumen;
  }

  @Get('no-asociados/:mes/archivo')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Descarga el TXT del complemento ya generado (sólo lectura).' })
  async archivoNoAsociados(@Param('mes') mes: string, @Res() res: Response) {
    // Sin `impuestos`/`uuid`: esas opciones cambian el archivo, y el archivo ya se decidió
    // al generarlo. Aceptarlas acá servía uno distinto del que quedó firmado por su hash.
    await this.enviarTxt(res, mes, 'complemento');
  }

  @Post('no-asociados/:mes/estado')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Mueve el trámite del complemento: entregado | aplicado | cancelado.' })
  marcarNoAsociados(
    @Param('mes') mes: string,
    @Body() body: { estado: 'entregado' | 'aplicado' | 'cancelado'; entregado_a?: string; notas?: string },
  ) {
    return this.svc.marcar(mes, body?.estado, { ...(body ?? {}), tipo: 'complemento' });
  }

  @Get(':mes')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_VER)
  @ApiOperation({ summary: 'Las facturas del mes con su cuadre, sus cuentas y los avisos que impedirían generar.' })
  getMes(@Param('mes') mes: string) {
    return this.svc.getMes(mes);
  }

  @Get(':mes/cuadre')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_VER)
  @ApiOperation({ summary: 'Compara lo entregado contra la póliza que quedó en ContPAQi.' })
  cuadre(@Param('mes') mes: string) {
    return this.svc.cuadrarContraContpaqi(mes);
  }

  @Post(':mes/inclusion')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Incluye o excluye facturas del mes (con motivo si se excluye).' })
  setInclusion(
    @Param('mes') mes: string,
    @Body() body: { uuids: string[]; incluida: boolean; motivo?: string },
  ) {
    return this.svc.setInclusion(mes, body?.uuids ?? [], body?.incluida !== false, body?.motivo);
  }

  @Post(':mes/generar')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_GESTIONAR)
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
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Descarga el TXT del mes ya generado (sólo lectura).' })
  async archivo(@Param('mes') mes: string, @Res() res: Response) {
    await this.enviarTxt(res, mes, 'libro');
  }

  /**
   * Sirve el archivo YA generado. Descargar es sólo lectura: antes esto llamaba a
   * `generar()`, que escribe — bajar un mes en `entregado` lo regresaba a `generado` y
   * recalculaba el hash contra datos más nuevos, así que el archivo dejaba de ser el que
   * quedó firmado.
   */
  private async enviarTxt(res: Response, mes: string, tipo: TipoCorrida = 'libro') {
    const r = await this.svc.obtenerArchivo(mes, tipo);
    // latin1: ContPAQi lee el archivo en la codificación de Windows, no en UTF-8. Con
    // acentos en UTF-8 los nombres de proveedor llegan rotos.
    res.setHeader('Content-Type', 'text/plain; charset=iso-8859-1');
    res.setHeader('Content-Disposition', `attachment; filename="${r.nombre}"`);
    res.setHeader('X-Archivo-Hash', r.hash ?? '');
    res.send(Buffer.from(r.txt, 'latin1'));
  }

  @Post(':mes/estado')
  @RequirePermissions(Permission.FISCAL_PURCHASE_BOOK_GESTIONAR)
  @ApiOperation({ summary: 'Mueve el trámite: entregado | aplicado | cancelado.' })
  marcar(
    @Param('mes') mes: string,
    @Body() body: { estado: 'entregado' | 'aplicado' | 'cancelado'; entregado_a?: string; notas?: string },
  ) {
    return this.svc.marcar(mes, body?.estado, { entregado_a: body?.entregado_a, notas: body?.notas });
  }
}
