import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase I — Inventario físico (conteo cíclico/total por almacén).
 *
 * Modela el proceso "hacer inventario" como sesión digital con conteo CIEGO,
 * doble conteo por contadores distintos y reconciliación auditable.
 *
 * Jerarquía (permisos):
 *   contador     (CONTAR)      → cuenta a ciegas; nunca ve el teórico ni la varianza.
 *   supervisor   (SUPERVISAR)  → abre folio, analiza avance, resuelve discrepancias.
 *   reconciliador(RECONCILIAR) → autoriza el ajuste del saldo (mueve dinero) y cierra.
 *
 * Controles embebidos:
 *   - Conteo ciego: submitCount NUNCA devuelve expected_qty.
 *   - Segregación de funciones: count_2 lo hace un usuario != count_1; el
 *     reconciliador no puede ser quien contó ningún item del folio.
 *   - Coverage guard: no se reconcilia si hay SKUs sin ningún conteo
 *     (un "no contado" jamás se trata como cero → no se destruye stock real).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpenCountDto {
  warehouse_id: string;
  type?: 'full' | 'cycle';
  freeze_movements?: boolean;
  blind_double_count?: boolean;
  notes?: string;
}

export interface SubmitCountDto {
  product_id?: string;
  barcode?: string;
  quantity: number;
  /** Forzar tercer conteo (reconteo ordenado por supervisor). */
  recount?: boolean;
}

export interface ResolveItemDto {
  final_qty: number;
  notes?: string;
}

