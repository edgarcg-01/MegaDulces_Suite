import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { uuidV4 } from '../../core/utils/uuid';
import type { JornadasPendientes, CorteCajaDto } from '@megadulces/contracts';
import { reintentarSi429 } from '../../core/utils/reintentar-429';
// `Freshness` se IMPORTA, no se redeclara: es el contrato de procedencia de ADR-056 y es el mismo
// objeto que consume `app-freshness-pill`. De los 26 tipos de este archivo, 24 están escritos a
// mano; cada uno que se pueda traer de acá es uno que no se puede desalinear en silencio.
import type {
  CorteRow, CortesSucursalesResponse, Freshness, VeredictoCorte,
} from '@megadulces/contracts';

/** `[CG.182]` El corte del POS, tal como lo publica Fase CSU. Reexportado para que la pantalla
 *  no tenga que saber de dos lugares — el mismo criterio que `ContextoFirma` en el socket. */
export type { CorteRow };

/**
 * CG.13/CG.17 — Cliente del libro de caja (ADR-070).
 *
 * Distinto de `caja.service.ts` (CG.1-CG.7), que lee el ESPEJO del Access `Control`. Éste
 * habla con el lado que ESCRIBE: la plataforma como fuente principal del efectivo.
 */

export type TipoMovimiento = 'ingreso' | 'gasto' | 'deposito';

export interface ConceptoKepler {
  sucursal: string;
  cuenta: string;
  concepto: string;
  concepto_nombre: string;
  cuenta_mayor: string;
}

export interface MovimientoCaja {
  id: string;
  folio: string;
  tipo: TipoMovimiento;
  fecha: string;
  hora: string | null;
  sucursal: string;
  centro_costo: string | null;
  kepler_cuenta: string;
  kepler_concepto: string;
  kepler_cuenta_nombre: string | null;
  kepler_concepto_nombre: string | null;
  glosa: string;
  beneficiario: string | null;
  monto: number;
  morralla: number;
  origen_tipo: string | null;
  origen_ref: string | null;
  estado: string;
  created_by_username: string | null;
  created_at: string;
  /** Procedencia de lo que autorrellenó el motor. Ausente = lo tecleó una persona. */
  autofill: Record<string, unknown> | null;

  /**
   * `[CG.125]` **Esto YA VIAJABA y la interfaz no lo declaraba.**
   *
   * La consulta del libro (`cash-ledger.service.ts`, el `base()` del listado) **no tiene
   * `.select()`**: es un `SELECT *` sobre `finance.cash_ledger`. O sea que estas columnas
   * llegaban al navegador en cada fila desde siempre, y la pantalla no podía pintarlas sólo
   * porque el tipo no las nombraba. No hace falta tocar el servidor para mostrarlas.
   *
   * ⚠️ **Opcionales a propósito.** Son aditivas: ningún consumidor de hoy cambia. Y opcionales,
   * no obligatorias, porque un servidor viejo —o una respuesta de otro endpoint que arme este
   * tipo a mano— no las trae, y declararlas requeridas convertiría un campo ausente en un
   * `undefined` que el tipo jura que existe.
   *
   * ⛔ **Hallazgo de paso, sin arreglar acá:** ese `SELECT *` también baja `firma_png`, que es un
   * PNG en base64, **por cada fila del libro**. Con 233 movimientos en el periodo de la captura
   * de Edgar eso es carga que nadie pinta. Acotar el `SELECT` es trabajo de servidor y va aparte.
   */
  /** Parte del monto que NO entró en efectivo (cliente de crédito). Efectivo = `monto` − esto. */
  venta_credito?: number | null;
  /**
   * `[CG.126]` **A qué caja entró este dinero.** Un movimiento puede repartirse entre las dos:
   * un cobro de ruta deja los billetes en la máquina (bóveda/CAOS) y la morralla en el cajón.
   *
   * ⛔ Los calcula el SERVIDOR desde `analytics.v_caja_reparto_movimiento`, el mismo resolvedor
   * que usa el cuadre del día. No se derivan en la pantalla: dos derivaciones del mismo reparto
   * terminan discrepando sin que nadie sepa cuál manda.
   *
   * ⚠️ Opcionales: un servidor anterior a `[CG.126]` no los manda, y ahí **no se dibuja un cero**
   * —diría que a esa caja no llegó nada— sino que se declara que no se pudo repartir.
   */
  en_boveda?: number | null;
  en_cajon?: number | null;
  /** Por qué este movimiento no trae documento. El servidor lo exige desde `[CG.124]`. */
  sin_documento_motivo?: string | null;
  /** El documento que se DECLARÓ cuando el origen es CAOS y la llave no lo identifica. */
  declared_doc_ref?: string | null;
  /** A qué corte quedó amarrado. `null` = todavía no se cerró ninguno que lo incluya. */
  corte_id?: string | null;
  beneficiario_rfc?: string | null;
  /** ⛔ `hora` NO se declara acá: ya existe arriba como requerida. Duplicarla da TS2300/TS2717. */
  cancel_reason?: string | null;
  cancelled_by_username?: string | null;
  firma_estado?: string | null;
  firma_nombre?: string | null;
}

export interface LibroResponse {
  rows: MovimientoCaja[];
  /**
   * `[CG.72]` Los tres importes son de lo VIVO: un movimiento cancelado es dinero que no se movió.
   * `cancelados`/`monto_cancelado` existen para DECLARAR la parte que la lista sí muestra —son
   * auditoría— y que por eso no cuadra con la suma de las filas.
   */
  kpi: {
    movimientos: number; ingresos: number; gastos: number; depositos: number;
    cancelados?: number; monto_cancelado?: number;
  };
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface CoberturaResponse {
  catalogo: Array<{ sucursal: string; filas_origen: number; usables: number; sin_subcuenta: number; sin_codigo: number; sin_nombre: number }>;
  mapa: Array<{ source_caja: string; cuentas: number; con_propuesta: number; sin_propuesta: number; confirmadas: number; por_confirmar: number }>;
  /**
   * `[CG.180]` **De dónde sale el autollenado, y si su fuente está viva.**
   *
   * Lo trajo la sesión de backend tras medir que `analytics.mv_caja_autofill_entidad` llegó a
   * producción **poblada y con cero filas** (la migración que la creó lee una vista filtrada por
   * `current_tenant_id()` y nunca fijó el tenant: misma sesión y mismo instante, sin tenant 0
   * filas, con tenant 13,302). Efecto en esta pantalla: el nivel «entidad» devolvía
   * `sin_historia` para TODA entidad, o sea que le decíamos al capturista *"no hay historia de
   * este proveedor"* cuando la verdad era que la copia nació vacía. Encaja con lo medido: 25
   * reclasificaciones sobre 70 movimientos.
   *
   * ⚠️ **Opcional, y el `undefined` significa algo distinto del cero.** La API desplegada todavía
   * no manda este campo: `undefined` = "esta versión del servidor no lo sabe" y `derivada === 0` =
   * "el servidor lo sabe y la copia está vacía". Sólo la segunda es un problema del dato, y se
   * pintan distinto.
   */
  autofill?: {
    /** Filas en `finance.caja_autofill_declarada` — lo que la empresa decidió a mano. */
    declarada: number;
    /** Filas en la copia derivada del historial. `0` con `latido` sano = la copia está vacía. */
    derivada: number;
    /**
     * `null` = el carril **nunca corrió**, que es su propio estado y no un cero.
     *
     * Es el `Freshness` canónico de `libs/contracts` (ADR-056) y no una forma propia: así
     * `app-freshness-pill` lo consume con `[freshness]` sin traductor, y el tercer estado
     * (`unknown`) existe — con un `ok|error` de dos valores, un refresco de hace 40 horas sale
     * verde.
     */
    latido: Freshness | null;
  };
}

export interface Propuesta<T = unknown> {
  value: T | null;
  source: string | null;
  confidence: number | null;
  support?: number;
  supportRatio?: number;
  reason?: string;
}

export interface AutofillResponse {
  concepto: Propuesta<{ kepler_cuenta: string; kepler_concepto: string }>;
  documento: Propuesta<Record<string, unknown>>;
  provenance: Record<string, unknown>;
  /** Un nivel `sin_fuente` NO es "no propuso": es que no se pudo consultar. */
  niveles: Record<string, 'consultado' | 'sin_fuente'>;
}

@Injectable({ providedIn: 'root' })
export class CashLedgerService {
  private http = inject(HttpClient);

