import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';

/**
 * Cliente del resolvedor universal de referencias (`GET /entity-ref/:ref`).
 *
 * La pantalla no sabe de tablas: pasa un `ref` y recibe siempre la misma forma.
 * Los refs los arma el backend y viajan dentro de los payloads — el front nunca
 * los construye a mano salvo en los puntos de entrada (una fila de la tabla), y
 * para eso está `entityRef()`.
 */

export type EntityKind = 'ent' | 'lin' | 'adj' | 'pay' | 'prov' | 'sku';

export interface RefField {
  label: string;
  value: string | number | null;
  kind?: 'text' | 'money' | 'date' | 'mono' | 'pct' | 'qty';
  /** Columna/tabla de origen — se pinta como pie del campo. */
  source?: string;
}

export interface RefRelation {
  ref: string;
  label: string;
  sub?: string | null;
  amount?: number | null;
  date?: string | null;
  group: string;
  /** El vínculo es una estimación, no una liga estructural del ERP. */
  heuristic?: boolean;
}

export interface RefBadge { text: string; tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info'; title?: string; }

export interface RefResult {
  ref: string;
  kind: EntityKind;
  title: string;
  subtitle?: string | null;
  badges: RefBadge[];
  fields: RefField[];
  relations: RefRelation[];
  notes: string[];
}

/** Arma un ref del lado del front. Mismo formato que `makeRef()` del backend. */
export function entityRef(kind: EntityKind, ...parts: (string | number | null | undefined)[]): string {
  return `${kind}:${parts.map((p) => encodeURIComponent(String(p ?? ''))).join('|')}`;
}

@Injectable({ providedIn: 'root' })
export class EntityRefService {
  private readonly http = inject(HttpClient);

  resolve(ref: string): Observable<RefResult> {
    return this.http.get<RefResult>(`${environment.apiUrl}/entity-ref/${encodeURIComponent(ref)}`);
  }
}
