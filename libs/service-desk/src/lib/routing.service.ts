/**
 * `[MS.3.10]` Asignación automática de tickets nuevos: administración de las reglas y su resolución. ADR-081.
 *
 * La función que ELIGE la regla es pura y vive en `domain/routing.ts`; acá se leen las reglas, se verifica que el
 * destino pueda atender y se administra el catálogo. Dos reglas de oro:
 *
 *  · **Nunca se asigna a quien no puede atender.** Un ticket en la mesa de alguien sin `SERVICIO_ATENDER` es un
 *    ticket que nadie ve (no abre la bandeja ni su ficha) pero que cuenta como «asignado» y por eso sale de la
 *    cola de sin asignar: el peor lugar para que se pierda. Si la regla gana pero el destino no puede, el
 *    ticket queda SIN ASIGNAR y se deja una nota interna que lo dice.
 *  · **La regla que gana es la primera que aplica, aunque su destino no pueda.** No se salta a la siguiente en
 *    silencio: sería esconder que la regla de impresoras apunta a alguien sin permiso.
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import type { SdRoutingResponse, SdRoutingRuleDto, SdUpsertRoutingRuleDto } from '@megadulces/contracts';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { ServiceDeskAgentsService } from './agents.service';
import { elegirRegla, normalizarClaves, type EntradaRuteo, type ReglaRuteo, type ResultadoRuteo } from './domain/routing';
import type { ActorCtx } from './service-desk.types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CLAVES = 40;
const MAX_LARGO_CLAVE = 60;
const MAX_NOMBRE = 120;

export interface DestinoRuteo {
  resultado: ResultadoRuteo;
  assigneeName: string | null;
  /** `false` = la regla ganó pero su destino no puede atender: NO se asigna. */
  asignable: boolean;
}

interface FilaRegla {
  id: string;
  name: string;
  keywords: string[] | null;
  category_id: string | null;
  assignee_id: string;
  sort_order: number | string;
  active: boolean;
}

