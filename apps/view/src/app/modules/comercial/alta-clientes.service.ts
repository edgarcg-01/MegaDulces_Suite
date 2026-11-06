import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  BandejaAlta,
  CatalogosAlta,
  CrearSolicitudRespuesta,
  DecidirCreditoBody,
  EstadoSolicitudAlta,
  RevisionAlta,
  SolicitudAlta,
  SolicitudAltaBody,
  SubirConstanciaRespuesta,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/** `[ALC]` Alta de clientes: constancia → solicitud → crédito → liga con Kepler. */
@Injectable({ providedIn: 'root' })
export class AltaClientesService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/customer-onboarding`;

  catalogos(branch?: string | null): Observable<CatalogosAlta> {
    return this.http.get<CatalogosAlta>(`${this.base}/catalogs`, { params: branch ? new HttpParams().set('branch', branch) : undefined });
  }

  /** El PDF en data URI. La API lo lee, lo guarda y devuelve el prellenado; no crea nada. */
  subirConstancia(pdf: string, branch?: string | null): Observable<SubirConstanciaRespuesta> {
    return this.http.post<SubirConstanciaRespuesta>(`${this.base}/constancia`, { pdf, branch: branch ?? null });
  }

  revisar(body: SolicitudAltaBody): Observable<RevisionAlta> {
    return this.http.post<RevisionAlta>(`${this.base}/validate`, body);
  }

  crear(body: SolicitudAltaBody): Observable<CrearSolicitudRespuesta> {
    return this.http.post<CrearSolicitudRespuesta>(this.base, body);
  }

  bandeja(estado?: EstadoSolicitudAlta | null): Observable<BandejaAlta> {
    return this.http.get<BandejaAlta>(this.base, { params: estado ? new HttpParams().set('estado', estado) : undefined });
  }

  urlConstancia(id: string): Observable<{ url: string }> {
    return this.http.get<{ url: string }>(`${this.base}/${id}/constancia`);
  }

  decidirCredito(id: string, body: DecidirCreditoBody): Observable<SolicitudAlta> {
    return this.http.post<SolicitudAlta>(`${this.base}/${id}/credit`, body);
  }

  ligar(id: string, clave: string): Observable<SolicitudAlta> {
    return this.http.post<SolicitudAlta>(`${this.base}/${id}/link`, { erp_customer_code: clave });
  }

  cancelar(id: string, motivo: string): Observable<SolicitudAlta> {
    return this.http.post<SolicitudAlta>(`${this.base}/${id}/cancel`, { motivo });
  }
}
