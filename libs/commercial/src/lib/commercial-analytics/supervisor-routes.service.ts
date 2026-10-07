import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import {
  SUPERVISOR_VENTANA_DIAS,
  type SupervisorDia,
  type SupervisorRuta,
  type SupervisorTablero,
} from '@megadulces/contracts';
import { FRESHNESS_UNKNOWN, composeFreshness, evalInput, stepAt, tableAt } from '../shared/freshness';
import { routeCodeSql } from '../shared/route-kind.sql';

/**
 * `[SV.3]` — El tablero del supervisor: cómo van SUS rutas.
 *
 * ── Por qué este servicio existe aparte y no es otro método del god service ─────────────
 * `salesByRouteDashboard` ya lee la MISMA matvista y responde en 7 ms, pero es **tenant-wide**:
 * sirve a `/comercial/ventas-por-ruta`, que miran 10 roles. Meterle el recorte por supervisor
 * cambiaría en silencio lo que ven esos 10. Esto es aditivo: mismo dato, distinto recorte.
 *
 * ── Lo que se midió antes de escribirlo (prod, 2026-10-06) ──────────────────────────────
 *  · La vista `analytics.v_rd_route_daily` tarda **6,722 ms**; la matvista
 *    `analytics.mv_rd_route_daily_200d` da **6 ms** y cuadra EXACTO contra ella
 *    (430 filas, $6,864,850 las dos). El gate del proyecto son 500 ms.
 *  · El COSTO por ruta existe en **1 de 430 filas**. Por eso acá no se publica margen: se
 *    declara. Dibujarlo sería inventar el número que la fase existe para cuidar.
 *  · `commercial.sales_targets` está VACÍA, así que todas las rutas salen `sin_meta`.
 *
 * ⚠️ `business_date <= CURRENT_DATE` no es cosmético: la fuente trae fechas FUTURAS corruptas
 * (la matvista llega a 2026-12-06). Sin ese filtro, el "mes a la fecha" incluiría diciembre.
 */
