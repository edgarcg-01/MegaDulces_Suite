import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * MAAT.9 (3.0 P3) — HITL: acciones propuestas por Maat con aprobación humana (ADR-013).
 *
 * Maat propone (estado `pending_approval`) → humano aprueba/rechaza → al aprobar se
 * EJECUTA el efecto sobre NUESTRAS tablas (nunca Kepler). Ejecución acotada y sew
 * segura: hoy soporta `revisar_hallazgo` (mueve un finding a en_revision) y
 * `marcar_documento`/`conciliar_saldo`/`nota_contable`/`otro` (registro + audit,
 * sin mutación externa). Sin aprobación humana no pasa nada — co-piloto puro.
 */

const KINDS = ['revisar_hallazgo', 'conciliar_saldo', 'marcar_documento', 'nota_contable', 'otro'];

@Injectable()
export class MaatActionsService {
  private readonly logger = new Logger(MaatActionsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Maat (o el motor) propone una acción. Queda pendiente de aprobación humana. */
  async propose(a: { kind: string; titulo: string; descripcion?: string; payload?: any; efecto?: string; finding_id?: string; importe?: number; origen?: string; created_by?: string }) {
    this.tenantCtx.requireTenantId();
    if (!a?.titulo?.trim()) throw new BadRequestException('titulo requerido');
    const kind = KINDS.includes(a.kind) ? a.kind : 'otro';
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.proposed_actions')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          kind, titulo: a.titulo.trim(), descripcion: a.descripcion || null,
          payload: a.payload ? JSON.stringify(a.payload) : null, efecto: a.efecto || null,
          finding_id: a.finding_id || null, importe: a.importe || 0,
          origen: a.origen || 'maat_chat', created_by: a.created_by || null,
        })
        .returning(['id', 'kind', 'titulo', 'estado']);
      this.logger.log(`acción propuesta [${row.kind}] ${row.titulo}`);
      return row;
    });
  }

  /** Bandeja de acciones (default pendientes). */
  async list(q: { estado?: string; limit?: number }) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
    return this.tk.run(async (trx) => {
      const b = trx('finance.proposed_actions')
        .select('id', 'kind', 'titulo', 'descripcion', 'payload', 'efecto', 'estado', 'origen',
          'finding_id', trx.raw('importe::numeric AS importe'), 'created_by', 'decided_by', 'decided_at', 'resultado', 'created_at')
        .orderBy('created_at', 'desc').limit(limit);
      if (q.estado) b.where('estado', q.estado);
      else b.where('estado', 'pending_approval');
      const rows = await b;
      return rows.map((r: any) => ({ ...r, importe: Number(r.importe) }));
    });
  }

  async stats() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows = await trx('finance.proposed_actions').groupBy('estado')
        .select('estado', trx.raw('COUNT(*)::int AS n'));
      const by = Object.fromEntries(rows.map((r: any) => [r.estado, Number(r.n)]));
      return { pendientes: by['pending_approval'] || 0, aprobadas: by['approved'] || 0, ejecutadas: by['executed'] || 0, rechazadas: by['rejected'] || 0 };
    });
  }

  /** Rechaza una acción propuesta (no se ejecuta). */
  async reject(id: string, actor?: string, nota?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.proposed_actions').where({ id, estado: 'pending_approval' })
        .update({ estado: 'rejected', decided_by: actor || null, decided_at: trx.fn.now(), resultado: nota || 'rechazada', updated_at: trx.fn.now() })
        .returning(['id', 'estado']);
      if (!row) throw new BadRequestException('acción no encontrada o ya decidida');
      return row;
    });
  }

  /**
   * Aprueba y EJECUTA (misma trx). El efecto vive en NUESTRAS tablas; jamás toca
   * Kepler. La corrección contable real la hace un humano en Kepler — aquí queda
   * la decisión auditada + el efecto de plataforma que corresponda.
   */
  async approve(id: string, actor?: string) {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const a = await trx('finance.proposed_actions').where({ id, estado: 'pending_approval' }).first();
      if (!a) throw new BadRequestException('acción no encontrada o ya decidida');
      await trx('finance.proposed_actions').where({ id }).update({ estado: 'approved', decided_by: actor || null, decided_at: trx.fn.now(), updated_at: trx.fn.now() });

      let resultado = 'Aprobada. Efecto registrado (sin mutación externa).';
      try {
        if (a.kind === 'revisar_hallazgo' && a.finding_id) {
          const upd = await trx('finance.findings').where({ id: a.finding_id }).update({ status: 'en_revision', updated_at: trx.fn.now() });
          resultado = upd ? 'Hallazgo movido a "en revisión".' : 'Hallazgo no encontrado (sin efecto).';
        }
        // conciliar_saldo | marcar_documento | nota_contable | otro → solo audit de la decisión (la acción real la ejecuta un humano en Kepler).
        await trx('finance.proposed_actions').where({ id }).update({ estado: 'executed', executed_at: trx.fn.now(), resultado, updated_at: trx.fn.now() });
        this.logger.log(`acción ${id} [${a.kind}] aprobada+ejecutada por ${actor || '?'}: ${resultado}`);
        return { id, estado: 'executed', resultado };
      } catch (e: any) {
        await trx('finance.proposed_actions').where({ id }).update({ estado: 'failed', resultado: String(e?.message || e).slice(0, 300), updated_at: trx.fn.now() });
        return { id, estado: 'failed', resultado: String(e?.message || e).slice(0, 300) };
      }
    });
  }
}
