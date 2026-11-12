import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Knex } from 'knex';
import {
  CANAL_FUENTE_KEPLER, KNEX_NEW_DB, MiradaAlAviso, PgListenService, TenantKnexService,
} from '@megadulces/platform-core';
import {
  FINANCE_FINDINGS_SINK_PORT, type FinanceFindingInput, type FinanceFindingsSinkPort,
} from '@megadulces/contracts';
import { AlertsService } from '../commercial-alerts/alerts.service';
import {
  REGLAS_TLMK, cotizacionDe, hallazgoCajaCambiada, hallazgoFacturaDistinta,
  type DocumentoTlmk, type RenglonCaja, type RenglonFactura,
} from './tlmk-revision.reglas';

/**
 * `[AX.22]` — Revisa los pedidos, embarques y facturas de Telemarketing **al llegar el dato** (aviso
 * `caja_fuente` de Kepler, sin cron), con las reglas puras de `tlmk-revision.reglas.ts`:
 *
 *  · embarque o pedido (sin embarcar) capturado con una caja que ya cambió;
 *  · factura(s) vivas que no dicen, por producto y en unidad base, lo mismo que su embarque.
 *
 * Cada hallazgo va a la bandeja de hallazgos (`FINANCE_FINDINGS_SINK_PORT`, idempotente por
 * `dedup_key`) y, si es NUEVO y el pedido nació en la Suite, a la campana de quien levantó la
 * cotización (`emitTo`).
 *
 * ── Decisiones, con su porqué ───────────────────────────────────────────────────────────────────
 *  · **«Nuevo» lo decide la base, no la memoria del pod.** La API corre en 2 réplicas con el
 *    adaptador de Redis: si cada una avisara lo que ELLA no había visto, el aviso saldría doble. El
 *    sink inserta con `ON CONFLICT … RETURNING (xmax = 0)`: sólo una réplica obtiene «insertado».
 *  · **No se avisa lo viejo.** Al arrancar se revisan 14 días (recoge lo que pasó con el proceso
 *    abajo: `NOTIFY` no se persiste), pero sólo se avisa un hallazgo cuyo documento es de ayer o de
 *    hoy; lo demás entra callado a la bandeja. Sin esto, cada despliegue repetiría avisos viejos.
 *  · **Qué documentos se revisan:** los TM (`U-D-40/41/8`, serie 1) creados o modificados desde
 *    ayer (`kdm1.c9` o `c68`; `c68` a veces viene sin hora, por eso es por DÍA). Una factura trae a
 *    revisión a su embarque (back-pointer `c37/c38/c39`).
 *
 * ⚠️ Lo que NO ve: un cambio de ficha sin que el documento se toque (pedido abierto que se queda
 *    con la caja vieja) — eso es `[AX.22.4]`. Un hallazgo corregido después en Kepler NO se cierra
 *    solo: queda en la bandeja hasta que alguien lo atienda. Un pedido capturado directo en Kepler
 *    (sin `COT-` en el comentario) no tiene a quién avisar: sólo va a la bandeja.
 *
 * Killable con `DISABLE_TLMK_REVISION=true`. Corre en los pods de `api` (donde está el WS).
 */
const DIAS_ARRANQUE = 14;
const DIAS_AVISO = 1;
const LOTE = 100;
// El pedido «ya embarcado» se busca en los embarques de esta ventana (índice por fecha, sin barrer kdm1).
const DIAS_EMBARQUES = 60;

export function esperaRevisionMs(): number {
  const v = Number(String(process.env.TLMK_REVISION_AVISO_S ?? '').trim());
  return Number.isFinite(v) && v > 0 ? Math.min(v, 600) * 1000 : 30_000;
}

/** Cabecera de Kepler de un documento TM (lo que lee `documentos()`). */
interface Cabecera {
  sucursal: string;
  doc_type: number;
  serie: number;
  folio: string;
  fecha: string;
  modificado: string | null;
  cliente: string | null;
  comentario: string | null;
  cancelado: boolean;
  o_tipo: number | null;
  o_serie: number | null;
  o_folio: string | null;
}

const llave = (s: string, t: number, se: number, f: string) => `${s}|${t}|${se}|${f}`;
const folioDigital = (c: Pick<Cabecera, 'sucursal' | 'doc_type' | 'serie' | 'folio'>) =>
  `${c.sucursal}UD${c.doc_type}${String(c.serie).padStart(2, '0')}-${c.folio}`;
const trozos = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

