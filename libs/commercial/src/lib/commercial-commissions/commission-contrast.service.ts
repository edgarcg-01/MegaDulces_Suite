import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { CommercialCommissionsService } from './commercial-commissions.service';

/**
 * `[RD.52]` — **El contraste: lo que el libro pagó contra lo que el motor pagaría.**
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────
 * El espejo de `[RD.51]` dejó **238 ruta-periodo de historia pagada** en la base. Eso
 * convierte una pregunta que hasta hoy se respondía a mano —*¿el motor reproduce lo que se
 * pagó?*— en una medición que se recalcula sola. Medido el 2026-10-08:
 *
 *   cuadra (<= $1)                 111    551,006.43  vs  551,006.22
 *   difiere <= 5%                   46    230,925.98  vs  231,031.08   (+105: el motor paga MAS)
 *   difiere > 5%                    22    120,555.20  vs   79,291.15
 *   el libro pago y el motor NO      9     26,932.74  vs        0.00   <- acantilado del tramo
 *   sin fuente en el motor           5      8,361.52  vs        0.00
 *                                  238    937,781.87  vs  861,328.45     delta -76,453.42
 *
 * ⭐ **111 de las 193 que pagan cuadran al peso.** Y el daño está concentrado en **14 filas**
 * que el motor tira a cero ($35,294), no repartido: eso es lo que hace que valga la pena
 * mirarlas una por una en vez de un promedio.
 *
 * ── Las tres decisiones de forma ─────────────────────────────────────────────────────────
 *
 * **1. Llama al MOTOR REAL, no a una copia de su regla.** La medición exploratoria se hizo con
 * SQL que reimplementaba el tabulador leyendo sus propias tablas; sirvió para dimensionar y
 * **no sirve para la pantalla**, porque una copia se desincroniza y el tablero se queda verde
 * midiendo una regla que ya nadie corre. Acá se invoca `computeRun(..., { dryRun: true })`.
 *
 * **2. Guarda sólo el lado del MOTOR.** El del libro ya vive en `commission_run_lines`, y
 * duplicarlo congelaría una foto que puede quedar vieja — el espejo se recargó dos veces el
 * mismo día que nació. La vista `analytics.v_rd_commission_contrast` hace el cruce, así que el
 * veredicto siempre refleja el libro **vigente**.
 *
 * **3. Es una SIMULACIÓN y vive fuera del libro mayor.** No entra en `commission_runs`: el
 * índice `una_viva_por_periodo` lo prohíbe con el espejo ocupando el lugar, y mezclar una
 * simulación con la nómina es como se terminan publicando cifras que nadie pidió.
 *
 * ⚠️ Cuesta ~12 s por quincena (lee tres fuentes de venta día por día), así que **no está en el
 * camino de lectura**: se dispara a mano, deja filas, y la pantalla lee tabla.
 */
@Injectable()
export class CommissionContrastService {
  private readonly logger = new Logger(CommissionContrastService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly commissions: CommercialCommissionsService,
  ) {}

