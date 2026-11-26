import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { AplicacionCosto, DecisionCostoGuardada, GuardarDecisionCostoDto } from '@megadulces/contracts/http/application-cost';
import { environment } from '../../../environments/environment';

/** `[PQ.157]` Validar el costo al aplicar: la API `compras/costo-aplicado` (anexo R §3d–§3e). */
@Injectable({ providedIn: 'root' })
export class CostoAplicadoService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/compras/costo-aplicado`;

  /** Los renglones de una aplicación contra su OC, con su cadena, su decisión y su antecedente. */
  aplicacion(sucursal: string, folio: string): Observable<AplicacionCosto> {
    return this.http.get<AplicacionCosto>(`${this.base}/aplicaciones/${encodeURIComponent(sucursal)}/${encodeURIComponent(folio)}`);
  }

  /** Guarda (o reemplaza) la decisión de un renglón. Sólo con `COMPRAS_COSTO_DECIDIR`. */
  decidir(dto: GuardarDecisionCostoDto): Observable<DecisionCostoGuardada> {
    return this.http.post<DecisionCostoGuardada>(`${this.base}/decisiones`, dto);
  }
}
