import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantContextService, latirCron } from '@megadulces/platform-core';
import { CommercialCommissionsService } from './commercial-commissions.service';

/**
 * `[RD.20]` — **La quincena se calcula sola al cerrar.**
 *
 * ── Por que existe ───────────────────────────────────────────────────────────────────────
 * Medido contra prod el 2026-10-07: el motor de comisiones esta **completo y desplegado desde
 * el 2026-09-08**, con sus 7 tablas, su escala sembrada, sus 27 quincenas y su pantalla -- y
 * tiene **CERO corridas**. Nunca se ejercio. Se sigue pagando con el Excel.
 *
 * No es un problema de funcionalidad: es que calcular dependia de que alguien se acordara de
 * abrir la pantalla, apretar *Vista previa*, cuadrar contra el libro y recien ahi crear el
 * borrador. Un motor que solo arranca si alguien lo invoca compite con la costumbre, y la
 * costumbre gana. Este cron le quita esa competencia: **la corrida ya esta hecha cuando la
 * persona llega**.
 *
 * ── Lo que NO hace, y es el punto ────────────────────────────────────────────────────────
 * ⛔ **No aprueba ni paga.** ADR-016 sigue entero: el motor calcula, el humano autoriza. Lo
 * unico que automatiza es el trabajo mecanico -- y ni siquiera eso cuando el dato no da: una
 * corrida que no pasa una compuerta dura nace **`bloqueada`**, que es un estado desde el que
 * *no se puede aprobar*. Si naciera `borrador` quedaria a un clic de pagarse, y la compuerta
 * seria decorativa.
 *
 * ── Por que diario y no "al cerrar la quincena" ──────────────────────────────────────────
 * La quincena cierra cada 14 dias, pero el DATO no esta completo ese mismo instante: el carril
 * que alimenta `route_push_lines` sube cada 15 min y puede venir atrasado. Un cron diario
 * reintenta solo: el dia que la frescura alcanza, la compuerta pasa y la corrida se rehace.
 * Por eso tambien **reemplaza su propia corrida bloqueada** -- y nunca una que un humano ya
 * toco (`aprobado`/`pagado`/`anulado`), ni una `borrador` que no haya creado el cron.
 *
 * ── El latido ────────────────────────────────────────────────────────────────────────────
 * ⭐ `ceroEsOk` **con motivo**: la mayoria de los dias no hay quincena pendiente, y sin esa
 * declaracion el latido pintaria rojo todos los dias y nadie lo miraria a los tres. Lo que si
 * es error es que haya quincena pendiente y no se escriba ninguna corrida.
 *
 * ⚠️ Sin su entrada en `CRON_JOBS` (`db-health.service.ts`) esto no sirve: el sensor cae en el
 * `cfg ? classify : 'ok'` y un cron parado se ve **verde**. Van juntos.
 */
@Injectable()
export class CommissionRunnerService {
  private readonly logger = new Logger(CommissionRunnerService.name);