@Injectable()
export class InventoryCountService {
  private readonly logger = new Logger(InventoryCountService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private userId(): string | null {
    return this.tenantCtx.get()?.userId || null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Apertura: snapshot del teórico + folio. (SUPERVISAR)
  // ─────────────────────────────────────────────────────────────────────────
  async openCount(dto: OpenCountDto) {
    if (!UUID.test(dto.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    const type = dto.type || 'full';
    const freeze = dto.freeze_movements !== false; // default true
    const blind = dto.blind_double_count !== false; // default true

    return this.tk.run(async (trx) => {
      const uid = this.userId();

      const wh = await trx('commercial.warehouses')
        .where({ id: dto.warehouse_id })
        .first();
      if (!wh) throw new NotFoundException('Almacén no encontrado');

      // El índice parcial único bloquea dos folios abiertos por almacén, pero
      // damos un error claro antes de tocar el insert.
      const openExisting = await trx('commercial.inventory_counts')
        .where({ warehouse_id: dto.warehouse_id })
        .whereIn('status', ['open', 'counting', 'review', 'ready_to_reconcile'])
        .first();
      if (openExisting)
        throw new ConflictException(
          `Ya existe un folio de inventario abierto para este almacén (${openExisting.folio}). Ciérralo o cancélalo primero.`,
        );

      const folio = await this.nextFolio(trx);

      const [count] = await trx('commercial.inventory_counts')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: dto.warehouse_id,
          folio,
          type,
          status: 'counting',
          freeze_movements: freeze,
          blind_double_count: blind,
          notes: dto.notes || null,
          started_at: trx.fn.now(),
          created_by: uid,
          updated_by: uid,
        })
        .returning('*');

      // Snapshot del teórico: una fila por SKU con saldo en el almacén.
      // expected_qty = commercial.stock.quantity AL MOMENTO de abrir.
      const snapInserted = await trx.raw(
        `INSERT INTO commercial.inventory_count_items
           (tenant_id, count_id, product_id, location, expected_qty, status)
         SELECT s.tenant_id, ?, s.product_id, p.location, s.quantity, 'pending'
           FROM commercial.stock s
           LEFT JOIN public.products p ON p.id = s.product_id
          WHERE s.warehouse_id = ?
            AND s.tenant_id = public.current_tenant_id()`,
        [count.id, dto.warehouse_id],
      );

      const expectedItems = snapInserted.rowCount ?? 0;
      this.logger.log(
        `Folio ${folio} abierto para almacén ${wh.code} con ${expectedItems} SKUs snapshot (freeze=${freeze}, blind=${blind}).`,
      );

      return {
        id: count.id,
        folio,
        warehouse_id: dto.warehouse_id,
        warehouse_code: wh.code,
        status: count.status,
        type,
        freeze_movements: freeze,
        blind_double_count: blind,
        expected_items: expectedItems,
      };
    });
  }

  private async nextFolio(trx: any): Promise<string> {
    const year = new Date().getFullYear();
    const [{ current_value }] = await trx.raw(
      `INSERT INTO commercial.inventory_count_sequences (tenant_id, year, current_value)
       VALUES (public.current_tenant_id(), ?, 1)
       ON CONFLICT (tenant_id, year) DO UPDATE
         SET current_value = inventory_count_sequences.current_value + 1,
             updated_at = now()
       RETURNING current_value`,
      [year],
    ).then((r: any) => r.rows);
    return `INV-${year}-${String(current_value).padStart(5, '0')}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Conteo CIEGO. (CONTAR) — nunca devuelve expected_qty.
  // ─────────────────────────────────────────────────────────────────────────
  async submitCount(countId: string, dto: SubmitCountDto) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    if (typeof dto.quantity !== 'number' || dto.quantity < 0)
      throw new BadRequestException('quantity debe ser número >= 0');
    if (!dto.product_id && !dto.barcode)
      throw new BadRequestException('Se requiere product_id o barcode');

    return this.tk.run(async (trx) => {
      const uid = this.userId();

      const count = await trx('commercial.inventory_counts')
        .where({ id: countId })
        .first();
      if (!count) throw new NotFoundException('Folio no encontrado');
      if (count.status !== 'counting' && count.status !== 'review')
        throw new ConflictException(
          `El folio está en estado '${count.status}'; no admite conteos.`,
        );

      // Opt-in (Fase I.4): si el folio tiene contadores asignados, solo ellos cuentan.
      const counters = await trx('commercial.inventory_count_assignments')
        .where({ count_id: countId, assignment_role: 'counter' })
        .select('user_id');
      if (counters.length && !counters.some((a) => a.user_id === uid)) {
        throw new ForbiddenException(
          'No estás asignado como contador de este folio.',
        );
      }

      // Resolver producto (por id o barcode).
      let productId = dto.product_id;
      let location: string | null = null;
      if (!productId && dto.barcode) {
        const prod = await trx('public.products')
          .where({ barcode: dto.barcode })
          .first();
        if (!prod)
          throw new NotFoundException(
            `Sin producto para el código de barras '${dto.barcode}'`,
          );
        productId = prod.id;
        location = prod.location || null;
      }
      if (!UUID.test(productId!))
        throw new BadRequestException('product_id inválido');

      // Lock del item (o crear si es un SOBRANTE no esperado en el snapshot).
      let item = await trx('commercial.inventory_count_items')
        .where({ count_id: countId, product_id: productId })
        .forUpdate()
        .first();

      if (!item) {
        const prod = await trx('public.products').where({ id: productId }).first();
        if (!prod) throw new NotFoundException('Producto no encontrado');
        [item] = await trx('commercial.inventory_count_items')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            count_id: countId,
            product_id: productId,
            location: location ?? prod.location ?? null,
            expected_qty: 0, // sobrante: no estaba en el teórico
            status: 'pending',
            updated_by: uid,
          })
          .returning('*');
      }

      // Selección de slot + segregación de funciones en el doble conteo.
      const patch: Record<string, any> = { updated_at: trx.fn.now(), updated_by: uid };
      let slot: string;
      if (dto.recount || (item.count_1 != null && item.count_2 != null)) {
        slot = 'count_3';
        patch.count_3 = dto.quantity;
        patch.counted_by_3 = uid;
        patch.counted_at_3 = trx.fn.now();
      } else if (item.count_1 == null) {
        slot = 'count_1';
        patch.count_1 = dto.quantity;
        patch.counted_by_1 = uid;
        patch.counted_at_1 = trx.fn.now();
      } else if (item.count_2 == null && uid && item.counted_by_1 === uid) {
        // El MISMO contador re-escanea su propio count_1 → corrección (overwrite),
        // no segundo conteo. El doble conteo ciego lo dispara un contador DISTINTO.
        slot = 'count_1';
        patch.count_1 = dto.quantity;
        patch.counted_at_1 = trx.fn.now();
      } else {
        // Segundo conteo: contador distinto (conteo ciego válido).
        slot = 'count_2';
        patch.count_2 = dto.quantity;
        patch.counted_by_2 = uid;
        patch.counted_at_2 = trx.fn.now();
      }

      patch.status = 'counted';
      await trx('commercial.inventory_count_items')
        .where({ id: item.id })
        .update(patch);

      // Identificación del SKU (nombre/sku/location) para que el contador
      // confirme qué escaneó — NO es dato ciego (el teórico/varianza sí se ocultan).
      const prodInfo = await trx('public.products')
        .where({ id: productId })
        .select('sku', 'nombre', 'location')
        .first();

      // Respuesta CIEGA: ni expected_qty ni varianza.
      return {
        ok: true,
        item_id: item.id,
        slot,
        product_id: productId,
        sku: prodInfo?.sku ?? null,
        product_name: prodInfo?.nombre ?? null,
        location: prodInfo?.location ?? null,
        quantity: dto.quantity,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Cómputo de discrepancias + paso a 'review'. (SUPERVISAR)
  // ─────────────────────────────────────────────────────────────────────────
  async computeDiscrepancies(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');

    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      const items = await trx('commercial.inventory_count_items')
        .where({ count_id: countId })
        .select('*');

      let discrepancies = 0;
      let resolved = 0;
      for (const it of items) {
        const c1 = it.count_1 != null ? Number(it.count_1) : null;
        const c2 = it.count_2 != null ? Number(it.count_2) : null;
        const c3 = it.count_3 != null ? Number(it.count_3) : null;
        if (c1 == null) continue; // sin contar — lo atrapa el coverage guard

        let finalQty: number | null = null;
        let status = 'counted';

        if (count.blind_double_count) {
          if (c2 == null) {
            // falta segundo conteo
            status = 'counted';
          } else if (c1 === c2) {
            finalQty = c1;
          } else if (c3 != null && (c3 === c1 || c3 === c2)) {
            finalQty = c3; // el tercero rompe el empate
          } else {
            status = 'discrepancy';
            discrepancies++;
          }
        } else {
          finalQty = c1;
        }

        if (finalQty != null) {
          const variance = +(finalQty - Number(it.expected_qty)).toFixed(3);
          status = 'resolved';
          resolved++;
          await trx('commercial.inventory_count_items')
            .where({ id: it.id })
            .update({ final_qty: finalQty, variance, status, updated_at: trx.fn.now() });
        } else if (status === 'discrepancy') {
          await trx('commercial.inventory_count_items')
            .where({ id: it.id })
            .update({ status, updated_at: trx.fn.now() });
        }
      }

      await trx('commercial.inventory_counts')
        .where({ id: countId })
        .update({ status: 'review', updated_at: trx.fn.now(), updated_by: this.userId() });

      return { status: 'review', resolved, discrepancies };
    });
  }

  // Resolución manual de un item (supervisor decide el valor final). (SUPERVISAR)
  async resolveItem(countId: string, itemId: string, dto: ResolveItemDto) {
    if (!UUID.test(countId) || !UUID.test(itemId))
      throw new BadRequestException('id inválido');
    if (typeof dto.final_qty !== 'number' || dto.final_qty < 0)
      throw new BadRequestException('final_qty debe ser >= 0');

    return this.tk.run(async (trx) => {
      const item = await trx('commercial.inventory_count_items')
        .where({ id: itemId, count_id: countId })
        .first();
      if (!item) throw new NotFoundException('Item no encontrado');
      const variance = +(dto.final_qty - Number(item.expected_qty)).toFixed(3);
      await trx('commercial.inventory_count_items')
        .where({ id: itemId })
        .update({
          final_qty: dto.final_qty,
          variance,
          status: 'resolved',
          notes: dto.notes || item.notes,
          updated_at: trx.fn.now(),
          updated_by: this.userId(),
        });
      return { ok: true, item_id: itemId, final_qty: dto.final_qty, variance };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Tablero del supervisor: avance, discrepancias, valor en riesgo. (SUPERVISAR)
  // ─────────────────────────────────────────────────────────────────────────
  async getProgress(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');

    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);

      const [agg] = await trx('commercial.inventory_count_items as i')
        .leftJoin('public.products as p', 'p.id', 'i.product_id')
        .where('i.count_id', countId)
        .select(
          trx.raw('COUNT(*)::int AS total'),
          trx.raw(`COUNT(*) FILTER (WHERE i.count_1 IS NOT NULL)::int AS counted_once`),
          trx.raw(`COUNT(*) FILTER (WHERE i.count_1 IS NULL)::int AS uncounted`),
          trx.raw(`COUNT(*) FILTER (WHERE i.status = 'discrepancy')::int AS discrepancies`),
          trx.raw(`COUNT(*) FILTER (WHERE i.status = 'resolved')::int AS resolved`),
          trx.raw(
            `COALESCE(SUM(ABS(COALESCE(i.variance,0)) * COALESCE(p.cost_base,0)) FILTER (WHERE i.status='resolved'), 0)::numeric AS value_at_variance`,
          ),
        );

      // Productividad por contador (count_1).
      const byCounter = await trx('commercial.inventory_count_items')
        .where({ count_id: countId })
        .whereNotNull('counted_by_1')
        .groupBy('counted_by_1')
        .select(
          'counted_by_1 as user_id',
          trx.raw('COUNT(*)::int AS counts'),
          trx.raw(`COUNT(*) FILTER (WHERE status='discrepancy')::int AS discrepancies`),
        );

      const total = Number(agg.total) || 0;
      const counted = Number(agg.counted_once) || 0;
      return {
        folio: count.folio,
        status: count.status,
        coverage_pct: total ? +((counted / total) * 100).toFixed(1) : 0,
        ...agg,
        by_counter: byCounter,
      };
    });
  }

  // Progreso CIEGO para el contador: avance sin teórico ni varianza. (CONTAR)
  async counterProgress(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      const uid = this.userId();
      const [agg] = await trx('commercial.inventory_count_items')
        .where({ count_id: countId })
        .select(
          trx.raw('COUNT(*)::int AS total'),
          trx.raw('COUNT(*) FILTER (WHERE count_1 IS NOT NULL)::int AS counted'),
          trx.raw('COUNT(*) FILTER (WHERE count_1 IS NULL)::int AS remaining'),
          trx.raw(`COUNT(*) FILTER (WHERE counted_by_1 = ? OR counted_by_2 = ? OR counted_by_3 = ?)::int AS mine`, [uid, uid, uid]),
        );
      return { folio: count.folio, status: count.status, ...agg };
    });
  }

  // Lista de items con teórico + varianza (NO la usa el contador). (SUPERVISAR/VER)
  async listItems(countId: string, status?: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      await this.getCountOrThrow(trx, countId);
      let q = trx('commercial.inventory_count_items as i')
        .leftJoin('public.products as p', 'p.id', 'i.product_id')
        .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
        .where('i.count_id', countId);
      if (status) q = q.where('i.status', status);
      return q
        .select(
          'i.id',
          'i.product_id',
          'p.sku',
          'p.nombre as product_name',
          'b.nombre as brand_name',
          'i.location',
          'i.expected_qty',
          'i.count_1',
          'i.count_2',
          'i.count_3',
          'i.final_qty',
          'i.variance',
          'i.status',
          'i.notes',
          'p.cost_base',
        )
        .orderByRaw(`CASE i.status WHEN 'discrepancy' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END`)
        .orderBy('p.nombre', 'asc')
        .limit(2000);
    });
  }

  async listCounts(warehouseId?: string) {
    return this.tk.run(async (trx) => {
      let q = trx('commercial.inventory_counts as c')
        .leftJoin('commercial.warehouses as w', 'w.id', 'c.warehouse_id');
      if (warehouseId) q = q.where('c.warehouse_id', warehouseId);
      return q
        .select(
          'c.id',
          'c.folio',
          'c.warehouse_id',
          'w.code as warehouse_code',
          'w.name as warehouse_name',
          'c.type',
          'c.status',
          'c.freeze_movements',
          'c.started_at',
          'c.closed_at',
          'c.created_at',
        )
        .orderBy('c.created_at', 'desc')
        .limit(200);
    });
  }

  // ───── Asignaciones de personas al folio (Fase I.4) ─────

  /** Usuarios asignables como contador (CONTAR) o supervisor (SUPERVISAR). */
  async assignableUsers(role: 'counter' | 'supervisor') {
    const perm = role === 'supervisor'
      ? 'COMMERCIAL_INVENTORY_SUPERVISAR'
      : 'COMMERCIAL_INVENTORY_CONTAR';
    return this.tk.run(async (trx) => {
      return trx('identity.users as u')
        .join('public.role_permissions as rp', function () {
          this.on('rp.role_name', '=', 'u.role_name').andOn('rp.tenant_id', '=', 'u.tenant_id');
        })
        .where('u.activo', true)
        .whereRaw(`(rp.permissions ->> ?)::bool = true`, [perm])
        .select('u.id', 'u.username', 'u.nombre', 'u.role_name')
        .orderBy('u.nombre', 'asc');
    });
  }

  async listAssignments(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      await this.getCountOrThrow(trx, countId);
      return trx('commercial.inventory_count_assignments as a')
        .leftJoin('identity.users as u', 'u.id', 'a.user_id')
        .where('a.count_id', countId)
        .select('a.user_id', 'a.assignment_role', 'u.username', 'u.nombre');
    });
  }

  /** Reemplaza la lista de asignados de un rol en el folio. (ASIGNAR) */
  async setAssignments(countId: string, role: 'counter' | 'supervisor', userIds: string[]) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    if (role !== 'counter' && role !== 'supervisor')
      throw new BadRequestException('role inválido');
    const ids = (userIds || []).filter((id) => UUID.test(id));
    return this.tk.run(async (trx) => {
      const count = await this.getCountOrThrow(trx, countId);
      if (count.status === 'reconciled' || count.status === 'cancelled')
        throw new ConflictException('El folio ya está cerrado.');
      const uid = this.userId();
      await trx('commercial.inventory_count_assignments')
        .where({ count_id: countId, assignment_role: role })
        .del();
      if (ids.length) {
        await trx('commercial.inventory_count_assignments').insert(
          ids.map((userId) => ({
            tenant_id: trx.raw('public.current_tenant_id()'),
            count_id: countId,
            user_id: userId,
            assignment_role: role,
            assigned_by: uid,
          })),
        );
      }
      return { ok: true, role, count: ids.length };
    });
  }

  /** Folios que puede contar el usuario actual: asignado como contador, o
   *  folios sin contadores asignados (modo abierto). (CONTAR) */
  async myCountingFolios() {
    return this.tk.run(async (trx) => {
      const uid = this.userId();
      return trx('commercial.inventory_counts as c')
        .leftJoin('commercial.warehouses as w', 'w.id', 'c.warehouse_id')
        .whereIn('c.status', ['counting', 'review'])
        .andWhere(function () {
          this.whereExists(function () {
            this.select(trx.raw('1'))
              .from('commercial.inventory_count_assignments as a')
              .whereRaw('a.count_id = c.id AND a.assignment_role = ? AND a.user_id = ?', ['counter', uid]);
          }).orWhereNotExists(function () {
            this.select(trx.raw('1'))
              .from('commercial.inventory_count_assignments as a2')
              .whereRaw(`a2.count_id = c.id AND a2.assignment_role = 'counter'`);
          });
        })
        .select('c.id', 'c.folio', 'c.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name', 'c.type', 'c.status')
        .orderBy('c.created_at', 'desc')
        .limit(100);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reconciliación: ajusta stock al físico + genera movimientos. (RECONCILIAR)
  // ─────────────────────────────────────────────────────────────────────────
  async reconcile(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');

    return this.tk.run(async (trx) => {
      const uid = this.userId();
      const count = await trx('commercial.inventory_counts')
        .where({ id: countId })
        .forUpdate()
        .first();
      if (!count) throw new NotFoundException('Folio no encontrado');
      if (count.status === 'reconciled')
        throw new ConflictException('El folio ya fue reconciliado.');
      if (count.status === 'cancelled')
        throw new ConflictException('El folio fue cancelado.');

      const items = await trx('commercial.inventory_count_items')
        .where({ count_id: countId })
        .select('*');

      // ── COVERAGE GUARD: ningún "no contado" puede pasar como cero ──
      const uncounted = items.filter((it) => it.count_1 == null);
      if (uncounted.length)
        throw new ConflictException(
          `No se puede reconciliar: ${uncounted.length} SKU(s) sin ningún conteo. Cuéntalos o cancela el folio (un no-contado NO se trata como cero).`,
        );
      const pendingDiscrepancies = items.filter((it) => it.status === 'discrepancy');
      if (pendingDiscrepancies.length)
        throw new ConflictException(
          `No se puede reconciliar: ${pendingDiscrepancies.length} discrepancia(s) sin resolver.`,
        );
      const unresolved = items.filter((it) => it.final_qty == null);
      if (unresolved.length)
        throw new ConflictException(
          `No se puede reconciliar: ${unresolved.length} item(s) sin valor final. Corré "calcular discrepancias" o resolvelos.`,
        );

      // ── SEGREGACIÓN DE FUNCIONES: el reconciliador no puede ser quien contó ──
      const counters = new Set<string>();
      items.forEach((it) => {
        [it.counted_by_1, it.counted_by_2, it.counted_by_3].forEach(
          (c) => c && counters.add(c),
        );
      });
      if (uid && counters.has(uid))
        throw new ForbiddenException(
          'Segregación de funciones: quien participó en el conteo no puede autorizar la reconciliación.',
        );

      // ── Aplicar ajustes en la MISMA transacción ──
      let adjusted = 0;
      let totalDelta = 0;
      const skippedReserved: string[] = [];

      for (const it of items) {
        const finalQty = Number(it.final_qty);
        const expected = Number(it.expected_qty);
        const delta = +(finalQty - expected).toFixed(3);
        if (delta === 0) continue;

        const stockRow = await trx('commercial.stock')
          .where({ warehouse_id: count.warehouse_id, product_id: it.product_id })
          .forUpdate()
          .first();

        const qtyBefore = stockRow ? Number(stockRow.quantity) : 0;
        const reservedBefore = stockRow ? Number(stockRow.reserved_quantity) : 0;

        // El físico no puede quedar por debajo de lo reservado (viola CHECK
        // quantity >= reserved). Lo dejamos pendiente para revisión manual.
        if (finalQty < reservedBefore) {
          skippedReserved.push(it.product_id);
          await trx('commercial.inventory_count_items')
            .where({ id: it.id })
            .update({
              status: 'discrepancy',
              notes: `Físico ${finalQty} < reservado ${reservedBefore}; ajuste bloqueado, requiere liberar reservas.`,
              updated_at: trx.fn.now(),
            });
          continue;
        }

        if (stockRow) {
          await trx('commercial.stock')
            .where({ id: stockRow.id })
            .update({ quantity: finalQty, updated_at: trx.fn.now(), updated_by: uid });
        } else {
          await trx('commercial.stock').insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            warehouse_id: count.warehouse_id,
            product_id: it.product_id,
            quantity: finalQty,
            reserved_quantity: 0,
            updated_by: uid,
          });
        }

        await trx('commercial.stock_movements').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: count.warehouse_id,
          product_id: it.product_id,
          movement_type: 'adjust',
          quantity: Math.abs(delta),
          quantity_before: qtyBefore,
          quantity_after: finalQty,
          reference_type: 'inventory_count',
          reference_id: countId,
          notes: `Inventario físico ${count.folio}. ${it.notes || ''}`.trim(),
          created_by: uid,
        });
        adjusted++;
        totalDelta = +(totalDelta + delta).toFixed(3);
      }

      if (skippedReserved.length)
        throw new ConflictException(
          `${skippedReserved.length} SKU(s) con físico < reservado: libera las reservas (pedidos) antes de reconciliar. El folio queda en review.`,
        );

      await trx('commercial.inventory_counts')
        .where({ id: countId })
        .update({
          status: 'reconciled',
          reconciled_at: trx.fn.now(),
          reconciled_by: uid,
          closed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
          updated_by: uid,
        });

      this.logger.log(
        `Folio ${count.folio} reconciliado: ${adjusted} ajustes, delta neto ${totalDelta}.`,
      );
      return {
        status: 'reconciled',
        folio: count.folio,
        items_adjusted: adjusted,
        net_delta: totalDelta,
      };
    });
  }

  async cancel(countId: string, reason?: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      const count = await trx('commercial.inventory_counts')
        .where({ id: countId })
        .first();
      if (!count) throw new NotFoundException('Folio no encontrado');
      if (count.status === 'reconciled')
        throw new ConflictException('No se puede cancelar un folio reconciliado.');
      await trx('commercial.inventory_counts')
        .where({ id: countId })
        .update({
          status: 'cancelled',
          closed_at: trx.fn.now(),
          notes: reason ? `Cancelado: ${reason}. ${count.notes || ''}`.trim() : count.notes,
          updated_at: trx.fn.now(),
          updated_by: this.userId(),
        });
      return { status: 'cancelled', folio: count.folio };
    });
  }

  /**
   * Export del ajuste de un folio reconciliado al formato del ERP Kepler.
   *
   * Mapea las varianzas a documentos de inventario Kepler:
   *   variance < 0 (merma)    → InvOut (nature N, dirección D)
   *   variance > 0 (sobrante) → InvIn  (nature N, dirección A)
   * (alternativamente un único PhysInv con la cantidad contada).
   *
   * NO escribe en Kepler (es el ERP de producción; estructura kdm1 de 200 cols,
   * folio/sequencing/triggers propios). Devuelve el documento para importar o
   * capturar en Kepler. La sucursal sale del código del almacén (KEPLER-NN → NN).
   */
  async keplerAdjustmentExport(countId: string) {
    if (!UUID.test(countId)) throw new BadRequestException('count_id inválido');
    return this.tk.run(async (trx) => {
      const count = await trx('commercial.inventory_counts as c')
        .leftJoin('commercial.warehouses as w', 'w.id', 'c.warehouse_id')
        .where('c.id', countId)
        .select('c.*', 'w.code as warehouse_code')
        .first();
      if (!count) throw new NotFoundException('Folio no encontrado');
      if (count.status !== 'reconciled')
        throw new ConflictException('Solo se exporta un folio reconciliado.');

      const m = /^KEPLER-(\w+)$/i.exec(count.warehouse_code || '');
      const branch = m ? m[1] : null;

      const items = await trx('commercial.inventory_count_items as i')
        .leftJoin('public.products as p', 'p.id', 'i.product_id')
        .where('i.count_id', countId)
        .whereRaw('COALESCE(i.variance, 0) <> 0')
        .select('p.sku', 'p.nombre as product_name', 'p.unit_sale', 'p.cost_base',
          'i.expected_qty', 'i.final_qty', 'i.variance');

      let mermaValue = 0, sobranteValue = 0;
      const lines = items.map((it: any) => {
        const variance = Number(it.variance);
        const cost = Number(it.cost_base) || 0;
        const value = +(Math.abs(variance) * cost).toFixed(2);
        if (variance < 0) mermaValue += value; else sobranteValue += value;
        return {
          sku: it.sku,
          product_name: it.product_name,
          unit: it.unit_sale || 'PZA',
          counted_qty: Number(it.final_qty),
          expected_qty: Number(it.expected_qty),
          variance,
          kepler_doc: variance < 0 ? 'InvOut' : 'InvIn',
          adjust_qty: Math.abs(variance),
          unit_cost: cost,
          line_value: value,
        };
      });

      return {
        folio: count.folio,
        kepler_branch: branch,
        warehouse_code: count.warehouse_code,
        date: count.reconciled_at,
        doc_type_hint: 'PhysInv (Physical inventory) / InvIn+InvOut',
        lines,
        summary: {
          total_lines: lines.length,
          merma_value: +mermaValue.toFixed(2),
          sobrante_value: +sobranteValue.toFixed(2),
          net_value: +(sobranteValue - mermaValue).toFixed(2),
        },
        note: 'Para importar/capturar en Kepler. No se escribe en el ERP automáticamente.',
      };
    });
  }

  private async getCountOrThrow(trx: any, countId: string) {
    const count = await trx('commercial.inventory_counts')
      .where({ id: countId })
      .first();
    if (!count) throw new NotFoundException('Folio no encontrado');
    return count;
  }
}
