import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService, applySmartSearch } from '@megadulces/platform-core';
import {
  ASSIGNMENT_ROLES,
  LOCATION_BULK_MAX,
  parseAssignmentRole,
  parseLocationCode,
  resolvePresentation,
  type AssignmentRole,
  type BulkAssignmentAction,
  type BulkAssignmentPreviewRow,
  type BulkAssignmentsBody,
  type BulkAssignmentsPreview,
  type BulkAssignmentsResult,
  type CreateAssignmentBody,
  type LocationStatus,
  type LocationZone,
  type PresentationFactorSource,
  type ProductAssignment,
  type ProductLocationDetail,
  type ProductLocationFilter,
  type ProductLocationsList,
  type ProductPresentation,
  type UpdateAssignmentBody,
} from '@megadulces/contracts';
import { almacenDeUbicaciones, contextoDeAlcance, type AlmacenUbicaciones } from './warehouse-locations-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROL = new Map(ASSIGNMENT_ROLES.map((r) => [r.key, r]));
const PREVIEW_MAX = 500;
const PESO: Record<BulkAssignmentAction, number> = { error: 0, repetida: 1, cambia: 2, nueva: 3, igual: 4 };

/**
 * La escalera de VARIOS productos en UNA sucursal: rótulo, factor (de `v_kepler_unit_ladder`, que ya
 * decide entre el capturado y el derivado del costo) y códigos de barras de la ficha `kdii`.
 *
 * Medido en prod (PH, 2026-11-13): 1 clave 12–19 ms · 500 claves 53–61 ms · 2,000 claves 123–134 ms.
 * Antes el Excel la pedía UNA vez por clave: hasta 2,000 consultas de 4–12 ms en serie (8–24 s).
 * La sucursal entra como VALOR (con join desde `catalog.products` tardaba ~4 s: el filtro no llegaba
 * a los índices).
 *
 * `kdii` va por `LATERAL … LIMIT 1`: si una sucursal llegara a traer dos fichas de la misma clave
 * (hoy 0, medido el 2026-11-13), la escalera no sale duplicada — la misma defensa que el checado.
 * Un factor derivado del costo que REDONDEA a 1 no es un factor (no hay "caja de 1"): queda sin_factor.
 * `C`+clave (la etiqueta con que Mega Dulces reetiqueta la caja) sólo cuando el peldaño 3 tiene factor,
 * igual que `checado-codigo.ts`.
 */
const ESCALERA_SQL = `
  SELECT l.sku, r.peldano, r.rotulo, r.factor, r.fuente, r.codigos, l.factor_source, l.peldano_caja
    FROM analytics.v_kepler_unit_ladder l
    JOIN LATERAL (SELECT k0.* FROM kepler_ods.kdii k0 WHERE btrim(k0.sucursal) = l.sucursal AND btrim(k0.c1) = l.sku LIMIT 1) k ON true
    CROSS JOIN LATERAL (VALUES
      (1, l.u1_label, 1::numeric, 'base',
          array_remove(ARRAY[nullif(btrim(k.c7), ''), nullif(btrim(k.c93), ''), nullif(btrim(k.c102), '')], NULL)),
      (2, l.u2_label,
          CASE WHEN l.f2_cap > 1 THEN l.f2_cap WHEN round(l.f2_costo) > 1 THEN round(l.f2_costo) END,
          CASE WHEN l.f2_cap > 1 THEN 'capturado' WHEN round(l.f2_costo) > 1 THEN 'derivado_del_costo' ELSE 'sin_factor' END,
          array_remove(ARRAY[nullif(btrim(k.c82), ''), nullif(btrim(k.c95), ''), nullif(btrim(k.c96), '')], NULL)),
      (3, l.u3_label,
          CASE WHEN l.f3_cap > 1 THEN l.f3_cap WHEN round(l.f3_costo) > 1 THEN round(l.f3_costo) END,
          CASE WHEN l.f3_cap > 1 THEN 'capturado' WHEN round(l.f3_costo) > 1 THEN 'derivado_del_costo' ELSE 'sin_factor' END,
          array_remove(ARRAY[nullif(btrim(k.c85), ''), CASE WHEN l.f3_cap > 1 OR round(l.f3_costo) > 1 THEN 'C' || l.sku END], NULL))
    ) AS r(peldano, rotulo, factor, fuente, codigos)
   WHERE l.sucursal = ? AND l.sku = ANY(?::text[])
     AND (r.peldano = 1 OR r.rotulo IS NOT NULL OR r.factor IS NOT NULL)
   ORDER BY l.sku, r.peldano`;

