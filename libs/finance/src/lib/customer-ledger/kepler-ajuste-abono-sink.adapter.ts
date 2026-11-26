import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { reservarFolioKepler, urlDeServidor, type Env } from '@megadulces/platform-core';

import { clonarFila } from '../shared/kepler-filas';
import {
  SERIE_AJUSTE, TIPO_AJUSTE, armarAjusteAbono,
  type FacturaConResto, type PlanAjuste,
} from './ajuste-abono.armador';

/** Una factura del cliente a cerrar. El saldo NO viene de afuera: se relee de Kepler. */
export interface FacturaDelAjuste { tipo: number; serie: number; folio: string }

export interface EntregaAjusteAbono {
  sucursal: string;
  /** `kdud.c2`. */
  cliente: string;
  /** La llave de idempotencia de la Suite → `kdm1.c11` (`varchar(20)`). */
  referencia: string;
  facturas: FacturaDelAjuste[];
  /** El techo por factura. Por omisión, D-R1 ($10). */
  tope?: number;
}

export interface KeplerAjusteEscrito {
  sucursal: string; folio: string; facturas: number; total: number;
  /** El saldo de cada factura DENTRO de la transacción, después de aplicar. Para un resto completo: 0.00. */
  saldos: { factura: string; antes: number; despues: number }[];
}

export type ResultadoAjusteAbonoKepler =
  | { estado: 'escrito'; ya_estaba?: boolean; kepler: KeplerAjusteEscrito }
  | { estado: 'apagado'; motivo: string }
  | { estado: 'rechazado'; motivo: string; reintentable: boolean };

/** Lo que el paso que ESCRIBE recibe, ya armado. */
export interface EscrituraAjusteAbono {
  sucursal: string;
  folio: string;
  plan: PlanAjuste;
  facturas: FacturaConResto[];
}

/** `[GP.R.3]` El interruptor de proceso: apagado salvo que diga exactamente `encendida`. */
export function escrituraDeAjusteAbonoEncendida(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env['KEPLER_AJUSTE_ABONO_ESCRITURA'] ?? '').trim() === 'encendida';
}

/**
 * ⭐ **El saldo de una factura de cartera se DERIVA: Kepler no lo guarda** (`kdue.c17` = importe en 632 de 632
 * facturas medidas). Es `importe menos la suma de kdm5` — la misma fórmula del ensayo del 2026-11-24, con la que la
 * factura `8-1-0000470` pasó de $7.20 a $0.00.
 */
const SALDO_SQL = `
  SELECT round(k.c16::numeric, 2) AS importe,
         round(k.c16::numeric - coalesce((SELECT sum(m.c12::numeric) FROM md.kdm5 m
            WHERE m.c1 = k.c1 AND m.c8 = 'D' AND m.c9 = k.c4 AND m.c10 = k.c5 AND btrim(m.c11) = btrim(k.c6)), 0), 2) AS saldo
    FROM md.kdm1 k
   WHERE k.c1 = $1 AND k.c2 = 'U' AND k.c3 = 'D' AND k.c4 = $2::numeric AND k.c5 = $3::numeric AND btrim(k.c6) = $4`;

/** Los ajustes que la Suite ya escribió con una referencia (idempotencia). */
const YA_ESCRITO_SQL = `
  SELECT btrim(c6) AS folio FROM md.kdm1
   WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND btrim(c11) = $3 AND btrim(c67) = 'SUITE'
     AND btrim(coalesce(c43, '')) <> 'C'
   ORDER BY c6`;

/** La plantilla: el `U-A-30` vivo más reciente de ese servidor. */
const PLANTILLA_SQL = `
  SELECT btrim(c6) AS folio FROM md.kdm1
   WHERE c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(coalesce(c43,'')) <> 'C'
   ORDER BY c9 DESC LIMIT 1`;

/** Un error de infraestructura se puede reintentar; un rechazo de negocio, no. */
const REINTENTABLE = /folio|timeout|connection|ECONN|terminating|deadlock|socket/i;

