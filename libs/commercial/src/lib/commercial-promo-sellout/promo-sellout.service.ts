import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, ScopeService } from '@megadulces/platform-core';

/**
 * `[MKT.6]` — **¿La activación sirvió?** El resultado del acuerdo, leído del ERP.
 *
 * ── Qué agrega sobre `[MKT.1]` ───────────────────────────────────────────────────────────────
 * El expediente prueba que la promoción **se ejecutó** (hay evidencia, en tal plaza, en tal
 * fecha). No dice si **sirvió**. Este servicio cierra ese lazo sin capturar un solo dato a mano:
 * lee `commercial.v_promo_agreement_sellout`, que deriva la venta de `analytics.v_sellout_daily`
 * y la compara contra una línea base del mismo largo inmediatamente anterior.
 *
 * ── Tres reglas que este servicio NO puede romper ───────────────────────────────────────────
 *
 *  1. **No suma lo que no se pudo medir.** El rollup separa `canales_medidos` de los que están
 *     en `sin_alcance` / `sin_venta` / `sin_baseline`, y publica esa razón. Sumar un NULL como 0
 *     haría que un acuerdo a medio capturar se lea como un fracaso comercial (ADR-056). Es el
 *     mismo defecto que MR.5 midió en prod: una pantalla decía 100% de cobertura por construcción.
 *
 *  2. **No re-deriva la venta.** Toda la aritmética vive en la vista, que es la que un smoke
 *     puede contrastar contra un recálculo independiente. Un segundo cálculo en TypeScript se
 *     desincroniza del primero y nadie se entera hasta que los dos números se publican juntos.
 *
 *  3. **Una fuente vacía no es un cero.** La conciliación contra las notas de crédito del ERP
 *     declara `fuente_vacia` cuando el espejo no tiene filas, en vez de reportar $0 acreditado.
 *     Medido 2026-09-28: `analytics.erp_purchase_adjustments` tiene **0 filas** en la base local
 *     (su importer nunca corrió acá), así que ese camino está **construido pero NO medido**.
 *
 * ── Alcance de datos ────────────────────────────────────────────────────────────────────────
 * La lectura por plaza pasa por `ScopeService.assertCanRead('warehouse', …)` (ADR-050): el
 * permiso dice si se abre la pantalla, el alcance dice **sobre qué filas**. El corte va ANTES de
 * la consulta, y el spec lo verifica comprobando que no se llegue a la base.
 *
 * Conexión: `TenantKnexService.run()` es OBLIGATORIO — las tablas de `[MKT.1]` tienen RLS
 * forzado y sin el `SET LOCAL app.tenant_id` toda consulta devuelve cero filas en silencio.
 */

/** Los cuatro estados que la vista declara. No es un booleano a propósito. */
export type EstadoMedicion = 'medida' | 'sin_baseline' | 'sin_venta' | 'sin_alcance';
export type EstadoUnidad = 'unica' | 'mixta' | 'sin_dato';

/** Una fila de la vista, ya con los `numeric` convertidos (el driver los trae como string). */
export interface ResultadoCanal {
  channel_id: string;
  agreement_id: string;
  folio: string | null;
  empresa: string;
  proveedor: string;
  agreement_status: string;
  warehouse_code: string;
  warehouse_name: string | null;
  desde: string;
  hasta: string;
  dias_ventana: number;
  ventana_abierta: boolean;
  monto_negociado: number | null;
  codigos_total: number;
  codigos_ligados: number;
  evidence_required: number;
  evidence_count: number;
  dias_con_venta: number;
  monto_ventana: number | null;
  monto_baseline: number | null;
  uplift_monto: number | null;
  uplift_pct: number | null;
  units_ventana: number | null;
  units_baseline: number | null;
  unidad_estado: EstadoUnidad;
  medicion: EstadoMedicion;
}

/**
 * El rollup de un acuerdo. `monto_*` sólo agrega los canales MEDIDOS; el resto se cuenta y se
 * nombra. Es la diferencia entre "esta promo dejó $12,000 de uplift sobre 3 de 7 plazas" y
 * "esta promo dejó $12,000", que es lo que dice un rollup que suma NULLs como ceros.
 */