@Injectable()
export class ServiceDeskRoutingService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly agents: ServiceDeskAgentsService,
  ) {}

  // ───────────────────────────── resolución (la usa `create`) ─────────────────────────────

  /** Decide a quién le toca un ticket nuevo, dentro de la transacción de su alta. `null` = ninguna regla aplica. */
  async resolver(trx: Knex.Transaction, entrada: EntradaRuteo): Promise<DestinoRuteo | null> {
    const filas = (await trx('servicedesk.routing_rules')
      .whereNull('deleted_at')
      .select('id', 'name', 'keywords', 'category_id', 'assignee_id', 'sort_order', 'active')) as FilaRegla[];
    const reglas: ReglaRuteo[] = filas.map((f) => ({
      id: f.id,
      name: f.name,
      keywords: f.keywords ?? [],
      category_id: f.category_id,
      assignee_id: f.assignee_id,
      sort_order: Number(f.sort_order),
      active: f.active,
    }));
    const resultado = elegirRegla(reglas, entrada);
    if (!resultado) return null;
    const persona = await trx('identity.users').where({ id: resultado.regla.assignee_id }).whereNull('deleted_at').first('nombre', 'username');
    const asignable = !!persona && (await this.agents.esAsignable(trx, resultado.regla.assignee_id));
    return { resultado, assigneeName: persona ? persona.nombre || persona.username : null, asignable };
  }

  // ───────────────────────────── administración ─────────────────────────────

  list(): Promise<SdRoutingResponse> {
    return this.tk.run(async (trx) => {
      const asignables = new Set((await this.agents.listIn(trx)).map((a) => a.user_id));
      const { rows } = await trx.raw(
        `SELECT r.id, r.name, r.keywords, r.category_id, c.name AS category_name, r.assignee_id,
                u.nombre AS assignee_name, u.username AS assignee_username, r.sort_order, r.active
           FROM servicedesk.routing_rules r
           JOIN identity.users u ON u.tenant_id = r.tenant_id AND u.id = r.assignee_id
           LEFT JOIN servicedesk.categories c ON c.tenant_id = r.tenant_id AND c.id = r.category_id
          WHERE r.deleted_at IS NULL
          ORDER BY r.sort_order, lower(r.name)`,
      );
      const rules: SdRoutingRuleDto[] = (rows as Array<Record<string, unknown>>).map((r) => ({
        id: String(r['id']),
        name: String(r['name']),
        keywords: (r['keywords'] as string[]) ?? [],
        category_id: (r['category_id'] as string | null) ?? null,
        category_name: (r['category_name'] as string | null) ?? null,
        assignee_id: String(r['assignee_id']),
        assignee_name: (r['assignee_name'] as string | null) ?? null,
        assignee_username: String(r['assignee_username']),
        assignee_ok: asignables.has(String(r['assignee_id'])),
        sort_order: Number(r['sort_order']),
        active: !!r['active'],
      }));
      return { rules };
    });
  }

  async create(ctx: ActorCtx, dto: SdUpsertRoutingRuleDto): Promise<SdRoutingResponse> {
    const name = this.nombre(dto?.name);
    if (!name) throw new BadRequestException('Escribe un nombre para la regla');
    const keywords = dto.keywords !== undefined ? this.claves(dto.keywords) : [];
    const categoryId = dto.category_id ?? null;
    if (categoryId !== null && !UUID_RE.test(categoryId)) throw new BadRequestException('category_id inválido');
    if (categoryId === null && keywords.length === 0) throw new BadRequestException(SIN_DISPARADOR);
    const assigneeId = dto.assignee_id;
    if (!assigneeId || !UUID_RE.test(assigneeId)) throw new BadRequestException('Elige a quién se asigna');
    const orden = dto.sort_order !== undefined ? this.orden(dto.sort_order) : 100;
    await this.tk.run(async (trx) => {
      await this.exigirExistentes(trx, categoryId, assigneeId);
      await trx('servicedesk.routing_rules').insert({
        tenant_id: this.tenantCtx.requireTenantId(),
        name,
        keywords,
        category_id: categoryId,
        assignee_id: assigneeId,
        sort_order: orden,
        active: dto.active ?? true,
        created_by: ctx.userId,
        updated_by: ctx.userId,
      });
    });
    return this.list();
  }

  async update(ctx: ActorCtx, id: string, dto: SdUpsertRoutingRuleDto): Promise<SdRoutingResponse> {
    if (!UUID_RE.test(id)) throw new NotFoundException('Regla no encontrada');
    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) {
      const n = this.nombre(dto.name);
      if (!n) throw new BadRequestException('El nombre de la regla no puede quedar vacío');
      patch['name'] = n;
    }
    if (dto.keywords !== undefined) patch['keywords'] = this.claves(dto.keywords);
    if (dto.category_id !== undefined) {
      if (dto.category_id !== null && !UUID_RE.test(dto.category_id)) throw new BadRequestException('category_id inválido');
      patch['category_id'] = dto.category_id;
    }
    if (dto.assignee_id !== undefined) {
      if (!UUID_RE.test(dto.assignee_id)) throw new BadRequestException('assignee_id inválido');
      patch['assignee_id'] = dto.assignee_id;
    }
    if (dto.sort_order !== undefined) patch['sort_order'] = this.orden(dto.sort_order);
    if (dto.active !== undefined) {
      if (typeof dto.active !== 'boolean') throw new BadRequestException('active debe ser verdadero o falso');
      patch['active'] = dto.active;
    }
    if (!Object.keys(patch).length) throw new BadRequestException('No se indicó ningún campo para cambiar');

    await this.tk.run(async (trx) => {
      const actual = await trx('servicedesk.routing_rules').where({ id }).whereNull('deleted_at').first();
      if (!actual) throw new NotFoundException('Regla no encontrada');
      // El disparador se valida contra lo que QUEDARÍA, no sólo contra lo que llega.
      const keywords = (patch['keywords'] ?? actual.keywords) as string[];
      const categoryId = (patch['category_id'] !== undefined ? patch['category_id'] : actual.category_id) as string | null;
      if (categoryId === null && keywords.length === 0) throw new BadRequestException(SIN_DISPARADOR);
      await this.exigirExistentes(trx, patch['category_id'] as string | null | undefined, patch['assignee_id'] as string | undefined);
      await trx('servicedesk.routing_rules').where({ id }).update({ ...patch, updated_at: trx.fn.now(), updated_by: ctx.userId });
    });
    return this.list();
  }

  /** Baja lógica: el runtime no tiene DELETE sobre la tabla (y los tickets viejos conservan el motivo en su hilo). */
  async remove(ctx: ActorCtx, id: string): Promise<SdRoutingResponse> {
    if (!UUID_RE.test(id)) throw new NotFoundException('Regla no encontrada');
    await this.tk.run(async (trx) => {
      const n = await trx('servicedesk.routing_rules')
        .where({ id })
        .whereNull('deleted_at')
        .update({ deleted_at: trx.fn.now(), deleted_by: ctx.userId, active: false, updated_at: trx.fn.now(), updated_by: ctx.userId });
      if (!n) throw new NotFoundException('Regla no encontrada');
    });
    return this.list();
  }

  // ───────────────────────────── validaciones ─────────────────────────────

  private nombre(v: unknown): string {
    const n = String(v ?? '').trim();
    if (n.length > MAX_NOMBRE) throw new BadRequestException(`El nombre admite hasta ${MAX_NOMBRE} caracteres`);
    return n;
  }

  private claves(v: unknown): string[] {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new BadRequestException('keywords debe ser una lista de palabras');
    if ((v as string[]).some((x) => x.trim().length > MAX_LARGO_CLAVE)) throw new BadRequestException(`Cada palabra admite hasta ${MAX_LARGO_CLAVE} caracteres`);
    const c = normalizarClaves(v as string[]);
    if (c.length > MAX_CLAVES) throw new BadRequestException(`Una regla admite hasta ${MAX_CLAVES} palabras clave`);
    return c;
  }

  private orden(v: unknown): number {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100000) throw new BadRequestException('sort_order debe ser un entero de 0 a 100000');
    return v as number;
  }

  /** La categoría y la persona deben existir (y la persona no estar dada de baja) ANTES de que lo diga una FK. */
  private async exigirExistentes(trx: Knex.Transaction, categoryId: string | null | undefined, assigneeId: string | undefined): Promise<void> {
    if (categoryId) {
      const c = await trx('servicedesk.categories').where({ id: categoryId }).whereNull('deleted_at').first('id');
      if (!c) throw new BadRequestException('La categoría indicada no existe');
    }
    if (assigneeId) {
      const u = await trx('identity.users').where({ id: assigneeId }).whereNull('deleted_at').first('id');
      if (!u) throw new BadRequestException('La persona indicada no existe');
    }
  }
}

const SIN_DISPARADOR = 'La regla necesita una categoría o al menos una palabra clave: sin eso no se dispararía nunca';
