import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { urlDeServidor, type Env } from '@megadulces/platform-core';

import {
  escrituraDeAutorizacionEncendida, llaveDeSolicitud, veredictoAutorizacion,
  type ResultadoAutorizacionKepler,
} from './autorizacion-kepler';

/** La solicitud `X-A-15-1` por su llave primaria (`pk_kdm1`: c1…c6). */
const LLAVE = `c1 = $1 AND c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1 AND c6 = $2`;

/**
 * `[PGP.79]` C2 — **Autoriza en Kepler la solicitud de un vale firmado** (`kdm1.c43: N → A`).
 * La regla y su medición viven en `autorizacion-kepler.ts`.
 *
 * ── Tres candados, y los tres tienen que estar abiertos ───────────────────────────────────
 *   1. `KEPLER_GASTO_AUTORIZACION=encendida` (apagado por default) · 2. `KEPLER_PUSH_URL_NN`
 *   3. el `GRANT UPDATE (c43) ON md.kdm1 TO kepler_push` — dado en las 9 bases el 2026-11-06 y
 *      verificado desde `md`: `kepler_push` puede cambiar `c43` y NINGUNA otra columna.
 *
 * Idempotente: el `c43 = 'N'` va en el WHERE del UPDATE, así que reintentar no escribe dos veces
 * y una solicitud que Kepler ya decidió no se toca. Sin `LOCK TABLE` (Kepler está en uso): una
 * fila por llave primaria, con `lock_timeout` corto para no quedarse esperando a la pantalla de
 * Kepler si alguien tiene esa misma solicitud abierta.
 *
 * Nunca lanza: el vale ya quedó aprobado en la Suite y lo que pase en Kepler se devuelve como
 * resultado para guardarlo y mostrarlo.
 */
@Injectable()
export class KeplerAutorizacionGastoAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerAutorizacionGastoAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /** Las variables de entorno, en un método y no en el constructor (#414). La prueba lo reemplaza. */
  protected get env(): Env { return process.env; }

  private poolDe(url: string): Pool {
    let p = this.pools.get(url);
    if (!p) {
      p = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 15000 });
      this.pools.set(url, p);
    }
    return p;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
  }

  /** El único paso que deja la escritura en el ERP. Aparte para que el ensayo termine en ROLLBACK. */
  protected async confirmar(c: PoolClient): Promise<void> {
    await c.query('COMMIT');
  }

  /** ¿La escritura está prendida? Sin esto quien llama no guarda nada: apagada no es un resultado. */
  encendida(): boolean { return escrituraDeAutorizacionEncendida(this.env); }

  async autorizar(v: { sucursal?: string | null; folio_solicitud?: string | null }): Promise<ResultadoAutorizacionKepler> {
    if (!this.encendida()) return { estado: 'no_escrito', motivo: 'La autorización en Kepler está apagada (KEPLER_GASTO_AUTORIZACION)' };
    const llave = llaveDeSolicitud(v);
    if (!llave.ok) return { estado: 'no_escrito', motivo: llave.motivo };
    const { sucursal, folio } = llave.valor;
    const srv = urlDeServidor(sucursal, this.env);
    if (!srv.ok) return { estado: 'no_escrito', motivo: srv.motivo };

    let c: PoolClient;
    try {
      c = await this.poolDe(srv.valor).connect();
    } catch (e) {
      return { estado: 'no_escrito', motivo: `Kepler (${sucursal}) no respondió: ${(e as Error)?.message ?? e}` };
    }
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      const u = await c.query(`UPDATE md.kdm1 SET c43 = 'A' WHERE ${LLAVE} AND c43 = 'N'`, [sucursal, folio]);
      const cambiadas = u.rowCount ?? 0;
      const actual = cambiadas === 0
        ? ((await c.query(`SELECT c43 FROM md.kdm1 WHERE ${LLAVE}`, [sucursal, folio])).rows[0]?.c43 ?? null)
        : null;
      const r = veredictoAutorizacion(cambiadas, actual);
      if (r.estado === 'escrito') await this.confirmar(c);
      else await c.query('ROLLBACK');
      this.logger.log(`solicitud ${sucursal}-${folio} en Kepler: ${r.estado}${r.estado === 'no_escrito' ? ` (${r.motivo})` : ''}`);
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      return { estado: 'no_escrito', motivo: `Kepler (${sucursal}) rechazó la escritura: ${(e as Error)?.message ?? e}` };
    } finally {
      c.release();
    }
  }
}
