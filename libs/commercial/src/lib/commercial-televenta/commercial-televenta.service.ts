import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService } from '@megadulces/platform-core';

/**
 * Fase E — Telemarketing (antes "Remote Manager" / "Televenta"; el ERP y el rol de prod lo
 * llaman telemarketing, canal TELEMARK).
 *
 * Pool autoservicio: operadores ven cola priorizada de clientes, toman un
 * lead (reserva TTL), trabajan al cliente (snapshot + pedido + log llamada),
 * y lo liberan al terminar. Cron limpia reservas expiradas.
 */

const RESERVATION_TTL_MIN = 30;

type QueueReason =
  | 'inactive_critical' // sin pedido >60 días
  | 'inactive_normal'   // sin pedido 30-60 días
  | 'never_ordered'     // customer nuevo sin orders
  | 'callback_due'      // callback programado vence hoy
  | 'general';          // resto del pool

export interface QueueItem {
  customer_id: string;
  code: string;
  name: string;
  phone: string | null;
  email: string | null;
  reason: QueueReason;
  last_order_at: string | null;
  last_call_at: string | null;
  callback_due_at: string | null;
  days_since_last_order: number | null;
  total_orders: number;
}

/** Resultado de `trx.raw` en Postgres: el driver entrega las filas sin tipo. */
interface RawResult {
  rows: Array<Record<string, unknown>>;
}

/** E.4 — la actividad de llamadas del tablero (`commercial.call_logs`). */
export interface TeleventaActividad {
  period: { from: string; to: string };
  today: {
    calls: number; orders_taken: number; no_answer: number;
    callbacks: number; not_interested: number; total_minutes: number;
  };
  my_stats: { my_calls: number; my_orders: number; my_minutes: number } | null;
  active_reservations: { total: number; unique_operators: number };
  conversion_7d: { total_calls: number; orders_taken: number; conversion_pct: number };
  top_operators: unknown[];
  outcomes_7d: unknown[];
  /** `registrada:false` ⇒ nadie ha capturado llamadas: no hay actividad que medir. */
  actividad: { registrada: boolean; nota: string };
}

/** E.9 — la facturación del canal en el tablero (`analytics.erp_sales_invoices`). */
export interface TelemarketingBilling {
  hoy: { facturas: number; importe: number };
  mes: { facturas: number; importe: number };
  d30: {
    facturas: number; importe: number; clientes: number;
    saldo: number; saldo_vencido: number; facturas_vencidas: number;
  };
  cartera_vencida: { saldo: number; facturas: number };
  clientes_en_cola: number;
  ultima_factura: Date | string | null;
  por_operador: Array<Record<string, unknown>>;
  ultimas: Array<Record<string, unknown>>;
  descuentos: DescuentosTelemarketing;
  atribucion: 'erp_vendedor_code';
}

/**
 * `[E.15]` La cascada del descuento del canal en 30 días, con la regla de la Fase TK (TK.13):
 *
 *     lista − producto = subtotal − cliente = facturado
 *
 *   · `producto` = Σ (precio de lista del renglón `kdm2.c66` − cobrado `c12`) × cantidad, nunca
 *     negativo y sólo donde la lista existe (`c66 > 0`).
 *   · `cliente`  = Σ importe de renglones − total del documento: el % negociado del cliente.
 *     ⛔ NO `kdm1.c13`, que viaja sin impuesto y subdeclara (ERP_KEPLER §2.6).
 *
 * Cierra exacto por construcción sobre las facturas CON renglones. Las que la réplica trajo sin
 * renglones todavía (la cabecera llega antes que el detalle) quedan fuera y se declaran.
 */
export interface DescuentosTelemarketing {
  facturas: number;
  facturas_sin_renglones: number;
  total_sin_renglones: number;
  renglones: number;
  /** Renglones donde el ERP no guarda precio de lista: ahí el descuento de producto es un piso. */
  renglones_sin_lista: number;
  lista: number;
  producto: number;
  subtotal: number;
  cliente: number;
  facturado: number;
  /**
   * Contra el maestro de clientes de HOY (`kdud.c17`, por sucursal + cliente): facturas que
   * salieron con MENOS % del negociado, y el monto que el cliente no se ahorró.
   */
  negociado_no_aplicado: { facturas: number; monto: number };
  /** Facturas con MÁS % del que el maestro registra hoy, y el monto de esa diferencia. */
  sin_respaldo_maestro: { facturas: number; monto: number };
}

const NUM = (col: string): string => `round(coalesce(nullif(regexp_replace(${col}::text, '[^0-9.-]', '', 'g'), '')::numeric, 0), 2)`;

/**
 * Una fila por (operador, % del maestro, % del documento). Los renglones se leen de `kdm2` por
 * factura con `ix_kdm2_venta_doc` (LATERAL): medido en prod el 2026-10-21, 150–345 ms. El join
 * en bloque contra `kdm2` (o contra `analytics.erp_sales_invoice_lines`) tardaba 46 s y más.
 * La llave del renglón incluye la serie (`c5`): sin ella se pegan renglones de documentos
 * homónimos de otra serie (VEC.7).
 */
