import { DestroyRef, Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

interface Latido {
  latido: string | null;
  servidor_at: string;
}

/**
 * `[CAT.7]` — **Mantiene las pestañas del Catálogo al día sin que nadie apriete nada.**
 *
 * Nace de un reporte real: *"cuando en Kepler arreglan los errores de códigos y de precios, no se
 * actualiza aquí"*. Se midió la ingesta antes de escribir una línea y **estaba sana**: cero códigos
 * fantasma, 4 de 8,761 precios divergentes (0.0 %), fuente viva a 18 minutos. Lo que no se
 * actualizaba era la pantalla — cargaba al abrirse y se quedaba ahí.
 *
 * ── CÓMO FUNCIONA, Y POR QUÉ ASÍ ────────────────────────────────────────────────────────────
 * Cada pocos segundos pide UN escalar (`/products/heartbeat`): el instante del último cambio real
 * de catálogo. Si no se movió, ahí termina — no se recarga nada. Si se movió, avisa a la pantalla
 * suscrita, que vuelve a pedir SUS datos.
 *
 * Se eligió esto sobre un WebSocket a propósito: el WS necesita gateway, permiso en el handshake y
 * un canal más que vigilar, y acá el dato de origen cambia pocas veces por hora. Una consulta
 * escalar cada 10 s cuesta menos que todo eso y falla de forma más simple.
 *
 * ⚠️ El piso de frescura NO es este intervalo: es el carril del ODS, que trae `kdii` cada ~10 s y
 * escribe por el hop-2. Bajar `INTERVALO_MS` no hace nada más fresco — sólo más consultas.
 *
 * ── LO QUE NO HACE, A PROPÓSITO ─────────────────────────────────────────────────────────────
 * No recarga la tabla por su cuenta cuando hay una fila abierta o el usuario está escribiendo: la
 * pantalla decide. Si la lista salta mientras alguien lee un renglón para ir a corregirlo a Kepler,
 * termina corrigiendo el producto equivocado.
 *
 * ── CUANDO SE CAE ───────────────────────────────────────────────────────────────────────────
 * Si el latido falla, `enVivo` pasa a `false` y la pantalla lo DICE. "No hay nada nuevo" y "dejé de
 * preguntar" se ven igual y significan lo contrario. Reintenta con espera creciente hasta 2 min,
 * para no dejar un renglón de error por segundo cuando la API está abajo.
 */
@Injectable({ providedIn: 'root' })
export class CatalogoLatidoService implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  private static readonly INTERVALO_MS = 10_000;
  private static readonly ESPERA_MAX_MS = 120_000;

  /** El latido que vio la última lectura exitosa. `undefined` = todavía no se tomó ninguna. */
  private ultimo: string | null | undefined = undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private fallas = 0;
  private suscriptores = 0;

  /** `false` = el latido no responde. La pantalla debe decirlo, no callarlo. */
  readonly enVivo = signal(false);
  /** Sube cada vez que el catálogo cambió de verdad. Las pantallas lo miran con un `effect`. */
  readonly version = signal(0);
  /** Hora del último cambio detectado, para mostrarla. */
  readonly ultimoCambio = signal<Date | null>(null);

  readonly hayCambio = computed(() => this.version() > 0);

  /**
   * Cada pantalla llama `escuchar()` en su init. El contador evita que la primera que se destruya
   * le corte el latido a otra que siga abierta — el error que ya se cometió con los sockets de
   * `/goods-receipts`, donde `disconnect()` destruía el canal para todos.
   */
  escuchar(): void {
    this.suscriptores += 1;
    if (this.timer === null) this.programar(0);
  }

  dejarDeEscuchar(): void {
    this.suscriptores = Math.max(0, this.suscriptores - 1);
    if (this.suscriptores === 0) this.detener();
  }

  ngOnDestroy(): void { this.detener(); }

  private detener(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.enVivo.set(false);
  }

  private programar(ms: number): void {
    if (this.suscriptores === 0) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    try {
      const r = await new Promise<Latido>((ok, err) =>
        this.http.get<Latido>(`${environment.apiUrl}/commercial/products/heartbeat`)
          .subscribe({ next: ok, error: err }));

      this.fallas = 0;
      this.enVivo.set(true);

      // La PRIMERA lectura sólo siembra la referencia: si no, al abrir la pantalla el primer tick
      // anunciaría como "cambio" todo lo que pasó antes de que el usuario llegara.
      if (this.ultimo === undefined) this.ultimo = r.latido;
      else if (r.latido !== this.ultimo) {
        this.ultimo = r.latido;
        this.ultimoCambio.set(r.latido ? new Date(r.latido) : new Date());
        this.version.update((v) => v + 1);
      }
    } catch {
      this.fallas += 1;
      this.enVivo.set(false);
    } finally {
      // Espera creciente mientras falla; no se pierde nada por reintentar más lento, porque el
      // latido es un TIMESTAMP, no una cola: el primer tick que vuelva a responder ve el cambio.
      const espera = this.fallas
        ? Math.min(CatalogoLatidoService.INTERVALO_MS * 2 ** Math.min(this.fallas, 4),
                   CatalogoLatidoService.ESPERA_MAX_MS)
        : CatalogoLatidoService.INTERVALO_MS;
      this.programar(espera);
    }
  }
}
