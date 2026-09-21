import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * `[E.12]` — Cotizaciones de mayoreo.
 *
 * Una cotización es una **oferta de precio con vigencia que todavía no es una venta**. Nace de
 * dos lugares del canal de mayoreo (ver el comentario largo de la migración
 * `20260921190000_commercial_quotes.js`):
 *
 *   · el cliente manda su lista y pide precio  → `origin = 'telemarketing'`
 *   · se visita al cliente y se levanta ahí    → `origin = 'route_visit'`
 *
 * ⚠️ **Una cotización NO toca inventario.** No reserva, no descuenta, no aparta. Eso pasa una
 * sola vez y en un solo lugar: cuando se convierte en `commercial.orders` y ese pedido se
 * confirma (Fase B.2). Si algún día alguien quiere "apartar" lo cotizado, eso es una reserva de
 * stock (`commercial.stock_reservations`, que ya existe), no un estado de la cotización.
 *
 * ⚠️ **`TenantKnexService.run()` es obligatorio** en toda query: las tres tablas tienen RLS
 * FORZADO y sin el contexto devuelven 0 filas en prod. En local no se ve porque el runtime corre
 * con el rol `postgres`, que bypasea RLS — el bug aparece recién en producción (lección de E.1).
 */

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
export type QuoteOrigin = 'telemarketing' | 'route_visit' | 'counter' | 'portal';

/** Vigencia por default cuando quien cotiza no la fija. Es una decisión de negocio, no técnica. */
const DEFAULT_VALIDITY_DAYS = 15;

export interface ListQuotesQuery {
  status?: string;
  origin?: string;
  customer_id?: string;
  /** `true` = sólo las mías. El operador entra a ver su trabajo, no el de todos. */
  mine?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface QuoteListRow {
  id: string;
  code: string;
  status: QuoteStatus;
  origin: QuoteOrigin;
  customer_id: string | null;
  customer_code: string | null;
  /** El cliente registrado, o el contacto suelto si todavía no es cliente. */
  recipient_name: string;
  quote_date: string;
  valid_until: string;
  /** Días para que venza. Negativo = ya venció aunque el status todavía diga otra cosa. */
  days_to_expiry: number;
  total: number;
  currency: string;
  line_count: number;
  /** Renglones que el cliente pidió y NO pudimos casar con el catálogo. */
  unmatched_count: number;
  order_id: string | null;
  order_code: string | null;
  created_at: string;
  user_id: string;
  created_by_username: string | null;
}

export interface QuotesSummary {
  /** Cuenta por estado. Lo que no tiene filas NO se omite: va en 0 explícito. */
  by_status: Record<QuoteStatus, number>;
  /** Monto vivo: lo cotizado que todavía puede convertirse (draft + sent, no vencido). */
  open_amount: number;
  open_count: number;
  /** Vencen dentro de 3 días y siguen abiertas: el trabajo urgente del día. */
  expiring_soon_count: number;
  /** Abiertas cuya vigencia ya pasó — el cron aún no las cerró, o no hay cron. Se DECLARA. */
  overdue_count: number;
}

@Injectable()
export class CommercialQuotesService {
  private readonly logger = new Logger(CommercialQuotesService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Lectura
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * La mesa de trabajo: una fila por cotización, con lo que hace falta para decidir a cuál
   * entrar (vigencia, monto, cuántos renglones quedaron sin casar).
   */
  async list(query: ListQuotesQuery): Promise<{ rows: QuoteListRow[]; total: number }> {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const offset = Math.max(Number(query.offset) || 0, 0);
    const userId = this.tenantCtx.get()?.userId;

    return this.tk.run(async (knex) => {
      const where: string[] = ['q.deleted_at IS NULL'];
      const binds: Record<string, unknown> = { limit, offset };

      if (query.status) {
        const list = String(query.status)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length) {
          where.push(`q.status = ANY(:statuses)`);
          binds['statuses'] = list;
        }
      }
      if (query.origin) {
        where.push('q.origin = :origin');
        binds['origin'] = query.origin;
      }
      if (query.customer_id) {
        where.push('q.customer_id = :customer_id');
        binds['customer_id'] = query.customer_id;
      }
      if (query.mine && userId) {
        where.push('q.user_id = :user_id');
        binds['user_id'] = userId;
      }
      if (query.search) {
        where.push(
          `(q.code ILIKE :search OR c.name ILIKE :search OR c.code ILIKE :search OR q.contact_name ILIKE :search OR q.erp_customer_code ILIKE :search OR q.erp_customer_name ILIKE :search)`,
        );
        binds['search'] = `%${String(query.search).trim()}%`;
      }

      const whereSql = where.join(' AND ');

      const rows = await knex.raw(
        `
        SELECT
          q.id, q.code, q.status, q.origin, q.customer_id,
          COALESCE(c.code, q.erp_customer_code) AS customer_code,
          COALESCE(c.name, q.erp_customer_name, q.contact_name) AS recipient_name,
          to_char(q.quote_date,  'YYYY-MM-DD') AS quote_date,
          to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until,
          (q.valid_until - CURRENT_DATE)::int  AS days_to_expiry,
          q.total::float8 AS total,
          q.currency,
          q.order_id,
          o.code AS order_code,
          q.created_at,
          q.user_id,
          u.username AS created_by_username,
          COALESCE(l.line_count, 0)::int      AS line_count,
          COALESCE(l.unmatched_count, 0)::int AS unmatched_count
        FROM commercial.quotes q
        LEFT JOIN commercial.customers c ON c.tenant_id = q.tenant_id AND c.id = q.customer_id
        LEFT JOIN commercial.orders    o ON o.tenant_id = q.tenant_id AND o.id = q.order_id
        LEFT JOIN identity.users       u ON u.tenant_id = q.tenant_id AND u.id = q.user_id
        LEFT JOIN LATERAL (
          SELECT count(*) AS line_count,
                 count(*) FILTER (WHERE ql.product_id IS NULL) AS unmatched_count
          FROM commercial.quote_lines ql
          WHERE ql.tenant_id = q.tenant_id AND ql.quote_id = q.id
        ) l ON TRUE
        WHERE ${whereSql}
        ORDER BY q.created_at DESC
        LIMIT :limit OFFSET :offset
        `,
        binds,
      );

      const counted = await knex.raw(
        `
        SELECT count(*)::int AS total
        FROM commercial.quotes q
        LEFT JOIN commercial.customers c ON c.tenant_id = q.tenant_id AND c.id = q.customer_id
        WHERE ${whereSql}
        `,
        binds,
      );

      return { rows: rows.rows as QuoteListRow[], total: counted.rows[0]?.total ?? 0 };
    });
  }

