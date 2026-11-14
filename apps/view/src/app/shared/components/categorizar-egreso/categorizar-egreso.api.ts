import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

/**
 * `[CP.8.80]` / `[CB.70]` — Las tres llamadas de **categorizar un egreso de banco** (`/finance/contpaqi/...`).
 *
 * Nacieron en el puente ContPAQi y viven aquí desde que Bancos también categoriza (CB.70): un solo motor
 * (`ContpaqiCategoriaService` en el backend), un solo permiso (`FISCAL_CONTPAQI_BRIDGE_CATEGORIZAR`), una sola
 * pieza de pantalla (`<app-categorizar-egreso>`). ⛔ No se agrega otro clasificador: se usa éste.
 */
@Injectable({ providedIn: 'root' })
export class CategorizarEgresoApi {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/contpaqi`;

  /** Las categorías que puede llevar un egreso. `_VER`. */
  categoriasEgreso(): Observable<CategoriaEgreso[]> {
    return this.http.get<CategoriaEgreso[]>(`${this.base}/categorias-egreso`);
  }

  /** Qué egresos sin categoría tomaría «empieza con `texto`», sin guardar nada. `_VER`. */
  vistaPreviaBeneficiario(movimiento: string, texto: string): Observable<VistaPreviaBeneficiario> {
    return this.http.get<VistaPreviaBeneficiario>(
      `${this.base}/movimientos/${encodeURIComponent(movimiento)}/beneficiario?texto=${encodeURIComponent(texto)}`);
  }

  /** Categoriza un egreso sin categoría; con `beneficiario`, deja la regla. Exige `_CATEGORIZAR`. */
  categorizar(movimiento: string, body: { categoria: string; beneficiario?: string }): Observable<ResultadoCategorizar> {
    return this.http.post<ResultadoCategorizar>(`${this.base}/movimientos/${encodeURIComponent(movimiento)}/categoria`, body);
  }
}

/** Una categoría de egreso de banco. */
export interface CategoriaEgreso {
  code: string;
  nombre: string;
  grupo: string;
}

/** Lo que tomaría la regla por beneficiario. ⛔ `movimientos` puede ser mayor que `filas` (muestra de 50). */
export interface VistaPreviaBeneficiario {
  texto: string;
  movimientos: number;
  importe: number;
  filas: { id: string; fecha: string; banco: string; concepto: string; importe: number }[];
  regla_existente: { prioridad: number; categoria: string } | null;
}

export interface ResultadoCategorizar {
  movimiento_id: string;
  categoria: string;
  regla: { prioridad: number; texto: string; nueva: boolean } | null;
  aplicados: number;
  importe_aplicado: number;
}

/**
 * `[CP.8.80]` El nombre con que se propone la regla: el concepto sin las iniciales sueltas del final. Medido: el
 * mismo beneficiario llega como «Oscar Hernandez R» y «Oscar Hernandez Rodriguez»; proponer «OSCAR HERNANDEZ R»
 * tomaría uno solo. Nunca deja menos de dos palabras.
 */
export function sugerenciaBeneficiario(concepto: string | null | undefined): string {
  const p = String(concepto ?? '').replace(/\s+/g, ' ').trim().toUpperCase().split(' ').filter(Boolean);
  while (p.length > 2 && p[p.length - 1].replace(/[^A-Z0-9ÁÉÍÓÚÜÑ]/g, '').length <= 1) p.pop();
  return p.join(' ');
}

/** El aviso que se da al guardar: lo que hizo, con lo que tomó la regla. */
export function textoCategorizado(r: ResultadoCategorizar, nombreCategoria: string): string {
  if (!r.regla) return `Categorizado como ${nombreCategoria}.`;
  const imp = r.importe_aplicado.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  return `Categorizado como ${nombreCategoria}. Con «${r.regla.texto}» se categorizaron ${r.aplicados} más (${imp}), y se aplicará a los próximos estados de cuenta.`;
}
