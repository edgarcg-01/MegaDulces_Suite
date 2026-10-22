import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import type { Freshness, Coverage } from '@megadulces/contracts';
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

  /** `[LC.21]` Los renglones de póliza detrás de una celda del semáforo (o lo fechado adelante). */
  renglones(mes: string, familia: string, provisional = false, page = 1): Observable<RenglonesCierre> {
    const q = `mes=${encodeURIComponent(mes)}&familia=${encodeURIComponent(familia)}&page=${page}`
      + (provisional ? '&provisional=true' : '');
    return this.http.get<RenglonesCierre>(`${this.base}/cierre/renglones?${q}`);
  }
}

/** `[LC.21]` Los renglones de una familia en un mes, y lo que dice el semáforo de esa misma celda. */
export interface RenglonesCierre {
  mes: string;
  familia: string;
  etiqueta: string;
  filtro: string;
  provisional: boolean;
  page: number;
  page_size: number;
  renglones: number;
  importe: number;
  /** La cifra de la matvista (recalculada @15 min). `null` = esa celda no existe en el semáforo. */
  semaforo: { importe: number | null; renglones: number | null } | null;
  filas: {
    cuenta: string; cuenta_nombre: string | null; tipo_pol: string; folio: string; num_movto: number;
    cargo_abono: string; importe: number; concepto: string | null; referencia: string | null;
  }[];
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
  /** ⭐ Sobre cuántos meses descansa la mediana. Un veredicto sobre n=1 no es un veredicto. */
  mediana_meses: number;
  cobertura: number | null;
  estado: EstadoCierre;
  motivo: string | null;
  escala_a: string | null;
  umbral: { target: number; warn_at: number; escalate_at: number } | null;
  /** ⭐ El color lo decidió el TECHO (sobra), no el piso (falta): posible mes duplicado. */
  por_exceso: boolean;
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
  /**
   * ⛔ `[CPA.10]` Esto era una copia a mano del contrato, con `status: string` dentro de `inputs`.
   * Compilaba sola —acá nadie la pasaba a `<app-freshness-pill>`— y reventaba recién al intentarlo
   * desde la bandeja, donde el input del componente exige la unión. Es exactamente lo que
   * `[VP.2.1]` subió a `libs/contracts` para que nadie volviera a copiarlo: medido el 2026-10-12,
   * era **el único** lugar del repo que todavía lo hacía.
   */
  freshness: Freshness;
  coverage: Coverage;
  /** Milisegundos reales de la consulta. Se muestra: un tiempo que molesta y se ve es un problema. */
  query_ms: number;
}
