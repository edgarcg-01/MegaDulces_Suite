import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB, MiradaAlAviso, PgListenService } from '@megadulces/platform-core';

/** El canal que avisan los disparadores `tg_existencia_*` (migración 20261117094325). */
export const CANAL_EXISTENCIA = 'existencia_sucia';
/** Lo que se espera tras el primer aviso antes de drenar: la ingesta escribe en lotes cada ~15 s y se juntan. */
export const ESPERA_EXISTENCIA_MS = 30_000;

/** Un renglón de `analytics.drenar_existencia()`: uno por tabla recalculada, o uno solo (vacio/ocupado/error). */
export interface RenglonDrenado {
  modo: 'llave' | 'completo' | 'vacio' | 'ocupado' | 'error' | string;
  motivo: string | null;
  marcas: number | null;
  llaves: number | null;
  objeto: string | null;
  insertadas: number | null;
  actualizadas: number | null;
  borradas: number | null;
}

/**
 * `[CANON.6.21]` Oleada 8b, paso 4 — **el precio, los dos factores de caja y el costo unitario se recalculan al
 * llegar el cambio, no cada 5 minutos.** Edgar, 2026-11-10: «ningún cron».
 *
 * Los disparadores de las 13 fuentes (paso 3) anotan qué SKUs tocó cada escritura en `analytics.llaves_sucias` y
 * avisan `existencia_sucia`. Este servicio junta los avisos (`MiradaAlAviso`, a lo más una pasada por espera) y llama
 * a `analytics.drenar_existencia()`, que hace todo en la base: toma la cola, quita repetidos y recalcula por llave —
 * o todo, con la marca total, arriba del umbral o en la primera corrida del día (hora de México). La cola PERSISTE:
 * un aviso perdido no pierde nada, lo toma la siguiente pasada. Por eso mira al arrancar y cada vez que el `LISTEN`
 * vuelve (`alConectar`): `NOTIFY` no se guarda.
 *
 *  · `ocupado` (otro recalcula): agenda otra mirada, no espera.
 *  · `error`: la cola quedó intacta y la falla está escrita en `analytics.existencia_corridas`; se dice en el log.
 *  · Los disparadores tienen su propio interruptor (`analytics.existencia_por_evento`, apagado al instalarse): con él
 *    apagado este servicio igual drena lo que haya y hace el recálculo completo del día, pero no le llegan avisos.
 *
 * Sólo escucha en el worker (`WORKER=true`), como los demás oyentes que escriben. Se apaga entero con
 * `DISABLE_EXISTENCIA_POR_EVENTO=true`. Usa la conexión de la app: `drenar_existencia` es `SECURITY DEFINER` y
 * `app_runtime` sólo puede ejecutarla (no escribe la cola ni las tablas).
 */
@Injectable()
export class ExistenciaPorEventoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExistenciaPorEventoService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;
  private dejarDeVolver: (() => void) | null = null;
  private avisos = 0;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly listen: PgListenService,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_EXISTENCIA_POR_EVENTO === 'true') { this.logger.log('existencia por evento APAGADA (DISABLE_EXISTENCIA_POR_EVENTO)'); return; }
    if (process.env.WORKER !== 'true') { this.logger.log(`no escucho ${CANAL_EXISTENCIA}: este proceso no es el worker (WORKER distinto de true)`); return; }
    // Cada aviso cambia la firma: cada ráfaga es una pasada. La base decide si hay algo que hacer (`vacio`).
    this.mirada = new MiradaAlAviso(
      ESPERA_EXISTENCIA_MS,
      async () => String(this.avisos),
      async () => {
        const r = await this.drenar();
        if (r.modo === 'ocupado') this.mirada?.avisar();
      },
      (e) => this.logger.error(`existencia por evento: la pasada falló: ${(e as Error)?.message} — la cola sigue en la base`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_EXISTENCIA, () => { this.avisos++; this.mirada?.avisar(); });
      this.dejarDeVolver = this.listen.alConectar(() => this.mirada?.avisar());
      this.logger.log(`escuchando ${CANAL_EXISTENCIA} (sin reloj): precio, factores de caja y costo por llave`);
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_EXISTENCIA}: ${(e as Error)?.message} — la existencia NO se va a recalcular sola`);
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

  /** Una pasada: `analytics.drenar_existencia()` y lo que contestó, al log. */
  async drenar(): Promise<{ modo: string; renglones: RenglonDrenado[]; ms: number }> {
    const t0 = Date.now();
    let res: unknown;
    try {
      res = await this.knex.raw('SELECT * FROM analytics.drenar_existencia()');
    } catch (e: unknown) {
      // El código puede llegar a prod antes que su migración (se aplican por separado): eso no es una falla, se dice.
      if ((e as { code?: string })?.code === '42883') {
        this.logger.warn('existencia por evento: analytics.drenar_existencia() no existe todavía (falta la migración 20261117094325): nada que drenar');
        return { modo: 'no_instalado', renglones: [], ms: Date.now() - t0 };
      }
      throw e;
    }
    const renglones = ((res as { rows?: RenglonDrenado[] }).rows ?? []) as RenglonDrenado[];
    const ms = Date.now() - t0;
    const r0 = renglones[0];
    const modo = r0?.modo ?? 'sin_respuesta';
    if (modo === 'error') {
      this.logger.error(`existencia por evento: el recálculo FALLÓ (${r0?.motivo ?? '—'}, ${r0?.llaves ?? 0} SKUs); la cola quedó intacta — ver analytics.existencia_corridas`);
    } else if (modo === 'llave' || modo === 'completo') {
      const tablas = renglones.map((x) => `${x.objeto} ${x.insertadas}/${x.actualizadas}/${x.borradas}`).join(' · ');
      this.logger.log(`existencia por evento: ${modo} (${r0?.motivo}) · ${r0?.llaves ?? 0} SKUs de ${r0?.marcas ?? 0} marcas · ${tablas} · ${ms} ms`);
    } else if (modo === 'sin_respuesta') {
      this.logger.error('existencia por evento: drenar_existencia() no devolvió nada');
    }
    return { modo, renglones, ms };
  }
}
