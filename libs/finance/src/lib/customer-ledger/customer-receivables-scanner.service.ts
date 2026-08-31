import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB } from '@megadulces/platform-core';
import { FINANCE_FINDINGS_SINK_PORT, FinanceFindingsSinkPort, FinanceFindingInput, FinanceRuleInput } from '@megadulces/contracts';

/**
 * CXC.7 (ADR-048/028) — Detector de riesgo de cartera. Empuja hallazgos a la bandeja
 * unificada de Maat (`finance.findings`, vía FINANCE_FINDINGS_SINK_PORT) → se ven en
 * /finanzas/hallazgos. El motor detecta / el humano cobra (ADR-016). Read-only.
 *
 *   cxc_cliente_vencido = cliente con saldo VENCIDO material (aging por vencimiento kdue)
 *   cxc_sobre_limite     = saldo > límite de crédito (kdud.c15)
 *
 * Corre como postgres (KNEX_NEW_DB) con SET LOCAL app.tenant_id por tenant. Idempotente
 * (dedup_key por cliente). Toggle ENABLE_CXC_SCAN=false; endpoint /scan-now manual.
 */
const RULES: FinanceRuleInput[] = [
  { rule_key: 'cxc_cliente_vencido', nombre: 'Cliente con saldo vencido', descripcion: 'Cartera vencida material por cliente (aging kdue).', clase: 'riesgo', params: { min_vencido: 2000 } },
  { rule_key: 'cxc_sobre_limite', nombre: 'Cliente sobre su línea de crédito', descripcion: 'Saldo supera el límite de crédito de Kepler (kdud.c15).', clase: 'riesgo', params: {} },
  { rule_key: 'cxc_promesa_incumplida', nombre: 'Compromiso de pago incumplido', descripcion: 'El cliente no pagó en la fecha que se comprometió (CXC.13).', clase: 'riesgo', params: {} },
  { rule_key: 'cxc_embarcado_sin_facturar', nombre: 'Embarcado sin facturar', descripcion: 'Salió mercancía y no se generó el cargo: la factura no existe o quedó en $0.00. La cartera nunca lo va a reclamar.', clase: 'riesgo', params: { min_monto: 500 } },
  { rule_key: 'cxc_factura_duplicada', nombre: 'Embarque facturado dos veces', descripcion: 'Un solo embarque generó facturas por más del doble de lo que salió: la cartera le cobra al cliente algo que no debe.', clase: 'error_captura', params: {} },
  { rule_key: 'cxc_embarque_descuadrado', nombre: 'Embarque y factura no cuadran', descripcion: 'Lo facturado difiere de lo embarcado por encima de la tolerancia de redondeo.', clase: 'error_captura', params: { min_dif: 500 } },
];
const MIN_VENCIDO = 2000;    // pesos: piso para no ahogar la bandeja
const CRIT_VENCIDO = 20000;  // pesos: vencido crítico
const CRIT_DIAS = 60;        // días vencido crítico
const MIN_EMBARQUE = 500;    // pesos: piso del control embarcado-vs-facturado
const CRIT_EMBARQUE = 10000; // pesos: fuga crítica
const MIN_DIF_EMBARQUE = 500;// pesos: por debajo es redondeo por renglón (máximo real medido: $189)
const DIAS_EMBARQUE = 365;   // ventana: no resucitar embarques antiguos ya conciliados a mano

@Injectable()
export class CustomerReceivablesScannerService {
  private readonly logger = new Logger(CustomerReceivablesScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
  ) {}

