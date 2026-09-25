import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { Freshness } from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** CXC (ADR-048) — cliente de Cartera de clientes / Partidas vivas (CxC). */

export interface AgingBucket { por_vencer: number; d0_30: number; d31_60: number; d61_90: number; d90_plus: number }

/**
 * ⭐ `[CXC.25]` **A quién le estás cobrando.** De los $57,780,190.86 que la pantalla publica,
 * **$26,583,657.82 (46.0%) son ocho cuentas que no son clientes** — `30-73 TLMKT Morelia
 * Abastos`, `10-00 P.V. Padre Hidalgo Piso`… Plaza contra plaza. Eso no se cobra por teléfono, y
 * contabilidad no lo reconoce como cartera: su balanza dice $9.1M.
 */
export type CuentaKind = 'cliente_final' | 'interno' | 'ruta';
/** Qué señal decidió: el código lo afirmó, el nombre lo rescató, o nadie dijo nada. */
export type CuentaKindSource = 'codigo' | 'nombre' | 'ninguno';
export interface CuentaOpt { code: CuentaKind; label: string }
export type PorTipoCuenta = Record<CuentaKind, { saldo: number; vencido: number; clientes: number }>;

export interface CarteraCliente {
  sucursal: string; cliente_code: string; cliente_nombre: string; rfc: string | null; vendedor: string | null;
  cuenta_kind: CuentaKind; cuenta_kind_source: CuentaKindSource;
  /** `[CXC.20]` Nombre del vendedor resuelto por (sucursal, código) contra `kduv`. */
  vendedor_nombre: string | null;
  grupo: string | null; zona: string | null; telefono: string | null;
  limite_credito: number | null; dias_credito: number | null; uso_linea: number | null; sobre_linea: boolean;
  saldo: number; vencido: number; n_partidas: number; n_saldadas: number; aging: AgingBucket;
  /** Parte del saldo que ningún documento explica (kdm5 aplicó más de lo que kdue justifica). */
  sin_documento: number;
  /** Saldo a favor del cliente (pagó de más / anticipo sin aplicar). */
  saldo_a_favor: number;
  /** Días promedio que tarda en pagar, medido sobre sus facturas ya saldadas. */
  dias_pago_prom: number | null; n_pagos: number;
}
/**
 * ⭐ `[CXC.20]` Opciones de filtro **derivadas del servidor**. La pantalla ya NO trae su propia
 * lista de sucursales: la que tenía se quedó en `01`..`06` y dejaba fuera de todo filtro la `00`
 * ($44.4M), la `07` y la `08` — el 78.5% de la cartera, sólo alcanzable eligiendo «Todas».
 */
export interface SucursalOpt {
  code: string;
  /** `código · nombre`, con el nombre de `commercial.warehouses`. */
  label: string;
  /**
   * `[CXC.26]` El nombre SOLO, para cuando hay que mostrar «La Piedad» y no «01 · La Piedad».
   * Partir el `label` por el «·» sería resolver un nombre parseando una etiqueta de presentación.
   * `null` = el código no está en el catálogo de almacenes.
   */
  nombre: string | null;
  /** El código existe en la cartera pero no en el catálogo de almacenes: se muestra pelado. */
  sin_catalogo: boolean;
}
export interface VendedorOpt { code: string; sucursal: string; label: string }
export interface CarteraFiltros { sucursales: SucursalOpt[]; grupos: string[]; zonas: string[]; vendedores: VendedorOpt[]; cuentas: CuentaOpt[] }

/** Lo que el desglose por documento no alcanza a explicar. Ver `CarteraResumen.sin_documento`. */
export interface SinDocumento { monto: number; clientes: number }