interface FilaEscalera {
  sku?: string;
  peldano: number;
  rotulo: string | null;
  factor: string | number | null;
  fuente: PresentationFactorSource;
  codigos: string[] | null;
  factor_source: string | null;
  peldano_caja: number | null;
}

/**
 * Limpia la escalera cruda: un peldaño SIN factor que repite el rótulo de otro es un FANTASMA de la
 * captura de Kepler (medido en PH: 2,661 de 9,656 fichas) y no se ofrece como presentación. Uno sin
 * factor con rótulo PROPIO (17 en PH) sí existe: se ofrece, marcado sin factor.
 */
export function limpiarEscalera(filas: FilaEscalera[]): { presentaciones: ProductPresentation[]; aviso: string | null } {
  const rotulo = (r: string | null) => (r ?? '').trim().toUpperCase();
  const vivas = filas.filter((f) => {
    if (f.peldano === 1) return true;
    if (f.fuente !== 'sin_factor') return true;
    const otros = filas.filter((o) => o.peldano !== f.peldano).map((o) => rotulo(o.rotulo));
    return !!rotulo(f.rotulo) && !otros.includes(rotulo(f.rotulo));
  });
  // La caja es la de MAYOR factor (> 1). `peldano_caja` de la vista se respeta sólo si ese peldaño
  // sigue vivo y con factor: la vista cae en 1 cuando no encuentra caja, y la base nunca es «la caja».
  const conFactor = vivas.filter((f) => f.factor != null && Number(f.factor) > 1);
  const mayor = conFactor.reduce<FilaEscalera | null>((m, f) => (m && Number(m.factor) >= Number(f.factor) ? m : f), null);
  const dicha = conFactor.find((f) => f.peldano === filas[0]?.peldano_caja);
  const caja = dicha?.peldano ?? mayor?.peldano ?? null;
  const presentaciones = vivas.map((f) => ({
    peldano: f.peldano as 1 | 2 | 3,
    rotulo: f.rotulo ? f.rotulo.trim() : null,
    factor: f.factor == null ? null : Number(f.factor),
    fuente: f.fuente,
    codigos: [...new Set((f.codigos ?? []).filter(Boolean))],
    es_caja: caja != null && f.peldano === caja,
  }));
  const contradice = filas[0]?.factor_source === 'capturado_contradice_al_costo';
  return {
    presentaciones,
    aviso: contradice ? 'En Kepler el factor capturado contradice al costo de este producto: revisa la ficha antes de convertir cantidades.' : null,
  };
}

interface AsignacionCruda {
  id: string;
  bin_id: string;
  code: string;
  zona: LocationZone | null;
  estado: LocationStatus;
  presentacion: number;
  presentacion_rotulo: string | null;
  papel: AssignmentRole;
  min_qty: string | number | null;
  max_qty: string | number | null;
}

const num = (v: unknown) => (v == null || v === '' ? null : Number(v));

/**
 * `[UB.3]` Asignación por producto y presentación (Fase UB, ADR-090 punto 7, D10).
 *
 * Producto × presentación (peldaño de la escalera de Kepler de ESA sucursal) × ubicación × papel,
 * con mínimo y máximo en esa presentación. El factor nunca se copia: se lee vivo de Kepler.
 */