  @Cron('0 30 8 * * *', { timeZone: 'America/Mexico_City' }) // 08:30 MX
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_CXC_SCAN === 'false') return;
    if (this.running) { this.logger.warn('Skip: scan en curso'); return; }
    await this.scanAll(); // snapshot siempre; findings solo si hay sink
  }

  async scanAll(): Promise<{ tenants: number; findings: number }> {
    this.running = true;
    let total = 0;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        await this.snapshotTenant(t.id).catch((e) => this.logger.warn(`snapshot ${t.id}: ${e.message}`));
        if (this.sink) total += await this.scanTenant(t.id);
      }
      this.logger.log(`CxC scan: ${tenants.length} tenants, ${total} hallazgos + snapshots`);
      return { tenants: tenants.length, findings: total };
    } finally { this.running = false; }
  }

  /** CXC.12 — captura el agregado de HOY (tenant × sucursal) para la tendencia. Idempotente por día. */
  async snapshotTenant(tenantId: string): Promise<number> {
    return this.knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
      const res = await trx.raw(
        `INSERT INTO analytics.customer_receivable_snapshots
           (tenant_id, snapshot_date, sucursal, saldo_total, vencido_total, n_clientes, por_vencer, d0_30, d31_60, d61_90, d90_plus, computed_at)
         SELECT ?::uuid, h.d, r.sucursal,
           COALESCE(round(sum(r.saldo_ajustado), 2), 0),
           COALESCE(round(sum(r.saldo_ajustado) FILTER (WHERE r.vencimiento < h.d), 2), 0),
           count(DISTINCT r.cliente_code),
           COALESCE(round(sum(r.saldo_ajustado) FILTER (WHERE r.vencimiento IS NULL OR r.vencimiento >= h.d), 2), 0),
           COALESCE(round(sum(r.saldo_ajustado) FILTER (WHERE r.vencimiento < h.d AND h.d - r.vencimiento <= 30), 2), 0),
           COALESCE(round(sum(r.saldo_ajustado) FILTER (WHERE h.d - r.vencimiento BETWEEN 31 AND 60), 2), 0),
           COALESCE(round(sum(r.saldo_ajustado) FILTER (WHERE h.d - r.vencimiento BETWEEN 61 AND 90), 2), 0),
           COALESCE(round(sum(r.saldo_ajustado) FILTER (WHERE h.d - r.vencimiento > 90), 2), 0),
           now()
         FROM analytics.customer_receivables r
         CROSS JOIN (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date d) h
         WHERE r.tenant_id = ?::uuid AND r.cargo_abono = 'C' AND r.saldo_ajustado > 0.005
         GROUP BY h.d, r.sucursal
         ON CONFLICT (tenant_id, snapshot_date, sucursal) DO UPDATE SET
           saldo_total=EXCLUDED.saldo_total, vencido_total=EXCLUDED.vencido_total, n_clientes=EXCLUDED.n_clientes,
           por_vencer=EXCLUDED.por_vencer, d0_30=EXCLUDED.d0_30, d31_60=EXCLUDED.d31_60, d61_90=EXCLUDED.d61_90,
           d90_plus=EXCLUDED.d90_plus, computed_at=now()`,
        [tenantId, tenantId]);
      return res.rowCount ?? 0;
    });
  }

  async scanTenant(tenantId: string): Promise<number> {
    if (!this.sink) return 0;
    const rows = await this.knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
      const hoy = (await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text d`)).rows[0].d;
      const r = await trx.raw(
        `SELECT r.sucursal, r.cliente_code, max(c.name) AS nombre, max(r.telefono) AS tel,
                max(r.limite_credito) AS limite, max(r.vendedor) AS vendedor, max(r.zona) AS zona,
                round(sum(r.saldo_ajustado), 2) AS saldo,
                round(sum(r.saldo_ajustado) FILTER (WHERE r.vencimiento < ?::date), 2) AS vencido,
                (min(r.vencimiento) FILTER (WHERE r.saldo_ajustado > 0.005 AND r.vencimiento < ?::date))::text AS oldest
           FROM analytics.customer_receivables r
           LEFT JOIN analytics.erp_customers c ON c.tenant_id = r.tenant_id AND c.erp_code = r.cliente_code
          WHERE r.tenant_id = ? AND r.cargo_abono = 'C'
            AND r.cliente_code NOT ILIKE '%CONTADO%'
            AND COALESCE(c.name, '') NOT ILIKE '%CONTADO%'
          GROUP BY r.sucursal, r.cliente_code
         HAVING sum(r.saldo_ajustado) > 0.005`,
        [hoy, hoy, tenantId]);
      return { hoy, data: r.rows };
    });

    const findings: FinanceFindingInput[] = [];
    for (const x of rows.data) {
      const saldo = Number(x.saldo) || 0;
      const vencido = Number(x.vencido) || 0;
      const limite = x.limite != null ? Number(x.limite) : 0;
      const nombre = x.nombre || x.cliente_code;
      const ent = { sucursal: x.sucursal, cliente_code: x.cliente_code, nombre, vendedor: x.vendedor, zona: x.zona, telefono: x.tel };
      // Regla 1: vencido material.
      if (vencido >= MIN_VENCIDO) {
        const dias = x.oldest ? Math.floor((Date.parse(rows.hoy) - Date.parse(String(x.oldest).slice(0, 10))) / 86400000) : 0;
        const crit = vencido >= CRIT_VENCIDO || dias >= CRIT_DIAS;
        findings.push({
          rule_key: 'cxc_cliente_vencido', clase: 'riesgo', severity: crit ? 'critical' : 'warn',
          score: Math.min(1, vencido / 100000),
          titulo: `${nombre}: ${this.mx(vencido)} vencido${dias ? ` (${dias}d)` : ''}`,
          resumen: `Sucursal ${x.sucursal}. Saldo ${this.mx(saldo)}, de los cuales ${this.mx(vencido)} está vencido${dias ? ` (la más vieja tiene ${dias} días)` : ''}.` + (x.tel ? ` Tel ${x.tel}.` : ''),
          entity: ent, periodo: null, importe: vencido,
          evidencia: { saldo, vencido, dias_max: dias, vendedor: x.vendedor },
          dedup_key: `cxc_vencido:${x.sucursal}:${x.cliente_code}`,
        });
      }
      // Regla 2: sobre su línea de crédito.
      if (limite > 0 && saldo > limite + 0.005) {
        const exceso = Math.round((saldo - limite) * 100) / 100;
        findings.push({
          rule_key: 'cxc_sobre_limite', clase: 'riesgo', severity: exceso > limite * 0.5 ? 'critical' : 'warn',
          score: Math.min(1, exceso / Math.max(limite, 1)),
          titulo: `${nombre}: sobre su línea (${this.mx(exceso)} de exceso)`,
          resumen: `Sucursal ${x.sucursal}. Saldo ${this.mx(saldo)} supera el límite de ${this.mx(limite)} en ${this.mx(exceso)}. Revisar antes de vender más a crédito.`,
          entity: ent, periodo: null, importe: exceso,
          evidencia: { saldo, limite, exceso, vendedor: x.vendedor },
          dedup_key: `cxc_sobrelimite:${x.sucursal}:${x.cliente_code}`,
        });
      }
    }
    // Promesas de pago vencidas sin cumplir → marca incumplida + hallazgo (CXC.13).
    try {
      const broken = await this.knex.transaction(async (trx) => {
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
        return (await trx.raw(
          `UPDATE finance.collection_promises
              SET estado = 'incumplida', updated_at = now()
            WHERE tenant_id = ?::uuid AND estado = 'abierta'
              AND fecha_promesa < (now() AT TIME ZONE 'America/Mexico_City')::date
          RETURNING sucursal, cliente_code, cliente_nombre, monto_prometido, fecha_promesa::text AS fecha_promesa`,
          [tenantId])).rows;
      });
      for (const b of broken) {
        findings.push({
          rule_key: 'cxc_promesa_incumplida', clase: 'riesgo', severity: 'critical',
          score: 0.9,
          titulo: `${b.cliente_nombre || b.cliente_code}: incumplió su compromiso (${this.mx(Number(b.monto_prometido))})`,
          resumen: `Sucursal ${b.sucursal}. Se comprometió a pagar ${this.mx(Number(b.monto_prometido))} el ${b.fecha_promesa} y no cumplió. Reactivar cobranza.`,
          entity: { sucursal: b.sucursal, cliente_code: b.cliente_code, nombre: b.cliente_nombre },
          periodo: null, importe: Number(b.monto_prometido) || 0,
          evidencia: { fecha_promesa: b.fecha_promesa },
          dedup_key: `cxc_promesa:${b.sucursal}:${b.cliente_code}:${b.fecha_promesa}`,
        });
      }
    } catch { /* tabla de promesas no migrada aún */ }

    findings.push(...await this.embarqueFindings(tenantId));

    if (!findings.length) return 0;
    const res = await this.sink.pushFindings(tenantId, findings, RULES);
    return res.inserted;
  }

  /**
   * Control **embarcado contra facturado** (`analytics.erp_shipment_billing`).
   *
   * `kdue` dice qué se debe; no dice qué DEBERÍA deberse. Si salió mercancía y nadie emitió el
   * cargo, la deuda no existe y la cobranza jamás la va a ver. Esto lo caza aguas arriba.
   *
   * Sólo mira la serie 01 (Embarque Telemarketing) de clientes reales: la serie 02 es traspaso
   * a sucursal y por diseño no factura, y en la suc 02 el embarque YA es el cargo en la cuenta
   * (`cargo_directo`) — meter esos sería inventar 1,094 hallazgos falsos.
   */
  private async embarqueFindings(tenantId: string): Promise<FinanceFindingInput[]> {
    const rows = await this.knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenantId]);
      return (await trx.raw(
        `SELECT sucursal, folio, folio_digital, fecha::text AS fecha, cliente_code, cliente_nombre,
                total_embarcado, n_facturas, total_facturado, diferencia, diagnostico, facturas
           FROM analytics.erp_shipment_billing
          WHERE tenant_id = ?::uuid AND serie = 1 AND NOT cuenta_interna
            AND fecha >= (now() AT TIME ZONE 'America/Mexico_City')::date - ?::int
            AND diagnostico IN ('sin_factura','facturado_en_cero','facturado_de_mas','diferencia')`,
        [tenantId, DIAS_EMBARQUE])).rows;
    }).catch((e) => { this.logger.warn(`embarques: ${e.message}`); return [] as any[]; });

    const out: FinanceFindingInput[] = [];
    for (const r of rows) {
      const emb = Number(r.total_embarcado) || 0;
      const fac = Number(r.total_facturado) || 0;
      const dif = Number(r.diferencia) || 0;
      const nombre = r.cliente_nombre || r.cliente_code;
      const ent = { sucursal: r.sucursal, cliente_code: r.cliente_code, nombre, folio: r.folio_digital };
      const base = { entity: ent, periodo: null as any, clase: 'riesgo' as const };

      if ((r.diagnostico === 'sin_factura' || r.diagnostico === 'facturado_en_cero') && emb >= MIN_EMBARQUE) {
        const enCero = r.diagnostico === 'facturado_en_cero';
        out.push({
          ...base, rule_key: 'cxc_embarcado_sin_facturar',
          severity: emb >= CRIT_EMBARQUE ? 'critical' : 'warn',
          score: Math.min(1, emb / 50000),
          titulo: `${nombre}: ${this.mx(emb)} embarcado sin cargo`,
          resumen: `Sucursal ${r.sucursal}, embarque ${r.folio_digital} del ${r.fecha}. Salieron ${this.mx(emb)} y ` +
            (enCero ? `sus ${r.n_facturas} factura(s) quedaron en $0.00.` : 'no se emitió factura.') +
            ' No hay cargo en la cuenta del cliente: la cartera nunca lo va a cobrar.',
          importe: emb,
          evidencia: { embarcado: emb, facturado: fac, n_facturas: r.n_facturas, diagnostico: r.diagnostico, facturas: r.facturas },
          dedup_key: `cxc_sinfacturar:${r.sucursal}:${r.folio}`,
        });
      }
      if (r.diagnostico === 'facturado_de_mas') {
        const exceso = Math.round(-dif * 100) / 100;
        out.push({
          ...base, rule_key: 'cxc_factura_duplicada', clase: 'error_captura', severity: 'critical',
          score: 0.9,
          titulo: `${nombre}: se le cobra ${this.mx(exceso)} de más (embarque facturado ${r.n_facturas} veces)`,
          resumen: `Sucursal ${r.sucursal}, embarque ${r.folio_digital} del ${r.fecha}. Salieron ${this.mx(emb)} ` +
            `pero se emitieron ${r.n_facturas} facturas por ${this.mx(fac)}. La cartera está inflada en ${this.mx(exceso)} ` +
            'y el cliente puede rechazar el cobro. Cancelar la factura repetida en Kepler.',
          importe: exceso,
          evidencia: { embarcado: emb, facturado: fac, n_facturas: r.n_facturas, facturas: r.facturas },
          dedup_key: `cxc_facdup:${r.sucursal}:${r.folio}`,
        });
      }
      if (r.diagnostico === 'diferencia' && Math.abs(dif) >= MIN_DIF_EMBARQUE) {
        out.push({
          ...base, rule_key: 'cxc_embarque_descuadrado', clase: 'error_captura', severity: 'warn',
          score: Math.min(1, Math.abs(dif) / 20000),
          titulo: `${nombre}: embarque y factura difieren ${this.mx(Math.abs(dif))}`,
          resumen: `Sucursal ${r.sucursal}, embarque ${r.folio_digital} del ${r.fecha}. Embarcado ${this.mx(emb)} ` +
            `contra facturado ${this.mx(fac)}. Revisar qué renglón cambió entre el surtido y la factura.`,
          importe: Math.abs(dif),
          evidencia: { embarcado: emb, facturado: fac, diferencia: dif, facturas: r.facturas },
          dedup_key: `cxc_embdif:${r.sucursal}:${r.folio}`,
        });
      }
    }
    return out;
  }

  private mx(v: number) { return `$${(Number(v) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`; }
}
