import { Module } from '@nestjs/common';
import { PurchaseBookService } from './purchase-book.service';
import { PurchaseBookController } from './purchase-book.controller';

/**
 * Fase LC (ADR-052) — Libro de Compras. Lee `fiscal.cfdis` (CFDIs recibidos del ADD de
 * ContPAQi) más el mapa `finance.gl_supplier_accounts`, y produce el TXT de la póliza
 * mensual. El trámite de subirlo a ContPAQi lo sigue haciendo contabilidad: aquí no se
 * escribe nada en el SoR (ADR-040).
 */
@Module({
  controllers: [PurchaseBookController],
  providers: [PurchaseBookService],
  exports: [PurchaseBookService],
})
export class FinancePurchaseBookModule {}
