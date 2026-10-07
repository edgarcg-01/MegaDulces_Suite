/**
 * `[MS.2.5]` El barrido del SLA de la Mesa de Servicio: marca lo que venció, avisa (si la escalación está
 * encendida) y cierra solo lo que quedó resuelto y nadie objetó. ADR-081 §4.
 *
 * ── Primero MIDE, después escala ───────────────────────────────────────────────────────────────
 * `settings.escalation_enabled` arranca APAGADO. Con él apagado el barrido igual MARCA los plazos vencidos
 * (`sla_*_breached_at`, que alimentan el tablero y los reportes) pero NO manda un solo aviso: `cash-count-sla`
 * se retiró (SM.34) por estar mal calibrado, y un reloj sin calibrar que grita enseña a ignorar la alarma.
 * Se enciende cuando Dirección haya visto los números reales de una semana.
 *
 * ── Idempotente ────────────────────────────────────────────────────────────────────────────
 * «Primera vez» se decide mirando las marcas que el ticket ya trae (`evaluarSla`), así que correrlo dos
 * veces seguidas no marca ni avisa dos veces. `escalated_at` marca el «por vencer», que no tiene columna propia.
 *
 * ── Single-flight y latido ──────────────────────────────────────────────────────────────────
 * Hay `running` en memoria (ahorra el viaje) Y un candado de base por tenant (`tomarCandadoDeCron`): con dos
 * instancias del worker, una sola barre. El latido sale por `latirCron` con su entrada en `CRON_JOBS`
 * (`service_desk_sla`): sin ella, el sensor caería en `cfg ? classify : 'ok'` y un cron parado se vería verde.
 * Que un barrido entregue CERO es lo normal (nada venció): se declara con `ceroEsOk`, con motivo.
 *
 * ⚠️ Corre en el WORKER, que no tiene WebSocket (ADR-080): los avisos salen por correo/WhatsApp y dejan su
 * fila `app` en `notification_log`, que la campana recoge por poll.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { SdPriority, SdSlaScanResult, SdStatus } from '@megadulces/contracts';
import { TenantContextService, TenantKnexService, latirCron, tomarCandadoDeCron } from '@megadulces/platform-core';
import { evaluarSla } from './domain/sla';
import { ServiceDeskAgentsService } from './agents.service';
import { juntar, ServiceDeskRequestsService, sinEfectos, type Efectos } from './requests.service';
import { ServiceDeskConfigService } from './service-desk-config.service';
import type { SdEvento } from './notifications.service';

export const SLA_JOB_KEY = 'service_desk_sla';

interface TicketAbierto {
  id: string;
  tenant_id: string;
  folio: string;
  title: string;
  priority: SdPriority;
  status: SdStatus;
  assigned_to: string | null;
  due_at: Date | null;
  first_response_due_at: Date | null;
  first_responded_at: Date | null;
  paused_at: Date | null;
  sla_first_breached_at: Date | null;
  sla_resolution_breached_at: Date | null;
  escalated_at: Date | null;
}

const VACIA: SdSlaScanResult = { tenants: 0, marcados: 0, avisos: 0, autocerrados: 0 };

@Injectable()
export class ServiceDeskSlaService {
  private readonly logger = new Logger(ServiceDeskSlaService.name);
  private running = false;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cfg: ServiceDeskConfigService,
    private readonly requests: ServiceDeskRequestsService,
    private readonly agents: ServiceDeskAgentsService,
  ) {}

  /** Cada 5 minutos. */
  @Cron('0 */5 * * * *')
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_SERVICE_DESK_SLA === 'false') return;
    if (this.running) {
      this.logger.warn('Skip: el barrido anterior sigue en curso');
      return;
    }
    await this.scanAll().catch((e) => this.logger.error(`barrido del SLA: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** Barre todos los tenants. Cada uno en su propia transacción: lo que falla en uno no frena al resto. */
  async scanAll(): Promise<SdSlaScanResult> {
    this.running = true;
    try {
      const tenants: { id: string }[] = await this.tk.global('identity.tenants').select('id');
      const total: SdSlaScanResult = { ...VACIA };
      for (const t of tenants) {
        const r = await this.scanTenant(t.id);
        if (!r) continue; // este tenant no usa la mesa
        total.tenants += 1;
        total.marcados += r.marcados;
        total.avisos += r.avisos;
        total.autocerrados += r.autocerrados;
      }
      return total;
    } finally {
      this.running = false;
    }
  }

  /**
   * Barre AHORA el tenant de quien llama, por el MISMO camino que el cron (así una corrida manual también deja
   * latido: la lección de `[CXC.20.5]`, donde el endpoint manual escribía sin tocar `cron_runs` y quedaba
   * imposible distinguir «el job está roto» de «alguien lo disparó a mano»).
   */
  async scanNow(): Promise<SdSlaScanResult> {
    const r = await this.scanTenant(this.tenantCtx.requireTenantId());
    return r ? { tenants: 1, ...r } : { ...VACIA };
  }

  /** Un tenant. `null` = no tiene la mesa configurada, o ya lo barre otra instancia. */
  async scanTenant(tenantId: string, now = new Date()): Promise<Omit<SdSlaScanResult, 'tenants'> | null> {
    const t0 = Date.now();
    const fallas: string[] = [];
    let res: Omit<SdSlaScanResult, 'tenants'> | null = null;
    let efectos: Efectos = sinEfectos();
    try {
      await this.tk.run(tenantId, async (trx) => {
        if (!(await tomarCandadoDeCron(trx, `${SLA_JOB_KEY}:${tenantId}`))) return;
        if (!(await trx('servicedesk.settings').first('tenant_id'))) return;
        const config = await this.cfg.load(trx);

        const abiertos: TicketAbierto[] = await trx('servicedesk.requests')
          .whereNull('deleted_at')
          .whereIn('status', ['nuevo', 'asignado', 'en_proceso', 'en_espera'])
          .select('id', 'tenant_id', 'folio', 'title', 'priority', 'status', 'assigned_to', 'due_at', 'first_response_due_at', 'first_responded_at', 'paused_at', 'sla_first_breached_at', 'sla_resolution_breached_at', 'escalated_at');

        let marcados = 0;
        const avisos: SdEvento[] = [];
        // Sin asignado el aviso va a quien coordina/atiende; con asignado, a esa persona.
        let agentes: string[] | null = null;
        const aQuienAtiende = async (): Promise<string[]> => (agentes ??= (await this.agents.listIn(trx)).map((a) => a.user_id));

        for (const r of abiertos) {
          const politica = config.policies[r.priority];
          if (!politica) {
            fallas.push(`${r.folio}: sin política de SLA para «${r.priority}»`);
            continue;
          }
          const v = evaluarSla(
            {
              status: r.status,
              due_at: r.due_at ? new Date(r.due_at) : null,
              first_response_due_at: r.first_response_due_at ? new Date(r.first_response_due_at) : null,
              first_responded_at: r.first_responded_at ? new Date(r.first_responded_at) : null,
              paused_at: r.paused_at ? new Date(r.paused_at) : null,
              sla_first_breached_at: r.sla_first_breached_at ? new Date(r.sla_first_breached_at) : null,
              sla_resolution_breached_at: r.sla_resolution_breached_at ? new Date(r.sla_resolution_breached_at) : null,
            },
            now,
            politica,
            config.settings.calendar,
            config.settings.escalatePct,
          );

          const patch: Record<string, unknown> = {};
          if (v.primera_respuesta_vencida) patch['sla_first_breached_at'] = now;
          if (v.resolucion_vencida) patch['sla_resolution_breached_at'] = now;
          const porVencer = v.avisar && !r.escalated_at;
          if (porVencer && config.settings.escalationEnabled) patch['escalated_at'] = now;

          if (Object.keys(patch).length) {
            await trx('servicedesk.requests').where({ id: r.id }).update(patch);
            marcados += Number(v.primera_respuesta_vencida) + Number(v.resolucion_vencida);
          }

          // Con la escalación apagada se MIDE y se marca, pero no se avisa a nadie.
          if (!config.settings.escalationEnabled) continue;
          const destino = r.assigned_to ? [r.assigned_to] : await aQuienAtiende();
          const base = { request_id: r.id, folio: r.folio, title: r.title, priority: r.priority, recipients: destino };
          const plazo = r.due_at ? new Date(r.due_at).getTime() : 0;
          const plazo1 = r.first_response_due_at ? new Date(r.first_response_due_at).getTime() : 0;
          if (porVencer) avisos.push({ ...base, event: 'sla_por_vencer', discriminador: plazo });
          if (v.primera_respuesta_vencida) avisos.push({ ...base, event: 'sla_primera_respuesta_vencida', recipients: await aQuienAtiende(), discriminador: plazo1 });
          if (v.resolucion_vencida) avisos.push({ ...base, event: 'sla_vencido', discriminador: plazo });
        }

        const ac = await this.requests.autoCerrarEn(trx, config, now);
        efectos = juntar({ avisos, bitacora: [] }, ac.efectos);
        res = { marcados, avisos: avisos.length, autocerrados: ac.cerrados };
      });
    } catch (e) {
      fallas.push(e instanceof Error ? e.message : String(e));
    }

    // Los avisos salen DESPUÉS de confirmar: si la transacción se cae, no se avisó de algo que no quedó escrito.
    if (res) await this.requests.despachar(efectos, tenantId);

    if (res || fallas.length) {
      const hecho = res as Omit<SdSlaScanResult, 'tenants'> | null;
      await latirCron(this.tk.global, {
        jobKey: SLA_JOB_KEY,
        label: 'Mesa de Servicio: barrido del SLA',
        tenantId,
        rowsAffected: hecho ? hecho.marcados + hecho.avisos + hecho.autocerrados : 0,
        durationMs: Date.now() - t0,
        fallas,
        ceroEsOk: 'no venció ni quedó por cerrar ninguna solicitud en esta corrida (lo normal si todo va en plazo)',
        note: hecho ? `marcados ${hecho.marcados} · avisos ${hecho.avisos} · autocerrados ${hecho.autocerrados}` : null,
      });
    }
    return res;
  }
}
