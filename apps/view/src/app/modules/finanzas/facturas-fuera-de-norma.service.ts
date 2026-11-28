import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { BandejaFueraDeNorma, DecidirNormaDto, DecisionTomada, RevocarDecisionNormaDto } from '@megadulces/contracts';

/** `[PGP.229]` La bandeja «Facturas fuera de norma»: leer, decidir y revocar (`finance/norma-fiscal`). */
@Injectable({ providedIn: 'root' })
export class FacturasFueraDeNormaService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/norma-fiscal`;

  bandeja(): Observable<BandejaFueraDeNorma> {
    return this.http.get<BandejaFueraDeNorma>(`${this.base}/bandeja`);
  }

  decidir(uuid: string, dto: DecidirNormaDto): Observable<DecisionTomada> {
    return this.http.post<DecisionTomada>(`${this.base}/${encodeURIComponent(uuid)}/decision`, dto);
  }

  revocar(id: string, dto: RevocarDecisionNormaDto): Observable<{ id: string; revocada: true }> {
    return this.http.post<{ id: string; revocada: true }>(`${this.base}/decisiones/${encodeURIComponent(id)}/revocar`, dto);
  }
}