  /**
   * `[CGP-V.4]` Toda LECTURA de caja pasa por acá y se reintenta sola ante un 429.
   *
   * Medido el 2026-10-15: al entrar, Caja General lanza 10 GET a la vez (más los del marco de la
   * app) contra un límite de 10 por segundo por IP. El que caía en el 429 dejaba su bloque «sin
   * medir» —y si era el saldo, el cierre pedía «Reintentar»— sin que nada estuviera roto. Un GET es
   * idempotente: repetirlo en la ventana siguiente es seguro. Las ESCRITURAS no pasan por acá.
   */
  private leer<T>(url: string, opciones?: { params?: HttpParams }): Observable<T> {
    return this.http.get<T>(url, opciones).pipe(reintentarSi429<T>());
  }
  private base = `${environment.apiUrl}/finance/cash-ledger`;

  libro(f: { from?: string; to?: string; tipo?: string; sucursal?: string; cuenta?: string; search?: string; limit?: number; offset?: number ; mios?: '1' }): Observable<LibroResponse> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.leer<LibroResponse>(this.base, { params: p });
  }

  conceptos(sucursal?: string, search?: string, limit = 50): Observable<{ rows: ConceptoKepler[]; limit: number }> {
    let p = new HttpParams().set('limit', String(limit));
    if (sucursal) p = p.set('sucursal', sucursal);
    if (search) p = p.set('search', search);
    return this.leer<{ rows: ConceptoKepler[]; limit: number }>(`${this.base}/conceptos`, { params: p });
  }

  cobertura(): Observable<CoberturaResponse> {
    return this.leer<CoberturaResponse>(`${this.base}/cobertura`);
  }

  /** PROPONE. No guarda nada. Lo que no puede proponer vuelve en null con su motivo. */
  autofill(input: { tipo?: string; sucursal?: string; glosa?: string; beneficiario?: string; beneficiario_rfc?: string; legacy_cuenta?: string; origen_ref?: string; entidad_code?: string }): Observable<AutofillResponse> {
    return this.http.post<AutofillResponse>(`${this.base}/autofill`, input);
  }

  crear(body: Record<string, unknown>): Observable<MovimientoCaja> {
    return this.http.post<MovimientoCaja>(this.base, body);
  }

  /**
   * CG.22.6 — **Declara que un beneficiario va siempre a una cuenta.**
   *
   * Medido el 2026-09-22: `finance.caja_classify_rules` tenía **0 filas en prod** y no existía
   * NINGUNA pantalla para cargarlas. Por eso la bandeja decía «0 de 8 se confirman» y no había
   * forma de mejorar ese número: el bloqueo no era falta de trabajo, era falta de puerta.
   * Se declara desde la captura, que es donde la persona tiene el beneficiario delante y acaba
   * de decidir la cuenta.
   */
  declararRegla(body: {
    beneficiario: string; kepler_cuenta: string; kepler_concepto: string; sucursal?: string; nota?: string;
  }): Observable<{ creada: boolean; motivo?: string; id?: string; patron?: string }> {
    return this.http.post<{ creada: boolean; motivo?: string; id?: string; patron?: string }>(
      `${this.base}/reglas`, body,
    );
  }