  /**
   * Corre el motor sobre UNA quincena cerrada y guarda su resultado para contrastarlo.
   * No toca el espejo ni ninguna corrida: sólo escribe `commission_engine_lines`.
   */
  async contrastarPeriodo(periodId: string): Promise<ContrasteResultado> {
    if (!periodId) throw new NotFoundException('period_id requerido');
    const t0 = Date.now();

    // ⛔ Una quincena que TODAVIA CORRE no se contrasta. `computeRun` en modo vista previa la
    // acepta -- para eso existe la vista previa -- pero guardar ese numero parcial como "lo que
    // el motor pagaria" lo vuelve comparable con algo que no tiene contraparte: nadie la pago
    // todavia, asi que saldria `solo_el_motor` y se quedaria asi hasta que alguien lo pise.
    // `contrastarAnio` ya filtraba por `date_to < current_date`; este camino no, y el endpoint
    // acepta `{ period_id }` directo. Es el mismo defecto de siempre: un valor que PARECE
    // comparable y no lo es.
    const { rows: [per] } = await this.tk.run(async (trx) => trx.raw(
      `SELECT p.anio, p.period_no, to_char(p.date_to, 'YYYY-MM-DD') date_to,
              (p.date_to < current_date) cerrada
         FROM commercial.commission_periods p
        WHERE p.id = ? AND p.deleted_at IS NULL`, [periodId]));
    if (!per) throw new NotFoundException(`Periodo ${periodId} no existe`);
    if (!per.cerrada) {
      throw new ConflictException(
        `La quincena ${per.anio}-${per.period_no} cierra el ${per.date_to} y todavia corre: `
        + 'no hay con que contrastarla. El contraste mide lo que se PAGO contra lo que el motor '
        + 'pagaria, y a un periodo abierto no se le pago nada. Para mirar como va esta la vista previa.',
      );
    }

    // ⚠️ `dryRun` a propósito: el motor NO debe dejar una corrida. Si la dejara, chocaría con
    // el espejo en el índice de una-viva-por-periodo y, peor, una simulación entraría al libro
    // mayor de la nómina con cara de corrida buena.
    const r = await this.commissions.computeRun(periodId, { dryRun: true }) as unknown as {
      lines?: Record<string, unknown>[]; scale?: { id: string };
    };
    const lines = r.lines ?? [];
    // ⚠️ El payload trae `scale: { id }`, no `scale_id`: la columna es NOT NULL y sin esto la
    // insercion muere entera. Es la misma familia de error que el 42703 de `[RD.50]`.
    const scaleId = r.scale?.id ?? null;
    if (!scaleId) throw new NotFoundException(`El motor no devolvio escala para el periodo ${periodId}`);

    const tenantId = this.tenantCtx.requireTenantId();
    await this.tk.run(async (trx) => {
      await trx('commercial.commission_engine_lines')
        .where({ tenant_id: tenantId, period_id: periodId }).del();
      if (!lines.length) return;
      await trx('commercial.commission_engine_lines').insert(
        lines.map((l) => ({
          tenant_id: tenantId,
          period_id: periodId,
          scale_id: scaleId,
          route_code: l['route_code'],
          beneficiario: l['beneficiario'],
          subtotal: l['subtotal'] ?? null,
          venta: l['venta'] ?? null,
          costo: l['costo'] ?? null,
          markup_sobre_costo_pct: l['markup_sobre_costo_pct'] ?? null,
          pct_aplicado: l['pct_aplicado'] ?? null,
          comision: l['comision'] ?? 0,
          bonos: l['bonos'] ?? 0,
          bonos_detalle: JSON.stringify(l['bonos_detalle'] ?? []),
          nomina_banco: l['nomina_banco'] ?? 0,
          a_pagar: l['a_pagar'] ?? 0,
          motivo_no_pago: l['motivo_no_pago'] ?? null,
          dias_con_venta: l['dias_con_venta'] ?? null,
          dias_esperados: l['dias_esperados'] ?? null,
          costo_veredicto: l['costo_veredicto'] ?? null,
          fuentes: l['fuentes'] ?? null,
        })),
      );
    });

    this.logger.log(`contraste del periodo ${periodId}: ${lines.length} linea(s) · ${Date.now() - t0} ms`);
    return { period_id: periodId, lineas: lines.length, duracion_ms: Date.now() - t0 };
  }

