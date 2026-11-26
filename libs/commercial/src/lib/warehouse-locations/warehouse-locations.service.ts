import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ScopeService } from '@megadulces/platform-core';
import {
  defaultPickSequence,
  LOCATION_KINDS,
  parseLocationCode,
  type CreateWarehouseLocationBody,
  type LocationKind,
  type WarehouseLocationRow,
  type WarehouseLocationsResponse,
  type WarehouseLocationsSummary,
} from '@megadulces/contracts';
import { almacenDeUbicaciones, ES_RUTA } from './warehouse-locations-scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_MAX = 120;
const TIPOS = new Set<string>(LOCATION_KINDS.map((k) => k.key));
// Las rutas (`RUTA-*`, ES_RUTA) son camiones: no tienen racks y se dejan fuera del selector. Si algún
// día se ubican estibas del camión, entran como familia `estiba`, no como `ubicacion`.

interface FilaCruda extends Omit<WarehouseLocationRow, 'renglones_con_cantidad' | 'renglones_totales' | 'productos_asignados' | 'updated_at'> {
  renglones_con_cantidad: string | number;
  renglones_totales?: string | number;
  productos_asignados?: string | number;
  updated_at: Date | string;
}

/**
 * `[UB.1]` Catálogo de ubicaciones (Fase UB, ADR-090). Lee y crea sobre
 * `commercial.warehouse_bins`; la cantidad sigue en `stock_lot_locations` (WMS-REC).
 *
 * El alcance por almacén lo da `ScopeService` en el proyecto Almacén: el encargado de tienda ve
 * y gestiona SU sucursal; supervisor y almacenista, las que su rol diga. Fuera de alcance responde
 * igual que "no existe" (no se confirma qué tiene otra sucursal).
 */
