import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import * as reader from './attendance-reader';
import { calcularAsistencia, desdeVentanaHorario, type AsistenciaPersonas } from './logic/asistencia-persona';
import { diasEntre, RE_FECHA } from './logic/fechas';
import type { HrPersonaDirectorioDto, HrSiteDto } from '@megadulces/contracts';

/**
 * Fase RH · `[RH.1.5]` — la ASISTENCIA POR PERSONA de un sitio y un rango: lo que pinta la
 * pantalla de Asistencia y lo que congela el cierre de semana.
 *
 * El cálculo es puro (`logic/asistencia-persona.ts`); aquí sólo se lee lo que necesita, en UNA
 * transacción para que todo salga de la misma foto de la base.
 */

/** Un rango más largo no es una consulta de pantalla: es una auditoría, y se pide por partes. */
export const TOPE_DIAS_REPORTE = 120;

@Injectable()
export class HrAttendanceReportService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async asistencia(p: { site_code?: string; date_from?: string; date_to?: string; only_promoters?: boolean }): Promise<AsistenciaPersonas> {
    const site = String(p.site_code || '').trim();
    const desde = String(p.date_from || '');
    const hasta = String(p.date_to || '');
    if (!site || !RE_FECHA.test(desde) || !RE_FECHA.test(hasta)) {
      throw new BadRequestException('Faltan site_code, date_from y date_to (yyyy-MM-dd).');
    }
    if (hasta < desde) throw new BadRequestException('date_to no puede ser anterior a date_from.');
    if (diasEntre(desde, hasta) > TOPE_DIAS_REPORTE) {
      throw new BadRequestException(`El rango es de más de ${TOPE_DIAS_REPORTE} días: pídelo por partes.`);
    }
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      if (!(await reader.sitioExiste(trx, site))) throw new NotFoundException(`No existe el sitio de checado "${site}".`);
      return this.calcular(trx, site, desde, hasta, !!p.only_promoters);
    });
  }

  /** El mismo cálculo dentro de una transacción ya abierta (el cierre lo usa para su foto). */
  async calcular(trx: Knex.Transaction, site: string, desde: string, hasta: string, soloPromotoras = false): Promise<AsistenciaPersonas> {
    const desdeHorario = desdeVentanaHorario(desde, hasta);
    // En serie, no con Promise.all: una transacción es UNA conexión, y encimarle consultas es lo
    // que `pg@9` va a prohibir (hoy ya lo avisa).
    const cfg = await reader.cargarConfig(trx, site);
    const filas = await reader.diasPorPersona(trx, site, desdeHorario, hasta);
    const ctx = await reader.contextoHistorico(trx, site);
    const padron = await reader.padron(trx, site);
    const conf = await reader.confirmados(trx, site);
    const revisiones = await reader.revisionesAprobadas(trx, site, desde, hasta);
    const incidencias = await reader.incidenciasEnRango(trx, site, desde, hasta);
    return calcularAsistencia({
      siteCode: site, desde, hasta, soloPromotoras, cfg, filas,
      silencio: ctx.silencio, unaMarca: ctx.unaMarca, padron: padron.fichas,
      turnosConfirmados: conf.turnos, asignados: conf.asignados, revisiones, incidencias,
    });
  }

  /** Los sitios de checado, para el selector de las pantallas. */
  async sitios(): Promise<HrSiteDto[]> {
    return this.tk.run(this.tenantCtx.requireTenantId(), (trx) =>
      trx('hr.attendance_sites').orderBy('name').select('code', 'name', 'warehouse_code', 'is_active'));
  }

  /** `[RH.1.7c]` Las personas de todas las plazas, para «Buscar en todas las plazas». */
  async directorio(): Promise<HrPersonaDirectorioDto[]> {
    return this.tk.run(this.tenantCtx.requireTenantId(), (trx) => reader.directorio(trx));
  }

  /** Las checadas crudas de un sitio y un rango (para la tabla de checadas). */
  async checadas(p: { site_code?: string; date_from?: string; date_to?: string; person_code?: string }): Promise<unknown[]> {
    const site = String(p.site_code || '').trim();
    if (!site || !RE_FECHA.test(String(p.date_from)) || !RE_FECHA.test(String(p.date_to))) {
      throw new BadRequestException('Faltan site_code, date_from y date_to (yyyy-MM-dd).');
    }
    if (diasEntre(String(p.date_from), String(p.date_to)) > TOPE_DIAS_REPORTE) {
      throw new BadRequestException(`El rango es de más de ${TOPE_DIAS_REPORTE} días: pídelo por partes.`);
    }
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const filas = await reader.checadasDelRango(trx, site, String(p.date_from), String(p.date_to));
      return p.person_code ? filas.filter((f) => f.codigo === p.person_code) : filas;
    });
  }

  /** Primer y último día con checadas de un sitio. */
  async rango(siteCode: string): Promise<{ min: string | null; max: string | null }> {
    if (!siteCode) throw new BadRequestException('Falta site_code.');
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const { rows } = await trx.raw<{ rows: Array<{ min: string | null; max: string | null }> }>(`
        SELECT to_char(min(punched_local), 'YYYY-MM-DD') AS min, to_char(max(punched_local), 'YYYY-MM-DD') AS max
          FROM hr.v_site_punches WHERE site_code = ? AND punched_local >= '${reader.DATO_VALIDO_DESDE}'::date`, [siteCode]);
      return rows[0] || { min: null, max: null };
    });
  }
}
