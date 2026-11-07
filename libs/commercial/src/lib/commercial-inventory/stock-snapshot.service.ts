import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Knex } from 'knex';
import { KNEX_NEW_DB, TenantKnexService } from '@megadulces/platform-core';

/** Lo que devuelve una corrida, por almacén. */
export interface SnapshotResult {
  warehouses: number;
  pares: number;
  pares_en_cero: number;
  pares_sin_costo: number;
  /** `[EX.H0]` Filas de ese día borradas al re-tomarlo: pares que ya no tienen saldo. 0 en la 1ª toma. */
  pares_retirados: number;
  fecha_corte: string;
  /**
   * `[EX.H0]` `false` = la base todavía no tiene las columnas de la migración EX.H0: la foto se
   * tomó (la existencia de un día no se recupera) pero SIN los costos del día. El latido lo marca
   * como error para que alguien aplique la migración, en vez de dejarlo verde.
   */
  esquema_ex_h0: boolean;
}

/**
 * `[EX.H0]` Las tres fuentes de la foto. En producción son SIEMPRE las vistas canónicas
 * (`FUENTES_FOTO`). El parámetro existe sólo para que la prueba
 * (`database/tests/test-newdb-stock-snapshots.js`) las sustituya por tablas temporales con datos
 * controlados y ejercite ESTE SQL — no una copia, que se comprobaría a sí misma.
 */
export interface FuentesFoto {
  /** `(tenant_id, warehouse_id, product_id, sku, qty_stock_units)` — la existencia viva. */
  existencia: string;
  /** `(tenant_id, warehouse_id, product_id, costo_unitario)` — `kdik.c16` por almacén × SKU. */
  costoErp: string;
  /** `(sucursal, sku, costo_estandar, costo_estandar_u2, costo_estandar_u3)` — los 3 peldaños. */
  costoEstandar: string;
}

export const FUENTES_FOTO: Readonly<FuentesFoto> = {
  existencia: 'analytics.v_erp_stock_on_hand',
  costoErp: 'analytics.v_kepler_unit_cost',
  costoEstandar: 'analytics.v_kepler_standard_cost',
};

/** Un nombre de relación se interpola en el SQL: sólo `esquema.nombre`, nada más. */
const RELACION_RX = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/**
 * Un renglón de **cobertura**: qué almacén se fotografió qué día. Es la mitad del par que evita
 * la mentira — sin esto, un producto ausente de la foto se leería como "tenía cero" cuando pudo
 * ser "ese almacén no reportó".
 *
 * `valor_total` es `number | null` a propósito y **el `null` no es cosmético**: si algún par del
 * almacén no se pudo costear, el total del almacén queda NULL con `pares_sin_costo` a la vista.
 * Tipar esto como `number` invitaría al consumidor a sumarlo, y un total parcial presentado como
 * total es una cifra falsa (ADR-056).
 */
export interface SnapshotCoverageRow {
  fecha_corte: string;
  warehouse_id: string;
  warehouse_code: string | null;
  warehouse_name: string | null;
  pares: number;
  pares_en_cero: number;
  unidades_total: number | null;
  valor_total: number | null;
  pares_sin_costo: number;
  cierre_semana: boolean;
  cierre_mes: boolean;
  cierre_trimestre: boolean;
  cierre_anio: boolean;
  /** `[EX.H0]` De qué fuente salió la existencia ese día. Antes de EX.H0: `commercial.stock`. */
  stock_source: string | null;
  /**
   * `[EX.H0]` Suma de lo que SÍ tiene costo, y cuántos pares no. ⛔ Parcial por diseño: se lee
   * SIEMPRE con sus faltantes. `null` en filas anteriores a EX.H0 (no medido, no cero).
   */
  standard_value_known: number | null;
  standard_missing_pairs: number | null;
  standard_doubtful_pairs: number | null;
  erp_value_known: number | null;
  erp_missing_pairs: number | null;
}

const MEGA = '00000000-0000-0000-0000-00000000d01c';

