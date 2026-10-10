import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * `[PP.1]` — **Lo que Tesorería todavía puede ganar, y hasta cuándo.**
 *
 * Pedido de Edgar (2026-10-10): *"necesitamos darle eso a pagos, para que no perdamos acceso a
 * esos privilegios"*. El privilegio del pronto pago se pierde por FECHA, en silencio: nadie emite
 * un aviso cuando se vence, y la factura se paga igual.
 *
 * ── Lo medido en prod antes de escribir esto (sólo lectura, 2026-10-10) ─────────────────────
 *
 * | | docs | monto |
 * |---|---:|---:|
 * | mercancía pendiente hoy | 1,853 | $93,450,470 |
 * | de proveedor con descuento observado | 988 | $62,227,642 |
 * | con ventana medible (`n >= 3`) | 1,047 | $63,167,459 |
 *
 * ⭐ Y lo ganado de hecho: **$17,094,609 en 12 meses** (`kdm1.c84`, 2,381 pagos).
 *
 * ⛔ **Esta pantalla NO inventa la condición pactada.** El acuerdo con el proveedor no existe
 * como dato en ninguna parte: `commercial.supplier_discount_policy` trae 147 filas **todas
 * `source='observed'`** y con `discount_days` **vacío en el 100%**. Lo que se publica es la
 * ventana **OBSERVADA** ({@link https://../migrations-newdb/20261010111352}), que dice *"cuando le
 * pagamos a este proveedor y nos dieron descuento, fue a los N días"*. Es una guía defendible,
 * no una promesa — y la pantalla lo dice con esas palabras.
 *
 * ⚠️ **Por eso `fuera_de_ventana` NO significa "perdido".** Significa que se pasó la mediana de
 * lo que históricamente funcionó. Decirle "perdido" a algo que todavía podría cobrarse haría que
 * Tesorería dejara de intentarlo — que es el daño opuesto al que esto viene a evitar.
 *
 * ⭐ **Y la mitad retrospectiva NO se reconstruye: ya existe.** `finance.findings` tiene la regla
 * `descuento_no_capturado` con **98 hallazgos por $5,363,294**. Se leen de ahí en vez de volver a
 * detectar lo mismo con otra definición. ⛔ Dos cosas que hay que decir de esos hallazgos y que
 * esta pantalla declara: están **todos en `nuevo`** (nadie triageó uno solo) y el detector
 * **dejó de producir el 2026-08-29** — su scanner no tiene latido, así que callarse fue invisible.
 *
 * Dominio finance: `analytics.*` no tiene RLS → el alcance lo da el JOIN contra
 * `analytics.v_supplier_payables`, que sí lleva `tenant_id`, con filtro explícito.
 */

/** Mínimo de observaciones para publicar una ventana. Medido: con 3 se conserva el 99.7% del descuento. */
const MIN_OBS = 3;

/** Días antes del límite en que un renglón pasa a "por vencer". Es aviso, no regla de negocio. */
const DIAS_AVISO = 5;

export type EstadoPronto = 'capturable' | 'por_vencer' | 'fuera_de_ventana' | 'sin_medir';

export interface ProntoPagoQuery {
  estado?: EstadoPronto;
  search?: string;
  limit?: number;
}

@Injectable()
export class ProntoPagoService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async overview(q: ProntoPagoQuery = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(1000, Math.max(50, Number(q.limit) || 300));

    return this.tk.run(async (trx) => {
      /**
       * ⚠️ `AS MATERIALIZED` en `base`: se referencia tres veces (totales, baldes y detalle) y sin
       * esto PG12+ la inlinea y vuelve a resolver `v_supplier_payables` —que ya cruza kdxe con
       * kdxf— una vez por rama. Medido en la fase: 0.4 s contra más de 1 s.
       */
      const sql = `
        WITH base AS MATERIALIZED (
          SELECT p.sucursal, btrim(p.proveedor) AS proveedor_code, p.proveedor_nombre,
                 p.folio, p.fecha, p.vencimiento, p.pendiente,
                 d.n_observaciones, d.dias_mediana, d.tasa_observada,
                 -- La fecha limite ESTIMADA. NULL cuando no hay ventana medible: sin esto, un
                 -- COALESCE a hoy pondria "vence hoy" sobre algo que nadie midio.
                 CASE WHEN d.n_observaciones >= ${MIN_OBS} AND p.fecha IS NOT NULL
                      THEN p.fecha + d.dias_mediana END AS fecha_limite,
                 CASE WHEN d.n_observaciones >= ${MIN_OBS} AND d.tasa_observada IS NOT NULL
                      THEN round(p.pendiente * d.tasa_observada, 2) END AS beneficio
            FROM analytics.v_supplier_payables p
            LEFT JOIN analytics.mv_supplier_prompt_discount d
                   ON d.proveedor_code = btrim(p.proveedor)
           WHERE p.tenant_id = ? AND p.pendiente > 0.01
             AND btrim(p.proveedor) LIKE 'C%'
        ), clasificado AS (
          SELECT b.*,
                 (b.fecha_limite - CURRENT_DATE) AS dias_restantes,
                 CASE
                   WHEN b.fecha_limite IS NULL                                 THEN 'sin_medir'
                   WHEN b.fecha_limite <  CURRENT_DATE                         THEN 'fuera_de_ventana'
                   WHEN b.fecha_limite <= CURRENT_DATE + ${DIAS_AVISO}         THEN 'por_vencer'
                   ELSE 'capturable'
                 END AS estado
            FROM base b
        )
        SELECT estado,
               count(*)::int                                   AS docs,
               round(sum(pendiente), 2)                        AS monto,
               round(coalesce(sum(beneficio), 0), 2)           AS beneficio
          FROM clasificado GROUP BY estado`;

      const resumen: any[] = (await trx.raw(sql, [tenantId])).rows;

      // ── el detalle, priorizado por URGENCIA y luego por dinero ──────────────────────────────
      // ⚠️ El orden es la mitad del valor de esta pantalla: una lista por importe deja los $200
      // que vencen mañana debajo de los $2M que vencen en tres semanas.
      const filtros: string[] = [];
      const params: any[] = [tenantId];
      if (q.estado) { filtros.push(`estado = ?`); params.push(q.estado); }
      if (q.search) {
        filtros.push(`(proveedor_nombre ILIKE ? OR proveedor_code ILIKE ? OR folio ILIKE ?)`);
        const s = `%${q.search.trim()}%`;
        params.push(s, s, s);
      }
      params.push(limit);

      const detalle: any[] = (await trx.raw(`
        WITH base AS MATERIALIZED (
          SELECT p.sucursal, btrim(p.proveedor) AS proveedor_code, p.proveedor_nombre,
                 p.folio, p.fecha, p.vencimiento, p.pendiente,
                 d.n_observaciones, d.dias_mediana, d.tasa_observada,
                 CASE WHEN d.n_observaciones >= ${MIN_OBS} AND p.fecha IS NOT NULL
                      THEN p.fecha + d.dias_mediana END AS fecha_limite,
                 CASE WHEN d.n_observaciones >= ${MIN_OBS} AND d.tasa_observada IS NOT NULL
                      THEN round(p.pendiente * d.tasa_observada, 2) END AS beneficio
            FROM analytics.v_supplier_payables p
            LEFT JOIN analytics.mv_supplier_prompt_discount d
                   ON d.proveedor_code = btrim(p.proveedor)
           WHERE p.tenant_id = ? AND p.pendiente > 0.01
             AND btrim(p.proveedor) LIKE 'C%'
        ), clasificado AS (
          SELECT b.*, (b.fecha_limite - CURRENT_DATE) AS dias_restantes,
                 CASE
                   WHEN b.fecha_limite IS NULL                         THEN 'sin_medir'
                   WHEN b.fecha_limite <  CURRENT_DATE                 THEN 'fuera_de_ventana'
                   WHEN b.fecha_limite <= CURRENT_DATE + ${DIAS_AVISO} THEN 'por_vencer'
                   ELSE 'capturable'
                 END AS estado
            FROM base b
        )
        SELECT * FROM clasificado
         ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
         ORDER BY CASE estado WHEN 'por_vencer' THEN 0 WHEN 'capturable' THEN 1
                              WHEN 'fuera_de_ventana' THEN 2 ELSE 3 END,
                  dias_restantes ASC NULLS LAST,
                  beneficio DESC NULLS LAST
         LIMIT ?`, params)).rows;

      /**
       * `[PP.1]` La mitad RETROSPECTIVA, leída de donde ya vive. No se re-detecta: una segunda
       * definición de "descuento no capturado" obligaría a alguien a decidir cuál creer.
       */
      const perdido = await trx('finance.findings')
        .where('rule_key', 'descuento_no_capturado')
        .select(
          trx.raw(`count(*)::int AS hallazgos`),
          trx.raw(`round(coalesce(sum(importe),0), 2) AS monto`),
          trx.raw(`count(*) FILTER (WHERE status = 'nuevo')::int AS sin_triage`),
          trx.raw(`max(created_at)::date AS ultimo`),
        )
        .first();

      const bal = (e: string) => resumen.find((r) => r.estado === e)
        || { estado: e, docs: 0, monto: 0, beneficio: 0 };
      const num = (x: any) => Number(x) || 0;

      return {
        /**
         * ADR-056: el número dice con qué se calculó. `ventana: 'observada'` no es decoración —
         * es la diferencia entre "el proveedor prometió" y "esto es lo que históricamente pasó".
         */
        procedencia: {
          ventana: 'observada',
          min_observaciones: MIN_OBS,
          dias_aviso: DIAS_AVISO,
          nota: 'La fecha limite es ESTIMADA a partir de los pagos que si obtuvieron descuento. '
              + 'No es la condicion pactada: ese dato no existe todavia.',
        },
        kpis: {
          capturable: bal('capturable'),
          por_vencer: bal('por_vencer'),
          fuera_de_ventana: bal('fuera_de_ventana'),
          sin_medir: bal('sin_medir'),
          total_pendiente: resumen.reduce((s, r) => s + num(r.monto), 0),
          beneficio_en_juego: num(bal('capturable').beneficio) + num(bal('por_vencer').beneficio),
        },
        perdido: {
          hallazgos: num(perdido?.hallazgos),
          monto: num(perdido?.monto),
          sin_triage: num(perdido?.sin_triage),
          ultimo: perdido?.ultimo ?? null,
        },
        rows: detalle.map((r) => ({
          sucursal: r.sucursal,
          proveedor_code: r.proveedor_code,
          proveedor_nombre: r.proveedor_nombre,
          folio: r.folio,
          fecha: r.fecha,
          vencimiento: r.vencimiento,
          pendiente: num(r.pendiente),
          tasa_observada: r.tasa_observada == null ? null : Number(r.tasa_observada),
          beneficio: r.beneficio == null ? null : Number(r.beneficio),
          dias_mediana: r.dias_mediana == null ? null : Number(r.dias_mediana),
          n_observaciones: num(r.n_observaciones),
          fecha_limite: r.fecha_limite,
          dias_restantes: r.dias_restantes == null ? null : Number(r.dias_restantes),
          estado: r.estado as EstadoPronto,
        })),
        truncado: detalle.length >= limit,
      };
    });
  }
}
