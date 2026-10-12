import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { Freshness, Coverage } from '@megadulces/contracts';
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

/**
 * ⛔ `freshness` y `coverage` vienen del CONTRATO, no redeclarados acá.
 *
 * Copiarlos a mano es lo que `[VP.2.1]` subió a `libs/contracts` justamente para evitar — el tipo
 * nació el 02-sep y a los tres días ya estaba duplicado en el frontend. Y no es cosmético: la
 * copia escribía `status: string` en `inputs`, que **compila sola** y revienta recién al pasársela
 * a `<app-freshness-pill>`, cuyo input exige la unión `'fresh' | 'stale' | 'unknown'`.
 *
 * ⚠️ Eso sólo lo ve `Build & typecheck`: `vitest` no tipa las plantillas (lección de
 * `ONBOARDING §8.0b` punto 5, y de `#346`). Las 23+563+39 pruebas estaban verdes con esto roto.
 */
export interface MiCierreResp {
  bandeja: Bandeja;
  freshness: Freshness;
  coverage: Coverage;
  query_ms: number;
}