/**
 * AB.0b — **La foto de inventario.** El reloj de la Fase AB.
 *
 * ── Por qué corre aunque no haya pantalla que la lea ─────────────────────────
 * La venta de un día que ya pasó se puede reconstruir del ERP. **La existencia no**:
 * `commercial.stock` es estado actual y se pisa a sí mismo. Medido antes de escribir
 * esto, no había ninguna serie histórica (`stock_ledger` y `floor_stockouts`: 1 fila
 * cada una). Cada día que este cron no corre es un día que no se recupera, así que se
 * entrega **antes** que las pantallas que lo van a consumir.
 *
 * Lo que desbloquea: el §5 del pedido exige descartar, antes de bajar un parámetro, que
 * la venta haya caído *porque no había producto*. Eso se cuenta con días-con-existencia,
 * y sin esta serie es incomputable.
 *
 * ── Una captura al día; las cadencias son banderas, no capturas ──────────────
 * Semana, mes, trimestre y año **son la foto diaria que cae en el último día del
 * periodo**. Capturarlas por separado permitiría que el cierre de mes no coincidiera con
 * el diario del día 31 — dos cifras oficiales del mismo hecho, que es el problema que la
 * Fase VP existe para cerrar.
 *
 * ── Hora: 23:50 MX, y no es arbitrario ───────────────────────────────────────
 * El corte del día tiene que ser el día. `feed_stock` refresca cada 15 min, así que a las
 * 23:50 la existencia ya es la de cierre de operación. Correrlo de madrugada obligaría a
 * fechar "ayer" una foto tomada hoy, y esa clase de desfase es la que después nadie puede
 * explicar.
 *
 * ── Lo que NO se dibuja como cero (ADR-056) ──────────────────────────────────
 *  · **Costo ausente → `costo_unitario` y `valor` quedan NULL**, y se cuenta en
 *    `pares_sin_costo`. El scanner de reabasto usa `COALESCE(..., 0)`, que sirve para
 *    ordenar una lista pero acá sumaría inventario valuado en cero al total del cierre.
 *  · **Saldo cero → no se guarda fila**, pero el almacén SÍ queda en `coverage`. Ausencia
 *    dentro de un almacén cubierto = cero real; ausencia del almacén = **no medido**.
 *
 * ── Unidad: se guarda CRUDA, a propósito ─────────────────────────────────────
 * La existencia viene en la unidad del ERP que manda en ese almacén, y Kepler y Wincaja no
 * son conmensurables sin el divisor de ADR-055. Convertir al fotografiar congelaría un
 * factor que todavía se está corrigiendo (`v_unit_truth`). Se guarda crudo y se convierte
 * al leer. Los DOS costos de EX.H0 se guardan en esa MISMA unidad, para que
 * `unidades × costo` sea válido sin conversión.
 *
 * ── ⭐ [EX.H0] La existencia sale de la MISMA vista que la pantalla Existencia ─
 * Hasta el 2026-11-06 la foto leía `commercial.stock` (acierta 91 % contra el POS; la vista
 * `analytics.v_erp_stock_on_hand`, 100 %). La diferencia no era ruido: el CEDIS salía
 * CONGELADO —el mismo saldo todos los días— porque la tabla arrastraba el residuo de la base
 * de prueba, y la vista ya lo arbitra contra el reporte del propio Kepler (`[IC.CEDIS.12]`).
 * En 01–08 las dos fuentes están en la misma unidad (razón mediana 1.000, ≥ 99.9 % de pares
 * iguales), así que la serie de unidades no se rompe; MD-32, que tampoco está en la vista ni
 * en la pantalla, deja de fotografiarse y queda «no medido» en `coverage`.
 *
 * Y cada fila guarda **el costo de ese día** con el que se valuará su historia («Consulta
 * históricos», Existencia), en vez de reconstruirlo después:
 *  · `erp_unit_cost` — `kdik.c16` de ESE almacén: el costo de la ÚLTIMA ENTRADA (⛔ no un promedio:
 *    medido 2026-11-06, casa con la última entrada en ≈99 % del subconjunto que distingue y con
 *    c8/c5 en 0.0–0.3 %). Es con el que valúa hoy la pantalla Existencia.
 *  · `standard_unit_cost` — el estándar de Kepler sin impuesto, en el peldaño (pieza, paquete
 *    o caja) que casa con el costo del ERP a menos de 2×. ⚠️ Usar sólo la unidad base
 *    subvaluaba la sucursal 01 un 11 % (SKU 95784: existencia en caja, estándar en pieza).
 *    Si ningún peldaño casa, la fila queda `doubtful_unit` y SIN valor — nunca un valor 10×
 *    equivocado. Sin costo del ERP para arbitrar, se usa la unidad base que declara Kepler.
 *
 * El cron se apaga con `ENABLE_STOCK_SNAPSHOT=false`; el disparo manual siempre funciona.
 */
