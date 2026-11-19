import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { HrHoyCandidatoDto, HrHoyDto } from '@megadulces/contracts';
import { SQL_ES_POSTULACION, etapaDe } from './logic/etapas';
import { faltantes, type EntradaDocumento } from './logic/expediente';
import {
  CUOTA_DIA, DIAS_APARTADO, DIAS_LIGA_VIGENTE, NOTA_LIGA_APTITUDES, NOTA_NO_CONTESTO, armarHoy, type FilaHoy,
} from './logic/hoy';

/** La fila tal como sale de la base, más lo que la regla necesita. */
interface FilaBase extends FilaHoy {
  full_name: string | null; phone: string | null; position_interest: string | null; city_branch: string | null; origin: string | null;
  availability: string | null; commute_time: string | null; desired_salary: string | null; rehire_note: string | null;
  intentos: number;
  faltan: string[];
}

const iso = (x: Date | string | null): string | null => (x == null ? null : x instanceof Date ? x.toISOString() : new Date(x).toISOString());

/**
 * Fase RH · `[RH.17.1]` — «Hoy» de Reclutamiento: SÓLO LECTURA. Lee los postulados activos (sin spam ni papelera, sin
 * contratados ni rechazados), con las señales que la regla de `logic/hoy.ts` necesita, y devuelve cada pendiente con su
 * total y la cuota del día. Las acciones de la pantalla usan los endpoints que ya existen (eventos y etapa).
 *
 * El universo es el mismo de la lista «Postulados» (`SQL_ES_POSTULACION`), para que «Hoy» y «Todos los candidatos»
 * hablen de la misma gente.
 */
@Injectable()
export class HrTalentHoyService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async hoy(): Promise<HrHoyDto> {
    const ahora = new Date();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const activos = (): Knex.QueryBuilder => trx('talent.candidates as c')
        .whereNull('c.deleted_at').where('c.is_spam', false).whereRaw(SQL_ES_POSTULACION)
        .where((w) => { w.whereNull('c.stage').orWhereNotIn('c.stage', ['contratado', 'rechazado']); });
      const desde = 'coalesce(c.last_activity_at, c.created_at)';

      // Los apartados sólo se cuentan: no se trabajan hoy y no hace falta traerlos.
      const [{ n }] = await activos().whereRaw(`${desde} <= now() - make_interval(days => ?)`, [DIAS_APARTADO])
        .count<{ n: string }[]>('* as n');

      const crudas = await activos().whereRaw(`${desde} > now() - make_interval(days => ?)`, [DIAS_APARTADO]).select(
        'c.id', 'c.full_name', 'c.phone', 'c.position_interest', 'c.city_branch', 'c.stage', 'c.created_at', 'c.last_activity_at',
        'c.origin', 'c.availability', 'c.commute_time', 'c.desired_salary', 'c.rehire_note', 'c.cv_url', 'c.documents',
        trx.raw('(c.aptitude_eval IS NOT NULL) AS tiene_eval'),
        // «Le habló alguien de RH»: un contacto o una entrevista con usuario. Las notas del bot y del sistema no cuentan.
        trx.raw(`EXISTS (SELECT 1 FROM talent.candidate_events e WHERE e.candidate_id = c.id AND e.actor_id IS NOT NULL
                   AND e.event_type IN ('contacto', 'entrevista')) AS contactado`),
        trx.raw(`EXISTS (SELECT 1 FROM talent.candidate_events e WHERE e.candidate_id = c.id AND e.note LIKE ?
                   AND e.occurred_at > now() - make_interval(days => ?)) AS liga_aptitudes_vigente`, [`${NOTA_LIGA_APTITUDES}%`, DIAS_LIGA_VIGENTE]),
        // Los «No contestó» desde su último cambio de etapa (o desde el alta).
        trx.raw(`(SELECT count(*)::int FROM talent.candidate_events e WHERE e.candidate_id = c.id AND e.note = ?
                   AND e.occurred_at >= coalesce((SELECT max(t.changed_at) FROM talent.candidate_stage_transitions t WHERE t.candidate_id = c.id), c.created_at)
                 ) AS intentos`, [NOTA_NO_CONTESTO]),
      ) as Array<Record<string, unknown>>;

