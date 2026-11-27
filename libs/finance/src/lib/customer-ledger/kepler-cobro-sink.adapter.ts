import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { reservarFolioKepler, urlDeServidor, type Env } from '@megadulces/platform-core';

import { clonarFila } from '../shared/kepler-filas';
import {
  CUENTA_CLIENTES, POLIZA_INGRESOS, SERIE_COBRO, TIPO_COBRO,
  armarCobro, type FacturaDelCobro, type PlanCobro,
} from './cobro.armador';

/**
 * `[CC.33]` **Escribe un COBRO `U-A-7` en el Kepler de la sucursal, desde la pantalla.**
 *
 * Es la versión de producto del guion `ops/prod/ensayo-cobro-kepler/insertar-cobro.ts`, que el 2026-11-27 escribió
 * el cobro `06/U-A-7/0000900` de verdad: la factura `8-1-0001446` pasó de $15,539.63 a cero y el cliente bajó
 * exactamente ese importe. Aquí vive lo mismo, con interruptor, idempotencia y verificación del efecto.
 *
 * ── ⛔⛔ Lo que NO hace, y hay que decirlo en cada pantalla que lo use ───────────────────────────────────────────
 * **NO TIMBRA.** El complemento de pago lo emite el programa `FE4Cobro` de Kepler llamando al PAC (`SMARTERWEB`)
 * con el CSD; escribir las tablas **no lo dispara** (`CC.26`, medido). El cobro nace **sin complemento**, igual que
 * los 6 que el propio Kepler dejó así en Canindo el 22 y 23 de septiembre (`CC.32`). Mientras no se cierre el
 * timbre por el camino de Kepler, **queda una obligación fiscal abierta** — por eso el resultado la DECLARA en vez
 * de devolver un «listo» que no es cierto.
 *
 * ── Lo que escribe, medido sobre cobros reales ─────────────────────────────────────────────────────────────────
 * | `kdm1` | el documento `U-A-7-01-<folio>` |
 * | `kdue` | UN renglón de abono en la cartera |
 * | `kdm5` | una aplicación por factura |
 * | `kdc2AAMM` | ⭐ la póliza: cargo a `102`, abono a `115`, tipo `I` — el Ajuste Abono no tiene |
 */

/** Lo que la pantalla pide escribir. Los saldos NO vienen de ella: se releen de Kepler. */
export interface EntregaCobro {
  sucursal: string;
  cliente: string;
  /** La llave de idempotencia de la Suite (`kdm1.c11`, `varchar(20)`). */
  referencia: string;
  /** ⭐ La fecha del DEPÓSITO (`YYYY-MM-DD`). */
  fecha: string;
  facturas: { tipo: number; serie: number; folio: string; monto: number }[];
}

export interface KeplerCobroEscrito {
  sucursal: string;
  folio: string;
  caja: string;
  poliza: number;
  tablaPoliza: string;
  facturas: number;
  total: number;
  /** El saldo de cada factura ANTES y DESPUÉS, dentro de la transacción. */
  saldos: { factura: string; antes: number; aplicado: number; despues: number }[];
  /** ⛔ Siempre `false` al escribir: el timbre es un acto del programa de Kepler. */
  timbrado: false;
}

export type ResultadoCobroKepler =
  | { estado: 'escrito'; ya_estaba?: boolean; kepler: KeplerCobroEscrito }
  | { estado: 'apagado'; motivo: string }
  | { estado: 'rechazado'; motivo: string; reintentable: boolean };

/** `[CC.33]` El interruptor de proceso: apagado salvo que diga exactamente `encendida`. */
export function escrituraDeCobroEncendida(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env['KEPLER_COBRO_ESCRITURA'] ?? '').trim() === 'encendida';
}

/**
 * ⭐ El saldo de una factura se DERIVA: Kepler no lo guarda. Es el importe menos la suma de sus aplicaciones.
 * Misma fórmula que el Ajuste Abono y que el guion con el que se escribió `0000900`.
 */
const SALDO_SQL = `
  SELECT round(k.c16::numeric, 2) AS importe,
         round(k.c16::numeric - coalesce((SELECT sum(m.c12::numeric) FROM md.kdm5 m
            WHERE m.c1 = k.c1 AND m.c8 = 'D' AND m.c9 = k.c4 AND m.c10 = k.c5 AND btrim(m.c11) = btrim(k.c6)), 0), 2) AS saldo
    FROM md.kdm1 k
   WHERE k.c1 = $1 AND k.c2 = 'U' AND k.c3 = 'D' AND k.c4 = $2::numeric AND k.c5 = $3::numeric AND btrim(k.c6) = $4`;

