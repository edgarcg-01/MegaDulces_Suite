import { Injectable, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { MaatToolsService } from './maat-tools.service';

/**
 * MAAT.3.1 — Briefing financiero al abrir el chat (proactividad, DETERMINISTA).
 *
 * Sin LLM: es un resumen de "qué mirar hoy" armado con las mismas fuentes que
 * las tools. Se muestra en el empty-state de /finanzas/maat como tarjetas +
 * chips de pregunta. El objetivo es que Maat "hable primero".
 *
 *   - gasto últimos 30d vs 30d previos (Δ%)
 *   - hallazgos contables por tipo (bandeja pendiente)
 *   - señales de riesgo globales (duplicados + facturas sin recepción)
 *   - top-3 preguntas sugeridas para arrancar
 */
@Injectable()
export class MaatBriefingService {
  private readonly logger = new Logger(MaatBriefingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly tools: MaatToolsService,
  ) {}

  async build() {
    const tenantId = this.tenantCtx.requireTenantId();
    const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
    return this.tk.run(async (trx) => {
      const today = new Date();
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const d30 = new Date(today); d30.setDate(d30.getDate() - 30);
      const d60 = new Date(today); d60.setDate(d60.getDate() - 60);

      // 1) Gasto 30d vs 30d previos
      const sum = async (from: string, to: string) => {
        const r: any = await trx('analytics.expense_entries')
          .where('tenant_id', tenantId).andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
          .select(trx.raw('COALESCE(SUM(importe),0)::numeric AS t')).first();
        return Number(r?.t || 0);
      };
      const gastoAct = await sum(iso(d30), iso(today));
      const gastoPrev = await sum(iso(d60), iso(d30));
      const deltaPct = gastoPrev ? +(((gastoAct - gastoPrev) / gastoPrev) * 100).toFixed(1) : null;

      // 2) Hallazgos por tipo (bandeja pendiente)
      const findings = await trx('analytics.expense_findings').where('tenant_id', tenantId)
        .groupBy('tipo').select('tipo', trx.raw('COUNT(*)::int AS num'), trx.raw('ROUND(SUM(importe)::numeric,2) AS total'))
        .orderByRaw('SUM(importe) DESC');

      // 3) Facturas sin recepción (riesgo agregado)
      const noRcp: any = await trx('analytics.expense_doc_chain').where('tenant_id', tenantId).whereNull('recepcion_folio')
        .select(trx.raw('COUNT(*)::int AS n'), trx.raw('ROUND(SUM(total)::numeric,2) AS monto')).first();

      // 4) Top proveedor por saldo (a quién le debemos más)
      const topSaldo: any = await trx('analytics.ap_provider').where('tenant_id', tenantId)
        .groupBy('proveedor_norm').select(trx.raw('MAX(proveedor) AS proveedor'), trx.raw('SUM(saldo)::numeric AS saldo'))
        .orderByRaw('SUM(saldo) DESC').first();

      const cards: { icon: string; label: string; value: string; tone?: 'up' | 'down' | 'warn' }[] = [];
      cards.push({
        icon: 'pi-wallet', label: 'Gasto últimos 30 días',
        value: money(gastoAct) + (deltaPct != null ? ` (${deltaPct > 0 ? '+' : ''}${deltaPct}% vs prev)` : ''),
        tone: deltaPct != null && deltaPct > 10 ? 'up' : undefined,
      });
      const findTotal = findings.reduce((a: number, f: any) => a + Number(f.num), 0);
      if (findTotal) cards.push({ icon: 'pi-exclamation-triangle', label: 'Hallazgos por revisar', value: `${findTotal} en ${findings.length} tipos`, tone: 'warn' });
      if (Number(noRcp?.n) > 0) cards.push({ icon: 'pi-box', label: 'Facturas sin recepción', value: `${noRcp.n} · ${money(Number(noRcp.monto))}`, tone: 'warn' });
      if (topSaldo && Number(topSaldo.saldo) > 0) cards.push({ icon: 'pi-truck', label: 'Mayor saldo por pagar', value: `${topSaldo.proveedor} · ${money(Number(topSaldo.saldo))}` });

      const suggestions = [
        '¿En qué se fue el gasto de los últimos 30 días?',
        findTotal ? 'Muéstrame los hallazgos contables' : '¿Cómo va el P&L de los últimos meses?',
        topSaldo?.proveedor ? `¿Qué le compramos a ${topSaldo.proveedor}?` : 'Top 10 proveedores por compra',
      ];

      return {
        greeting: 'Esto es lo que veo hoy en los libros:',
        cards,
        findings: findings.map((f: any) => ({ tipo: f.tipo, num: Number(f.num), total: Number(f.total) })),
        suggestions,
      };
    });
  }
}
