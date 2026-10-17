import { Injectable } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { sqlKeplerPayableId } from '../payment-calendar/payment-calendar.service';

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

/**
 * `[PP.2]` **Por qué decimos lo que decimos de esta factura.**
 *
 * ⛔ `sin_medir` mezclaba dos cosas que para quien paga NO son lo mismo, y medirlo lo confirmó:
 *
 * | | docs | pendiente | proveedores |
 * |---|---:|---:|---:|
 * | **nunca** dio descuento en 12 meses | 763 | $27,321,330 | 82 |
 * | lo dio 1 o 2 veces (no alcanza) | 48 | $3,648,747 | 18 |
 *
 * Al primero no hay nada que pedirle; al segundo vale la pena preguntarle. Por eso el MOTIVO va
 * aparte del estado: el estado contesta *"¿puedo actuar sobre una fecha?"*, el motivo contesta
 * *"¿por qué, y qué hago si no?"*.
 *
 * ⚠️ `estado` NO se parte en más valores a propósito: los cuatro siguen respondiendo la misma
 * pregunta y partirlos obligaría a tocar el filtro, los KPIs y el orden por una distinción que es
 * explicativa, no operativa.
 */
export type MotivoPronto =
  | 'historial'            // suficientes pagos y CONCENTRADOS: la ventana es real
  | 'historial_disperso'   // los hay, pero el plazo no explica el descuento
  | 'nunca_dio'            // 12 meses sin un solo pago con descuento a este proveedor
  | 'pocas_veces'          // lo dio 1 o 2 veces: no alcanza para fijar una fecha
  | 'sin_fecha';           // la factura no trae fecha: no hay desde dónde contar

/**
 * `[PP.2]` **Cuándo el plazo NO explica el descuento.**
 *
 * ⛔ Casi me publico una mentira al revés: la primera versión de la frase decía el rango
 * **mínimo–máximo**, y para el proveedor más grande (423 pagos, $15,080,144 de ahorro) eso daba
 * *"entre 0 y 112 días"* — que hace parecer inútil una ventana que en realidad es de **19 a 23**.
 * El máximo es una cola suelta; el estadístico que sirve es el **p90**.
 *
 * ⭐ Y al medirlo bien aparece una distinción que sí hay que decir: en 29 proveedores
 * (**$7,327,046** de ahorro) el p90 está tan lejos de la mediana que el plazo **no manda** — se
 * llevaron descuento pagando a los 4 días y también a los 30. Contra 128 proveedores
 * (**$49,758,200**) donde la ventana es real. Prometerle a Tesorería una fecha límite en los
 * primeros sería mandarla a correr por un plazo que no existe.
 *
 * ⚠️ El umbral es una HEURÍSTICA, no una ley: `p90 > 2×mediana + 7`. Los 7 días evitan marcar
 * como disperso a un proveedor de ventana corta (mediana 4, p90 12 no es dispersión, es ruido).
 * Se declara como lo que es y se puede mover con una medición mejor.
 */