/**
 * ⛔⛔ La plantilla es el cobro ANTERIOR DEL MISMO CLIENTE, y de ahí sale la caja (`kdm1.c12`), que **no se
 * adivina**: es un código por sucursal. Si el cliente no tiene uno, este adaptador se niega.
 */
const PLANTILLA_SQL = `
  SELECT btrim(c6) AS folio, btrim(coalesce(c12, '')) AS caja FROM md.kdm1
   WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric
     AND btrim(c10) = $4 AND btrim(coalesce(c43, '')) <> 'C'
   ORDER BY c9 DESC LIMIT 1`;

const YA_ESCRITO_SQL = `
  SELECT btrim(c6) AS folio FROM md.kdm1
   WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND btrim(c11) = $3`;

const NOMBRE_SQL = `SELECT btrim(coalesce(c3, '')) AS nombre, btrim(coalesce(c10, '')) AS rfc FROM md.kdud WHERE btrim(c2) = $1 LIMIT 1`;

/**
 * `[CC.35]` La ficha de CFDI anterior **del mismo cliente**, que es la plantilla de la quinta tabla.
 *
 * ⛔⛔ Del mismo cliente y de nadie más: ahí viven su RFC, su nombre y su régimen fiscal, y **esos datos no
 * se inventan ni se traen de otro**. Se llega a ella por el cobro al que pertenece (`c13` = folio del cobro),
 * porque `kdfe33m1` no guarda la clave del cliente.
 */
const FICHA_PREVIA_SQL = `
  SELECT btrim(f.c13) AS folio, btrim(coalesce(f.c34, '')) AS rfc
    FROM md.kdfe33m1 f
    JOIN md.kdm1 k ON k.c1 = f.c1 AND k.c2 = 'U' AND k.c3 = 'A' AND k.c4 = 7
                  AND btrim(k.c6) = btrim(f.c13)
   WHERE f.c1 = $1 AND btrim(f.c9) = 'U' AND btrim(f.c10) = 'A' AND btrim(f.c11::text) = '7'
     AND btrim(k.c10) = $2
   ORDER BY f.c7 DESC LIMIT 1`;

/** Un fallo de red o de candado se puede reintentar; uno de reglas, no. */
const REINTENTABLE = /timeout|ECONNRESET|ECONNREFUSED|terminating connection|deadlock|could not obtain lock/i;

