/**
 * `[MS.3.5]` Lectura del reporte de la Mesa de Servicio (coordinación). ADR-081.
 *
 * La cuenta vive en `domain/report.ts` (pura); acá sólo se resuelve el periodo, se leen las filas y se le pasa la
 * configuración. **Sin tabla de apoyo ni copia**: el reporte sale de `servicedesk.requests` en vivo, así que no
 * hay un «actualizado a las…» que pueda estar viejo — `medido_at` es el momento de la consulta.
 *
 * El periodo se cuenta por CREACIÓN del ticket, en la zona horaria de la mesa (no la del servidor): un ticket de
 * las 23:30 del día 5 en México es del día 5 aunque en UTC ya sea el 6.
 */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { SdReportResponse } from '@megadulces/contracts';
import { TenantKnexService, branchName, toMxDateKey } from '@megadulces/platform-core';
import { armarReporte, type FilaReporte } from './domain/report';
import { resolverPeriodo } from './domain/report-period';
import { ServiceDeskConfigService } from './service-desk-config.service';
import type { ActorCtx } from './service-desk.types';

/** Cuántos tickets calcula un reporte como máximo; más allá se declara `truncado`. */
export const TOPE_FILAS = 20000;

@Injectable()
export class ServiceDeskReportsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly cfg: ServiceDeskConfigService,
  ) {}

  async report(ctx: ActorCtx, q: { from?: string; to?: string }): Promise<SdReportResponse> {
    if (!ctx.esCoordinador) throw new ForbiddenException('El reporte es para la coordinación de la Mesa de Servicio');
    const periodo = resolverPeriodo(q.from, q.to, toMxDateKey(new Date()));
    if (!periodo.ok) throw new BadRequestException(periodo.motivo);
    const { desde, hasta } = periodo;
    return this.tk.run(async (trx) => {
      const config = await this.cfg.load(trx);
      const tz = config.settings.calendar.tz;
      // `TOPE_FILAS + 1` para saber si hay más sin traerlas todas.
      const { rows } = await trx.raw(
        `SELECT r.priority, r.category_id, c.name AS category_name, r.warehouse_code, r.status,
                r.created_at, r.first_responded_at, r.first_response_due_at, r.resolved_at, r.due_at,
                r.paused_minutes, r.reopened_count
           FROM servicedesk.requests r
           JOIN servicedesk.categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id
          WHERE r.deleted_at IS NULL
            AND r.created_at >= (?::date)::timestamp AT TIME ZONE ?
            AND r.created_at <  ((?::date + 1))::timestamp AT TIME ZONE ?
          ORDER BY r.created_at DESC
          LIMIT ?`,
        [desde, tz, hasta, tz, TOPE_FILAS + 1],
      );
      const todas = rows as FilaReporte[];
      const truncado = todas.length > TOPE_FILAS;
      return armarReporte(truncado ? todas.slice(0, TOPE_FILAS) : todas, { calendar: config.settings.calendar, policies: config.policies }, {
        desde,
        hasta,
        ahora: Date.now(),
        truncado,
        nombreSucursal: (code) => branchName(code),
      });
    });
  }
}
