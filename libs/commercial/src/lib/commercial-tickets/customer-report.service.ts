import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase TK.8 — **Reporte por cliente**: se busca un cliente por nombre, se elige, se le abren
 * sus tickets, y RECIÉN AHÍ se filtran.
 *
 * Vive en su propia sección y en su propio servicio: la pantalla de buscar folio no se toca.
 *
 * ── ⚠️ EL HALLAZGO QUE DEFINE LA FORMA ──────────────────────────────────────────────────
 * **El catálogo de clientes está REPLICADO en las nueve sucursales.** Medido en prod: el
 * término "ABARROTES" casa **5,297 filas** del maestro, que son sólo **685 claves** y **571
 * nombres**; y de las 2,395 claves del catálogo, **1,862 existen en LAS NUEVE plazas**.
 *
 * O sea que **la clave de cliente es global**, no por sucursal: lo que cambia entre plazas es
 * dónde compró, no quién es. De ahí la forma de esta pantalla:
 *   1. el buscador agrupa **por clave** (685 resultados, no 5,297),
 *   2. al elegir salen sus documentos de **todas las plazas que alcanza quien pregunta**,
 *   3. y `sucursal` pasa a ser **un filtro más**, junto a fecha, folio, importe y caja.
 *
 * ⚠️ Esto **corrige** el diseño anterior, que trataba al cliente como (sucursal, clave) y
 * listaba nueve veces lo mismo. El riesgo que aquel diseño quería cubrir sigue existiendo y se
 * cubre mejor: cuando una MISMA clave trae nombres distintos según la plaza, el candidato sale
 * marcado (`clave_ambigua`) en vez de partir en nueve la lista de todos los demás.
 *
 * ── ⚠️ LO SEGUNDO, PORQUE DECIDE PARA QUIÉN SIRVE ───────────────────────────────────────
 * **El mostrador es anónimo.** Medido sobre 90 días: de **193,297** tickets de mostrador,
 * **187,530 (97%)** se cobraron a la clave literal `CONTADO`. No son de nadie y no se pueden
 * reportar. El universo real son los **1,065 clientes con nombre** que sí compran a su nombre.
 *
 * ── EL BUSCADOR: POR NOMBRE, IGNORANDO ACENTOS Y ADMITIENDO ERRORES DE DEDO ─────────────
 * Sale del MAESTRO (`v_customer_master`, derivada de `kepler_ods.kdud`), no de los documentos:
 * 301 ms contra 12,203 ms agregando sobre las ventas.
 *
 * ⚠️ **`ILIKE` ignora mayúsculas pero NO acentos.** Medido: `'%MARIA%'` devuelve 869 clientes y
 * `'%MARÍA%'` devuelve **0**. Quien teclea el nombre con acento —o el maestro lo guarda con
 * acento y se teclea sin— no encontraba a nadie. Se normalizan **los dos lados** con
 * `unaccent()`.
 *
 * Y "o parecidos" es literal: además del `ILIKE` va el operador `%` de `pg_trgm`, así que
 * `abarotes` encuentra `ABAROTES DAVID` y `ABARROTES 61`. El orden es por `similarity()`, no
 * alfabético: un tope alfabético sobre 5,297 coincidencias devolvía lo que empezara con A.
 *
 * ⚠️ `pg_trgm` 1.6 y `unaccent` 1.1 ya están instaladas en prod: no hace falta migración.
 *
 * ⚠️ **El recorte por alcance va DENTRO de la consulta, no después del `LIMIT`.** El defecto
 * anterior traía 26 filas alfabéticas y recién entonces filtraba por las plazas del usuario:
 * con las coincidencias repartidas parejo entre nueve sucursales, alguien con acceso a una sola
 * veía tres resultados o ninguno.
 *
 * ── LOS FILTROS, DESPUÉS DE ELEGIR ──────────────────────────────────────────────────────
 *   fecha · folio · importe              baratos
 *   sucursal                             ⚠️ NO es un filtro de este servicio: llega resuelto en
 *                                        `alcance` (ScopeService intersecta lo pedido con lo
 *                                        permitido). La pantalla manda `?warehouse_codes=`.
 *   caja                                 ⚠️ SÓLO existe en mostrador
 *   atendió                              cajero en mostrador, vendedor en facturas
 *   marca                                423 ms/plaza/mes. 100% del catálogo la tiene.
 *   proveedor                            ⚠️ sólo 9,483 de 11,260 productos (84.2%)
 *
 * ⚠️ **Zona NO es filtro de los tickets**: es un atributo del CLIENTE (17,016 de 18,113 lo
 * tienen, 6 zonas). Después de elegir un cliente su zona ya está fija y filtrar por ella no
 * quitaría nada. Viaja en el candidato, para que se vea al elegir.
 *
 * ⚠️ **Marca y proveedor son del PRODUCTO, no del documento.** Se filtra con un `EXISTS` sobre
 * los renglones y **entra el documento COMPLETO**: si sólo entraran sus partidas de esa marca,
 * el total dejaría de ser un cobro que existió y no cuadraría contra ningún ticket en papel.
 *
 * ⚠️ Las **notas de crédito** entran con su importe en NEGATIVO y en su lugar por fecha, para
 * que el total del periodo sea lo que el cliente realmente pagó.
 *
 * ── POR QUÉ ESTO ES VIABLE RECIÉN AHORA ─────────────────────────────────────────────────
 * Hasta TK.7/TK.9 las dos vistas traían un `DISTINCT ON` que no deduplicaba nada y que impedía
 * empujar cualquier filtro que no fuera la identidad del documento: 17,876 ms el mostrador y
 * 9,889 ms las facturas. Hoy son 50 ms y 1,335 ms. Sin eso, esta pantalla no existe.
 */

