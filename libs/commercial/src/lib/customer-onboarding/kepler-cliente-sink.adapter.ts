import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { urlDelConcentrador, urlDeServidor, type Env, type Resolucion } from '@megadulces/platform-core';
import type { ResultadoServidorAlta, ServidorEscrituraKepler } from '@megadulces/contracts';

import {
  COLUMNA_KEPLER,
  SERVIDORES_CLIENTE,
  enSerie,
  siguienteClave,
  type FilaKepler,
  type PlanClienteKepler,
  type SerieClave,
} from './kepler-cliente.armador';

/** Conexión de un servidor del maestro de clientes: `SC` = concentrador; `00`…`08` = sucursales. */
export function urlDeServidorCliente(servidor: string, env: Env): Resolucion<string> {
  return servidor === 'SC' ? urlDelConcentrador(env) : urlDeServidor(servidor, env);
}

/** Los 10 servidores y si tienen conexión configurada (no se conecta a ninguno). */
export function servidoresDeCliente(env: Env): ServidorEscrituraKepler[] {
  return SERVIDORES_CLIENTE.map((servidor) => {
    const u = urlDeServidorCliente(servidor, env);
    return { servidor, configurado: u.ok, motivo: u.ok ? null : u.motivo };
  });
}

const RFC_GENERICOS = new Set(['XAXX010101000', 'XEXX010101000']);

/** Quién escribió, en la bitácora de Kepler (`kdlogmov.c1`/`c4`): la Suite, no una persona (como `kdm1.c67` en KR). */
export const CAPTURISTA_SUITE = 'SUITE';

/** El resultado de un servidor, con la marca interna de «la clave es de otro cliente» (no sale del adaptador). */
type Resultado = ResultadoServidorAlta & { ajena?: true };
const sinMarca = ({ servidor, estado, motivo }: Resultado): ResultadoServidorAlta => ({ servidor, estado, motivo });

export type ClaveDeKepler = { ok: true; clave: string } | { ok: false; motivo: string };

export interface EntregaClienteKepler {
  servidores: ResultadoServidorAlta[];
  /** El concentrador dijo que la clave ya es de OTRO cliente y no se escribió nada: hay que soltar la reserva. */
  claveAjena: boolean;
}

