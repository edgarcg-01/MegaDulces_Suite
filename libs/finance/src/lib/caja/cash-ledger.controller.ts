import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, Permission, isPlatformAdminRole } from '@megadulces/platform-core';
import { CashLedgerService, type CreateMovementInput } from './cash-ledger.service';
import { CajaAutofillService, type AutofillInput } from './caja-autofill.service';
import { CashCutService, type AbrirCorteInput, type CerrarCorteInput } from './cash-cut.service';

interface AuthedRequest {
  user?: {
    id?: string; sub?: string; userId?: string; username?: string;
    role_name?: string; permissions?: Record<string, boolean>;
  };
}

/**
 * CG.13/CG.17 — Caja General: el libro donde la plataforma REGISTRA el efectivo (ADR-070).
 *
 * Distinto de `CajaGeneralController` (`/finance/caja`, CG.1-CG.7), que es la lectura del
 * ESPEJO del Access y seguirá viva durante el traslape. Éste es el lado que escribe.
 *
 * Permisos PROPIOS (§CG.14): hasta ahora todo `/finanzas/caja` colgaba de `FINANCE_BANK_VER`,
 * que es de Bancos. VER consulta · GESTIONAR captura · AUTORIZAR (fuera de todo MODULE_GROUP)
 * cierra el corte y confirma el mapa de conceptos. Capturar ≠ autorizar.
 */
@ApiTags('finance-cash-ledger')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/cash-ledger')
export class CashLedgerController {
  constructor(
    private readonly svc: CashLedgerService,
    private readonly autofill: CajaAutofillService,
    private readonly cortes: CashCutService,
  ) {}

  /** El JWT trae el id con nombres distintos según el emisor; se toma el primero que exista. */
  private user(req: AuthedRequest) {
    const u = req?.user ?? {};
    return { id: u.id ?? u.sub ?? u.userId, username: u.username };
  }

  /**
   * ⛔ CG.19 Capa 1b — **¿este usuario puede ver el esperado?**
   *
   * Sólo quien AUTORIZA, que es la segunda llave del corte y la persona que ya no puede ser la
   * que lo cerró. Quien captura cuenta a ciegas: el esperado se revela al sellar el conteo.
   *
   * Calca `revela()` de `store-arqueo.controller.ts` (SM.8), que resuelve exactamente lo mismo.
   * Se lee del permiso, NO del rol: un gate por nombre de rol se rompe en la siguiente alta.
   */
  private revela(req: AuthedRequest): boolean {
    return isPlatformAdminRole(req?.user?.role_name)
      || req?.user?.permissions?.[Permission.FINANCE_CAJA_AUTORIZAR] === true;
  }