export interface ResumenAcuerdo {
  agreement_id: string;
  folio: string | null;
  proveedor: string;
  canales_total: number;
  canales_medidos: number;
  /** Por qué NO se pudo medir cada uno de los demás. Suma exactamente `canales_total − medidos`. */
  no_medidos: Record<Exclude<EstadoMedicion, 'medida'>, number>;
  /** Cobertura de captura: sin códigos ligados al catálogo no hay nada que mirar. */
  codigos_total: number;
  codigos_ligados: number;
  monto_ventana: number | null;
  monto_baseline: number | null;
  uplift_monto: number | null;
  uplift_pct: number | null;
  monto_negociado: number | null;
  /** Evidencia (lo que ya medía el expediente), al lado del resultado. */
  evidencia_requerida: number;
  evidencia_subida: number;
  /** Alguna ventana sigue abierta ("HASTA AGOTAR") → la cifra es provisional. */
  ventana_abierta: boolean;
}

/** Diagnóstico de captura. NO es un resolvedor: sólo cuenta lo que se podría ligar. */
export interface CoberturaCodigos {
  codigos_total: number;
  ligados: number;
  /**
   * Sin ligar pero con un SKU idéntico en el catálogo. Es un DIAGNÓSTICO para que la pantalla
   * pueda decir "esto se arregla", no una liga automática: escribir `product_id` es del flujo de
   * captura de `[MKT.1]`, y resolver el mismo código en dos lugares distintos garantiza que un
   * día digan cosas distintas (ADR-056).
   */
  sin_ligar_resolubles: number;
  sin_ligar_sin_match: number;
}

/** Negociado contra lo que el proveedor de verdad acreditó. */
export interface Conciliacion {
  agreement_id: string;
  folio: string | null;
  proveedor: string;
  monto_negociado: number | null;
  /** NULL cuando no se pudo medir. Nunca 0: un cero dice "no acreditó nada". */
  monto_acreditado: number | null;
  documentos: number;
  /** Cómo se ligó el proveedor del acuerdo con el del ERP, o por qué no se pudo. */
  metodo: 'codigo_proveedor' | 'nombre_exacto' | 'sin_liga';
  estado: 'conciliado' | 'sin_acreditacion' | 'fuente_vacia' | 'sin_liga' | 'sin_monto';
  nota: string;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const int = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

@Injectable()
export class PromoSelloutService {
  constructor(
    private readonly tk: TenantKnexService,
    /**
     * El alcance de datos (ADR-050). No `@Optional()`: acá decide si se contesta o no, y un
     * servicio instanciado sin él tendría que elegir entre abrirse o romperse.
     */
    private readonly scope: ScopeService,
  ) {}

  /** Convierte una fila cruda de la vista. Un solo lugar, para que no se haga en cada consumidor. */
  private mapear(r: Record<string, unknown>): ResultadoCanal {
    return {
      channel_id: String(r['channel_id']),
      agreement_id: String(r['agreement_id']),
      folio: (r['folio'] as string) ?? null,
      empresa: String(r['empresa'] ?? ''),
      proveedor: String(r['proveedor'] ?? ''),
      agreement_status: String(r['agreement_status'] ?? ''),
      warehouse_code: String(r['warehouse_code'] ?? ''),
      warehouse_name: (r['warehouse_name'] as string) ?? null,
      desde: this.fecha(r['desde']),
      hasta: this.fecha(r['hasta']),
      dias_ventana: int(r['dias_ventana']),
      ventana_abierta: r['ventana_abierta'] === true,
      monto_negociado: num(r['monto_negociado']),
      codigos_total: int(r['codigos_total']),
      codigos_ligados: int(r['codigos_ligados']),
      evidence_required: int(r['evidence_required']),
      evidence_count: int(r['evidence_count']),
      dias_con_venta: int(r['dias_con_venta']),
      monto_ventana: num(r['monto_ventana']),
      monto_baseline: num(r['monto_baseline']),
      uplift_monto: num(r['uplift_monto']),
      uplift_pct: num(r['uplift_pct']),
      units_ventana: num(r['units_ventana']),
      units_baseline: num(r['units_baseline']),
      unidad_estado: (r['unidad_estado'] as EstadoUnidad) ?? 'sin_dato',
      medicion: (r['medicion'] as EstadoMedicion) ?? 'sin_alcance',
    };
  }

