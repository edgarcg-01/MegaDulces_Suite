import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, KNEX_NEW_DB_ADMIN, latirCron } from '@megadulces/platform-core';

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const MV = 'analytics.mv_caja_autofill_entidad';
const KEY = 'caja_autofill_entidad';
const LABEL = 'Caja — refresca el autollenado por entidad';

export interface MedicionRefrescoAutofill {
  /** Filas que quedaron PUBLICADAS en la copia. Es lo entregado, no lo recorrido. */
  filas: number;
  /** Filas que la fuente tenía al momento del prevuelo. */
  fuente: number;
  /** `null` si no se refrescó (prevuelo en cero): la copia anterior sobrevive. */
  antes: number | null;
  ms: number;
  falla: string | null;
}

/**
 * `[CG.141]` — **Quién refresca la matvista del autollenado. Hasta hoy, nadie.**
 *
 * `analytics.mv_caja_autofill_entidad` nació el 2026-10-13 y llegó a producción **con cero
 * filas**, leída por `CajaAutofillService.porEntidad()` y sin un solo `REFRESH` en todo el repo,
 * sin `job_key` en `analytics.cron_runs` y sin umbral en `CRON_JOBS`. O sea: una copia que se
 * congela sola y un tablero que no puede notarlo (ADR-053).
 *
 * ── Las tres decisiones de este carril, y por qué ───────────────────────────────────────────
 *
 * 1. ⛔ **El tenant se fija ANTES de refrescar.** La matvista lee
 *    `finance.v_caja_movimientos_pendientes`, que filtra `current_tenant_id()`. Un `REFRESH`
 *    lanzado desde una sesión sin `app.tenant_id` **la vacía**, que es exactamente cómo nació.
 *    Medido: sin tenant 0 filas · con tenant 13,302. Por eso este carril no puede vivir en el
 *    array genérico de `AnalyticsRefreshService`: ése refresca sin fijar nada y volvería a
 *    vaciarla en la primera corrida.
 *
 * 2. ⭐ **`REFRESH` sin `CONCURRENTLY`, dentro de una transacción, a propósito.** No es
 *    comodidad: `CONCURRENTLY` no corre dentro de una transacción, y la transacción es lo que
 *    hace que el defecto no pueda repetirse — si la copia quedara vacía, **se revierte y
 *    sobrevive la anterior**. Además evita el otro riesgo: un `SET` de sesión sobre una conexión
 *    del pool deja el `app.tenant_id` puesto para quien la tome después, que en una base con RLS
 *    es un problema peor que el que vino a resolver.
 *    El costo declarado, MEDIDO contra prod (ensayo en transacción con `ROLLBACK`, 2026-10-13,
 *    con el rol que ejecuta): el `REFRESH` tarda **1,553 ms** y publica **285 entidades** desde
 *    13,302 pendientes, así que la copia queda bloqueada para lectura **~1.6 s, una vez por hora**.
 *
 * 3. ⭐ **El latido mide ENTREGA, no «el job corrió»** (ADR-053): `rowsAffected` son las filas
 *    PUBLICADAS. Cero es `error` y `latirCron` lo marca solo — sin `ceroEsOk`, porque acá cero
 *    nunca es legítimo: si la fuente se quedó sin filas, eso ES la noticia.
 *
 * ⚠️ Su umbral vive en `CRON_JOBS` (`db-health.service.ts`). Sin esa entrada el sensor cae en el
 * `cfg ? classify : 'ok'` y un carril parado se pinta **verde**.
 */
@Injectable()
export class CajaAutofillRefreshService {
  private readonly logger = new Logger(CajaAutofillRefreshService.name);
  private running = false;

