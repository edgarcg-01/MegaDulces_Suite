import { Module } from '@nestjs/common';
import { LogisticsPayrollService } from './logistics-payroll.service';
import { LogisticsPayrollController } from './logistics-payroll.controller';

@Module({
  controllers: [LogisticsPayrollController],
  providers: [LogisticsPayrollService],
  exports: [LogisticsPayrollService],
})
export class LogisticsPayrollModule {}