  /**
   * Una `date` de Postgres llega como `Date` en medianoche UTC; `String()` la renderiza en hora
   * de México (−06:00) y devuelve **el día anterior**. Ese error exacto ya se pagó en la Fase LC
   * (una factura del día 1 salía fechada el 31 en el TXT y en el respaldo). Se formatea en UTC.
   */
  private fecha(v: unknown): string {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return String(v ?? '').slice(0, 10);
  }

  /** Resultado de todos los canales, para la bandeja de Mercadotecnia. */
  async listar(opts: { folio?: string; medicion?: string; limite?: number } = {}): Promise<ResultadoCanal[]> {
    const limite = Math.min(Math.max(Number(opts.limite) || 300, 1), 1000);
    return this.tk.run(async (trx) => {
      const q = trx('commercial.v_promo_agreement_sellout').select('*');
      if (opts.folio) q.where('folio', opts.folio);
      if (opts.medicion) q.where('medicion', opts.medicion);
      // Lo medido y con más uplift primero; lo no medible al final, para que no encabece la cola
      // algo sobre lo que no hay nada que decidir.
      const rows = await q
        .orderByRaw('uplift_monto DESC NULLS LAST')
        .orderBy('folio', 'desc')
        .limit(limite);
      return rows.map((r: Record<string, unknown>) => this.mapear(r));
    });
  }

  /** Los canales de UN acuerdo, más su rollup honesto. */
  async porAcuerdo(agreementId: string): Promise<{ resumen: ResumenAcuerdo; canales: ResultadoCanal[] }> {
    if (!agreementId) throw new BadRequestException('Falta el acuerdo');
    const canales = await this.tk.run(async (trx) => {
      const rows = await trx('commercial.v_promo_agreement_sellout')
        .select('*')
        .where('agreement_id', agreementId)
        .orderBy('warehouse_code');
      return rows.map((r: Record<string, unknown>) => this.mapear(r));
    });
    if (!canales.length) throw new NotFoundException('El acuerdo no tiene canales, o no existe');
    return { resumen: this.resumir(agreementId, canales), canales };
  }

  /**
   * Rollup. **Sólo agrega los canales medidos**; el resto se cuenta por motivo.
   * Se expone como función pura para poder probarlo sin base (es donde vive el riesgo de
   * publicar un número que suma NULLs como ceros).
   */
  resumir(agreementId: string, canales: ResultadoCanal[]): ResumenAcuerdo {
    const medidos = canales.filter((c) => c.medicion === 'medida');
    // `reduce<number>` explícito: con `Array<number | null>` TypeScript infiere el acumulador
    // como `number | null` y el resultado deja de ser sumable. El `?? 0` de adentro NO es el
    // pecado de "dibujar un cero": acá ya se filtró a los MEDIDOS, y un medido sin monto no
    // existe (la vista garantiza que `medicion='medida'` implica ventana y base no nulas).
    const suma = (xs: Array<number | null>) =>
      xs.length ? Math.round(xs.reduce<number>((a, b) => a + (b ?? 0), 0) * 100) / 100 : null;

    const ventana = medidos.length ? suma(medidos.map((c) => c.monto_ventana)) : null;
    const base = medidos.length ? suma(medidos.map((c) => c.monto_baseline)) : null;
    const uplift = ventana !== null && base !== null ? Math.round((ventana - base) * 100) / 100 : null;

    const primero = canales[0];
    return {
      agreement_id: agreementId,
      folio: primero?.folio ?? null,
      proveedor: primero?.proveedor ?? '',
      canales_total: canales.length,
      canales_medidos: medidos.length,
      no_medidos: {
        sin_baseline: canales.filter((c) => c.medicion === 'sin_baseline').length,
        sin_venta: canales.filter((c) => c.medicion === 'sin_venta').length,
        sin_alcance: canales.filter((c) => c.medicion === 'sin_alcance').length,
      },
      // La cobertura de códigos es del ACUERDO, no del canal: todos los canales traen el mismo
      // par. Tomar el máximo evita que una fila rara lo subestime.
      codigos_total: Math.max(0, ...canales.map((c) => c.codigos_total)),
      codigos_ligados: Math.max(0, ...canales.map((c) => c.codigos_ligados)),
      monto_ventana: ventana,
      monto_baseline: base,
      uplift_monto: uplift,
      // El % sólo con denominador > 0: sin base no es "+infinito", es "no había base".
      uplift_pct:
        uplift !== null && base !== null && base > 0
          ? Math.round((uplift / base) * 10000) / 100
          : null,
      monto_negociado: primero?.monto_negociado ?? null,
      evidencia_requerida: canales.reduce((a, c) => a + c.evidence_required, 0),
      evidencia_subida: canales.reduce((a, c) => a + c.evidence_count, 0),
      ventana_abierta: canales.some((c) => c.ventana_abierta),
    };
  }

