import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, concat, defaultIfEmpty, filter, map, switchMap, take, timer } from 'rxjs';
import { environment } from '../../../environments/environment';
import { FinanceJobEvent } from './bancos-socket.service';

/** Lo que devuelve `GET /finance/jobs/:id` (registro en memoria del proceso). */
interface FinanceJobRecord {
  id: string;
  name: string;
  label: string;
  status: 'running' | 'done' | 'error';
  result: unknown;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * COMM-P0 — Red de seguridad del 202: sondea `GET /finance/jobs/:id` hasta que el
 * trabajo termina y emite UN evento con la misma forma que el de WS.
 *
 * ¿Por qué existe si ya hay WebSocket? Porque si el WS no llegó a conectar (proxy
 * que no hace upgrade, red corporativa, token vencido), el usuario quedaría con un
 * spinner eterno y sin saber si el import quedó aplicado — exactamente el problema
 * que P0 vino a matar. El primer aviso que llegue gana: el handler de la pantalla
 * descarta el duplicado por `job_id`.
 */
@Injectable({ providedIn: 'root' })
export class FinanceJobsClient {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/finance/jobs`;

  /**
   * Emite UNA sola vez: el cierre del trabajo. Si se agotan los intentos sin que
   * el job termine, emite un evento sintético `error` — **nunca completa en
   * silencio**, porque eso dejaba el spinner girando para siempre.
   *
   * El primer sondeo va a 1.5 s (no a 5 s) por una carrera real: un job corto
   * puede terminar ANTES de que el 202 llegue al cliente, y en ese caso el evento
   * WS `done` se emitió cuando la pantalla todavía no tenía el `job_id` — la sonda
   * es quien lo rescata, así que conviene que pregunte pronto.
   */
  watch(jobId: string, everyMs = 5_000, maxTries = 36): Observable<FinanceJobEvent> {
    const ticks = concat(timer(1_500), timer(everyMs, everyMs));
    return ticks.pipe(
      take(maxTries),
      switchMap(() => this.http.get<FinanceJobRecord>(`${this.base}/${jobId}`)),
      filter((r) => r.status === 'done' || r.status === 'error'),
      take(1),
      map((r) => this.toEvent(r)),
      // Se agotaron los sondeos y seguía `running`: avisar, no callar.
      defaultIfEmpty(this.timedOut(jobId, everyMs * maxTries)),
    );
  }

  private toEvent(r: FinanceJobRecord): FinanceJobEvent {
    return {
      job_id: r.id,
      name: r.name,
      label: r.label,
      status: r.status,
      actor: null,
      result: r.result,
      error: r.error,
      took_ms: null,
      emitted_at: r.finished_at || new Date().toISOString(),
    };
  }

  /** Evento sintético: el trabajo no resolvió dentro de la ventana de sondeo. */
  private timedOut(jobId: string, windowMs: number): FinanceJobEvent {
    const mins = Math.round(windowMs / 60_000);
    return {
      job_id: jobId,
      name: 'unknown',
      label: 'trabajo en curso',
      status: 'error',
      actor: null,
      result: null,
      error: `Sigue corriendo después de ${mins} min. Recargá la pantalla para ver el resultado.`,
      took_ms: null,
      emitted_at: new Date().toISOString(),
    };
  }
}
