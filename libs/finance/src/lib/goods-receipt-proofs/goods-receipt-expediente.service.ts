import { BadRequestException, Injectable } from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type {
  EntradasSinOcFila, EntradasSinOcResumen, ExpedienteConteos, ExpedienteCubo, ExpedienteDocTipo, ExpedienteHallazgo,
  ExpedienteLectura, ExpedienteLiga, ExpedienteResumenFila, IdentificacionCandidata, IdentificacionEntrada,
  IdentificarLectura, ReceiptExpediente,
} from '@megadulces/contracts';
import {
  CfdiCandidato, HistorialEmisor, NotaCredito, REGLA_EXPEDIENTE, TOLERANCIA_ABS, TOLERANCIA_PCT, Veredicto,
  cuadra, extraerUuid, hallazgosDe, ligarCfdi, notaQueExplica, promoverRfcImporte, proveedorEnContpaqi, veredictoExpediente,
  UMBRAL_NOMBRE_CONTPAQI,
} from './expediente-verdict';
import { COMERCIAL_CATS, parecidoNombre, rfcBienFormado, rfcComparable } from './receipt-match';
import { EntradaParaIdentificar, clasificarIdentificacion } from './identificar-entrada';

/** Filas tal como las devuelven las consultas (tipadas: el boundary no admite `any`). */
interface EntradaFila {
  sucursal: string; folio: string; proveedor_code: string | null; proveedor_nombre: string | null;
  proveedor_rfc: string | null; oc_folio: string | null; receipt_date: string | null; monto: number;
  fecha_recepcion: string | null; fecha_recepcion_usuario: string | null;
}
interface ProofFila {
  sucursal: string; folio: string; status: string; files: unknown;
  ocr_folio: string | null; ocr_rfc: string | null; ocr_status: string | null;
  ocr_monto: number | null; ocr_fecha: string | null; ocr_raw: string | null;
}
type CfdiFila = Omit<CfdiCandidato, 'iva_trasladado' | 'ieps_trasladado' | 'ieps_por_cuota'>;
interface TrasladoCfdi { impuesto?: string | number; importe?: number | string; tipo_factor?: string }
interface ImpuestosCfdi { iva_trasladado?: number | string | null; ieps_trasladado?: number | string | null; traslados?: TrasladoCfdi[] }
interface HistorialFila { id: string; emisor_rfc: string; fecha: string; emisor_regimen: string | null; metodo_pago: string | null; emisor_nombre: string | null }
interface ListaSatFila { rfc: string; lista: string | number; situacion: string | null }
interface NotaFila extends NotaCredito { emisor_rfc: string }
interface AjusteFila { sucursal: string; entrada_folio: string; operativo: number; comercial: number }
interface GemelaFila { proveedor_code: string; monto: number; receipt_date: string }

/** Ventana de búsqueda de CFDI alrededor de la fecha de la entrada (días). */
const VENTANA_BUSQUEDA = 60;
/** Historia del emisor que cuenta para "lo habitual". */
const HISTORIA_DIAS = 730;


const CFDI_COLS = `id, uuid, serie, folio,
  to_char(fecha, 'YYYY-MM-DD') AS fecha,
  to_char(fecha_timbrado AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI') AS fecha_timbrado,
  emisor_rfc, emisor_nombre, emisor_regimen, receptor_rfc, receptor_regimen,
  receptor_uso_cfdi AS uso_cfdi, metodo_pago, forma_pago, moneda,
  tipo_cambio::float8 AS tipo_cambio, subtotal::float8 AS subtotal, descuento::float8 AS descuento,
  total::float8 AS total, total_trasladados::float8 AS total_trasladados, total_retenidos::float8 AS total_retenidos,
  lugar_expedicion, estatus_sat`;

/** Lo que el lote calcula para UNA entrada (el panel y la fila del listado leen lo mismo). */
export interface ExpedienteCalculado {
  entrada: EntradaFila;
  docTipo: ExpedienteDocTipo;
  lectura: ExpedienteLectura | null;
  cfdi: CfdiCandidato | null;
  liga: ExpedienteLiga | null;
  veredicto: Veredicto;
  hallazgos: ExpedienteHallazgo[];
}

export interface LlaveEntrada { sucursal: string; folio: string }

const llave = (s: string, f: string) => `${s}/${f}`;

