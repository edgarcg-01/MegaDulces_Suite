import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, filter, map, switchMap, take, timer } from 'rxjs';
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

  /** Emite una sola vez, cuando el trabajo termina (o al agotar los intentos). */
  watch(jobId: string, everyMs = 5_000, maxTries = 36): Observable<FinanceJobEvent> {
    return timer(everyMs, everyMs).pipe(
      take(maxTries),
      switchMap(() => this.http.get<FinanceJobRecord>(`${this.base}/${jobId}`)),
      filter((r) => r.status === 'done' || r.status === 'error'),
      take(1),
      map((r) => ({
        job_id: r.id,
        name: r.name,
        label: r.label,
        status: r.status,
        actor: null,
        result: r.result,
        error: r.error,
        took_ms: null,
        emitted_at: r.finished_at || new Date().toISOString(),
      })),
    );
  }
}