  /**
   * CG.19 Capa 1 — **Los cobros que Kepler ya registró y todavía no se aplicaron.**
   *
   * El capturista ELIGE de acá en vez de teclear monto, fecha y motivo: el valor se toma del ERP
   * y el registro precede al dinero. Lo que NO está en esta lista no deja de existir — es el
   * ingreso que sigue capturándose a mano (~40-45% del total, medido), y por eso la pantalla
   * conserva el camino manual en vez de obligar a elegir.
   */
  movimientosPendientes(
    f: {
      tipo?: string; caja?: string; sucursal?: string; from?: string; to?: string;
      search?: string; limit?: number;
      /**
       * `[CGA11Y-O3b]` El grupo elegido en la tira de accesos (`U-A-5`, `X-D-26`…).
       *
       * ⚠️ El nombre va en `snake_case` porque **es el nombre del query param**: el bucle de abajo
       * serializa las llaves tal cual. Escribirlo `docTipo` acá mandaría `?docTipo=` y el servidor
       * —que lee `doc_tipo`— lo ignoraría **en silencio**: la lista saldría sin filtrar y nadie
       * vería un error. Es la convención que `CLAUDE.md` fija para query params.
       */
      doc_tipo?: string;
    } = {},
  ): Observable<PendientesResponse> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.leer<PendientesResponse>(`${this.base}/movimientos-pendientes`, { params: p });
  }

  /**
   * CS.3 — Movimientos de CAOS (caja fuerte) pendientes de capturar, con sus denominaciones ya
   * contadas por la máquina para autorrellenar el arqueo. Segunda fuente de la bandeja.
   */
  caosCapturables(
    f: { tipo?: string; from?: string; to?: string; search?: string; limit?: number } = {},
  ): Observable<CaosCapturablesResponse> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.leer<CaosCapturablesResponse>(`${this.base}/caos-capturables`, { params: p });
  }

  /**
   * CS.3.3 — Retiros del cajero (CAOS) que PUDIERON pagar un gasto, rankeados por patrones + lo
   * aprendido. El detector de la captura: se muestran con score/motivos y el humano confirma.
   */
  caosCandidatos(
    f: { fecha?: string; monto?: number; beneficiario?: string; concepto?: string; sucursal?: string; tipo?: string; limit?: number } = {},
  ): Observable<CaosCandidatosResponse> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.leer<CaosCandidatosResponse>(`${this.base}/caos-candidatos`, { params: p });
  }

  /**
   * CG.21 — Las cajas de efectivo del catálogo de Kepler, con su volumen medido.
   *
   * Viene del catálogo y no de los movimientos: una caja dormida tiene que poder verse en el
   * selector, o sería indistinguible de una que no existe.
   */
  cajas(dias?: number): Observable<{ rows: CajaKepler[]; ventana_dias: number | null; desde?: string | null }> {
    let p = new HttpParams();
    if (dias) p = p.set('dias', String(dias));
    return this.leer<{ rows: CajaKepler[]; ventana_dias: number | null; desde?: string | null }>(`${this.base}/cajas`, { params: p });
  }

  /**
   * CG.20/CG.21 — **Confirma N movimientos de un golpe.** El backend corre cada fila en su propia
   * transacción: una que falle NO tumba a las demás, y el resultado viene por fila.
   *
   * ⛔ `[CG.48]` El lote ESPEJA al ERP: ya no lleva `monto_contado` por fila. Era la única vía por
   * la que una cifra contada entraba al libro **sin un billete declarado detrás**, y volvía
   * irreconstruible el arqueo del día. Contar distinto va por la captura anclada, con desglose.
   */
  confirmarLote(items: Array<{ origen_ref: string }>): Observable<ResumenLote> {
    return this.http.post<ResumenLote>(`${this.base}/lote`, {
      // El `client_uuid` va por fila: si la red corta y la persona reintenta, el reintento
      // devuelve lo que ya se guardó en vez de duplicarlo.
      // `[CGP-V.10]` `uuidV4()` y no `crypto.randomUUID()`: por http:// en la LAN no existe, la
      // petición reventaba antes de salir y «Confirmar N» quedaba cargando para siempre.
      items: items.map((i) => ({ ...i, client_uuid: uuidV4() })),
    });
  }

  /** CG.20 — Los pares que ese capturista más repite, para ofrecerlos de un toque. */
  frecuentes(f: { tipo?: string; sucursal?: string; limit?: number } = {}): Observable<{ rows: Frecuente[]; medido: { pares_con_soporte: number; minimo_usos: number } }> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.leer<{ rows: Frecuente[]; medido: { pares_con_soporte: number; minimo_usos: number } }>(
      `${this.base}/frecuentes`, { params: p });
  }

  detalle(id: string): Observable<MovimientoCaja & { denominaciones: Array<{ denominacion: number; piezas: number; flujo?: 'recibido' | 'devuelto' }>; arqueo: { desglosado: number; diferencia: number } | null }> {
    return this.leer(`${this.base}/${id}`);
  }

  // ── CG.15 · corte, saldo y cancelación ───────────────────────────────────────────────

  /** `saldo: null` + `sin_corte_abierto` NO es cero: la caja no tiene punto de partida. */
  saldo(sucursal: string): Observable<SaldoResponse> {
    return this.leer<SaldoResponse>(`${this.base}/saldo/${encodeURIComponent(sucursal)}`);
  }

  /**
   * `[CGA-A.43]` Con qué arrancaría la caja si se abriera el corte ahora: el `contado` del cierre
   * anterior, o `sin_medir`. Es la MISMA regla que aplica el servidor al abrir con el fondo vacío.
   */
  fondoSugerido(sucursal: string): Observable<FondoSugerido> {
    const p = new HttpParams().set('sucursal', sucursal);
    return this.leer<FondoSugerido>(`${this.base}/cortes/fondo-sugerido`, { params: p });
  }

  /**
   * `[CG.26]` El cierre de la jornada: el día en caja general y en el cajero (CAOS).
   *
   * ⭐ **No depende de que haya corte abierto**, y eso es el punto: el panel de «Arqueo final del
   * día» que ya existía colgaba de `corteAbierto()`, y en prod hay CERO cortes — o sea que no lo
   * vio nunca nadie.
   */
  arqueoDia(f: { fecha?: string; sucursal?: string } = {}): Observable<ArqueoDia> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.leer<ArqueoDia>(`${this.base}/arqueo-dia`, { params: p });
  }

  /**
   * `[CG.27-B.1]` Los que repiten y nadie declaró su cuenta. Es el 69 % de los clics de la caja.
   */
  recurrentesSinRegla(f: { dias?: number; min_pagos?: number; incluir_cubiertos?: boolean } = {}): Observable<RecurrentesResponse> {
    // ⚠️ Sin el `v !== ''` del resto del archivo, y a propósito: acá los valores son `number` y
    // `boolean`, así que compararlos con una cadena vacía es código muerto — y el compilador lo
    // dice (TS2367). Copiar el bucle de al lado sin mirar los tipos rompía el build.
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null) p = p.set(k, String(v));
    return this.leer<RecurrentesResponse>(`${this.base}/recurrentes-sin-regla`, { params: p });
  }

  /** `[CG.27-B.0]` Las reglas ya declaradas. Hasta ahora sólo se podían escribir. */
  reglas(f: { incluir_inactivas?: boolean; limit?: number } = {}): Observable<{ rows: ReglaCaja[]; limit: number; has_more: boolean }> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null) p = p.set(k, String(v));
    return this.leer<{ rows: ReglaCaja[]; limit: number; has_more: boolean }>(`${this.base}/reglas`, { params: p });
  }

  /**
   * `[CG.27-B.0]` Corrige o APAGA una regla. ⛔ No hay `DELETE`: una regla que ya clasificó dinero
   * se desactiva, no se borra.
   */
  actualizarRegla(id: string, body: { kepler_cuenta?: string; kepler_concepto?: string; sucursal?: string; active?: boolean; nota?: string }): Observable<ReglaCaja> {
    return this.http.patch<ReglaCaja>(`${this.base}/reglas/${encodeURIComponent(id)}`, body);
  }

  cortes(f: { from?: string; to?: string; sucursal?: string; estado?: string; limit?: number } = {}): Observable<{ rows: CorteCaja[]; limit: number }> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.leer<{ rows: CorteCaja[]; limit: number }>(`${this.base}/cortes`, { params: p });
  }

  /**
   * `[CG.42]` `fondo_inicial` **omitido** = no se midió → el backend guarda `NULL` +
   * `fondo_origen='sin_medir'`. Mandar `0` afirma que se contó y estaba vacía.
   */
  abrirCorte(body: { fecha: string; sucursal: string; fondo_inicial?: number; nota?: string }): Observable<CorteCaja> {
    return this.http.post<CorteCaja>(`${this.base}/cortes`, body);
  }

  /**
   * `[CGP-L.4]` Las jornadas del cajón con movimientos y SIN corte, de la más vieja a la más nueva.
   * Es lo que la pantalla ofrece abrir, y en ese orden: el servidor rechaza abrir un día anterior a
   * un corte que ya existe, así que abrir hoy primero deja huérfanos a los de atrás.
   */
  jornadasPendientes(sucursal: string): Observable<JornadasPendientes> {
    return this.leer<JornadasPendientes>(`${this.base}/cortes/jornadas-pendientes`, {
      params: new HttpParams().set('sucursal', sucursal),
    });
  }

  /**
   * CG.19 — SELLA el conteo y recién entonces revela. Era `previa`, que mostraba la diferencia
   * mientras se contaba: con eso el arqueo era una transcripción del esperado.
   */
  // `[CGP-V.9]` `ceroDeclarado`: «conté y no hay efectivo». Sin él, una reja vacía es «no se contó».
  contarCorte(id: string, conteo: Array<{ denominacion: number; piezas: number }>, morralla = 0, ceroDeclarado = false): Observable<RevelacionCorte> {
    return this.http.post<RevelacionCorte>(`${this.base}/cortes/${id}/contar`,
      ceroDeclarado ? { conteo, morralla, cero_declarado: true } : { conteo, morralla });
  }

  /** Segundo y ÚLTIMO conteo. El motivo es obligatorio y el primero se conserva. */
  recontarCorte(id: string, conteo: Array<{ denominacion: number; piezas: number }>, morralla: number, motivo: string, ceroDeclarado = false): Observable<RevelacionCorte> {
    return this.http.post<RevelacionCorte>(`${this.base}/cortes/${id}/recontar`,
      ceroDeclarado ? { conteo, morralla, motivo, cero_declarado: true } : { conteo, morralla, motivo });
  }

  /**
   * `[CGP-V.12]` `esperadoVisto`: el esperado que la persona confirmó después de un 409 de
   * `[CGP-L.2]` (cambió desde el conteo). Sin él, el servidor compara contra lo que reveló el conteo.
   */
  cerrarCorte(
    id: string, conteo: Array<{ denominacion: number; piezas: number }>, morralla = 0, nota?: string,
    esperadoVisto?: number,
  ): Observable<CorteCaja & { totales: TotalesCorte }> {
    return this.http.post<CorteCaja & { totales: TotalesCorte }>(`${this.base}/cortes/${id}/cerrar`,
      { conteo, morralla, nota, esperado_visto: esperadoVisto });
  }

  /** Devuelve 403 si lo intenta quien cerró: la doble llave está en la DB, no acá. */
  autorizarCorte(id: string): Observable<CorteCaja> {
    return this.http.post<CorteCaja>(`${this.base}/cortes/${id}/autorizar`, {});
  }

  /**
   * ⭐⭐ `[CG.182]` **LOS CORTES DE CAJA DEL POS — lo que la persona tiene EN LA MANO.**
   *
   * Hasta hoy, para declarar de dónde salió un depósito, lo único que la pantalla ofrecía eran
   * documentos de Kepler y movimientos de CAOS. El papel que la persona trae del mostrador —el
   * corte de caja— no estaba en ninguna lista, así que la declaración terminaba tecleada a mano:
   * medido en prod, **708 referencias distintas en 749 depósitos**, cero parseables, y la misma
   * ruta escrita `ruta 21 09 26`, `rd 21 04/07`, `ruta 21 13 10 26`.
   *
   * ⛔ **Vive FUERA de `finance/cash-ledger`, y no es un descuido de nombres**: el corte es de
   * Fase CSU (`finance/cortes-sucursales`), que lee el POS desde el ODS. Acá sólo se consume.
   * Por eso el tipo se IMPORTA de `libs/contracts` y no se redeclara: de los 26 tipos de este
   * archivo, 24 están escritos a mano y cada uno que se pueda traer es uno que no se desalinea
   * en silencio.
   *
   * ⚠️ `from`/`to` son obligatorios acá aunque el servidor acepte `month`: la ventana de este
   * selector es **móvil** (los últimos días desde hoy), no un mes natural, porque entre el corte
   * y su depósito pasan días — el caso que originó esto son **5**.
   */
  cortesDeCaja(from: string, to: string): Observable<CortesSucursalesResponse> {
    const p = new HttpParams().set('from', from).set('to', to);
    return this.leer<CortesSucursalesResponse>(`${environment.apiUrl}/finance/cortes-sucursales`, { params: p });
  }

  cancelar(id: string, motivo: string): Observable<MovimientoCaja> {
    return this.http.post<MovimientoCaja>(`${this.base}/${id}/cancelar`, { motivo });
  }
}

