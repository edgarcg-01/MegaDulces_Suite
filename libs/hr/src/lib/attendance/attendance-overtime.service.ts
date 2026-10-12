import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type { HrAjusteHorasExtraBody, HrAjusteHorasExtraDto, HrBancoHorasExtraDto } from '@megadulces/contracts';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { HrAttendanceReportService } from './attendance-report.service';
import { bancoHorasExtra, errorDeAjuste, HORAS_EXTRA_DESDE, type AjusteLeido } from './logic/banco-horas-extra';
import { hoyMexico, RE_FECHA } from './logic/fechas';

/**
 * Fase RH · `[RH.1.10]` — BANCO DE HORAS EXTRA (Mega Talento ee4ff38). El saldo sale del mismo
 * cálculo de asistencia (`HrAttendanceReportService.calcular`) desde que arrancó el banco; lo único
 * que se escribe son los ajustes de RH, que se anulan con motivo y nunca se borran.
 */
@Injectable()
export class HrAttendanceOvertimeService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly report: HrAttendanceReportService,
  ) {}

  private quien(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  private async ajustes(trx: Knex.Transaction, site: string, hasta: string): Promise<AjusteLeido[]> {
    const rows: Array<{ id: string; person_code: string; fecha: string; minutes: number; reason: string; created_by_name: string | null; created_at: Date | string }> =
      await trx('hr.overtime_adjustments').where({ site_code: site }).whereNull('voided_at').where('effective_date', '<=', hasta)
        .orderBy([{ column: 'effective_date' }, { column: 'created_at' }])
        .select('id', 'person_code', 'minutes', 'reason', 'created_by_name', 'created_at', trx.raw(`to_char(effective_date, 'YYYY-MM-DD') AS fecha`));
    return rows.map((r) => ({
      id: r.id, personCode: String(r.person_code).trim(), fecha: r.fecha, minutos: Number(r.minutes), motivo: r.reason,
      creadoPor: r.created_by_name || '', creadoEn: new Date(r.created_at).toISOString(),
    }));
  }

  /** El banco de la plaza (o de una persona), desde que arrancó hasta `hasta` (hoy si no viene). */
  async banco(p: { site_code?: string; date_to?: string; person_code?: string }): Promise<HrBancoHorasExtraDto> {
    const site = String(p.site_code || '').trim();
    const hasta = String(p.date_to || hoyMexico());
    if (!site) throw new BadRequestException('Falta site_code.');
    if (!RE_FECHA.test(hasta)) throw new BadRequestException('date_to debe venir como yyyy-MM-dd.');
    const desde = HORAS_EXTRA_DESDE;
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const asistencia = hasta < desde ? null : await this.report.calcular(trx, site, desde, hasta);
      const ajustes = await this.ajustes(trx, site, hasta);
      return bancoHorasExtra({ siteCode: site, desde, hasta, codigo: p.person_code ? String(p.person_code).trim() : undefined, asistencia, ajustes });
    });
  }

  /** Registra un ajuste (saldo inicial o corrección). */
  async crearAjuste(b: Partial<HrAjusteHorasExtraBody>): Promise<HrAjusteHorasExtraDto> {
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
  async anularAjuste(id: string, motivo: string): Promise<{ ok: true }> {
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
}
