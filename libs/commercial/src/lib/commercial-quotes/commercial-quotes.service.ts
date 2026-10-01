import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService, applySmartSearch } from '@megadulces/platform-core';

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

/** Una fila de `analytics.v_erp_wholesale_customers`: el cliente EN UNA sucursal. */
export interface WholesaleBranchTerms {
  sucursal: string;
  credit_limit: string | null;
  payment_days: number | null;
  discount_1_pct: string | null;
  discount_2_pct: string | null;
  zone_code: string | null;
  group_code: string | null;
  salesperson_code?: string | null;
}

export interface WholesaleCustomerRow {
  customer_code: string;
  name: string;
  phone: string | null;
  rfc: string | null;
  address_1: string | null;
  state: string | null;
  branches: WholesaleBranchTerms[];
  /** true = sus condiciones NO son iguales en todas las sucursales. */
  terms_vary_by_branch: boolean;
}

/**
 * Un producto **cotizable en esa sucursal**, tal como lo ve el motor de precio.
 *
 * ⛔ La fuente es `analytics.v_label_prices`, NO `catalog.products`, y no es un detalle: el motor
 * de cotizaciones preci­a por `(sucursal, sku)` contra esa vista. Un buscador que leyera el
 * catálogo de la Suite ofrecería productos que la previa no puede preciar, y el operador se
 * comería un "el ERP no publica precio para X en la sucursal Y" DESPUÉS de elegirlo. Acá sólo
 * sale lo que se puede cotizar.
 */
export interface QuoteCatalogRow {
  sku: string;
  name: string | null;
  /** Gramaje parseado del nombre (`500 g`), cuando la etiqueta lo trae. */
  content: string | null;
  barcode: string | null;
  /** Unidad BASE del ERP en esa sucursal: `PZA`, `PAQ`, `CJA`, `KG`. */
  unit_base: string | null;
  /** Precio de la unidad base. NULL = el ERP no lo publica; **nunca 0** (ADR-056). */
  piece_price: number | null;
  pack_size: number | null;
  box_size: number | null;
  /**
   * Rótulo del ERP de la unidad mayor: `CJA`, o `BTO`/`CUB` cuando el producto no tiene caja
   * (granel y cubeta). NULL = el ERP no declara unidad mayor. Es lo que rotula el botón.
   */
  box_label: string | null;
  sold_by_kg: boolean;
}

/** Cabecera + renglones. Las columnas se devuelven tal cual salen del SELECT. */
export interface QuoteDetail extends Record<string, unknown> {
  id: string;
  code: string;
  status: QuoteStatus;
  lines: Array<Record<string, unknown>>;
}

/** Lo que devuelve crear una cotización: su identidad y las condiciones congeladas. */
export interface CreatedQuote {
  id: string;
  code: string;
  status: QuoteStatus;
  valid_until: string;
  erp_customer_code: string | null;
  erp_customer_name: string | null;
  source_branch: string | null;
  terms_source: string;
  terms_discount_pct: string | null;
  terms_credit_limit: string | null;
  terms_payment_days: number | null;
}

