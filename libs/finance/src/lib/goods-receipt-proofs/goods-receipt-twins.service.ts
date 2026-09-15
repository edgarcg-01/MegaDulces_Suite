import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService } from '@megadulces/platform-core';

export interface PairResult {
  tenant_id: string;
  /** pares que NO existían antes de esta corrida. Es el único número que vale para loguear. */
  nuevas: number;
  /** todas las marcas escritas de la ventana (casi siempre las mismas: no dice nada solo). */
  marcadas: number;
  /** pares que quedaron esperando dictamen humano. */
  propuestas: number;
  /** marcas del motor que ya no tienen candidato (cambió el importe, se canceló el documento). */
  obsoletas: number;
  ms: number;
}

/** Tenant bajo el que se registra el latido del barrido multi-tenant (mismo criterio que `period_close_check`). */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

/**
 * `[RE.14.6]` — **El motor que enlaza las gemelas solo.**
 *
 * Cada recepción se captura dos veces: en el Kepler de la sucursal y en el de oficinas
 * (servidor 9.95, sucursal `'00'`). Hasta acá el apareo era un CLI que alguien tenía que
 * acordarse de correr, y eso no es un proceso: **cada recepción nueva nacía contada dos veces**
 * y se quedaba así hasta la próxima corrida a mano. Con esto se aparea sola cada 5 minutos.
 *
 * La cascada de reglas NO vive acá: vive en `analytics.fn_pair_goods_receipts` (migración
 * `20260827170000`). Son tres consumidores del mismo apareo —este cron, el CLI de backfill y el
 * smoke— y el CLI es Node plano que no puede importar de `libs/`, así que la única forma de que
 * no existan dos definiciones de *qué dinero deja de contarse* es que la definición esté en la DB.
 *
 * **Ventana corta a propósito.** Medido sobre data real: la ventana de 45 días cuesta ~3 s y el
 * histórico completo **~45 s**. Un cron no tiene por qué pagar el barrido histórico cada 5
 * minutos; eso se hace una vez con el CLI. La función además arranca 15 días antes del corte,
 * así que una ventana corta no puede desaparear un par cuya copia de sucursal cayó justo afuera.
 *
 * Corre con `KNEX_NEW_DB` (usuario de la app): `analytics.*` no tiene RLS y el filtro de tenant
 * es explícito, igual que `GoodsReceiptsWatcherService`. Killable con `DISABLE_RECEIPT_TWINS=true`.
 */
@Injectable()
export class GoodsReceiptTwinsService {
  private readonly logger = new Logger(GoodsReceiptTwinsService.name);
  /**
   * Corrida en vuelo. El que llega tarde **espera** en vez de saltarse el turno: si el watcher
   * mira `running` y se va, anuncia órdenes nuevas antes de que el apareo termine — que es
   * exactamente el bug que este orden evita.
   */
  private inFlight: Promise<PairResult[]> | null = null;
  private lastOkAt = 0;

  /** Días hacia atrás que barre el cron. Configurable porque oficinas a veces captura tarde. */
  private get ventanaDias(): number {
    const v = Number(process.env.RECEIPT_TWIN_WINDOW_DAYS);
    return Number.isFinite(v) && v > 0 ? Math.min(400, v) : 45;
  }

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Segundo 30 y no 0: el watcher corre en el segundo 0 del mismo minuto y ya dispara el apareo
   * antes de anunciar. Este tick es el respaldo (si el watcher está apagado) y con la ventana de
   * frescura de 90 s no repite el trabajo que el watcher acaba de hacer.
   */
  @Cron('30 */5 * * * *')
  async scan(): Promise<void> {
    if (process.env.DISABLE_RECEIPT_TWINS === 'true') return;
    await this.ensureFresh();
  }

  /**
   * Para el watcher: **aparear ANTES de anunciar órdenes nuevas.** Sin este orden, la copia de
   * oficinas que acaba de llegar se anuncia por WS como orden nueva y aparece en la worklist
   * pidiendo evidencia de algo que la sucursal ya cubrió. No-op si ya corrió hace menos de 90 s,
   * así que no duplica el trabajo del cron.
   */
  async ensureFresh(origen = 'watcher'): Promise<void> {
    if (this.inFlight) { await this.inFlight; return; }
    if (Date.now() - this.lastOkAt < 90_000) return;
    this.inFlight = this.correr(origen).finally(() => { this.inFlight = null; });
    await this.inFlight;
  }

  /**
   * Disparo manual desde la bandeja de gemelas ("buscar pares ahora"). Sólo el tenant de quien
   * lo pide: el barrido de toda la plataforma es trabajo del cron, no de un botón.
   */
  async pairNow(): Promise<PairResult | null> {
    const tenantId = this.tenantCtx.requireTenantId();
    // No se cuelga del `inFlight` de los ticks: ése puede estar barriendo otro tenant, y el botón
    // tiene que contestar por el de quien lo apretó. Dos corridas en paralelo son seguras (cada
    // sesión tiene su propia tabla temporal y las marcas son por tenant).
    const [r] = await this.correr('manual', tenantId);
    return r ?? null;
  }

