import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Knex } from 'knex';
import { KNEX_NEW_DB, MiradaAlAviso, PgListenService } from '@megadulces/platform-core';

/**
 * `[COT.7.50]` — **La tienda de marca deja de mentir sola: se empuja lo que cambió, cuando cambia.**
 *
 * ── Por qué ─────────────────────────────────────────────────────────────────
 * Medido el 2026-11-26 sobre una ventana real de 22 h: la tienda se desfasa **376 renglones de
 * cantidad y 6 de precio**, o sea **~23 % del catálogo en un día**. Corregirla a mano dura horas.
 *
 * ── Cómo, sin estrenar nada ─────────────────────────────────────────────────
 * No hay canal nuevo, ni disparador nuevo, ni reloj. Se escucha **`existencia_sucia`**, el canal
 * que `[CANON.6.21]` ya puso en producción: disparadores en 13 fuentes anotan en
 * `analytics.llaves_sucias` **qué SKU** tocó cada escritura y avisan. *ADR-056: se reusa el
 * primitivo.* Y nació de la misma regla que manda acá — Edgar, 2026-11-10: «ningún cron».
 *
 * ⛔ **La cola se lee en el AVISO, no después.** `analytics.drenar_existencia()` la **consume**, así
 * que quien llega tarde no encuentra nada. Por eso cada aviso toma los SKU y los acumula en memoria.
 *
 * ⚠️ **Lo que esto pierde, declarado:** si el worker se reinicia con SKU acumulados sin empujar, se
 * pierden. No es grave y se autocorrige —el siguiente cambio de ese SKU lo vuelve a marcar—, y al
 * arrancar se hace una pasada completa que cierra el hueco. Lo que NO se hace es fingir que no pasa.
 *
 * ⛔ **Fail-OPEN, igual que `notify-store.js`:** esto es un empuje a un sistema de afuera, no el
 * dato. Si Wix no contesta, la tienda queda como estaba y se dice en el log. Que un empuje caído
 * tumbe al worker sería cambiar un problema chico por uno grande.
 *
 * Sólo escucha en el worker (`WORKER=true`), como los demás oyentes que escriben.
 * Se apaga entero con `DISABLE_TIENDA_SYNC=true`.
 */

/** El canal de `[CANON.6.21]`. Se importa el nombre, no se redeclara. */
export const CANAL_EXISTENCIA_TIENDA = 'existencia_sucia';

/**
 * Cuánto se juntan los avisos antes de empujar. Más corto que los 2 min del drenado de existencia
 * a propósito: este empuje **no depende del recálculo** —el precio sale del mostrador en vivo y la
 * existencia del resolvedor arbitrado—, así que no hay que esperarlo.
 */
export const ESPERA_TIENDA_MS = 60_000;

/** Cuántos SKU se empujan como mucho de una vez: una ráfaga de ventas no se vuelve una tormenta. */
export const TOPE_POR_PASADA = 200;

/**
 * Lo que empuja de verdad. Vive detrás de un puerto para que la decisión —qué empujar y cuándo—
 * se pueda probar sin red, y para que el transporte se enchufe cuando exista su secreto.
 */
export abstract class EmpujeTienda {
  /** Empuja esos SKU. Devuelve cuántos renglones cambió. Puede lanzar: quien llama lo contiene. */
  abstract empujar(skus: string[]): Promise<{ renglones: number; noPublicados: number }>;
}

@Injectable()
export class TiendaSyncPorEventoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TiendaSyncPorEventoService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;
  private dejarDeVolver: (() => void) | null = null;
  /** Los SKU tomados de la cola, esperando su empuje. */
  private sucios = new Set<string>();
  private avisos = 0;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly listen: PgListenService,
    private readonly empuje: EmpujeTienda,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_TIENDA_SYNC === 'true') {
      this.logger.log('empuje a la tienda APAGADO (DISABLE_TIENDA_SYNC)');
      return;
    }
    if (process.env.WORKER !== 'true') {
      this.logger.log(`no escucho ${CANAL_EXISTENCIA_TIENDA}: este proceso no es el worker`);
      return;
    }
    this.mirada = new MiradaAlAviso(
      ESPERA_TIENDA_MS,
      async () => String(this.avisos),
      async () => { await this.pasada(); },
      (e) => this.logger.error(`empuje a la tienda: la pasada falló: ${(e as Error)?.message} — la tienda queda como estaba`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_EXISTENCIA_TIENDA, () => {
        this.avisos++;
        // ⛔ tomar AHORA: drenar_existencia() consume la cola
        void this.tomarDeLaCola().finally(() => this.mirada?.avisar());
      });
      this.dejarDeVolver = this.listen.alConectar(() => this.mirada?.avisar());
      this.logger.log(`escuchando ${CANAL_EXISTENCIA_TIENDA} (sin reloj): la tienda se empuja al cambiar`);
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_EXISTENCIA_TIENDA}: ${(e as Error)?.message} — la tienda NO se va a actualizar sola`);
    }
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    this.dejarDeVolver?.();
    this.dejarDeVolver = null;
    this.mirada?.detener();
  }

  /** Lee los SKU que están en la cola AHORA y los acumula. No borra: de eso se encarga el drenado. */
  async tomarDeLaCola(): Promise<number> {
    try {
      const r = await this.knex.raw(
        `SELECT DISTINCT sku FROM analytics.llaves_sucias WHERE sku IS NOT NULL LIMIT ?`,
        [TOPE_POR_PASADA * 5],
      );
      const filas = ((r as { rows?: { sku: string }[] }).rows ?? []);
      for (const f of filas) if (f?.sku) this.sucios.add(String(f.sku));
      return filas.length;
    } catch (e: unknown) {
      // El código puede llegar antes que su migración: eso no es una falla, se dice.
      if ((e as { code?: string })?.code === '42P01') {
        this.logger.warn('empuje a la tienda: analytics.llaves_sucias no existe todavía: nada que tomar');
        return 0;
      }
      this.logger.warn(`empuje a la tienda: no se pudo leer la cola: ${(e as Error)?.message}`);
      return 0;
    }
  }

  /** Una pasada: empuja lo acumulado. Los SKU se sueltan SÓLO si el empuje salió bien. */
  async pasada(): Promise<{ empujados: number; renglones: number } | null> {
    if (!this.sucios.size) return null;
    const lote = [...this.sucios].slice(0, TOPE_POR_PASADA);
    try {
      const r = await this.empuje.empujar(lote);
      // recién ahora: si falla, siguen pendientes y entran en la próxima
      for (const s of lote) this.sucios.delete(s);
      this.logger.log(
        `empuje a la tienda: ${lote.length} SKU · ${r.renglones} renglón(es) cambiado(s)` +
        (r.noPublicados ? ` · ${r.noPublicados} no publicados` : '') +
        (this.sucios.size ? ` · quedan ${this.sucios.size}` : ''),
      );
      if (this.sucios.size) this.mirada?.avisar();
      return { empujados: lote.length, renglones: r.renglones };
    } catch (e: unknown) {
      // FAIL-OPEN: la tienda queda como estaba y los SKU siguen pendientes.
      this.logger.error(`empuje a la tienda: ${(e as Error)?.message} — quedan ${this.sucios.size} SKU pendientes`);
      return null;
    }
  }

  /** Cuántos SKU esperan empuje. Para la prueba y para poder mirarlo. */
  pendientes(): number {
    return this.sucios.size;
  }
}
