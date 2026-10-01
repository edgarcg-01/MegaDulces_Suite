import { Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, isPlatformAdminRole } from '@megadulces/platform-core';

/** Quien pide el expediente. Lo arma el controlador desde `req.user`. */
export interface ActorExpediente {
  sub?: string;
  id?: string;
  tenant_id?: string;
  role_name?: string;
  /** El mapa FRESCO que `RolesGuard` deja en `request.user.permissions`. */
  permissions?: Record<string, boolean>;
  /**
   * Los ROLES frescos de DB que `RolesGuard` deja en `request.user.roles_frescos`.
   * ⛔ No se usa `role_name` del token: degradar a un admin tiene que surtir efecto al
   * instante, no en 12 h (lección de `[AUTHZ-HARD.2]`).
   */
  roles_frescos?: string[];
}

/**
 * [IC.0] El descuadre del conteo físico de Kepler, visible.
 *
 * Kepler hace el inventario completo cada trimestre y emite el ajuste. El dato existe desde
 * nov-2025 y **no se ve en ninguna pantalla**: medido en sep-2026, $6.60M de sobrante contra
 * $2.26M de faltante sobre $34.1M contados, con el sobrante entre 6.5% y 31% del valor
 * contado según la sucursal. No falta información: falta dónde mirarla.
 *
 * Lee de `analytics.mv_erp_physical_count_variance` (IC.12) — la misma derivación del ODS de
 * IC.0, materializada por COSTO (la pantalla abría en 2.2 s contra un gate de 1 s) y con el
 * PELDAÑO DEL COSTO declarado fila por fila.
 *
 * ⛔ **Una matview no soporta RLS** (limitación de Postgres): el tenant se filtra A MANO en
 * toda consulta que la toque. `tk.run` setea el GUC y la matview no lo mira.
 *
 * 3. **El peldaño.** El ajuste de Kepler declara la cantidad en PIEZAS y la valúa al costo de
 *    la CAJA en una parte de los renglones. Arbitrado contra la captura del mismo día: **338
 *    renglones publican $6,845,043 donde al costo contado serían $487,714**. El `importe` NO
 *    se corrige (es el que Kepler asentó, ADR-040); se DECLARA cuánto está en disputa.
 *
 * ── Dos cosas que este servicio NO puede dejar de declarar ──────────────────────────────
 *
 * 1. **Una carga inicial no es un descuadre.** Cuando una sucursal migra de Wincaja a Kepler
 *    emite, el día antes del corte, una captura y una entrada que cuadran línea por línea con
 *    faltante cero. Son **$30.8M** en el histórico. Se excluyen del descuadre por default y
 *    se informan aparte — mezclarlos convierte cualquier promedio en ruido.
 *
 * 2. **La cobertura.** El trimestral deja fuera SKUs con existencia (4,022 en sep-2026, entre
 *    7% y 31% por sucursal). Un tablero que muestre sólo lo contado se lee como si eso fuera
 *    todo el almacén. Ver `coverage()`.
 */
@Injectable()
export class InventoryVarianceService {
  private readonly logger = new Logger(InventoryVarianceService.name);

  constructor(private readonly tk: TenantKnexService) {}

  /**
   * `[IC.12]` La frescura de una MV, en TRES estados.
   *
   * Un booleano no puede decir "no sé" (ADR-056): si el job nunca escribió un latido, el dato
   * puede ser de la migración inicial o de hace un mes, y las dos cosas se ven igual desde acá.
   * `unknown` NO es `fresh`, y por eso son tres y no dos.
   */
  private async frescura(knex: Knex, jobKey: string) {
    const [latido] = await knex('analytics.cron_runs')
      .where({ job_key: jobKey })
      .select('last_finish', 'status')
      .orderBy('last_finish', 'desc')
      .limit(1);
    return {
      data_as_of: latido?.['last_finish'] ?? null,
      status: !latido ? 'unknown' : latido['status'] === 'ok' ? 'fresh' : 'stale',
      motivo: !latido
        ? 'la matview nunca registró un refresco: no se sabe de cuándo es este dato'
        : null,
    };
  }

  /**
   * Resumen por evento de conteo: una fila por (almacén, fecha), con su descuadre.
   * `include_initial_load` existe para poder VER las cargas iniciales, no para mezclarlas:
   * vienen con `tipo_evento` y el consumidor las pinta distinto.
   */
  async summary(params: {
    warehouse_id?: string;
    date_from?: string;
    date_to?: string;
    include_initial_load?: boolean;
  }) {
    return this.tk.run(async (knex) => {
      // ⚠️ MATVIEW: Postgres no soporta RLS sobre una matview, así que el tenant se filtra A
      // MANO en toda consulta de acá abajo. `tk.run` setea el GUC y la matview no lo mira.
      const q = knex('analytics.mv_erp_physical_count_variance as v')
        .where('v.tenant_id', knex.raw('public.current_tenant_id()'))
        .select(
          'v.warehouse_id',
          'v.warehouse_code',
          'v.warehouse_name',
          'v.fecha',
          'v.tipo_evento',
          knex.raw("count(*) filter (where v.signo = 'sobrante')::int as skus_sobrante"),
          knex.raw("count(*) filter (where v.signo = 'faltante')::int as skus_faltante"),
          knex.raw("coalesce(round(sum(v.importe) filter (where v.signo = 'sobrante'), 2), 0) as pesos_sobrante"),
          knex.raw("coalesce(round(sum(v.importe) filter (where v.signo = 'faltante'), 2), 0) as pesos_faltante"),
          knex.raw("coalesce(round(sum(case when v.signo = 'sobrante' then v.importe else -v.importe end), 2), 0) as pesos_neto"),
          // [IC.12] LA BANDA EN DISPUTA. `peldano_arriba` = el costo del ajuste es >= 2x el que
          // la captura de ese mismo día implica, y 2 es el factor de caja MÍNIMO del catálogo
          // (Fase CE): por debajo de eso no puede ser un salto de peldaño.
          knex.raw("count(*) filter (where v.costo_veredicto = 'peldano_arriba')::int as skus_peldano"),
          knex.raw("coalesce(round(sum(v.importe) filter (where v.costo_veredicto = 'peldano_arriba'), 2), 0) as pesos_peldano"),
          knex.raw("coalesce(round(sum(v.importe_en_costo_contado) filter (where v.costo_veredicto = 'peldano_arriba'), 2), 0) as pesos_peldano_contado"),
          // Lo que NO se pudo juzgar va aparte y nunca dentro de "coincide".
          knex.raw("count(*) filter (where v.costo_veredicto = 'sin_testigo')::int as skus_sin_testigo"),
          knex.raw("coalesce(round(sum(v.importe) filter (where v.costo_veredicto = 'sin_testigo'), 2), 0) as pesos_sin_testigo"),
        )
        .groupBy('v.warehouse_id', 'v.warehouse_code', 'v.warehouse_name', 'v.fecha', 'v.tipo_evento')
        .orderBy([{ column: 'v.fecha', order: 'desc' }, { column: 'v.warehouse_code' }]);

      if (!params.include_initial_load) q.where('v.tipo_evento', 'conteo');
      if (params.warehouse_id) q.where('v.warehouse_id', params.warehouse_id);
      if (params.date_from) q.where('v.fecha', '>=', params.date_from);
      if (params.date_to) q.where('v.fecha', '<=', params.date_to);

      const [rows, freshness] = await Promise.all([
        q, this.frescura(knex, 'analytics_refresh_count_variance'),
      ]);
      return {
        items: rows.map((r: Record<string, unknown>) => ({
          ...r,
          // El % se calcula sobre lo que se contó, no sobre el total del almacén: es la
          // pregunta que el supervisor hace ("de lo que conté, cuánto bailó").
          pesos_sobrante: Number(r['pesos_sobrante']),
          pesos_faltante: Number(r['pesos_faltante']),
          pesos_neto: Number(r['pesos_neto']),
          pesos_peldano: Number(r['pesos_peldano']),
          pesos_peldano_contado: Number(r['pesos_peldano_contado']),
          pesos_sin_testigo: Number(r['pesos_sin_testigo']),
        })),
        // ⛔ Esto sale de una MV que se refresca una vez al día. Si el refresco se para, la
        // pantalla NO se vacía ni avisa: sigue mostrando el descuadre del trimestre anterior.
        freshness,
      };
    });
  }

