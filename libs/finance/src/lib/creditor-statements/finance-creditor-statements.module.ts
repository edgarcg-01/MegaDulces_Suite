import { Module } from '@nestjs/common';
import { CreditorStatementsService } from './creditor-statements.service';
import { CreditorStatementsController } from './creditor-statements.controller';

/**
 * `[ECA.1]` Estado de cuenta de acreedores. Read-only sobre `kepler_ods.kdxe/kdxf/kdxd/kdmm`
 * (derive-no-copy). TenantKnexService viene del core global.
 */
@Module({
  controllers: [CreditorStatementsController],
  providers: [CreditorStatementsService],
  exports: [CreditorStatementsService],
})
export class FinanceCreditorStatementsModule {}
