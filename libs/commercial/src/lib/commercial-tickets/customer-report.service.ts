import { Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

/**
 * Fase TK.8 — **Reporte por cliente**: qué le compró un cliente en un periodo, con los
 * documentos que uno elija.
 *
 * Vive en su propia sección y en su propio servicio: la pantalla de buscar folio no se toca.
 * Son dos preguntas distintas —"dame ESTE documento" contra "dame TODO lo de este cliente"— y
 * la segunda necesita filtros que a la primera le estorbarían.
 *
 * ── ⚠️ LO PRIMERO, PORQUE DECIDE PARA QUIÉN SIRVE ────────────────────────────────────────
 * **El mostrador es anónimo.** Medido en prod sobre 90 días: de **193,297** tickets de
 * mostrador, **187,530 (97%)** se cobraron a la clave literal `CONTADO`. No son de nadie y no
 * se pueden reportar. El universo real de esta pantalla son los **1,065 clientes con nombre**
 * (más 788 en facturas), y el más activo tiene **119 documentos en 90 días** — o sea que la
 * lista cabe en una pantalla con scroll y no hace falta paginar.
 *
 * ⚠️ **La clave de cliente es POR SUCURSAL.** Medido: **29 de 1,005** claves nombran a un
 * cliente DISTINTO según la plaza. Por eso el reporte es de (sucursal, clave) y nunca de la
 * clave sola: juntarlas sumaría a dos personas en un mismo papel sin que nadie se entere.
 *
 * ── EL BUSCADOR SALE DEL MAESTRO, NO DE LOS DOCUMENTOS ──────────────────────────────────
 * `analytics.v_customer_master` (derivada de `kepler_ods.kdud`) es el catálogo de clientes:
 * **301 ms** para un ILIKE. Buscar lo mismo agregando sobre los documentos tardaba
 * **12,203 ms** — y además respondía otra pregunta ("quién compró"), no la que se teclea.
 *
 * ── LOS FILTROS: LO QUE CUESTA CADA UNO, MEDIDO ─────────────────────────────────────────
 *   sucursal · fechas · importe · cliente   baratos, y sucursal YA se recorta por alcance.
 *   marca                                   423 ms por plaza/mes. 100% del catálogo la tiene.
 *   proveedor                               ⚠️ sólo 9,483 de 11,260 productos (84.2%).
 *   caja                                    ⚠️ SÓLO existe en mostrador.
 *   atendió                                 cajero en mostrador, vendedor en facturas.
 *
 * ⚠️ **Marca y proveedor son del PRODUCTO, no del documento.** Se filtra con un `EXISTS` sobre
 * los renglones y **entra el documento COMPLETO**, no sólo sus partidas de esa marca (decisión
 * del usuario, 2026-09-22). El motivo: si sólo entraran las partidas, el total del reporte
 * dejaría de ser un cobro que existió y no cuadraría contra ningún ticket en papel.
 *
 * ⚠️ **`caja` y `vendedor` no conviven en ningún documento.** Por eso `atendio` es UN filtro
 * que mira `cajero_code` en mostrador y `vendedor_code` en facturas: quien pregunta no tiene
 * por qué saber de antemano de qué universo salió el documento que busca.
 *
 * ⚠️ Las **notas de crédito** (`U-A-21/25/35`) entran con su importe en NEGATIVO y en su lugar
 * por fecha, para que el total del periodo sea lo que el cliente realmente pagó.
 *
 * ── POR QUÉ ESTO ES VIABLE RECIÉN AHORA ─────────────────────────────────────────────────
 * Hasta TK.7 (mig 20260921220000) pedir los tickets de un cliente tardaba **17,876 ms**: la
 * vista traía un `DISTINCT ON` que no deduplicaba nada y que impedía empujar cualquier filtro
 * que no fuera la identidad del documento. Hoy son **50 ms**. Sin eso, esta pantalla no existe.
 */

export type ReporteOrigen = 'mostrador' | 'telemarketing' | 'credito' | 'abono';

const ORIGEN_LABEL: Record<ReporteOrigen, string> = {
  mostrador: 'Mostrador',
  telemarketing: 'Telemarketing',
  credito: 'Crédito',
  abono: 'Nota de crédito',
};

/** Una fila del buscador de clientes. */
export interface ClienteCandidato {
  /** La identidad REAL: la clave sola no basta (29 de 1,005 nombran a otro en otra plaza). */
  id: string;
  sucursal: string;
  sucursal_nombre: string | null;
  cliente_code: string;
  nombre: string | null;
  ciudad: string | null;
  vendedor_nombre: string | null;
  /**
   * true ⇒ esta MISMA clave existe con otro nombre en otra plaza. La pantalla lo dice y obliga
   * a elegir; no se juntan, porque serían dos personas en un solo papel.
   */
  clave_ambigua: boolean;
}

/** Un documento del periodo. */
export interface ReporteDocumento {
  id: string;
  origen: ReporteOrigen;
  origen_label: string;
  sucursal: string;
  caja: number | null;
  folio: string;
  fecha: string | null;
  atendio: string | null;
  renglones: number | null;
  descuento: number;
  /** NEGATIVO en las notas de crédito: el total del periodo es lo que se pagó de verdad. */
  total: number;
}

export interface ReporteFiltros {
  from?: string;
  to?: string;
  /** Importe del documento. «cantidad» del pedido original = importe (decidido 2026-09-22). */
  min?: number;
  max?: number;
  caja?: number;
  atendio?: string;
  brand_id?: string;
  supplier_id?: string;
  solo_con_descuento?: boolean;
}

export interface ReporteCliente {
  cliente: ClienteCandidato;
  documentos: ReporteDocumento[];
  resumen: {
    documentos: number;
    importe: number;
    descuento: number;
    promedio: number;
    /** Cuántos de los documentos son notas de crédito, para que el neto se pueda explicar. */
    abonos: number;
  };
  /** Lo que los filtros NO dicen por sí solos. `null` = no hay nada que declarar. */
  aviso: string | null;
}

const LIMITE = 500;
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v ?? 0) || 0;
const fecha = (v: unknown) =>
  v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null;