  /** Detalle SKU por SKU de un evento (almacén + fecha). Es la lista accionable. */
  /**
   * [IC.0c] El detalle SKU por SKU — con lo que DEBÍA haber contra lo que SALIÓ.
   *
   * La versión anterior mostraba sólo la diferencia, que es lo único que Kepler emite. Para
   * decidir algo hace falta el par: si el sistema decía 108 y se contaron 1,232, el sobrante de
   * 1,124 se explica solo; si decía 2,051 y se contaron 1,474, es otra conversación.
   *
   * ── ⛔ De dónde sale cada número, porque NO son del mismo tipo ──────────────────────────
   *
   * · `contado`   → DATO DIRECTO. La captura `N-A-45` (`c9` de cada línea). Medido en el
   *                 evento 02/2026-09-23: 2,370 SKUs capturados, y los 1,144 que tienen ajuste
   *                 están todos en la captura.
   * · `diferencia`→ DATO DIRECTO. El ajuste `N-A-30` / `N-D-30`.
   * · `teorico`   → **DERIVADO**: `contado − diferencia`. Kepler **no lo guarda**: se revisaron
   *                 las 38 columnas de la línea de captura buscando el valor esperado y no está.
   *
   * ⛔ Y el derivado NO siempre es posible: en **80 de 1,144 SKUs (6.99%)** del mismo evento da
   * NEGATIVO, que es físicamente imposible. La causa está medida: la captura y el ajuste no
   * comparten grano — para el SKU 88045 la captura trae costo 5.28 y factor 16, y su ajuste
   * costo 5.07 y factor 0. Esos casos salen con `teorico = null` y `teorico_salvedad`, nunca
   * con un número inventado (ADR-056).
   *
   * ── `[IC.12]` De dónde sale ahora ────────────────────────────────────────────────────────
   *
   * El SQL crudo que vivía acá se fue a `analytics.mv_erp_physical_count_variance`, y no sólo
   * por velocidad (1.39 s → lectura de matview). Su CTE `capt` filtraba la captura por
   * SUCURSAL y no por ALMACÉN: el día que la tienda `01` y la Ruta 28 (`01-006`) cuenten el
   * mismo día, el «se contó» de la tienda sumaba el de la ruta. En la matview la llave del
   * testigo lleva el almacén, y la definición del teórico existe **una sola vez**.
   */
  async detail(params: {
    warehouse_id: string;
    fecha: string;
    signo?: 'sobrante' | 'faltante';
    explicacion?: string;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 2000);
    return this.tk.run(async (knex) => {
      // ⚠️ MATVIEW: sin RLS. El tenant se filtra a mano.
      const q = knex('analytics.mv_erp_physical_count_variance as v')
        // [EXP.1b] Las señales que explican el renglón.
        //
        // ⭐ La dirección del join importa: `v` es por LÍNEA de kdm2 y `s` es por SKU, así que
        // esto es MUCHOS-A-UNO y **no abanica**. Al revés sí lo haría — por eso las señales
        // viven en su propia matvista y no como columnas de ésta (hay 1,483 líneas de más
        // sobre el mismo universo de 20,849 pares).
        //
        // Dos líneas del mismo SKU en el mismo día comparten explicación, y eso es correcto:
        // la causa es del SKU-día, no del renglón. Cuando las dos líneas traen signo opuesto
        // —504 pares en el histórico— el veredicto sale del NETO y `signos_mezclados` lo dice.
        .leftJoin('analytics.mv_erp_count_line_signals as s', function () {
          this.on('s.tenant_id', '=', 'v.tenant_id')
            .andOn('s.warehouse_id', '=', 'v.warehouse_id')
            .andOn('s.fecha', '=', 'v.fecha')
            .andOn('s.sku', '=', 'v.sku');
        })
        .where('v.tenant_id', knex.raw('public.current_tenant_id()'))
        .andWhere('v.warehouse_id', params.warehouse_id)
        .andWhereRaw('v.fecha = ?::date', [params.fecha])
        .select('v.sku', 'v.product_id', 'v.descripcion', 'v.unidad_erp', 'v.signo',
          'v.cantidad', 'v.costo_unitario', 'v.importe', 'v.folio', 'v.kepler_sucursal',
          'v.kepler_almacen', 'v.tipo_evento', 'v.contado', 'v.teorico', 'v.teorico_salvedad',
          // [IC.12] El peldaño del costo, fila por fila. `razon_costo` va expuesta para que
          // cualquiera pueda juzgar el renglón sin creerle a la etiqueta.
          'v.costo_contado', 'v.razon_costo', 'v.costo_veredicto',
          'v.importe_en_costo_contado', 'v.ficha_peldano', 'v.ficha_costo_base',
          'v.ficha_costo_caja', 'v.ficha_factor_caja',
          // [EXP.1b] El veredicto y SUS INSUMOS. Van los dos: una etiqueta que no se puede
          // auditar es una opinión.
          's.explicacion', 's.testigos_faltantes', 's.signos_mezclados', 's.lineas',
          's.importe_neto', 's.importe_bruto',
          's.rf_veredicto', 's.rf_no_explicado', 's.rf_importe_no_explicado',
          's.veces_contado', 's.veces_descuadro', 's.retencion', 's.patron',
          's.demanda_diaria', 's.demanda_motivo', 's.dias_de_venta', 's.excede_la_venta',
          's.oe_fecha', 's.oe_folio', 's.oe_unidad', 's.oe_costo_unitario', 's.oe_cantidad',
          's.oe_unidad_discrepa')
        .orderBy('v.importe', 'desc')
        .limit(limit);
      if (params.signo) q.andWhere('v.signo', params.signo);
      // ⛔ El filtro clave de la pantalla: `sin_explicacion` es la pila que se camina. Va sobre
      // la matvista de señales, así que un renglón sin fila allá (carga inicial, o la MV sin
      // refrescar) NO entra en ningún filtro — y eso es a propósito: no se le puede atribuir
      // una explicación a algo que no se juzgó.
      if (params.explicacion) q.andWhere('s.explicacion', params.explicacion);
      return q;
    });
  }