/**
 * `[CGP-L.7]` El corte, con la forma del contrato que comparte con el servidor: el dinero como número
 * y la fecha como día. Antes era una copia a mano que decía `number` mientras llegaba texto, y
 * `fondo_inicial: number` cuando el servidor manda `null` si no se midió.
 */
export type CorteCaja = CorteCajaDto;

export interface TotalesCorte {
  ingresos: number; gastos: number; depositos: number;
  /**
   * ⛔ CG.19 — **opcionales a propósito.** El servidor los recorta para quien no autoriza: el
   * arqueo es CIEGO. `diferencia` y `veredicto` se van JUNTO con `esperado` porque
   * `esperado = contado − diferencia` y el veredicto es su signo — publicar uno es publicar los
   * tres. Cuando faltan, viene `oculto: true`.
   */
  esperado?: number; diferencia?: number;
  veredicto?: VeredictoCorte;
  /**
   * `[CG.42]` No se midió con qué arrancó la caja. Va FUERA del recorte ciego a propósito: no
   * revela el esperado —sólo dice que no tiene base— y quien cuenta necesita saberlo ANTES de
   * contar, no después.
   */
  fondo_sin_medir?: boolean;
  contado: number;
  movimientos: number; cancelados: number;
  /** De qué está hecho el esperado: cuánto del ingreso viene de Kepler y cuánto de un teclado. */
  ingresos_anclados: number; ingresos_capturados: number;
  /** 0..1, o `null` si no hubo ingresos. NUNCA 0 por falta de datos. */
  cobertura_ingreso: number | null;
  /** El servidor DICE que recortó, en vez de mandar campos ausentes sin explicación. */
  oculto?: true;
  /** Viaja aunque sea ciego: no revela nada y la pantalla necesita saber si ya se contó. */
  conto?: boolean;
}

/**
 * ⭐ `[CG.160]` El conteo ya sellado de un corte abierto, tal como lo manda `saldo()`.
 *
 * ⚠️ `esperado` y `diferencia` pueden venir en `null` **con `contado` presente**: son los cortes
 * que se sellaron antes de `[CG.156]`, cuando el veredicto no se guardaba. Ahí `veredicto` vale
 * `'sin_medir'` y la pantalla tiene que DECIRLO — `money(null)` dibuja `$0.00`, que sobre un
 * esperado ausente afirma que cuadra.
 */