@Injectable()
export class KeplerCobroSinkAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerCobroSinkAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /** Las variables de entorno en un método, no en el constructor (el caso de #414). */
  protected get env(): Env { return process.env; }
  /** `HH:MM` en México, como lo guarda `kdm1.c69`. */
  protected get ahora(): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
  }

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

  private async saldoDe(c: PoolClient, sucursal: string, f: { tipo: number; serie: number; folio: string }) {
    const r = await c.query(SALDO_SQL, [sucursal, f.tipo, f.serie, f.folio]);
    if (r.rowCount !== 1) return null;
    return { importe: Number(r.rows[0].importe), saldo: Number(r.rows[0].saldo) };
  }

  /**
   * El único paso que ESCRIBE. Aparte, para que un ensayo corra todo el SQL real y termine en ROLLBACK aquí.
   * ⭐ Antes de confirmar comprueba **dos** efectos: que cada factura bajó **exactamente lo aplicado** (no que
   * quedó en cero: un cobro puede ser parcial) y que **la póliza cuadra**.
   */
  protected async confirmar(
    c: PoolClient, sucursal: string, folio: string, poliza: number, plan: PlanCobro, facturas: FacturaDelCobro[],
  ): Promise<KeplerCobroEscrito['saldos']> {
    const tablas = ['kdm1', 'kdue', 'kdm5', plan.tablaPoliza, ...(plan.cfdi ? ['kdfe33m1'] : [])];
    for (const t of tablas) {
      const r = await c.query(`INSERT INTO md.${t} SELECT * FROM _${t}`);
      if (!r.rowCount) throw new Error(`El INSERT en md.${t} no tocó ninguna fila`);
    }

    // ⛔⛔ El control que impide falsificar: la ficha que acabamos de escribir NO puede traer folio fiscal
    //    ni sellos. Si trae alguno, es que la plantilla los filtró y la transacción se cae aquí.
    if (plan.cfdi) {
      const f = (await c.query(
        `SELECT btrim(coalesce(c54, '')) AS uuid, btrim(coalesce(c46, '')) AS sello, btrim(coalesce(c15, '')) AS version
           FROM md.kdfe33m1 WHERE c1 = $1 AND btrim(c13) = $2 AND btrim(c25) = 'P'`, [sucursal, folio])).rows[0];
      if (!f) throw new Error('La ficha de CFDI no quedó escrita');
      if (f.uuid || f.sello) throw new Error(`La ficha del cobro ${folio} salió con folio fiscal o sello: eso lo pone el PAC, no la Suite`);
      if (f.version !== '4.0') throw new Error(`La ficha del cobro ${folio} quedó con versión «${f.version}» y Kepler exige 4.0`);
    }

    const saldos: KeplerCobroEscrito['saldos'] = [];
    for (const f of facturas) {
      const id = `${f.tipo}-${f.serie}-${f.folio}`;
      const s = await this.saldoDe(c, sucursal, f);
      if (!s) throw new Error(`La factura ${id} dejó de existir en Kepler a mitad del cobro`);
      const esperado = Math.round((f.saldo - f.monto) * 100) / 100;
      if (Math.abs(s.saldo - esperado) > 0.005) {
        throw new Error(
          `La factura ${id} quedó debiendo ${s.saldo.toFixed(2)} y debía quedar en ${esperado.toFixed(2)}: algo más se movió`,
        );
      }
      saldos.push({ factura: id, antes: f.saldo, aplicado: f.monto, despues: s.saldo });
    }

    const cuadre = (await c.query(
      `SELECT round(sum(c5::numeric) FILTER (WHERE c4 = 'C'), 2) AS cargo,
              round(sum(c5::numeric) FILTER (WHERE c4 = 'A'), 2) AS abono
         FROM md.${plan.tablaPoliza} WHERE c1 = $1 AND c8 = $2 AND btrim(c19) = $3`,
      [poliza, POLIZA_INGRESOS, folio])).rows[0];
    if (String(cuadre?.cargo) !== String(cuadre?.abono)) {
      throw new Error(`La póliza no cuadra: cargo ${cuadre?.cargo} contra abono ${cuadre?.abono}`);
    }

    await this.cerrar(c);
    return saldos;
  }

  /**
   * El último acto. Aparte **para que un ensayo pueda correr TODO el SQL de producción y terminar en
   * `ROLLBACK` aquí**: así lo que se prueba contra el Kepler vivo es este código, no una copia suya.
   */
  protected async cerrar(c: PoolClient): Promise<void> {
    await c.query('COMMIT');
  }

  async entregar(e: EntregaCobro): Promise<ResultadoCobroKepler> {
    if (!escrituraDeCobroEncendida(this.env)) {
      return { estado: 'apagado', motivo: 'La escritura de cobros a Kepler está apagada (KEPLER_COBRO_ESCRITURA).' };
    }
    const srv = urlDeServidor(e.sucursal, this.env);
    if (!srv.ok) return { estado: 'apagado', motivo: srv.motivo };

    const c = await this.poolDe(srv.valor).connect();
    try {
      // ── Idempotencia: la misma referencia no entra dos veces ────────────────────────────────────────────────
      const previos = await c.query(YA_ESCRITO_SQL, [e.sucursal, TIPO_COBRO, e.referencia]);
      if (previos.rowCount) {
        return {
          estado: 'escrito', ya_estaba: true,
          kepler: {
            sucursal: e.sucursal, folio: String(previos.rows[0].folio), caja: '', poliza: 0, tablaPoliza: '',
            facturas: e.facturas.length, total: 0, saldos: [], timbrado: false,
          },
        };
      }

      // ── La plantilla y la caja: del cobro anterior del mismo cliente ────────────────────────────────────────
      const pl = await c.query(PLANTILLA_SQL, [e.sucursal, TIPO_COBRO, SERIE_COBRO, e.cliente]);
      if (pl.rowCount !== 1) {
        return {
          estado: 'rechazado', reintentable: false,
          motivo: `El cliente ${e.cliente} no tiene un cobro anterior en ${e.sucursal}: sin él no se sabe por qué caja entra y no se inventa.`,
        };
      }
      const base = String(pl.rows[0].folio);
      const caja = String(pl.rows[0].caja);

      // ── Lo vivo: el saldo de HOY de cada factura, derivado de Kepler ────────────────────────────────────────
      const facturas: FacturaDelCobro[] = [];
      for (const f of e.facturas) {
        const s = await this.saldoDe(c, e.sucursal, f);
        if (!s) {
          return { estado: 'rechazado', reintentable: false, motivo: `Kepler (${e.sucursal}) no tiene la factura ${f.tipo}-${f.serie}-${f.folio}.` };
        }
        facturas.push({ tipo: f.tipo, serie: f.serie, folio: f.folio, monto: f.monto, saldo: s.saldo });
      }
      const kdud = (await c.query(NOMBRE_SQL, [e.cliente])).rows[0] ?? {};
      const nombre = String(kdud.nombre ?? '');

      // ── `[CC.35]` La quinta tabla: ¿hay una ficha de CFDI previa de ESTE cliente para clonar? ───────────
      const previa = (await c.query(FICHA_PREVIA_SQL, [e.sucursal, e.cliente])).rows[0];
      // ⛔ Y su RFC tiene que seguir siendo el del cliente HOY: una ficha vieja timbraría datos rancios.
      const rfcHoy = String(kdud.rfc ?? '').toUpperCase();
      const rfcFicha = String(previa?.rfc ?? '').toUpperCase();
      const fichaUsable = !!previa && !!rfcHoy && rfcFicha === rfcHoy;
      if (previa && !fichaUsable) {
        this.logger.warn(
          `Cobro ${e.referencia}: la ficha de CFDI previa del cliente ${e.cliente} trae RFC ${rfcFicha || '(vacío)'} ` +
          `y hoy es ${rfcHoy || '(vacío)'}: no se clona, el cobro nace sin ficha.`,
        );
      }

      const armado = armarCobro({
        sucursal: e.sucursal, cliente: e.cliente, nombre, referencia: e.referencia,
        fecha: e.fecha, hora: this.ahora, caja, facturas, hayFichaPrevia: fichaUsable,
      });
      if (!armado.ok) return { estado: 'rechazado', motivo: armado.motivo, reintentable: false };
      const plan = armado.valor;
      if (!/^kdc2[0-9]{4}$/.test(plan.tablaPoliza)) {
        return { estado: 'rechazado', motivo: `Tabla de pólizas inválida: ${plan.tablaPoliza}`, reintentable: false };
      }

      await c.query('BEGIN');

      // ⛔ `clonarFila` INSERTA y después pisa: clonar directo a `md.kdm1` chocaría con su llave. Se arma en
      //    temporales sin llave y se vuelca al final — patrón de la casa.
      const plantilla = async (t: string, filtro: string, params: unknown[]): Promise<number> => {
        await c.query(`CREATE TEMP TABLE _${t}0 ON COMMIT DROP AS SELECT * FROM md.${t} WHERE ${filtro}`, params);
        await c.query(`CREATE TEMP TABLE _${t} ON COMMIT DROP AS SELECT * FROM md.${t} WHERE false`);
        return Number((await c.query(`SELECT count(*)::int AS n FROM _${t}0`)).rows[0].n);
      };
      const llave = [e.sucursal, TIPO_COBRO, SERIE_COBRO, base];
      const nH = await plantilla('kdm1', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4`, llave);
      const nE = await plantilla('kdue', `c1 = $1 AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4`, llave);
      const nM = await plantilla('kdm5', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4 LIMIT 1`, llave);
      const nP = await plantilla(plan.tablaPoliza,
        `btrim(c15) = 'U' AND btrim(c16) = 'A' AND btrim(c17::text) = $1 AND btrim(c19) = $2`, [String(TIPO_COBRO), base]);
      if (nH !== 1 || nE !== 1 || nM !== 1 || nP !== 2) {
        await c.query('ROLLBACK');
        return {
          estado: 'rechazado', reintentable: false,
          motivo: `La plantilla U-A-${TIPO_COBRO} ${e.sucursal}/${base} está incompleta (kdm1 ${nH} · kdue ${nE} · kdm5 ${nM} · póliza ${nP}): no se inventan sus columnas.`,
        };
      }

      const reserva = await reservarFolioKepler(c, {
        sucursal: e.sucursal, grupo: 'U', naturaleza: 'A', tipo: TIPO_COBRO, serie: SERIE_COBRO,
      });
      if (!reserva.ok) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `Folio Kepler U-A-${TIPO_COBRO} (${e.sucursal}): ${reserva.motivo}`, reintentable: true };
      }
      const { folio, llave: contador, contadorAntes, contadorNuevo } = reserva.valor;

      await clonarFila(c, '_kdm10', '_kdm1', { ...plan.kdm1, c6: folio });
      await clonarFila(c, '_kdue0', '_kdue', { ...plan.kdue, c6: folio });
      for (const r of plan.kdm5) await clonarFila(c, '_kdm50', '_kdm5', { ...r, c6: folio });

      // ── `[CC.35]` La quinta tabla: la ficha del CFDI, en el estado «creada, sin timbrar» ────────────────
      // ⛔⛔ El folio fiscal y los sellos quedan VACÍOS: los pone el PAC a través de Kepler. Escribirlos
      //    sería falsificar un comprobante. Esto sólo deja el documento como Kepler lo deja antes de llamar.
      if (plan.cfdi) {
        const nF = await plantilla('kdfe33m1',
          `c1 = $1 AND btrim(c9) = 'U' AND btrim(c10) = 'A' AND btrim(c11::text) = '7' AND btrim(c13) = $2`,
          [e.sucursal, String(previa.folio)]);
        if (nF !== 1) {
          await c.query('ROLLBACK');
          return {
            estado: 'rechazado', reintentable: false,
            motivo: `La ficha de CFDI plantilla ${e.sucursal}/${previa.folio} apareció ${nF} veces: no se clona a ciegas.`,
          };
        }
        const vacias = Object.fromEntries(plan.cfdi.vaciar.map((k) => [k, '']));
        await clonarFila(c, '_kdfe33m10', '_kdfe33m1', { ...plan.cfdi.campos, ...vacias, c3: folio, c13: folio });
      }

      // ── La póliza: el siguiente número de ingresos del mes, y los dos renglones que cuadran ─────────────────
      const poliza = Number((await c.query(
        `SELECT coalesce(max(c1), 0)::int AS m FROM md.${plan.tablaPoliza} WHERE c8 = $1`, [POLIZA_INGRESOS])).rows[0].m) + 1;
      for (const r of plan.poliza) {
        const ins = await c.query(
          `INSERT INTO _${plan.tablaPoliza} SELECT * FROM _${plan.tablaPoliza}0 WHERE btrim(c3) = $1 RETURNING ctid::text AS t`, [r.cuenta]);
        if (ins.rowCount !== 1) {
          await c.query('ROLLBACK');
          return { estado: 'rechazado', motivo: `La póliza plantilla no trae un renglón de la cuenta ${r.cuenta}.`, reintentable: false };
        }
        await c.query(
          `UPDATE _${plan.tablaPoliza}
              SET c1 = $2, c2 = $3::timestamp, c5 = $4, c6 = $5, c19 = $6,
                  c7 = CASE WHEN btrim(c3) = $7 THEN $6 ELSE c7 END
            WHERE ctid = $1::tid`,
          [ins.rows[0].t, poliza, e.fecha, r.campos['c5'], r.campos['c6'], folio, CUENTA_CLIENTES]);
      }

      const saldos = await this.confirmar(c, e.sucursal, folio, poliza, plan, facturas);
      const paso = saldos.map((s) => `${s.factura} ${s.antes.toFixed(2)}→${s.despues.toFixed(2)}`).join(', ');
      this.logger.log(
        `Cobro ${e.referencia} → Kepler ${e.sucursal}/U-A-${TIPO_COBRO}/${folio}: ${plan.facturas} factura(s) por ` +
        `${plan.total.toFixed(2)} (caja ${caja}, póliza ${POLIZA_INGRESOS} ${poliza} en ${plan.tablaPoliza}, ` +
        `contador ${contador} ${contadorAntes} → ${contadorNuevo}; ${paso}). ` +
        `⛔ SIN COMPLEMENTO: el timbre lo pone el programa de Kepler, no esto (CC.26).`,
      );
      return {
        estado: 'escrito',
        kepler: {
          sucursal: e.sucursal, folio, caja, poliza, tablaPoliza: plan.tablaPoliza,
          facturas: plan.facturas, total: plan.total, saldos, timbrado: false,
        },
      };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      const motivo = (err as Error).message;
      this.logger.error(`Cobro ${e.referencia} rechazado por Kepler: ${motivo}`);
      return { estado: 'rechazado', motivo, reintentable: REINTENTABLE.test(motivo) };
    } finally {
      c.release();
    }
  }
}
