import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import * as reader from './attendance-reader';
import { calcularAsistencia, desdeVentanaHorario, type AsistenciaPersonas } from './logic/asistencia-persona';
import { diasEntre, hoyMexico, masDias, RE_FECHA } from './logic/fechas';
import { bancoHorasExtra, errorDeAjuste, HORAS_EXTRA_DESDE, type AjusteLeido } from './logic/banco-horas-extra';
import { inicioSemana } from './logic/horario-deducido';
import type {
  HrAjusteHorasExtraBody, HrAjusteHorasExtraDto, HrBancoHorasExtraDto, HrPersonaDirectorioDto, HrSiteDto,
} from '@megadulces/contracts';

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
    // `[RH.1.10]` Las semanas COMPLETAS (jueves a miércoles) que toca el periodo: un cambio de descanso
    // del viernes mueve también el día de trabajo de esa semana aunque el periodo empiece después.
    // La lógica sigue recortando al periodo lo que pega a cada día y lo que lista por persona.
    const incidencias = await reader.incidenciasEnRango(trx, site, inicioSemana(desde), masDias(inicioSemana(hasta), 6));
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

  // ── `[RH.1.10]` Banco de horas extra (Mega Talento ee4ff38) ─────────────────────────────
  // El saldo sale de ESTE cálculo desde que arrancó el banco; lo único que se escribe son los
  // ajustes de RH, que se anulan con motivo y nunca se borran.

  private quien(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  private async ajustesHorasExtra(trx: Knex.Transaction, site: string, hasta: string): Promise<AjusteLeido[]> {
    const rows: Array<{ id: string; person_code: string; fecha: string; minutes: number; reason: string; created_by_name: string | null; created_at: Date | string }> =
      await trx('hr.overtime_adjustments').where({ site_code: site }).whereNull('voided_at').where('effective_date', '<=', hasta)
        .orderBy([{ column: 'effective_date' }, { column: 'created_at' }])
        .select('id', 'person_code', 'minutes', 'reason', 'created_by_name', 'created_at', trx.raw(`to_char(effective_date, 'YYYY-MM-DD') AS fecha`));
    return rows.map((r) => ({
      id: r.id, personCode: String(r.person_code).trim(), fecha: r.fecha, minutos: Number(r.minutes), motivo: r.reason,
      creadoPor: r.created_by_name || '', creadoEn: new Date(r.created_at).toISOString(),
    }));
  }

  /** El banco de la plaza (o de una persona), desde que arrancó hasta `date_to` (hoy si no viene). */
  async bancoHorasExtra(p: { site_code?: string; date_to?: string; person_code?: string }): Promise<HrBancoHorasExtraDto> {
    const site = String(p.site_code || '').trim();
    const hasta = String(p.date_to || hoyMexico());
    if (!site) throw new BadRequestException('Falta site_code.');
    if (!RE_FECHA.test(hasta)) throw new BadRequestException('date_to debe venir como yyyy-MM-dd.');
    const desde = HORAS_EXTRA_DESDE;
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const asistencia = hasta < desde ? null : await this.calcular(trx, site, desde, hasta);
      const ajustes = await this.ajustesHorasExtra(trx, site, hasta);
      return bancoHorasExtra({ siteCode: site, desde, hasta, codigo: p.person_code ? String(p.person_code).trim() : undefined, asistencia, ajustes });
    });
  }

  /** Registra un ajuste al banco (saldo inicial o corrección, minutos con signo). */
  async crearAjusteHorasExtra(b: Partial<HrAjusteHorasExtraBody>): Promise<HrAjusteHorasExtraDto> {
    const error = errorDeAjuste(b);
    if (error) throw new BadRequestException(error);
    const q = this.quien();
    const fecha = b.effective_date ? String(b.effective_date) : hoyMexico();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const [r] = await trx('hr.overtime_adjustments').insert({
        tenant_id: this.tenantCtx.requireTenantId(), site_code: String(b.site_code).trim(), person_code: String(b.person_code).trim(),
        minutes: Math.round(Number(b.minutes)), effective_date: fecha, reason: String(b.reason).trim(),
        created_by: q.id, created_by_name: q.nombre,
      }).returning(['id', 'minutes', 'reason', 'created_by_name', 'created_at', trx.raw(`to_char(effective_date, 'YYYY-MM-DD') AS fecha`)]);
      return {
        id: r.id, fecha: r.fecha, minutos: Number(r.minutes), motivo: r.reason,
        creadoPor: r.created_by_name || '', creadoEn: new Date(r.created_at).toISOString(),
      };
    });
  }

  /** Anula un ajuste: no se borra, queda quién, cuándo y por qué. */
  async anularAjusteHorasExtra(id: string, motivo: string): Promise<{ ok: true }> {
    const m = String(motivo || '').trim();
    if (m.length < 5) throw new BadRequestException('Escribe por qué se quita el ajuste.');
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const n = await trx('hr.overtime_adjustments').where({ id }).whereNull('voided_at')
        .update({ voided_at: trx.fn.now(), voided_by: q.id, voided_by_name: q.nombre, void_reason: m });
      if (!n) throw new NotFoundException('Ese ajuste ya no existe o ya estaba anulado.');
      return { ok: true as const };
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
