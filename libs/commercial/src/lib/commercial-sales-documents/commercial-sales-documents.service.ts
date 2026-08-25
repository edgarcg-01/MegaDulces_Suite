import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService, applySmartSearch } from '@megadulces/platform-core';

/**
 * AX.1 — Documentos de venta al cliente (factura telemarketing / venta a crédito).
 *
 * Lee las VISTAS EN VIVO `analytics.erp_sales_invoices` / `_lines` (mig 20260822140000),
 * derivadas de `kepler_ods` por el CDC → frescura de segundos, sin feed ni tabla copiada.
 * No hay estado propio que guardar: este service es 100% lectura.
 *
 * `analytics.*` no tiene RLS → filtro `tenant_id` EXPLÍCITO, todo dentro de `tk.run()`.
 */

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// AX 2026-08-25: /comercial/documentos = SOLO telemarketing (se sacó la venta a crédito, U/D/12).
const DOC_TIPOS = ['telemarketing'] as const;
const MAX_PAGE = 200;

export interface SalesDocsQuery {
  from?: string;
  to?: string;
  warehouse_ids?: string;  // CSV de uuid
  doc_tipo?: string;       // telemarketing | credito
  cliente_code?: string;
  vendedor_code?: string;
  search?: string;         // cliente / RFC / folio / monto
  vencidas?: string;       // 'true' → sólo las que ya vencieron
  canceladas?: string;     // 'true' → incluir las canceladas en Kepler (por defecto NO)
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

  private whIds(q: SalesDocsQuery): string[] {
    return (q.warehouse_ids || '').split(',').map((s) => s.trim()).filter((s) => UUID_RX.test(s));
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

    const whs = this.whIds(q);
    if (whs.length) b.whereIn('i.warehouse_id', whs);
    // AX 2026-08-25 (Edgar): /comercial/documentos = SOLO facturas de telemarketing.
    // Se saca la venta a crédito (U/D/12). Filtro en el service (no en la vista compartida).
    b.andWhere('i.doc_tipo', 'telemarketing');
    if (q.cliente_code) b.andWhere('i.cliente_code', q.cliente_code.trim());
    if (q.vendedor_code) b.andWhere('i.vendedor_code', q.vendedor_code.trim());
    if (q.min && Number.isFinite(Number(q.min))) b.andWhere('i.total', '>=', Number(q.min));
    if (q.vencidas === 'true') b.andWhere('i.vencimiento', '<', trx.raw('current_date'));

    applySmartSearch(b, q.search, {
      columns: ['i.cliente_nombre', 'i.cliente_code', 'i.cliente_rfc', 'i.folio', 'i.folio_digital', 'i.vendedor_nombre'],
      numeric: ['i.total'],
    });
    return b;
  }

  /** Listado paginado + KPIs de la MISMA selección. */
  async list(q: SalesDocsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(MAX_PAGE, Math.max(1, Number(q.pageSize) || 50));

    return this.tk.run(async (trx) => {
      const [rows, kpis] = await Promise.all([
        this.base(trx, tenantId, q)
          .select(
            'i.folio_digital', 'i.sucursal', 'i.warehouse_id', 'i.doc_prefix', 'i.doc_tipo', 'i.doc_label',
            'i.folio', 'i.fecha', 'i.vencimiento', 'i.dias_credito', 'i.limite_credito',
            'i.cliente_code', 'i.cliente_nombre', 'i.cliente_rfc',
            'i.vendedor_code', 'i.vendedor_nombre', 'i.canal', 'i.referencia',
            'i.total', 'i.ieps', 'i.descuento', 'i.descuento_pct', 'i.subtotal',
            'i.doc_estatus', 'i.cancelada',
            trx.raw('(i.vencimiento < current_date) AS vencida'),
            trx.raw('(current_date - i.vencimiento) AS dias_vencida'),
          )
          .orderBy([{ column: 'i.fecha', order: 'desc' }, { column: 'i.folio', order: 'desc' }])
          .limit(pageSize).offset((page - 1) * pageSize),
        this.base(trx, tenantId, q)
          .select(
            trx.raw('count(*)::int AS documentos'),
            trx.raw('count(DISTINCT i.cliente_code)::int AS clientes'),
            trx.raw('coalesce(sum(i.total),0)::numeric AS importe'),
            trx.raw('coalesce(sum(i.descuento),0)::numeric AS descuento'),
            trx.raw('count(*) FILTER (WHERE i.vencimiento < current_date)::int AS vencidas'),
          ).first(),
      ]);
      return { rows, kpis, page, pageSize, range: this.range(q) };
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
  async detail(folioDigital: string) {
    const tenantId = this.tenantCtx.requireTenantId();
    const p = this.partes(folioDigital);
    return this.tk.run(async (trx) => {
      const donde = p
        ? { tenant_id: tenantId, sucursal: p.sucursal, doc_prefix: p.docPrefix, folio: p.folio }
        : { tenant_id: tenantId, folio_digital: folioDigital }; // formato inesperado: lento pero correcto

      const doc = await trx('analytics.erp_sales_invoices').where(donde).first();
      if (!doc) throw new NotFoundException(`Documento ${folioDigital} no encontrado`);

      const lineas = await trx('analytics.erp_sales_invoice_lines')
        .where(donde)
        .select('linea', 'sku', 'descripcion', 'unidad', 'cantidad', 'precio_unitario',
                'importe', 'factor_caja', 'unidad_venta', 'unidad_bulto', 'product_id',
                'box_factor', 'box_factor_source', 'box_factor_dudoso')
        .orderBy('linea');

      // derivar() devuelve `lineas` ya enriquecidas (descuento/neto/precios por unidad) → esas mandan.
      // `sin_detalle`: 95 facturas traen un único renglón de SERVICIO y quedan sin producto;
      // la pantalla no debe ofrecer el anexo ahí (el PDF también lo rechaza).
      return { ...doc, sin_detalle: lineas.length === 0, ...this.derivar(doc, lineas) };
    });
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

  /** Catálogos para poblar los filtros de la pantalla (de la misma ventana consultada). */
  async filtros(q: SalesDocsQuery) {
    const tenantId = this.tenantCtx.requireTenantId();
    const { from, to } = this.range(q);
    return this.tk.run(async (trx) => {
      const [vendedores, sucursales] = await Promise.all([
        trx('analytics.erp_sales_invoices').where('tenant_id', tenantId)
          .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
          .andWhere('doc_tipo', 'telemarketing')
          .whereNotNull('vendedor_code')
          .distinct('vendedor_code', 'vendedor_nombre').orderBy('vendedor_nombre'),
        trx('analytics.erp_sales_invoices').where('tenant_id', tenantId)
          .andWhere('fecha', '>=', from).andWhere('fecha', '<=', to)
          .andWhere('doc_tipo', 'telemarketing')
          .whereNotNull('warehouse_id')
          .distinct('warehouse_id', 'sucursal').orderBy('sucursal'),
      ]);
      return { vendedores, sucursales, doc_tipos: DOC_TIPOS };
    });
  }
}