  /**
   * ⚠️ Dos conexiones, y no es duplicación: `KNEX_NEW_DB_ADMIN` **devuelve `null`** cuando falta
   * `DATABASE_URL_NEW` (lo dice su propia factory: *«consumers chequean antes de usar»*). Si el
   * latido colgara de ella, el único caso en que este carril no puede trabajar sería también el
   * único en que no puede avisarlo — el modo de falla que la Fase OBS vino a cerrar. El refresco
   * usa la admin (sólo el dueño puede refrescar); **el latido usa la de siempre.**
   */
  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    @Inject(KNEX_NEW_DB_ADMIN) private readonly admin: Knex | null,
  ) {}

  /**
   * Cada hora en punto. La fuente son movimientos pendientes de Kepler y sus pólizas: se mueve
   * en el día, pero no en el minuto — y el refresco cuesta 1,553 ms medidos, así que 24
   * corridas/día son ~37 s de CPU. No se pone cada minuto como `mv_caja_refresh`: aquello es la BANDEJA
   * (se mira en vivo) y esto es la MEMORIA de qué cuenta usó cada entidad.
   */
  @Cron('0 7 * * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    if (process.env.ENABLE_CAJA_AUTOFILL_REFRESH === 'false') return;
    if (this.running) { this.logger.warn('Skip: refresco en curso'); return; }
    await this.refrescar().catch((e) =>
      this.logger.error(`refresco autollenado: ${e?.message ?? e}`));
  }

  async refrescar(): Promise<MedicionRefrescoAutofill> {
    this.running = true;
    const t0 = Date.now();
    // `const` y no `let`: este objeto se MUTA, nunca se reemplaza — y `prefer-const` lo exige.
    const m: MedicionRefrescoAutofill = { filas: 0, fuente: 0, antes: null, ms: 0, falla: null };

    try {
      if (!this.admin) {
        // No se puede refrescar lo que no se posee. Se DECLARA; el latido de abajo lo publica
        // como error en vez de dejar al tablero con la marca de la hora pasada.
        throw new Error('KNEX_NEW_DB_ADMIN es null (falta DATABASE_URL_NEW): nadie puede refrescar');
      }
      await this.admin.transaction(async (trx) => {
        await trx.raw(`SET LOCAL lock_timeout = '10s'`);
        // ⛔ La línea sin la cual la fuente devuelve CERO y el refresco publica el vacío.
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);

        // ── Prevuelo ───────────────────────────────────────────────────────────────────────
        // Se mira la FUENTE antes de tocar la copia: si viene vacía no se refresca, y la copia
        // buena de la hora pasada sigue sirviendo. Un dato de una hora es mejor que ninguno.
        m.fuente = Number((await trx.raw(
          `SELECT count(*)::int AS n
             FROM finance.v_caja_movimientos_pendientes
            WHERE entidad_code IS NOT NULL`,
        )).rows[0].n);

        m.antes = Number((await trx.raw(`SELECT count(*)::int AS n FROM ${MV}`)).rows[0].n);

        if (m.fuente === 0) {
          // No es una excepción: es una medición que se DECLARA. La copia no se toca.
          m.falla = 'la fuente devolvió 0 filas con el tenant puesto: no se refrescó para no '
            + 'publicar el vacío sobre la copia anterior';
          m.filas = m.antes ?? 0;
          return;
        }

        await trx.raw(`REFRESH MATERIALIZED VIEW ${MV}`);
        m.filas = Number((await trx.raw(`SELECT count(*)::int AS n FROM ${MV}`)).rows[0].n);

        if (m.filas === 0) {
          // Revierte la transacción entera: la copia anterior sobrevive.
          throw new Error(
            `la copia quedó vacía tras refrescar con ${m.fuente} filas en la fuente`,
          );
        }
      });
    } catch (e) {
      // ⚠️ El mensaje se corta por el FINAL, no por el principio: knex antepone el SQL y deja la
      // causa al final, así que un `slice(0, N)` guarda la consulta y tira el motivo — el defecto
      // medido en `cashflow_forecast_snapshot`, cuyo `error` en prod son 400 caracteres de SQL
      // que terminan a media lista de parámetros.
      // ⚠️ `[CG.143.4]` **Las DOS ramas recortan por el final.** La de `String(e)` quedó sin
      // recortar en la primera versión, y no es un caso de laboratorio: un rechazo del driver de
      // pg o un `throw` de un string no son `Error`. Si cayera por ahí, `db-health` publicaría sus
      // primeros 80 caracteres — exactamente el modo de falla que este recorte existe para cerrar.
      m.falla = (e instanceof Error ? e.message : String(e)).slice(-400);
      this.logger.error(`refresco de ${MV} NO aplicado: ${m.falla}`);
    } finally {
      this.running = false;
    }

    m.ms = Date.now() - t0;

    await latirCron(this.knex, {
      jobKey: KEY,
      label: LABEL,
      tenantId: MEGA,
      // Lo ENTREGADO: filas publicadas en la copia que el autollenado lee.
      rowsAffected: m.falla ? 0 : m.filas,
      durationMs: m.ms,
      fallas: m.falla ? [m.falla] : [],
      note: m.falla ? null : `${m.filas} entidad(es) publicadas desde ${m.fuente} pendientes`,
    });

    return m;
  }
}
