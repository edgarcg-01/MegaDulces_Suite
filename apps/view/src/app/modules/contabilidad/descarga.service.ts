import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.4 — cliente de la descarga masiva de CFDI. /fiscal/descarga. Operations. */

export interface DownloadRequest {
  id: string; rfc_solicitante: string; tipo_solicitud: string; rol: string;
  fecha_ini: string; fecha_fin: string; id_solicitud: string | null;
  estado: string; estado_solicitud: number | null; numero_cfdis: number | null;
  packages_total: number; packages_done: number; mensaje_sat: string | null;
  created_at: string; updated_at: string;
}
export interface DownloadPackage {
  id: string; id_paquete: string; estado: string; num_cfdis: number | null; last_error: string | null;
}
export interface CrearDescarga {
  rfcSolicitante: string; rol: 'emitidas' | 'recibidas'; tipo?: 'CFDI' | 'Metadata';
  fechaIni: string; fechaFin: string;
}

@Injectable({ providedIn: 'root' })
export class DescargaService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/descarga`;

  list(estado?: string): Observable<DownloadRequest[]> { return this.http.get<DownloadRequest[]>(`${this.base}${estado ? '?estado=' + estado : ''}`); }
  get(id: string): Observable<DownloadRequest & { packages: DownloadPackage[] }> { return this.http.get<DownloadRequest & { packages: DownloadPackage[] }>(`${this.base}/${id}`); }
  crear(body: CrearDescarga): Observable<{ id: string }> { return this.http.post<{ id: string }>(this.base, body); }
}
