import { Injectable, Logger } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { TenantKnexService } from '@megadulces/platform-core';
import { CfdiParserService } from './cfdi-parser.service';
import { CfdiStorageService } from './cfdi-storage.service';
import { CfdiHeader } from './cfdi.types';

export interface IngestResult { storedRef: string | null; parsed: number; skipped: number; total: number; }

/**
 * FISCAL.4.2 — Ingesta de un paquete de descarga masiva: sube el ZIP a R2,
 * descomprime, parsea cada XML y hace UPSERT idempotente en fiscal.cfdis.
 * Corre dentro del scope de tenant (lo invoca el orquestador de descarga).
 */
@Injectable()
export class CfdiIngestService {
  private readonly logger = new Logger(CfdiIngestService.name);
  private readonly CHUNK = 200;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly parser: CfdiParserService,
    private readonly storage: CfdiStorageService,
  ) {}

  async ingestPackage(opts: {
    tenantId: string; requestId: string; packageId: string;
    rol: string | null; zip: Buffer; baseDate?: Date;
  }): Promise<IngestResult> {
    const { tenantId, requestId, packageId, rol, zip } = opts;

    const storedRef = await this.storage.putPackageZip(tenantId, packageId, zip, opts.baseDate);

    let entries: AdmZip.IZipEntry[];
    try {
      entries = new AdmZip(zip).getEntries();
    } catch (e: any) {
      this.logger.error(`ZIP corrupto (paquete ${packageId}): ${e?.message || e}`);
      return { storedRef, parsed: 0, skipped: 0, total: 0 };
    }

    const xmls = entries.filter((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith('.xml'));
    let parsed = 0, skipped = 0;
    let batch: any[] = [];
    let linkBatch: any[] = [];

    const flush = async () => {
      if (batch.length) {
        const rows = batch; batch = [];
        await this.tk.run(tenantId, async (trx) =>
          trx('fiscal.cfdis').insert(rows).onConflict(['tenant_id', 'uuid']).ignore());
      }
      if (linkBatch.length) {
        const rows = linkBatch; linkBatch = [];
        await this.tk.run(tenantId, async (trx) =>
          trx('fiscal.cfdi_payment_links').insert(rows).onConflict(['tenant_id', 'rep_uuid', 'docto_uuid', 'num_parcialidad']).ignore());
      }
    };

    for (const e of xmls) {
      let h: CfdiHeader | null = null;
      try { h = this.parser.parse(e.getData().toString('utf8')); }
      catch { h = null; }
      if (!h) { skipped++; continue; }
      batch.push(this.toRow(tenantId, requestId, packageId, rol, e.entryName, h));
      if (h.pagos?.length) for (const pl of h.pagos) linkBatch.push(this.toLinkRow(tenantId, h.uuid, pl));
      parsed++;
      if (batch.length >= this.CHUNK) await flush();
    }
    await flush();

    this.logger.log(`Paquete ${packageId}: ${parsed} CFDI parseados, ${skipped} omitidos de ${xmls.length} XML.`);
    return { storedRef, parsed, skipped, total: xmls.length };
  }

  private toRow(tenantId: string, requestId: string, packageId: string, rol: string | null, entryName: string, h: CfdiHeader) {
    return {
      tenant_id: tenantId,
      uuid: h.uuid,
      version: h.version,
      tipo_comprobante: h.tipoComprobante,
      serie: h.serie,
      folio: h.folio,
      fecha: h.fecha,
      fecha_timbrado: h.fechaTimbrado,
      emisor_rfc: h.emisorRfc,
      emisor_nombre: h.emisorNombre,
      emisor_regimen: h.emisorRegimen,
      receptor_rfc: h.receptorRfc,
      receptor_nombre: h.receptorNombre,
      receptor_uso_cfdi: h.receptorUsoCfdi,
      receptor_regimen: h.receptorRegimen,
      receptor_domicilio: h.receptorDomicilio,
      subtotal: h.subtotal,
      descuento: h.descuento,
      total: h.total,
      moneda: h.moneda,
      tipo_cambio: h.tipoCambio,
      metodo_pago: h.metodoPago,
      forma_pago: h.formaPago,
      lugar_expedicion: h.lugarExpedicion,
      no_certificado: h.noCertificado,
      no_certificado_sat: h.noCertificadoSat,
      pac_rfc: h.pacRfc,
      total_trasladados: h.totalTrasladados,
      total_retenidos: h.totalRetenidos,
      conceptos_count: h.conceptosCount,
      impuestos: h.impuestos == null ? null : JSON.stringify(h.impuestos),
      raw: JSON.stringify({ ...h, pagos: undefined, impuestos: undefined }), // los pagos van a su tabla; impuestos ya en su columna
      rol,
      source: 'descarga_masiva',
      request_id: requestId,
      package_id: packageId,
      stored_ref: entryName,
    };
  }

  private toLinkRow(tenantId: string, repUuid: string, pl: import('./cfdi.types').CfdiPaymentLink) {
    return {
      tenant_id: tenantId,
      rep_uuid: repUuid,
      docto_uuid: pl.doctoUuid,
      fecha_pago: pl.fechaPago,
      forma_pago: pl.formaPago,
      moneda: pl.moneda,
      // NumParcialidad es requerido por el SAT (≥1); default 1 para que el UNIQUE
      // deduplique en re-ingesta (Postgres trata NULLs como distintos).
      num_parcialidad: pl.numParcialidad ?? 1,
      imp_saldo_ant: pl.impSaldoAnt,
      imp_pagado: pl.impPagado,
      imp_saldo_insoluto: pl.impSaldoInsoluto,
    };
  }
}
