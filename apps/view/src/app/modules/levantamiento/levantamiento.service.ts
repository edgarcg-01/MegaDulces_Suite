import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  LevantamientoBusquedaFila, LevantamientoCalidadFoto, LevantamientoCara, LevantamientoContexto, LevantamientoEscaneoDto, LevantamientoEscaneoRespuesta,
  LevantamientoFotoRespuesta, LevantamientoMotivoSalto, LevantamientoSugeridosRespuesta,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[NP.7]` Levantamiento del Catálogo digital: `/api/catalog/levantamiento`.
 * `branch` sólo viaja si la persona la ELIGIÓ (su perfil no tiene sucursal, D25); si no, el servidor
 * usa la de su perfil. El servidor valida siempre: el cliente no decide la sucursal por su cuenta.
 */
@Injectable({ providedIn: 'root' })
export class LevantamientoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/catalog/levantamiento`;

  private conSucursal(branch: string | null, extra: Record<string, string | number> = {}): HttpParams {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(extra)) p = p.set(k, String(v));
    return branch ? p.set('branch', branch) : p;
  }

  sucursales(): Observable<Array<{ code: string; name: string }>> {
    return this.http.get<Array<{ code: string; name: string }>>(`${this.base}/branches`);
  }

  contexto(branch: string | null): Observable<LevantamientoContexto> {
    return this.http.get<LevantamientoContexto>(`${this.base}/context`, { params: this.conSucursal(branch) });
  }

  sugeridos(branch: string | null, limit = 3, offset = 0): Observable<LevantamientoSugeridosRespuesta> {
    return this.http.get<LevantamientoSugeridosRespuesta>(`${this.base}/suggested`, { params: this.conSucursal(branch, { limit, offset }) });
  }

  /** `[NP.7.L.10]` Buscador de respaldo: código, SKU o nombre. Sin precio (lista blanca del servidor). */
  buscar(branch: string | null, q: string): Observable<LevantamientoBusquedaFila[]> {
    return this.http.get<LevantamientoBusquedaFila[]>(`${this.base}/search`, { params: this.conSucursal(branch, { q }) });
  }

  escanear(branch: string | null, dto: LevantamientoEscaneoDto): Observable<LevantamientoEscaneoRespuesta> {
    return this.http.post<LevantamientoEscaneoRespuesta>(`${this.base}/scan`, dto, { params: this.conSucursal(branch) });
  }

  /** Multipart: el controlador usa `FileInterceptor('file')`. */
  subirFoto(sheetId: string, face: LevantamientoCara, foto: Blob, calidad: LevantamientoCalidadFoto, ancho: number, alto: number): Observable<LevantamientoFotoRespuesta> {
    const fd = new FormData();
    fd.append('face', face);
    fd.append('sharpness', String(calidad.sharpness));
    fd.append('contrast', String(calidad.contrast));
    fd.append('quality_version', calidad.version);
    fd.append('width', String(ancho));
    fd.append('height', String(alto));
    fd.append('file', foto, `${face}.jpg`);
    return this.http.post<LevantamientoFotoRespuesta>(`${this.base}/sheets/${sheetId}/photos`, fd);
  }

  saltar(sheetId: string, face: LevantamientoCara, reason: LevantamientoMotivoSalto): Observable<LevantamientoFotoRespuesta> {
    return this.http.post<LevantamientoFotoRespuesta>(`${this.base}/sheets/${sheetId}/skip`, { face, reason });
  }

  soltar(sheetId: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/sheets/${sheetId}/release`, {});
  }
}
