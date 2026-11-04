import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  AsignarUsuarioDeMaquina, CobroEnVentanilla, OrdenPorFirmar, ConteoDeCaja, TopeDelCajon, UsuarioDeMaquina, CustodiaAbierta, EstadoDeCobro, HechoDePersona, ResultadoConteo, ExplicarSuspenso, PersonaDeCustodia, RendirCustodia, ResultadoRendicion, RetiroACustodia, HojaDeReposicion, PagoEnVentanilla, PartidaEnSuspenso, PedirReposicion,
  PlanDePagoVentanilla, QuienLlevaDeposito, ResultadoCobro,
  ResultadoHecho, ResultadoPago, SaldosDelLibro, VeredictoDePago,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';
import { reintentarSi429 } from '../../core/utils/reintentar-429';

/** `[LE.6.6]` Un hallazgo abierto del libro (la diferencia de un conteo, un hueco de la máquina…), como lo da `GET hallazgos`. */
export interface HallazgoDelLibro {
  id: string; source: string; account_code: string | null; business_date: string | null; amount_minor: string | null;
  detail: Record<string, unknown> | null; owner_user: string | null; opened_at: string; dias_abierto: number | null;
}

/** Una solicitud que espera la firma de otra persona (cuatro ojos), como la da `GET solicitudes`. */
export interface SolicitudDelLibro {
  id: string; event_kind: string; gross_minor: string; registered_by: string; created_at: string; expires_at: string;
  payload: { meta?: Record<string, string>; reason?: string } | null;
}

/**
 * `[LE.4.10]` `[LE.2.13]` El libro de efectivo nuevo (`finance/libro-efectivo`), del lado de la
 * Ventanilla. Los tipos son los del contrato: el endpoint y la pantalla no pueden desalinearse.
 */