const esDisperso = (med: number, p90: number): boolean => p90 > med * 2 + 7;

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
                 -- [PP.2] La EVIDENCIA detrás de la fecha. Sin esto la pantalla afirma "este
                 -- proveedor da 6.3% a 26 días" y no muestra con qué lo sabe; quien paga no puede
                 -- decidir si confiar en el número ni cuándo ignorarlo.
                 d.dias_p90, d.descuento_12m,
                 CASE WHEN d.n_observaciones >= ${MIN_OBS} AND p.fecha IS NOT NULL
                      THEN p.fecha + d.dias_mediana END AS fecha_limite,
                 CASE WHEN d.n_observaciones >= ${MIN_OBS} AND d.tasa_observada IS NOT NULL
                      THEN round(p.pendiente * d.tasa_observada, 2) END AS beneficio,
                 -- [TP.18.3] CON QUE se programa esta factura en el Calendario (ADR-094).
                 -- Si Compras ya la capturo como entrega, manda esa obligacion (trae fecha
                 -- negociada y acuerdos); si no, va por la deuda DERIVADA con su llave
                 -- determinista. Es la misma regla de dedupe que aplica listObligations, y la
                 -- llave la genera la MISMA funcion: si cambia alla, cambia aca.
                 CASE WHEN o.id IS NOT NULL THEN 'supplier_payable' ELSE 'kepler_payable' END AS obligation_source,
                 coalesce(o.id, ${sqlKeplerPayableId('p')}) AS obligation_id,
                 -- Lo ya comprometido en el Calendario: sin esto el boton ofreceria programar
                 -- de nuevo algo que ya tiene fecha, y el candado de saldo lo rechazaria DESPUES
                 -- del clic -- que es la peor forma de decir que no.
                 coalesce(r.reservado, 0) AS reservado,
                 coalesce(r.pagado, 0)    AS pagado
            FROM analytics.v_supplier_payables p
            LEFT JOIN analytics.mv_supplier_prompt_discount d
                   ON d.proveedor_code = btrim(p.proveedor)
            LEFT JOIN commercial.supplier_payment_obligations o
                   ON o.kepler_sucursal = p.sucursal AND o.kepler_doc_tipo = p.doc_tipo
                  AND o.kepler_doc_sub = p.doc_sub   AND o.kepler_folio    = p.folio
                  AND o.status <> 'cancelled'
            LEFT JOIN LATERAL (
              SELECT coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'pending'), 0)  AS reservado,
                     coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'executed'), 0) AS pagado
                FROM finance.payment_allocation_items i
                JOIN finance.payment_allocations a ON a.id = i.allocation_id
               WHERE i.obligation_id = coalesce(o.id, ${sqlKeplerPayableId('p')})
            ) r ON true
           WHERE p.tenant_id = ? AND p.pendiente > 0.01
             AND btrim(p.proveedor) LIKE 'C%'
        ), clasificado AS (
          SELECT b.*,
                 -- Lo que todavia se puede mandar al Calendario de esta factura.
                 greatest(b.pendiente - b.reservado - b.pagado, 0) AS programable,
                 (b.fecha_limite - CURRENT_DATE) AS dias_restantes,
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
          /**
           * `[TP.18.3]` **El puente con el Calendario** (O2): con QUÉ se programa esta factura y
           * cuánto queda por programar. Sin estos cinco campos la pantalla ve vencer el descuento
           * y no tiene nada que mandar — que es exactamente el estado que O2 viene a cerrar.
           *
           * ⚠️ `obligation_source` no es siempre el mismo: si Compras ya capturó la factura como
           * entrega manda esa obligación (trae fecha negociada y acuerdos); si no, va por la deuda
           * derivada. La decisión se toma en el SQL con la misma regla de dedupe del Calendario.
           */
          obligation_source: r.obligation_source as 'supplier_payable' | 'kepler_payable',
          obligation_id: r.obligation_id as string,
          reservado: num(r.reservado),
          pagado: num(r.pagado),
          /** Lo que todavía se puede mandar al Calendario: `pendiente − reservado − pagado`. */
          programable: num(r.programable),
          ...this.porQue(r),
        })),
        truncado: detalle.length >= limit,
      };
    });
  }

  /**
   * `[PP.2]` El motivo, y la frase que lo dice en llano.
   *
   * ⭐ La arma el SERVIDOR y no la pantalla, por el mismo motivo que la marca de procedencia: es
   * el único lugar que sabe con qué evidencia se calculó. Si la escribiera el front, al cambiar
   * `MIN_OBS` o la derivación la frase seguiría contando la historia vieja.
   *
   * ⚠️ El rango min–max va en la frase y no sólo la mediana: un proveedor que pagó entre 18 y 41
   * días es distinto de uno que pagó siempre a 26, y la mediana sola los hace parecer iguales.
   */
  private porQue(r: any): { motivo: MotivoPronto; porque: string } {
    const n = Number(r.n_observaciones) || 0;
    const dia = (x: any) => Number(x) || 0;
    const pesos = (x: any) => (Number(x) || 0).toLocaleString('es-MX', {
      style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });

    if (n >= MIN_OBS) {
      const med = dia(r.dias_mediana);
      const p90 = dia(r.dias_p90);
      const tasa = r.tasa_observada == null ? '' : ` al ${(Number(r.tasa_observada) * 100).toFixed(1)}%`;
      const cabeza = `${n} pagos a este proveedor obtuvieron descuento${tasa} en los últimos 12 meses`;
      const ahorro = `Nos ahorró ${pesos(r.descuento_12m)}.`;
      // ⚠️ p90 y NO el máximo: el máximo es una cola suelta y hace parecer inútil una ventana
      // que es corta. Medido: el proveedor más grande va de 19 a 23 días, con un máximo de 112.
      if (esDisperso(med, p90)) {
        return {
          motivo: 'historial_disperso',
          porque: `${cabeza}, pero pagando desde los ${med} hasta los ${p90} días. `
                + `El plazo no es lo que lo dispara: la fecha de abajo es poco confiable acá. ${ahorro}`,
        };
      }
      return {
        motivo: 'historial',
        porque: `${cabeza}, pagando a los ${med} días `
              + `(9 de cada 10, antes de ${p90}). ${ahorro}`,
      };
    }
    // ⛔ Las tres ausencias se nombran distinto porque se resuelven distinto (ADR-056).
    if (n === 0) {
      return {
        motivo: 'nunca_dio',
        porque: 'En 12 meses no hubo un solo pago a este proveedor con descuento. '
              + 'No hay historial que diga que lo ofrece.',
      };
    }
    if (!r.fecha) {
      return { motivo: 'sin_fecha', porque: 'La factura no trae fecha: no hay desde dónde contar los días.' };
    }
    return {
      motivo: 'pocas_veces',
      porque: `Sólo ${n} pago${n === 1 ? '' : 's'} con descuento en 12 meses: no alcanza para fijar `
            + `una fecha (hacen falta ${MIN_OBS}). Vale preguntarle al proveedor.`,
    };
  }
}