  /** Cuanto hacia atras mira. Dos quincenas: reintenta la anterior si quedo bloqueada. */
  private static readonly VENTANA_DIAS = 30;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tenantCtx: TenantContextService,
    private readonly commissions: CommercialCommissionsService,
  ) {}

  /** 08:30 MX — despues de que los carriles de la noche terminaron de subir la venta. */
  @Cron('0 30 8 * * *', { timeZone: 'America/Mexico_City' })
  async scheduled(): Promise<void> {
    await this.run('cron');
  }

  /**
   * `[RD.21]` Cada 30 min, **la quincena que todavia corre**.
   *
   * La pantalla no tiene botones: abre, lee una tabla y verifica. Para que "actualizada" sea
   * cierto y no una aspiracion, alguien tiene que recalcular el periodo abierto — y ese alguien
   * no puede ser la persona que mira, porque calcular cuesta ~8.5 s y leer cuesta 2 ms.
   *
   * ⚠️ Cada 30 min, no cada 15: la fuente (`route_push_lines`) sube cada 15, asi que ir mas
   * seguido gastaria el doble para ver la misma cifra. Y la corrida nace `en_curso`, estado
   * desde el que **no se puede aprobar** — refrescar la quincena abierta no la acerca ni un
   * paso al pago.
   */
  @Cron('0 5,35 * * * *', { timeZone: 'America/Mexico_City' })
  async refrescarEnCurso(): Promise<void> {
    await this.run('cron', { soloEnCurso: true });
  }

  /**
   * Calcula las quincenas cerradas que no tienen corrida viva (o cuya corrida la dejo bloqueada
   * este mismo cron). Devuelve lo que hizo. **Nunca aprueba.**
   *
   * No lanza cuando lo invoca el cron: un runner que se cae deja de correr en silencio, que es
   * peor que una corrida con error. El fallo queda en el latido, y se re-lanza solo para el
   * humano que lo pidio a mano.
   */
  async run(
    source: 'cron' | 'manual' = 'manual',
    opts: { soloEnCurso?: boolean } = {},
  ): Promise<{
    revisados: number;
    calculadas: { period_no: number; anio: number; run_id: string; status: string; gates: string[] }[];
    fallas: string[];
  }> {
    const t0 = Date.now();
    const calculadas: { period_no: number; anio: number; run_id: string; status: string; gates: string[] }[] = [];
    const fallas: string[] = [];
    let revisados = 0;

    let tenants: { id: string }[] = [];
    try {
      tenants = await this.knex('identity.tenants').whereNull('deleted_at').select('id');
    } catch (e) {
      const msg = `no se pudo listar tenants: ${e instanceof Error ? e.message : String(e)}`;
      if (source === 'manual') throw e;
      fallas.push(msg);
    }

    for (const t of tenants) {
      try {
        await this.tenantCtx.run({ tenantId: t.id, roleName: 'system' }, async () => {
          const pendientes = await this.pendientes(t.id, opts.soloEnCurso === true);
          revisados += pendientes.length;
          for (const p of pendientes) {
            try {
              const r = await this.commissions.computeRun(p.id, {
                origen: 'cron',
                // Solo reemplaza lo que el propio cron dejo bloqueado. Una corrida que un
                // humano abrio o aprobo no se toca.
                replace: p.replace,
              });
              calculadas.push({
                anio: p.anio, period_no: p.period_no,
                run_id: String(r.run_id), status: String(r.status),
                gates: (r.gates ?? []).filter((g) => g.estado !== 'pasa').map((g) => `${g.gate}:${g.estado}`),
              });
            } catch (e) {
              fallas.push(`Q${p.period_no}/${p.anio}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        });
      } catch (e) {
        fallas.push(`tenant ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const bloqueadas = calculadas.filter((c) => c.status === 'bloqueada').length;
    await latirCron(this.knex, {
      jobKey: 'rd_commission_runner',
      label: 'Comisiones RD — corrida automatica de la quincena',
      tenantId: tenants[0]?.id ?? '00000000-0000-0000-0000-00000000d01c',
      rowsAffected: calculadas.length,
      durationMs: Date.now() - t0,
      fallas,
      note: calculadas.length
        ? `${calculadas.length} corrida(s): ${calculadas.length - bloqueadas} borrador, ${bloqueadas} bloqueada(s)`
        : null,
      // ⭐ Cero legitimo CON motivo: 13 de cada 14 dias no cierra ninguna quincena. Sin esto el
      // latido pintaria rojo a diario y el tablero se vuelve ruido.
      ceroEsOk: revisados === 0
        ? 'no habia quincena cerrada sin corrida: el cron corrio y no tenia que escribir nada'
        : undefined,
    });

    if (fallas.length && source === 'manual') {
      throw new Error(`La corrida automatica fallo: ${fallas.join(' | ')}`);
    }
    this.logger.log(
      `[${source}] ${revisados} quincena(s) pendiente(s) · ${calculadas.length} calculada(s) ` +
      `(${bloqueadas} bloqueada(s))${fallas.length ? ` · ${fallas.length} falla(s)` : ''}`,
    );
    return { revisados, calculadas, fallas };
  }

  /**
   * Las quincenas que toca calcular: cerradas, dentro de la ventana, y **sin una corrida que un
   * humano haya tocado**. `replace` sale verdadero solo para la corrida que el propio cron dejo
   * bloqueada -- reintentarla es el punto de correr a diario.
   */
  private async pendientes(tenantId: string, soloEnCurso: boolean) {
    // ⚠️ Las dos ramas comparten el mismo freno: no se toca una corrida que un humano abrio
    // (`borrador` creada a mano) ni una ya `aprobado`/`pagado`. El cron solo reemplaza lo que
    // el propio cron dejo, y solo mientras no se pueda aprobar.
    const { rows } = soloEnCurso
      ? await this.knex.raw(
        `SELECT p.id, p.anio, p.period_no, r.status AS run_status
           FROM commercial.commission_periods p
           LEFT JOIN commercial.commission_runs r
             ON r.period_id = p.id AND r.deleted_at IS NULL AND r.status <> 'anulado'
          WHERE p.tenant_id = ?
            AND p.deleted_at IS NULL
            AND current_date BETWEEN p.date_from AND p.date_to
            AND (r.id IS NULL OR (r.status = 'en_curso' AND r.origen = 'cron'))
          ORDER BY p.anio, p.period_no`,
        [tenantId],
      )
      : await this.knex.raw(
        `SELECT p.id, p.anio, p.period_no, r.status AS run_status
           FROM commercial.commission_periods p
           LEFT JOIN commercial.commission_runs r
             ON r.period_id = p.id AND r.deleted_at IS NULL AND r.status <> 'anulado'
          WHERE p.tenant_id = ?
            AND p.deleted_at IS NULL
            AND p.date_to < current_date
            AND p.date_to >= current_date - ?::int
            AND (r.id IS NULL
                 OR (r.status IN ('bloqueada','en_curso') AND r.origen = 'cron'))
          ORDER BY p.anio, p.period_no`,
        [tenantId, CommissionRunnerService.VENTANA_DIAS],
      );
    return rows.map((r: { id: string; anio: number; period_no: number; run_status: string | null }) => ({
      id: r.id,
      anio: r.anio,
      period_no: r.period_no,
      // La quincena que acaba de cerrar trae la corrida `en_curso` del dia anterior: hay que
      // reemplazarla para que pase a `borrador` con el periodo completo.
      replace: r.run_status === 'bloqueada' || r.run_status === 'en_curso',
    }));
  }
}
