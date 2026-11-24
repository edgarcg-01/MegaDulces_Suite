import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  HrExpedienteFirmasDto, HrFirmaSemanaDto, HrFirmasSemanaDto, HrGenerarLigasFirmaBody, HrHojaFirmasDto, HrLigasFirmaDto, HrRegistrarFirmaBody,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * Fase RH · `[RH.15.5]` — La firma de la semana (LFT 132-XXXIV). Servicio propio para no mezclarse con `RhService`:
 * es lo único que habla con `/hr/attendance/signoffs`.
 */
@Injectable({ providedIn: 'root' })
export class RhFirmasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/hr/attendance/signoffs`;

  estado(site: string, periodStart: string): Observable<HrFirmasSemanaDto> {
    return this.http.get<HrFirmasSemanaDto>(this.base, { params: new HttpParams().set('site_code', site).set('period_start', periodStart) });
  }

  registrar(b: HrRegistrarFirmaBody): Observable<HrFirmaSemanaDto> {
    return this.http.post<HrFirmaSemanaDto>(this.base, b);
  }

  archivo(id: string): Observable<{ url: string }> {
    return this.http.get<{ url: string }>(`${this.base}/${id}/file`);
  }

  anular(id: string, motivo: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/${id}/void`, { motivo });
  }

  /** `[RH.15.11]` Los QR de un departamento para firmar en el celular. El token viaja sólo en esta respuesta. */
  generarLigas(b: HrGenerarLigasFirmaBody): Observable<HrLigasFirmaDto> {
    return this.http.post<HrLigasFirmaDto>(`${this.base}/digital/links`, b);
  }

  /** `[RH.15.11]` La hoja de un departamento con todas sus firmas (para el PDF). */
  hoja(site: string, periodStart: string, department: string): Observable<HrHojaFirmasDto> {
    return this.http.get<HrHojaFirmasDto>(`${this.base}/digital/sheet`, {
      params: new HttpParams().set('site_code', site).set('period_start', periodStart).set('department', department),
    });
  }

  /** `[RH.15.11]` El comprobante de una firma del celular: la semana exacta que firmó. */
  comprobante(id: string): Observable<HrHojaFirmasDto> {
    return this.http.get<HrHojaFirmasDto>(`${this.base}/digital/signatures/${id}/receipt`);
  }

  /** `[RH.15.11]` Las semanas firmadas de una persona: por su usuario (todas sus plazas) o, sin ligar, por plaza + número. */
  expediente(q: { userId?: string | null; site?: string; personCode?: string }): Observable<HrExpedienteFirmasDto> {
    const params = q.userId
      ? new HttpParams().set('user_id', q.userId)
      : new HttpParams().set('site_code', q.site ?? '').set('person_code', q.personCode ?? '');
    return this.http.get<HrExpedienteFirmasDto>(`${this.base}/digital/person`, { params });
  }

  /** `[RH.15.11]` El trazo de una firma del celular (liga temporal). */
  archivoFirma(id: string): Observable<{ url: string }> {
    return this.http.get<{ url: string }>(`${this.base}/digital/signatures/${id}/file`);
  }

  /** `[RH.15.11]` Anula una firma del celular con motivo (no se borra). */
  anularFirma(id: string, motivo: string): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`${this.base}/digital/signatures/${id}/void`, { motivo });
  }
}
