import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule, requireJwtSecret, jwtVerifyOptions } from '@megadulces/platform-core';
import { PagosVencidosService } from './pagos-vencidos.service';
import { PagosPorElBancoService } from './pagos-por-el-banco.service';
import { KeplerPagoSinkAdapter } from './kepler-pago/kepler-pago-sink.adapter';
import { CajaRealtimeModule } from '../caja/caja-realtime.module';
import { BudgetCapacityService } from './budget-capacity.service';
import { BudgetCapacityController } from './budget-capacity.controller';
import { BudgetExpenseObligationsService } from './budget-expense-obligations.service';
import { BudgetExpenseObligationsController } from './budget-expense-obligations.controller';
import { ObligationsAutopilotService } from './obligations-autopilot.service';
import { FinancialCommitmentsService } from './financial-commitments.service';
import { FinancialCommitmentsController } from './financial-commitments.controller';
import { PaymentCalendarService } from './payment-calendar.service';
import { PaymentCalendarDocumentService } from './payment-calendar-document.service';
import { PaymentCalendarController } from './payment-calendar.controller';
import { AvisoDePagoService } from './aviso-de-pago.service';
import { AvisoDePagoController, AvisoDePagoPublicoController } from './aviso-de-pago.controller';
import { FinanceBudgetModule } from '../budget/finance-budget.module';
import { FinanceSupplierPaymentAccountsModule } from '../supplier-payment-accounts/finance-supplier-payment-accounts.module';
import { BudgetLinesService } from '../budget/budget-lines.service';
import { BUDGET_LEDGER_PORT } from '../budget/budget-ledger.port';
import { ChargeContractsController } from '../charge-contracts/charge-contracts.controller';
import { ChargeContractsService } from '../charge-contracts/charge-contracts.service';
import { CargosDelBancoService } from '../charge-contracts/cargos-del-banco.service';

/**
 * Fase TP (ADR-064) — Calendario de Pagos: Presupuestos (capacidad + gastos autorizados) +
 * Finanzas (compromisos financieros) + el motor de asignación (lotes/allocations/agreements) +
 * documentos imprimibles (TP.8, `PaymentCalendarDocumentService` con su propio Chromium — mismo
 * patrón que Fase AX, sin cruzar la frontera finance→commercial).
 * Las obligaciones a proveedor de mercancía y el catálogo de cuentas de pago viven en
 * `@megadulces/commercial` — este módulo solo las LEE por knex directo.
 */
@Module({
  // Importa FinanceBudgetModule sólo para el puerto del ledger (unificar el gasto — ADR-066). Sin ciclo:
  // FinanceBudgetModule no importa nada de payment-calendar.
  // `[PGP.21]` `CloudinaryModule` EXPORTA `ObjectStorageService`, que firma la URL del PDF de la
  // factura. Se importa el modulo en vez de declarar el servicio en `providers`: asi se comparte
  // la instancia en lugar de crear una segunda en este inyector (mismo patron que TP.7).
  // `[PGP.46]` El catálogo de cuentas de proveedor, para que la CLABE que alguien teclea al
  // preparar un pago quede PEDIDA de alta y no haya que teclearla otra vez. Sin ciclo:
  // `FinanceSupplierPaymentAccountsModule` sólo importa `CloudinaryModule`.
  // `[PGP.117]` ⛔ `CajaRealtimeModule` se IMPORTA por `PgListenService`, y NO se provee acá: lo exporta
  // a propósito para que todos los oyentes de finanzas compartan la MISMA conexión `LISTEN` (`[CG.197]`).
  // Proveerlo aquí compila igual y abre una segunda conexión a prod para el mismo aviso. Sin ciclo:
  // `CajaRealtimeModule` sólo importa `JwtModule`.
  // `[PGP.194]` `JwtModule` local para firmar la liga del aviso de pago al proveedor (la misma configuración que la
  // liga del depósito del cliente, `[CC.20]`): `CajaRealtimeModule` lo importa pero no lo exporta.
  imports: [
    FinanceBudgetModule, CloudinaryModule, FinanceSupplierPaymentAccountsModule, CajaRealtimeModule,
    JwtModule.register({
      secret: requireJwtSecret(),
      signOptions: { expiresIn: (process.env.JWT_EXPIRES_IN || '12h') as any, algorithm: 'HS256' },
      verifyOptions: jwtVerifyOptions,
    }),
  ],
  controllers: [
    BudgetCapacityController,
    BudgetExpenseObligationsController,
    FinancialCommitmentsController,
    PaymentCalendarController,
    // `[PGP.194]` El aviso de pago al proveedor: el del Calendario y el de la liga pública.
    AvisoDePagoController,
    AvisoDePagoPublicoController,
    // `[PGP.213]` Los contratos que sustentan los cargos del banco (anexo CR): su cargo de cada mes vive en el Calendario.
    ChargeContractsController,
  ],
  providers: [
    // `[VE.4]` El quinto motor del presupuesto, que vive de este lado de la frontera: genera las
    // obligaciones recurrentes en estado `propuesta`. No se pudo sumar al piloto de `[VE.3]`
    // porque este módulo YA importa `FinanceBudgetModule` y al revés sería un ciclo.
    ObligationsAutopilotService,
    BudgetCapacityService,
    BudgetExpenseObligationsService,
    FinancialCommitmentsService,
    PaymentCalendarService,
    PaymentCalendarDocumentService,
    AvisoDePagoService,
    // `[PGP.117]` Escucha `caja_fuente` y, una vez al día, libera los pagos que nadie pagó en una
    // semana (con bitácora). Su `PgListenService` llega de `CajaRealtimeModule` (ver `imports`).
    PagosVencidosService,
    // `[PGP.121]` Escucha `bancos_movimientos`: paga lo que el banco prueba y, con `KEPLER_PAGO_ESCRITURA=encendida`,
    // lo escribe en Kepler con su adaptador (sin parámetros en el constructor: las variables las lee de `process.env`).
    PagosPorElBancoService,
    KeplerPagoSinkAdapter,
    // `[PGP.213]` La API de los contratos y su pasada con cada carga del banco (escucha `bancos_movimientos` en el worker,
    // sin reloj; su `PgListenService` llega de `CajaRealtimeModule`, como el de arriba).
    ChargeContractsService,
    CargosDelBancoService,
    // El movimiento del ledger de la partida lo hace BudgetLinesService, expuesto por token para no
    // acoplar TP a la clase concreta (BUDGET_LEDGER_PORT).
    { provide: BUDGET_LEDGER_PORT, useExisting: BudgetLinesService },
  ],
  // `[CB.62.4]` KeplerPagoSinkAdapter se EXPORTA para que las comisiones de la terminal (Bancos) escriban su
  // X-D-26 con el MISMO escritor probado contra el Kepler vivo, no con una copia.
  exports: [BudgetCapacityService, BudgetExpenseObligationsService, FinancialCommitmentsService, PaymentCalendarService, KeplerPagoSinkAdapter],
})
export class FinancePaymentCalendarModule {}
