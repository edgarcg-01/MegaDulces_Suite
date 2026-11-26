import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { HrPeriodoOmitidoDto, HrPeriodosDto } from '@megadulces/contracts';

/**
 * Fase RH · frente NE · `[NE.2.2]` — EL PERIODO DE NÓMINA, DERIVADO DE ContPAQi.
 *
 * `hr.payroll_periods` es la llave del frente y llegó al 2026-11-24 con **0 filas**. Esto la
 * puebla desde `contpaqi_ods.v_nomina_pago_periodo`, que ya está dentro de la base: sin archivo,
 * sin importer y sin que nadie teclee fechas.
 *
 * ── Lo medido (prod, sólo lectura, 2026-11-24) ─────────────────────────────────────────────────
 *  · **517 fechas de pago** de nómina **ordinaria**, de 2017-01-06 a 2026-11-20, y en 2026 la
 *    cadencia es perfecta: 47 fechas sin un solo salto distinto de 7 días.
 *  · ⭐ **516 de 517 caen en viernes**; la única excepción en diez años es el **miércoles de
 *    Semana Santa de 2018**. El `CHECK` de la tabla exige viernes, así que esa fecha **se omite y
 *    se reporta** — no se fuerza, no se calla.
 *  · ⭐⭐ **El rango de días SÍ está registrado**, al contrario de lo que supuso `[NE.0.4]`. No es
 *    igual para todos —quien entra o sale a media semana trae el suyo—, pero el **rango modal** de
 *    cada fecha cubre en promedio el **98.2 %** de sus pagos (nunca menos del **90.4 %**) y en
 *    **516 de 517** es de **7 días que terminan el día del pago**: la semana es **sábado→viernes**.
 *
 * ── Qué NO entra ───────────────────────────────────────────────────────────────────────────────
 * ⛔ La nómina **extraordinaria** (`payroll_type = 'E'`): paga cualquier día y se concentra en
 * junio (PTU) y diciembre (aguinaldo). **No es una semana.** Meterla acá rompería el viernes y,
 * peor, haría que «periodo» signifique dos cosas distintas.
 *
 * ── Y lo que no se puede derivar, se DECLARA ───────────────────────────────────────────────────
 * Si el rango modal de una fecha no es de 7 días terminando en el pago, o no alcanza el consenso
 * mínimo, el periodo se escribe igual **con `starts_on`/`ends_on` en NULL** (ADR-056): medio rango
 * es peor que ninguno, y la tabla ya lo exige con un `CHECK`.
 */
@Injectable()
export class HrNominaPeriodosService {
  private readonly logger = new Logger(HrNominaPeriodosService.name);

  /** Consenso mínimo del rango modal para darlo por bueno. Medido: el mínimo real es 90.4 %. */
  static readonly CONSENSO_MINIMO = 0.8;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private run<T>(fn: (trx: Knex.Transaction, tenant: string) => Promise<T>): Promise<T> {
    const tenant = this.tenantCtx.requireTenantId();
    return this.tk.run(tenant, (trx) => fn(trx, tenant));
  }

  private static validaDesde(desde: string | undefined): string {
    const d = (desde ?? '2017-01-01').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BadRequestException('La fecha va como yyyy-MM-dd.');
    return d;
  }

  /**
   * Lo que ContPAQi dice de cada fecha de pago ordinaria: su rango modal y cuánto de esa fecha
   * cubre. ⚠️ Las fechas sin ningún rango también salen (con el modal nulo), para que ninguna se
   * pierda por el camino.
   */
  private async deContpaqi(trx: Knex.Transaction, desde: string): Promise<Array<{
    paidOn: string; pf: string | null; pt: string | null; share: number;
  }>> {
    const { rows } = await trx.raw(
      `WITH base AS (
         SELECT paid_on::date AS paid_on, period_from::date AS pf, period_to::date AS pt, count(*)::int AS n
           FROM contpaqi_ods.v_nomina_pago_periodo
          WHERE payroll_type = 'O' AND paid_on >= ?::date
            AND period_from IS NOT NULL AND period_to IS NOT NULL
          GROUP BY 1, 2, 3),
       total AS (
         SELECT paid_on::date AS paid_on, count(*)::int AS n
           FROM contpaqi_ods.v_nomina_pago_periodo
          WHERE payroll_type = 'O' AND paid_on >= ?::date
          GROUP BY 1),
       modal AS (
         SELECT DISTINCT ON (paid_on) paid_on, pf, pt, n
           FROM base ORDER BY paid_on, n DESC, pf)
       SELECT t.paid_on::text AS paid_on, m.pf::text AS pf, m.pt::text AS pt,
              COALESCE(m.n, 0)::float / NULLIF(t.n, 0) AS share
         FROM total t LEFT JOIN modal m ON m.paid_on = t.paid_on
        ORDER BY t.paid_on`,
      [desde, desde],
    );
    return rows.map((r: Record<string, unknown>) => ({
      paidOn: String(r['paid_on']),
      pf: r['pf'] === null || r['pf'] === undefined ? null : String(r['pf']),
      pt: r['pt'] === null || r['pt'] === undefined ? null : String(r['pt']),
      share: Number(r['share'] ?? 0),
    }));
  }

