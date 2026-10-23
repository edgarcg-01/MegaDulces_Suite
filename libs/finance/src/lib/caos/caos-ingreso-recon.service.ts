import { Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { diaDeFecha } from '@megadulces/contracts';
import {
  repartirIngresosCaos, resumirReparto,
  type CobroDisponible, type DepositoCaos, type ResumenReparto,
} from '../caja/caja-caos-ingreso.engine';

/**
 * `[CG.58]` — **Concilia el 100% de los ingresos de la caja fuerte contra los cobros de Kepler.**
 *
 * La regla la puso Edgar y la medición la confirmó: *el cobro se registra en Kepler ANTES de que el
 * efectivo entre al equipo*. Por eso el ingreso cierra al 100% y el egreso no — ahí hay que
 * adivinar cuál retiro pagó qué gasto, acá hay que **consumir en orden**.
 *
 * ── El reparto vive en el motor, no acá ─────────────────────────────────────────────────────
 *
 * Este servicio **lee, llama y escribe**. Toda la aritmética está en `caja-caos-ingreso.engine`,
 * pura y probada con su mutación — si estuviera acá haría falta un doble de Knex para probarla, y
 * un doble de Knex no ejecuta SQL.
 *
 * ── Por qué se MATERIALIZA ──────────────────────────────────────────────────────────────────
 *
 * El reparto es determinista, así que se podría derivar. No se hace: una atribución de efectivo
 * derivada **cambia el pasado** cada vez que el feed trae un cobro viejo. Se escribe en
 * `finance.caos_ingreso_atribucion`, y el candado `ux_caos_atrib_cobro_vivo` impide **en la base**
 * que un cobro se use dos veces. Sin ese candado el 100% sería de mentira.
 */
@Injectable()
export class CaosIngresoReconService {
  private readonly log = new Logger(CaosIngresoReconService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Qué tan conciliados están los ingresos de CAOS. **No escribe nada**: es la foto para la
   * pantalla y para decidir si vale la pena correr el reparto.
   *
   * ⚠️ Los tres cubos se publican SEPARADOS a propósito (ADR-056): «sin respaldo» (un depósito que
   * no tiene cobros anteriores que lo expliquen) y «sin depositar» (cobros que todavía no entraron
   * al equipo) son dos cosas distintas y las arregla gente distinta.
   */
  async estado(q: { from?: string; to?: string } = {}): Promise<{
    desde: string;
    depositos: number;
    monto_depositado: number;
    conciliados: number;
    monto_conciliado: number;
    pendientes: number;
    monto_pendiente: number;
    /** Efectivo cobrado que todavía no entró al equipo. Medido 2026-10-07: $18.8 M. */
    monto_sin_depositar: number;
    /** `[CG.58.5]` Cuándo corrió solo por última vez. `null` = nunca; se declara, no se asume. */
    latido: { cuando: string; status: string; nota: string | null; error: string | null } | null;
  }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const desde = q.from || '2026-05-27';   // el primer depósito que existe

    return this.tk.run(async (trx) => {
      const dep: any = await trx('analytics.caos_cash_movements as m')
        .where('m.tenant_id', tenantId)
        .where('m.type_id', 0)
        .where(trx.raw('m.occurred_at::date >= ?', [desde]))
        .count({ n: '*' }).sum({ monto: 'm.total' })
        .first();

      // Conciliado = el depósito tiene al menos una atribución viva que lo cubre entero.
      const conc: any = await trx
        .select(trx.raw('count(*)::int AS n'), trx.raw('coalesce(sum(cubierto),0)::numeric(18,2) AS monto'))
        .from(trx.raw(`(
          SELECT m.external_id, m.total, coalesce(sum(a.monto),0) AS cubierto
            FROM analytics.caos_cash_movements m
            JOIN finance.caos_ingreso_atribucion a
              ON a.tenant_id = m.tenant_id AND a.caos_device = m.device
             AND a.caos_external_id = m.external_id AND a.deleted_at IS NULL
           WHERE m.tenant_id = ? AND m.type_id = 0 AND m.occurred_at::date >= ?
           GROUP BY m.external_id, m.total
          HAVING coalesce(sum(a.monto),0) >= m.total - 0.005
        ) AS x`, [tenantId, desde]))
        .first();

      const libre: any = await trx('finance.v_caja_movimientos_pendientes as k')
        .where('k.tenant_id', tenantId)
        .where('k.tipo', 'ingreso')
        .where('k.fecha_valor', '>=', desde)
        .whereNotExists(function (this: any) {
          this.select(1).from('finance.caos_ingreso_atribucion as a')
            .whereRaw('a.tenant_id = k.tenant_id AND a.cobro_origen_ref = k.origen_ref AND a.deleted_at IS NULL');
        })
        .sum({ monto: 'k.monto' })
        .first();

      const depositos = Number(dep?.n ?? 0);
      const conciliados = Number(conc?.n ?? 0);
      const monto_depositado = Number(dep?.monto ?? 0);
      const monto_conciliado = Number(conc?.monto ?? 0);
      /**
       * `[CG.58.5]` El LATIDO del carril que ahora hace esto solo. Viaja con el estado y no en un
       * endpoint aparte a propósito: la pregunta *«¿esto está al día?»* no se puede responder con
       * las cifras sin saber **cuándo se calcularon**, y separarlas deja que la pantalla publique
       * un número viejo con toda confianza.
       *
       * ⚠️ `null` cuando no hay ninguna corrida — se declara, no se dibuja como «al día».
       */
      type LatidoCrudo = { cuando: string | null; status: string | null; note: string | null; error: string | null };
      const lat: LatidoCrudo | undefined = await trx('analytics.cron_runs')
        .where({ tenant_id: tenantId, job_key: 'caos_ingreso_conciliar' })
        .select(
          trx.raw(`to_char(last_finish AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD HH24:MI') AS cuando`),
          'status', 'note', 'error',
        )
        .first();

      return {
        desde,
        depositos,
        monto_depositado,
        conciliados,
        monto_conciliado,
        pendientes: depositos - conciliados,
        monto_pendiente: Number((monto_depositado - monto_conciliado).toFixed(2)),
        monto_sin_depositar: Number(libre?.monto ?? 0),
        latido: lat?.cuando
          ? { cuando: lat.cuando, status: lat.status ?? 'unknown', nota: lat.note, error: lat.error }
          : null,
      };
    });
  }

  /**
   * **Reparte y GUARDA.** Es lo que corre al generar el arqueo.
   *
   * ⚠️ Toma los cobros **ya atribuidos** para descontarlos del pool: correrlo dos veces no puede
   * dar un reparto distinto ni duplicar tramos. Lo que ya está escrito no se toca — sólo se
   * agregan los depósitos que todavía no tienen atribución.
   */
  async conciliar(
    user: { id?: string } | null,
    q: { from?: string; to?: string } = {},
  ): Promise<ResumenReparto & { escritos: number }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const desde = q.from || '2026-05-27';

    return this.tk.run(async (trx) => {
      const hayCustodia = !!(await trx.raw(`SELECT to_regclass('finance.caos_retiro_custodia') AS t`)).rows?.[0]?.t;
      // 1 · Los depósitos que todavía NO están atribuidos.
      const depositos: DepositoCaos[] = (await trx('analytics.caos_cash_movements as m')
        .where('m.tenant_id', tenantId)
        .where('m.type_id', 0)
        .where(trx.raw('m.occurred_at::date >= ?', [desde]))
        .whereNotExists(function (this: any) {
          this.select(1).from('finance.caos_ingreso_atribucion as a')
            .whereRaw('a.tenant_id = m.tenant_id AND a.caos_device = m.device '
              + 'AND a.caos_external_id = m.external_id AND a.deleted_at IS NULL');
        })
        /**
         * ⛔ `[CGA-A.51]` El REGRESO de un retiro que se llevó una persona (ADR-101) no es un
         * cobro: es el sobrante que vuelve a la máquina. Repartirlo consumiría cobros viejos de
         * Kepler que no tienen nada que ver — un jineteo fabricado por el conciliador. Dos señales:
         * la custodia ya cerrada con ese depósito, o la referencia de CAOS empieza con «regreso»
         * (la convención para depositar un sobrante, porque el cierre suele llegar después de la
         * corrida de cada hora). Medido el 2026-10-23: 0 depósitos con esa referencia hasta hoy.
         */
        .whereRaw(`coalesce(m.ref, '') !~* '^[[:space:]]*regres'`)
        .modify((qb: Knex.QueryBuilder) => {
          if (hayCustodia) {
            qb.whereNotExists(function (this: Knex.QueryBuilder) {
              this.select(1).from('finance.caos_retiro_custodia as c')
                .whereRaw('c.tenant_id = m.tenant_id AND c.caos_device = m.device '
                  + 'AND c.cierre_caos_external_id = m.external_id AND c.deleted_at IS NULL');
            });
          }
        })
        .orderBy('m.occurred_at', 'asc').orderBy('m.external_id', 'asc')
        .select('m.device', 'm.external_id', 'm.occurred_at', 'm.total'))
        .map((r: any) => ({
          device: r.device,
          external_id: Number(r.external_id),
          occurred_at: new Date(r.occurred_at).toISOString(),
          total: Number(r.total),
        }));

      if (!depositos.length) {
        return { ...resumirReparto({ resultados: [], sinDepositar: [] }), escritos: 0 };
      }

      // 2 · Los cobros, con lo YA atribuido descontado. Sin esto, correrlo dos veces repartiría
      //     el mismo dinero dos veces — y el candado de la base lo rechazaría a mitad de camino.
      const cobros: CobroDisponible[] = (await trx('finance.v_caja_movimientos_pendientes as k')
        .leftJoin(
          trx.raw(`(SELECT cobro_origen_ref, sum(monto) AS usado
                      FROM finance.caos_ingreso_atribucion
                     WHERE tenant_id = ? AND deleted_at IS NULL
                     GROUP BY 1) AS u`, [tenantId]),
          'u.cobro_origen_ref', 'k.origen_ref',
        )
        .where('k.tenant_id', tenantId)
        .where('k.tipo', 'ingreso')
        .where('k.fecha_valor', '>=', desde)
        .orderBy('k.fecha_valor', 'asc').orderBy('k.origen_ref', 'asc')
        .select('k.origen_ref', 'k.fecha_valor', 'k.monto', trx.raw('coalesce(u.usado,0) AS usado')))
        .map((r: any) => ({
          origen_ref: r.origen_ref,
          /**
           * ⛔⛔ `[CG.162]` Acá decía `String(r.fecha_valor).slice(0, 10)` y costó $18.5 M de
           * acusación: `fecha_valor` es `date`, node-pg la devuelve como **objeto `Date`**, y
           * `String(Date)` da `"Wed May 27 2026 …"` → recortado, `"Wed May 27"`. Cualquier letra
           * de día ordena después de `"2026-…"`, así que el corte `if (c.fecha > corte) break`
           * del motor disparaba en el PRIMER cobro de los 755 depósitos y los declaraba a todos
           * «sin respaldo». `diaDeFecha` es el resolvedor que sí entiende un `Date`.
           */
          fecha: diaDeFecha(r.fecha_valor) ?? r.fecha_valor,
          monto: Number(r.monto),
          consumido: Number(r.usado ?? 0),
        }));

      const reparto = repartirIngresosCaos(depositos, cobros);

      /**
       * ⛔⛔ `[CGA-A.37]` **ESTE INSERT NO GUARDÓ UNA SOLA FILA EN SU VIDA.** El índice
       * `ux_caos_atrib_cobro_vivo` exigía UNA fila por cobro, y el motor parte un cobro entre dos
       * depósitos a propósito (el último tramo de cada depósito es parcial). Medido en prod: 512
       * cobros partidos, 779 filas rechazadas, la transacción entera revertida en cada corrida.
       * El candado se reemplazó por el que sí protege —Σ por cobro ≤ su monto— y para eso cada
       * tramo lleva el monto TOTAL de su cobro (`cobro_monto`).
       */
      const montoDeCobro = new Map(cobros.map((c) => [c.origen_ref, c.monto] as const));

      // 3 · Escribir. Sólo los tramos: el cobro y el depósito viven en sus fuentes.
      const filas: any[] = [];
      for (const { deposito, veredicto } of reparto.resultados) {
        for (const ap of veredicto.aplicaciones) {
          filas.push({
            tenant_id: tenantId,
            caos_device: deposito.device,
            caos_external_id: deposito.external_id,
            caos_occurred_at: deposito.occurred_at,
            cobro_origen_ref: ap.origen_ref,
            cobro_fecha: ap.fecha,
            monto: ap.monto,
            cobro_monto: montoDeCobro.get(ap.origen_ref) ?? null,
            metodo: 'fifo_anterior',
            calculado_por: user?.id ?? null,
          });
        }
      }
      if (filas.length) {
        // En lotes: 708 depósitos pueden dar miles de tramos y un INSERT único los manda todos
        // en una sentencia de megabytes.
        for (let i = 0; i < filas.length; i += 500) {
          await trx('finance.caos_ingreso_atribucion').insert(filas.slice(i, i + 500));
        }
      }

      const resumen = resumirReparto(reparto);
      this.log.log(
        `[CG.58] reparto: ${resumen.depositos} depósitos · ${resumen.cubiertos} cubiertos · `
        + `${resumen.sin_respaldo} sin respaldo · ${filas.length} tramos · `
        + `sin depositar $${resumen.monto_sin_depositar}`,
      );
      return { ...resumen, escritos: filas.length };
    });
  }
}