export interface CarteraResumen {
  hoy: string; saldo_total: number; vencido_total: number; pct_vencido: number; dso: number | null; ventas_90d: number; n_clientes: number;
  pago: { n: number; promedio: number; mediana: number; tarde_30d: number } | null;
  concentracion: { top10_pct: number; top10: { cliente_code: string; saldo: number }[] };
  proyeccion: { vencido: number; d0_7: number; d8_15: number; d16_30: number; d30_plus: number; sin_fecha: number };
  por_vendedor: { sucursal: string; vendedor: string; vendedor_nombre: string | null; saldo: number; vencido: number; n_clientes: number }[];
  por_zona: { zona: string; saldo: number; vencido: number }[];
  /** Los dos rollups reparten por DOCUMENTO: suman `saldo_total − sin_documento`, no `saldo_total`. */
  base_rollups: 'documento';
  sin_documento: SinDocumento;
}
export interface CarteraTendencia { fecha: string; saldo_total: number; vencido_total: number; n_clientes: number; pct_vencido: number }
export interface CarteraResp {
  hoy: string;
  /** Edad real del dato (carriles del ODS), no la hora en que respondió el servidor. ADR-056. */
  freshness: Freshness;
  kpi: {
    total_saldo: number; total_vencido: number; n_clientes: number; n_partidas: number;
    n_sobre_linea: number; total_a_favor: number; n_a_favor: number; aging: AgingBucket;
    sin_documento: SinDocumento;
    /** `[CXC.25]` El total partido por a quién le cobrás. Suma EXACTO `total_saldo`. */
    por_tipo: PorTipoCuenta;
  };
  clientes: CarteraCliente[]; total_clientes: number;
  /** `[CXC.20]` Viajan en la MISMA respuesta: una sola pasada, imposible que se contradigan. */
  resumen: CarteraResumen;
  filtros: CarteraFiltros;
}

/* ── `[CXC.26]` Cartera por DÍA — la agenda de cobranza ──────────────────────────────────── */

export interface PorDiaQuery {
  sucursal?: string; vendedor?: string; grupo?: string; zona?: string; cuenta?: string; search?: string;
}

/**
 * Tres estados, no un booleano `vencido`. «Vence hoy» no es ni una cosa ni la otra, y es
 * justamente el día que la cobranza tiene que mirar primero.
 */
export type DiaEstado = 'vencido' | 'hoy' | 'futuro';

export interface DiaCartera {
  fecha: string;
  /** ⭐ Lo emite el SERVIDOR. La pantalla NO vuelve a restar fechas: un `new Date()` local le
   *  cambiaría el día al equipo que esté en otra zona horaria. */
  estado: DiaEstado;
  /** Negativo = venció hace N días · 0 = hoy · positivo = vence en N días. */
  dias_offset: number;
  monto: number; docs: number; clientes: number;
}

/**
 * ⭐ Una FACTURA viva. El renglón del cliente se deriva sumando éstas, nunca al revés: «qué
 * facturas tiene vencidas» es la pregunta del que sale a cobrar, y un agregado no se desarma.
 *
 * Lleva sólo lo PROPIO de la factura; quién la debe está en `DiaClienteRef`, unido por `k`.
 */
export interface DiaDocumento {
  /** El vencimiento — el eje de la pantalla. */
  fecha: string;
  /** Negativo = venció hace N días · 0 = hoy · positivo = vence en N. Lo emite el SERVIDOR. */
  dias_offset: number;
  estado: DiaEstado;
  /** `sucursal|cliente_code`. La arma el servidor: si cada lado la construyera, el join
   *  fallaría en silencio el día que una cambie de forma. */
  k: string;
  folio_digital: string; doc_label: string;
  /** Fecha de emisión, para leer «se facturó el X y vencía el Y». */
  fecha_doc: string | null;
  importe: number;
  /** Lo que queda por cobrar de ESTA factura. Es lo que suma la agenda. */
  saldo: number;
}

/**
 * El cliente, UNA vez. Con los nombres repetidos en cada una de las 6,913 facturas la respuesta
 * pesaba 205 KB gzipeados; así son 131 KB — y el nombre vive en un solo lugar.
 */
export interface DiaClienteRef {
  k: string;
  sucursal: string;
  /** El NOMBRE de la plaza, no su número. `null` = el código no está en el catálogo de almacenes
   *  y la pantalla muestra el número: ocultarlo escondería dinero. */
  sucursal_nombre: string | null;
  cliente_code: string; cliente_nombre: string;
  telefono: string | null;
  /** Código de Kepler + nombre contra `kduk`. `zona: null` = el cliente no tiene zona asignada. */
  zona: string | null; zona_nombre: string | null;
  vendedor: string | null; vendedor_nombre: string | null;
  cuenta_kind: CuentaKind; dias_credito: number | null;
}

