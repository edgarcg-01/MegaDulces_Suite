import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, ScopeService, branchName } from '@megadulces/platform-core';
import type { CortesAlcance, CortesSucursalesResponse } from '@megadulces/contracts';
import { armarRespuesta, type CorteCrudo } from './cortes-sucursales.engine';

/**
 * `[CSU.1]` Cortes/Sucursales — lectura pura sobre el ODS, sin importer (derive-no-copy).
 *
 *  · Corte  = `kepler_ods.kdue` cargo (`c29='C'`) del cliente `CONTADO`, grupo 23 tipo 1
 *             ("Corte de Caja POS"). `c7` fecha, `c11` importe, `c16` = `Caja <caja>-<folio>`.
 *  · Cobros = aplicaciones VIGENTES (`analytics.kepler_kdm5_vigente`: kdm5 sin documentos cancelados,
 *             `[CSU.11]`) cuyo cargo es el corte (`c8='D'`, `c9=23`, `c10=1`, `c11` = folio del corte).
 *             Forma de pago y concepto de `analytics.erp_collections`.
 *  · Arqueo = `analytics.cash_cuts` por (sucursal, caja, folio). ⚠️ El folio de arqueo se REPITE
 *             entre fechas (Hidalgo caja 1 folio 93 aparece 22-sep, 28-sep y 2-oct): se casa con
 *             la fecha más cercana dentro de ±3 días, nunca con cualquiera.
 *  · `[CSU.7]` Devoluciones = `kepler_ods.kdm1` notas de crédito POS (`U-A-21-1` fiscal, `U-A-25-1`
 *             no fiscal) no canceladas, ligadas al turno por `c81` (caja) + `c80` (folio de turno)
 *             y ±1 día. El corte ya las resta; el arqueo no — el motor juzga contra el neto.
 *
 * Costo medido en prod (2026-10-05): un mes completo, 106 cortes, 630-750 ms en caliente; casi todo
 * el tiempo es la vista analytics.erp_collections (forma de pago del cobro).
 * Replica cruzada (un corte de otra plaza en la replica de esta): medido 0 en las 8 sucursales;
 * igual se filtra c1 = sucursal para que el dia que aparezca no fabrique un corte fantasma.
 * `kepler_ods.*` no tiene tenant ni RLS; `analytics.*` sin RLS → filtro tenant explícito.
 *
 * `[CSU.6]` ALCANCE POR SUCURSAL (decisión de Francisco, 2026-10-05): Finanzas ve todas;
 * encargados y auxiliares de tienda, sólo la suya. Lo resuelve `ScopeService` (ADR-050) con
 * `role_scopes`/`user_scopes` — el mismo mecanismo del arqueo de tienda —, no un `if` por rol.
 * Medido en prod con el servicio real: 31 de las 32 personas de Finanzas resuelven `all`, los
 * encargados/auxiliares `own` = su `warehouse_code`, y quien no tiene sucursal asignada, ninguna.
 */
/*
 * `[CSU.10]` RENDIMIENTO — la pantalla dejó de cargar (pedido: ≤ 0.5 s). Misma salida, otra forma:
 *  · ANTES cada corte corría su propio LATERAL contra `analytics.erp_collections`, una vista con
 *    DISTINCT ON sobre TODOS los cobros de la historia: la vista se re-evaluaba por corte, y el
 *    costo crecía con el mes (≈6 s con ~200 cortes el 8-oct; 501 cortes el 20-oct).
 *  · AHORA la vista se consulta UNA vez, aparte (`SQL_COBROS`), con la lista exacta de cobros
 *    (`= ANY` sobre sus columnas DISTINCT ON, así el filtro baja a `kdm1`), y se casa en memoria.
 *  · `ap` se arma desde los cortes (folio incluido) para entrar completo a `ix_kdm5_aplicacion_factura`.
 *  · `dv` repite sus filtros con la forma EXACTA de `ix_kdm1_abono_doc` (btrim(sucursal), btrim(c1),
 *    c4::int, c5::int). Son redundantes con los originales —se suman con AND, no los reemplazan—,
 *    así que no cambian qué filas entran: sólo dejan usar el índice.
 *  · LATERAL por corte → agregados por llave (sucursal, folio) con JOIN, una pasada cada uno. Los
 *    agregados `a`/`d` van MATERIALIZED: sin eso el planner los inlinea y los recalcula por corte.
 * Medido (2026-10-21) en banco LOCAL a escala de prod (`kdm1` 880,697 filas / 825 MB, 504 cortes):
 * vieja 88,615 ms → nueva 192 ms (medianas), salida idéntica. En prod: `NO MEDIDO` (sin lectura).
 * Re-medir: `database/scripts/csu-cortes-bench-local.js` (local) y `csu-cortes-paridad-prod.js` (prod).
 */
