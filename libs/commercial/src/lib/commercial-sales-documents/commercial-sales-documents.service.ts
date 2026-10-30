import { Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService, applySmartSearch } from '@megadulces/platform-core';

/**
 * AX.1 — Facturación de Telemarketing (`U/D/8`; la ruta y el módulo conservan el nombre
 * genérico "sales-documents" porque renombrarlos movería la URL y el permiso).
 *
 * Lee las VISTAS EN VIVO `analytics.erp_sales_invoices` / `_lines` (mig 20260822140000),
 * derivadas de `kepler_ods` por el CDC → frescura de segundos, sin feed ni tabla copiada.
 * No hay estado propio que guardar: este service es 100% lectura.
 *
 * `analytics.*` no tiene RLS → filtro `tenant_id` EXPLÍCITO, todo dentro de `tk.run()`.
 */

/**
 * Fila de `analytics.erp_sales_invoices` tal como la consume la **Guía de Cobranza** — son
 * exactamente las columnas que `paraGuia()` selecciona, ni una más. Se declara acá (y no un
 * `any`) para que el servicio que imprime el papel no adivine qué campos existen: si mañana
 * se quita una columna del SELECT, lo que revienta es la compilación y no la guía impresa.
 */
/**
 * Lo que devuelve `detail()`: la fila completa de la vista (≈40 columnas, se consumen por
 * nombre en el anexo) más los derivados que calcula este service. El index signature dice la
 * verdad —la vista trae más de lo que este lib declara— sin que eso valga por `any`: los
 * campos que el anexo y la pantalla usan están tipados.
 */
export interface SalesDocDetalle extends FacturaGuiaRow {
  /** true si la factura no trae renglones de producto (sólo servicio) */
  sin_detalle: boolean;
  /** true si el ODS no tiene NINGÚN renglón del documento: hueco de replicación */
  detalle_ausente: boolean;
  lineas: Record<string, unknown>[];
  importe_bruto: number;
  descuento_aplicado: number;
  descuento_pct_efectivo: number;
  detalle_explica_total: boolean;
  embarque: EmbarqueDeFactura;
  [columna: string]: unknown;
}

/**
 * `[AX.17]` El embarque `U-D-41` del que salió la factura (cadena Kepler: Pedido `U-D-40` →
 * Embarque `U-D-41` → Factura `U-D-8`). La liga es el back-pointer de la propia factura
 * (`kdm1.c37/c38/c39`, que la vista expone como `doc_origen`) **más la sucursal**: el folio es
 * por sucursal, y sin ella 2,203 de 2,943 facturas casaban con más de un embarque.
 *
 * Medido en prod (2026-10-29, todo el universo): 5,927 de 5,929 facturas TM resuelven a
 * exactamente UN embarque; 2 no traen back-pointer. Control negativo: con el folio corrido +1
 * el cliente coincide en 29.5 % y el importe (±$1) en 2.2 %; con el par verdadero, 99.9 % y 87.3 %.
 * Lo que no resuelve se DECLARA por `status` — nunca se dibuja como un embarque vacío.
 */
export type EmbarqueDeFactura =
  | { status: 'sin_backpointer'; origen: string | null }
  | { status: 'no_en_ods'; origen: string }
  | {
      status: 'resuelto';
      origen: string;
      folio_digital: string;
      fecha: string | Date | null;
      /** Guía de embarque (`c86`): EL VIAJE. Un viaje lleva varias paradas (embarques). */
      guia: string | null;
      transporte: string | null;
      placas: string | null;
      /** 'exacto' | 'normalizado' | 'sin_resolver' — cómo se resolvió la clave de la unidad. */
      transporte_metodo: string | null;
      chofer: string | null;
      /** Kepler no trae chofer capturado en el embarque (62.9 % de los de TM, medido). */
      chofer_sin_capturar: boolean;
      /** Chofer ASIGNADO a la unidad en el catálogo: no prueba que haya manejado este viaje. */
      chofer_asignado: string | null;
      /** `numeric` de Postgres: llega como string. */
      total: string | null;
      /**
       * Σ facturas vivas del embarque − embarque, en pesos. Hasta $1 es redondeo (87.3 % de los
       * pares caen ahí). Se compara la SUMA y no esta factura sola: con dos facturas por embarque
       * (5 casos), la segunda salía «$32,803 menos que su embarque», que es falso.
       */
      diferencia: number | null;
      /** Σ de `facturas` (string con centavos exactos). */
      total_facturas: string;
      /** El embarque está a nombre de otro cliente que la factura (3 casos medidos). */
      cliente_distinto: boolean;
      /** A quién va el embarque (`destino_nombre`): la pantalla lo nombra sólo si `cliente_distinto`. */
      destino: string | null;
      /** Facturas VIVAS que apuntan a este embarque —ésta incluida si no está cancelada—. 5 embarques tienen 2. */
      facturas: string[];
    };

export interface FacturaGuiaRow {
  folio_digital: string;
  sucursal: string;
  doc_prefix: string;
  folio: string;
  doc_label: string | null;
  fecha: string | Date | null;
  vencimiento: string | Date | null;
  dias_credito: number | null;
  vencimiento_source: string | null;
  cliente_code: string | null;
  cliente_nombre: string | null;
  cliente_rfc: string | null;
  cliente_domicilio: string | null;
  cliente_colonia: string | null;
  cliente_estado: string | null;
  cliente_cp: string | null;
  vendedor_code: string | null;
  vendedor_nombre: string | null;
  /** `numeric` de Postgres: llega como string. No se convierte acá para no perder centavos. */
  total: string | null;
  descuento_efectivo: string | null;
  saldo: string | null;
  cobrado: string | null;
  estatus_cobro: string | null;
  doc_estatus: string | null;
  doc_estatus_label: string | null;
  cancelada: boolean;
}

/**
 * `[AX.18]` Un embarque de telemarketing (`U-D-41` serie 1) que salió y no tiene factura viva.
 * Sale de `analytics.erp_shipment_billing` — la MISMA vista y el mismo diagnóstico que usa el
 * detector `cxc_embarcado_sin_facturar` de Finanzas, para que las dos pantallas digan lo mismo.
 */
