import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { reservarFolioKepler, urlDeServidor, valorDeEnv, type Env, type FolioReservado } from '@megadulces/platform-core';

import { armarGastoKepler, polizaCuadra, type PlanGastoKepler } from '../../shared/gasto-kepler.armador';
import { columnaCargoKdxg, columnasKdc126, tablaPolizaDelMes } from '../../shared/kepler-contable';
import { clonarFila, insertarCompleta, insertarFila, sumarAcumuladoAcreedor, vacioDeTipo } from '../../shared/kepler-filas';

/**
 * `[PGP.123]` G.7 C2 — **Escribe en Kepler la comprobación del gasto (`X-A-10` «Alta gasto CFDI») de una solicitud
 * viva, con su póliza y sus acumulados.** Plan: `FASE_PGP_ANEXO_COMPROBACION_DE_GASTO.md` §3 y §5.3.
 *
 * Las 9 escrituras, en UNA transacción (§3): `kdm1` (el gasto, clon de su X-A-15) · `kdm6` (sus renglones, clon) ·
 * la X-A-15 a `F` con saldo 0 · el contador `KFXA1001.NN` · `kdxe` (la cuenta por pagar) · la póliza D en `kdc2AAMM` ·
 * `kdc126` (dos juegos, cuenta y mayor) · `kdcn26` (el ejercido por centro de costo) · `kdxg` (el cargo del acreedor).
 *
 * ── Qué se clona y qué no ─────────────────────────────────────────────────────────────────────────────────────────
 * `kdm1` y `kdm6` se CLONAN de la solicitud viva (la sombra G.2 los comparó columna por columna con los 1,922 gastos
 * reales). `kdxe`, la póliza y las celdas nuevas de `kdcn26` se insertan COMPLETAS: en los 1,922 gastos medidos, las
 * columnas que el armador no pone van vacías o en cero sin una excepción (13 de `kdxe`, 29 de la póliza), y clonar
 * una fila de otro gasto arrastraría lo suyo.
 *
 * ── Cinco candados, y los cinco tienen que estar abiertos ────────────────────────────────────────────────────────
 *   1. `KEPLER_GASTO_COMPROBACION=encendida` (apagado por default)  2. `KEPLER_PUSH_URL_NN`
 *   3. (DG7, retirado el 2026-11-20 por G.1: no hay contador escondido. Las 9 bases numeran la póliza D como MAX+1 de
 *      la tabla del mes; la «segunda secuencia» de 00/01/03/06/08 la hereda un X-D-55 que deja su póliza en el mes
 *      nuevo con el número del mes anterior, y desde ahí MAX+1 sigue esa serie. Anexo G §3.6 y §15.)
 *   4. el renglón `comprobacion_gasto` de `commercial.kepler_push_switch` (lo lee el servicio, con su tope)
 *   5. los `GRANT` en Kepler (`ops/prod/kepler-grants/pgp123_comprobacion_gasto.sql`). Sin ellos: `apagado`.
 *
 * ⛔ **Idempotente por la solicitud, no por una marca** (§3.1: el X-A-10 copia la marca de su solicitud). Antes de
 * escribir, y otra vez con el candado del contador tomado, se busca un X-A-10 vivo de esa solicitud (`c4 = 10`,
 * `c39`); si existe —de la Suite o capturado por una persona—, no se escribe otro.
 *
 * Nunca lanza: lo que pase en Kepler se devuelve para guardarlo en el vale.
 */

export function escrituraDeGastoEncendida(env: Env): boolean {
  return valorDeEnv(env, 'KEPLER_GASTO_COMPROBACION') === 'encendida';
}

