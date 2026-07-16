import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CfdiParserService } from '../cfdi/cfdi-parser.service';
import { CfdiHeader } from '../cfdi/cfdi.types';
import { PAC_PORT, PacPort, PacStampResult } from './pac.port';
import { ConceptoInput, EmitirFacturaInput, IssuerConfigInput } from './emision.types';

interface ComputedConcepto extends ConceptoInput {
  cantidadN: number; valorN: number; descuentoN: number;
  importe: number; objetoImp: string; tasa: number; base: number; iva: number;
}
interface Computed {
  conceptos: ComputedConcepto[];
  subtotal: number; descuentoTotal: number; totalTraslados: number; total: number;
  traslados: { base: number; importe: number; tasa: number }[];
}

/**
 * FE.2 — Emisión/timbrado de facturas CFDI 4.0.
 * Motor determinista arma el JSON del comprobante; el PAC (puerto `PAC_PORT`,
 * SW por defecto) sella+timbra. La emitida se persiste en `fiscal.cfdis`
 * (rol=emitidas, source=manual) reusando el parser del almacén.
 */
@Injectable()
export class EmisionService {
  private readonly logger = new Logger(EmisionService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    @Inject(PAC_PORT) private readonly pac: PacPort,
    private readonly parser: CfdiParserService,
  ) {}

  // ── Configuración del emisor ────────────────────────────────────────────
  listIssuers() {
    return this.tk.run(async (trx) =>
      trx('fiscal.issuer_config').where('active', true).orderBy('is_default', 'desc').orderBy('created_at'));
  }

  async upsertIssuer(input: IssuerConfigInput) {
    const tenantId = this.tenantCtx.requireTenantId();
    const rfc = input.rfc.toUpperCase().trim();
    return this.tk.run(tenantId, async (trx) => {
      if (input.is_default) {
        await trx('fiscal.issuer_config').update({ is_default: false, updated_at: trx.fn.now() });
      }
      const row = {
        tenant_id: tenantId, rfc,
        tax_name: input.tax_name.trim(),
        regimen_fiscal: input.regimen_fiscal.trim(),
        cp: input.cp.trim(),
        serie: input.serie?.trim() || null,
        pac_provider: input.pac_provider?.trim() || 'sw',
        is_default: !!input.is_default,
        active: true,
        updated_at: trx.fn.now(),
      };
      const [saved] = await trx('fiscal.issuer_config')
        .insert(row)
        .onConflict(['tenant_id', 'rfc'])
        .merge()
        .returning('*');
      return saved;
    });
  }

  private async resolveIssuer(trx: any, rfc?: string) {
    const q = trx('fiscal.issuer_config').where('active', true);
    if (rfc) return q.where('rfc', rfc.toUpperCase()).first();
    return (await q.clone().where('is_default', true).first()) || (await q.clone().orderBy('created_at').first());
  }