export interface CancelledQuote {
  id: string;
  code: string;
  status: QuoteStatus;
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
          -- [COT.1b] "Sin casar" estaba definido DOS veces y coincidían por casualidad: el motor
          -- escribe availability='unmatched' (quote-pricing.service.ts) y acá se contaba por
          -- product_id IS NULL. Manda la COLUMNA, que es la que el motor afirma; el
          -- product_id IS NULL queda como red por si un renglón viejo nació antes de que el motor
          -- existiera. Una sola pregunta, un solo lugar donde cambiarla.
          -- (Sin acentos graves: esto vive dentro de un template literal.)
          SELECT count(*) AS line_count,
                 count(*) FILTER (
                   WHERE ql.availability = 'unmatched' OR ql.product_id IS NULL
                 ) AS unmatched_count
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
  async getOne(id: string): Promise<QuoteDetail> {
    return this.tk.run(async (knex) => {
      const head = await knex.raw(
        `
        SELECT
          q.*,
          to_char(q.quote_date,  'YYYY-MM-DD') AS quote_date,
          to_char(q.valid_until, 'YYYY-MM-DD') AS valid_until,
          (q.valid_until - CURRENT_DATE)::int  AS days_to_expiry,
          c.code AS customer_code,
          -- ⚠️ erp_customer_name VA EN EL COALESCE. Un cliente de mayoreo del ERP no tiene fila
          -- en commercial.customers (customer_id NULL) ni contact_name, así que sin él esto
          -- devolvía NULL y el entregable salía rotulado "CLIENTE" con sólo el código —medido en
          -- prod sobre COT-2026-00004, que tiene "GRUPO ORTIZ VERA" guardado. La consulta de
          -- list() ya lo resolvía bien: eran dos reglas distintas para el mismo dato.
          COALESCE(c.name, q.erp_customer_name, q.contact_name) AS recipient_name,
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
          -- El SKU y los descriptivos que el entregable necesita para ser el MISMO documento
          -- que imprime la pantalla de alta. La columna requested_text es NULL en todo renglón
          -- que casó con el catálogo (así lo escribe el motor), así que sin p.sku el PDF del
          -- detalle imprimía "ART" en cada fila teniendo el SKU a un JOIN de distancia.
          p.sku AS product_sku,
          lp.content  AS product_content,
          lp.barcode  AS product_barcode,
          -- El descuento se DERIVA, no se guarda: guardado aparte se desincroniza del precio
          -- en cuanto alguien edita uno de los dos.
          CASE
            WHEN ql.list_price IS NULL OR ql.list_price = 0 OR ql.unit_price IS NULL THEN NULL
            ELSE round(((ql.list_price - ql.unit_price) / ql.list_price * 100)::numeric, 2)
          END AS discount_pct
        FROM commercial.quote_lines ql
        LEFT JOIN catalog.products p ON p.tenant_id = ql.tenant_id AND p.id = ql.product_id
        -- MISMA fuente que el buscador de la pantalla de alta (v_label_prices por sucursal), para
        -- que los dos entregables describan el producto igual. Sólo se leen descriptivos
        -- (contenido y EAN): el PRECIO del papel es el que quedó congelado en el renglón, nunca
        -- el de hoy — re-precificar al imprimir cambiaría una cotización ya entregada.
        LEFT JOIN analytics.v_label_prices lp
               ON lp.sucursal = :branch AND lp.sku = btrim(p.sku)
        WHERE ql.tenant_id = public.current_tenant_id() AND ql.quote_id = :id
        ORDER BY ql.line_number
        `,
        // La sucursal sale de la cabecera ya leída: es la plaza con la que se armó la cotización,
        // no la que el usuario tenga elegida al abrir el detalle.
        { id, branch: (head.rows[0].source_branch as string) ?? '01' },
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
  async searchWholesaleCustomers(search: string, limit = 20): Promise<WholesaleCustomerRow[]> {
    const term = (search || '').trim();
    const n = Math.min(Math.max(Number(limit) || 20, 1), 50);

    return this.tk.run(async (knex) => {
      // Búsqueda por PALABRAS (COT.16): cada palabra tiene que aparecer en el código, el nombre
      // o el RFC, en cualquier orden ("ortiz vera" encuentra "GRUPO ORTIZ VERA"). Estricta, sin
      // trigramas: el operador escribe lo que ve en el padrón.
      const hit = knex('analytics.v_erp_wholesale_customers')
        .distinct('customer_code')
        .orderBy('customer_code')
        .limit(n);
      applySmartSearch(hit, term, { columns: ['customer_code', 'name', 'rfc'], fuzzy: false });

      const res = await knex.raw(
        `
        WITH hit AS ?
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
              'group_code',     v.group_code,
              'salesperson_code', v.salesperson_code
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
        [hit],
      );
      return res.rows;
    });
  }

  /**
   * `[COT.1d]` — Vendedores de Kepler asignados a la sucursal.
   * La fuente es `kepler_ods.kduv`, el padrón de vendedores por sucursal del ERP.
   */
  async listSalespersons(branch: string): Promise<Array<{ code: string; name: string }>> {
    const suc = (branch || '').trim();
    if (!suc) return [];
    return this.tk.run(async (knex) => {
      const res = await knex.raw(
        `SELECT btrim(c2) AS code, btrim(c3) AS name
           FROM kepler_ods.kduv
          WHERE sucursal = :branch
            AND btrim(coalesce(c2, '')) <> ''
            AND btrim(coalesce(c3, '')) <> ''
          ORDER BY btrim(c3) ASC`,
        { branch: suc },
      );
      return res.rows;
    });
  }

  /**
   * `[COT.1c]` — El catálogo de la cotización: qué se puede cotizar en ESA sucursal.
   *
   * Sin esto el editor exige que el operador se sepa el SKU de memoria — que era el estado real
   * hasta acá, y por eso el buscador no es cosmético: es la diferencia entre poder cotizar y no.
   *
   * ⛔ **La sucursal es obligatoria.** Un producto no es "cotizable" en abstracto: `v_label_prices`
   * publica precio por `(sucursal, sku)`, y hay SKUs con precio en una plaza y sin precio en otra.
   * Buscar sin sucursal devolvería un catálogo que después no se puede preciar.
   *
   * Tres formas de llegar al renglón, en este orden de confianza:
   *   · el SKU exacto (lo que el operador ya sabía)     → primero
   *   · el código de barras completo (viene del lector) → después
   *   · el prefijo del SKU, y el nombre                 → al final
   *
   * ⚠️ El orden está **desempatado hasta el final** (`name`, `sku`): sin desempate, dos corridas
   * con los mismos datos pueden devolver filas distintas y no hay forma de demostrar que un
   * cambio no movió nada.
   */
  async searchCatalog(branch: string, search: string, limit = 30): Promise<QuoteCatalogRow[]> {
    const suc = (branch || '').trim();
    if (!suc) throw new BadRequestException('Falta la sucursal: un producto sólo es cotizable en una plaza concreta.');

    const term = (search || '').trim();
    const n = Math.min(Math.max(Number(limit) || 30, 1), 50);

    return this.tk.run(async (knex) => {
      // Búsqueda por PALABRAS (COT.16): cada palabra tiene que aparecer en el nombre o el SKU,
      // en cualquier orden ("altos rollo 25 35" encuentra "ALTOS ROLLO 25X35 ..."). Estricta,
      // sin trigramas. El código de barras va APARTE y por igualdad exacta: es lo que manda el
      // lector, y meterlo al substring haría que "25" pegara con medio catálogo de códigos.
      const inner = knex('analytics.v_label_prices')
        .select('sku', 'name', 'content', 'barcode', 'unit_base', 'piece_price', 'pack_size', 'box_size', 'box_price', 'sold_by_kg')
        .where('sucursal', suc)
        .orderByRaw(
          `CASE WHEN upper(sku) = upper(?) THEN 0
                WHEN barcode = ?          THEN 1
                WHEN sku ILIKE ?          THEN 2
                ELSE 3 END,
           name NULLS LAST,
           sku`,
          [term, term, `${term}%`],
        )
        .limit(n);
      if (term) {
        inner.andWhere((g) => {
          g.where('barcode', term).orWhere((porPalabras) =>
            applySmartSearch(porPalabras, term, { columns: ['name', 'sku'], fuzzy: false }),
          );
        });
      }

      const res = await knex.raw(
        // La unidad mayor se completa con BTO/CUB cuando no hay caja, o el botón diría "Caja" y
        // la previa "Bulto".
        //
        // ⚠️ **Acá NO se lee `analytics.v_label_presentations`, que es la fuente del precio.**
        // Motivo medido (2026-10-01): esa vista no empuja el filtro y cuesta ~3.6 s por lectura
        // (seq scan de 84k `kdii` + 379k `kdpv_prod_util`); el buscador del catálogo responde hoy
        // en ~50 ms y pasaría a segundos. Acá sólo se decide **la etiqueta del botón** — el precio
        // y el factor que se cobran salen siempre de `QuotePricingService.ladder`, que sí la lee.
        // La coincidencia entre ambos criterios está MEDIDA y la vigila `http-quote-pricing-test.js`
        // (bloque 5c). Medido 2026-10-01 sobre las 84,340 filas sucursal×sku: **182 en desacuerdo,
        // las 182 en la dirección segura** — el botón se queda mudo donde la escalera sí tiene
        // peldaño (son las filas que `v_label_presentations` rellena y `v_label_prices` no trae) —
        // y **0 en la peligrosa**, que sería ofrecer un botón sin precio detrás. El candado exige
        // que ese 0 siga en 0; el 182 se declara, no se esconde.
        `
        SELECT v.sku, v.name, v.content, v.barcode, v.unit_base, v.piece_price, v.pack_size,
               COALESCE(v.box_size, m.factor) AS box_size,
               CASE WHEN v.box_size IS NOT NULL OR v.box_price IS NOT NULL THEN 'CJA'
                    ELSE m.unidad END AS box_label,
               v.sold_by_kg
          FROM :inner v
          LEFT JOIN LATERAL (
            SELECT s.unidad, s.factor
              FROM kepler_ods.kdii k
              CROSS JOIN LATERAL (VALUES
                (upper(btrim(k.c83)), floor(k.c84)::int, NULLIF(k.c92, 0), 1),
                (upper(btrim(k.c80)), floor(k.c81)::int, NULLIF(k.c91, 0), 2)
              ) AS s(unidad, factor, price, prioridad)
             WHERE v.box_size IS NULL AND v.box_price IS NULL
               AND btrim(k.sucursal) = :branch AND btrim(k.c1) = v.sku
               AND s.unidad IN ('BTO', 'CUB') AND s.factor > 1 AND s.price IS NOT NULL
             ORDER BY s.prioridad
             LIMIT 1
          ) m ON true
         ORDER BY
           CASE WHEN upper(v.sku) = upper(:term) THEN 0
                WHEN v.barcode = :term          THEN 1
                WHEN v.sku ILIKE :pre           THEN 2
                ELSE 3 END,
           v.name NULLS LAST,
           v.sku
        `,
        { inner, branch: suc, term, pre: `${term}%` },
      );

      // Los `numeric` de Postgres llegan como STRING por JSON (GOTCHAS §6): el tipo TS miente
      // si no se convierten acá. Y un ausente se queda NULL, nunca 0 (ADR-056).
      const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
      return (res.rows as Record<string, unknown>[]).map((r) => ({
        sku: String(r['sku']),
        name: (r['name'] as string) ?? null,
        content: (r['content'] as string) ?? null,
        barcode: (r['barcode'] as string) ?? null,
        unit_base: (r['unit_base'] as string) ?? null,
        piece_price: num(r['piece_price']),
        pack_size: num(r['pack_size']),
        box_size: num(r['box_size']),
        box_label: (r['box_label'] as string) ?? null,
        sold_by_kg: r['sold_by_kg'] === true,
      }));
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
    salesperson_code?: string | null;
    salesperson_name?: string | null;
  }): Promise<CreatedQuote> {
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
    try {
      return await this.tk.run(async (trx) => {
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
          const anyBranch = await trx.raw(
            `
            SELECT name
            FROM analytics.v_erp_wholesale_customers
            WHERE customer_code = :code
            LIMIT 1
            `,
            { code: erpCode },
          );
          if (!anyBranch.rows.length) {
            throw new NotFoundException(`El cliente ${erpCode} no existe en el padrón de mayoreo.`);
          }
          terms = {
            source: 'kepler_kdud',
            branch: String(dto.source_branch),
            discount: null,
            credit_limit: null,
            payment_days: null,
            name: anyBranch.rows[0].name,
          };
        } else {
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
            salesperson_code, salesperson_name,
            created_by, updated_by
          ) VALUES (
            :tenant_id, :code, :customer_id, :erp_code, :erp_name,
            :contact_name, :contact_phone, :contact_email,
            :origin, :user_id, :warehouse_id, :price_list_id, 'draft',
            CURRENT_DATE,
            :valid_until::date,
            :customer_request, :notes, :internal_notes,
            :branch, :terms_source, :discount, :credit_limit, :payment_days,
            :salesperson_code, :salesperson_name,
            :user_id, :user_id
          )
          RETURNING id, code, status, to_char(valid_until,'YYYY-MM-DD') AS valid_until,
                    erp_customer_code, erp_customer_name, source_branch,
                    terms_source, terms_discount_pct, terms_credit_limit, terms_payment_days,
                    salesperson_code, salesperson_name
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
            internal_notes: [
              dto.salesperson_code
                ? `Vendedor asignado: ${dto.salesperson_name ? `${dto.salesperson_name} (${dto.salesperson_code})` : dto.salesperson_code}`
                : '',
              dto.internal_notes,
            ]
              .filter(Boolean)
              .join('\n') || null,
            branch: terms.branch,
            terms_source: terms.source,
            discount: terms.discount,
            credit_limit: terms.credit_limit,
            payment_days: terms.payment_days,
            salesperson_code: dto.salesperson_code ?? null,
            salesperson_name: dto.salesperson_name ?? null,
          },
        );

        this.logger.log(`Cotización creada ${code} (origin=${origin})`);
        const row = inserted.rows[0];
        if (dto.salesperson_code) {
          row.salesperson_code = dto.salesperson_code;
          row.salesperson_name = dto.salesperson_name || null;
        }
        return row;
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === '25006' || code === '42501') {
        throw new ServiceUnavailableException(
          'Base de datos en modo solo lectura para este usuario (conexión de desarrollo local). La persistencia de cotizaciones requiere permisos de escritura (app_runtime/producción).',
        );
      }
      throw err;
    }
  }

  /**
   * Cancela una cotización. Cancelar NO es rechazar: rechazada = el cliente dijo que no;
   * cancelada = la dimos de baja nosotros. Se distinguen porque miden cosas distintas
   * (una es tasa de conversión, la otra es ruido operativo).
   */
  async cancel(id: string, reason: string): Promise<CancelledQuote> {
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
