import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import type {
  ArqueoRevisionAccionDto, ArqueoRevisionDiaDto, ArqueoRevisionEvento, ArqueoRevisionFirmaDia,
  ArqueoRevisionJustificacion, ArqueoRevisionJustificarDto, ArqueoRevisionResp, ArqueoRevisionResumen,
} from '@megadulces/contracts/http/arqueo-cajas';
import { PermissionsService } from '../../core/services/permissions.service';
import { Permission } from '../../core/constants/permissions';
import { PageTab } from '../../shared/components/page-tabs/page-tabs.component';
import { ARQUEO_TABS } from './arqueo-tabs';

/**
 * [SM.55] Revisión de turnos — cliente HTTP de `store/arqueo-revision`.
 *
 * Escribir (justificar, acción, firmar el día) no tiene modo sin red: la pantalla lo dice y deja
 * reintentar. Los payloads son los que prueba `database/tests/test-newdb-arqueo-revision.js`.
 */
@Injectable({ providedIn: 'root' })
export class ArqueoRevisionService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/store/arqueo-revision`;

  pendientes(q: { desde?: string; hasta?: string } = {}): Observable<ArqueoRevisionResp> {
    let params = new HttpParams();
    if (q.desde) params = params.set('desde', q.desde);
    if (q.hasta) params = params.set('hasta', q.hasta);
    return this.http.get<ArqueoRevisionResp>(this.base, { params });
  }

  resumen(): Observable<ArqueoRevisionResumen> {
    return this.http.get<ArqueoRevisionResumen>(`${this.base}/resumen`);
  }

  justificar(dto: ArqueoRevisionJustificarDto): Observable<ArqueoRevisionJustificacion> {
    return this.http.post<ArqueoRevisionJustificacion>(this.base, dto);
  }

  accion(dto: ArqueoRevisionAccionDto): Observable<ArqueoRevisionEvento[]> {
    return this.http.post<ArqueoRevisionEvento[]>(`${this.base}/accion`, dto);
  }

  firmarDia(dto: ArqueoRevisionDiaDto): Observable<ArqueoRevisionFirmaDia> {
    return this.http.post<ArqueoRevisionFirmaDia>(`${this.base}/dia`, dto);
  }
}

/**
 * [SM.55] El aviso de las pestañas de Arqueo: «Retiros por revisar 3» le dice a la encargada que hay turnos
 * esperándola sin tener que entrar a buscarlos.
 *
 * Solo pregunta quien tiene `RECONCILIATION_VER` (a la cajera ni se le pide: daría 403). Se
 * guarda 5 minutos para que cambiar de pestaña no repita la consulta. Si falla, no se pinta
 * nada: un cero inventado diría «todo bien» sin haberlo medido.
 */
@Injectable({ providedIn: 'root' })
export class ArqueoAvisoService {
  private readonly svc = inject(ArqueoRevisionService);
  private readonly perms = inject(PermissionsService);
  private readonly resumen = signal<ArqueoRevisionResumen | null>(null);
  private pedidoAt = 0;

  /**
   * Turnos cuyos retiros no empatan con Kepler y nadie ha explicado. null = no medido.
   * (La firma del día salió de la versión simple, 2026-11-24: ya no suma al aviso.)
   */
  readonly pendientes = computed(() => {
    const r = this.resumen();
    return r ? r.por_justificar : null;
  });

  readonly tabs = computed<PageTab[]>(() => {
    const n = this.pendientes();
    return ARQUEO_TABS.map((t) => (t.route === '/tienda/arqueo/revision' ? { ...t, badge: n } : t));
  });

  /** Pide el resumen si toca (permiso + caché de 5 min). `forzar` tras justificar o firmar. */
  refrescar(forzar = false): void {
    if (!this.perms.has(Permission.RECONCILIATION_VER)) return;
    if (!forzar && Date.now() - this.pedidoAt < 5 * 60_000) return;
    this.pedidoAt = Date.now();
    this.svc.resumen().subscribe({ next: (r) => this.resumen.set(r), error: () => this.resumen.set(null) });
  }

  /** Cuando la pantalla de Revisión ya tiene la lista completa, no hace falta otra consulta. */
  fijar(r: ArqueoRevisionResumen): void {
    this.pedidoAt = Date.now();
    this.resumen.set(r);
  }
}
