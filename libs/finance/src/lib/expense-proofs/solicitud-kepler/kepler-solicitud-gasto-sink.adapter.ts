import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import {
  contadorAtrasado, leerContador, llaveDelContador, normalizarSucursal, reservarFolioKepler, urlDeServidor, valorDeEnv, type Env,
  type FolioReservado, type Resolucion,
} from '@megadulces/platform-core';

import { armarSolicitudKepler, COLUMNAS_QUE_VARIAN, CONSTANTES_DE_LA_PLANTILLA, type DatosSolicitudKepler, type PlanSolicitudKepler } from './solicitud-kepler.armador';
import { clonarFila } from '../../shared/kepler-filas';

/**
 * `[PGP.122.11]` C2 — **Escribe en Kepler la solicitud de gasto que nació en la Suite** (X-A-15-1), al
 * firmarla y ya autorizada (DS2). Plan: `FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md` §5.
 *
 * Modelo: ADR-092 (la requisición) y `[PGP.106]` (el pago): se CLONA una solicitud que el ERP ya aceptó
 * (la plantilla del servidor) y se pisan sólo las 23 columnas que varían (`solicitud-kepler.armador.ts`).
 * Una solicitud sólo vive en `kdm1` + `kdm6`: no hace póliza, `kdxe` ni acumulados (0 de 11,444 CxP son
 * X-A-15; 0 renglones de póliza). Lo que Kepler además toca al CREARLA se cierra con la captura de prueba
 * (anexo §8, S.1): hasta entonces la lista es una hipótesis y la escritura sigue apagada.
 *
 * ── El folio, sin chocar con quien captura en Kepler ─────────────────────────────────────────
 * Del CONTADOR de Kepler (`md.sqliov`, `KFXA1501.NN`), no de `MAX+1` a secas: `reservarFolioKepler` toma
 * el candado de su fila, decide `greatest(c4, MAX+1)` y lo avanza, en la misma transacción. Se toma AL
 * FINAL, cuando todo lo demás ya está armado, para retener el candado milisegundos.
 *
 * ── Cinco candados, y los cinco tienen que estar abiertos ────────────────────────────────────
 *   1. `KEPLER_GASTO_SOLICITUD=encendida` (apagado por default)  2. `KEPLER_PUSH_URL_NN`
 *   3. `KEPLER_SOLGASTO_TEMPLATE_FOLIO_NN` (SIN default en ningún servidor)
 *   4. el renglón `solicitud_gasto` de `commercial.kepler_push_switch` (lo lee el servicio, con su tope)
 *   5. los `GRANT` en Kepler (`ops/prod/kepler-grants/pgp122_solicitud_gasto.sql`).
 *
 * ⛔ **No es idempotente por sí solo.** Quien llama reclama el vale ANTES (reclamo atómico) y, antes de
 * escribir y antes de reintentar, este adaptador busca en el Kepler vivo la MARCA de la Suite (`c26`): si
 * ya está, devuelve ese folio y no escribe otra (lección de KR: la misma requisición salió 4 veces).
 *
 * Nunca lanza: la firma ya está guardada en la Suite y lo que pase en Kepler se devuelve para guardarlo.
 */

export function escrituraDeSolicitudEncendida(env: Env): boolean {
  return valorDeEnv(env, 'KEPLER_GASTO_SOLICITUD') === 'encendida';
}

/** La solicitud plantilla del servidor: `KEPLER_SOLGASTO_TEMPLATE_FOLIO_<NN>`, 7 dígitos. Sin default. */
export function plantillaSolicitudDe(sucursal: string, env: Env): Resolucion<string> {
  const n = normalizarSucursal(sucursal);
  if (!n.ok) return n;
  const folio = valorDeEnv(env, `KEPLER_SOLGASTO_TEMPLATE_FOLIO_${n.valor}`);
  if (!/^\d{7}$/.test(folio)) {
    return { ok: false, motivo: `Falta KEPLER_SOLGASTO_TEMPLATE_FOLIO_${n.valor}: no hay solicitud plantilla elegida en el servidor ${n.valor}` };
  }
  return { ok: true, valor: folio };
}

