import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { ProofFile, ProofFileRole, ExpenseClasificacion } from './comprobaciones.service';

/**
 * GX.9 — cliente de la captura de gasto **por link** (superficie pública, sin sesión).
 *
 * Todo pasa por el token de la URL. Estas rutas están exceptuadas en `authInterceptor`:
 * si el celular arrastra un token viejo, pegarlo rompería la petición pública.
 */

/** Lo que el trabajador ve de una captura suya — su estado dicho en llano, no el interno. */
export interface CapturaMia {
  id: string;
  folio_solicitud: string | null;
  status: string;
  estado: string;
  proveedor: string;
  importe: number;
  fecha_gasto: string | null;
  comentarios: string | null;
  motivo_rechazo: string | null;
  revision_nota: string | null;
  created_at: string;
}

export interface CapturaContext {
  persona: string;
  sucursal: string | null;
  sucursales: { code: string; label: string }[];
  capturas: CapturaMia[];
}

export interface CapturaSubmit {
  importe: number;
  concepto: string;
  beneficiario: string;
  sucursal: string;
  fecha_gasto?: string;
  clasificacion: ExpenseClasificacion;
  comentarios?: string;
  files: ProofFile[];
  camera?: 'live' | 'file';
  captured_at?: string;
  user_agent?: string;
}

@Injectable({ providedIn: 'root' })
export class CapturaGastoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/captura`;

  context(token: string): Observable<CapturaContext> {
    return this.http.get<CapturaContext>(`${this.base}/${token}`);
  }

  /** De a un archivo: en un celular con datos móviles, una falla no debe tirar las demás. */
  uploadFile(token: string, fileBase64: string, role: ProofFileRole): Observable<ProofFile> {
    return this.http.post<ProofFile>(`${this.base}/${token}/upload`, { file_base64: fileBase64, role });
  }

  submit(token: string, dto: CapturaSubmit): Observable<{ id: string; status: string; estado: string }> {
    return this.http.post<{ id: string; status: string; estado: string }>(`${this.base}/${token}`, dto);
  }
}