export interface ZonaCatalogo { code: string; nombre: string; ambigua: boolean }

/** Lo que la pantalla arma en memoria: un cliente con SUS facturas de un día. */
export interface ClienteDelDia {
  ref: DiaClienteRef;
  docs: DiaDocumento[];
  /** Suma de `docs` — o sea, la suma de sus propias facturas. No puede discrepar del desglose. */
  monto: number;
  /** Lo que el mismo cliente debe en OTROS días, para no llamarlo dos veces. */
  otros_dias_monto: number;
  otros_dias_docs: number;
}

/**
 * ⭐ Lo que el calendario NO puede mostrar, con su monto. El eje es `vencimiento`, que sólo
 * existe a nivel documento; el saldo canónico es el de `kdue` por cliente. La resta no tiene
 * fecha y **se declara, no se reparte a dedo** (ADR-056).
 */
export interface PorDiaCobertura {
  canonico: number; repartible: number; sin_documento: number; sin_vencimiento: number; clientes: number;
}

/**
 * ⚠️ **Viene la agenda COMPLETA, sin ventana.** Medido en prod: 292 días, 6,913 facturas y 1,307
 * clientes = 1,448 KB crudos = **131 KB gzipeados**, y pedir todo cuesta lo mismo que pedir un mes
 * (2.5 s, que es la pirámide de CTEs). Una ventana sólo habría comprado un botón de «ampliá para
 * ver el resto» sobre la mitad del dinero. Todos los drills son locales.
 */
export interface PorDiaResp {
  hoy: string;
  freshness: Freshness;
  dias: DiaCartera[];
  /** Las facturas, no un agregado. */
  documentos: DiaDocumento[];
  /** Los clientes, una vez cada uno; las facturas los referencian por `k`. */
  clientes: DiaClienteRef[];
  totales: {
    vencido: number; hoy: number; futuro: number;
    dias_vencidos: number; dias_futuros: number;
  };
  cobertura: PorDiaCobertura;
  filtros: CarteraFiltros;
  catalogos: { zonas: ZonaCatalogo[] };
}

export interface Aplicacion { tipo: string; label: string; folio: string; fecha: string | null; monto: number }
export interface Partida {
  doc_tipo: string; doc_label: string; doc_code: string; folio: string; folio_digital: string;
  fecha: string | null; vencimiento: string | null; importe: number; saldo_documento: number;
  /** Lo que dicen las aplicaciones de kdm5; difiere de `saldo_documento` si hubo abono sin ubicar. */
  saldo_kdm5: number;
  dias_vencido: number | null; vencida: boolean; estatus: string | null;
  /** Saldada = ya cobrada por completo; `pagada_el` = fecha de la última aplicación. */
  saldada: boolean; pagada_el: string | null; dias_pago: number | null;
  aplicaciones: Aplicacion[];
}
export interface CarteraDetalle {
  hoy: string;
  freshness: Freshness;
  cliente: { sucursal: string; cliente_code: string; cliente_nombre: string; rfc: string | null; vendedor: string | null; vendedor_nombre: string | null; grupo: string | null; zona: string | null; telefono: string | null; limite_credito: number | null; dias_credito: number | null };
  saldo: number; vencido: number;
  saldo_a_favor: number; sin_documento: number; dias_pago_prom: number | null; n_pagos: number;
  partidas: Partida[]; pagadas: number; importe_pagado: number;
  abonos: { doc_label: string; folio: string; fecha: string | null; importe: number }[];
  cobranza: { n: number; monto: number; ultimo: string | null; con_ficha: number; validados: number } | null;
  compromisos: Compromiso[];
}
export interface Compromiso { id: string; monto_prometido: number; fecha_promesa: string; estado: string; nota: string | null; created_by: string | null; created_at: string }