export interface EntregaSolicitudKepler extends DatosSolicitudKepler {
  /** Tope diario del interruptor (`kepler_push_switch.tope_dia`); `null` = sin tope. */
  tope_dia: number | null;
}

/** Lo que `confirmar` pasa de las temporales a Kepler. */
export interface EscrituraSolicitudKepler {
  sucursal: string;
  folio: string;
  marca: string;
  plantilla: string;
  plan: PlanSolicitudKepler;
  contador: FolioReservado;
  /** Lo marca `confirmar` justo antes del COMMIT: un error después de esto deja la escritura EN DUDA. */
  commitEnviado?: boolean;
}

export type ResultadoEscrituraSolicitud =
  /** La Suite la escribió. */
  | { estado: 'escrito'; sucursal: string; folio: string; total: number; contador: { llave: string; antes: string; nuevo: string; atrasado: boolean } }
  /** Kepler ya la tenía (por su marca): no se escribió otra. */
  | { estado: 'ya_estaba'; sucursal: string; folio: string; kepler: string }
  /** No se intentó: un candado está cerrado. El vale sigue esperando; no cuenta como intento. */
  | { estado: 'apagado'; motivo: string }
  /**
   * No se escribió. `reintentable` = vale la pena volver a intentar sin que nadie cambie nada; `porTope` = se
   * alcanzó el tope del día en ese servidor (se reintenta mañana, sin gastar intentos).
   */
  | { estado: 'rechazado'; motivo: string; reintentable: boolean; porTope?: boolean }
  /** El COMMIT salió y la respuesta no volvió: no se sabe. NO se reintenta sin preguntar por la marca. */
  | { estado: 'en_duda'; motivo: string };

export type MarcaEnKepler = { ok: true; encontrada: { folio: string; kepler: string; total: string } | null } | { ok: false; motivo: string };

/**
 * `[PGP.122]` R1 — La compuerta del contador (§5.6): el `c4` de `KFXA1501.NN` tiene que apuntar al siguiente folio
 * libre. `atrasado` = `c4 ≤ MAX(c6)` (o un `c4` que no es número): la próxima solicitud capturada A MANO en Kepler
 * pediría un folio que ya existe.
 */
export type ContadorEnKepler = { ok: true; atrasado: boolean; contador: string; maximo: number } | { ok: false; motivo: string };

/**
 * Errores que se arreglan solos esperando: conexión, candado ocupado, folio ganado por otro, tiempo agotado, y
 * el abrazo mortal o la serialización con quien captura en Kepler en el mismo instante (`40P01`, `40001`).
 */
export function esReintentable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (['55P03', '23505', '57014', '57P01', '57P03', '40P01', '40001', '08000', '08003', '08006', '08001', '08004'].includes(String(e?.code ?? ''))) return true;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE'].includes(String(e?.code ?? ''))) return true;
  return /Connection terminated|timeout exceeded when trying to connect|connect ETIMEDOUT/i.test(String(e?.message ?? ''));
}

const LLAVE_XA15 = `c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1`;

/** Lo «vacío» de una columna de Kepler: texto en blanco, número en cero, fecha centinela (≤ 1900 o 2000-01-01). */
function sqlVacio(col: { n: string; t: string }): string {
  return /char|text/.test(col.t) ? `btrim(${col.n}) = ''`
    : /timestamp|date/.test(col.t) ? `(${col.n}::date <= '1900-01-01' OR ${col.n}::date = '2000-01-01')` : `${col.n} = 0`;
}

/**
 * Las columnas de la plantilla que NO se pisan, NO son de las 8 constantes y NO están vacías («col = valor»).
 * En las 5,224 solicitudes medidas esas 169 columnas van vacías (anexo §5.2.1): una plantilla que trae algo ahí
 * lo copiaría a cada solicitud, así que el escritor no escribe con ella (fail-closed) y la revisión lo da por falla.
 */
