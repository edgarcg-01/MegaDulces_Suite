import { Injectable, BadRequestException } from '@nestjs/common';
import {
  TenantKnexService,
  TenantContextService,
  laneAt,
  evalInput,
  composeFreshness,
  FRESHNESS_UNKNOWN,
} from '@megadulces/platform-core';
import type { Freshness } from '@megadulces/contracts';

/**
 * `[CXC.SKU.1]` Lo que la búsqueda por producto NO cubre, dicho en la respuesta.
 * Viaja al frontend para que la pantalla pueda declararlo: una cobertura parcial que
 * no se anuncia se lee como total, y ahí el usuario concluye que el producto "no se
 * vendió" cuando lo que pasa es que su documento no está en el universo.
 */
const EXCLUYE_BUSQUEDA = {
  doctypes: ['U-D-10'],
  motivo: 'Ticket de mostrador (venta POS): no es factura. 424,022 documentos quedan fuera.',
} as const;

/**
 * Fase CXC (ADR-048) — Cartera de clientes / Partidas vivas (Cuentas por Cobrar).
 *
 * Reproduce el `Reporte de partidas vivas` de Kepler leyendo el espejo read-only
 * `analytics.customer_receivables` (derivado de `md.kdue`). El saldo se COMPUTA:
 * `saldo = Σ(signed_amount)` (cargo +, abono −). VERIFICADO cuadra al peso vs el PDF.
 * NO escribe a Kepler.
 *
 * Aging por FIFO: el link exacto cobro→factura (kdm5) aún no se consume, así que el
 * saldo por documento se aproxima aplicando los abonos del cliente a sus cargos más
 * viejos primero (estándar de antigüedad de saldos; el saldo total es exacto).
 *
 * OJO multi-tenant: la vista estampa el uuid de mega_dulces como literal (kepler_ods no
 * tiene tenant y es el único con Kepler), igual que el resto de la capa ODS-derivada. El
 * `where tenant_id` de acá NO aísla nada — es forma, no defensa.
 */

const M2 = (v: unknown) => Number(v) || 0;

export interface CarteraQuery {
  sucursal?: string;
  cliente?: string;
  vendedor?: string;
  grupo?: string;   // kdud.c13 (ej '1M001' TELEMARKETING LA PIEDAD)
  zona?: string;    // kdud.c14
  /** `[CXC.25]` A quién le cobrás: `cliente_final` | `interno` | `ruta`. Ver `CuentaKind`. */
  cuenta?: string;
  from?: string;
  to?: string;
  incluir_saldados?: string; // '1' = incluir clientes con saldo 0
  search?: string;
  sort?: 'saldo' | 'vencido'; // priorización: default saldo; 'vencido' = cola de cobranza
  limit?: number;
}