export interface ConteoSellado {
  contado: number;
  esperado: number | null;
  diferencia: number | null;
  veredicto: VeredictoCorte;
  ya_reconto: boolean;
  /**
   * `[CGP-V.2]` Lo sellado, pieza por pieza, y la morralla. La reja lo muestra de sólo lectura una
   * vez revelado. Opcionales: un API anterior no los manda, y la pantalla lo declara en vez de
   * pintar la reja en blanco junto a un «Contado» con cifra.
   */
  desglose?: Array<{ denom_key: string; denominacion: number; piezas: number }>;
  morralla?: number;
}

/**
 * `[CG.160]` Lo que la pantalla PINTA de la revelación: el subconjunto común entre el veredicto
 * recién sellado (`TotalesCorte`) y el que ya estaba sellado en la base (`ConteoSellado`). Existe
 * para que el diálogo no tenga que saber de cuál de los dos vino — las dos formas encajan acá.
 */
export interface RevelacionVista {
  contado: number;
  esperado?: number | null;
  diferencia?: number | null;
  veredicto?: VeredictoCorte;
  oculto?: boolean;
}

/**
 * Un movimiento de caja que Kepler ya registró y el libro todavía no aplicó. Los DOS signos.
 *
 * `origen_ref` es su identidad: **`sucursal|doc_tipo|folio|clave_banco`**. El `doc_tipo` no es
 * decorativo — medido, el folio COLISIONA entre `X-A-45`, `X-D-26` y `X-D-60` (los folios
 * 0000011, 0000029, 0000030… existen en los tres a la vez), así que sin él confirmar un anticipo
 * bloquearía un pago distinto.
 */
export interface MovimientoPendiente {
  origen_ref: string;
  /** `ingreso` | `gasto`, derivado del signo del documento en el ERP. */
  tipo: string;
  origen_tipo: string;
  /** Clave de la caja en el catálogo `kdb1`. `0011` = CAJA GENERAL. */
  clave_banco: string;
  caja_nombre: string | null;
  sucursal: string;
  doc_tipo: string;
  folio: string;
  fecha_valor: string;
  /** El código de la contraparte en Kepler (`CB013`, `GG015`, `RD 21`, `2-32-321`). */
  entidad_code: string | null;
  beneficiario: string | null;
  concepto: string | null;
  metodo: string | null;
  monto: number;
  /**
   * ⭐ `[CGA-A.15]` La unidad de reparto de la que viene este cobro (`ruta_27`, `ruta_503`…).
   *
   * `null` = **no es de camioneta**: es un cobro de mostrador, donde `CONTADO` es el cliente de
   * verdad. Medido el 2026-10-19: de 136 cobros `CONTADO` en la cola, **36 eran de mostrador**,
   * así que etiquetarlos todos con una ruta sería inventar.
   *
   * Sale de `analytics.route_collections.truck` por la procedencia del renglón, **no** de
   * adivinar por el formato de la sucursal — la lección de `GOTCHAS` §86.
   */
  ruta?: string | null;
  /** CS.3.13 — el cliente del cobro es de crédito (`kdud` días/límite > 0): auto-rellena «venta a crédito». */
  cliente_credito?: boolean;
  credito_limite?: number | null;
  credito_dias?: number | null;
  /**
   * CG.20/CG.21 — `true` = se puede confirmar sin elegir NADA (la cuenta contable ya viene
   * resuelta: del mapa declarado si es ingreso, de una regla si es egreso). `false` viene SIEMPRE
   * con `motivo_texto`: sin el porqué, la pantalla tendría que adivinar, y adivinar acá es
   * inventar una cuenta contable.
   */
  confirmable: boolean;
  kepler_cuenta: string | null;
  kepler_concepto: string | null;
  /** CS.3.1b — El NOMBRE de la contra-cuenta cuando viene del documento (para mostrarla). */
  kepler_cuenta_nombre?: string | null;
  /** CS.3.1b — De dónde salió la cuenta: `ruta` | `regla` | `documento` (su propia póliza). */
  cuenta_fuente?: 'ruta' | 'regla' | 'documento' | null;
  /** CS.3.1b — `true` = la cuenta es autoritativa (del documento) y la pantalla la BLOQUEA. */
  cuenta_bloqueada?: boolean;
  /** CS.3.1b — Los conceptos válidos de esa cuenta, para la elección ACOTADA (no buscador libre). */
  conceptos_cuenta?: Array<{ concepto: string; concepto_nombre: string | null }>;
  /**
   * CS.3.6 — El match del cajero (CAOS) que el motor ADJUNTÓ a este movimiento, para autorrellenar
   * PARTE de su arqueo. `null` si no hay. El efectivo del cajero es ≤ el movimiento de Kepler (la
   * diferencia es lo retenido/gastos de ruta).
   */
  caos_match?: {
    origen_ref: string; device: string; external_id: number; monto: number; ref: string | null;
    type_label: string; denominaciones: Array<{ denominacion: number; piezas: number }>;
    confianza: 'alta' | 'media' | 'baja'; motivos: string[];
  } | null;
  motivo?: 'sin_mapa' | 'sin_confirmar' | 'sin_cuenta' | 'sin_monto' | 'sin_regla' | 'elegir_concepto'
    // El documento viene fechado DESPUÉS de hoy: no se confirma en lote, se captura a mano
    // corrigiendo la fecha. Medido: 8 documentos del ERP, y uno ya entró al libro como diciembre.
    | 'fecha_futura';
  motivo_texto?: string;
}

/** Una caja de efectivo del catálogo `kdb1`, con lo que de verdad se movió por ella. */
export interface CajaKepler {
  clave: string;
  nombre: string;
  cuenta_contable: string | null;
  /** Documentos en la ventana. `0` acá es un HECHO medido, no una falta de datos. */
  documentos: number;
}