export interface EntregaGastoKepler {
  sucursal: string;
  /** El folio de la X-A-15 (7 dígitos). */
  solicitud: string;
  /** `c9` del gasto, `YYYY-MM-DD` (DG1). */
  fecha: string;
  /** Cuándo lo escribe la Suite, hora de México. */
  capturadoEn: { fecha: string; hora: string };
  /** DG3: la forma de pago del vale ya en código de Kepler (`01`…`04`, `99`), si la solicitud no la trae. */
  formaPagoVale?: string | null;
  /** El vale de la Suite: sólo para la bitácora y el registro. */
  vale: string;
  /** Tope diario del interruptor (`kepler_push_switch.tope_dia`); `null` = sin tope. */
  tope_dia: number | null;
  /**
   * `[PGP.123]` G.16 — Sólo para la bitácora (el escritor no lo usa): la lectura del comprobante decía otro monto y una
   * persona dijo que lo comparó antes de generar el gasto (DG12).
   */
  lecturaComparada?: { por: string | null; monto: number | null };
  /**
   * Lo que aprobó la regla G.5, leído del ODS: el total, el acreedor (`c10`) y la fecha (`c9`) de la X-A-15. El escritor
   * lo compara con la X-A-15 VIVA que bloquea y NO escribe si cambió: armaba el gasto con lo vivo sin ver si era lo que
   * la regla aprobó (revisión independiente, 2026-11-17). Obligatorio: sin él no se escribe a ciegas.
   */
  esperado: { total: number; acreedor: string; fecha: string };
}

/** Lo que `confirmar` pasa de las temporales a Kepler. */
export interface EscrituraGastoKepler {
  sucursal: string;
  solicitud: string;
  folio: string;
  /** `kdc2AAMM` del mes del gasto (validada: `^kdc2\d{4}$`). */
  tablaPoliza: string;
  /** El número de la póliza D (`c1`): MAX+1 de la tabla del mes, como Kepler en las 9 bases (G.1). */
  poliza: number;
  plan: PlanGastoKepler;
  contador: FolioReservado;
  /** Lo marca `confirmar` justo antes del COMMIT: un error después de esto deja la escritura EN DUDA. */
  commitEnviado?: boolean;
}

export type ResultadoEscrituraGasto =
  /** La Suite lo escribió. */
  | { estado: 'escrito'; sucursal: string; folio: string; poliza: number; tablaPoliza: string; total: number;
    contador: { llave: string; antes: string; nuevo: string; atrasado: boolean } }
  /** Kepler ya tiene un X-A-10 vivo de esa solicitud (de la Suite o de una persona): no se escribió otro. */
  | { estado: 'ya_estaba'; sucursal: string; folio: string; kepler: string }
  /** No se intentó: un candado está cerrado. El vale sigue esperando; no cuenta como intento. */
  | { estado: 'apagado'; motivo: string }
  /** No se escribió. `reintentable` = vale la pena volver a intentar sin que nadie cambie nada. */
  | { estado: 'rechazado'; motivo: string; reintentable: boolean; porTope?: boolean }
  /** El COMMIT salió y la respuesta no volvió: no se sabe. NO se reintenta sin buscar el gasto. */
  | { estado: 'en_duda'; motivo: string };

export type GastoEnKepler = { ok: true; encontrado: { folio: string; kepler: string } | null } | { ok: false; motivo: string };

/** Errores que se arreglan solos esperando (los mismos del escritor de la solicitud). */
export function esReintentableGasto(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (['55P03', '23505', '57014', '57P01', '57P03', '40P01', '40001', '08000', '08003', '08006', '08001', '08004'].includes(String(e?.code ?? ''))) return true;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE'].includes(String(e?.code ?? ''))) return true;
  return /Connection terminated|timeout exceeded when trying to connect|connect ETIMEDOUT/i.test(String(e?.message ?? ''));
}

const LLAVE_XA15 = `c2 = 'X' AND c3 = 'A' AND c4 = 15 AND c5 = 1`;
const LLAVE_XA10 = `c2 = 'X' AND c3 = 'A' AND c4 = 10 AND c5 = 1`;
/** Un X-A-10 VIVO de la solicitud `$2` en la sucursal `$1` (§3.1: la idempotencia va por `c4 = 10` y `c39`). */
const GASTO_DE_LA_SOLICITUD = `SELECT lpad(btrim(c6), 7, '0') AS folio, btrim(c43) AS kepler FROM md.kdm1
  WHERE c1 = $1 AND ${LLAVE_XA10} AND btrim(c36) = 'A' AND c37 = 15 AND c38 = 1 AND btrim(c39) = $2 AND btrim(c43) <> 'C' ORDER BY c6`;