@Injectable()
export class StockSnapshotService {
  private readonly logger = new Logger(StockSnapshotService.name);
  private isRunning = false;

  /**
   * ⛔ `[INV-FOTO.1]` `knex` NO sirve para leer `commercial.stock`, y por eso esta foto nunca se
   * tomó. Medido en prod el 2026-09-24:
   *
   *     analytics.stock_snapshots ............ 0 filas    (desde que existe la tabla)
   *     commercial.stock ..................... 57,011 filas · 10 almacenes
   *     latido `stock_snapshot` .............. error · "0 almacenes · 0 pares · 0 sin costo"
   *
   * `commercial.stock` tiene **RLS FORZADA** (`relforcerowsecurity = t`). Leerla como
   * `app_runtime` sin `app.tenant_id` **no da error: da CERO FILAS**. Comprobado en vivo:
   *
   *     set role app_runtime; select count(*) from commercial.stock;            →      0
   *     ... + set_config('app.tenant_id', '…d01c');                             → 57,011
   *
   * Por eso `knex` queda SÓLO para lo que no tiene RLS (`public.tenants`, `analytics.*`) y todo
   * lo que toque `commercial.*` pasa por `tk.run(tenantId, …)`, que abre la transacción con el
   * tenant puesto. Es la regla que los hermanos de esta misma carpeta ya siguen
   * (`commercial-inventory.service.ts`, `bin-location.service.ts`).
   *
   * ⚠️ Lo único que evitó que esto fuera VERDE para siempre fue que el latido comprueba
   * `warehouses === 0`. Sin esa línea, un cron que no escribe nada se ve igual que uno que no
   * tenía nada que escribir.
   */
  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
  ) {}

  /** 23:50 MX — cierre de operación del día que se está fotografiando. */
  @Cron('0 50 23 * * *', { timeZone: 'America/Mexico_City' })
  async scheduledSnapshot(): Promise<void> {
    if (process.env.ENABLE_STOCK_SNAPSHOT === 'false') return;
    if (this.isRunning) {
      this.logger.warn('Skip: la foto anterior sigue corriendo');
      return;
    }
    await this.snapshotAllTenants();
  }

  /**
   * Toma la foto de todos los tenants. `fecha` permite re-tomar un día concreto: re-correr
   * el mismo día lo REEMPLAZA (UPSERT de lo que tiene saldo + borrado de lo que ya no lo
   * tiene, `[EX.H0]`), no lo duplica ni lo mezcla.
   *
   * ⚠️ La fuente es VIVA: `fecha` sólo ETIQUETA. Re-tomar un día pasado guarda la existencia
   * de AHORA con esa fecha. Sirve para reponer la foto de anoche a primera hora (casi no se
   * movió nada); para un día de hace una semana guardaría una cifra que no fue la de ese día.
   */
  async snapshotAllTenants(fecha?: string): Promise<SnapshotResult> {
    this.isRunning = true;
    const t0 = Date.now();
    const acc: SnapshotResult = {
      warehouses: 0, pares: 0, pares_en_cero: 0, pares_sin_costo: 0, pares_retirados: 0,
      fecha_corte: '', esquema_ex_h0: true,
    };
    let error: string | null = null;
    try {
      const tenants = await this.knex('public.tenants').where({ activo: true }).select('id');
      for (const t of tenants) {
        const r = await this.snapshotTenant(t.id, fecha);
        acc.warehouses += r.warehouses;
        acc.pares += r.pares;
        acc.pares_en_cero += r.pares_en_cero;
        acc.pares_sin_costo += r.pares_sin_costo;
        acc.pares_retirados += r.pares_retirados;
        acc.fecha_corte = r.fecha_corte;
        acc.esquema_ex_h0 = acc.esquema_ex_h0 && r.esquema_ex_h0;
      }
      if (!acc.esquema_ex_h0) {
        this.logger.warn('Foto tomada SIN los costos del día: falta aplicar la migración EX.H0');
      }
      this.logger.log(
        `Foto ${acc.fecha_corte}: ${acc.warehouses} almacenes · ${acc.pares} pares · ` +
        `${acc.pares_en_cero} en cero · ${acc.pares_sin_costo} sin costo`,
      );
      return acc;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.isRunning = false;
      await this.latir(acc, Date.now() - t0, error);
    }
  }

  async snapshotTenant(tenantId: string, fecha?: string, fuentes: FuentesFoto = FUENTES_FOTO): Promise<SnapshotResult> {
    // La fecha de corte se calcula EN LA DB con la zona de México, no con el reloj del
    // proceso: la API puede correr en UTC y a las 23:50 MX ya es el día siguiente en UTC,
    // lo que fecharía la foto un día adelante. Es el bug de fecha que este repo ya pagó
    // cuatro veces (ver la nota de LC.16 sobre `String(fecha).slice(0,10)`).
    const { rows: fr } = await this.knex.raw(
      `SELECT COALESCE(?::date, (now() AT TIME ZONE 'America/Mexico_City')::date) AS f`,
      [fecha ?? null],
    );
    const f: string = fr[0].f instanceof Date
      ? fr[0].f.toISOString().slice(0, 10)
      : String(fr[0].f).slice(0, 10);

    // Banderas de cierre: se derivan de la fecha, una sola vez, en SQL.
    //   semana  = domingo (el corte semanal del negocio)
    //   mes     = último día del mes · trimestre = último día de mar/jun/sep/dic
    //   año     = 31 de diciembre
    const flags = `
      (EXTRACT(DOW FROM d.f) = 0)                                              AS cierre_semana,
      (d.f = (date_trunc('month', d.f) + interval '1 month - 1 day')::date)    AS cierre_mes,
      (d.f = (date_trunc('quarter', d.f) + interval '3 months - 1 day')::date) AS cierre_trimestre,
      (d.f = (date_trunc('year', d.f) + interval '1 year - 1 day')::date)      AS cierre_anio`;

    // ── [EX.H0] La foto se arma en UNA sentencia que lee la fuente UNA vez ─────────────
    // La vista viva de existencia cuesta ~0.5 s y la del costo del ERP ~0.3 s; antes la foto
    // leía su fuente dos veces (filas y cobertura). Ahora un CTE MATERIALIZED la lee una vez y
    // las escrituras (filas, borrado de lo que quedó en cero y cobertura) salen de él en la misma
    // sentencia: no pueden describir dos existencias distintas aunque la vista cambie entre una y
    // otra, tampoco al re-tomar un día que ya existía.
    //
    // ⛔ La foto y su cobertura van en UNA sola transacción con el tenant puesto: son el par que
    // distingue "tenía cero" de "no se midió". Si una entrara y la otra no, la ausencia de un
    // almacén se leería como saldo cero.
    //
    // ⛔ Si una fuente trajera un par duplicado, el ON CONFLICT revienta («cannot affect row a
    // second time») y el latido sale en error. Es a propósito: escoger una de las dos en silencio
    // sería publicar una existencia que nadie arbitró. Medido 2026-11-06: 0 duplicados en las tres.
    for (const rel of [fuentes.existencia, fuentes.costoErp, fuentes.costoEstandar]) {
      if (!RELACION_RX.test(rel)) throw new Error(`fuente de la foto inválida: ${rel}`);
    }

    return this.tk.run(tenantId, async (trx) => {
      const exH0 = await this.tieneEsquemaExH0(trx);
      // JIT apagado: compila cientos de funciones para una lectura de segundos (mismo remedio
      // que [EX-PERF.1] en la pantalla Existencia, que lee esta misma vista).
      await trx.raw('SET LOCAL jit = off');

      // Sin la migración EX.H0 la tabla todavía exige reservadas/disponibles NOT NULL y no tiene
      // las columnas de costo: se fotografía igual (un día que no se toma no se recupera) con lo
      // que el esquema viejo admite, y `esquema_ex_h0 = false` lo lleva al latido como error.
      const filaCols = exH0 ? ', erp_unit_cost, standard_unit_cost, standard_cost_rule' : '';
      const filaVals = exH0 ? ', x.costo_erp, x.costo_estandar, x.regla' : '';
      const filaSet = exH0
        ? `, erp_unit_cost = EXCLUDED.erp_unit_cost, standard_unit_cost = EXCLUDED.standard_unit_cost,
             standard_cost_rule = EXCLUDED.standard_cost_rule`
        : '';
      // La fuente NO trae apartados: NULL = no medido (ADR-056). Escribir 0 diría «nada apartado».
      const reservadas = exH0 ? 'NULL' : '0';
      const disponibles = exH0 ? 'NULL' : 'x.unidades';

      const covCols = exH0
        ? `, stock_source, erp_value_known, erp_missing_pairs,
             standard_value_known, standard_missing_pairs, standard_doubtful_pairs`
        : '';
      // `*_value_known` = la suma de lo que SÍ tiene costo; se lee con sus faltantes. NULL si no
      // se pudo valuar ni un par (no medido), nunca 0.
      const covVals = exH0
        ? `, '${FUENTES_FOTO.existencia}',
             sum(x.unidades * x.costo_erp) FILTER (WHERE x.unidades <> 0),
             count(*) FILTER (WHERE x.unidades <> 0 AND x.costo_erp IS NULL)::int,
             sum(x.unidades * x.costo_estandar) FILTER (WHERE x.unidades <> 0),
             count(*) FILTER (WHERE x.unidades <> 0 AND x.costo_estandar IS NULL
                                AND x.regla <> 'doubtful_unit')::int,
             count(*) FILTER (WHERE x.unidades <> 0 AND x.regla = 'doubtful_unit')::int`
        : '';
      const covSet = exH0
        ? `, stock_source = EXCLUDED.stock_source,
             erp_value_known = EXCLUDED.erp_value_known, erp_missing_pairs = EXCLUDED.erp_missing_pairs,
             standard_value_known = EXCLUDED.standard_value_known,
             standard_missing_pairs = EXCLUDED.standard_missing_pairs,
             standard_doubtful_pairs = EXCLUDED.standard_doubtful_pairs`
        : '';

      const { rows } = await trx.raw(
        `
        WITH d AS (SELECT ?::date AS f),
        fuente AS MATERIALIZED (
          SELECT s.tenant_id, s.warehouse_id, s.product_id,
                 s.qty_stock_units::numeric                         AS unidades,
                 -- El costo del CATÁLOGO (con impuesto) sigue alimentando costo_unitario/valor: es
                 -- la serie que ya existe y cambiarle el significado a mitad de camino la rompería.
                 -- SIN ", 0" final: un cero se sumaría al valorizado como si no valiera nada.
                 COALESCE(pr.cost_with_tax, pr.cost_base)           AS costo_catalogo,
                 CASE WHEN pr.cost_with_tax IS NOT NULL THEN 'cost_with_tax'
                      WHEN pr.cost_base     IS NOT NULL THEN 'cost_base' END AS costo_catalogo_fuente,
                 kc.costo_unitario                                   AS costo_erp,
                 std.costo_estandar AS c1, std.costo_estandar_u2 AS c2, std.costo_estandar_u3 AS c3
            FROM ${fuentes.existencia} s
            JOIN commercial.warehouses w
                 ON w.tenant_id = s.tenant_id AND w.id = s.warehouse_id
            LEFT JOIN catalog.products pr
                 ON pr.tenant_id = s.tenant_id AND pr.id = s.product_id
            LEFT JOIN ${fuentes.costoErp} kc
                 ON kc.tenant_id = s.tenant_id AND kc.warehouse_id = s.warehouse_id
                AND kc.product_id = s.product_id AND kc.costo_unitario > 0
            -- El estándar es de Kepler: se une por la sucursal de Kepler del almacén. Un almacén
            -- sin kepler_code (Wincaja) no trae estándar y queda 'none', declarado.
            LEFT JOIN ${fuentes.costoEstandar} std
                 ON std.sucursal = w.kepler_code AND std.sku = s.sku
           WHERE s.tenant_id = ?
        ),
        -- El peldaño del estándar más cercano al costo del ERP, en escala log (2× arriba = 2× abajo).
        peldano AS (
          SELECT fu.*, p.costo AS costo_peldano, p.distancia
            FROM fuente fu
            LEFT JOIN LATERAL (
              SELECT v.c AS costo, abs(ln(v.c / fu.costo_erp)) AS distancia
                FROM (VALUES (fu.c1), (fu.c2), (fu.c3)) AS v(c)
               WHERE v.c > 0 AND fu.costo_erp > 0
               ORDER BY 2
               LIMIT 1) p ON true
        ),
        x AS (
          SELECT q.*,
                 CASE q.regla WHEN 'erp_rung'             THEN q.costo_peldano
                              WHEN 'base_unit_no_witness' THEN q.c1 END AS costo_estandar
            FROM (
              SELECT pe.*,
                     CASE WHEN pe.costo_erp IS NULL
                            THEN CASE WHEN pe.c1 > 0 THEN 'base_unit_no_witness' ELSE 'none' END
                          WHEN pe.costo_peldano IS NULL THEN 'none'
                          WHEN pe.distancia < ln(2)     THEN 'erp_rung'
                          ELSE 'doubtful_unit' END AS regla
                FROM peldano pe) q
        ),
        escritas AS (
          INSERT INTO analytics.stock_snapshots (
            tenant_id, warehouse_id, product_id, fecha_corte,
            unidades, reservadas, disponibles, costo_unitario, valor, costo_fuente,
            cierre_semana, cierre_mes, cierre_trimestre, cierre_anio${filaCols})
          SELECT x.tenant_id, x.warehouse_id, x.product_id, d.f,
                 x.unidades, ${reservadas}, ${disponibles}, x.costo_catalogo,
                 -- valor NULL (no 0) cuando no hay costo: se declara, no se dibuja.
                 CASE WHEN x.costo_catalogo IS NULL THEN NULL ELSE x.unidades * x.costo_catalogo END,
                 x.costo_catalogo_fuente, ${flags}${filaVals}
            FROM x CROSS JOIN d
           WHERE x.unidades <> 0
          ON CONFLICT (tenant_id, warehouse_id, product_id, fecha_corte) DO UPDATE
            SET unidades = EXCLUDED.unidades, reservadas = EXCLUDED.reservadas,
                disponibles = EXCLUDED.disponibles, costo_unitario = EXCLUDED.costo_unitario,
                valor = EXCLUDED.valor, costo_fuente = EXCLUDED.costo_fuente${filaSet}
          RETURNING costo_unitario
        ),
        -- [EX.H0] Re-tomar un día lo REEMPLAZA: un par que ya tenía fila ese día y ahora quedó en
        -- cero (o salió de la fuente) se BORRA. Sin esto conservaba su saldo viejo mientras la
        -- cobertura lo contaba en cero, y un lector que toma «almacén cubierto sin fila = agotado»
        -- veía existencia donde no la había. Sólo en los almacenes que la fuente trajo: uno que dejó
        -- de reportar (MD-32) conserva sus filas Y su cobertura de ese día, coherentes entre sí.
        -- Es disjunto de lo que el UPSERT toca (aquél sólo escribe pares con saldo), así que las dos
        -- escrituras en la misma sentencia no pisan la misma fila.
        retiradas AS (
          DELETE FROM analytics.stock_snapshots ss
           USING d
           WHERE ss.tenant_id = ?
             AND ss.fecha_corte = d.f
             AND ss.warehouse_id IN (SELECT DISTINCT x.warehouse_id FROM x)
             AND NOT EXISTS (SELECT 1 FROM x
                              WHERE x.warehouse_id = ss.warehouse_id
                                AND x.product_id   = ss.product_id
                                AND x.unidades <> 0)
          RETURNING 1
        ),
        -- Cobertura: una fila por almacén que la fuente trajo, aunque todo esté en cero. ES la
        -- pieza que distingue "tenía cero" de "no se midió".
        cubiertas AS (
          INSERT INTO analytics.stock_snapshot_coverage (
            tenant_id, warehouse_id, fecha_corte, pares, pares_en_cero,
            unidades_total, valor_total, pares_sin_costo,
            cierre_semana, cierre_mes, cierre_trimestre, cierre_anio${covCols})
          SELECT x.tenant_id, x.warehouse_id, d.f,
                 count(*) FILTER (WHERE x.unidades <> 0)::int,
                 count(*) FILTER (WHERE x.unidades  = 0)::int,
                 sum(x.unidades),
                 -- Total NULL si ALGÚN par no se pudo costear: un total parcial presentado como
                 -- total es una cifra falsa. El detalle de cuántos faltan va en pares_sin_costo.
                 CASE WHEN count(*) FILTER (WHERE x.unidades <> 0 AND x.costo_catalogo IS NULL) > 0
                      THEN NULL
                      ELSE sum(x.unidades * x.costo_catalogo) END,
                 count(*) FILTER (WHERE x.unidades <> 0 AND x.costo_catalogo IS NULL)::int,
                 ${flags}${covVals}
            FROM x CROSS JOIN d
           GROUP BY x.tenant_id, x.warehouse_id, d.f
          ON CONFLICT (tenant_id, warehouse_id, fecha_corte) DO UPDATE
            SET pares = EXCLUDED.pares, pares_en_cero = EXCLUDED.pares_en_cero,
                unidades_total = EXCLUDED.unidades_total, valor_total = EXCLUDED.valor_total,
                pares_sin_costo = EXCLUDED.pares_sin_costo${covSet}
          RETURNING pares_en_cero
        )
        SELECT (SELECT count(*) FROM escritas)::int                               AS pares,
               (SELECT count(*) FROM escritas WHERE costo_unitario IS NULL)::int AS pares_sin_costo,
               (SELECT count(*) FROM cubiertas)::int                              AS warehouses,
               (SELECT COALESCE(sum(pares_en_cero), 0) FROM cubiertas)::int       AS pares_en_cero,
               (SELECT count(*) FROM retiradas)::int                              AS pares_retirados`,
        // Orden de los `?`: la fecha (d), el tenant de la fuente, el tenant del borrado.
        [f, tenantId, tenantId],
      );

      const r = rows[0] ?? { pares: 0, pares_sin_costo: 0, warehouses: 0, pares_en_cero: 0, pares_retirados: 0 };
      return {
        warehouses: Number(r.warehouses),
        pares: Number(r.pares),
        pares_en_cero: Number(r.pares_en_cero),
        pares_sin_costo: Number(r.pares_sin_costo),
        pares_retirados: Number(r.pares_retirados),
        fecha_corte: f,
        esquema_ex_h0: exH0,
      };
    });
  }

  /**
   * `[EX.H0]` ¿La base ya tiene las columnas de la migración EX.H0? El código y el DDL viajan por
   * caminos distintos y llegan desordenados; una foto que revienta a las 23:50 por una columna que
   * falta es un día de historia perdido. Se pregunta en CADA corrida, sin recordar la respuesta:
   * cuesta milisegundos una vez al día, y un «sí» recordado haría que una migración revertida
   * tumbara la foto hasta reiniciar el proceso.
   */
  private async tieneEsquemaExH0(db: Knex | Knex.Transaction): Promise<boolean> {
    const { rows } = await db.raw(
      `SELECT count(*)::int AS n
         FROM information_schema.columns
        WHERE table_schema = 'analytics'
          AND ((table_name = 'stock_snapshots'         AND column_name = 'standard_cost_rule')
            OR (table_name = 'stock_snapshot_coverage' AND column_name = 'standard_doubtful_pairs'))`,
    );
    return Number(rows[0]?.n) === 2;
  }

  /**
   * Qué almacén se fotografió qué día. Es la mitad del par que evita la mentira: sin esto,
   * un producto ausente en la foto se lee como "tenía cero" cuando pudo ser "ese almacén no
   * reportó". Devuelve la cobertura, no el detalle.
   */
  async coverage(desde?: string, hasta?: string): Promise<SnapshotCoverageRow[]> {
    // [EX.H0] Sin la migración, las columnas nuevas salen NULL (no medido) en vez de reventar.
    const exH0 = await this.tieneEsquemaExH0(this.knex);
    const nuevas = exH0
      ? ['c.stock_source', 'c.standard_value_known', 'c.standard_missing_pairs', 'c.standard_doubtful_pairs',
         'c.erp_value_known', 'c.erp_missing_pairs']
      : ['stock_source', 'standard_value_known', 'standard_missing_pairs', 'standard_doubtful_pairs',
         'erp_value_known', 'erp_missing_pairs'].map((k) => this.knex.raw(`NULL AS ${k}`));
    const q = this.knex('analytics.stock_snapshot_coverage as c')
      .leftJoin('commercial.warehouses as w', 'w.id', 'c.warehouse_id')
      .select(
        'c.fecha_corte', 'c.warehouse_id', 'w.code as warehouse_code', 'w.name as warehouse_name',
        'c.pares', 'c.pares_en_cero', 'c.unidades_total', 'c.valor_total', 'c.pares_sin_costo',
        'c.cierre_semana', 'c.cierre_mes', 'c.cierre_trimestre', 'c.cierre_anio',
        ...nuevas,
      )
      .orderBy([{ column: 'c.fecha_corte', order: 'desc' }, { column: 'w.code' }]);
    if (desde) q.where('c.fecha_corte', '>=', desde);
    if (hasta) q.where('c.fecha_corte', '<=', hasta);
    return q.limit(2000);
  }

  /**
   * Latido a `analytics.cron_runs`. Obligatorio, no cosmético: su umbral vive en
   * `CRON_JOBS` (`stock_snapshot`) y sin registrarlo el sensor de `db-health` cae en
   * `cfg ? classify : 'ok'` — **verde incondicional**, que es el bug que la Fase VP.0
   * salió a cazar. Y para un job cuyo valor es no perder días, un verde falso es lo peor
   * que puede pasar: nadie se enteraría hasta necesitar la historia que no se tomó.
   */
  private async latir(r: SnapshotResult, ms: number, error: string | null): Promise<void> {
    try {
      await this.knex('analytics.cron_runs')
        .insert({
          tenant_id: MEGA,
          job_key: 'stock_snapshot',
          label: 'Foto diaria de inventario',
          last_start: this.knex.fn.now(),
          last_finish: this.knex.fn.now(),
          // Cero almacenes fotografiados es FALLA, no éxito silencioso: el caso real es
          // que la query corra bien contra una tabla que quedó vacía.
          // [EX.H0] Y una foto SIN los costos del día también: se tomó (no se pierde el día),
          // pero la historia de ese día no se podrá valuar. Verde sería mentir.
          status: error || r.warehouses === 0 || !r.esquema_ex_h0 ? 'error' : 'ok',
          rows_affected: r.pares,
          duration_ms: ms,
          note: error
            ? null
            : `${r.fecha_corte} · ${r.warehouses} almacenes · ${r.pares} pares · ${r.pares_sin_costo} sin costo` +
              (r.pares_retirados ? ` · ${r.pares_retirados} retirados al re-tomar` : ''),
          error: error
            ? error.slice(0, 500)
            : r.warehouses === 0
              ? 'cero almacenes fotografiados'
              : !r.esquema_ex_h0
                ? 'foto tomada SIN costos del día: falta aplicar la migración EX.H0'
                : null,
          host: 'api',
          updated_at: this.knex.fn.now(),
        })
        .onConflict(['tenant_id', 'job_key'])
        .merge(['label', 'last_start', 'last_finish', 'status', 'rows_affected', 'duration_ms', 'note', 'error', 'host', 'updated_at']);
    } catch {
      /* el latido nunca rompe al que late (criterio de cron-heartbeat.js) */
    }
  }
}
