/**
 * `[MS.2.3]` La configuración viva de la Mesa de Servicio: horario hábil, políticas de SLA, colas y
 * categorías. Se lee de `servicedesk.*` EN CADA operación (son 4 filas chicas) en vez de cachearla en
 * memoria: un cambio de política o de horario aplica de inmediato, sin invalidaciones ni reinicio.
 */
import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { SD_IMPACTS, type SdCatalogResponse, type SdPriority } from '@megadulces/contracts';
import { TenantKnexService } from '@megadulces/platform-core';
import { parseHHMM, type BusinessCalendar } from './domain/business-clock';
import { politicaEfectiva, type PoliticaSla, type PoliticasPorPrioridad } from './domain/sla';

export interface SdSettings {
  calendar: BusinessCalendar;
  autoCloseDays: number;
  escalatePct: number;
  escalationEnabled: boolean;
  maxAttachmentBytes: number;
}

export interface SdConfig {
  settings: SdSettings;
  /** La política GENERAL del tenant (`queue_id IS NULL`): la de siempre y la que heredan las colas que no cambiaron nada. */
  policies: Readonly<Record<SdPriority, PoliticaSla>>;
  /** `[MS.7.2]` Lo que cada cola cambió a su manera, por id de cola. Para leer la política de un ticket usa `politicaDe`. */
  queuePolicies: ReadonlyMap<string, PoliticasPorPrioridad>;
}

/** `[MS.7.2]` La política que rige a un ticket de `queueId` con esa prioridad (la de su cola o, si no, la general). */
export function politicaDe(cfg: Pick<SdConfig, 'policies' | 'queuePolicies'>, queueId: string, priority: SdPriority): PoliticaSla | undefined {
  return politicaEfectiva(cfg.policies, cfg.queuePolicies.get(queueId), priority);
}

@Injectable()
export class ServiceDeskConfigService {
  constructor(private readonly tk: TenantKnexService) {}

  /** Lee settings y políticas dentro de la transacción que ya tiene el llamador (mismo tenant, mismo RLS). */
  async load(trx: Knex.Transaction): Promise<SdConfig> {
    const s = await trx('servicedesk.settings').first();
    if (!s) throw new Error('servicedesk.settings no tiene fila para este tenant: falta correr la migración de catálogos');
    const rows = await trx('servicedesk.sla_policies').select('queue_id', 'priority', 'first_response_minutes', 'resolution_minutes', 'clock');
    const policies = {} as Record<SdPriority, PoliticaSla>;
    const porCola = new Map<string, Partial<Record<SdPriority, PoliticaSla>>>();
    for (const r of rows) {
      const p: PoliticaSla = {
        priority: r.priority,
        first_response_minutes: Number(r.first_response_minutes),
        resolution_minutes: Number(r.resolution_minutes),
        clock: r.clock,
      };
      if (r.queue_id) {
        const m = porCola.get(r.queue_id) ?? {};
        m[r.priority as SdPriority] = p;
        porCola.set(r.queue_id, m);
      } else policies[r.priority as SdPriority] = p;
    }
    return {
      settings: {
        calendar: {
          tz: s.tz,
          days: (s.business_days as number[]).map(Number),
          startMin: parseHHMM(String(s.business_start)),
          endMin: parseHHMM(String(s.business_end)),
        },
        autoCloseDays: Number(s.auto_close_days),
        escalatePct: Number(s.escalate_at_pct),
        escalationEnabled: !!s.escalation_enabled,
        maxAttachmentBytes: Number(s.max_attachment_mb) * 1048576,
      },
      policies,
      queuePolicies: porCola,
    };
  }

  /** Lo que la pantalla «Nueva solicitud» necesita para pintarse. `userId` = quien pregunta (para saber si ya aceptó el aviso de privacidad). */
  async catalog(userId?: string): Promise<SdCatalogResponse> {
    return this.tk.run(async (trx) => {
      const queues = await trx('servicedesk.queues').where({ active: true }).whereNull('deleted_at').orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'code', 'name', 'priority_model', 'asks_zone', 'confidential', 'uses_priority', 'sla_enabled', 'privacy_notice_code');
      const activas = new Set(queues.map((q: { id: string }) => q.id));
      /*
       * `[PRV.2]` El aviso de privacidad VIGENTE de las colas que lo exigen, y si quien pregunta ya lo aceptó. `privacy_notice_code` es un dato
       * interno: NO sale en la respuesta; salen `privacy_required` y, si hay versión vigente, `privacy_notice`.
       */
      const codigos = [...new Set(queues.map((q: { privacy_notice_code: string | null }) => q.privacy_notice_code).filter((c: string | null): c is string => !!c))];
      const vigentes = codigos.length
        ? ((await trx('servicedesk.privacy_notices').whereIn('code', codigos).where({ status: 'vigente' }).select('id', 'code', 'version', 'title', 'summary_text', 'consent_text', 'full_url')) as { id: string; code: string; version: number; title: string; summary_text: string; consent_text: string; full_url: string | null }[])
        : [];
      const aceptados = new Set<string>(
        userId && vigentes.length ? ((await trx('servicedesk.privacy_acceptances').where({ user_id: userId }).whereIn('notice_id', vigentes.map((v) => v.id)).pluck('notice_id')) as string[]) : [],
      );
      const colasDto = queues.map((q: { privacy_notice_code: string | null } & Record<string, unknown>) => {
        const { privacy_notice_code: codigo, ...resto } = q;
        if (!codigo) return resto;
        const v = vigentes.find((x) => x.code === codigo);
        return {
          ...resto,
          privacy_required: true,
          privacy_notice: v ? { id: v.id, version: v.version, title: v.title, summary_text: v.summary_text, consent_text: v.consent_text, full_url: v.full_url, accepted: aceptados.has(v.id) } : null,
        };
      });
      const cats = await trx('servicedesk.categories')
        .where({ active: true })
        .whereNull('deleted_at')
        .orderBy([{ column: 'sort_order' }, { column: 'name' }])
        .select('id', 'queue_id', 'code', 'name', 'default_priority', 'requires_branch');
      const zones = await trx('servicedesk.zones').where({ active: true }).orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('code', 'name');
      // `[MS.7.4]` Los campos propios ACTIVOS de las colas que se ofrecen (los de una cola apagada no se piden: nadie la atiende).
      const fieldRows = await trx('servicedesk.queue_fields')
        .where({ active: true })
        .orderBy([{ column: 'sort_order' }, { column: 'label' }])
        .select('queue_id', 'code', 'label', 'type', 'required', 'options');
      return {
        queues: colasDto as unknown as SdCatalogResponse['queues'],
        zones,
        fields: fieldRows.filter((f: { queue_id: string }) => activas.has(f.queue_id)),
        // Una categoría de una cola apagada no se ofrece: crearía un ticket que nadie atiende.
        categories: cats.filter((c: { queue_id: string }) => activas.has(c.queue_id)),
        impacts: SD_IMPACTS,
      };
    });
  }
}