const SQL_DESCUENTOS_TELEMARKETING_30D = `
  WITH f AS MATERIALIZED (
    SELECT sucursal, doc_prefix, folio, total, cliente_code, vendedor_code, vendedor_nombre,
           coalesce(descuento_pct, 0) AS pct_documento
    FROM analytics.erp_sales_invoices
    WHERE tenant_id = ? AND doc_tipo = 'telemarketing' AND NOT cancelada
      AND fecha >= current_date - 30),
  x AS (
    SELECT f.*, l.renglones, l.sin_lista, l.importe, l.desc_producto,
           coalesce(nullif(regexp_replace(coalesce(u.c17, ''), '[^0-9.]', '', 'g'), '')::numeric, 0) AS pct_maestro
    FROM f
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS renglones,
             count(*) FILTER (WHERE ${NUM('d.c66')} <= 0)::int AS sin_lista,
             sum(${NUM('d.c13')}) AS importe,
             sum(round(greatest(coalesce(nullif(${NUM('d.c66')}, 0), ${NUM('d.c12')}) - ${NUM('d.c12')}, 0)
                 * abs(coalesce(d.c9::numeric, 0)), 2)) AS desc_producto
      FROM kepler_ods.kdm2 d
      WHERE d.c2 = 'U' AND d.c3 = 'D' AND btrim(d.sucursal) = f.sucursal AND (d.c4)::integer = 8
        AND (d.c5)::integer = substr(f.doc_prefix, 5, 2)::integer AND btrim(d.c6) = f.folio
        AND btrim(d.c1) = f.sucursal AND abs(coalesce(d.c9::numeric, 0)) > 0) l
    LEFT JOIN kepler_ods.kdud u ON btrim(u.sucursal) = f.sucursal AND btrim(u.c2) = f.cliente_code)
  SELECT vendedor_code, vendedor_nombre, pct_maestro, pct_documento,
         count(*) FILTER (WHERE renglones > 0)::int                          AS facturas,
         count(*) FILTER (WHERE renglones = 0)::int                          AS facturas_sin_renglones,
         coalesce(sum(total) FILTER (WHERE renglones = 0), 0)::numeric       AS total_sin_renglones,
         coalesce(sum(renglones), 0)::int                                    AS renglones,
         coalesce(sum(sin_lista), 0)::int                                    AS renglones_sin_lista,
         coalesce(sum(importe) FILTER (WHERE renglones > 0), 0)::numeric     AS subtotal,
         coalesce(sum(desc_producto) FILTER (WHERE renglones > 0), 0)::numeric AS producto,
         coalesce(sum(importe - total) FILTER (WHERE renglones > 0), 0)::numeric AS cliente,
         coalesce(sum(total) FILTER (WHERE renglones > 0), 0)::numeric       AS facturado
  FROM x GROUP BY 1, 2, 3, 4`;

const llaveOperador = (code: unknown, nombre: unknown): string => `${code ?? ''}|${nombre ?? ''}`;
const centavos = (n: number): number => Math.round(n * 100) / 100;

interface DescuentoOperador { lista: number; producto: number; cliente: number }

/** Suma las filas por (operador, %maestro, %documento) en la cascada y en el reparto por operador. */
export function armarDescuentos(rows: Array<Record<string, unknown>>): {
  resumen: DescuentosTelemarketing;
  porOperador: Map<string, DescuentoOperador>;
} {
  const r: DescuentosTelemarketing = {
    facturas: 0, facturas_sin_renglones: 0, total_sin_renglones: 0, renglones: 0, renglones_sin_lista: 0,
    lista: 0, producto: 0, subtotal: 0, cliente: 0, facturado: 0,
    negociado_no_aplicado: { facturas: 0, monto: 0 },
    sin_respaldo_maestro: { facturas: 0, monto: 0 },
  };
  const porOperador = new Map<string, DescuentoOperador>();
  for (const row of rows) {
    const facturas = Number(row.facturas || 0);
    const subtotal = Number(row.subtotal || 0);
    const producto = Number(row.producto || 0);
    const cliente = Number(row.cliente || 0);
    const pm = Number(row.pct_maestro || 0);
    const pd = Number(row.pct_documento || 0);
    r.facturas += facturas;
    r.facturas_sin_renglones += Number(row.facturas_sin_renglones || 0);
    r.total_sin_renglones += Number(row.total_sin_renglones || 0);
    r.renglones += Number(row.renglones || 0);
    r.renglones_sin_lista += Number(row.renglones_sin_lista || 0);
    r.subtotal += subtotal;
    r.producto += producto;
    r.cliente += cliente;
    r.facturado += Number(row.facturado || 0);
    if (facturas > 0 && pm > pd) {
      r.negociado_no_aplicado.facturas += facturas;
      r.negociado_no_aplicado.monto += (subtotal * (pm - pd)) / 100;
    } else if (facturas > 0 && pd > pm) {
      r.sin_respaldo_maestro.facturas += facturas;
      r.sin_respaldo_maestro.monto += (subtotal * (pd - pm)) / 100;
    }
    if (facturas > 0) {
      const k = llaveOperador(row.vendedor_code, row.vendedor_nombre);
      const o = porOperador.get(k) || { lista: 0, producto: 0, cliente: 0 };
      o.lista += subtotal + producto;
      o.producto += producto;
      o.cliente += cliente;
      porOperador.set(k, o);
    }
  }
  r.lista = r.subtotal + r.producto;
  for (const k of ['total_sin_renglones', 'lista', 'producto', 'subtotal', 'cliente', 'facturado'] as const) {
    r[k] = centavos(r[k]);
  }
  r.negociado_no_aplicado.monto = centavos(r.negociado_no_aplicado.monto);
  r.sin_respaldo_maestro.monto = centavos(r.sin_respaldo_maestro.monto);
  for (const o of porOperador.values()) {
    o.lista = centavos(o.lista); o.producto = centavos(o.producto); o.cliente = centavos(o.cliente);
  }
  return { resumen: r, porOperador };
}

