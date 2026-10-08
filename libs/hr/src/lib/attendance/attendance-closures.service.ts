import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import * as reader from './attendance-reader';
import { HrAttendanceReportService } from './attendance-report.service';
import { HrAttendanceIncidentsService, type FilaIncidencia } from './attendance-incidents.service';
import { inicioSemana } from './logic/horario-deducido';
import { hoyMexico, masDias, RE_FECHA } from './logic/fechas';
import { textoSemanaCerrada } from './logic/incidencias';

/**
 * Fase RH · `[RH.1.6]` — CIERRE DE SEMANA PARA PRENÓMINA. Traslado de `mega-talento-90/api/src/
 * cierres.ts` @ 2c7d267.
 *
 * El número de asistencia se RECALCULA cada vez que se pide (llegan marcas tarde, se capturan
 * incidencias días después). Bien para trabajar, mal para pagar: la semana que se mandó a nómina
 * no se podía volver a ver tal cual, y contabilidad no tenía contra qué auditar. Cerrar:
 *   1. exige que no quede nada POR CALIFICAR en la semana;
 *   2. guarda la FOTO: el cálculo completo de esa semana, tal como salió;
 *   3. pasa sus incidencias calificadas a CERRADA (con su renglón de bitácora), y
 *   4. bloquea la semana: capturar, calificar o quitar algo en ella responde 409.
 * Reabrir exige motivo y NO borra la foto: deja quién, cuándo y por qué, y las incidencias vuelven
 * a calificada (salvo las que tocan OTRA semana que siga cerrada).
 *
 * ══ UNA DIFERENCIA CONTRA MEGA TALENTO, A FAVOR ══
 * Allá la foto se tomaba FUERA de la transacción y se volvía a contar lo pendiente adentro. Aquí
 * todo —la foto, el conteo, el cambio de estado y el cierre— corre en UNA transacción, así que la
 * foto es exactamente lo que quedó cerrado. El índice único parcial de la tabla
 * (`ux_hr_closure_open`) sigue siendo la red: si dos personas cierran a la vez, la segunda choca.
 *
 * La semana es la de nómina: jueves a miércoles (`DIA_INICIO_SEMANA`); la tabla lo exige con un
 * CHECK.
 */

const COLUMNAS_CIERRE = [
  'id', 'site_code', 'closed_by', 'closed_by_name', 'closed_at', 'summary',
  'reopened_by', 'reopened_by_name', 'reopened_at', 'reopen_reason',
];

