import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { RE_FECHA } from './logic/fechas';

/**
 * Fase RH · `[RH.1.5]` — el lado HUMANO de las alertas: RH ve lo que el agente sugirió y decide.
 * Traslado de `persistencia.ts` (listar, decidir, agrupar) de Mega Talento.
 *
 * ══ LA COLA AGRUPADA POR CAUSA ══
 * Al 30/07/2026 Mega Talento tenía 2,510 borradores esperando y CERO decididos: pedir 2,510
 * decisiones una por una garantiza que no se tome ninguna. `checada_duplicada` es del LECTOR
 * (decisión por sitio) y `entrada_sin_salida` es de la rutina de una PERSONA (por persona); por
 * eso se agrupa por regla + sitio (+ persona).
 *
 * ══ APROBAR ES DE UNA EN UNA ══
 * En Mega Talento aprobar avisaba al jefe por WhatsApp, y un grupo de 400 habrían sido 400
 * mensajes a una persona real. En la Suite el aviso todavía no existe (llega con el bot, `[RH.3]`),
 * pero la regla se conserva: en bloque sólo se rechaza o se descarta. Cuando el aviso llegue, la
 * cola ya estará acostumbrada a la regla correcta.
 */

export type EstadoAlerta = 'sugerida_ia' | 'aprobada' | 'rechazada' | 'descartada';
const DECISIONES: EstadoAlerta[] = ['aprobada', 'rechazada', 'descartada'];

const COLUMNAS = [
  'id', 'site_code', 'person_code', 'person_name', 'user_id', 'rule', 'severity', 'detail', 'evidence',
  'suggested_justification', 'status', 'origin', 'decided_by', 'decided_by_name', 'decided_at',
  'supervisor_justification', 'responded_by', 'responded_at', 'analyzed_at',
];

@Injectable()
export class HrAttendanceAlertsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private actor(): { id: string | null; nombre: string | null } {
    const c = this.tenantCtx.get();
    return { id: c?.userId ?? null, nombre: c?.username ?? null };
  }

  async listar(f: { site_code: string; date_from?: string; date_to?: string; status?: string; person_code?: string }): Promise<unknown[]> {
    if (!f.site_code) throw new BadRequestException('Falta site_code.');
    return this.tk.run(this.tenantCtx.requireTenantId(), (trx) => {
      const q = trx('hr.attendance_alerts').where({ site_code: f.site_code });
      if (f.date_from) q.where('work_date', '>=', f.date_from);
      if (f.date_to) q.where('work_date', '<=', f.date_to);
      if (f.status) q.where({ status: f.status });
      if (f.person_code) q.where({ person_code: f.person_code });
      return q.orderBy([{ column: 'work_date', order: 'desc' }, { column: 'person_name' }, { column: 'rule' }])
        .select([...COLUMNAS, trx.raw(`to_char(work_date, 'YYYY-MM-DD') AS work_date`)]);
    });
  }

  /** La misma cola agrupada. `level='site'` es el nivel correcto para `checada_duplicada`. */
  async agrupar(f: { site_code?: string; date_from?: string; date_to?: string; status?: string; level?: string }): Promise<{
    grupos: unknown[]; porRegla: Record<string, number>; total: number; nivel: 'persona' | 'sitio';
  }> {
    const porSitio = f.level === 'site';
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const q = trx('hr.attendance_alerts').where({ status: f.status || 'sugerida_ia' });
      if (f.site_code) q.where({ site_code: f.site_code });
      if (f.date_from) q.where('work_date', '>=', f.date_from);
      if (f.date_to) q.where('work_date', '<=', f.date_to);
      const grupos: Array<{ rule: string; total: number }> = await q
        .groupBy(porSitio ? ['rule', 'site_code'] : ['rule', 'site_code', 'person_code'])
        .orderByRaw('count(*) DESC')
        .select(
          'rule', 'site_code',
          trx.raw(porSitio ? `'' AS person_code` : 'person_code'),
          trx.raw(porSitio ? `count(DISTINCT person_code)::int || ' persona(s)' AS person_name` : 'max(person_name) AS person_name'),
          trx.raw('count(DISTINCT person_code)::int AS personas'),
          trx.raw('count(*)::int AS total'),
          trx.raw(`to_char(min(work_date), 'YYYY-MM-DD') AS primera`),
          trx.raw(`to_char(max(work_date), 'YYYY-MM-DD') AS ultima`),
          trx.raw('count(*) FILTER (WHERE supervisor_justification IS NOT NULL)::int AS con_justificacion'),
        );
      const porRegla: Record<string, number> = {};
      for (const g of grupos) porRegla[g.rule] = (porRegla[g.rule] || 0) + g.total;
      return { grupos, porRegla, total: grupos.reduce((s, g) => s + g.total, 0), nivel: porSitio ? 'sitio' : 'persona' };
    });
  }

  /** RH resuelve UNA alerta. Registra quién y cuándo; opcionalmente reescribe la justificación. */
  async decidir(id: string, status: string, justification?: string): Promise<unknown> {
    if (!DECISIONES.includes(status as EstadoAlerta)) {
      throw new BadRequestException('status debe ser aprobada, rechazada o descartada.');
    }
    const a = this.actor();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const sets: Record<string, unknown> = { status, decided_by: a.id, decided_by_name: a.nombre, decided_at: trx.fn.now() };
      if (justification !== undefined) sets['suggested_justification'] = justification;
      const [row] = await trx('hr.attendance_alerts').where({ id }).update(sets)
        .returning([...COLUMNAS, trx.raw(`to_char(work_date, 'YYYY-MM-DD') AS work_date`)]);
      if (!row) throw new NotFoundException('Alerta no encontrada.');
      return { ...row, aviso: { enviado: false, motivo: 'el aviso al jefe por WhatsApp llega con el bot ([RH.3])' } };
    });
  }

  /**
   * Decide un GRUPO de una vez: sólo rechazar o descartar (ver la cabecera). Sólo toca lo que
   * sigue en `sugerida_ia`: jamás pisa una decisión ya tomada, ni con el mismo filtro dos veces.
   */
  async decidirGrupo(b: {
    rule?: string; site_code?: string; person_code?: string; date_from?: string; date_to?: string;
    status?: string; justification?: string;
  }): Promise<{ afectadas: number }> {
    if (!b.rule || !b.site_code) throw new BadRequestException('Faltan rule y site_code.');
    if (b.status !== 'rechazada' && b.status !== 'descartada') {
      throw new BadRequestException('En bloque sólo se puede rechazar o descartar. Aprobar es de una en una.');
    }
    for (const f of [b.date_from, b.date_to]) if (f && !RE_FECHA.test(f)) throw new BadRequestException('Las fechas deben venir como yyyy-MM-dd.');
    const a = this.actor();
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const q = trx('hr.attendance_alerts').where({ status: 'sugerida_ia', rule: b.rule, site_code: b.site_code });
      if (b.person_code) q.whereRaw('btrim(person_code) = btrim(?)', [b.person_code]);
      if (b.date_from) q.where('work_date', '>=', b.date_from);
      if (b.date_to) q.where('work_date', '<=', b.date_to);
      const sets: Record<string, unknown> = { status: b.status, decided_by: a.id, decided_by_name: a.nombre, decided_at: trx.fn.now() };
      if (b.justification) sets['suggested_justification'] = b.justification;
      const afectadas = await q.update(sets);
      return { afectadas };
    });
  }
}