@Injectable()
export class WarehouseLocationsService {
  private readonly logger = new Logger(WarehouseLocationsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** Ids de almacén visibles; `null` = todos. Fuera de `tk.run` (ScopeService abre su propia consulta). */
  private visibles(): Promise<string[] | null> {
    return this.scope.warehouseIds({}, 'warehouse/locations', 'almacen');
  }

  async list(warehouseIdRaw?: string): Promise<WarehouseLocationsResponse> {
    this.tenantCtx.requireTenantId();
    // La base devuelve el uuid en minúsculas; compararlo tal cual llegó daba 404 a un id en mayúsculas.
    const warehouseId = warehouseIdRaw?.toLowerCase();
    if (warehouseId && !UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    const visibles = await this.visibles();
    const t0 = Date.now();
    return this.tk.run(async (trx) => {
      const qa = trx('commercial.warehouses').whereNull('deleted_at').select('id', 'code', 'name').orderBy('code');
      if (visibles !== null) qa.whereIn('id', visibles.length ? visibles : ['00000000-0000-0000-0000-000000000000']);
      const crudos = (await qa).filter((w: { code: string }) => !ES_RUTA.test(w.code));
      // [UB.RF.19] Cuánto trabajo tiene cada almacén del alcance. Una sola consulta agregada: es lo que
      // deja decir «aquí no hay nada, pero en Padre Hidalgo hay 23» en vez de un «no hay» a secas.
      const t = await trx.raw(
        // ⚠️ count(DISTINCT b.id), NO count(*): el LEFT JOIN multiplica la ubicación por cada producto
        // que tiene, y con `count(*)` Padre Hidalgo daba 185 ubicaciones en vez de 156 (sus 3 bins con
        // asignaciones se contaban 32 veces). Lo cazó el control de la consulta, no una prueba.
        `SELECT b.warehouse_id,
                count(DISTINCT b.id) FILTER (WHERE b.familia = 'ubicacion' AND b.estado <> 'baja')::int AS ubicaciones,
                count(DISTINCT a.product_id) FILTER (WHERE a.deleted_at IS NULL)::int AS con_producto
           FROM commercial.warehouse_bins b
           LEFT JOIN commercial.bin_assignments a ON a.tenant_id = b.tenant_id AND a.bin_id = b.id
          GROUP BY b.warehouse_id`,
      );
      const trabajo = new Map<string, { ubicaciones: number; con_producto: number }>(
        (t.rows as Array<{ warehouse_id: string; ubicaciones: number; con_producto: number }>).map((r) => [
          r.warehouse_id,
          { ubicaciones: Number(r.ubicaciones) || 0, con_producto: Number(r.con_producto) || 0 },
        ]),
      );
      const almacenes = crudos.map((w: { id: string; code: string; name: string }) => ({
        ...w,
        ubicaciones: trabajo.get(w.id)?.ubicaciones ?? 0,
        con_producto: trabajo.get(w.id)?.con_producto ?? 0,
      }));
      const alcance = { todas: visibles === null, almacenes };

      // El pedido manda si está en alcance; si no, el primero que se puede ver.
      const warehouse = (warehouseId ? almacenes.find((w) => w.id === warehouseId) : almacenes[0]) ?? null;
      if (warehouseId && !warehouse) throw new NotFoundException('Almacén no encontrado.');
      if (!warehouse) return { alcance, warehouse: null, resumen: resumenVacio(), ubicaciones: [] };

      const r = await trx.raw(
        `SELECT b.id, b.warehouse_id, w.code AS warehouse_code, b.code, b.label, b.familia, b.zona,
                b.pasillo, b.rack, b.nivel, b.tipo, b.estado, b.motivo_estado, b.pick_sequence, b.updated_at,
                (SELECT count(*) FROM commercial.stock_lot_locations l
                  WHERE l.tenant_id = b.tenant_id AND l.bin_id = b.id AND l.quantity > 0) AS renglones_con_cantidad,
                -- [UB.RF.17] Sin filtrar cantidad: distingue "cero mercancía" de "el acomodo nunca escribió acá".
                (SELECT count(*) FROM commercial.stock_lot_locations l
                  WHERE l.tenant_id = b.tenant_id AND l.bin_id = b.id) AS renglones_totales,
                -- [UB.RF.17] Lo único que varía hoy entre racks: qué productos ya tienen lugar.
                (SELECT count(*) FROM commercial.bin_assignments a
                  WHERE a.tenant_id = b.tenant_id AND a.bin_id = b.id AND a.deleted_at IS NULL) AS productos_asignados
           FROM commercial.warehouse_bins b
           JOIN commercial.warehouses w ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
          WHERE b.warehouse_id = ?
          ORDER BY b.pick_sequence NULLS LAST, b.code`,
        [warehouse.id],
      );
      const ubicaciones = (r.rows as FilaCruda[]).map(aFila);
      this.logger.debug(`ubicaciones ${warehouse.code}: ${ubicaciones.length} en ${Date.now() - t0} ms`);
      return { alcance, warehouse, resumen: resumir(ubicaciones), ubicaciones };
    });
  }

  async create(body: CreateWarehouseLocationBody): Promise<WarehouseLocationRow> {
    this.tenantCtx.requireTenantId();
    if (!body || !UUID.test(String(body.warehouse_id ?? ''))) throw new BadRequestException('warehouse_id inválido');
    const warehouseId = String(body.warehouse_id).toLowerCase();
    const parsed = parseLocationCode(body.code);
    if (!parsed.ok) throw new BadRequestException(parsed.motivo);
    const tipo = body.tipo ?? null;
    if (tipo !== null && !TIPOS.has(tipo)) throw new BadRequestException(`Tipo de ubicación desconocido: ${tipo}`);
    const label = String(body.label ?? '').trim();
    if (label.length > LABEL_MAX) throw new BadRequestException(`El nombre no puede pasar de ${LABEL_MAX} caracteres.`);

    // [UB.3] Alcance de lectura + escritura con el validador común del módulo (clave canónica de la
    // sucursal, no `code`: en Morelia `code` es 'MD-30' y la clave del alcance es '30').
    const ctx = { visibles: await this.visibles(), resuelto: await this.scope.current('almacen') };

    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, warehouseId, true);
      const dup = await trx('commercial.warehouse_bins')
        .where({ warehouse_id: wh.id })
        .whereRaw('UPPER(code) = ?', [parsed.code])
        .first('id', 'estado');
      if (dup) {
        throw new ConflictException(
          // [UB.RF.17] No se manda a «Mantenimiento»: esa pantalla es UB.4 y todavía no existe (ni su
          // endpoint). Decir a dónde ir cuando no hay a dónde ir cuesta una búsqueda inútil.
          dup.estado === 'baja'
            ? `La ubicación ${parsed.code} existe dada de baja y todavía no hay forma de reactivarla desde la suite.`
            : `Ya existe la ubicación ${parsed.code} en ese almacén.`,
        );
      }
      const userId = this.tenantCtx.get()?.userId || null;
      const { zona, pasillo, rack, nivel } = parsed.parts;
      const [row] = await trx('commercial.warehouse_bins')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: wh.id,
          code: parsed.code,
          label: label || null,
          familia: 'ubicacion',
          zona,
          pasillo,
          rack,
          nivel,
          tipo: tipo as LocationKind | null,
          pick_sequence: defaultPickSequence(parsed.parts),
          created_by: userId,
          updated_by: userId,
        })
        .returning(['id', 'warehouse_id', 'code', 'label', 'familia', 'zona', 'pasillo', 'rack', 'nivel', 'tipo', 'estado', 'motivo_estado', 'pick_sequence', 'updated_at'])
        .catch((e: { code?: string }) => {
          // Dos altas del mismo código al mismo tiempo: la segunda choca con el índice único.
          // Es la misma respuesta que la búsqueda previa, no un 500.
          if (e?.code === '23505') throw new ConflictException(`Ya existe la ubicación ${parsed.code} en ese almacén.`);
          throw e;
        });
      return aFila({ ...row, warehouse_code: wh.code, renglones_con_cantidad: 0 });
    });
  }
}