  private async correr(origen: string, soloTenant?: string): Promise<PairResult[]> {
    const out: PairResult[] = [];
    const t0Total = Date.now();
    // Lo que falló, para que el latido lo DECLARE. Antes estos errores sólo iban a `logger.warn`:
    // si tronaban todos los tenants, `correr()` devolvía `[]` y el tablero no se enteraba.
    const fallos: string[] = [];
    try {
      const tenants: { id: string }[] = soloTenant
        ? [{ id: soloTenant }]
        : await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        const t0 = Date.now();
        try {
          // `current_date` del server: la ventana es de 45 días, así que un corrimiento de husos
          // en el límite del día no cambia nada de lo que se aparea.
          const { rows } = await this.knex.raw(
            'SELECT * FROM analytics.fn_pair_goods_receipts(?::uuid, (current_date - ?::int)::date)',
            [t.id, this.ventanaDias],
          );
          const r = rows?.[0] || {};
          const res: PairResult = {
            tenant_id: t.id,
            nuevas: Number(r.nuevas || 0), marcadas: Number(r.marcadas || 0),
            propuestas: Number(r.propuestas || 0), obsoletas: Number(r.obsoletas || 0),
            ms: Date.now() - t0,
          };
          out.push(res);
          // Se loguea sólo cuando pasó algo: un cron cada 5 minutos que reporte "405 marcas" (las
          // mismas de siempre) tapa el log y esconde justo la corrida que sí encontró algo.
          if (res.nuevas || res.obsoletas || origen === 'manual') {
            this.logger.log(
              `[${origen}] tenant ${t.id}: ${res.nuevas} par(es) nuevo(s) · ${res.propuestas} por dictaminar` +
              `${res.obsoletas ? ` · ${res.obsoletas} obsoleta(s) limpiada(s)` : ''} (${res.ms}ms)`,
            );
          }
        } catch (e: any) {
          // Un tenant que truena no puede frenar a los demás ni tirar el cron — pero SÍ tiene que
          // salir del edificio: se acumula para que el latido lo declare.
          fallos.push(`${t.id}: ${e.message}`);
          this.logger.warn(`[${origen}] tenant ${t.id}: ${e.message}`);
        }
      }
      if (!soloTenant) this.lastOkAt = Date.now();
    } catch (e: any) {
      fallos.push(e.message);
      this.logger.warn(`[${origen}] ${e.message}`);
    }
    // El barrido de toda la plataforma late; `pairNow()` (un solo tenant, apretado por una persona
    // que ya ve el resultado en pantalla) no — si latiera, un botón haría parecer sano un cron muerto.
    if (!soloTenant) await this.latir(out, fallos, Date.now() - t0Total);
    return out;
  }

  /**
   * Latido a `analytics.cron_runs`. **El motivo por el que existe:** hasta 2026-09-15 este cron era
   * mudo, y el único `job_key` de recepciones que el tablero veía era `feed_receipts` — el CLI de
   * barrido histórico. Con el cron sin latido no había forma de saber desde la DB si el apareo
   * incremental estaba vivo, así que **tampoco había forma de bajarle la cadencia al CLI sin
   * arriesgarse a dejar el dinero contado dos veces** (el CLI estaba agendado *cada minuto* y se
   * llevaba el 42.8% del tiempo de ejecución de la base).
   *
   * Hereda ADR-053: el latido mide **entrega** (`nuevas`), no "el proceso corre". Y a diferencia de
   * `run-prod-feeds.js` —que sólo marca `error` si fallan TODOS los pasos— acá **un solo tenant que
   * falle pinta la corrida de rojo**: un tenant sin aparear es dinero contado dos veces, no un
   * detalle estadístico.
   *
   * ⚠️ Su umbral vive en `CRON_JOBS` (`apps/api/src/modules/db-health/db-health.service.ts`). Sin esa
   * entrada, `db-health` cae en `cfg ? classify : 'ok'` y un cron parado se vería VERDE.
   */
  private async latir(out: PairResult[], fallos: string[], ms: number): Promise<void> {
    try {
      const nuevas = out.reduce((a, r) => a + r.nuevas, 0);
      const propuestas = out.reduce((a, r) => a + r.propuestas, 0);
      const obsoletas = out.reduce((a, r) => a + r.obsoletas, 0);
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'twins_pairing',
          label: 'Apareo de recepciones gemelas (cron API)',
          last_start: this.knex.fn.now(),
          last_finish: this.knex.fn.now(),
          status: fallos.length ? 'error' : 'ok',
          // Lo accionable es lo que CAMBIÓ, no cuántas marcas se reescribieron: `marcadas` son casi
          // siempre las mismas y un número que nunca se mueve no distingue sano de muerto.
          rows_affected: nuevas,
          duration_ms: ms,
          note: fallos.length
            ? null
            : `${out.length} tenant(s) · ${nuevas} par(es) nuevo(s) · ${propuestas} por dictaminar · ${obsoletas} obsoleta(s)`,
          error: fallos.length ? fallos.join(' | ').slice(0, 500) : null,
          host: 'api',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch { /* el latido nunca rompe al que late (mismo criterio que cron-heartbeat.js) */ }
  }
}