      const filas: FilaBase[] = crudas.map((r) => {
        const faltan = faltantes(Array.isArray(r['documents']) ? r['documents'] as EntradaDocumento[] : [], !!(r['cv_url'] && String(r['cv_url']).trim()));
        return {
          id: String(r['id']), stage: (r['stage'] as string | null) ?? null, created_at: r['created_at'] as Date, last_activity_at: (r['last_activity_at'] as Date | null) ?? null,
          contactado: !!r['contactado'], faltantes: faltan.length, faltan, tiene_eval: !!r['tiene_eval'], liga_aptitudes_vigente: !!r['liga_aptitudes_vigente'],
          full_name: (r['full_name'] as string | null) ?? null, phone: (r['phone'] as string | null) ?? null,
          position_interest: (r['position_interest'] as string | null) ?? null, city_branch: (r['city_branch'] as string | null) ?? null,
          origin: (r['origin'] as string | null) ?? null, availability: (r['availability'] as string | null) ?? null,
          commute_time: (r['commute_time'] as string | null) ?? null, desired_salary: (r['desired_salary'] as string | null) ?? null,
          rehire_note: (r['rehire_note'] as string | null) ?? null, intentos: Number(r['intentos']) || 0,
        };
      });

      const armado = armarHoy(filas, ahora, CUOTA_DIA);
      const ultimos = await this.ultimos(trx, armado.pendientes.flatMap((p) => p.filas.map((f) => f.id)));

      return {
        generado_en: ahora.toISOString(),
        cuota: CUOTA_DIA,
        apartados: Number(n) + armado.apartados,
        dias_apartado: DIAS_APARTADO,
        pendientes: armado.pendientes.map((p) => ({
          id: p.id, total: p.total,
          candidatos: p.filas.map((f): HrHoyCandidatoDto => ({
            id: f.id, full_name: f.full_name, phone: f.phone, position_interest: f.position_interest, city_branch: f.city_branch,
            stage: etapaDe(f.stage), created_at: iso(f.created_at) as string, last_activity_at: iso(f.last_activity_at), origin: f.origin,
            availability: f.availability, commute_time: f.commute_time, desired_salary: f.desired_salary, rehire_note: f.rehire_note,
            intentos_sin_respuesta: f.intentos, documentos_faltantes: f.faltan, ultimos: ultimos.get(f.id) ?? [],
          })),
        })),
      };
    });
  }

  /** Lo último que pasó con cada candidato de la cuota (hasta 3): eventos y cambios de etapa, juntos. */
  private async ultimos(trx: Knex.Transaction, ids: string[]): Promise<Map<string, HrHoyCandidatoDto['ultimos']>> {
    const mapa = new Map<string, HrHoyCandidatoDto['ultimos']>();
    if (!ids.length) return mapa;
    const eventos = await trx('talent.candidate_events').whereIn('candidate_id', ids)
      .select('candidate_id', 'event_type', 'channel', 'note', 'actor_name', 'occurred_at') as Array<Record<string, unknown>>;
    const pasos = await trx('talent.candidate_stage_transitions').whereIn('candidate_id', ids)
      .select('candidate_id', 'stage_from', 'stage_to', 'changed_by_name', 'changed_at') as Array<Record<string, unknown>>;
    const todos = [
      ...eventos.map((e) => ({ id: String(e['candidate_id']), cuando: iso(e['occurred_at'] as Date) as string, quien: (e['actor_name'] as string | null) ?? null,
        texto: [String(e['event_type']), e['channel'], e['note']].filter(Boolean).join(' · ') })),
      ...pasos.map((t) => ({ id: String(t['candidate_id']), cuando: iso(t['changed_at'] as Date) as string, quien: (t['changed_by_name'] as string | null) ?? null,
        texto: `Cambio de etapa: ${etapaDe(t['stage_from'] as string | null)} → ${etapaDe(t['stage_to'] as string | null)}` })),
    ].sort((a, b) => (a.cuando < b.cuando ? 1 : a.cuando > b.cuando ? -1 : 0));
    for (const x of todos) {
      const l = mapa.get(x.id) ?? [];
      if (l.length < 3) { l.push({ cuando: x.cuando, texto: x.texto, quien: x.quien }); mapa.set(x.id, l); }
    }
    return mapa;
  }
}