@Injectable()
export class WarehouseLocationsAssignService {
  private readonly logger = new Logger(WarehouseLocationsAssignService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** La escalera de varias claves, ya limpia, por clave. Una sola consulta. */
  private async escaleras(trx: Knex.Transaction, sucursal: string, skus: string[]) {
    const out = new Map<string, ReturnType<typeof limpiarEscalera>>();
    if (!skus.length) return out;
    const r = await trx.raw(ESCALERA_SQL, [sucursal, skus]);
    const porSku = new Map<string, FilaEscalera[]>();
    for (const f of r.rows as FilaEscalera[]) {
      const k = String(f.sku);
      if (!porSku.has(k)) porSku.set(k, []);
      porSku.get(k)!.push(f);
    }
    for (const [k, filas] of porSku) out.set(k, limpiarEscalera(filas));
    return out;
  }

  private async escalera(trx: Knex.Transaction, sucursal: string, sku: string) {
    return (await this.escaleras(trx, sucursal, [sku])).get(sku) ?? { presentaciones: [], aviso: null };
  }

  private async asignaciones(trx: Knex.Transaction, warehouseId: string, productId: string): Promise<ProductAssignment[]> {
    const rows: AsignacionCruda[] = await trx('commercial.bin_assignments as a')
      .join('commercial.warehouse_bins as b', function () {
        this.on('b.tenant_id', 'a.tenant_id').andOn('b.id', 'a.bin_id');
      })
      .where({ 'a.warehouse_id': warehouseId, 'a.product_id': productId })
      .whereNull('a.deleted_at')
      .orderBy([{ column: 'a.presentacion', order: 'desc' }, { column: 'b.pick_sequence' }])
      .select('a.id', 'a.bin_id', 'b.code', 'b.zona', 'b.estado', 'a.presentacion', 'a.presentacion_rotulo', 'a.papel', 'a.min_qty', 'a.max_qty');
    return rows.map((r) => ({ ...r, presentacion: r.presentacion as 1 | 2 | 3, min_qty: num(r.min_qty), max_qty: num(r.max_qty) }));
  }

  // ── Lectura ──────────────────────────────────────────────────────────────────────────────────

  async products(warehouseIdRaw: string, q: string | undefined, filtro: ProductLocationFilter, limitRaw?: number, offsetRaw?: number): Promise<ProductLocationsList> {
    this.tenantCtx.requireTenantId();
    const warehouseId = String(warehouseIdRaw ?? '').toLowerCase();
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 50));
    const offset = Math.max(0, Number(offsetRaw) || 0);
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations/products');
    const t0 = Date.now();
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, warehouseId, false);
      const base = { warehouse: { id: wh.id, code: wh.code, name: wh.name }, limit, offset };
      if (!wh.kepler_code) return { ...base, ficha_kepler: false, universo: 0, total: 0, sin_ubicacion: 0, filas: [] };
      // Universo = los productos que tienen ficha en Kepler de ESTA sucursal.
      const universo = () => {
        // EXISTS y no JOIN: aunque la sucursal trajera dos fichas de la misma clave, el producto sale una
        // vez (medido: 9,039 productos de PH en 26 ms). Sucursal como VALOR: llega al índice ix_kdii_suc_sku.
        const qb = trx('catalog.products as p')
          .whereNull('p.deleted_at')
          .whereRaw('EXISTS (SELECT 1 FROM kepler_ods.kdii k WHERE btrim(k.sucursal) = ? AND btrim(k.c1) = p.sku)', [wh.kepler_code]);
        applySmartSearch(qb, q, { columns: ['p.nombre', 'p.sku'] });
        return qb;
      };
      // Un lugar fijo en una ubicación DADA DE BAJA no cuenta: el producto ya no tiene dónde surtirse.
      const conSurtido = trx('commercial.bin_assignments as a')
        .join('commercial.warehouse_bins as b', function () {
          this.on('b.tenant_id', 'a.tenant_id').andOn('b.id', 'a.bin_id');
        })
        .whereRaw('a.product_id = p.id')
        .where({ 'a.warehouse_id': wh.id, 'a.papel': 'surtido_fijo' })
        .whereNull('a.deleted_at')
        .whereNot('b.estado', 'baja')
        .select(trx.raw('1'));
      const filtrado = () => {
        const qb = universo();
        if (filtro === 'sin_ubicacion') qb.whereNotExists(conSurtido);
        if (filtro === 'con_ubicacion') qb.whereExists(conSurtido);
        return qb;
      };
      const [{ total }] = await filtrado().count({ total: '*' });
      const [{ todos }] = await universo().count({ todos: '*' });
      const [{ sin }] = await universo().whereNotExists(conSurtido).count({ sin: '*' });
      const filas = await filtrado()
        .select(
          'p.id as product_id',
          'p.sku',
          'p.nombre',
          trx.raw(`COALESCE((SELECT array_agg(b.code ORDER BY a.presentacion DESC)
                    FROM commercial.bin_assignments a JOIN commercial.warehouse_bins b ON b.tenant_id = a.tenant_id AND b.id = a.bin_id
                   WHERE a.product_id = p.id AND a.warehouse_id = ? AND a.papel = 'surtido_fijo' AND a.deleted_at IS NULL AND b.estado <> 'baja'), '{}') AS surtido_fijo`, [wh.id]),
          trx.raw(`(SELECT count(*) FROM commercial.bin_assignments a
                     WHERE a.product_id = p.id AND a.warehouse_id = ? AND a.deleted_at IS NULL) AS asignaciones`, [wh.id]),
        )
        // Nombre + clave: con nombres repetidos, el orden es estable y la página no salta ni repite.
        .orderBy([{ column: 'p.nombre' }, { column: 'p.sku' }])
        .limit(limit)
        .offset(offset);
      this.logger.debug(`productos ${wh.code} (${filtro}, q=${q ?? ''}): ${filas.length} en ${Date.now() - t0} ms`);
      return {
        ...base,
        ficha_kepler: true,
        universo: Number(todos) || 0,
        total: Number(total) || 0,
        sin_ubicacion: Number(sin) || 0,
        filas: filas.map((f: Record<string, unknown>) => ({
          product_id: String(f['product_id']),
          sku: String(f['sku']),
          nombre: String(f['nombre']),
          surtido_fijo: (f['surtido_fijo'] as string[]) ?? [],
          asignaciones: Number(f['asignaciones']) || 0,
        })),
      };
    });
  }

  async detail(warehouseIdRaw: string, productIdRaw: string): Promise<ProductLocationDetail> {
    this.tenantCtx.requireTenantId();
    const warehouseId = String(warehouseIdRaw ?? '').toLowerCase();
    const productId = String(productIdRaw ?? '').toLowerCase();
    if (!UUID.test(warehouseId) || !UUID.test(productId)) throw new BadRequestException('Almacén o producto inválido');
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations/products/:id');
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, warehouseId, false);
      const p = await trx('catalog.products').where({ id: productId }).whereNull('deleted_at').first('id', 'sku', 'nombre');
      if (!p) throw new NotFoundException('Producto no encontrado.');
      const esc = wh.kepler_code && p.sku ? await this.escalera(trx, wh.kepler_code, String(p.sku).trim()) : { presentaciones: [], aviso: null };
      return {
        warehouse: { id: wh.id, code: wh.code, name: wh.name },
        product: { id: p.id, sku: String(p.sku ?? ''), nombre: String(p.nombre) },
        ficha_kepler: esc.presentaciones.length > 0,
        presentaciones: esc.presentaciones,
        asignaciones: await this.asignaciones(trx, wh.id, p.id),
        aviso: esc.aviso,
      };
    });
  }

  // ── Escritura ────────────────────────────────────────────────────────────────────────────────

  /** La ubicación destino: existe en ESE almacén, tiene el formato nuevo, está activa y su zona es la del papel. */
  private async ubicacionPara(trx: Knex.Transaction, wh: AlmacenUbicaciones, rawCode: string, papel: AssignmentRole): Promise<{ id: string; code: string }> {
    const parsed = parseLocationCode(rawCode);
    if (!parsed.ok) throw new BadRequestException(parsed.motivo);
    const b = await trx('commercial.warehouse_bins').where({ warehouse_id: wh.id }).whereRaw('UPPER(code) = ?', [parsed.code]).first('id', 'code', 'familia', 'zona', 'estado');
    if (!b) throw new NotFoundException(`La ubicación ${parsed.code} no existe en ${wh.name}: dala de alta primero.`);
    if (b.estado !== 'activa') throw new ConflictException(`La ubicación ${b.code} está ${b.estado === 'baja' ? 'dada de baja' : 'bloqueada'}.`);
    const rol = ROL.get(papel)!;
    if (b.zona !== rol.zona) {
      throw new BadRequestException(`${rol.label} va en ${rol.zona === 'B' ? 'bodega (B…)' : 'tienda (T…)'}; ${b.code} es de ${b.zona === 'T' ? 'tienda' : 'bodega'}.`);
    }
    return { id: b.id, code: b.code };
  }

  private cantidades(min: unknown, max: unknown): { min_qty: number | null; max_qty: number | null } {
    const leer = (v: unknown, nombre: string) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new BadRequestException(`El ${nombre} tiene que ser un número de 0 en adelante.`);
      return n;
    };
    const a = leer(min, 'mínimo');
    const b = leer(max, 'máximo');
    if (a != null && b != null && a > b) throw new BadRequestException(`El mínimo (${a}) no puede pasar del máximo (${b}).`);
    return { min_qty: a, max_qty: b };
  }

  async create(body: CreateAssignmentBody): Promise<ProductAssignment> {
    this.tenantCtx.requireTenantId();
    const warehouseId = String(body?.warehouse_id ?? '').toLowerCase();
    const productId = String(body?.product_id ?? '').toLowerCase();
    if (!UUID.test(warehouseId) || !UUID.test(productId)) throw new BadRequestException('Almacén o producto inválido');
    if (!ROL.has(body.papel)) throw new BadRequestException(`Papel desconocido: ${body.papel}`);
    const qty = this.cantidades(body.min_qty, body.max_qty);
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations/assignments');
    const userId = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, warehouseId, true);
      const p = await trx('catalog.products').where({ id: productId }).whereNull('deleted_at').first('id', 'sku');
      if (!p) throw new NotFoundException('Producto no encontrado.');
      if (!wh.kepler_code) throw new BadRequestException(`${wh.name} no tiene fichas de Kepler: no hay presentaciones que asignar.`);
      const esc = await this.escalera(trx, wh.kepler_code, String(p.sku).trim());
      const pres = esc.presentaciones.find((x) => x.peldano === Number(body.presentacion));
      if (!pres) throw new BadRequestException(`Este producto no tiene la presentación ${body.presentacion} en Kepler de ${wh.name}.`);
      const bin = await this.ubicacionPara(trx, wh, body.bin_code, body.papel);
      const [row] = await trx('commercial.bin_assignments')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: wh.id,
          product_id: p.id,
          bin_id: bin.id,
          presentacion: pres.peldano,
          presentacion_rotulo: pres.rotulo ? pres.rotulo.slice(0, 12) : null,
          papel: body.papel,
          ...qty,
          created_by: userId,
          updated_by: userId,
        })
        .returning(['id'])
        .catch((e: { code?: string; constraint?: string }) => {
          if (e?.code === '23505') {
            throw new ConflictException(
              e.constraint === 'commercial_bin_assignments_unico_por_papel'
                ? `Esta presentación ya tiene ${ROL.get(body.papel)!.label.toLowerCase()}: cámbiala en vez de agregar otra.`
                : `Esa asignación ya existe en ${bin.code}.`,
            );
          }
          throw e;
        });
      return (await this.asignaciones(trx, wh.id, p.id)).find((a) => a.id === row.id)!;
    });
  }

  async update(idRaw: string, body: UpdateAssignmentBody): Promise<ProductAssignment> {
    this.tenantCtx.requireTenantId();
    const id = String(idRaw ?? '').toLowerCase();
    if (!UUID.test(id)) throw new BadRequestException('Asignación inválida');
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations/assignments/:id');
    const userId = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      const a = await trx('commercial.bin_assignments').where({ id }).whereNull('deleted_at').forUpdate().first('id', 'warehouse_id', 'product_id', 'papel', 'min_qty', 'max_qty');
      if (!a) throw new NotFoundException('Asignación no encontrada.');
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, a.warehouse_id, true);
      const cambios: Record<string, unknown> = { updated_at: trx.fn.now(), updated_by: userId };
      if (body.bin_code !== undefined) cambios['bin_id'] = (await this.ubicacionPara(trx, wh, body.bin_code, a.papel)).id;
      if (body.min_qty !== undefined || body.max_qty !== undefined) {
        Object.assign(cambios, this.cantidades(body.min_qty !== undefined ? body.min_qty : a.min_qty, body.max_qty !== undefined ? body.max_qty : a.max_qty));
      }
      await trx('commercial.bin_assignments').where({ id }).update(cambios).catch((e: { code?: string }) => {
        if (e?.code === '23505') throw new ConflictException('Ya existe esa misma asignación en la ubicación destino.');
        throw e;
      });
      return (await this.asignaciones(trx, wh.id, a.product_id)).find((x) => x.id === id)!;
    });
  }

  async remove(idRaw: string): Promise<{ id: string; quitada: true }> {
    this.tenantCtx.requireTenantId();
    const id = String(idRaw ?? '').toLowerCase();
    if (!UUID.test(id)) throw new BadRequestException('Asignación inválida');
    const ctx = await contextoDeAlcance(this.scope, 'warehouse/locations/assignments/:id');
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('Sin usuario en la sesión: no se puede registrar quién quitó la asignación.');
    return this.tk.run(async (trx) => {
      const a = await trx('commercial.bin_assignments').where({ id }).whereNull('deleted_at').forUpdate().first('id', 'warehouse_id');
      if (!a) throw new NotFoundException('Asignación no encontrada.');
      await almacenDeUbicaciones(trx, this.scope, ctx, a.warehouse_id, true);
      // No se borra: queda con quién y cuándo (la bitácora completa llega en UB.4).
      await trx('commercial.bin_assignments').where({ id }).update({ deleted_at: trx.fn.now(), deleted_by: userId, updated_at: trx.fn.now(), updated_by: userId });
      return { id, quitada: true as const };
    });
  }

  // ── Excel producto → presentación → ubicación → papel ───────────────────────────────────────

  private async planificar(trx: Knex.Transaction, wh: AlmacenUbicaciones, body: BulkAssignmentsBody) {
    if (!wh.kepler_code) throw new BadRequestException(`${wh.name} no tiene fichas de Kepler: no hay presentaciones que asignar.`);
    const filas = body.filas ?? [];
    const skus = [...new Set(filas.map((f) => String(f?.sku ?? '').trim()).filter(Boolean))];
    const productos = new Map<string, { id: string; nombre: string }>(
      skus.length
        ? (await trx('catalog.products').whereIn('sku', skus).whereNull('deleted_at').select('id', 'sku', 'nombre')).map((p: { id: string; sku: string; nombre: string }) => [p.sku, { id: p.id, nombre: p.nombre }])
        : [],
    );
    const codigos = [...new Set(filas.map((f) => parseLocationCode(f?.ubicacion)).filter((p) => p.ok).map((p) => p.code))];
    const bins = new Map<string, { id: string; zona: string; estado: string }>(
      codigos.length
        ? (await trx('commercial.warehouse_bins').where({ warehouse_id: wh.id }).whereRaw('UPPER(code) = ANY(?::text[])', [codigos]).select(trx.raw('UPPER(code) AS code'), 'id', 'zona', 'estado')).map((b: { code: string; id: string; zona: string; estado: string }) => [b.code, b])
        : [],
    );
    const ids = [...productos.values()].map((p) => p.id);
    const vigentes: Array<{ id: string; product_id: string; presentacion: number; papel: string; bin_id: string; bin_code: string; min_qty: string | null; max_qty: string | null }> = ids.length
      ? await trx('commercial.bin_assignments as a')
          .join('commercial.warehouse_bins as b', function () {
            this.on('b.tenant_id', 'a.tenant_id').andOn('b.id', 'a.bin_id');
          })
          .where({ 'a.warehouse_id': wh.id })
          .whereIn('a.product_id', ids)
          .whereNull('a.deleted_at')
          .select('a.id', 'a.product_id', 'a.presentacion', 'a.papel', 'a.bin_id', 'b.code as bin_code', 'a.min_qty', 'a.max_qty')
      : [];
    const escaleras = new Map<string, ProductPresentation[]>();
    for (const [sku, esc] of await this.escaleras(trx, wh.kepler_code, [...productos.keys()])) escaleras.set(sku, esc.presentaciones);

    const vistos = new Map<string, number | null>();
    const plan: Array<BulkAssignmentPreviewRow & { product_id?: string; bin_id?: string; existente_id?: string; rotulo?: string | null }> = [];
    for (const [i, raw] of filas.entries()) {
      const fila = Number.isInteger(raw?.fila) ? Number(raw.fila) : i + 2;
      const sku = String(raw?.sku ?? '').trim();
      const ubic = parseLocationCode(raw?.ubicacion);
      const papel = parseAssignmentRole(raw?.papel);
      const fila0 = { fila, sku, nombre: null as string | null, presentacion: String(raw?.presentacion ?? ''), peldano: null as number | null, ubicacion: ubic.code, papel, min_qty: null as number | null, max_qty: null as number | null };
      const err = (motivo: string) => plan.push({ ...fila0, accion: 'error', motivo });
      const prod = productos.get(sku);
      if (!sku) { err('Falta la clave del producto.'); continue; }
      if (!prod) { err(`No existe el producto ${sku}.`); continue; }
      fila0.nombre = prod.nombre;
      const pres = resolvePresentation(raw?.presentacion, escaleras.get(sku) ?? []);
      if (!pres.ok) { err(pres.motivo); continue; }
      fila0.peldano = pres.peldano;
      const rotulo = pres.rotulo;
      if (!papel) { err(`Papel desconocido «${raw?.papel ?? ''}». Usa: surtido, exhibición o reserva.`); continue; }
      if (!ubic.ok) { err(ubic.motivo); continue; }
      const bin = bins.get(ubic.code);
      if (!bin) { err(`La ubicación ${ubic.code} no existe en ${wh.name}: dala de alta primero.`); continue; }
      if (bin.estado !== 'activa') { err(`La ubicación ${ubic.code} está ${bin.estado === 'baja' ? 'dada de baja' : 'bloqueada'}.`); continue; }
      const rol = ROL.get(papel)!;
      if (bin.zona !== rol.zona) { err(`${rol.label} va en ${rol.zona === 'B' ? 'bodega (B…)' : 'tienda (T…)'}; ${ubic.code} es de ${bin.zona === 'T' ? 'tienda' : 'bodega'}.`); continue; }
      // Repetida en el archivo: misma llave de unicidad que la base.
      const llave = rol.unico ? `${prod.id}|${pres.peldano}|${papel}` : `${prod.id}|${pres.peldano}|${papel}|${bin.id}`;
      const actual = vigentes.find((v) => v.product_id === prod.id && v.presentacion === pres.peldano && v.papel === papel && (rol.unico || v.bin_id === bin.id));
      // Celda VACÍA de mínimo o máximo = se CONSERVA lo que ya tenía (en una nueva, queda sin dato).
      // Así un Excel que sólo mueve ubicaciones no borra los mín/máx en silencio.
      const vacia = (v: unknown) => v == null || String(v).trim() === '';
      const conserva = { min: vacia(raw?.min), max: vacia(raw?.max) };
      let qty: { min_qty: number | null; max_qty: number | null };
      try {
        qty = this.cantidades(conserva.min ? (actual ? actual.min_qty : null) : raw?.min, conserva.max ? (actual ? actual.max_qty : null) : raw?.max);
      } catch (e) { err((e as Error).message); continue; }
      Object.assign(fila0, qty);
      if (vistos.has(llave)) { plan.push({ ...fila0, accion: 'repetida', motivo: `Repetida: ya viene en la fila ${vistos.get(llave)}.` }); continue; }
      vistos.set(llave, fila);
      const base = { ...fila0, product_id: prod.id, bin_id: bin.id, existente_id: actual?.id, rotulo };
      const seConserva = actual && (conserva.min || conserva.max) ? ' Mínimo y máximo vacíos en el archivo: se conservan los que tenía.' : '';
      if (!actual) plan.push({ ...base, accion: 'nueva', motivo: null });
      else if (actual.bin_id === bin.id && num(actual.min_qty) === qty.min_qty && num(actual.max_qty) === qty.max_qty) plan.push({ ...base, accion: 'igual', motivo: 'Ya está así: no cambia nada.' });
      else if (actual.bin_id === bin.id) plan.push({ ...base, accion: 'cambia', motivo: 'Cambia mínimo/máximo.' });
      else plan.push({ ...base, accion: 'cambia', motivo: `Se mueve de ${actual.bin_code} a ${ubic.code}.${seConserva}` });
    }
    return plan;
  }

  private async contextoBulk(body: BulkAssignmentsBody) {
    this.tenantCtx.requireTenantId();
    const warehouseId = String(body?.warehouse_id ?? '').toLowerCase();
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    if (!Array.isArray(body.filas) || !body.filas.length) throw new BadRequestException('El archivo no trae renglones.');
    if (body.filas.length > LOCATION_BULK_MAX) throw new BadRequestException(`El archivo trae ${body.filas.length} renglones; el tope es ${LOCATION_BULK_MAX}.`);
    return { warehouseId, ctx: await contextoDeAlcance(this.scope, 'warehouse/locations/assignments/bulk') };
  }

  async bulkPreview(body: BulkAssignmentsBody): Promise<BulkAssignmentsPreview> {
    const { warehouseId, ctx } = await this.contextoBulk(body);
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, warehouseId, true);
      const plan = await this.planificar(trx, wh, body);
      const conteo: Record<BulkAssignmentAction, number> = { nueva: 0, cambia: 0, igual: 0, repetida: 0, error: 0 };
      for (const f of plan) conteo[f.accion]++;
      const filas = plan
        .map(({ product_id, bin_id, existente_id, rotulo, ...f }) => f)
        .sort((a, b) => PESO[a.accion] - PESO[b.accion] || (a.fila ?? 0) - (b.fila ?? 0));
      return { warehouse: { id: wh.id, code: wh.code, name: wh.name }, total: plan.length, conteo, filas: filas.slice(0, PREVIEW_MAX), truncado: filas.length > PREVIEW_MAX };
    });
  }

  async bulkApply(body: BulkAssignmentsBody): Promise<BulkAssignmentsResult> {
    const { warehouseId, ctx } = await this.contextoBulk(body);
    const userId = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, warehouseId, true);
      const plan = await this.planificar(trx, wh, body);
      const nuevas = plan.filter((f) => f.accion === 'nueva');
      const cambian = plan.filter((f) => f.accion === 'cambia');
      // Si alguien aplicó lo mismo al mismo tiempo, el índice único lo frena: 409, no un 500.
      const choque = (e: { code?: string }) => {
        if (e?.code === '23505') throw new ConflictException('Mientras revisabas, alguien más asignó algunas de estas presentaciones. Vuelve a revisar el archivo.');
        throw e;
      };
      // Altas por lotes de 500 (no 2,000 INSERT sueltos).
      for (let i = 0; i < nuevas.length; i += 500) {
        await trx('commercial.bin_assignments')
          .insert(
            nuevas.slice(i, i + 500).map((f) => ({
              tenant_id: trx.raw('public.current_tenant_id()'),
              warehouse_id: wh.id,
              product_id: f.product_id,
              bin_id: f.bin_id,
              presentacion: f.peldano,
              // Foto del rótulo de KEPLER (CJA), no de lo que se tecleó (caja).
              presentacion_rotulo: f.rotulo ? f.rotulo.slice(0, 12) : null,
              papel: f.papel,
              min_qty: f.min_qty,
              max_qty: f.max_qty,
              created_by: userId,
              updated_by: userId,
            })),
          )
          .catch(choque);
      }
      for (const f of cambian) {
        await trx('commercial.bin_assignments')
          .where({ id: f.existente_id })
          .update({ bin_id: f.bin_id, min_qty: f.min_qty, max_qty: f.max_qty, updated_at: trx.fn.now(), updated_by: userId })
          .catch(choque);
      }
      const creadas = nuevas.length;
      const actualizadas = cambian.length;
      if (!creadas && !actualizadas) throw new BadRequestException('No hay nada que crear ni cambiar.');
      this.logger.log(`asignación masiva ${wh.code}: ${creadas} nuevas, ${actualizadas} cambiadas`);
      return { creadas, actualizadas, omitidas: plan.length - creadas - actualizadas };
    });
  }
}
