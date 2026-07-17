import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CfdiParserService } from '../cfdi/cfdi-parser.service';
import { CfdiHeader } from '../cfdi/cfdi.types';
import { PAC_PORT, PacPort, PacStampResult } from './pac.port';
import { ConceptoInput, EmitirFacturaInput, IssuerConfigInput, NotaCreditoInput, RepInput } from './emision.types';
import { EmissionErrorsService, EmissionErrorCtx } from './emission-errors.service';

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
    private readonly errors: EmissionErrorsService,
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
    const ctx = this.emitErrorCtx(input, serie, folio, computed);
    let stamp: PacStampResult;
    try {
      stamp = await this.pac.stamp(cfdiJson);
    } catch (e) {
      await this.errors.record(tenantId, ctx, e);
      throw e;
    }

    // 3) Persistir la emitida
    await this.persist(tenantId, issuer, input, serie, folio, computed, stamp);
    await this.errors.resolve(tenantId, ctx.dedup_key);

    return {
      uuid: stamp.uuid, serie, folio,
      subtotal: computed.subtotal, iva: computed.totalTraslados, total: computed.total,
      fecha_timbrado: stamp.fecha_timbrado, provider: this.pac.provider,
    };
  }

  /** FD.0 — Contexto de captura del error de emisión (kind + dedup_key estable). */
  private emitErrorCtx(input: EmitirFacturaInput, serie: string, folio: string, c: Computed): EmissionErrorCtx {
    const isNC = input.tipo_comprobante === 'E' && !!input.relacionados?.uuids?.length;
    const receptorRfc = input.tipo === 'global' ? 'XAXX010101000' : input.receptor?.rfc?.toUpperCase() || null;
    const receptorNombre = input.tipo === 'global' ? 'PUBLICO EN GENERAL' : input.receptor?.nombre || null;
    if (isNC) {
      const orig = String(input.relacionados!.uuids[0]).toUpperCase();
      return {
        kind: 'nota_credito', dedup_key: `nota_credito:${orig}`, cfdi_uuid: orig,
        receptor_rfc: receptorRfc, receptor_nombre: receptorNombre, serie, folio, total: c.total,
      };
    }
    const dedup = input.order_id
      ? `timbrado:order:${input.order_id}`
      : `timbrado:manual:${receptorRfc || '?'}:${c.total}`;
    return {
      kind: 'timbrado', dedup_key: dedup, order_id: input.order_id || null,
      receptor_rfc: receptorRfc, receptor_nombre: receptorNombre, serie, folio, total: c.total,
    };
  }

  /**
   * FE.12 — Nota de crédito (Egreso) sobre un CFDI emitido. Deriva el receptor del
   * original (RFC/nombre EXACTOS, requisito SAT) y timbra TipoDeComprobante 'E' con
   * CfdiRelacionados TipoRelacion '01'. Reusa el motor de `emitir`.
   */
  async emitirNotaCredito(uuidOriginal: string, input: NotaCreditoInput) {
    if (!input?.conceptos?.length) throw new BadRequestException('La nota de crédito requiere al menos un concepto.');
    const u = uuidOriginal.toUpperCase();
    const original = await this.tk.run(async (trx) =>
      trx('fiscal.cfdis').where({ uuid: u, rol: 'emitidas' }).first());
    if (!original) throw new NotFoundException('Factura original no encontrada.');
    if (original.tipo_comprobante === 'E') throw new BadRequestException('No se emite nota de crédito sobre otra nota de crédito.');
    if (original.estatus_sat === 'cancelado') throw new BadRequestException('La factura original está cancelada.');

    const receptor = {
      rfc: original.receptor_rfc,
      nombre: original.receptor_nombre,
      regimen_fiscal: original.receptor_regimen || '616',
      domicilio_cp: original.receptor_domicilio || original.lugar_expedicion,
      uso_cfdi: original.receptor_uso_cfdi || 'S01',
    };
    return this.emitir({
      tipo: 'nominativa',
      tipo_comprobante: 'E',
      relacionados: { tipo_relacion: '01', uuids: [u] },
      emisor_rfc: input.emisor_rfc || original.emisor_rfc,
      serie: input.serie,
      forma_pago: input.forma_pago || original.forma_pago || '01',
      metodo_pago: input.metodo_pago || original.metodo_pago || 'PUE',
      moneda: original.moneda || 'MXN',
      receptor,
      conceptos: input.conceptos,
    });
  }

  /**
   * FE.8 — Complemento de Pago (REP). Emite un CFDI tipo 'P' con Pagos 2.0 sobre una
   * factura PPD. Resuelve la factura original por UUID (serie/folio/receptor/moneda).
   * Devuelve null si la factura NO es PPD (PUE no lleva REP). El monto del pago
   * incluye IVA 16%: base = monto/1.16 (caso común MXN + tasa 16%).
   */
  async emitirRep(input: RepInput) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!(Number(input?.monto) > 0)) throw new BadRequestException('monto del pago debe ser > 0');
    const u = String(input.cfdi_uuid || '').toUpperCase();
    const original = await this.tk.run(async (trx) =>
      trx('fiscal.cfdis').where({ uuid: u, rol: 'emitidas' }).first());
    if (!original) throw new NotFoundException('Factura original no encontrada.');
    if (original.metodo_pago !== 'PPD') return null; // PUE no requiere REP
    if (original.estatus_sat === 'cancelado') throw new BadRequestException('La factura original está cancelada.');

    const { issuer, serie, folio } = await this.tk.run(tenantId, async (trx) => {
      const iss = await this.resolveIssuer(trx, input.emisor_rfc || original.emisor_rfc);
      if (!iss) throw new BadRequestException('No hay emisor configurado.');
      const s = (input.serie || 'P').toUpperCase();
      const f = await this.nextFolio(trx, tenantId, s);
      return { issuer: iss, serie: s, folio: f };
    });

    const json = this.buildRepJson(issuer, original, input, serie, folio);
    const dedup = `rep:${u}:${Number(input.num_parcialidad) || 1}`;
    let stamp: PacStampResult;
    try {
      stamp = await this.pac.stamp(json);
    } catch (e) {
      await this.errors.record(tenantId, {
        kind: 'rep', dedup_key: dedup, cfdi_uuid: u, serie, folio,
        receptor_rfc: original.receptor_rfc, receptor_nombre: original.receptor_nombre,
        total: this.round2(input.monto), num_parcialidad: Number(input.num_parcialidad) || 1,
      }, e);
      throw e;
    }
    await this.persistStamp(tenantId, stamp, () => this.repFallbackRow(tenantId, issuer, original, serie, folio, stamp));
    await this.errors.resolve(tenantId, dedup);
    return { uuid: stamp.uuid, serie, folio, monto: this.round2(input.monto), provider: this.pac.provider };
  }

  private buildRepJson(issuer: any, original: any, input: RepInput, serie: string, folio: string): any {
    const fecha = this.mxNow();
    const fechaPago = input.fecha_pago || fecha;
    const monto = this.round2(input.monto);
    const base = this.round2(monto / 1.16);
    const iva = this.round2(monto - base);
    const cp = original.receptor_domicilio || issuer.cp;
    const doctoRel: any = {
      IdDocumento: original.uuid,
      MonedaDR: 'MXN',
      NumParcialidad: String(input.num_parcialidad || 1),
      ImpSaldoAnt: this.round2(input.imp_saldo_ant).toFixed(2),
      ImpPagado: monto.toFixed(2),
      ImpSaldoInsoluto: this.round2(input.imp_saldo_insoluto).toFixed(2),
      ObjetoImpDR: '02',
      ImpuestosDR: {
        TrasladosDR: [{ BaseDR: base.toFixed(2), ImpuestoDR: '002', TipoFactorDR: 'Tasa', TasaOCuotaDR: '0.160000', ImporteDR: iva.toFixed(2) }],
      },
    };
    if (original.serie) doctoRel.Serie = original.serie;
    if (original.folio) doctoRel.Folio = original.folio;

    return {
      Version: '4.0', Serie: serie, Folio: folio, Fecha: fecha,
      Sello: '', NoCertificado: '', Certificado: '',
      SubTotal: '0', Moneda: 'XXX', Total: '0',
      TipoDeComprobante: 'P', Exportacion: '01', LugarExpedicion: issuer.cp,
      Emisor: { Rfc: issuer.rfc, Nombre: issuer.tax_name, RegimenFiscal: issuer.regimen_fiscal },
      Receptor: {
        Rfc: original.receptor_rfc, Nombre: original.receptor_nombre,
        DomicilioFiscalReceptor: cp, RegimenFiscalReceptor: original.receptor_regimen || '616', UsoCFDI: 'CP01',
      },
      Conceptos: [{
        ClaveProdServ: '84111506', Cantidad: '1', ClaveUnidad: 'ACT',
        Descripcion: 'Pago', ValorUnitario: '0', Importe: '0', ObjetoImp: '01',
      }],
      Complemento: {
        Pagos: {
          Version: '2.0',
          Totales: {
            TotalTrasladosBaseIVA16: base.toFixed(2),
            TotalTrasladosImpuestoIVA16: iva.toFixed(2),
            MontoTotalPagos: monto.toFixed(2),
          },
          Pago: [{
            FechaPago: fechaPago, FormaDePagoP: input.forma_pago || '99', MonedaP: 'MXN', Monto: monto.toFixed(2),
            DoctoRelacionado: [doctoRel],
          }],
        },
      },
    };
  }

  /** Fila mínima para persistir un REP si el parser no puede leer el XML tipo 'P'. */
  private repFallbackRow(tenantId: string, issuer: any, original: any, serie: string, folio: string, stamp: PacStampResult) {
    return {
      tenant_id: tenantId, uuid: (stamp.uuid || '').toUpperCase(), version: '4.0', tipo_comprobante: 'P',
      serie, folio, fecha: stamp.fecha_timbrado ? new Date(stamp.fecha_timbrado) : new Date(),
      fecha_timbrado: stamp.fecha_timbrado ? new Date(stamp.fecha_timbrado) : new Date(),
      emisor_rfc: issuer.rfc, emisor_nombre: issuer.tax_name, emisor_regimen: issuer.regimen_fiscal,
      receptor_rfc: original.receptor_rfc, receptor_nombre: original.receptor_nombre,
      subtotal: 0, total: 0, moneda: 'XXX', metodo_pago: null, forma_pago: null,
      lugar_expedicion: issuer.cp, no_certificado_sat: stamp.no_certificado_sat,
      xml: stamp.xml ?? null, rol: 'emitidas', source: 'manual', estatus_sat: 'vigente', estatus_checked_at: new Date(),
    };
  }

  /** Persiste una emitida a partir del stamp: parsea el XML si puede, si no usa el fallback. */
  private async persistStamp(tenantId: string, stamp: PacStampResult, fallback: () => any) {
    let header: CfdiHeader | null = null;
    if (stamp.xml) { try { header = this.parser.parse(stamp.xml); } catch { header = null; } }
    const row = header ? this.rowFromHeader(tenantId, header, stamp) : fallback();
    await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis').insert(row).onConflict(['tenant_id', 'uuid']).ignore());
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
          'subtotal', 'total_trasladados', 'total', 'metodo_pago', 'forma_pago', 'estatus_sat', 'source', 'tipo_comprobante')
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

  /**
   * FE.10 — Cancelación completa. Valida el motivo (01 exige UUID de sustitución),
   * pide la cancelación al PAC, guarda el acuse + motivo + sustitución y fija el
   * estatus real (cancelado / en_proceso_cancelacion). Intenta confirmar contra el
   * SAT con status() para resolver "en proceso" → "cancelado" cuando aplica.
   */
  async cancelar(uuid: string, motivo?: string, folioSustitucion?: string, reason?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const mot = (motivo || '02').trim();
    if (!['01', '02', '03', '04'].includes(mot)) {
      throw new BadRequestException('Motivo inválido. Usa 01, 02, 03 o 04.');
    }
    const sustit = mot === '01' ? (folioSustitucion || '').trim().toUpperCase() : undefined;
    if (mot === '01' && !/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(sustit || '')) {
      throw new BadRequestException('El motivo 01 requiere el UUID del CFDI que sustituye (folioSustitucion).');
    }

    const row = await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis').where({ uuid: uuid.toUpperCase(), rol: 'emitidas' }).first());
    if (!row) throw new NotFoundException('Factura no encontrada.');
    if (row.estatus_sat === 'cancelado') {
      return { uuid: row.uuid, estatus_sat: 'cancelado', acuse: row.cancel_acuse, already: true };
    }

    const cancelDedup = `cancelacion:${row.uuid}`;
    let result;
    try {
      result = await this.pac.cancel({ uuid: row.uuid, rfc: row.emisor_rfc, motivo: mot, folioSustitucion: sustit });
    } catch (e) {
      await this.errors.record(tenantId, {
        kind: 'cancelacion', dedup_key: cancelDedup, cfdi_uuid: row.uuid,
        receptor_rfc: row.receptor_rfc, receptor_nombre: row.receptor_nombre, total: row.total,
      }, e);
      throw e;
    }

    // Confirmar contra el SAT (best-effort): resuelve "en proceso" → "cancelado".
    let estatus = result.estatus;
    if (estatus === 'en_proceso_cancelacion') {
      const st = await this.pac.status({
        uuid: row.uuid, emisorRfc: row.emisor_rfc, receptorRfc: row.receptor_rfc, total: row.total,
      });
      if (st?.estado && /cancel/i.test(st.estado)) estatus = 'cancelado';
    }
    const estatusSat = estatus === 'cancelado' ? 'cancelado'
      : estatus === 'en_proceso_cancelacion' ? 'en_proceso_cancelacion' : row.estatus_sat;

    await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis').where({ uuid: row.uuid }).update({
        estatus_sat: estatusSat,
        estatus_checked_at: trx.fn.now(),
        cancel_motivo: mot,
        cancel_sustitucion_uuid: sustit || null,
        cancel_reason: reason || null,
        cancel_requested_at: trx.fn.now(),
        cancel_acuse: result.acuse || null,
        updated_at: trx.fn.now(),
      }));
    await this.errors.resolve(tenantId, cancelDedup);
    return { uuid: row.uuid, estatus_sat: estatusSat, motivo: mot, acuse: result.acuse, codes: result.codes };
  }

  /** FE.10 — Consulta el estatus del CFDI ante el SAT y actualiza la fila. */
  async consultarEstatus(uuid: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const row = await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis').where({ uuid: uuid.toUpperCase(), rol: 'emitidas' }).first());
    if (!row) throw new NotFoundException('Factura no encontrada.');
    const st = await this.pac.status({
      uuid: row.uuid, emisorRfc: row.emisor_rfc, receptorRfc: row.receptor_rfc, total: row.total,
    });
    if (!st) return { uuid: row.uuid, estatus_sat: row.estatus_sat, sat: null, checked: false };
    const estatusSat = st.estado && /cancel/i.test(st.estado) ? 'cancelado'
      : /en proceso/i.test(st.estatus_cancelacion || '') ? 'en_proceso_cancelacion'
      : st.estado && /vigente/i.test(st.estado) ? 'vigente' : row.estatus_sat;
    await this.tk.run(tenantId, async (trx) =>
      trx('fiscal.cfdis').where({ uuid: row.uuid }).update({ estatus_sat: estatusSat, estatus_checked_at: trx.fn.now(), updated_at: trx.fn.now() }));
    return { uuid: row.uuid, estatus_sat: estatusSat, sat: st, checked: true };
  }

  /** FE.10 — Acuse de cancelación del SAT (XML/base64) persistido al cancelar. */
  async getAcuse(uuid: string): Promise<string> {
    const row = await this.tk.run(async (trx) =>
      trx('fiscal.cfdis').where({ uuid: uuid.toUpperCase(), rol: 'emitidas' }).select('cancel_acuse').first());
    if (!row?.cancel_acuse) throw new NotFoundException('No hay acuse de cancelación para esta factura.');
    return row.cancel_acuse;
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

    const tipoComprobante = input.tipo_comprobante || 'I';
    const json: any = {
      Version: '4.0', Serie: serie, Folio: folio, Fecha: fecha,
      FormaPago: input.forma_pago || '01', MetodoPago: input.metodo_pago || 'PUE',
      Sello: '', NoCertificado: '', Certificado: '',
      SubTotal: c.subtotal.toFixed(2),
      Moneda: input.moneda || 'MXN',
      Total: c.total.toFixed(2),
      TipoDeComprobante: tipoComprobante, Exportacion: '01', LugarExpedicion: cp,
      Emisor: { Rfc: issuer.rfc, Nombre: issuer.tax_name, RegimenFiscal: issuer.regimen_fiscal },
      Receptor: receptor,
      Conceptos: conceptos,
    };
    // FE.12 — CFDI relacionados (nota de crédito = TipoRelacion 01 al UUID original).
    if (input.relacionados?.uuids?.length) {
      json.CfdiRelacionados = [{
        TipoRelacion: input.relacionados.tipo_relacion || '01',
        CfdiRelacionado: input.relacionados.uuids.map((u) => ({ Uuid: String(u).toUpperCase() })),
      }];
    }
    if (c.descuentoTotal > 0) json.Descuento = c.descuentoTotal.toFixed(2);
    // InformaciónGlobal solo aplica a Ingreso a público general (no a Egreso).
    if (input.tipo === 'global' && tipoComprobante === 'I') {
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
