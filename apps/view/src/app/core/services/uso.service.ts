import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, of } from 'rxjs';
import { environment } from '../../../environments/environment';

/**
 * `[SN.12]` — Registro de USO de la suite: qué abre cada persona.
 *
 * ── Para qué existe ─────────────────────────────────────────────────────────────────────────
 * Pedido de Edgar (2026-09-11): *"me gustaría tener un registro de qué clickea cada usuario, para
 * empezar a mostrar sus preferencias o una interfaz personalizada"*. Sin esto, "qué módulos valen"
 * y "qué le pongo primero a esta persona" se responden por opinión — y ya hubo tres rediseños
 * discutidos así.
 *
 * ── Lo que NO se construyó, porque ya existía ───────────────────────────────────────────────
 * La tabla y el pipeline son los del Portal B2B (`commercial.portal_telemetry_events` +
 * `CommercialTelemetryService`, junio 2026). Acá sólo se agrega el canal de la suite interna:
 * `POST /telemetry/suite`, **autenticado**, para que el `user_id` sea el real y no un decode
 * best-effort. Es el caso exacto que ADR-056 llama "primitivo que vive en un solo dominio y nunca
 * se generalizó": se generaliza en vez de inventar una tabla nueva.
 *
 * ── Qué se guarda, y qué no ─────────────────────────────────────────────────────────────────
 * El identificador de la puerta o de la bandeja que se abrió, y su espacio. **No** se guarda lo
 * que la persona escribe en el buscador, ni el contenido de ninguna pantalla. El propósito
 * declarado es ordenar la interfaz de quien la usa, no vigilar a nadie — y por eso el evento es
 * el clic en un enlace de navegación, no el recorrido dentro de cada módulo.
 *
 * ── Por qué no falla nunca ──────────────────────────────────────────────────────────────────
 * Es un efecto secundario de navegar: el envío es "dispara y olvida" con `catchError`, así que un
 * 500, un token vencido o la API caída no cambian en nada lo que la persona estaba haciendo.
 */
@Injectable({ providedIn: 'root' })
export class UsoService {
  private readonly http = inject(HttpClient);

  /** Un id por carga de página: agrupa los clics de una misma visita sin identificar a nadie. */
  private readonly sesion = Math.random().toString(36).slice(2, 12);

  /**
   * Deja constancia de que esta persona abrió algo desde la landing.
   *
   * @param que   `'puerta'` (un módulo) o `'bandeja'` (una cola de trabajo).
   * @param id    El identificador estable del destino en el mapa (`mkt-scoring`, `cuadre`).
   * @param extra Contexto mínimo del destino: el espacio, la ruta.
   */
  registrarApertura(que: 'puerta' | 'bandeja', id: string, extra: Record<string, string> = {}): void {
    this.enviar({ kind: 'event', name: `abrio_${que}`, props: { id, ...extra } });
  }

  private enviar(evento: Record<string, unknown>): void {
    const cuerpo = {
      events: [
        {
          ...evento,
          ts: Date.now(),
          url: location.pathname,
          session_id: this.sesion,
          env: environment.production ? 'prod' : 'dev',
        },
      ],
    };
    this.http
      .post(`${environment.apiUrl}/telemetry/suite`, cuerpo)
      .pipe(catchError(() => of(null)))
      .subscribe();
  }
}
