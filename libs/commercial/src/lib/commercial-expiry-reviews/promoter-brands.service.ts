import { Injectable, BadRequestException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase P2.6 — Promotores de marca propia. Mapa usuario↔marca (commercial.promoter_brands).
 * `mine()` scopea el Control de Caducidades: si el usuario tiene marcas asignadas es
 * "promotor" y solo ve/captura SUS SKUs. La gestión (asignar marcas a un usuario) es admin.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PromoterBrandsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Marcas del usuario logueado (vacío = no es promotor → ve todo). */
  async mine(): Promise<{ brand_ids: string[]; brands: { id: string; nombre: string }[] }> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return { brand_ids: [], brands: [] };
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.promoter_brands as pb')
        .leftJoin('public.brands as b', 'b.id', 'pb.brand_id')
        .where('pb.user_id', userId)
        .select('pb.brand_id as id', 'b.nombre')
        .orderBy('b.nombre');
      return { brand_ids: rows.map((r: any) => r.id), brands: rows.map((r: any) => ({ id: r.id, nombre: r.nombre })) };
    });
  }

  /** brand_ids del usuario (para scoping server-side). */
  async brandIdsOf(userId: string): Promise<string[]> {
    if (!userId) return [];
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.promoter_brands').where('user_id', userId).select('brand_id');
      return rows.map((r: any) => r.brand_id);
    });
  }

  // ───── admin ─────

  /** Promotores = usuarios con al menos una marca asignada, con sus marcas. */
  async listPromoters() {
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.promoter_brands as pb')
        .leftJoin('public.users as u', 'u.id', 'pb.user_id')
        .leftJoin('public.brands as b', 'b.id', 'pb.brand_id')
        .select('pb.user_id', 'u.username', 'u.nombre as user_nombre', 'pb.brand_id', 'b.nombre as brand_nombre')
        .orderBy('u.username');
      const byUser = new Map<string, any>();
      for (const r of rows as any[]) {
        if (!byUser.has(r.user_id))
          byUser.set(r.user_id, { user_id: r.user_id, username: r.username, nombre: r.user_nombre, brands: [] });
        byUser.get(r.user_id).brands.push({ id: r.brand_id, nombre: r.brand_nombre });
      }
      return Array.from(byUser.values());
    });
  }

  /** Marcas asignables = las que tienen productos activos (evita las 600+ de proveedor sin SKU). */
  async assignableBrands(search?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      let q = trx('public.brands as b')
        .join('public.products as p', function () {
          this.on('p.brand_id', '=', 'b.id').andOn('p.tenant_id', '=', 'b.tenant_id');
        })
        .where('b.tenant_id', tenantId)
        .whereNull('p.deleted_at');
      if (search) q = q.whereRaw('upper(b.nombre) like ?', [`%${String(search).toUpperCase()}%`]);
      return q.distinct('b.id', 'b.nombre').orderBy('b.nombre').limit(200);
    });
  }

  /** Usuarios candidatos a promotor (activos del tenant). */
  async candidateUsers(search?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      let q = trx('public.users').where('tenant_id', tenantId).whereNull('deleted_at');
      if (search) q = q.whereRaw('upper(username || COALESCE(nombre, \'\')) like ?', [`%${String(search).toUpperCase()}%`]);
      return q.select('id', 'username', 'nombre', 'role_name').orderBy('username').limit(200);
    });
  }

  /** Reemplaza el set de marcas de un usuario (admin). */
  async setUserBrands(userId: string, brandIds: string[]) {
    if (!UUID_REGEX.test(userId)) throw new BadRequestException('user_id inválido');
    const ids = Array.from(new Set((brandIds || []).filter((b) => UUID_REGEX.test(b))));
    const createdBy = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      await trx('commercial.promoter_brands').where('user_id', userId).del();
      if (ids.length) {
        await trx('commercial.promoter_brands').insert(
          ids.map((brand_id) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            user_id: userId,
            brand_id,
            created_by: createdBy,
          })),
        );
      }
      return { user_id: userId, brand_ids: ids };
    });
  }
}