function insertDe(tabla: string, fila: FilaKepler): { sql: string; valores: unknown[] } {
  const cols = Object.keys(fila);
  for (const k of cols) if (!COLUMNA_KEPLER.test(k)) throw new Error(`Columna inválida en el plan: ${k}`);
  return {
    sql: `INSERT INTO md.${tabla} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    valores: cols.map((k) => fila[k]),
  };
}

/**
 * `[ALC.2.7]` C2 — **Da de alta un cliente en Kepler: `kdud` + `kdfedir` en las 10 bases** (D1-b).
 *
 * Plan: `FASE_ALC_ALTA_DE_CLIENTES.md` §4.1. Lo que escribe lo decide el armador (C1); aquí sólo se
 * lee lo vivo y se escribe. A diferencia del pago (`KeplerPagoSinkAdapter`) **no se clona una
 * plantilla**: las 30 columnas de `kdud` y las 19 de `kdfedir` se escriben TODAS explícitas
 * (el armador reproduce la fila real de 21054, 30/30 y 19/19). Si la base viva tuviera una columna
 * `NOT NULL` que el ODS no trae, el INSERT falla en voz alta — y eso es lo que caza el ensayo.
 *
 * ── Por qué 10 bases ────────────────────────────────────────────────────────────────────────
 * La forma de Kepler, guardada en el concentrador, repite la escritura en las 9 sucursales con la
 * librería del cliente (`pv_sc_lib`); la base no replica. Si la Suite no escribiera en el
 * concentrador, la siguiente alta hecha ahí podría tomar la misma clave.
 *
 * ── Cuatro candados, y los cuatro tienen que estar abiertos ───────────────────────────────
 *   1. `commercial.kepler_push_switch` (sucursal de la solicitud, tipo `cliente`) encendido —lo lee
 *      el service, con su tope diario— · 2. las 10 conexiones `KEPLER_PUSH_URL_SC` y
 *      `KEPLER_PUSH_URL_00`…`_08` · 3. los `GRANT` en las 10 bases: `SELECT, INSERT` en `md.kdud`,
 *      `md.kdfedir` y `INSERT` en `md.kdlogmov` · 4. la llave `COMMERCIAL_ALTA_CLIENTES_KEPLER`.
 *   Y antes de encender: el ensayo (`kepler-cliente-sink.ensayo.spec.ts`) contra las 10.
 *
 * ── Idempotente por diseño ──────────────────────────────────────────────────────────────────
 * La clave se reserva en la Suite ANTES de escribir (`reservarClave` no escribe). Escribir es por
 * servidor y en su propia transacción: si la clave ya está con el MISMO cliente (mismo RFC; con el
 * genérico, mismo RFC y nombre) es `ya_estaba`; con otro cliente, `rechazada` y no se toca. Un
 * reintento con la misma clave completa sólo lo que faltó.
 *
 * Sin `LOCK TABLE` (Kepler está en uso): una alta simultánea en Kepler con la misma clave la
 * rebota la llave primaria, sin daño, y queda escrita en el resultado de ese servidor.
 */
@Injectable()
export class KeplerClienteSinkAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerClienteSinkAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /** En un método y no en el constructor: un parámetro sin token tumba el arranque de Nest (#414). El ensayo lo reemplaza. */
  protected get env(): Env { return process.env; }

  private poolDe(url: string): Pool {
    let p = this.pools.get(url);
    if (!p) {
      p = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 30000 });
      this.pools.set(url, p);
    }
    return p;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
  }

  /** Los 10 servidores con su conexión (sin conectarse). */
  servidores(): ServidorEscrituraKepler[] {
    return servidoresDeCliente(this.env);
  }

  /**
   * Paso 1 — la clave. Lee la serie en las 10 bases vivas (sirve también de prueba de que las 10
   * contestan ANTES de escribir en alguna) y le suma las que la Suite ya reservó. Con una clave ya
   * reservada por un intento anterior, se devuelve ésa: el reintento no inventa otra. No escribe.
   */
  async reservarClave(serie: SerieClave, reservadasEnSuite: string[], reservada: string | null): Promise<ClaveDeKepler> {
    const apagados = this.servidores().filter((s) => !s.configurado);
    if (apagados.length) return { ok: false, motivo: apagados.map((s) => s.motivo).join(' · ') };
    if (reservada && !enSerie(serie, reservada)) {
      return { ok: false, motivo: `La clave reservada ${reservada} ya no es de la serie ${serie.patron} (¿cambió la zona o el crédito?): cancélala y vuelve a capturar` };
    }
    const existentes = [...reservadasEnSuite];
    for (const servidor of SERVIDORES_CLIENTE) {
      const u = urlDeServidorCliente(servidor, this.env);
      if (!u.ok) return { ok: false, motivo: u.motivo };
      let c: PoolClient | null = null;
      try {
        c = await this.poolDe(u.valor).connect();
        // `cuenta`, no `regex`: en crédito el consecutivo también lo ocupan las `C1xxx` viejas.
        const { rows } = await c.query(`SELECT btrim(c2) AS c2 FROM md.kdud WHERE upper(btrim(c2)) ~ $1`, [serie.cuenta]);
        for (const r of rows) existentes.push(String(r.c2));
      } catch (err) {
        return { ok: false, motivo: `Kepler ${servidor} no contestó: ${(err as Error).message}. No se escribió nada.` };
      } finally {
        c?.release();
      }
    }
    return reservada ? { ok: true, clave: reservada } : siguienteClave(serie, existentes);
  }

  /**
   * El único paso que ESCRIBE. Aparte para que el ensayo corra todo el SQL real y termine en ROLLBACK
   * aquí (el ensayo usa el servidor y el plan para releer y comparar; aquí no hacen falta).
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected async confirmar(c: PoolClient, _servidor: string, _plan: PlanClienteKepler): Promise<void> {
    await c.query('COMMIT');
  }

  /** Paso 2 — escribe en las 10, el concentrador primero. Cada servidor en su transacción. */
  async entregar(plan: PlanClienteKepler, folio: string): Promise<EntregaClienteKepler> {
    if (!plan.clave || plan.kdud['c2'] !== plan.clave || plan.kdfedir['c2'] !== plan.clave) {
      throw new Error('El plan no trae su clave en kdud.c2 y kdfedir.c2: no se escribe nada');
    }
    const servidores: Resultado[] = [];
    for (const servidor of SERVIDORES_CLIENTE) {
      const u = urlDeServidorCliente(servidor, this.env);
      const r: Resultado = u.ok ? await this.escribirEn(servidor, u.valor, plan, folio) : { servidor, estado: 'rechazada', motivo: u.motivo };
      servidores.push(r);
      if (servidor === 'SC' && r.estado === 'rechazada') {
        // Sin el concentrador no se sigue: es donde se dan las altas, y una sucursal sin él diverge.
        for (const resto of SERVIDORES_CLIENTE.slice(1)) {
          servidores.push({ servidor: resto, estado: 'rechazada', motivo: 'No se intentó: el concentrador rechazó la ficha.' });
        }
        return { servidores: servidores.map(sinMarca), claveAjena: r.ajena === true };
      }
    }
    const escritas = servidores.filter((s) => s.estado !== 'rechazada').length;
    this.logger.log(`[ALC] ${folio} → Kepler clave ${plan.clave}: ${escritas}/${servidores.length} bases`);
    return { servidores: servidores.map(sinMarca), claveAjena: false };
  }

  private async escribirEn(servidor: string, url: string, plan: PlanClienteKepler, folio: string): Promise<Resultado> {
    let c: PoolClient | null = null;
    try {
      c = await this.poolDe(url).connect();
      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      const rfc = String(plan.kdud['c10']);
      const ya = (await c.query(`SELECT btrim(c3) AS c3, upper(btrim(c10)) AS c10 FROM md.kdud WHERE btrim(c2) = $1`, [plan.clave])).rows[0];
      let nuevo = false;
      if (ya) {
        const mismo = RFC_GENERICOS.has(rfc) ? ya.c10 === rfc && ya.c3 === plan.kdud['c3'] : ya.c10 === rfc;
        if (!mismo) {
          await c.query('ROLLBACK');
          return { servidor, estado: 'rechazada', ajena: true, motivo: `La clave ${plan.clave} ya es de otro cliente en Kepler ${servidor} («${ya.c3}», RFC ${ya.c10 || 'vacío'}). No se tocó.` };
        }
      } else {
        const i = insertDe('kdud', plan.kdud);
        await c.query(i.sql, i.valores);
        nuevo = true;
      }
      const fe = await c.query(
        `SELECT 1 FROM md.kdfedir WHERE btrim(c1::text) = '3' AND btrim(c2) = $1 AND btrim(c3::text) = '1'`, [plan.clave]);
      if (!fe.rowCount) {
        const i = insertDe('kdfedir', plan.kdfedir);
        await c.query(i.sql, i.valores);
        nuevo = true;
      }
      if (nuevo) {
        // Rastro en la bitácora de Kepler, como el que deja su forma al borrar (`5,BORR`): aquí `ALTA` + el folio de la Suite.
        await c.query(
          `INSERT INTO md.kdlogmov (c1, c2, c3, c4, c5, c6, c7, c8, c9)
           VALUES ($1, (now() AT TIME ZONE 'America/Mexico_City')::date, to_char(now() AT TIME ZONE 'America/Mexico_City', 'HH24:MI:SS'),
                   $1, 'ALTA', $2, '', 'kdud', $3)`,
          [CAPTURISTA_SUITE, folio, `'${plan.clave}'`]);
      }
      await this.confirmar(c, servidor, plan);
      return { servidor, estado: nuevo ? 'escrita' : 'ya_estaba', motivo: null };
    } catch (err) {
      await c?.query('ROLLBACK').catch(() => undefined);
      const motivo = (err as Error).message;
      this.logger.error(`[ALC] ${folio} rechazada por Kepler ${servidor}: ${motivo}`);
      return { servidor, estado: 'rechazada', motivo };
    } finally {
      c?.release();
    }
  }
}