const SQL = `
WITH co AS MATERIALIZED (
  SELECT DISTINCT ON (e.sucursal, btrim(e.c6))
         e.sucursal,
         btrim(e.c6)                                            AS folio,
         to_char(e.c7::date, 'YYYY-MM-DD')                      AS fecha,
         e.c7::date                                             AS fecha_d,
         btrim(e.c16)                                           AS referencia,
         substring(btrim(e.c16) from '^Caja ([0-9]+)-')         AS caja,
         substring(btrim(e.c16) from '^Caja [0-9]+-([0-9]+)$')  AS turno,
         round(e.c11::numeric, 2)                               AS monto
    FROM kepler_ods.kdue e
   WHERE btrim(e.c2) = 'CONTADO' AND e.c29 = 'C' AND e.c4 = 23 AND e.c5 = 1
     AND btrim(e.c1) = e.sucursal                 -- el documento es de SU plaza (filtro canonico, Fase PO)
     AND e.c7 >= ?::date AND e.c7 < (?::date + 1)
     AND (?::boolean OR e.sucursal = ANY(?::text[]))   -- alcance: todas, o sólo las permitidas
   ORDER BY e.sucursal, btrim(e.c6)
),
sucs AS MATERIALIZED (SELECT DISTINCT sucursal FROM co),
ap AS MATERIALIZED (
  -- Desde el corte: (sucursal, folio) entra completo a ix_kdm5_aplicacion_factura. co trae UNA fila
  -- por (sucursal, folio) (DISTINCT ON), así que el JOIN no duplica aplicaciones.
  SELECT DISTINCT co.sucursal, co.folio AS corte_folio,
         'U' || btrim(m.c3) || lpad(btrim(m.c4::text), 2, '0') || lpad(btrim(m.c5::text), 2, '0') AS doc_prefix,
         btrim(m.c6) AS folio, round(m.c13::numeric, 2) AS monto
    FROM co
    -- [CSU.11] Las aplicaciones VIGENTES, no kdm5 crudo: un cobro cancelado en Kepler (cabecera
    -- c43 = 'C', importe 0) conserva su aplicación con el monto completo y contaba como cobrado.
    -- Medido en prod (21-oct): 14 de 1,218 aplicaciones a cortes de octubre, $171,986.56. La
    -- vista tiene las mismas columnas que kdm5 y se aplana: los filtros siguen entrando al índice.
    JOIN analytics.kepler_kdm5_vigente m
      ON m.c2 = 'U' AND btrim(m.c1) = co.sucursal AND btrim(m.c8) = 'D' AND btrim(m.c9::text) = '23'
     AND btrim(m.c10::text) = '1' AND btrim(m.c11) = co.folio
   WHERE btrim(m.c1) = m.sucursal
),
a AS MATERIALIZED (
  -- MATERIALIZED a propósito (medido en el banco local de CSU.10): sin él el planner inlinea el
  -- agregado y lo RE-CALCULA por corte (GroupAggregate loops=504), o sea el mismo patrón cuadrático.
  SELECT sucursal, corte_folio, sum(monto) AS cobrado,
         jsonb_agg(jsonb_build_object('doc_prefix', doc_prefix, 'folio', folio, 'monto', monto) ORDER BY folio) AS cobros
    FROM ap GROUP BY 1, 2
),
apc AS MATERIALIZED (
  -- [CSU.13] Los cobros CANCELADOS aplicados al corte, de la vista hermana de la vigente (mismo casado
  -- que ap). Se publican para verlos marcados y encontrarlos con el buscador: NO suman. La fecha y el
  -- concepto salen de su cabecera en kdm1, por la llave primaria del documento dueño.
  SELECT DISTINCT co.sucursal, co.folio AS corte_folio,
         'U' || btrim(m.c3) || lpad(btrim(m.c4::text), 2, '0') || lpad(btrim(m.c5::text), 2, '0') AS doc_prefix,
         btrim(m.c6) AS folio, round(m.c13::numeric, 2) AS monto,
         to_char(k.c9::date, 'YYYY-MM-DD') AS fecha, nullif(btrim(k.c24), '') AS concepto
    FROM co
    JOIN analytics.kepler_kdm5_cancelado m
      ON m.c2 = 'U' AND btrim(m.c1) = co.sucursal AND btrim(m.c8) = 'D' AND btrim(m.c9::text) = '23'
     AND btrim(m.c10::text) = '1' AND btrim(m.c11) = co.folio
    LEFT JOIN kepler_ods.kdm1 k
      ON k.sucursal = m.c1 AND k.c1 = m.c1 AND k.c2 = m.c2 AND k.c3 = m.c3 AND k.c4 = m.c4 AND k.c5 = m.c5 AND k.c6 = m.c6
   WHERE btrim(m.c1) = m.sucursal
),
ac AS MATERIALIZED (
  SELECT sucursal, corte_folio,
         jsonb_agg(jsonb_build_object('doc_prefix', doc_prefix, 'folio', folio, 'monto', monto, 'fecha', fecha, 'concepto', concepto)
                   ORDER BY folio) AS cobros_cancelados
    FROM apc GROUP BY 1, 2
),
dv AS MATERIALIZED (
  -- [CSU.7] Notas de crédito POS pagadas en caja (UA2101 fiscal, UA2501 no fiscal), con su turno.
  -- [CSU.10] La segunda línea del WHERE repite la primera con la forma de ix_kdm1_abono_doc.
  SELECT m.sucursal, btrim(m.c81) AS caja, btrim(m.c80::text) AS turno, m.c9::date AS fecha_d,
         'UA' || lpad(btrim(m.c4::text), 2, '0') || lpad(btrim(m.c5::text), 2, '0') AS doc_prefix,
         btrim(m.c6) AS folio, round(m.c16::numeric, 2) AS monto,
         nullif(btrim(m.c32), '') AS cliente, nullif(btrim(m.c24), '') AS motivo, nullif(btrim(m.c67), '') AS cajero
    FROM kepler_ods.kdm1 m
   WHERE m.c2 = 'U' AND m.c3 = 'A' AND m.c4::text IN ('21', '25') AND m.c5::text = '1'
     AND btrim(m.sucursal) = ANY(ARRAY(SELECT sucursal FROM sucs)) AND btrim(m.c1) = ANY(ARRAY(SELECT sucursal FROM sucs))
     AND (m.c4)::integer IN (21, 25) AND (m.c5)::integer = 1
     AND btrim(m.c1) = m.sucursal AND coalesce(m.c43, '') <> 'C'
     AND m.c9 >= (?::date - 1) AND m.c9 < (?::date + 2)
     AND m.sucursal IN (SELECT sucursal FROM sucs)
),
d AS MATERIALIZED (
  -- MATERIALIZED por lo mismo que el agregado de cobros: se calcula una vez, no una por corte.
  -- El folio de turno se repite entre fechas: sólo la devolución del día del corte (±1 por medianoche).
  SELECT co.sucursal, co.folio,
         jsonb_agg(jsonb_build_object(
           'doc_prefix', dv.doc_prefix, 'folio', dv.folio, 'fecha', to_char(dv.fecha_d, 'YYYY-MM-DD'), 'monto', dv.monto,
           'cliente', dv.cliente, 'motivo', dv.motivo, 'cajero', dv.cajero) ORDER BY dv.doc_prefix, dv.folio) AS devoluciones
    FROM co
    JOIN dv ON dv.sucursal = co.sucursal AND dv.caja = co.caja AND dv.turno = co.turno AND abs(dv.fecha_d - co.fecha_d) <= 1
   GROUP BY 1, 2
)
SELECT co.sucursal, co.folio, co.fecha, co.referencia, co.caja, co.turno, co.monto,
       a.cobros, coalesce(a.cobrado, 0) AS cobrado, ac.cobros_cancelados, d.devoluciones,
       to_char(cc.business_date, 'YYYY-MM-DD') AS arqueo_fecha,
       cc.efectivo_esperado, cc.efectivo_contado,
       cc.tarjeta_esperado, cc.tarjeta_contado,
       cc.transfer_esperado, cc.transfer_contado,
       cc.cajero_cierre,
       -- [CSU.9] Las denominaciones: el UNICO efectivo que alguien conto. efectivo_contado es un
       -- numero declarado y es identico al esperado en el 81.2% de los cortes, asi que el veredicto
       -- "cuadra" sale de comparar una cifra contra si misma. OJO: arqueo_otros (c45) NO entra.
       cc.arqueo_billetes, cc.arqueo_monedas, cc.efectivo_retirado
  FROM co
  LEFT JOIN a ON a.sucursal = co.sucursal AND a.corte_folio = co.folio
  LEFT JOIN ac ON ac.sucursal = co.sucursal AND ac.corte_folio = co.folio
  LEFT JOIN d ON d.sucursal = co.sucursal AND d.folio = co.folio
  LEFT JOIN LATERAL (
    SELECT c.* FROM analytics.cash_cuts c
     WHERE c.tenant_id = ?::uuid AND c.warehouse_code = co.sucursal AND c.caja = co.caja AND c.folio = co.turno
       AND abs(c.business_date - co.fecha_d) <= 3
     ORDER BY abs(c.business_date - co.fecha_d), c.business_date DESC
     LIMIT 1
  ) cc ON true
 ORDER BY co.sucursal, co.folio`;

