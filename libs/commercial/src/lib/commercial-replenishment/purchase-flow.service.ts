import { Injectable } from '@nestjs/common';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { FlujoComprasDto, FlujoRenglonDto, FlujoRequisicionDto } from '@megadulces/contracts';
import { clasificarRecepciones } from './oc-abiertas';
import {
  elegirOc, etapaRequisicion, FlujoCandidatoRow, FlujoEntradaRow, FlujoOcSkuRow, FlujoRqLineRow,
  negadosRecurrentes, OcElegida, resumenFlujo, sucursalKepler, surtidoPct, VENTANA_OC_DIAS,
} from './flujo-compras';

const n = (v: unknown) => Number(v) || 0;

/**
 * `[RA-PRO.63]` Flujo de compras: requisición → OC de Kepler (XA3501) → entrada (XA2001).
 * Solo lectura. La liga requisición→OC es SUGERIDA (ver `flujo-compras.contract.ts`): hoy nadie
 * la captura. Las decisiones viven en `flujo-compras.ts` (probadas); aquí sólo se traen filas.
 *
 * Las vistas `analytics.erp_*` no tienen RLS: el tenant va explícito en cada consulta.
 * Medido 2026-09-26 contra prod: ~250 ms para 60 días (244 requisiciones).
 */
@Injectable()
export class PurchaseFlowService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  async flow(q: { dias?: number | string; sucursal?: string } = {}): Promise<FlujoComprasDto> {
    const tenantId = this.tenantCtx.requireTenantId();
    const dias = Math.min(180, Math.max(7, Math.round(n(q.dias)) || 60));
    const suc = /^\d{2}$/.test(String(q.sucursal ?? '')) ? String(q.sucursal) : null;
    // Alcance por sucursal (`[ZN.3.3]`): `null` = todas, `[]` = ninguna.
    const codigos = await this.scope.readParam(suc ? { warehouse_codes: suc } : {}, 'warehouse', 'compras/pedido/flujo');

