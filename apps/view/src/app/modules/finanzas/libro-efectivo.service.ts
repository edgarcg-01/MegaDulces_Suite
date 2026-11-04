import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { PagoEnVentanilla, PlanDePagoVentanilla, ResultadoPago, SaldosDelLibro, VeredictoDePago } from '@megadulces/contracts';
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
}