function aFila(r: FilaCruda): WarehouseLocationRow {
  return {
    ...r,
    rack: r.rack == null ? null : Number(r.rack),
    nivel: r.nivel == null ? null : Number(r.nivel),
    pick_sequence: r.pick_sequence == null ? null : Number(r.pick_sequence),
    renglones_con_cantidad: Number(r.renglones_con_cantidad) || 0,
    renglones_totales: Number(r.renglones_totales ?? r.renglones_con_cantidad) || 0,
    productos_asignados: Number(r.productos_asignados) || 0,
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

function resumenVacio(): WarehouseLocationsSummary {
  // `contenido_medido: false` — sin ubicaciones no hay nada medido, y un `0` ahí se leería como
  // "no hay mercancía" (ADR-056).
  return { total: 0, activas: 0, bloqueadas: 0, bajas: 0, con_formato: 0, legado: 0, con_contenido: 0, contenido_medido: false, con_producto: 0, fuera_del_mapa: 0 };
}

export function resumir(filas: WarehouseLocationRow[]): WarehouseLocationsSummary {
  const s = resumenVacio();
  for (const f of filas) {
    s.total++;
    if (f.estado === 'activa') s.activas++;
    else if (f.estado === 'bloqueada') s.bloqueadas++;
    else s.bajas++;
    if (f.familia === 'ubicacion') s.con_formato++;
    else if (f.familia === 'legado') s.legado++;
    else s.fuera_del_mapa++; // [UB.RF.17] carreta, espera, contenedor, estiba: el mapa no las recorre
    if (f.renglones_con_cantidad > 0) s.con_contenido++;
    if (f.renglones_totales > 0) s.contenido_medido = true;
    if (f.productos_asignados > 0) s.con_producto++;
  }
  return s;
}
