import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { urlDelConcentrador, urlDeServidor, type Env, type Resolucion } from '@megadulces/platform-core';

/**
 * `[CXC.48]` C2 — **El teléfono del cliente, escrito en Kepler en cada base donde está su clave** (Edgar, 2026-11-20).
 *
 * ── Lo medido que manda el diseño (prod, sólo lectura, 2026-11-20) ─────────────────────────────────────────────────
 *  · El teléfono es `kdud.c7`: la forma de clientes de Kepler (`md_cat_cli.kpl`) deja en `kdlogmov` la columna `7` con
 *    teléfonos (373 cambios en las 9 sucursales), y es la que ya lee la cartera.
 *  · Un cambio hecho en UNA sucursal no llega a las otras (cliente 30172, editado en la 05: las otras 7 siguen igual).
 *    La base no replica; sólo lo que se guarda en el concentrador se repite. Por eso se escribe en cada base.
 *  · Kepler registra cada casilla en `kdlogmov` (usuario, fecha, hora, forma, columna, nuevo, anterior, tabla, clave).
 *    La Suite deja el mismo renglón con `SUITE` como usuario y como forma (igual que el alta de ALC).
 *
 * ── Cuatro candados ───────────────────────────────────────────────────────────────────────────────────────────────
 *   1. `commercial.kepler_push_switch` (sucursal de la cuenta, tipo `telefono_cliente`) encendido, con su tope diario
 *      (lo lee el servicio) · 2. las 10 conexiones `KEPLER_PUSH_URL_SC` y `_00`…`_08` · 3. en las 10 bases, para ese
 *      usuario: `SELECT, UPDATE (c7)` en `md.kdud` e `INSERT` en `md.kdlogmov` · 4. la llave `FINANCE_CARTERA_TELEFONOS`.
 *
 * ── Primero se pregunta a las 10, después se escribe ──────────────────────────────────────────────────────────────
 * Si una base no contesta, no se escribe en NINGUNA: un teléfono distinto por sucursal es justo lo que se quiere evitar.
 * Escribir es por base y en su propia transacción (`FOR UPDATE` sobre la fila). Una base donde la clave no está queda
 * como `no_esta`: no se da de alta a nadie desde aquí.
 */

/** Los servidores del maestro de clientes: el concentrador primero. */
export const SERVIDORES_TELEFONO = ['SC', '00', '01', '02', '03', '04', '05', '06', '07', '08'] as const;
export const CAPTURISTA_SUITE = 'SUITE';

export type EstadoServidorTelefono = 'escrita' | 'ya_estaba' | 'no_esta' | 'rechazada';
export interface ResultadoServidorTelefono {
  servidor: string;
  estado: EstadoServidorTelefono;
  anterior: string | null;
  motivo: string | null;
}

/** El cliente de Postgres que necesita la escritura (un `PoolClient` real o uno de prueba). */
export interface ClienteSql { query(sql: string, valores?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }> }

/** Normaliza a 10 dígitos (México). Acepta espacios, guiones, paréntesis y el `+52`/`52` delante. */
export function normalizarTelefono(crudo: string | null | undefined): { ok: true; valor: string } | { ok: false; motivo: string } {
  let d = String(crudo ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('52')) d = d.slice(2);
  if (d.length === 13 && d.startsWith('521')) d = d.slice(3);
  if (d.length !== 10) return { ok: false, motivo: `El teléfono debe tener 10 dígitos (trae ${d.length}).` };
  return { ok: true, valor: d };
}

export function urlDeServidorTelefono(servidor: string, env: Env): Resolucion<string> {
  return servidor === 'SC' ? urlDelConcentrador(env) : urlDeServidor(servidor, env);
}

/**
 * La escritura en UNA base, dentro de la transacción que ya abrió quien llama. Devuelve qué pasó; no hace COMMIT.
 * Exportada para probarla con un cliente falso (el SQL es el real).
 */