    return this.tk.run(async (trx) => {
      const rango = (await trx.raw(
        `SELECT (CURRENT_DATE - ?::int)::text AS desde, CURRENT_DATE::text AS hasta`, [dias])).rows[0] as { desde: string; hasta: string };
      const vacio: FlujoComprasDto = {
        desde: rango.desde, hasta: rango.hasta, dias, ventana_dias: VENTANA_OC_DIAS,
        resumen: resumenFlujo([]), requisiciones: [], negados_recurrentes: [], traspasos_fuera: 0,
      };
      if (codigos && !codigos.length) return vacio;

      // Filtro de requisiciones compartido por las dos consultas (mismo universo).
      const filtro = `
        r.tenant_id = :t AND r.estado <> 'cancelled'
        AND r.created_at >= (CURRENT_DATE - CAST(:dias AS int))
        ${codigos ? "AND (w.code = ANY(string_to_array(:codigos, ',')) OR w.kepler_code = ANY(string_to_array(:codigos, ',')))" : ''}`;
      // Los códigos son de dos dígitos (validados por el alcance): viajan como texto separado por comas.
      const b = { t: tenantId, dias, codigos: (codigos ?? []).join(',') };

      const lineas = (await trx.raw(`
        SELECT r.id, r.folio,
               (r.created_at AT TIME ZONE 'America/Mexico_City')::date::text AS fecha,
               CURRENT_DATE - (r.created_at AT TIME ZONE 'America/Mexico_City')::date AS dias_desde,
               r.source_type, w.code AS wcode, w.kepler_code, w.name AS wname,
               s.code AS prov_code, s.name AS prov_name,
               p.sku, p.nombre, l.line_cost
          FROM commercial.purchase_requisitions r
          JOIN commercial.warehouses w ON w.id = r.warehouse_id AND w.tenant_id = r.tenant_id
          LEFT JOIN catalog.suppliers s ON s.id = r.supplier_id AND s.tenant_id = r.tenant_id
          JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND l.tenant_id = r.tenant_id
          JOIN catalog.products p ON p.id = l.product_id AND p.tenant_id = r.tenant_id
         WHERE ${filtro}
         ORDER BY r.created_at DESC, r.folio, p.sku`, b)).rows as FlujoRqLineRow[];
      if (!lineas.length) return vacio;

      // Candidatas: OC de la misma sucursal y proveedor en la ventana, con cuántos productos de la
      // requisición traen. Sólo requisiciones de proveedor (un traspaso no pasa por una OC).
      const candidatos = (await trx.raw(`
        WITH rq AS (
          SELECT r.id,
                 (r.created_at AT TIME ZONE 'America/Mexico_City')::date AS d,
                 COALESCE(NULLIF(w.kepler_code, ''), CASE WHEN w.code ~ '^[0-9]{2}$' THEN w.code END) AS suc,
                 s.code AS prov,
                 array_agg(DISTINCT p.sku) AS skus
            FROM commercial.purchase_requisitions r
            JOIN commercial.warehouses w ON w.id = r.warehouse_id AND w.tenant_id = r.tenant_id
            JOIN catalog.suppliers s ON s.id = r.supplier_id AND s.tenant_id = r.tenant_id
            JOIN commercial.purchase_requisition_lines l ON l.requisition_id = r.id AND l.tenant_id = r.tenant_id
            JOIN catalog.products p ON p.id = l.product_id AND p.tenant_id = r.tenant_id
           WHERE ${filtro} AND r.source_type = 'supplier'
           GROUP BY 1, 2, 3, 4
        )
        SELECT rq.id AS rq_id, oc.sucursal, oc.folio, oc.doc_date::text AS fecha,
               oc.doc_date - rq.d AS dias, oc.monto,
               (SELECT count(DISTINCT ln.sku) FROM analytics.erp_purchase_doc_lines ln
                 WHERE ln.tenant_id = :t AND ln.doctype = 'XA3501'
                   AND ln.sucursal = oc.sucursal AND ln.folio = oc.folio AND ln.sku = ANY(rq.skus)) AS comunes
          FROM rq
          JOIN analytics.erp_purchase_docs oc
            ON oc.tenant_id = :t AND oc.doctype = 'XA3501'
           AND oc.sucursal = rq.suc AND oc.proveedor_code = rq.prov
           AND oc.doc_date BETWEEN rq.d AND rq.d + CAST(:ventana AS int)`, { ...b, ventana: VENTANA_OC_DIAS })).rows as FlujoCandidatoRow[];

      // Agrupar renglones por requisición.
      interface Acc { head: FlujoRqLineRow; lineas: FlujoRenglonDto[]; costo: number }
      const reqs = new Map<string, Acc>();
      for (const r of lineas) {
        const a = reqs.get(r.id) ?? { head: r, lineas: [], costo: 0 };
        const costo = n(r.line_cost);
        a.lineas.push({ sku: String(r.sku ?? ''), nombre: String(r.nombre ?? ''), costo, en_oc: null });
        a.costo += costo;
        reqs.set(r.id, a);
      }

      const porRq = new Map<string, FlujoCandidatoRow[]>();
      for (const c of candidatos) (porRq.get(c.rq_id) ?? porRq.set(c.rq_id, []).get(c.rq_id)!).push(c);

      const elegidas = new Map<string, OcElegida>();
      for (const [id, a] of reqs) {
        if (a.head.source_type !== 'supplier') continue;
        const e = elegirOc(a.lineas.length, (porRq.get(id) ?? []).map((c) => ({
          sucursal: c.sucursal, folio: c.folio, fecha: c.fecha, dias: n(c.dias), monto: n(c.monto), comunes: n(c.comunes),
        })));
        if (e) elegidas.set(id, e);
      }

      // Productos y entradas de las OC elegidas (una consulta cada una).
      const llaves = [...new Map([...elegidas.values()].map((e) => [`${e.oc.sucursal}|${e.oc.folio}`, [e.oc.sucursal, e.oc.folio]])).values()];
      const skusOc = new Map<string, Set<string>>();
      const entradasOc = new Map<string, FlujoEntradaRow[]>();
      if (llaves.length) {
        const ocSkus = (await trx('analytics.erp_purchase_doc_lines')
          .where({ tenant_id: tenantId, doctype: 'XA3501' })
          .whereIn(['sucursal', 'folio'], llaves)
          .distinct('sucursal', 'folio', 'sku')) as FlujoOcSkuRow[];
        for (const r of ocSkus) {
          const k = `${r.sucursal}|${r.folio}`;
          (skusOc.get(k) ?? skusOc.set(k, new Set()).get(k)!).add(String(r.sku ?? ''));
        }
        const ents = (await trx('analytics.erp_goods_receipts')
          .where({ tenant_id: tenantId })
          .whereIn(['sucursal', 'oc_folio'], llaves)
          .select('sucursal', 'oc_folio', 'folio', 'monto', 'proveedor_code',
            trx.raw('receipt_date::text AS fecha'))) as FlujoEntradaRow[];
        for (const r of ents) {
          const k = `${r.sucursal}|${r.oc_folio}`;
          (entradasOc.get(k) ?? entradasOc.set(k, []).get(k)!).push(r);
        }
      }
      const rqsPorOc = new Map<string, number>();
      for (const e of elegidas.values()) {
        const k = `${e.oc.sucursal}|${e.oc.folio}`;
        rqsPorOc.set(k, (rqsPorOc.get(k) ?? 0) + 1);
      }

      let traspasos = 0;
      const out: FlujoRequisicionDto[] = [];
      for (const [id, a] of reqs) {
        const h = a.head;
        if (h.source_type !== 'supplier') { traspasos += 1; continue; }
        const sucK = sucursalKepler(h.wcode, h.kepler_code);
        const e = elegidas.get(id) ?? null;
        const k = e ? `${e.oc.sucursal}|${e.oc.folio}` : '';
        let entrada: FlujoRequisicionDto['entrada'] = null;
        let negados = 0;
        if (e) {
          const skus = skusOc.get(k) ?? new Set<string>();
          for (const l of a.lineas) { l.en_oc = skus.has(l.sku); if (!l.en_oc) negados += 1; }
          const { validas } = clasificarRecepciones(h.prov_code, e.oc.fecha, (entradasOc.get(k) ?? []).map((r) => ({
            folio: r.folio, fecha: r.fecha, monto: n(r.monto), proveedor_code: r.proveedor_code,
          })));
          if (validas.length) {
            const monto = validas.reduce((s, r) => s + r.monto, 0);
            const fechas = validas.map((r) => r.fecha).filter((f): f is string => !!f).sort();
            entrada = { n: validas.length, primera_fecha: fechas[0] ?? null, monto, surtido_pct: surtidoPct(e.oc.monto, monto) };
          }
        }
        const diasDesde = n(h.dias_desde);
        const etapa = etapaRequisicion({ sinFuente: !sucK, conOc: !!e, conEntrada: !!entrada, diasDesde });
        const motivo =
          etapa === 'sin_fuente' ? 'Este almacén no hace sus órdenes en Kepler (Wincaja): no hay OC que buscar.'
          : etapa === 'esperando' ? `Tiene ${diasDesde} día(s); se espera la OC hasta ${VENTANA_OC_DIAS} días.`
          : etapa === 'sin_oc' ? `Ninguna OC del proveedor en ${VENTANA_OC_DIAS} días trae al menos la mitad de sus productos.`
          : e?.ambigua ? 'Otra OC trae los mismos productos: se ligó la más cercana en fecha.'
          : null;
        out.push({
          id, folio: h.folio, fecha: h.fecha,
          almacen: h.wcode ?? '', almacen_nombre: h.wname ?? '',
          proveedor: h.prov_name ?? null,
          renglones: a.lineas.length, costo: Math.round(a.costo * 100) / 100,
          etapa, motivo,
          oc: e ? {
            sucursal: e.oc.sucursal, folio: e.oc.folio, fecha: e.oc.fecha, dias: e.oc.dias, monto: e.oc.monto,
            coincidencia_pct: e.pct, confianza: e.confianza, ambigua: e.ambigua, requisiciones_en_oc: rqsPorOc.get(k) ?? 1,
          } : null,
          entrada, negados, lineas: a.lineas,
        });
      }

      return {
        ...vacio,
        resumen: resumenFlujo(out),
        requisiciones: out,
        negados_recurrentes: negadosRecurrentes(out),
        traspasos_fuera: traspasos,
      };
    });
  }
}
