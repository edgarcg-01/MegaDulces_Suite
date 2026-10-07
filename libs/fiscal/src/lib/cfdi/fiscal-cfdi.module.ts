import { Module } from '@nestjs/common';
import { CfdiParserService } from './cfdi-parser.service';
import { CfdiStorageService } from './cfdi-storage.service';
import { CfdiIngestService } from './cfdi-ingest.service';
import { CfdiService } from './cfdi.service';
import { CfdiController } from './cfdi.controller';

/**
 * FISCAL.4.2 (libs/fiscal) — Almacén CFDI 4.0.
 * Parser XML + ingesta desde el ZIP de descarga + storage R2 + API de lectura.
 * Exporta CfdiIngestService para que el orquestador de descarga persista los
 * comprobantes al descargar cada paquete.
 */
@Module({
  controllers: [CfdiController],
  providers: [CfdiParserService, CfdiStorageService, CfdiIngestService, CfdiService],
  exports: [CfdiIngestService, CfdiStorageService, CfdiParserService],
})
export class FiscalCfdiModule {}
