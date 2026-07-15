import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** FISCAL.10.1 — cliente del expediente de materialidad. /fiscal/materialidad. */

export interface MaterialidadDossier {
  rfc: string;
  beneficiario: string | null;
  operaciones: number;
  monto_total: number;
  periodo: { desde: string | null; hasta: string | null };
  listas_negras: { lista: string; situacion: string; nombre: string | null; doc_count: number; importe_total: number; estado: string }[];
  en_lista_riesgo: boolean;
  cfdis: { total: number; cancelados: number; monto: number };
  cadena_suministro: { cadenas: number; con_orden: number; con_recepcion: number; con_pago: number; recepcion_pct: number };
  veredicto: { nivel: string; mensaje: string };
}

@Injectable({ providedIn: 'root' })
export class MaterialidadService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/materialidad`;

  dossier(rfc: string): Observable<MaterialidadDossier> { return this.http.get<MaterialidadDossier>(`${this.base}/${encodeURIComponent(rfc)}`); }
}
