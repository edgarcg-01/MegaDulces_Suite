import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { urlDeServidor, type Env } from '@megadulces/platform-core';

import {
  decidirCancelacionOc, permisosNecesarios, sentenciasCancelacion, TABLAS_KEPLER,
  type OcEnKepler, type PlanCancelacion, type RequisicionEnKepler, type Sentencia, type Tablas,
} from './kepler-oc-cancelacion';
import {
  decidirCancelacionRequisicion, sentenciasCancelacionRequisicion,
  type PlanCancelacionRequisicion, type RequisicionACancelar,
} from './kepler-req-cancelacion';

/** `[PQ.110]` Pedido de cancelación, ya validado del lado de la Suite (permiso, alcance, motivo). */
export interface CancelacionOcEntrada {
  sucursal: string;
  folio: string;
  /** `c67`: quién cancela, como queda en Kepler. */
  capturista: string;
  /** `YYYY-MM-DD` y `HH:MM`, hora de México. */
  fecha: string;
  hora: string;
}

export interface CancelacionOcResultado {
  /** `cancelada` = las sentencias afectaron lo esperado y se confirmó. `rechazada` = nada se escribió. */
  estado: 'cancelada' | 'rechazada';
  motivo?: string;
  /**
   * Lo que Kepler pierde al cancelar y la Suite guarda: capturista, fecha y hora originales, total y
   * renglones. Se devuelve también al rechazar si se alcanzó a leer.
   */
  original?: Pick<OcEnKepler, 'serie' | 'folio' | 'estado' | 'total' | 'capturista' | 'fecha_captura' | 'hora_captura' | 'renglones' | 'origen_tipo' | 'origen_folio'>;
  /** La requisición que Kepler reabre (y que se reabrió), si la OC salió de una. */
  requisicion?: { folio: string; total: number; renglones: number } | null;
}

/** `[KR.7]` Resultado de cancelar una requisición. `original` = lo que Kepler pierde (quién y cuándo la capturó). */
export interface CancelacionRequisicionResultado {
  estado: 'cancelada' | 'rechazada';
  motivo?: string;
  original?: RequisicionACancelar;
}

/** Fecha de Kepler (`date`, `timestamp` o texto) → `YYYY-MM-DD` sin mover el día. */
const dia = (v: unknown): string => {
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v ?? '').slice(0, 10);
};

/** Llave de lectura de un documento de compra por sucursal y folio (cualquier serie). */
const DOC = (tipo: string) =>
  `btrim(c1) = $1 AND c2 = 'X' AND c3 = 'A' AND btrim(c4::text) = '${tipo}'`;

/**
 * `[PQ.110]` — **Cancela una OC sin vale en Kepler, todo o nada.**
 *
 * La regla vive en `kepler-oc-cancelacion.ts`; aquí sólo se lee, se decide y se escribe, en UNA
 * transacción contra el servidor de la sucursal (`KEPLER_PUSH_URL_NN`, como la requisición).
 *
 * ⛔ Las cabeceras se leen con `FOR UPDATE NOWAIT`: si alguien tiene abierta esa OC en Kepler, se
 * rechaza al instante en vez de esperar a que la suelte (bloquearía la pantalla de compras).
 *
 * ⛔ Cada sentencia debe afectar exactamente las filas que se leyeron; si no, `ROLLBACK` y el motivo.
 *
 * Permisos de `kepler_push` (`ops/prod/kepler-grants/pq110_cancelar_oc.sql`): UPDATE de 9 columnas de
 * `kdm1`, DELETE en `kdm2` y —para reabrir la requisición— UPDATE (`c24`) en `kdm2`.
 */
@Injectable()
export class KeplerOcCancelAdapter implements OnModuleDestroy {
  private readonly logger = new Logger(KeplerOcCancelAdapter.name);
  private readonly pools = new Map<string, Pool>();

  /** El ensayo lo reemplaza para no depender de `process.env`. */
  protected get env(): Env { return process.env; }

