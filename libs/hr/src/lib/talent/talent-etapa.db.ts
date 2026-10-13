import type { Knex } from 'knex';

/**
 * Fase RH · `[RH.2.4]` — registrar un cambio de etapa: el renglón de la bitácora (con las horas que pasó en la etapa
 * que deja) y la etapa nueva, en la MISMA transacción. Lo usan RH (`moverEtapa`) y el avance automático del
 * cuestionario; antes cada uno tenía su copia del cálculo de horas.
 *
 * Las horas: desde su última transición o, si nunca se movió, desde su alta. Si no tenía etapa (llegó por el bot), la
 * que deja es Filtro Inicial (regla de Mega Talento).
 */
export async function registrarCambioEtapa(trx: Knex.Transaction, a: {
  candidateId: string; desde: string | null; hacia: string; quienId: string | null; quienNombre: string;
}): Promise<void> {
  await trx.raw(`
    INSERT INTO talent.candidate_stage_transitions
      (tenant_id, candidate_id, stage_from, stage_to, hours_in_from, changed_by, changed_by_name)
    SELECT c.tenant_id, c.id, ?, ?,
           GREATEST(0, EXTRACT(EPOCH FROM (now() - coalesce(
             (SELECT max(t.changed_at) FROM talent.candidate_stage_transitions t WHERE t.candidate_id = c.id),
             c.created_at))) / 3600),
           ?, ?
      FROM talent.candidates c WHERE c.id = ?`, [a.desde ?? 'filtro_inicial', a.hacia, a.quienId, a.quienNombre, a.candidateId]);
  await trx('talent.candidates').where({ id: a.candidateId }).update({ stage: a.hacia, last_activity_at: trx.fn.now(), updated_at: trx.fn.now() });
}
