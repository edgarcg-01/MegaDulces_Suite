import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { ThotExample, THOT_SEED_EXAMPLES, rankExamples, formatExamples } from './thot-examples';
import { ThotExampleVectorService } from './thot-example-vector.service';

/**
 * TC.4a (ADR-026) — Biblioteca de ejemplos verificados de Thot Chat.
 * Combina ejemplos SEMILLA (en código) + CURADOS (commercial.thot_chat_examples),
 * ranquea por similitud con la pregunta y arma el fragmento few-shot. También cura:
 * agregar a mano o promover una fila buena desde thot_chat_log.
 */
@Injectable()
export class ThotExamplesService {
  private readonly logger = new Logger(ThotExamplesService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly ctx: TenantContextService,
    private readonly vector: ThotExampleVectorService,
  ) {}

  /** Fragmento few-shot para el system prompt. TC.4b: embeddings si hay vector DB; si no, solape. */
  async promptFragment(profile: string, question: string): Promise<string> {
    // TC.4b — retrieval por embeddings (mejor que solape). Si no hay vector DB o
    // no devuelve nada, cae al ranking por tokens de abajo.
    if (this.vector.available()) {
      try {
        const tenantId = this.ctx.requireTenantId();
        const hits = await this.vector.search(tenantId, profile, question, 3);
        if (hits.length) return formatExamples(hits);
      } catch (e: any) {
        this.logger.warn(`few-shot vector falló (${e?.message || e}); uso solape.`);
      }
    }
    return this.promptFragmentByOverlap(profile, question);
  }

  private async promptFragmentByOverlap(profile: string, question: string): Promise<string> {
    let curated: ThotExample[] = [];
    try {
      curated = await this.tk.run(async (trx) => {
        const rows = await trx('commercial.thot_chat_examples')
          .where({ enabled: true })
          .andWhere((w: any) => w.where('profile', profile).orWhereNull('profile'))
          .orderBy('created_at', 'desc')
          .limit(200)
          .select('profile', 'question', 'answer', 'tools', 'note');
        return rows.map((r: any) => ({
          profile: r.profile,
          question: r.question,
          answer: r.answer || '',
          tools: Array.isArray(r.tools) ? r.tools.map((t: any) => t?.name || t) : [],
          note: r.note || undefined,
        }));
      });
    } catch (e: any) {
      // La tabla puede no existir aún (migración sin aplicar): degradamos a semillas.
      this.logger.warn(`thot_chat_examples no disponible (${e?.message || e}); uso solo semillas.`);
    }
    const pool = [...curated, ...THOT_SEED_EXAMPLES];
    return formatExamples(rankExamples(question, pool, profile, 3));
  }

  async add(dto: { profile?: string; question: string; answer?: string; tools?: any[]; note?: string }, userId?: string) {
    if (!dto?.question?.trim()) throw new BadRequestException('question requerido');
    const profile = ['admin', 'portal', 'vendor'].includes(dto.profile || '') ? dto.profile : 'admin';
    return this.tk.run(async (trx) => {
      const [row] = await trx('commercial.thot_chat_examples')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          profile,
          question: dto.question.trim().slice(0, 2000),
          answer: (dto.answer || '').slice(0, 6000) || null,
          tools: JSON.stringify(dto.tools || []),
          note: (dto.note || '').slice(0, 1000) || null,
          created_by: userId || null,
        })
        .returning(['id', 'profile', 'question']);
      return row;
    }).then(async (row: any) => {
      await this.vector.upsert(this.tenantId(), row.id, { profile, question: dto.question, answer: dto.answer, tools: dto.tools, note: dto.note, enabled: true });
      return row;
    });
  }

  private tenantId(): string {
    try { return this.ctx.requireTenantId(); } catch { return ''; }
  }

  async list(profile?: string) {
    return this.tk.run(async (trx) =>
      trx('commercial.thot_chat_examples')
        .modify((qb: any) => { if (profile) qb.where('profile', profile); })
        .orderBy('created_at', 'desc')
        .limit(500)
        .select('id', 'profile', 'question', 'answer', 'tools', 'note', 'enabled', 'created_at'),
    );
  }

  async setEnabled(id: string, enabled: boolean) {
    const res = await this.tk.run(async (trx) => {
      const n = await trx('commercial.thot_chat_examples').where({ id }).update({ enabled });
      if (!n) throw new NotFoundException('Ejemplo no encontrado');
      return { id, enabled };
    });
    await this.vector.setEnabled(this.tenantId(), id, enabled);
    return res;
  }

  /** Reindexa semillas + ejemplos curados en la DB vector (TC.4b). */
  async reindex() {
    const curated = await this.tk.run(async (trx) =>
      trx('commercial.thot_chat_examples')
        .where({ enabled: true })
        .select('id', 'profile', 'question', 'answer', 'tools', 'note'),
    );
    const mapped = curated.map((r: any) => ({
      id: r.id, profile: r.profile, question: r.question, answer: r.answer || '',
      tools: Array.isArray(r.tools) ? r.tools : [], note: r.note || undefined, enabled: true,
    }));
    return this.vector.reindex(this.tenantId(), THOT_SEED_EXAMPLES, mapped);
  }

  /** Promueve una fila de thot_chat_log a ejemplo dorado (y la marca como promovida). */
  async promoteFromLog(logId: string, opts: { note?: string; profile?: string } = {}, userId?: string) {
    const profile = ['admin', 'portal', 'vendor'].includes(opts.profile || '') ? opts.profile! : 'admin';
    const out = await this.tk.run(async (trx) => {
      const log = await trx('commercial.thot_chat_log').where({ id: logId }).first('question', 'answer', 'tools_used');
      if (!log) throw new NotFoundException('Registro de log no encontrado');
      const toolsRaw = typeof log.tools_used === 'string' ? log.tools_used : JSON.stringify(log.tools_used || []);
      const [row] = await trx('commercial.thot_chat_examples')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          profile,
          question: String(log.question || '').slice(0, 2000),
          answer: String(log.answer || '').slice(0, 6000) || null,
          tools: toolsRaw,
          note: (opts.note || 'Promovido desde el log').slice(0, 1000),
          created_by: userId || null,
        })
        .returning(['id', 'question']);
      await trx('commercial.thot_chat_log').where({ id: logId }).update({ promoted: true }).catch(() => undefined);
      let tools: any[] = [];
      try { tools = JSON.parse(toolsRaw); } catch { /* noop */ }
      return { row, answer: log.answer, tools };
    });
    await this.vector.upsert(this.tenantId(), out.row.id, { profile, question: out.row.question, answer: out.answer, tools: out.tools });
    return out.row;
  }

  /** Cola de curaduría: respuestas con 👍 que aún no son ejemplo. */
  async candidates(limitParam?: number) {
    const limit = Math.min(100, Math.max(1, Number(limitParam) || 30));
    return this.tk.run(async (trx) =>
      trx('commercial.thot_chat_log')
        .where({ feedback: 1, promoted: false })
        .whereNotNull('answer')
        .orderBy('created_at', 'desc')
        .limit(limit)
        .select('id', 'question', 'answer', 'tools_used', 'user_name', 'created_at'),
    );
  }
}
