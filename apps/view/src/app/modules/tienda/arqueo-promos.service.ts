import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** `[MKT.18]` Quién vendió cada ticket con promoción del turno (lo escribe la cajera). */
export interface PersonaVendedora { code: string; nombre: string; promotora: boolean }
export interface PromoDeTicket { code: string; mecanica: string; cantidad: number }
export interface TicketConPromo {
  doc_tipo: number;
  caja: string;
  folio: string;
  business_date: string;
  turno_apertura: string | null;
  cajero: string | null;
  total: number;
  promos: PromoDeTicket[];
  vendedora: { code: string; nombre: string } | null;
}
export interface TicketsDeTurnos {
  sucursal: string;
  dias: number;
  ve_toda_la_sucursal: boolean;
  tickets: TicketConPromo[];
  personas: PersonaVendedora[];
  asignados: number;
  consultado_at: string;
}
export interface Asignacion { doc_tipo: number; caja: string; folio: string; person_code: string | null }

/** La llave de un ticket como Kepler lo identifica. */
export const llaveTicket = (t: { doc_tipo: number; caja: string; folio: string }) => `${t.doc_tipo}|${t.caja}|${t.folio}`;

/** Lo que cambió contra lo guardado: sólo eso se manda (vacío = quitar). */
export function asignacionesPendientes(tickets: TicketConPromo[], elegidos: Record<string, string | null>): Asignacion[] {
  const out: Asignacion[] = [];
  for (const t of tickets) {
    const k = llaveTicket(t);
    if (!(k in elegidos)) continue;
    const nuevo = elegidos[k] || null;
    if (nuevo === (t.vendedora?.code ?? null)) continue;
    out.push({ doc_tipo: t.doc_tipo, caja: t.caja, folio: t.folio, person_code: nuevo });
  }
  return out;
}

@Injectable({ providedIn: 'root' })
export class ArqueoPromosService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/commercial/mkt-ranking/vendedoras`;

  tickets(sucursal: string | null, dias: number): Observable<TicketsDeTurnos> {
    let p = new HttpParams().set('dias', String(dias));
    if (sucursal) p = p.set('sucursal', sucursal);
    return this.http.get<TicketsDeTurnos>(this.base, { params: p });
  }

  guardar(sucursal: string | null, items: Asignacion[]): Observable<{ guardados: number; quitados: number }> {
    return this.http.put<{ guardados: number; quitados: number }>(this.base, { sucursal, items });
  }
}
