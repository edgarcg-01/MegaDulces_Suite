import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';
import { repartirOla, resumenPorPedido } from './allocation';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PoolQuery {
  warehouse_id?: string;
  delivery_date?: string;
  limit?: number;
}

export interface CreateWaveDto {
  warehouse_id: string;
  delivery_date?: string;
  order_ids: string[];
  assigned_to?: string;
  notes?: string;
}

/**
 * SU.2 — El pool de pedidos por surtir y las olas (ADR-067).
 *
 * ⭐ El pool es una LECTURA derivada, no una tabla: un pedido está "por surtir" cuando su estado
 * COMERCIAL dice que el cliente ya se comprometió (`confirmed`) y no está en ninguna ola viva.
 * Materializarlo sería una segunda verdad que habría que mantener sincronizada con
 * `commercial.orders` — y la regla del proyecto es derivar, no copiar.
 *
 * ⛔ **No aparta stock** (decisión de Edgar, 2026-09-17). La existencia que se vea al armar la ola
 * es informativa; el reparto de lo escaso se resuelve sobre lo que el surtidor levantó (SU.6/SU.8).
 * Por eso acá no hay nada que reservar ni que liberar: dos olas pueden pedir el mismo producto y
 * eso se resuelve por excepción, no se previene.
 */
@Injectable()
export class PickingService {
  private readonly logger = new Logger(PickingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Pedidos listos para surtir y todavía sin ola.
   *
   * ⚠️ `pendiente_offline` NO se puede medir desde acá y se DECLARA (ADR-056): el vendedor arma
   * pedidos sin señal (Dexie + cola de sync en `apps/vendor`) y esos pedidos **no existen para el
   * servidor** hasta que sincronizan. El pool no puede prometer que muestra todo lo del día; lo
   * que muestra es todo lo que YA LLEGÓ. La pantalla tiene que decirlo — si no, un pedido que
   * nunca sincronizó se ve igual que un pedido que no existe.
   */
  async pool(q: PoolQuery = {}) {
    if (q.warehouse_id && !UUID_RE.test(q.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (q.delivery_date && !DATE_RE.test(q.delivery_date))
      throw new BadRequestException('delivery_date debe ser YYYY-MM-DD');
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);

    return this.tk.run(async (trx) => {
      let qb = trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', function () {
          this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'o.warehouse_id').andOn('w.tenant_id', '=', 'o.tenant_id');
        })
        .where('o.status', 'confirmed')
        // Sin ola viva. `listo_embarque` ya salió del almacén, así que no bloquea.
        .whereNotExists(function () {
          this.select(trx.raw('1'))
            .from('commercial.wave_orders as wo')
            .whereRaw('wo.order_id = o.id')
            .andWhere('wo.stage', '<>', 'listo_embarque');
        });

      if (q.warehouse_id) qb = qb.where('o.warehouse_id', q.warehouse_id);
      if (q.delivery_date) qb = qb.where('o.requested_delivery_date', q.delivery_date);

      const rows = await qb
        .select(
          'o.id',
          'o.code',
          'o.customer_id',
          'c.name as customer_name',
          'o.warehouse_id',
          'w.name as warehouse_name',
          'o.requested_delivery_date',
          'o.total',
          'o.confirmed_at',
          'o.created_at',
          trx.raw('(SELECT count(*) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::int AS lines'),
          trx.raw('(SELECT coalesce(sum(ol.quantity),0) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::numeric AS units'),
        )
        // Primero lo que se entrega antes; a igual fecha, lo que se confirmó antes.
        .orderByRaw('o.requested_delivery_date ASC NULLS LAST, o.confirmed_at ASC NULLS LAST, o.code ASC')
        .limit(limit);

      return {
        data: rows,
        count: rows.length,
        capped: rows.length === limit,
        // ⚠️ Frescura del pool: lo creado sin señal todavía no llegó. No es un contador que
        // podamos calcular — es una ausencia, y se declara como tal.
        pendiente_offline: 'no_medible_desde_el_servidor',
      };
    });
  }

  /** Detalle de una ola: cabecera, sus pedidos y el consolidado por SKU. */
  async byId(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);

      const orders = await trx('commercial.wave_orders as wo')
        .join('commercial.orders as o', function () {
          this.on('o.id', '=', 'wo.order_id').andOn('o.tenant_id', '=', 'wo.tenant_id');
        })
        .leftJoin('commercial.customers as c', function () {
          this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
        })
        .where('wo.wave_id', waveId)
        .select('wo.id as wave_order_id', 'wo.stage', 'o.id as order_id', 'o.code', 'o.total', 'c.name as customer_name')
        .orderBy('o.code');

      return { ...wave, orders, consolidated: await this.consolidado(trx, waveId) };
    });
  }

  /**
   * §11 del documento — el consolidado por SKU que recorre el surtidor.
   *
   * ⭐ Va SIEMPRE con la unidad al lado, y el desglose por pedido debajo. Dos razones, las dos
   * medidas:
   *
   *  1. Un número sin unidad es el defecto de ADR-055, que ya costó $866,805 de sobre-pedido. El
   *     catálogo no tiene una unidad uniforme: la base es PAQ en 6,586 SKUs, PZA en 1,906, KG en
   *     232, y 69% de los productos tienen más de una presentación. "Carlos V = 23" no le dice
   *     nada a quien tiene que agarrarlo del anaquel.
   *  2. El desglose por pedido es lo que hace posible la desconsolidación (SU.6). Si se pierde al
   *     consolidar, hay que reconstruirlo adivinando.
   *
   * ⚠️ `qty_unit` sale del sello que puso la captura (VU.2/VU.4). Cuando la línea no lo trae, la
   * cantidad está en unidad base y se declara `sin_unidad_declarada` — nunca se asume "pieza".
   */
  private async consolidado(trx: any, waveId: string) {
    const rows = await trx('commercial.wave_orders as wo')
      .join('commercial.order_lines as ol', function (this: any) {
        this.on('ol.order_id', '=', 'wo.order_id').andOn('ol.tenant_id', '=', 'wo.tenant_id');
      })
      .leftJoin('catalog.products as p', function (this: any) {
        this.on('p.id', '=', 'ol.product_id').andOn('p.tenant_id', '=', 'ol.tenant_id');
      })
      .join('commercial.orders as o', function (this: any) {
        this.on('o.id', '=', 'wo.order_id').andOn('o.tenant_id', '=', 'wo.tenant_id');
      })
      .where('wo.wave_id', waveId)
      .select(
        'ol.product_id',
        // ⚠️ `nombre`, no `name`: el catálogo conserva el español legacy (mismo nombre que usa
        // `commercial-orders` al leer sus líneas). Es la clase de columna que NO se adivina.
        'p.nombre as product_name',
        'p.sku',
        'ol.qty_unit',
        'ol.quantity',
        'o.code as order_code',
        'wo.order_id',
      )
      .orderBy(['p.nombre', 'o.code']);

    const porSku = new Map<string, any>();
    for (const r of rows as any[]) {
      let g = porSku.get(r.product_id);
      if (!g) {
        g = {
          product_id: r.product_id,
          product_name: r.product_name,
          sku: r.sku,
          total_base: 0,
          // ⚠️ Si dos pedidos capturaron el MISMO producto en unidades distintas, el total en la
          // unidad de captura no existe: se declara mixto y el surtidor cuenta en unidad base.
          unidades_capturadas: new Set<string>(),
          por_pedido: [] as any[],
        };
        porSku.set(r.product_id, g);
      }
      g.total_base += Number(r.quantity);
      // ⚠️ La ausencia se guarda como `null`, NO como el texto "sin_unidad_declarada". Un
      // centinela de texto se ve igual que una unidad real y termina viajando a la base como si
      // lo fuera (pasó: reventó el varchar(16) de `wave_lines.qty_unit`, y de haber cabido habría
      // quedado una "unidad" inventada en la tabla). ADR-056: la ausencia se declara, no se nombra.
      g.unidades_capturadas.add(r.qty_unit || null);
      g.por_pedido.push({ order_id: r.order_id, order_code: r.order_code, quantity: Number(r.quantity) });
    }

    return Array.from(porSku.values()).map((g) => {
      const us = Array.from(g.unidades_capturadas) as (string | null)[];
      return {
        product_id: g.product_id,
        product_name: g.product_name,
        sku: g.sku,
        total_base: g.total_base,
        // Una sola unidad de captura Y que exista → se puede nombrar. Varias, o ninguna, → null:
        // no se inventa un total común ni se bautiza la ausencia.
        qty_unit: us.length === 1 && us[0] != null ? us[0] : null,
        unidad_mixta: us.length > 1,
        // Para mostrar: acá SÍ se rotula la ausencia, porque es texto de pantalla y no un dato
        // que se guarde. La distinción importa — lo que se persiste es el null de arriba.
        unidades_capturadas: us.map((u) => u ?? 'sin declarar'),
        por_pedido: g.por_pedido,
      };
    });
  }

  /** Lista de olas (bandeja del jefe de almacén). */
  async list(status?: string) {
    return this.tk.run(async (trx) => {
      let qb = trx('commercial.picking_waves as pw')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'pw.warehouse_id').andOn('w.tenant_id', '=', 'pw.tenant_id');
        });
      if (status) qb = qb.where('pw.status', status);
      return qb
        .select(
          'pw.*',
          'w.name as warehouse_name',
          trx.raw('(SELECT count(*) FROM commercial.wave_orders wo WHERE wo.wave_id = pw.id)::int AS orders_count'),
        )
        .orderBy('pw.created_at', 'desc')
        .limit(100);
    });
  }

  /**
   * Arma una ola con los pedidos dados.
   *
   * ⚠️ Un pedido que ya está en otra ola viva **no se roba en silencio**: se rechaza la operación
   * entera y se dice cuáles. El índice único parcial `ux_wo_order_viva` lo garantiza también en la
   * base, pero un 23505 crudo no le dice al jefe de almacén cuál pedido fue.
   */
  async createWave(dto: CreateWaveDto) {
    if (!UUID_RE.test(dto?.warehouse_id || '')) throw new BadRequestException('warehouse_id inválido');
    const ids = Array.from(new Set((dto?.order_ids || []).filter((x) => UUID_RE.test(x))));
    if (!ids.length) throw new BadRequestException('order_ids vacío o inválido');
    if (dto.delivery_date && !DATE_RE.test(dto.delivery_date))
      throw new BadRequestException('delivery_date debe ser YYYY-MM-DD');
    if (dto.assigned_to && !UUID_RE.test(dto.assigned_to))
      throw new BadRequestException('assigned_to inválido');

    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const orders = await trx('commercial.orders').whereIn('id', ids).select('id', 'code', 'status', 'warehouse_id');
      if (orders.length !== ids.length) {
        const vistos = new Set(orders.map((o: any) => o.id));
        throw new NotFoundException(`Pedidos no encontrados: ${ids.filter((i) => !vistos.has(i)).join(', ')}`);
      }

      const noConfirmados = orders.filter((o: any) => o.status !== 'confirmed');
      if (noConfirmados.length)
        throw new ConflictException(
          `Solo entran pedidos confirmados. Fuera: ${noConfirmados.map((o: any) => `${o.code} (${o.status})`).join(', ')}`,
        );

      // Una ola recorre UN almacén: mezclar dos es un recorrido imposible.
      const otroAlmacen = orders.filter((o: any) => o.warehouse_id !== dto.warehouse_id);
      if (otroAlmacen.length)
        throw new ConflictException(
          `Estos pedidos se surten de otro almacén: ${otroAlmacen.map((o: any) => o.code).join(', ')}`,
        );

      const yaEnOla = await trx('commercial.wave_orders as wo')
        .join('commercial.orders as o', function (this: any) {
          this.on('o.id', '=', 'wo.order_id').andOn('o.tenant_id', '=', 'wo.tenant_id');
        })
        .whereIn('wo.order_id', ids)
        .andWhere('wo.stage', '<>', 'listo_embarque')
        .select('o.code');
      if (yaEnOla.length)
        throw new ConflictException(
          `Ya están en otra ola: ${yaEnOla.map((r: any) => r.code).join(', ')}`,
        );

      const code = await this.nextCode(trx);
      const [wave] = await trx('commercial.picking_waves')
        .insert({
          code,
          warehouse_id: dto.warehouse_id,
          delivery_date: dto.delivery_date || null,
          assigned_to: dto.assigned_to || null,
          notes: dto.notes || null,
          created_by: userId,
          updated_by: userId,
        })
        .returning('*');

      await trx('commercial.wave_orders').insert(
        ids.map((order_id) => ({ wave_id: wave.id, order_id, added_by: userId })),
      );

      this.logger.log(`Ola ${code} creada con ${ids.length} pedido(s)`);
      return { ...wave, orders_count: ids.length };
    });
  }

  /** Asigna (o reasigna) la ola a un surtidor. */
  async assign(waveId: string, assignedTo: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    if (!UUID_RE.test(assignedTo)) throw new BadRequestException('assigned_to inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'cancelada') throw new ConflictException('La ola está cancelada');
      if (wave.status === 'surtida') throw new ConflictException('La ola ya se surtió');

      const [upd] = await trx('commercial.picking_waves')
        .where({ id: waveId })
        .update({ assigned_to: assignedTo, updated_at: trx.fn.now(), updated_by: userId })
        .returning('*');
      return upd;
    });
  }

  /**
   * Cancela la ola. Los pedidos vuelven al pool solos: el pool los encuentra porque el índice
   * `ux_wo_order_viva` deja de aplicar cuando se borran sus renglones.
   *
   * ⚠️ Se BORRAN los `wave_orders` en vez de marcarlos: si se conservaran con su `stage`, el
   * índice único parcial seguiría reservando al pedido y no podría entrar a otra ola — el pedido
   * quedaría preso por una ola que ya no existe.
   */
  async cancelWave(waveId: string, reason?: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'surtida') throw new ConflictException('Una ola ya surtida no se cancela');
      if (wave.status === 'cancelada') return wave; // idempotente

      await trx('commercial.wave_orders').where({ wave_id: waveId }).del();
      const [upd] = await trx('commercial.picking_waves')
        .where({ id: waveId })
        .update({
          status: 'cancelada',
          notes: reason ? `${wave.notes ? wave.notes + ' · ' : ''}Cancelada: ${reason}` : wave.notes,
          updated_at: trx.fn.now(),
          updated_by: userId,
        })
        .returning('*');
      return upd;
    });
  }

  /**
   * Arranca el surtido: congela el consolidado en `wave_lines` y marca la ola `en_surtido`.
   *
   * ⚠️ El congelado va ACÁ y no al crear la ola: un pedido corregido entre armar y empezar dejaría
   * a la persona buscando una cantidad que ya nadie pidió. Y una vez arrancada no se recalcula —
   * el papel que se está recorriendo no puede cambiar debajo.
   *
   * Idempotente: arrancar dos veces devuelve las líneas ya congeladas sin pisar lo levantado.
   */
  async startPicking(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'cancelada') throw new ConflictException('La ola está cancelada');
      if (wave.status === 'surtida') throw new ConflictException('La ola ya se surtió');

      const yaHay = await trx('commercial.wave_lines').where({ wave_id: waveId }).first();
      if (!yaHay) {
        const cons = await this.consolidado(trx, waveId);
        if (!cons.length) throw new ConflictException('La ola no tiene renglones que surtir');
        await trx('commercial.wave_lines').insert(
          cons.map((c: any) => ({
            wave_id: waveId,
            product_id: c.product_id,
            qty_requested: c.total_base,
            // La unidad viaja con la cantidad, o se declara ausente. Nunca 'PZA' de relleno.
            qty_unit: c.unidad_mixta ? null : c.qty_unit,
            unidad_mixta: !!c.unidad_mixta,
          })),
        );
      }

      if (wave.status !== 'en_surtido') {
        await trx('commercial.picking_waves').where({ id: waveId }).update({
          status: 'en_surtido',
          started_at: wave.started_at || trx.fn.now(),
          picked_by: wave.picked_by || userId,
          updated_at: trx.fn.now(),
          updated_by: userId,
        });
      }
      return this.lineasDe(trx, waveId);
    });
  }

  /**
   * Marca un renglón: cuánto se levantó y por qué, si no fue todo.
   *
   * ⭐ **No detiene el surtido** (§14 del documento, y es la regla correcta): un faltante se
   * registra y la persona sigue. Lo que se hace con ese faltante —sustituir, traspasar, avisar al
   * vendedor— es trabajo del motor comercial, asíncrono, y no puede bloquear el recorrido.
   */
  async pickLine(
    waveId: string,
    lineId: string,
    dto: { qty_picked: number; status?: string; note?: string; bin_code?: string },
  ) {
    if (!UUID_RE.test(waveId) || !UUID_RE.test(lineId)) throw new BadRequestException('id inválido');
    const qty = Number(dto?.qty_picked);
    if (!Number.isFinite(qty) || qty < 0) throw new BadRequestException('qty_picked debe ser >= 0');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'cancelada') throw new ConflictException('La ola está cancelada');
      if (wave.status === 'surtida') throw new ConflictException('La ola ya se cerró');

      const line = await trx('commercial.wave_lines').where({ id: lineId, wave_id: waveId }).first();
      if (!line) throw new NotFoundException(`Renglón ${lineId} no encontrado en esta ola`);
      if (qty > Number(line.qty_requested))
        throw new BadRequestException(
          `No se puede levantar más de lo pedido (${line.qty_requested}). Si sobra mercancía, es un ajuste de inventario, no un surtido.`,
        );

      // El estado se DERIVA de la cantidad salvo que la persona declare una causa (agotado/dañado):
      // "levanté 0" y "levanté 0 porque estaba dañado" son hechos distintos.
      const declarado = String(dto?.status || '').trim();
      let status: string;
      if (declarado && ['agotado', 'danado', 'faltante', 'surtido'].includes(declarado)) {
        status = declarado;
      } else if (qty === 0) {
        status = 'agotado';
      } else if (qty < Number(line.qty_requested)) {
        status = 'faltante';
      } else {
        status = 'surtido';
      }

      const [upd] = await trx('commercial.wave_lines')
        .where({ id: lineId })
        .update({
          qty_picked: qty,
          status,
          note: dto?.note ?? line.note,
          bin_code: dto?.bin_code ?? line.bin_code,
          picked_by: userId,
          picked_at: trx.fn.now(),
        })
        .returning('*');
      return upd;
    });
  }

  /**
   * Cierra el surtido de la ola.
   *
   * ⚠️ Exige que TODOS los renglones se hayan tocado. Un renglón `pendiente` al cerrar no es "no
   * había": es **nadie pasó por ahí**, y esa diferencia es justamente la que se pierde si se deja
   * cerrar con pendientes (quedaría indistinguible de un agotado, y el pedido saldría corto sin
   * que nadie lo supiera).
   */
  async finishPicking(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'cancelada') throw new ConflictException('La ola está cancelada');
      if (wave.status === 'surtida') return wave; // idempotente

      const pend = await trx('commercial.wave_lines')
        .where({ wave_id: waveId, status: 'pendiente' })
        .count('* as n')
        .first();
      const sinTocar = Number(pend?.n ?? 0);
      if (sinTocar > 0)
        throw new ConflictException(
          `Faltan ${sinTocar} renglón(es) sin tocar. Marcá cada uno —aunque sea en 0— antes de cerrar: ` +
            'un renglón sin tocar no es lo mismo que uno agotado.',
        );

      const [upd] = await trx('commercial.picking_waves')
        .where({ id: waveId })
        .update({
          status: 'surtida',
          finished_at: trx.fn.now(),
          picked_by: wave.picked_by || userId,
          updated_at: trx.fn.now(),
          updated_by: userId,
        })
        .returning('*');

      // SU.6 — repartir lo levantado entre los pedidos, en la MISMA transacción: si el reparto
      // fallara después, la ola quedaría cerrada y nadie sabría a quién le toca qué.
      const reparto = await this.repartirYGuardar(trx, waveId);

      await trx('commercial.wave_orders').where({ wave_id: waveId }).update({
        stage: 'desconsolidado',
        updated_at: trx.fn.now(),
      });
      return { ...upd, reparto };
    });
  }

  /**
   * SU.6 — calcula el reparto con la función PURA (`allocation.ts`, probada por unidad) y lo
   * guarda. Acá sólo se leen filas y se escriben: la decisión de a quién se le queda corto el
   * pedido vive en la función, fuera de la base, para que se pueda probar sin ella.
   */
  private async repartirYGuardar(trx: any, waveId: string) {
    const lineas = await trx('commercial.wave_lines').where({ wave_id: waveId });
    if (!lineas.length) return [];

    // Lo que pidió cada pedido de cada producto, con lo que hace falta para ordenarlos.
    const pedidos = await trx('commercial.wave_orders as wo')
      .join('commercial.order_lines as ol', function (this: any) {
        this.on('ol.order_id', '=', 'wo.order_id').andOn('ol.tenant_id', '=', 'wo.tenant_id');
      })
      .join('commercial.orders as o', function (this: any) {
        this.on('o.id', '=', 'wo.order_id').andOn('o.tenant_id', '=', 'wo.tenant_id');
      })
      .where('wo.wave_id', waveId)
      .select(
        'ol.product_id',
        'wo.order_id',
        'o.code as order_code',
        'ol.quantity as qty_requested',
        'o.requested_delivery_date as delivery_date',
        'o.confirmed_at',
      );

    const porProducto = new Map<string, any[]>();
    for (const r of pedidos as any[]) {
      const arr = porProducto.get(r.product_id) ?? [];
      arr.push({
        order_id: r.order_id,
        order_code: r.order_code,
        qty_requested: Number(r.qty_requested),
        delivery_date: r.delivery_date ? String(r.delivery_date).slice(0, 10) : null,
        confirmed_at: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
      });
      porProducto.set(r.product_id, arr);
    }

    const ola = repartirOla(
      (lineas as any[]).map((l) => ({
        product_id: l.product_id,
        qty_picked: l.qty_picked == null ? null : Number(l.qty_picked),
        pedidos: porProducto.get(l.product_id) ?? [],
      })),
    );

    const filas: any[] = [];
    for (const r of ola) {
      for (const a of r.reparto) {
        filas.push({
          wave_id: waveId,
          order_id: a.order_id,
          product_id: r.product_id,
          qty_requested: a.qty_requested,
          qty_allocated: a.qty_allocated,
          rule_applied: a.regla,
        });
      }
    }
    if (filas.length) {
      // Idempotente: cerrar dos veces no duplica ni pisa con otro criterio.
      await trx('commercial.wave_allocations')
        .insert(filas)
        .onConflict(['tenant_id', 'wave_id', 'order_id', 'product_id'])
        .merge(['qty_requested', 'qty_allocated', 'rule_applied']);
    }
    return resumenPorPedido(ola);
  }

  /** Lo que le toca a cada pedido de la ola (la hoja con la que se separa la mercancía). */
  async allocations(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    return this.tk.run(async (trx) => {
      const filas = await trx('commercial.wave_allocations as wa')
        .join('commercial.orders as o', function (this: any) {
          this.on('o.id', '=', 'wa.order_id').andOn('o.tenant_id', '=', 'wa.tenant_id');
        })
        .leftJoin('commercial.customers as c', function (this: any) {
          this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
        })
        .leftJoin('catalog.products as p', function (this: any) {
          this.on('p.id', '=', 'wa.product_id').andOn('p.tenant_id', '=', 'wa.tenant_id');
        })
        .leftJoin('commercial.wave_orders as wo', function (this: any) {
          this.on('wo.wave_id', '=', 'wa.wave_id')
            .andOn('wo.order_id', '=', 'wa.order_id')
            .andOn('wo.tenant_id', '=', 'wa.tenant_id');
        })
        .where('wa.wave_id', waveId)
        .select(
          'wa.*',
          'o.code as order_code',
          'c.name as customer_name',
          'p.nombre as product_name',
          'p.sku',
          'wo.stage',
        )
        .orderBy(['o.code', 'p.nombre']);

      // Agrupado por pedido: así es como se separa físicamente (una caja por cliente).
      const porPedido = new Map<string, any>();
      for (const f of filas as any[]) {
        let g = porPedido.get(f.order_id);
        if (!g) {
          g = {
            order_id: f.order_id,
            order_code: f.order_code,
            customer_name: f.customer_name,
            stage: f.stage,
            completo: true,
            items: [] as any[],
          };
          porPedido.set(f.order_id, g);
        }
        if (Number(f.qty_allocated) < Number(f.qty_requested)) g.completo = false;
        g.items.push({
          product_id: f.product_id,
          product_name: f.product_name,
          sku: f.sku,
          qty_requested: Number(f.qty_requested),
          qty_allocated: Number(f.qty_allocated),
          rule_applied: f.rule_applied,
        });
      }
      return Array.from(porPedido.values());
    });
  }

  /**
   * SU.7 — re-verificación de UN pedido: lo separado contra lo físico.
   *
   * ⚠️ Se llama **re-verificación** y no "chequeo": con una sola persona (decisión de Edgar) no es
   * un control cruzado, y decirle control a algo que no lo es sería peor que no tenerlo. Se guarda
   * `verified_by` aparte de `picked_by` para poder MEDIR en qué proporción coinciden — el día que
   * sean dos personas, el gate se enciende sin migrar nada.
   */
  async verifyOrder(waveId: string, orderId: string) {
    if (!UUID_RE.test(waveId) || !UUID_RE.test(orderId))
      throw new BadRequestException('id inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status !== 'surtida')
        throw new ConflictException(
          `Sólo se verifica una ola ya surtida (está en '${wave.status}'). Terminá el recorrido primero.`,
        );

      const wo = await trx('commercial.wave_orders')
        .where({ wave_id: waveId, order_id: orderId })
        .first();
      if (!wo) throw new NotFoundException('Ese pedido no está en esta ola');
      if (wo.stage === 'listo_embarque') return wo; // idempotente

      const [upd] = await trx('commercial.wave_orders')
        .where({ id: wo.id })
        .update({
          stage: 'listo_embarque',
          verified_by: userId,
          verified_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      return upd;
    });
  }

  /** Renglones de la ola con su avance (lo que ve la persona mientras recorre). */
  private async lineasDe(trx: any, waveId: string) {
    return trx('commercial.wave_lines as wl')
      .leftJoin('catalog.products as p', function (this: any) {
        this.on('p.id', '=', 'wl.product_id').andOn('p.tenant_id', '=', 'wl.tenant_id');
      })
      .where('wl.wave_id', waveId)
      .select('wl.*', 'p.nombre as product_name', 'p.sku')
      .orderByRaw(
        // Lo pendiente primero (es lo que falta caminar); dentro, por ubicación y nombre.
        `CASE WHEN wl.status = 'pendiente' THEN 0 ELSE 1 END, wl.bin_code NULLS LAST, p.nombre`,
      );
  }

  /** Renglones de la ola (público, para la pantalla). */
  async lines(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    return this.tk.run(async (trx) => this.lineasDe(trx, waveId));
  }

  /** Folio `W-YYYY-NNNNN`, con el mismo UPSERT atómico de `commercial.order_sequences`. */
  private async nextCode(trx: any): Promise<string> {
    const tenantId = this.tenantCtx.requireTenantId();
    const year = new Date().getFullYear();
    const [{ current_value }] = await trx
      .raw(
        `INSERT INTO commercial.wave_sequences (tenant_id, year, current_value)
         VALUES (?, ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.wave_sequences.current_value + 1,
               updated_at = now()
         RETURNING current_value`,
        [tenantId, year],
      )
      .then((r: any) => r.rows);
    return `W-${year}-${String(current_value).padStart(5, '0')}`;
  }
}
