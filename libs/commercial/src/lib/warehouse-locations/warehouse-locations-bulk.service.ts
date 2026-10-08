import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService, branchKeySql } from '@megadulces/platform-core';
import {
  defaultPickSequence,
  expandLocationRange,
  formatLocationCode,
  LOCATION_BULK_MAX,
  LOCATION_KINDS,
  parseLocationCode,
  type BulkLocationAction,
  type BulkLocationPreviewRow,
  type BulkLocationsBody,
  type BulkLocationsPreview,
  type BulkLocationsResult,
  type LocationCaptureBatch,
  type LocationCodeParts,
  type LocationKind,
  type UndoLocationBatchResult,
} from '@megadulces/contracts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_MAX = 120;
const TIPOS = new Set<string>(LOCATION_KINDS.map((k) => k.key));
const ES_RUTA = /^RUTA-/i;
/** Lo que se pinta en la vista previa; los conteos sí cubren todo. */
const PREVIEW_MAX = 500;
/** Primero lo que tiene algo que decir. */
const PESO: Record<BulkLocationAction, number> = { error: 0, repetida: 1, baja: 2, existe: 3, nueva: 4 };

interface Almacen {
  id: string;
  code: string;
  name: string;
}
interface Plan {
  wh: Almacen;
  filas: Array<BulkLocationPreviewRow & { parts: LocationCodeParts | null }>;
}

/**
 * `[UB.2]` Captura masiva de ubicaciones (Fase UB, ADR-090): por rango o por archivo.
 *
 * La vista previa y el aplicar corren el MISMO plan, así que lo que se vio es lo que se crea. Lo
 * que ya existe no se toca; lo dado de baja no se reactiva aquí (eso es Mantenimiento, `[UB.4]`); lo
 * que trae error no se crea y se señala con su fila. Cada captura es un LOTE que se puede deshacer
 * mientras ninguna de sus ubicaciones se haya usado.
 */