  /**
   * Los números de la cabecera. Cada estado sale en 0 explícito aunque no tenga filas: un estado
   * ausente en el objeto se lee en la pantalla como "no aplica" cuando en realidad es "cero".
   */
  async summary(mine = false): Promise<QuotesSummary> {
    const userId = this.tenantCtx.get()?.userId;
    return this.tk.run(async (knex) => {
      const mineSql = mine && userId ? 'AND q.user_id = :user_id' : '';
      const binds: Record<string, unknown> = {};
      if (mine && userId) binds['user_id'] = userId;

      const res = await knex.raw(
        `
        SELECT
          q.status,
          count(*)::int AS n,
          COALESCE(sum(q.total), 0)::float8 AS amount,
          count(*) FILTER (
            WHERE q.status IN ('draft','sent')
              AND q.valid_until >= CURRENT_DATE
              AND q.valid_until <= CURRENT_DATE + 3
          )::int AS expiring_soon,
          count(*) FILTER (
            WHERE q.status IN ('draft','sent') AND q.valid_until < CURRENT_DATE
          )::int AS overdue
        FROM commercial.quotes q
        WHERE q.deleted_at IS NULL ${mineSql}
        GROUP BY q.status
        `,
        binds,
      );

      const by_status: Record<QuoteStatus, number> = {
        draft: 0,
        sent: 0,
        accepted: 0,
        rejected: 0,
        expired: 0,
        cancelled: 0,
      };
      let open_amount = 0;
      let open_count = 0;
      let expiring_soon_count = 0;
      let overdue_count = 0;

      for (const r of res.rows as Array<Record<string, number | string>>) {
        const st = r['status'] as QuoteStatus;
        if (st in by_status) by_status[st] = Number(r['n']);
        if (st === 'draft' || st === 'sent') {
          open_amount += Number(r['amount']);
          open_count += Number(r['n']);
        }
        expiring_soon_count += Number(r['expiring_soon']);
        overdue_count += Number(r['overdue']);
      }

      return { by_status, open_amount, open_count, expiring_soon_count, overdue_count };
    });
  }

