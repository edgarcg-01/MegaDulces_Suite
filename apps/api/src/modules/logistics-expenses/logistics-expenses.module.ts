import { Module } from '@nestjs/common';
import { LogisticsExpensesService } from './logistics-expenses.service';
import { LogisticsExpensesController } from './logistics-expenses.controller';
import { LogisticsConfigModule } from '../logistics-config/logistics-config.module';

@Module({
  imports: [LogisticsConfigModule],
  controllers: [LogisticsExpensesController],
  providers: [LogisticsExpensesService],
  exports: [LogisticsExpensesService],
})
export class LogisticsExpensesModule {}
