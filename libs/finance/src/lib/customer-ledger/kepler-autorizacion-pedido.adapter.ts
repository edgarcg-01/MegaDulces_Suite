import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { urlDeServidor, valorDeEnv, type Env } from '@megadulces/platform-core';
import {
  LECTURA_PEDIDO,
  decidirEscrituraAutorizacion,
  sentenciaAutorizacion,
  type AccionAutorizacion,
  type PedidoLeidoKepler,
} from './autorizacion-kepler';

/**
 * `[GP.A.2]` C2 — **Escribe en el Kepler vivo la autorización de un pedido TELEMARK** (o su regreso), con la regla y
 * la sentencia de `autorizacion-kepler.ts`. Modelo: la cancelación de la solicitud de gasto (`[PGP.122.6]`): una
 * transacción que lee con candado, decide, escribe y comprueba que tocó exactamente una fila; si no, deshace.
 *
 * ── Tres candados, y los tres tienen que estar abiertos ──────────────────────────────────────────────────────────
 *   1. `KEPLER_AUTORIZACION_PEDIDOS=encendida` (apagado por default)
 *   2. `KEPLER_PUSH_URL_NN` (la conexión de `kepler_push` al servidor de la sucursal, sólo desde `md`)
 *   3. el `GRANT UPDATE (c11)` en Kepler (`ops/prod/kepler-grants/gpa0d_kdm1_update_c11.sql`)
 * El renglón `autorizacion` de `commercial.kepler_push_switch` (interruptor por sucursal y tope del día) lo lee quien
 * decide (la regla, condición 6), antes de llamar aquí.
 *
 * **Es idempotente**: autorizar uno que ya está AUTORIZADO devuelve `ya_estaba` sin escribir; el `WHERE` con el
 * estatus leído impide pisar un cambio hecho en Kepler a la vez.
 *
 * Nunca lanza: lo que pase en Kepler se devuelve para guardarlo en la bitácora.
 */

export type ResultadoEscrituraAutorizacion =
  | { estado: 'escrito'; de: string; a: string }
  | { estado: 'ya_estaba'; motivo: string }
  | { estado: 'apagado'; motivo: string }
  | { estado: 'rechazado'; motivo: string; reintentable: boolean };

export interface PedidoAEscribir {
  sucursal: string;
  serie: number;
  folio: string;
  accion: AccionAutorizacion;
}

export function escrituraDeAutorizacionEncendida(env: Env): boolean {
  return valorDeEnv(env, 'KEPLER_AUTORIZACION_PEDIDOS') === 'encendida';
}

/** Una conexión caída o lenta se puede reintentar; un rechazo de la regla, no. */
export function esReintentableAutorizacion(err: unknown): boolean {
  const e = err as { message?: string; code?: string };
  if (e?.code === '55P03' || e?.code === '40P01') return true; // candado ocupado o deadlock
  return /Connection terminated|timeout exceeded when trying to connect|connect ETIMEDOUT|ECONNRESET/i.test(String(e?.message ?? ''));
}

@Injectable()
export class KeplerAutorizacionPedidoAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerAutorizacionPedidoAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /** Las variables de entorno en un getter y no en el constructor (#414). La prueba y el ensayo lo reemplazan. */
  protected get env(): Env { return process.env; }

  /** Costura para la prueba: la conexión al servidor de la sucursal. */
  protected async conectar(url: string): Promise<PoolClient> {
    let p = this.pools.get(url);
    if (!p) {
      // Mismos tiempos que el resto de los escritores a Kepler: cada servidor está en otra red (WAN/VPN), y
      // `idle_in_transaction_session_timeout` suelta el candado de la fila si la red se cae a media transacción.
      p = new Pool({
        connectionString: url, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 30000, query_timeout: 45000,
        idle_in_transaction_session_timeout: 15000, keepAlive: true,
      });
      this.pools.set(url, p);
    }
    return p.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
  }

  encendida(): boolean { return escrituraDeAutorizacionEncendida(this.env); }

  /** El único paso que hace permanente la escritura. Aparte para que el ensayo termine en ROLLBACK aquí. */
  protected async confirmar(c: PoolClient): Promise<void> {
    await c.query('COMMIT');
  }

  async escribir(e: PedidoAEscribir): Promise<ResultadoEscrituraAutorizacion> {
    if (!this.encendida()) return { estado: 'apagado', motivo: 'La autorización de pedidos en Kepler está apagada (KEPLER_AUTORIZACION_PEDIDOS)' };
    const srv = urlDeServidor(e.sucursal, this.env);
    if (!srv.ok) return { estado: 'apagado', motivo: srv.motivo };
    let c: PoolClient;
    try {
      c = await this.conectar(srv.valor);
    } catch (err) {
      return { estado: 'rechazado', motivo: `Kepler ${e.sucursal} no responde: ${(err as Error).message}`, reintentable: true };
    }
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      const leidos = (await c.query(LECTURA_PEDIDO, [e.sucursal, e.serie, e.folio])).rows as PedidoLeidoKepler[];
      const d = decidirEscrituraAutorizacion(leidos, e.accion);
      if (!d.ok) {
        await c.query('ROLLBACK');
        return d.yaEstaba ? { estado: 'ya_estaba', motivo: d.motivo } : { estado: 'rechazado', motivo: d.motivo, reintentable: false };
      }
      const s = sentenciaAutorizacion({ sucursal: e.sucursal, serie: e.serie, folio: e.folio, de: d.de, a: d.a });
      const r = await c.query(s.sql, s.params);
      if (r.rowCount !== s.esperadas) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `Al escribir ${s.que} se tocaron ${r.rowCount} filas en lugar de ${s.esperadas}: alguien lo cambió en Kepler a la vez; no se escribió nada`, reintentable: true };
      }
      await this.confirmar(c);
      this.logger.log(`Pedido ${e.sucursal}-${e.serie}-${e.folio}: ${d.de} → ${d.a} en Kepler desde la Suite`);
      return { estado: 'escrito', de: d.de, a: d.a };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      return { estado: 'rechazado', motivo: `Kepler ${e.sucursal} no lo escribió: ${(err as Error).message}`, reintentable: esReintentableAutorizacion(err) };
    } finally {
      c.release();
    }
  }
}
