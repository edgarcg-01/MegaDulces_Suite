import { Injectable, Inject, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB_ADMIN, TenantContextService } from '@megadulces/platform-core';
import { HEALTH_NOTIFIER_PORT, type HealthNotifierPort } from '@megadulces/contracts';
import { CommercialCommissionsService } from './commercial-commissions.service';

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/**
 * `[RD.87]` — **La quincena que cierra se calcula sola. Nunca se aprueba ni se paga sola.**
 *
 * ── El problema que resuelve ─────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-20: **20 corridas, todas `origen = 'libro'`**, y la única
 * manera de producir el número de una quincena era que alguien se acordara de apretar
 * «calcular desde». *Depender de que alguien se acuerde no es un proceso: es una costumbre.*
 *
 * ── ⛔ Por qué esto NO contradice el retiro del cron de `[RD.22]` ────────────────────────
 * Aquel cron despertaba **48 veces al día** —cada 30 minutos— para reescribir la quincena en
 * curso: una cifra de nómina **moviéndose sola**. Eso se retiró con razón y no vuelve.
 *
 * Esto es otra cosa: **un chequeo diario de una condición de fecha**. Un hecho que ocurre 24
 * veces al año no tiene scheduler propio en esta plataforma, así que se detecta mirando una vez
 * al día si ya pasó. Y lo que importaba de `[RD.78]` no era el disparador — era **la
 * condición**.
 *
 * ── ⭐⭐ La condición, que es la parte que decide ────────────────────────────────────────
 *
 *     cerró la quincena (date_to < hoy) y no tiene corrida
 *            └─ ¿la fuente de TODAS las rutas vigentes está viva?
 *                  ├─ sí  → calcula y deja la corrida en BORRADOR
 *                  └─ no  → NO calcula. Nombra las rutas y espera.
 *
 * **Calcular con la fuente incompleta no produce «un número aproximado»: produce $0**, porque
 * el tabulador es un acantilado y una ruta con 9 de 14 días queda debajo del primer escalón.
 * *Un motor que calcula sin fuente es peor que uno que no calcula, porque el cero se ve como un
 * resultado.*
 *
 * ⭐ **El clasificador no se inventa acá**: se usa `fuente_estado` de
 * `analytics.v_rd_commission_universe`, que ya está medido y justificado (`[RD.71]`: con 3 días
 * las nueve rutas que operan normal salen `viva` y ninguna da falso positivo; la 504, con 18
 * días sin reportar, cae en `rezagada`). Inventar un umbral nuevo acá sería un segundo criterio
 * para la misma pregunta.
 *
 * ⚠️ **Límite declarado:** `fuente_estado` se mide contra `current_date`, no contra el periodo.
 * Para la quincena que acaba de cerrar eso es casi lo mismo. Para una quincena vieja que quedó
 * sin calcular, «viva hoy» no prueba que el dato estuviera completo entonces — sólo que el feed
 * no murió. Es suficiente para no calcular sobre un hueco abierto, y **no** sustituye mirar la
 * cobertura de días, que la corrida publica igual.
 *
 * ── ⛔ Lo que NO hace, y es deliberado ───────────────────────────────────────────────────
 * **Deja `borrador`.** No aprueba, no paga (ADR-016). Un borrador no puede pasar a `pagado` sin
 * que una persona lo apruebe —`setStatus` lo exige— así que el alcance de un error acá es *«hay
 * una corrida de más para revisar»*, nunca *«se depositó algo»*.
 */
/** `[RD.87]` Una ruta que no se puede calcular porque su fuente no esta viva. */
interface RutaRezagada { route_code: string; fuente_estado: string; dias_sin_dato: number | null }

@Injectable()
export class CommissionAutoRunService {
  private readonly logger = new Logger(CommissionAutoRunService.name);

  constructor(
    @Inject(KNEX_NEW_DB_ADMIN) private readonly adminKnex: Knex | null,
    private readonly tenantCtx: TenantContextService,
    private readonly commissions: CommercialCommissionsService,
    @Optional() @Inject(HEALTH_NOTIFIER_PORT) private readonly notifier?: HealthNotifierPort,
  ) {}