/** Clave que el ERP usa para la venta de piso: no es un cliente, es la ausencia de uno. */
const ANONIMO = 'CONTADO';

@Injectable()
export class CustomerReportService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private dentro(sucursal: string, alcance: string[] | null) {
    return !alcance || alcance.includes(sucursal);
  }

  /**
   * Busca clientes por nombre o clave. Sale del MAESTRO (`kdud`), no de los documentos: 301 ms
   * contra 12,203 ms, y responde la pregunta que se teclea.
   */
  async clientes(q: string, alcance: string[] | null): Promise<{ candidatos: ClienteCandidato[]; topado: boolean }> {
    const termino = String(q || '').trim();
    if (termino.length < 2) return { candidatos: [], topado: false };
    const tenantId = this.tenantCtx.requireTenantId();
    const like = `%${termino.replace(/[%_]/g, (m) => '\\' + m)}%`;

    return this.tk.run(async (trx) => {
      // ⚠️ El join a `commercial.warehouses` se ve caro y NO lo es. La primera medición dio
      // 2,158 ms y casi lo saco; repitiéndola en caliente, 316 ms CON join contra 454 ms sin él
      // (dos viajes en vez de uno). Los 2,158 eran caché fría leyendo `kdud` por primera vez —
      // un costo que las dos variantes pagan igual. Se queda el join, que es el código simple.
      const filas = await trx('analytics.v_customer_master as c')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.code', '=', 'c.fuente_sucursal')
            .andOn('w.tenant_id', '=', trx.raw('?', [tenantId]))
            .andOnNull('w.deleted_at');
        })
        .select('c.fuente_sucursal as sucursal', 'c.cliente_code', 'c.nombre', 'c.ciudad',
          'c.vendedor_nombre', 'w.name as sucursal_nombre')
        // Ni la venta de piso ni las cuentas internas de la propia tienda: no son clientes.
        .whereNot('c.cliente_code', ANONIMO)
        .andWhere('c.es_interno', false)
        .andWhere((b) => b.whereILike('c.nombre', like).orWhereILike('c.cliente_code', like))
        .orderBy('c.nombre')
        .limit(LIMITE_BUSCADOR + 1);

      const visibles = filas.filter((f) => this.dentro(String(f.sucursal), alcance));
      const topado = visibles.length > LIMITE_BUSCADOR;
      const corte = visibles.slice(0, LIMITE_BUSCADOR);

      // Una clave es ambigua cuando la MISMA nombra a otro en otra plaza. Se resuelve sobre el
      // resultado, no con otra consulta: es un dato del propio conjunto.
      const porClave = new Map<string, Set<string>>();
      for (const f of corte) {
        const nom = String(f.nombre ?? '').trim().toUpperCase();
        if (!porClave.has(f.cliente_code)) porClave.set(f.cliente_code, new Set());
        if (nom) porClave.get(f.cliente_code)?.add(nom);
      }

      return {
        topado,
        candidatos: corte.map((f) => ({
          id: `${f.sucursal}:${f.cliente_code}`,
          sucursal: String(f.sucursal),
          sucursal_nombre: (f.sucursal_nombre as string) ?? null,
          cliente_code: String(f.cliente_code),
          nombre: (f.nombre as string) ?? null,
          ciudad: (f.ciudad as string) ?? null,
          vendedor_nombre: (f.vendedor_nombre as string) ?? null,
          clave_ambigua: (porClave.get(f.cliente_code)?.size ?? 0) > 1,
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

  private comunes(qb: Knex.QueryBuilder, alias: string, f: ReporteFiltros) {
    if (f.from) qb.where(`${alias}.fecha`, '>=', f.from);
    if (f.to) qb.where(`${alias}.fecha`, '<=', f.to);
    if (f.min != null) qb.where(`${alias}.total`, '>=', f.min);
    if (f.max != null) qb.where(`${alias}.total`, '<=', f.max);
    return qb;
  }

  /** El reporte: los documentos del cliente en el periodo, de los DOS universos. */
  async reporte(
    sucursal: string, clienteCode: string, f: ReporteFiltros, alcance: string[] | null,
  ): Promise<ReporteCliente> {
    const tenantId = this.tenantCtx.requireTenantId();
    if (!this.dentro(sucursal, alcance)) {
      // Mismo criterio que el detalle de un folio: no se distingue "no existe" de "no te toca".
      return this.vacio(sucursal, clienteCode);
    }

    return this.tk.run(async (trx) => {
      // ── Mostrador ────────────────────────────────────────────────────────────────────
      // Se salta entero cuando el filtro es de VENDEDOR, porque acá ese campo es el cajero y
      // la lista de "atendió" ya trae a los dos rotulados.
      const mos = trx('analytics.erp_sale_tickets as t')
        .where({ 't.tenant_id': tenantId, 't.sucursal': sucursal, 't.cliente_code': clienteCode })
        .select('t.folio_digital as id', 't.sucursal', 't.caja', 't.folio', 't.fecha',
          't.cajero_nombre as atendio', 't.total', 't.descuento_documento',
          trx.raw(`'mostrador'::text as origen`));
      this.comunes(mos, 't', f);
      if (f.caja != null) mos.where('t.caja', f.caja);
      if (f.atendio) mos.where('t.cajero_code', f.atendio);
      const exMos = this.existsProducto(tenantId, 'analytics.erp_sale_ticket_lines', 't', f);
      if (exMos) mos.whereRaw(exMos.sql, exMos.bindings);

      // ── Facturas, crédito y notas de crédito ─────────────────────────────────────────
      // `caja` no existe en este universo: si se filtró por caja, no hay nada que traer.
      const fac = trx('analytics.erp_sales_invoices as i')
        .where({ 'i.tenant_id': tenantId, 'i.sucursal': sucursal, 'i.cliente_code': clienteCode })
        .select('i.folio_digital as id', 'i.sucursal', 'i.folio', 'i.fecha',
          'i.vendedor_nombre as atendio', 'i.total', 'i.doc_tipo', 'i.doc_prefix',
          trx.raw('NULL::int as caja'), trx.raw('0::numeric as descuento_documento'));
      this.comunes(fac, 'i', f);
      if (f.atendio) fac.where('i.vendedor_code', f.atendio);
      const exFac = this.existsProducto(tenantId, 'analytics.erp_sales_invoice_lines', 'i', f);
      if (exFac) fac.whereRaw(exFac.sql, exFac.bindings);

      const [filasMos, filasFac] = [
        await mos.limit(LIMITE),
        f.caja != null ? [] : await fac.limit(LIMITE),
      ];

      const docs: ReporteDocumento[] = [];
      for (const r of filasMos) {
        docs.push({
          id: String(r.id), origen: 'mostrador', origen_label: ORIGEN_LABEL.mostrador,
          sucursal: String(r.sucursal), caja: r.caja != null ? Number(r.caja) : null,
          folio: String(r.folio), fecha: fecha(r.fecha), atendio: (r.atendio as string) ?? null,
          renglones: null, descuento: r2(num(r.descuento_documento)), total: r2(num(r.total)),
        });
      }
      for (const r of filasFac) {
        // El prefijo dice la naturaleza: `UA…` es abono (devolución / nota de crédito).
        const esAbono = String(r.doc_prefix || '').startsWith('UA');
        const origen: ReporteOrigen = esAbono ? 'abono'
          : (r.doc_tipo === 'credito' ? 'credito' : 'telemarketing');
        docs.push({
          id: String(r.id), origen, origen_label: ORIGEN_LABEL[origen],
          sucursal: String(r.sucursal), caja: null, folio: String(r.folio), fecha: fecha(r.fecha),
          atendio: (r.atendio as string) ?? null, renglones: null,
          descuento: 0,
          // ⭐ El abono RESTA. Sin el signo, el total del periodo diría de más y el papel
          // afirmaría que el cliente pagó mercancía que devolvió.
          total: esAbono ? -Math.abs(r2(num(r.total))) : r2(num(r.total)),
        });
      }

      const conDesc = f.solo_con_descuento ? docs.filter((d) => d.descuento > 0) : docs;
      // Más reciente primero, y con el folio de desempate: dos documentos del mismo día no
      // pueden quedar en un orden que cambie entre dos cargas de la misma pantalla.
      conDesc.sort((a, b) => (b.fecha ?? '').localeCompare(a.fecha ?? '') || b.id.localeCompare(a.id));

      const importe = r2(conDesc.reduce((s, d) => s + d.total, 0));
      const descuento = r2(conDesc.reduce((s, d) => s + d.descuento, 0));
      const abonos = conDesc.filter((d) => d.origen === 'abono').length;

      return {
        cliente: await this.identidad(trx, tenantId, sucursal, clienteCode),
        documentos: conDesc,
        resumen: {
          documentos: conDesc.length,
          importe,
          descuento,
          promedio: conDesc.length ? r2(importe / conDesc.length) : 0,
          abonos,
        },
        aviso: this.aviso(f, conDesc.length, filasMos.length + filasFac.length >= LIMITE),
      };
    });
  }

  /** Quién es el cliente, para que el papel lo diga con su nombre y no con su clave. */
  private async identidad(
    trx: Knex, tenantId: string, sucursal: string, code: string,
  ): Promise<ClienteCandidato> {
    const m = await trx('analytics.v_customer_master as c')
      .leftJoin('commercial.warehouses as w', function () {
        this.on('w.code', '=', 'c.fuente_sucursal')
          .andOn('w.tenant_id', '=', trx.raw('?', [tenantId]))
          .andOnNull('w.deleted_at');
      })
      .where({ 'c.fuente_sucursal': sucursal, 'c.cliente_code': code })
      .select('c.nombre', 'c.ciudad', 'c.vendedor_nombre', 'w.name as sucursal_nombre')
      .first();
    const otras = await trx('analytics.v_customer_master')
      .where('cliente_code', code).whereNot('fuente_sucursal', sucursal)
      .whereNotNull('nombre').select('nombre');
    const nom = String(m?.nombre ?? '').trim().toUpperCase();
    return {
      id: `${sucursal}:${code}`,
      sucursal,
      sucursal_nombre: (m?.sucursal_nombre as string) ?? null,
      cliente_code: code,
      nombre: (m?.nombre as string) ?? null,
      ciudad: (m?.ciudad as string) ?? null,
      vendedor_nombre: (m?.vendedor_nombre as string) ?? null,
      clave_ambigua: otras.some((o) => String(o.nombre ?? '').trim().toUpperCase() !== nom),
    };
  }

  private vacio(sucursal: string, code: string): ReporteCliente {
    return {
      cliente: {
        id: `${sucursal}:${code}`, sucursal, sucursal_nombre: null, cliente_code: code,
        nombre: null, ciudad: null, vendedor_nombre: null, clave_ambigua: false,
      },
      documentos: [],
      resumen: { documentos: 0, importe: 0, descuento: 0, promedio: 0, abonos: 0 },
      aviso: null,
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

/** Cuántos clientes devuelve el buscador antes de pedir que se afine. */
const LIMITE_BUSCADOR = 25;
