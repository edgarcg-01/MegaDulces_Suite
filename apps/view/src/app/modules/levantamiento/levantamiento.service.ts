import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  LevantamientoBusquedaFila, LevantamientoCalidadFoto, LevantamientoCara, LevantamientoContexto, LevantamientoDetalleTipo, LevantamientoEscaneoDto,
  LevantamientoEscaneoRespuesta, LevantamientoFotoCara, LevantamientoFotoRespuesta, LevantamientoMotivoSalto, LevantamientoSugeridosRespuesta,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[NP.7]` Levantamiento del Catálogo digital: `/api/catalog/levantamiento`.
 * `[NP.7.L.20]` Ninguna llamada manda sucursal: el servidor la decide con el perfil y el alcance de la
 * persona (antes, quien no tenía sucursal en su perfil la elegía, D25).
 */
@Injectable({ providedIn: 'root' })
export class LevantamientoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/catalog/levantamiento`;

  contexto(): Observable<LevantamientoContexto> {
    return this.http.get<LevantamientoContexto>(`${this.base}/context`);
  }

  sugeridos(limit = 3, offset = 0): Observable<LevantamientoSugeridosRespuesta> {
    return this.http.get<LevantamientoSugeridosRespuesta>(`${this.base}/suggested`, { params: new HttpParams().set('limit', limit).set('offset', offset) });
  }

  /** `[NP.7.L.10]` Buscador de respaldo: código, SKU o nombre. Sin precio (lista blanca del servidor). */
  buscar(q: string): Observable<LevantamientoBusquedaFila[]> {
    return this.http.get<LevantamientoBusquedaFila[]>(`${this.base}/search`, { params: new HttpParams().set('q', q) });
  }

  escanear(dto: LevantamientoEscaneoDto): Observable<LevantamientoEscaneoRespuesta> {
    return this.http.post<LevantamientoEscaneoRespuesta>(`${this.base}/scan`, dto);
  }

  /** Multipart: el controlador usa `FileInterceptor('file')`. */
  /** Una cara, o un detalle (`detalle_n`) con lo que muestra: el detalle sólo se acepta ya terminada la captura. */
  subirFoto(
    sheetId: string, face: LevantamientoFotoCara, foto: Blob, calidad: LevantamientoCalidadFoto, ancho: number, alto: number,
    detalle?: { tipo: LevantamientoDetalleTipo; nota: string | null },
  ): Observable<LevantamientoFotoRespuesta> {
    const fd = new FormData();
    fd.append('face', face);
    if (detalle) {
      fd.append('detail_kind', detalle.tipo);
      if (detalle.nota) fd.append('detail_note', detalle.nota);
    }
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