/**
 * `[GP.R.3]` C2 — **Escribe en Kepler el Ajuste Abono `U-A-30`** que cierra los restos de centavos de un cliente
 * (el armador, C1: `ajuste-abono.armador.ts`; el plan: anexo RC de la fase GP).
 *
 * Reemplaza al «Cobro» de centavos que Crédito y cobranza usa hoy —74 en 60 días—, que afirma que entró dinero y no
 * entró. Las escrituras, todas en UNA transacción, son **tres** (medidas escribiendo, ensayo del 2026-11-24):
 *   `kdm1` (el encabezado, clonado de un `U-A-30` que Kepler ya aceptó) · `kdue` (UN renglón de abono) ·
 *   `kdm5` por factura (una aplicación, por su resto exacto).
 * ⛔ `kdm2` **no**: el ajuste no tiene renglones de producto. ⛔ La póliza **tampoco**: sep-2026 tiene 0 renglones
 * `U-A-30`, con control (`U-A-5`: 4,188 · `U-A-21`: 698) — por eso D-R2 sigue abierta.
 *
 * ── Cuatro candados ──────────────────────────────────────────────────────────────────────────────────────────
 *  1. `KEPLER_AJUSTE_ABONO_ESCRITURA=encendida` (nace apagada).
 *  2. `KEPLER_PUSH_URL_<NN>` — la conexión de esa sucursal, que sólo existe en `md`.
 *  3. El `GRANT SELECT, INSERT ON md.kdue` de `ops/prod/kepler-grants/gpr0c_ajuste_abono.sql` (aplicado en 8 de 9;
 *     CEDIS sin línea de `pg_hba` para `sa`).
 *  4. Una **plantilla** viva: un `U-A-30` no cancelado en ESE servidor. Sin plantilla **no se inventa un documento**
 *     (las ~200 columnas de `kdm1` son `NOT NULL`: ADR-092).
 * El interruptor por sucursal y el registro los lleva el servicio (`ajuste-abono.service.ts`), que es quien habla
 * con la base de la Suite; aquí sólo se habla con Kepler.
 *
 * **Es idempotente por referencia**: antes de escribir pregunta si la Suite ya escribió un ajuste con esa
 * referencia en ese servidor, y si sí, no escribe otro.
 *
 * ⛔⛔ **Lo que esto NO hace, y se DECLARA: no emite CFDI.** Los restos que cierra son de facturas de crédito, que se
 * emiten **PPD** (la serie lo dice: `NNUD0801` → PPD · `NNUD0501` → PUE), así que la factura queda saldada en Kepler
 * y **sigue debiendo sus centavos ante el SAT**. Medido el 2026-11-25 sobre los 9,889 complementos de 2026, con
 * control aritmético (0 de 15,160 renglones sin cuadrar): **1,782 facturas ya están así, $729.78**. Cerrarlo de
 * verdad es la nota de crédito `U-A-21`, que **timbra**, y el timbre lo pone Kepler, no la Suite (D-F10).
 *
 * ⬜ **NO MEDIDO:** qué mueve el PROGRAMA de Kepler al postear un ajuste (acumulados). Las cinco tablas tienen
 * **cero disparadores**, así que no se ve en un ensayo: se mira sobre un ajuste real capturado por una persona.
 */