export interface CarteraQuery {
  sucursal?: string; cliente?: string; vendedor?: string; grupo?: string; zona?: string; cuenta?: string; from?: string; to?: string;
  incluir_saldados?: string; search?: string; sort?: 'saldo' | 'vencido'; limit?: number;
}

/** `[CXC.SKU.1]` Un renglón de documento que tocó el producto buscado. */
export interface RenglonProducto {
  folio_digital: string; sucursal: string; folio: string; doc_prefix: string;
  linea: number; sku: string; descripcion: string | null; unidad: string | null;
  cantidad: number; importe: number;
  /** `cargo` = factura · `abono` = nota de crédito o devolución. */
  naturaleza: 'cargo' | 'abono';
  fecha: string | null;
}

export interface BusquedaProducto {
  texto: string;
  skus: string[];
  renglones: RenglonProducto[];
  /** Se cortó en el límite: hay más, no es que no haya. */
  truncado: boolean;
  /** Lo que la búsqueda NO cubre. La pantalla DEBE decirlo. */
  excluye: { doctypes: string[]; motivo: string };
}

@Injectable({ providedIn: 'root' })
export class CarteraService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/receivables`;

  cartera(q: CarteraQuery = {}): Observable<CarteraResp> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v != null && v !== '') p.set(k, String(v));
    const qs = p.toString();
    return this.http.get<CarteraResp>(`${this.base}${qs ? '?' + qs : ''}`);
  }
  filtros(): Observable<CarteraFiltros> {
    return this.http.get<CarteraFiltros>(`${this.base}/filtros`);
  }
  resumen(q: { sucursal?: string; grupo?: string; zona?: string; vendedor?: string; search?: string } = {}): Observable<CarteraResumen> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, String(v));
    const qs = p.toString();
    return this.http.get<CarteraResumen>(`${this.base}/resumen${qs ? '?' + qs : ''}`);
  }
  /**
   * `[CXC.26]` La cartera con el DÍA como eje. Una sola llamada trae la agenda completa: los
   * días con su monto **y** los clientes de cada día dentro de la ventana, así que abrir un día
   * no dispara otro request.
   */
  porDia(q: PorDiaQuery = {}): Observable<PorDiaResp> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v != null && v !== '') p.set(k, String(v));
    const qs = p.toString();
    return this.http.get<PorDiaResp>(`${this.base}/por-dia${qs ? '?' + qs : ''}`);
  }
  tendencia(q: { sucursal?: string; dias?: number } = {}): Observable<CarteraTendencia[]> {
    const p = new URLSearchParams();
    if (q.sucursal) p.set('sucursal', q.sucursal);
    if (q.dias) p.set('dias', String(q.dias));
    const qs = p.toString();
    return this.http.get<CarteraTendencia[]>(`${this.base}/tendencia${qs ? '?' + qs : ''}`);
  }
  detalle(sucursal: string, cliente: string): Observable<CarteraDetalle> {
    return this.http.get<CarteraDetalle>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(cliente)}`);
  }
  createPromise(sucursal: string, cliente: string, body: { monto: number; fecha: string; nota?: string }): Observable<{ id: string; estado: string }> {
    return this.http.post<{ id: string; estado: string }>(`${this.base}/${encodeURIComponent(sucursal)}/${encodeURIComponent(cliente)}/promise`, body);
  }
  /**
   * `[CXC.SKU.1]` Documentos que tocaron un producto: facturas Y notas de crédito o
   * devoluciones. `excluye` viaja a propósito — la pantalla tiene que DECIR que los
   * tickets de mostrador quedan fuera, o un resultado vacío se lee como "no se vendió".
   */
  buscarProducto(q: string, limit = 200): Observable<BusquedaProducto> {
    const params = new HttpParams().set('q', q).set('limit', String(limit));
    return this.http.get<BusquedaProducto>(`${this.base}/producto`, { params });
  }

  resolvePromise(id: string, estado: 'cumplida' | 'incumplida' | 'cancelada'): Observable<{ id: string; estado: string }> {
    return this.http.post<{ id: string; estado: string }>(`${this.base}/promise/${encodeURIComponent(id)}/resolve`, { estado });
  }
}
