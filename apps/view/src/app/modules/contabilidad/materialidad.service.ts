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

/** MAT.2 — una fila por factura de compra con sus documentos relacionados. */
export interface MaterialidadChain {
  key: string;
  sucursal: string;
  factura_folio: string; factura_fecha: string | null;
  orden_folio: string | null; orden_fecha: string | null;
  recepcion_folio: string | null; recepcion_fecha: string | null;
  pago_folio: string | null; pago_fecha: string | null;
  total: number;
  lead_days: number | null; pago_days: number | null;
  match_confidence: string | null;
  completa: boolean;
}

@Injectable({ providedIn: 'root' })
export class MaterialidadService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/fiscal/materialidad`;

  dossier(rfc: string): Observable<MaterialidadDossier> { return this.http.get<MaterialidadDossier>(`${this.base}/${encodeURIComponent(rfc)}`); }
  /** MAT.2 — desglose de documentos de la cadena de suministro del RFC. */
  chains(rfc: string): Observable<MaterialidadChain[]> { return this.http.get<MaterialidadChain[]>(`${this.base}/${encodeURIComponent(rfc)}/chains`); }
}
