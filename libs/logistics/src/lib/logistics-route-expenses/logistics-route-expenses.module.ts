import { Module } from '@nestjs/common';
import { LogisticsRouteExpensesService } from './logistics-route-expenses.service';
import { LogisticsRouteExpensesController } from './logistics-route-expenses.controller';

/** RD.4 — gasto de flota de Ruta Directa. */
@Module({
  controllers: [LogisticsRouteExpensesController],
  providers: [LogisticsRouteExpensesService],
  exports: [LogisticsRouteExpensesService],
})
export class LogisticsRouteExpensesModule {}