  /** Cabecera + renglones de una cotización. */
  async getOne(id: string) {
    return this.tk.run(async (knex) => {
      const head = await knex.raw(
        `
        SELECT
          q.*,
          to_char(q.quote_date,  'YYYY-MM-DD') AS quote_date,
          to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until,
          (q.valid_until - CURRENT_DATE)::int  AS days_to_expiry,
          c.code AS customer_code,
          COALESCE(c.name, q.contact_name) AS recipient_name,
          o.code AS order_code,
          u.username AS created_by_username
        FROM commercial.quotes q
        LEFT JOIN commercial.customers c ON c.tenant_id = q.tenant_id AND c.id = q.customer_id
        LEFT JOIN commercial.orders    o ON o.tenant_id = q.tenant_id AND o.id = q.order_id
        LEFT JOIN identity.users       u ON u.tenant_id = q.tenant_id AND u.id = q.user_id
        WHERE q.id = :id AND q.deleted_at IS NULL
        `,
        { id },
      );
      if (!head.rows.length) throw new NotFoundException('Cotización no encontrada');

      const lines = await knex.raw(
        `
        SELECT
          ql.*,
          p.nombre AS product_name,
          -- El descuento se DERIVA, no se guarda: guardado aparte se desincroniza del precio
          -- en cuanto alguien edita uno de los dos.
          CASE
            WHEN ql.list_price IS NULL OR ql.list_price = 0 OR ql.unit_price IS NULL THEN NULL
            ELSE round(((ql.list_price - ql.unit_price) / ql.list_price * 100)::numeric, 2)
          END AS discount_pct
        FROM commercial.quote_lines ql
        LEFT JOIN catalog.products p ON p.tenant_id = ql.tenant_id AND p.id = ql.product_id
        WHERE ql.tenant_id = public.current_tenant_id() AND ql.quote_id = :id
        ORDER BY ql.line_number
        `,
        { id },
      );

      return { ...head.rows[0], lines: lines.rows };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // El padrón de mayoreo (derivado del ERP, sin copiar nada)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Busca clientes de MAYOREO en `analytics.v_erp_wholesale_customers` (vista sobre
   * `kepler_ods.kdud`, filtrada a `C####`).
   *
   * ⚠️ Devuelve **una fila por (cliente, sucursal)** colapsada a un cliente con el arreglo de
   * sus sucursales, porque las condiciones DIFIEREN entre ellas y quien cotiza tiene que elegir
   * —y ver— con cuáles está cotizando. Medido: C1086 tiene $60,000 y 3% en la sucursal 01 y 06,
   * y $30,000 sin descuento en las otras cinco. Colapsarlo a un solo juego de condiciones sería
   * elegir una sucursal en silencio.
   */
  async searchWholesaleCustomers(search: string, limit = 20) {
    const term = (search || '').trim();
    const n = Math.min(Math.max(Number(limit) || 20, 1), 50);

    return this.tk.run(async (knex) => {
      const res = await knex.raw(
        `
        WITH hit AS (
          SELECT DISTINCT customer_code
          FROM analytics.v_erp_wholesale_customers
          WHERE :term = '' OR customer_code ILIKE :like OR name ILIKE :like
          ORDER BY customer_code
          LIMIT :lim
        )
        SELECT
          v.customer_code,
          max(v.name)                      AS name,
          max(v.phone)                     AS phone,
          max(v.rfc)                       AS rfc,
          max(v.address_1)                 AS address_1,
          max(v.state)                     AS state,
          jsonb_agg(
            jsonb_build_object(
              'sucursal',       v.sucursal,
              'credit_limit',   v.credit_limit,
              'payment_days',   v.payment_days,
              'discount_1_pct', v.discount_1_pct,
              'discount_2_pct', v.discount_2_pct,
              'zone_code',      v.zone_code,
              'group_code',     v.group_code
            ) ORDER BY v.sucursal
          )                                AS branches,
          -- ¿Las condiciones son las mismas en todas sus sucursales? Si no, la pantalla tiene
          -- que decirlo: es la diferencia entre "$60,000 con 3%" y "$30,000 sin descuento".
          (count(DISTINCT coalesce(v.discount_1_pct::text, '-')) > 1
           OR count(DISTINCT coalesce(v.credit_limit::text, '-')) > 1
           OR count(DISTINCT coalesce(v.payment_days::text, '-')) > 1) AS terms_vary_by_branch
        FROM analytics.v_erp_wholesale_customers v
        JOIN hit ON hit.customer_code = v.customer_code
        GROUP BY v.customer_code
        ORDER BY v.customer_code
        `,
        { term, like: `%${term}%`, lim: n },
      );
      return res.rows;
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Escritura
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Crea la cotización en borrador. Los renglones se cargan después (E.12.1): acá nace la
   * cabecera con su folio, su destinatario y su vigencia, que es lo que la hace existir.
   */
  async create(dto: {
    customer_id?: string | null;
    /** Cliente de mayoreo del ERP (`C####`). Tercera vía de destinatario. */
    erp_customer_code?: string | null;
    /** Sucursal Kepler desde la que se cotiza. Obligatoria si el cliente viene del ERP. */
    source_branch?: string | null;
    contact_name?: string | null;
    contact_phone?: string | null;
    contact_email?: string | null;
    origin?: QuoteOrigin;
    warehouse_id?: string | null;
    price_list_id?: string | null;
    valid_until?: string | null;
    customer_request?: string | null;
    notes?: string | null;
    internal_notes?: string | null;
  }) {
    const userId = this.tenantCtx.get()?.userId;
    const tenantId = this.tenantCtx.requireTenantId();
    if (!userId) throw new BadRequestException('Sesión sin usuario: no se puede cotizar.');

    const erpCode = (dto.erp_customer_code || '').trim().toUpperCase() || null;
    const hasRecipient =
      !!dto.customer_id || !!erpCode || !!(dto.contact_name && dto.contact_name.trim());
    if (!hasRecipient) {
      throw new BadRequestException(
        'La cotización necesita destinatario: un cliente de mayoreo del ERP, un cliente registrado, o al menos un nombre de contacto.',
      );
    }
    if (erpCode && !dto.source_branch) {
      throw new BadRequestException(
        'Falta la sucursal: las condiciones del cliente (descuento, límite, plazo) DIFIEREN entre sucursales, así que cotizar sin decir cuál es irreproducible.',
      );
    }
    const origin = dto.origin ?? 'telemarketing';
    if (!['telemarketing', 'route_visit', 'counter', 'portal'].includes(origin)) {
      throw new BadRequestException(`origin inválido: ${origin}`);
    }

    // `tk.run()` YA abre la transacción con `SET LOCAL app.tenant_id` (GOTCHAS §2: el request
    // entero va en UNA trx). Abrir otra acá anidaría un savepoint sin ganar nada.
    return this.tk.run(async (trx) => {
      const year = new Date().getFullYear();

      // ── Las condiciones se LEEN del ERP y se congelan; NO se aceptan del request ────────
      // Si el cliente las mandara, la cotización podría afirmar un descuento que el ERP nunca
      // dio. Se resuelven por (código, sucursal) porque es el grano en el que existen.
      let terms = {
        source: 'unknown' as 'kepler_kdud' | 'manual' | 'unknown',
        branch: dto.source_branch ?? null,
        discount: null as number | null,
        credit_limit: null as number | null,
        payment_days: null as number | null,
        name: null as string | null,
      };
      if (erpCode) {
        const found = await trx.raw(
          `
          SELECT name, credit_limit, payment_days, discount_1_pct
          FROM analytics.v_erp_wholesale_customers
          WHERE customer_code = :code AND sucursal = :branch
          `,
          { code: erpCode, branch: dto.source_branch },
        );
        if (!found.rows.length) {
          throw new NotFoundException(
            `El cliente ${erpCode} no existe en el padrón de mayoreo de la sucursal ${dto.source_branch}.`,
          );
        }
        const r = found.rows[0];
        terms = {
          source: 'kepler_kdud',
          branch: String(dto.source_branch),
          // NULL se queda NULL: "sin descuento configurado" no es "0% de descuento" hasta que
          // alguien lo verifique. El 0 lo dibujaría como una decisión que nadie tomó (ADR-056).
          discount: r.discount_1_pct === null ? null : Number(r.discount_1_pct),
          credit_limit: r.credit_limit === null ? null : Number(r.credit_limit),
          payment_days: r.payment_days === null ? null : Number(r.payment_days),
          name: r.name,
        };
      }

        // Folio atómico, mismo patrón que commercial.order_sequences: el UPSERT de Postgres
        // garantiza que dos transacciones concurrentes obtengan valores distintos.
        const seq = await trx.raw(
          `
          INSERT INTO commercial.quote_sequences (tenant_id, year, current_value)
          VALUES (:tenant_id, :year, 1)
          ON CONFLICT (tenant_id, year) DO UPDATE
            SET current_value = commercial.quote_sequences.current_value + 1,
                updated_at = now()
          RETURNING current_value
          `,
          { tenant_id: tenantId, year },
        );
        const n = seq.rows[0].current_value as number;
        const code = `COT-${year}-${String(n).padStart(5, '0')}`;

        // La vigencia se resuelve en JS, no en SQL. Hacerlo con `CURRENT_DATE + :param` costó
        // dos errores de Postgres seguidos: 42725 (operador ambiguo: date + int o + interval?)
        // y, al castear el parámetro, 42P18 (knex no resuelve un binding nombrado pegado a `::`).
        // Un parámetro menos y cero aritmética de fechas en el SQL.
        const validUntil =
          dto.valid_until && /^\d{4}-\d{2}-\d{2}$/.test(dto.valid_until)
            ? dto.valid_until
            : new Date(Date.now() + DEFAULT_VALIDITY_DAYS * 86400000).toISOString().slice(0, 10);

        const inserted = await trx.raw(
          `
          INSERT INTO commercial.quotes (
            tenant_id, code, customer_id, erp_customer_code, erp_customer_name,
            contact_name, contact_phone, contact_email,
            origin, user_id, warehouse_id, price_list_id, status,
            quote_date, valid_until, customer_request, notes, internal_notes,
            source_branch, terms_source, terms_discount_pct, terms_credit_limit, terms_payment_days,
            created_by, updated_by
          ) VALUES (
            :tenant_id, :code, :customer_id, :erp_code, :erp_name,
            :contact_name, :contact_phone, :contact_email,
            :origin, :user_id, :warehouse_id, :price_list_id, 'draft',
            CURRENT_DATE,
            :valid_until::date,
            :customer_request, :notes, :internal_notes,
            :branch, :terms_source, :discount, :credit_limit, :payment_days,
            :user_id, :user_id
          )
          RETURNING id, code, status, to_char(valid_until,'YYYY-MM-DD') AS valid_until,
                    erp_customer_code, erp_customer_name, source_branch,
                    terms_source, terms_discount_pct, terms_credit_limit, terms_payment_days
          `,
          {
            tenant_id: tenantId,
            code,
            customer_id: dto.customer_id ?? null,
            erp_code: erpCode,
            erp_name: terms.name,
            contact_name: dto.contact_name ?? null,
            contact_phone: dto.contact_phone ?? null,
            contact_email: dto.contact_email ?? null,
            origin,
            user_id: userId,
            warehouse_id: dto.warehouse_id ?? null,
            price_list_id: dto.price_list_id ?? null,
            valid_until: validUntil,
            customer_request: dto.customer_request ?? null,
            notes: dto.notes ?? null,
            internal_notes: dto.internal_notes ?? null,
            branch: terms.branch,
            terms_source: terms.source,
            discount: terms.discount,
            credit_limit: terms.credit_limit,
            payment_days: terms.payment_days,
          },
        );

        this.logger.log(`Cotización creada ${code} (origin=${origin})`);
        return inserted.rows[0];
    });
  }

  /**
   * Cancela una cotización. Cancelar NO es rechazar: rechazada = el cliente dijo que no;
   * cancelada = la dimos de baja nosotros. Se distinguen porque miden cosas distintas
   * (una es tasa de conversión, la otra es ruido operativo).
   */
  async cancel(id: string, reason: string) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('Cancelar exige motivo: sin motivo no se puede medir después.');
    }
    const userId = this.tenantCtx.get()?.userId;

    return this.tk.run(async (knex) => {
      const current = await knex('commercial.quotes').where({ id }).first('status', 'code');
      if (!current) throw new NotFoundException('Cotización no encontrada');
      if (current.status === 'accepted') {
        throw new ConflictException(
          'La cotización ya fue aceptada y tiene pedido: cancelá el pedido, no la cotización.',
        );
      }
      if (current.status === 'cancelled') {
        throw new ConflictException('La cotización ya estaba cancelada.');
      }

      const updated = await knex.raw(
        `
        UPDATE commercial.quotes
           SET status = 'cancelled',
               cancelled_at = now(),
               close_reason = :reason,
               updated_at = now(),
               updated_by = :user_id
         WHERE id = :id
        RETURNING id, code, status
        `,
        { id, reason: reason.trim(), user_id: userId },
      );
      return updated.rows[0];
    });
  }
}
