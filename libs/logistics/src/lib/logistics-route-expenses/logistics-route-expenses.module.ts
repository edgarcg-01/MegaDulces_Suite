import { Module } from '@nestjs/common';
import { LogisticsRouteExpensesService } from './logistics-route-expenses.service';
import { LogisticsRouteExpensesController } from './logistics-route-expenses.controller';
import { LogisticsRouteOperationService } from './logistics-route-operation.service';
import { LogisticsRouteOperationController } from './logistics-route-operation.controller';

/**
 * RD.4 gasto de flota + RD.5 odómetro y $/km de Ruta Directa.
 * Una sola superficie operativa (el costo de flota) en dos pestañas, un solo par de permisos
 * `LOGISTICS_ROUTE_EXPENSES_VER/_GESTIONAR` — el odómetro es lo que convierte los pesos del
 * gasto en $/km, no un módulo aparte.
 */
@Module({
  controllers: [LogisticsRouteExpensesController, LogisticsRouteOperationController],
  providers: [LogisticsRouteExpensesService, LogisticsRouteOperationService],
  exports: [LogisticsRouteExpensesService, LogisticsRouteOperationService],
})
export class LogisticsRouteExpensesModule {}
