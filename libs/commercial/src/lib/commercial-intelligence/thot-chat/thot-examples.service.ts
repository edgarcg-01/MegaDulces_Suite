import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { ThotExample, THOT_SEED_EXAMPLES, rankExamples, formatExamples } from './thot-examples';

/**
 * TC.4a (ADR-026) — Biblioteca de ejemplos verificados de Thot Chat.
 * Combina ejemplos SEMILLA (en código) + CURADOS (commercial.thot_chat_examples),
 * ranquea por similitud con la pregunta y arma el fragmento few-shot. También cura:
 * agregar a mano o promover una fila buena desde thot_chat_log.
 */
@Injectable()
export class ThotExamplesService {
  private readonly logger = new Logger(ThotExamplesService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /** Fragmento few-shot para el system prompt (semilla + curados, top-K por solape). */
  async promptFragment(profile: string, question: string): Promise<string> {
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
    });
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
    return this.tk.run(async (trx) => {
      const n = await trx('commercial.thot_chat_examples').where({ id }).update({ enabled });
      if (!n) throw new NotFoundException('Ejemplo no encontrado');
      return { id, enabled };
    });
  }

  /** Promueve una fila de thot_chat_log a ejemplo dorado. */
  async promoteFromLog(logId: string, opts: { note?: string; profile?: string } = {}, userId?: string) {
    return this.tk.run(async (trx) => {
      const log = await trx('commercial.thot_chat_log').where({ id: logId }).first('question', 'answer', 'tools_used');
      if (!log) throw new NotFoundException('Registro de log no encontrado');
      const [row] = await trx('commercial.thot_chat_examples')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          profile: ['admin', 'portal', 'vendor'].includes(opts.profile || '') ? opts.profile : 'admin',
          question: String(log.question || '').slice(0, 2000),
          answer: String(log.answer || '').slice(0, 6000) || null,
          tools: typeof log.tools_used === 'string' ? log.tools_used : JSON.stringify(log.tools_used || []),
          note: (opts.note || 'Promovido desde el log').slice(0, 1000),
          created_by: userId || null,
        })
        .returning(['id', 'question']);
      return row;
    });
  }
}
