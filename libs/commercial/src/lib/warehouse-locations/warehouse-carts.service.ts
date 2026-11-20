import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  CART_KINDS,
  CART_NUM_MAX,
  formatCartCode,
  parseCartCode,
  type BulkCartsBody,
  type BulkCartsResult,
  type CartKind,
  type CartOrderRef,
  type CartRow,
  type CartsResponse,
  type LocationStatus,
  type OccupyCartBody,
  type OccupyCartResult,
} from '@megadulces/contracts';
import { almacenDeUbicaciones, contextoDeAlcance, type AlmacenUbicaciones } from './warehouse-locations-scope';
import { decidirLiberar, decidirOcupar, type CarretaHechos, type PedidoHechos } from './carretas.reglas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUTA = 'warehouse/carts';
const TIPOS = new Set<string>(CART_KINDS.map((k) => k.key));

/** `10:42`, hora de la Ciudad de México. */
const horaMx = (iso: string): string =>
  new Date(iso).toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false });

const pedidoKepler = (serie: number | string, folio: string): string => `U-D-${serie} ${folio}`;

interface FilaCarreta {
  id: string;
  code: string;
  tipo: CartKind;
  estado: LocationStatus;
  motivo_estado: string | null;
  oc_id: string | null;
  source: 'suite' | 'kepler' | null;
  order_id: string | null;
  occupied_at: Date | string | null;
  occupied_by: string | null;
  occupied_by_name: string | null;
  kepler_serie: number | null;
  kepler_folio: string | null;
  suite_code: string | null;
}

/**
 * `[GP.11.4]` Carretas y carritos: el catálogo por almacén, el alta por rango y la ocupación (qué pedido
 * trae cada una). Las reglas son de `carretas.reglas.ts`; la base vuelve a exigir lo esencial (una carreta
 * abierta por pedido, sólo carretas activas del almacén) — si dos surtidores escanean la misma carreta al
 * mismo tiempo, el segundo choca con el índice único y recibe el mismo mensaje que si hubiera llegado tarde.
 */