  /** Lo de UNA plaza. El permiso abre la pantalla; el alcance decide qué filas. */
  async porSucursal(warehouseCode: string): Promise<ResultadoCanal[]> {
    if (!warehouseCode || !String(warehouseCode).trim()) {
      throw new BadRequestException('Falta la sucursal');
    }
    // ANTES de la consulta, a propósito: si el gate dejara pasar, la base ya habría contestado.
    await this.scope.assertCanRead('warehouse', String(warehouseCode).trim());
    return this.tk.run(async (trx) => {
      const rows = await trx('commercial.v_promo_agreement_sellout')
        .select('*')
        .whereRaw('LOWER(warehouse_code) = LOWER(?)', [String(warehouseCode).trim()])
        .orderBy('desde', 'desc');
      return rows.map((r: Record<string, unknown>) => this.mapear(r));
    });
  }

  /**
   * Diagnóstico de captura: cuántos códigos del acuerdo están ligados al catálogo y cuántos de
   * los que faltan tienen un SKU idéntico esperando.
   *
   * Existe porque `sin_alcance` sin explicación es inútil: la pantalla tiene que poder decir
   * "4 de 6 códigos no están ligados, y 4 resuelven por SKU" en vez de un cero mudo.
   * ⚠️ NO liga nada: escribir `product_id` es del flujo de `[MKT.1]`.
   */
  async coberturaDeCodigos(agreementId: string): Promise<CoberturaCodigos> {
    if (!agreementId) throw new BadRequestException('Falta el acuerdo');
    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT
            count(*)::int AS total,
            count(*) FILTER (WHERE k.product_id IS NOT NULL)::int AS ligados,
            count(*) FILTER (
              WHERE k.product_id IS NULL AND EXISTS (
                SELECT 1 FROM catalog.products p
                 WHERE p.tenant_id = k.tenant_id AND p.deleted_at IS NULL
                   AND btrim(p.sku) = btrim(k.code)))::int AS resolubles
           FROM commercial.promo_agreement_codes k
          WHERE k.agreement_id = ?`,
        [agreementId],
      );
      const r = rows[0] || { total: 0, ligados: 0, resolubles: 0 };
      return {
        codigos_total: int(r.total),
        ligados: int(r.ligados),
        sin_ligar_resolubles: int(r.resolubles),
        sin_ligar_sin_match: int(r.total) - int(r.ligados) - int(r.resolubles),
      };
    });
  }

  /**
   * ⭐ Lo negociado contra lo que el proveedor **de verdad acreditó**.
   *
   * La fuente es `analytics.erp_purchase_adjustments`, el espejo de los ajustes de compra de
   * Kepler (`X-D-40` devolución y `X-D-55` nota de crédito — 1,154 documentos y $20.3M en 2026,
   * con el motivo clasificado en `categoria`). Es el único lugar donde el dinero del acuerdo
   * aparece como un hecho y no como una promesa.
   *
   * ⚠️ **La liga con el proveedor es heurística cuando falta `supplier_id`**, porque
   * `promo_agreements.proveedor` es texto libre por diseño (el formato se imprime con el nombre
   * tal cual se negoció). Se declara en `metodo` en vez de presentar un cruce 1:1 que no existe
   * — mismo criterio que CB.15.2 con el pago a proveedor.
   *
   * ⚠️ **Construido y NO medido**: el espejo está en 0 filas en la base local (2026-09-28).
   */
  async conciliacion(agreementId: string): Promise<Conciliacion> {
    if (!agreementId) throw new BadRequestException('Falta el acuerdo');
    return this.tk.run(async (trx) => {
      const ag = await trx('commercial.promo_agreements')
        .select('id', 'folio', 'proveedor', 'supplier_id', 'monto', 'vigencia_desde', 'vigencia_hasta')
        .where('id', agreementId)
        .whereNull('deleted_at')
        .first();
      if (!ag) throw new NotFoundException('No existe el acuerdo');

      const salida: Conciliacion = {
        agreement_id: agreementId,
        folio: ag.folio ?? null,
        proveedor: ag.proveedor,
        monto_negociado: num(ag.monto),
        monto_acreditado: null,
        documentos: 0,
        metodo: 'sin_liga',
        estado: 'sin_liga',
        nota: '',
      };

      // 1) ¿La fuente existe y tiene algo? Una fuente vacía NO es un cero acreditado.
      const espejo = await trx.raw(`SELECT to_regclass('analytics.erp_purchase_adjustments') AS t`);
      if (!espejo.rows[0]?.t) {
        salida.estado = 'fuente_vacia';
        salida.nota = 'El espejo analytics.erp_purchase_adjustments no existe en esta base.';
        return salida;
      }
      const { rows: hay } = await trx.raw(
        `SELECT count(*)::int AS n FROM analytics.erp_purchase_adjustments
          WHERE tenant_id = public.current_tenant_id()`,
      );
      if (int(hay[0]?.n) === 0) {
        salida.estado = 'fuente_vacia';
        salida.nota =
          'El espejo de notas de crédito del ERP está vacío: no se puede afirmar cuánto acreditó ' +
          'el proveedor. No es $0 — es que no hay con qué medirlo.';
        return salida;
      }

      // 2) La liga con el proveedor del ERP. Por código si existe; por nombre exacto si no.
      let where = '';
      // `string[]` y no `unknown[]`: knex tipa los bindings como `RawBinding`, y un `unknown`
      // no le entra. Es el mismo tropiezo de tipos que no aparece hasta que compila el bundle.
      const params: string[] = [];
      if (ag.supplier_id) {
        const prov = await trx('catalog.suppliers').select('code').where('id', ag.supplier_id).first();
        if (prov?.code) {
          where = 'btrim(a.proveedor_code) = btrim(?)';
          params.push(prov.code);
          salida.metodo = 'codigo_proveedor';
        }
      }
      if (!where) {
        where = 'upper(btrim(a.proveedor_nombre)) = upper(btrim(?))';
        params.push(ag.proveedor);
        salida.metodo = 'nombre_exacto';
      }

      // 3) Ventana: la vigencia del acuerdo. "HASTA AGOTAR" se corta hoy, igual que la vista.
      const desde = this.fecha(ag.vigencia_desde);
      const hasta = ag.vigencia_hasta ? this.fecha(ag.vigencia_hasta) : null;

      const { rows } = await trx.raw(
        `SELECT count(*)::int AS n, sum(a.monto) AS monto
           FROM analytics.erp_purchase_adjustments a
          WHERE a.tenant_id = public.current_tenant_id()
            AND ${where}
            AND a.adjustment_date >= ?::date
            AND a.adjustment_date <= COALESCE(?::date, CURRENT_DATE)`,
        [...params, desde, hasta],
      );
      const n = int(rows[0]?.n);
      salida.documentos = n;
      salida.monto_acreditado = n > 0 ? num(rows[0]?.monto) : null;

      if (n === 0) {
        salida.estado = 'sin_acreditacion';
        salida.nota =
          `No hay notas de crédito ni devoluciones de "${ag.proveedor}" dentro de la vigencia. ` +
          (salida.metodo === 'nombre_exacto'
            ? 'La liga fue por nombre exacto: si el ERP lo escribe distinto, el cruce no lo ve.'
            : 'La liga fue por código de proveedor.');
      } else if (salida.monto_negociado === null) {
        salida.estado = 'sin_monto';
        salida.nota =
          'El acuerdo no pactó monto en efectivo, así que no hay contra qué comparar lo acreditado.';
      } else {
        salida.estado = 'conciliado';
        salida.nota =
          salida.metodo === 'nombre_exacto'
            ? 'Liga por NOMBRE EXACTO (heurística): el acuerdo no tiene proveedor del catálogo.'
            : 'Liga por código de proveedor del catálogo.';
      }
      return salida;
    });
  }
}