interface Bucket { por_vencer: number; d0_30: number; d31_60: number; d61_90: number; d90_plus: number; }
const emptyBucket = (): Bucket => ({ por_vencer: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * `[CXC.20]` **El saldo del cliente lo manda `kdue`; el desglose por documento se queda corto, y
 * ese hueco se DECLARA.**
 *
 * Las dos cifras existen desde CXC (mig `20260831140000`) y son distintas a propósito:
 *  · `saldo` = `max(Σ signed_amount, 0)` de `kdue` — la fórmula verificada al peso contra el PDF
 *    de Kepler. **Es la canónica.**
 *  · `Σ saldo_ajustado` = lo que las partidas alcanzan a explicar, que es lo único que se puede
 *    repartir en buckets de antigüedad, por vendedor o por zona (un bucket necesita una FECHA de
 *    vencimiento, y sólo los documentos la tienen).
 *
 * La diferencia es `sin_documento`: abonos que `kdm5` aplicó por encima de lo que la cuenta
 * justifica. Hasta acá la pantalla mostraba las dos sin decirlo — el KPI sumaba una y la barra de
 * antigüedad y el resumen gerencial sumaban la otra. **Medido en prod 2026-09-24: $771,712.64
 * (1.34%) sobre 12 clientes**, o sea dirección leía $57,780,190.86 arriba y $57,008,478.22 abajo,
 * en la misma pantalla y con los mismos filtros. El comentario del código afirmaba "5 clientes,
 * $41k" — una medición vieja, 18× más chica, que nadie volvió a correr.
 *
 * No se arregla eligiendo una de las dos: se publica la canónica **y** se le da nombre al hueco,
 * que ahora es un segmento más de la antigüedad. Así la barra suma exactamente el KPI (ADR-056:
 * lo que no se puede repartir se declara, no se esconde ni se reparte a dedo).
 */
export interface Sindocumento { monto: number; clientes: number }

/**
 * `[CXC.25]` **A quién le estás cobrando.** No es una etiqueta cosmética: de los
 * $57,780,190.86 que la pantalla publica, **$26,583,657.82 (46.0%) son ocho cuentas que no son
 * clientes** — `30-73 TLMKT Morelia Abastos`, `10-00 P.V. Padre Hidalgo Piso`… Plaza contra
 * plaza. Eso no se cobra por teléfono, y contabilidad no lo reconoce como cartera (su balanza
 * dice $9.1M). Resolvedor: `analytics.v_customer_account_kind` (mig `20260924180000`).
 */
export type CuentaKind = 'cliente_final' | 'interno' | 'ruta';
export const CUENTA_KINDS: CuentaKind[] = ['cliente_final', 'interno', 'ruta'];
export type PorTipoCuenta = Record<CuentaKind, { saldo: number; vencido: number; clientes: number }>;
const emptyPorTipo = (): PorTipoCuenta => ({
  cliente_final: { saldo: 0, vencido: 0, clientes: 0 },
  interno: { saldo: 0, vencido: 0, clientes: 0 },
  ruta: { saldo: 0, vencido: 0, clientes: 0 },
});

/* ── `[CXC.26]` Cartera por DÍA ──────────────────────────────────────────────────────────── */

export interface PorDiaQuery {
  sucursal?: string; vendedor?: string; grupo?: string; zona?: string; cuenta?: string; search?: string;
}

/** Tres estados, no un booleano `vencido`: «vence hoy» no es ni una cosa ni la otra. */
export type DiaEstado = 'vencido' | 'hoy' | 'futuro';

export interface DiaCartera {
  fecha: string;
  estado: DiaEstado;
  /** Negativo = ya venció hace N días · 0 = hoy · positivo = vence en N días. */
  dias_offset: number;
  monto: number; docs: number; clientes: number;
}

export interface DiaCliente {
  fecha: string; sucursal: string; cliente_code: string; cliente_nombre: string;
  telefono: string | null; zona: string | null;
  vendedor: string | null; vendedor_nombre: string | null;
  cuenta_kind: CuentaKind; dias_credito: number | null;
  monto: number; docs: number; dias_offset: number;
}

/**
 * Lo que `cobertura` dice y lo que NO puede decir. El eje del calendario es `vencimiento`, que
 * sólo existe a nivel documento; el canónico es el de `kdue` por cliente. La resta no tiene fecha.
 */
export interface PorDiaCobertura {
  canonico: number; repartible: number; sin_documento: number; sin_vencimiento: number; clientes: number;
}

export interface PorDiaTotales {
  vencido: number; hoy: number; futuro: number;
  dias_vencidos: number; dias_futuros: number;
}

/**
 * Las opciones de los selects. Las arma `opciones()`, el MISMO constructor que usa la vista por
 * cliente — acá sólo se le pone nombre al tipo para que el boundary no necesite un `any`.
 */
export interface CarteraFiltroOpts {
  sucursales: { code: string; label: string; sin_catalogo: boolean; orden: number | null }[];
  grupos: string[];
  zonas: string[];
  vendedores: { code: string; sucursal: string; label: string }[];
  cuentas: { code: string; label: string }[];
}

export interface PorDiaResp {
  hoy: string;
  freshness: Freshness;
  dias: DiaCartera[];
  detalle: DiaCliente[];
  totales: PorDiaTotales;
  cobertura: PorDiaCobertura;
  filtros: CarteraFiltroOpts;
}

/** Lo que `?` acepta como parámetro ligado en esta consulta: nada exótico, y nada `any`. */
type BindValue = string | number;

/** Las filas tal como salen del `jsonb_agg`: números que vienen como texto, nulos posibles. */
interface FilaDiaCruda { fecha: string; monto: string | number; docs: number; clientes: number }
interface FilaClienteCruda {
  fecha: string; sucursal: string; cliente_code: string; cliente_nombre: string | null;
  telefono: string | null; zona: string | null; vendedor: string | null;
  vendedor_nombre: string | null; cuenta_kind: string | null;
  dias_credito: number | string | null; monto: string | number; docs: number;
}

/**
 * Diferencia en días entre dos fechas `YYYY-MM-DD`, **en UTC a propósito**.
 *
 * ⚠️ `new Date('2026-09-25')` se parsea como medianoche UTC, pero `new Date(2026, 8, 25)` es
 * medianoche LOCAL: restar una de otra da ±1 día según dónde corra el proceso. Acá los dos lados
 * salen del mismo `Date.UTC`, así que la resta es exacta y no depende del reloj del servidor.
 * Las dos fechas ya vienen de Postgres calculadas en `America/Mexico_City`.
 */
function diasEntre(hoy: string, fecha: string): number {
  const p = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  return Math.round((p(fecha) - p(hoy)) / 86400000);
}

@Injectable()
export class CustomerLedgerService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private async hoy(trx: any): Promise<string> {
    const r = await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text d`);
    return r.rows[0].d;
  }

  /**
   * `[CXC.20]` Procedencia de la cartera (ADR-056). Dos eslabones, porque el número sale de dos
   * carriles distintos del ODS y **una cadena es tan fresca como su peor tramo**:
   *  · `ods_live_hot` → `kdue` + `kdm5`, o sea el saldo y las aplicaciones. Corre cada 15 s, así
   *    que 6 h ya está lejísimos de cualquier hipo y cerca de "algo se rompió anoche".
   *  · `ods_live_mirror` → `kdud`/`kduv`: límite de crédito, zona, grupo, teléfono y el nombre del
   *    vendedor. Son catálogos, cambian en días → 26 h, la misma tolerancia que el resto.
   *
   * No es decorativo: el 2026-09-24 los dos carriles llevaban ~26 h sin latir y la pantalla
   * igual rotulaba «saldos al 2026-09-24» — que era el reloj de Postgres, no la edad del dato.
   */
  private async freshness(trx: any): Promise<Freshness> {
    try {
      return composeFreshness([
        evalInput('ods_live_hot', 'Saldos y cobros (kdue/kdm5)', await laneAt(trx, 'ods_live_hot'), 6),
        evalInput('ods_live_mirror', 'Clientes y vendedores (kdud/kduv)', await laneAt(trx, 'ods_live_mirror'), 26),
      ]);
    } catch {
      return FRESHNESS_UNKNOWN;
    }
  }

  /**
   * `[CXC.20]` **UNA pasada sobre la vista, y de ahí sale toda la pantalla**: la tabla, los KPIs,
   * el resumen gerencial y las opciones de los filtros.
   *
   * ── Por qué, medido en prod (2026-09-24) ─────────────────────────────────────────────────
   * `analytics.customer_receivables` es una pirámide de CTEs sobre `erp_receivable_documents`
   * que **no admite pushdown**: se construye entera en cada consulta. Filtrar por sucursal
   * bajaba de 6.0 s a 3.0 s, no a un noveno. Abrir la pantalla disparaba **cuatro** barridos de
   * esa pirámide y tocar «Resumen» un quinto:
   *
   *     cartera() ............  6,011 ms   (17,271 filas al navegador, agrupadas en Node)
   *     filtros() ............ 11,294 ms   (4 × `distinct`, 2 de ellos para controles que no existían)
   *     resumen() ............  3,678 ms
   *     ────────────────────────────────
   *     al abrir .............. 17,305 ms  ·  con «Resumen», 20,983 ms
   *
   * Acá va **una sola** consulta con `doc AS MATERIALIZED` —que obliga a evaluar la pirámide una
   * vez aunque se lea cuatro veces— y la agregación en SQL en vez de 17 mil filas por la red:
   * **4,248 ms para todo** (medido, dos corridas). El gate del proyecto sigue siendo 1 s y esto
   * NO llega; lo que queda es la pirámide misma, y su arreglo está declarado abajo.
   *
   * ⚠️ Los filtros se aplican en `sel`, **no** en `doc`. Es deliberado: las opciones de los
   * selects salen del universo COMPLETO (si se filtraran, elegir una sucursal borraría las otras
   * ocho del desplegable), y como `doc` ya está materializado, leerlo sin filtro no cuesta un
   * segundo barrido.
   *
   * ⛔ DEUDA CON NOMBRE — `[CXC.21]`: los 4.2 s son la pirámide, no esta consulta (`EXPLAIN` da
   * 3.2 s de CPU con **todos** los buffers en `shared hit`; no es I/O). El arreglo es el mismo que
   * `[PERF.4b]` ya aplicó a `erp_sales_invoices`: resolver la cartera **por documento** con una
   * función SQL inlineable + `LEFT JOIN LATERAL`, para que los predicados bajen hasta el índice.
   * No se hace acá porque re-abre el contrato de paridad de `[AX.9]`
   * (`test-newdb-receivable-core-parity.js`) y eso es un cambio medible aparte, no un renglón de
   * éste. Lo más caro de la pirámide es el `jsonb_agg` de `aplicaciones`, que **sólo usa el
   * drill** y la lista paga en cada request.
   */
  private async agregado(trx: any, tenantId: string, q: CarteraQuery) {
    const cond: string[] = [];
    const bind: any[] = [tenantId];
    const add = (sql: string, ...v: any[]) => { cond.push(sql); bind.push(...v); };
    if (q.sucursal) add('d.sucursal = ?', q.sucursal);
    if (q.vendedor) add(`NULLIF(btrim(d.vendedor), '') = ?`, q.vendedor);
    if (q.grupo) add('d.grupo = ?', q.grupo);
    if (q.zona) add('d.zona = ?', q.zona);
    if (q.cuenta) add('d.cuenta_kind = ?', q.cuenta);
    if (q.cliente) add('d.cliente_code = ?', q.cliente);
    if (q.from) add('d.fecha >= ?::date', q.from);
    if (q.to) add('d.fecha <= ?::date', q.to);
    if (q.search) {
      const s = `%${q.search.trim()}%`;
      add('(d.cliente_code ILIKE ? OR d.cliente_nombre ILIKE ? OR d.rfc ILIKE ?)', s, s, s);
    }
    const filtros = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    // `res` = residual del documento, ya clampeado: la partida saldada vale 0 y no resta.
    const VIVA = 'd.res > 0.005';
    const bucket = (extra: string) =>
      `round(COALESCE(sum(d.res) FILTER (WHERE ${VIVA} AND ${extra}), 0), 2)`;

    const sql = `
      WITH h AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS d),
      -- [CXC.25] MATERIALIZED a propósito: son 2,427 filas y se leen contra las 52 mil de doc.
      -- Sin esto el planificador empuja la vista adentro del join y la re-evalúa por fila —
      -- medido: la consulta entera pasaba de 4.2 s a 11.3 s. Con el CTE materializado vuelve.
      cuenta AS MATERIALIZED (
        SELECT cliente_code, kind, kind_source FROM analytics.v_customer_account_kind
      ),
      doc AS MATERIALIZED (
        SELECT r.sucursal, r.cliente_code,
               NULLIF(btrim(r.vendedor), '') AS vendedor,
               r.grupo, r.zona, r.telefono, r.limite_credito, r.dias_credito,
               r.saldo_cliente, r.dias_pago, r.importe, r.fecha, r.vencimiento,
               GREATEST(COALESCE(r.saldo_ajustado, 0), 0) AS res,
               c.name AS cliente_nombre, c.rfc AS rfc,
               -- [CXC.25] A quién le estás cobrando. El COALESCE con la función NO es defensivo
               -- de más: un código que esté en la cartera y NO en el catálogo de Kepler llega
               -- NULL por el LEFT JOIN, y NULL se leería como cliente_final. Con la función,
               -- la señal del código sigue valiendo aunque el catálogo no tenga la fila.
               --
               -- ⚠️ Acá va SÓLO el veredicto, porque acá es donde FILTRA. La fuente
               -- (codigo|nombre|ninguno) se agrega al final, sobre las ~1,300 filas ya
               -- agrupadas: arrastrar una segunda columna de texto por las 52 mil de doc
               -- costaba ~0.9 s medidos, y no la necesita nadie hasta la salida.
               COALESCE(k.kind, analytics.customer_account_kind(r.cliente_code, NULL))
                 AS cuenta_kind
          FROM analytics.customer_receivables r
          LEFT JOIN analytics.erp_customers c
                 ON c.tenant_id = r.tenant_id AND c.erp_code = r.cliente_code
          LEFT JOIN cuenta k ON k.cliente_code = btrim(r.cliente_code)
         WHERE r.tenant_id = ? AND r.cargo_abono = 'C'
      ),
      -- El vendedor se identifica por (sucursal, código), NUNCA por código solo: medido en prod,
      -- 11 de 81 códigos de \`kduv\` nombran a personas distintas según la sucursal. Agrupar por
      -- el código pelado fundiría dos carteras en un renglón con el nombre de uno de los dos.
      vnd AS (
        SELECT DISTINCT ON (btrim(sucursal), btrim(c2))
               btrim(sucursal) AS suc, btrim(c2) AS code, NULLIF(btrim(c3), '') AS nombre
          FROM kepler_ods.kduv
         WHERE btrim(COALESCE(c2, '')) <> '' ORDER BY 1, 2
      ),
      sel AS (SELECT d.* FROM doc d ${filtros}),
      cli AS (
        SELECT d.sucursal, d.cliente_code,
          max(d.cliente_nombre) AS cliente_nombre, max(d.rfc) AS rfc,
          max(d.grupo) AS grupo, max(d.zona) AS zona, max(d.telefono) AS telefono,
          max(d.limite_credito) AS limite_credito, max(d.dias_credito) AS dias_credito,
          max(d.saldo_cliente) AS saldo_cliente,
          max(d.cuenta_kind) AS cuenta_kind,
          -- El de la factura MÁS RECIENTE, no uno al azar: es "quién lo atiende hoy".
          (array_agg(d.vendedor ORDER BY d.fecha DESC NULLS LAST)
             FILTER (WHERE d.vendedor IS NOT NULL))[1] AS vendedor,
          ${bucket('true')} AS residual,
          ${bucket('d.vencimiento < h.d')} AS vencido,
          ${bucket('(d.vencimiento IS NULL OR d.vencimiento >= h.d)')} AS por_vencer,
          ${bucket('h.d - d.vencimiento BETWEEN 1 AND 30')} AS d0_30,
          ${bucket('h.d - d.vencimiento BETWEEN 31 AND 60')} AS d31_60,
          ${bucket('h.d - d.vencimiento BETWEEN 61 AND 90')} AS d61_90,
          ${bucket('h.d - d.vencimiento > 90')} AS d90_plus,
          ${bucket('d.vencimiento >= h.d AND d.vencimiento - h.d <= 7')} AS p0_7,
          ${bucket('d.vencimiento - h.d BETWEEN 8 AND 15')} AS p8_15,
          ${bucket('d.vencimiento - h.d BETWEEN 16 AND 30')} AS p16_30,
          ${bucket('d.vencimiento - h.d > 30')} AS p30_plus,
          ${bucket('d.vencimiento IS NULL')} AS p_sin_fecha,
          count(*) FILTER (WHERE ${VIVA})::int AS n_partidas,
          count(*) FILTER (WHERE NOT (${VIVA}))::int AS n_saldadas,
          round(avg(d.dias_pago) FILTER (WHERE d.dias_pago IS NOT NULL), 1) AS dias_pago_prom,
          count(d.dias_pago)::int AS n_pagos,
          round(COALESCE(sum(d.importe) FILTER (WHERE d.fecha >= h.d - 90), 0), 2) AS ventas_90d
        FROM sel d CROSS JOIN h GROUP BY 1, 2
      ),
      vend AS (
        SELECT d.sucursal, d.vendedor,
               ${bucket('true')} AS saldo,
               ${bucket('d.vencimiento < h.d')} AS vencido,
               count(DISTINCT d.cliente_code) FILTER (WHERE ${VIVA})::int AS n_clientes
          FROM sel d CROSS JOIN h GROUP BY 1, 2
      ),
      zon AS (
        SELECT d.zona,
               ${bucket('true')} AS saldo,
               ${bucket('d.vencimiento < h.d')} AS vencido
          FROM sel d CROSS JOIN h GROUP BY 1
      )
      SELECT (SELECT d FROM h)::text AS hoy,
        COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (
            SELECT c.*,
                   COALESCE(k.kind_source,
                            analytics.customer_account_kind_source(c.cliente_code, NULL))
                     AS cuenta_kind_source
              FROM cli c LEFT JOIN cuenta k ON k.cliente_code = btrim(c.cliente_code)) x),
          '[]'::jsonb) AS clientes,
        -- Comportamiento de pago REAL (días entre factura y su último cobro), sobre las partidas
        -- ya saldadas. El DSO dice cuánto tarda la cartera; esto, cuánto tardan los que SÍ pagan.
        -- La mediana es percentile_cont, no el elemento del medio de un arreglo ordenado: con
        -- n par el viejo devolvia el de arriba y lo llamaba mediana igual.
        (SELECT jsonb_build_object(
            'n', count(*)::int,
            'promedio', round(avg(d.dias_pago)::numeric, 1),
            'mediana', round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.dias_pago)::numeric, 1),
            'tarde_30d', count(*) FILTER (WHERE d.dias_pago > 30)::int)
           FROM sel d WHERE d.dias_pago IS NOT NULL) AS pago,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'sucursal', v.sucursal, 'code', v.vendedor, 'nombre', n.nombre,
            'saldo', v.saldo, 'vencido', v.vencido, 'n_clientes', v.n_clientes))
          FROM vend v LEFT JOIN vnd n ON n.suc = v.sucursal AND n.code = v.vendedor
          WHERE v.saldo > 0.005), '[]'::jsonb) AS por_vendedor,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'zona', COALESCE(z.zona, '—'), 'saldo', z.saldo, 'vencido', z.vencido))
          FROM zon z WHERE z.saldo > 0.005), '[]'::jsonb) AS por_zona,
        jsonb_build_object(
          -- ⭐ Las opciones salen del DATO, no de una lista escrita a mano. Ver \`filtros()\`.
          'sucursales', COALESCE((SELECT jsonb_agg(DISTINCT d.sucursal) FROM doc d WHERE d.sucursal IS NOT NULL), '[]'::jsonb),
          'grupos',     COALESCE((SELECT jsonb_agg(DISTINCT d.grupo)    FROM doc d WHERE d.grupo    IS NOT NULL), '[]'::jsonb),
          'zonas',      COALESCE((SELECT jsonb_agg(DISTINCT d.zona)     FROM doc d WHERE d.zona     IS NOT NULL), '[]'::jsonb),
          'cuentas',    COALESCE((SELECT jsonb_agg(DISTINCT d.cuenta_kind) FROM doc d WHERE d.cuenta_kind IS NOT NULL), '[]'::jsonb),
          'vendedores', COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object(
                            'sucursal', d.sucursal, 'code', d.vendedor, 'nombre', n.nombre))
                          FROM doc d LEFT JOIN vnd n ON n.suc = d.sucursal AND n.code = d.vendedor
                         WHERE d.vendedor IS NOT NULL), '[]'::jsonb)
        ) AS opciones,
        -- El NOMBRE, no el short_label: ese es la sigla de los chips compactos y no siempre es
        -- una abreviatura del nombre (la 05 se llama "Zamora Centro" y su sigla es "DAMASO").
        -- En un desplegable, "01 - PH" no le dice nada a quien cobra.
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'code', w.code,
            'name', COALESCE(NULLIF(btrim(w.name), ''), NULLIF(btrim(w.short_label), ''), w.code),
            'orden', w.display_order) ORDER BY w.display_order NULLS LAST, w.code)
          FROM commercial.warehouses w
         WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.code ~ '^[0-9]{2}$'), '[]'::jsonb)
          AS almacenes`;

    const r = await trx.raw(sql, [...bind, tenantId]);
    return r.rows[0];
  }

  /**
   * Cartera por cliente: saldo + aging + KPIs + resumen gerencial + opciones de filtro.
   *
   * `[CXC.20]` Devuelve **toda** la pantalla en una respuesta. Antes eran tres llamadas (tabla,
   * filtros, resumen) y cada una reconstruía la pirámide de CTEs por su cuenta; ahora es una sola
   * pasada (ver `agregado()`). El efecto de fondo no es la velocidad sino que **el resumen y la
   * tabla ya no pueden contradecirse**: salen del mismo `SELECT`.
   */
  async cartera(q: CarteraQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const limit = Math.min(Math.max(Number(q.limit) || 500, 1), 5000);
    return this.tk.run(async (trx) => {
      const a = await this.agregado(trx, tenantId, q);
      const freshness = await this.freshness(trx);
      const hoy: string = a.hoy;

      const clientes: any[] = [];
      const kpi = {
        total_saldo: 0, total_vencido: 0, n_clientes: 0, n_partidas: 0, n_sobre_linea: 0,
        total_a_favor: 0, n_a_favor: 0, aging: emptyBucket(),
        sin_documento: { monto: 0, clientes: 0 } as Sindocumento,
        // `[CXC.25]` El total partido por a quién le cobrás. Suma EXACTO `total_saldo`.
        por_tipo: emptyPorTipo(),
      };
      const porCliente: { cliente_code: string; saldo: number }[] = [];
      let ventas90 = 0;
      const proy = { vencido: 0, d0_7: 0, d8_15: 0, d16_30: 0, d30_plus: 0, sin_fecha: 0 };

      for (const g of (a.clientes as any[])) {
        const saldoCliente = M2(g.saldo_cliente);
        const saldo = r2(Math.max(saldoCliente, 0));
        const residual = r2(g.residual);
        const aging: Bucket = {
          por_vencer: r2(g.por_vencer), d0_30: r2(g.d0_30), d31_60: r2(g.d31_60),
          d61_90: r2(g.d61_90), d90_plus: r2(g.d90_plus),
        };
        // Lo que el desglose por documento NO alcanza a explicar. Ver el bloque `Sindocumento`.
        const sin_documento = r2(saldo - residual);
        const saldo_a_favor = r2(Math.max(-saldoCliente, 0));
        // El "a favor" se cuenta ANTES del corte: son clientes con saldo 0 que la tabla no lista,
        // y si se contaran después el KPI diría 0 justo cuando hay dinero del cliente sin aplicar.
        if (saldo_a_favor > 0.005) { kpi.total_a_favor += saldo_a_favor; kpi.n_a_favor += 1; }
        ventas90 += M2(g.ventas_90d);

        if (saldo <= 0.005 && q.incluir_saldados !== '1') continue;

        const limite = M2(g.limite_credito) > 0 ? M2(g.limite_credito) : null;
        const sobre_linea = limite != null && saldo > limite + 0.005;
        // Un `kind` que llegue vacío NO se asume cliente: se cuenta aparte y se declara.
        const kind: CuentaKind = CUENTA_KINDS.includes(g.cuenta_kind) ? g.cuenta_kind : 'cliente_final';
        clientes.push({
          sucursal: g.sucursal, cliente_code: g.cliente_code,
          cliente_nombre: g.cliente_nombre || g.cliente_code,
          cuenta_kind: kind, cuenta_kind_source: g.cuenta_kind_source || 'ninguno',
          rfc: g.rfc || null, vendedor: g.vendedor || null, vendedor_nombre: null,
          grupo: g.grupo || null, zona: g.zona || null, telefono: g.telefono || null,
          limite_credito: limite, dias_credito: g.dias_credito != null ? Number(g.dias_credito) : null,
          uso_linea: limite ? Math.round((saldo / limite) * 1000) / 10 : null,
          sobre_linea,
          saldo, vencido: r2(g.vencido),
          n_partidas: Number(g.n_partidas) || 0, n_saldadas: Number(g.n_saldadas) || 0,
          sin_documento: Math.abs(sin_documento) > 0.005 ? sin_documento : 0,
          saldo_a_favor,
          dias_pago_prom: g.dias_pago_prom != null ? Number(g.dias_pago_prom) : null,
          n_pagos: Number(g.n_pagos) || 0,
          aging,
        });

        kpi.total_saldo += saldo; kpi.total_vencido += r2(g.vencido);
        kpi.por_tipo[kind].saldo += saldo;
        kpi.por_tipo[kind].vencido += r2(g.vencido);
        kpi.por_tipo[kind].clientes += 1;
        kpi.n_clientes += 1; kpi.n_partidas += Number(g.n_partidas) || 0;
        if (sobre_linea) kpi.n_sobre_linea += 1;
        (Object.keys(aging) as (keyof Bucket)[]).forEach((k) => { kpi.aging[k] += aging[k]; });
        if (Math.abs(sin_documento) > 0.005) { kpi.sin_documento.monto += sin_documento; kpi.sin_documento.clientes += 1; }
        porCliente.push({ cliente_code: g.cliente_code, saldo });
        proy.vencido += r2(g.vencido);
        proy.d0_7 += r2(g.p0_7); proy.d8_15 += r2(g.p8_15);
        proy.d16_30 += r2(g.p16_30); proy.d30_plus += r2(g.p30_plus);
        proy.sin_fecha += r2(g.p_sin_fecha);
      }

      // Nombre del vendedor por (sucursal, código) — el rollup ya lo trae resuelto contra `kduv`.
      const nombreVend = new Map<string, string>();
      for (const v of (a.por_vendedor as any[])) if (v.nombre) nombreVend.set(`${v.sucursal}||${v.code}`, v.nombre);
      for (const c of clientes) c.vendedor_nombre = c.vendedor ? (nombreVend.get(`${c.sucursal}||${c.vendedor}`) || null) : null;

      if (q.sort === 'vencido') clientes.sort((x, y) => y.vencido - x.vencido || y.saldo - x.saldo);
      else clientes.sort((x, y) => y.saldo - x.saldo);

      kpi.total_saldo = r2(kpi.total_saldo);
      kpi.total_vencido = r2(kpi.total_vencido);
      kpi.total_a_favor = r2(kpi.total_a_favor);
      kpi.sin_documento.monto = r2(kpi.sin_documento.monto);
      for (const k of CUENTA_KINDS) {
        kpi.por_tipo[k].saldo = r2(kpi.por_tipo[k].saldo);
        kpi.por_tipo[k].vencido = r2(kpi.por_tipo[k].vencido);
      }
      (Object.keys(kpi.aging) as (keyof Bucket)[]).forEach((k) => { kpi.aging[k] = r2(kpi.aging[k]); });

      const topCli = porCliente.sort((x, y) => y.saldo - x.saldo);
      const top10 = topCli.slice(0, 10).map((c) => ({ ...c, saldo: r2(c.saldo) }));
      const top10Suma = top10.reduce((s, c) => s + c.saldo, 0);
      const ventasDiarias = ventas90 / 90;

      const resumen = {
        hoy,
        saldo_total: kpi.total_saldo, vencido_total: kpi.total_vencido,
        pct_vencido: kpi.total_saldo > 0 ? Math.round((kpi.total_vencido / kpi.total_saldo) * 1000) / 10 : 0,
        // DSO sobre venta a CRÉDITO (lo único que engorda esta cartera), no sobre la venta total.
        dso: ventasDiarias > 0 ? Math.round(kpi.total_saldo / ventasDiarias) : null,
        ventas_90d: r2(ventas90), n_clientes: kpi.n_clientes,
        pago: a.pago && Number(a.pago.n) > 0
          ? {
              n: Number(a.pago.n),
              promedio: M2(a.pago.promedio),
              mediana: M2(a.pago.mediana),
              tarde_30d: Number(a.pago.tarde_30d) || 0,
            }
          : null,
        concentracion: { top10_pct: kpi.total_saldo > 0 ? Math.round((top10Suma / kpi.total_saldo) * 1000) / 10 : 0, top10 },
        proyeccion: {
          vencido: r2(proy.vencido), d0_7: r2(proy.d0_7), d8_15: r2(proy.d8_15),
          d16_30: r2(proy.d16_30), d30_plus: r2(proy.d30_plus), sin_fecha: r2(proy.sin_fecha),
        },
        // ⚠️ Los dos rollups reparten el saldo POR DOCUMENTO, así que suman
        // `saldo_total − sin_documento`: un vendedor o una zona necesitan que el peso esté
        // atado a una factura, y el hueco por definición no lo está. La pantalla lo dice.
        por_vendedor: (a.por_vendedor as any[])
          .map((v) => ({
            sucursal: v.sucursal, vendedor: v.code, vendedor_nombre: v.nombre || null,
            saldo: M2(v.saldo), vencido: M2(v.vencido), n_clientes: Number(v.n_clientes) || 0,
          }))
          .sort((x, y) => y.saldo - x.saldo),
        por_zona: (a.por_zona as any[])
          .map((z) => ({ zona: z.zona, saldo: M2(z.saldo), vencido: M2(z.vencido) }))
          .sort((x, y) => y.saldo - x.saldo),
        base_rollups: 'documento' as const,
        sin_documento: kpi.sin_documento,
      };

      return {
        hoy,
        freshness,
        kpi,
        clientes: clientes.slice(0, limit),
        total_clientes: clientes.length,
        resumen,
        filtros: this.opciones(a),
      };
    });
  }

  /**
   * ⭐ `[CXC.20]` **De dónde salen las sucursales del desplegable, y por qué antes faltaban tres.**
   *
   * La pantalla traía su propia lista escrita a mano con seis sucursales (`01`..`06`). No es que
   * el dato no llegara: `filtros()` ya devolvía las nueve desde el servidor y el componente
   * **tiraba esa respuesta** para usar su copia. Medido en prod el 2026-09-24, esa copia dejaba
   * fuera de todo filtro **$45.4M, el 78.5% de la cartera**:
   *
   *     00  Oficinas ..........  $44,383,939.32   95.8% vencido   248 clientes
   *     07  Morelia Madero ....     $392,022.27  100.0% vencido   390 clientes
   *     08  Morelia Abastos ...     $592,552.61   12.2% vencido    45 clientes
   *
   * Es el patrón que ADR-056 persigue: un primitivo correcto (el catálogo de la red vive en
   * `commercial.warehouses`, y las sucursales presentes están en el propio dato) re-declarado a
   * mano en una rebanada, que después se congela sin que nada falle.
   *
   * El arreglo no es agregarle `00`, `07` y `08` a la lista — es que **no haya lista**:
   *  · **qué sucursales se ofrecen** = las que el dato tiene (`DISTINCT sucursal` de la misma
   *    pasada). Una sucursal nueva aparece sola; una sin cartera no ofrece un filtro vacío.
   *  · **cómo se llaman** = `commercial.warehouses` (`short_label` y si no `name`), con su
   *    `display_order`. El nombre no se inventa acá.
   *  · el código sin nombre en el catálogo se muestra **como código**, no se esconde: es la
   *    señal de que falta darlo de alta, y ocultarlo volvería a desaparecer dinero.
   */
  private opciones(a: any) {
    const nombres = new Map<string, { name: string; orden: number | null }>();
    for (const w of ((a.almacenes as any[]) || [])) {
      nombres.set(String(w.code), { name: w.name, orden: w.orden != null ? Number(w.orden) : null });
    }
    const codes: string[] = ((a.opciones?.sucursales as string[]) || []).slice().sort();
    const sucursales = codes
      .map((code) => {
        const n = nombres.get(code);
        return { code, label: n ? `${code} · ${n.name}` : code, sin_catalogo: !n, orden: n?.orden ?? null };
      })
      .sort((x, y) => (x.orden ?? 999) - (y.orden ?? 999) || x.code.localeCompare(y.code));

    // ⚠️ El valor del filtro sigue siendo el CÓDIGO (es lo que el `WHERE` compara), pero la
    // etiqueta lleva la sucursal adelante porque 11 de 81 códigos nombran a personas distintas
    // según la plaza: «1» solo sería mentirle a la mitad de la lista.
    const vendedores = ((a.opciones?.vendedores as any[]) || [])
      .map((v: any) => ({
        code: v.code as string,
        sucursal: v.sucursal as string,
        label: `${v.sucursal} · ${v.nombre || v.code}`,
      }))
      .sort((x, y) => x.label.localeCompare(y.label));

    // `[CXC.25]` Las opciones del filtro salen del dato, igual que las sucursales: si mañana
    // no hay ninguna cuenta interna, el filtro no la ofrece.
    const ETIQUETA: Record<string, string> = {
      cliente_final: 'Cliente', interno: 'Cuenta interna (plaza)', ruta: 'Ruta',
    };
    const cuentas = ((a.opciones?.cuentas as string[]) || [])
      .filter((k) => CUENTA_KINDS.includes(k as CuentaKind))
      .sort((x, y) => CUENTA_KINDS.indexOf(x as CuentaKind) - CUENTA_KINDS.indexOf(y as CuentaKind))
      .map((k) => ({ code: k, label: ETIQUETA[k] || k }));

    return {
      sucursales,
      grupos: ((a.opciones?.grupos as string[]) || []).slice().sort(),
      zonas: ((a.opciones?.zonas as string[]) || []).slice().sort(),
      vendedores,
      cuentas,
    };
  }

  /**
   * Resumen gerencial (lo que Kepler no da): DSO, concentración top-10, proyección de cobranza,
   * cartera por vendedor y por zona.
   *
   * `[CXC.20]` **Ya no tiene cálculo propio: es el `resumen` que `cartera()` devuelve.** Tenía su
   * propio barrido de la pirámide con su propia fórmula de saldo, y por eso el mismo universo
   * daba $57,780,190.86 arriba (KPI) y $57,008,478.22 acá abajo, con los mismos filtros. El
   * comentario decía *"el resumen tiene que hablar del mismo universo que la tabla"* y los
   * filtros sí coincidían — lo que no coincidía era la fórmula. Ahora salen del mismo `SELECT`,
   * así que no pueden separarse otra vez.
   *
   * El endpoint sigue vivo para quien ya lo consuma; la pantalla dejó de llamarlo.
   */
  async resumen(q: { sucursal?: string; grupo?: string; zona?: string; vendedor?: string; cuenta?: string; search?: string } = {}) {
    const { resumen } = await this.cartera({ ...q, limit: 1 });
    return resumen;
  }

  /**
   * ⭐ `[CXC.26]` **La cartera vista por DÍA** — el mismo dinero, con el calendario como eje.
   *
   * La vista por cliente contesta «¿quién me debe?». Ésta contesta las otras dos preguntas del
   * que cobra: **«¿quiénes me deben estos días?»** y **«¿qué día debo cobrar?»**.
   *
   * ── ⛔ LA TRAMPA, MEDIDA EN PROD (2026-09-25) ──────────────────────────────────────────────
   * La lectura ingenua de «qué día debo cobrar» es un calendario **hacia adelante**. Ese
   * calendario existe, y es casi vacío:
   *
   *     vence hoy o después ....   $7,897,657.69  (  667 docs,  19 días)   12.9%
   *     YA VENCIÓ ..............  $53,015,537.54  (6,240 docs, 273 días)   87.1%
   *
   * Publicar sólo lo de adelante diría «tenés $7.9M por cobrar» sobre una cartera de $61M. Por
   * eso el eje va **a los dos lados**: hacia atrás el día contesta *¿desde cuándo me deben?* y
   * hacia adelante *¿cuándo me van a deber?*. Es la misma corrección que `cobranza-prevista.ts`
   * ya declaró para la curva semanal, aplicada al día.
   *
   * ── ⛔ EL TIPO DE CUENTA NO ES COSMÉTICO ACÁ ──────────────────────────────────────────────
   * Medido el mismo día: de los $26,081,506.31 `interno` (plaza contra plaza), **CERO están por
   * vencer** — el 100% ya venció. Sin separar cuentas, la agenda se llena de saldos entre plazas
   * propias que nadie va a cobrar por teléfono.
   *
   * ── Lo que NINGÚN día puede mostrar, y por eso se declara ─────────────────────────────────
   * El eje es `vencimiento`, que sólo existe a nivel DOCUMENTO; el saldo canónico es el de `kdue`
   * por CLIENTE. La resta no tiene fecha: medido hoy, **$612,428.11 sobre $61,525,623.34 (1.0%)**.
   * Va en `cobertura`, nunca repartido a dedo (ADR-056). ⚠️ `sin_vencimiento` se calcula aunque
   * hoy mida 0: una ausencia que hoy vale cero no autoriza a dejar de medirla.
   *
   * ⛔ **La promesa de pago NO es el eje.** `finance.collection_promises` sería la respuesta más
   * literal a «qué día debo cobrar» — y está **VACÍA en prod (0 filas, medido)**. Una agenda
   * montada ahí abriría en blanco. Cuando se empiece a usar, se superpone; no se reemplaza.
   *
   * ⚠️ **Pasada propia, no la de `cartera()`.** Se consideró colgarlo del mismo `SELECT` (que es
   * lo que `[CXC.20]` hizo con el resumen), y se descartó midiendo: las filas (día × cliente) son
   * **5,652 para la cartera completa** y viajarían en cada carga de la vista por cliente, que no
   * las usa. Acá la pirámide se paga una vez al abrir (**2.4 s medidos en prod**) y **todos los
   * drills por día son locales, sin más requests**. Esos 2.4 s son la deuda ya bautizada
   * `[CXC.21]`, no un costo nuevo.
   *
   * ── ⛔ NO HAY VENTANA, Y ESO SE DECIDIÓ MIDIENDO ──────────────────────────────────────────
   * La primera versión traía el desglose sólo de una ventana (±30 días) para no cargar de más.
   * Medido en prod, esa ventana **no ahorraba nada y sí escondía $29.7M**:
   *
   *     ventana -30/+30 ....... 2,890 filas ·   787 KB ·  2,311 ms
   *     ventana -90/+30 ....... 4,405 filas · 1,184 KB ·  2,374 ms
   *     TODO ................. 5,652 filas · 1,480 KB ·  2,413 ms   ← gzip: 119 KB (12.4×)
   *
   * El costo es **la pirámide**, no el recorte: pedir todo sale igual de caro que pedir un mes.
   * Y la app comprime (`compression({ threshold: 1024 })` en `main.ts`), así que la agenda
   * COMPLETA viaja en **119 KB**. Una ventana acá sólo compraba un botón de «ampliá para ver el
   * resto» sobre la mitad del dinero. ⚠️ El tamaño es una medición, no una garantía: el smoke
   * `test-newdb-cartera-por-dia.js` tiene el techo puesto, así que el día que crezca se pone
   * rojo un test en vez de ponerse lenta una pantalla.
   */
  async porDia(q: PorDiaQuery = {}): Promise<PorDiaResp> {
    const tenantId = this.tenantCtx.requireTenantId();
    const cond: string[] = [];
    const bind: BindValue[] = [tenantId];
    const add = (sql: string, ...v: BindValue[]): void => { cond.push(sql); bind.push(...v); };
    if (q.sucursal) add('d.sucursal = ?', q.sucursal);
    if (q.vendedor) add('d.vendedor = ?', q.vendedor);
    if (q.grupo) add('d.grupo = ?', q.grupo);
    if (q.zona) add('d.zona = ?', q.zona);
    if (q.cuenta) add('d.cuenta_kind = ?', q.cuenta);
    if (q.search) {
      const s = `%${q.search.trim()}%`;
      add('(d.cliente_code ILIKE ? OR d.cliente_nombre ILIKE ? OR d.rfc ILIKE ?)', s, s, s);
    }
    const filtros = cond.length ? `WHERE ${cond.join(' AND ')}` : '';

    const sql = `
      WITH h AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS d),
      cuenta AS MATERIALIZED (SELECT cliente_code, kind FROM analytics.v_customer_account_kind),
      doc AS MATERIALIZED (
        SELECT r.sucursal, r.cliente_code, NULLIF(btrim(r.vendedor), '') AS vendedor,
               r.grupo, r.zona, r.telefono, r.vencimiento, r.saldo_cliente, r.dias_credito,
               GREATEST(COALESCE(r.saldo_ajustado, 0), 0) AS res,
               c.name AS cliente_nombre, c.rfc AS rfc,
               COALESCE(k.kind, analytics.customer_account_kind(r.cliente_code, NULL)) AS cuenta_kind
          FROM analytics.customer_receivables r
          LEFT JOIN analytics.erp_customers c
                 ON c.tenant_id = r.tenant_id AND c.erp_code = r.cliente_code
          LEFT JOIN cuenta k ON k.cliente_code = btrim(r.cliente_code)
         WHERE r.tenant_id = ? AND r.cargo_abono = 'C'
      ),
      vnd AS (
        SELECT DISTINCT ON (btrim(sucursal), btrim(c2))
               btrim(sucursal) AS suc, btrim(c2) AS code, NULLIF(btrim(c3), '') AS nombre
          FROM kepler_ods.kduv
         WHERE btrim(COALESCE(c2, '')) <> '' ORDER BY 1, 2
      ),
      -- ⚠️ El filtro se aplica ANTES de recortar por saldo vivo: la cobertura tiene que medirse
      -- sobre el MISMO universo que la agenda, si no el denominador es otro y el % miente.
      fil AS (SELECT d.* FROM doc d ${filtros}),
      -- El canónico es por CLIENTE (kdue), el repartible es por DOCUMENTO.
      -- ⚠️ El residual va FILTRADO a \`res > 0.005\`, exactamente como el \`bucket('true')\` de
      -- \`cartera()\`. Hoy las dos formas dan lo mismo al centavo (medido), pero si acá se sumaran
      -- también las migajas sub-centavo, las dos pantallas publicarían totales distintos el día
      -- que aparezca una — y nadie sabría cuál mira.
      cli AS (SELECT sucursal, cliente_code, max(saldo_cliente) AS sc,
                     COALESCE(sum(res) FILTER (WHERE res > 0.005), 0) AS res
                FROM fil GROUP BY 1, 2),
      viva AS (SELECT * FROM fil WHERE res > 0.005),
      dias AS (
        SELECT f.vencimiento AS fecha, round(sum(f.res), 2) AS monto,
               count(*)::int AS docs,
               count(DISTINCT f.sucursal || '|' || f.cliente_code)::int AS clientes
          FROM viva f WHERE f.vencimiento IS NOT NULL GROUP BY 1
      ),
      det AS (
        SELECT f.vencimiento AS fecha, f.sucursal, f.cliente_code,
               max(f.cliente_nombre) AS cliente_nombre, max(f.telefono) AS telefono,
               max(f.zona) AS zona, max(f.cuenta_kind) AS cuenta_kind,
               max(f.dias_credito) AS dias_credito,
               (array_agg(f.vendedor ORDER BY f.vendedor)
                  FILTER (WHERE f.vendedor IS NOT NULL))[1] AS vendedor,
               round(sum(f.res), 2) AS monto, count(*)::int AS docs
          FROM viva f
         WHERE f.vencimiento IS NOT NULL
         GROUP BY 1, 2, 3
      )
      SELECT (SELECT d FROM h)::text AS hoy,
        COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.fecha) FROM (
            SELECT fecha::text AS fecha, monto, docs, clientes FROM dias) x), '[]'::jsonb) AS dias,
        COALESCE((SELECT jsonb_agg(to_jsonb(y) ORDER BY y.fecha, y.monto DESC) FROM (
            SELECT d.fecha::text AS fecha, d.sucursal, d.cliente_code, d.cliente_nombre,
                   d.telefono, d.zona, d.vendedor, n.nombre AS vendedor_nombre,
                   d.cuenta_kind, d.dias_credito, d.monto, d.docs
              FROM det d LEFT JOIN vnd n ON n.suc = d.sucursal AND n.code = d.vendedor) y),
          '[]'::jsonb) AS detalle,
        jsonb_build_object(
          'sucursales', COALESCE((SELECT jsonb_agg(DISTINCT d.sucursal) FROM doc d WHERE d.sucursal IS NOT NULL), '[]'::jsonb),
          'grupos',     COALESCE((SELECT jsonb_agg(DISTINCT d.grupo)    FROM doc d WHERE d.grupo    IS NOT NULL), '[]'::jsonb),
          'zonas',      COALESCE((SELECT jsonb_agg(DISTINCT d.zona)     FROM doc d WHERE d.zona     IS NOT NULL), '[]'::jsonb),
          'cuentas',    COALESCE((SELECT jsonb_agg(DISTINCT d.cuenta_kind) FROM doc d WHERE d.cuenta_kind IS NOT NULL), '[]'::jsonb),
          'vendedores', COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object(
                            'sucursal', d.sucursal, 'code', d.vendedor, 'nombre', n.nombre))
                          FROM doc d LEFT JOIN vnd n ON n.suc = d.sucursal AND n.code = d.vendedor
                         WHERE d.vendedor IS NOT NULL), '[]'::jsonb)
        ) AS opciones,
        jsonb_build_object(
          'canonico',        (SELECT round(COALESCE(sum(GREATEST(sc, 0)), 0), 2) FROM cli),
          'repartible',      (SELECT round(COALESCE(sum(res), 0), 2) FROM cli),
          -- CON SIGNO y con el mismo umbral que \`cartera()\`: si en algún cliente el desglose por
          -- documento supera al saldo de kdue, eso RESTA. Clampearlo a 0 inflaría la cobertura
          -- justo en el caso raro que hay que ver. Hoy no hay ninguno (medido: 0 clientes).
          'sin_documento',   (SELECT round(COALESCE(sum(GREATEST(sc, 0) - res)
                                 FILTER (WHERE abs(GREATEST(sc, 0) - res) > 0.005), 0), 2) FROM cli),
          'sin_vencimiento', (SELECT round(COALESCE(sum(res), 0), 2) FROM viva WHERE vencimiento IS NULL),
          'clientes',        (SELECT count(*)::int FROM cli WHERE GREATEST(sc, 0) > 0.005)
        ) AS cobertura,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'code', w.code,
            'name', COALESCE(NULLIF(btrim(w.name), ''), NULLIF(btrim(w.short_label), ''), w.code),
            'orden', w.display_order) ORDER BY w.display_order NULLS LAST, w.code)
          FROM commercial.warehouses w
         WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.code ~ '^[0-9]{2}$'), '[]'::jsonb)
          AS almacenes`;

    return this.tk.run(async (trx) => {
      const r = await trx.raw(sql, [...bind, tenantId]);
      const a = r.rows[0];
      const freshness = await this.freshness(trx);
      const hoy: string = a.hoy;

      // ⚠️ El veredicto (vencido / hoy / futuro) lo emite el SERVIDOR, no la pantalla. Restar
      // fechas en el navegador es donde un equipo en otra zona horaria cambia de día — el mismo
      // error que la Fase VP midió en 21 de 24 píldoras de frescura.
      const dias: DiaCartera[] = ((a.dias as FilaDiaCruda[]) || []).map((x) => {
        const off = diasEntre(hoy, x.fecha);
        return {
          fecha: x.fecha as string,
          estado: (off < 0 ? 'vencido' : off === 0 ? 'hoy' : 'futuro') as DiaEstado,
          dias_offset: off,
          monto: M2(x.monto), docs: Number(x.docs) || 0, clientes: Number(x.clientes) || 0,
        };
      });

      const detalle: DiaCliente[] = ((a.detalle as FilaClienteCruda[]) || []).map((x) => ({
        fecha: x.fecha as string, sucursal: x.sucursal, cliente_code: x.cliente_code,
        cliente_nombre: x.cliente_nombre || x.cliente_code,
        telefono: x.telefono || null, zona: x.zona || null,
        vendedor: x.vendedor || null, vendedor_nombre: x.vendedor_nombre || null,
        // Un `kind` que llegue vacío NO se asume nada raro: cae a `cliente_final`, igual que en
        // `cartera()`, para que las dos vistas repartan por tipo con el mismo criterio.
        cuenta_kind: (CUENTA_KINDS.includes(x.cuenta_kind as CuentaKind) ? x.cuenta_kind : 'cliente_final') as CuentaKind,
        dias_credito: x.dias_credito != null ? Number(x.dias_credito) : null,
        monto: M2(x.monto), docs: Number(x.docs) || 0,
        dias_offset: diasEntre(hoy, x.fecha),
      }));

      // Los totales salen de `dias`, o sea de la MISMA suma que la tabla: no pueden discrepar de
      // lo que el usuario está viendo.
      const sum = (p: (x: DiaCartera) => boolean) => r2(dias.filter(p).reduce((s, x) => s + x.monto, 0));
      const cob = a.cobertura || {};

      return {
        hoy, freshness,
        dias, detalle,
        totales: {
          vencido: sum((x) => x.estado === 'vencido'),
          hoy: sum((x) => x.estado === 'hoy'),
          futuro: sum((x) => x.estado === 'futuro'),
          // Cuántos días tiene cada lado: «$53M vencidos» no dice lo mismo que «$53M repartidos
          // en 273 días», y la segunda es la que explica por qué no se cobra de un tirón.
          dias_vencidos: dias.filter((x) => x.estado === 'vencido').length,
          dias_futuros: dias.filter((x) => x.estado === 'futuro').length,
        },
        cobertura: {
          canonico: M2(cob.canonico), repartible: M2(cob.repartible),
          sin_documento: M2(cob.sin_documento), sin_vencimiento: M2(cob.sin_vencimiento),
          clientes: Number(cob.clientes) || 0,
        },
        // El MISMO constructor de opciones que la vista por cliente: un segundo builder acá
        // sería el primitivo duplicado que ADR-056 manda no volver a escribir.
        filtros: this.opciones(a),
      };
    });
  }

  /** CXC.12 — tendencia de cartera (snapshots diarios). Sin sucursal = red (suma por día). */
  async tendencia(q: { sucursal?: string; dias?: number } = {}) {
    const tenantId = this.tenantCtx.requireTenantId();
    const dias = Math.min(Math.max(Number(q.dias) || 90, 1), 730);
    return this.tk.run(async (trx) => {
      let qb = trx('analytics.customer_receivable_snapshots')
        .where('tenant_id', tenantId)
        .andWhereRaw(`snapshot_date >= (now() AT TIME ZONE 'America/Mexico_City')::date - ?::int`, [dias]);
      if (q.sucursal) qb = qb.where('sucursal', q.sucursal);
      const rows = await qb
        .select(trx.raw('snapshot_date::text as fecha'))
        .sum({ saldo_total: 'saldo_total', vencido_total: 'vencido_total', n_clientes: 'n_clientes' })
        .groupBy('snapshot_date').orderBy('snapshot_date');
      return rows.map((r: any) => ({
        fecha: r.fecha, saldo_total: M2(r.saldo_total), vencido_total: M2(r.vencido_total),
        n_clientes: Number(r.n_clientes) || 0,
        pct_vencido: M2(r.saldo_total) > 0 ? Math.round((M2(r.vencido_total) / M2(r.saldo_total)) * 1000) / 10 : 0,
      }));
    });
  }

  /** CXC.13 — compromisos de pago abiertos de un cliente (para el drill). */
  private async promisesOf(trx: any, tenantId: string, sucursal: string, cliente: string) {
    const rows = await trx('finance.collection_promises')
      .where({ tenant_id: tenantId, sucursal, cliente_code: cliente })
      .whereIn('estado', ['abierta', 'incumplida'])
      .orderBy('fecha_promesa', 'asc')
      .select('id', 'monto_prometido', trx.raw('fecha_promesa::text as fecha_promesa'), 'estado', 'nota', 'created_by', trx.raw('created_at::text as created_at'));
    return rows.map((r: any) => ({ ...r, monto_prometido: M2(r.monto_prometido) }));
  }

  /** Registra un compromiso de pago (promesa de cobro). Escribe en tabla propia, NO Kepler. */
  async createPromise(sucursal: string, cliente: string, dto: { monto: number; fecha: string; nota?: string }, username?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!dto?.monto || dto.monto <= 0) throw new BadRequestException('monto inválido');
    if (!dto?.fecha) throw new BadRequestException('fecha requerida');
    return this.tk.run(async (trx) => {
      const snap = (await trx('analytics.customer_receivables as r')
        .leftJoin('analytics.erp_customers as c', function (this: any) { this.on('c.tenant_id', 'r.tenant_id').andOn('c.erp_code', 'r.cliente_code'); })
        .where({ 'r.tenant_id': tenantId, 'r.sucursal': sucursal, 'r.cliente_code': cliente, 'r.cargo_abono': 'C' })
        // `[CXC.20]` El saldo que se congela en el compromiso es el CANÓNICO (`saldo_cliente`, de
        // `kdue`), no `Σ saldo_documento` — que es la otra cifra, la que se queda corta. Una
        // promesa de pago se compara después contra lo que el cliente debe, así que guardar la
        // que no cuadra con Kepler dejaba un compromiso comparado contra un saldo que nadie más
        // publica.
        .select(trx.raw('max(c.name) as nombre'),
                trx.raw('GREATEST(COALESCE(max(r.saldo_cliente), 0), 0) as saldo')).first()) || {};
      const [row] = await trx('finance.collection_promises').insert({
        tenant_id: trx.raw('current_tenant_id()'),
        sucursal, cliente_code: cliente, cliente_nombre: snap.nombre || cliente,
        monto_prometido: dto.monto, fecha_promesa: dto.fecha, saldo_al_registrar: M2(snap.saldo),
        nota: dto.nota || null, created_by: username || null,
      }).returning(['id', 'estado']);
      return row;
    });
  }

  /** Resuelve un compromiso: cumplida | incumplida | cancelada. */
  async resolvePromise(id: string, estado: 'cumplida' | 'incumplida' | 'cancelada', username?: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!['cumplida', 'incumplida', 'cancelada'].includes(estado)) throw new BadRequestException('estado inválido');
    return this.tk.run(async (trx) => {
      const n = await trx('finance.collection_promises').where({ tenant_id: tenantId, id })
        .update({ estado, resolved_by: username || null, resolved_at: trx.fn.now(), updated_at: trx.fn.now() });
      if (!n) throw new BadRequestException('compromiso no encontrado');
      return { id, estado };
    });
  }

  /**
   * Opciones de los selects (sucursal/grupo/zona/vendedor), **derivadas del dato** y con el
   * nombre resuelto contra el catálogo. Ver `opciones()` para el porqué.
   *
   * `[CXC.20]` Eran cuatro `SELECT DISTINCT` sueltos —**11,294 ms medidos en prod**, porque cada
   * uno reconstruía la pirámide de CTEs entera— y devolvían códigos pelados. Ahora salen de la
   * misma pasada que la tabla. La pantalla ya no llama a este endpoint (le llegan en `cartera()`);
   * queda para quien lo consuma por fuera.
   */
  async filtros() {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => this.opciones(await this.agregado(trx, tenantId, {})));
  }

  /**
   * Detalle (auxiliar) de un cliente: partidas con saldo por documento EXACTO (kdm5)
   * + los cobros/notas aplicados a cada factura (como el reporte Kepler). Si falta
   * `saldo_documento` (ramas sin kdm5), cae a `importe` (sin aplicar).
   */
  async detalle(sucursal: string, cliente: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      const hoy = await this.hoy(trx);
      const rows = await trx('analytics.customer_receivables as r')
        .leftJoin('analytics.erp_customers as c', function (this: any) {
          this.on('c.tenant_id', 'r.tenant_id').andOn('c.erp_code', 'r.cliente_code');
        })
        .where({ 'r.tenant_id': tenantId, 'r.sucursal': sucursal, 'r.cliente_code': cliente })
        .select('r.doc_tipo', 'r.doc_label', 'r.doc_code', 'r.folio', 'r.folio_digital',
          trx.raw('r.fecha::text as fecha'), trx.raw('r.vencimiento::text as vencimiento'),
          'r.importe', 'r.cargo_abono', 'r.estatus', 'r.vendedor', 'r.saldo_documento', 'r.saldo_ajustado',
          'r.saldo_cliente', 'r.dias_pago', 'r.aplicaciones',
          'r.limite_credito', 'r.dias_credito', 'r.telefono', 'r.grupo', 'r.zona',
          trx.raw('c.name as cliente_nombre'), trx.raw('c.rfc as rfc'))
        .orderBy([{ column: 'r.fecha', order: 'asc' }, { column: 'r.folio', order: 'asc' }]);

      const cargos = rows.filter((r: any) => r.cargo_abono === 'C');
      const abonos = rows.filter((r: any) => r.cargo_abono === 'A');

      const partidas = cargos.map((cg: any) => {
        const importe = M2(cg.importe);
        // El saldo que se muestra es el ajustado (cuadra con kdue); `saldo_kdm5` es lo que
        // dicen las aplicaciones. Difieren cuando hubo un abono que kdm5 no supo ubicar.
        const saldo_kdm5 = cg.saldo_documento != null ? M2(cg.saldo_documento) : importe;
        const saldo_documento = cg.saldo_ajustado != null ? M2(cg.saldo_ajustado) : saldo_kdm5;
        const venc = cg.vencimiento || null;
        const dias = venc ? Math.floor((Date.parse(hoy) - Date.parse(venc)) / 86400000) : null;
        const aplicaciones: any[] = Array.isArray(cg.aplicaciones) ? cg.aplicaciones : (cg.aplicaciones || []);
        const saldada = saldo_documento <= 0.005;
        // Saldada = la última aplicación que la cerró (la vista ya las ordena por fecha).
        const fechas = aplicaciones.map((a) => a?.fecha).filter(Boolean).sort();
        return {
          doc_tipo: cg.doc_tipo, doc_label: cg.doc_label, doc_code: cg.doc_code,
          folio: cg.folio, folio_digital: cg.folio_digital,
          fecha: cg.fecha || null, vencimiento: venc,
          importe, saldo_documento, saldo_kdm5, dias_vencido: dias, vencida: dias != null && dias > 0 && !saldada,
          saldada, pagada_el: saldada && fechas.length ? fechas[fechas.length - 1] : null,
          dias_pago: cg.dias_pago != null ? Number(cg.dias_pago) : null,
          estatus: cg.estatus,
          aplicaciones,
        };
      });
      // `rows[0]` es el documento MÁS VIEJO (la consulta ordena por fecha asc). Para los datos de
      // catálogo da igual —vienen de `kdud`, iguales en todas las filas— pero el vendedor es por
      // documento: se toma el de la factura más reciente, que es quien lo atiende hoy.
      const head = rows[0] || {};
      const ultimo = rows.length ? rows[rows.length - 1] : head;
      const vendedor = (ultimo.vendedor || head.vendedor || null) as string | null;
      const saldoDocs = Math.round(partidas.reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100;
      const saldoCliente = head.saldo_cliente != null ? M2(head.saldo_cliente) : saldoDocs;
      const saldo = Math.round(Math.max(saldoCliente, 0) * 100) / 100;
      const pagos = partidas.map((p) => p.dias_pago).filter((d): d is number => d != null);

      // `[CXC.20]` El nombre del vendedor sale de `kduv` por **(sucursal, código)**. Por código
      // solo nombraría mal a 11 de 81: el mismo '1' es otra persona según la plaza.
      let vendedorNombre: string | null = null;
      if (vendedor) {
        const v = (await trx.raw(
          `SELECT NULLIF(btrim(c3), '') AS nombre FROM kepler_ods.kduv
            WHERE btrim(sucursal) = ? AND btrim(c2) = ? LIMIT 1`, [sucursal, vendedor])).rows[0];
        vendedorNombre = v?.nombre || null;
      }

      // 360 — cobranza real del cliente (Fase CC): cobros UA0501 + evidencia (ficha/validada).
      // Puente por cliente_code (los cobros de la suc '00' — Oficinas, no el CEDIS: ERP_KEPLER
      // §2.3 — traen el código del cliente). Best-effort.
      let cobranza: any = null;
      try {
        const cc = (await trx.raw(
          `SELECT count(*)::int n, COALESCE(sum(e.monto), 0)::numeric monto, max(e.cobro_date)::text ultimo,
                  count(d.id)::int con_ficha, count(*) FILTER (WHERE d.estado = 'validado')::int validados
             FROM analytics.erp_collections e
             LEFT JOIN finance.collection_deposits d
               ON d.tenant_id = e.tenant_id AND d.sucursal = e.sucursal AND d.folio = e.folio
            WHERE e.tenant_id = ? AND e.cliente_code = ?`,
          [tenantId, cliente])).rows[0];
        if (cc && cc.n > 0) {
          cobranza = { n: cc.n, monto: M2(cc.monto), ultimo: cc.ultimo, con_ficha: cc.con_ficha, validados: cc.validados };
        }
      } catch { /* CC no disponible → sin puente */ }

      let compromisos: any[] = [];
      try { compromisos = await this.promisesOf(trx, tenantId, sucursal, cliente); } catch { /* tabla no migrada aún */ }

      return {
        hoy,
        cobranza,
        compromisos,
        freshness: await this.freshness(trx),
        cliente: {
          sucursal, cliente_code: cliente, cliente_nombre: head.cliente_nombre || cliente, rfc: head.rfc || null,
          vendedor, vendedor_nombre: vendedorNombre, grupo: head.grupo || null, zona: head.zona || null,
          telefono: head.telefono || null,
          limite_credito: head.limite_credito != null && M2(head.limite_credito) > 0 ? M2(head.limite_credito) : null,
          dias_credito: head.dias_credito != null ? Number(head.dias_credito) : null,
        },
        saldo,
        saldo_a_favor: Math.round(Math.max(-saldoCliente, 0) * 100) / 100,
        sin_documento: Math.abs(saldo - saldoDocs) > 0.005 ? Math.round((saldo - saldoDocs) * 100) / 100 : 0,
        dias_pago_prom: pagos.length ? Math.round((pagos.reduce((s, d) => s + d, 0) / pagos.length) * 10) / 10 : null,
        n_pagos: pagos.length,
        vencido: Math.round(partidas.filter((p) => p.vencida).reduce((s, p) => s + p.saldo_documento, 0) * 100) / 100,
        // Van TODAS: la partida saldada es historia de pago del cliente, no ruido. El front
        // las esconde detrás de un toggle para que el default siga siendo "partidas vivas".
        partidas,
        pagadas: partidas.filter((p) => p.saldada).length,
        importe_pagado: Math.round(partidas.filter((p) => p.saldada).reduce((s, p) => s + p.importe, 0) * 100) / 100,
        abonos: abonos.map((r: any) => ({
          doc_label: r.doc_label, folio: r.folio, fecha: r.fecha || null, importe: M2(r.importe),
        })),
      };
    });
  }

  /**
   * `[CXC.SKU.1]` — Qué documentos tocaron un producto: facturas Y notas de crédito o
   * devoluciones, que es de lo que se trataba el pedido.
   *
   * ⛔ Lee `analytics.erp_sales_line_search`, NO `erp_sales_invoice_lines`. La segunda
   * existe para el DETALLE de un documento y arrastra `kdii`, `catalog.products` y
   * `v_product_box_factor`: la MISMA búsqueda por ella tarda **16,871 ms**. Por la
   * flaca, **~400 ms** en el peor SKU (541 renglones). Medido, no estimado.
   *
   * Dos caminos, y el de texto NO busca sobre los 3.8 M de renglones:
   *   · parece código → se usa tal cual (`sku = …`, por índice).
   *   · texto → se resuelve a SKUs contra `catalog.products` (**11 ms**) y recién
   *     entonces se buscan los renglones (**337 ms** con 25 SKUs). Un
   *     `descripcion ILIKE '%x%'` directo sobre `kdm2` sería un seq scan de 1.9 GB y
   *     volveríamos a los 17 s.
   *
   * ⚠️ `U-D-10` ("Ticket Contado Caja", 424,022 cabeceras) NO entra: es venta de
   * mostrador, no factura. Va declarado en la respuesta (`excluye`) para que la
   * pantalla lo diga — omitirlo callado sería dibujar una cobertura que no existe.
   */
  async buscarPorProducto(q: { texto?: string; limit?: number }) {
    const texto = String(q.texto ?? '').trim();
    const vacio = { texto, skus: [] as string[], renglones: [] as unknown[], truncado: false, excluye: EXCLUYE_BUSQUEDA };
    if (texto.length < 2) return vacio;

    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);

    return this.tk.run(async (trx) => {
      const skus = new Set<string>();
      // Un código no lleva espacios; si los tiene, es texto y no vale probarlo como SKU.
      if (/^[A-Za-z0-9._-]+$/.test(texto)) skus.add(texto);

      const porNombre = await trx('catalog.products')
        .whereNull('deleted_at')
        .whereRaw('nombre ILIKE ?', [`%${texto}%`])
        .select('sku')
        .limit(25);
      for (const p of porNombre) if (p.sku != null) skus.add(String(p.sku).trim());

      if (!skus.size) return vacio;

      // limit + 1 para saber si quedó cortado SIN contar el total (contar cuesta otro scan).
      const rows = await trx('analytics.erp_sales_line_search')
        .whereIn('sku', [...skus])
        .orderBy('fecha', 'desc')
        .limit(limit + 1)
        .select('folio_digital', 'sucursal', 'folio', 'doc_prefix', 'linea', 'sku',
                'descripcion', 'unidad', 'cantidad', 'importe', 'naturaleza', 'fecha');

      return {
        texto,
        skus: [...skus],
        renglones: rows.slice(0, limit),
        truncado: rows.length > limit,
        excluye: EXCLUYE_BUSQUEDA,
      };
    });
  }
}