const TABLA_POLIZA = /^kdc2\d{4}$/;

/**
 * `[PGP.123]` ¿La X-A-15 VIVA es la que aprobó G.5 en el ODS? `null` = sí; si no, qué cambió, en llano. Total al
 * centavo, acreedor y fecha: lo que decide el monto, a quién se le debe y el mes de la póliza.
 */
export function cambioContraLoAprobado(
  viva: { total: string | number | null; acreedor: string | null; fecha: string | null },
  esperado: EntregaGastoKepler['esperado'],
): string | null {
  const cent = (x: unknown): number => Math.round(Number(x) * 100);
  const pesos = (x: unknown): string => `$${Number(x).toFixed(2)}`;
  const dif: string[] = [];
  if (viva.total == null || !Number.isFinite(Number(viva.total)) || cent(viva.total) !== cent(esperado.total)) {
    dif.push(`total: el ODS dice ${pesos(esperado.total)} y Kepler ${viva.total == null ? 'nada' : pesos(viva.total)}`);
  }
  if (String(viva.acreedor ?? '').trim() !== String(esperado.acreedor ?? '').trim()) dif.push(`acreedor: ${esperado.acreedor} → ${viva.acreedor ?? 'nada'}`);
  if (String(viva.fecha ?? '') !== String(esperado.fecha ?? '')) dif.push(`fecha: ${esperado.fecha} → ${viva.fecha ?? 'nada'}`);
  return dif.length ? dif.join(' · ') : null;
}
const COLUMNA = /^c\d{1,3}$/;

type Valor = string | number;

// `[PGP.172]` `vacioDeTipo` e `insertarCompleta` vivían acá y se movieron a `../../shared/kepler-filas`:
// las necesitan los tres escritores que tocan los acumulados, no sólo éste (ADR-056). Se re-exportan
// porque el ensayo y las pruebas de este adaptador las importan por su nombre de aquí.
export { insertarCompleta, vacioDeTipo };