  /**
   * `[EXP.1b]` EL EMBUDO — cuánto del descuadre cae en cada explicación.
   *
   * Es la tira que convierte la pantalla de un listado en una decisión. Medido en prod sobre
   * sep-2026: de **$8,859,397** brutos, la pila `sin_explicacion` son **818 SKUs / $248,436**.
   *
   * ⛔ Las tres cosas que esta tira NO puede dejar de decir:
   *
   * 1. **`no_medido` no es «sin causa».** Son $3,519,579 del mismo mes donde falta un testigo
   *    —casi siempre el roll-forward o el historial— porque un almacén contado UNA vez no
   *    tiene conteo previo del cual rodar ni segunda observación con la cual llamar a algo
   *    reincidente. Mezclarlo con `sin_explicacion` inflaría la pila 14 veces.
   * 2. **Se agrega sobre el NETO por SKU, no sobre el bruto por línea.** En el histórico hay
   *    504 pares con los dos signos el mismo día cuyos **$4,376,696 se cancelan solos** (todos
   *    en el almacén 02, nov-2025 a ene-2026). Sumar magnitudes ahí publica un problema que no
   *    existe.
   * 3. **`excede_la_venta` es una PISTA y va aparte de la partición**, con su falso positivo
   *    medido: dispara en el 10.1% de los faltantes, donde no explica nada.
   */
  async embudo(params: {
    warehouse_id?: string;
    date_from?: string;
    date_to?: string;
  } = {}) {
    return this.tk.run(async (knex) => {
      // ⚠️ MATVIEW: sin RLS. Tenant a mano.
      const q = knex('analytics.mv_erp_count_line_signals as s')
        .where('s.tenant_id', knex.raw('public.current_tenant_id()'))
        .select('s.warehouse_id', 's.warehouse_code', 's.fecha', 's.explicacion')
        .count('* as skus')
        .select(
          knex.raw('coalesce(round(sum(abs(s.importe_neto)), 2), 0) as pesos_abs'),
          knex.raw("coalesce(round(sum(s.importe_neto) filter (where s.importe_neto > 0), 2), 0) as pesos_sobrante"),
          knex.raw("coalesce(round(-sum(s.importe_neto) filter (where s.importe_neto < 0), 2), 0) as pesos_faltante"),
          knex.raw('count(*) filter (where s.excede_la_venta)::int as con_pista'),
          knex.raw('count(*) filter (where s.signos_mezclados)::int as signos_mezclados'),
        )
        .groupBy('s.warehouse_id', 's.warehouse_code', 's.fecha', 's.explicacion')
        .orderBy([{ column: 's.fecha', order: 'desc' }, { column: 's.warehouse_code' },
          { column: 's.explicacion' }]);

      if (params.warehouse_id) q.where('s.warehouse_id', params.warehouse_id);
      if (params.date_from) q.where('s.fecha', '>=', params.date_from);
      if (params.date_to) q.where('s.fecha', '<=', params.date_to);

      const [rows, freshness] = await Promise.all([
        q, this.frescura(knex, 'analytics_refresh_count_signals'),
      ]);
      return {
        items: rows.map((r: Record<string, unknown>) => ({
          ...r,
          skus: Number(r['skus']),
          pesos_abs: Number(r['pesos_abs']),
          pesos_sobrante: Number(r['pesos_sobrante']),
          pesos_faltante: Number(r['pesos_faltante']),
        })),
        freshness,
      };
    });
  }


