import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, ScopeService, branchKeySql } from '@megadulces/platform-core';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_MAX = 120;
const TIPOS = new Set<string>(LOCATION_KINDS.map((k) => k.key));
/**
 * Las rutas (`RUTA-*`) son camiones: no tienen racks. Se dejan fuera del selector para que nadie
 * genere ubicaciones de bodega sobre un camión. Si algún día se ubican estibas del camión, entran
 * como familia `estiba`, no como `ubicacion`.
 */
const ES_RUTA = /^RUTA-/i;

interface FilaCruda extends Omit<WarehouseLocationRow, 'renglones_con_cantidad' | 'updated_at'> {
  renglones_con_cantidad: string | number;
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
      const almacenes = (await qa).filter((w: { code: string }) => !ES_RUTA.test(w.code));
      const alcance = { todas: visibles === null, almacenes };

      // El pedido manda si está en alcance; si no, el primero que se puede ver.
      const warehouse = (warehouseId ? almacenes.find((w) => w.id === warehouseId) : almacenes[0]) ?? null;
      if (warehouseId && !warehouse) throw new NotFoundException('Almacén no encontrado.');
      if (!warehouse) return { alcance, warehouse: null, resumen: resumenVacio(), ubicaciones: [] };

      const r = await trx.raw(
        `SELECT b.id, b.warehouse_id, w.code AS warehouse_code, b.code, b.label, b.familia, b.zona,
                b.pasillo, b.rack, b.nivel, b.tipo, b.estado, b.motivo_estado, b.pick_sequence, b.updated_at,
                (SELECT count(*) FROM commercial.stock_lot_locations l
                  WHERE l.tenant_id = b.tenant_id AND l.bin_id = b.id AND l.quantity > 0) AS renglones_con_cantidad
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

    const visibles = await this.visibles();
    if (visibles !== null && !visibles.includes(warehouseId)) throw new NotFoundException('Almacén no encontrado.');
    const resuelto = await this.scope.current('almacen');

    return this.tk.run(async (trx) => {
      // `clave` = la llave canónica de la sucursal (branchKeySql), NO `code`: en Morelia `code` es
      // 'MD-30' y la clave del alcance es '30'. Comparar contra `code` le negaba al encargado su
      // propia sucursal (revisión del PR).
      const wh = await trx('commercial.warehouses as w')
        .where('w.id', warehouseId)
        .whereNull('w.deleted_at')
        .first('w.id', 'w.code', trx.raw(`${branchKeySql('w')} AS clave`));
      if (!wh || ES_RUTA.test(wh.code)) throw new NotFoundException('Almacén no encontrado.');
      // Leer no es escribir: el alcance de escritura puede ser más corto que el de lectura.
      if (!this.scope.canWrite(resuelto, 'warehouse', wh.clave)) {
        throw new ForbiddenException(`No puedes dar de alta ubicaciones en el almacén ${wh.code}.`);
      }
      const dup = await trx('commercial.warehouse_bins')
        .where({ warehouse_id: wh.id })
        .whereRaw('UPPER(code) = ?', [parsed.code])
        .first('id', 'estado');
      if (dup) {
        throw new ConflictException(
          dup.estado === 'baja'
            ? `La ubicación ${parsed.code} existe dada de baja: reactívala desde Mantenimiento.`
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
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

function resumenVacio(): WarehouseLocationsSummary {
  return { total: 0, activas: 0, bloqueadas: 0, bajas: 0, con_formato: 0, legado: 0, con_contenido: 0 };
}

export function resumir(filas: WarehouseLocationRow[]): WarehouseLocationsSummary {
  const s = resumenVacio();
  for (const f of filas) {
    s.total++;
    if (f.estado === 'activa') s.activas++;
    else if (f.estado === 'bloqueada') s.bloqueadas++;
    else s.bajas++;
    if (f.familia === 'ubicacion') s.con_formato++;
    if (f.familia === 'legado') s.legado++;
    if (f.renglones_con_cantidad > 0) s.con_contenido++;
  }
  return s;
}
