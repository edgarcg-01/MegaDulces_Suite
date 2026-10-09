import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';

/**
 * `[RD.57]` — **¿La ruta gana dinero?** Que no es la pregunta que contesta la comisión.
 *
 * ── Por qué es una pantalla y no una pestaña ─────────────────────────────────────────────
 * `/comercial/comisiones` responde *cuánto cobra cada persona*. Esto responde *qué queda
 * después del costo de la mercancía, del combustible y de la propia comisión*. El libro
 * `INDICADORES RD 2026` tiene los dos números en hojas separadas y nadie los pone uno al lado
 * del otro — ésa es toda la tesis.
 *
 * ── Las cuatro decisiones de medición, y por qué ─────────────────────────────────────────
 *
 * **1. ⭐ La utilidad bruta se calcula sobre el SUBTOTAL, nunca sobre `venta`.**
 * `commission_run_lines` trae las dos: `subtotal` sin IVA y `venta` con IVA. El costo es sin
 * IVA. Medido en la ruta 21 de la quincena 19: `(194,346.03 − 164,065.25) / 164,065.25 =
 * 18.4565%`, que es exactamente el `markup_sobre_costo_pct` que ya guarda el renglón. Usar
 * `venta` como base inflaría el margen ~16 puntos **sin que nada se vea raro**.
 *
 * **2. ⛔ El gasto NO se prorratea a la ruta.** La contabilidad llega al DEPARTAMENTO
 * (`1-01-10-20` RD PADRE HIDALGO · `1-03-50-51` CANINDO RD · `1-02-32-98` MORELIA MADERO RD)
 * y el comentario de las líneas de combustible dice literalmente "combustible rd". Repartirlo
 * por venta o por kilómetros sería inventar un dato que nadie capturó (ADR-056). Va en su
 * propio bloque, a nivel plaza, con su nombre.
 *
 * **3. ⛔ La comisión no se resta dos veces.** El gasto del departamento **ya incluye**
 * `COMISIONES DE VENTAS` ($1,057,960 en 2026). El resultado de la plaza es
 * `utilidad bruta − gasto del departamento`, y la comisión del libro se publica **al lado**,
 * como contraste, no como una resta adicional.
 *
 * **4. ⭐ Y ese contraste destapa un hueco.** El libro paga `comisión + bonos` por **$1,721,128**
 * en 2026; la contabilidad registra **$1,057,960** en los tres departamentos de RD. Faltan
 * **$663,168**, en las 14 quincenas medidas, sin una sola excepción. La hipótesis del rezago
 * (que la comisión de la quincena N se contabilice en la N+1) **se probó y no lo explica**:
 * con rezago el delta sigue entre −$28k y −$42k. Lo más probable es que los bonos y el 20% del
 * supervisor se registren bajo otro concepto o en otro departamento (`FINANZAS` tiene $474,714
 * de "comisión" sin desagregar). **Se declara con monto; no se netea ni se esconde.**
 *
 * ── Lo que esta pantalla NO puede decir, y lo dice ───────────────────────────────────────
 *   · `$/litro` y `km/l`: no hay litros. El CFDI guarda sólo el encabezado y el XML completo
 *     existe en 105 de 6,241 facturas del proveedor de combustible.
 *   · Kilómetros de **Canindo 501-505**: esas camionetas no tienen GPS.
 *   · Kilómetros **antes del 2026-07-27**: ahí arranca la historia de posiciones.
 */
