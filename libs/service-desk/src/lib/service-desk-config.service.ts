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
import type { PoliticaSla } from './domain/sla';

export interface SdSettings {
  calendar: BusinessCalendar;
  autoCloseDays: number;
  escalatePct: number;
  escalationEnabled: boolean;
  maxAttachmentBytes: number;
}

export interface SdConfig {
  settings: SdSettings;
  policies: Readonly<Record<SdPriority, PoliticaSla>>;
}

@Injectable()
export class ServiceDeskConfigService {
  constructor(private readonly tk: TenantKnexService) {}

  /** Lee settings y políticas dentro de la transacción que ya tiene el llamador (mismo tenant, mismo RLS). */
  async load(trx: Knex.Transaction): Promise<SdConfig> {
    const s = await trx('servicedesk.settings').first();
    if (!s) throw new Error('servicedesk.settings no tiene fila para este tenant: falta correr la migración de catálogos');
    const rows = await trx('servicedesk.sla_policies').select('priority', 'first_response_minutes', 'resolution_minutes', 'clock');
    const policies = {} as Record<SdPriority, PoliticaSla>;
    for (const r of rows) {
      policies[r.priority as SdPriority] = {
        priority: r.priority,
        first_response_minutes: Number(r.first_response_minutes),
        resolution_minutes: Number(r.resolution_minutes),
        clock: r.clock,
      };
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
    };
  }

  /** Lo que la pantalla «Nueva solicitud» necesita para pintarse. */
  async catalog(): Promise<SdCatalogResponse> {
    return this.tk.run(async (trx) => {
      const queues = await trx('servicedesk.queues').where({ active: true }).whereNull('deleted_at').orderBy([{ column: 'sort_order' }, { column: 'name' }]).select('id', 'code', 'name');
      const activas = new Set(queues.map((q: { id: string }) => q.id));
      const cats = await trx('servicedesk.categories')
        .where({ active: true })
        .whereNull('deleted_at')
        .orderBy([{ column: 'sort_order' }, { column: 'name' }])
        .select('id', 'queue_id', 'code', 'name', 'default_priority', 'requires_branch');
      return {
        queues,
        // Una categoría de una cola apagada no se ofrece: crearía un ticket que nadie atiende.
        categories: cats.filter((c: { queue_id: string }) => activas.has(c.queue_id)),
        impacts: SD_IMPACTS,
      };
    });
  }
}
