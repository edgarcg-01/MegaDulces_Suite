import { Injectable, NotFoundException } from '@nestjs/common';
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
const MAX_PAGE = 200;

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
  cobro?: string;          // pagada | parcial | pendiente | sin_cartera
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
    if (q.cobro) b.andWhere('i.estatus_cobro', q.cobro.trim());

    applySmartSearch(b, q.search, {
      columns: ['i.cliente_nombre', 'i.cliente_code', 'i.cliente_rfc', 'i.folio', 'i.folio_digital', 'i.vendedor_nombre'],
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
   */
  async list(q: SalesDocsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(MAX_PAGE, Math.max(1, Number(q.pageSize) || 50));

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
          // Vencida = venció Y debe. Sin saldo, la fecha ya no significa nada.
          trx.raw(`(i.vencimiento < current_date
                    AND i.estatus_cobro IN ('pendiente','parcial')) AS vencida`),
          trx.raw('(current_date - i.vencimiento) AS dias_vencida'),
        );

      const [rows, kpis] = await Promise.all([
        trx.withMaterialized('sel', seleccion)
          .select('*').from('sel')
          .orderBy([{ column: 'fecha', order: 'desc' }, { column: 'folio', order: 'desc' }])
          .limit(pageSize).offset((page - 1) * pageSize),
        this.base(trx, tenantId, q)
          .select(
            trx.raw('count(*)::int AS documentos'),
            trx.raw('count(DISTINCT i.cliente_code)::int AS clientes'),
            trx.raw('coalesce(sum(i.total),0)::numeric AS importe'),
            // `descuento` (c13) NO es lo que se descontó: Σrenglones − c13 == total sólo en
            // 985 de 1,268. El efectivo se despeja del % y cuadra 3,264/3,264.
            trx.raw('coalesce(sum(i.descuento_efectivo),0)::numeric AS descuento'),
            // Cobranza: vencido = venció Y debe. El resto se declara en vez de esconderse.
            trx.raw(`count(*) FILTER (WHERE i.vencimiento < current_date
                     AND i.estatus_cobro IN ('pendiente','parcial'))::int AS vencidas`),
            trx.raw(`coalesce(sum(i.saldo) FILTER (WHERE i.vencimiento < current_date
                     AND i.estatus_cobro IN ('pendiente','parcial')),0)::numeric AS saldo_vencido`),
            trx.raw('coalesce(sum(i.saldo),0)::numeric AS saldo'),
            trx.raw(`count(*) FILTER (WHERE i.estatus_cobro='pagada')::int AS pagadas`),
            trx.raw(`count(*) FILTER (WHERE i.estatus_cobro='sin_cartera')::int AS sin_cartera`),
            // Cuántas fechas de vencimiento son el hecho del ERP y cuántas una reconstrucción.
            trx.raw(`count(*) FILTER (WHERE i.vencimiento_source='erp')::int AS venc_erp`),
          ).first(),
      ]);
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
  private async ultimaFactura(trx: any, tenantId: string, q: SalesDocsQuery): Promise<string | null> {
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
  ): Promise<{ rows: any[]; faltantes: string[] }> {
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
      const vistos = new Set(rows.map((r: any) => String(r.folio_digital)));
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
  async detail(folioDigital: string, q?: Pick<SalesDocsQuery, 'warehouse_codes'>) {
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
      return {
        ...doc,
        sin_detalle: sinRenglones && !detalleAusente,
        detalle_ausente: detalleAusente,
        ...this.derivar(doc, lineas),
      };
    });
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
