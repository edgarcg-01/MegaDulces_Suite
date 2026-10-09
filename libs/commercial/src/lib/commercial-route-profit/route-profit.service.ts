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
/**
 * ⛔⛔ **La regla del `$/km` vive acá y en ningún otro lado.**
 *
 * `[RD.58]` la endureció y `[RD.58.2]` la corrigió — las dos veces **en `serie()` solamente**,
 * porque `rentabilidad()` tenía su propia copia. Medido contra prod el 2026-10-09: de 36
 * ruta-quincena con kilometraje, **13 (36%) publicaban en la tarjeta una cifra que la serie se
 * negaba a publicar**, incluida la que motivó toda la corrección — la ruta 21 en la Q15
 * mostrando **$450.94/km con 3 de 14 días medidos**. Dos pantallas, la misma ruta, la misma
 * quincena, dos respuestas.
 *
 * Por eso el texto es UNA constante que las dos consultas interpolan: mientras la regla esté
 * escrita dos veces, arreglarla una vez va a seguir pareciendo que la arregló entera.
 *
 * Exige los alias `li` (la línea, con `subtotal` y `dias_de_la_quincena`) y `k` (el kilometraje
 * agregado, con `km` y `dias_medidos`).
 *
 * ⚠️ La cobertura se mide con los días **MEDIDOS**, no con los que tuvieron señal: un día en
 * que el odómetro no se pudo leer tiene señal, aporta CERO kilómetros y pasaría como cobertura.
 */
