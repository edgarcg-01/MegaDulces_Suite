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
          // Un tenant que truena no puede frenar a los demás ni tirar el cron.
          this.logger.warn(`[${origen}] tenant ${t.id}: ${e.message}`);
        }
      }
      if (!soloTenant) this.lastOkAt = Date.now();
    } catch (e: any) {
      this.logger.warn(`[${origen}] ${e.message}`);
    }
    return out;
  }
}