export interface PendientesResponse {
  /** Desde qué fecha se está mirando. `ventana_dias` null = el filtro lo puso la persona. */
  desde?: string;
  ventana_dias?: number | null;
  /** `[CGA-A.43]` De dónde sale `desde`: la pantalla lo pidió, es el primer corte del libro, o la ventana de siempre. */
  desde_motivo?: 'pedido' | 'relevo' | 'ventana';
  /** `[CGA-A.44]` El primer corte del libro (cuando `desde_motivo='relevo'`). */
  relevo?: string | null;
  /** `[CGA-A.44]` Documentos de la era Control que se quitaron por estar ya saldados en el Control. */
  saldados_por_control?: number;
  /** `[CGA-A.44]` false = no se leyeron los cobros de camioneta y se dejaron visibles (lado seguro). */
  control_ruta_disponible?: boolean;
  /**
   * Lo que la ventana DEJA FUERA, declarado. Medido en prod al aplicar CG.21: con el libro nuevo
   * vacío, "pendiente" era todo lo que Kepler registró desde 2025 — 12,160 movimientos. Eso no es
   * trabajo del día, es una decisión de hasta dónde se migra lo que el Access ya registró; pero
   * tampoco puede desaparecer de la pantalla.
   */
  fuera_de_ventana?: { movimientos: number; monto: number };
  /**
   * `[CG.28]` Los que el ERP fechó DESPUÉS de hoy. Quedan fuera de la lista — una ventana de
   * "los últimos N días" que deja entrar el futuro no es una ventana — pero se cuentan y se
   * publican: no son trabajo de caja, son un error de captura que alguien tiene que ir a corregir
   * en Kepler.
   */
  mal_fechados?: { movimientos: number; monto: number };
  /**
   * `[CGA11Y-O3a]` Cuántos hay POR GRUPO, para la tira de accesos rápidos. Ordenado por volumen.
   *
   * ⛔ **El eje es `doc_tipo`, no `origen_tipo`.** En esta vista `origen_tipo` sale del signo
   * (`signo > 0 ? 'cobro' : 'pago_proveedor'`), así que es un sinónimo de `tipo` y no distingue
   * nada — medido el 2026-10-16: 1,428 gasto↔`pago_proveedor` y 479 ingreso↔`cobro`, sin una sola
   * excepción. `doc_tipo` sí separa: `U-A-5` es el depósito de efectivo (95% del ingreso),
   * `X-D-26` el pago/egreso (92% de la salida), `D-23-1` el cobro de ruta de detalle.
   *
   * ⚠️ **NO se calcula con `rows`.** Contar la página en vez del trabajo es el defecto que
   * `[CG.30]` midió: la bandeja publicaba «31 de 100» teniendo 1,887 en esa caja y 12,793 en
   * total. Viene del servidor o no viene.
   *
   * ⚠️ `undefined` = el servidor desplegado todavía no lo manda. **No es un arreglo vacío**: sin
   * grupos no se dibuja la tira, en vez de dibujarla con ceros (ADR-056).
   */
  grupos?: Array<{ doc_tipo: string; tipo: string; movimientos: number; monto: number }>;
  rows: MovimientoPendiente[];
  /**
   * CG — Lo que el BUSCADOR encuentra FUERA del efectivo inferido: documentos POR PAGAR —
   * gastos (`XA1001`) y órdenes de entrada (`XA2001`). Sólo viene cuando hay término de búsqueda;
   * la lista por default es la cola de efectivo y estos no son (todavía) movimientos de caja.
   *
   * Comparte la forma de `MovimientoPendiente` para abrirse con la MISMA captura, pero llega
   * siempre con `confirmable:false`: pagar uno exige elegir cuenta y contar el efectivo.
   */
  pagables?: Array<MovimientoPendiente & { pagable_label: string }>;
  limit: number;
  has_more: boolean;
  /**
   * CG.22.3 — cuándo se armó la foto que se está leyendo. La lista sale de un matview
   * (`analytics.mv_caja_movimientos`), materializado por costo: 415 ms → 0.4 ms, medido.
   * ⚠️ `null` = no se pudo medir, y se DECLARA como tal. Un matview que dejó de refrescarse no da
   * error: sirve la foto vieja, y una bandeja de caja congelada se lee como "no hay trabajo".
   */
  datos_al?: string | null;
  /** Cuántas de las visibles se pueden confirmar de un clic. Una lista llena de filas trabadas
   *  no puede leerse igual que una lista lista (ADR-056).
   *  ⚠️ Es sobre las filas DEVUELTAS, no sobre `total`: quien lo muestre tiene que decirlo así. */
  confirmables: number;
  /**
   * `[CG.30]` **Cuántos hay de verdad** en la ventana, con los mismos filtros — no cuántos cupieron
   * en la página. El subtítulo publicaba `rows.length` (tope 100) como si fuera el trabajo
   * pendiente: decía *«31 de 100»* teniendo **1,887** en esa caja y **12,793** en total.
   * Opcional porque una API anterior no lo manda; sin él la pantalla NO afirma un universo.
   */
  total?: number;
}

/** CS.3 — Un movimiento de CAOS capturable, con sus denominaciones para el arqueo. */
export interface CaosCapturable {
  origen_ref: string;      // 'device|external_id' — la identidad para el candado anti-duplicado
  external_id: number;
  device: string;
  tipo: 'ingreso' | 'gasto';
  type_label: string;
  occurred_at: string;
  fecha_valor: string;
  sucursal: string;
  user_external: string | null;
  ref: string | null;
  monto: number;
  denominaciones: Array<{ denominacion: number; piezas: number }>;
}

export interface CaosCapturablesResponse {
  rows: CaosCapturable[];
  limit: number;
  has_more: boolean;
  desde: string;
  datos_al?: string | null;
}

/** CS.3.3 — Un candidato del detector: un retiro de CAOS con su puntaje y por qué (para confirmar). */
export interface CaosCandidato {
  origen_ref: string;
  external_id: number;
  device: string;
  type_label: string;
  fecha_valor: string;
  sucursal: string;
  user_external: string | null;
  ref: string | null;
  monto: number;
  denominaciones: Array<{ denominacion: number; piezas: number }>;
  score: number;
  motivos: string[];
  confianza: 'alta' | 'media' | 'baja';
}
export interface CaosCandidatosResponse {
  rows: CaosCandidato[];
  fecha: string;
  datos_al: string | null;
}

/** Resultado del lote: por fila, porque una que falla no tumba a las demás. */
export interface ResumenLote {
  filas: Array<{ origen_ref: string; estado: 'guardado' | 'duplicado' | 'rechazado' | 'no_confirmable'; folio?: string; motivo?: string }>;
  guardados: number;
  duplicados: number;
  rechazados: number;
  no_confirmables: number;
  /** Suma SÓLO lo guardado. Un total optimista es una mentira. */
  monto_guardado: number;
}

/** Un par (cuenta, concepto, beneficiario) que esa persona repite. Un toque lo llena. */
export interface Frecuente {
  kepler_cuenta: string;
  kepler_concepto: string;
  glosa: string | null;
  beneficiario: string | null;
  usos: number;
  ultimo_uso: string | null;
  rango: number;
}

/** Lo que devuelve sellar el conteo: acá SÍ viene revelado — ya no se puede retocar en silencio. */
export interface RevelacionCorte {
  corte_id: string;
  totales: TotalesCorte;
  puede_recontar: boolean;
  sellado_por?: string;
  conteo_previo_contado?: number;
}

/** `[CGP-L.4]` Lo que devuelve `GET cortes/jornadas-pendientes`: el contrato que comparte con el servidor. */
export type { JornadasPendientes };