  // ── Emisión ─────────────────────────────────────────────────────────────
  async emitir(input: EmitirFacturaInput) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!input?.conceptos?.length) throw new BadRequestException('Se requiere al menos un concepto.');
    if (input.tipo === 'nominativa' && !input.receptor) {
      throw new BadRequestException('La factura nominativa requiere datos del receptor.');
    }

    // 1) Emisor + folio (transacción corta: no cruzamos la red con la trx abierta)
    const { issuer, serie, folio } = await this.tk.run(tenantId, async (trx) => {
      const iss = await this.resolveIssuer(trx, input.emisor_rfc);
      if (!iss) throw new BadRequestException('No hay emisor configurado. Configura el emisor en Facturación → Emisor.');
      const s = (input.serie || iss.serie || 'A').toUpperCase();
      const f = await this.nextFolio(trx, tenantId, s);
      return { issuer: iss, serie: s, folio: f };
    });

    // 2) Armar + timbrar
    const computed = this.computeConceptos(input.conceptos);
    const cfdiJson = this.buildCfdiJson(issuer, input, serie, folio, computed);
    const stamp = await this.pac.stamp(cfdiJson);

    // 3) Persistir la emitida
    await this.persist(tenantId, issuer, input, serie, folio, computed, stamp);

    return {
      uuid: stamp.uuid, serie, folio,
      subtotal: computed.subtotal, iva: computed.totalTraslados, total: computed.total,
      fecha_timbrado: stamp.fecha_timbrado, provider: this.pac.provider,
    };
  }

  private async nextFolio(trx: any, tenantId: string, serie: string): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await trx
      .raw(
        `INSERT INTO fiscal.invoice_sequences (tenant_id, serie, year, current_value)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (tenant_id, serie, year) DO UPDATE
           SET current_value = fiscal.invoice_sequences.current_value + 1, updated_at = now()
         RETURNING current_value`,
        [tenantId, serie, year],
      )
      .then((r: any) => r.rows);
    return String(rows[0].current_value);
  }

  // ── Consulta de emitidas ─────────────────────────────────────────────────
  listEmitidas(f: { from?: string; to?: string; search?: string; limit?: number; offset?: number }) {
    const limit = Math.min(Number(f.limit) || 50, 500);
    const offset = Number(f.offset) || 0;
    return this.tk.run(async (trx) => {
      const q = trx('fiscal.cfdis').where('rol', 'emitidas').modify((b: any) => {
        if (f.from) b.where('fecha', '>=', f.from);
        if (f.to) b.where('fecha', '<=', `${f.to} 23:59:59`);
        if (f.search) {
          const s = `%${f.search}%`;
          b.where((w: any) => w.whereILike('receptor_nombre', s).orWhereILike('uuid', s).orWhereILike('folio', s));
        }
      });
      const [{ count }] = await q.clone().count<{ count: string }[]>('* as count');
      const rows = await q
        .select('id', 'uuid', 'serie', 'folio', 'fecha', 'fecha_timbrado', 'receptor_rfc', 'receptor_nombre',
          'subtotal', 'total_trasladados', 'total', 'metodo_pago', 'forma_pago', 'estatus_sat', 'source')
        .orderBy('fecha', 'desc').limit(limit).offset(offset);
      return { total: Number(count), limit, offset, rows };
    });
  }

  async getXml(uuid: string): Promise<string> {
    const row = await this.tk.run(async (trx) =>
      trx('fiscal.cfdis').where({ uuid: uuid.toUpperCase(), rol: 'emitidas' }).select('xml').first());
    if (!row?.xml) throw new NotFoundException('XML no disponible para esta factura.');
    return row.xml;
  }

  /** PDF (representación impresa, base64). Lo cachea en fiscal.cfdis.pdf al generarlo. */
  async getPdf(uuid: string): Promise<string> {
    const u = uuid.toUpperCase();
    const row = await this.tk.run(async (trx) =>
      trx('fiscal.cfdis').where({ uuid: u, rol: 'emitidas' }).select('pdf', 'xml').first());
    if (!row) throw new NotFoundException('Factura no encontrada.');
    if (row.pdf) return row.pdf;
    if (!row.xml) throw new NotFoundException('No hay XML para generar el PDF.');
    const b64 = await this.pac.pdf(row.xml);
    if (!b64) throw new ServiceUnavailableException('El PAC no pudo generar el PDF.');
    await this.tk.run(async (trx) =>
      trx('fiscal.cfdis').where({ uuid: u }).update({ pdf: b64, updated_at: trx.fn.now() }));
    return b64;
  }

  async cancelar(uuid: string, motivo?: string, folioSustitucion?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const row = await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis').where({ uuid: uuid.toUpperCase(), rol: 'emitidas' }).first());
    if (!row) throw new NotFoundException('Factura no encontrada.');
    const result = await this.pac.cancel({ uuid: row.uuid, rfc: row.emisor_rfc, motivo, folioSustitucion });
    await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis').where({ uuid: row.uuid }).update({ estatus_sat: 'cancelado', estatus_checked_at: trx.fn.now(), updated_at: trx.fn.now() }));
    return { uuid: row.uuid, estatus_sat: 'cancelado', acuse: result };
  }

  // ── Motor de cálculo + armado del CFDI ───────────────────────────────────
  private round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

  private computeConceptos(items: ConceptoInput[]): Computed {
    const conceptos: ComputedConcepto[] = items.map((c) => {
      const cantidadN = Number(c.cantidad);
      const valorN = Number(c.valor_unitario);
      const descuentoN = this.round2(c.descuento || 0);
      const importe = this.round2(cantidadN * valorN);
      const objetoImp = c.objeto_imp || '02';
      const tasa = objetoImp === '02' ? (c.tasa_iva ?? 0.16) : 0;
      const base = this.round2(importe - descuentoN);
      const iva = this.round2(base * tasa);
      return { ...c, cantidadN, valorN, descuentoN, importe, objetoImp, tasa, base, iva };
    });
    const subtotal = this.round2(conceptos.reduce((s, c) => s + c.importe, 0));
    const descuentoTotal = this.round2(conceptos.reduce((s, c) => s + c.descuentoN, 0));
    const totalTraslados = this.round2(conceptos.reduce((s, c) => s + c.iva, 0));
    const total = this.round2(subtotal - descuentoTotal + totalTraslados);

    const byTasa = new Map<string, { base: number; importe: number; tasa: number }>();
    for (const c of conceptos) {
      if (c.objetoImp !== '02') continue;
      const key = c.tasa.toFixed(6);
      const g = byTasa.get(key) || { base: 0, importe: 0, tasa: c.tasa };
      g.base = this.round2(g.base + c.base);
      g.importe = this.round2(g.importe + c.iva);
      byTasa.set(key, g);
    }
    return { conceptos, subtotal, descuentoTotal, totalTraslados, total, traslados: [...byTasa.values()] };
  }

  private buildCfdiJson(issuer: any, input: EmitirFacturaInput, serie: string, folio: string, c: Computed): any {
    const fecha = this.mxNow();
    const cp = issuer.cp;
    const conceptos = c.conceptos.map((x) => {
      const node: any = {
        ClaveProdServ: x.clave_prod_serv || '01010101',
        Cantidad: String(x.cantidadN),
        ClaveUnidad: x.clave_unidad || 'H87',
        Unidad: x.unidad || 'Pieza',
        Descripcion: x.descripcion,
        ValorUnitario: x.valorN.toFixed(2),
        Importe: x.importe.toFixed(2),
        ObjetoImp: x.objetoImp,
      };
      if (x.no_identificacion) node.NoIdentificacion = x.no_identificacion;
      if (x.descuentoN > 0) node.Descuento = x.descuentoN.toFixed(2);
      if (x.objetoImp === '02') {
        node.Impuestos = {
          Traslados: [{ Base: x.base.toFixed(2), Importe: x.iva.toFixed(2), Impuesto: '002', TasaOCuota: x.tasa.toFixed(6), TipoFactor: 'Tasa' }],
        };
      }
      return node;
    });

    const receptor = input.tipo === 'global'
      ? { Rfc: 'XAXX010101000', Nombre: 'PUBLICO EN GENERAL', DomicilioFiscalReceptor: cp, RegimenFiscalReceptor: '616', UsoCFDI: 'S01' }
      : {
          Rfc: input.receptor!.rfc.toUpperCase(),
          Nombre: input.receptor!.nombre,
          DomicilioFiscalReceptor: input.receptor!.domicilio_cp,
          RegimenFiscalReceptor: input.receptor!.regimen_fiscal,
          UsoCFDI: input.receptor!.uso_cfdi,
        };

    const json: any = {
      Version: '4.0', Serie: serie, Folio: folio, Fecha: fecha,
      FormaPago: input.forma_pago || '01', MetodoPago: input.metodo_pago || 'PUE',
      Sello: '', NoCertificado: '', Certificado: '',
      SubTotal: c.subtotal.toFixed(2),
      Moneda: input.moneda || 'MXN',
      Total: c.total.toFixed(2),
      TipoDeComprobante: 'I', Exportacion: '01', LugarExpedicion: cp,
      Emisor: { Rfc: issuer.rfc, Nombre: issuer.tax_name, RegimenFiscal: issuer.regimen_fiscal },
      Receptor: receptor,
      Conceptos: conceptos,
    };
    if (c.descuentoTotal > 0) json.Descuento = c.descuentoTotal.toFixed(2);
    if (input.tipo === 'global') {
      json.InformacionGlobal = { Periodicidad: input.periodicidad || '01', Meses: fecha.slice(5, 7), 'Año': fecha.slice(0, 4) };
    }
    if (c.totalTraslados > 0) {
      json.Impuestos = {
        TotalImpuestosTrasladados: c.totalTraslados.toFixed(2),
        Traslados: c.traslados.map((t) => ({ Base: t.base.toFixed(2), Importe: t.importe.toFixed(2), Impuesto: '002', TasaOCuota: t.tasa.toFixed(6), TipoFactor: 'Tasa' })),
      };
    }
    return json;
  }

  // ── Persistencia ──────────────────────────────────────────────────────────
  private async persist(tenantId: string, issuer: any, input: EmitirFacturaInput, serie: string, folio: string, c: Computed, stamp: PacStampResult) {
    let header: CfdiHeader | null = null;
    if (stamp.xml) { try { header = this.parser.parse(stamp.xml); } catch { header = null; } }
    const row = header
      ? this.rowFromHeader(tenantId, header, stamp)
      : this.rowFallback(tenantId, issuer, input, serie, folio, c, stamp);
    await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis').insert(row).onConflict(['tenant_id', 'uuid']).ignore());
  }

  private rowFromHeader(tenantId: string, h: CfdiHeader, stamp: PacStampResult) {
    return {
      tenant_id: tenantId, uuid: h.uuid, version: h.version, tipo_comprobante: h.tipoComprobante,
      serie: h.serie, folio: h.folio, fecha: h.fecha, fecha_timbrado: h.fechaTimbrado,
      emisor_rfc: h.emisorRfc, emisor_nombre: h.emisorNombre, emisor_regimen: h.emisorRegimen,
      receptor_rfc: h.receptorRfc, receptor_nombre: h.receptorNombre, receptor_uso_cfdi: h.receptorUsoCfdi,
      receptor_regimen: h.receptorRegimen, receptor_domicilio: h.receptorDomicilio,
      subtotal: h.subtotal, descuento: h.descuento, total: h.total, moneda: h.moneda, tipo_cambio: h.tipoCambio,
      metodo_pago: h.metodoPago, forma_pago: h.formaPago, lugar_expedicion: h.lugarExpedicion,
      no_certificado: h.noCertificado, no_certificado_sat: h.noCertificadoSat, pac_rfc: h.pacRfc,
      total_trasladados: h.totalTrasladados, total_retenidos: h.totalRetenidos, conceptos_count: h.conceptosCount,
      impuestos: h.impuestos == null ? null : JSON.stringify(h.impuestos),
      raw: JSON.stringify({ ...h, pagos: undefined, impuestos: undefined }),
      xml: stamp.xml ?? null,
      rol: 'emitidas', source: 'manual',
      estatus_sat: 'vigente', estatus_checked_at: new Date(),
    };
  }

  private rowFallback(tenantId: string, issuer: any, input: EmitirFacturaInput, serie: string, folio: string, c: Computed, stamp: PacStampResult) {
    const receptorRfc = input.tipo === 'global' ? 'XAXX010101000' : input.receptor!.rfc.toUpperCase();
    const receptorNombre = input.tipo === 'global' ? 'PUBLICO EN GENERAL' : input.receptor!.nombre;
    return {
      tenant_id: tenantId, uuid: (stamp.uuid || '').toUpperCase(), version: '4.0', tipo_comprobante: 'I',
      serie, folio, fecha: stamp.fecha_timbrado ? new Date(stamp.fecha_timbrado) : new Date(), fecha_timbrado: stamp.fecha_timbrado ? new Date(stamp.fecha_timbrado) : new Date(),
      emisor_rfc: issuer.rfc, emisor_nombre: issuer.tax_name, emisor_regimen: issuer.regimen_fiscal,
      receptor_rfc: receptorRfc, receptor_nombre: receptorNombre,
      subtotal: c.subtotal, descuento: c.descuentoTotal || null, total: c.total, moneda: input.moneda || 'MXN',
      metodo_pago: input.metodo_pago || 'PUE', forma_pago: input.forma_pago || '01', lugar_expedicion: issuer.cp,
      no_certificado_sat: stamp.no_certificado_sat, total_trasladados: c.totalTraslados, conceptos_count: c.conceptos.length,
      xml: stamp.xml ?? null, rol: 'emitidas', source: 'manual', estatus_sat: 'vigente', estatus_checked_at: new Date(),
    };
  }

  private mxNow(): string {
    const d = new Date(Date.now() - 120000);
    const p: any = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Mexico_City', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(d).map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  }
}
