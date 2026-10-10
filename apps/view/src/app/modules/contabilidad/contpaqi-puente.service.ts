import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[CP.8.33]` — Cliente de **la bandeja del puente** (`/contabilidad/contpaqi-puente`).
 *
 * ⚠️ No confundir con `contabilidad-contpaqi.service.ts`, que es el otro sentido: ése LEE los
 * libros fiscales que ya están en ContPAQi (balanza, bancos, EFOS). Éste mira la **ida**: qué
 * saldría de póliza desde los egresos de banco, y qué no sale y por qué.
 *
 * ⛔ Los dos endpoints son de SOLO LECTURA y no existe `entregar`: nunca se importó un archivo
 * a ContPAQi, así que la pantalla no ofrece un camino que nadie recorrió.
 */
@Injectable({ providedIn: 'root' })
export class ContpaqiPuenteService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/contpaqi`;

  lotes(mes?: string): Observable<LotesResp> {
    const qs = mes ? `?mes=${encodeURIComponent(mes)}` : '';
    return this.http.get<LotesResp>(`${this.base}/lotes${qs}`);
  }

  cuadre(): Observable<CuadreResp> {
    return this.http.get<CuadreResp>(`${this.base}/cuadre`);
  }
}

/** Un lote = una póliza candidata, al grano real: **(cuenta de banco × día)**. */
export interface LoteRow {
  cuenta_banco: string;
  /** Cómo lo nombra finanzas (`BBAJIO 4166`). Viaja ADEMÁS de la cuenta, no en vez de ella. */
  banco_label: string | null;
  fecha: string;
  movimientos: number;
  incluidas: number;
  renglones: number;
  total: number;
  iva_traspaso: 'no_emitido' | null;
  /** Conteo POR motivo. Cuatro rechazos distintos tienen cuatro dueños distintos. */
  motivos: Record<string, number>;
}

/**
 * `[CP.8.34]` Lo que no entra a ningún lote, con nombre e importe.
 * Medido en enero: `CAJA CG` (864) y `FACTORAJE FAC` (12) — **no son bancos**, no les falta
 * un mapeo. Se declara para que `movimientos` no se lea como el universo del mes.
 */
export interface FueraDeLote {
  movimientos: number;
  importe: number;
  cuentas: { cuenta: string; movimientos: number; importe: number }[];
}

export interface LotesResp {
  mes: string;
  lotes: LoteRow[];
  resumen: {
    lotes: number;
    con_asiento: number;
    movimientos: number;
    incluidas: number;
    universo: number;
  };
  fuera_de_lote: FueraDeLote;
  /** Ya viene ordenado de mayor a menor: lo primero que se ve es lo que más trabajo representa. */
  motivos: { motivo: string; movimientos: number; dueno: string }[];
}

export interface CuadreResp {
  /**
   * ⭐ `false` = **nunca se entregó nada**. Sin esto, un `0 %` de cuadre se lee como "falla"
   * cuando lo que pasa es que el denominador es cero (ADR-056).
   */
  hay_entregas: boolean;
  por_estado: Record<string, number>;
  verificadas: number;
  esperando: number;
  divergentes: number;
  plazo_dias: number;
}
