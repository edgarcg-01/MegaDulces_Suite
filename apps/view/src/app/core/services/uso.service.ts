import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, of, shareReplay } from 'rxjs';
import {
  VENTANA_ACCESOS_DIAS,
  type MisAccesos,
} from '@megadulces/contracts';
import { environment } from '../../../environments/environment';
import { valorWebVital } from './web-vital-valor';

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

  /**
   * `[DS.7]` — Core Web Vitals de campo, por el mismo canal que el uso.
   *
   * ── Por qué ────────────────────────────────────────────────────────────────────────────────
   * `DESIGN.md` §17 declara BINDING que **INP < 200ms es criterio de aceptación** en vistas
   * densas, y dice literal *"se mide, no se estima"*. Medido el 2026-10-02: `web-vitals` estaba
   * instalado y cableado **sólo en `apps/portal`**. O sea que la app con las tablas densas —la
   * que la regla nombra— era la única que no medía nada, y el presupuesto de interacción se
   * discutía de memoria. El endpoint (`POST /telemetry/suite`, autenticado) y este servicio ya
   * existían: lo único que faltaba era llamar a la librería.
   *
   * ── Qué se manda ───────────────────────────────────────────────────────────────────────────
   * El nombre de la métrica, su valor, su calificación (`good`/`needs-improvement`/`poor`) y la
   * ruta. **Nada del contenido de la pantalla**, igual que el registro de uso.
   *
   * ⚠️ **La ruta importa más que el promedio.** Un INP global no dice nada en una suite con
   * pantallas tan distintas como `/projects` y `/compras/pedido`; lo que se busca es *qué
   * pantalla* pasa los 200ms. Por eso va `url` en cada muestra y el análisis agrupa por ahí.
   *
   * ⚠️ Es `import()` perezoso: la librería no entra al bundle inicial. Y hereda el "dispara y
   * olvida" de `enviar()` — si la API está caída, no cambia nada de lo que la persona hacía.
   */
  medirWebVitals(): void {
    void import('web-vitals').then(({ onINP, onLCP, onCLS }) => {
      const reportar = (m: { name: string; value: number; rating: string }) =>
        this.enviar({
          kind: 'event',
          name: 'web_vital',
          // `[RA-PERF.5]` El redondeo lo decide la UNIDAD de la métrica, no la comodidad del
          // entero: acá decía `Math.round(m.value)` para las tres, y CLS es un score 0..1 →
          // `Math.round(0.31)` = 0. Medido en prod: 236 muestras malas guardadas como perfectas.
          // Ver `web-vital-valor.ts` para la medición completa.
          props: { metric: m.name, value: valorWebVital(m.name, m.value), rating: m.rating },
        });
      onINP(reportar);
      onLCP(reportar);
      onCLS(reportar);
    });
  }

  /**
   * `[SN.40]` **La vuelta del dato: qué abre esta persona de verdad.**
   *
   * Hasta hoy este servicio sólo ESCRIBÍA. Medido el 2026-10-05 en prod: 3,677 aperturas de 84
   * personas guardadas desde el 11 de septiembre, y **cero lectores** — ningún endpoint, ningún
   * consumidor. La fila «Tus accesos» de la landing, que es lo único de la pantalla que se
   * parecía al uso, salía de `localStorage`: un solo navegador, perdida al limpiar datos, y
   * ordenada por *lo último*, no por *lo más*.
   *
   * Lo que vuelve NO es sólo tuyo: cuando tu historia no alcanza —y para ~8 de cada 10 personas
   * no alcanza— el servidor completa con tu puesto y tu área, y cada elemento trae `origen`
   * diciendo de dónde salió. Ver `suite-usage.contract.ts` para la medición que lo justifica.
   *
   * ⚠️ Se cachea por sesión de pantalla con `shareReplay`: la landing la pide una vez y no vuelve
   * a preguntar aunque se re-renderice. Un clic nuevo se refleja en la siguiente carga, no en el
   * acto — que es el comportamiento correcto para una fila que NO debe reacomodarse debajo del
   * cursor.
   *
   * ⛔ Nunca falla hacia afuera: ante cualquier error devuelve la forma vacía con `propias: 0`,
   * y la landing ya sabe leer eso como "no hay nada que mostrar" y no dibujar la fila.
   */
  misAccesos(): Observable<MisAccesos> {
    this.accesos$ ??= this.http
      .get<MisAccesos>(`${environment.apiUrl}/telemetry/suite/mios`)
      .pipe(
        catchError(() =>
          of<MisAccesos>({
            medido_at: new Date().toISOString(),
            ventana_dias: VENTANA_ACCESOS_DIAS,
            propias: 0,
            accesos: [],
          }),
        ),
        shareReplay({ bufferSize: 1, refCount: false }),
      );
    return this.accesos$;
  }

  private accesos$?: Observable<MisAccesos>;

  /**
   * `[SN.40]` Olvida lo medido. Lo llama `AuthService.logout()`.
   *
   * ⛔ **Sin esto, cambiar de usuario SIN recargar la página le mostraría a la persona nueva los
   * atajos de la anterior.** Este servicio es `providedIn: 'root'` y el `shareReplay` de arriba
   * vive lo que vive el SPA; `logout()` vacía los signals pero no destruye el inyector salvo que
   * le pidan `derribar`, y el interceptor que cierra sesión ante un 401 justamente NO lo pide
   * (recargar ahí puede dejar un bucle).
   *
   * No es hipotético: es el defecto exacto que `DataScopeService` ya pagó —su `reset()` estaba
   * escrito y sin llamador, y los selectores de sucursal seguían ofreciendo las del usuario
   * anterior—. Acá además filtraría algo peor que una lista de sucursales: **qué abre otra
   * persona**, que es lo que esta fase prometió no convertir en vigilancia.
   */
  reset(): void {
    this.accesos$ = undefined;
  }

  /**
   * `[RA-PERF.6]` **Un incidente del cliente, por el canal que sí llega.**
   *
   * Existe porque un `throw` dentro de una expresión de template **lo come el `ErrorHandler` de
   * Angular y nunca sale del navegador**. Medido en prod el 2026-10-07: en 30 días hay **un solo**
   * evento `kind='error'` en `commercial.portal_telemetry_events`, y es de `/portal/login`. O sea
   * que el crash de render de `/compras/pedido` —abierto desde julio— es invisible para el único
   * canal que podría probar que sigue pasando.
   *
   * Hereda el "dispara y olvida" de `enviar()`: si la API está caída no cambia nada de lo que la
   * persona estaba haciendo. `kind: 'error'` para que se separe del uso normal al consultarlo.
   */
  reportarIncidente(nombre: string, props: Record<string, unknown>): void {
    this.enviar({ kind: 'error', name: nombre, props });
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
