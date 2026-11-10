import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  CandidatosTemporada, ConfirmarFechasTemporadaDto, ConfirmarFechasTemporadaRespuesta,
  DecisionesTemporadaDto, DecisionesTemporadaRespuesta, TemporadasVista,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';

/**
 * `[PQ.94]` Compras › Temporadas: `/api/compras/temporadas`. Los GET piden `COMPRAS_TEMPORADAS_VER`; los
 * POST, `COMPRAS_TEMPORADAS_GESTIONAR`. Es la única puerta de escritura de la temporada de un producto.
 */
@Injectable({ providedIn: 'root' })
export class TemporadasService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/compras/temporadas`;

  calendario(): Observable<TemporadasVista> {
    return this.http.get<TemporadasVista>(this.base);
  }

  /** Puede tardar ~1 s la primera vez: la API lo guarda por temporada-año. */
  candidatos(seasonDateId: string): Observable<CandidatosTemporada> {
    return this.http.get<CandidatosTemporada>(`${this.base}/fechas/${encodeURIComponent(seasonDateId)}/candidatos`);
  }

  /** Lote parcial: la respuesta dice cuántos entraron y cuáles no, con su motivo. */
  decidir(seasonId: string, dto: DecisionesTemporadaDto): Observable<DecisionesTemporadaRespuesta> {
    return this.http.post<DecisionesTemporadaRespuesta>(`${this.base}/${encodeURIComponent(seasonId)}/decisiones`, dto);
  }

  confirmarFechas(seasonDateId: string, dto: ConfirmarFechasTemporadaDto): Observable<ConfirmarFechasTemporadaRespuesta> {
    return this.http.post<ConfirmarFechasTemporadaRespuesta>(`${this.base}/fechas/${encodeURIComponent(seasonDateId)}/confirmar`, dto);
  }
}