  /**
   * 07:30 MX — **después** del refresh nocturno (06:20) y del comparador de cierres (07:10).
   * Calcular contra matvistas sin refrescar produciría una corrida que se desmiente sola a los
   * veinte minutos, y una cifra de nómina que cambia enseña a no creerle a la pantalla.
   */
  @Cron('0 30 7 * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    try {
      await this.revisar('cron');
    } catch (e) {
      // ⛔ No se re-lanza desde el cron: un automatismo que se cae deja de automatizar EN
      // SILENCIO, que es peor que una corrida con error. Se registra y se sigue.
      this.logger.error(`[RD.87] la revision automatica fallo: ${(e as Error).message}`);
    }
  }

  /**
   * Revisa las quincenas cerradas sin corrida y calcula las que tienen la fuente completa.
   * Devuelve qué hizo con cada una — `calculada` | `esperando_fuente` | `fallo`.
   */
  async revisar(source: 'cron' | 'manual' = 'manual'): Promise<RevisionAuto> {
    const admin = this.adminKnex;
    if (!admin) {
      this.logger.debug('[RD.87] skip: KNEX_NEW_DB_ADMIN no disponible');
      return { revisadas: 0, resultados: [] };
    }

    const { rows: pendientes } = await admin.raw(
      `SELECT p.id, p.anio, p.period_no,
              to_char(p.date_from,'YYYY-MM-DD') AS date_from,
              to_char(p.date_to,'YYYY-MM-DD')   AS date_to,
              (current_date - p.date_to)        AS dias_desde_cierre
         FROM commercial.commission_periods p
         LEFT JOIN commercial.commission_runs r
                ON r.period_id = p.id AND r.deleted_at IS NULL
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL
          AND p.date_to < current_date AND r.id IS NULL
        ORDER BY p.date_from`, [MEGA]);

    const resultados: ResultadoAuto[] = [];
    for (const p of pendientes) {
      // ⚠️ Las rutas VIGENTES en ESE periodo, con la regla de `[RD.84.0]`: una ruta dada de baja
      // después no tiene por qué frenar el cálculo de una quincena en que sí operaba.
      const { rows: rezagadas } = await admin.raw(
        `SELECT u.route_code, u.fuente_estado, u.dias_sin_dato
           FROM analytics.v_rd_commission_universe u
           JOIN commercial.commission_route_config c
                 ON c.tenant_id = u.tenant_id AND c.route_code = u.route_code
                AND c.deleted_at IS NULL
          WHERE u.tenant_id = ?
            AND (c.activo_desde IS NULL OR c.activo_desde <= ?::date)
            AND (c.activo OR (c.activo_hasta IS NOT NULL AND c.activo_hasta >= ?::date))
            AND u.fuente_estado <> 'viva'
          ORDER BY u.dias_sin_dato DESC NULLS FIRST`,
        [MEGA, p.date_to, p.date_from]);

      if (rezagadas.length) {
        const detalle = rezagadas
          .map((r: RutaRezagada) => `${r.route_code} (${r.fuente_estado}`
            + `${r.dias_sin_dato == null ? '' : `, ${r.dias_sin_dato} d`})`)
          .join(', ');
        this.logger.warn(
          `[RD.87] Q${p.period_no}/${p.anio} NO se calcula: ${rezagadas.length} ruta(s) sin `
          + `fuente viva — ${detalle}`);
        resultados.push({
          period_id: p.id, anio: p.anio, period_no: p.period_no,
          estado: 'esperando_fuente',
          detalle: `${rezagadas.length} ruta(s) sin fuente viva: ${detalle}`,
          rutas: rezagadas.map((r: RutaRezagada) => r.route_code),
        });
        // ⭐ El aviso es RARO por diseño. Una quincena que cierra el lunes y espera el martes es
        // normal; una que lleva tres días esperando es una ruta que dejó de reportar, y eso lo
        // tiene que ver alguien el mismo día. Avisar todos los días enseñaría a ignorarlo.
        if (Number(p.dias_desde_cierre) >= 3) {
          await this.avisar(
            `Comision RD: Q${p.period_no}/${p.anio} sin calcular`,
            `${rezagadas.length} ruta(s) sin fuente viva: ${detalle}. El tabulador es un `
            + 'acantilado: calcular sin dias completos paga $0, no "un poco menos".',
            `${p.dias_desde_cierre} dias`);
        }
        continue;
      }

      try {
        // El cálculo corre acá, en el worker, no en el hilo de una petición. Son ~5.7 s por
        // quincena: en un request serían 5.7 s de pantalla en blanco (`[RD.54]`).
        const run = await this.tenantCtx.run(
          { tenantId: MEGA, roleName: 'system' },
          () => this.commissions.computeRun(p.id),
        );
        this.logger.log(
          `[RD.87] Q${p.period_no}/${p.anio} calculada en BORRADOR (${(run as { id?: string } | null)?.id ?? '?'}) `
          + `por ${source}. No se aprueba ni se paga sola.`);
        resultados.push({
          period_id: p.id, anio: p.anio, period_no: p.period_no,
          estado: 'calculada', detalle: 'queda en borrador, esperando aprobación humana',
          rutas: [],
        });
      } catch (e) {
        const msg = (e as Error).message;
        this.logger.error(`[RD.87] Q${p.period_no}/${p.anio} fallo al calcular: ${msg}`);
        resultados.push({
          period_id: p.id, anio: p.anio, period_no: p.period_no,
          estado: 'fallo', detalle: msg, rutas: [],
        });
      }
    }

    return { revisadas: pendientes.length, resultados };
  }

  /**
   * ⚠️ El puerto es `notifyCritical(HealthAlertItem[])` y es **best-effort por contrato**: no
   * lanza y devuelve si alguien recibió. Se consulta `isConfigured()` antes de armar el mensaje,
   * que es la convención de la casa — sin credenciales, no-op con warning, nunca crash.
   */
  private async avisar(label: string, motivo: string, edad: string): Promise<void> {
    if (!this.notifier?.isConfigured()) return;
    try {
      await this.notifier.notifyCritical([
        { key: 'rd_comisiones_sin_calcular', label, motivo, age_human: edad },
      ]);
    } catch (e) {
      // Que falle el aviso no puede tumbar la revisión: el trabajo ya está hecho o declarado.
      this.logger.warn(`[RD.87] no se pudo avisar: ${(e as Error).message}`);
    }
  }
}

export interface ResultadoAuto {
  period_id: string; anio: number; period_no: number;
  estado: 'calculada' | 'esperando_fuente' | 'fallo';
  detalle: string;
  /** Las rutas que frenan el cálculo. Vacío cuando no frena ninguna. */
  rutas: string[];
}
export interface RevisionAuto { revisadas: number; resultados: ResultadoAuto[] }