/** `[CGA-A.43]` `GET cortes/fondo-sugerido`. `monto: null` = no hay cierre anterior medido. */
export interface FondoSugerido {
  monto: number | null;
  origen: string;
  denominaciones?: Record<string, number> | null;
  procedencia?: string | null;
  limites?: unknown[];
}

export interface SaldoResponse {
  sucursal: string;
  // ⛔ `[CG.153]` `fondo_inicial` es `number | null`, no `number`. El servidor manda `fondo(abierto)`
  // y ese `null` SIGNIFICA «no se midió» — es justo la distinción que `[CG.39]`/`[CG.90.1]` pelearon
  // por conservar contra un cero que diría «arrancó vacía». Este mismo archivo ya lo declara bien
  // 228 líneas más abajo (`ArqueoDia`); acá mentía, y los consumidores ya guardan el null en runtime.
  corte_abierto: {
    id: string; folio: string; fondo_inicial: number | null; ya_reconto: boolean;
    /**
     * `[CGP-L.4]` La jornada del corte (`YYYY-MM-DD`). Con jornadas atrasadas, el corte abierto
     * puede no ser el de hoy y el diálogo de cierre tiene que decirlo. Opcional: el API puede ir
     * por detrás del front en un deploy parcial.
     */
    fecha?: string;
    /**
     * ⭐ `[CG.160]` **El conteo que YA está sellado en la base.** Lo publica `saldo()` desde
     * `[CG.156]` y acá no estaba declarado, así que la pantalla no podía leerlo: al recargar,
     * `abrirCierre()` arrancaba sin revelación y sólo ofrecía «Guardar conteo», que el servidor
     * rechaza con *«este corte ya tiene un conteo sellado»*. Callejón sin salida.
     *
     * `null` mientras nadie contó — y ahí el esperado sigue oculto por el arqueo ciego.
     */
    conteo_sellado?: ConteoSellado | null;
  } | null;
  saldo: number | null;
  /** `saldo` es el esperado con otro nombre: cuando está oculto se declara, no se confunde con 0. */
  saldo_oculto: boolean;
  sin_corte_abierto: boolean;
  movimientos_sueltos: number;
  /** `[CG.115]` La jornada que se midió (`YYYY-MM-DD`): sin esto «N sueltos» no dice de qué día. */
  dia?: string;
  /**
   * ⭐ `[CG.115]` **Lo que quedó suelto de OTRAS jornadas.** `null` = no hay pendientes de otros
   * días; nunca significa "no se midió". Existe porque acotar el corte a su día sin publicar esto
   * sería cambiar un defecto por otro: los $130,000 del 25-sep dejarían de torcer el esperado,
   * pero también dejarían de verse.
   */
  sueltos_fuera?: {
    dia: string;
    anteriores: { movimientos: number; neto: number };
    posteriores: { movimientos: number; neto: number };
    desde: string | null;
    hasta: string | null;
  } | null;
  totales: TotalesCorte;
  /**
   * CS.3.11 — Movimiento del CAJERO (CAOS) en el período del corte, para conciliar la caja chica
   * (efectivo suelto) contra la bóveda. Sólo en oficinas (sucursal 00) con corte abierto; `null` si no.
   *
   * `[CG.26]` `dotado`/`vaciado`/`otros` se sumaron cuando se midió que la conciliación miraba
   * **2 de los 6 tipos** del cajero. Van en piernas SEPARADAS de depósito/dispensación: `Dotar` y
   * `Vaciar Stocks` mueven la bóveda contra el exterior, no contra la caja chica, y sumarlos ahí
   * daría un «caja chica conciliada» inventado.
   */
  cajero?: {
    /**
     * `[CG.101]` La JORNADA que se midió (`YYYY-MM-DD`), no el instante en que se creó el corte.
     * Antes acá decía `desde` con un timestamp, y ese timestamp era el defecto: el corte se abre
     * al cerrar la jornada, así que la ventana empezaba después de todo lo que tenía que medir
     * y las dos piernas llegaban en cero.
     */
    dia: string;
    depositado: number; dispensado: number; movimientos: number;
    dotado?: number; vaciado?: number;
    otros?: { movimientos: number; monto: number };
  } | null;
}

