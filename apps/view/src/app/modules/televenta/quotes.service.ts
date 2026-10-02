import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[E.12]` — Cotizaciones de mayoreo (submódulo de Telemarketing).
 *
 * Wrapper del backend `commercial/quotes`. No guarda estado: los componentes son dueños de su
 * señal. Mismo criterio que `TeleventaService`.
 */

export type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired' | 'cancelled';
export type QuoteOrigin = 'telemarketing' | 'route_visit' | 'counter' | 'portal';

export interface QuoteListRow {
  id: string;
  code: string;
  status: QuoteStatus;
  origin: QuoteOrigin;
  customer_id: string | null;
  customer_code: string | null;
  recipient_name: string;
  quote_date: string;
  valid_until: string;
  days_to_expiry: number;
  total: number;
  currency: string;
  line_count: number;
  unmatched_count: number;
  order_id: string | null;
  order_code: string | null;
  created_at: string;
  user_id: string;
  created_by_username: string | null;
}

export interface QuotesSummary {
  by_status: Record<QuoteStatus, number>;
  open_amount: number;
  open_count: number;
  expiring_soon_count: number;
  overdue_count: number;
}

/** Condiciones de un cliente de mayoreo EN UNA SUCURSAL. Difieren entre sucursales. */
export interface WholesaleBranchTerms {
  sucursal: string;
  credit_limit: number | string | null;
  payment_days: number | null;
  discount_1_pct: number | string | null;
  discount_2_pct: number | string | null;
  zone_code: string | null;
  group_code: string | null;
  salesperson_code?: string | null;
}

export interface WholesaleCustomer {
  customer_code: string;
  name: string;
  phone: string | null;
  rfc: string | null;
  address_1: string | null;
  state: string | null;
  branches: WholesaleBranchTerms[];
  /** true = sus condiciones NO son iguales en todas las sucursales. La pantalla lo dice. */
  terms_vary_by_branch: boolean;
}

export interface QuotesPage {
  rows: QuoteListRow[];
  total: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `[COT.1b]` Renglones. El motor vive en el servidor desde COT.1 y NINGUNA pantalla lo llamaba.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Peldaño de la escalera del ERP. `base` es la unidad en la que el ERP publica el precio. */
export type Rung = 'base' | 'pack' | 'box';

/** Un paso del cálculo: qué le hizo al precio y con qué fuente. Es lo que lo vuelve explicable. */
export interface PriceStep {
  step: string;
  source: string;
  detail: string;
  before: number | null;
  after: number | null;
}

/**
 * Lo que devuelve el motor por un renglón.
 *
 * ⛔ El precio SIEMPRE lo pone el servidor. La pantalla manda qué y cuánto, nunca a cuánto:
 * el vendedor no puede inventar un descuento (decisión de Dirección, 2026-09-22), y los
 * endpoints ni siquiera aceptan `unit_price` en el body.
 */

/**
 * Un producto cotizable en la sucursal de la cotización, derivado de la MISMA vista que preci­a
 * (`analytics.v_label_prices`). El `piece_price` que trae es de referencia para reconocer el
 * producto en la lista — el precio que vale es el que devuelve `pricePreview` con la cantidad
 * y el peldaño puestos.
 */
export interface QuoteCatalogRow {
  sku: string;
  name: string | null;
  content: string | null;
  barcode: string | null;
  unit_base: string | null;
  piece_price: number | null;
  pack_size: number | null;
  box_size: number | null;
  /** Rótulo del ERP de la unidad mayor: `CJA`, `BTO` (bulto) o `CUB` (cubeta). NULL = no declara. */
  box_label: string | null;
  sold_by_kg: boolean;
}

// Las funciones de unidades viven en `quote-units.ts` (sin Angular, se prueban solas).
export * from './quote-units';

export interface PricedLine {
  sku: string;
  product_id: string | null;
  name: string | null;
  branch: string;
  rung: Rung;
  unit_label: string | null;
  /** Unidades base por peldaño. `null` en la base o cuando no se pudo resolver — nunca 1 de relleno. */
  unit_factor: number | null;
  quantity: number;
  list_price: number | null;
  /** `null` = no se pudo cotizar. **Nunca 0**: un cero se leería como "no cuesta nada" (ADR-056). */
  unit_price: number | null;
  price_source: string;
  line_total: number | null;
  tax_rate: number;
  tax_basis: string;
  availability: string;
  applied: PriceStep[];
  not_applied: { mechanism: string; reason: string }[];
  /** Escalón de mayoreo / volumen configurado en el ERP */
  volume_tier?: { min_qty: number; price: number } | null;
  free_goods: { sku: string; quantity: number; unit_label: string | null; product_id: string | null } | null;
  unpriced_reason: string | null;
  warnings: string[];
}

export interface AddLineResult {
  quote_id: string;
  lines: number;
  priced: PricedLine | null;
}

/** Un renglón tal como lo devuelve `getOne`. `ql.*` más el nombre y el descuento derivado. */
export interface QuoteLine {
  id: string;
  line_number: number;
  product_id: string | null;
  product_name: string | null;
  /**
   * SKU real del catálogo. ⚠️ NO usar `requested_text` para esto: es NULL en todo renglón que
   * casó con el catálogo (sólo guarda lo que el cliente escribió cuando NO casó), así que
   * usarlo como SKU imprimía "ART" en el entregable.
   */
  product_sku: string | null;
  product_content: string | null;
  product_barcode: string | null;
  /** Unidad BASE del producto en la sucursal de la cotización (rotula el desglose "12 PAQ"). */
  product_unit_base?: string | null;
  product_sold_by_kg?: boolean | null;
  /** Unidades base del paquete del producto (desglosa la caja en su unidad del medio, COT.17). */
  product_pack_size?: number | string | null;
  requested_text: string | null;
  quantity: number | string;
  unit_price: number | string | null;
  list_price: number | string | null;
  line_total: number | string;
  price_source: string;
  availability: string;
  parent_line_number: number | null;
  discount_pct: number | string | null;
  notes: string | null;
  /** `[COT.1b]` El peldaño en que se cotizó. `null` = no se registró (renglón viejo). NO es pieza. */
  qty_unit: string | null;
  qty_factor: number | string | null;
  qty_factor_source: string | null;
}

export interface QuoteDetail {
  id: string;
  code: string;
  status: QuoteStatus;
  origin: QuoteOrigin;
  recipient_name: string;
  customer_code: string | null;
  erp_customer_code: string | null;
  /** Nombre del cliente de mayoreo, congelado al crear. Es lo que rotula el entregable. */
  erp_customer_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  salesperson_code: string | null;
  salesperson_name: string | null;
  source_branch: string | null;
  terms_source: string;
  terms_discount_pct: number | string | null;
  terms_credit_limit: number | string | null;
  terms_payment_days: number | null;
  quote_date: string;
  valid_until: string;
  days_to_expiry: number;
  subtotal: number | string;
  tax_total: number | string;
  total: number | string;
  currency: string;
  customer_request: string | null;
  notes: string | null;
  order_code: string | null;
  created_by_username: string | null;
  lines: QuoteLine[];
}

@Injectable({ providedIn: 'root' })
export class QuotesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/quotes`;

  list(opts: {
    status?: string;
    origin?: string;
    mine?: boolean;
    search?: string;
    limit?: number;
    offset?: number;
  } = {}): Observable<QuotesPage> {
    let params = new HttpParams();
    if (opts.status) params = params.set('status', opts.status);
    if (opts.origin) params = params.set('origin', opts.origin);
    if (opts.mine) params = params.set('mine', 'true');
    if (opts.search) params = params.set('search', opts.search);
    if (opts.limit != null) params = params.set('limit', String(opts.limit));
    if (opts.offset != null) params = params.set('offset', String(opts.offset));
    return this.http.get<QuotesPage>(this.base, { params });
  }

  summary(mine = false): Observable<QuotesSummary> {
    let params = new HttpParams();
    if (mine) params = params.set('mine', 'true');
    return this.http.get<QuotesSummary>(`${this.base}/summary`, { params });
  }

  getOne(id: string): Observable<QuoteDetail> {
    return this.http.get<QuoteDetail>(`${this.base}/${id}`);
  }

  /**
   * `[COT.1c]` Qué se puede cotizar en esa sucursal. La sucursal es obligatoria: el precio vive
   * por `(sucursal, sku)`, así que un catálogo sin plaza ofrecería cosas que no se pueden preciar.
   */
  searchCatalog(branch: string, search: string, limit = 30): Observable<QuoteCatalogRow[]> {
    const params = new HttpParams()
      .set('branch', branch)
      .set('search', search)
      .set('limit', String(limit));
    return this.http.get<QuoteCatalogRow[]>(`${this.base}/catalog`, { params });
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // `[COT.1b]` Renglones
  // ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Cotiza un renglón SIN guardarlo. Es lo que deja ver el precio —y por qué— antes de
   * ensuciar la cotización. No exige `GESTIONAR`: mirar un precio no es ofrecerlo.
   */
  pricePreview(input: { branch: string; sku: string; quantity: number; rung?: Rung }): Observable<PricedLine> {
    return this.http.post<PricedLine>(`${this.base}/price-preview`, input);
  }

  /** Agrega un renglón. Con `sku` se cotiza; con `requested_text` se guarda lo que el cliente pidió y no casó. */
  addLine(
    quoteId: string,
    input: { sku?: string; requested_text?: string; quantity: number; rung?: Rung },
  ): Observable<AddLineResult> {
    return this.http.post<AddLineResult>(`${this.base}/${quoteId}/lines`, input);
  }

  /**
   * Corrige la cantidad conservando el LUGAR del renglón en la lista.
   * ⭐ Re-tarifica: subir la cantidad puede cruzar el umbral de volumen o activar una promo del
   * ERP, y el precio nuevo es justo lo que hay que ver. (El PATCH de pedidos NO hace esto.)
   */
  updateLine(quoteId: string, lineId: string, input: { quantity: number; rung?: Rung }): Observable<AddLineResult> {
    return this.http.patch<AddLineResult>(`${this.base}/${quoteId}/lines/${lineId}`, input);
  }

  /** Quita un renglón. Se lleva sus renglones de regalo: un regalo huérfano parece un error. */
  removeLine(quoteId: string, lineId: string): Observable<{ quote_id: string; removed: number }> {
    return this.http.delete<{ quote_id: string; removed: number }>(`${this.base}/${quoteId}/lines/${lineId}`);
  }

  /**
   * Padrón de MAYOREO (`C####`) derivado de `kepler_ods.kdud`.
   * Cada cliente trae el arreglo de sus sucursales porque sus condiciones difieren entre ellas.
   */
  searchWholesaleCustomers(search: string, limit = 20): Observable<WholesaleCustomer[]> {
    let params = new HttpParams().set('limit', String(limit));
    if (search) params = params.set('search', search);
    return this.http.get<WholesaleCustomer[]>(`${this.base}/wholesale-customers`, { params });
  }

  create(payload: {
    customer_id?: string;
    erp_customer_code?: string;
    source_branch?: string;
    contact_name?: string;
    contact_phone?: string;
    contact_email?: string;
    origin?: QuoteOrigin;
    /** Opcional desde [E.12.1]: en mayoreo el ancla es `source_branch`, no la ruta. */
    warehouse_id?: string;
    price_list_id?: string;
    valid_until?: string;
    customer_request?: string;
    notes?: string;
    salesperson_code?: string;
    salesperson_name?: string;
  }): Observable<{ id: string; code: string; status: QuoteStatus; valid_until: string }> {
    return this.http.post<{ id: string; code: string; status: QuoteStatus; valid_until: string }>(
      this.base,
      payload,
    );
  }

  /** Lista los vendedores de Kepler asignados a una sucursal (?branch=01). */
  listSalespersons(branch: string): Observable<Array<{ code: string; name: string }>> {
    const params = new HttpParams().set('branch', branch);
    return this.http.get<Array<{ code: string; name: string }>>(`${this.base}/salespersons`, { params });
  }

  cancel(id: string, reason: string): Observable<{ id: string; code: string; status: QuoteStatus }> {
    return this.http.post<{ id: string; code: string; status: QuoteStatus }>(
      `${this.base}/${id}/cancel`,
      { reason },
    );
  }
}
