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
  /** `[PR.V14]` Tratamientos que aterrizaron y luego se movieron · controles que aterrizaron. */
  movidas: number; contaminadas: number;
  primera_captura: string | null; ultima_captura: string | null;
  dias_dispersion: number | null;
}

/**
 * `[PR.V14]` Una celda del tratamiento. `precio_hoy`/`propuesto_hoy` son los de HOY (la lista del
 * día de la asignación envejece); `precio_antes`/`precio_propuesto` quedan como el diseño.
 * `aplicado_at` es la aplicación EFECTIVA: la marcada a mano o la detectada en la bitácora.
 */
export interface CapturaRow {
  id: string; sucursal: string; sku: string; estrato: string; unidad: string | null;
  precio_antes: string; precio_propuesto: string;
  precio_hoy: string | null; propuesto_hoy: string | null; alza_pct: string | null;
  aplicado_at: string | null; aplicado_por: string | null;
  fuente_aplicacion: 'marcada' | 'bitacora' | null;
  estado_celda: 'pendiente' | 'aplicada' | 'aplicada_y_movida' | 'sin_ficha';
}

export interface ResultadoRow {
  estrato: string; delta_pct: string; n_trat: number; n_ctrl: number;
  cambio_trat_pct: string; cambio_ctrl_pct: string;
  /** NULL mientras no hay celdas medibles (sin_arrancar / en_curso): no se pinta un cero. */
  efecto_pct: string | null; ic_inferior_pct: string | null; ic_superior_pct: string | null;
  veredicto: string; veredicto_motivo: string;
  /** `[PR.V14]` Lo que dice por qué todavía no hay veredicto, o qué quedó fuera. */
  n_trat_aplicadas: number; n_trat_pendientes: number; n_en_curso: number;
  n_excluidas_cambio_precio: number; n_ctrl_contaminadas: number;
  arranque: string | null; ventana_cierra: string | null;
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

  disenar(nombre: string, modo: string, semilla: number, estratos?: string[]): Observable<unknown> {
    return this.http.post(this.base, { nombre, modo, semilla, estratos });
  }
}