const KM_SQL = `
               CASE WHEN k.km > 0 AND k.dias_medidos >= li.dias_de_la_quincena
                    THEN round(li.subtotal / k.km, 2) END AS venta_por_km,
               CASE WHEN k.km > 0 AND k.dias_medidos >= li.dias_de_la_quincena
                    THEN round((li.subtotal - li.costo) / k.km, 2) END AS utilidad_por_km,
               CASE WHEN k.km IS NULL THEN 'sin_gps'
                    WHEN k.dias_medidos < li.dias_de_la_quincena THEN 'parcial'
                    ELSE 'completa' END AS cobertura_km`;

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
               -- El $/km SÓLO sale con la quincena completa de GPS. La regla, su medición y el
               -- motivo de cada guarda están en KM_SQL, que es el único lugar donde se escribe.
               ${KM_SQL}
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

  /**
   * `[RD.60]` El gasto de la quincena, **renglón por renglón**. Ver el contrato `GastoDetalle`.
   * ⚠️ Topado a 400 renglones y lo DECLARA: una tabla que se corta en silencio miente sobre
   * el total, y el total de abajo tiene que ser el de la quincena, no el de lo que se ve.
   */
  async gastoDetalle(anio: number, periodNo: number): Promise<GastoDetalle> {
    const TOPE = 400;
    return this.tk.run(async (trx) => {
      const { rows: [per] } = await trx.raw(
        `SELECT to_char(date_from,'YYYY-MM-DD') date_from, to_char(date_to,'YYYY-MM-DD') date_to
           FROM commercial.commission_periods WHERE anio = ? AND period_no = ?`,
        [anio, periodNo]);
      if (!per) throw new NotFoundException(`no existe la quincena ${periodNo} de ${anio}`);

      const { rows: renglones } = await trx.raw(`
        SELECT e.id,
               to_char(e.fecha, 'YYYY-MM-DD') AS fecha,
               e.dpto,
               btrim(regexp_replace(e.dpto_nombre, '[. ]+$', '')) AS dpto_norm,
               pl.plaza,
               e.concepto,
               btrim(regexp_replace(coalesce(e.concepto_nombre, ''), '[. ]+$', '')) AS concepto_norm,
               analytics.fn_expense_family(
                 btrim(regexp_replace(coalesce(e.concepto_nombre, ''), '[. ]+$', '')), e.cuenta) AS familia,
               e.cuenta, e.cuenta_nombre, e.beneficiario, e.comentario,
               e.doc_tipo, e.doc_folio,
               round(e.importe * CASE WHEN e.cargo_abono = 'A' THEN -1 ELSE 1 END, 2) AS importe
          FROM analytics.expense_entries e
          LEFT JOIN (
            SELECT DISTINCT tenant_id, plaza, upper(plaza) AS plaza_upper
              FROM analytics.mv_rd_route_identity
          ) pl ON pl.tenant_id = e.tenant_id
              AND pl.plaza_upper = btrim(regexp_replace(
                    btrim(regexp_replace(e.dpto_nombre, '[. ]+$', '')), '(^RD[ ]|[ ]RD$)', ''))
         WHERE e.dpto IS NOT NULL AND e.dpto_nombre IS NOT NULL
           AND btrim(regexp_replace(e.dpto_nombre, '[. ]+$', '')) ~ '(^|[^A-Za-z])RD([^A-Za-z]|$)'
           AND e.fecha >= ?::date AND e.fecha <= ?::date
         ORDER BY e.fecha DESC, abs(e.importe) DESC
         LIMIT ?`, [per.date_from, per.date_to, TOPE + 1]);

      // ⛔ El total NO sale de los renglones que se muestran: sale de la quincena entera. Si
      // saliera de la página, una tabla topada publicaría un total más chico sin avisar.
      const { rows: fam } = await trx.raw(`
        SELECT familia, sum(lineas)::int AS lineas, round(sum(importe), 2) AS importe
          FROM analytics.v_rd_expense_period
         WHERE anio = ? AND period_no = ?
         GROUP BY 1 ORDER BY sum(importe) DESC`, [anio, periodNo]);

      const truncado = renglones.length > TOPE;
      const huecos: Hueco[] = [{
        clave: 'gasto_no_baja_a_la_ruta',
        detalle: 'El comentario a veces nombra la camioneta («ARRENDAMIENTO NP300 RD PH»), pero eso es texto, no una atribución. No se deriva la ruta de él: sería adivinar.',
      }];
      if (truncado) {
        huecos.push({
          clave: 'tabla_topada',
          detalle: `La quincena tiene más de ${TOPE} renglones y la tabla muestra los ${TOPE} de mayor importe. Los totales de abajo son los de la quincena ENTERA, no los de lo que se ve.`,
        });
      }

      return {
        anio, period_no: periodNo,
        date_from: per.date_from, date_to: per.date_to,
        renglones: truncado ? renglones.slice(0, TOPE) : renglones,
        por_familia: fam.map((f: { familia: string; lineas: number; importe: string }) => ({
          familia: f.familia, lineas: f.lineas, importe: Number(f.importe),
        })),
        total: Number(fam.reduce((a: number, f: { importe: string }) => a + Number(f.importe), 0).toFixed(2)),
        truncado,
        huecos,
      };
    });
  }

  /**
   * `[RD.60]` La flota de Ruta Directa: lo que de verdad se sabe de cada camioneta, y lo que no.
   *
   * ⛔ **El padrón está casi vacío y la pantalla lo dice en vez de disimularlo.** Medido sobre
   * los 56 vehículos vivos: placa y marca 56/56, pero **año 1/56** y **VIN, número económico,
   * aseguradora, póliza y odómetro en 0/56**. Y **no existe ninguna columna de vencimiento de
   * seguro en toda la base**, así que el aviso por póliza que pedía el libro no tiene dónde vivir.
   *
   * ⭐ Lo que sí sale solo: el odómetro vivo del GPS, los días sin reportar, y los **vínculos
   * sospechosos** — el tracker `CHEVROLET S10 NM8497D R-321` cuelga del vehículo de placa
   * `MW7947C`, que es otra camioneta.
   */
  async flota(): Promise<FlotaResumen> {
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(`
        WITH tr AS (
          SELECT t.tenant_id, t.route_number, t.external_name, t.last_odometer, t.last_seen_at,
                 t.vehicle_id,
                 (t.external_name ~* 'DASHCAM|[(]CAM[)]') AS es_camara
            FROM logistics.trackers t
           WHERE t.route_number IS NOT NULL AND t.deleted_at IS NULL
        )
        SELECT tr.route_number::text AS route_code,
               -- La ficha es para IDENTIFICAR la unidad, no para agrupar dinero: aca el respaldo
               -- sirve. Con la plaza resuelta a secas, las rutas 321 y 322 salen con un guion
               -- aunque el universo sepa que son de Morelia. En rentabilidad() NO se usa el
               -- respaldo: alla la plaza reparte gasto y el texto de la zona ya se equivoco una vez.
               coalesce(u.plaza, u.plaza_o_zona) AS plaza, u.chofer_nombre AS chofer,
               v.plate AS placa, v.brand AS marca, v.model AS modelo, v.year AS anio,
               v.vin, v.insurance_carrier AS aseguradora,
               tr.last_odometer AS odometro,
               to_char(tr.last_seen_at, 'YYYY-MM-DD') AS ultimo_visto,
               (current_date - tr.last_seen_at::date)::int AS dias_sin_reportar,
               tr.external_name AS nombre_tracker,
               -- El nombre del aparato trae la placa. Si no es la del vehiculo al que cuelga,
               -- el vinculo esta mal: son dos camionetas distintas.
               -- ⛔ Esto comparaba con el operador de EXPRESION REGULAR, o sea que usaba la
               -- placa como patron. Verificado contra prod: una placa con un parentesis suelto
               -- rompe la consulta entera (parentheses not balanced) y una con un punto da
               -- FALSO NEGATIVO -- el punto matchea cualquier caracter, asi que un vinculo malo
               -- se ve bien. Hoy ninguna de las 56 placas trae metacaracteres, pero ya conviven
               -- OCHO formatos distintos: el dato no esta disciplinado y el riesgo es latente.
               -- position() compara TEXTO, que es lo que se queria comparar.
               (v.plate IS NOT NULL AND position(v.plate in tr.external_name) = 0)
                 AS vinculo_sospechoso,
               count(*) OVER (PARTITION BY tr.route_number)::int AS aparatos,
               row_number() OVER (PARTITION BY tr.route_number
                                  ORDER BY tr.es_camara, tr.last_seen_at DESC) AS rn
          FROM tr
          LEFT JOIN logistics.vehicles v ON v.id = tr.vehicle_id AND v.deleted_at IS NULL
          LEFT JOIN analytics.v_rd_commission_universe u
            ON u.tenant_id = tr.tenant_id AND u.route_code = tr.route_number::text
         ORDER BY tr.route_number, tr.es_camara`);

      // Una fila por ruta: la del aparato principal (no cámara, más reciente).
      const unidades: UnidadFlota[] = rows
        .filter((r: { rn: number }) => r.rn === 1)
        .map((r: Record<string, unknown>) => {
          // ⛔ Los campos vacíos se ENUMERAN. Un NULL en una ficha no se explica solo, y la
          // lista es la que convierte «la pantalla se ve pobre» en «falta capturar esto».
          const sinCapturar: string[] = [];
          if (!r['modelo']) sinCapturar.push('modelo');
          if (!r['anio']) sinCapturar.push('año');
          if (!r['vin']) sinCapturar.push('número de serie');
          if (!r['aseguradora']) sinCapturar.push('aseguradora');
          return {
            route_code: String(r['route_code']),
            plaza: (r['plaza'] as string) ?? null,
            chofer: (r['chofer'] as string) ?? null,
            placa: (r['placa'] as string) ?? null,
            marca: (r['marca'] as string) ?? null,
            modelo: (r['modelo'] as string) ?? null,
            anio: (r['anio'] as number) ?? null,
            vin: (r['vin'] as string) ?? null,
            aseguradora: (r['aseguradora'] as string) ?? null,
            odometro: r['odometro'] === null || r['odometro'] === undefined ? null : String(r['odometro']),
            ultimo_visto: (r['ultimo_visto'] as string) ?? null,
            dias_sin_reportar: (r['dias_sin_reportar'] as number) ?? null,
            aparatos: Number(r['aparatos']),
            vinculo_sospechoso: Boolean(r['vinculo_sospechoso']),
            nombre_tracker: (r['nombre_tracker'] as string) ?? null,
            sin_capturar: sinCapturar,
          };
        });

      // Las rutas que comisionan y NO tienen rastreador: su kilometraje no existe.
      const { rows: sinGps } = await trx.raw(`
        SELECT u.route_code
          FROM analytics.v_rd_commission_universe u
         WHERE u.comisiona
           AND NOT EXISTS (SELECT 1 FROM logistics.trackers t
                            WHERE t.route_number::text = u.route_code AND t.deleted_at IS NULL)
         ORDER BY u.route_code`);

      // ⛔ Acá iba la cobertura del padrón ESCRITA A MANO en el texto («de 56 unidades vivas,
      // el año en 1, el VIN en ninguna»). Era cierta el día que se midió y seguiría diciendo lo
      // mismo el día que alguien capture: una medición congelada en una cadena no avisa cuando
      // deja de ser cierta. Es la lección de `[CDRP.2.1]`, que costó una migración aparte porque
      // la cifra vivía en un COMMENT de prod. Se cuenta cada vez.
      const { rows: [pad] } = await trx.raw(`
        SELECT count(*)::int AS total, count(plate)::int AS placa, count(brand)::int AS marca,
               count(model)::int AS modelo, count(year)::int AS anio, count(vin)::int AS vin,
               count(insurance_carrier)::int AS aseguradora
          FROM logistics.vehicles WHERE deleted_at IS NULL`);
      const faltantes = ([
        ['modelo', pad.modelo], ['año', pad.anio], ['número de serie', pad.vin],
        ['aseguradora', pad.aseguradora],
      ] as [string, number][])
        .filter(([, n]) => n < pad.total)
        .map(([k, n]) => `${k} ${n}/${pad.total}`);

      const huecos: Hueco[] = [{
        clave: 'padron_vacio',
        detalle: faltantes.length
          ? `El padrón de vehículos está incompleto: sobre ${pad.total} unidades vivas, `
            + `placa ${pad.placa}/${pad.total} y marca ${pad.marca}/${pad.total}, pero `
            + `${faltantes.join(', ')}. Se captura en Logística.`
          : `El padrón de vehículos está completo en las ${pad.total} unidades vivas.`,
      }, {
        clave: 'sin_vencimiento_de_seguro',
        detalle: 'No existe ninguna columna de vencimiento de seguro en toda la base, así que el aviso por póliza que pedía el libro no tiene dónde vivir todavía. El dato está sólo en el Excel.',
      }];
      const sospechosos = unidades.filter((u) => u.vinculo_sospechoso).map((u) => u.route_code);
      if (sospechosos.length) {
        huecos.push({
          clave: 'vinculo_sospechoso',
          detalle: `${sospechosos.length} ruta(s) tienen el rastreador colgado de un vehículo con OTRA placa: ${sospechosos.join(', ')}. Se arregla en Logística; mientras tanto la ficha muestra una camioneta que puede no ser la que anda.`,
        });
      }
      if (sinGps.length) {
        huecos.push({
          clave: 'rutas_sin_gps',
          detalle: `${sinGps.length} ruta(s) que comisionan no tienen rastreador: ${sinGps.map((s: { route_code: string }) => s.route_code).join(', ')}. Su kilometraje no existe — no es cero.`,
        });
      }

      return {
        unidades,
        rutas_sin_gps: sinGps.map((s: { route_code: string }) => s.route_code),
        huecos,
      };
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
          -- ⛔⛔ La PLAZA sale del resolvedor por route_code, NO del texto de la zona.
          -- La primera versión cruzaba cadenas (zona contiene plaza) y «Zamora, Michoacán»
          -- NO contiene «Canindo»: las 4 rutas de Canindo nunca se pegaban a su plaza, así que
          -- su tarjeta publicaba el gasto con CERO rutas y resultado «sin medir» — $158,383.69
          -- de utilidad bruta, el 42% del total de RD, desaparecidos de la vista por plaza.
          SELECT l.route_code, l.beneficiario_nombre, l.zona, u.plaza,
                 l.subtotal, l.venta, l.costo, l.comision, l.bonos, l.a_pagar,
                 l.motivo_no_pago, l.pct_aplicado, l.dias_con_venta, l.dias_esperados,
                 l.subtotal_origen, l.costo_status,
                 -- Lo exige KM_SQL: sin los días de la quincena no hay con qué medir cobertura.
                 (p.date_to - p.date_from + 1)::int AS dias_de_la_quincena
            FROM commercial.commission_run_lines l
            JOIN commercial.commission_runs r ON r.id = l.run_id AND r.deleted_at IS NULL
            JOIN commercial.commission_periods p ON p.id = r.period_id
            LEFT JOIN analytics.v_rd_commission_universe u
              ON u.tenant_id = l.tenant_id AND u.route_code = l.route_code
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
               li.plaza,
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
               k.km, k.dias_medidos, k.dias_con_senal, k.dias_quieto, li.dias_de_la_quincena,
               -- Aca vivia una SEGUNDA copia de la regla, con dos defectos que la copia de la
               -- serie ya no tenia: el $/km salia con cualquier kilometraje (sin exigir la
               -- quincena completa) y la cobertura se media contra los dias CON SENAL en vez de
               -- los MEDIDOS. Arreglar la serie dos veces no arreglo esto ni una.
               ${KM_SQL}
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
      const sinGps = rutas.filter((r: RentabilidadRuta) => r.cobertura_km === 'sin_gps').map((r) => r.route_code);
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
      const { plazas, rutasSinPlaza } = armarPlazas(rutas, gasto);
      if (rutasSinPlaza.length) {
        huecos.push({
          clave: 'rutas_sin_plaza',
          detalle: `${rutasSinPlaza.length} ruta(s) no entran a ninguna plaza: ${rutasSinPlaza.join(', ')}. El resolvedor de identidad no las ubica, así que su utilidad bruta se ve arriba —por ruta— pero no se resta contra ningún gasto abajo.`,
        });
      }

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
function armarPlazas(rutas: RentabilidadRuta[], gasto: GastoFamilia[]): ArmadoPlazas {
  const porPlaza = new Map<string, RentabilidadPlaza>();
  const rutasSinPlaza: string[] = [];
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

  // ⛔⛔ Se une por PLAZA EXACTA, que el resolvedor da por `route_code`. La versión anterior
  // cruzaba cadenas (`zona.includes(plaza)`) y «Zamora, Michoacán» no contiene «Canindo»:
  // las 4 rutas de Canindo nunca se pegaban y su tarjeta decía «sin medir» teniendo $158,383.69
  // de utilidad bruta. Un cruce por texto comercial parece funcionar porque UNA de las tres
  // zonas sí contiene su plaza, y esa coincidencia es lo que lo hace difícil de ver.
  const huerfanas: string[] = [];
  for (const r of rutas) {
    if (!r.plaza) { huerfanas.push(r.route_code); continue; }
    const p = porPlaza.get(r.plaza);
    // La ruta tiene plaza pero su departamento no gastó en esta quincena: no se inventa
    // una tarjeta vacía, se cuenta como huérfana y la pantalla lo declara.
    if (!p) { huerfanas.push(r.route_code); continue; }
    p.rutas += 1;
    p.subtotal = round2(p.subtotal + Number(r.subtotal ?? 0));
    p.costo = round2(p.costo + Number(r.costo ?? 0));
    p.utilidad_bruta = round2(p.utilidad_bruta + Number(r.utilidad_bruta ?? 0));
  }
  rutasSinPlaza.push(...huerfanas);

  for (const p of porPlaza.values()) {
    p.gasto_por_familia.sort((a, b) => b.importe - a.importe);
    // ⛔ Sin rutas no hay utilidad que restar: el resultado queda NULL, no en negativo.
    p.resultado = p.rutas > 0 ? round2(p.utilidad_bruta - p.gasto) : null;
  }
  return {
    plazas: [...porPlaza.values()].sort((a, b) => (b.gasto ?? 0) - (a.gasto ?? 0)),
    rutasSinPlaza,
  };
}

interface ArmadoPlazas { plazas: RentabilidadPlaza[]; rutasSinPlaza: string[] }

export interface PeriodoDisponible {
  id: string; anio: number; period_no: number;
  date_from: string; date_to: string;
  status: string; origen: string; rutas: number;
}

export interface RentabilidadRuta {
  route_code: string;
  chofer: string | null;
  /** Texto comercial ("Zamora, Michoacán"). ⛔ NO sirve para unir con la plaza. */
  zona: string | null;
  /** La plaza EXACTA, del resolvedor por route_code. NULL = el resolvedor no la ubica. */
  plaza: string | null;
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
  /** Mismo nombre y mismos valores que en la serie: un concepto, una palabra. */
  cobertura_km: 'completa' | 'parcial' | 'sin_gps';
  dias_de_la_quincena: number;
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

/**
 * `[RD.60]` — **El gasto de Ruta Directa, renglón por renglón.**
 *
 * La pestaña «Por plaza» de `[RD.57]` muestra el gasto **agregado** por familia y concepto; ésta
 * muestra el renglón, que es lo que la hoja `CONTROL DE GASTOS RD` tenía y la pantalla no.
 * Medido en la quincena 20: **95 renglones, 17 conceptos, 89 con comentario**.
 *
 * ⭐ **El comentario es el dato que nadie estaba mirando.** No es atribución estructurada —la
 * contabilidad no baja al camión— pero a veces nombra la unidad: *«ARRENDAMIENTO NP300 RD PH»*
 * $18,525.86, *«ROTULACIÓN CAMIONETA PIN PON»* $7,000, *«LONA PARA CAMIONETA DE RD»* $350.
 * ⛔ Se publica **como texto**, sin intentar derivar la ruta de él: eso sería adivinar.
 */
export interface GastoRenglon {
  /**
   * La llave REAL del renglón, del servidor. ⛔ No se arma pegando campos: dos renglones del
   * mismo documento pueden compartir concepto, fecha e importe, y un `track` que colisiona
   * hace que Angular reutilice la fila equivocada al reordenar.
   */
  id: string;
  fecha: string;
  dpto: string; dpto_norm: string; plaza: string | null;
  concepto: string; concepto_norm: string; familia: string;
  cuenta: string | null; cuenta_nombre: string | null;
  beneficiario: string | null;
  /** ⭐ A veces nombra la camioneta. Se muestra, NO se parsea para inferir la ruta. */
  comentario: string | null;
  doc_tipo: string | null; doc_folio: string | null;
  importe: string;
}

export interface GastoDetalle {
  anio: number; period_no: number;
  date_from: string | null; date_to: string | null;
  renglones: GastoRenglon[];
  por_familia: { familia: string; lineas: number; importe: number }[];
  total: number;
  truncado: boolean;
  huecos: Hueco[];
}

/** `[RD.60]` Una camioneta de RD con lo que de verdad se sabe de ella, y lo que no. */
export interface UnidadFlota {
  route_code: string;
  plaza: string | null;
  chofer: string | null;
  placa: string | null;
  marca: string | null;
  modelo: string | null;
  anio: number | null;
  vin: string | null;
  aseguradora: string | null;
  /** El odómetro del aparato que NO es cámara. */
  odometro: string | null;
  ultimo_visto: string | null;
  /** Días sin reportar. NULL si nunca reportó. */
  dias_sin_reportar: number | null;
  aparatos: number;
  /** ⚠️ `true` cuando el nombre del tracker nombra una placa distinta a la del vehículo. */
  vinculo_sospechoso: boolean;
  nombre_tracker: string | null;
  /** Los campos de la ficha que están vacíos. Se enumeran: un NULL no se explica solo. */
  sin_capturar: string[];
}

export interface FlotaResumen {
  unidades: UnidadFlota[];
  rutas_sin_gps: string[];
  huecos: Hueco[];
}
