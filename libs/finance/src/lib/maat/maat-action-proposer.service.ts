import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * CxP — Convierte los hallazgos ACCIONABLES de Maat en ACCIONES HITL
 * (`finance.proposed_actions`) que Tesorería/CxP aprueba o rechaza en la bandeja.
 *
 * Cierra el lazo "hallazgo → acción": el hallazgo describe el problema; la acción es
 * lo que alguien EJECUTA y queda auditado (ADR-013 — el motor propone, el humano
 * aprueba, la plataforma nunca toca Kepler). Hoy cubre:
 *   · descuento_no_capturado (oportunidad) → renegociar/adelantar pago.
 *   · pago_duplicado (riesgo) → verificar y recuperar.
 *
 * Idempotente por finding_id: NUNCA crea una 2ª acción para el mismo hallazgo (ni
 * aunque haya sido rechazada) — no re-spamea la bandeja cada noche. Corre tras el
 * scanner (09:00 UTC) y el bridge de compras (06:30 UTC), cuando ambos hallazgos ya
 * existen. `analytics.*` no aplica aquí: lee `finance.*` con RLS vía TenantKnexService.
 */

interface ActionableRule {
  rule_key: string;
  min_importe: number;
  titulo: (f: FindingRow) => string;
  efecto: string;
}
interface FindingRow { id: string; rule_key: string; titulo: string; resumen: string; importe: string | number; entity: any; severity: string }

const money = (n: number) => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const nombre = (f: FindingRow) => (f.entity && (f.entity.proveedor_nombre || f.entity.proveedor_code)) || 'proveedor';

const ACTIONABLE: ActionableRule[] = [
  {
    rule_key: 'descuento_no_capturado',
    min_importe: 5000,
    titulo: (f) => `Ajustar pronto pago — ${nombre(f)} (${money(Number(f.importe) || 0)})`,
    efecto: 'Marca el hallazgo "en revisión" y deja constancia de la decisión de CxP (renegociar términos o adelantar el pago para capturar el descuento). La captura real la ejecuta un humano en Kepler — la plataforma no toca el ERP.',
  },
  {
    rule_key: 'pago_duplicado',
    min_importe: 10000,
    titulo: (f) => `Verificar posible doble pago — ${nombre(f)} (${money(Number(f.importe) || 0)})`,
    efecto: 'Marca el hallazgo "en revisión" para que CxP/Contraloría verifique en Kepler si hubo doble pago y gestione la recuperación o aclaración con el proveedor.',
  },
];

@Injectable()
export class MaatActionProposerService {
  private readonly logger = new Logger(MaatActionProposerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Genera acciones para el tenant en contexto (endpoint manual). */
  proposeCurrent(): Promise<{ created: number }> {
    return this.proposeForTenant(this.tenantCtx.requireTenantId());
  }

  @Cron('0 30 3 * * *', { timeZone: 'America/Mexico_City' }) // 03:30 MX — tras el scanner (03:00) y el bridge de compras (00:30)
  async scheduled(): Promise<void> {
    if (this.running) { this.logger.warn('Skip: proposer previo aún corriendo'); return; }
    this.running = true;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      let created = 0;
      for (const t of tenants) {
        try { created += (await this.proposeForTenant(t.id)).created; }
        catch (e: any) { this.logger.warn(`proposer tenant ${t.id} falló: ${e?.message || e}`); }
      }
      this.logger.log(`action-proposer: ${tenants.length} tenants · ${created} acciones nuevas.`);
    } finally {
      this.running = false;
    }
  }

  async proposeForTenant(tenantId: string): Promise<{ created: number }> {
    return this.tenantCtx.run({ tenantId }, () => this.tk.run(async (trx) => {
      let created = 0;
      for (const rule of ACTIONABLE) {
        const rows: FindingRow[] = await trx('finance.findings as f')
          .where('f.rule_key', rule.rule_key)
          .whereIn('f.status', ['nuevo', 'confirmado'])
          .where('f.importe', '>=', rule.min_importe)
          // idempotente: una sola acción por hallazgo, cualquiera sea su estado (no re-spamea)
          .whereNotExists(function () {
            this.select(trx.raw('1')).from('finance.proposed_actions as pa').whereRaw('pa.finding_id = f.id');
          })
          .select('f.id', 'f.rule_key', 'f.titulo', 'f.resumen', 'f.importe', 'f.entity', 'f.severity')
          .orderBy('f.importe', 'desc')
          .limit(200);
        for (const f of rows) {
          await trx('finance.proposed_actions').insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            kind: 'revisar_hallazgo',
            titulo: rule.titulo(f),
            descripcion: f.resumen,
            efecto: rule.efecto,
            payload: JSON.stringify({ finding_id: f.id, rule_key: f.rule_key, entity: f.entity }),
            finding_id: f.id,
            importe: Number(f.importe) || 0,
            origen: 'motor',
            created_by: 'maat_motor',
          });
          created++;
        }
      }
      if (created) this.logger.log(`tenant ${tenantId}: ${created} acciones CxP creadas desde hallazgos.`);
      return { created };
    }));
  }
}
