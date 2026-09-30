import {
  CallHandler, ExecutionContext, Inject, Injectable, Logger,
  NestInterceptor, OnModuleDestroy, Optional,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { latirCron } from '../provenance/cron-heartbeat';

/**
 * `[UX.0]` **Qué pantallas se usan.** El único medidor de uso del API.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────
 *
 * Medido el 2026-09-30: 285 pantallas desplegadas y **cero** telemetría. Caddy no loguea
 * accesos, el API no loguea rutas, y la única tabla de eventos cubre sólo el portal B2B. Sin
 * esto, decidir qué auditar primero entre 285 pantallas es opinión — y el precedente es la
 * Fase IC, donde el módulo de inventario llevaba meses en prod con 6 folios, todos cancelados.
 *
 * ── Las cuatro decisiones que lo hacen barato y honesto ──────────────────────────────────
 *
 * 1. **Agrega en memoria y descarga cada 60 s.** Una fila por request a Postgres sería un
 *    escritor nuevo en la ruta caliente de cada pantalla. Acá el costo por request es sumar
 *    en un `Map`.
 *
 * 2. **Guarda el PATRÓN de la ruta, no la URL.** `/commercial/orders/:id`, jamás
 *    `/commercial/orders/9f3c…`. Por cardinalidad (con IDs serían millones de filas que no
 *    responden nada) y porque una URL cruda arrastra identificadores de clientes y documentos
 *    a una tabla de métricas. Cuando Express no resolvió la ruta (un 404), se normaliza a mano
 *    y se marca — pero **nunca** se guarda el segmento crudo.
 *
 * 3. **Nunca rompe el request.** Todo lo que hace va dentro de un `try` mudo hacia afuera: un
 *    medidor que tira la pantalla que mide es peor que no medir. Es el mismo contrato que
 *    `POST /api/errores` de CV.3.
 *
 * 4. ⛔ **La descarga LATE** (`ui_usage_flush` en `CRON_JOBS`). Y acá no es ceremonia: si el
 *    medidor se muere, la tabla deja de crecer y **«0 hits» se lee exactamente igual que
 *    «nadie la usa»** — o sea que su falla produce la conclusión opuesta a la verdad. Es el
 *    peor modo de falla posible para una herramienta de priorización.
 *
 * ⚠️ Lo que mide es tiempo de **servidor**, no lo que espera la persona: no incluye red, ni
 * render de Angular, ni las otras consultas que la misma pantalla dispara en paralelo.
 */

/** Lo acumulado para un (día, método, ruta, rol). */
interface Celda {
  hits: number;
  msTotal: number;
  msMax: number;
  errores: number;
}

export const USAGE_METRICS_DB = 'USAGE_METRICS_DB';

/**
 * El tenant del latido y del tráfico anónimo (el verificador de precios es público y no trae
 * sesión de la que sacarlo).
 *
 * ⚠️ **Es la TERCERA copia de este UUID en el repo**: `analytics-refresh.service.ts` lo tiene
 * literal dos veces. ADR-056 dice que un valor duplicado a mano es deuda con nombre, así que
 * queda anotada acá y en el tracker; la limpieza es subirlo a una constante de `platform-core`
 * y retirar las tres, que toca archivos de otra fase y no entra en este item.
 */
const TENANT_POR_DEFECTO = '00000000-0000-0000-0000-00000000d01c';

@Injectable()
export class UsageMetricsInterceptor implements NestInterceptor, OnModuleDestroy {
  private readonly log = new Logger('UsageMetrics');
  private readonly buffer = new Map<string, Celda>();
  /** (fecha|ruta|user_id) → role_name. La unicidad la pone la PK de la tabla, no un contador. */
  private readonly usuarios = new Map<string, string | null>();
  private timer: NodeJS.Timeout | null = null;
  private descargando = false;
  /** Se declara para que una descarga que nunca corrió no se lea como "no hubo tráfico". */
  private ultimaDescarga: Date | null = null;

  constructor(@Optional() @Inject(USAGE_METRICS_DB) private readonly knex?: unknown) {
    if (process.env['USAGE_METRICS'] === 'off') {
      this.log.log('apagado por USAGE_METRICS=off');
      return;
    }
    // `unref()` para no sostener el proceso vivo por el medidor.
    this.timer = setInterval(() => void this.descargar(), 60_000);
    this.timer.unref?.();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    // Una última descarga: sin esto, cada redeploy tira hasta 60 s de tráfico medido.
    await this.descargar();
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http' || !this.timer) return next.handle();
    const t0 = Date.now();
    const req = context.switchToHttp().getRequest();
    const anotar = (falla: boolean) => {
      try { this.anotar(req, Date.now() - t0, falla); } catch { /* jamás rompe el request */ }
    };
    return next.handle().pipe(tap({
      next: () => anotar(false),
      error: () => anotar(true),
    }));
  }

  /**
   * El patrón de la ruta. Express lo deja en `req.route.path` **ya resuelto**, que es el único
   * lugar donde `:id` viene como `:id` y no como el UUID del cliente.
   *
   * ⛔ El fallback NO es la URL cruda: es la URL con cada segmento que parezca identificador
   * reemplazado por `:id`. Un 404 con un UUID adentro no puede terminar en la tabla.
   */
  private patron(req: Record<string, any>): string {
    const base = typeof req['baseUrl'] === 'string' ? req['baseUrl'] : '';
    const ruta = req['route']?.path;
    if (typeof ruta === 'string' && ruta) return (base + ruta).slice(0, 200) || '/';
    const crudo = String(req['originalUrl'] || req['url'] || '/').split('?')[0];
    return crudo
      .split('/')
      .map((s) => (/^[0-9]+$/.test(s)
        || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
        || /^[0-9a-f]{24,}$/i.test(s) ? ':id' : s))
      .join('/')
      .slice(0, 200) || '/';
  }

  private anotar(req: Record<string, any>, ms: number, falla: boolean) {
    const u = req['user'] as { id?: string; tenant_id?: string; role_name?: string } | undefined;
    const tenant = u?.tenant_id || process.env['DEFAULT_TENANT_ID'] || TENANT_POR_DEFECTO;
    if (!tenant) return;                       // sin tenant no hay dónde guardarlo
    const fecha = new Date().toISOString().slice(0, 10);
    const metodo = String(req['method'] || 'GET');
    const ruta = this.patron(req);
    const rol = u?.role_name || '(anonimo)';

    const k = `${tenant}|${fecha}|${metodo}|${ruta}|${rol}`;
    const c = this.buffer.get(k) || { hits: 0, msTotal: 0, msMax: 0, errores: 0 };
    c.hits++; c.msTotal += ms; c.msMax = Math.max(c.msMax, ms); if (falla) c.errores++;
    this.buffer.set(k, c);

    if (u?.id) this.usuarios.set(`${tenant}|${fecha}|${ruta}|${u.id}`, u.role_name ?? null);
  }

  /** Vuelca el buffer y late. Nunca lanza. */
  private async descargar() {
    if (this.descargando || !this.knex) return;
    if (!this.buffer.size && !this.usuarios.size) {
      // Sin tráfico no se escribe nada, pero SÍ se late con el motivo: un latido ausente y un
      // latido "cero legítimo" son cosas distintas y el tablero tiene que poder distinguirlas.
      await this.latir(0, 0, ['sin trafico en la ventana']);
      return;
    }
    this.descargando = true;
    const t0 = Date.now();
    const celdas = [...this.buffer.entries()];
    const users = [...this.usuarios.entries()];
    this.buffer.clear();
    this.usuarios.clear();
    let escritas = 0;
    const fallas: string[] = [];
    const knex = this.knex as any;
    try {
      const filas = celdas.map(([k, c]) => {
        const [tenant_id, fecha, metodo, ruta, role_name] = k.split('|');
        return {
          tenant_id, fecha, metodo, ruta, role_name,
          hits: c.hits, ms_total: c.msTotal, ms_max: c.msMax, errores: c.errores,
          updated_at: knex.fn.now(),
        };
      });
      for (let i = 0; i < filas.length; i += 500) {
        const lote = filas.slice(i, i + 500);
        // SUMA sobre lo que ya había: el grano es el día y las descargas son cada minuto.
        const r = await knex('analytics.ui_usage').insert(lote)
          .onConflict(['tenant_id', 'fecha', 'metodo', 'ruta', 'role_name'])
          .merge({
            hits: knex.raw('analytics.ui_usage.hits + excluded.hits'),
            ms_total: knex.raw('analytics.ui_usage.ms_total + excluded.ms_total'),
            ms_max: knex.raw('greatest(analytics.ui_usage.ms_max, excluded.ms_max)'),
            errores: knex.raw('analytics.ui_usage.errores + excluded.errores'),
            updated_at: knex.fn.now(),
          });
        escritas += Array.isArray(r) ? r.length : lote.length;
      }
      if (users.length) {
        const fu = users.map(([k, rol]) => {
          const [tenant_id, fecha, ruta, user_id] = k.split('|');
          return { tenant_id, fecha, ruta, user_id, role_name: rol, updated_at: knex.fn.now() };
        });
        for (let i = 0; i < fu.length; i += 500) {
          await knex('analytics.ui_usage_users').insert(fu.slice(i, i + 500))
            .onConflict(['tenant_id', 'fecha', 'ruta', 'user_id'])
            .merge({ role_name: knex.raw('excluded.role_name'), updated_at: knex.fn.now() });
        }
      }
      this.ultimaDescarga = new Date();
    } catch (e) {
      fallas.push(e instanceof Error ? e.message : String(e));
      this.log.error(`descarga fallida (se pierden ${celdas.length} celdas): ${fallas[0]}`);
    } finally {
      this.descargando = false;
    }
    await this.latir(escritas, Date.now() - t0, fallas);
  }

  private async latir(rows: number, ms: number, fallas: string[]) {
    const knex = this.knex as any;
    const tenant = process.env['DEFAULT_TENANT_ID'] || TENANT_POR_DEFECTO;
    if (!knex) return;
    await latirCron(knex, {
      jobKey: 'ui_usage_flush',
      label: 'Telemetría de uso del API (descarga cada 60 s)',
      tenantId: tenant,
      rowsAffected: rows,
      durationMs: ms,
      fallas,
      // Sin tráfico no hay filas, y eso es legítimo de madrugada. Pero se declara con motivo,
      // que es justo lo que `latirCron` exige para no pintar rojo un cero sano.
      ceroEsOk: rows === 0 && !fallas.length
        ? 'sin trafico en la ventana de 60 s' : undefined,
      note: rows > 0 ? `${rows} celdas` : undefined,
    });
  }

  /** Para el smoke: cuánto hay sin descargar y cuándo fue la última. */
  estado() {
    return {
      pendientes: this.buffer.size,
      usuarios_pendientes: this.usuarios.size,
      ultima_descarga: this.ultimaDescarga,
      encendido: this.timer !== null,
    };
  }
}
