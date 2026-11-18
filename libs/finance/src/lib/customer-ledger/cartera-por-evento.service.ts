import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB, MiradaAlAviso, PgListenService } from '@megadulces/platform-core';

/** El canal que avisan los disparadores `tg_receivables_*` (migración 20261117144732). */
export const CANAL_CARTERA = 'cartera_sucia';
/**
 * Lo que se espera tras el primer aviso antes de drenar: junta los lotes de la ingesta (cada ~15 s) en una corrida.
 * Una cuenta cuesta 20–230 ms (medido en prod el 2026-11-17), así que la espera no la fija el costo sino la frescura:
 * 30 s deja la cartera, como mucho, ~45 s detrás de Kepler.
 */
export const ESPERA_CARTERA_MS = 30_000;

/** Un renglón de `analytics.drain_customer_receivables()`. */
export interface CorridaCartera {
  mode: 'llave' | 'completo' | 'vacio' | 'ocupado' | 'error' | string;
  reason: string | null;
  marks: number | null;
  accounts: number | null;
  inserted: number | null;
  updated: number | null;
  deleted: number | null;
  ms: number | null;
}

/**
 * `[CXC.21]` **La cartera se recalcula al llegar el cambio, por cuenta.** Edgar, 2026-11-10: «ningún cron»; Edgar,
 * 2026-11-17: opción A (por evento) para la lentitud de `/finanzas/cartera` (4.3 s por lista, 3.3 s por ficha).
 *
 * Los disparadores de `kdud`, `kdm5`, `kdue` y `kdm1` anotan qué cuentas tocó cada escritura en
 * `analytics.receivables_dirty_accounts` y avisan `cartera_sucia`. Este servicio junta los avisos (`MiradaAlAviso`)
 * y llama a `analytics.drain_customer_receivables()`, que recalcula esas cuentas en
 * `analytics.customer_receivables_current` — o todo, comparando contra la vista, en la primera corrida del día. La
 * cola PERSISTE: un aviso perdido no pierde nada. Por eso mira al arrancar y cada vez que el `LISTEN` vuelve.
 *
 * Es la copia del patrón de `ExistenciaPorEventoService` (`[CANON.6.21]`) para otro dominio: misma pieza compartida
 * (`MiradaAlAviso`, `PgListenService`), su propia cola (la de existencia es de SKUs y la vacía su drenado).
 *
 * Sólo escucha en el worker (`WORKER=true`). Se apaga entero con `DISABLE_CARTERA_POR_EVENTO=true`. Los disparadores
 * tienen su interruptor en la base (`analytics.receivables_by_event`, apagado al instalarse).
 */
@Injectable()
export class CarteraPorEventoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CarteraPorEventoService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;
  private dejarDeVolver: (() => void) | null = null;
  private avisos = 0;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly listen: PgListenService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_CARTERA_POR_EVENTO === 'true') { this.logger.log('cartera por evento APAGADA (DISABLE_CARTERA_POR_EVENTO)'); return; }
    if (process.env.WORKER !== 'true') { this.logger.log(`no escucho ${CANAL_CARTERA}: este proceso no es el worker (WORKER distinto de true)`); return; }
    this.mirada = new MiradaAlAviso(
      ESPERA_CARTERA_MS,
      async () => String(this.avisos),
      async () => {
        const r = await this.drenar();
        if (r.mode === 'ocupado') this.mirada?.avisar();
      },
      (e) => this.logger.error(`cartera por evento: la pasada falló: ${(e as Error)?.message} — la cola sigue en la base`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_CARTERA, () => { this.avisos++; this.mirada?.avisar(); });
      this.dejarDeVolver = this.listen.alConectar(() => this.mirada?.avisar());
      this.logger.log(`escuchando ${CANAL_CARTERA} (sin reloj): cartera de clientes por cuenta`);
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_CARTERA}: ${(e as Error)?.message} — la cartera NO se va a recalcular sola`);
    }
    this.mirada.avisar(); // la primera mirada: lo que quedó en la cola con el proceso abajo, y el completo del día
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    this.dejarDeVolver?.();
    this.dejarDeVolver = null;
    this.mirada?.detener();
  }

  /** Una pasada: `analytics.drain_customer_receivables()` y lo que contestó, al log. */
  async drenar(): Promise<CorridaCartera> {
    let res: unknown;
    try {
      res = await this.knex.raw('SELECT * FROM analytics.drain_customer_receivables()');
    } catch (e: unknown) {
      // El código puede llegar a prod antes que su migración (se aplican por separado): eso no es una falla, se dice.
      if ((e as { code?: string })?.code === '42883') {
        this.logger.warn('cartera por evento: analytics.drain_customer_receivables() no existe todavía (falta la migración 20261117144732): nada que drenar');
        return { mode: 'no_instalado', reason: null, marks: null, accounts: null, inserted: null, updated: null, deleted: null, ms: null };
      }
      throw e;
    }
    const r = ((res as { rows?: CorridaCartera[] }).rows ?? [])[0];
    if (!r) {
      this.logger.error('cartera por evento: drain_customer_receivables() no devolvió nada');
      return { mode: 'sin_respuesta', reason: null, marks: null, accounts: null, inserted: null, updated: null, deleted: null, ms: null };
    }
    if (r.mode === 'error') {
      this.logger.error(`cartera por evento: el recálculo FALLÓ (${r.reason ?? '—'}, ${r.accounts ?? 0} cuentas); la cola quedó intacta — ver analytics.receivables_refresh_runs`);
    } else if (r.mode === 'llave' || r.mode === 'completo') {
      this.logger.log(`cartera por evento: ${r.mode} (${r.reason}) · ${r.accounts ?? 0} cuentas de ${r.marks ?? 0} marcas · ${r.inserted}/${r.updated}/${r.deleted} · ${r.ms} ms`);
    }
    return r;
  }
}