export type ReporteOrigen = 'mostrador' | 'telemarketing' | 'credito' | 'abono';

const ORIGEN_LABEL: Record<ReporteOrigen, string> = {
  mostrador: 'Mostrador',
  telemarketing: 'Telemarketing',
  credito: 'Crédito',
  abono: 'Nota de crédito',
};

/** Una fila del buscador: UN cliente, no una por plaza. */
export interface ClienteCandidato {
  /** La clave de Kepler. Es global: la misma en las nueve sucursales. */
  cliente_code: string;
  nombre: string | null;
  ciudad: string | null;
  zona: string | null;
  /** En cuántas sucursales existe la clave (de las que alcanza quien pregunta). */
  plazas: number;
  /**
   * ⚠️ true ⇒ esta MISMA clave trae nombres DISTINTOS según la plaza. El reporte junta igual
   * —es lo que se pidió— pero la pantalla lo dice, porque puede estar sumando a dos personas.
   */
  clave_ambigua: boolean;
  /** 1.000 = el nombre es idéntico a lo tecleado. Ordena la lista. */
  score: number;
}

/**
 * [TK.11] Una partida del documento, con las MISMAS cinco columnas de dinero que el ticket en
 * carta: precio original, precio con descuento, descuento por pieza, descuento total y total a
 * pagar. Ni netos ni impuesto por renglon — el papel los saco porque revolvian al cliente.
 */
export interface ReporteLinea {
  linea: number;
  sku: string | null;
  descripcion: string | null;
  unidad: string | null;
  cantidad: number;
  precio_lista: number;
  /** false ⇒ el ERP no guarda con que precio se comparaba. No es «no hubo descuento». */
  lista_conocida: boolean;
  precio_pagado: number;
  descuento_unitario: number;
  descuento_linea: number;
  importe: number;
}

export interface ReporteDocumento {
  id: string;
  origen: ReporteOrigen;
  origen_label: string;
  sucursal: string;
  sucursal_nombre: string | null;
  caja: number | null;
  folio: string;
  fecha: string | null;
  atendio: string | null;
  /**
   * `[TK.d3]` El descuento **de cliente**: el de CABECERA del documento, no la suma de las
   * rebajas por renglón. Son dos capas distintas y una no explica a la otra — medido sobre 609
   * facturas, 435 difieren en más de $1 (`ERP_KEPLER` §3.1). Las rebajas por renglón sólo salen
   * con `detalle: true`, en `lineas[].descuento_linea`.
   *
   * ⚠️ Sale de `descuento_efectivo`, NO de `kdm1.c13`: ese viaja sin impuesto y subdeclara
   * 8.3% (Fase DC, `07 U-D-10 s4 f0000513`: real $147.43 · `c13` $135.26).
   */
  descuento: number;
  /**
   * `[TK.d3]` El porcentaje que Kepler declara en el documento (`kdm1.c19`). Medido en la Fase
   * DC: coincide con `kdud.c17` —el % negociado en el maestro de clientes— en **533 de 578
   * (92.2%)** de las ventas de septiembre 2026.
   *
   * `null` cuando el documento no lo trae — nunca 0: un descuento no declarado no es un
   * descuento de cero (ADR-056).
   */
  descuento_pct: number | null;
  /** NEGATIVO en las notas de crédito: el total del periodo es lo que se pagó de verdad. */
  total: number;
  /**
   * [TK.11] Las partidas, SOLO cuando se pidio el detalle (`detalle: true`).
   *
   * ⚠️ `null` y `[]` NO son lo mismo, y el papel los imprime distinto: `null` = no se pidio el
   * detalle; `[]` = se pidio y este documento no tiene partidas en el sistema. Un arreglo vacio
   * donde deberia haber `null` le diria al cliente que su compra no tuvo productos.
   */
  lineas: ReporteLinea[] | null;
}

