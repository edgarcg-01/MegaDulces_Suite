/**
 * `[MS.3.11]` Quién puede figurar como solicitante cuando quien atiende levanta una solicitud a nombre de otra persona.
 * ADR-081.
 *
 * Es un buscador de PERSONAS para quien atiende, y por eso es estrecho a propósito:
 *  · sólo `ATENDER`/`COORDINAR` (el servicio lo vuelve a exigir aunque la ruta ya lo pida);
 *  · mínimo 2 caracteres y a lo sumo 20 resultados: no es un padrón navegable sino un «¿quién es?»;
 *  · sólo lo que hace falta para ELEGIR (nombre, usuario, área, puesto, sucursal): **nunca correo ni teléfono**, que
 *    no se le dan a quien atiende sólo por buscar a alguien;
 *  · sólo personas que pueden ser solicitantes: activas, internas (no cuentas de servicio de los feeds ni de
 *    dispositivo) y que no estén dadas de baja (`retirado_*`).
 *
 * Sin `USUARIOS_VER`: el catálogo de personas se abre para este único fin, igual que el selector de agentes.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { SdDepartmentDto, SdRequesterDto } from '@megadulces/contracts';
import { TenantKnexService, applySmartSearch, branchName } from '@megadulces/platform-core';
import type { ActorCtx } from './service-desk.types';

export const MIN_BUSQUEDA = 2;
export const MAX_RESULTADOS = 20;

@Injectable()
export class ServiceDeskRequestersService {
  constructor(private readonly tk: TenantKnexService) {}

  async search(ctx: ActorCtx, q: string | undefined): Promise<SdRequesterDto[]> {
    if (!ctx.esAgente) throw new ForbiddenException('Sólo quien atiende puede buscar solicitantes');
    const texto = (q ?? '').trim();
    if (texto.length < MIN_BUSQUEDA) return [];
    return this.tk.run(async (trx) => {
      const qb = trx('identity.users as u')
        .leftJoin('identity.departments as d', function () {
          this.on('d.tenant_id', 'u.tenant_id').andOn('d.code', 'u.department_code');
        })
        .whereNull('u.deleted_at')
        .whereRaw(`COALESCE(u.kind, 'interno') <> 'servicio'`)
        .whereRaw(`u.role_name NOT LIKE 'retirado%'`)
        .select('u.id as user_id', 'u.username', 'u.nombre as name', 'u.department_code', 'd.name as department_name', 'u.position_code', 'u.warehouse_code')
        .orderByRaw('lower(coalesce(u.nombre, u.username))')
        .limit(MAX_RESULTADOS);
      applySmartSearch(qb, texto, { columns: ['u.nombre', 'u.username'] });
      const rows = (await qb) as Array<Record<string, string | null>>;
      return rows.map((r) => ({
        user_id: r['user_id'] as string,
        username: r['username'] as string,
        name: r['name'] ?? null,
        department_code: r['department_code'] ?? null,
        department_name: r['department_name'] ?? null,
        position_code: r['position_code'] ?? null,
        warehouse_code: r['warehouse_code'] ?? null,
        warehouse_name: r['warehouse_code'] ? branchName(r['warehouse_code']) : null,
      }));
    });
  }

  /** El catálogo de áreas (departamentos) para el selector del formulario. Sólo quien atiende. */
  async departments(ctx: ActorCtx): Promise<SdDepartmentDto[]> {
    if (!ctx.esAgente) throw new ForbiddenException('Sólo quien atiende puede ver el catálogo de áreas');
    return this.tk.run(async (trx) => {
      const rows = await trx('identity.departments').whereNull('deleted_at').orderBy([{ column: 'orden' }, { column: 'name' }]).select('code', 'name');
      return rows as SdDepartmentDto[];
    });
  }
}
