import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { KNEX_NEW_DB, latirCron } from '@megadulces/platform-core';
import { FINANCE_NOTIFIER_PORT, type FinanceNotifierPort } from '@megadulces/contracts';
import type { Knex } from 'knex';

const MEGA = '00000000-0000-0000-0000-00000000d01c';

export interface MedicionFechaFutura {
  /** Movimientos del LIBRO que siguen fechados después de hoy. */
  libro: number;
  /** Lo que esos movimientos suman. Es dinero que el libro publica en un mes que no llegó. */
  libro_monto: number;
  /** Documentos del ERP todavía sin capturar que vienen fechados adelante. */
  pendientes: number;
  /** Movimientos que se re-sincronizaron en esta pasada porque Kepler ya los corrigió. */
  resincronizados: number;
  /** Los que siguen mal y NO se pueden tocar: están dentro de un corte cerrado o autorizado. */
  congelados: number;
  /** Universo revisado. Cero acá NO es "todo bien": es que no se vio el libro (ver el latido). */
  universo: number;
}

/**
 * `[CG.25]` — **La fecha adelantada se avisa, y cuando Kepler la corrige la seguimos.**
 *
 * ── De dónde sale, medido ────────────────────────────────────────────────────────────────
 * El ERP trae documentos con `fecha_valor` posterior a hoy: el 2026-09-29 eran **8**, y los seis
 * `X-D-26` lo confiesan en su propio concepto — *"GASTOS NF MORELIA **28-01-2026**"*,
 * *"**30-01-2026**"*, *"**21-01**"*. Son gastos de **enero** que alguien fechó en **diciembre**.
 *
 * `[CG.24]` puso el freno para que no vuelvan a entrar. Pero un freno **no arregla lo ya escrito**:
 * `CG-2026-00002` ya estaba en el libro con `fecha = 2026-12-10`, y con el filtro por default de
 * la pantalla (del 1º del mes a hoy) el libro mostraba **1 de los 2** movimientos que tenía.
 *
 * ── La decisión de fondo: Kepler es el dueño de la fecha ──────────────────────────────────
 * Decisión de Edgar (2026-09-29): *"debemos avisar cuando un movimiento esté en una fecha
 * adelante, y una vez se actualicen en Kepler actualizarlos también nosotros"*.
 *
 * Es lo correcto y hereda ADR-040: **el ERP es el sistema de registro del documento, nosotros no
 * le escribimos**. La corrección se hace allá, donde vive el dato, y acá se **sigue**. Lo contrario
 * —corregir la fecha a mano de este lado— crearía dos verdades para el mismo documento, que es
 * exactamente lo que el camino B del §6 de ADR-070 tiene prohibido.
 *
 * ⛔ **Sólo se re-sincroniza lo que está en el estado MALO CONOCIDO** (`fecha > hoy`). No se
 * persigue cualquier cambio de fecha del ERP, y la razón es concreta: si una persona ya corrigió
 * a mano nuestra fecha a la buena, seguir a Kepler ciegamente le **desharía** la corrección. El
 * universo es el de las filas rotas, no el de todas.
 *
 * ⛔ **Nunca toca un movimiento congelado.** Si entró a un corte `cerrado` o `autorizado`, sus
 * totales ya están firmados: cambiarle la fecha por atrás volvería mentiroso un documento que
 * alguien autorizó. Esos se cuentan aparte y se avisan para que se resuelvan a mano.
 *
 * ── Por qué avisa por la campana y NO escribe hallazgos ──────────────────────────────────
 * Es el mismo criterio ya medido en `CobranzaGapScannerService` (`[CC.10]`), y no conviene
 * re-litigarlo: `finance.findings` acumuló **82,377 filas en `nuevo` sin triage**. Además, acá
 * **el trabajo cierra el item solo** — en cuanto alguien arregla la fecha en Kepler, la fila sale
 * de la consulta. Un hallazgo exigiría un "confirmar / descartar" aparte que duplicaría la acción
 * real y se quedaría sin hacer.
 *
 * ⚠️ Su umbral vive en `CRON_JOBS` (`db-health.service.ts`). Sin esa entrada el sensor cae en el
 * `cfg ? classify : 'ok'` y un cron parado se pinta **verde**.
 */