  /**
   * `[EXP.2]` ⭐⭐ **EL EXPEDIENTE DEL RENGLÓN** — lo que se abre al dar clic.
   *
   * El reproche que originó esto: *"podemos llegar a saber si tuvo órdenes de entrada, compras,
   * ajustes... debemos cazar esta información, enlazarla con los demás módulos"*. Y era
   * correcto: las piezas existían, enlazadas por `(almacén, fecha)` o por `(almacén, par de
   * conteos)` — **nunca por SKU**. `[EXP.1b]` construyó la llave; esto la usa.
   *
   * **Un solo viaje.** Ocho llamadas serían ocho estados de carga en la misma ventana y el
   * panel se armaría a pedazos (mismo criterio que `margin-engine.expediente()`).
   *
   * ── ⛔ Cada sección declara su permiso, y NUNCA se omite en silencio ──────────────────
   *
   * Un panel al que le faltan tres bloques sin decir por qué se lee como «no hay nada que ver».
   * Cada sección devuelve `{ datos }` o `{ oculto: true, permiso, motivo }`.
   *
   * ⚠️ **El god-mode se resuelve por ROL, no por el mapa** (ADR-054), y acá eso no es
   * teórico: medido en prod, `superadmin` —**7 personas**— tiene `COMMERCIAL_PREVENTION_VER`
   * **ausente** de su mapa y entra por god-mode. Gatear sólo contra el mapa les ocultaría la
   * sección de Prevención a los siete. Por eso se piden los roles FRESCOS de DB (los mismos
   * que usa `RolesGuard`), no el `role_name` del token: degradar a un admin tiene que surtir
   * efecto al instante, que es la lección de `[AUTHZ-HARD.2]`.
   *
   * ── Lo que la medición del 2026-09-30 corrigió de este diseño ─────────────────────────
   *
   * ⛔ El plan daba por sentado que `analytics.stock_movements` es una **ventana rodante de
   * 120 días**, y que por eso un conteo de nov-2025 devolvería vacío. **Es falso**: la tabla
   * tiene 3,755,552 filas desde **2020-03-20**. Lo que sí hay que declarar es otro piso, y es
   * POR ALMACÉN: hasta dic-2025 el feed cubría **5 almacenes** y desde ene-2026 cubre **8**.
   * O sea que la ausencia de movimientos puede ser «no hubo» o «ese almacén todavía no
   * alimentaba», y las dos se ven igual si no se dice cuál.
   *
   * ⚠️ `prevencion` tiene `COMPRAS_ENTRADAS_VER` en **`false`**: el equipo que investiga la
   * diferencia no puede ver las compras que explicarían un sobrante. Queda **declarado**, no
   * arreglado de contrabando — es la misma disciplina de `[EXP.0]` con `supervisor`.
   */
  async expediente(
    params: { warehouse_id: string; sku: string; fecha: string },
    actor?: ActorExpediente,
  ) {
    // ⭐ Roles FRESCOS de DB (los deja `RolesGuard` en el request), no el `role_name` del
    // token. Si el guard no corrió —ruta sin `@RequirePermissions`— no hay god-mode que
    // conceder: `roles_frescos` llega vacío y se cae a lo que diga el mapa. Falla cerrado.
    const esAdmin = (actor?.roles_frescos ?? []).some((r) => isPlatformAdminRole(r));
    const puede = (...claves: string[]) =>
      esAdmin || claves.some((k) => actor?.permissions?.[k] === true);
    const oculto = (permiso: string, que: string) => ({
      oculto: true as const,
      permiso,
      motivo: `${que} no se muestra porque tu perfil no incluye ${permiso}. `
        + 'No es que no haya información: es que no te corresponde verla.',
    });

    const verMovimientos = puede('COMMERCIAL_MOVEMENTS_VER', 'RECONCILIATION_VER');
    const verEntradas = puede('COMPRAS_ENTRADAS_VER');
    const verExistencia = puede('EXISTENCIA_VER');
    const verPrevencion = puede('COMMERCIAL_PREVENTION_VER');

    return this.tk.run(async (knex) => {
      const T = knex.raw('public.current_tenant_id()');

      // ⚠️ MATVIEW sin RLS: el tenant va a mano en TODAS las de abajo.
      const [senal] = await knex('analytics.mv_erp_count_line_signals as s')
        .where('s.tenant_id', T)
        .andWhere('s.warehouse_id', params.warehouse_id)
        .andWhere('s.sku', params.sku)
        .andWhereRaw('s.fecha = ?::date', [params.fecha])
        .select('*');

      if (!senal) {
        return {
          encontrado: false,
          motivo: 'No hay señales calculadas para este SKU en este evento. Puede ser una carga '
            + 'inicial (que no es un descuadre) o que la vista de señales no se haya refrescado.',
        };
      }

      const productId = senal['product_id'] as string | null;

      // La ventana de los movimientos: el período que TERMINA en este conteo si existe, y si
      // no, 90 días hacia atrás. Se declara cuál de las dos se usó — no es lo mismo.
      const [prev] = await knex('analytics.mv_erp_count_line_signals as s')
        .where('s.tenant_id', T)
        .andWhere('s.warehouse_id', params.warehouse_id)
        .andWhere('s.sku', params.sku)
        .andWhereRaw('s.fecha < ?::date', [params.fecha])
        .orderBy('s.fecha', 'desc').limit(1)
        .select('s.fecha');
      const desde = prev?.['fecha'] ?? null;

      const [
        lineas, eventos, rollforward, movimientos, entradas, existencia, prevencion,
      ] = await Promise.all([
        // 1 · Las LÍNEAS del ajuste en este evento. Es lo que hace visible el caso de los dos
        //     signos: 504 pares en el histórico donde el mismo SKU se ajustó en las dos
        //     direcciones el mismo día.
        knex('analytics.mv_erp_physical_count_variance as v')
          .where('v.tenant_id', T)
          .andWhere('v.warehouse_id', params.warehouse_id)
          .andWhere('v.sku', params.sku)
          .andWhereRaw('v.fecha = ?::date', [params.fecha])
          .select('v.folio', 'v.serie', 'v.linea', 'v.signo', 'v.cantidad', 'v.costo_unitario',
            'v.importe', 'v.contado', 'v.teorico', 'v.teorico_salvedad', 'v.costo_contado',
            'v.razon_costo', 'v.costo_veredicto', 'v.importe_en_costo_contado')
          .orderBy(['v.folio', 'v.linea']),

        // 2 · ⭐ La TRAYECTORIA del SKU entre conteos. Sale gratis de la misma matvista: es la
        //     única pieza que ya estaba indexada por SKU y nadie podía ver desde acá.
        knex('analytics.mv_erp_count_line_signals as s')
          .where('s.tenant_id', T)
          .andWhere('s.warehouse_id', params.warehouse_id)
          .andWhere('s.sku', params.sku)
          .select('s.fecha', 's.signo', 's.cantidad_neta', 's.importe_neto', 's.importe_bruto',
            's.lineas', 's.signos_mezclados', 's.explicacion', 's.rf_veredicto',
            's.excede_la_venta', 's.dias_de_venta')
          .orderBy('s.fecha', 'desc'),

        // 3 · La conciliación de TODOS los períodos del SKU, no sólo el de este conteo.
        knex('analytics.mv_erp_count_rollforward as r')
          .where('r.tenant_id', T)
          .andWhere('r.warehouse_id', params.warehouse_id)
          .andWhere('r.sku', params.sku)
          .select('r.desde', 'r.hasta', 'r.dias', 'r.contado_inicio', 'r.compras', 'r.recibido',
            'r.vendido', 'r.enviado', 'r.esperado', 'r.contado_fin', 'r.no_explicado',
            'r.importe_no_explicado', 'r.veredicto')
          .select(knex.raw('(r.esperado < 0) AS esperado_imposible'))
          .orderBy('r.hasta', 'desc'),

        // 4 · Los movimientos documento a documento.
        verMovimientos && productId
          ? knex.raw(`
              WITH piso AS (
                SELECT min(doc_date) AS desde_real
                  FROM analytics.stock_movements
                 WHERE tenant_id = public.current_tenant_id() AND warehouse_id = ?
              ), mov AS (
                SELECT doc_date, movement_label, movement_kind, signed_qty, qty, folio,
                       doc_code, source_branch, dest_label
                  FROM analytics.stock_movements
                 WHERE tenant_id = public.current_tenant_id() AND warehouse_id = ?
                   AND product_id = ?
                   AND doc_date >  coalesce(?::date, ?::date - 90)
                   AND doc_date <= ?::date
                 ORDER BY doc_date DESC LIMIT 300
              )
              SELECT (SELECT json_agg(m) FROM mov m) AS items,
                     (SELECT desde_real FROM piso) AS feed_desde`,
          [params.warehouse_id, params.warehouse_id, productId,
            desde, params.fecha, params.fecha]).then((r) => r.rows[0])
          : null,

        // 5 · Las órdenes de entrada del SKU, antes del conteo.
        verEntradas
          ? knex('analytics.erp_goods_receipt_lines as l')
            .join('analytics.erp_goods_receipts as h', function () {
              this.on('h.tenant_id', '=', 'l.tenant_id')
                .andOn('h.sucursal', '=', 'l.sucursal').andOn('h.folio', '=', 'l.folio');
            })
            .where('l.tenant_id', T)
            .andWhere('h.warehouse_id', params.warehouse_id)
            .andWhere('l.sku', params.sku)
            .andWhereRaw('h.receipt_date <= ?::date', [params.fecha])
            .andWhereRaw('h.receipt_date >= ?::date - 365', [params.fecha])
            .select('h.receipt_date', 'h.folio', 'h.proveedor_nombre', 'h.oc_folio',
              'l.cantidad', 'l.unidad', 'l.costo_unitario', 'l.importe')
            .orderBy('h.receipt_date', 'desc').limit(40)
          : null,

        // 6 · La existencia de HOY, con su unidad.
        verExistencia && productId
          ? knex('analytics.v_erp_stock_on_hand as e')
            .where('e.tenant_id', T)
            .andWhere('e.warehouse_id', params.warehouse_id)
            .andWhere('e.product_id', productId)
            .select('e.qty_stock_units', 'e.display_box_factor', 'e.unit_source', 'e.source')
            .first()
          : null,

        // 7 · El expediente de Prevención, si alguien ya lo abrió. ⛔ Sólo CUENTA Y LIGA: abrir
        //     uno es un acto con dueño y va por su propio endpoint.
        verPrevencion && productId
          ? knex('commercial.inventory_investigations as i')
            .where('i.warehouse_id', params.warehouse_id)
            .andWhere('i.product_id', productId)
            .select('i.id', 'i.folio', 'i.status', 'i.root_cause', 'i.difference',
              'i.value_at_cost', 'i.opened_at', 'i.opened_by', 'i.resolved_at')
            .orderBy('i.opened_at', 'desc').limit(10)
          : null,
      ]);

      const mov = movimientos as { items: unknown[] | null; feed_desde: string | null } | null;
      const ventanaDesde = desde ?? null;
      const pisoFeed = mov?.feed_desde ?? null;

      return {
        encontrado: true,
        senal,
        lineas,
        eventos,
        rollforward,
        // ⛔ Cada bloque gateado dice su permiso cuando está oculto. Omitirlo en silencio haría
        // que un panel a medias se leyera como «no hay nada que ver».
        movimientos: verMovimientos
          ? {
            items: mov?.items ?? [],
            ventana: { desde: ventanaDesde, hasta: params.fecha,
              origen: ventanaDesde ? 'conteo_anterior' : 'noventa_dias' },
            // ⛔ El piso del feed, POR ALMACÉN. Sin esto, «ese almacén todavía no alimentaba»
            // se lee exactamente igual que «no hubo movimientos».
            feed_desde: pisoFeed,
            feed_cubre: pisoFeed != null && ventanaDesde != null
              ? String(pisoFeed) <= String(ventanaDesde) : null,
          }
          : oculto('COMMERCIAL_MOVEMENTS_VER', 'El detalle documento a documento'),
        entradas: verEntradas
          ? { items: entradas ?? [] }
          : oculto('COMPRAS_ENTRADAS_VER', 'Las órdenes de entrada del SKU'),
        existencia: verExistencia
          ? { datos: existencia ?? null,
            motivo: existencia ? null : 'El SKU no tiene existencia registrada hoy en este almacén.' }
          : oculto('EXISTENCIA_VER', 'La existencia de hoy'),
        prevencion: verPrevencion
          ? { items: prevencion ?? [] }
          : oculto('COMMERCIAL_PREVENTION_VER', 'El expediente de investigación'),
      };
    });
  }