@Injectable()
export class TlmkRevisionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TlmkRevisionService.name);
  private mirada: MiradaAlAviso | null = null;
  private dejarDeEscuchar: (() => void) | null = null;
  private primera = true;
  private corriendo = false;

  constructor(
    @Inject(KNEX_NEW_DB) private readonly knex: Knex,
    private readonly tk: TenantKnexService,
    private readonly listen: PgListenService,
    private readonly alerts: AlertsService,
    @Optional() @Inject(FINANCE_FINDINGS_SINK_PORT) private readonly sink?: FinanceFindingsSinkPort,
  ) {}

  onModuleInit(): void {
    if (process.env.DISABLE_TLMK_REVISION === 'true') { this.logger.log('revisión TM APAGADA (DISABLE_TLMK_REVISION)'); return; }
    if (process.env.WORKER === 'true') { this.logger.log(`no escucho ${CANAL_FUENTE_KEPLER}: la revisión TM avisa por WS y vive en los pods de api`); return; }
    if (!this.sink) { this.logger.warn('FINANCE_FINDINGS_SINK_PORT no ligado: la revisión TM no tiene bandeja y NO va a correr'); return; }
    this.mirada = new MiradaAlAviso(
      esperaRevisionMs(),
      () => this.firma(),
      async (cambio) => { if (cambio) await this.revisar(); },
      (e) => this.logger.warn(`revisión TM falló: ${(e as Error)?.message}`),
    );
    try {
      this.dejarDeEscuchar = this.listen.escuchar(CANAL_FUENTE_KEPLER, () => this.mirada?.avisar());
    } catch (e: unknown) {
      this.logger.error(`no se pudo escuchar ${CANAL_FUENTE_KEPLER}: ${(e as Error)?.message} — la revisión TM NO va a correr sola`);
    }
    this.mirada.avisar(); // la primera mirada recoge lo que pasó con el proceso abajo
  }

  onModuleDestroy(): void {
    this.dejarDeEscuchar?.();
    this.dejarDeEscuchar = null;
    this.mirada?.detener();
  }

  /** Firma de los documentos TM de la ventana: cambia si se crea, se edita o se cancela uno. */
  async firma(): Promise<string> {
    const r = await this.knex.raw<{ rows: { f: string | null }[] }>(
      `SELECT md5(COALESCE(string_agg(btrim(sucursal) || '|' || c4::text || '|' || btrim(c6) || '|' || COALESCE(btrim(c11), '')
                  || '|' || COALESCE(c16::text, '') || '|' || COALESCE(c43, '') || '|' || COALESCE(c68::text, ''),
                  ',' ORDER BY sucursal, c4, c6), '')) AS f
         FROM kepler_ods.kdm1
        WHERE c2 = 'U' AND c3 = 'D' AND c4 IN (8, 40, 41) AND c5 = 1
          AND c9::date >= current_date - ?::int AND btrim(c1) = btrim(sucursal)`,
      [DIAS_ARRANQUE],
    );
    return r.rows[0]?.f ?? '';
  }

  /** Una pasada. Nunca lanza: lo que falla se dice y la siguiente mirada lo reintenta. */
  async revisar(): Promise<{ documentos: number; hallazgos: number; nuevos: number; avisos: number }> {
    const vacio = { documentos: 0, hallazgos: 0, nuevos: 0, avisos: 0 };
    if (this.corriendo || !this.sink) return vacio;
    this.corriendo = true;
    try {
      const dias = this.primera ? DIAS_ARRANQUE : DIAS_AVISO;
      const docs = await this.documentos(dias);
      const tenants: { id: string }[] = await this.knex('public.tenants').where({ activo: true }).select('id');
      const total = { ...vacio, documentos: docs.length };
      for (const t of tenants) {
        const r = await this.revisarTenant(t.id, docs);
        total.hallazgos += r.hallazgos; total.nuevos += r.nuevos; total.avisos += r.avisos;
      }
      this.primera = false;
      if (total.nuevos) this.logger.log(`revisión TM (${dias} d): ${docs.length} documentos, ${total.hallazgos} hallazgos, ${total.nuevos} nuevos, ${total.avisos} avisos`);
      return total;
    } finally {
      this.corriendo = false;
    }
  }

  /** Los documentos TM creados o modificados en los últimos `dias`. */
  async documentos(dias: number): Promise<Cabecera[]> {
    const r = await this.knex.raw<{ rows: Cabecera[] }>(
      `SELECT btrim(sucursal) AS sucursal, c4::int AS doc_type, c5::int AS serie, btrim(c6) AS folio,
              c9::date::text AS fecha, c68::date::text AS modificado,
              NULLIF(btrim(c10), '') AS cliente, NULLIF(btrim(c24), '') AS comentario,
              COALESCE(c43, '') = 'C' AS cancelado,
              NULLIF(btrim(c37::text), '')::numeric::int AS o_tipo,
              NULLIF(btrim(c38::text), '')::numeric::int AS o_serie,
              NULLIF(btrim(c39), '') AS o_folio
         FROM kepler_ods.kdm1
        WHERE c2 = 'U' AND c3 = 'D' AND c4 IN (8, 40, 41) AND c5 = 1 AND btrim(c1) = btrim(sucursal)
          AND (c9::date >= current_date - ?::int OR c68::date >= current_date - ?::int)`,
      [dias, dias],
    );
    return r.rows;
  }

  private async revisarTenant(tenantId: string, docs: Cabecera[]): Promise<{ hallazgos: number; nuevos: number; avisos: number }> {
    // 1. Qué se revisa: embarques vivos (los suyos y los que trae una factura) y pedidos vivos.
    const embarques = new Map<string, Cabecera>();
    const pedidos = new Map<string, Cabecera>();
    const traidosPorFactura: { sucursal: string; serie: number; folio: string }[] = [];
    for (const d of docs) {
      if (d.doc_type === 41 && !d.cancelado) embarques.set(llave(d.sucursal, 41, d.serie, d.folio), d);
      else if (d.doc_type === 40 && !d.cancelado) pedidos.set(llave(d.sucursal, 40, d.serie, d.folio), d);
      else if (d.doc_type === 8 && d.o_tipo === 41 && d.o_serie !== null && d.o_folio) {
        traidosPorFactura.push({ sucursal: d.sucursal, serie: d.o_serie, folio: d.o_folio });
      }
    }
    const faltan = traidosPorFactura.filter((e) => !embarques.has(llave(e.sucursal, 41, e.serie, e.folio)));
    for (const c of await this.cabecerasPorLlave(faltan)) {
      if (!c.cancelado) embarques.set(llave(c.sucursal, 41, c.serie, c.folio), c);
    }

    // 2. Un pedido que ya se embarcó lo revisa su embarque.
    const embarcados = await this.pedidosEmbarcados();
    for (const k of [...pedidos.keys()]) if (embarcados.has(k)) pedidos.delete(k);

    const objetivo = [...embarques.values(), ...pedidos.values()];
    if (!objetivo.length) return { hallazgos: 0, nuevos: 0, avisos: 0 };

    // 3. Los renglones (vista AX.22.1) y las facturas vivas de cada embarque, en lote y por llave.
    const renglones = await this.renglones(tenantId, objetivo);
    const facturas = await this.facturasDe(tenantId, [...embarques.values()]);

    // 4. Reglas.
    const hallazgos: { f: FinanceFindingInput; doc: Cabecera; cot: string | null }[] = [];
    for (const c of objetivo) {
      const k = llave(c.sucursal, c.doc_type, c.serie, c.folio);
      const rs = renglones.get(k) ?? [];
      if (!rs.length) continue; // sin renglones en el ODS no se afirma nada
      const cot = cotizacionDe(c.comentario);
      const doc: DocumentoTlmk = {
        sucursal: c.sucursal, doc_type: c.doc_type as 40 | 41, serie: c.serie, folio: c.folio,
        folio_digital: folioDigital(c), fecha: c.fecha, cliente: c.cliente, cotizacion: cot,
      };
      const h1 = hallazgoCajaCambiada(doc, rs);
      if (h1) hallazgos.push({ f: h1, doc: c, cot });
      if (c.doc_type === 41) {
        const h2 = hallazgoFacturaDistinta(doc, rs, facturas.get(k) ?? []);
        if (h2) hallazgos.push({ f: h2, doc: c, cot });
      }
    }
    if (!hallazgos.length) return { hallazgos: 0, nuevos: 0, avisos: 0 };

    // 5. A la bandeja de a uno: el «insertado» de la base es lo que decide si es nuevo (ver arriba).
    const autores = await this.autores(tenantId, [...new Set(hallazgos.map((h) => h.cot).filter((x): x is string => !!x))]);
    const hoy = new Date(Date.now() - DIAS_AVISO * 86_400_000).toISOString().slice(0, 10);
    let nuevos = 0;
    let avisos = 0;
    let reglasRegistradas = false;
    for (const h of hallazgos) {
      const r = await this.sink!.pushFindings(tenantId, [h.f], reglasRegistradas ? [] : REGLAS_TLMK);
      reglasRegistradas = true;
      if (!r.inserted) continue;
      nuevos++;
      const reciente = h.doc.fecha >= hoy || (h.doc.modificado !== null && h.doc.modificado >= hoy);
      const quien = h.cot ? autores.get(h.cot) : undefined;
      if (!reciente || !quien) continue;
      this.alerts.emitTo(tenantId, quien, {
        type: 'tlmk_documento',
        severity: h.f.severity,
        title: h.f.titulo,
        message: h.f.resumen,
        data: { route: '/telemarketing/documentos', folio: (h.f.entity as { folio_digital?: string }).folio_digital ?? null, rule_key: h.f.rule_key, cotizacion: h.cot },
      });
      avisos++;
    }
    return { hallazgos: hallazgos.length, nuevos, avisos };
  }

  /** Cabeceras de embarques por llave constante (índice `ix_kdm1_venta_doc`). */
  private async cabecerasPorLlave(llaves: { sucursal: string; serie: number; folio: string }[]): Promise<Cabecera[]> {
    const out: Cabecera[] = [];
    for (const lote of trozos(llaves, LOTE)) {
      const vals = lote.map(() => '(?::text, ?::int, ?::text)').join(', ');
      const r = await this.knex.raw<{ rows: Cabecera[] }>(
        `SELECT btrim(h.sucursal) AS sucursal, 41 AS doc_type, h.c5::int AS serie, btrim(h.c6) AS folio,
                h.c9::date::text AS fecha, h.c68::date::text AS modificado,
                NULLIF(btrim(h.c10), '') AS cliente, NULLIF(btrim(h.c24), '') AS comentario,
                COALESCE(h.c43, '') = 'C' AS cancelado, NULL::int AS o_tipo, NULL::int AS o_serie, NULL::text AS o_folio
           FROM kepler_ods.kdm1 h
           JOIN (VALUES ${vals}) k(s, se, f)
             ON btrim(h.sucursal) = k.s AND h.c4::int = 41 AND h.c5::int = k.se AND btrim(h.c6) = k.f
          WHERE h.c2 = 'U' AND h.c3 = 'D' AND btrim(h.c1) = btrim(h.sucursal)`,
        lote.flatMap((x) => [x.sucursal, x.serie, x.folio]),
      );
      out.push(...r.rows);
    }
    return out;
  }

  /** Llaves de pedidos (`sucursal|40|serie|folio`) que ya tienen un embarque vivo. */
  private async pedidosEmbarcados(): Promise<Set<string>> {
    const r = await this.knex.raw<{ rows: { s: string; se: number; f: string }[] }>(
      `SELECT btrim(sucursal) AS s, NULLIF(btrim(c38::text), '')::numeric::int AS se, btrim(c39) AS f
         FROM kepler_ods.kdm1
        WHERE c2 = 'U' AND c3 = 'D' AND c4 = 41 AND c9::date >= current_date - ?::int
          AND btrim(c1) = btrim(sucursal) AND COALESCE(c43, '') <> 'C'
          AND NULLIF(btrim(c37::text), '')::numeric = 40`,
      [DIAS_EMBARQUES],
    );
    return new Set(r.rows.filter((x) => x.se !== null && x.f).map((x) => llave(x.s, 40, x.se, x.f)));
  }

  /** Renglones de la vista AX.22.1 por documento, en lote y por llave constante (3 ms por llave). */
  private async renglones(tenantId: string, docs: Cabecera[]): Promise<Map<string, RenglonCaja[]>> {
    const out = new Map<string, RenglonCaja[]>();
    for (const lote of trozos(docs, LOTE)) {
      const vals = lote.map(() => '(?::text, ?::int, ?::int, ?::text)').join(', ');
      const r = await this.knex.raw<{ rows: (RenglonCaja & { sucursal: string; doc_type: number; serie: number; folio: string })[] }>(
        `SELECT v.sucursal, v.doc_type, v.serie, v.folio, v.sku, v.captured_unit,
                v.captured_qty::float8 AS captured_qty, v.captured_factor::float8 AS captured_factor,
                v.base_qty::float8 AS base_qty, v.base_unit, v.base_unit_price::float8 AS base_unit_price,
                v.current_factor::float8 AS current_factor, v.status,
                v.qty_in_current_unit::float8 AS qty_in_current_unit,
                v.base_qty_at_current_factor::float8 AS base_qty_at_current_factor
           FROM analytics.v_erp_order_line_box_factor v
           JOIN (VALUES ${vals}) k(s, t, se, f)
             ON v.sucursal = k.s AND v.doc_type = k.t AND v.serie = k.se AND v.folio = k.f
          WHERE v.tenant_id = ?`,
        [...lote.flatMap((d) => [d.sucursal, d.doc_type, d.serie, d.folio]), tenantId],
      );
      for (const x of r.rows) {
        const k = llave(x.sucursal, x.doc_type, x.serie, x.folio);
        const arr = out.get(k) ?? [];
        arr.push(x);
        out.set(k, arr);
      }
    }
    return out;
  }

  /** Renglones de las facturas VIVAS de cada embarque (por su back-pointer `doc_origen`). */
  private async facturasDe(tenantId: string, embarques: Cabecera[]): Promise<Map<string, RenglonFactura[]>> {
    const out = new Map<string, RenglonFactura[]>();
    for (const lote of trozos(embarques, LOTE)) {
      const fac: { sucursal: string; doc_prefix: string; folio: string; folio_digital: string; doc_origen: string }[] =
        await this.knex('analytics.erp_sales_invoices as i')
          .where('i.tenant_id', tenantId)
          .andWhere('i.cancelada', false)
          .whereIn(['i.sucursal', 'i.doc_origen'], lote.map((e) => [e.sucursal, `UD41${String(e.serie).padStart(2, '0')}-${e.folio}`]))
          .select('i.sucursal', 'i.doc_prefix', 'i.folio', 'i.folio_digital', 'i.doc_origen');
      if (!fac.length) continue;
      // ⛔ Los renglones NO por `analytics.erp_sales_invoice_lines`: medido en prod (2026-11-12, 98 facturas),
      // la vista por tupla tardó 5.3–6.0 s y `kdm2` por llave (índice `ix_kdm2_venta_doc`) 7 ms, con las
      // mismas 1,220 llaves (sucursal, serie, folio, sku) y 0 diferencias de cantidad (`c9`).
      const llavesFac = fac.map((f) => ({ f, serie: Number(String(f.doc_prefix).slice(-2)), folio: String(f.folio).trim() }));
      const vals = llavesFac.map(() => '(?::text, ?::int, ?::text)').join(', ');
      const lin = (await this.knex.raw<{ rows: { sucursal: string; serie: number; folio: string; sku: string; cantidad: number }[] }>(
        `SELECT btrim(l.sucursal) AS sucursal, l.c5::int AS serie, btrim(l.c6) AS folio, btrim(l.c8) AS sku, l.c9::float8 AS cantidad
           FROM kepler_ods.kdm2 l
           JOIN (VALUES ${vals}) k(s, se, f)
             ON btrim(l.sucursal) = k.s AND l.c4::int = 8 AND l.c5::int = k.se AND btrim(l.c6) = k.f
          WHERE l.c2 = 'U' AND l.c3 = 'D' AND btrim(l.c1) = btrim(l.sucursal) AND NULLIF(btrim(l.c8), '') IS NOT NULL`,
        llavesFac.flatMap((x) => [x.f.sucursal, x.serie, x.folio]),
      )).rows;
      const deFactura = new Map(llavesFac.map((x) => [`${x.f.sucursal}|${x.serie}|${x.folio}`, x.f]));
      for (const l of lin) {
        const f = deFactura.get(`${l.sucursal}|${l.serie}|${l.folio}`);
        if (!f || !l.sku) continue;
        const m = /^UD41(\d{2})-(\S+)$/.exec(String(f.doc_origen).trim());
        if (!m) continue;
        const k = llave(f.sucursal, 41, Number(m[1]), m[2]);
        const arr = out.get(k) ?? [];
        arr.push({ factura: f.folio_digital, sku: l.sku, cantidad: Number(l.cantidad) });
        out.set(k, arr);
      }
    }
    return out;
  }

  /** Quién levantó cada cotización (username, el destinatario de `emitTo`). Con RLS: por tenant. */
  private async autores(tenantId: string, cotizaciones: string[]): Promise<Map<string, string>> {
    if (!cotizaciones.length) return new Map();
    try {
      const rows: { code: string; username: string | null }[] = await this.tk.run(tenantId, (trx) =>
        trx('commercial.quotes as q')
          .leftJoin('identity.users as u', 'u.id', trx.raw('COALESCE(q.created_by, q.kepler_sent_by)'))
          .where('q.tenant_id', tenantId)
          .whereIn('q.code', cotizaciones)
          .select('q.code', 'u.username'));
      return new Map(rows.filter((r) => r.username).map((r) => [r.code, String(r.username)]));
    } catch (e: unknown) {
      // Sin autor no hay aviso, pero el hallazgo igual va a la bandeja.
      this.logger.warn(`no se pudo leer quién levantó las cotizaciones: ${(e as Error)?.message}`);
      return new Map();
    }
  }
}
