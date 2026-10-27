/**
 * `[LE.4.4]` — El carril que pasa los movimientos de la máquina al libro de efectivo (Fase LE, E5:
 * operación en sombra). Identidad de servicio propia (`libro-caos`); nunca autoriza (B14).
 *
 * ── Reglas ───────────────────────────────────────────────────────────────────────────────────
 *  · ⛔ APAGADO por default: `LE_LIBRO_CAOS=on` lo enciende.
 *  · ⛔ Sin punto de apertura no hace NADA: `LE_LIBRO_CAOS_DESDE=<equipo>:<id>` es el último
 *    movimiento que el libro NO toma (en LE.3.4: `AST700-19758:1607`, la máquina en cero con dos
 *    testigos). Antes de ese punto el libro no sabe qué había, y empezar en otro lado lo dejaría
 *    pidiendo billetes que no tiene.
 *  · En orden y sin saltar: un hueco en la numeración detiene el carril y va a la cola (B41).
 *  · Lo que no tiene regla (Fin de Día, Contenido Modificado, un vaciado que no cuadra con su
 *    desglose) va a la cola con su motivo y el carril SIGUE: por las reglas, no mueve la bóveda.
 *  · Lo que dejaría la bóveda en negativo NO se fuerza: va a la cola y el carril SE DETIENE (algo
 *    anterior falta).
 *  · Idempotente: el asiento va por `event_ref` + `event_hash`; releer no duplica.
 *  · Deja su latido (`cron_runs`, `libro_caos`), también cuando está apagado o detenido.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { planDeCaos, puntoDeApertura } from './carril-caos';
import { identidadDeCaos, type MovimientoCaos } from './identidad';
import { esSinRegla, movimientoCaos, type Contexto } from './reglas';

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const LOTE = 500;
const FISICAS_NEGATIVAS = new Set(['cashbook_piezas_no_negativas', 'cashbook_saldo_no_negativo']);

export interface CorridaCarril {
  estado: 'apagado' | 'sin_apertura' | 'al_dia' | 'detenido' | 'error';
  asentados: number;
  a_la_cola: number;
  ultimo: number | null;
  motivo: string | null;
}

export const carrilEncendido = (): boolean => process.env['LE_LIBRO_CAOS'] === 'on';

@Injectable()
export class CashbookCaosCarril {
  private readonly logger = new Logger(CashbookCaosCarril.name);

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly tk: TenantKnexService,
  ) {}

  @Cron('30 * * * * *', { timeZone: 'America/Mexico_City' })
  async cadaMinuto(): Promise<void> {
    if (!carrilEncendido()) return;
    const r = await this.correr();
    await this.latir(r);
  }

  /** Una pasada. `opciones` existe para la prueba (tenant y apertura propios); el cron usa el entorno. */
  async correr(opciones: { tenantId?: string; desde?: string } = {}): Promise<CorridaCarril> {
    const apertura = puntoDeApertura(opciones.desde ?? process.env['LE_LIBRO_CAOS_DESDE']);
    if (!apertura) {
      this.logger.warn('[LE.4.4] NO MEDIDO: sin LE_LIBRO_CAOS_DESDE el libro no sabe desde dónde tomar la máquina');
      return { estado: 'sin_apertura', asentados: 0, a_la_cola: 0, ultimo: null, motivo: 'sin punto de apertura' };
    }
    const ctx: Contexto = { actor: { kind: 'servicio', service: 'libro-caos' }, valueAt: '' };
    try {
      return await this.tenantCtx.run({ tenantId: opciones.tenantId ?? MEGA }, () => this.tk.run(async (trx) => {
        const ultimo = await this.ultimoProcesado(trx, apertura.equipo, apertura.desde);
        const movs = await this.movimientos(trx, apertura.equipo, ultimo);
        const plan = planDeCaos(movs, ultimo);
        let asentados = 0;
        let aLaCola = 0;
        let hasta = ultimo;
        for (const m of plan.aAsentar) {
          const res = movimientoCaos(m, { ...ctx, valueAt: new Date(m.occurred_at).toISOString() });
          if (esSinRegla(res)) {
            await this.encolar(trx, res.event_ref, res.motivo, m);
            aLaCola += 1;
            hasta = Number(m.external_id);
            continue;
          }
          for (const c of res.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify(c)]);
          await trx.raw('SAVEPOINT libro_caos');
          try {
            await trx.raw('SELECT cashbook.post_entry(?::jsonb)', [JSON.stringify(res.asiento)]);
            await trx.raw('RELEASE SAVEPOINT libro_caos');
            asentados += 1;
            hasta = Number(m.external_id);
          } catch (e) {
            await trx.raw('ROLLBACK TO SAVEPOINT libro_caos');
            const c = (e as { constraint?: string }).constraint ?? '';
            if (!FISICAS_NEGATIVAS.has(c)) throw e;
            await this.encolar(trx, identidadDeCaos(m).event_ref, `dejaría la bóveda en negativo (${c}): falta algo anterior`, m);
            return { estado: 'detenido', asentados, a_la_cola: aLaCola + 1, ultimo: hasta, motivo: `#${m.external_id} dejaría la bóveda en negativo` };
          }
        }
        if (plan.hueco) {
          const ref = `caos:${apertura.equipo}:hueco:${plan.hueco.desde}-${plan.hueco.hasta}`;
          await trx.raw('SELECT cashbook.enqueue_external(?::jsonb)', [JSON.stringify({ source: 'caos', event_ref: ref,
            reason: `faltan los movimientos ${plan.hueco.desde}–${plan.hueco.hasta} de la máquina: el libro espera`, payload: plan.hueco })]);
          return { estado: 'detenido', asentados, a_la_cola: aLaCola + 1, ultimo: hasta, motivo: `hueco ${plan.hueco.desde}–${plan.hueco.hasta}` };
        }
        return { estado: 'al_dia', asentados, a_la_cola: aLaCola, ultimo: hasta, motivo: null };
      }));
    } catch (e) {
      const motivo = (e as { constraint?: string; message?: string }).constraint ?? (e as Error).message;
      this.logger.error(`[LE.4.4] el carril de la máquina falló: ${motivo}`);
      return { estado: 'error', asentados: 0, a_la_cola: 0, ultimo: null, motivo };
    }
  }

  /** El último movimiento ya procesado: asentado o en la cola. Nunca antes del punto de apertura. */
  private async ultimoProcesado(trx: Knex.Transaction, equipo: string, desde: number): Promise<number> {
    const patron = `^caos:${equipo.replace(/[.-]/g, (c) => `[${c}]`)}:[0-9]+$`;
    const r = (await trx.raw(`
      SELECT greatest(
        (SELECT max(split_part(event_ref, ':', 3)::bigint) FROM cashbook.entries WHERE event_ref ~ ?),
        (SELECT max(split_part(event_ref, ':', 3)::bigint) FROM cashbook.external_queue WHERE source = 'caos' AND event_ref ~ ?)
      )::text AS n`, [patron, patron])).rows[0] as { n: string | null };
    return Math.max(desde, Number(r.n ?? 0));
  }

  private async movimientos(trx: Knex.Transaction, equipo: string, desde: number): Promise<MovimientoCaos[]> {
    return (await trx.raw(`
      SELECT m.device, m.external_id::text, m.type_id, m.type_label, m.occurred_at, m.total::text, m.ref, m.user_external,
             coalesce(json_agg(json_build_object('denom', d.denom::text, 'pieza_tipo', d.pieza_tipo, 'quantity', d.quantity::text))
                      FILTER (WHERE d.movement_id IS NOT NULL), '[]') AS piezas
        FROM analytics.caos_cash_movements m
        LEFT JOIN analytics.caos_cash_denominations d ON d.movement_id = m.id
       WHERE m.device = ? AND m.external_id > ?
       GROUP BY m.id ORDER BY m.external_id LIMIT ?`, [equipo, desde, LOTE])).rows as MovimientoCaos[];
  }

  private async encolar(trx: Knex.Transaction, ref: string, motivo: string, m: MovimientoCaos): Promise<void> {
    await trx.raw('SELECT cashbook.enqueue_external(?::jsonb)', [JSON.stringify({ source: 'caos', event_ref: ref, reason: motivo,
      payload: { external_id: m.external_id, type_label: m.type_label, total: m.total, occurred_at: m.occurred_at } })]);
  }

  private async latir(r: CorridaCarril): Promise<void> {
    const error = r.estado === 'error' || r.estado === 'sin_apertura' || r.estado === 'detenido' ? r.motivo : null;
    await this.knex('analytics.cron_runs').insert({
      tenant_id: MEGA, job_key: 'libro_caos', label: 'Libro de efectivo — movimientos de la máquina',
      last_start: this.knex.fn.now(), last_finish: this.knex.fn.now(), status: error ? 'error' : 'ok',
      rows_affected: r.asentados, note: error ? null : `${r.asentados} asentado(s) · ${r.a_la_cola} a la cola · hasta #${r.ultimo ?? '—'}`,
      error, host: 'worker', updated_at: this.knex.fn.now(),
    }).onConflict(['tenant_id', 'job_key']).merge()
      .catch((e: Error) => this.logger.warn(`[LE.4.4] latido: ${e.message}`));
  }
}