@Injectable()
export class HrAttendanceClosuresService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly report: HrAttendanceReportService,
    private readonly incidents: HrAttendanceIncidentsService,
  ) {}

  private quien(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  private columnas(trx: Knex.Transaction): Array<string | Knex.Raw> {
    return [...COLUMNAS_CIERRE,
      trx.raw(`to_char(period_start, 'YYYY-MM-DD') AS period_start`),
      trx.raw(`to_char(period_end, 'YYYY-MM-DD') AS period_end`),
      trx.raw('reopened_at IS NULL AS vigente')];
  }

  /** Los cierres de un sitio, el más nuevo primero, sin la foto. */
  async listar(siteCode: string): Promise<unknown[]> {
    if (!siteCode) throw new BadRequestException('Falta site_code.');
    return this.tk.run(this.tenantCtx.requireTenantId(), (trx) =>
      trx('hr.attendance_closures').where({ site_code: siteCode })
        .orderBy([{ column: 'period_start', order: 'desc' }, { column: 'closed_at', order: 'desc' }])
        .limit(60).select(this.columnas(trx)));
  }

  /** Las semanas CERRADAS que toca un periodo (para que la pantalla avise antes de editar). */
  async estado(p: { site_code?: string; date_from?: string; date_to?: string }): Promise<unknown[]> {
    if (!p.site_code || !RE_FECHA.test(String(p.date_from)) || !RE_FECHA.test(String(p.date_to))) {
      throw new BadRequestException('Faltan site_code, date_from y date_to (yyyy-MM-dd).');
    }
    return this.tk.run(this.tenantCtx.requireTenantId(), (trx) =>
      trx('hr.attendance_closures').where({ site_code: p.site_code }).whereNull('reopened_at')
        .where('period_start', '<=', String(p.date_to)).where('period_end', '>=', String(p.date_from))
        .orderBy('period_start').select(this.columnas(trx)));
  }

  /** Un cierre CON su foto (para descargarla o auditarla). */
  async uno(id: string): Promise<unknown> {
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const r = await trx('hr.attendance_closures').where({ id }).first([...this.columnas(trx), 'snapshot']);
      if (!r) throw new NotFoundException('Ese cierre no existe.');
      return r;
    });
  }

  /** Cierra la semana que abre el jueves `period_start`. */
  async cerrar(b: { site_code?: string; period_start?: string }): Promise<unknown> {
    const site = String(b.site_code || '').trim();
    const desde = String(b.period_start || '');
    if (!site || !RE_FECHA.test(desde)) throw new BadRequestException('Faltan site_code y period_start (yyyy-MM-dd).');
    if (inicioSemana(desde) !== desde) {
      throw new BadRequestException('La semana de nómina empieza en jueves: elige el jueves que la abre.');
    }
    const hasta = masDias(desde, 6);
    // Se cierra lo que ya pasó: una semana en curso todavía va a cambiar.
    if (hasta >= hoyMexico()) {
      throw new ConflictException(`La semana termina el miércoles ${hasta}: se puede cerrar a partir del día siguiente.`);
    }
    const q = this.quien();

    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      if (!(await reader.sitioExiste(trx, site))) throw new NotFoundException(`No existe el sitio de checado "${site}".`);
      const ya = await reader.cierreQueToca(trx, site, desde, hasta);
      if (ya) throw new ConflictException(textoSemanaCerrada(ya));

      // Las incidencias de la semana, tomadas: nadie entrega algo mientras se cierra.
      const deLaSemana: Array<{ id: string; status: string }> = await trx('hr.attendance_incidents')
        .where({ site_code: site }).where('date_from', '<=', hasta).where('date_to', '>=', desde)
        .whereIn('status', ['capturada', 'calificada']).forUpdate().select('id', 'status');
      const pend = deLaSemana.filter((r) => r.status === 'capturada').length;
      if (pend > 0) {
        throw new ConflictException(
          `Hay ${pend} incidencia${pend === 1 ? '' : 's'} por calificar en esta semana. Califícalas o recházalas antes de cerrar.`);
      }

      const foto = await this.report.calcular(trx, site, desde, hasta);

      const ids = deLaSemana.map((r) => r.id);
      if (ids.length) {
        await trx('hr.attendance_incidents').whereIn('id', ids).update({ status: 'cerrada', updated_at: trx.fn.now() });
        const { rows } = await trx.raw<{ rows: FilaIncidencia[] }>(
          `SELECT *, to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to
             FROM hr.attendance_incidents WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
        for (const fila of rows) {
          await this.incidents.registrar(trx, fila, 'cerrada', 'calificada', `Cierre de la semana del ${desde} al ${hasta}.`);
        }
      }

      const r = foto.resumen;
      const summary = {
        personas: r.personas, usables: r.usables, faltas: r.faltas,
        retardoRealMin: r.retardoRealMin, horasTrabajadas: r.horasTrabajadas, incidencias: ids.length,
      };
      try {
        const [nuevo] = await trx('hr.attendance_closures').insert({
          tenant_id: this.tenantCtx.requireTenantId(), site_code: site, period_start: desde, period_end: hasta,
          closed_by: q.id, closed_by_name: q.nombre, summary: JSON.stringify(summary), snapshot: JSON.stringify(foto),
        }).returning('id');
        const id = typeof nuevo === 'object' ? (nuevo as { id: string }).id : nuevo;
        return trx('hr.attendance_closures').where({ id }).first(this.columnas(trx));
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new ConflictException('Alguien más acaba de cerrar esta semana.');
        throw e;
      }
    });
  }

  /** Reabre un cierre. Exige motivo y no borra la foto. */
  async reabrir(id: string, motivo: string): Promise<unknown> {
    const m = String(motivo || '').trim();
    if (!m) throw new BadRequestException('Escribe por qué se reabre la semana: queda en el registro.');
    const q = this.quien();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const n = await trx('hr.attendance_closures').where({ id }).whereNull('reopened_at')
        .update({ reopened_by: q.id, reopened_by_name: q.nombre, reopened_at: trx.fn.now(), reopen_reason: m });
      if (!n) throw new ConflictException('Esa semana ya no está cerrada.');
      const act = await trx('hr.attendance_closures').where({ id }).first(this.columnas(trx));
      const { site_code: site, period_start: desde, period_end: hasta } = act as { site_code: string; period_start: string; period_end: string };
      // Las que tocan OTRA semana que siga cerrada se quedan cerradas.
      const { rows: incs } = await trx.raw<{ rows: Array<{ id: string; status: string }> }>(`
        SELECT i.id, i.status FROM hr.attendance_incidents i
         WHERE i.site_code = ? AND i.status IN ('cerrada', 'auditada')
           AND i.date_from <= ?::date AND i.date_to >= ?::date
           AND NOT EXISTS (SELECT 1 FROM hr.attendance_closures k
                            WHERE k.site_code = i.site_code AND k.reopened_at IS NULL
                              AND k.period_start <= i.date_to AND k.period_end >= i.date_from)
         FOR UPDATE`, [site, hasta, desde]);
      for (const antes of incs) {
        await trx('hr.attendance_incidents').where({ id: antes.id }).update({ status: 'calificada', updated_at: trx.fn.now() });
        const { rows: [fila] } = await trx.raw<{ rows: FilaIncidencia[] }>(
          `SELECT *, to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to
             FROM hr.attendance_incidents WHERE id = ?`, [antes.id]);
        await this.incidents.registrar(trx, fila, 'reabierta', antes.status, `Se reabrió la semana del ${desde} al ${hasta}: ${m}`);
      }
      return act;
    });
  }
}
