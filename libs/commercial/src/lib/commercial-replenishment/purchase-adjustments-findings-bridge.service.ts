import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';
import {
  FINANCE_FINDINGS_SINK_PORT,
  FinanceFindingsSinkPort,
  FinanceFindingInput,
  FinanceRuleInput,
} from '@megadulces/contracts';
import { PurchaseAdjustmentsService } from './purchase-adjustments.service';

/**
 * RE.10 — Bridge: empuja las POSIBLES FACTURAS DUPLICADAS (mismo proveedor + monto
 * exacto repetido en ≤N días, sobre `analytics.erp_goods_receipts`) a la bandeja
 * unificada de hallazgos de Maat (`finance.findings`) vía FINANCE_FINDINGS_SINK_PORT.
 *
 * Por qué Maat y no una bandeja de compras: una factura duplicada es un RIESGO
 * financiero (doble pago / costo inflado) — encaja en las clases de Maat
 * (riesgo/error_captura/oportunidad) y reusa su triage + auto-supresión L2. Mismo
 * patrón que FiscalFindingsBridgeService.
 *
 * `@Optional()`: si Maat está apagado (o el binding no se registra), es no-op; el
 * detector sigue disponible en `/compras/descuentos` (lectura). Best-effort.
 *
 * El cron corre como `KNEX_NEW_DB` (postgres) e itera tenants; `analytics.*` no
 * tiene RLS, así que basta el filtro `tenant_id` explícito (sin SET LOCAL).
 */
@Injectable()
export class PurchaseAdjustmentsFindingsBridgeService {
  private readonly logger = new Logger(PurchaseAdjustmentsFindingsBridgeService.name);
  private readonly WINDOW_DAYS = 30;
  private readonly MIN_MONTO = 500; // ignora grupos triviales (ruido)
  private isRunning = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly adjustments: PurchaseAdjustmentsService,
    private readonly tenantCtx: TenantContextService,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
  ) {}

  /** Sync del tenant en contexto (endpoint manual). */
  syncCurrent(): Promise<{ pushed: number; inserted: number; skipped: number }> {
    return this.syncForTenant(this.tenantCtx.requireTenantId());
  }

  @Cron('0 30 6 * * *') // 06:30 UTC = 00:30 America/Mexico_City (tras el scanner de reorden)
  async scheduledSync(): Promise<void> {
    if (process.env.ENABLE_DUP_FINDINGS_SCAN === 'false') return;
    if (!this.sink) { this.logger.debug('FINANCE_FINDINGS_SINK_PORT no ligado — sync no-op.'); return; }
    if (this.isRunning) { this.logger.warn('Skip: sync anterior aún corriendo'); return; }
    this.isRunning = true;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      let pushed = 0;
      for (const t of tenants) pushed += (await this.syncForTenant(t.id)).pushed;
      this.logger.log(`dup-findings scan: ${tenants.length} tenants, ${pushed} posibles duplicadas`);
    } finally {
      this.isRunning = false;
    }
  }

  async syncForTenant(tenantId: string): Promise<{ pushed: number; inserted: number; skipped: number }> {
    if (!this.sink) return { pushed: 0, inserted: 0, skipped: 0 };
    const groups = await this.adjustments.duplicateGroups(this.knex, tenantId, this.WINDOW_DAYS);

    const findings: FinanceFindingInput[] = [];
    for (const g of groups) {
      const montoRiesgo = Number(g.monto_riesgo || 0);
      if (montoRiesgo < this.MIN_MONTO) continue; // solo lo material
      const veces = Number(g.veces || 0);
      const monto = Number(g.monto || 0);
      const folios = (g.folios || []).join(', ');
      findings.push({
        rule_key: 'compra_factura_duplicada',
        clase: 'riesgo',
        severity: montoRiesgo >= 50000 ? 'critical' : montoRiesgo >= 10000 ? 'warn' : 'info',
        score: Math.min(0.85, 0.5 + 0.1 * (veces - 1)),
        titulo: `Posible factura de compra duplicada — ${g.proveedor_nombre || g.proveedor_code}`,
        resumen: `${g.proveedor_nombre || g.proveedor_code}: ${veces} entradas por el MISMO monto ${this.money(monto)} en ${g.span_dias} día(s) (${folios}). Posible captura doble → riesgo de doble pago ${this.money(montoRiesgo)}.`,
        entity: { proveedor_code: g.proveedor_code, proveedor_nombre: g.proveedor_nombre, monto },
        periodo: this.ym(g.hasta),
        importe: montoRiesgo,
        evidencia: {
          veces, copias_extra: Number(g.copias_extra || 0), monto,
          folios: g.folios, sucursales: g.sucursales,
          desde: g.desde, hasta: g.hasta, span_dias: Number(g.span_dias || 0),
          window_days: this.WINDOW_DAYS, fuente: 'analytics.erp_goods_receipts',
        },
        dedup_key: `compra_factura_duplicada|${g.proveedor_code}|${monto}`,
      });
    }

    if (!findings.length) return { pushed: 0, inserted: 0, skipped: 0 };
    const rule: FinanceRuleInput = {
      rule_key: 'compra_factura_duplicada',
      nombre: 'Posible factura de compra duplicada',
      descripcion: 'Entradas del mismo proveedor con el mismo monto exacto repetido dentro de una ventana corta — posible captura doble del comprobante (riesgo de doble pago). HITL: el humano confirma (un pedido recurrente idéntico puede ser legítimo).',
      clase: 'riesgo',
      params: { window_days: this.WINDOW_DAYS, min_monto: this.MIN_MONTO },
    };
    const res = await this.sink.pushFindings(tenantId, findings, [rule]);
    this.logger.log(`tenant ${tenantId}: ${findings.length} posibles duplicadas → Maat (${res.inserted} nuevas, ${res.skipped} omitidas).`);
    return { pushed: findings.length, ...res };
  }

  /** 'YYYY-MM' robusto (pg `date` → objeto Date en tz local; no usar toISOString). */
  private ym(v: unknown): string | null {
    if (v == null) return null;
    if (typeof v === 'string') return v.slice(0, 7);
    if (v instanceof Date && !isNaN(v.getTime())) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
    return null;
  }

  private money(n: number): string {
    return Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
  }
}