@Injectable({ providedIn: 'root' })
export class LibroEfectivoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/libro-efectivo`;

  /** Si el día del libro está abierto (`jornada_abierta`): sin él la Ventanilla no paga. */
  saldos(): Observable<SaldosDelLibro> {
    return this.http.get<SaldosDelLibro>(`${this.base}/saldos`).pipe(reintentarSi429<SaldosDelLibro>());
  }

  /** El veredicto de cada documento de la cola, en un viaje (hasta 200). */
  veredictos(docs: readonly string[]): Observable<VeredictoDePago[]> {
    return this.http.get<VeredictoDePago[]>(`${this.base}/pagos/veredictos`, { params: new HttpParams().set('docs', docs.join(',')) })
      .pipe(reintentarSi429<VeredictoDePago[]>());
  }

  /** Qué sale de la máquina y qué del cajón (no escribe): el mismo motor que `pagar`. */
  plan(origenRef: string, cuentaKepler: string): Observable<PlanDePagoVentanilla> {
    return this.http.get<PlanDePagoVentanilla>(`${this.base}/pagos/plan`,
      { params: new HttpParams().set('origen_ref', origenRef).set('cuenta_kepler', cuentaKepler) });
  }

  /**
   * Paga. La llave la arma la pantalla UNA vez por intento: un reintento con la misma llave devuelve
   * el mismo resultado y no paga dos veces (el servidor lo garantiza; la base también).
   */
  pagar(body: PagoEnVentanilla, idempotencyKey: string): Observable<ResultadoPago> {
    return this.http.post<ResultadoPago>(`${this.base}/pagos`, body, { headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) });
  }

  /** `[LE.6.7]` Cómo está cada cobro de la cola (de ruta, de sucursal o detenido, y si ya se recibió), en un viaje. */
  estadoDeCobros(docs: readonly string[]): Observable<EstadoDeCobro[]> {
    return this.http.get<EstadoDeCobro[]>(`${this.base}/cobros/estado`, { params: new HttpParams().set('docs', docs.join(',')) })
      .pipe(reintentarSi429<EstadoDeCobro[]>());
  }

  /** `[LE.6.8]` La hoja de reposición de cada zona, desde la apertura del libro. */
  reposiciones(): Observable<HojaDeReposicion[]> {
    return this.http.get<HojaDeReposicion[]>(`${this.base}/reposiciones`).pipe(reintentarSi429<HojaDeReposicion[]>());
  }

  /** `[LE.6.8]` Quién puede llevar el depósito (D35). */
  quienLleva(): Observable<QuienLlevaDeposito[]> {
    return this.http.get<QuienLlevaDeposito[]>(`${this.base}/reposiciones/quien-lleva`).pipe(reintentarSi429<QuienLlevaDeposito[]>());
  }

  /** `[LE.6.8]` Pide la reposición: nace por firmar; la firma de Tesorería da el código. */
  pedirReposicion(body: PedirReposicion, idempotencyKey: string): Observable<ResultadoPago> {
    return this.http.post<ResultadoPago>(`${this.base}/reposiciones`, body, { headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) });
  }

  // ── `[LE.6.3]` `[LE.6.4]` `[LE.6.6]` Tu día: abrir, contar, cerrar, arqueo, hallazgos, firmas ──

  abrirJornada(fecha: string): Observable<void> {
    return this.http.post<void>(`${this.base}/jornadas/${encodeURIComponent(fecha)}/abrir`, {});
  }

  /** Cierra quien hizo el último arqueo de cierre; firma la sesión (Tesorería). */
  cerrarJornada(fecha: string): Observable<{ cerro: string; autorizo: string; excedente: string | null }> {
    return this.http.post<{ cerro: string; autorizo: string; excedente: string | null }>(`${this.base}/jornadas/${encodeURIComponent(fecha)}/cerrar`, {});
  }

  /** El conteo ciego por pieza: de cierre, sorpresa (sin esperado) o relevo. */
  contar(c: ConteoDeCaja): Observable<ResultadoConteo> {
    return this.http.post<ResultadoConteo>(`${this.base}/conteos`, c);
  }

  /** Un hecho de persona (aquí, la apertura con el saldo de arranque: siempre la autoriza otra persona). */
  registrarHecho(h: HechoDePersona, idempotencyKey: string): Observable<ResultadoHecho> {
    return this.http.post<ResultadoHecho>(`${this.base}/hechos`, h, { headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) });
  }

  hallazgos(): Observable<HallazgoDelLibro[]> {
    return this.http.get<HallazgoDelLibro[]>(`${this.base}/hallazgos`).pipe(reintentarSi429<HallazgoDelLibro[]>());
  }

  solicitudes(): Observable<SolicitudDelLibro[]> {
    return this.http.get<SolicitudDelLibro[]>(`${this.base}/solicitudes`).pipe(reintentarSi429<SolicitudDelLibro[]>());
  }

  autorizar(id: string): Observable<{ entry_id: string }> {
    return this.http.post<{ entry_id: string }>(`${this.base}/solicitudes/${encodeURIComponent(id)}/autorizar`, {});
  }

  rechazar(id: string, nota: string): Observable<void> {
    return this.http.post<void>(`${this.base}/solicitudes/${encodeURIComponent(id)}/rechazar`, { nota });
  }

  // ── `[LE.1.15]` Catálogos firmados ──────────────────────────────────────────────────────

  tope(): Observable<TopeDelCajon> {
    return this.http.get<TopeDelCajon>(`${this.base}/catalogos/tope`).pipe(reintentarSi429<TopeDelCajon>());
  }

  fijarTope(montoMinor: string): Observable<TopeDelCajon> {
    return this.http.post<TopeDelCajon>(`${this.base}/catalogos/tope`, { monto_minor: montoMinor });
  }

  usuariosDeMaquina(): Observable<UsuarioDeMaquina[]> {
    return this.http.get<UsuarioDeMaquina[]>(`${this.base}/catalogos/usuarios-maquina`).pipe(reintentarSi429<UsuarioDeMaquina[]>());
  }

  asignarUsuarioDeMaquina(body: AsignarUsuarioDeMaquina): Observable<UsuarioDeMaquina[]> {
    return this.http.post<UsuarioDeMaquina[]>(`${this.base}/catalogos/usuarios-maquina`, body);
  }

  /** `[LE.4.10]` Las órdenes que esperan la firma de Tesorería (pagos, reposiciones, custodias). */
  porFirmar(): Observable<OrdenPorFirmar[]> {
    return this.http.get<OrdenPorFirmar[]>(`${this.base}/ordenes/por-firmar`).pipe(reintentarSi429<OrdenPorFirmar[]>());
  }

  firmarOrden(id: string): Observable<ResultadoPago> {
    return this.http.post<ResultadoPago>(`${this.base}/ordenes/${encodeURIComponent(id)}/firmar`, {});
  }

  rechazarOrden(id: string, nota: string): Observable<void> {
    return this.http.post<void>(`${this.base}/ordenes/${encodeURIComponent(id)}/rechazar`, { nota });
  }

  /** `[LE.6.5]` Lo que cada persona tiene a su cargo. */
  custodias(): Observable<CustodiaAbierta[]> {
    return this.http.get<CustodiaAbierta[]>(`${this.base}/custodias`).pipe(reintentarSi429<CustodiaAbierta[]>());
  }

  /** `[LE.6.5]` Buscar a la persona (al menos 2 letras). */
  personas(q: string): Observable<PersonaDeCustodia[]> {
    return this.http.get<PersonaDeCustodia[]>(`${this.base}/custodias/personas`, { params: new HttpParams().set('q', q) });
  }

  /** `[LE.6.5]` Sacar dinero a la custodia de una persona. */
  retiroACustodia(body: RetiroACustodia, idempotencyKey: string): Observable<ResultadoPago | ResultadoHecho> {
    return this.http.post<ResultadoPago | ResultadoHecho>(`${this.base}/custodias`, body, { headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) });
  }

  /** `[LE.6.5]` Rendir una custodia. */
  rendir(body: RendirCustodia, idempotencyKey: string): Observable<ResultadoRendicion> {
    return this.http.post<ResultadoRendicion>(`${this.base}/custodias/rendir`, body, { headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) });
  }

  /** `[LE.6.8]` Cerrar una reposición con su depósito del banco. */
  confirmarDeposito(ordenId: string): Observable<ResultadoRendicion> {
    return this.http.post<ResultadoRendicion>(`${this.base}/reposiciones/${encodeURIComponent(ordenId)}/confirmar-deposito`, {});
  }

  /** `[LE.6.7]` Lo que la máquina hizo y nadie explicó, lo más viejo primero. */
  suspenso(): Observable<PartidaEnSuspenso[]> {
    return this.http.get<PartidaEnSuspenso[]>(`${this.base}/suspenso`).pipe(reintentarSi429<PartidaEnSuspenso[]>());
  }

  /** `[LE.6.7]` Explica un movimiento en Suspenso. El importe lo lee el servidor del libro. */
  explicar(body: ExplicarSuspenso, idempotencyKey: string): Observable<ResultadoHecho> {
    return this.http.post<ResultadoHecho>(`${this.base}/suspenso/explicar`, body, { headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) });
  }

  /** `[LE.6.7]` Recibe un cobro contado por pieza. Misma regla de la llave que `pagar`: un reintento no recibe dos veces. */
  recibir(body: CobroEnVentanilla, idempotencyKey: string): Observable<ResultadoCobro> {
    return this.http.post<ResultadoCobro>(`${this.base}/cobros`, body, { headers: new HttpHeaders({ 'Idempotency-Key': idempotencyKey }) });
  }
}
