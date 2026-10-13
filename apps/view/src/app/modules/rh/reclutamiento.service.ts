import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  HrCandidatoEdicion, HrCandidatoEventoDto, HrCandidatoEventoNuevo, HrCandidatoFichaDto, HrCandidatosListaDto,
  HrCasilleroDto, HrDocumentoNuevo, HrDuplicadoGrupoDto, HrLigaCreadaDto, HrFusionResultadoDto, HrReingresoAlertaDto, HrTalentApartado,
  HrTalentEtapa, HrTiempoPorEtapaDto, HrVacanteDto, HrVacanteEdicion,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * Fase RH · `[RH.2.3]` — el cliente HTTP de Reclutamiento (`/api/hr/talent/*`). Los tipos vienen del contrato
 * (`hr-talent.contract.ts`): el servidor los construye con los mismos.
 */
@Injectable({ providedIn: 'root' })
export class ReclutamientoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/hr/talent`;

  candidatos(q: { view?: HrTalentApartado; stage?: HrTalentEtapa | null; branch?: string | null; q?: string; limit?: number; offset?: number }): Observable<HrCandidatosListaDto> {
    let p = new HttpParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p = p.set(k, String(v));
    return this.http.get<HrCandidatosListaDto>(`${this.base}/candidates`, { params: p });
  }

  ficha(id: string): Observable<HrCandidatoFichaDto> {
    return this.http.get<HrCandidatoFichaDto>(`${this.base}/candidates/${encodeURIComponent(id)}`);
  }

  editar(id: string, b: HrCandidatoEdicion): Observable<HrCandidatoFichaDto> {
    return this.http.patch<HrCandidatoFichaDto>(`${this.base}/candidates/${encodeURIComponent(id)}`, b);
  }

  moverEtapa(id: string, stage: HrTalentEtapa): Observable<HrCandidatoFichaDto> {
    return this.http.post<HrCandidatoFichaDto>(`${this.base}/candidates/${encodeURIComponent(id)}/stage`, { stage });
  }

  evento(id: string, b: HrCandidatoEventoNuevo): Observable<HrCandidatoEventoDto> {
    return this.http.post<HrCandidatoEventoDto>(`${this.base}/candidates/${encodeURIComponent(id)}/events`, b);
  }

  noRecontratable(id: string, mark: boolean, reason: string): Observable<HrCandidatoFichaDto> {
    return this.http.post<HrCandidatoFichaDto>(`${this.base}/candidates/${encodeURIComponent(id)}/no-rehire`, { mark, reason });
  }

  spam(id: string, mark: boolean, reason: string): Observable<HrCandidatoFichaDto> {
    return this.http.post<HrCandidatoFichaDto>(`${this.base}/candidates/${encodeURIComponent(id)}/spam`, { mark, reason });
  }

  aPapelera(id: string, reason: 'manual' | 'cierre_seguimiento'): Observable<HrCandidatoFichaDto> {
    return this.http.post<HrCandidatoFichaDto>(`${this.base}/candidates/${encodeURIComponent(id)}/trash`, { reason });
  }

  restaurar(id: string): Observable<HrCandidatoFichaDto> {
    return this.http.post<HrCandidatoFichaDto>(`${this.base}/candidates/${encodeURIComponent(id)}/restore`, {});
  }

  fusionar(conservarId: string, absorbId: string): Observable<HrFusionResultadoDto> {
    return this.http.post<HrFusionResultadoDto>(`${this.base}/candidates/${encodeURIComponent(conservarId)}/merge`, { absorb_id: absorbId });
  }

  casilleros(): Observable<HrCasilleroDto[]> {
    return this.http.get<HrCasilleroDto[]>(`${this.base}/candidates/document-slots`);
  }

  subirDocumento(id: string, b: HrDocumentoNuevo): Observable<HrCandidatoFichaDto> {
    return this.http.post<HrCandidatoFichaDto>(`${this.base}/candidates/${encodeURIComponent(id)}/documents`, b);
  }

  retirarDocumento(id: string, llave: string, reason: string): Observable<HrCandidatoFichaDto> {
    return this.http.post<HrCandidatoFichaDto>(`${this.base}/candidates/${encodeURIComponent(id)}/documents/retire`, { llave, reason });
  }

  /** `[RH.2.4]` Una liga personal para el candidato (subir su CV o el cuestionario de liderazgo), que vence en 7 días. */
  crearLiga(id: string, form: 'cv' | 'liderazgo' | 'aptitudes' = 'cv'): Observable<HrLigaCreadaDto> {
    return this.http.post<HrLigaCreadaDto>(`${this.base}/candidates/${encodeURIComponent(id)}/links`, { form });
  }

  duplicados(): Observable<HrDuplicadoGrupoDto[]> {
    return this.http.get<HrDuplicadoGrupoDto[]>(`${this.base}/candidates/duplicates`);
  }

  reingresos(): Observable<HrReingresoAlertaDto[]> {
    return this.http.get<HrReingresoAlertaDto[]>(`${this.base}/candidates/rehire-alerts`);
  }

  tiempoPorEtapa(): Observable<{ fases: HrTiempoPorEtapaDto[]; total: number }> {
    return this.http.get<{ fases: HrTiempoPorEtapaDto[]; total: number }>(`${this.base}/candidates/stage-times`);
  }

  vacantes(active?: boolean): Observable<HrVacanteDto[]> {
    const params = active === undefined ? undefined : new HttpParams().set('active', String(active));
    return this.http.get<HrVacanteDto[]>(`${this.base}/jobs`, { params });
  }

  crearVacante(b: HrVacanteEdicion): Observable<HrVacanteDto> {
    return this.http.post<HrVacanteDto>(`${this.base}/jobs`, b);
  }

  editarVacante(id: string, b: HrVacanteEdicion): Observable<HrVacanteDto> {
    return this.http.patch<HrVacanteDto>(`${this.base}/jobs/${encodeURIComponent(id)}`, b);
  }
}