@Injectable()
export class WarehouseCartsService {
  private readonly logger = new Logger(WarehouseCartsService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  async list(warehouseIdRaw: string): Promise<CartsResponse> {
    const warehouseId = this.uuid(warehouseIdRaw, 'warehouse_id');
    const ctx = await contextoDeAlcance(this.scope, RUTA);
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, warehouseId, false);
      const carretas = await this.carretas(trx, wh.id);
      const activas = carretas.filter((c) => c.estado === 'activa');
      return {
        warehouse: { id: wh.id, code: wh.code, name: wh.name },
        carretas,
        libres: activas.filter((c) => !c.ocupacion).length,
        ocupadas: activas.filter((c) => !!c.ocupacion).length,
      };
    });
  }

  /** Alta por rango («carretas del 1 al 40»). Lo que ya existe con ese código no se toca y se dice. */
  async bulk(body: BulkCartsBody): Promise<BulkCartsResult> {
    const warehouseId = this.uuid(body?.warehouse_id, 'warehouse_id');
    if (!TIPOS.has(String(body?.tipo))) throw new BadRequestException('Elige si son carretas o carritos.');
    const desde = Number(body.desde);
    const hasta = Number(body.hasta);
    if (!(Number.isInteger(desde) && Number.isInteger(hasta) && desde >= 1 && hasta <= CART_NUM_MAX && desde <= hasta)) {
      throw new BadRequestException(`Los números van del 1 al ${CART_NUM_MAX} y el inicial no puede pasar al final.`);
    }
    const userId = this.userId();
    const ctx = await contextoDeAlcance(this.scope, RUTA);
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, warehouseId, true);
      const codigos = Array.from({ length: hasta - desde + 1 }, (_, i) => formatCartCode(desde + i));
      const existentes = new Set<string>(
        (await trx('commercial.warehouse_bins').where({ warehouse_id: wh.id }).whereIn(trx.raw('upper(code)') as never, codigos).select('code'))
          .map((r: { code: string }) => String(r.code).toUpperCase()),
      );
      const nuevos = codigos.filter((c) => !existentes.has(c));
      if (nuevos.length) {
        await trx('commercial.warehouse_bins')
          .insert(nuevos.map((code) => ({
            tenant_id: trx.raw('public.current_tenant_id()'), warehouse_id: wh.id, code, familia: 'carreta', tipo: body.tipo,
            estado: 'activa', created_by: userId, updated_by: userId,
          })))
          .catch((e: { code?: string }) => {
            if (e?.code === '23505') throw new ConflictException('Mientras tanto alguien dio de alta alguna de esas carretas. Vuelve a intentarlo.');
            throw e;
          });
      }
      this.logger.log(`carretas ${wh.code}: ${nuevos.length} nuevas (${body.tipo}), ${existentes.size} ya existían`);
      return { creadas: nuevos, ya_existian: codigos.filter((c) => existentes.has(c)) };
    });
  }

  /** Escanear una carreta para el pedido que se surte (al empezar, o «agregar otra carreta»). */
  async occupy(body: OccupyCartBody): Promise<OccupyCartResult> {
    const warehouseId = this.uuid(body?.warehouse_id, 'warehouse_id');
    const leida = parseCartCode(body?.carreta);
    if (!leida.ok) throw new BadRequestException(leida.motivo);
    const ref = this.referencia(body?.pedido);
    const { userId, nombre } = await this.quien();
    const ctx = await contextoDeAlcance(this.scope, RUTA);
    return this.tk.run(async (trx) => {
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, warehouseId, false);
      const carreta = await this.carretaParaActualizar(trx, wh.id, leida.code);
      const pedido = await this.pedido(trx, wh, ref);
      const d = decidirOcupar(carreta?.hechos ?? null, pedido?.hechos ?? null, userId, horaMx, leida.code, wh.name);
      if (!d.ok) throw new HttpException(d.motivo, d.status);
      if (d.accion === 'ocupar') {
        await trx('commercial.cart_occupations')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'), warehouse_id: wh.id, bin_id: carreta!.id, source: ref.source,
            order_id: pedido!.hechos.order_id,
            kepler_sucursal: ref.source === 'kepler' ? ref.sucursal : null,
            kepler_serie: ref.source === 'kepler' ? ref.serie : null,
            kepler_folio: ref.source === 'kepler' ? ref.folio : null,
            wave_id: pedido!.wave_id, occupied_by: userId, occupied_by_name: nombre, created_by: userId, updated_by: userId,
          })
          .catch((e: { code?: string }) => {
            // Otro surtidor la tomó entre la lectura y el alta: el índice único lo frena.
            if (e?.code === '23505') throw new ConflictException(`${leida.code} la acaba de tomar otra persona. Usa otra.`);
            throw e;
          });
      }
      const [fila] = await this.carretas(trx, wh.id, carreta!.id);
      return { carreta: fila, ya_estaba: d.accion === 'ya_estaba' };
    });
  }

  /** `deshecho` (quien la escaneó por error) o `manual` (el coordinador). El permiso lo pone el controlador. */
  async release(binIdRaw: string, motivo: 'deshecho' | 'manual'): Promise<CartRow> {
    const binId = this.uuid(binIdRaw, 'id');
    const { userId, nombre } = await this.quien();
    const ctx = await contextoDeAlcance(this.scope, RUTA);
    return this.tk.run(async (trx) => {
      const bin = await trx('commercial.warehouse_bins').where({ id: binId, familia: 'carreta' }).first('warehouse_id');
      if (!bin) throw new NotFoundException('Carreta no encontrada.');
      const wh = await almacenDeUbicaciones(trx, this.scope, ctx, bin.warehouse_id, false);
      const oc = await trx('commercial.cart_occupations').where({ bin_id: binId }).whereNull('released_at').forUpdate().first();
      const terminado = oc ? await this.pedidoTerminado(trx, oc) : false;
      const etiqueta = oc ? (oc.source === 'kepler' ? pedidoKepler(oc.kepler_serie, oc.kepler_folio) : await this.codigoSuite(trx, oc.order_id)) : '';
      const d = decidirLiberar(oc ? { occupied_by: oc.occupied_by, pedido: etiqueta } : null, motivo, userId, motivo === 'manual', terminado);
      if (!d.ok) throw new HttpException(d.motivo, d.status);
      await trx('commercial.cart_occupations').where({ id: oc.id }).update({
        released_at: trx.fn.now(), released_by: userId, released_by_name: nombre, release_reason: motivo, updated_at: trx.fn.now(), updated_by: userId,
      });
      const [fila] = await this.carretas(trx, wh.id, binId);
      return fila;
    });
  }

  // ─── Interno ──────────────────────────────────────────────────────────────────────────────────

  private async carretas(trx: Knex.Transaction, warehouseId: string, binId?: string): Promise<CartRow[]> {
    const r = await trx.raw(
      `SELECT b.id, b.code, b.tipo, b.estado, b.motivo_estado,
              o.id AS oc_id, o.source, o.order_id, o.occupied_at, o.occupied_by, o.occupied_by_name,
              o.kepler_serie, o.kepler_folio, ord.code AS suite_code
         FROM commercial.warehouse_bins b
         LEFT JOIN commercial.cart_occupations o
           ON o.tenant_id = b.tenant_id AND o.bin_id = b.id AND o.released_at IS NULL
         LEFT JOIN commercial.orders ord
           ON o.source = 'suite' AND ord.tenant_id = o.tenant_id AND ord.id = o.order_id
        WHERE b.warehouse_id = ? AND b.familia = 'carreta' ${binId ? 'AND b.id = ?' : ''}
        ORDER BY b.code`,
      binId ? [warehouseId, binId] : [warehouseId],
    );
    return (r.rows as FilaCarreta[]).map((f) => ({
      id: f.id,
      code: f.code,
      numero: Number(f.code.slice(1)),
      tipo: f.tipo,
      estado: f.estado,
      motivo_estado: f.motivo_estado,
      ocupacion: f.oc_id
        ? {
            id: f.oc_id,
            source: f.source!,
            order_id: f.order_id!,
            pedido: f.source === 'kepler' ? pedidoKepler(f.kepler_serie!, f.kepler_folio!) : f.suite_code ?? 'pedido de la Suite',
            occupied_at: iso(f.occupied_at),
            occupied_by: f.occupied_by!,
            occupied_by_name: f.occupied_by_name!,
          }
        : null,
    }));
  }

  /** La carreta con su ocupación abierta, bloqueando la fila del catálogo (dos escaneos a la vez se forman). */
  private async carretaParaActualizar(trx: Knex.Transaction, warehouseId: string, code: string): Promise<{ id: string; hechos: CarretaHechos } | null> {
    const b = await trx('commercial.warehouse_bins').where({ warehouse_id: warehouseId, familia: 'carreta' }).whereRaw('upper(code) = ?', [code]).forUpdate().first('id');
    if (!b) return null;
    const [f] = await this.carretas(trx, warehouseId, b.id);
    return {
      id: f.id,
      hechos: {
        code: f.code, tipo: f.tipo, estado: f.estado, motivo_estado: f.motivo_estado,
        ocupacion: f.ocupacion ? { order_id: f.ocupacion.order_id, pedido: f.ocupacion.pedido, occupied_by: f.ocupacion.occupied_by, occupied_by_name: f.ocupacion.occupied_by_name, occupied_at: f.ocupacion.occupied_at } : null,
      },
    };
  }

  /**
   * El pedido como lo ve el surtido de ESTE almacén: quién lo surte y si ya terminó. Preventa por
   * `presale_picks`; si va en una ola (Kepler siempre, la Suite a veces), por la ola (`en_surtido` +
   * `assigned_to`). Un pedido de otro almacén responde como si no existiera.
   */
  private async pedido(trx: Knex.Transaction, wh: AlmacenUbicaciones, ref: CartOrderRef): Promise<{ hechos: PedidoHechos; wave_id: string | null } | null> {
    const ola = (orderIdSql: string, params: ReadonlyArray<string | number>) =>
      trx.raw(
        `SELECT wo.order_id, w.id AS wave_id, w.status, w.assigned_to, w.warehouse_id, u.nombre
           FROM commercial.wave_orders wo
           JOIN commercial.picking_waves w ON w.tenant_id = wo.tenant_id AND w.id = wo.wave_id
           LEFT JOIN identity.users u ON u.id = w.assigned_to
          WHERE wo.order_id = ${orderIdSql}
          ORDER BY wo.added_at DESC
          LIMIT 1`,
        params,
      );
    const deOla = (o: Record<string, unknown> | undefined, order_id: string, etiqueta: string) =>
      o && o['warehouse_id'] === wh.id
        ? {
            hechos: {
              order_id, pedido: etiqueta,
              surtidor_id: o['status'] === 'en_surtido' || o['status'] === 'surtida' ? (o['assigned_to'] as string | null) : null,
              surtidor_nombre: (o['nombre'] as string | null) ?? null,
              terminado: o['status'] === 'surtida',
            },
            wave_id: o['wave_id'] as string,
          }
        : null;

    if (ref.source === 'kepler') {
      const r = await ola(`md5('kepler/UD40/' || ? || '/' || ? || '/' || ?)::uuid AND wo.source = 'kepler'`, [ref.sucursal, ref.serie, ref.folio]);
      const o = r.rows[0] as Record<string, unknown> | undefined;
      return o ? deOla(o, String(o['order_id']), pedidoKepler(ref.serie, ref.folio)) : null;
    }
    const ord = await trx('commercial.orders').where({ id: ref.order_id }).first('id', 'code', 'warehouse_id');
    if (!ord || ord.warehouse_id !== wh.id) return null;
    const pick = await trx('commercial.presale_picks').where({ order_id: ord.id }).first('started_by', 'started_by_name', 'finished_at');
    if (pick) {
      return {
        hechos: { order_id: ord.id, pedido: ord.code, surtidor_id: pick.started_by, surtidor_nombre: pick.started_by_name, terminado: !!pick.finished_at },
        wave_id: null,
      };
    }
    const r = await ola('?', [ord.id]);
    return deOla(r.rows[0], ord.id, ord.code) ?? { hechos: { order_id: ord.id, pedido: ord.code, surtidor_id: null, surtidor_nombre: null, terminado: false }, wave_id: null };
  }

  private async pedidoTerminado(trx: Knex.Transaction, oc: { source: string; order_id: string; wave_id: string | null }): Promise<boolean> {
    if (oc.wave_id) {
      const w = await trx('commercial.picking_waves').where({ id: oc.wave_id }).first('status');
      return w?.status === 'surtida';
    }
    const p = await trx('commercial.presale_picks').where({ order_id: oc.order_id }).first('finished_at');
    return !!p?.finished_at;
  }

  private async codigoSuite(trx: Knex.Transaction, orderId: string): Promise<string> {
    const o = await trx('commercial.orders').where({ id: orderId }).first('code');
    return o?.code ?? 'pedido de la Suite';
  }

  private referencia(p: CartOrderRef | undefined): CartOrderRef {
    if (p?.source === 'suite') return { source: 'suite', order_id: this.uuid(p.order_id, 'pedido.order_id') };
    if (p?.source === 'kepler') {
      const sucursal = String(p.sucursal ?? '').trim();
      const serie = Number(p.serie);
      const folio = String(p.folio ?? '').trim();
      if (!/^\d{2}$/.test(sucursal) || !Number.isInteger(serie) || !/^\d{1,10}$/.test(folio)) {
        throw new BadRequestException('El pedido de Kepler lleva sucursal (2 dígitos), serie y folio.');
      }
      return { source: 'kepler', sucursal, serie, folio };
    }
    throw new BadRequestException('Falta el pedido (de la Suite o de Kepler).');
  }

  private uuid(v: unknown, campo: string): string {
    const s = String(v ?? '').trim().toLowerCase();
    if (!UUID.test(s)) throw new BadRequestException(`${campo} inválido`);
    return s;
  }

  private userId(): string {
    const id = this.tenantCtx.get()?.userId;
    if (!id) throw new UnauthorizedException('Sin usuario en la sesión.');
    return id;
  }

  /** Quién firma, con el nombre de su ficha (el mismo criterio que el surtido de preventa). */
  private async quien(): Promise<{ userId: string; nombre: string }> {
    const userId = this.userId();
    const u = await this.tk.run((trx) => trx('identity.users').where({ id: userId }).first('nombre', 'username'));
    const nombre = String(u?.nombre ?? '').trim() || String(u?.username ?? '').trim() || 'Surtidor';
    return { userId, nombre };
  }
}

const iso = (v: Date | string | null): string => (v instanceof Date ? v.toISOString() : String(v ?? ''));