/**
 * `[CSU.10]` Forma de pago, concepto y cuenta de tesorería de los cobros aplicados — UNA consulta a
 * la vista para todos, en vez de una por corte. Los tres `= ANY` van sobre las columnas del
 * DISTINCT ON de la vista, que es lo que permite a Postgres bajarlos hasta `kdm1`. Traen de más
 * (el producto cartesiano de las tres listas); el casado exacto por llave se hace en memoria.
 * [CSU.8] Van las DOS de tesorería: la clase (para no pintar 'CAJA GENERAL' como si fuera un banco)
 * y el nombre. Si el cobro no está en la vista, las dos llegan null y la pantalla no inventa.
 */
const SQL_COBROS = `
SELECT ec.sucursal, ec.doc_prefix, ec.folio, to_char(ec.cobro_date, 'YYYY-MM-DD') AS fecha,
       ec.forma_pago, ec.concepto, ec.medio_cobro, ec.cuenta_tesoreria
  FROM analytics.erp_collections ec
 WHERE ec.tenant_id = ?::uuid AND ec.sucursal = ANY(?::text[]) AND ec.doc_prefix = ANY(?::text[]) AND ec.folio = ANY(?::text[])`;

type CobroCrudo = NonNullable<CorteCrudo['cobros']>[number];
type CobroDetalle = Pick<CobroCrudo, 'fecha' | 'forma_pago' | 'concepto' | 'medio_cobro' | 'cuenta_tesoreria'>;
const llaveCobro = (sucursal: string, docPrefix: string, folio: string): string => `${sucursal}|${docPrefix}|${folio}`;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MES = /^\d{4}-\d{2}$/;