  /**
   * `yyyy-MM-dd`, venga como venga. ⚠️ Una columna `date` de Postgres llega a Node como **objeto
   * `Date`**, no como texto: cortar `String(fecha)` da `'Fri Oct 16'` y no `'2026-10-16'`. Lo
   * destapó la prueba contra base real — con eso roto, la idempotencia **no funcionaba**, porque
   * las llaves del mapa de lo ya existente nunca empataban.
   */
  private static iso(v: unknown): string | null {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    return String(v).slice(0, 10);
  }

  /** Viernes es `isodow = 5`. Se calcula sin husos: la fecha ya viene como `yyyy-MM-dd`. */
  private static esViernes(iso: string): boolean {
    return new Date(`${iso}T12:00:00Z`).getUTCDay() === 5;
  }

  private static dias(pf: string, pt: string): number {
    return Math.round((Date.parse(`${pt}T12:00:00Z`) - Date.parse(`${pf}T12:00:00Z`)) / 86400000) + 1;
  }

  /**
   * Escribe los periodos que falten. Idempotente; **no pisa** uno que ya existe diciendo otra
   * cosa: lo reporta. Todo en una transacción.
   */
  async sincroniza(desde?: string): Promise<HrPeriodosDto> {
    const d = HrNominaPeriodosService.validaDesde(desde);
    return this.run(async (trx, tenant) => {
      const fechas = await this.deContpaqi(trx, d);
      const existentes = new Map<string, { starts_on: string | null; ends_on: string | null }>(
        (await trx('hr.payroll_periods').where({ tenant_id: tenant }).select('paid_on', 'starts_on', 'ends_on'))
          .map((f) => [String(HrNominaPeriodosService.iso(f['paid_on'])), {
            starts_on: HrNominaPeriodosService.iso(f['starts_on']),
            ends_on: HrNominaPeriodosService.iso(f['ends_on']),
          }]),
      );
      const quien = this.tenantCtx.get()?.userId ?? null;
      const omitidos: HrPeriodoOmitidoDto[] = [];
      const nuevos: Array<Record<string, unknown>> = [];
      let yaEstaban = 0;
      let conRango = 0;
      let sinRango = 0;

      for (const f of fechas) {
        if (!HrNominaPeriodosService.esViernes(f.paidOn)) {
          // ⛔ No se fuerza ni se calla: la semana de nómina es sábado→viernes y la tabla lo exige.
          omitidos.push({
            paidOn: f.paidOn, motivo: 'no-es-viernes',
            detalle: 'La fecha de pago no cayó en viernes; el periodo semanal no la admite.',
          });
          continue;
        }
        // El rango sólo se da por bueno si son 7 días que terminan el día del pago y hay consenso.
        const sirve = f.pf !== null && f.pt !== null
          && f.pt === f.paidOn
          && HrNominaPeriodosService.dias(f.pf, f.pt) === 7
          && f.share >= HrNominaPeriodosService.CONSENSO_MINIMO;
        const starts = sirve ? f.pf : null;
        const ends = sirve ? f.pt : null;

        const ya = existentes.get(f.paidOn);
        if (ya) {
          if ((ya.starts_on ?? null) === (starts ?? null) && (ya.ends_on ?? null) === (ends ?? null)) {
            yaEstaban++;
          } else {
            omitidos.push({
              paidOn: f.paidOn, motivo: 'ya-existe-distinto',
              detalle: 'Ya hay un periodo con esa fecha de pago y declara otro rango: no se pisa.',
            });
          }
          continue;
        }
        if (sirve) conRango++; else sinRango++;
        nuevos.push({
          tenant_id: tenant,
          paid_on: f.paidOn,
          starts_on: starts,
          ends_on: ends,
          days: sirve ? 7 : null,
          // Ya se pagaron: decir «abierto» sería falso.
          status: 'pagado',
          source: 'contpaqi',
          notes: sirve
            ? `[NE.2.2] Semana sábado→viernes según ContPAQi; el rango lo declara el ${Math.round(f.share * 100)} % de los pagos de esa fecha.`
            : `[NE.2.2] Rango NO derivado: el rango modal de ContPAQi no son 7 días terminando el día del pago, o no llegó al ${Math.round(HrNominaPeriodosService.CONSENSO_MINIMO * 100)} % de consenso. Se declara desconocido.`,
          created_by: quien,
          updated_by: quien,
        });
      }

      let insertados = 0;
      if (nuevos.length) {
        const puestos = await trx('hr.payroll_periods').insert(nuevos).onConflict().ignore().returning('id');
        insertados = puestos.length;
      }
      this.logger.log(
        `[NE.2.2] periodos desde ContPAQi: universo ${fechas.length}, insertados ${insertados}, ` +
          `ya estaban ${yaEstaban}, con rango ${conRango}, sin rango ${sinRango}, omitidos ${omitidos.length}`,
      );
      return { universo: fechas.length, insertados, yaEstaban, conRango, sinRango, omitidos };
    });
  }
}
