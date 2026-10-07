import { Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * PV.4 (Fase PV, ADR-041 + ADR-056) — Auditor del TIPO de poliza.
 *
 * Nace de revisar dos documentos reales: un TXT de polizas de ContPAQi (tipo 2 =
 * Egresos) contra un PDF de Kepler del doctype XA1001 "Gastos" (tipo D = Diario).
 * La sospecha era que Kepler asignaba mal el tipo.
 *
 * Medido, NO era asi: XA1001 abona a 201/203 (proveedores), no a efectivo, o sea es
 * un DEVENGO y Diario es correcto. Lo que si existe son dos cosas distintas:
 *
 *  A) Incongruencias del catalogo de Kepler (kdmm): doctypes cuyo tipo de poliza
 *     declarado (c18) no concuerda con las cuentas que mueve (c19 cargo / c20 abono).
 *     La regla sale del propio catalogo: si toca efectivo o equivalentes (familias
 *     102 y 111 bancos, 110 caja) el tipo debe ser E o I; si no los toca, debe ser D.
 *     Ojo: el criterio ingenuo "mueve 102" marcaba 24 doctypes, 18 de ellos falsos
 *     positivos, porque un pago en efectivo mueve caja (110), no banco.
 *
 *  B) Brecha de MODELO entre Kepler y ContPAQi: Kepler registra el gasto en dos
 *     tiempos (devengo contra proveedores, despues pago contra banco) y ContPAQi en
 *     uno solo (gasto + IVA contra banco). Se mide comparando monto por tipo de
 *     poliza y mes entre las dos fuentes de analytics.gl_polizas.
 *
 * ADR-056: lo que no se puede medir se DECLARA. Cada bloque devuelve un estado con
 * motivo; una fuente vacia NUNCA se reporta como cero hallazgos, porque
 * "0 incongruencias" y "no hay con que medirlas" se leen igual en pantalla y
 * significan lo contrario.
 *
 * Todo sale del ODS y de analytics (derive-no-copy): sin importer, sin tabla nueva.
 */

/** Familias de cuenta que SON efectivo o equivalente en este catalogo. */
const EFECTIVO_RE = '^(102|110|111)';

export type MeasureState = 'measured' | 'not_measured';

export interface MeasuredBlock<T> {
  state: MeasureState;
  /** Por que no se pudo medir. Null cuando el estado es measured. */
  reason: string | null;
  data: T;
}

export interface DoctypeVerdict {
  doc: string;
  descripcion: string;
  tipo_declarado: string;
  tipo_esperado: string;
  cargo: string | null;
  abono: string | null;
  veredicto: string;
  docs: number;
  importe: number;
}

export interface CatalogAudit {
  incongruentes: DoctypeVerdict[];
  /** Doctypes sin cuentas declaradas: no se pueden juzgar. Se cuentan, no se aprueban. */
  no_juzgables: { doctypes: number; docs: number; importe: number };
  ok: number;
  total: number;
}

export interface CrossGapRow {
  anio_mes: string;
  tipo_pol: string;
  kepler_polizas: number;
  kepler_monto: number;
  contpaqi_polizas: number;
  contpaqi_monto: number;
  brecha: number;
}

const CATALOG_SQL = `
  WITH cat AS (
    SELECT DISTINCT ON (c1, c2, c3, c4)
           c1, c2, c3::int AS c3, c4::int AS c4, c5 AS descripcion,
           c18 AS tipo, nullif(c19, '') AS cargo, nullif(c20, '') AS abono
      FROM kepler_ods.kdmm
     ORDER BY c1, c2, c3, c4, c18
  ), j AS (
    SELECT cat.*,
           coalesce(cargo, '') ~ '${EFECTIVO_RE}' AS entra_efectivo,
           coalesce(abono, '') ~ '${EFECTIVO_RE}' AS sale_efectivo,
           (cargo IS NULL AND abono IS NULL) AS sin_cuentas
      FROM cat
  ), v AS (
    SELECT j.*,
           CASE WHEN sin_cuentas THEN NULL
                WHEN sale_efectivo AND NOT entra_efectivo THEN 'E'
                WHEN entra_efectivo AND NOT sale_efectivo THEN 'I'
                WHEN entra_efectivo AND sale_efectivo THEN 'E/I'
                ELSE 'D' END AS tipo_esperado
      FROM j
  )
  SELECT v.c1 || '-' || v.c2 || '-' || v.c3 || '-' || v.c4 AS doc,
         v.descripcion, v.tipo, v.cargo, v.abono,
         coalesce(v.tipo_esperado, '?') AS tipo_esperado,
         CASE WHEN v.sin_cuentas THEN 'no_juzgable'
              WHEN (v.entra_efectivo OR v.sale_efectivo) AND v.tipo = 'D'
                   THEN 'mueve efectivo pero esta declarado Diario'
              WHEN NOT (v.entra_efectivo OR v.sale_efectivo) AND v.tipo IN ('E', 'I')
                   THEN 'no mueve efectivo pero esta declarado Egreso/Ingreso'
              ELSE 'ok' END AS veredicto,
         coalesce(d.docs, 0) AS docs,
         coalesce(d.importe, 0) AS importe
    FROM v
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS docs, round(sum(coalesce(k.c16, 0)))::bigint AS importe
        FROM kepler_ods.kdm1 k
       WHERE k.c2 = v.c1 AND k.c3 = v.c2 AND k.c4 = v.c3 AND k.c5 = v.c4
         AND k.c9 >= ?::date AND k.c9 < ?::date
    ) d ON true`;