export interface CortesQuery { month?: string; from?: string; to?: string }

@Injectable()
export class CortesSucursalesService {
  private readonly logger = new Logger(CortesSucursalesService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  /** `from`+`to` mandan sobre `month`; sin nada, el mes en curso (hora de México). */
  periodo(q: CortesQuery): { from: string; to: string } {
    if (q.from || q.to) {
      if (!q.from || !q.to || !ISO.test(q.from) || !ISO.test(q.to)) {
        throw new BadRequestException('El rango necesita "from" y "to" con formato AAAA-MM-DD.');
      }
      if (q.from > q.to) throw new BadRequestException('"from" no puede ser posterior a "to".');
      return { from: q.from, to: q.to };
    }
    const hoyMx = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const m = q.month && MES.test(q.month) ? q.month : hoyMx.slice(0, 7);
    const [y, mo] = m.split('-').map(Number);
    const ultimo = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { from: `${m}-01`, to: `${m}-${String(ultimo).padStart(2, '0')}` };
  }

  /**
   * Sucursales que puede ver quien consulta. Se resuelve FUERA de `tk.run` (ScopeService usa su
   * propia conexión), igual que en goods-receipt-proofs.
   */
  private async alcance(): Promise<CortesAlcance> {
    const s = await this.scope.current('finanzas');
    const visibles = this.scope.intersect(s, 'warehouse', null);
    if (visibles === null) return { todas: true, sucursales: [] };
    return {
      todas: false,
      sucursales: [...visibles].sort().map((codigo) => ({ codigo, nombre: branchName(codigo) })),
    };
  }

  async list(q: CortesQuery): Promise<CortesSucursalesResponse> {
    const tenantId = this.tenantCtx.requireTenantId();
    const periodo = this.periodo(q);
    const alcance = await this.alcance();
    // Sin sucursal asignada: no hay nada que consultar. Se declara en `alcance`, no se pinta vacío a secas.
    if (!alcance.todas && alcance.sucursales.length === 0) return armarRespuesta([], {}, periodo, alcance);
    const codigos = alcance.sucursales.map((x) => x.codigo);
    const t0 = Date.now();
    return this.tk.run(async (trx) => {
      const r = await trx.raw(SQL, [periodo.from, periodo.to, alcance.todas, codigos, periodo.from, periodo.to, tenantId]);
      const filas = r.rows as CorteCrudo[];
      await this.completarCobros(trx, tenantId, filas);
      const nom = await trx.raw(
        `SELECT warehouse_code, max(warehouse_name) AS nombre FROM analytics.cash_cuts WHERE tenant_id = ?::uuid GROUP BY 1`,
        [tenantId],
      );
      const nombres: Record<string, string> = {};
      for (const x of nom.rows as Array<{ warehouse_code: string; nombre: string | null }>) {
        if (x.nombre) nombres[x.warehouse_code] = x.nombre;
      }
      const resp = armarRespuesta(filas, nombres, periodo, alcance);
      this.logger.debug(`cortes ${periodo.from}..${periodo.to}: ${resp.totales.cortes} en ${Date.now() - t0} ms`);
      return resp;
    });
  }

  /**
   * `[CSU.10]` Pega a cada cobro aplicado su detalle de `analytics.erp_collections`, con la misma
   * semántica del LEFT JOIN que reemplaza: cobro sin fila en la vista → los cinco campos en null.
   */
  private async completarCobros(trx: Knex.Transaction, tenantId: string, filas: CorteCrudo[]): Promise<void> {
    const sucs = new Set<string>(), prefijos = new Set<string>(), folios = new Set<string>();
    for (const f of filas) {
      for (const c of f.cobros || []) { sucs.add(f.sucursal); prefijos.add(c.doc_prefix); folios.add(c.folio); }
    }
    const detalle = new Map<string, CobroDetalle>();
    if (folios.size) {
      const r = await trx.raw(SQL_COBROS, [tenantId, [...sucs], [...prefijos], [...folios]]);
      for (const x of r.rows as Array<CobroDetalle & { sucursal: string; doc_prefix: string; folio: string }>) {
        detalle.set(llaveCobro(x.sucursal, x.doc_prefix, x.folio), {
          fecha: x.fecha, forma_pago: x.forma_pago, concepto: x.concepto,
          medio_cobro: x.medio_cobro, cuenta_tesoreria: x.cuenta_tesoreria,
        });
      }
    }
    for (const f of filas) {
      if (!f.cobros) continue;
      f.cobros = f.cobros.map((c) => {
        const d = detalle.get(llaveCobro(f.sucursal, c.doc_prefix, c.folio));
        return {
          ...c,
          fecha: d?.fecha ?? null, forma_pago: d?.forma_pago ?? null, concepto: d?.concepto ?? null,
          medio_cobro: d?.medio_cobro ?? null, cuenta_tesoreria: d?.cuenta_tesoreria ?? null,
        };
      });
    }
  }
}