@Injectable()
export class CajaFechaFuturaScannerService {
  private readonly logger = new Logger(CajaFechaFuturaScannerService.name);
  private running = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    @Optional() @Inject(FINANCE_NOTIFIER_PORT) private readonly notifier?: FinanceNotifierPort,
  ) {}

  /** 07:15 MX — antes de que Finanzas abra la caja, y antes del scan de cobranza (07:45). */
  @Cron('0 15 7 * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_CAJA_FECHA_SCAN === 'false') return;
    if (this.running) { this.logger.warn('Skip: scan en curso'); return; }
    await this.scan().catch((e) => this.logger.error(`scan fecha futura: ${e?.message ?? e}`));
  }

  async scan(): Promise<MedicionFechaFutura> {
    this.running = true;
    const t0 = Date.now();
    const fallas: string[] = [];
    let m: MedicionFechaFutura = {
      libro: 0, libro_monto: 0, pendientes: 0, resincronizados: 0, congelados: 0, universo: 0,
    };
    try {
      await this.knex.transaction(async (trx) => {
        // ⛔ SIN ESTA LÍNEA EL UNIVERSO ES CERO, Y EL CERO SE LEE COMO "no hay nada mal".
        // `finance.cash_ledger` tiene RLS **forzado** (verificado en prod: `relforcerowsecurity`),
        // y esto corre desde un `@Cron`, sin request, así que no hay `TenantContextService` que fije
        // `app.tenant_id`. El filtro `tenant_id = ?` NO alcanza: la política se aplica antes.
        // Es la misma trampa que le costó a `cobranza_gap` reportar 0 abonos todos los días
        // ([AUD-DAT.8]). `set_config(k, v, true)` y no `SET LOCAL`: Postgres rechaza parámetros
        // ligados en `SET` (42601), y el `true` lo hace local a esta transacción.
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);

        // 1 ─ SEGUIR A KEPLER. Sólo las filas rotas (`fecha > hoy`) cuyo documento en el ERP YA
        //     tiene fecha buena. El `origen_ref` se arma igual que al capturar:
        //     `sucursal|doc_tipo|folio|clave_banco` (verificado contra las 2 filas reales).
        const up = await trx.raw(`
          WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS d),
          -- Congelado = atado a un corte que ya se firmó. No se toca por atrás.
          frio AS (
            SELECT id FROM finance.cash_ledger_cuts
             WHERE tenant_id = ? AND estado IN ('cerrado','autorizado')
          ),
          candidatas AS (
            SELECT l.id, l.folio, l.fecha AS antes, m.fecha_valor AS ahora
              FROM finance.cash_ledger l
              CROSS JOIN hoy
              JOIN analytics.mv_caja_movimientos m
                ON m.tenant_id = l.tenant_id
               AND m.sucursal || '|' || m.doc_tipo || '|' || m.folio || '|' || m.clave_banco = l.origen_ref
             WHERE l.tenant_id = ?
               AND l.deleted_at IS NULL
               AND l.estado <> 'cancelado'
               AND (l.corte_id IS NULL OR l.corte_id NOT IN (SELECT id FROM frio))
               AND l.fecha > hoy.d          -- sólo el estado malo conocido
               AND m.fecha_valor <= hoy.d   -- …y sólo si Kepler YA la corrigió
          )
          UPDATE finance.cash_ledger l
             SET fecha = c.ahora,
                 updated_at = now(),
                 -- La huella viaja EN LA FILA, no sólo en un log: un movimiento de dinero cuya
                 -- fecha cambió sola tiene que poder explicar de dónde salió el cambio.
                 autofill = coalesce(l.autofill, '{}'::jsonb) || jsonb_build_object(
                   'fecha_resync', jsonb_build_object(
                     'source', 'documento',
                     'reason', 'kepler_corrigio_fecha_futura',
                     'antes', c.antes::text,
                     'ahora', c.ahora::text,
                     'at', now()
                   ))
            FROM candidatas c
           WHERE l.id = c.id
          RETURNING l.folio, c.antes::text AS antes, c.ahora::text AS ahora`, [MEGA, MEGA]);

        m.resincronizados = up.rows.length;
        for (const r of up.rows) {
          this.logger.log(`resync ${r.folio}: ${r.antes} → ${r.ahora} (Kepler corrigió la fecha)`);
        }

        // 2 ─ MEDIR lo que queda. Se mide DESPUÉS del paso 1 a propósito: lo que se acaba de
        //     arreglar no tiene que salir en el aviso del mismo día.
        const r = await trx.raw(`
          WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS d),
          frio AS (
            SELECT id FROM finance.cash_ledger_cuts
             WHERE tenant_id = ? AND estado IN ('cerrado','autorizado')
          ),
          libro AS (
            SELECT l.monto, (l.corte_id IN (SELECT id FROM frio)) AS congelado
              FROM finance.cash_ledger l CROSS JOIN hoy
             WHERE l.tenant_id = ? AND l.deleted_at IS NULL AND l.estado <> 'cancelado'
               AND l.fecha > hoy.d
          )
          SELECT (SELECT count(*)::int FROM libro) AS libro,
                 (SELECT round(coalesce(sum(monto), 0), 2)::float FROM libro) AS libro_monto,
                 (SELECT count(*)::int FROM libro WHERE congelado) AS congelados,
                 -- El universo: todo el libro vivo. Si esto viene en 0 el latido se pone rojo,
                 -- porque significa que no vimos la tabla (RLS), no que el libro esté sano.
                 (SELECT count(*)::int FROM finance.cash_ledger
                   WHERE tenant_id = ? AND deleted_at IS NULL) AS universo,
                 -- Los que todavía NO se capturaron: avisar acá es lo que evita que el problema
                 -- entre al libro, y desde [CG.24] ya ni siquiera se pueden confirmar en lote.
                 (SELECT count(*)::int FROM finance.v_caja_movimientos_pendientes p
                   CROSS JOIN hoy WHERE p.tenant_id = ? AND p.fecha_valor > hoy.d) AS pendientes
          `, [MEGA, MEGA, MEGA, MEGA]);
        const row = r.rows[0];
        m = { ...m, ...row, libro_monto: Number(row.libro_monto) };
      });
      this.logger.log(`caja fecha futura: ${m.libro} en el libro ($${m.libro_monto}) · `
        + `${m.pendientes} por capturar · ${m.resincronizados} resync · ${m.congelados} congelados`);
    } catch (e) {
      fallas.push(e instanceof Error ? e.message : String(e));
      this.logger.error(`caja fecha futura: ${fallas[0]}`);
    } finally {
      this.running = false;
    }

    // ⛔ `rowsAffected` = el UNIVERSO revisado, no los defectos encontrados. Si fuera "los
    // defectos", el día que todo esté bien el latido diría "cero entregado" y se pintaría rojo por
    // estar sano. Y al revés: un cero en el universo sí es rojo, y con razón — el libro de caja de
    // esta empresa no está vacío, así que verlo vacío significa que RLS nos dejó afuera.
    await latirCron(this.knex, {
      jobKey: 'caja_fecha_futura',
      label: 'Caja: movimientos fechados adelante (avisa y sigue a Kepler)',
      tenantId: MEGA,
      rowsAffected: m.universo,
      durationMs: Date.now() - t0,
      fallas,
      note: `${m.libro} en el libro · ${m.pendientes} por capturar · ${m.resincronizados} resync`,
    });

    if (!fallas.length) await this.avisar(m);
    return m;
  }

  /**
   * El aviso a la campana. Dos mensajes distintos porque son dos acciones distintas:
   * lo que ya entró al libro está publicando un número equivocado **hoy**; lo que todavía no entró
   * sólo hay que ir a corregirlo en Kepler antes de capturarlo.
   *
   * ⚠️ Best-effort y por el puerto: si la campana no está montada, el scan igual midió y latió.
   */
  private async avisar(m: MedicionFechaFutura): Promise<void> {
    const notify = this.notifier?.notify?.bind(this.notifier);
    if (!notify) return;

    if (m.libro > 0) {
      const congelado = m.congelados > 0
        ? ` ${m.congelados} está${m.congelados === 1 ? '' : 'n'} dentro de un corte firmado y hay que resolverlo${m.congelados === 1 ? '' : 's'} a mano.`
        : '';
      await notify(MEGA, {
        key: 'caja_fecha_futura_libro',
        // `critical` y no `info`: mientras esté así, el libro publica de menos en el mes en curso.
        severity: m.libro_monto >= 10000 ? 'critical' : 'warn',
        title: 'Movimientos de caja fechados adelante',
        message: `${m.libro} movimiento${m.libro === 1 ? '' : 's'} del libro por `
          + `$${m.libro_monto.toLocaleString('es-MX')} está${m.libro === 1 ? '' : 'n'} fechado${m.libro === 1 ? '' : 's'} `
          + 'después de hoy y no aparece' + (m.libro === 1 ? '' : 'n') + ' en el libro del mes. '
          + 'Corregí la fecha del documento en Kepler y acá se actualiza solo.' + congelado,
        route: '/finanzas/caja-general',
        data: { movimientos: m.libro, monto: m.libro_monto, congelados: m.congelados },
      }).catch((e: unknown) => this.logger.warn(`aviso libro: ${e instanceof Error ? e.message : e}`));
    }

    if (m.pendientes > 0) {
      await notify(MEGA, {
        key: 'caja_fecha_futura_pendientes',
        severity: 'info',
        title: 'Documentos de Kepler mal fechados en la cola de caja',
        message: `${m.pendientes} documento${m.pendientes === 1 ? '' : 's'} por confirmar viene${m.pendientes === 1 ? '' : 'n'} `
          + 'con fecha posterior a hoy. No se pueden confirmar en lote hasta que se corrija la fecha en Kepler.',
        route: '/finanzas/caja-general',
        data: { pendientes: m.pendientes },
      }).catch((e: unknown) => this.logger.warn(`aviso pendientes: ${e instanceof Error ? e.message : e}`));
    }
  }
}