const CROSS_SQL = `
  WITH base AS (
    SELECT anio_mes, tipo_pol, source,
           count(*)::int AS polizas,
           round(sum(abs(coalesce(cargos, 0))))::bigint AS monto
      FROM analytics.gl_polizas
     WHERE tenant_id = ?
       AND anio_mes >= to_char(now() - make_interval(months => ?::int), 'YYYY-MM')
     GROUP BY 1, 2, 3
  )
  SELECT anio_mes, tipo_pol,
         coalesce(sum(polizas) FILTER (WHERE source = 'kepler'), 0)::int      AS kepler_polizas,
         coalesce(sum(monto)   FILTER (WHERE source = 'kepler'), 0)::bigint   AS kepler_monto,
         coalesce(sum(polizas) FILTER (WHERE source = 'contpaqi'), 0)::int    AS contpaqi_polizas,
         coalesce(sum(monto)   FILTER (WHERE source = 'contpaqi'), 0)::bigint AS contpaqi_monto,
         (coalesce(sum(monto) FILTER (WHERE source = 'kepler'), 0)
          - coalesce(sum(monto) FILTER (WHERE source = 'contpaqi'), 0))::bigint AS brecha
    FROM base
   GROUP BY 1, 2
   ORDER BY anio_mes DESC, 7 DESC`;