export interface EmbarqueSinFactura {
  folio_digital: string;
  sucursal: string;
  folio: string;
  fecha: string;
  cliente_code: string | null;
  cliente_nombre: string | null;
  /** `numeric` de Postgres: llega como string. */
  total_embarcado: string;
  /**
   * `sin_factura` = nunca se emitió una · `facturas_en_cero` = se emitieron y todas quedaron en
   * $0 (medido 2026-10-29: 17 de 17 de esas facturas están canceladas en Kepler).
   */
  situacion: 'sin_factura' | 'facturas_en_cero';
  /** Folios de las facturas en $0 (vacío si nunca se facturó). */
  facturas: string[];
}
export interface EmbarquesSinFacturaReport {
  /** Ventana en días: la misma que el detector de Finanzas (365). */
  dias: number;
  embarques: EmbarqueSinFactura[];
  /** Σ `total_embarcado`, string con centavos exactos. */
  total: string;
}
/** La ventana del detector de Finanzas (`DIAS_EMBARQUE`): no resucitar embarques viejos ya conciliados. */
const DIAS_SIN_FACTURA = 365;

/** Identidad fiscal del emisor, leída de `fiscal.issuer_config` (ver `emisorFiscal()`). */
export interface EmisorFiscal {
  rfc: string;
  nombre: string;
  regimen_code: string;
  cp: string;
}
const EMISOR_CACHE = new Map<string, EmisorFiscal>();

// AX 2026-08-25: /comercial/documentos = SOLO telemarketing (se sacó la venta a crédito, U/D/12).
const DOC_TIPOS = ['telemarketing'] as const;
/*
 * `[AX.12]` 200 → 500. No es generosidad: **medido**, `pageSize` 50 y 200 tardan lo mismo
 * (~810 ms) porque el costo es armar la selección de la vista, no devolver las filas. El tope
 * existe para que nadie pida 50,000 renglones al navegador, no para cuidar la base.
 */
const MAX_PAGE = 500;
/** `[AX.12]` Lo que pide la pantalla si no dice nada. 100 cabe en una pantalla con scroll. */
const DEFAULT_PAGE = 100;

/**
 * GT.13 — órdenes que la pantalla ofrece. Lista blanca a propósito: el `sort` viaja por query
 * y armar el ORDER BY con lo que llegue es una inyección. El desempate siempre es `folio`,
 * para que dos facturas del mismo día (o del mismo importe) no se intercambien entre páginas.
 */
const ORDENES: Record<string, { column: string; order: 'asc' | 'desc'; nulls?: 'first' | 'last' }[]> = {
  fecha_desc: [{ column: 'fecha', order: 'desc' }, { column: 'folio', order: 'desc' }],
  fecha_asc: [{ column: 'fecha', order: 'asc' }, { column: 'folio', order: 'asc' }],
  total_desc: [{ column: 'total', order: 'desc' }, { column: 'folio', order: 'desc' }],
  total_asc: [{ column: 'total', order: 'asc' }, { column: 'folio', order: 'asc' }],
  // El saldo es NULL en las que no están en la cartera: van al final en los dos sentidos, que
  // es donde estorban menos — no son un "cero", son un desconocido (ADR-056).
  saldo_desc: [{ column: 'saldo', order: 'desc', nulls: 'last' }, { column: 'folio', order: 'desc' }],
  saldo_asc: [{ column: 'saldo', order: 'asc', nulls: 'last' }, { column: 'folio', order: 'asc' }],
};

export interface SalesDocsQuery {
  from?: string;
  to?: string;
  /**
   * Sucursales que este usuario puede ver, **ya recortadas** por `ScopeService.readParam()`
   * en el controller (llave canónica = código de 2 dígitos = `erp_sales_invoices.sucursal`).
   * `null` = sin filtro (alcance `all` y nada pedido) · `[]` = no alcanza ninguna.
   * NO es lo que pidió el cliente: lo que pide de más se recorta antes de llegar acá.
   */
  warehouse_codes?: string[] | null;
  warehouse_ids?: string;  // CSV de uuid (legacy; hoy lo resuelve readParam)
  doc_tipo?: string;       // telemarketing | credito
  cliente_code?: string;
  vendedor_code?: string;
  search?: string;         // cliente / RFC / folio / monto
  vencidas?: string;       // 'true' → sólo las vencidas QUE AÚN DEBEN (ver base())
  canceladas?: string;     // 'true' → incluir las canceladas en Kepler (por defecto NO)
  /**
   * Estado de cobranza. Acepta **uno o varios** separados por coma (`?cobro=pendiente,parcial`):
   * la pantalla arma la guia con lo que todavia se debe, y eso son DOS estados, no uno.
   * Un valor fuera de la lista no se ignora: filtra y devuelve cero filas (un estado inventado
   * no debe leerse como "sin filtro" y mostrar todo).
   */
  cobro?: string;          // pagada | parcial | pendiente | sin_cartera (CSV)
  /** Orden de la tabla. Lista blanca — ver ORDENES. Default: lo más reciente primero. */
  sort?: string;
  min?: string;            // importe mínimo
  page?: number;
  pageSize?: number;
}

