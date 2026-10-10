import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[CPA.0]` — Cliente del **semáforo de cierre contable** (`/contabilidad/cierre`).
 *
 * ⚠️ Es el tercer cliente que habla con ContPAQi y hace algo distinto de los otros dos:
 *  · `contabilidad-contpaqi.service.ts` → lee los LIBROS que ContPAQi ya tiene (balanza, bancos).
 *  · `contpaqi-puente.service.ts`       → mira la IDA (qué egreso saldría de póliza).
 *  · éste                                → vigila el CIERRE: qué mes está asentado y cuál no.
 *
 * ⛔ Solo lectura, sin `POST`: este tablero señala, no asienta. Quien arregla el mes que falta es
 * el módulo del Libro de Compras o la contadora (ADR-040).
 */
@Injectable({ providedIn: 'root' })
export class CierreContableService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/contabilidad/contpaqi`;

  cierre(desde?: string, hasta?: string): Observable<CierreResp> {
    const p: string[] = [];
    if (desde) p.push(`desde=${encodeURIComponent(desde)}`);
    if (hasta) p.push(`hasta=${encodeURIComponent(hasta)}`);
    return this.http.get<CierreResp>(`${this.base}/cierre${p.length ? '?' + p.join('&') : ''}`);
  }
}

/** Los cinco estados de `[CDRP.2]`. Las dos ausencias se distinguen a propósito. */
export type EstadoCierre = 'ok' | 'warn' | 'bad' | 'sin_meta' | 'sin_medir';

export interface FamiliaCierre {
  familia: string;
  etiqueta: string;
  /** Qué cuentas la miden. Procedencia: el número dice con qué se calculó. */
  senal_cuentas: string;
  senal: number;
  /** ⛔ `0 renglones` y `$0` NO son lo mismo. Por eso el conteo viaja junto al importe. */
  senal_renglones: number;
  /** Lo que ContPAQi tiene fechado en el futuro. No se suma a la señal: se declara aparte. */
  provisional: number | null;
  testigo: number | null;
  testigo_fuente: string | null;
  cobertura_base: 'testigo' | 'historia';
  mediana_6m: number | null;
  cobertura: number | null;
  estado: EstadoCierre;
  motivo: string | null;
  escala_a: string | null;
  umbral: { target: number; warn_at: number; escalate_at: number } | null;
}

export interface MesCierre {
  anio_mes: string;
  periodo_estado: 'cerrado' | 'en_curso';
  estado: EstadoCierre;
  conteo: Record<EstadoCierre, number>;
  familias: FamiliaCierre[];
}

export interface CierreResp {
  meses: MesCierre[];
  freshness: {
    data_as_of: string | null;
    status: 'fresh' | 'stale' | 'unknown';
    stale: boolean;
    age_human: string | null;
    inputs: Array<{ key: string; label: string; at: string | null; age_human: string | null; status: string; stale: boolean }>;
  };
  coverage: { measured: boolean; pct: number | null; note: string };
  /** Milisegundos reales de la consulta. Se muestra: un tiempo que molesta y se ve es un problema. */
  query_ms: number;
}