export interface ReporteFiltros {
  from?: string;
  to?: string;
  /** Folio o parte de él. El folio NO identifica: se usa como "contiene". */
  folio?: string;
  /** Importe del documento. */
  min?: number;
  max?: number;
  caja?: number;
  atendio?: string;
  brand_id?: string;
  supplier_id?: string;
  solo_con_descuento?: boolean;
  /**
   * [TK.11] Trae las partidas de cada documento. Cuesta una consulta mas por universo, y
   * ALARGA el papel: medido, un cliente con 37 compras y ~4 partidas son ~150 renglones, de una
   * hoja a cinco o seis. Por eso es opcional y el papel declara cuantas partidas trae.
   */
  detalle?: boolean;
}

export interface ReporteCliente {
  cliente: ClienteCandidato;
  documentos: ReporteDocumento[];
  resumen: {
    documentos: number;
    importe: number;
    descuento: number;
    promedio: number;
    abonos: number;
    /** En cuántas sucursales compró de verdad, que no es lo mismo que dónde existe la clave. */
    plazas_con_compra: number;
  };
  /** Lo que los filtros NO dicen por sí solos. `null` = no hay nada que declarar. */
  aviso: string | null;
}

const LIMITE = 500;
/** Cuántos clientes devuelve el buscador antes de pedir que se afine. */
const LIMITE_BUSCADOR = 25;
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v ?? 0) || 0;
const fecha = (v: unknown) =>
  v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null;

/** Clave que el ERP usa para la venta de piso: no es un cliente, es la ausencia de uno. */
const ANONIMO = 'CONTADO';

/** `%` y `_` son comodines de LIKE: lo tecleado se escapa y se declara el ESCAPE al usarlo. */
const escLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