@Injectable()
export class KeplerGastoSinkAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerGastoSinkAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /** Las variables de entorno, en un getter y no en el constructor (#414). El ensayo y la prueba lo reemplazan. */
  protected get env(): Env { return process.env; }

  private poolDe(url: string): Pool {
    let p = this.pools.get(url);
    if (!p) {
      // Mismos tiempos que el escritor de la solicitud: si la red se cae a media transacción, Kepler suelta el
      // candado del contador y de la X-A-15 en 15 s, no en 2 h.
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

  /** ¿El candado 1 está abierto? Sin esto quien llama ni lo intenta. */
  encendida(): boolean { return escrituraDeGastoEncendida(this.env); }

  /**
   * Costura para las pruebas: corre justo ANTES de tomar el candado del contador. Ahí una prueba mete a «otra
   * persona» que captura el gasto de la misma solicitud, para comprobar que se vuelve a buscar DENTRO del candado.
   */
  protected async antesDelCandado(_e: EntregaGastoKepler): Promise<void> {
    return undefined;
  }

  /**
   * El único paso que ESCRIBE en el ERP. Aparte para que el ensayo (`kepler-gasto-sink.ensayo.spec.ts`) corra todo
   * el SQL real y termine en ROLLBACK aquí, con la revisión (`kepler-gasto-sink.revision.ts`) en su lugar.
   */
  protected async confirmar(c: PoolClient, w: EscrituraGastoKepler): Promise<void> {
    if (!TABLA_POLIZA.test(w.tablaPoliza)) throw new Error(`Tabla de pólizas inválida: ${w.tablaPoliza}`);
    const n = w.plan.kdm6.length;
    const r = w.plan.poliza.renglones.length;
    const pasa = async (sql: string, esperadas: number, que: string) => {
      const x = await c.query(sql);
      if (x.rowCount !== esperadas) throw new Error(`${que} pasó ${x.rowCount} filas a Kepler: se esperaban ${esperadas}`);
    };
    await pasa('INSERT INTO md.kdm1 SELECT * FROM _h', 1, 'El gasto (kdm1)');
    await pasa('INSERT INTO md.kdm6 SELECT * FROM _l', n, 'Los renglones (kdm6)');
    await pasa('INSERT INTO md.kdxe SELECT * FROM _e', 1, 'La cuenta por pagar (kdxe)');
    await pasa(`INSERT INTO md.${w.tablaPoliza} SELECT * FROM _p`, r, `La póliza (${w.tablaPoliza})`);

    // La solicitud: aplicada, sin saldo. Exige que siga como se leyó (en A y con todo su saldo).
    const s = await c.query(
      `UPDATE md.kdm1 SET c42 = c42 - $3, c43 = 'F' WHERE c1 = $1 AND ${LLAVE_XA15} AND c6 = $2 AND btrim(c43) = 'A' AND c42 = $3`,
      [w.sucursal, w.solicitud, w.plan.total]);
    if (s.rowCount !== 1) throw new Error(`La solicitud ${w.solicitud} cambió en Kepler mientras se escribía su gasto (${s.rowCount} filas)`);

    // El número de la póliza se leyó como MAX+1: si otro documento lo tomó mientras tanto, no se escribe.
    const ajenas = (await c.query(
      `SELECT count(*)::int n FROM md.${w.tablaPoliza}
        WHERE c8 = 'D' AND c1 = $1 AND NOT (btrim(c15) = 'X' AND btrim(c16) = 'A' AND c17 = 10 AND btrim(c19) = $2)`,
      [w.poliza, w.folio])).rows[0].n;
    if (ajenas) throw Object.assign(new Error(`Otro documento tomó el número de póliza D ${w.poliza} en ${w.tablaPoliza}`), { code: '23505' });

    // Los acumulados: cada fila exactamente una vez (si Kepler la crearía, la Suite no lo hace: se rechazó antes).
    const a = w.plan.acumulados;
    const k = columnasKdc126(a.mes);
    for (const m of a.kdc126) {
      const x = await c.query(
        `UPDATE md.kdc126 SET ${k.cargo[0]} = ${k.cargo[0]} + $1, ${k.cargo[1]} = ${k.cargo[1]} + $1,
                              ${k.abono[0]} = ${k.abono[0]} + $2, ${k.abono[1]} = ${k.abono[1]} + $2
          WHERE btrim(c1) = $3`, [m.cargo, m.abono, m.cuenta]);
      if (x.rowCount !== 1) throw new Error(`La cuenta ${m.cuenta} (kdc126) trae ${x.rowCount} filas en ${w.sucursal}: se esperaba una`);
    }
    for (const m of a.kdcn26) {
      const x = await c.query(
        `UPDATE md.kdcn26 SET c7 = c7 + $1 WHERE btrim(c1) = $2 AND btrim(c2) = $3 AND btrim(c3) = $4 AND btrim(c4) = $5`,
        [m.importe, m.concepto, m.departamento, m.proyecto, m.periodo]);
      if (x.rowCount === 0) {
        await insertarCompleta(c, 'md.kdcn26', { c1: m.concepto, c2: m.departamento, c3: m.proyecto, c4: m.periodo, c5: '', c6: 0, c7: m.importe, c8: 0 });
      } else if (x.rowCount !== 1) {
        throw new Error(`La celda ${m.concepto}/${m.departamento}/${m.proyecto}/${m.periodo} (kdcn26) trae ${x.rowCount} filas en ${w.sucursal}`);
      }
    }
    // `[PGP.172]` El acumulado del acreedor NACE con este cargo si el acreedor nunca tuvo movimiento aquí:
    // `kdxg` es un acumulado, no un catálogo (ver `sumarAcumuladoAcreedor`). El gasto sube `c4` y `c6`.
    await sumarAcumuladoAcreedor(c, {
      sucursal: w.sucursal, acreedor: a.kdxg.acreedor, columna: columnaCargoKdxg(a.mes),
      importe: a.kdxg.cargo, fecha: a.kdxg.fecha, fechas: ['c4', 'c6'],
    });

    w.commitEnviado = true;
    await c.query('COMMIT');
  }

  /**
   * **¿Kepler ya tiene el gasto de esta solicitud?** Sólo lectura, en el Kepler vivo. La usa el servicio antes de
   * reintentar uno EN DUDA y el lazo para enterarse de lo que capturó una persona. Si no se puede preguntar,
   * `ok: false`: quien llama NO reintenta.
   */
  async buscarGasto(sucursal: string, solicitud: string): Promise<GastoEnKepler> {
    const srv = urlDeServidor(sucursal, this.env);
    if (!srv.ok) return { ok: false, motivo: srv.motivo };
    let c: PoolClient | null = null;
    try {
      c = await this.poolDe(srv.valor).connect();
      return { ok: true, encontrado: await this.gastoVivo(c, sucursal, solicitud) };
    } catch (err) {
      return { ok: false, motivo: `No se pudo preguntar a Kepler ${sucursal} por el gasto de la solicitud ${solicitud}: ${(err as Error).message}` };
    } finally {
      c?.release();
    }
  }

  private async gastoVivo(c: PoolClient, sucursal: string, solicitud: string): Promise<{ folio: string; kepler: string } | null> {
    const r = await c.query(GASTO_DE_LA_SOLICITUD, [sucursal, solicitud]);
    return r.rows[0] ?? null;
  }

  /** Cuántos gastos escribió la Suite hoy en ese servidor (`c67`), para el tope. Conservador (§3.1: marcas heredadas). */
  private async hechosHoy(c: PoolClient, e: EntregaGastoKepler): Promise<number> {
    return Number((await c.query(
      `SELECT count(*)::int AS n FROM md.kdm1 WHERE c1 = $1 AND ${LLAVE_XA10} AND btrim(c67) = 'SUITE' AND c68::date = $2::date`,
      [e.sucursal, e.capturadoEn.fecha])).rows[0].n);
  }

  async entregar(e: EntregaGastoKepler): Promise<ResultadoEscrituraGasto> {
    if (!escrituraDeGastoEncendida(this.env)) return { estado: 'apagado', motivo: 'La escritura de gastos a Kepler está apagada (KEPLER_GASTO_COMPROBACION)' };
    const srv = urlDeServidor(e.sucursal, this.env);
    if (!srv.ok) return { estado: 'apagado', motivo: srv.motivo };
    if (!/^\d{7}$/.test(e.solicitud)) return { estado: 'rechazado', motivo: `Folio de solicitud inválido «${e.solicitud}»`, reintentable: false };
    const esp = e.esperado;
    if (!esp || !Number.isFinite(Number(esp.total)) || !String(esp.acreedor ?? '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(esp.fecha ?? ''))) {
      return { estado: 'rechazado', motivo: 'Falta lo que aprobó la regla (total, acreedor y fecha de la solicitud): no se escribe a ciegas', reintentable: false };
    }
    const tablaPoliza = tablaPolizaDelMes(e.fecha);
    if (!tablaPoliza) return { estado: 'rechazado', motivo: `Fecha del gasto inválida «${e.fecha}»`, reintentable: false };

    let c: PoolClient;
    try {
      c = await this.poolDe(srv.valor).connect();
    } catch (err) {
      return { estado: 'rechazado', motivo: `Kepler ${e.sucursal} no responde: ${(err as Error).message}`, reintentable: true };
    }
    const w: EscrituraGastoKepler | { commitEnviado?: boolean } = {};
    try {
      // ── Antes de nada: ¿ya tiene su gasto? (la solicitud vuelve idempotente el reintento) ───────────────────────
      const ya = await this.gastoVivo(c, e.sucursal, e.solicitud);
      if (ya) return { estado: 'ya_estaba', sucursal: e.sucursal, folio: ya.folio, kepler: ya.kepler };
      if (e.tope_dia != null) {
        const hoy = await this.hechosHoy(c, e);
        if (hoy >= e.tope_dia) return { estado: 'rechazado', motivo: `Tope diario del servidor ${e.sucursal} alcanzado: ${hoy} de ${e.tope_dia} gastos hoy`, reintentable: true, porTope: true };
      }
      const existe = (await c.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`md.${tablaPoliza}`])).rows[0].ok;
      if (!existe) return { estado: 'rechazado', motivo: `Kepler (${e.sucursal}) no tiene la tabla de pólizas del mes (${tablaPoliza})`, reintentable: false };

      await c.query('BEGIN');
      await c.query(`SET LOCAL lock_timeout = '5s'`);
      // ── Lo vivo: la solicitud con su candado de fila, sus renglones, kdmm y kdc3 del servidor ─────────────────────
      const bloqueada = await c.query(`SELECT 1 FROM md.kdm1 WHERE c1 = $1 AND ${LLAVE_XA15} AND c6 = $2 FOR UPDATE`, [e.sucursal, e.solicitud]);
      if (bloqueada.rowCount !== 1) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `La solicitud ${e.sucursal}/X-A-15/${e.solicitud} no existe en Kepler`, reintentable: false };
      }
      await c.query(`CREATE TEMP TABLE _s0 ON COMMIT DROP AS SELECT * FROM md.kdm1 WHERE c1 = $1 AND ${LLAVE_XA15} AND c6 = $2`, [e.sucursal, e.solicitud]);
      // ⛔ La X-A-15 viva tiene que ser la que aprobó G.5: si el ODS iba atrasado o alguien la editó en Kepler, no se escribe.
      // Reintentable: la siguiente vuelta relee el ODS y la regla decide con lo nuevo.
      const viva = (await c.query(`SELECT round(c16::numeric, 2)::text AS total, btrim(c10) AS acreedor, to_char(c9, 'YYYY-MM-DD') AS fecha FROM _s0`)).rows[0];
      const cambio = cambioContraLoAprobado(viva ?? { total: null, acreedor: null, fecha: null }, esp);
      if (cambio) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `La solicitud cambió en Kepler desde que la Suite la revisó (${cambio}): se vuelve a revisar con lo nuevo`, reintentable: true };
      }
      await c.query(`CREATE TEMP TABLE _r0 ON COMMIT DROP AS SELECT * FROM md.kdm6 WHERE c1 = $1 AND ${LLAVE_XA15} AND c6 = $2`, [e.sucursal, e.solicitud]);
      const solicitud = (await c.query('SELECT to_jsonb(s) AS j FROM _s0 s')).rows[0].j as Record<string, string | number>;
      const renglones = (await c.query('SELECT to_jsonb(r) AS j FROM _r0 r ORDER BY r.c7')).rows.map((x) => x.j as Record<string, string | number>);
      const mm = (await c.query(
        `SELECT btrim(c18) c18, btrim(c20) c20, btrim(c21) c21, btrim(c22) c22 FROM md.kdmm WHERE btrim(c1) = 'X' AND btrim(c2) = 'A' AND c3 = 10 AND c4 = 1`)).rows;
      if (mm.length !== 1) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `Kepler (${e.sucursal}) trae ${mm.length} configuraciones del gasto X-A-10 en kdmm: se esperaba una`, reintentable: false };
      }
      const departamentos = new Set((await c.query('SELECT DISTINCT btrim(c1) AS c1 FROM md.kdc3')).rows.map((x) => x.c1 as string));

      const armado = armarGastoKepler({
        sucursal: e.sucursal, solicitud, renglones, fecha: e.fecha, capturadoEn: e.capturadoEn, formaPagoVale: e.formaPagoVale ?? null,
        config: { tipoPoliza: mm[0].c18, cuentaAcreedor: mm[0].c20, cuentaIva: mm[0].c21, cuentaRetencion: mm[0].c22 }, departamentos,
      });
      if (!armado.ok) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: armado.motivos.join(' · '), reintentable: false };
      }
      const plan = armado.plan;
      if (!polizaCuadra(plan.poliza, plan.total)) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `La póliza del gasto no cuadra contra su total (${plan.total.toFixed(2)})`, reintentable: false };
      }

      // ── Lo que Kepler CREARÍA si faltara, la Suite no lo crea: se rechaza y se captura a mano ─────────────────────
      const cuentas = [...new Set(plan.acumulados.kdc126.map((m) => m.cuenta))];
      const hay = (await c.query(`SELECT btrim(c1) AS c1, count(*)::int AS n FROM md.kdc126 WHERE btrim(c1) = ANY($1::text[]) GROUP BY 1`, [cuentas])).rows as { c1: string; n: number }[];
      const faltan = cuentas.filter((x) => !hay.some((h) => h.c1 === x && h.n === 1));
      if (faltan.length) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `Kepler (${e.sucursal}) no tiene exactamente una fila de ${faltan.join(', ')} en kdc126: Kepler la crearía; se captura a mano`, reintentable: false };
      }
      // `[PGP.172]` Acá se rechazaba el gasto cuando el acreedor no tenía todavía su fila de acumulado en
      // `kdxg`, con `reintentable: false` y «se captura a mano». Medido el 2026-11-27: eso era el 80.7 % de
      // los pares (sucursal, acreedor) del catálogo —en Zamora Centro, 724 de 747—, o sea el PRIMER gasto de
      // casi cualquier acreedor. Ahora la fila nace con el movimiento, igual que la crearía Kepler, y lo
      // hace `sumarAcumuladoAcreedor`. Lo único que sigue siendo motivo de rechazo es que haya MÁS de una
      // fila propia, que ya no se puede resolver adivinando: eso revienta ruidoso donde se escribe.

      // ── Las filas, en temporales: el gasto y sus renglones clonados de la solicitud; kdxe y la póliza, completas ──
      await c.query('CREATE TEMP TABLE _h (LIKE md.kdm1) ON COMMIT DROP');
      await c.query('CREATE TEMP TABLE _l (LIKE md.kdm6) ON COMMIT DROP');
      await c.query('CREATE TEMP TABLE _e (LIKE md.kdxe) ON COMMIT DROP');
      await c.query(`CREATE TEMP TABLE _p (LIKE md.${tablaPoliza}) ON COMMIT DROP`);
      await clonarFila(c, '_s0', '_h', plan.kdm1);
      const l = await c.query('INSERT INTO _l SELECT * FROM _r0');
      if (l.rowCount !== plan.kdm6.length) throw new Error(`La solicitud trae ${l.rowCount} renglones; el plan, ${plan.kdm6.length}`);
      await c.query('UPDATE _l SET c4 = 10');

      // ── El folio, AL FINAL: candado del contador, greatest(c4, MAX+1), contador avanzado ─────────────────────────
      await this.antesDelCandado(e);
      const f = await reservarFolioKepler(c, { sucursal: e.sucursal, grupo: 'X', naturaleza: 'A', tipo: 10, serie: 1 });
      if (!f.ok) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: f.motivo, reintentable: false };
      }
      const folio = f.valor.folio;
      // Con el candado tomado, quien captura el gasto en Kepler va en fila detrás: se vuelve a buscar el gasto de esta
      // solicitud (una persona pudo capturarlo entre la primera lectura y aquí) y se cuenta el tope sin carrera.
      const yaDentro = await this.gastoVivo(c, e.sucursal, e.solicitud);
      if (yaDentro) {
        await c.query('ROLLBACK');
        return { estado: 'ya_estaba', sucursal: e.sucursal, folio: yaDentro.folio, kepler: yaDentro.kepler };
      }
      if (e.tope_dia != null) {
        const hechos = await this.hechosHoy(c, e);
        if (hechos >= e.tope_dia) {
          await c.query('ROLLBACK');
          return { estado: 'rechazado', motivo: `Tope diario del servidor ${e.sucursal} alcanzado: ${hechos} de ${e.tope_dia} gastos hoy`, reintentable: true, porTope: true };
        }
      }
      const ocupado = await c.query(`SELECT 1 FROM md.kdm1 WHERE c1 = $1 AND ${LLAVE_XA10} AND c6 = $2`, [e.sucursal, folio]);
      if (ocupado.rowCount) throw Object.assign(new Error(`El folio ${folio} ya existe en Kepler ${e.sucursal}`), { code: '23505' });
      const poliza = Number((await c.query(`SELECT coalesce(max(c1), 0)::int AS m FROM md.${tablaPoliza} WHERE c8 = 'D'`)).rows[0].m) + 1;

      await c.query('UPDATE _h SET c6 = $1', [folio]);
      await c.query('UPDATE _l SET c6 = $1', [folio]);
      await insertarCompleta(c, '_e', { ...plan.kdxe, c6: folio });
      for (const r of plan.poliza.renglones) {
        await insertarCompleta(c, '_p', { ...r, c1: poliza, c2: plan.poliza.fecha, c8: plan.poliza.tipo, c15: 'X', c16: 'A', c17: 10, c18: 1, c19: folio });
      }

      Object.assign(w, { sucursal: e.sucursal, solicitud: e.solicitud, folio, tablaPoliza, poliza, plan, contador: f.valor });
      await this.confirmar(c, w as EscrituraGastoKepler);
      this.logger.log(`Gasto del vale ${e.vale} → Kepler ${e.sucursal}/X-A-10/${folio} de la solicitud ${e.solicitud} ($${plan.total.toFixed(2)}; póliza ${tablaPoliza} D ${poliza}; contador ${f.valor.llave} ${f.valor.contadorAntes} → ${f.valor.contadorNuevo}${f.valor.contadorAtrasado ? ', VENÍA ATRASADO' : ''})`);
      return {
        estado: 'escrito', sucursal: e.sucursal, folio, poliza, tablaPoliza, total: plan.total,
        contador: { llave: f.valor.llave, antes: f.valor.contadorAntes, nuevo: f.valor.contadorNuevo, atrasado: f.valor.contadorAtrasado },
      };
    } catch (err) {
      const motivo = (err as Error).message;
      if (w.commitEnviado) {
        this.logger.error(`Gasto del vale ${e.vale}: el COMMIT salió hacia Kepler ${e.sucursal} y no hubo respuesta (${motivo}). EN DUDA: se busca el gasto antes de reintentar`);
        return { estado: 'en_duda', motivo };
      }
      await c.query('ROLLBACK').catch(() => undefined);
      // Sin permiso no es culpa del vale: el servidor no está configurado (candado 5). Espera sin gastar intentos.
      if (String((err as { code?: string }).code ?? '') === '42501') {
        this.logger.error(`Kepler ${e.sucursal}: sin permiso para escribir el gasto (${motivo}); faltan los GRANT de pgp123_comprobacion_gasto.sql`);
        return { estado: 'apagado', motivo: `Kepler ${e.sucursal} no le da permiso a la Suite (${motivo}): Sistemas aplica ops/prod/kepler-grants/pgp123_comprobacion_gasto.sql` };
      }
      const reintentable = esReintentableGasto(err);
      this.logger.error(`Gasto del vale ${e.vale} rechazado por Kepler ${e.sucursal}${reintentable ? ' (se reintenta)' : ''}: ${motivo}`);
      return { estado: 'rechazado', motivo, reintentable };
    } finally {
      c.release();
    }
  }
}
