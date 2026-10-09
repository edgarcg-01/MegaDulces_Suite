import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, RequirePermissions, RequireAnyPermission, Permission } from '@megadulces/platform-core';
import type { AcreedorEstadoCuentaResponse, AcreedoresResponse } from '@megadulces/contracts';
import { CreditorStatementsService } from './creditor-statements.service';

/**
 * `[ECA.1]` Estado de cuenta de acreedores: cada documento de Kepler con los pagos y notas de
 * crédito que se le aplicaron. Sólo lectura: los pagos se siguen capturando y aplicando en Kepler.
 * Mismo permiso que el resto de Pagos (Cuadre y deuda, Programa y Calendario de pagos).
 */
@ApiTags('finance-creditor-statements')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@Controller('finance/creditor-statements')
export class CreditorStatementsController {
  constructor(private readonly svc: CreditorStatementsService) {}

  @Get()
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Acreedores con su saldo en Kepler (pendiente, vencido, pagos sin aplicar) y totales por tipo: mercancía, servicios, financiero.' })
  resumen(): Promise<AcreedoresResponse> {
    return this.svc.resumen();
  }

  /**
   * `[RA.CAP]` Lo que le debemos a cada acreedor, en corto, **para el comprador**.
   *
   * Punto 3 de los tres de Edgar (2026-10-08): *"el pedido en algún momento se hará bajo análisis
   * también el presupuesto de pago y capacidad de pago"*.
   *
   * ⛔ **La capacidad de pago NO existe todavía** y eso es un bloqueo humano, no técnico: medido
   * el 2026-10-09, `budget.daily_capacity` tiene 22 filas **de septiembre** (o sea vencidas),
   * `finance.payment_calendar_lots`, `finance.financial_commitments` y
   * `commercial.supplier_payment_obligations` están **en 0**. Nadie captura cuánto se puede pagar
   * por día, así que el pedido no se puede condicionar a eso.
   *
   * ⭐ **Pero la otra mitad SÍ tiene dato.** Lo que YA le debemos a cada proveedor vive en Kepler
   * y esta fase lo lee desde el 2026-10-07: **$164,922,961 pendiente · $133,163,172 vencido
   * (80.7%)** en 402 acreedores. Y el 97.5% de los proveedores que aparecen en el pedido (274 de
   * 281) casan con su acreedor. No decide por el comprador, pero le pone enfrente el hecho de que
   * le va a pedir medio millón a alguien a quien ya le debe dos vencidos.
   *
   * ⛔ **Reusa `resumen()`, no una consulta nueva.** Si la deuda se calculara dos veces, Compras y
   * Finanzas publicarían números distintos del mismo proveedor y nadie sabría cuál creer. Lo único
   * que cambia es el ANCHO: acá viaja el saldo, nunca el detalle de documentos.
   *
   * El permiso se abre a `COMPRAS_PEDIDO_VER` además del de Pagos: un comprador no tiene permiso
   * de Finanzas, y sin esto el panel le llegaría vacío **sin decirle por qué** — que es
   * indistinguible de "no le debemos nada" (la misma trampa de `[EX.7]`).
   */
  @Get('por-proveedor')
  @RequireAnyPermission(Permission.FINANCE_PAYMENTS_VER, Permission.COMPRAS_PEDIDO_VER)
  @ApiOperation({ summary: 'Saldo por acreedor en corto (código, pendiente, vencido) para cruzarlo con el proveedor del pedido. Sin detalle de documentos.' })
  async porProveedor(): Promise<{ al: string; acreedores: { codigo: string; nombre: string; pendiente: number; vencido: number; saldo: number }[] }> {
    const r = await this.svc.resumen();
    return {
      al: r.al,
      // Sólo los que tienen algo que deber: mandar 402 filas en cero es ruido que el front
      // tendría que volver a filtrar, y el que no aparece es exactamente "no le debemos".
      acreedores: r.acreedores
        .filter((a) => a.pendiente > 0 || a.vencido > 0)
        .map((a) => ({ codigo: a.codigo, nombre: a.nombre, pendiente: a.pendiente, vencido: a.vencido, saldo: a.saldo })),
    };
  }

  // ⚠️ `:codigo` va DESPUÉS de `por-proveedor`: si fuera antes, la ruta comodín se comería esa
  // palabra y la pediría como si fuera el código de un acreedor — HTTP 200 con un estado de
  // cuenta vacío, que es peor que un error.
  @Get(':codigo')
  @RequirePermissions(Permission.FINANCE_PAYMENTS_VER)
  @ApiOperation({ summary: 'Estado de cuenta de un acreedor: documentos con sus pagos casados (kdxe + kdxf). Default: sólo lo que tiene saldo. pendientes=false + from/to (AAAA-MM-DD): todo el periodo.' })
  estadoCuenta(
    @Param('codigo') codigo: string,
    @Query('pendientes') pendientes?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<AcreedorEstadoCuentaResponse> {
    return this.svc.estadoCuenta(codigo, { pendientes: !(pendientes === 'false' || pendientes === '0'), from, to });
  }
}