@Injectable()
export class PolizaTypeAuditService {
  private readonly logger = new Logger(PolizaTypeAuditService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Resuelve con que conexion correr. Desde HTTP no se pasa nada y va por
   * TenantKnexService (que es obligatorio donde hay RLS forzado); desde el cron el
   * bridge pasa su propio knex, porque ahi no hay contexto de request del cual
   * sacar el tenant. Ni kepler_ods ni analytics tienen RLS, asi que en el camino
   * del cron basta el filtro de tenant explicito.
   */
  private withDb<T>(knex: Knex | undefined, fn: (db: Knex | Knex.Transaction) => Promise<T>): Promise<T> {
    return knex ? fn(knex) : this.tk.run((trx) => fn(trx));
  }

  /**
   * (A) Congruencia del catalogo de Kepler. Medible mientras el ODS tenga kdmm; si
   * no lo tiene, se declara en vez de devolver una lista vacia.
   *
   * anio: ventana para el volumen (docs / importe) de cada doctype, que es lo que
   * separa la incongruencia VIVA del catalogo dormido.
   */
  async catalogAudit(anio?: number, knex?: Knex): Promise<MeasuredBlock<CatalogAudit>> {
    const y = anio && anio > 2000 ? anio : new Date().getFullYear();
    const vacio: CatalogAudit = {
      incongruentes: [],
      no_juzgables: { doctypes: 0, docs: 0, importe: 0 },
      ok: 0,
      total: 0,
    };

    return this.withDb(knex, async (trx) => {
      const existe = await trx.raw(`SELECT to_regclass('kepler_ods.kdmm') AS t`);
      if (!existe?.rows?.[0]?.t) {
        return { state: 'not_measured', reason: 'kepler_ods.kdmm no existe en esta base', data: vacio };
      }
      const n = await trx.raw('SELECT count(*)::int AS n FROM kepler_ods.kdmm');
      if (!Number(n?.rows?.[0]?.n || 0)) {
        return {
          state: 'not_measured',
          reason: 'kepler_ods.kdmm sin filas: el catalogo de doctypes no llego al ODS',
          data: vacio,
        };
      }

      const { rows } = await trx.raw(CATALOG_SQL, [`${y}-01-01`, `${y + 1}-01-01`]);
      const incongruentes: DoctypeVerdict[] = [];
      let noJuzDoctypes = 0;
      let noJuzDocs = 0;
      let noJuzImporte = 0;
      let ok = 0;

      for (const r of rows) {
        const docs = Number(r.docs || 0);
        const importe = Number(r.importe || 0);
        if (r.veredicto === 'no_juzgable') {
          noJuzDoctypes++;
          noJuzDocs += docs;
          noJuzImporte += importe;
        } else if (r.veredicto === 'ok') {
          ok++;
        } else {
          incongruentes.push({
            doc: r.doc,
            descripcion: r.descripcion || '',
            tipo_declarado: r.tipo,
            tipo_esperado: r.tipo_esperado,
            cargo: r.cargo,
            abono: r.abono,
            veredicto: r.veredicto,
            docs,
            importe,
          });
        }
      }
      incongruentes.sort((a, b) => b.importe - a.importe || b.docs - a.docs);

      return {
        state: 'measured',
        reason: null,
        data: {
          incongruentes,
          no_juzgables: { doctypes: noJuzDoctypes, docs: noJuzDocs, importe: noJuzImporte },
          ok,
          total: rows.length,
        },
      };
    });
  }

  /**
   * (B) Brecha de modelo Kepler vs ContPAQi por tipo de poliza y mes.
   *
   * NO pretende casar poliza contra poliza: no existe liga 1:1 entre los dos
   * sistemas (los gastos pagados al banco ni siquiera traen CFDI). Compara la forma:
   * cuanto clasifico cada sistema en cada tipo, mes a mes.
   */
  async crossAudit(meses = 6, tenantId?: string, knex?: Knex): Promise<MeasuredBlock<CrossGapRow[]>> {
    const tid = tenantId || this.tenantCtx.requireTenantId();
    const ventana = Math.min(36, Math.max(1, Number(meses) || 6));

    return this.withDb(knex, async (trx) => {
      const cobertura: any = await trx('analytics.gl_polizas')
        .where('tenant_id', tid)
        .select(
          trx.raw(`COUNT(*) FILTER (WHERE source = 'kepler')::int AS kepler`),
          trx.raw(`COUNT(*) FILTER (WHERE source = 'contpaqi')::int AS contpaqi`),
        )
        .first();

      const faltan: string[] = [];
      if (!Number(cobertura?.kepler || 0)) faltan.push('Kepler');
      if (!Number(cobertura?.contpaqi || 0)) faltan.push('ContPAQi');
      if (faltan.length) {
        return {
          state: 'not_measured',
          reason: `analytics.gl_polizas sin filas de ${faltan.join(' ni ')}: el importer no ha corrido contra esta base`,
          data: [] as CrossGapRow[],
        };
      }

      const { rows } = await trx.raw(CROSS_SQL, [tid, ventana]);
      return {
        state: 'measured',
        reason: null,
        data: rows.map((r: any) => ({
          anio_mes: r.anio_mes,
          tipo_pol: r.tipo_pol,
          kepler_polizas: Number(r.kepler_polizas || 0),
          kepler_monto: Number(r.kepler_monto || 0),
          contpaqi_polizas: Number(r.contpaqi_polizas || 0),
          contpaqi_monto: Number(r.contpaqi_monto || 0),
          brecha: Number(r.brecha || 0),
        })),
      };
    });
  }

  /** Vista de cabecera: las dos reglas, cada una con su estado de medicion explicito. */
  async summary(anio?: number, tenantId?: string, knex?: Knex) {
    const [catalogo, cruce] = await Promise.all([
      this.catalogAudit(anio, knex),
      this.crossAudit(6, tenantId, knex),
    ]);
    const vivos = catalogo.data.incongruentes.filter((i) => i.docs > 0);
    return {
      catalogo: {
        state: catalogo.state,
        reason: catalogo.reason,
        incongruentes: catalogo.data.incongruentes.length,
        /* Con uso en la ventana: separa la incongruencia viva del catalogo dormido. */
        incongruentes_vivos: vivos.length,
        importe_en_riesgo: Math.round(vivos.reduce((a, i) => a + i.importe, 0)),
        no_juzgables: catalogo.data.no_juzgables,
        ok: catalogo.data.ok,
        total: catalogo.data.total,
      },
      cruce: {
        state: cruce.state,
        reason: cruce.reason,
        periodos: cruce.data.length,
        brecha_total: Math.round(cruce.data.reduce((a, r) => a + Math.abs(r.brecha), 0)),
      },
    };
  }
}