@Injectable()
export class CustomerReportService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Clientes cuyo nombre se parece a lo tecleado, UNO por clave.
   *
   * ⚠️ El alcance de sucursal va DENTRO del `WHERE`, antes del `LIMIT` (ver la cabecera: el
   * defecto anterior filtraba después y dejaba a media empresa sin resultados).
   */
  async clientes(q: string, alcance: string[] | null): Promise<{ candidatos: ClienteCandidato[]; topado: boolean }> {
    const termino = String(q || '').trim();
    if (termino.length < 2) return { candidatos: [], topado: false };

    return this.tk.run(async (trx) => {
      const { rows } = await trx.raw(
        `SELECT cliente_code,
                (array_agg(nombre ORDER BY length(nombre) DESC))[1] AS nombre,
                (array_agg(ciudad) FILTER (WHERE ciudad IS NOT NULL))[1] AS ciudad,
                (array_agg(zona_nombre) FILTER (WHERE zona_nombre IS NOT NULL))[1] AS zona,
                count(DISTINCT fuente_sucursal)::int AS plazas,
                count(DISTINCT upper(btrim(nombre)))::int AS nombres,
                max(similarity(unaccent(nombre), unaccent(?)))::float8 AS score
           FROM analytics.v_customer_master
          WHERE cliente_code <> ?
            AND es_interno = false
            AND nombre IS NOT NULL
            ${alcance ? 'AND fuente_sucursal = ANY(?)' : ''}
            -- "o parecidos" es literal: el ILIKE atrapa la subcadena y el % de pg_trgm el
            -- error de dedo. Los DOS lados van sin acentos: ILIKE ignora mayusculas, no tildes.
            AND (unaccent(nombre) ILIKE unaccent(?) ESCAPE '\\'
                 OR unaccent(nombre) % unaccent(?)
                 OR cliente_code ILIKE ? ESCAPE '\\')
          GROUP BY cliente_code
          -- Por parecido, NO alfabetico: un tope alfabetico sobre 5,297 coincidencias devolvia
          -- lo que empezara con A, no lo que se estaba buscando.
          ORDER BY score DESC NULLS LAST, nombre
          LIMIT ?`,
        [
          termino,
          ANONIMO,
          ...(alcance ? [alcance] : []),
          `%${escLike(termino)}%`,
          termino,
          `%${escLike(termino)}%`,
          LIMITE_BUSCADOR + 1,
        ],
      );

      const topado = rows.length > LIMITE_BUSCADOR;
      return {
        topado,
        candidatos: rows.slice(0, LIMITE_BUSCADOR).map((f: Record<string, unknown>) => ({
          cliente_code: String(f['cliente_code']),
          nombre: (f['nombre'] as string) ?? null,
          ciudad: (f['ciudad'] as string) ?? null,
          zona: (f['zona'] as string) ?? null,
          plazas: Number(f['plazas'] ?? 0),
          clave_ambigua: Number(f['nombres'] ?? 1) > 1,
          score: Math.round(Number(f['score'] ?? 0) * 1000) / 1000,
        })),
      };
    });
  }

  /**
   * ⚠️ El `EXISTS` de marca/proveedor se correlaciona por (sucursal, doc_prefix, folio) y NO
   * por `folio_digital`: ésa es una concatenación y filtrar por ella no usa el índice del ODS.
   */
  private existsProducto(
    tenantId: string, tablaLineas: string, alias: string, f: ReporteFiltros,
  ): { sql: string; bindings: string[] } | null {
    if (!f.brand_id && !f.supplier_id) return null;
    // ⛔ Devuelve el SQL y sus BINDINGS por separado, nunca un raw ya resuelto: `.toString()`
    // sobre un knex.raw interpola los valores en el texto, y `brand_id`/`supplier_id` llegan
    // del query string. El nombre de la tabla y el alias SÍ van interpolados, y pueden porque
    // son constantes de este archivo, no entrada de nadie.
    const sql = `EXISTS (SELECT 1 FROM ${tablaLineas} l
        JOIN catalog.products p ON p.tenant_id = ?::uuid AND p.id = l.product_id
         AND p.deleted_at IS NULL${f.brand_id ? ' AND p.brand_id = ?::uuid' : ''}${f.supplier_id ? ' AND p.supplier_id = ?::uuid' : ''}
       WHERE l.tenant_id = ?::uuid AND l.sucursal = ${alias}.sucursal
         AND l.doc_prefix = ${alias}.doc_prefix AND l.folio = ${alias}.folio)`;
    const bindings = [
      tenantId,
      ...(f.brand_id ? [f.brand_id] : []),
      ...(f.supplier_id ? [f.supplier_id] : []),
      tenantId,
    ];
    return { sql, bindings };
  }

  /** Lo que aplica a los dos universos por igual. */
  private comunes(qb: Knex.QueryBuilder, alias: string, f: ReporteFiltros, alcance: string[] | null) {
    if (f.from) qb.where(`${alias}.fecha`, '>=', f.from);
    if (f.to) qb.where(`${alias}.fecha`, '<=', f.to);
    if (f.min != null) qb.where(`${alias}.total`, '>=', f.min);
    if (f.max != null) qb.where(`${alias}.total`, '<=', f.max);
    // El folio NO identifica un documento (cada plaza y cada caja tienen su contador), así que
    // se usa como "contiene" y no como igualdad: quien teclea 6440 quiere verlos todos.
    if (f.folio) qb.whereRaw(`${alias}.folio ILIKE ? ESCAPE '\\'`, [`%${escLike(f.folio)}%`]);
    // ⚠️ El filtro de SUCURSAL no vive acá: llega ya resuelto en `alcance`. `ScopeService.
    // readParam()` lee `?warehouse_codes=03` del request y lo INTERSECA con las plazas del
    // usuario, traduciendo además UUIDs y los 16 alias viejos. Un segundo filtro de sucursal
    // en este servicio sería una reimplementación más débil de eso mismo, y la que se
    // desincroniza (ADR-050).
    if (alcance) qb.whereIn(`${alias}.sucursal`, alcance);
    return qb;
  }

  /** El reporte: los documentos del cliente, de los DOS universos y de todas sus plazas. */
  /**
   * [TK.11] Las partidas de un lote de documentos, adjuntadas en su sitio.
   *
   * ⚠️ NO se busca por `folio_digital`: es una CONCATENACION y no usa el indice del ODS — el
   * mismo motivo por el que el EXISTS de marca/proveedor se correlaciona por la terna. Aca se
   * arma la terna `(sucursal, doc_prefix, folio)`, que si entra por indice.
   *
   * El `doc_prefix` no viaja en el documento, pero sale EXACTO de su identidad: `folio_digital`
   * es `<sucursal><doc_prefix>-<folio>` por construccion de la vista, asi que se recorta con los
   * dos campos que el documento si trae. Hay una prueba que lo fija.
   *
   * Dos universos, dos consultas: mostrador va a `erp_sale_ticket_lines` y todo lo demas
   * (telemarketing, credito, abonos) a `erp_sales_invoice_lines`.
   */
  private async partidas(
    trx: Knex,
    tenantId: string,
    docs: ReporteDocumento[],
  ): Promise<void> {
    const terna = (d: ReporteDocumento): [string, string, string] => [
      d.sucursal,
      d.id.slice(d.sucursal.length, d.id.length - d.folio.length - 1),
      d.folio,
    ];

    const universos: { vista: string; docs: ReporteDocumento[] }[] = [
      { vista: 'analytics.erp_sale_ticket_lines', docs: docs.filter((d) => d.origen === 'mostrador') },
      { vista: 'analytics.erp_sales_invoice_lines', docs: docs.filter((d) => d.origen !== 'mostrador') },
    ];

    const porDoc = new Map<string, ReporteLinea[]>();
    for (const u of universos) {
      if (!u.docs.length) continue;
      const ternas = u.docs.map(terna);
      const filas = await trx
        .select('folio_digital', 'linea', 'sku', 'descripcion', 'unidad', 'cantidad',
          'precio_lista', 'precio_unitario', 'descuento_unitario', 'descuento_linea', 'importe')
        .from(trx.raw('?? as l', [u.vista]))
        .where('l.tenant_id', tenantId)
        .whereRaw(
          `(l.sucursal, l.doc_prefix, l.folio) IN (${ternas.map(() => '(?,?,?)').join(',')})`,
          ternas.flat(),
        )
        .orderBy(['folio_digital', 'linea']);

      for (const r of filas as Record<string, unknown>[]) {
        const id = String(r['folio_digital']);
        // `precio_lista` llega NULL cuando el ERP no lo guarda (nada anterior al 2026-08-13).
        // Se distingue de «lista = pagado», que si es una afirmacion.
        const listaRaw = r['precio_lista'];
        const conocida = listaRaw != null && num(listaRaw) > 0;
        const pagado = r2(num(r['precio_unitario']));
        if (!porDoc.has(id)) porDoc.set(id, []);
        (porDoc.get(id) as ReporteLinea[]).push({
          linea: Number(r['linea'] ?? 0),
          sku: (r['sku'] as string) ?? null,
          descripcion: (r['descripcion'] as string) ?? null,
          unidad: (r['unidad'] as string) ?? null,
          cantidad: num(r['cantidad']),
          precio_lista: conocida ? r2(num(listaRaw)) : pagado,
          lista_conocida: conocida,
          precio_pagado: pagado,
          descuento_unitario: r2(num(r['descuento_unitario'])),
          descuento_linea: r2(num(r['descuento_linea'])),
          importe: r2(num(r['importe'])),
        });
      }
    }

    // ⚠️ Se asigna a TODOS, incluso a los que no trajeron filas: `[]` dice «se pidio el detalle
    // y este documento no tiene partidas», que no es lo mismo que el `null` de «no se pidio».
    for (const d of docs) d.lineas = porDoc.get(d.id) ?? [];
  }

  async reporte(
    clienteCode: string, f: ReporteFiltros, alcance: string[] | null,
  ): Promise<ReporteCliente> {
    const tenantId = this.tenantCtx.requireTenantId();

    return this.tk.run(async (trx) => {
      // ── Mostrador ────────────────────────────────────────────────────────────────────
      const mos = trx('analytics.erp_sale_tickets as t')
        .where({ 't.tenant_id': tenantId, 't.cliente_code': clienteCode })
        .select('t.folio_digital as id', 't.sucursal', 't.caja', 't.folio', 't.fecha',
          't.cajero_nombre as atendio', 't.total', 't.descuento_documento');
      this.comunes(mos, 't', f, alcance);
      if (f.caja != null) mos.where('t.caja', f.caja);
      if (f.atendio) mos.where('t.cajero_code', f.atendio);
      const exMos = this.existsProducto(tenantId, 'analytics.erp_sale_ticket_lines', 't', f);
      if (exMos) mos.whereRaw(exMos.sql, exMos.bindings);

      // ── Facturas, crédito y notas de crédito ─────────────────────────────────────────
      // `caja` no existe en este universo: si se filtró por caja, no hay nada que traer.
      const fac = trx('analytics.erp_sales_invoices as i')
        .where({ 'i.tenant_id': tenantId, 'i.cliente_code': clienteCode })
        .select('i.folio_digital as id', 'i.sucursal', 'i.folio', 'i.fecha',
          'i.vendedor_nombre as atendio', 'i.total', 'i.doc_tipo', 'i.doc_prefix',
          // ⭐ `[TK.d3]` Esto decía `0::numeric`: la columna salía vacía justo donde el dato
          // existe, y el filtro «sólo con descuento» —que filtra por `descuento > 0` sobre este
          // mismo campo— no podía devolver una sola factura.
          //
          // ⛔ Y la columna obvia es la EQUIVOCADA. `i.descuento` es `kdm1.c13`, que viaja SIN
          // impuesto mientras el total va CON: medido en la Fase DC, en `07 U-D-10 s4 f0000513`
          // el descuento real es $147.43 y `c13` dice $135.26 — publicarlo subdeclara 8.3%.
          // `descuento_efectivo` lo deriva como `total / (1 − pct/100) − total` y reproduce los
          // $147.43 al centavo. Es el mismo criterio que `armar()` usa en el detalle: el
          // descuento se MIDE, no se copia del que la cabecera declara.
          'i.descuento_efectivo as descuento_documento', 'i.descuento_pct',
          trx.raw('NULL::int as caja'));
      this.comunes(fac, 'i', f, alcance);
      if (f.atendio) fac.where('i.vendedor_code', f.atendio);
      const exFac = this.existsProducto(tenantId, 'analytics.erp_sales_invoice_lines', 'i', f);
      if (exFac) fac.whereRaw(exFac.sql, exFac.bindings);

      // ⚠️ El nombre de la plaza NO sale de las vistas: `erp_sale_tickets` lo trae pero
      // `erp_sales_invoices` sólo expone `warehouse_id`. Pedirlo allá compila y revienta al
      // correr. Se resuelve de `commercial.warehouses`, que son diez filas, y sirve a los dos.
      const plazas = new Map<string, string>(
        (await trx('commercial.warehouses').where({ tenant_id: tenantId }).whereNull('deleted_at')
          .select('code', 'name')).map((w) => [String(w.code), String(w.name)]),
      );

      const filasMos = await mos.limit(LIMITE);
      const filasFac = f.caja != null ? [] : await fac.limit(LIMITE);

      const docs: ReporteDocumento[] = [];
      for (const r of filasMos) {
        docs.push({
          id: String(r.id), origen: 'mostrador', origen_label: ORIGEN_LABEL.mostrador,
          sucursal: String(r.sucursal), sucursal_nombre: plazas.get(String(r.sucursal)) ?? null,
          caja: r.caja != null ? Number(r.caja) : null,
          folio: String(r.folio), fecha: fecha(r.fecha), atendio: (r.atendio as string) ?? null,
          descuento: r2(num(r.descuento_documento)),
          // El ticket de mostrador no trae porcentaje de cabecera: `null`, no 0 (ADR-056).
          descuento_pct: null,
          total: r2(num(r.total)),
          lineas: null,
        });
      }
      for (const r of filasFac) {
        // El prefijo dice la naturaleza: `UA…` es abono (devolución / nota de crédito).
        const esAbono = String(r.doc_prefix || '').startsWith('UA');
        const origen: ReporteOrigen = esAbono ? 'abono'
          : (r.doc_tipo === 'credito' ? 'credito' : 'telemarketing');
        docs.push({
          id: String(r.id), origen, origen_label: ORIGEN_LABEL[origen],
          sucursal: String(r.sucursal), sucursal_nombre: plazas.get(String(r.sucursal)) ?? null,
          caja: null, folio: String(r.folio), fecha: fecha(r.fecha),
          atendio: (r.atendio as string) ?? null,
          descuento: r2(num(r.descuento_documento)),
          descuento_pct: r.descuento_pct != null && num(r.descuento_pct) > 0
            ? r2(num(r.descuento_pct)) : null,
          // ⭐ El abono RESTA. Sin el signo, el total del periodo diría de más y el papel
          // afirmaría que el cliente pagó mercancía que devolvió.
          total: esAbono ? -Math.abs(r2(num(r.total))) : r2(num(r.total)),
          lineas: null,
        });
      }

      const sel = f.solo_con_descuento ? docs.filter((d) => d.descuento > 0) : docs;
      // Más reciente primero, con el folio de desempate: dos documentos del mismo día no pueden
      // quedar en un orden que cambie entre dos cargas de la misma pantalla.
      sel.sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? '') || b.id.localeCompare(a.id));

      // [TK.11] El detalle se pide aparte y DESPUES de filtrar: no tiene sentido traer las
      // partidas de documentos que el usuario ya descarto.
      if (f.detalle && sel.length) await this.partidas(trx, tenantId, sel);

      const importe = r2(sel.reduce((s, d) => s + d.total, 0));
      const descuento = r2(sel.reduce((s, d) => s + d.descuento, 0));

      return {
        cliente: await this.identidad(trx, clienteCode, alcance),
        documentos: sel,
        resumen: {
          documentos: sel.length,
          importe,
          descuento,
          promedio: sel.length ? r2(importe / sel.length) : 0,
          abonos: sel.filter((d) => d.origen === 'abono').length,
          plazas_con_compra: new Set(sel.map((d) => d.sucursal)).size,
        },
        aviso: this.aviso(f, sel.length, filasMos.length + filasFac.length >= LIMITE),
      };
    });
  }

  /** Quién es el cliente, para que el papel lo diga con su nombre y no con su clave. */
  private async identidad(
    trx: Knex, code: string, alcance: string[] | null,
  ): Promise<ClienteCandidato> {
    const qb = trx('analytics.v_customer_master').where('cliente_code', code);
    if (alcance) qb.whereIn('fuente_sucursal', alcance);
    const filas = await qb.select('nombre', 'ciudad', 'zona_nombre', 'fuente_sucursal');
    const nombres = new Set(filas.map((f) => String(f.nombre ?? '').trim().toUpperCase()).filter(Boolean));
    // El más largo: en Kepler la versión corta suele ser la truncada.
    const nombre = filas.map((f) => f.nombre as string).filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] ?? null;
    return {
      cliente_code: code,
      nombre,
      ciudad: (filas.find((f) => f.ciudad)?.ciudad as string) ?? null,
      zona: (filas.find((f) => f.zona_nombre)?.zona_nombre as string) ?? null,
      plazas: new Set(filas.map((f) => f.fuente_sucursal)).size,
      clave_ambigua: nombres.size > 1,
      score: 1,
    };
  }

  /**
   * Lo que los filtros no dicen por sí solos. Cada frase existe porque su ausencia haría leer
   * el reporte como si fuera completo cuando no lo es (ADR-056).
   */
  private aviso(f: ReporteFiltros, n: number, topado: boolean): string | null {
    const partes: string[] = [];
    if (topado) partes.push(`Se muestran los primeros ${LIMITE} documentos: acotá el periodo para verlos todos.`);
    if (f.supplier_id) {
      partes.push('El filtro de proveedor sólo alcanza a 9,483 de 11,260 productos (84.2%): '
        + 'los 1,777 sin proveedor en el catálogo no aparecen bajo ningún proveedor.');
    }
    if (f.brand_id || f.supplier_id) {
      partes.push('Los documentos entran COMPLETOS aunque sólo una partida sea de esa marca o proveedor, '
        + 'para que el total siga siendo lo que se cobró.');
    }
    if (f.caja != null) partes.push('Al filtrar por caja quedan fuera las facturas y las notas de crédito: la caja sólo existe en mostrador.');
    if (!n) partes.push('Sin documentos con esos filtros.');
    return partes.length ? partes.join(' ') : null;
  }
}