/** `[RE.35.7]` La lectura cruda del OCR (JSON en `ocr_raw`); null si es texto viejo o no parsea. */
function lecturaCruda(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return null;
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
}
const sumarDias = (ymd: string, n: number) => new Date(Date.parse(ymd.slice(0, 10)) + n * 864e5).toISOString().slice(0, 10);
const difDias = (a: string, b: string) => Math.round((Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 864e5);

/**
 * `[RE.35]` — El expediente de la factura de una orden de entrada (ADR-085).
 *
 * `[RE.35.5]` Todo sale de UN cálculo por lote (\`calcularLote\`): el panel lateral pide una llave y el
 * listado pide su universo entero. Así la fila y el panel nunca se contradicen, y el listado paga
 * pocas consultas en bloque en vez de una por fila.
 *
 * Junta las piezas y le pide el veredicto al motor PURO (`expediente-verdict.ts`):
 *   · la entrada de Kepler (`analytics.erp_goods_receipts`, vista viva sobre el ODS);
 *   · el documento que subió el auxiliar (`finance.goods_receipt_proofs`): de él sólo salen las
 *     LLAVES para identificar la factura (UUID, folio, RFC, total);
 *   · el CFDI que sincroniza ContPAQi (`fiscal.cfdis`): de él sale TODO dato fiscal;
 *   · la historia del emisor, las listas del SAT, las notas de crédito y los ajustes de Kepler.
 *
 * Es de SÓLO LECTURA: no escribe la liga (eso es RE.37, con la decisión del auxiliar y en
 * `fiscal.cfdi_assignments`), no escribe a Kepler ni a ContPAQi (ADR-040).
 */
@Injectable()
export class GoodsReceiptExpedienteService {
  /** Sólo se recuerda el SÍ: si una migración se aplica con la API arriba, se ve en la siguiente consulta. */
  private readonly existe = new Set<string>();
  /**
   * `[RE.35.5]` Caché corta del resumen del listado: paginar, ordenar o buscar reusa el mismo cálculo.
   * La llave es el conjunto de entradas con documento: subir un documento lo cambia y obliga a recalcular.
   * Lo que puede quedar viejo hasta 2 minutos es un CFDI recién sincronizado (ContPAQi sincroniza diario).
   */
  private readonly cache = new Map<string, { at: number; valor: { filas: Map<string, ExpedienteResumenFila>; conteos: ExpedienteConteos } }>();
  private static readonly CACHE_MS = 120_000;

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  // ─────────────────────────────── el panel: una entrada ───────────────────────────────
  async expediente(sucursal: string, folio: string): Promise<ReceiptExpediente> {
    const tenantId = this.tenantCtx.requireTenantId();
    // El alcance se resuelve FUERA de `tk.run` (ScopeService no vive dentro de la transacción con RLS),
    // igual que el detalle: la URL es adivinable y sin esto el alcance sería decorativo.
    const alcance = await this.scope.current();
    if (!this.scope.canRead(alcance, 'warehouse', sucursal)) {
      throw new BadRequestException(`la entrada ${sucursal}/${folio} no está en tu alcance`);
    }
    return this.tk.run(async (trx) => {
      const lote = await this.calcularLote(trx, tenantId, [{ sucursal, folio }]);
      const x = lote.get(llave(sucursal, folio));
      if (!x) throw new BadRequestException('entrada no encontrada');
      const cfdi = x.cfdi ? { ...x.cfdi, ...(await this.impuestos(trx, tenantId, x.cfdi.id)) } : null;
      const { id: _id, ...cfdiPublico } = cfdi ?? ({} as CfdiCandidato);
      return {
        sucursal, folio,
        doc_tipo: x.docTipo,
        cubo: x.veredicto.cubo,
        motivos: x.veredicto.motivos,
        checks: x.veredicto.checks,
        cfdi: cfdi ? cfdiPublico : null,
        liga: x.liga,
        lectura: x.lectura,
        monto_entrada: Number(x.entrada.monto),
        diferencia: x.veredicto.diferencia,
        via: x.veredicto.via,
        hallazgos: x.hallazgos,
        nota_credito: x.veredicto.notaCredito,
        regla: REGLA_EXPEDIENTE,
        tolerancia: { pct: TOLERANCIA_PCT, abs: TOLERANCIA_ABS },
      };
    });
  }

  // ─────────────────────────────── el listado: muchas entradas ───────────────────────────────
  /**
   * `[RE.35.5]` El veredicto compacto de cada llave + los conteos de la Bandeja y del Hallazgo.
   * Se llama DENTRO de la transacción del listado (ya con el alcance aplicado a las llaves).
   */
  async resumenLote(trx: Knex.Transaction, tenantId: string, keys: LlaveEntrada[]): Promise<{ filas: Map<string, ExpedienteResumenFila>; conteos: ExpedienteConteos }> {
    const t0 = Date.now();
    const clave = tenantId + '|' + keys.map((k) => llave(k.sucursal, k.folio)).sort().join(',');
    const hit = this.cache.get(clave);
    if (hit && t0 - hit.at < GoodsReceiptExpedienteService.CACHE_MS) return { filas: hit.valor.filas, conteos: { ...hit.valor.conteos, ms: Date.now() - t0 } };
    const lote = await this.calcularLote(trx, tenantId, keys);
    const filas = new Map<string, ExpedienteResumenFila>();
    const porCubo: Record<ExpedienteCubo, number> = { auto: 0, revisar: 0, sin_cfdi_aun: 0, sin_documento: 0, fuera_de_alcance: 0 };
    const porHallazgo: Record<ExpedienteHallazgo, number> = { cobrar_nc: 0, mal_emitida: 0, incompleta: 0, sin_oc: 0, nc_aplicada: 0, comercial: 0 };
    for (const [k, x] of lote) {
      filas.set(k, { cubo: x.veredicto.cubo, hallazgos: x.hallazgos, motivo: x.veredicto.motivos[0] ?? null });
      porCubo[x.veredicto.cubo]++;
      for (const h of x.hallazgos) porHallazgo[h]++;
    }
    const valor = { filas, conteos: { por_cubo: porCubo, por_hallazgo: porHallazgo, ms: Date.now() - t0 } };
    if (this.cache.size > 50) this.cache.clear();
    this.cache.set(clave, { at: Date.now(), valor });
    return valor;
  }

  /**
   * El cálculo por lote. Pocas consultas en bloque; el motor puro corre por entrada en memoria.
   * Cada entrada ve SÓLO los CFDI de su ventana (±60 días de su fecha) más los que la nombran por
   * UUID o por asignación confirmada — exactamente lo mismo que vería sola.
   */
  async calcularLote(trx: Knex.Transaction, tenantId: string, keys: LlaveEntrada[]): Promise<Map<string, ExpedienteCalculado>> {
    const out = new Map<string, ExpedienteCalculado>();
    if (!keys.length) return out;
    const pares = keys.map((k) => [k.sucursal, k.folio]);
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());

    // 1. Entradas
    const tieneRecepcion = await this.existeColumna(trx, 'analytics', 'erp_goods_receipts', 'fecha_recepcion');
    const entradas: EntradaFila[] = await trx('analytics.erp_goods_receipts')
      .where({ tenant_id: tenantId })
      .whereIn(['sucursal', 'folio'], pares)
      .select(
        'sucursal', 'folio', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc', 'oc_folio',
        trx.raw(`to_char(receipt_date, 'YYYY-MM-DD') AS receipt_date`),
        trx.raw('monto::float8 AS monto'),
        trx.raw(tieneRecepcion ? `to_char(fecha_recepcion, 'YYYY-MM-DD') AS fecha_recepcion` : 'NULL::text AS fecha_recepcion'),
        trx.raw(tieneRecepcion ? 'fecha_recepcion_usuario' : 'NULL::text AS fecha_recepcion_usuario'));
    if (!entradas.length) return out;

    // 2. Quién es la empresa (receptor) y qué proveedores son internos
    const emisora = await trx('fiscal.issuer_config')
      .where({ tenant_id: tenantId, active: true }).orderBy('is_default', 'desc').first('rfc', 'regimen_fiscal');
    const receptorRfc: string | null = emisora?.rfc ?? null;
    const internos = await this.internos(trx, tenantId, entradas.map((e) => e.proveedor_code).filter((c): c is string => !!c));

    // 3. Documentos subidos: el último que no fue devuelto (si todos, el último) + todos los roles
    const proofs: (ProofFila & { created_at: string })[] = await trx('finance.goods_receipt_proofs')
      .whereIn(['sucursal', 'folio'], pares)
      .orderBy('created_at', 'desc')
      .select('sucursal', 'folio', 'status', 'files', 'ocr_folio', 'ocr_rfc', 'ocr_status', 'created_at',
        trx.raw('ocr_monto::float8 AS ocr_monto'), trx.raw(`to_char(ocr_fecha, 'YYYY-MM-DD') AS ocr_fecha`),
        trx.raw('ocr_raw::text AS ocr_raw'));
    const porEntrada = new Map<string, (ProofFila & { created_at: string })[]>();
    for (const p of proofs) { const k = llave(p.sucursal, p.folio); (porEntrada.get(k) ?? porEntrada.set(k, []).get(k)!).push(p); }

    // 4. Asignaciones ya confirmadas por una persona
    const asignados = new Map<string, string>();
    if (await this.existeTabla(trx, 'fiscal', 'cfdi_assignments')) {
      const rows = await trx('fiscal.cfdi_assignments')
        .where({ tenant_id: tenantId, status: 'confirmed' })
        .whereIn(['sucursal', 'doc_folio'], pares)
        .orderBy('created_at', 'asc')
        .select('sucursal', 'doc_folio', 'cfdi_id');
      for (const r of rows as { sucursal: string; doc_folio: string; cfdi_id: string }[]) asignados.set(llave(r.sucursal, r.doc_folio), r.cfdi_id);
    }

    // Prepara cada entrada: tipo de documento y lectura del papel
    interface Prep { e: EntradaFila; k: string; docTipo: ExpedienteDocTipo; lectura: ExpedienteLectura | null; interno: boolean; pivote: string | null }
    const preps: Prep[] = entradas.map((e) => {
      const k = llave(e.sucursal, e.folio);
      const ps = porEntrada.get(k) ?? [];
      const proof = ps.find((p) => p.status !== 'rechazado') ?? ps[0] ?? null;
      const roles = new Set<string>();
      for (const p of ps) {
        const files: { role?: string }[] = typeof p.files === 'string' ? JSON.parse(p.files || '[]') : (Array.isArray(p.files) ? p.files : []);
        for (const f of files) if (f?.role) roles.add(String(f.role));
      }
      // Sólo cuentan los documentos DEL PROVEEDOR: una orden de entrada o un vale son hojas nuestras.
      const docTipo: ExpedienteDocTipo = roles.has('factura') ? 'factura' : roles.has('remision') ? 'remision' : 'ninguno';
      // `[RE.35.7]` Sello y firma viven en la lectura cruda (ocr_raw); las anteriores a RE.35.7 no los traen.
      const crudo = proof ? lecturaCruda(proof.ocr_raw) : null;
      const lectura = proof ? {
        uuid: extraerUuid(proof.ocr_raw), folio: proof.ocr_folio ?? null, rfc: proof.ocr_rfc ?? null,
        total: proof.ocr_monto ?? null, fecha: proof.ocr_fecha ?? null, ocr_status: proof.ocr_status ?? null,
        sello: typeof crudo?.['sello_recibido'] === 'boolean' ? crudo['sello_recibido'] as boolean : null,
        firma: typeof crudo?.['firma_recibido'] === 'boolean' ? crudo['firma_recibido'] as boolean : null,
        sello_evidencia: typeof crudo?.['sello_evidencia'] === 'string' ? crudo['sello_evidencia'] as string : null,
      } : null;
      const interno = (!!e.proveedor_rfc && !!receptorRfc && e.proveedor_rfc.trim().toUpperCase() === receptorRfc.toUpperCase())
        || (!!e.proveedor_code && internos.has(e.proveedor_code.trim()));
      return { e, k, docTipo, lectura, interno, pivote: e.receipt_date ?? lectura?.fecha ?? null };
    });

    // 5. Candidatos CFDI de todas las facturas, en UNA consulta
    const facturas = preps.filter((p) => p.docTipo === 'factura' && !p.interno);
    let candidatos: CfdiFila[] = [];
    if (facturas.length) {
      const fechas = facturas.map((p) => p.pivote).filter((x): x is string => !!x).sort();
      const uuids = [...new Set(facturas.map((p) => p.lectura?.uuid).filter((x): x is string => !!x))];
      const ids = [...new Set(facturas.map((p) => asignados.get(p.k)).filter((x): x is string => !!x))];
      candidatos = await trx('fiscal.cfdis')
        .where({ tenant_id: tenantId, rol: 'recibidas', tipo_comprobante: 'I' })
        .andWhere((w) => {
          if (ids.length) w.orWhereIn('id', ids);
          // UUID y RFC están en mayúsculas en fiscal.cfdis (medido: 0 de 427,792 en minúsculas).
          if (uuids.length) w.orWhereIn('uuid', uuids);
          if (fechas.length) {
            w.orWhereRaw(`(fecha >= ?::date AND fecha < ?::date)`,
              [sumarDias(fechas[0], -VENTANA_BUSQUEDA), sumarDias(fechas[fechas.length - 1], VENTANA_BUSQUEDA + 1)]);
          }
          if (!ids.length && !uuids.length && !fechas.length) w.whereRaw('false');
        })
        .select(trx.raw(CFDI_COLS));
    }
    const vistos = candidatos.map((r) => ({ ...r, iva_trasladado: null, ieps_trasladado: null, ieps_por_cuota: false }));
    // Día numérico de cada CFDI, ordenado: la ventana de cada entrada sale por búsqueda binaria en vez
    // de convertir fechas miles de veces por entrada (medido: 2.9 s de 5 s en 447 entradas).
    const diaDe = (ymd: string | null) => (ymd ? Math.round(Date.parse(ymd.slice(0, 10)) / 864e5) : NaN);
    const porDia = vistos.map((c) => ({ c, d: diaDe(c.fecha) })).filter((x) => !Number.isNaN(x.d)).sort((a, b) => a.d - b.d);
    const desdeIdx = (d: number) => { let lo = 0, hi = porDia.length; while (lo < hi) { const m = (lo + hi) >> 1; if (porDia[m].d < d) lo = m + 1; else hi = m; } return lo; };
    const enVentana = (pivote: string | null): CfdiCandidato[] => {
      const d = diaDe(pivote); if (Number.isNaN(d)) return [];
      const out: CfdiCandidato[] = [];
      for (let i = desdeIdx(d - VENTANA_BUSQUEDA); i < porDia.length && porDia[i].d <= d + VENTANA_BUSQUEDA; i++) out.push(porDia[i].c);
      return out;
    };

    // 6. Ligar cada factura con los CFDI de SU ventana
    interface Liga { cfdi: CfdiCandidato | null; liga: ExpedienteLiga | null; ambiguos: number; enContpaqi?: boolean }
    const ligas = new Map<string, Liga>();
    for (const p of facturas) {
      const asig = asignados.get(p.k) ?? null;
      const ventana = enVentana(p.pivote);
      const extra = vistos.filter((c) => (c.id === asig || (!!p.lectura?.uuid && c.uuid === p.lectura.uuid)) && !ventana.includes(c));
      const suyos = extra.length ? [...ventana, ...extra] : ventana;
      const r = ligarCfdi({
        uuidLeido: p.lectura?.uuid ?? null, folioLeido: p.lectura?.folio ?? null, rfcLeido: p.lectura?.rfc ?? null,
        totalLeido: p.lectura?.total ?? null, fechaLeida: p.lectura?.fecha ?? null,
        rfcKepler: p.e.proveedor_rfc ?? null, montoEntrada: Number(p.e.monto), fechaEntrada: p.e.receipt_date,
        asignadoId: asig,
      }, suyos);
      // Sin CFDI: ¿el proveedor factura en ContPAQi? Si no, su papel se revisa como remisión.
      ligas.set(p.k, { ...r, enContpaqi: r.cfdi ? undefined : proveedorEnContpaqi(p.e.proveedor_nombre ?? null, p.e.proveedor_rfc ?? null, suyos) });
    }

    // 7. RFC + importe: ¿hay otra entrada del proveedor con ese importe? (una consulta)
    const porPromover = facturas.filter((p) => { const l = ligas.get(p.k); return !!l?.cfdi && l.liga?.metodo === 'rfc_importe' && l.liga.candidatos === 1 && !!p.e.proveedor_code; });
    if (porPromover.length) {
      const codes = [...new Set(porPromover.map((p) => p.e.proveedor_code as string))];
      const fs = porPromover.map((p) => ligas.get(p.k)?.cfdi?.fecha).filter((x): x is string => !!x).sort();
      const q = trx('analytics.erp_goods_receipts').where({ tenant_id: tenantId }).whereNull('dup_of_folio').whereIn('proveedor_code', codes)
        .select('proveedor_code', trx.raw('monto::float8 AS monto'), trx.raw(`to_char(receipt_date, 'YYYY-MM-DD') AS receipt_date`));
      if (fs.length) q.whereBetween('receipt_date', [sumarDias(fs[0], -VENTANA_BUSQUEDA), sumarDias(fs[fs.length - 1], VENTANA_BUSQUEDA)]);
      const gem: GemelaFila[] = await q;
      for (const p of porPromover) {
        const l = ligas.get(p.k)!; const c = l.cfdi!;
        const n = gem.filter((g) => g.proveedor_code === p.e.proveedor_code && Math.abs(Number(g.monto) - c.total) <= 1
          && (!c.fecha || Math.abs(difDias(g.receipt_date, c.fecha)) <= VENTANA_BUSQUEDA)).length;
        l.liga = promoverRfcImporte(l.liga, n);
      }
    }

    // 8-9. Notas de crédito, historia del emisor y listas del SAT (una consulta cada una)
    const ligadas = facturas.filter((p) => !!ligas.get(p.k)?.cfdi);
    const emisores = [...new Set(ligadas.map((p) => ligas.get(p.k)!.cfdi!.emisor_rfc.toUpperCase()))];
    const fechasCfdi = ligadas.map((p) => ligas.get(p.k)!.cfdi!.fecha).filter((x): x is string => !!x).sort();
    let notas: NotaFila[] = [], historia: HistorialFila[] = [], listas: ListaSatFila[] = [];
    if (emisores.length && fechasCfdi.length) {
      const lo = fechasCfdi[0], hi = fechasCfdi[fechasCfdi.length - 1];
      const mayores = ligadas.filter((p) => { const c = ligas.get(p.k)!.cfdi!; const d = c.total - Number(p.e.monto); return d > 0 && !cuadra(d, Number(p.e.monto)); });
      if (mayores.length) {
        notas = (await trx('fiscal.cfdis')
          .where({ tenant_id: tenantId, rol: 'recibidas', tipo_comprobante: 'E' })
          .whereIn('emisor_rfc', [...new Set(mayores.map((p) => ligas.get(p.k)!.cfdi!.emisor_rfc.toUpperCase()))])
          .whereRaw('fecha >= ?::date AND fecha < ?::date', [sumarDias(lo, -5), sumarDias(hi, 91)])
          .select('uuid', 'emisor_rfc', trx.raw('total::float8 AS total'), trx.raw(`to_char(fecha, 'YYYY-MM-DD') AS fecha`)))
          .map((n: NotaFila) => ({ ...n, total: Number(n.total) }));
      }
      // ⚠️ ~190 ms por emisor en la consulta suelta: el índice por RFC lo retiró 20260928210000.
      historia = await trx('fiscal.cfdis')
        .where({ tenant_id: tenantId, rol: 'recibidas', tipo_comprobante: 'I', receptor_uso_cfdi: 'G01' })
        .whereIn('emisor_rfc', emisores)
        .whereRaw('fecha >= ?::date AND fecha < ?::date', [sumarDias(lo, -HISTORIA_DIAS), hi])
        .select('id', 'emisor_rfc', trx.raw(`to_char(fecha, 'YYYY-MM-DD') AS fecha`), 'emisor_regimen', 'metodo_pago', 'emisor_nombre');
      if (await this.existeTabla(trx, 'fiscal', 'sat_list_rfcs')) {
        listas = await trx('fiscal.sat_list_rfcs').whereRaw('upper(rfc) = ANY(?)', [emisores]).select(trx.raw('upper(rfc) AS rfc'), 'lista', 'situacion');
      }
    }

    // 10. Ajustes de Kepler ligados a cada entrada (devolución = operativo; descuento/apoyo = comercial)
    const ajustes = new Map<string, { operativo: number; comercial: number }>();
    if (await this.existeTabla(trx, 'analytics', 'erp_purchase_adjustments')) {
      const rows: AjusteFila[] = await trx('analytics.erp_purchase_adjustments')
        .where({ tenant_id: tenantId }).whereIn(['sucursal', 'entrada_folio'], pares)
        .groupBy('sucursal', 'entrada_folio')
        .select('sucursal', 'entrada_folio',
          trx.raw(`COALESCE(sum(monto) FILTER (WHERE categoria IS NULL OR NOT (categoria = ANY(?))), 0)::float8 AS operativo`, [COMERCIAL_CATS]),
          trx.raw(`COALESCE(sum(monto) FILTER (WHERE categoria = ANY(?)), 0)::float8 AS comercial`, [COMERCIAL_CATS]));
      for (const r of rows) ajustes.set(llave(r.sucursal, r.entrada_folio), { operativo: Number(r.operativo), comercial: Number(r.comercial) });
    }

    // 11. El veredicto de cada entrada (motor puro)
    for (const p of preps) {
      const l = ligas.get(p.k);
      const cfdi = l?.cfdi ?? null;
      let notaCredito: NotaCredito | null = null;
      let historial: HistorialEmisor | null = null;
      if (cfdi) {
        const dif = cfdi.total - Number(p.e.monto);
        if (dif > 0 && !cuadra(dif, Number(p.e.monto))) {
          notaCredito = notaQueExplica(dif, Number(p.e.monto), cfdi.fecha,
            notas.filter((n) => n.emisor_rfc.toUpperCase() === cfdi.emisor_rfc.toUpperCase()));
        }
        historial = { regimenes: {}, metodos: {}, nombres: {} };
        for (const h of historia) {
          if (h.emisor_rfc.toUpperCase() !== cfdi.emisor_rfc.toUpperCase() || h.id === cfdi.id) continue;
          if (cfdi.fecha && (h.fecha >= cfdi.fecha || difDias(cfdi.fecha, h.fecha) > HISTORIA_DIAS)) continue;
          if (h.emisor_regimen) historial.regimenes[h.emisor_regimen] = (historial.regimenes[h.emisor_regimen] ?? 0) + 1;
          if (h.metodo_pago) historial.metodos[h.metodo_pago] = (historial.metodos[h.metodo_pago] ?? 0) + 1;
          if (h.emisor_nombre) historial.nombres[h.emisor_nombre] = (historial.nombres[h.emisor_nombre] ?? 0) + 1;
        }
      }
      const v = veredictoExpediente({
        docTipo: p.docTipo,
        entrada: {
          monto: Number(p.e.monto), oc_folio: p.e.oc_folio ?? null,
          fecha_recepcion: p.e.fecha_recepcion ?? null, fecha_recepcion_usuario: p.e.fecha_recepcion_usuario ?? null,
          receipt_date: p.e.receipt_date ?? null, proveedor_nombre: p.e.proveedor_nombre ?? null, interno: p.interno,
        },
        cfdi, liga: l?.liga ?? null, ambiguos: l?.ambiguos ?? 0,
        totalLeido: p.lectura?.total ?? null,
        fechaDocumento: p.lectura?.fecha ?? p.e.receipt_date ?? null,
        historial,
        ctx: {
          receptorRfc, receptorRegimen: emisora?.regimen_fiscal ?? null,
          listasSat: cfdi ? listas.filter((x) => x.rfc === cfdi.emisor_rfc.toUpperCase()).map((x) => ({ lista: String(x.lista), situacion: x.situacion ?? null })) : [],
        },
        notaCredito,
        proveedorEnContpaqi: l?.enContpaqi,
        sello: p.lectura?.sello ?? null, firma: p.lectura?.firma ?? null, selloEvidencia: p.lectura?.sello_evidencia ?? null,
        hoy,
      });
      out.set(p.k, {
        entrada: p.e, docTipo: p.docTipo, lectura: p.lectura, cfdi, liga: l?.liga ?? null, veredicto: v,
        hallazgos: hallazgosDe(v, ajustes.get(p.k) ?? { operativo: 0, comercial: 0 }),
      });
    }
    return out;
  }

  /**
   * `[RE.35.3]` Entradas sin OC por sucursal y por quién las capturó en Kepler, en el periodo.
   * Sólo las sucursales que la persona puede ver (mismo alcance que la lista de entradas).
   */
  // ─────────────────────────── [RE.35.7] captura por lote: identificar ───────────────────────────
  /**
   * ¿De qué entrada es este papel? Primero su CFDI (con `ligarCfdi`, sólo con lo leído), luego las
   * entradas que cuadran con el total del CFDI (o lo leído) y cuyo proveedor es el emisor. Sólo
   * lectura: no guarda nada. El alcance por sucursal aplica (no se propone una entrada ajena).
   */
  async identificar(l: IdentificarLectura): Promise<IdentificacionEntrada> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ymd = /^\d{4}-\d{2}-\d{2}/;
    const uuidRe = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
    const uuid = typeof l?.uuid === 'string' && uuidRe.test(l.uuid.trim().toUpperCase()) ? l.uuid.trim().toUpperCase() : null;
    const rfc = rfcBienFormado(l?.rfc) ? String(l.rfc).trim().toUpperCase() : null;
    const total = typeof l?.total === 'number' && isFinite(l.total) && l.total > 0 ? l.total : null;
    const fecha = typeof l?.fecha === 'string' && ymd.test(l.fecha) ? l.fecha.slice(0, 10) : null;
    const folio = typeof l?.folio === 'string' && l.folio.trim() ? l.folio.trim().slice(0, 60) : null;
    const nombreLeido = typeof l?.proveedor === 'string' ? l.proveedor.slice(0, 200) : null;
    const alcance = await this.scope.current();
    const visibles = this.scope.intersect(alcance, 'warehouse', null);

    return this.tk.run(async (trx) => {
      // 1. El CFDI, sólo con las llaves del papel.
      let cfdi: CfdiCandidato | null = null;
      let liga: ExpedienteLiga | null = null;
      if (uuid || rfc || total != null) {
        const filas = (await trx('fiscal.cfdis')
          .where({ tenant_id: tenantId, rol: 'recibidas', tipo_comprobante: 'I' })
          .andWhere((w) => {
            if (uuid) w.orWhere('uuid', uuid);
            if (rfc || total != null) {
              w.orWhere((v) => {
                if (fecha) v.whereRaw('(fecha >= ?::date AND fecha < ?::date)', [sumarDias(fecha, -VENTANA_BUSQUEDA), sumarDias(fecha, VENTANA_BUSQUEDA + 1)]);
                else v.whereRaw(`fecha >= current_date - 120`);
                v.andWhere((x) => {
                  if (rfc) x.orWhere('emisor_rfc', rfc);
                  if (total != null) x.orWhereRaw('abs(total - ?) <= 1', [total]);
                });
              });
            }
          })
          .select(trx.raw(CFDI_COLS))
          .limit(500)) as CfdiFila[];
        const cands: CfdiCandidato[] = filas.map((r) => ({ ...r, iva_trasladado: null, ieps_trasladado: null, ieps_por_cuota: false }));
        const r = ligarCfdi({
          uuidLeido: uuid, folioLeido: folio, rfcLeido: rfc, totalLeido: total, fechaLeida: fecha,
          rfcKepler: null, montoEntrada: Number.NaN, fechaEntrada: fecha, asignadoId: null,
        }, cands);
        cfdi = r.cfdi; liga = r.liga;
      }

      // 2. Las entradas que cuadran con el total del CFDI (o lo leído) y son de ese emisor.
      const totalObj = cfdi?.total ?? total;
      const rfcObj = cfdi?.emisor_rfc ?? rfc;
      const nombreObj = cfdi?.emisor_nombre ?? nombreLeido;
      const fechaObj = cfdi?.fecha ?? fecha;
      let candidatas: IdentificacionCandidata[] = [];
      if (totalObj != null) {
        const inicio = await this.inicioRecepcion(trx, tenantId);
        const dep = trx('finance.goods_receipt_proofs')
          .where({ tenant_id: tenantId }).whereNot('status', 'rechazado')
          .groupBy('sucursal', 'folio').select('sucursal', 'folio').count('* as n').as('d');
        const q = trx('analytics.erp_goods_receipts as c')
          .leftJoin(dep, (j) => { j.on('c.sucursal', 'd.sucursal').andOn('c.folio', 'd.folio'); })
          .where('c.tenant_id', tenantId).whereNull('c.dup_of_folio').where('c.monto', '>', 0)
          .whereRaw('abs(c.monto - ?) < ?', [totalObj, TOLERANCIA_ABS])
          .select('c.sucursal', 'c.folio', 'c.proveedor_nombre', 'c.proveedor_rfc', 'c.oc_folio',
            trx.raw(`to_char(c.receipt_date, 'YYYY-MM-DD') AS receipt_date`), trx.raw('c.monto::float8 AS monto'),
            trx.raw('COALESCE(d.n, 0)::int AS deposits'))
          .limit(50);
        if (inicio) q.where('c.receipt_date', '>=', inicio);
        // La entrada se captura alrededor de la fecha de la factura: unos días antes (llegó antes de
        // facturarse) o hasta dos meses después (factura adelantada).
        if (fechaObj) q.whereBetween('c.receipt_date', [sumarDias(fechaObj, -15), sumarDias(fechaObj, VENTANA_BUSQUEDA)]);
        else q.whereRaw(`c.receipt_date >= current_date - 120`);
        if (visibles) { if (visibles.length) q.whereIn('c.sucursal', visibles); else q.whereRaw('false'); }
        const filas = (await q) as EntradaParaIdentificar[];
        const rfcCmp = rfcBienFormado(rfcObj) ? rfcComparable(rfcObj) : null;
        candidatas = filas
          .map((e) => {
            const monto = Number(e.monto);
            const diferencia = Math.round((totalObj - monto) * 100) / 100;
            const rfcEq = rfcCmp && rfcBienFormado(e.proveedor_rfc) ? rfcComparable(e.proveedor_rfc) === rfcCmp : null;
            const nom = parecidoNombre(nombreObj, e.proveedor_nombre);
            // El RFC de Kepler falta o está mal en ~60%: el nombre también confirma. Sólo se descarta
            // cuando las dos señales dicen que es OTRO proveedor.
            const proveedor_ok = rfcEq === true || (nom != null && nom >= UMBRAL_NOMBRE_CONTPAQI) ? true
              : (rfcEq === false && (nom == null || nom < 0.3)) || (rfcEq == null && nom != null && nom < 0.3) ? false
              : null;
            return { ...e, monto, diferencia, proveedor_ok, deposits: Number(e.deposits) || 0 };
          })
          // Sólo donde se puede ESCRIBIR: proponer una entrada de una sucursal que sólo se ve terminaría
          // en un 403 al guardar.
          .filter((c) => cuadra(c.diferencia, c.monto) && c.proveedor_ok !== false && this.scope.canWrite(alcance, 'warehouse', c.sucursal))
          .sort((a, b) => a.deposits - b.deposits || Math.abs(a.diferencia) - Math.abs(b.diferencia));
      }

      const c = clasificarIdentificacion({
        hayLectura: !!uuid || total != null || !!cfdi, cfdi: !!cfdi, liga,
        sello: l?.sello, firma: l?.firma, candidatas, fechaDocumento: fechaObj,
      });
      return {
        cfdi: cfdi ? { uuid: cfdi.uuid, emisor_rfc: cfdi.emisor_rfc, emisor_nombre: cfdi.emisor_nombre, folio: cfdi.folio, total: cfdi.total, fecha: cfdi.fecha } : null,
        liga, candidatas, confianza: c.confianza, propuesta: c.propuesta, motivos: c.motivos,
      };
    });
  }

  /** Arranque del proceso de recepción (`finance.receipt_settings`): no se liga a histórico previo. */
  private async inicioRecepcion(trx: Knex.Transaction, tenantId: string): Promise<string | null> {
    if (!(await this.existeTabla(trx, 'finance', 'receipt_settings'))) return null;
    const row = (await trx('finance.receipt_settings').where({ tenant_id: tenantId })
      .first(trx.raw(`to_char(reception_start, 'YYYY-MM-DD') AS inicio`))) as { inicio: string | null } | undefined;
    return row?.inicio ?? null;
  }

  async sinOc(desde?: string, hasta?: string): Promise<EntradasSinOcResumen> {
    const tenantId = this.tenantCtx.requireTenantId();
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
    const h = hasta && ymd.test(hasta) ? hasta : hoy;
    const d = desde && ymd.test(desde) ? desde : new Date(Date.parse(h) - 29 * 864e5).toISOString().slice(0, 10);
    if (d > h) throw new BadRequestException('La fecha inicial es posterior a la final.');
    const alcance = await this.scope.current();
    const visibles = this.scope.intersect(alcance, 'warehouse', null);
    return this.tk.run(async (trx) => {
      const tieneUsuario = await this.existeColumna(trx, 'analytics', 'erp_goods_receipts', 'fecha_recepcion_usuario');
      const q = trx('analytics.erp_goods_receipts')
        .where({ tenant_id: tenantId })
        .whereNull('dup_of_folio')
        .where('monto', '>', 0)
        .whereBetween('receipt_date', [d, h])
        .groupBy('sucursal', 'usuario')
        .select('sucursal',
          trx.raw(tieneUsuario ? 'fecha_recepcion_usuario AS usuario' : 'NULL::text AS usuario'),
          trx.raw('count(*)::int AS entradas'),
          trx.raw(`count(*) FILTER (WHERE nullif(btrim(oc_folio), '') IS NULL)::int AS sin_oc`),
          trx.raw(`COALESCE(sum(monto) FILTER (WHERE nullif(btrim(oc_folio), '') IS NULL), 0)::float8 AS monto_sin_oc`))
        .orderBy([{ column: 'sin_oc', order: 'desc' }, { column: 'sucursal' }]);
      if (visibles) q.whereIn('sucursal', visibles);
      const filas = (await q) as EntradasSinOcFila[];
      return {
        desde: d, hasta: h,
        filas: filas.filter((f) => f.sin_oc > 0),
        total_entradas: filas.reduce((s, f) => s + f.entradas, 0),
        total_sin_oc: filas.reduce((s, f) => s + f.sin_oc, 0),
        monto_sin_oc: filas.reduce((s, f) => s + Number(f.monto_sin_oc), 0),
      };
    });
  }

  /** Códigos de proveedor marcados como internos en el catálogo (\`is_internal\`, RE.30). */
  private async internos(trx: Knex.Transaction, tenantId: string, codes: string[]): Promise<Set<string>> {
    const set = new Set<string>();
    if (!codes.length || !(await this.existeColumna(trx, 'catalog', 'suppliers', 'is_internal'))) return set;
    const rows = await trx('catalog.suppliers')
      .where({ tenant_id: tenantId, is_internal: true })
      .whereNull('deleted_at')
      .whereRaw('btrim(code) = ANY(?)', [[...new Set(codes.map((c) => c.trim()))]])
      .select(trx.raw('btrim(code) AS code'));
    for (const r of rows as { code: string }[]) set.add(r.code);
    return set;
  }

  /**
   * Los impuestos del CFDI elegido. ContPAQi los manda ya resumidos (`iva_trasladado`,
   * `ieps_trasladado`) más el detalle `traslados[]`; la descarga masiva sólo el detalle. Se lee el
   * resumen si está y si no se suma el detalle por clave de impuesto (002 IVA, 003 IEPS).
   */
  private async impuestos(trx: Knex.Transaction, tenantId: string, id: string) {
    const row = await trx('fiscal.cfdis').where({ tenant_id: tenantId, id }).first('impuestos');
    let imp: ImpuestosCfdi | null = row?.impuestos ?? null;
    if (typeof imp === 'string') { try { imp = JSON.parse(imp) as ImpuestosCfdi; } catch { imp = null; } }
    const traslados: TrasladoCfdi[] = Array.isArray(imp?.traslados) ? imp.traslados : [];
    const suma = (clave: string) => traslados
      .filter((t) => String(t.impuesto) === clave)
      .reduce((s, t) => s + Number(t.importe || 0), 0);
    const iva = imp?.iva_trasladado != null ? Number(imp.iva_trasladado) : (traslados.length ? suma('002') : null);
    const ieps = imp?.ieps_trasladado != null ? Number(imp.ieps_trasladado) : (traslados.length ? suma('003') : null);
    const porCuota = traslados.some((t) => String(t.impuesto) === '003' && /cuota/i.test(String(t.tipo_factor || '')));
    return { iva_trasladado: iva, ieps_trasladado: ieps, ieps_por_cuota: porCuota };
  }

  private async existeTabla(trx: Knex.Transaction, schema: string, table: string): Promise<boolean> {
    const k = `t:${schema}.${table}`;
    if (this.existe.has(k)) return true;
    const { rows } = await trx.raw('SELECT to_regclass(?) IS NOT NULL AS ok', [`${schema}.${table}`]);
    if (rows[0]?.ok) this.existe.add(k);
    return !!rows[0]?.ok;
  }

  private async existeColumna(trx: Knex.Transaction, schema: string, table: string, col: string): Promise<boolean> {
    const k = `c:${schema}.${table}.${col}`;
    if (this.existe.has(k)) return true;
    const { rows } = await trx.raw(
      `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(?) AND attname = ? AND NOT attisdropped) AS ok`,
      [`${schema}.${table}`, col]);
    if (rows[0]?.ok) this.existe.add(k);
    return !!rows[0]?.ok;
  }
}