export async function columnasRarasDePlantilla(c: PoolClient, tabla = '_h0'): Promise<string[]> {
  const cols = (await c.query(
    `SELECT a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [tabla])).rows as { n: string; t: string }[];
  const varian = new Set<string>(COLUMNAS_QUE_VARIAN);
  const raras = cols.filter((x) => !varian.has(x.n) && !(x.n in CONSTANTES_DE_LA_PLANTILLA));
  if (!raras.length) return [];
  const v = (await c.query(`SELECT ${raras.map((x) => `CASE WHEN ${sqlVacio(x)} THEN NULL ELSE ${x.n}::text END AS ${x.n}`).join(', ')} FROM ${tabla}`)).rows[0] as Record<string, string | null>;
  return raras.filter((x) => v?.[x.n] != null).map((x) => `${x.n}=«${v[x.n]}»`);
}

@Injectable()
export class KeplerSolicitudGastoSinkAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerSolicitudGastoSinkAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /** Las variables de entorno, en un getter y no en el constructor (#414). El ensayo y la prueba lo reemplazan. */
  protected get env(): Env { return process.env; }

  private poolDe(url: string): Pool {
    let p = this.pools.get(url);
    if (!p) {
      // Cada servidor de sucursal está en otra red (WAN/VPN). `statement_timeout` corta en el servidor; del lado de
      // la Suite, `query_timeout` no deja una promesa colgada, `keepAlive` detecta la conexión muerta y
      // `idle_in_transaction_session_timeout` hace que Kepler suelte el candado del contador si la red se cae a
      // media transacción (sin esto, el contador quedaba tomado ~2 h y cada captura en Kepler esperaba).
      p = new Pool({
        connectionString: url, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 30000, query_timeout: 45000,
        idle_in_transaction_session_timeout: 15000, keepAlive: true,
      });
      this.pools.set(url, p);
    }
    return p;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
  }

  /** ¿El candado 1 está abierto? Sin esto quien llama ni lo intenta: apagada no es un resultado. */
  encendida(): boolean { return escrituraDeSolicitudEncendida(this.env); }

  /**
   * El único paso que ESCRIBE en el ERP. Aparte para que el ensayo
   * (`kepler-solicitud-gasto-sink.ensayo.spec.ts`, `ops/prod/ensayo-solicitud-gasto/ensayo.ts`) corra
   * todo el SQL real y termine en ROLLBACK aquí.
   */
  protected async confirmar(c: PoolClient, w: EscrituraSolicitudKepler): Promise<void> {
    const h = await c.query('INSERT INTO md.kdm1 SELECT * FROM _h');
    if (h.rowCount !== 1) throw new Error(`La cabecera pasó ${h.rowCount} filas a Kepler: se esperaba una`);
    const l = await c.query('INSERT INTO md.kdm6 SELECT * FROM _l');
    if (l.rowCount !== w.plan.kdm6.length) throw new Error(`Los renglones pasaron ${l.rowCount} filas: se esperaban ${w.plan.kdm6.length}`);
    w.commitEnviado = true;
    await c.query('COMMIT');
  }

  /**
   * Costura para las pruebas (como `confirmar` para el ensayo): corre justo ANTES de tomar el candado del contador.
   * Aquí una prueba mete a «otro escritor» (la misma marca, o una solicitud más del día) para comprobar que la marca
   * y el tope se vuelven a revisar DENTRO del candado. En producción no hace nada.
   */
  protected async antesDelCandado(_e: EntregaSolicitudKepler): Promise<void> {
    return undefined;
  }

  /**
   * **¿Kepler ya tiene la solicitud con esta marca?** Sólo lectura, en el Kepler vivo. La usa el
   * escritor antes de escribir y el servicio antes de reintentar una que quedó EN DUDA. Si no se puede
   * preguntar, `ok: false`: quien llama NO reintenta.
   */
  async buscarPorMarca(sucursal: string, marca: string): Promise<MarcaEnKepler> {
    const srv = urlDeServidor(sucursal, this.env);
    if (!srv.ok) return { ok: false, motivo: srv.motivo };
    let c: PoolClient | null = null;
    try {
      c = await this.poolDe(srv.valor).connect();
      return { ok: true, encontrada: await this.porMarca(c, sucursal, marca) };
    } catch (err) {
      return { ok: false, motivo: `No se pudo preguntar a Kepler ${sucursal} por la marca ${marca}: ${(err as Error).message}` };
    } finally {
      c?.release();
    }
  }

  /**
   * `[PGP.122]` R1 — **¿El contador de folios de la solicitud de gasto está atrasado?** Sólo lectura, en el Kepler
   * vivo (`sqliov` no viaja al ODS), sin candado: `c4` y `MAX(c6)` salen de UNA sentencia, así que son la misma foto.
   * Si no se puede preguntar, `ok: false`: quien llama lo dice, no lo da por bueno.
   */
  async revisarContador(sucursal: string): Promise<ContadorEnKepler> {
    const srv = urlDeServidor(sucursal, this.env);
    if (!srv.ok) return { ok: false, motivo: srv.motivo };
    const llave = llaveDelContador({ sucursal, grupo: 'X', naturaleza: 'A', tipo: 15, serie: 1 });
    if (!llave.ok) return { ok: false, motivo: llave.motivo };
    let c: PoolClient | null = null;
    try {
      c = await this.poolDe(srv.valor).connect();
      const r = await c.query(
        `SELECT (SELECT c4::text FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0) AS c4,
                (SELECT count(*)::int FROM md.sqliov WHERE c1 = $1 AND c2 = 0 AND c3 = 0) AS filas,
                (SELECT coalesce(max(c6::int), 0)::int FROM md.kdm1 WHERE c1 = $2 AND ${LLAVE_XA15} AND c6 ~ '^[0-9]+$') AS m`,
        [llave.valor, sucursal]);
      const f = r.rows[0] as { c4: string | null; filas: number; m: number };
      if (Number(f.filas) !== 1) return { ok: false, motivo: `Kepler ${sucursal} tiene ${f.filas} filas del contador ${llave.valor} en sqliov: se esperaba una` };
      const contador = String(f.c4 ?? '').trim();
      const maximo = Number(f.m ?? 0);
      return { ok: true, atrasado: contadorAtrasado(leerContador(contador), maximo), contador, maximo };
    } catch (err) {
      return { ok: false, motivo: `No se pudo leer el contador ${llave.valor} de Kepler ${sucursal}: ${(err as Error).message}` };
    } finally {
      c?.release();
    }
  }

  /**
   * Por la marca (`c26`) y la llave X-A-15-1 de la sucursal, SIN exigir `c67 = 'SUITE'`: Kepler reescribe `c67` con
   * su usuario al CANCELAR, y una solicitud cancelada en Kepler sigue siendo la que la Suite ya escribió (si no se
   * reconociera, se volvería a escribir el gasto que Finanzas canceló). `kepler` trae su estado (`A`, `F`, `C`).
   */
  private async porMarca(c: PoolClient, sucursal: string, marca: string): Promise<{ folio: string; kepler: string; total: string } | null> {
    const r = await c.query(
      `SELECT btrim(c6) AS folio, btrim(c43) AS kepler, c16::text AS total FROM md.kdm1
        WHERE c1 = $1 AND ${LLAVE_XA15} AND btrim(c26) = $2 ORDER BY c6`, [sucursal, marca]);
    if (r.rowCount && r.rowCount > 1) throw new Error(`La marca ${marca} aparece ${r.rowCount} veces en Kepler ${sucursal}: no se escribe otra`);
    return r.rows[0] ?? null;
  }

  async entregar(e: EntregaSolicitudKepler): Promise<ResultadoEscrituraSolicitud> {
    if (!escrituraDeSolicitudEncendida(this.env)) return { estado: 'apagado', motivo: 'La escritura de solicitudes de gasto a Kepler está apagada (KEPLER_GASTO_SOLICITUD)' };
    const srv = urlDeServidor(e.sucursal, this.env);
    if (!srv.ok) return { estado: 'apagado', motivo: srv.motivo };
    const pl = plantillaSolicitudDe(e.sucursal, this.env);
    if (!pl.ok) return { estado: 'apagado', motivo: pl.motivo };
    const armado = armarSolicitudKepler(e);
    if (!armado.ok) return { estado: 'rechazado', motivo: armado.motivos.join(' · '), reintentable: false };
    const plan = armado.plan;

    let c: PoolClient;
    try {
      c = await this.poolDe(srv.valor).connect();
    } catch (err) {
      return { estado: 'rechazado', motivo: `Kepler ${e.sucursal} no responde: ${(err as Error).message}`, reintentable: true };
    }
    const w: EscrituraSolicitudKepler | { commitEnviado?: boolean } = {};
    try {
      // ── Antes de nada: ¿ya está? (la marca vuelve idempotente el reintento) ────────────────────
      const ya = await this.porMarca(c, e.sucursal, e.marca);
      if (ya) return { estado: 'ya_estaba', sucursal: e.sucursal, folio: ya.folio, kepler: ya.kepler };

      // ── El tope diario del interruptor, contado en Kepler (atajo; el conteo que manda va dentro del candado) ──
      if (e.tope_dia != null) {
        const hoy = Number((await c.query(
          `SELECT count(*)::int AS n FROM md.kdm1 WHERE c1 = $1 AND ${LLAVE_XA15} AND btrim(c26) LIKE 'SUITE SG-%' AND c68::date = $2::date`,
          [e.sucursal, e.capturadaEn.fecha])).rows[0].n);
        if (hoy >= e.tope_dia) return { estado: 'rechazado', motivo: `Tope diario del servidor ${e.sucursal} alcanzado: ${hoy} de ${e.tope_dia} solicitudes hoy`, reintentable: true, porTope: true };
      }

      // ── El acreedor y los catálogos de ESTE servidor (cada sucursal tiene los suyos) ──────────
      const acreedor = await c.query(`SELECT 1 FROM md.kdxd WHERE btrim(c2) = $1 LIMIT 1`, [plan.kdm1.c10]);
      if (!acreedor.rowCount) return { estado: 'rechazado', motivo: `Kepler (${e.sucursal}) no tiene al acreedor ${plan.kdm1.c10} en su catálogo (kdxd)`, reintentable: false };
      const faltan = await this.faltanEnCatalogos(c, plan);
      if (faltan.length) return { estado: 'rechazado', motivo: `Kepler (${e.sucursal}): ${faltan.join(' · ')}`, reintentable: false };

      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      // ── La plantilla: una solicitud real del servidor, con las 8 constantes medidas ───────────
      const base = await c.query(`CREATE TEMP TABLE _h0 ON COMMIT DROP AS SELECT * FROM md.kdm1 WHERE c1 = $1 AND ${LLAVE_XA15} AND c6 = $2`, [e.sucursal, pl.valor]);
      // Una plantilla ausente o rara no es culpa de ESTA solicitud: el servidor no escribe con ella y la solicitud
      // ESPERA (`apagado`: no gasta intentos y se escribe sola cuando Sistemas elija otra plantilla).
      if (base.rowCount !== 1) {
        await c.query('ROLLBACK');
        this.logger.error(`Kepler ${e.sucursal}: no existe la solicitud plantilla X-A-15 ${pl.valor}; no se escribe en ese servidor hasta elegir otra`);
        return { estado: 'apagado', motivo: `No existe la solicitud plantilla X-A-15 ${e.sucursal}/${pl.valor} en Kepler: ese servidor no escribe solicitudes hasta que Sistemas elija otra; ésta espera` };
      }
      const distinta = await this.plantillaDistinta(c);
      if (distinta) {
        await c.query('ROLLBACK');
        this.logger.error(`Kepler ${e.sucursal}: la plantilla ${pl.valor} no es como las solicitudes medidas (${distinta}); no se escribe en ese servidor hasta elegir otra`);
        return { estado: 'apagado', motivo: `La plantilla ${e.sucursal}/${pl.valor} no es como las solicitudes medidas (${distinta}): ese servidor no escribe solicitudes hasta que Sistemas elija otra; ésta espera` };
      }

      await c.query('CREATE TEMP TABLE _h (LIKE md.kdm1) ON COMMIT DROP');
      await c.query('CREATE TEMP TABLE _l (LIKE md.kdm6) ON COMMIT DROP');
      await clonarFila(c, '_h0', '_h', plan.kdm1);
      // RFC y nombre: del catálogo de ESTE servidor, en SQL (no se re-codifica un nombre de 200 a 60).
      const d = await c.query(
        `UPDATE _h SET c22 = left(coalesce(btrim(d.c10), ''), 40), c32 = left(coalesce(btrim(d.c3), ''), 60)
           FROM (SELECT c10, c3 FROM md.kdxd WHERE btrim(c2) = $1 ORDER BY c1 LIMIT 1) d`, [plan.kdm1.c10]);
      if (d.rowCount !== 1) throw new Error(`El acreedor ${plan.kdm1.c10} no se pudo copiar del catálogo (${d.rowCount} filas)`);

      // Renglones: la cuenta (c8) y el texto (c9) del concepto en kdco de ESTE servidor (99.5 % es así).
      // ⚠️ VALUES y no INSERT … SELECT: en un SELECT los parámetros nacen `text` y no toman el tipo de la
      // columna destino (c4/c5/c7/c11 son numeric). Que el concepto exista y tenga cuenta ya lo revisó
      // `faltanEnCatalogos`; si aun así faltara, el NOT NULL de la temporal lo rebota.
      for (const r of plan.kdm6) {
        await c.query(
          `INSERT INTO _l (c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14, c15, c16, c17, c18)
           VALUES ($1, $2, $3, $4, $5, '0000000', $6,
                   (SELECT left(btrim(k.c3), 20) FROM md.kdco k WHERE btrim(k.c1) = $9 AND btrim(k.c3) <> '' ORDER BY k.c1 LIMIT 1),
                   (SELECT left(btrim(k.c2), 30) FROM md.kdco k WHERE btrim(k.c1) = $9 AND btrim(k.c3) <> '' ORDER BY k.c1 LIMIT 1),
                   $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [r.c1, r.c2, r.c3, r.c4, r.c5, r.c7, r.c10, r.c11, r.c12, r.c13, r.c14, r.c15, r.c16, r.c17, r.c18]);
      }

      // ── El folio, AL FINAL: candado del contador, greatest(c4, MAX+1), contador avanzado ──────
      await this.antesDelCandado(e);
      const f = await reservarFolioKepler(c, { sucursal: e.sucursal, grupo: 'X', naturaleza: 'A', tipo: 15, serie: 1 });
      if (!f.ok) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: f.motivo, reintentable: false };
      }
      const folio = f.valor.folio;
      // ── Con el candado del contador tomado, todos los escritores de este servidor van en fila: aquí se
      // vuelve a preguntar por la MARCA (otro escritor —uno que se colgó más de 10 min y regresó, o el cron—
      // pudo escribirla mientras tanto; en READ COMMITTED su COMMIT ya se ve) y se cuenta el TOPE sin carrera.
      const yaDentro = await this.porMarca(c, e.sucursal, e.marca);
      if (yaDentro) {
        await c.query('ROLLBACK');
        return { estado: 'ya_estaba', sucursal: e.sucursal, folio: yaDentro.folio, kepler: yaDentro.kepler };
      }
      if (e.tope_dia != null) {
        const hechas = Number((await c.query(
          `SELECT count(*)::int AS n FROM md.kdm1 WHERE c1 = $1 AND ${LLAVE_XA15} AND btrim(c26) LIKE 'SUITE SG-%' AND c68::date = $2::date`,
          [e.sucursal, e.capturadaEn.fecha])).rows[0].n);
        if (hechas >= e.tope_dia) {
          await c.query('ROLLBACK');
          return { estado: 'rechazado', motivo: `Tope diario del servidor ${e.sucursal} alcanzado: ${hechas} de ${e.tope_dia} solicitudes hoy`, reintentable: true, porTope: true };
        }
      }
      const ocupado = await c.query(`SELECT 1 FROM md.kdm1 WHERE c1 = $1 AND ${LLAVE_XA15} AND c6 = $2`, [e.sucursal, folio]);
      if (ocupado.rowCount) throw Object.assign(new Error(`El folio ${folio} ya existe en Kepler ${e.sucursal}`), { code: '23505' });
      await c.query('UPDATE _h SET c6 = $1', [folio]);
      await c.query('UPDATE _l SET c6 = $1', [folio]);

      Object.assign(w, { sucursal: e.sucursal, folio, marca: e.marca, plantilla: pl.valor, plan, contador: f.valor });
      await this.confirmar(c, w as EscrituraSolicitudKepler);
      this.logger.log(`Solicitud ${e.marca} → Kepler ${e.sucursal}/X-A-15/${folio} (${plan.kdm6.length} renglones, $${plan.total.toFixed(2)}; contador ${f.valor.llave} ${f.valor.contadorAntes} → ${f.valor.contadorNuevo}${f.valor.contadorAtrasado ? ', VENÍA ATRASADO' : ''})`);
      return {
        estado: 'escrito', sucursal: e.sucursal, folio, total: plan.total,
        contador: { llave: f.valor.llave, antes: f.valor.contadorAntes, nuevo: f.valor.contadorNuevo, atrasado: f.valor.contadorAtrasado },
      };
    } catch (err) {
      const motivo = (err as Error).message;
      if (w.commitEnviado) {
        this.logger.error(`Solicitud ${e.marca}: el COMMIT salió hacia Kepler ${e.sucursal} y no hubo respuesta (${motivo}). EN DUDA: se pregunta por la marca antes de reintentar`);
        return { estado: 'en_duda', motivo };
      }
      await c.query('ROLLBACK').catch(() => undefined);
      const reintentable = esReintentable(err);
      this.logger.error(`Solicitud ${e.marca} rechazada por Kepler ${e.sucursal}${reintentable ? ' (se reintenta)' : ''}: ${motivo}`);
      return { estado: 'rechazado', motivo, reintentable };
    } finally {
      c.release();
    }
  }

  /** Conceptos, proyectos y departamentos que NO existen en el catálogo de ese servidor. */
  private async faltanEnCatalogos(c: PoolClient, plan: PlanSolicitudKepler): Promise<string[]> {
    const uno = (k: string) => [...new Set(plan.kdm6.map((r) => String(r[k])))];
    const no: string[] = [];
    for (const [col, tabla, que] of [['c12', 'kdco', 'concepto'], ['c13', 'kdcp', 'proyecto'], ['c16', 'kdc3', 'departamento']] as const) {
      const pedidos = uno(col);
      // El concepto además tiene que traer su cuenta (113 de 3,112 entradas de kdco no la tienen).
      const conCuenta = tabla === 'kdco' ? ` AND btrim(c3) <> ''` : '';
      const hay = new Set((await c.query(`SELECT DISTINCT btrim(c1) AS c1 FROM md.${tabla} WHERE btrim(c1) = ANY($1::text[])${conCuenta}`, [pedidos])).rows.map((x) => x.c1 as string));
      for (const p of pedidos) if (!hay.has(p)) no.push(`el ${que} ${p} no está en su catálogo (${tabla})${tabla === 'kdco' ? ' o no tiene cuenta' : ''}`);
    }
    return no;
  }

  /**
   * `null` si la plantilla trae las 8 constantes de una solicitud, está en A o F y las otras 169 columnas que se
   * copian van vacías (como en las 5,224 medidas, anexo §5.2.1); si no, qué difiere. Fail-closed.
   */
  private async plantillaDistinta(c: PoolClient): Promise<string | null> {
    const cols = Object.keys(CONSTANTES_DE_LA_PLANTILLA);
    const r = (await c.query(`SELECT ${cols.map((k) => `btrim(${k}::text) AS ${k}`).join(', ')}, btrim(c43) AS c43 FROM _h0`)).rows[0] as Record<string, string>;
    const no = cols.filter((k) => String(r[k]) !== String(CONSTANTES_DE_LA_PLANTILLA[k])).map((k) => `${k}=${r[k]}`);
    if (!['A', 'F'].includes(r.c43)) no.push(`c43=${r.c43}`);
    no.push(...(await columnasRarasDePlantilla(c, '_h0')));
    return no.length ? no.join(', ') : null;
  }
}
