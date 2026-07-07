import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

/**
 * MAAT.0 — Base de conocimiento de Maat (`finance.knowledge`).
 *
 * Lo que la AI "sabe" además de la data viva: definiciones del modelo contable
 * Kepler, hechos verificados, reglas de negocio para feeds/reportes e issues
 * conocidos. Se inyecta al system prompt del chat (MAAT.3) y crece cuando
 * Finanzas valida hechos en conversación (L0 de ADR-021).
 *
 * Upsert por (tenant_id, kind, title) → seeds y saves idempotentes.
 */

export type KnowledgeKind = 'definicion' | 'hecho' | 'regla_negocio' | 'issue_conocido';
const KINDS: KnowledgeKind[] = ['definicion', 'hecho', 'regla_negocio', 'issue_conocido'];

export interface KnowledgeEntry {
  kind: KnowledgeKind;
  title: string;
  body: string;
  source?: 'seed' | 'chat' | 'finanzas';
  created_by?: string | null;
}

@Injectable()
export class MaatKnowledgeService {
  private readonly logger = new Logger(MaatKnowledgeService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Listado filtrable — es lo que consume el system prompt del chat. */
  async list(q: { kind?: string; q?: string; status?: string; limit?: number }) {
    this.tenantCtx.requireTenantId();
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    return this.tk.run(async (trx) => {
      const b = trx('finance.knowledge')
        .where('status', q.status === 'retired' ? 'retired' : 'active')
        .select('id', 'kind', 'title', 'body', 'source', 'status', 'created_by', 'updated_at')
        .orderBy(['kind', 'title'])
        .limit(limit);
      if (q.kind) b.where('kind', q.kind);
      if (q.q?.trim()) b.whereRaw('(title ILIKE ? OR body ILIKE ?)', [`%${q.q.trim()}%`, `%${q.q.trim()}%`]);
      return b;
    });
  }

  /** Conteos por kind — verificación de seeds + salud de la base. */
  async stats() {
    this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const rows: { kind: string; status: string; num: number }[] = await trx('finance.knowledge')
        .groupBy('kind', 'status')
        .select('kind', 'status', trx.raw('COUNT(*)::int AS num'))
        .orderBy('kind');
      return { by_kind: rows.map((r) => ({ ...r, num: Number(r.num) })) };
    });
  }

  /** Alta/actualización idempotente (la usa el chat vía save_knowledge en MAAT.3). */
  async upsert(entry: KnowledgeEntry) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!entry?.title?.trim() || !entry?.body?.trim()) throw new BadRequestException('title y body son requeridos');
    if (!KINDS.includes(entry.kind)) throw new BadRequestException(`kind inválido (${KINDS.join('|')})`);
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.knowledge')
        .insert({
          tenant_id: tenantId,
          kind: entry.kind,
          title: entry.title.trim(),
          body: entry.body.trim(),
          source: entry.source || 'finanzas',
          created_by: entry.created_by || null,
        })
        .onConflict(['tenant_id', 'kind', 'title'])
        .merge({ body: entry.body.trim(), status: 'active', updated_at: trx.fn.now() })
        .returning(['id', 'kind', 'title', 'status']);
      this.logger.log(`knowledge upsert: [${row.kind}] ${row.title}`);
      return row;
    });
  }

  /** Retirar/reactivar una entrada (soft — el conocimiento no se borra). */
  async setStatus(id: string, status: 'active' | 'retired') {
    this.tenantCtx.requireTenantId();
    if (!['active', 'retired'].includes(status)) throw new BadRequestException('status inválido (active|retired)');
    return this.tk.run(async (trx) => {
      const [row] = await trx('finance.knowledge')
        .where('id', id)
        .update({ status, updated_at: trx.fn.now() })
        .returning(['id', 'kind', 'title', 'status']);
      if (!row) throw new BadRequestException('entrada no encontrada');
      return row;
    });
  }
}