  private poolDe(url: string): Pool {
    let p = this.pools.get(url);
    if (!p) {
      p = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8000, statement_timeout: 30000 });
      this.pools.set(url, p);
    }
    return p;
  }

  async onModuleDestroy() {
    await Promise.all([...this.pools.values()].map((p) => p.end().catch(() => undefined)));
  }

  /**
   * El único paso que ESCRIBE. Aparte para que el ensayo corra todo lo demás contra el Kepler real
   * y aquí ejecute las MISMAS sentencias sobre copias temporales y haga ROLLBACK.
   */
  protected async confirmar(c: PoolClient, plan: PlanCancelacion, tablas: Tablas = TABLAS_KEPLER): Promise<string | null> {
    return this.ejecutar(c, plan.sucursal, permisosNecesarios(!!plan.requisicion),
      plan.requisicion ? 'reabrir la requisición' : 'cancelar', sentenciasCancelacion(plan, tablas));
  }

  /** `[KR.7]` El único paso que escribe al cancelar una requisición. Aparte por la misma razón que `confirmar`. */
  protected async confirmarRequisicion(c: PoolClient, plan: PlanCancelacionRequisicion, tablas: Tablas = TABLAS_KEPLER): Promise<string | null> {
    // Los mismos permisos que cancelar una OC sin requisición (anexo K §3e): ninguno nuevo.
    return this.ejecutar(c, plan.sucursal, permisosNecesarios(false), 'cancelar la requisición',
      sentenciasCancelacionRequisicion(plan, tablas));
  }

  /** Pregunta los permisos y corre las sentencias, todo o nada. `null` = confirmado (COMMIT). */
  private async ejecutar(c: PoolClient, sucursal: string, permisos: string[], para: string, sentencias: Sentencia[]): Promise<string | null> {
    // Antes de tocar nada: ¿Kepler le da a `kepler_push` cada permiso? Sin esto, la falta de uno se
    // descubre a media transacción con un «permiso denegado» que no dice cuál ni para qué.
    const faltan: string[] = [];
    for (const expr of permisos) {
      if ((await c.query(`SELECT (${expr}) ok`)).rows[0]?.ok !== true) faltan.push(expr.replace(/^has_\w+\(current_user, /, '').replace(/\)$/, ''));
    }
    if (faltan.length) {
      await c.query('ROLLBACK');
      return `Kepler (sucursal ${sucursal}) todavía no le da a la Suite el permiso para ${para} (${faltan.join('; ')}); no se escribió nada`;
    }
    for (const s of sentencias) {
      const r = await c.query(s.sql, s.params);
      if (r.rowCount !== s.esperadas) {
        await c.query('ROLLBACK');
        return `Kepler cambió mientras se cancelaba (${s.que}: ${r.rowCount ?? 0} filas, se esperaban ${s.esperadas}); no se escribió nada`;
      }
    }
    await c.query('COMMIT');
    return null;
  }

  async cancelar(e: CancelacionOcEntrada): Promise<CancelacionOcResultado> {
    const srv = urlDeServidor(e.sucursal, this.env);
    if (!srv.ok) return { estado: 'rechazada', motivo: srv.motivo };
    const folio = e.folio.trim();

    let c: PoolClient;
    try { c = await this.poolDe(srv.valor).connect(); }
    catch (err) { return { estado: 'rechazada', motivo: `Kepler (sucursal ${e.sucursal}) no responde: ${(err as Error).message}` }; }

    let abierta = false;
    try {
      await c.query('BEGIN');
      abierta = true;
      const ocs = await c.query(
        `SELECT btrim(c5::text) serie, btrim(c6) folio, btrim(c43) estado, c16::float8 total, btrim(c67) capturista,
                c68 fecha, btrim(c69) hora, NULLIF(btrim(c37::text), '') origen_tipo, NULLIF(btrim(c39), '') origen_folio
           FROM md.kdm1 WHERE ${DOC('35')} AND btrim(c6) = $2
           FOR UPDATE NOWAIT`,
        [e.sucursal, folio]);
      const h = ocs.rows[0];
      let oc: OcEnKepler | null = null;
      if (h) {
        const ren = await c.query(
          `SELECT count(*)::int n FROM md.kdm2 WHERE ${DOC('35')} AND btrim(c5::text) = $2 AND btrim(c6) = $3`,
          [e.sucursal, h.serie, folio]);
        oc = {
          serie: h.serie, folio: h.folio, estado: h.estado, total: Number(h.total) || 0,
          capturista: h.capturista ?? '', fecha_captura: dia(h.fecha), hora_captura: h.hora ?? '',
          renglones: ren.rows[0].n, origen_tipo: h.origen_tipo, origen_folio: h.origen_folio,
        };
      }

      const vales = await c.query(
        `SELECT btrim(c6) folio FROM md.kdm1
          WHERE ${DOC('37')} AND btrim(c37::text) = '35' AND btrim(c39) = $2 AND btrim(c43) <> 'C' ORDER BY 1`,
        [e.sucursal, folio]);

      let requisicion: RequisicionEnKepler | null = null;
      let otras: string[] = [];
      if (oc?.origen_tipo === '30' && oc.origen_folio) {
        const rq = await c.query(
          `SELECT btrim(c5::text) serie, btrim(c6) folio, btrim(c43) estado, c16::float8 total
             FROM md.kdm1 WHERE ${DOC('30')} AND btrim(c6) = $2
             FOR UPDATE NOWAIT`,
          [e.sucursal, oc.origen_folio]);
        if (rq.rowCount === 1) {
          const r = rq.rows[0];
          const ren = await c.query(
            `SELECT count(*)::int n FROM md.kdm2 WHERE ${DOC('30')} AND btrim(c5::text) = $2 AND btrim(c6) = $3`,
            [e.sucursal, r.serie, r.folio]);
          requisicion = { serie: r.serie, folio: r.folio, estado: r.estado, total: Number(r.total) || 0, renglones: ren.rows[0].n };
        }
        otras = (await c.query(
          `SELECT btrim(c6) folio FROM md.kdm1
            WHERE ${DOC('35')} AND btrim(c37::text) = '30' AND btrim(c39) = $2 AND btrim(c6) <> $3 AND btrim(c43) <> 'C' ORDER BY 1`,
          [e.sucursal, oc.origen_folio, folio])).rows.map((x) => String(x.folio));
      }

      const original = oc ?? undefined;
      const d = decidirCancelacionOc({
        oc, coincidencias: ocs.rowCount ?? 0, vales_vivos: vales.rows.map((x) => String(x.folio)),
        requisicion, otras_oc_vivas: otras,
      });
      if (!d.ok) {
        await c.query('ROLLBACK');
        abierta = false;
        return { estado: 'rechazada', motivo: d.motivo, original };
      }

      const plan: PlanCancelacion = {
        sucursal: e.sucursal,
        oc: { serie: oc!.serie, folio: oc!.folio, renglones: oc!.renglones },
        requisicion: d.reabre_requisicion && requisicion
          ? { serie: requisicion.serie, folio: requisicion.folio, renglones: requisicion.renglones } : null,
        capturista: e.capturista, fecha: e.fecha, hora: e.hora,
      };
      const falla = await this.confirmar(c, plan);
      abierta = false;
      if (falla) return { estado: 'rechazada', motivo: falla, original };
      this.logger.log(`[PQ.110] OC ${e.sucursal}|${folio} cancelada en Kepler${plan.requisicion ? `; requisición ${plan.requisicion.folio} reabierta` : ''}`);
      return {
        estado: 'cancelada', original,
        requisicion: plan.requisicion && requisicion ? { folio: requisicion.folio, total: requisicion.total, renglones: requisicion.renglones } : null,
      };
    } catch (err) {
      const m = (err as { code?: string; message?: string });
      if (abierta) await c.query('ROLLBACK').catch(() => undefined);
      // 55P03 = lock_not_available (NOWAIT): alguien tiene el documento abierto en Kepler.
      if (m.code === '55P03') return { estado: 'rechazada', motivo: 'Alguien tiene esa OC (o su requisición) abierta en Kepler en este momento; intenta de nuevo en un rato' };
      if (m.code === '42501') return { estado: 'rechazada', motivo: `Kepler (sucursal ${e.sucursal}) no le da permiso a la Suite para cancelar: ${m.message}` };
      this.logger.error(`[PQ.110] Cancelar OC ${e.sucursal}|${folio}: ${m.message}`);
      return { estado: 'rechazada', motivo: `Kepler rechazó la cancelación: ${m.message}` };
    } finally {
      c.release();
    }
  }

  /**
   * `[KR.7]` — **Cancela una requisición de compra (`X-A-30`) en Kepler, todo o nada.** La regla vive en
   * `kepler-req-cancelacion.ts` (sin OC viva, sólo N o A). Misma transacción, mismo candado `FOR UPDATE
   * NOWAIT` y los mismos permisos que cancelar una OC. El `UPDATE` repite en su `WHERE` el estado leído y
   * que no haya OC viva: si alguien la convirtió entre la lectura y la escritura, 0 filas y `ROLLBACK`.
   * ⚠️ Una OC que alguien esté capturando en Kepler (sin confirmar) no se ve; Kepler tiene la misma carrera.
   */
  async cancelarRequisicion(e: CancelacionOcEntrada): Promise<CancelacionRequisicionResultado> {
    const srv = urlDeServidor(e.sucursal, this.env);
    if (!srv.ok) return { estado: 'rechazada', motivo: srv.motivo };
    const folio = e.folio.trim();

    let c: PoolClient;
    try { c = await this.poolDe(srv.valor).connect(); }
    catch (err) { return { estado: 'rechazada', motivo: `Kepler (sucursal ${e.sucursal}) no responde: ${(err as Error).message}` }; }

    let abierta = false;
    try {
      await c.query('BEGIN');
      abierta = true;
      const rqs = await c.query(
        `SELECT btrim(c5::text) serie, btrim(c6) folio, btrim(c43) estado, c16::float8 total, btrim(c67) capturista,
                c68 fecha, btrim(c69) hora
           FROM md.kdm1 WHERE ${DOC('30')} AND btrim(c6) = $2
           FOR UPDATE NOWAIT`,
        [e.sucursal, folio]);
      const h = rqs.rows[0];
      let rq: RequisicionACancelar | null = null;
      if (h) {
        const ren = await c.query(
          `SELECT count(*)::int n FROM md.kdm2 WHERE ${DOC('30')} AND btrim(c5::text) = $2 AND btrim(c6) = $3`,
          [e.sucursal, h.serie, folio]);
        rq = {
          serie: h.serie, folio: h.folio, estado: h.estado, total: Number(h.total) || 0,
          capturista: h.capturista ?? '', fecha_captura: dia(h.fecha), hora_captura: h.hora ?? '', renglones: ren.rows[0].n,
        };
      }
      const ocVivas = (await c.query(
        `SELECT btrim(c6) folio FROM md.kdm1
          WHERE ${DOC('35')} AND btrim(c37::text) = '30' AND btrim(c39) = $2 AND btrim(c43) <> 'C' ORDER BY 1`,
        [e.sucursal, folio])).rows.map((x) => String(x.folio));

      const original = rq ?? undefined;
      const d = decidirCancelacionRequisicion({ requisicion: rq, coincidencias: rqs.rowCount ?? 0, oc_vivas: ocVivas });
      if (!d.ok) {
        await c.query('ROLLBACK');
        abierta = false;
        return { estado: 'rechazada', motivo: d.motivo, original };
      }

      const plan: PlanCancelacionRequisicion = {
        sucursal: e.sucursal,
        requisicion: { serie: rq!.serie, folio: rq!.folio, estado: rq!.estado, renglones: rq!.renglones },
        capturista: e.capturista, fecha: e.fecha, hora: e.hora,
      };
      const falla = await this.confirmarRequisicion(c, plan);
      abierta = false;
      if (falla) return { estado: 'rechazada', motivo: falla, original };
      this.logger.log(`[KR.7] Requisición ${e.sucursal}|${folio} cancelada en Kepler`);
      return { estado: 'cancelada', original };
    } catch (err) {
      const m = (err as { code?: string; message?: string });
      if (abierta) await c.query('ROLLBACK').catch(() => undefined);
      if (m.code === '55P03') return { estado: 'rechazada', motivo: 'Alguien tiene esa requisición abierta en Kepler en este momento; intenta de nuevo en un rato' };
      if (m.code === '42501') return { estado: 'rechazada', motivo: `Kepler (sucursal ${e.sucursal}) no le da permiso a la Suite para cancelar: ${m.message}` };
      this.logger.error(`[KR.7] Cancelar requisición ${e.sucursal}|${folio}: ${m.message}`);
      return { estado: 'rechazada', motivo: `Kepler rechazó la cancelación: ${m.message}` };
    } finally {
      c.release();
    }
  }
}