@Injectable()
export class KeplerAjusteAbonoSinkAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerAjusteAbonoSinkAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /** Las variables de entorno en un método, no en el constructor (el caso de #414). El ensayo lo reemplaza. */
  protected get env(): Env { return process.env; }
  /** `YYYY-MM-DD` en México: el ajuste se fecha HOY, nunca se antedata a un mes cerrado. */
  protected get hoy(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  }
  /** `HH:MM` en México, como lo guarda `kdm1.c69` (medido en los ajustes vivos: `13:01`, `12:48`). */
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

  /** El saldo vivo de una factura, derivado. `null` = Kepler no la tiene. */
  private async saldoDe(c: PoolClient, sucursal: string, f: FacturaDelAjuste): Promise<{ importe: number; saldo: number } | null> {
    const r = await c.query(SALDO_SQL, [sucursal, f.tipo, f.serie, f.folio]);
    if (r.rowCount !== 1) return null;
    return { importe: Number(r.rows[0].importe), saldo: Number(r.rows[0].saldo) };
  }

  /**
   * El único paso que ESCRIBE. Aparte para que el ensayo corra todo el SQL real y termine en ROLLBACK aquí.
   * ⭐ Antes de confirmar comprueba el EFECTO: el resto se cierra completo, así que cada factura tiene que quedar
   * en cero. Es el mismo control con el que el ensayo vio bajar `8-1-0000470` de $7.20 a $0.00.
   */
  protected async confirmar(c: PoolClient, w: EscrituraAjusteAbono): Promise<KeplerAjusteEscrito['saldos']> {
    for (const t of ['kdm1', 'kdue', 'kdm5'] as const) {
      const r = await c.query(`INSERT INTO md.${t} SELECT * FROM _${t}`);
      if (!r.rowCount) throw new Error(`El INSERT en md.${t} no tocó ninguna fila`);
    }

    const saldos: KeplerAjusteEscrito['saldos'] = [];
    for (const f of w.facturas) {
      const id = `${f.tipo}-${f.serie}-${f.folio}`;
      const s = await this.saldoDe(c, w.sucursal, f);
      if (!s) throw new Error(`La factura ${id} dejó de existir en Kepler a mitad del ajuste`);
      if (Math.abs(s.saldo) > 0.005) {
        throw new Error(`La factura ${id} quedó debiendo ${s.saldo.toFixed(2)} y el ajuste cerraba su resto completo: algo más se movió`);
      }
      saldos.push({ factura: id, antes: f.saldo, despues: s.saldo });
    }

    await c.query('COMMIT');
    return saldos;
  }

  async entregar(e: EntregaAjusteAbono): Promise<ResultadoAjusteAbonoKepler> {
    if (!escrituraDeAjusteAbonoEncendida(this.env)) {
      return { estado: 'apagado', motivo: 'La escritura de ajustes a Kepler está apagada (KEPLER_AJUSTE_ABONO_ESCRITURA)' };
    }
    const srv = urlDeServidor(e.sucursal, this.env);
    if (!srv.ok) return { estado: 'apagado', motivo: srv.motivo };

    const c = await this.poolDe(srv.valor).connect();
    try {
      const previos = await this.ajustesConReferencia(c, e.sucursal, e.referencia);
      if (previos.length) {
        return {
          estado: 'escrito', ya_estaba: true,
          kepler: { sucursal: e.sucursal, folio: previos[0], facturas: e.facturas.length, total: 0, saldos: [] },
        };
      }

      // ── Lo vivo: el saldo de HOY de cada factura, derivado de Kepler (nunca del ODS, nunca de la pantalla) ──
      const facturas: FacturaConResto[] = [];
      for (const f of e.facturas) {
        const s = await this.saldoDe(c, e.sucursal, f);
        if (!s) {
          return { estado: 'rechazado', motivo: `Kepler (${e.sucursal}) no tiene la factura ${f.tipo}-${f.serie}-${f.folio}`, reintentable: false };
        }
        facturas.push({ tipo: f.tipo, serie: f.serie, folio: f.folio, importe: s.importe, saldo: s.saldo });
      }

      const armado = armarAjusteAbono({
        sucursal: e.sucursal, cliente: e.cliente, referencia: e.referencia, facturas,
        fecha: this.hoy, hora: this.ahora, tope: e.tope,
      });
      if (!armado.ok) return { estado: 'rechazado', motivo: armado.motivo, reintentable: false };
      const plan = armado.valor;

      await c.query('BEGIN');
      const base = (await c.query(PLANTILLA_SQL, [e.sucursal, TIPO_AJUSTE, SERIE_AJUSTE])).rows[0];
      if (!base) {
        await c.query('ROLLBACK');
        return {
          estado: 'rechazado', reintentable: false,
          motivo: `Kepler (${e.sucursal}) no tiene ningún Ajuste Abono U-A-${TIPO_AJUSTE} vivo que clonar: sin plantilla no se inventa un documento`,
        };
      }

      // ⛔ `clonarFila` INSERTA y después pisa, así que clonar directo a `md.kdm1` choca con `pk_kdm1` (el folio de
      //    la plantilla entraría tal cual). Se arma en temporales sin llave y se vuelca al final — patrón de la casa
      //    (`kepler-nota-sink.adapter.ts`), y la razón por la que el primer ensayo murió.
      const plantilla = async (t: string, filtro: string, params: unknown[]): Promise<number> => {
        await c.query(`CREATE TEMP TABLE _${t}0 ON COMMIT DROP AS SELECT * FROM md.${t} WHERE ${filtro}`, params);
        await c.query(`CREATE TEMP TABLE _${t} ON COMMIT DROP AS SELECT * FROM md.${t} WHERE false`);
        return Number((await c.query(`SELECT count(*)::int AS n FROM _${t}0`)).rows[0].n);
      };
      const llave = [e.sucursal, TIPO_AJUSTE, SERIE_AJUSTE, base.folio];
      const nH = await plantilla('kdm1', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4`, llave);
      const nE = await plantilla('kdue', `c1 = $1 AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4`, llave);
      const nM = await plantilla('kdm5', `c1 = $1 AND c2 = 'U' AND c3 = 'A' AND c4 = $2::numeric AND c5 = $3::numeric AND btrim(c6) = $4 LIMIT 1`, llave);
      if (nH !== 1 || nE !== 1 || nM !== 1) {
        await c.query('ROLLBACK');
        return {
          estado: 'rechazado', reintentable: false,
          motivo: `La plantilla U-A-${TIPO_AJUSTE} ${e.sucursal}/${base.folio} está incompleta (kdm1 ${nH} · kdue ${nE} · kdm5 ${nM}): no se inventan sus columnas`,
        };
      }

      // ── El folio, con el candado real del contador de Kepler (`KFUA3001.<sucursal>`) ─────────────────────────
      const reserva = await reservarFolioKepler(c, {
        sucursal: e.sucursal, grupo: 'U', naturaleza: 'A', tipo: TIPO_AJUSTE, serie: SERIE_AJUSTE,
      });
      if (!reserva.ok) {
        await c.query('ROLLBACK');
        return { estado: 'rechazado', motivo: `Folio Kepler U-A-${TIPO_AJUSTE} (${e.sucursal}): ${reserva.motivo}`, reintentable: true };
      }
      const { folio, llave: contador, contadorAntes, contadorNuevo } = reserva.valor;

      await clonarFila(c, '_kdm10', '_kdm1', { ...plan.kdm1, c6: folio });
      await clonarFila(c, '_kdue0', '_kdue', { ...plan.kdue, c6: folio });
      for (const r of plan.kdm5) await clonarFila(c, '_kdm50', '_kdm5', { ...r, c6: folio });

      const saldos = await this.confirmar(c, { sucursal: e.sucursal, folio, plan, facturas });
      const paso = saldos.map((s) => `${s.factura} ${s.antes.toFixed(2)}→${s.despues.toFixed(2)}`).join(', ');
      this.logger.log(
        `Ajuste Abono ${e.referencia} → Kepler ${e.sucursal}/U-A-${TIPO_AJUSTE}/${folio}: ${plan.facturas} factura(s) por ${plan.total.toFixed(2)} ` +
        `(contador ${contador} ${contadorAntes} → ${contadorNuevo}; ${paso}). Sin CFDI: el insoluto ante el SAT no se cierra con esto (D-F10).`,
      );
      return { estado: 'escrito', kepler: { sucursal: e.sucursal, folio, facturas: plan.facturas, total: plan.total, saldos } };
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      const motivo = (err as Error).message;
      this.logger.error(`Ajuste Abono ${e.referencia} rechazado por Kepler: ${motivo}`);
      return { estado: 'rechazado', motivo, reintentable: REINTENTABLE.test(motivo) };
    } finally {
      c.release();
    }
  }

  /** Los `U-A-30` que la Suite ya escribió con esta referencia en ese servidor. */
  private async ajustesConReferencia(c: PoolClient, sucursal: string, referencia: string): Promise<string[]> {
    const r = await c.query(YA_ESCRITO_SQL, [sucursal, TIPO_AJUSTE, referencia]);
    return r.rows.map((x: { folio: string }) => x.folio);
  }
}