@Injectable()
export class SupervisorRoutesService {
  private readonly logger = new Logger(SupervisorRoutesService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * El tablero completo. `desde`/`hasta` en `YYYY-MM-DD`.
   *
   * `verTodas` existe porque el eje `route` de `identity.role_scopes` está en `all` para 43 de
   * 49 roles con la nota "default materializado del comportamiento vigente": el recorte a "mis
   * rutas" es el DEFAULT de la pantalla, no una frontera de seguridad. Quien ya podía ver todas
   * las rutas sigue pudiendo; lo que cambia es con qué se le abre la pantalla.
   */
  async tablero(desde: string, hasta: string, verTodas = false): Promise<SupervisorTablero> {
    const dRx = /^\d{4}-\d{2}-\d{2}$/;
    if (!dRx.test(desde) || !dRx.test(hasta)) {
      throw new BadRequestException('desde/hasta deben ser YYYY-MM-DD');
    }
    if (desde > hasta) throw new BadRequestException('desde no puede ser mayor que hasta');

    const tenantId = this.tenantCtx.requireTenantId();
    const me = this.tenantCtx.get()?.userId ?? null;
    if (!me) throw new BadRequestException('Usuario no identificado');

    // La ventana de la matvista. Pedir más atrás NO devuelve menos en silencio: se recorta y se
    // dice en la cobertura. Un rango que se achica sin avisar publica una caída de venta que en
    // realidad es una caída de cobertura.
    const piso = new Date(Date.now() - SUPERVISOR_VENTANA_DIAS * 86400000)
      .toISOString()
      .slice(0, 10);
    const recortado = desde < piso;
    const desdeReal = recortado ? piso : desde;

    const num = (v: unknown) => Number(v) || 0;

    return this.tk.run(async (trx) => {
      // ── 1. El alcance, derivado del organigrama ───────────────────────────────────────
      // `DISTINCT` sobre el CÓDIGO, nunca sobre la fila del catálogo: medido, 3 de las 4 rutas
      // vecinales tienen DOS cuentas de vendedor, y agrupar por vendedor las duplicaría.
      const alc = (
        await trx.raw(
          `SELECT count(u.id)::int                                   AS reportes,
                  count(u.route_id)::int                             AS reportes_con_ruta,
                  coalesce(array_agg(DISTINCT ${routeCodeSql('tc.value')})
                           FILTER (WHERE ${routeCodeSql('tc.value')} IS NOT NULL), '{}') AS rutas
             FROM identity.users u
             LEFT JOIN trade.catalogs tc
                    ON tc.id = u.route_id AND tc.tenant_id = u.tenant_id
                   AND tc.catalog_id = 'rutas' AND tc.deleted_at IS NULL
            WHERE u.supervisor_id = ? AND u.deleted_at IS NULL`,
          [me],
        )
      ).rows[0];

      const misRutas: string[] = alc?.rutas ?? [];
      const reportes = num(alc?.reportes);
      const reportesConRuta = num(alc?.reportes_con_ruta);

      // Las dos ausencias NO son la misma: "nadie me reporta" lo arregla quien administra
      // personas; "mi gente no tiene ruta" lo arregla quien asigna rutas (ADR-056).
      const motivo =
        reportes === 0 ? 'sin_equipo' : misRutas.length === 0 ? 'equipo_sin_ruta' : null;

      // Sin rutas no hay nada que consultar, y devolver listas vacías sin decir por qué es
      // exactamente cómo "no le toca nada" se lee igual que "hoy no vendió nadie".
      if (!verTodas && misRutas.length === 0) {
        return {
          periodo: { desde: desdeReal, hasta, dias: this.dias(desdeReal, hasta) },
          alcance: { reportes, reportes_con_ruta: reportesConRuta, rutas: [], motivo },
          rutas: [],
          serie: [],
          freshness: await this.frescura(trx, tenantId),
          cobertura: {
            measured: false,
            pct: null,
            note:
              motivo === 'sin_equipo'
                ? 'No hay nadie asignado a este supervisor, así que no hay rutas que mostrar.'
                : 'Hay equipo asignado, pero a esas personas no se les declaró ruta.',
          },
        };
      }

      const filtroRutas = verTodas ? '' : 'AND d.route_code = ANY(?)';
      const bindRutas = verTodas ? [] : [misRutas];

      // ── 2. Desempeño por ruta en el periodo ──────────────────────────────────────────
      const porRuta = (
        await trx.raw(
          `SELECT d.route_code,
                  count(DISTINCT d.business_date)::int AS dias_operados,
                  round(sum(d.venta), 2)::float        AS venta,
                  sum(d.tickets)::int                  AS tickets,
                  sum(d.lineas)::int                   AS lineas,
                  round(sum(d.venta) FILTER (WHERE d.costo IS NOT NULL), 2)::float AS venta_con_costo,
                  round(sum(d.costo), 2)::float        AS costo,
                  to_char(max(d.business_date), 'YYYY-MM-DD') AS ultimo_dia
             FROM analytics.mv_rd_route_daily_200d d
            WHERE d.tenant_id = ? AND d.business_date >= ? AND d.business_date <= ?
              AND d.business_date <= CURRENT_DATE ${filtroRutas}
            GROUP BY 1 ORDER BY 3 DESC NULLS LAST`,
          [tenantId, desdeReal, hasta, ...bindRutas],
        )
      ).rows;

      // ── 3. Mes a la fecha + meta ─────────────────────────────────────────────────────
      // La meta de `commercial.sales_targets` es MENSUAL. Compararla contra un rango de una
      // semana obligaría a prorratearla, y prorratear un objetivo mensual entre días hábiles,
      // días naturales o días de visita da tres números distintos — ninguno acordado con nadie.
      // Por eso la meta se compara contra el MES EN CURSO, que es su propio grano, y el rango
      // que el usuario elige manda sobre la venta y la serie, no sobre la meta.
      const mes = hasta.slice(0, 7);
      const mesDesde = mes + '-01';
      const mtd = (
        await trx.raw(
          `SELECT d.route_code, round(sum(d.venta), 2)::float AS venta_mes
             FROM analytics.mv_rd_route_daily_200d d
            WHERE d.tenant_id = ? AND d.business_date >= ?::date
              AND d.business_date <= least(?::date, CURRENT_DATE) ${filtroRutas}
            GROUP BY 1`,
          [tenantId, mesDesde, hasta, ...bindRutas],
        )
      ).rows;
      const ventaMes = new Map<string, number>(mtd.map((r: any) => [r.route_code, num(r.venta_mes)]));

      const metas = (
        await trx.raw(
          `SELECT scope_key, target_monto::float AS meta
             FROM commercial.sales_targets
            WHERE tenant_id = ? AND scope = 'route' AND year_month = ?`,
          [tenantId, mes],
        )
      ).rows;
      const metaPorRuta = new Map<string, number>(metas.map((r: any) => [r.scope_key, num(r.meta)]));

      // ── 4. Etiquetas del catálogo ────────────────────────────────────────────────────
      // ⚠️ `min(value)` a propósito: dos filas del catálogo pueden dar el mismo código
      // ('Ruta 501' y 'RUTA 501'). Sin el agregado, el JOIN duplicaría la fila de la ruta.
      const etiquetas = (
        await trx.raw(
          `SELECT ${routeCodeSql('tc.value')} AS cod, min(btrim(tc.value)) AS etiqueta
             FROM trade.catalogs tc
            WHERE tc.tenant_id = ? AND tc.catalog_id = 'rutas' AND tc.deleted_at IS NULL
              AND ${routeCodeSql('tc.value')} IS NOT NULL
            GROUP BY 1`,
          [tenantId],
        )
      ).rows;
      const etiqueta = new Map<string, string>(etiquetas.map((r: any) => [r.cod, r.etiqueta]));

      // ── 5. Serie día a día (el filtro por semana se arma sobre esto) ─────────────────
      const serie: SupervisorDia[] = (
        await trx.raw(
          `SELECT d.route_code,
                  to_char(d.business_date, 'YYYY-MM-DD') AS business_date,
                  round(sum(d.venta), 2)::float          AS venta,
                  sum(d.tickets)::int                    AS tickets
             FROM analytics.mv_rd_route_daily_200d d
            WHERE d.tenant_id = ? AND d.business_date >= ? AND d.business_date <= ?
              AND d.business_date <= CURRENT_DATE ${filtroRutas}
            GROUP BY 1, 2 ORDER BY 2, 1`,
          [tenantId, desdeReal, hasta, ...bindRutas],
        )
      ).rows.map((r: any) => ({
        route_code: r.route_code,
        business_date: r.business_date,
        venta: num(r.venta),
        tickets: num(r.tickets),
      }));

      // ── 6. Armado ────────────────────────────────────────────────────────────────────
      const rutas: SupervisorRuta[] = porRuta.map((r: any) => {
        const vMes = ventaMes.get(r.route_code) ?? 0;
        const meta = metaPorRuta.has(r.route_code) ? (metaPorRuta.get(r.route_code) as number) : null;
        const tickets = num(r.tickets);
        const conCosto = num(r.venta_con_costo);
        return {
          route_code: r.route_code,
          etiqueta: etiqueta.get(r.route_code) ?? null,
          dias_operados: num(r.dias_operados),
          venta: num(r.venta),
          tickets,
          lineas: num(r.lineas),
          // 0 tickets devuelve null, nunca 0: un 0 se lee como "vende barato", no como "no vendió".
          ticket_promedio: tickets > 0 ? Math.round((num(r.venta) / tickets) * 100) / 100 : null,
          meta_mes: meta,
          venta_mes: vMes,
          ...this.veredicto(vMes, meta),
          // ⛔ El margen NO se publica: el costo está en 1 de 430 filas de la fuente.
          margen_pct: null,
          margen_motivo:
            conCosto > 0
              ? 'El costo cubre $' + conCosto.toLocaleString('es-MX') + ' de $' +
                num(r.venta).toLocaleString('es-MX') + ' de venta: no alcanza para publicar margen.'
              : 'La fuente declara el costo de esta ruta como sin dato (costo_status=sin_dato_en_la_fuente).',
          ultimo_dia: r.ultimo_dia ?? null,
        };
      });

      const cubiertas = new Set(rutas.map((r) => r.route_code));
      const sinVenta = verTodas ? [] : misRutas.filter((c) => !cubiertas.has(c));

      const notas: string[] = [];
      if (recortado) {
        notas.push(
          'El rango se recortó a ' + desdeReal + ': la fuente materializada cubre ' +
            SUPERVISOR_VENTANA_DIAS + ' días.',
        );
      }
      if (sinVenta.length) {
        notas.push(
          sinVenta.length + ' ruta(s) de tu equipo sin venta en el periodo: ' + sinVenta.join(', ') + '.',
        );
      }
      if (reportes > reportesConRuta) {
        notas.push(
          reportes - reportesConRuta + ' persona(s) de tu equipo no tienen ruta asignada: su venta no aparece acá.',
        );
      }

      return {
        periodo: { desde: desdeReal, hasta, dias: this.dias(desdeReal, hasta) },
        alcance: { reportes, reportes_con_ruta: reportesConRuta, rutas: misRutas, motivo },
        rutas,
        serie,
        freshness: await this.frescura(trx, tenantId),
        cobertura: {
          measured: true,
          pct: misRutas.length ? Math.round((cubiertas.size / misRutas.length) * 10000) / 100 : null,
          note: notas.length ? notas.join(' ') : 'Todas las rutas de tu equipo tienen venta en el periodo.',
        },
      };
    });
  }

  /**
   * Los 5 estados de `[CDRP.2]`, aplicados a la meta mensual.
   *
   * ⛔ Con `meta === null` devuelve `sin_meta`, NUNCA `ok`. Ése es el `cfg ? classify : 'ok'`
   * que la Fase VP encontró dando verde incondicional, y es lo único que impide que este
   * tablero nazca diciéndole a cuatro supervisores que van bien sin que nadie fijara una meta.
   */
  private veredicto(
    ventaMes: number,
    meta: number | null,
  ): Pick<SupervisorRuta, 'estado' | 'estado_motivo' | 'avance'> {
    if (meta === null) {
      return {
        estado: 'sin_meta',
        estado_motivo:
          'Hay venta y no hay meta registrada para esta ruta en el mes: no se puede decir si va bien o mal.',
        avance: null,
      };
    }
    if (meta === 0) {
      return {
        estado: 'sin_meta',
        estado_motivo: 'La meta registrada es 0: no hay contra qué comparar.',
        avance: null,
      };
    }
    const avance = ventaMes / meta;
    // Las bandas salen del propio objetivo, no de números clavados: 90% y 75% del avance
    // ESPERADO a esta altura del mes. Sin prorratear la meta a días, se compara el avance
    // contra la fracción del mes transcurrida.
    const hoy = new Date();
    const diasMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
    const transcurrido = Math.min(hoy.getDate() / diasMes, 1);
    const esperado = transcurrido > 0 ? avance / transcurrido : null;
    if (esperado === null) {
      return { estado: 'sin_medir', estado_motivo: 'No se pudo calcular el avance esperado.', avance };
    }
    const estado = esperado >= 0.9 ? 'ok' : esperado >= 0.75 ? 'warn' : 'bad';
    return {
      estado,
      estado_motivo:
        'Lleva ' + Math.round(avance * 100) + '% de la meta con ' +
        Math.round(transcurrido * 100) + '% del mes transcurrido.',
      avance,
    };
  }

  /** Días naturales del rango, inclusivo. */
  private dias(desde: string, hasta: string): number {
    return Math.floor((Date.parse(hasta) - Date.parse(desde)) / 86400000) + 1;
  }

  /**
   * La frescura de lo que se publica. Dos eslabones, y se queda con el PEOR: la matvista se
   * refresca cada 30 min (`analytics_refresh`), y la tabla de metas cambia cuando alguien
   * captura. Un servidor que contesta en 6 ms sobre una matvista de ayer no es fresco.
   */
  private async frescura(trx: any, tenantId: string) {
    try {
      const refresco = await stepAt(trx, 'analytics_refresh', tenantId);
      const metas = await tableAt(trx, 'commercial.sales_targets', 'updated_at');
      return composeFreshness([
        evalInput('analytics_refresh', 'Refresco de la venta por ruta', refresco, 2),
        evalInput('sales_targets', 'Metas capturadas', metas, 24 * 60),
      ]);
    } catch (e: any) {
      this.logger.warn('No se pudo medir la frescura: ' + (e?.message ?? e));
      return FRESHNESS_UNKNOWN;
    }
  }
}
