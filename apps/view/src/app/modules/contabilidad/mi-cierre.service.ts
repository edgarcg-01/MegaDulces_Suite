import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[CPA.10]` — Cliente de la **bandeja «Mi cierre»** (`/contabilidad/mi-cierre`).
 *
 * ⚠️ Es el cuarto cliente que habla con ContPAQi, y hace algo distinto de los otros tres:
 *  · `contabilidad-contpaqi.service.ts` → lee los LIBROS que ContPAQi ya tiene (balanza, bancos).
 *  · `contpaqi-puente.service.ts`       → mira la IDA (qué egreso saldría de póliza).
 *  · `cierre-contable.service.ts`       → vigila el CIERRE: qué mes está asentado y cuál no.
 *  · éste                                → la BANDEJA: qué le toca teclear a contabilidad este
 *    mes y de eso cuánto se arma solo.
 *
 * ⛔ El único `POST` **no escribe a ContPAQi** (ADR-040): registra lo que la contadora dice que
 * pasó allá. Y `verificada` sólo viaja como `true` cuando hay bitácora que lo respalde.
 */
@Injectable({ providedIn: 'root' })
export class MiCierreService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/contabilidad/mi-cierre`;

  bandeja(mes?: string): Observable<MiCierreResp> {
    return this.http.get<MiCierreResp>(`${this.base}${mes ? `?mes=${encodeURIComponent(mes)}` : ''}`);
  }

  registrarResultado(
    eventoTipo: string,
    periodo: string,
    body: { resultado: ResultadoEntrega; verificada?: boolean | null; motivo?: string | null },
  ): Observable<{ actualizadas: number; estado: string; verificada: boolean | null }> {
    return this.http.post<{ actualizadas: number; estado: string; verificada: boolean | null }>(
      `${this.base}/${encodeURIComponent(eventoTipo)}/${encodeURIComponent(periodo)}/resultado`, body);
  }
}

/** Tres resultados, no dos: «se cargó sin afectar» es un desenlace real del importador. */
export type ResultadoEntrega = 'aplicada' | 'sin_afectar' | 'rechazada';

/**
 * En qué parte del camino va cada familia. ⛔ `aplicada_sin_verificar` es un estado PROPIO: no es
 * un matiz de `aplicada`. Pintarlos igual convierte «nadie comprobó» en «listo».
 */
export type EstadoBandeja =
  | 'lista' | 'entregada' | 'aplicada' | 'aplicada_sin_verificar'
  | 'rechazada' | 'falta_mapa' | 'no_automatizable';

export interface RequisitoMapa { clave: string; descripcion: string }

export interface FilaBandeja {
  familia: string;
  etiqueta: string;
  orden: number;
  renglones: number;
  polizas: number;
  cargos: number;
  /** De dónde saldría el asiento de este lado. `null` cuando no hay fuente. */
  fuente: string | null;
  automatizable: boolean;
  estado: EstadoBandeja;
  /** Por qué no se puede armar, o por qué quedó sin verificar. */
  motivo: string | null;
  /** Quién lo destraba. Una deuda sin dueño no se paga. */
  dueno: string | null;
  requiere: RequisitoMapa[];
  /** ⛔ TERNARIO. `null` = nadie comprobó; NO es `false`. */
  verificada: boolean | null;
  actualizada_en: string | null;
}

export interface Bandeja {
  anio_mes: string;
  en_curso: boolean;
  total_renglones: number;
  automatizables: number;
  /** `null` cuando el mes no tiene renglones: no es 0 % ni 100 %. */
  cobertura_pct: number | null;
  conteo: Record<EstadoBandeja, number>;
  filas: FilaBandeja[];
}

export interface MiCierreResp {
  bandeja: Bandeja;
  freshness: {
    data_as_of: string | null;
    status: 'fresh' | 'stale' | 'unknown';
    stale: boolean;
    age_human: string | null;
    inputs: Array<{ key: string; label: string; at: string | null; age_human: string | null; status: string; stale: boolean }>;
  };
  coverage: { measured: boolean; pct: number | null; note: string };
  query_ms: number;
}