  @Get()
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Libro de caja: movimientos + KPIs del MISMO filtro. from/to, tipo, sucursal, cuenta, search.' })
  list(
    @Query('from') from?: string, @Query('to') to?: string, @Query('tipo') tipo?: string,
    @Query('sucursal') sucursal?: string, @Query('cuenta') cuenta?: string,
    @Query('search') search?: string, @Query('limit') limit?: string, @Query('offset') offset?: string,
  ) {
    return this.svc.list({
      from, to, tipo, sucursal, cuenta, search,
      limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('conceptos')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Catálogo de conceptos de Kepler (vista derivada del ODS). El concepto es POR SUCURSAL.' })
  conceptos(@Query('sucursal') sucursal?: string, @Query('search') search?: string, @Query('limit') limit?: string) {
    return this.svc.conceptos({ sucursal, search, limit: limit ? Number(limit) : undefined });
  }

  @Get('cobertura')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Cobertura del catálogo de conceptos y del mapa HITL. Va SIEMPRE a la pantalla: "0 conceptos" por carril caído no puede verse igual que "no hay conceptos".' })
  cobertura() {
    return this.svc.coverage();
  }

  /**
   * CG.19 Capa 1 — va ANTES de `@Get(':id')` como el resto: Nest resuelve por orden de
   * declaración y `ingresos-pendientes` se comería como un id.
   */
  @Get('ingresos-pendientes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'CG.19 — Cobros que Kepler YA registró y todavía no se aplicaron a la caja. El capturista ELIGE de acá en vez de teclear monto/fecha/motivo: el valor se toma del ERP y el registro precede al dinero. Filtros: sucursal, tipo_cuenta(ruta|interno|cliente_final), from/to, search.' })
  ingresosPendientes(
    @Query('sucursal') sucursal?: string,
    @Query('tipo_cuenta') tipo_cuenta?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.ingresosPendientes({ sucursal, tipo_cuenta, from, to, search, limit: limit ? Number(limit) : undefined });
  }

  @Post('autofill')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'PROPONE los campos del movimiento con su procedencia y confianza. No guarda nada. Lo que no puede proponer sale en null con motivo.' })
  suggest(@Body() body: AutofillInput) {
    return this.autofill.suggest(body ?? {});
  }

  @Post()
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Registra un movimiento. Folio atómico, par cuenta/concepto validado contra el catálogo vivo y arqueo que cuadra o no se guarda.' })
  create(@Body() body: CreateMovementInput, @Req() req: AuthedRequest) {
    return this.svc.create(body, this.user(req));
  }

  // ⚠️ Estas rutas van ANTES de @Get(':id'): Nest resuelve por orden de declaracion y
  // 'cortes'/'saldo' se comerian como si fueran un id. Misma trampa que en LC.2.

  @Get('saldo/:sucursal')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Saldo de la caja: fondo del corte abierto + efecto de sus movimientos. DERIVADO, no guardado. Sin corte abierto devuelve null y lo declara, no 0. CG.19: el esperado y la diferencia SOLO viajan a quien AUTORIZA — quien captura cuenta a ciegas, y lo que se oculta se declara (saldo_oculto).' })
  saldo(@Param('sucursal') sucursal: string, @Req() req: AuthedRequest) {
    return this.cortes.saldo(sucursal, this.revela(req));
  }

  @Get('cortes')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Cortes de caja. Filtros: from, to, sucursal, estado.' })
  listarCortes(
    @Query('from') from?: string, @Query('to') to?: string,
    @Query('sucursal') sucursal?: string, @Query('estado') estado?: string, @Query('limit') limit?: string,
  ) {
    return this.cortes.listar({ from, to, sucursal, estado, limit: limit ? Number(limit) : undefined });
  }

  @Post('cortes')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Abre el corte de la sucursal con su fondo inicial. Uno solo abierto por sucursal.' })
  abrirCorte(@Body() body: AbrirCorteInput, @Req() req: AuthedRequest) {
    return this.cortes.abrir(body, this.user(req));
  }

  /**
   * ⚠️ Era `POST cortes/:id/previa`, cuyo resumen decía «para que el capturista vea la diferencia
   * mientras cuenta» — exactamente lo que CG.19 revierte. Tenía **cero llamadores** (verificado en
   * `apps/view` y `libs/finance`), así que se reusa y se renombra: un endpoint cuyo nombre miente
   * es peor que uno que no existe.
   */
  @Post('cortes/:id/contar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'CG.19 — SELLA el conteo y RECIÉN ENTONCES revela la diferencia. Sellar antes de revelar es lo que vuelve ciego al arqueo: sin eso bastaba mirar el resultado, corregir el conteo y volver a preguntar.' })
  contarCorte(@Param('id') id: string, @Body() body: CerrarCorteInput, @Req() req: AuthedRequest) {
    return this.cortes.contar(id, body ?? {}, this.user(req));
  }

  @Post('cortes/:id/recontar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'CG.19 — Segundo y ÚLTIMO conteo, con motivo obligatorio. El primero se conserva en conteo_previo: un reconteo sin rastro no se distingue de un ajuste.' })
  recontarCorte(@Param('id') id: string, @Body() body: CerrarCorteInput & { motivo?: string }, @Req() req: AuthedRequest) {
    return this.cortes.recontar(id, body ?? {}, this.user(req));
  }

  @Post('cortes/:id/cerrar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Cierra el corte con el conteo fisico. Congela los totales y ata los movimientos. NO se puede cerrar sin contar.' })
  cerrarCorte(@Param('id') id: string, @Body() body: CerrarCorteInput, @Req() req: AuthedRequest) {
    return this.cortes.cerrar(id, body ?? {}, this.user(req));
  }

  @Post('cortes/:id/autorizar')
  @RequirePermissions(Permission.FINANCE_CAJA_AUTORIZAR)
  @ApiOperation({ summary: 'Autoriza el corte. DOBLE LLAVE: quien lo cerro NO puede autorizarlo (lo frena la DB ademas del servicio).' })
  autorizarCorte(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.cortes.autorizar(id, this.user(req));
  }

  @Post(':id/cancelar')
  @RequirePermissions(Permission.FINANCE_CAJA_GESTIONAR)
  @ApiOperation({ summary: 'Cancela un movimiento con motivo. No se borra: se marca y sigue en la lista. No se puede cancelar lo que ya entro a un corte cerrado.' })
  cancelar(@Param('id') id: string, @Body() body: { motivo: string }, @Req() req: AuthedRequest) {
    return this.cortes.cancelarMovimiento(id, body?.motivo, this.user(req));
  }

  @Get(':id')
  @RequirePermissions(Permission.FINANCE_CAJA_VER)
  @ApiOperation({ summary: 'Detalle del movimiento con su desglose por denominación y el cuadre del arqueo ya calculado.' })
  detail(@Param('id') id: string) {
    return this.svc.detail(id);
  }
}