export interface ReservationRecord {
  id: string;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  reserved_at: string;
  expires_at: string;
  expires_in_seconds: number;
}

export interface CustomerSnapshot {
  customer: {
    id: string;
    code: string;
    name: string;
    phone: string | null;
    email: string | null;
    notes: string | null;
    credit_limit: number | null;
    balance: number | null;
    payment_terms_days: number | null;
  };
  recent_orders: Array<{
    id: string;
    code: string;
    status: string;
    total: number;
    created_at: string;
    confirmed_at: string | null;
  }>;
  recent_calls: Array<{
    id: string;
    called_at: string;
    outcome: string;
    notes: string | null;
    next_action_at: string | null;
    operator_username: string | null;
  }>;
  reservation: ReservationRecord | null;
}

export interface LogCallDto {
  customer_id: string;
  outcome:
    | 'sale'
    | 'no_sale'
    | 'callback_scheduled'
    | 'no_answer'
    | 'wrong_contact'
    | 'other';
  notes?: string;
  duration_minutes?: number;
  next_action_at?: string; // ISO string, requerido si outcome=callback_scheduled
  order_id?: string;       // si outcome=sale
  /** Si true, libera la reserva activa del operador sobre este customer. */
  release_reservation?: boolean;
}

@Injectable()
export class CommercialTeleventaService {
  private readonly logger = new Logger(CommercialTeleventaService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private context() {
    const ctx = this.tenantCtx.get();
    if (!ctx?.tenantId) {
      throw new BadRequestException('Falta tenant context (Bearer JWT).');
    }
    if (!ctx.userId) {
      throw new BadRequestException('Falta user context.');
    }
    return { tenantId: ctx.tenantId, userId: ctx.userId };
  }

  /**
   * Cola priorizada de clientes a llamar.
   *
   * Excluye los reservados activamente por OTROS operadores (los reservados
   * por el operador actual se ven con un flag para que sepa cuáles "ya tomó").
   * Orden: inactive_critical > callback_due > inactive_normal > never_ordered
   * > general. Dentro de cada grupo, last_contact_at ASC NULLS FIRST.
   */
  async getQueue(limit = 50): Promise<QueueItem[]> {
    const { tenantId, userId } = this.context();

    const rows = await this.tk.run(async (trx) => trx.raw(
      `
      WITH customer_stats AS (
        SELECT
          c.id, c.code, c.name, c.phone, c.email,
          (SELECT MAX(o.created_at) FROM commercial.orders o
            WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id
              AND o.deleted_at IS NULL) AS last_order_at,
          (SELECT COUNT(*) FROM commercial.orders o
            WHERE o.tenant_id = c.tenant_id AND o.customer_id = c.id
              AND o.deleted_at IS NULL) AS total_orders,
          (SELECT MAX(cl.called_at) FROM commercial.call_logs cl
            WHERE cl.tenant_id = c.tenant_id AND cl.customer_id = c.id) AS last_call_at,
          (SELECT MIN(cl.next_action_at) FROM commercial.call_logs cl
            WHERE cl.tenant_id = c.tenant_id AND cl.customer_id = c.id
              AND cl.outcome = 'callback_scheduled'
              AND cl.next_action_at IS NOT NULL
              AND cl.next_action_at >= NOW() - INTERVAL '7 days') AS callback_due_at
        FROM commercial.customers c
        WHERE c.tenant_id = ? AND c.active = true AND c.deleted_at IS NULL
      ),
      reservations AS (
        SELECT customer_id, reserved_by_user_id
        FROM commercial.lead_reservations
        WHERE tenant_id = ? AND released_at IS NULL AND expires_at > NOW()
      )
      SELECT
        cs.*,
        CASE
          WHEN cs.callback_due_at IS NOT NULL AND cs.callback_due_at <= NOW() + INTERVAL '1 day' THEN 'callback_due'
          WHEN cs.total_orders = 0 THEN 'never_ordered'
          WHEN cs.last_order_at IS NULL OR cs.last_order_at < NOW() - INTERVAL '60 days' THEN 'inactive_critical'
          WHEN cs.last_order_at < NOW() - INTERVAL '30 days' THEN 'inactive_normal'
          ELSE 'general'
        END AS reason,
        EXTRACT(DAY FROM NOW() - cs.last_order_at)::int AS days_since_last_order,
        EXISTS(SELECT 1 FROM reservations r WHERE r.customer_id = cs.id AND r.reserved_by_user_id <> ?) AS reserved_by_other
      FROM customer_stats cs
      `,
      [tenantId, tenantId, userId],
    ));

    const all: any[] = (rows as any).rows;
    // Excluir los reservados por otros (siguen visibles los que reservé yo).
    const visible = all.filter((r) => !r.reserved_by_other);

    // Sort por prioridad de reason + last_contact_at ASC NULLS FIRST.
    const priority: Record<QueueReason, number> = {
      inactive_critical: 1,
      callback_due: 2,
      inactive_normal: 3,
      never_ordered: 4,
      general: 5,
    };
    visible.sort((a, b) => {
      const pa = priority[a.reason as QueueReason] || 999;
      const pb = priority[b.reason as QueueReason] || 999;
      if (pa !== pb) return pa - pb;
      // Within group: nunca contactado primero.
      const lcA = a.last_call_at ? new Date(a.last_call_at).getTime() : 0;
      const lcB = b.last_call_at ? new Date(b.last_call_at).getTime() : 0;
      return lcA - lcB;
    });

    return visible.slice(0, limit).map((r) => ({
      customer_id: r.id,
      code: r.code,
      name: r.name,
      phone: r.phone,
      email: r.email,
      reason: r.reason,
      last_order_at: r.last_order_at,
      last_call_at: r.last_call_at,
      callback_due_at: r.callback_due_at,
      days_since_last_order: r.days_since_last_order,
      total_orders: Number(r.total_orders),
    }));
  }

  /**
   * Reserva exclusiva del cliente por el operador (TTL 30 min default).
   * Si ya existe reserva activa, retorna 409.
   */
  async reserveLead(customerId: string): Promise<ReservationRecord> {
    const { tenantId, userId } = this.context();
    const expiresAt = new Date(Date.now() + RESERVATION_TTL_MIN * 60 * 1000);

    return this.tk.run(async (trx) => {
      const customer = await trx('commercial.customers')
        .where({ tenant_id: tenantId, id: customerId, active: true })
        .whereNull('deleted_at')
        .first('id', 'code', 'name');
      if (!customer) {
        throw new NotFoundException(`Cliente ${customerId} no encontrado.`);
      }

      // Pre-libera reservas vencidas: el cron corre c/5min, sin esto el INSERT choca el UNIQUE parcial → 409 espurio sobre un lead que la cola sí ofrece.
      await trx('commercial.lead_reservations')
        .where({ tenant_id: tenantId, customer_id: customerId })
        .whereNull('released_at')
        .where('expires_at', '<', trx.fn.now())
        .update({ released_at: trx.fn.now(), released_reason: 'expired' });

      try {
        const [row] = await trx('commercial.lead_reservations')
          .insert({
            tenant_id: tenantId,
            customer_id: customerId,
            reserved_by_user_id: userId,
            expires_at: expiresAt,
          })
          .returning(['id', 'reserved_at', 'expires_at']);

        return {
          id: row.id,
          customer_id: customerId,
          customer_code: customer.code,
          customer_name: customer.name,
          reserved_at: row.reserved_at,
          expires_at: row.expires_at,
          expires_in_seconds: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)),
        };
      } catch (e: any) {
        if (e.code === '23505') {
          throw new ConflictException(
            `Cliente ${customer.code} ya está siendo trabajado por otro operador.`,
          );
        }
        throw e;
      }
    });
  }

  /**
   * Libera una reserva activa (released_at = NOW).
   * Solo el operador owner puede liberar (o el cron via released_reason=expired).
   */
  async releaseLead(reservationId: string, reason: 'completed' | 'released_manual' = 'released_manual'): Promise<{ released: boolean }> {
    const { tenantId, userId } = this.context();

    const updated = await this.tk.run(async (trx) =>
      trx('commercial.lead_reservations')
        .where({ tenant_id: tenantId, id: reservationId, reserved_by_user_id: userId })
        .whereNull('released_at')
        .update({ released_at: trx.fn.now(), released_reason: reason }),
    );

    if (updated === 0) {
      throw new NotFoundException(
        `Reserva ${reservationId} no encontrada, ya liberada, o pertenece a otro operador.`,
      );
    }
    return { released: true };
  }

  /**
   * Snapshot completo del cliente — info + últimos 5 pedidos + últimas 5
   * llamadas. Incluye la reserva activa del operador si existe.
   */
  async getCustomerSnapshot(customerId: string): Promise<CustomerSnapshot> {
    const { tenantId, userId } = this.context();

    return this.tk.run(async (trx) => {
      const customer = await trx('commercial.customers')
        .where({ tenant_id: tenantId, id: customerId })
        .whereNull('deleted_at')
        .first(
          'id', 'code', 'name', 'phone', 'email', 'notes',
          'credit_limit', 'balance', 'payment_terms_days',
        );
      if (!customer) {
        throw new NotFoundException(`Cliente ${customerId} no encontrado.`);
      }

      const recentOrders = await trx('commercial.orders')
        .where({ tenant_id: tenantId, customer_id: customerId })
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .limit(5)
        .select('id', 'code', 'status', 'total', 'created_at', 'confirmed_at');

      const recentCalls = await trx('commercial.call_logs as cl')
        .leftJoin('public.users as u', function () {
          this.on('u.tenant_id', '=', 'cl.tenant_id').andOn('u.id', '=', 'cl.user_id');
        })
        .where('cl.tenant_id', tenantId)
        .andWhere('cl.customer_id', customerId)
        .orderBy('cl.called_at', 'desc')
        .limit(5)
        .select(
          'cl.id',
          'cl.called_at',
          'cl.outcome',
          'cl.notes',
          'cl.next_action_at',
          'u.username as operator_username',
        );

      const activeRes = await trx('commercial.lead_reservations')
        .where({ tenant_id: tenantId, customer_id: customerId, reserved_by_user_id: userId })
        .whereNull('released_at')
        .first('id', 'reserved_at', 'expires_at');

      return {
        customer: {
          ...customer,
          credit_limit: customer.credit_limit !== null ? Number(customer.credit_limit) : null,
          balance: customer.balance !== null ? Number(customer.balance) : null,
        },
        recent_orders: recentOrders.map((o) => ({ ...o, total: Number(o.total) })),
        recent_calls: recentCalls,
        reservation: activeRes
          ? {
              id: activeRes.id,
              customer_id: customerId,
              customer_code: customer.code,
              customer_name: customer.name,
              reserved_at: activeRes.reserved_at,
              expires_at: activeRes.expires_at,
              expires_in_seconds: Math.max(0, Math.floor((new Date(activeRes.expires_at).getTime() - Date.now()) / 1000)),
            }
          : null,
      };
    });
  }

  /**
   * Reservas activas del operador actual (con TTL restante).
   */
  async getMyReservations(): Promise<ReservationRecord[]> {
    const { tenantId, userId } = this.context();

    const rows = await this.tk.run(async (trx) =>
      trx('commercial.lead_reservations as lr')
        .innerJoin('commercial.customers as c', function () {
          this.on('c.tenant_id', '=', 'lr.tenant_id').andOn('c.id', '=', 'lr.customer_id');
        })
        .where('lr.tenant_id', tenantId)
        .andWhere('lr.reserved_by_user_id', userId)
        .whereNull('lr.released_at')
        .where('lr.expires_at', '>', trx.fn.now())
        .orderBy('lr.reserved_at', 'desc')
        .select('lr.id', 'lr.customer_id', 'c.code as customer_code', 'c.name as customer_name', 'lr.reserved_at', 'lr.expires_at'),
    );

    return rows.map((r) => ({
      id: r.id,
      customer_id: r.customer_id,
      customer_code: r.customer_code,
      customer_name: r.customer_name,
      reserved_at: r.reserved_at,
      expires_at: r.expires_at,
      expires_in_seconds: Math.max(0, Math.floor((new Date(r.expires_at).getTime() - Date.now()) / 1000)),
    }));
  }

  /**
   * Registra el resultado de la llamada + opcionalmente libera la reserva.
   * Si outcome=callback_scheduled, requiere next_action_at.
   */
  async logCall(dto: LogCallDto): Promise<{ id: string }> {
    const { tenantId, userId } = this.context();

    if (dto.outcome === 'callback_scheduled' && !dto.next_action_at) {
      throw new BadRequestException(
        'next_action_at requerido cuando outcome=callback_scheduled.',
      );
    }

    const [inserted] = await this.tk.run(async (trx) => {
      const customer = await trx('commercial.customers')
        .where({ tenant_id: tenantId, id: dto.customer_id })
        .whereNull('deleted_at')
        .first('id');
      if (!customer) {
        throw new NotFoundException(`Cliente ${dto.customer_id} no encontrado.`);
      }

      const result = await trx('commercial.call_logs')
        .insert({
          tenant_id: tenantId,
          customer_id: dto.customer_id,
          user_id: userId,
          outcome: dto.outcome,
          notes: dto.notes ?? null,
          duration_minutes: dto.duration_minutes ?? null,
          next_action_at: dto.next_action_at ?? null,
          order_id: dto.order_id ?? null,
        })
        .returning('id');

      // Si pidieron release, cerrar la reserva activa del operador.
      if (dto.release_reservation) {
        await trx('commercial.lead_reservations')
          .where({
            tenant_id: tenantId,
            customer_id: dto.customer_id,
            reserved_by_user_id: userId,
          })
          .whereNull('released_at')
          .update({
            released_at: trx.fn.now(),
            released_reason: 'completed',
          });
      }
      return result;
    });

    return { id: inserted.id };
  }

  /**
   * Historial paginado de llamadas a un cliente.
   */
  /**
   * E.4 — Dashboard de métricas televenta.
   *
   * Devuelve KPIs operativos del día/período + breakdown por operador para
   * managers, y stats personales para operadores. Endpoint usado por la
   * página `/telemarketing/dashboard`.
   */
  async dashboardMetrics(opts: { from?: string; to?: string } = {}): Promise<any> {
    const { tenantId, userId } = this.context();
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString();

    // 7. Los primeros 5 de la cola, con el MISMO orden que /telemarketing/queue.
    // ⚠️ Antes era una consulta propia sin ORDER BY: se titulaba «Cola priorizada» y devolvía
    // los 5 primeros en orden físico — medido el 2026-10-21, cinco clientes sin teléfono ni
    // pedidos, mientras la cola real ordenaba por motivo. Dos implementaciones de «la cola»
    // = dos respuestas; se reusa la única que prioriza.
    //
    // Cola, facturación y actividad van en PARALELO, cada una con su conexión: dentro de una
    // sola transacción las consultas se encolan en el mismo cliente y el tiempo es la SUMA.
    // Medido en prod el 2026-10-21: facturación en serie ≈ 670 ms; en paralelo, la más lenta
    // (el vencido de toda la cartera) ≈ 390 ms.
    const [queue, billing, actividad] = await Promise.all([
      this.getQueue(5),
      // ── E.9: el dinero del canal, medido en el ERP (no en esta plataforma) ──
      this.facturacion(tenantId),
      this.actividadLlamadas(tenantId, userId, todayStart, sevenDaysAgo, opts),
    ]);
    const queuePreview = queue.map((q) => ({
      id: q.customer_id,
      code: q.code,
      name: q.name,
      phone: q.phone,
      reason: q.reason,
      last_order_at: q.last_order_at,
      days_since_last_order: q.days_since_last_order,
    }));
    return { ...actividad, queue_preview: queuePreview, billing };
  }

  /** E.4 — la actividad de llamadas (`commercial.call_logs`) del tablero. */
  private async actividadLlamadas(
    tenantId: string,
    userId: string,
    todayStart: string,
    sevenDaysAgo: string,
    opts: { from?: string; to?: string },
  ): Promise<TeleventaActividad> {
    return this.tk.run(async (trx) => {
      // 1. Llamadas hoy (total + por outcome + propio operador)
      const callsToday = await trx('commercial.call_logs')
        .where({ tenant_id: tenantId })
        .where('called_at', '>=', todayStart)
        .select(
          trx.raw('count(*)::int as total'),
          trx.raw(`count(*) filter (where outcome = 'sale')::int as orders_taken`),
          trx.raw(`count(*) filter (where outcome = 'no_answer')::int as no_answer`),
          trx.raw(`count(*) filter (where outcome = 'callback_scheduled')::int as callbacks`),
          trx.raw(`count(*) filter (where outcome = 'no_sale')::int as not_interested`),
          trx.raw(`coalesce(sum(duration_minutes), 0)::int as total_minutes`),
        )
        .first();

      // 2. Mis stats (operador logueado) — solo si hay userId
      let myStats: any = null;
      if (userId) {
        myStats = await trx('commercial.call_logs')
          .where({ tenant_id: tenantId, user_id: userId })
          .where('called_at', '>=', todayStart)
          .select(
            trx.raw('count(*)::int as my_calls'),
            trx.raw(`count(*) filter (where outcome = 'sale')::int as my_orders`),
            trx.raw(`coalesce(sum(duration_minutes), 0)::int as my_minutes`),
          )
          .first();
      }

      // 3. Reservas activas
      const activeReservations = await trx('commercial.lead_reservations')
        .where({ tenant_id: tenantId })
        .whereNull('released_at')
        .where('expires_at', '>', new Date().toISOString())
        .select(
          trx.raw('count(*)::int as total'),
          trx.raw(`count(distinct reserved_by_user_id)::int as unique_operators`),
        )
        .first();

      // 4. Conversión 7d: % calls que terminaron en pedido confirmed (order_id no null)
      const conversion7d = await trx('commercial.call_logs')
        .where({ tenant_id: tenantId })
        .where('called_at', '>=', sevenDaysAgo)
        .select(
          trx.raw('count(*)::int as total_calls'),
          trx.raw('count(order_id)::int as calls_with_order'),
          trx.raw(`count(*) filter (where outcome = 'sale')::int as orders_outcome`),
        )
        .first();

      // 5. Top operadores por llamadas hoy
      const topOperators = await trx('commercial.call_logs as cl')
        .leftJoin('public.users as u', function () {
          this.on('u.tenant_id', '=', 'cl.tenant_id').andOn('u.id', '=', 'cl.user_id');
        })
        .where('cl.tenant_id', tenantId)
        .where('cl.called_at', '>=', todayStart)
        .groupBy('cl.user_id', 'u.username')
        .select(
          'cl.user_id',
          'u.username',
          trx.raw('count(*)::int as calls'),
          trx.raw(`count(*) filter (where cl.outcome = 'sale')::int as orders`),
          trx.raw('coalesce(sum(cl.duration_minutes), 0)::int as minutes'),
        )
        .orderByRaw('count(*) desc')
        .limit(10);

      // 6. Breakdown de outcomes (últimos 7 días)
      const outcomesBreakdown = await trx('commercial.call_logs')
        .where({ tenant_id: tenantId })
        .where('called_at', '>=', sevenDaysAgo)
        .groupBy('outcome')
        .select('outcome', trx.raw('count(*)::int as count'))
        .orderByRaw('count(*) desc');

      const totalCalls7d = Number(conversion7d?.total_calls || 0);
      const ordersOutcome7d = Number(conversion7d?.orders_outcome || 0);
      const conversionPct = totalCalls7d > 0 ? Number(((ordersOutcome7d / totalCalls7d) * 100).toFixed(1)) : 0;

      return {
        period: { from: opts.from || todayStart, to: opts.to || new Date().toISOString() },
        today: {
          calls: Number(callsToday?.total || 0),
          orders_taken: Number(callsToday?.orders_taken || 0),
          no_answer: Number(callsToday?.no_answer || 0),
          callbacks: Number(callsToday?.callbacks || 0),
          not_interested: Number(callsToday?.not_interested || 0),
          total_minutes: Number(callsToday?.total_minutes || 0),
        },
        my_stats: myStats ? {
          my_calls: Number(myStats.my_calls || 0),
          my_orders: Number(myStats.my_orders || 0),
          my_minutes: Number(myStats.my_minutes || 0),
        } : null,
        active_reservations: {
          total: Number(activeReservations?.total || 0),
          unique_operators: Number(activeReservations?.unique_operators || 0),
        },
        conversion_7d: {
          total_calls: totalCalls7d,
          orders_taken: ordersOutcome7d,
          conversion_pct: conversionPct,
        },
        top_operators: topOperators,
        outcomes_7d: outcomesBreakdown,
        // Lo que este tablero NO puede afirmar, dicho aquí y no en la UI (ADR-056): si la
        // plataforma no tiene una sola llamada registrada, "0 llamadas" no es desempeño,
        // es ausencia de captura — y la pantalla debe decirlo en vez de pintar ceros.
        actividad: {
          registrada: Number(callsToday?.total || 0) > 0 || totalCalls7d > 0,
          nota: 'La actividad (llamadas, minutos, conversión) sale de commercial.call_logs, que se llena al registrar llamadas en este módulo. La facturación sale del ERP y es independiente de esa captura.',
        },
      };
    });
  }

  /**
   * E.9 — Facturación REAL del canal telemarketing, para el tablero del módulo.
   *
   * Sale de `analytics.erp_sales_invoices` (doc_tipo `telemarketing` = `U/D/8`, canal TELEMARK
   * en el 100% de los documentos), la misma vista en vivo que consume `/comercial/documentos`.
   * Se lee aquí porque el tablero del canal medía sólo actividad —llamadas y minutos— y no el
   * resultado: en prod hay 732 facturas y $8.2M en 30 días que este módulo no veía.
   *
   * ⚠️ **La atribución es la del ERP, no la de la plataforma.** El operador viene de
   * `vendedor_code`; `identity.users` no tiene con qué empatarlo (sólo `route_id`), así que
   * NO se puede cruzar con quien registró la llamada. Se muestra tal cual viene y se dice.
   *
   * ⚠️ Cada consulta va con su selección **materializada antes de ordenar o recortar**: sobre
   * esta vista un `ORDER BY … LIMIT` directo dispara un nested loop que re-escanea el CTE de la
   * cartera por fila (medido en prod: 23,856 ms vs 970 ms). Ver `commercial-sales-documents`.
   */
  private async facturacion(tenantId: string): Promise<TelemarketingBilling> {
    // Cada consulta en su propia transacción (y conexión), para que el Promise.all de abajo
    // sea paralelo de verdad: sobre un solo `trx` se encolan y el tiempo es la suma.
    const q = (sql: string, bindings: string[]): Promise<RawResult> =>
      this.tk.run(tenantId, async (trx) => (await trx.raw(sql, bindings)) as RawResult);
    const W = `WHERE tenant_id = ? AND doc_tipo = 'telemarketing' AND NOT cancelada`;

    // ⚠️ `sel` trae la ventana de 30 días **más** toda factura vencida, de cualquier fecha: el
    // vencido de sólo 30 días dejaba fuera la deuda más vieja (medido el 2026-10-21: $3.73M en
    // la ventana contra $6.55M del canal). Una sola pasada sobre la vista: 452 ms contra 263 ms
    // de la consulta anterior, y dos pasadas separadas costaban 263 + 576.
    // `d30` filtra por fecha explícita en cada agregado; `vencida` vale para las dos.
    const D30 = `fecha >= current_date - 30`;
    const VENCIDA = `vencimiento < current_date AND estatus_cobro IN ('pendiente','parcial')`;
    const [totales, porOperador, ultimas, descuentosRaw] = await Promise.all([
      q(
        `WITH sel AS MATERIALIZED (
           SELECT fecha, total, saldo, estatus_cobro, vencimiento, cliente_code, sucursal,
                  (${VENCIDA}) AS vencida
           FROM analytics.erp_sales_invoices ${W} AND (${D30} OR (${VENCIDA})))
         SELECT
           count(*) FILTER (WHERE fecha = current_date)::int                        AS facturas_hoy,
           coalesce(sum(total) FILTER (WHERE fecha = current_date), 0)::numeric     AS importe_hoy,
           count(*) FILTER (WHERE fecha >= date_trunc('month', current_date))::int  AS facturas_mes,
           coalesce(sum(total) FILTER (WHERE fecha >= date_trunc('month', current_date)), 0)::numeric AS importe_mes,
           count(*) FILTER (WHERE ${D30})::int                                      AS facturas_30d,
           coalesce(sum(total) FILTER (WHERE ${D30}), 0)::numeric                   AS importe_30d,
           count(DISTINCT cliente_code) FILTER (WHERE ${D30})::int                  AS clientes_30d,
           coalesce(sum(saldo) FILTER (WHERE ${D30}), 0)::numeric                   AS saldo_30d,
           coalesce(sum(saldo) FILTER (WHERE ${D30} AND vencida), 0)::numeric       AS saldo_vencido,
           count(*) FILTER (WHERE ${D30} AND vencida)::int                          AS facturas_vencidas,
           coalesce(sum(saldo) FILTER (WHERE vencida), 0)::numeric                  AS saldo_vencido_canal,
           count(*) FILTER (WHERE vencida)::int                                     AS facturas_vencidas_canal,
           max(fecha) FILTER (WHERE ${D30})                                         AS ultima_factura,
           -- Cuántos de los clientes facturados existen en el padrón de la cola. La llave
           -- (erp_customer_code + erp_source_branch) se verificó por nombre: 11 de 11 iguales.
           (SELECT count(DISTINCT s.cliente_code) FROM sel s
             WHERE s.${D30} AND EXISTS (
               SELECT 1 FROM commercial.customers c
               WHERE c.tenant_id = ? AND c.active AND c.deleted_at IS NULL
                 AND c.erp_customer_code = s.cliente_code AND c.erp_source_branch = s.sucursal))::int
                                                                                    AS clientes_en_cola
         FROM sel`,
        [tenantId, tenantId],
      ),
      q(
        `WITH sel AS MATERIALIZED (
           SELECT vendedor_code, vendedor_nombre, total, saldo, cliente_code
           FROM analytics.erp_sales_invoices ${W} AND fecha >= current_date - 30)
         SELECT vendedor_code, vendedor_nombre,
                count(*)::int AS facturas,
                coalesce(sum(total), 0)::numeric AS importe,
                coalesce(sum(saldo), 0)::numeric AS saldo,
                count(DISTINCT cliente_code)::int AS clientes
         FROM sel GROUP BY 1, 2 ORDER BY 4 DESC`,
        [tenantId],
      ),
      q(
        `WITH sel AS MATERIALIZED (
           SELECT folio_digital, sucursal, doc_prefix, folio, fecha, cliente_code, cliente_nombre,
                  vendedor_nombre, total, saldo, estatus_cobro,
                  (vencimiento < current_date AND estatus_cobro IN ('pendiente','parcial')) AS vencida
           FROM analytics.erp_sales_invoices ${W} AND fecha >= current_date - 30)
         SELECT * FROM sel ORDER BY fecha DESC, folio DESC LIMIT 8`,
        [tenantId],
      ),
      q(SQL_DESCUENTOS_TELEMARKETING_30D, [tenantId]),
    ]);

    const t: Record<string, unknown> = totales?.rows?.[0] || {};
    const descuentos = armarDescuentos(descuentosRaw?.rows || []);
    // El descuento por operador se pega a su fila de facturación por la MISMA llave con que
    // las dos consultas agrupan; un operador sin renglones todavía queda sin descuento (null),
    // no con $0 — cero sería afirmar que no se le descontó nada.
    const porOperadorConDescuento = (porOperador?.rows || []).map((o) => {
      const d = descuentos.porOperador.get(llaveOperador(o.vendedor_code, o.vendedor_nombre));
      return {
        ...o,
        descuento_producto: d ? d.producto : null,
        descuento_cliente: d ? d.cliente : null,
        importe_lista: d ? d.lista : null,
      };
    });
    return {
      hoy: { facturas: Number(t.facturas_hoy || 0), importe: Number(t.importe_hoy || 0) },
      mes: { facturas: Number(t.facturas_mes || 0), importe: Number(t.importe_mes || 0) },
      d30: {
        facturas: Number(t.facturas_30d || 0),
        importe: Number(t.importe_30d || 0),
        clientes: Number(t.clientes_30d || 0),
        saldo: Number(t.saldo_30d || 0),
        saldo_vencido: Number(t.saldo_vencido || 0),
        facturas_vencidas: Number(t.facturas_vencidas || 0),
      },
      /** Vencido de TODA la cartera del canal, sin ventana de fecha de emisión. */
      cartera_vencida: {
        saldo: Number(t.saldo_vencido_canal || 0),
        facturas: Number(t.facturas_vencidas_canal || 0),
      },
      /**
       * La cola sale de `commercial.customers`, no de quien factura por el canal: de los
       * `d30.clientes` facturados, sólo `clientes_en_cola` están en ella. Se publica para que la
       * pantalla lo DECLARE en vez de presentar la cola como el universo del canal.
       */
      clientes_en_cola: Number(t.clientes_en_cola || 0),
      /** Fecha de NEGOCIO del dato más reciente; null si no hay facturas en la ventana. */
      ultima_factura: (t.ultima_factura as Date | string | null) || null,
      por_operador: porOperadorConDescuento,
      ultimas: ultimas?.rows || [],
      descuentos: descuentos.resumen,
      /** La atribución es del ERP: no hay forma de cruzarla con los usuarios de la plataforma. */
      atribucion: 'erp_vendedor_code',
    };
  }

  async getCustomerCallHistory(customerId: string, limit = 20): Promise<any[]> {
    const { tenantId } = this.context();

    return this.tk.run(async (trx) =>
      trx('commercial.call_logs as cl')
        .leftJoin('public.users as u', function () {
          this.on('u.tenant_id', '=', 'cl.tenant_id').andOn('u.id', '=', 'cl.user_id');
        })
        .where('cl.tenant_id', tenantId)
        .andWhere('cl.customer_id', customerId)
        .orderBy('cl.called_at', 'desc')
        .limit(limit)
        .select(
          'cl.id',
          'cl.called_at',
          'cl.outcome',
          'cl.notes',
          'cl.next_action_at',
          'cl.duration_minutes',
          'cl.order_id',
          'u.username as operator_username',
        ),
    );
  }
}