  /**
   * Contrasta todas las quincenas CERRADAS del año que tengan espejo cargado.
   *
   * ⚠️ Son ~12 s cada una: veinte quincenas son cuatro minutos. Las fallas **no se tragan** ni
   * abortan el resto -- se devuelven junto con lo que sí se midió, porque lanzar borraría el
   * resultado parcial y obligaría a adivinar cuáles quedaron hechas.
   */
  async contrastarAnio(anio: number): Promise<ContrasteLote> {
    const tenantId = this.tenantCtx.requireTenantId();
    const { rows } = await this.tk.run(async (trx) => trx.raw(
      `SELECT p.id, p.period_no
         FROM commercial.commission_periods p
         JOIN commercial.commission_runs r
           ON r.period_id = p.id AND r.deleted_at IS NULL AND r.status <> 'anulado'
        WHERE p.tenant_id = ? AND p.anio = ? AND p.deleted_at IS NULL
          AND p.date_to < current_date
        ORDER BY p.period_no`, [tenantId, anio]));

    const hechas: number[] = [];
    const fallas: string[] = [];
    const t0 = Date.now();
    for (const p of rows as { id: string; period_no: number }[]) {
      try { await this.contrastarPeriodo(p.id); hechas.push(p.period_no); }
      catch (e) { fallas.push(`Q${p.period_no}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (fallas.length) for (const f of fallas) this.logger.error(`contraste ${anio}: ${f}`);
    this.logger.log(`contraste ${anio}: ${hechas.length} de ${rows.length} · ${Date.now() - t0} ms`);
    return { anio, periodos: rows.length, hechas, fallas, duracion_ms: Date.now() - t0 };
  }

  /**
   * `[RD.56]` **«Lo que faltó»** — la pregunta que el Excel no puede contestar.
   *
   * El tabulador es ESCALONADO: quedarse corto por poco no paga "un poco menos", paga el
   * escalón de abajo o **cero**. Medido sobre las 238 ruta-periodo del espejo:
   *
   *   ⭐ Q13 · ruta 28 · Maria Elena Valadez Limon
   *      vendio $189,643.22 — le faltaron **$356.77** — cobro **$0** en vez de **$4,827.96**
   *
   *    6 no cobraron nada estando a menos de $10,000 del piso  →  $30,264
   *   29 quedaron a menos de $5,000 del siguiente escalon       →  $18,620
   *  141 de 238 ya estan en el TOPE: para esas no hay nada que perseguir, y decirlo
   *      tambien es informacion — evita mandar a un supervisor a una ruta donde no hay nada.
   *
   * Lee vista, no calcula: medido en prod, **16 ms**.
   */
  async loQueFalto(anio: number): Promise<{ resumen: FaltoResumen[]; filas: FaltoFila[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows: filas } = await trx.raw(
        `SELECT period_no, route_code, beneficiario_nombre, zona,
                venta::float8 venta, pct_aplicado::float8 pct_aplicado,
                a_pagar::float8 a_pagar, motivo_no_pago,
                escalon_umbral::float8 escalon_umbral, escalon_pct::float8 escalon_pct,
                escalon_falta::float8 escalon_falta, escalon_ganancia::float8 escalon_ganancia,
                bono_nombre, bono_umbral::float8 bono_umbral,
                bono_falta::float8 bono_falta, bono_monto::float8 bono_monto,
                oportunidad::float8 oportunidad, cercania
           FROM analytics.v_rd_commission_lo_que_falto
          WHERE tenant_id = ? AND anio = ?
          ORDER BY period_no DESC, escalon_falta NULLS LAST`, [tenantId, anio]);

      const { rows: resumen } = await trx.raw(
        `SELECT cercania, count(*)::int n,
                round(coalesce(sum(oportunidad), 0), 2)::float8 oportunidad
           FROM analytics.v_rd_commission_lo_que_falto
          WHERE tenant_id = ? AND anio = ?
          GROUP BY cercania`, [tenantId, anio]);

      return { resumen, filas };
    });
  }

  /** Lo que lee la pantalla: una fila por ruta-periodo, ya con veredicto. Tabla, no cálculo. */
  async leer(anio: number): Promise<{ resumen: ContrasteResumen[]; filas: ContrasteFila[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const { rows: filas } = await trx.raw(
        `SELECT period_no, route_code, beneficiario_nombre, zona,
                libro_a_pagar::float8 libro_a_pagar, motor_a_pagar::float8 motor_a_pagar,
                libro_venta::float8 libro_venta, motor_venta::float8 motor_venta,
                libro_pct::float8 libro_pct, motor_pct::float8 motor_pct,
                delta_a_pagar::float8 delta_a_pagar,
                dias_con_venta, dias_esperados, veredicto, causa,
                libro_motivo, motor_motivo, computed_at
           FROM analytics.v_rd_commission_contrast
          WHERE tenant_id = ? AND anio = ?
          ORDER BY period_no, route_code`, [tenantId, anio]);

      const { rows: resumen } = await trx.raw(
        `SELECT veredicto, count(*)::int n,
                round(coalesce(sum(libro_a_pagar), 0), 2)::float8 libro,
                round(coalesce(sum(motor_a_pagar), 0), 2)::float8 motor,
                round(coalesce(sum(delta_a_pagar), 0), 2)::float8 delta
           FROM analytics.v_rd_commission_contrast
          WHERE tenant_id = ? AND anio = ?
          GROUP BY veredicto ORDER BY veredicto`, [tenantId, anio]);

      return { resumen, filas };
    });
  }
}

export interface FaltoResumen { cercania: string; n: number; oportunidad: number }
export interface FaltoFila {
  period_no: number; route_code: string;
  beneficiario_nombre: string | null; zona: string | null;
  venta: number | null; pct_aplicado: number | null;
  a_pagar: number | null; motivo_no_pago: string | null;
  escalon_umbral: number | null; escalon_pct: number | null;
  escalon_falta: number | null; escalon_ganancia: number | null;
  bono_nombre: string | null; bono_umbral: number | null;
  bono_falta: number | null; bono_monto: number | null;
  oportunidad: number | null;
  cercania: 'sin_cobrar_por_poco' | 'sin_cobrar' | 'al_alcance' | 'cerca' | 'lejos' | 'en_el_tope';
}

export interface ContrasteResultado { period_id: string; lineas: number; duracion_ms: number }
export interface ContrasteLote {
  anio: number; periodos: number; hechas: number[]; fallas: string[]; duracion_ms: number;
}
export interface ContrasteResumen {
  veredicto: string; n: number; libro: number; motor: number; delta: number;
}
export interface ContrasteFila {
  period_no: number; route_code: string;
  beneficiario_nombre: string | null; zona: string | null;
  libro_a_pagar: number | null; motor_a_pagar: number | null;
  libro_venta: number | null; motor_venta: number | null;
  libro_pct: number | null; motor_pct: number | null;
  delta_a_pagar: number | null;
  dias_con_venta: number | null; dias_esperados: number | null;
  veredicto: string; causa: string | null;
  libro_motivo: string | null; motor_motivo: string | null;
  computed_at: string | null;
}
