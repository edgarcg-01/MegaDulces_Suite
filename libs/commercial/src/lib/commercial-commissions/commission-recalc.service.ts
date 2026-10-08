import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { CommercialCommissionsService } from './commercial-commissions.service';

/**
 * `[RD.22]` — **El unico camino que ESCRIBE una corrida: recalcular desde una quincena.**
 *
 * ── Por que esto reemplaza al cron ───────────────────────────────────────────────────────
 * `[RD.20]`/`[RD.21]` habian puesto dos relojes: uno diario a las 08:30 para la quincena cerrada
 * y otro cada 30 min para la que todavia corria. Los dos se retiraron el 2026-10-07, por decision
 * de negocio y con razon:
 *
 *   ⭐ **Una quincena cerrada es un valor estatico.** Se calcula una vez y no cambia. Un reloj
 *      que despierta 48 veces al dia para un hecho que ocurre 24 veces al AÑO esta mal planteado
 *      de origen -- y el que reescribia la quincena en curso cada media hora hacia que una cifra
 *      de nomina se moviera sola, que es lo contrario de lo que esa cifra tiene que ser.
 *
 *   ⚠️ Ademas, la justificacion que yo le habia puesto al cron diario ("el carril puede venir
 *      atrasado, asi que se reintenta") **nunca se midio**. Era una premisa escrita como ley.
 *
 * ── Lo que hace ──────────────────────────────────────────────────────────────────────────
 * Calcula la quincena indicada y **todas las cerradas que le siguen**, en orden. Es el mismo
 * acto las dos veces que hace falta:
 *   · cuando cierra una quincena y hay que producir su numero por primera vez;
 *   · cuando cambia la escala y hay que reconvertir desde el periodo en que aplica.
 *
 * ── Lo que NO hace ───────────────────────────────────────────────────────────────────────
 * ⛔ **No toca lo pagado.** Una corrida `pagado` se SALTA con su motivo y el lote sigue: es un
 * deposito que ya ocurrio, no un calculo pendiente. Si la escala cambio con efecto retroactivo,
 * la diferencia entra como ajuste en la quincena siguiente. Lo mismo con `aprobado`, que lleva
 * una firma: se anula a mano primero, y ese acto queda registrado.
 *
 * ⛔ **No aprueba ni paga.** ADR-016 entero: el motor calcula, la persona autoriza.
 *
 * ⛔ **No calcula la quincena abierta.** `computeRun` la rechaza. Para mirar como va esta la
 * vista previa, que no deja fila.
 *
 * ⚠️ Un periodo saltado **no corta el lote**: cada quincena se calcula sobre su propio rango de
 * fechas, no acumula contra la anterior, asi que saltar Q13 no invalida Q14. Lo que no se puede
 * es esconder el salto, y por eso vuelve enumerado en la respuesta.
 */
@Injectable()
export class CommissionRecalcService {
  private readonly logger = new Logger(CommissionRecalcService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly commissions: CommercialCommissionsService,
  ) {}

  /**
   * Las quincenas CERRADAS desde `periodId` (incluida) en adelante, con el estado de su corrida
   * viva. Sale de la DB con el `current_date` de la DB -- no de `new Date()`, que es UTC y
   * adelanta el dia seis horas en Mexico.
   */
  private async aRecalcular(periodId: string) {
    return this.tk.run(async (trx) => {
      const { rows: [ancla] } = await trx.raw(
        `SELECT anio, period_no, to_char(date_to, 'YYYY-MM-DD') AS date_to
           FROM commercial.commission_periods
          WHERE id = ? AND deleted_at IS NULL`,
        [periodId],
      );
      if (!ancla) throw new NotFoundException(`Periodo ${periodId} no existe`);

      const { rows } = await trx.raw(
        `SELECT p.id, p.anio, p.period_no,
                to_char(p.date_to, 'YYYY-MM-DD') AS date_to,
                r.status AS run_status
           FROM commercial.commission_periods p
           LEFT JOIN commercial.commission_runs r
             ON r.period_id = p.id AND r.deleted_at IS NULL AND r.status <> 'anulado'
          WHERE p.tenant_id = ?
            AND p.deleted_at IS NULL
            AND (p.anio, p.period_no) >= (?, ?)
            AND p.date_to < current_date
          ORDER BY p.anio, p.period_no`,
        [this.tenantCtx.requireTenantId(), ancla.anio, ancla.period_no],
      );
      return { ancla, periodos: rows as PeriodoRow[] };
    });
  }

  async recalcularDesde(periodId: string): Promise<RecalcResultado> {
    if (!periodId) throw new NotFoundException('period_id requerido');
    const t0 = Date.now();
    const { ancla, periodos } = await this.aRecalcular(periodId);

    const calculadas: RecalcCalculada[] = [];
    const saltadas: RecalcSaltada[] = [];
    const fallas: string[] = [];

    for (const p of periodos) {
      const etiqueta = `Q${p.period_no}/${p.anio}`;
      if (p.run_status === 'pagado' || p.run_status === 'aprobado') {
        saltadas.push({
          anio: p.anio, period_no: p.period_no, run_status: p.run_status,
          motivo: p.run_status === 'pagado'
            ? 'ya esta pagada: es un deposito que ocurrio, no un calculo. La diferencia va como ajuste en la siguiente.'
            : 'ya esta aprobada: lleva una firma. Anulala a mano y vuelve a correr esto.',
        });
        continue;
      }
      try {
        const r = await this.commissions.computeRun(p.id, { origen: 'manual', replace: true });
        calculadas.push({
          anio: p.anio, period_no: p.period_no,
          run_id: String(r.run_id), status: String(r.status),
          gates: (r.gates ?? []).filter((g) => g.estado !== 'pasa').map((g) => `${g.gate}:${g.estado}`),
        });
      } catch (e) {
        fallas.push(`${etiqueta}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const bloqueadas = calculadas.filter((c) => c.status === 'bloqueada').length;
    this.logger.log(
      `recalcular desde Q${ancla.period_no}/${ancla.anio}: ${periodos.length} cerrada(s) en el rango · `
      + `${calculadas.length} calculada(s) (${bloqueadas} bloqueada(s)) · ${saltadas.length} saltada(s)`
      + `${fallas.length ? ` · ${fallas.length} falla(s)` : ''} · ${Date.now() - t0} ms`,
    );

    // ⚠️ Las fallas NO se tragan: esto lo dispara una persona y tiene que enterarse. Pero se
    // devuelven junto con lo que SI se calculo, porque lanzar borraria el resultado parcial y
    // obligaria a adivinar cuales quincenas quedaron hechas.
    return {
      desde: { anio: ancla.anio, period_no: ancla.period_no },
      revisados: periodos.length,
      calculadas,
      saltadas,
      fallas,
      duracion_ms: Date.now() - t0,
    };
  }
}

interface PeriodoRow {
  id: string; anio: number; period_no: number; date_to: string; run_status: string | null;
}
export interface RecalcCalculada {
  anio: number; period_no: number; run_id: string; status: string; gates: string[];
}
export interface RecalcSaltada {
  anio: number; period_no: number; run_status: string; motivo: string;
}
export interface RecalcResultado {
  desde: { anio: number; period_no: number };
  revisados: number;
  calculadas: RecalcCalculada[];
  saltadas: RecalcSaltada[];
  fallas: string[];
  duracion_ms: number;
}