@Injectable()
export class RouteProfitService {
  private readonly logger = new Logger(RouteProfitService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * `[RD.58]` — **Quién viene empeorando.** Una foto de una quincena no contesta eso.
   *
   * Devuelve la serie por ruta a lo largo del año y, sobre ella, la **tendencia**: las últimas
   * tres quincenas contra las tres anteriores. Es la pregunta que el libro no puede contestar
   * porque cada quincena vive en su propia hoja.
   *
   * ⛔ **Sin meta, y se declara.** `budget.sales_plan_lines` tiene las 13 rutas de RD con 13
   * periodos cada una, pero medido el 2026-10-08 los **tres** presupuestos cargados están en
   * `borrador`, ninguno autorizado, uno marcado `is_test` y el único de 2026 se llama
   * literalmente `prueba 2`. Además hay **tres filas por (ruta, periodo)** con montos distintos
   * (461,357 / 574,368 / 574,368 en el periodo 1 de la ruta 21), así que unir sin elegir
   * presupuesto **triplica la meta**. Publicar cumplimiento contra eso sería publicar una cifra
   * inventada: la pantalla dice que no hay meta, no dibuja una.
   *
   * ⚠️ **Las dos series no cubren lo mismo.** El margen existe desde la primera quincena pagada;
   * los kilómetros arrancan el **2026-07-27**, cuando empieza la historia de posiciones. Por eso
   * cada tendencia trae su propio conteo de quincenas comparables, y la que no alcanza para
   * comparar sale `sin_base`, no en cero.
   */
  async serie(anio?: number): Promise<SeriePeriodo> {
    const year = anio && Number.isFinite(anio) ? anio : new Date().getFullYear();
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(`
        WITH per AS (
          SELECT p.id, p.anio, p.period_no, p.date_from, p.date_to
            FROM commercial.commission_periods p
           WHERE p.anio = ?
        ), ventana AS (
          SELECT min(date_from) AS desde, max(date_to) AS hasta FROM per
        ), lin AS (
          SELECT per.period_no,
                 (per.date_to - per.date_from + 1)::int AS dias_de_la_quincena,
                 l.route_code, l.beneficiario_nombre AS chofer, l.zona,
                 l.subtotal, l.costo, l.comision, l.bonos, l.motivo_no_pago
            FROM per
            JOIN commercial.commission_runs r
              ON r.period_id = per.id AND r.deleted_at IS NULL
            JOIN commercial.commission_run_lines l
              ON l.run_id = r.id AND l.deleted_at IS NULL AND l.beneficiario = 'chofer'
        ), km AS (
          -- ⚠️ El filtro por la ventana completa va ANTES de cruzar con los periodos: sin eso
          -- la vista de kilómetros se recorre una vez por quincena.
          SELECT per.period_no, k.route_code,
                 sum(k.km)::bigint AS km,
                 count(k.km)::int AS dias_medidos,
                 count(*)::int AS dias_con_senal
            FROM ventana v
            JOIN analytics.v_rd_route_km_daily k
              ON k.dia >= v.desde AND k.dia <= v.hasta
            JOIN per ON k.dia >= per.date_from AND k.dia <= per.date_to
           GROUP BY 1,2
        )
        SELECT li.route_code, li.chofer, li.zona, li.period_no,
               round(li.subtotal, 2) AS subtotal,
               round(li.costo, 2) AS costo,
               round(li.subtotal - li.costo, 2) AS utilidad_bruta,
               CASE WHEN li.subtotal > 0
                    THEN round((li.subtotal - li.costo) / li.subtotal * 100, 2) END AS margen_pct,
               round(li.comision + li.bonos, 2) AS comision,
               li.motivo_no_pago,
               k.km, k.dias_medidos, k.dias_con_senal, li.dias_de_la_quincena,
               -- ⛔⛔ El $/km SÓLO sale con la quincena completa de GPS. Medido el 2026-10-08:
               -- la Q15 tenía 3 días de señal de 14 y la Q16 once, así que dividir la venta de
               -- catorce días entre tres kilómetros daba $373 contra los ~$210 de una quincena
               -- entera, y las SEIS rutas con GPS salían «empeorando» a la vez. No empeoraron:
               -- se completó la medición. Es el denominador incompleto de [IC.8].
               CASE WHEN k.km > 0 AND k.dias_con_senal >= li.dias_de_la_quincena
                    THEN round(li.subtotal / k.km, 2) END AS venta_por_km,
               CASE WHEN k.km IS NULL THEN 'sin_gps'
                    WHEN k.dias_con_senal < li.dias_de_la_quincena THEN 'parcial'
                    ELSE 'completa' END AS cobertura_km
          FROM lin li
          LEFT JOIN km k ON k.route_code = li.route_code AND k.period_no = li.period_no
         ORDER BY li.route_code, li.period_no`, [year]);

      const porRuta = new Map<string, SerieRuta>();
      for (const r of rows as PuntoCrudo[]) {
        if (!porRuta.has(r.route_code)) {
          porRuta.set(r.route_code, {
            route_code: r.route_code, chofer: r.chofer, zona: r.zona, puntos: [],
            margen: sinTendencia(), venta_por_km: sinTendencia(),
          });
        }
        porRuta.get(r.route_code)!.puntos.push({
          period_no: r.period_no,
          subtotal: Number(r.subtotal), costo: Number(r.costo),
          utilidad_bruta: Number(r.utilidad_bruta),
          margen_pct: r.margen_pct === null ? null : Number(r.margen_pct),
          comision: Number(r.comision),
          motivo_no_pago: r.motivo_no_pago,
          km: r.km === null ? null : Number(r.km),
          dias_medidos: r.dias_medidos, dias_con_senal: r.dias_con_senal,
          dias_de_la_quincena: r.dias_de_la_quincena,
          cobertura_km: r.cobertura_km,
          venta_por_km: r.venta_por_km === null ? null : Number(r.venta_por_km),
        });
      }
      for (const ruta of porRuta.values()) {
        ruta.margen = tendencia(ruta.puntos.map((p) => p.margen_pct));
        ruta.venta_por_km = tendencia(ruta.puntos.map((p) => p.venta_por_km));
      }

      const rutas = [...porRuta.values()].sort((a, b) => orden(a.margen) - orden(b.margen));
      const huecos: Hueco[] = [{
        clave: 'sin_meta_autorizada',
        detalle: 'Las 13 rutas tienen renglones en el plan de ventas, pero los tres presupuestos cargados están en borrador, ninguno autorizado, y el único de 2026 se llama «prueba 2». No se publica cumplimiento contra una meta que nadie firmó.',
      }, {
        clave: 'km_arrancan_en_julio',
        detalle: 'La historia de posiciones del GPS arranca el 2026-07-27, así que la tendencia de venta por kilómetro tiene menos quincenas comparables que la de margen.',
      }];

      return { anio: year, rutas, huecos };
    });
  }

  /** Quincenas que tienen una corrida con renglones: lo que se puede abrir. */
  async periodos(): Promise<PeriodoDisponible[]> {
    const { rows } = await this.tk.run(async (trx) => trx.raw(`
      SELECT p.id, p.anio, p.period_no,
             to_char(p.date_from, 'YYYY-MM-DD') AS date_from,
             to_char(p.date_to,   'YYYY-MM-DD') AS date_to,
             r.status, r.origen,
             count(l.id)::int AS rutas
        FROM commercial.commission_periods p
        JOIN commercial.commission_runs r
          ON r.period_id = p.id AND r.deleted_at IS NULL
        LEFT JOIN commercial.commission_run_lines l
          ON l.run_id = r.id AND l.deleted_at IS NULL
       GROUP BY p.id, p.anio, p.period_no, p.date_from, p.date_to, r.status, r.origen
       HAVING count(l.id) > 0
       ORDER BY p.anio DESC, p.period_no DESC
       LIMIT 60`));
    return rows;
  }

  /**
   * El tablero de una quincena. Tres bloques que NO se suman entre sí:
   * rutas (venta, costo, comisión, km) · plazas (gasto del departamento) · el contraste.
   */
  async rentabilidad(periodId?: string): Promise<RentabilidadPeriodo> {
    return this.tk.run(async (trx) => {
      const { rows: [per] } = await trx.raw(
        periodId
          ? `SELECT p.id, p.anio, p.period_no,
                    to_char(p.date_from,'YYYY-MM-DD') date_from, to_char(p.date_to,'YYYY-MM-DD') date_to,
                    (p.date_to < current_date) AS cerrado
               FROM commercial.commission_periods p WHERE p.id = ?`
          : `SELECT p.id, p.anio, p.period_no,
                    to_char(p.date_from,'YYYY-MM-DD') date_from, to_char(p.date_to,'YYYY-MM-DD') date_to,
                    (p.date_to < current_date) AS cerrado
               FROM commercial.commission_periods p
               JOIN commercial.commission_runs r ON r.period_id = p.id AND r.deleted_at IS NULL
               JOIN commercial.commission_run_lines l ON l.run_id = r.id AND l.deleted_at IS NULL
              GROUP BY p.id, p.anio, p.period_no, p.date_from, p.date_to
              ORDER BY p.anio DESC, p.period_no DESC LIMIT 1`,
        periodId ? [periodId] : [],
      );
      if (!per) throw new NotFoundException('no hay ninguna quincena con renglones para leer');

      // ── Bloque 1: la ruta ────────────────────────────────────────────────────────────
      // La utilidad bruta sale del SUBTOTAL (sin IVA), que es la base del costo. Los km del
      // odómetro del GPS; `km` llega NULL cuando el día no se pudo medir, así que
      // `sum(km)` ignora esos días y `dias_medidos` dice cuántos entraron de verdad.
      const { rows: rutas } = await trx.raw(`
        WITH linea AS (
          SELECT l.route_code, l.beneficiario_nombre, l.zona,
                 l.subtotal, l.venta, l.costo, l.comision, l.bonos, l.a_pagar,
                 l.motivo_no_pago, l.pct_aplicado, l.dias_con_venta, l.dias_esperados,
                 l.subtotal_origen, l.costo_status
            FROM commercial.commission_run_lines l
            JOIN commercial.commission_runs r ON r.id = l.run_id AND r.deleted_at IS NULL
           WHERE r.period_id = ? AND l.deleted_at IS NULL AND l.beneficiario = 'chofer'
        ), km AS (
          SELECT k.route_code,
                 sum(k.km)::bigint                                        AS km,
                 count(k.km)::int                                         AS dias_medidos,
                 count(*)::int                                            AS dias_con_senal,
                 count(*) FILTER (WHERE k.veredicto = 'sin_movimiento')::int AS dias_quieto
            FROM analytics.v_rd_route_km_daily k
           WHERE k.dia >= ?::date AND k.dia <= ?::date
           GROUP BY k.route_code
        )
        SELECT li.route_code,
               li.beneficiario_nombre AS chofer,
               li.zona,
               round(li.subtotal, 2)  AS subtotal,
               round(li.venta, 2)     AS venta,
               round(li.costo, 2)     AS costo,
               round(li.subtotal - li.costo, 2) AS utilidad_bruta,
               CASE WHEN li.subtotal > 0
                    THEN round((li.subtotal - li.costo) / li.subtotal * 100, 2) END AS margen_pct,
               round(li.comision, 2)  AS comision,
               round(li.bonos, 2)     AS bonos,
               round(li.subtotal - li.costo - li.comision - li.bonos, 2) AS despues_de_su_comision,
               li.motivo_no_pago,
               li.pct_aplicado,
               li.subtotal_origen,
               li.costo_status,
               k.km, k.dias_medidos, k.dias_con_senal, k.dias_quieto,
               CASE
                 WHEN k.km IS NULL                  THEN 'sin_gps'
                 WHEN k.dias_medidos < k.dias_con_senal THEN 'parcial'
                 ELSE 'medido'
               END AS km_veredicto,
               CASE WHEN k.km > 0 THEN round(li.subtotal / k.km, 2) END AS venta_por_km,
               CASE WHEN k.km > 0
                    THEN round((li.subtotal - li.costo) / k.km, 2) END AS utilidad_por_km
          FROM linea li
          LEFT JOIN km k ON k.route_code = li.route_code
         ORDER BY li.route_code`,
        [per.id, per.date_from, per.date_to]);

      // ── Bloque 2: la plaza (el gasto, que no baja al camión) ─────────────────────────
      const { rows: gasto } = await trx.raw(`
        SELECT dpto, dpto_norm, plaza, veredicto_plaza, familia,
               sum(lineas)::int AS lineas,
               round(sum(importe), 2) AS importe
          FROM analytics.v_rd_expense_period
         WHERE anio = ? AND period_no = ?
         GROUP BY dpto, dpto_norm, plaza, veredicto_plaza, familia
         ORDER BY dpto, sum(importe) DESC`,
        [per.anio, per.period_no]);

      const { rows: conceptos } = await trx.raw(`
        SELECT dpto, dpto_norm, concepto, concepto_norm, familia,
               sum(lineas)::int AS lineas, round(sum(importe), 2) AS importe
          FROM analytics.v_rd_expense_period
         WHERE anio = ? AND period_no = ?
         GROUP BY dpto, dpto_norm, concepto, concepto_norm, familia
         ORDER BY sum(importe) DESC
         LIMIT 60`,
        [per.anio, per.period_no]);

      // ── Bloque 3: el contraste que destapa el hueco ──────────────────────────────────
      const { rows: [contraste] } = await trx.raw(`
        SELECT
          (SELECT round(coalesce(sum(l.comision + l.bonos), 0), 2)
             FROM commercial.commission_run_lines l
             JOIN commercial.commission_runs r ON r.id = l.run_id AND r.deleted_at IS NULL
            WHERE r.period_id = ? AND l.deleted_at IS NULL) AS libro,
          (SELECT round(coalesce(sum(importe), 0), 2)
             FROM analytics.v_rd_expense_period
            WHERE anio = ? AND period_no = ? AND concepto_norm ~* 'COMISION') AS contabilidad`,
        [per.id, per.anio, per.period_no]);

      // ── Procedencia: con qué se calculó esto ─────────────────────────────────────────
      const { rows: [proc] } = await trx.raw(`
        SELECT (SELECT max(computed_at) FROM analytics.expense_entries) AS gasto_calculado_at,
               (SELECT min(dia) FROM analytics.v_rd_route_km_daily)     AS km_desde,
               (SELECT max(dia) FROM analytics.v_rd_route_km_daily)     AS km_hasta`);

      // ── Lo que no se pudo medir, con nombre ──────────────────────────────────────────
      const huecos: Hueco[] = [];
      const sinGps = rutas.filter((r: RentabilidadRuta) => r.km_veredicto === 'sin_gps').map((r) => r.route_code);
      if (sinGps.length) {
        huecos.push({
          clave: 'rutas_sin_gps',
          detalle: `${sinGps.length} ruta(s) sin kilometraje: ${sinGps.join(', ')}. Esas camionetas no tienen rastreador, así que el dato no existe — no es cero.`,
        });
      }
      if (proc?.km_desde && per.date_from < toISO(proc.km_desde)) {
        huecos.push({
          clave: 'km_antes_del_historial',
          detalle: `La historia de posiciones arranca el ${toISO(proc.km_desde)}; esta quincena empieza antes, así que su kilometraje está incompleto por construcción.`,
        });
      }
      huecos.push({
        clave: 'gasto_no_baja_a_la_ruta',
        detalle: 'La contabilidad atribuye el gasto al departamento, no a la camioneta: el comentario de las líneas de combustible dice "combustible rd". Repartirlo por venta o por kilómetros sería inventarlo.',
      });
      huecos.push({
        clave: 'sin_litros',
        detalle: 'No hay litros en ninguna fuente: el CFDI guarda sólo el encabezado y el XML completo existe en 105 de 6,241 facturas del proveedor de combustible. Por eso no hay $/litro ni km/l.',
      });
      const delta = Number(contraste?.contabilidad ?? 0) - Number(contraste?.libro ?? 0);
      if (Math.abs(delta) >= 1) {
        huecos.push({
          clave: 'comision_libro_vs_contabilidad',
          detalle: `El libro paga ${money(contraste.libro)} de comisión y bonos; la contabilidad registra ${money(contraste.contabilidad)} en los departamentos de RD. Faltan ${money(Math.abs(delta))}. La hipótesis del rezago a la quincena siguiente se probó y no lo explica.`,
        });
      }

      const sumaRutas = rutas.reduce((a: Totales, r: RentabilidadRuta) => ({
        subtotal: a.subtotal + Number(r.subtotal ?? 0),
        costo: a.costo + Number(r.costo ?? 0),
        utilidad_bruta: a.utilidad_bruta + Number(r.utilidad_bruta ?? 0),
        comision: a.comision + Number(r.comision ?? 0) + Number(r.bonos ?? 0),
        km: a.km + Number(r.km ?? 0),
      }), { subtotal: 0, costo: 0, utilidad_bruta: 0, comision: 0, km: 0 });

      // El resultado de la plaza = utilidad bruta de SUS rutas − gasto de SU departamento.
      // Sólo se publica donde la plaza resuelve; donde no, se dice por qué.
      const plazas = armarPlazas(rutas, gasto);

      return {
        periodo: per,
        rutas,
        plazas,
        gasto_por_concepto: conceptos,
        contraste_comision: {
          libro: Number(contraste?.libro ?? 0),
          contabilidad: Number(contraste?.contabilidad ?? 0),
          delta,
        },
        totales: {
          ...sumaRutas,
          margen_pct: sumaRutas.subtotal > 0
            ? Number((sumaRutas.utilidad_bruta / sumaRutas.subtotal * 100).toFixed(2))
            : null,
          gasto_departamento: round2(gasto.reduce((a: number, g: GastoFamilia) => a + Number(g.importe ?? 0), 0)),
        },
        procedencia: {
          gasto_calculado_at: proc?.gasto_calculado_at ?? null,
          km_desde: proc?.km_desde ? toISO(proc.km_desde) : null,
          km_hasta: proc?.km_hasta ? toISO(proc.km_hasta) : null,
        },
        huecos,
      };
    });
  }
}

