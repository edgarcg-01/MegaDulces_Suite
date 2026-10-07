import { Module } from '@nestjs/common';
import { DiotService } from './diot.service';
import { DiotController } from './diot.controller';

/**
 * FISCAL.8.1 (libs/fiscal) — DIOT + conciliación de IVA.
 * Calcula sobre fiscal.cfdis + cfdi_payment_links (IVA efectivamente pagado).
 * Sin tablas nuevas ni WS: reporte determinista on-the-fly.
 */
@Module({
  controllers: [DiotController],
  providers: [DiotService],
  exports: [DiotService],
})
export class FiscalDiotModule {}
