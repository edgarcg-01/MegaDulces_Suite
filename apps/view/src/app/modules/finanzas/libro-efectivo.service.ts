import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  CobroEnVentanilla, CustodiaAbierta, EstadoDeCobro, ExplicarSuspenso, PersonaDeCustodia, RendirCustodia, ResultadoRendicion, RetiroACustodia, HojaDeReposicion, PagoEnVentanilla, PartidaEnSuspenso, PedirReposicion,
  PlanDePagoVentanilla, QuienLlevaDeposito, ResultadoCobro,
  ResultadoHecho, ResultadoPago, SaldosDelLibro, VeredictoDePago,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';
import { reintentarSi429 } from '../../core/utils/reintentar-429';

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