@Injectable()
export class WarehouseLocationsBulkService {
  private readonly logger = new Logger(WarehouseLocationsBulkService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** Valida el almacén: visible, no camión, y con alcance de ESCRITURA (clave canónica, no `code`). */
  private async almacenEscribible(trx: Knex.Transaction, warehouseId: string, visibles: string[] | null, resuelto: Awaited<ReturnType<ScopeService['current']>>): Promise<Almacen> {
    if (visibles !== null && !visibles.includes(warehouseId)) throw new NotFoundException('Almacén no encontrado.');
    const wh = await trx('commercial.warehouses as w')
      .where('w.id', warehouseId)
      .whereNull('w.deleted_at')
      .first('w.id', 'w.code', 'w.name', trx.raw(`${branchKeySql('w')} AS clave`));
    if (!wh || ES_RUTA.test(wh.code)) throw new NotFoundException('Almacén no encontrado.');
    if (!this.scope.canWrite(resuelto, 'warehouse', wh.clave)) {
      throw new ForbiddenException(`No puedes dar de alta ubicaciones en el almacén ${wh.code}.`);
    }
    return { id: wh.id, code: wh.code, name: wh.name };
  }

  private async contexto(body: BulkLocationsBody) {
    this.tenantCtx.requireTenantId();
    if (!body || !UUID.test(String(body.warehouse_id ?? ''))) throw new BadRequestException('warehouse_id inválido');
    const hayRango = !!body.rango;
    const hayFilas = Array.isArray(body.filas);
    if (hayRango === hayFilas) throw new BadRequestException('Manda un rango o los renglones de un archivo (uno de los dos).');
    if (body.tipo != null && !TIPOS.has(body.tipo)) throw new BadRequestException(`Tipo de ubicación desconocido: ${body.tipo}`);
    if (hayFilas && (body.filas?.length ?? 0) > LOCATION_BULK_MAX) {
      throw new BadRequestException(`El archivo trae ${body.filas?.length} renglones; el tope por captura es ${LOCATION_BULK_MAX}.`);
    }
    const visibles = await this.scope.warehouseIds({}, 'warehouse/locations/bulk', 'almacen');
    const resuelto = await this.scope.current('almacen');
    return { warehouseId: String(body.warehouse_id).toLowerCase(), visibles, resuelto };
  }

  /** El plan: qué pasa con cada renglón. Lo usan la vista previa y el aplicar. */
  private async planificar(trx: Knex.Transaction, body: BulkLocationsBody, ctx: Awaited<ReturnType<WarehouseLocationsBulkService['contexto']>>): Promise<Plan> {
    const wh = await this.almacenEscribible(trx, ctx.warehouseId, ctx.visibles, ctx.resuelto);
    const tipoGeneral = (body.tipo ?? null) as LocationKind | null;
    const filas: Plan['filas'] = [];

    if (body.rango) {
      const r = expandLocationRange(body.rango);
      if (!r.ok) throw new BadRequestException(r.motivo);
      for (const parts of r.partes) {
        filas.push({ fila: null, code: formatLocationCode(parts), tipo: tipoGeneral, label: null, accion: 'nueva', motivo: null, parts });
      }
    } else {
      for (const [i, raw] of (body.filas ?? []).entries()) {
        const fila = Number.isInteger(raw?.fila) ? Number(raw.fila) : i + 2; // fila 1 = encabezados
        const parsed = parseLocationCode(raw?.code);
        const tipoTxt = String(raw?.tipo ?? '').trim().toLowerCase();
        const label = String(raw?.label ?? '').trim() || null;
        const base = { fila, code: parsed.code, label, parts: parsed.ok ? parsed.parts : null };
        if (!parsed.ok) {
          filas.push({ ...base, tipo: null, accion: 'error', motivo: parsed.motivo });
          continue;
        }
        if (tipoTxt && !TIPOS.has(tipoTxt)) {
          filas.push({ ...base, tipo: null, accion: 'error', motivo: `Tipo desconocido: "${raw?.tipo}". Usa: ${[...TIPOS].join(', ')}.` });
          continue;
        }
        if (label && label.length > LABEL_MAX) {
          filas.push({ ...base, tipo: null, accion: 'error', motivo: `El nombre no puede pasar de ${LABEL_MAX} caracteres.` });
          continue;
        }
        filas.push({ ...base, tipo: (tipoTxt || tipoGeneral) as LocationKind | null, accion: 'nueva', motivo: null });
      }
    }

    // Repetidas dentro de la misma captura: gana la primera, las demás se señalan.
    const primera = new Map<string, number | null>();
    for (const f of filas) {
      if (f.accion === 'error') continue;
      if (primera.has(f.code)) {
        const n = primera.get(f.code);
        f.accion = 'repetida';
        f.motivo = n == null ? 'Repetida en el rango.' : `Repetida: igual a la fila ${n}.`;
      } else primera.set(f.code, f.fila);
    }

    // Lo que ya existe en el almacén (sin importar mayúsculas).
    const candidatas = filas.filter((f) => f.accion === 'nueva').map((f) => f.code);
    if (candidatas.length) {
      const existentes = await trx('commercial.warehouse_bins')
        .where({ warehouse_id: wh.id })
        .whereRaw('UPPER(code) = ANY(?::text[])', [candidatas])
        .select(trx.raw('UPPER(code) AS code'), 'estado');
      const estado = new Map<string, string>(existentes.map((e: { code: string; estado: string }) => [e.code, e.estado]));
      for (const f of filas) {
        if (f.accion !== 'nueva') continue;
        const e = estado.get(f.code);
        if (e === 'baja') {
          f.accion = 'baja';
          f.motivo = 'Existe dada de baja: se reactiva desde Mantenimiento.';
        } else if (e) {
          f.accion = 'existe';
          f.motivo = e === 'bloqueada' ? 'Ya existe (bloqueada): no se toca.' : 'Ya existe: no se toca.';
        }
      }
    }
    return { wh, filas };
  }

  async preview(body: BulkLocationsBody): Promise<BulkLocationsPreview> {
    const ctx = await this.contexto(body);
    return this.tk.run(async (trx) => {
      const plan = await this.planificar(trx, body, ctx);
      const conteo: Record<BulkLocationAction, number> = { nueva: 0, existe: 0, baja: 0, repetida: 0, error: 0 };
      for (const f of plan.filas) conteo[f.accion]++;
      const ordenadas = [...plan.filas]
        .map(({ parts, ...f }) => f)
        .sort((a, b) => PESO[a.accion] - PESO[b.accion] || (a.fila ?? 0) - (b.fila ?? 0));
      return {
        warehouse: plan.wh,
        total: plan.filas.length,
        conteo,
        filas: ordenadas.slice(0, PREVIEW_MAX),
        truncado: ordenadas.length > PREVIEW_MAX,
      };
    });
  }

  async apply(body: BulkLocationsBody): Promise<BulkLocationsResult> {
    const ctx = await this.contexto(body);
    const userId = this.tenantCtx.get()?.userId || null;
    const t0 = Date.now();
    return this.tk.run(async (trx) => {
      const plan = await this.planificar(trx, body, ctx);
      const nuevas = plan.filas.filter((f) => f.accion === 'nueva' && f.parts);
      if (!nuevas.length) throw new BadRequestException('No hay ninguna ubicación nueva que crear.');
      const kind = body.rango ? 'rango' : 'archivo';
      const params = body.rango ? { rango: body.rango, tipo: body.tipo ?? null } : { archivo: body.archivo ?? null, renglones: plan.filas.length };
      const [lote] = await trx('commercial.location_capture_batches')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: plan.wh.id,
          kind,
          params: JSON.stringify(params),
          created_by: userId,
        })
        .returning(['id']);
      // `onConflict().ignore()`: si otra persona creó una igual entre el plan y el insert, se omite
      // en vez de tirar la captura entera.
      const creadas: Array<{ code: string }> = await trx('commercial.warehouse_bins')
        .insert(
          nuevas.map((f) => {
            const p = f.parts as LocationCodeParts;
            return {
              tenant_id: trx.raw('public.current_tenant_id()'),
              warehouse_id: plan.wh.id,
              code: f.code,
              label: f.label,
              familia: 'ubicacion',
              zona: p.zona,
              pasillo: p.pasillo,
              rack: p.rack,
              nivel: p.nivel,
              tipo: f.tipo,
              pick_sequence: defaultPickSequence(p),
              capture_batch_id: lote.id,
              created_by: userId,
              updated_by: userId,
            };
          }),
        )
        .onConflict(['tenant_id', 'warehouse_id', 'code'])
        .ignore()
        .returning(['code']);
      // Si una carrera dejó TODAS omitidas, no queda un lote vacío en el historial: se revierte.
      if (!creadas.length) throw new ConflictException('Mientras revisabas, alguien más creó esas ubicaciones. Vuelve a revisar.');
      const omitidas = plan.filas.length - creadas.length;
      await trx('commercial.location_capture_batches')
        .where({ id: lote.id })
        .update({ created_count: creadas.length, skipped_count: omitidas });
      this.logger.log(`captura ${kind} ${plan.wh.code}: ${creadas.length} creadas, ${omitidas} omitidas en ${Date.now() - t0} ms`);
      return { batch_id: lote.id, creadas: creadas.length, omitidas, codigos: creadas.map((c) => c.code) };
    });
  }

  async batches(warehouseIdRaw: string): Promise<LocationCaptureBatch[]> {
    this.tenantCtx.requireTenantId();
    const warehouseId = String(warehouseIdRaw ?? '').toLowerCase();
    if (!UUID.test(warehouseId)) throw new BadRequestException('warehouse_id inválido');
    const visibles = await this.scope.warehouseIds({}, 'warehouse/locations/batches', 'almacen');
    const resuelto = await this.scope.current('almacen');
    return this.tk.run(async (trx) => {
      // Escritura, no sólo lectura: el historial existe para deshacer, y sin alcance de escritura
      // el botón Deshacer contestaría 403 (revisión del PR).
      await this.almacenEscribible(trx, warehouseId, visibles, resuelto);
      const r = await trx.raw(
        `SELECT b.id, b.kind, b.params, b.created_count, b.skipped_count, b.created_at, b.undone_at, b.undone_count,
                COALESCE(u.nombre, u.username) AS created_by_name,
                (SELECT count(DISTINCT wb.id) FROM commercial.warehouse_bins wb
                   JOIN commercial.stock_lot_locations l ON l.tenant_id = wb.tenant_id AND l.bin_id = wb.id AND l.quantity > 0
                  WHERE wb.tenant_id = b.tenant_id AND wb.capture_batch_id = b.id) AS en_uso
           FROM commercial.location_capture_batches b
           LEFT JOIN identity.users u ON u.id = b.created_by
          WHERE b.warehouse_id = ?
          ORDER BY b.created_at DESC
          LIMIT 20`,
        [warehouseId],
      );
      return r.rows.map((x: Record<string, unknown>) => ({
        id: String(x['id']),
        kind: x['kind'] as 'rango' | 'archivo',
        descripcion: describirLote(x['kind'] as string, (x['params'] ?? {}) as Record<string, unknown>),
        created_count: Number(x['created_count']) || 0,
        skipped_count: Number(x['skipped_count']) || 0,
        created_at: new Date(x['created_at'] as string).toISOString(),
        created_by_name: (x['created_by_name'] as string) ?? null,
        undone_at: x['undone_at'] ? new Date(x['undone_at'] as string).toISOString() : null,
        undone_count: x['undone_count'] == null ? null : Number(x['undone_count']),
        en_uso: Number(x['en_uso']) || 0,
      }));
    });
  }

  async undo(batchIdRaw: string): Promise<UndoLocationBatchResult> {
    this.tenantCtx.requireTenantId();
    const batchId = String(batchIdRaw ?? '').toLowerCase();
    if (!UUID.test(batchId)) throw new BadRequestException('Lote inválido');
    const visibles = await this.scope.warehouseIds({}, 'warehouse/locations/batches/undo', 'almacen');
    const resuelto = await this.scope.current('almacen');
    const userId = this.tenantCtx.get()?.userId || null;
    return this.tk.run(async (trx) => {
      const lote = await trx('commercial.location_capture_batches').where({ id: batchId }).forUpdate().first('id', 'warehouse_id', 'undone_at');
      if (!lote) throw new NotFoundException('Lote no encontrado.');
      await this.almacenEscribible(trx, lote.warehouse_id, visibles, resuelto);
      if (lote.undone_at) throw new ConflictException('Ese lote ya se deshizo.');
      const usadas = await trx('commercial.warehouse_bins as wb')
        .join('commercial.stock_lot_locations as l', function () {
          this.on('l.tenant_id', 'wb.tenant_id').andOn('l.bin_id', 'wb.id');
        })
        .where('wb.capture_batch_id', batchId)
        .where('l.quantity', '>', 0)
        .distinct('wb.code')
        .orderBy('wb.code')
        .limit(11);
      if (usadas.length) {
        const lista = usadas.slice(0, 10).map((u: { code: string }) => u.code).join(', ');
        throw new ConflictException(
          `No se puede deshacer: ${usadas.length > 10 ? 'más de 10' : usadas.length} ubicación(es) del lote ya tienen mercancía (${lista}). Dalas de baja una por una desde Mantenimiento.`,
        );
      }
      // Lo que alguien ya bloqueó o dio de baja tiene un motivo registrado: se respeta, no se borra.
      const tocadas = await trx('commercial.warehouse_bins')
        .where({ capture_batch_id: batchId })
        .whereNot({ estado: 'activa' })
        .orderBy('code')
        .limit(11)
        .pluck('code');
      if (tocadas.length) {
        throw new ConflictException(
          `No se puede deshacer: ${tocadas.length > 10 ? 'más de 10' : tocadas.length} ubicación(es) del lote ya se bloquearon o dieron de baja (${tocadas.slice(0, 10).join(', ')}).`,
        );
      }
      // Ninguna se usó: nunca existieron en la operación, así que se retiran. Los renglones en CERO
      // (un rack que se vació con moveLot) se limpian primero, igual que deleteBin del Andén: la FK
      // es RESTRICT y existir alcanza para reventar el DELETE.
      const ids = trx('commercial.warehouse_bins').where({ capture_batch_id: batchId }).select('id');
      await trx('commercial.stock_lot_locations').whereIn('bin_id', ids).where('quantity', '<=', 0).del();
      const retiradas = await trx('commercial.warehouse_bins')
        .where({ capture_batch_id: batchId })
        .del()
        .catch((e: { code?: string }) => {
          // Un acomodo que entró entre la revisión y el borrado: mismo 409, no un 500.
          if (e?.code === '23503') throw new ConflictException('Mientras deshacías, se acomodó mercancía en una ubicación del lote. Ya no se puede deshacer.');
          throw e;
        });
      await trx('commercial.location_capture_batches')
        .where({ id: batchId })
        .update({ undone_at: trx.fn.now(), undone_by: userId, undone_count: retiradas });
      this.logger.log(`lote ${batchId} deshecho: ${retiradas} ubicaciones retiradas`);
      return { batch_id: batchId, retiradas };
    });
  }
}

/** "Bodega · A–D · racks 01–15 · niveles 1–3" o "Archivo ubicaciones-PH.xlsx (412 renglones)". */
export function describirLote(kind: string, params: Record<string, unknown>): string {
  if (kind === 'rango') {
    const r = (params['rango'] ?? {}) as Record<string, unknown>;
    const dos = (n: unknown) => String(n ?? '').padStart(2, '0');
    return `${r['zona'] === 'T' ? 'Tienda' : 'Bodega'} · pasillos ${r['pasillo_desde']}–${r['pasillo_hasta']} · racks ${dos(r['rack_desde'])}–${dos(r['rack_hasta'])} · niveles ${r['nivel_desde']}–${r['nivel_hasta']}`;
  }
  const archivo = params['archivo'] ? String(params['archivo']) : 'sin nombre';
  return `Archivo ${archivo} (${Number(params['renglones']) || 0} renglones)`;
}
