import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { HrVacanteDto, HrVacanteEdicion } from '@megadulces/contracts';

/**
 * Fase RH · `[RH.2.2]` — VACANTES (antes `puestos` de Mega Talento: 7 al 12-oct-2026). Se
 * desactivan, no se borran: un candidato puede apuntar a una vacante que ya cerró.
 */

const TEXTOS = ['description', 'area', 'branches_text', 'salary_text', 'schedule_text', 'requirements', 'image_url', 'competencies_sheet'] as const;

const iso = (d: unknown) => (d == null ? null : new Date(d as string).toISOString());

function aDto(r: Record<string, unknown>): HrVacanteDto {
  return {
    ...(r as unknown as HrVacanteDto),
    branch_codes: Array.isArray(r['branch_codes']) ? (r['branch_codes'] as string[]) : [],
    extra: (r['extra'] as Record<string, unknown>) ?? {},
    created_at: iso(r['created_at']) as string,
    updated_at: iso(r['updated_at']) as string,
  };
}

/** Lo que se puede escribir de una vacante, limpio. `crear` exige nombre. */
export function limpiarVacante(b: HrVacanteEdicion | null | undefined, crear: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (b?.name !== undefined || crear) {
    const name = String(b?.name ?? '').trim();
    if (!name) throw new BadRequestException('La vacante necesita nombre.');
    out['name'] = name.slice(0, 200);
  }
  for (const k of TEXTOS) {
    if (b?.[k] === undefined) continue;
    out[k] = b[k] == null ? null : String(b[k]).trim() || null;
  }
  if (b?.branch_codes !== undefined) {
    if (!Array.isArray(b.branch_codes)) throw new BadRequestException('branch_codes es una lista.');
    out['branch_codes'] = [...new Set(b.branch_codes.map((x) => String(x).trim()).filter(Boolean))];
  }
  if (b?.extra !== undefined) {
    if (b.extra == null || typeof b.extra !== 'object' || Array.isArray(b.extra)) throw new BadRequestException('extra es un objeto.');
    out['extra'] = JSON.stringify(b.extra);
  }
  if (b?.is_active !== undefined) out['is_active'] = b.is_active === true;
  if (b?.sort_order !== undefined) {
    const n = Number(b.sort_order);
    if (!Number.isInteger(n)) throw new BadRequestException('sort_order es un entero.');
    out['sort_order'] = n;
  }
  return out;
}

@Injectable()
export class HrTalentJobsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async listar(f: { active?: string }): Promise<HrVacanteDto[]> {
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const q = trx('talent.job_postings').orderBy(['sort_order', 'name']);
      if (f.active === 'true') q.where('is_active', true);
      if (f.active === 'false') q.where('is_active', false);
      return (await q.select('*')).map(aDto);
    });
  }

  async crear(b: HrVacanteEdicion): Promise<HrVacanteDto> {
    const datos = limpiarVacante(b, true);
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const [r] = await trx('talent.job_postings')
        .insert({ ...datos, tenant_id: this.tenantCtx.requireTenantId(), created_by: this.tenantCtx.get()?.userId ?? null })
        .returning('*');
      return aDto(r);
    });
  }

  async editar(id: string, b: HrVacanteEdicion): Promise<HrVacanteDto> {
    const datos = limpiarVacante(b, false);
    if (!Object.keys(datos).length) throw new BadRequestException('Nada que cambiar.');
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new NotFoundException('Vacante no encontrada.');
    return this.tk.run(this.tenantCtx.requireTenantId(), async (trx) => {
      const [r] = await trx('talent.job_postings').where({ id }).update({ ...datos, updated_at: trx.fn.now() }).returning('*');
      if (!r) throw new NotFoundException('Vacante no encontrada.');
      return aDto(r);
    });
  }
}
