import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** `[PR.D2]` Un estrato del experimento, con el número que lo habilita o lo descalifica. */
export interface EstratoDef {
  clave: string; min: number; max: number;
  deltaPct: number; nPorRama: number; viable: boolean; elegibles: number;
}

export interface ExperimentoRow {
  id: string; nombre: string; estado: string; tipo: string;
  modo_aterrizaje: string; semilla: number;
  fecha_inicio: string | null; fecha_fin: string | null;
  resultado: string | null; resultado_motivo: string | null;
  unidades: number; tratamiento: number; control: number; capturadas: number;
  primera_captura: string | null; ultima_captura: string | null;
  dias_dispersion: number | null;
}

export interface CapturaRow {
  id: string; sucursal: string; sku: string; estrato: string;
  precio_antes: string; precio_propuesto: string; alza_pct: string;
  aplicado_at: string | null; aplicado_por: string | null;
}

export interface ResultadoRow {
  estrato: string; delta_pct: string; n_trat: number; n_ctrl: number;
  cambio_trat_pct: string; cambio_ctrl_pct: string;
  efecto_pct: string; ic_inferior_pct: string; ic_superior_pct: string;
  veredicto: string; veredicto_motivo: string;
}

@Injectable({ providedIn: 'root' })
export class ExperimentosPrecioService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/price-experiments`;

  estratos(): Observable<{ estratos: EstratoDef[] }> {
    return this.http.get<{ estratos: EstratoDef[] }>(`${this.base}/estratos`);
  }

  listar(): Observable<ExperimentoRow[]> {
    return this.http.get<ExperimentoRow[]>(this.base);
  }

  captura(id: string): Observable<CapturaRow[]> {
    return this.http.get<CapturaRow[]>(`${this.base}/${id}/captura`);
  }

  resultados(id: string): Observable<ResultadoRow[]> {
    return this.http.get<ResultadoRow[]>(`${this.base}/${id}/resultados`);
  }

  marcarAplicada(unitId: string): Observable<{ id: string; aplicado_at: string }> {
    return this.http.patch<{ id: string; aplicado_at: string }>(
      `${this.base}/units/${unitId}/aplicada`, {});
  }

  disenar(nombre: string, modo: string, semilla: number, estratos?: string[]): Observable<unknown> {
    return this.http.post(this.base, { nombre, modo, semilla, estratos });
  }
}