@Injectable()
export class CommercialSalesDocumentsService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /** Ventana por defecto: últimos 30 días (la pantalla arranca acotada, no con todo). */
  private range(q: SalesDocsQuery) {
    const to = q.to || new Date().toISOString().slice(0, 10);
    const from = q.from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    return { from, to };
  }

  /** '06UD0801-0000087' → {sucursal:'06', docPrefix:'UD0801', folio:'0000087'}; null si no calza. */
  private partes(folioDigital: string): { sucursal: string; docPrefix: string; folio: string } | null {
    const m = /^(\d{2})(UD\d{4})-(.+)$/.exec(String(folioDigital || '').trim());
    return m ? { sucursal: m[1], docPrefix: m[2], folio: m[3] } : null;
  }

  /** WHERE base compartido por list() y kpis() — si divergen, los KPIs mienten sobre la tabla. */
  private base(trx: any, tenantId: string, q: SalesDocsQuery) {
    const { from, to } = this.range(q);
    const b = trx('analytics.erp_sales_invoices as i')
      .where('i.tenant_id', tenantId)
      .andWhere('i.fecha', '>=', from)
      .andWhere('i.fecha', '<=', to);

    // Las canceladas (kdm1.c43='C') son 280 documentos en $0 que no son ventas: fuera del
    // listado y de los KPIs salvo que se pidan explícitamente.
    if (q.canceladas !== 'true') b.andWhere('i.cancelada', false);

    // Alcance de sucursal. `[]` ⇒ knex emite `1 = 0`: un usuario sin sucursal alcanzable ve
    // cero filas, que es lo correcto — nunca "todas" por ausencia de filtro.
    if (q.warehouse_codes) b.whereIn('i.sucursal', q.warehouse_codes);
    // AX 2026-08-25 (Edgar): /comercial/documentos = SOLO facturas de telemarketing.
    // Se saca la venta a crédito (U/D/12). Filtro en el service (no en la vista compartida).
    b.andWhere('i.doc_tipo', 'telemarketing');
    if (q.cliente_code) b.andWhere('i.cliente_code', q.cliente_code.trim());
    if (q.vendedor_code) b.andWhere('i.vendedor_code', q.vendedor_code.trim());
    if (q.min && Number.isFinite(Number(q.min))) b.andWhere('i.total', '>=', Number(q.min));
    // "Vencida" = pasó la fecha **y sigue debiendo**. Antes era sólo lo primero, y de las 355
    // que marcaba en 30d, 91 ($567,504) ya estaban liquidadas en la cartera. El saldo lo manda
    // `kdue` (vía `estatus_cobro` de la vista), no la cabecera de Kepler — ver mig 20260905150100.
    if (q.vencidas === 'true') {
      b.andWhere('i.vencimiento', '<', trx.raw('current_date'))
        .whereIn('i.estatus_cobro', ['pendiente', 'parcial']);
    }
    // CSV: `whereIn` con un solo valor emite el mismo plan que `=`, asi que no hay dos caminos.
    const cobros = String(q.cobro ?? '').split(',').map((c) => c.trim()).filter(Boolean);
    if (cobros.length) b.whereIn('i.estatus_cobro', [...new Set(cobros)]);

    applySmartSearch(b, q.search, {
      // `[AX.17]` `doc_origen`: se encuentra la factura tecleando el folio de su embarque.
      columns: ['i.cliente_nombre', 'i.cliente_code', 'i.cliente_rfc', 'i.folio', 'i.folio_digital', 'i.vendedor_nombre', 'i.doc_origen'],
      numeric: ['i.total'],
    });
    return b;
  }

  /**
   * Listado paginado + KPIs de la MISMA selección.
   *
   * ⚠️ La página va envuelta en un CTE **MATERIALIZED** y se ordena y recorta AFUERA. No es
   * cosmético: medido en prod, `ORDER BY … LIMIT 50` directo sobre la vista costaba **23,856 ms**
   * y así cuesta **970 ms** — 24× — y se mantiene en 959 ms en la última página.
   * El motivo es el `LIMIT`: invita al planner a un nested loop que **re-escanea el CTE `src` de
   * la cartera (14,623 filas, en disco) una vez por fila devuelta** (`loops=50` en el EXPLAIN).
   * Con la selección materializada primero, elige hash join —igual que en `kpis()`, que por ser
   * agregado nunca tuvo el problema (791 ms)— y luego ordena 738 filas ya resueltas.
   * Si alguien "simplifica" esto quitando el CTE, la pantalla vuelve a tardar 24 segundos.
   *
   * `[AX.12]` La página y los KPIs salen ahora de **una sola** referencia a ese CTE: ver el
   * comentario del cuerpo. Y el tope de página subió a 500 porque **medido, no cuesta nada**:
   * `pageSize` 50 y 200 tardan lo mismo (~810 ms), el costo es armar la selección, no devolver
   * las filas.
   */
  async list(q: SalesDocsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(MAX_PAGE, Math.max(1, Number(q.pageSize) || DEFAULT_PAGE));

    return this.tk.run(async (trx) => {
      const seleccion = this.base(trx, tenantId, q)
        .select(
          'i.folio_digital', 'i.sucursal', 'i.warehouse_id', 'i.doc_prefix', 'i.doc_tipo', 'i.doc_label',
          'i.folio', 'i.fecha', 'i.vencimiento', 'i.dias_credito', 'i.limite_credito',
          'i.cliente_code', 'i.cliente_nombre', 'i.cliente_rfc',
          'i.vendedor_code', 'i.vendedor_nombre', 'i.canal', 'i.referencia',
          'i.total', 'i.ieps', 'i.descuento', 'i.descuento_pct', 'i.subtotal',
          'i.doc_estatus', 'i.doc_estatus_label', 'i.cancelada',
          'i.importe_bruto', 'i.descuento_efectivo',
          'i.saldo', 'i.cobrado', 'i.estatus_cobro', 'i.dias_pago',
          'i.vencimiento_erp', 'i.vencimiento_source',
          // `[AX.17]` El folio del embarque que la originó (back-pointer de Kepler). Va sin JOIN a
          // propósito: medido, cruzar la página con `erp_shipment_headers` cuesta ~1 s por 100
          // filas (la vista resuelve unidad y chofer por fila). El detalle trae el resto.
          'i.doc_origen',
          // Vencida = venció Y debe. Sin saldo, la fecha ya no significa nada.
          trx.raw(`(i.vencimiento < current_date
                    AND i.estatus_cobro IN ('pendiente','parcial')) AS vencida`),
          trx.raw('(current_date - i.vencimiento) AS dias_vencida'),
        );

      /*
       * `[AX.12]` — **Una sola pasada por la vista, no dos.**
       *
       * Antes esto eran dos consultas en `Promise.all`… dentro del MISMO `tk.run(trx)`. Una
       * transacción tiene UNA conexión, así que el `Promise.all` **no paralelizaba nada**: se
       * ejecutaban en fila. Medido contra prod (EXPLAIN ANALYZE, mínimo de 3 corridas):
       * lista **765 ms** + KPIs **906 ms** = **1,671 ms** por cada carga y por cada cambio de
       * página.
       *
       * Un CTE `MATERIALIZED` se calcula **una vez** aunque se lo referencie varias veces. Así
       * que la misma selección alimenta los agregados y la página: **740 ms, 56% menos**, con los
       * KPIs **idénticos al centavo** (verificado campo por campo contra la formulación vieja).
       *
       * ⚠️ `LEFT JOIN LATERAL … ON true` y no `CROSS JOIN`: con un `offset` más allá del final la
       * página viene vacía, y un `CROSS JOIN` devolvería **cero filas** — o sea que también se
       * perderían los KPIs, y la pantalla diría "0 documentos" sobre una selección que sí tiene.
       *
       * ⚠️ Los KPIs viajan con prefijo `k_` porque `saldo` y `descuento` existen **de los dos
       * lados**: sin el prefijo, `select k.*, p.*` los pisa y el KPI se convierte en el valor de
       * la última fila de la página. Ninguna columna del renglón empieza con `k_`.
       *
       * ⛔ El CTE materializado NO es cosmético (ver el comentario de arriba): si alguien lo
       * quita, la pantalla vuelve a tardar 24 segundos.
       */
      const orden = ORDENES[String(q.sort || '')] ?? ORDENES['fecha_desc'];
      // Lista blanca: `column` sale de ORDENES y `order`/`nulls` son uniones cerradas.
      const ordenSql = orden
        .map((o) => `"${o.column}" ${o.order === 'asc' ? 'asc' : 'desc'}` +
          (o.nulls ? ` nulls ${o.nulls === 'first' ? 'first' : 'last'}` : ''))
        .join(', ');

      const filas: any[] = await trx
        .withMaterialized('sel', seleccion)
        .select('k.*', 'p.*')
        .from(
          trx.select(
            trx.raw('count(*)::int AS k_documentos'),
            trx.raw('count(DISTINCT cliente_code)::int AS k_clientes'),
            trx.raw('coalesce(sum(total),0)::numeric AS k_importe'),
            // `descuento` (c13) NO es lo que se descontó: Σrenglones − c13 == total sólo en
            // 985 de 1,268. El efectivo se despeja del % y cuadra 3,264/3,264.
            trx.raw('coalesce(sum(descuento_efectivo),0)::numeric AS k_descuento'),
            // Cobranza: vencido = venció Y debe. El resto se declara en vez de esconderse.
            trx.raw(`count(*) FILTER (WHERE vencimiento < current_date
                     AND estatus_cobro IN ('pendiente','parcial'))::int AS k_vencidas`),
            trx.raw(`coalesce(sum(saldo) FILTER (WHERE vencimiento < current_date
                     AND estatus_cobro IN ('pendiente','parcial')),0)::numeric AS k_saldo_vencido`),
            trx.raw('coalesce(sum(saldo),0)::numeric AS k_saldo'),
            trx.raw(`count(*) FILTER (WHERE estatus_cobro='pagada')::int AS k_pagadas`),
            trx.raw(`count(*) FILTER (WHERE estatus_cobro='sin_cartera')::int AS k_sin_cartera`),
            // Cuántas fechas de vencimiento son el hecho del ERP y cuántas una reconstrucción.
            trx.raw(`count(*) FILTER (WHERE vencimiento_source='erp')::int AS k_venc_erp`),
          ).from('sel').as('k'),
        )
        .joinRaw(
          `LEFT JOIN LATERAL (SELECT * FROM "sel" ORDER BY ${ordenSql} LIMIT ? OFFSET ?) p ON true`,
          [pageSize, (page - 1) * pageSize],
        );

      const primera = filas[0] ?? {};
      const kpis = {
        documentos: primera.k_documentos ?? 0,
        clientes: primera.k_clientes ?? 0,
        importe: primera.k_importe ?? '0',
        descuento: primera.k_descuento ?? '0',
        vencidas: primera.k_vencidas ?? 0,
        saldo_vencido: primera.k_saldo_vencido ?? '0',
        saldo: primera.k_saldo ?? '0',
        pagadas: primera.k_pagadas ?? 0,
        sin_cartera: primera.k_sin_cartera ?? 0,
        venc_erp: primera.k_venc_erp ?? 0,
      };
      // La fila del `LEFT JOIN` sin página trae `folio_digital` NULL: son los KPIs solos.
      const rows = filas
        .filter((f) => f.folio_digital != null)
        .map((f) => {
          const row: any = {};
          for (const col of Object.keys(f)) if (!col.startsWith('k_')) row[col] = f[col];
          return row;
        });
      // Una pantalla en blanco con todo en $0 se lee como "se rompió". Cuando la ventana no
      // trae nada, se dice CUÁNDO fue la última factura del canal para que el rango se pueda
      // corregir sin adivinar. Sólo se paga en el camino vacío: medido, este max() cuesta
      // ~1 s sobre la vista en vivo y no tiene por qué pagarlo la consulta que sí trajo filas.
      const ultima = kpis?.documentos ? null : await this.ultimaFactura(trx, tenantId, q);
      return { rows, kpis, page, pageSize, range: this.range(q), ultima_factura: ultima };
    });
  }

  /**
   * Fecha de la última factura del canal, IGNORANDO el rango consultado (el resto de los
   * filtros sí se respetan: si el vacío lo causó el vendedor o el estado de cobro, la fecha
   * que se muestra tiene que ser la de ESA selección, no la del canal entero).
   */
  private async ultimaFactura(trx: Knex.Transaction, tenantId: string, q: SalesDocsQuery): Promise<string | null> {
    const sinRango: SalesDocsQuery = { ...q, from: '1900-01-01', to: '2999-12-31' };
    const row = await this.base(trx, tenantId, sinRango).max('i.fecha as ultima').first();
    const v = row?.ultima;
    if (!v) return null;
    return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  }

  /**
   * Identidad fiscal del EMISOR, de `fiscal.issuer_config` — la fuente que ya existe (Fase FE).
   *
   * AX.10: el anexo la traía **hardcodeada y equivocada**. Imprimía `LOGL8810144QS` y
   * `C.P. 59701, Michoacán`; lo correcto es **`LOGL851014AQ5`** y **C.P. 36910**, confirmado
   * por tres fuentes independientes: esta tabla, los **167,503 CFDIs recibidos** de
   * `fiscal.cfdis` (todos con `receptor_rfc = 'LOGL851014AQ5'` desde 2018 — el receptor de una
   * factura recibida somos nosotros) y 11 fichas internas de `kepler_ods.kdud`. El CP viejo
   * además se contradecía con el propio pagaré del mismo documento, que dice C.P. 36910.
   *
   * Si no hay fila configurada **se niega a imprimir**: un RFC inventado en un pagaré es peor
   * que no emitirlo. Cache en proceso (una fila que cambia cada varios años).
   */
  async emisorFiscal(): Promise<EmisorFiscal> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hit = EMISOR_CACHE.get(tenantId);
    if (hit) return hit;
    const row = await this.tk.run(async (trx) =>
      trx('fiscal.issuer_config')
        .where({ tenant_id: tenantId, active: true })
        .orderBy('is_default', 'desc')
        .first('rfc', 'tax_name', 'regimen_fiscal', 'cp'));
    if (!row?.rfc || !row?.tax_name) {
      throw new NotFoundException(
        'No hay identidad fiscal configurada (fiscal.issuer_config): el anexo y el pagaré no se '
        + 'emiten sin RFC y razón social verificados.');
    }
    const emisor: EmisorFiscal = {
      rfc: String(row.rfc).trim().toUpperCase(),
      nombre: String(row.tax_name).trim(),
      regimen_code: String(row.regimen_fiscal ?? '').trim(),
      cp: String(row.cp ?? '').trim(),
    };
    EMISOR_CACHE.set(tenantId, emisor);
    return emisor;
  }

  /**
   * GT.1 — las facturas SELECCIONADAS a mano en /comercial/documentos/reportes, para la Guía
   * de Cobranza. No es un filtro más: la selección es un acto humano (el cobrador sale con
   * ESAS y no con las que caigan en un rango), así que se piden por folio explícito.
   *
   * Devuelve también las `faltantes`: un folio que se pidió y no volvió no se descarta en
   * silencio —la guía imprimiría de menos y nadie lo notaría hasta la ruta—, lo reporta el
   * service que arma el PDF.
   *
   * Mismo truco de rendimiento que `detail()`: se filtra por (sucursal, doc_prefix, folio),
   * nunca por `folio_digital`, que es una expresión compuesta de la vista y no usa índice.
   */
  async paraGuia(
    folioDigitales: string[],
    q?: Pick<SalesDocsQuery, 'warehouse_codes'>,
  ): Promise<{ rows: FacturaGuiaRow[]; faltantes: string[] }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const pedidos = [...new Set((folioDigitales || []).map((f) => String(f || '').trim()).filter(Boolean))];
    if (!pedidos.length) return { rows: [], faltantes: [] };

    const tuplas: string[][] = [];
    const invalidos: string[] = [];
    for (const f of pedidos) {
      const p = this.partes(f);
      if (p) tuplas.push([p.sucursal, p.docPrefix, p.folio]);
      else invalidos.push(f);
    }
    if (!tuplas.length) return { rows: [], faltantes: invalidos };

    return this.tk.run(async (trx) => {
      const q0 = trx('analytics.erp_sales_invoices')
        .where('tenant_id', tenantId)
        .whereIn(['sucursal', 'doc_prefix', 'folio'], tuplas);
      // Fuera de alcance no vuelve, y por lo tanto cae en `faltantes`: la guía se niega a
      // imprimir y dice cuáles. Mejor que imprimir de menos en silencio.
      if (q?.warehouse_codes) q0.whereIn('sucursal', q.warehouse_codes);
      const rows = await q0
        .select(
          'folio_digital', 'sucursal', 'doc_prefix', 'folio', 'doc_label',
          'fecha', 'vencimiento', 'dias_credito', 'vencimiento_source',
          'cliente_code', 'cliente_nombre', 'cliente_rfc',
          'cliente_domicilio', 'cliente_colonia', 'cliente_estado', 'cliente_cp',
          'vendedor_code', 'vendedor_nombre',
          'total', 'descuento_efectivo', 'saldo', 'cobrado', 'estatus_cobro',
          'doc_estatus', 'doc_estatus_label', 'cancelada',
        )
        .orderBy([
          { column: 'cliente_nombre', order: 'asc' },
          { column: 'fecha', order: 'asc' },
          { column: 'folio', order: 'asc' },
        ]);
      const vistos = new Set(rows.map((r) => String(r.folio_digital)));
      return { rows, faltantes: [...invalidos, ...pedidos.filter((f) => !vistos.has(f))] };
    });
  }

  /**
   * Documento completo (cabecera + renglones) — lo que consume el anexo imprimible.
   *
   * OJO con el filtro: `folio_digital` es una expresión compuesta dentro de la vista
   * (`sucursal || doc_prefix || '-' || folio`) y el planner NO la puede empujar al índice →
   * medido en prod, filtrar por él costaba **3,031 ms**; por (sucursal, doc_prefix, folio),
   * **162 ms**. Se descompone acá y se filtra por las columnas simples.
   */
  async detail(folioDigital: string, q?: Pick<SalesDocsQuery, 'warehouse_codes'>): Promise<SalesDocDetalle> {
    const tenantId = this.tenantCtx.requireTenantId();
    const p = this.partes(folioDigital);
    return this.tk.run(async (trx) => {
      const donde = p
        ? { tenant_id: tenantId, sucursal: p.sucursal, doc_prefix: p.docPrefix, folio: p.folio }
        : { tenant_id: tenantId, folio_digital: folioDigital }; // formato inesperado: lento pero correcto

      const doc = await trx('analytics.erp_sales_invoices').where(donde).first();
      if (!doc) throw new NotFoundException(`Documento ${folioDigital} no encontrado`);
      // Fuera de tu alcance = no existe. Un 403 confirmaría que el folio SÍ existe en otra
      // sucursal; y sin esta guarda el recorte de la tabla sería cosmético: bastaba un
      // deep-link `?doc=` para leer (e imprimir) la factura de cualquier sucursal.
      if (q?.warehouse_codes && !q.warehouse_codes.includes(String(doc.sucursal))) {
        throw new NotFoundException(`Documento ${folioDigital} no encontrado`);
      }

      const lineas = await trx('analytics.erp_sales_invoice_lines')
        .where(donde)
        .select('linea', 'sku', 'descripcion', 'unidad', 'cantidad', 'precio_unitario',
                'importe', 'factor_caja', 'unidad_venta', 'unidad_bulto', 'unidad_paq', 'factor_paq', 'product_id',
                'box_factor', 'box_factor_source', 'box_factor_dudoso')
        .orderBy('linea');

      // derivar() devuelve `lineas` ya enriquecidas (descuento/neto/precios por unidad) → esas mandan.
      // `sin_detalle`: 95 facturas traen un único renglón de SERVICIO y quedan sin producto;
      // la pantalla no debe ofrecer el anexo ahí (el PDF también lo rechaza).
      //
      // ⚠️ "cero renglones" tiene DOS causas y hasta 2026-08-31 la pantalla afirmaba la primera para
      // ambas ("su único renglón es de servicio"). El 06UD0801-0000265 la delató: tiene 3 renglones
      // reales por $4,518.00 —el total exacto de la cabecera— que nunca llegaron al ODS. Un hueco de
      // datos disfrazado de hecho de negocio es peor que un error visible: nadie lo va a reportar.
      // Se distinguen preguntándole al ODS crudo si el documento tiene renglones ANTES de los filtros
      // de la vista (SER / cantidad 0). Sólo se paga cuando ya hay 0 renglones — el camino raro.
      const sinRenglones = lineas.length === 0;
      const detalleAusente = sinRenglones ? await this.detalleAusente(trx, p) : false;
      const embarque = await this.embarqueDe(trx, tenantId, doc);
      return {
        ...doc,
        sin_detalle: sinRenglones && !detalleAusente,
        detalle_ausente: detalleAusente,
        ...this.derivar(doc, lineas),
        embarque,
      };
    });
  }

  /**
   * `[AX.18]` Los embarques de telemarketing que salieron y no tienen factura viva.
   *
   * Medido en prod (2026-10-29, 365 días): 23 embarques por $162,863 — 8 nunca facturados y 15
   * con todas sus facturas en $0 (uno con 16). Cruce contra la otra implementación (el
   * back-pointer de `erp_sales_invoices`): la vista y las facturas vivas no se contradicen.
   *
   * ⛔ Depende de la vista de `20261029175926_erp_shipment_billing_ventana`: con la definición
   * anterior esta consulta pasaba de 60 s. El `statement_timeout` local es la red: si la
   * migración no está aplicada, el endpoint falla en 5 s y la pantalla lo declara, en vez de
   * colgar una conexión del pool.
   *
   * Sin `NOT cuenta_interna` a secas: con el cliente vacío esa expresión es NULL y el embarque
   * desaparecería sin decirlo. `IS NOT TRUE` lo conserva (hoy da lo mismo: 23 y 23).
   */
  async embarquesSinFactura(q: Pick<SalesDocsQuery, 'warehouse_codes'>): Promise<EmbarquesSinFacturaReport> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx) => {
      await trx.raw(`SET LOCAL statement_timeout = '5s'`);
      const b = trx('analytics.erp_shipment_billing as b')
        .where('b.tenant_id', tenantId)
        .andWhere('b.serie', 1)
        .whereRaw('b.cuenta_interna IS NOT TRUE')
        .andWhere('b.total_embarcado', '>', 0)
        .whereRaw(`b.fecha >= (now() AT TIME ZONE 'America/Mexico_City')::date - ?::int`, [DIAS_SIN_FACTURA])
        .whereIn('b.diagnostico', ['sin_factura', 'facturado_en_cero']);
      if (q.warehouse_codes) b.whereIn('b.sucursal', q.warehouse_codes);
      const rows: any[] = await b
        .select('b.folio_digital', 'b.sucursal', 'b.folio', trx.raw('b.fecha::text AS fecha'),
          'b.cliente_code', 'b.cliente_nombre', 'b.total_embarcado', 'b.diagnostico', 'b.facturas')
        .orderBy([{ column: 'b.fecha', order: 'desc' }, { column: 'b.folio', order: 'desc' }]);

      const embarques: EmbarqueSinFactura[] = rows.map((r) => ({
        folio_digital: r.folio_digital,
        sucursal: r.sucursal,
        folio: r.folio,
        fecha: r.fecha,
        cliente_code: r.cliente_code ?? null,
        cliente_nombre: r.cliente_nombre ?? null,
        total_embarcado: String(r.total_embarcado),
        situacion: r.diagnostico === 'facturado_en_cero' ? 'facturas_en_cero' : 'sin_factura',
        facturas: Array.isArray(r.facturas) ? r.facturas.map((f: { folio: string }) => f.folio) : [],
      }));
      // En centavos enteros: sumar `numeric` como float acumula error.
      const centavos = embarques.reduce((s, e) => s + Math.round(Number(e.total_embarcado) * 100), 0);
      return { dias: DIAS_SIN_FACTURA, embarques, total: (centavos / 100).toFixed(2) };
    });
  }

  /**
   * `[AX.17]` El embarque de la factura — ver `EmbarqueDeFactura`.
   *
   * ⛔ Por LLAVE CONSTANTE (sucursal, serie, folio), nunca como JOIN ni por `folio_digital`: medido
   * en prod, el JOIN factura⋈embarque de 30 días pasa de 60 s (el planner estima 1 fila y elige
   * nested loop sobre una vista que resuelve unidad y chofer por fila), y por llave cuesta 7–18 ms.
   * Las facturas hermanas, 2–8 ms. ⛔ Las PARADAS del viaje no van: `erp_shipment_trips` por guía
   * midió 30–422 ms (crece con las paradas), y con ella el detalle pasaba de 500 ms por un dato
   * que no decide nada en esta pantalla.
   */
  private async embarqueDe(trx: any, tenantId: string, doc: Record<string, any>): Promise<EmbarqueDeFactura> {
    const origen = doc.doc_origen ? String(doc.doc_origen).trim() : null;
    const m = origen ? /^UD41(\d{2})-(\S+)$/.exec(origen) : null;
    if (!origen || !m) return { status: 'sin_backpointer', origen };
    const sucursal = String(doc.sucursal);

    const h = await trx('analytics.erp_shipment_headers')
      .where({ tenant_id: tenantId, sucursal, serie: Number(m[1]), folio: m[2] })
      .first('folio_digital', 'fecha', 'cliente_code', 'destino_nombre', 'guia_embarque', 'transporte_descripcion',
        'transporte_placas', 'transporte_metodo', 'chofer_nombre', 'chofer_sin_capturar',
        'chofer_asignado_a_la_unidad', 'total');
    if (!h) return { status: 'no_en_ods', origen };

    const hermanas: { folio_digital: string; total: string | null }[] = await trx('analytics.erp_sales_invoices')
      .where({ tenant_id: tenantId, sucursal, doc_origen: origen, cancelada: false })
      .select('folio_digital', 'total')
      .orderBy('folio_digital');

    // En centavos enteros: sumar `numeric` como float acumula error justo donde se mide $1.
    const centavos = (v: unknown) => Math.round(Number(v) * 100);
    const sumaFacturas = hermanas.reduce((s, x) => s + centavos(x.total ?? 0), 0);
    return {
      status: 'resuelto',
      origen,
      folio_digital: h.folio_digital,
      fecha: h.fecha,
      guia: h.guia_embarque ?? null,
      transporte: h.transporte_descripcion ?? null,
      placas: h.transporte_placas ?? null,
      transporte_metodo: h.transporte_metodo ?? null,
      chofer: h.chofer_nombre ?? null,
      chofer_sin_capturar: h.chofer_sin_capturar === true,
      chofer_asignado: h.chofer_asignado_a_la_unidad ?? null,
      total: h.total ?? null,
      diferencia: h.total == null || !hermanas.length ? null : (sumaFacturas - centavos(h.total)) / 100,
      total_facturas: (sumaFacturas / 100).toFixed(2),
      cliente_distinto: !!h.cliente_code && !!doc.cliente_code
        && String(h.cliente_code).trim() !== String(doc.cliente_code).trim(),
      destino: h.destino_nombre ?? null,
      facturas: hermanas.map((x) => x.folio_digital),
    };
  }

  /**
   * ¿El documento no tiene renglones en el ODS, o sí los tiene y la vista los filtró?
   *
   * `true` = el ODS no trae NINGUNA fila de `kdm2` para el documento → es un hueco de replicación
   * (la cabecera llegó, el detalle no), no una factura de servicio. Devuelve `false` ante cualquier
   * duda (folio con formato inesperado, error de lectura): degradar al mensaje viejo es preferible a
   * acusar de hueco un documento legítimo.
   */
  private async detalleAusente(trx: any, p: { sucursal: string; docPrefix: string; folio: string } | null): Promise<boolean> {
    if (!p) return false;
    const c4 = Number(p.docPrefix.slice(2, 4));
    const c5 = Number(p.docPrefix.slice(4, 6));
    if (!Number.isFinite(c4) || !Number.isFinite(c5)) return false;
    try {
      const r = await trx.raw(
        `SELECT count(*)::int AS n FROM kepler_ods.kdm2
          WHERE btrim(sucursal) = ? AND c2::text = 'U' AND c3::text = 'D'
            AND (c4)::int = ? AND (c5)::int = ? AND btrim(c6::text) = ?`,
        [p.sucursal, c4, c5, p.folio]);
      return Number(r?.rows?.[0]?.n ?? 1) === 0;
    } catch {
      return false;
    }
  }

  /**
   * Derivados del anexo. Kepler NO persiste el descuento por renglón, sólo el total del
   * documento, así que la diferencia (bruto − total) se reparte proporcional al importe de
   * cada línea, por MAYOR RESIDUO, para que la columna NETO sume **exacto** el total del CFDI:
   * es lo único que el cliente puede verificar con una calculadora.
   *
   * NO se usa `kdud.c17` como base del reparto (lo hacía antes y fallaba en 593 de 5,128
   * facturas): hay **802 documentos con 0% en el catálogo y descuento real** —hasta $761— y
   * **348 donde el total es MAYOR que la suma de las líneas** (redondeo a favor del cliente),
   * o sea que el objetivo puede ser negativo. El % del catálogo se queda sólo como referencia;
   * la tasa que se muestra es la **efectiva** de este documento.
   */
  private derivar(doc: any, lineas: any[]) {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const importes = lineas.map((l) => Number(l.importe) || 0);
    const bruto = r2(importes.reduce((a, b) => a + b, 0));
    const total = Number(doc.total) || 0;

    // ¿El detalle EXPLICA el total? Medido sobre las 5,128 facturas con renglones: 4,973 tienen
    // hueco ~0, 139 un descuento plausible (≤15%) y 9 un redondeo negativo mínimo. Las 8 que se
    // salen son 2 canceladas y **6 con el detalle incompleto en Kepler** (renglones que arrancan
    // en L7/L3/L5 — falta el principio del documento). Repartir ahí inflaría los pocos productos
    // que sí están (una llegaba a +56%), así que no se reparte nada y el anexo se niega a salir.
    const gapPct = bruto > 0 ? ((bruto - total) / bruto) * 100 : 100;
    const explica = bruto > 0 && Math.abs(gapPct) <= 15;

    const objetivo = explica ? Math.round((bruto - total) * 100) : 0; // centavos, CON signo
    const signo = objetivo < 0 ? -1 : 1;
    const meta = Math.abs(objetivo);
    // Peso = participación de la línea en el importe (si el bruto es 0, reparto parejo).
    const n = importes.length || 1;
    const exacto = bruto > 0
      ? importes.map((v) => (meta * v) / bruto)
      : importes.map(() => meta / n);
    const cents = exacto.map((v) => Math.floor(v));
    // el residuo (< n centavos por construcción) va a las líneas de mayor fracción
    const orden = exacto
      .map((v, i) => ({ i, f: v - Math.floor(v) }))
      .sort((a, b) => b.f - a.f || a.i - b.i);
    let faltan = meta - cents.reduce((a, b) => a + b, 0);
    for (let k = 0; faltan > 0 && orden.length; k++, faltan--) cents[orden[k % orden.length].i] += 1;

    const detalle = lineas.map((l, i) => {
      const d = r2((signo * (cents[i] || 0)) / 100);
      const precio = Number(l.precio_unitario);
      const cant = Number(l.cantidad);
      // Tasa EFECTIVA de esta línea: el precio con descuento tiene que ser consistente con
      // el descuento que realmente se le repartió, no con un % de catálogo que puede ser 0.
      const importe = Number(l.importe) || 0;
      const tasa = importe > 0 ? d / importe : 0;
      // UNIDADES VERBATIM DE KEPLER + RELACIÓN DE EMPAQUE CANÓNICA (2026-08-24).
      //
      // Las etiquetas (unidad de línea `kdm2.c11`, bulto `kdii.c83`) van tal cual de Kepler.
      // El FACTOR, en cambio, sale de `analytics.v_product_box_factor` — el resolvedor único
      // que ya leen compras/sell-out/salidas (override > c84 > etiquetera > factor_sale, con
      // guarda anti-pallet). Leer `c84` crudo acá hacía que 212 líneas contradijeran al resto
      // del sistema (granel con override=1) y que otras 13,935 escondieran la equivalencia.
      //
      // Se imprime sólo si se puede afirmar honestamente:
      //   (a) el canónico da > 1                     — con 1, el humano dijo "no convertir"
      //   (b) el canónico no está marcado dudoso     — `is_master_suspect`: c84 parece pallet
      //   (c) el bulto está capturado y difiere de la unidad de la línea
      //   (d) la línea se vendió EN la unidad del catálogo (si no, el factor no la describe)
      const canon = Number(l.box_factor) || 0;
      const factorAplica = !!(canon > 1 && !l.box_factor_dudoso && l.unidad_bulto
        && l.unidad && l.unidad_venta && String(l.unidad) === String(l.unidad_venta)
        && String(l.unidad_bulto) !== String(l.unidad));
      const factor = factorAplica ? canon : null;
      const cajas = factor && cant / factor >= 1 ? cant / factor : null;
      return {
        ...l,
        descuento: d,
        neto: r2(importe - d),
        precio_con_descuento: r2(precio * (1 - tasa)),
        precio_caja: factor ? r2(precio * factor) : null,
        precio_caja_con_descuento: factor ? r2(precio * factor * (1 - tasa)) : null,
        cajas_equivalentes: cajas,
        // el factor que SE MUESTRA (canónico y validado); null si no aplica a esta línea.
        // `factor_caja` sigue viajando intacto desde la vista = c84 crudo, para trazabilidad.
        factor_bulto: factor,
      };
    });
    return {
      importe_bruto: bruto,
      descuento_aplicado: explica ? r2(bruto - total) : 0,
      // tasa efectiva REAL del documento (la del catálogo miente en 802 facturas)
      descuento_pct_efectivo: explica ? r2(gapPct) : 0,
      /** false ⇒ los renglones no suman el total del CFDI: no hay anexo confiable que emitir */
      detalle_explica_total: explica,
      lineas: detalle,
    };
  }

  /**
   * Catálogos para poblar los filtros de la pantalla (de la misma ventana consultada).
   *
   * ⚠️ Un solo query, con la ventana materializada primero — por la misma razón que `list()`.
   * Medido en prod: el `DISTINCT warehouse_id, sucursal` directo sobre la vista costaba
   * **10,853 ms** (el planner recorría el CTE de la cartera por cada fila del join a
   * `commercial.warehouses`) y así cuesta **430 ms**, los dos catálogos juntos.
   * Se piden en UNA pasada porque el trabajo caro —resolver la ventana— es el mismo para ambos.
   */
  async filtros(q: SalesDocsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    return this.tk.run(async (trx) => {
      const ventana = trx('analytics.erp_sales_invoices')
        .where('tenant_id', tenantId)
        .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
        .andWhere('doc_tipo', 'telemarketing')
        .select('warehouse_id', 'sucursal', 'vendedor_code', 'vendedor_nombre');
      // El MISMO recorte que la tabla. De acá sale el catálogo de vendedores: sin esto, quien
      // sólo alcanza una sucursal vería en el selector al personal de todas las demás.
      if (q.warehouse_codes) ventana.whereIn('sucursal', q.warehouse_codes);

      const r = await trx.withMaterialized('sel', ventana)
        .select(
          trx.raw(`(SELECT coalesce(jsonb_agg(x ORDER BY x->>'vendedor_nombre'), '[]'::jsonb) FROM (
                      SELECT DISTINCT jsonb_build_object(
                        'vendedor_code', vendedor_code, 'vendedor_nombre', vendedor_nombre) AS x
                      FROM sel WHERE vendedor_code IS NOT NULL) v) AS vendedores`),
          trx.raw(`(SELECT coalesce(jsonb_agg(x ORDER BY x->>'sucursal'), '[]'::jsonb) FROM (
                      SELECT DISTINCT jsonb_build_object(
                        'warehouse_id', warehouse_id, 'sucursal', sucursal) AS x
                      FROM sel WHERE warehouse_id IS NOT NULL) s) AS sucursales`),
        ).first();

      return {
        vendedores: r?.vendedores || [],
        sucursales: r?.sucursales || [],
        doc_tipos: DOC_TIPOS,
      };
    });
  }
}