/** ⚠️ `pg` devuelve `date` como objeto Date: `String(d).slice(0,10)` da el día ANTERIOR en MX. */
function toISO(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const round2 = (n: number): number => Number(n.toFixed(2));
const money = (n: number | string): string =>
  `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Junta las rutas con el gasto de su departamento. La llave es la PLAZA, no el nombre del
 * departamento, y un departamento cuya plaza no resuelve (`MORELIA MADERO RD`, que gasta sin
 * tener rutas en el resolvedor de identidad) sale igual, declarado, en vez de desaparecer.
 */
function armarPlazas(rutas: RentabilidadRuta[], gasto: GastoFamilia[]): RentabilidadPlaza[] {
  const porPlaza = new Map<string, RentabilidadPlaza>();
  const clave = (p: string | null, dpto: string | null): string => p ?? `dpto:${dpto}`;

  for (const g of gasto) {
    const k = clave(g.plaza, g.dpto);
    if (!porPlaza.has(k)) {
      porPlaza.set(k, {
        plaza: g.plaza, dpto: g.dpto, dpto_norm: g.dpto_norm,
        veredicto_plaza: g.veredicto_plaza,
        rutas: 0, subtotal: 0, costo: 0, utilidad_bruta: 0,
        gasto: 0, gasto_por_familia: [], resultado: null,
      });
    }
    const p = porPlaza.get(k)!;
    p.gasto = round2(p.gasto + Number(g.importe ?? 0));
    p.gasto_por_familia.push({ familia: g.familia, importe: Number(g.importe ?? 0), lineas: g.lineas });
  }

  for (const r of rutas) {
    // La zona del renglón de comisión nombra la plaza en otro vocabulario ("Zamora,
    // Michoacán" por Canindo), así que se une por la plaza que ya resolvió el gasto.
    const k = [...porPlaza.keys()].find((kk) => {
      const p = porPlaza.get(kk)!;
      if (!p.plaza || !r.zona) return false;
      return r.zona.toUpperCase().includes(p.plaza.toUpperCase());
    });
    if (!k) continue;
    const p = porPlaza.get(k)!;
    p.rutas += 1;
    p.subtotal = round2(p.subtotal + Number(r.subtotal ?? 0));
    p.costo = round2(p.costo + Number(r.costo ?? 0));
    p.utilidad_bruta = round2(p.utilidad_bruta + Number(r.utilidad_bruta ?? 0));
  }

  for (const p of porPlaza.values()) {
    p.gasto_por_familia.sort((a, b) => b.importe - a.importe);
    // ⛔ Sin rutas no hay utilidad que restar: el resultado queda NULL, no en negativo.
    p.resultado = p.rutas > 0 ? round2(p.utilidad_bruta - p.gasto) : null;
  }
  return [...porPlaza.values()].sort((a, b) => (b.gasto ?? 0) - (a.gasto ?? 0));
}

export interface PeriodoDisponible {
  id: string; anio: number; period_no: number;
  date_from: string; date_to: string;
  status: string; origen: string; rutas: number;
}

export interface RentabilidadRuta {
  route_code: string;
  chofer: string | null;
  zona: string | null;
  subtotal: string; venta: string; costo: string;
  utilidad_bruta: string;
  margen_pct: string | null;
  comision: string; bonos: string;
  despues_de_su_comision: string;
  motivo_no_pago: string | null;
  pct_aplicado: string | null;
  subtotal_origen: string | null;
  costo_status: string | null;
  km: string | null;
  dias_medidos: number | null;
  dias_con_senal: number | null;
  dias_quieto: number | null;
  km_veredicto: 'medido' | 'parcial' | 'sin_gps';
  venta_por_km: string | null;
  utilidad_por_km: string | null;
}

export interface GastoFamilia {
  dpto: string; dpto_norm: string; plaza: string | null;
  veredicto_plaza: string; familia: string;
  lineas: number; importe: string;
}

export interface RentabilidadPlaza {
  plaza: string | null; dpto: string | null; dpto_norm: string | null;
  veredicto_plaza: string;
  rutas: number; subtotal: number; costo: number; utilidad_bruta: number;
  gasto: number;
  gasto_por_familia: { familia: string; importe: number; lineas: number }[];
  resultado: number | null;
}

export interface ConceptoGasto {
  dpto: string; dpto_norm: string;
  concepto: string; concepto_norm: string; familia: string;
  lineas: number; importe: string;
}

export interface Hueco { clave: string; detalle: string }

interface Totales {
  subtotal: number; costo: number; utilidad_bruta: number; comision: number; km: number;
}

export interface RentabilidadPeriodo {
  periodo: { id: string; anio: number; period_no: number; date_from: string; date_to: string; cerrado: boolean };
  rutas: RentabilidadRuta[];
  plazas: RentabilidadPlaza[];
  gasto_por_concepto: ConceptoGasto[];
  contraste_comision: { libro: number; contabilidad: number; delta: number };
  totales: Totales & { margen_pct: number | null; gasto_departamento: number };
  procedencia: { gasto_calculado_at: Date | null; km_desde: string | null; km_hasta: string | null };
  huecos: Hueco[];
}

/**
 * `[RD.58]` Tendencia: el promedio de las últimas N contra las N anteriores.
 *
 * ⛔ **Tres quincenas de cada lado, y si no alcanzan se DECLARA.** Con una sola quincena por
 * lado cualquier semana rara se lee como tendencia; con menos de dos no hay nada que comparar
 * y el veredicto es `sin_base`, que **no es lo mismo** que «no cambió» (ADR-056). Los puntos
 * sin cifra (la ruta no vendió, o no tuvo GPS) se saltan: promediarlos como cero inventaría
 * una caída.
 */
const VENTANA_TENDENCIA = 3;

function tendencia(serie: (number | null)[]): Tendencia {
  const v = serie.filter((x): x is number => x !== null && Number.isFinite(x));
  if (v.length < 4) return { ...sinTendencia(), puntos: v.length };
  const n = Math.min(VENTANA_TENDENCIA, Math.floor(v.length / 2));
  const prom = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const reciente = prom(v.slice(-n));
  const previo = prom(v.slice(-2 * n, -n));
  const delta = reciente - previo;
  return {
    reciente: Number(reciente.toFixed(2)),
    previo: Number(previo.toFixed(2)),
    delta: Number(delta.toFixed(2)),
    quincenas: n,
    puntos: v.length,
    veredicto: delta <= -UMBRAL_SENSIBLE ? 'empeora' : delta >= UMBRAL_SENSIBLE ? 'mejora' : 'estable',
  };
}

/**
 * Cuánto tiene que moverse para llamarlo movimiento. ⚠️ Es el mismo número para margen (puntos
 * porcentuales) y para venta por kilómetro (pesos), y **eso es a propósito en la primera
 * entrega**: con 20 quincenas no hay base para calibrar dos umbrales distintos, y dos números
 * inventados se defienden peor que uno declarado. Cuando haya historia se saca del dato.
 */
const UMBRAL_SENSIBLE = 1;

const sinTendencia = (): Tendencia => ({
  reciente: null, previo: null, delta: null, quincenas: 0, puntos: 0, veredicto: 'sin_base',
});

/** Ordena primero lo que empeora: un tablero que esconde la caída no sirve de tablero. */
function orden(t: Tendencia): number {
  if (t.veredicto === 'sin_base') return 1e9;
  return t.delta ?? 0;
}

export interface Tendencia {
  reciente: number | null;
  previo: number | null;
  delta: number | null;
  /** Cuántas quincenas entraron de cada lado. */
  quincenas: number;
  /** Cuántos puntos con cifra tenía la serie entera. */
  puntos: number;
  veredicto: 'empeora' | 'mejora' | 'estable' | 'sin_base';
}

export interface SeriePunto {
  period_no: number;
  subtotal: number; costo: number; utilidad_bruta: number;
  margen_pct: number | null;
  comision: number;
  motivo_no_pago: string | null;
  km: number | null;
  dias_medidos: number | null;
  dias_con_senal: number | null;
  dias_de_la_quincena: number;
  /** completa = los 14 dias con senal; parcial = el denominador esta incompleto y NO se publica $/km. */
  cobertura_km: 'completa' | 'parcial' | 'sin_gps';
  venta_por_km: number | null;
}

export interface SerieRuta {
  route_code: string;
  chofer: string | null;
  zona: string | null;
  puntos: SeriePunto[];
  margen: Tendencia;
  venta_por_km: Tendencia;
}

export interface SeriePeriodo {
  anio: number;
  rutas: SerieRuta[];
  huecos: Hueco[];
}

interface PuntoCrudo {
  route_code: string; chofer: string | null; zona: string | null; period_no: number;
  subtotal: string; costo: string; utilidad_bruta: string; margen_pct: string | null;
  comision: string; motivo_no_pago: string | null;
  km: string | null; dias_medidos: number | null; dias_con_senal: number | null;
  dias_de_la_quincena: number; cobertura_km: 'completa' | 'parcial' | 'sin_gps';
  venta_por_km: string | null;
}