/** `[CG.27-B.0]` Una regla de clasificación declarada. */
export interface ReglaCaja {
  id: string;
  priority: number;
  match_tipo: string | null;
  match_glosa: string | null;
  /** El patrón crudo, a la vista: es lo que hay que poder mirar para entender qué clasifica. */
  match_beneficiario: string | null;
  kepler_cuenta: string;
  kepler_concepto: string;
  active: boolean;
  suppressed_at: string | null;
  applied_count?: number;
  corrected_count?: number;
  note?: string | null;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

/**
 * `[CG.27-B.1]` Un beneficiario que repite y al que ninguna regla viva clasifica.
 *
 * ⛔ `propuesta_contable` en `null` NO es "el motor no propuso": es que **no hay de dónde**. Medido
 * en prod: de los 57 sin regla, sólo **3** tienen en la contabilidad un par (cuenta, concepto) con
 * soporte y dominancia suficientes. Los otros 54 los tiene que declarar una persona.
 */
export interface RecurrenteSinRegla {
  beneficiario: string;
  pagos: number;
  /** Cuántos de sus pagos SÍ clasifica alguna regla. Un booleano escondería la cobertura parcial. */
  pagos_con_regla: number;
  monto: number;
  promedio: number;
  /** σ/μ del importe. `null` = no se pudo medir; **0 es una señal, no un hueco**. */
  cv_importe: number | null;
  ultimo_pago: string;
  dias_sin_pago: number | null;
  propuesta_contable: { kepler_cuenta: string; kepler_concepto: string; soporte: number; dominancia: number } | null;
}

export interface RecurrentesResponse {
  rows: RecurrenteSinRegla[];
  ventana_dias: number;
  min_pagos: number;
  /** El contador va SIEMPRE: una lista escondida no se trabaja, y un 0 por consulta vacía no puede leerse como "ya está todo". */
  medido: {
    recurrentes: number; sin_regla: number; pagos_sin_regla: number;
    reglas_declaradas: number; caidos: number;
    con_propuesta_contable: number; sin_de_donde_proponer: number;
  };
  caido_dias: number;
}

/** `[CG.26]` Una pierna del cajero, tal como el dispositivo la declara. */
export interface ArqueoTipoCajero {
  type_id: number;
  etiqueta: string;
  movimientos: number;
  monto: number;
  /** El tipo no está en el catálogo medido: se pinta aparte y NO se suma a ninguna pierna. */
  desconocido: boolean;
}

/**
 * `[CG.26]` El cierre de la jornada.
 *
 * ⛔ `cajero.neto` es el **movimiento del día**, NO el efectivo que hay en la máquina: CAOS no
 * publica su contenido, y el flujo acumulado da negativo porque el saldo anterior al arranque del
 * feed no se conoce. Rotularlo «saldo» sería publicar un número que no existe.
 */
/**
 * `[CG.91]` Un renglón del historial de la jornada: lo que la persona capturó, no el agregado.
 * El cuadro de arriba es el resumen; esto es lo que lo forma y lo que permite revisarlo.
 */
export interface ArqueoMovimientoDia {
  id: string;
  folio: string;
  /** `HH:MM` en hora de México, del reloj FÍSICO (`created_at`), igual que el resto de la jornada. */
  hora: string;
  tipo: 'ingreso' | 'gasto' | 'deposito';
  monto: number;
  /**
   * ⭐⭐ `[CG.139]` **El mismo movimiento, repartido en dos cajas.** De un cobro de ruta la máquina
   * se queda los billetes y al cajón llega la morralla: medido sobre los tres cobros del 10 al 12
   * de octubre, $49,400 contra $57. Por eso el renglón trae las dos mitades y no una bandera —
   * `monto = en_boveda + en_cajon`, y la migración `[CG.139]` lo comprueba fila por fila.
   *
   * Opcional: un API por detrás del front no las manda, y ahí la pantalla muestra el `monto`.
   */
  en_boveda?: number;
  en_cajon?: number;
  beneficiario: string | null;
  /** El documento de Kepler que lo originó (`X-D-26 0023030`), si lo hay. */
  documento: string | null;
  concepto: string | null;
  cuenta: string | null;
  estado: string;
  origen: string | null;
  quien: string | null;
}

export interface ArqueoDia {
  fecha: string;
  sucursal: string;
  /**
   * `[CG.91]` El historial de la jornada. Opcional porque el API puede ir por detrás del front
   * (deploy parcial): si no viene, la pantalla no pinta la lista en vez de reventar. Ausente NO
   * es "no hubo movimientos" — eso lo dice `caja_general.movimientos`.
   */
  movimientos_del_dia?: ArqueoMovimientoDia[];
  caja_general: {
    movimientos: number; cancelados: number;
    ingresos: number; gastos: number; depositos: number;
    /** ingresos − gastos − depósitos. Sin fondo inicial: eso compone el esperado, que va gateado. */
    neto: number;
    /**
     * `[CG.82]` De los movimientos de la jornada, cuántos traen el documento de Kepler fechado
     * OTRO día. La jornada se arma por el día en que se REGISTRÓ el efectivo — el único reloj en
     * el que el otro lado del cuadre también está: el `accounting_date` del cajero coincide con el
     * día físico en 455 de 456 movimientos de 60 días. Este número dice cuánto de la jornada es
     * papel de antes, y por eso viaja como número y no sólo como frase en `limites`.
     */
    fechados_otro_dia: number;
    /**
     * `[CG.97]` Lo que de verdad quedó en el cajón, en el modelo de **cajas separadas**: la caja
     * chica es efectivo suelto y el cajero es la bóveda.
     *
     *     en_el_cajon = ingresos − gastos − depósitos + dispensado − depositado
     *
     * `null` cuando esta sucursal no tiene cajero o el feed no está. **No es cero**: un cero
     * afirmaría que no quedó nada en el cajón, que es otra cosa que no poder saberlo.
     */
    en_el_cajon?: number | null;
    /** `[CG.97]` Lo que la jornada le dejó a la bóveda, neto. Positivo = la bóveda creció. */
    a_la_boveda?: number | null;
    /**
     * `[CG.180]` **Las dos mitades del cajón, ACOPLADAS: o están las dos o no está ninguna.**
     *
     * Los dos campos de arriba se declaran nullables por separado y la plantilla pintaba
     * `a_la_boveda!` bajo la guarda de `en_el_cajon != null` — correcto hoy porque el servidor
     * los emite juntos, y a una línea de dibujar **$0.00** el día que uno se volviera null por su
     * cuenta. El backend los acopló en el origen (`cash-cut.service.ts`), así que la guarda es
     * una sola y el tipo la expresa.
     *
     * `null` = no hay cajero (cualquier sucursal que no sea OFICINAS, o el feed caído), que es
     * distinto de «quedó en cero». ⚠️ Opcional mientras la API desplegada no lo mande: hasta
     * entonces se arma de los dos planos, que el servidor conserva con su forma exacta.
     */
    cajon?: { en_el_cajon: number; a_la_boveda: number } | null;
    /**
     * ⭐⭐ `[CG.139]` **La parte de la jornada que se quedó la máquina, y por eso ya no está en
     * `ingresos` ni en `gastos`.**
     *
     * Medido en prod el 2026-10-13: de $290,525 publicados como ingreso de caja general,
     * $203,662 estaban dentro del cajero y sólo $86,863 llegaron al cajón. Y el reparto es por
     * peso, no por movimiento — un cobro de ruta entra como UNO y se parte: los billetes a la
     * bóveda, la morralla al cajón.
     *
     * ⚠️ `movimientos` cuenta los que **tocaron** la bóveda, no los que «son de CAOS».
     */
    se_fue_a_boveda?: { ingresos: number; gastos: number; movimientos: number };
    /**
     * `[CG.99]` Con qué arrancó el cajón: el corte abierto, o el `contado` del último corte
     * sellado. **`null` = no se midió**, y es distinto de cero — sin esto `en_el_cajon` es sólo
     * un movimiento y no se puede publicar como saldo.
     */
    fondo_inicial?: number | null;
  };
  /** `null` cuando la sucursal no tiene cajero o el feed no está. El motivo viaja en `no_medido`. */
  cajero: {
    por_tipo: ArqueoTipoCajero[];
    entra: number; sale: number; neto: number;
    depositado: number; dispensado: number; dotado: number; vaciado: number;
    movimientos: number;
    tipos_desconocidos: Array<{ type_id: number; etiqueta: string; monto: number }>;
    ultimo_movimiento: string | null;
  } | null;
  /**
   * `[CG.90.1]` `fondo_inicial` es `number | null` y el `null` SIGNIFICA algo: no se midió, que
   * no es lo mismo que haber arrancado en cero. De eso cuelga si la pantalla ofrece declararlo.
   * Opcionales porque el API puede ir por detrás del front en un deploy parcial.
   */
  corte_abierto: {
    id: string; folio: string; fecha: string;
    fondo_inicial?: number | null; fondo_origen?: string | null;
  } | null;
  /**
   * `[CG.29]` Lo que ESTA jornada no pudo afirmar y que **alguien puede cambiar hoy**. Se pinta
   * fuerte: es lo que separa «el movimiento registrado» de «un arqueo firmado».
   */
  no_medido: string[];
  /**
   * `[CG.29]` Lo que este cuadre **nunca** va a cubrir, por cómo son las fuentes. Permanente: sale
   * todos los días. Va en segundo plano — un aviso que aparece siempre y que nadie puede resolver
   * deja de leerse, y se lleva puesto al que sí importaba.
   */
  limites?: string[];
}