  /**
   * ⛔ LA COBERTURA — lo que el conteo NO tocó.
   *
   * Sin esto el tablero miente por omisión: muestra el descuadre de lo contado y el lector
   * asume que eso es el almacén. Medido en sep-2026: entre 192 y 923 SKUs **con existencia**
   * quedaron fuera por sucursal.
   *
   * ⚠️ Se compara contra la existencia de HOY (`v_erp_stock_on_hand`), no contra la del día
   * del conteo — el ODS no guarda historia de saldos. Para un conteo reciente es una buena
   * aproximación; para uno viejo es orientativo, y por eso se devuelve `dias_desde_conteo`
   * en vez de dejar que el número se lea con la misma confianza en los dos casos.
   */
  async coverage(params: { warehouse_id: string; fecha: string }) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `WITH contado AS (
           -- ⚠️ MATVIEW sin RLS: el tenant va a mano.
           SELECT DISTINCT v.sku
             FROM analytics.mv_erp_physical_count_variance v
            WHERE v.tenant_id = public.current_tenant_id()
              AND v.warehouse_id = ? AND v.fecha = ?
         ),
         -- La captura incluye SKUs que NO descuadraron y por eso no están en la vista de
         -- varianza. Para la cobertura hace falta el universo CONTADO, no el DESCUADRADO.
         capturado AS (
           SELECT DISTINCT btrim(l.c8) AS sku
             FROM kepler_ods.kdm1 m
             JOIN kepler_ods.kdm2 l
               ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
              AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
             JOIN commercial.warehouses w
               ON w.kepler_code = m.sucursal AND w.id = ? AND w.deleted_at IS NULL
            WHERE m.c2 = 'N' AND m.c3 = 'A' AND m.c4 = '45' AND m.c9::date = ?
              -- ⛔ ANTI-RÉPLICA, igual que en la vista: la sucursal 03 arrastra 220 cabeceras
              -- del almacén 02. Sin esto la cobertura de 8ESQ cuenta como "contados" SKUs
              -- que se contaron en La Piedad — y la cobertura queda inflada justo en la
              -- pantalla que existe para declarar lo que NO se contó.
              -- Faltaba acá cuando ya estaba en la vista y en el KPI: un filtro que se
              -- aplica en dos de tres lugares es peor que no aplicarlo, porque las cifras
              -- se contradicen entre sí sin que nada falle.
              AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
         )
         SELECT count(*) FILTER (WHERE s.sku IN (SELECT sku FROM capturado))::int AS contados,
                count(*) FILTER (WHERE s.sku NOT IN (SELECT sku FROM capturado))::int AS sin_contar,
                count(*)::int AS con_existencia,
                (SELECT count(*) FROM contado)::int AS con_diferencia,
                (current_date - ?::date) AS dias_desde_conteo
           FROM analytics.v_erp_stock_on_hand s
          WHERE s.warehouse_id = ? AND s.qty_stock_units > 0`,
        [params.warehouse_id, params.fecha, params.warehouse_id, params.fecha,
          params.fecha, params.warehouse_id],
      );
      const r = rows[0] || {};
      const conExistencia = Number(r.con_existencia || 0);
      return {
        ...r,
        pct_cubierto: conExistencia > 0
          ? Number((100 * Number(r.contados || 0) / conExistencia).toFixed(1))
          : null,   // NULL, no 0: "no se pudo medir" no es "cobertura cero"
      };
    });
  }

  /**
   * [IC.8] ⭐ EL KPI DE LA FASE — ¿sirvió?
   *
   * La tesis de IC.5 es que contar un tercio del catálogo cada mes hace que el trimestral de
   * Kepler encuentre menos descuadre. Esto lo mide, y la fase se vuelve **falsable**: si el
   * trimestre siguiente no baja, el parcial no está funcionando y hay que decirlo en vez de
   * seguir contando.
   *
   * ── Las tres cosas que este cálculo NO puede hacer mal ──────────────────────────────────
   *
   * 1. **Excluir cargas iniciales.** Son $30.8M de migraciones de ERP. Mezcladas, cualquier
   *    tendencia es ruido.
   * 2. **Normalizar por lo contado.** Un trimestre donde se contó la mitad tiene la mitad del
   *    descuadre sin haber mejorado nada. Se compara el **% sobre el valor contado**, no los
   *    pesos absolutos.
   * 3. **No comparar peras con manzanas.** Los almacenes entran y salen (Morelia no tiene
   *    conteos, PH tiene uno). Si un período tiene almacenes que el otro no, la comparación
   *    global miente — por eso se devuelve `comparable` y la lista de los que están en ambos.
   */
  async kpi(params: { warehouse_id?: string } = {}) {
    return this.tk.run(async (knex) => {
      const { rows } = await knex.raw(
        `WITH ev AS (
           SELECT v.warehouse_id, v.warehouse_code, v.fecha,
                  sum(CASE WHEN v.signo = 'sobrante' THEN v.importe ELSE 0 END) AS sobrante,
                  sum(CASE WHEN v.signo = 'faltante' THEN v.importe ELSE 0 END) AS faltante
             FROM analytics.mv_erp_physical_count_variance v
            WHERE v.tenant_id = public.current_tenant_id()   -- MATVIEW: sin RLS, tenant a mano
              AND v.tipo_evento = 'conteo'          -- una carga inicial no es descuadre
              AND (?::uuid IS NULL OR v.warehouse_id = ?::uuid)
            GROUP BY 1, 2, 3
         ),
         contado AS (
           -- El denominador: lo que se contó en ese evento. Sin esto, un trimestre con menos
           -- conteo parece una mejora.
           SELECT w.id AS warehouse_id, m.c9::date AS fecha,
                  sum(l.c13::numeric) AS valor_contado
             FROM kepler_ods.kdm1 m
             JOIN kepler_ods.kdm2 l
               ON l.sucursal = m.sucursal AND l.c1 = m.c1 AND l.c2 = m.c2 AND l.c3 = m.c3
              AND l.c4 = m.c4 AND l.c5 = m.c5 AND l.c6 = m.c6
             JOIN commercial.warehouses w
               ON w.kepler_code = m.sucursal AND w.kepler_code <> '00' AND w.deleted_at IS NULL
            WHERE m.c2 = 'N' AND m.c3 = 'A' AND m.c4 = '45'
              AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')
            GROUP BY 1, 2
         )
         SELECT to_char(ev.fecha, 'YYYY-"T"Q')                    AS periodo,
                count(*)::int                                     AS eventos,
                count(DISTINCT ev.warehouse_code)::int            AS almacenes,
                array_agg(DISTINCT ev.warehouse_code ORDER BY ev.warehouse_code) AS codigos,
                round(sum(ev.sobrante), 2)                        AS sobrante,
                round(sum(ev.faltante), 2)                        AS faltante,
                round(sum(coalesce(c.valor_contado, 0)), 2)       AS valor_contado,
                CASE WHEN sum(coalesce(c.valor_contado, 0)) > 0
                     THEN round(100 * (sum(ev.sobrante) + sum(ev.faltante))
                                / sum(c.valor_contado), 2) END    AS pct_descuadre
           FROM ev LEFT JOIN contado c
             ON c.warehouse_id = ev.warehouse_id AND c.fecha = ev.fecha
          GROUP BY 1 ORDER BY 1`,
        [params.warehouse_id ?? null, params.warehouse_id ?? null],
      );

      // La comparación sólo vale entre períodos con los MISMOS almacenes.
      // ⛔ Un pct > 100 es IMPOSIBLE de leer como "descuadró más de lo que hay": significa
      // que el DENOMINADOR no cubre al numerador. Medido: 2025-T4 da 115.25%, porque en esos
      // conteos la captura venía partida en decenas de folios y el valor capturado que
      // alcanzamos a sumar no cubre todos los SKUs que después se ajustaron.
      // Se MARCA en vez de explicarse sin medirlo, y no se usa para la tendencia: una serie
      // que arranca en un número imposible haría ver una mejora que nadie produjo.
      const periodos = rows.map((r: Record<string, unknown>) => {
        const pct = r['pct_descuadre'] != null ? Number(r['pct_descuadre']) : null;
        return {
          ...r,
          pct_descuadre: pct,
          salvedad: pct != null && pct > 100 ? 'denominador_incompleto' : null,
        };
      });
      let tendencia: Record<string, unknown> | null = null;
      // Sólo períodos con denominador sano entran a la tendencia.
      const sanos = periodos.filter((p) => p.salvedad == null);
      if (sanos.length >= 2) {
        const [prev, ult] = [sanos[sanos.length - 2], sanos[sanos.length - 1]];
        const a = new Set(prev.codigos as string[]);
        const b = new Set(ult.codigos as string[]);
        const comunes = [...b].filter((x) => a.has(x));
        const mismos = comunes.length === a.size && comunes.length === b.size;
        tendencia = {
          de: prev.periodo, a: ult.periodo,
          pct_antes: prev.pct_descuadre, pct_despues: ult.pct_descuadre,
          // NULL, no 0: "no se puede comparar" no es "no cambió".
          delta_pp: (prev.pct_descuadre != null && ult.pct_descuadre != null && mismos)
            ? Number((ult.pct_descuadre - prev.pct_descuadre).toFixed(2)) : null,
          comparable: mismos,
          motivo: mismos ? null
            : `los períodos no tienen los mismos almacenes (${[...a].join(',')} vs ${[...b].join(',')})`,
          almacenes_comunes: comunes,
        };
      }
      return {
        periodos,
        tendencia,
        // Sin al menos dos trimestres con los mismos almacenes, esto todavía no puede
        // responder si la fase sirvió — y decirlo es parte de la respuesta.
        veredicto: tendencia?.comparable
          ? ((tendencia['delta_pp'] as number) < 0 ? 'mejora' : 'sin_mejora')
          : 'sin_base_de_comparacion',
        // Cuántos períodos quedaron fuera por denominador imposible. Si son muchos, el KPI
        // todavía no se puede usar y hay que arreglar la medida antes que el proceso.
        periodos_descartados: periodos.length - sanos.length,
      };
    });
  }

  /**
   * [IC.3b] Reincidencia: qué SKU descuadra una y otra vez, y **si el dinero vuelve**.
   *
   * Lee `analytics.v_sku_count_variance_history` (IC.3), que estaba en prod sin un solo
   * consumidor: su grano es (almacén, SKU), el universo son las CAPTURAS y no los ajustes,
   * y ya declara la tasa como NULL bajo 2 observaciones.
   *
   * ── El eje que hace útil la pantalla, medido antes de elegirlo ─────────────────────────
   *
   * "Descuadra siempre" no dice nada por sí solo. Lo que separa un error de captura de una
   * merma es si el descuadre **se compensa entre conteos**:
   *
   *   retencion = |pesos_neto| / pesos_abs
   *
   * Medido en prod sobre los 6,834 SKUs con 2+ conteos, la distribución es BIMODAL:
   *   · retencion < 0.2  →  1,171 SKUs mueven $6.9M en bruto y dejan $75k netos (1.1%)
   *   · retencion = 1.0  →  3,404 SKUs, el descuadre nunca vuelve
   *   · el valle (0.2-0.8) está plano, ~250-380 SKUs por décima
   *
   * El caso que lo ilustra: el SKU 17063 de La Piedad mueve **$3,318,784** en bruto y su neto
   * es **$558**. Ordenar por dinero bruto lo pone primero y no es mercancía perdida: es la
   * misma cantidad entrando y saliendo. La CAJETA ENVINADA (18022) mueve $147,580 y retiene
   * $137,780 — cien veces menos ruido y veinte veces más pérdida real.
   *
   * ⛔ Los SKUs con menos de 2 conteos NO se clasifican: con una observación no existe la
   * palabra "reincidente". Son 5,809 filas — los almacenes 01 y 06 ENTEROS, que sólo tienen
   * un conteo cada uno. No se filtran en silencio: van en `sin_base`, con su dinero y sus
   * almacenes, porque una pantalla que los esconda se lee como si 01 no tuviera problema
   * (ADR-056).
   */
  async reincidencia(params: {
    warehouse_id?: string;
    patron?: string;
    sku?: string;
    limit?: number;
  } = {}) {
    // ⭐ [EXP.1a] `patron` y `retencion` YA NO SE DERIVAN ACÁ: se LEEN de
    // `v_sku_count_variance_history`, que es donde viven desde esa migración. Los umbrales
    // medidos (0.2 / 0.8) bajaron a SQL porque la matvista de señales de `[EXP.1b]` necesita
    // el mismo veredicto, y copiarlo habría creado la segunda definición — el error exacto que
    // ABC.6 cometió con `clase_motivo` esta misma semana.
    //
    // Los dos que SIGUEN acá son los que nadie más consume: `UN_SOLO_EVENTO` juzga la
    // concentración (otra consulta, otra vista) y `MIN_CONTEOS` es el piso de esta pantalla.
    const UN_SOLO_EVENTO = 0.9;
    const MIN_CONTEOS = 2;
    const limit = Math.min(500, Math.max(1, Number(params.limit) || 100));
    const wh = params.warehouse_id;
    const filtros = [
      ...(wh ? ['warehouse_id = ?'] : []),
      ...(params.sku ? ['sku = ?'] : []),
    ];

    // ⛔ El CTE va MATERIALIZED a propósito: sin eso la vista se deriva una vez por cada uno de
    // los tres usos (items, resumen, sin_base) y la consulta pasa de ~0.65 s a varios segundos.
    const sqlHistoria = `
      WITH h AS MATERIALIZED (
        SELECT warehouse_id, warehouse_code, sku, veces_contado, veces_descuadro,
               veces_sobrante, veces_faltante, tasa_descuadre, tasa_motivo,
               pesos_abs, pesos_neto, ultimo_descuadre, retencion, patron
          FROM analytics.v_sku_count_variance_history
         ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
      ),
      juz AS (SELECT * FROM h WHERE veces_contado >= ${MIN_CONTEOS} AND veces_descuadro > 0)
      SELECT
        (SELECT json_agg(x) FROM (SELECT * FROM juz ${params.patron ? 'WHERE patron = ?' : ''}
           ORDER BY abs(pesos_neto) DESC, veces_descuadro DESC, sku LIMIT ?) x) AS items,
        (SELECT json_agg(r) FROM (SELECT patron, count(*)::int AS skus,
           sum(pesos_abs)::numeric AS pesos_abs, sum(pesos_neto)::numeric AS pesos_neto
           FROM juz GROUP BY patron ORDER BY 2 DESC) r) AS resumen,
        (SELECT row_to_json(s) FROM (SELECT count(*)::int AS skus,
           coalesce(sum(pesos_abs), 0)::numeric AS pesos_abs,
           coalesce(string_agg(DISTINCT warehouse_code, ', ' ORDER BY warehouse_code), '') AS almacenes
           FROM h WHERE veces_contado < ${MIN_CONTEOS}) s) AS sin_base`;
    const bindHistoria = [
      ...(wh ? [wh] : []), ...(params.sku ? [params.sku] : []),
      ...(params.patron ? [params.patron] : []), limit,
    ];

    // La CONCENTRACIÓN sale de la vista de eventos, no de IC.3 — que no la tiene.
    // ⛔ Va en su propia consulta y NO unida a la anterior: juntarlas en un solo plan hace que
    // el planificador combine dos derivaciones del ODS y la consulta pasa de ~1 s a **83 s**,
    // medido. Separadas y en paralelo, el total es el de la más lenta.
    const sqlConcentracion = `
      SELECT warehouse_id, sku, max(abs(neto_ev)) AS mayor_evento, count(*)::int AS eventos
        FROM (SELECT warehouse_id, sku, fecha,
                     sum(CASE WHEN signo = 'sobrante' THEN importe ELSE -importe END) AS neto_ev
                FROM analytics.mv_erp_physical_count_variance
               WHERE tenant_id = public.current_tenant_id()   -- MATVIEW: sin RLS
                 AND tipo_evento = 'conteo' ${wh ? 'AND warehouse_id = ?' : ''}
               GROUP BY 1, 2, 3) e
       GROUP BY 1, 2`;

    const [hist, conc] = await Promise.all([
      this.tk.run(async (knex) => (await knex.raw(sqlHistoria, bindHistoria)).rows[0]),
      this.tk.run(async (knex) => (await knex.raw(sqlConcentracion, wh ? [wh] : [])).rows),
    ]);

    const porSku = new Map<string, { mayor_evento: string; eventos: number }>(
      (conc as { warehouse_id: string; sku: string; mayor_evento: string; eventos: number }[])
        .map((r) => [`${r.warehouse_id}|${r.sku}`, r]),
    );

    type Fila = Record<string, unknown> & { warehouse_id: string; sku: string; pesos_neto: string };
    const items = ((hist?.items as Fila[]) || []).map((r) => {
      const c = porSku.get(`${r.warehouse_id}|${r.sku}`);
      const neto = Math.abs(Number(r.pesos_neto));
      // >= 0.9 significa que UN evento explica casi todo: es un hecho puntual, no una sangría.
      // Puede pasar de 1 cuando hay eventos de signo contrario que se restan en el neto.
      const concentracion = c && neto > 0 ? Number(c.mayor_evento) / neto : null;
      return {
        ...r,
        retencion: Number(r['pesos_abs']) > 0
          ? Math.round((neto / Number(r['pesos_abs'])) * 1e4) / 1e4 : null,
        eventos_con_descuadre: c?.eventos ?? null,
        mayor_evento: c?.mayor_evento ?? null,
        concentracion: concentracion == null ? null : Math.round(concentracion * 1e3) / 1e3,
        // El segundo eje, y el que decide a quién se manda al anaquel. Medido: 3,098 de 4,666
        // SKUs (66%, $5.7M de $7.4M) tienen UN evento que explica el 90%+ de su neto — o sea
        // que "descuadra seguido" y "pierde seguido" son cosas distintas.
        forma: concentracion == null ? 'sin_medir'
          : concentracion >= UN_SOLO_EVENTO ? 'evento_aislado' : 'sostenido',
      };
    });

    return {
      items,
      resumen: hist?.resumen || [],
      min_conteos: MIN_CONTEOS,
      // ⚠️ Estos dos números son un ESPEJO para la leyenda de la pantalla: el cálculo vive en
      // `analytics.v_sku_count_variance_history` desde `[EXP.1a]`. Un espejo puede desfasarse,
      // así que no queda suelto — `test-newdb-variance-senales.js` compara estos valores contra
      // los bordes que la vista produce de verdad y se pone ROJO si divergen. Deuda vigilada,
      // no deuda silenciosa (mismo criterio que la duplicación declarada en IC.3).
      umbrales: {
        se_compensa: 0.2,
        persiste: 0.8,
        un_solo_evento: UN_SOLO_EVENTO,
        fuente: 'analytics.v_sku_count_variance_history.patron',
      },
      sin_base: {
        ...(hist?.sin_base || { skus: 0, pesos_abs: 0, almacenes: '' }),
        motivo: `menos de ${MIN_CONTEOS} conteos: sin dos observaciones no hay reincidencia que medir`,
      },
    };
  }

  /**
   * [IC.11] Los PERÍODOS que se pueden conciliar — dos conteos consecutivos del mismo almacén.
   *
   * ⛔ Devuelve también los almacenes que NO tienen par, con su motivo. Un almacén que
   * desaparece de un selector se lee como "ese no tiene problema", y son tres: Padre Hidalgo
   * (tiene dos capturas pero en almacenes DISTINTOS — la tienda `01` y la Ruta 28 `01-006`;
   * compararlas sería mezclar una tienda con una ruta) y las dos de Morelia, con una sola
   * captura cada una.
   *
   * ⚠️ Una MATVIEW no soporta RLS (limitación de Postgres), así que el tenant se filtra A MANO
   * en toda consulta de acá abajo. `tk.run` setea el GUC, pero la matview no lo mira.
   */
  async rollforwardPeriodos() {
    return this.tk.run(async (knex) => {
      const periodos = await knex('analytics.mv_erp_count_rollforward as r')
        .where('r.tenant_id', knex.raw('public.current_tenant_id()'))
        .select('r.warehouse_id', 'r.warehouse_code', 'r.warehouse_name')
        .select(knex.raw("to_char(r.desde,'YYYY-MM-DD') AS desde"))
        .select(knex.raw("to_char(r.hasta,'YYYY-MM-DD') AS hasta"))
        .select(knex.raw('max(r.dias)::int AS dias'))
        .count<Record<string, unknown>[]>('* as skus')
        .select(knex.raw(`count(*) FILTER (WHERE r.veredicto = 'merma')::int AS skus_merma`))
        .select(knex.raw(`count(*) FILTER (WHERE r.veredicto = 'no_recontado')::int AS sin_recontar`))
        .select(knex.raw(`coalesce(sum(r.importe_no_explicado)
          FILTER (WHERE r.veredicto = 'merma'), 0) AS importe_merma`))
        .groupBy('r.warehouse_id', 'r.warehouse_code', 'r.warehouse_name', 'r.desde', 'r.hasta')
        .orderBy([{ column: 'r.warehouse_code' }, { column: 'r.hasta', order: 'desc' }]);

      // Lo que NO se puede conciliar, con nombre y motivo.
      const { rows: sinPar } = await knex.raw(`
        SELECT w.code, w.name,
               (SELECT count(DISTINCT m.c1 || '|' || m.c9::date)::int
                  FROM kepler_ods.kdm1 m
                 WHERE m.sucursal = w.kepler_code
                   AND m.c2='N' AND m.c3='A' AND m.c4::int = 45
                   AND (m.c1 = m.sucursal OR m.c1 LIKE m.sucursal || '-%')) AS capturas
          FROM commercial.warehouses w
         WHERE w.tenant_id = public.current_tenant_id()
           AND w.kepler_code IS NOT NULL AND w.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM analytics.mv_erp_count_rollforward r
                            WHERE r.warehouse_id = w.id)
         ORDER BY w.code`);

      return {
        periodos,
        sin_par: sinPar.map((x: Record<string, unknown>) => ({
          ...x,
          motivo: Number(x['capturas']) < 2
            ? 'un solo conteo: hace falta un segundo para comparar'
            : 'sus conteos son de almacenes distintos (p. ej. la tienda y una ruta), y no son comparables entre sí',
        })),
      };
    });
  }

  /**
   * [IC.11] La conciliación de UN período: a dónde se fue la mercancía.
   *
   * Los totales se calculan sobre TODO el período, no sobre la página — si el encabezado dijera
   * la suma de las 100 filas visibles, cambiaría al paginar y nadie podría citarlo.
   *
   * ⛔ `sin_recontar` va en el encabezado a propósito: son SKUs que estaban en el primer conteo
   * y NO en el segundo, así que su merma es DESCONOCIDA, no cero. En el par más flaco son 2,265
   * de 2,403 — o sea que ese período casi no mide nada, y la pantalla tiene que decirlo antes
   * de que alguien lea el total como si cubriera el almacén.
   *
   * ⛔ Y `imposibles` es la otra salvedad, que además NO es simétrica: 993 filas (3.8%) tienen
   * un "debía quedar" NEGATIVO — salió más de lo que el conteo anterior decía que había, lo cual
   * sólo puede significar que falta una entrada que no capturamos. De esas 993, **cero** caen en
   * merma y 356 en sobrante, porque contra un esperado imposible lo contado siempre parece de
   * más. Van marcadas fila por fila (`esperado_imposible`) y contadas aparte: sin eso, el total
   * de sobrante se lee como mercancía que apareció.
   */
  async rollforward(params: {
    warehouse_id: string;
    desde: string;
    hasta: string;
    veredicto?: string;
    sku?: string;
    limit?: number;
  }) {
    const limit = Math.min(1000, Math.max(1, Number(params.limit) || 150));
    return this.tk.run(async (knex) => {
      const base = () => {
        const b = knex('analytics.mv_erp_count_rollforward as r')
          .where('r.tenant_id', knex.raw('public.current_tenant_id()'))
          .andWhere('r.warehouse_id', params.warehouse_id)
          .andWhereRaw('r.desde = ?::date', [params.desde])
          .andWhereRaw('r.hasta = ?::date', [params.hasta]);
        // [EXP.2] Filtro OPCIONAL por SKU para el expediente del renglón. Va en `base()`, que
        // alimenta tanto los totales como la lista: si fuera sólo en la lista, el expediente
        // mostraría un SKU con los totales de todo el almacén al lado, que es peor que no
        // mostrarlos. Los consumidores que no lo pasan no cambian de resultado.
        if (params.sku) b.andWhere('r.sku', params.sku);
        return b;
      };

      const [tot] = await base()
        .select(knex.raw(`
          count(*)::int AS skus,
          coalesce(sum(r.contado_inicio), 0) AS contado_inicio,
          coalesce(sum(r.compras), 0)  AS compras,
          coalesce(sum(r.recibido), 0) AS recibido,
          coalesce(sum(r.vendido), 0)  AS vendido,
          coalesce(sum(r.enviado), 0)  AS enviado,
          coalesce(sum(r.esperado), 0) AS esperado,
          coalesce(sum(r.contado_fin), 0) AS contado_fin,
          coalesce(sum(r.no_explicado), 0) AS no_explicado,
          coalesce(sum(r.importe_no_explicado) FILTER (WHERE r.veredicto='merma'), 0) AS importe_merma,
          coalesce(sum(r.importe_no_explicado) FILTER (WHERE r.veredicto='sobrante'), 0) AS importe_sobrante,
          count(*) FILTER (WHERE r.veredicto='cuadra')::int       AS cuadra,
          count(*) FILTER (WHERE r.veredicto='merma')::int        AS merma,
          count(*) FILTER (WHERE r.veredicto='sobrante')::int     AS sobrante,
          count(*) FILTER (WHERE r.veredicto='no_recontado')::int AS sin_recontar,
          -- ⛔ El "debía quedar" IMPOSIBLE. Medido en prod: 993 de 26,133 filas (3.8%) dan un
          -- esperado NEGATIVO, o sea que salió más de lo que había según el conteo anterior.
          -- Eso no es merma ni sobrante: es que falta una entrada que no estamos capturando.
          -- Y NO es neutro: de esas 993, CERO caen en merma y 356 en sobrante -- cuando el
          -- esperado es imposible, lo contado siempre parece de más. O sea que inflan el
          -- sobrante en una direccion sola, y publicar el total sin decirlo lo exagera.
          count(*) FILTER (WHERE r.esperado < 0)::int AS imposibles,
          coalesce(sum(r.importe_no_explicado)
            FILTER (WHERE r.esperado < 0 AND r.veredicto = 'sobrante'), 0) AS importe_imposible,
          max(r.dias)::int AS dias`));

      const q = base()
        .select('r.sku', 'r.product_id', 'r.contado_inicio', 'r.compras', 'r.recibido',
          'r.vendido', 'r.enviado', 'r.esperado', 'r.contado_fin', 'r.no_explicado',
          'r.importe_no_explicado', 'r.costo_unitario', 'r.veredicto',
          'r.kepler_sucursal', 'r.kepler_almacen')
        .select(knex.raw('(r.esperado < 0) AS esperado_imposible'))
        // Ordena por lo que QUEDA en dinero. El desempate por SKU es lo que vuelve el orden
        // estable entre dos corridas — sin eso no se puede demostrar que un cambio no lo movió.
        .orderByRaw('abs(coalesce(r.importe_no_explicado, 0)) DESC, r.sku')
        .limit(limit);
      if (params.veredicto) q.andWhere('r.veredicto', params.veredicto);

      const [items, nombres] = await Promise.all([
        q,
        // ⚠️ La columna es `nombre`, NO `name`: lo adiviné y tiró 500 en la primera corrida real.
        // `catalog.products` tiene `nombre` (varchar) y `description` (text), ninguna `name`.
        knex('catalog.products as p')
          .where('p.tenant_id', knex.raw('public.current_tenant_id()'))
          .whereNull('p.deleted_at')
          .select('p.sku', 'p.nombre'),
      ]);
      const nom = new Map(
        (nombres as { sku: string; nombre: string }[]).map((x) => [x.sku, x.nombre]));

      // ⛔ LA FRESCURA, y acá no es adorno. Esto sale de una MATVIEW que se refresca una vez al
      // día: si el refresco se para, la pantalla NO se vacía ni avisa — sigue mostrando la merma
      // del período anterior como si fuera la de este, que es la clase de fallo que no se nota
      // hasta que alguien decide con ella. El veredicto es TERNARIO: un booleano no puede decir
      // "no sé" (ADR-056), y `null` cuando el latido no existe NO es lo mismo que "está fresco".
      const freshness = await this.frescura(knex, 'analytics_refresh_count_rollforward');

      return {
        totales: tot,
        items: (items as Record<string, unknown>[]).map((r) => ({
          ...r, descripcion: nom.get(String(r['sku'])) ?? null,
        })),
        freshness,
      };
    });
  }

  /** Almacenes y fechas con conteo, para poblar los filtros sin adivinar. */
  async events() {
    return this.tk.run(async (knex) =>
      knex('analytics.mv_erp_physical_count_variance as v')
        .where('v.tenant_id', knex.raw('public.current_tenant_id()'))   // MATVIEW: sin RLS
        .distinct('v.warehouse_id', 'v.warehouse_code', 'v.warehouse_name', 'v.fecha', 'v.tipo_evento')
        .orderBy([{ column: 'v.fecha', order: 'desc' }, { column: 'v.warehouse_code' }])
        .limit(200),
    );
  }
}