export async function escribirTelefonoEnBase(c: ClienteSql, servidor: string, clave: string, telefono: string): Promise<ResultadoServidorTelefono> {
  const fila = (await c.query(`SELECT c7 FROM md.kdud WHERE btrim(c2) = $1 FOR UPDATE`, [clave])).rows[0];
  if (!fila) return { servidor, estado: 'no_esta', anterior: null, motivo: null };
  const anterior = fila['c7'] == null ? '' : String(fila['c7']).trim();
  if (anterior.replace(/\D/g, '') === telefono) return { servidor, estado: 'ya_estaba', anterior, motivo: null };
  await c.query(`UPDATE md.kdud SET c7 = $2 WHERE btrim(c2) = $1`, [clave, telefono]);
  await c.query(
    `INSERT INTO md.kdlogmov (c1, c2, c3, c4, c5, c6, c7, c8, c9)
     VALUES ($1, (now() AT TIME ZONE 'America/Mexico_City')::date, to_char(now() AT TIME ZONE 'America/Mexico_City', 'HH24:MI:SS'),
             $1, '7', $2, $3, 'kdud', $4)`,
    [CAPTURISTA_SUITE, telefono, anterior, `'${clave}'`]);
  return { servidor, estado: 'escrita', anterior, motivo: null };
}

@Injectable()
export class KeplerTelefonoClienteAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerTelefonoClienteAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /** En un método y no en el constructor: un parámetro sin token tumba el arranque de Nest (#414). */
  protected get env(): Env { return process.env; }

  protected poolDe(url: string): Pool {
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

  /** Las conexiones que faltan, sin conectarse. Vacío = las 10 configuradas. */
  faltantes(): string[] {
    return SERVIDORES_TELEFONO.map((s) => urlDeServidorTelefono(s, this.env)).filter((u) => !u.ok).map((u) => (u as { motivo: string }).motivo);
  }

  /** El único paso que confirma. Aparte para que un ensayo corra el SQL real y termine en ROLLBACK. */
  protected async confirmar(c: PoolClient): Promise<void> {
    await c.query('COMMIT');
  }

  /** Escribe el teléfono en las bases donde está la clave. Si alguna de las 10 no contesta, no escribe en ninguna. */
  async escribir(clave: string, telefono: string): Promise<ResultadoServidorTelefono[]> {
    const faltan = this.faltantes();
    if (faltan.length) throw new Error(faltan.join(' · '));
    const urls = SERVIDORES_TELEFONO.map((s) => ({ servidor: s, url: (urlDeServidorTelefono(s, this.env) as { valor: string }).valor }));
    // 1. ¿Contestan las 10? (sólo lectura)
    for (const { servidor, url } of urls) {
      let c: PoolClient | null = null;
      try {
        c = await this.poolDe(url).connect();
        await c.query('SELECT 1 FROM md.kdud LIMIT 1');
      } catch (err) {
        throw new Error(`Kepler ${servidor} no contestó: ${(err as Error).message}. No se escribió en ninguna sucursal.`);
      } finally {
        c?.release();
      }
    }
    // 2. Escribir, base por base
    const out: ResultadoServidorTelefono[] = [];
    for (const { servidor, url } of urls) {
      let c: PoolClient | null = null;
      try {
        c = await this.poolDe(url).connect();
        await c.query('BEGIN');
        await c.query(`SET LOCAL lock_timeout = '5s'`);
        const r = await escribirTelefonoEnBase(c, servidor, clave, telefono);
        if (r.estado === 'escrita') await this.confirmar(c);
        else await c.query('ROLLBACK');
        out.push(r);
      } catch (err) {
        await c?.query('ROLLBACK').catch(() => undefined);
        const motivo = (err as Error).message;
        this.logger.error(`[CXC.48] teléfono de ${clave} rechazado por Kepler ${servidor}: ${motivo}`);
        out.push({ servidor, estado: 'rechazada', anterior: null, motivo });
      } finally {
        c?.release();
      }
    }
    this.logger.log(`[CXC.48] teléfono de ${clave}: ${out.map((r) => `${r.servidor}=${r.estado}`).join(' ')}`);
    return out;
  }
}
