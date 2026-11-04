/**
 * `[LE.4.10]` — **La Ventanilla: pagar un documento de Kepler en un solo acto** (V3, V4, D18, D26; ADR-112).
 *
 * La cajera elige el X-D-26 y, si lo hay, el vale que lo ampara. El servidor RELEE el documento (el
 * importe nunca viaja desde la pantalla), arma el plan (`plan-de-pago.ts`) y, en la misma transacción:
 *
 *  · con vale aprobado: emite la orden con su código (los billetes, que la máquina entrega y el carril
 *    de CAOS asienta contra la orden) y asienta lo del cajón por pieza con el redondeo declarado;
 *  · sin vale aprobado: deja la orden «por firmar», sin código. Tesorería firma (`firmar`): ahí nace
 *    el código y se asienta lo del cajón. Antes de la firma no sale un peso (V4).
 *
 * ── Decisiones, declaradas ──────────────────────────────────────────────────────────────────
 *  · Fuente del documento: `analytics.bank_movement_legs` (la que ya usa la caja; 915 pagos de la
 *    0011 desde el 1-oct, ninguno con dos piernas). Testigo: X-D-26 0023782 = $796.73.
 *  · «Ya pagado» también mira el libro viejo (`finance.cash_ledger`, por `origen_ref` o
 *    `declared_doc_ref`): mientras conviven, un documento no se paga por los dos lados.
 *  · El asiento del cajón es de quien paga (la cajera), también cuando lo dispara la firma; quien
 *    firmó va en `meta.firmo` y en la orden (`decided_by`).
 *  · La orden y su código vencen al fin del día de México: un código no sobrevive a la jornada.
 *  · Sin la migración `20261102143213` la Ventanilla responde 503 con su nombre: el endpoint
 *    puede llegar a prod antes que la migración (expand/contract) sin escribir a medias.
 *  · La firma de quien RECIBE es su nombre (V5); la firma en pantalla es deuda con nombre (LE.6.x).
 */
import {
  BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  CUENTA, ZONAS_HOJA_GASTOS, centavosATexto, formatearDinero, pagableConBilletesCaos, pesosACentavos, valorDePiezas, warehouseName,
  type CustodiaAbierta, type PersonaDeCustodia, type RendirCustodia, type ReposicionPorConfirmar, type ResultadoRendicion, type RetiroACustodia,
  type HojaDeReposicion, type PedirReposicion, type QuienLlevaDeposito, type ZonaHojaGastos,
  type CobroEnVentanilla, type CuentaDelCobro, type EstadoDeCobro, type ExplicarSuspenso, type OrdenPorFirmar, type PartidaEnSuspenso, type ResultadoHecho, type PagoEnVentanilla, type PiezasTexto,
  type PlanDePagoVentanilla, type ResultadoCobro, type ResultadoPago, type VeredictoDePago,
} from '@megadulces/contracts';
import { traducirErrorDelLibro } from './errores';
import {
  ARREGLO_DEL_BLOQUEO, MOTIVO_BLOQUEO, planDePago, veredictoDePago, type DocumentoAPagar, type PlanDePago, type Respaldo, type ValeElegido,
} from './plan-de-pago';
import {
  CUENTAS_FIJAS, aCustodiaDesdeCajon, clasificarSuspenso, entregaRuta, gasto, otroIngreso, pagoDelCajon, regresoCustodiaAlCajon, type Contexto, type Propuesta,
} from './reglas';
import { hojaDeReposicion } from './reposicion-en-ventanilla';
import { depositoDeHoja, type DepositoBancoHoja, type PagoDeZona } from '../caja/hoja-gastos.engine';
import { consultasHoja } from '../caja/hoja-gastos.query';
import {
  clasificarCobro, eventoDeCobro, parDelCobro, type CobroClasificado, type FilaCobroRuta, type FilaCobroSucursal,
} from './cobro-en-ventanilla';
import type { UsuarioDelLibro } from './cashbook.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * `[LE.6.7]` El X-D-26 (pago a proveedor) y el X-D-60 (anticipo, Glosario). El respaldo por lote
 * (kdm5/kdxf) está medido sólo para el X-D-26: el anticipo se lee documento por documento y su respaldo
 * es «no medido», así que siempre lo firma Tesorería —un anticipo todavía no tiene compra que lo respalde—.
 */
const LLAVE_DOCUMENTO = /^([0-9]{2}(?:-[0-9]+)?)\|(X-D-26|X-D-60)\|([^|]+)\|(0011)$/;
const FIN_DEL_DIA = `((date_trunc('day', clock_timestamp() AT TIME ZONE 'America/Mexico_City') + interval '1 day')
  AT TIME ZONE 'America/Mexico_City')`;

/** Lo que la cajera capturó y se asienta al pagar (o al firmar). Vive en `withdrawal_orders.act`. */
interface ActoDePago {
  /** `[LE.6.8]` En una reposición: los X-D-26 que repone y su zona. */
  documentos?: string[];
  zona?: string;
  total_minor?: string;
  piezas_cajon: PiezasTexto;
  recibe: string;
  recibe_empleado: string | null;
  cajon_minor: string;
  redondeo_minor: string;
  beneficiario: string;
  folio: string;
  motivo_firma: string | null;
}

interface OrdenEmitida { id: string; code: string | null; state: string; repetida: boolean }

/**
 * Las dos lecturas de fuera del libro, como texto: el servicio las corre y la sonda contra prod
 * corre ESTE mismo SQL (medir una consulta parecida no prueba la que corre).
 */
export const SQL_DOCUMENTO = `
  SELECT folio, coalesce(nullif(btrim(beneficiario), ''), '(sin beneficiario)') AS beneficiario, importe::text AS importe
    FROM analytics.bank_movement_legs
   WHERE tenant_id = ? AND sucursal = ? AND doc_tipo = ? AND folio = ? AND clave_banco = ?
     AND signo < 0 AND es_traspaso = false`;
export const SQL_VALE = `
  SELECT id, coalesce(nullif(btrim(folio_solicitud), ''), left(id::text, 8)) AS folio, status, importe::text AS importe,
         aprobado_at::text AS aprobado_at
    FROM finance.expense_proofs WHERE tenant_id = ? AND id = ?`;

/**
 * `[LE.2.13]` Lo que el X-D-26 paga según Kepler, POR LOTE de pares (sucursal, folio): la cola pide
 * todos sus veredictos en un viaje y el pago de uno usa la MISMA consulta con un par (una sola
 * versión del SQL). Corrido TAL CUAL contra prod (sólo lectura, 2026-11-03) con la cola real de 14
 * días (21 documentos) + 5 testigos: gasto 80–149 ms, compra 52–93 ms, documentos 7–9 ms; los
 * testigos dan lo mismo que la versión de un documento (08/0000699 = 3 entradas de compra;
 * 08/0000707 = 6 gastos; 00/0023782 = un gasto SIN expediente en la Suite).
 *  · Gasto: `kdm5` (transferencia → gasto XA1001) → `expense_documents` (su solicitud) → el vale de
 *    `expense_proofs`; si hay varios, el aprobado por una persona, y si no, el más nuevo.
 *  · Compra: `kdxf` (transferencia → entrada A-20) con el importe de la entrada (`kdxe`) y todo lo que
 *    se le ha aplicado sin contar cargos cancelados (`kdm1.c43 = 'C'`, la trampa de ECA.7).
 *  · Filtrar ANTES con `= ANY` (superconjunto) y después exigir el par: el patrón medido en
 *    `transferencias-del-gasto.ts` (el par solo con `IN (unnest)` costaba 1.4 millones de comparaciones).
 */
export const SQL_RESPALDO_GASTO = `
  SELECT g.sucursal, g.folio, g.gasto, g.aplicado::text AS aplicado, ep.id AS vale_id, ep.folio AS vale_folio,
         ep.status AS vale_estado, ep.importe::text AS vale_importe, ep.aprobado_at::text AS vale_aprobado_at
    FROM (SELECT m.sucursal, btrim(m.c6) AS folio, btrim(m.c11) AS gasto, sum(m.c13) AS aplicado
            FROM kepler_ods.kdm5 m
           WHERE m.sucursal = ANY(?::text[]) AND btrim(m.c6) = ANY(?::text[])
             AND (m.sucursal, btrim(m.c6)) IN (SELECT * FROM unnest(?::text[], ?::text[]))
             AND btrim(m.c1) = m.sucursal AND m.c2 = 'X' AND m.c3 = 'D' AND m.c4 = 26 AND m.c5 = 1
             AND m.c8 = 'A' AND m.c9 = 10 AND m.c10 = 1
           GROUP BY 1, 2, 3) g
    LEFT JOIN LATERAL (SELECT btrim(ed.solicitud_folio) AS sol FROM analytics.expense_documents ed
                        WHERE ed.tenant_id = ? AND ed.doc_tipo = 'XA1001' AND ed.sucursal = g.sucursal AND btrim(ed.doc_folio) = g.gasto
                          AND nullif(btrim(ed.solicitud_folio), '') IS NOT NULL
                        LIMIT 1) d ON true
    LEFT JOIN LATERAL (SELECT p.id, coalesce(nullif(btrim(p.folio_solicitud), ''), left(p.id::text, 8)) AS folio, p.status,
                              p.importe, p.aprobado_at
                         FROM finance.expense_proofs p
                        WHERE p.tenant_id = ? AND p.sucursal = g.sucursal AND btrim(p.folio_solicitud) = d.sol
                        ORDER BY (p.aprobado_at IS NOT NULL) DESC, (p.status = 'rechazada'), p.created_at DESC
                        LIMIT 1) ep ON true
   ORDER BY g.sucursal, g.folio, g.gasto`;
export const SQL_RESPALDO_COMPRA = `
  WITH mio AS (
    SELECT f.sucursal, btrim(f.c6) AS folio, btrim(f.c2) AS acreedor, f.c7, f.c8, btrim(f.c9) AS doc, sum(f.c10) AS aplicado
      FROM kepler_ods.kdxf f
     WHERE f.sucursal = ANY(?::text[]) AND btrim(f.c6) = ANY(?::text[])
       AND (f.sucursal, btrim(f.c6)) IN (SELECT * FROM unnest(?::text[], ?::text[]))
       AND f.c1 = f.sucursal AND f.c4 = 26 AND f.c5 = 1 AND f.c7 = 20
     GROUP BY 1, 2, 3, 4, 5, 6)
  SELECT mio.sucursal, mio.folio, mio.doc, mio.aplicado::text AS aplicado,
         (SELECT max(e.c11) FROM kepler_ods.kdxe e
           WHERE e.sucursal = mio.sucursal AND btrim(e.c2) = mio.acreedor AND e.c3 = 'A' AND e.c4 = mio.c7 AND e.c5 = mio.c8
             AND btrim(e.c6) = mio.doc)::text AS importe_doc,
         (SELECT sum(o.c10) FROM kepler_ods.kdxf o
           WHERE o.sucursal = mio.sucursal AND o.c1 = o.sucursal AND btrim(o.c2) = mio.acreedor AND o.c7 = mio.c7 AND o.c8 = mio.c8
             AND btrim(o.c9) = mio.doc
             AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdm1 h
                              WHERE h.sucursal = o.sucursal AND h.c1 = o.sucursal AND h.c2 = 'X' AND h.c3 = 'D'
                                AND h.c4 = o.c4 AND h.c5 = o.c5 AND btrim(h.c6) = btrim(o.c6) AND h.c43 = 'C'))::text AS aplicado_total
    FROM mio
   ORDER BY mio.sucursal, mio.folio, mio.doc`;
/** `[LE.2.13]` El importe de cada documento de la cola, por lote: lo mismo que `SQL_DOCUMENTO` con la caja 0011 fija. */
export const SQL_DOCUMENTOS = `
  SELECT sucursal, folio, coalesce(nullif(btrim(beneficiario), ''), '(sin beneficiario)') AS beneficiario, importe::text AS importe
    FROM analytics.bank_movement_legs
   WHERE tenant_id = ? AND doc_tipo = 'X-D-26' AND clave_banco = '0011' AND signo < 0 AND es_traspaso = false
     AND sucursal = ANY(?::text[]) AND folio = ANY(?::text[])
     AND (sucursal, folio) IN (SELECT * FROM unnest(?::text[], ?::text[]))`;

/**
 * `[LE.6.7]` Las dos fuentes de un cobro U-A-5 de la 0011, por lote de pares `(almacen, folio)`:
 * las mismas que arman la cola de Captura. Corridas TAL CUAL en prod (sólo lectura, 2026-11-04) con
 * los 138 cobros capturados en 14 días: 102 de ruta (la ruta coincide con la capturada en los 102) y
 * 36 de sucursal, ninguno en las dos ni en ninguna; 9 ms y 5 ms. Parámetros: `[tenant, s, f, s, f]`.
 */
export const SQL_COBROS_RUTA = `
  SELECT almacen, cobro_folio AS folio, sum(importe)::numeric(18,2)::text AS importe,
         string_agg(DISTINCT regexp_replace(truck, '^ruta_0*', ''), ' · ') AS rutas,
         count(DISTINCT truck)::int AS n_rutas, count(DISTINCT fecha)::int AS n_fechas
    FROM analytics.route_collections
   WHERE tenant_id = ? AND cuenta = '0011' AND almacen = ANY(?::text[]) AND cobro_folio = ANY(?::text[])
     AND (almacen, cobro_folio) IN (SELECT * FROM unnest(?::text[], ?::text[]))
   GROUP BY almacen, cobro_folio`;
export const SQL_COBROS_SUCURSAL = `
  SELECT sucursal, folio, sum(importe)::numeric(18,2)::text AS importe, count(*)::int AS n
    FROM analytics.bank_movement_legs
   WHERE tenant_id = ? AND doc_tipo = 'U-A-5' AND clave_banco = '0011' AND signo > 0 AND es_traspaso = false
     AND sucursal = ANY(?::text[]) AND folio = ANY(?::text[])
     AND (sucursal, folio) IN (SELECT * FROM unnest(?::text[], ?::text[]))
   GROUP BY sucursal, folio`;

/**
 * `[LE.6.7]` Lo abierto en Suspenso: cada asiento de la máquina con saldo en `SUSPENSO_MXN`, sin
 * reversa y sin explicación (ni asentada ni esperando firma), con el texto y el usuario de la
 * máquina. ⚠️ NO MEDIDO en prod: el rol de lectura no lee `cashbook` (LE.5.8).
 * Parámetros: `[tenant, ref|null, ref|null, tenant, tenant, tenant]`.
 */
export const SQL_SUSPENSO = `
  WITH s AS (
    SELECT e.id AS entry_id, e.event_ref, e.value_at, e.meta->>'motivo' AS motivo, sum(l.amount_minor) AS neto
      FROM cashbook.entries e
      JOIN cashbook.entry_lines l ON l.entry_id = e.id
      JOIN cashbook.accounts a ON a.id = l.account_id
     WHERE e.tenant_id = ? AND a.code = 'SUSPENSO_MXN' AND e.event_ref LIKE 'caos:%'
       AND (?::text IS NULL OR e.event_ref = ?)
       AND NOT EXISTS (SELECT 1 FROM cashbook.entries r WHERE r.reverses_entry_id = e.id)
     GROUP BY e.id)
  SELECT s.entry_id, s.event_ref, s.value_at::text AS value_at, s.neto::text AS neto, s.motivo, m.type_label, m.ref, m.user_external
    FROM s
    LEFT JOIN analytics.caos_cash_movements m ON m.tenant_id = ? AND m.device = split_part(s.event_ref, ':', 2)
         AND m.external_id::text = split_part(s.event_ref, ':', 3)
   WHERE s.neto <> 0
     AND NOT EXISTS (SELECT 1 FROM cashbook.entries c WHERE c.tenant_id = ? AND c.event_kind = 'clasificar_suspenso'
                       AND c.event_ref = 'clasifica:' || s.event_ref)
     AND NOT EXISTS (SELECT 1 FROM cashbook.requests q WHERE q.tenant_id = ? AND q.state IN ('pendiente', 'autorizada')
                       AND q.payload->>'event_ref' = 'clasifica:' || s.event_ref)
   ORDER BY s.value_at, s.event_ref`;

/**
 * `[LE.6.8]` Quién puede llevar el depósito de una reposición (D35): la responsabilidad
 * `finanzas.caja_deposito` dada a la persona (`user_responsibilities`, el mismo patrón que AB.29).
 * Mientras nadie la tenga, la Ventanilla no deja pedir una reposición. Parámetros: `[tenant]`.
 */
export const SQL_QUIEN_LLEVA = `
  SELECT u.id::text AS usuario_id, coalesce(nullif(btrim(u.nombre), ''), u.username) AS nombre
    FROM identity.user_responsibilities ur
    JOIN identity.users u ON u.id = ur.user_id AND u.tenant_id = ur.tenant_id AND u.deleted_at IS NULL AND u.activo
   WHERE ur.tenant_id = ? AND ur.responsibility_key = 'finanzas.caja_deposito' AND ur.accion = 'suma'
     AND ur.deleted_at IS NULL AND (ur.valid_to IS NULL OR ur.valid_to >= current_date)
   ORDER BY 2`;

/**
 * `[LE.6.5]` Lo que cada persona tiene a su cargo: el saldo de su cuenta de custodia y desde cuándo
 * no vuelve a cero (la última vez que el corrido fue 0). Sin plazo que castigue (D3). Parámetros: `[tenant]`.
 * ⚠️ NO MEDIDO en prod: el rol de lectura no lee `cashbook` (LE.5.8).
 */
export const SQL_CUSTODIAS = `
  WITH m AS (
    SELECT a.id, a.holder_ref AS persona, a.name, e.seq, e.value_at,
           sum(l.amount_minor) OVER (PARTITION BY a.id ORDER BY e.seq) AS corrido
      FROM cashbook.accounts a
      JOIN cashbook.entry_lines l ON l.account_id = a.id
      JOIN cashbook.entries e ON e.id = l.entry_id
     WHERE a.tenant_id = ? AND a.class = 'custodia'),
  u AS (SELECT DISTINCT ON (id) id, persona, name, corrido FROM m ORDER BY id, seq DESC),
  c AS (SELECT id, max(seq) FILTER (WHERE corrido = 0) AS cero FROM m GROUP BY id)
  SELECT u.persona, regexp_replace(u.name, '^En custodia · ', '') AS nombre, u.corrido::text AS saldo_minor,
         (SELECT min(m.value_at) FROM m WHERE m.id = u.id AND m.seq > coalesce(c.cero, 0))::text AS desde
    FROM u JOIN c ON c.id = u.id
   WHERE u.corrido <> 0
   ORDER BY 4 NULLS LAST, 2`;

export interface FilaDocumento { folio: string; beneficiario: string; importe: string }
export interface FilaVale { id: string; folio: string; status: string; importe: string; aprobado_at: string | null }
export interface FilaDocumentoLote extends FilaDocumento { sucursal: string }
export interface FilaRespaldoGasto {
  sucursal: string; folio: string; gasto: string; aplicado: string; vale_id: string | null; vale_folio: string | null; vale_estado: string | null;
  vale_importe: string | null; vale_aprobado_at: string | null;
}
export interface FilaRespaldoCompra { sucursal: string; folio: string; doc: string; aplicado: string; importe_doc: string | null; aplicado_total: string | null }
type ValeConId = ValeElegido & { id: string };

function sumaDePiezas(p: PiezasTexto | undefined): bigint {
  if (!p || Object.keys(p).length === 0) return 0n;
  return valorDePiezas(Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Number(v)])), 'MXN');
}

@Injectable()
export class CashbookVentanillaService {
  private readonly logger = new Logger(CashbookVentanillaService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private quien(u: UsuarioDelLibro | null | undefined): string {
    if (!u?.id || !UUID.test(u.id)) throw new BadRequestException({ codigo: 'sin_usuario', mensaje: 'No se pudo identificar quién hace el movimiento.' });
    return u.id;
  }

  private llave(k: string | undefined): string {
    if (!k || !UUID.test(k)) {
      throw new BadRequestException({ codigo: 'sin_idempotency_key', mensaje: 'Cada pago lleva el encabezado Idempotency-Key (un uuid), para que un reintento no lo duplique.' });
    }
    return k.toLowerCase();
  }

  private run<T>(fn: (trx: Knex.Transaction, tenantId: string) => Promise<T>): Promise<T> {
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run((trx) => fn(trx, tenantId)).catch((e: unknown) => traducirErrorDelLibro(e));
  }

  private async exigeVentanilla(trx: Knex.Transaction): Promise<void> {
    const ok = (await trx.raw(`SELECT to_regprocedure('cashbook.sign_order(uuid, uuid, uuid, timestamptz)') IS NOT NULL AS ok`)).rows[0].ok;
    if (!ok) {
      throw new ServiceUnavailableException({ codigo: 'ventanilla_sin_migracion',
        mensaje: 'La Ventanilla todavía no está habilitada en esta base (falta la migración 20261102143213).' });
    }
  }

  /** Las lecturas de fuera del libro. `protected`: la prueba contra base real las sustituye (las tablas no existen ahí). */
  protected async filasDelDocumento(trx: Knex.Transaction, params: string[]): Promise<FilaDocumento[]> {
    return (await trx.raw(SQL_DOCUMENTO, params)).rows as FilaDocumento[];
  }

  protected async filaDelVale(trx: Knex.Transaction, tenantId: string, valeId: string): Promise<FilaVale | undefined> {
    return (await trx.raw(SQL_VALE, [tenantId, valeId])).rows[0] as FilaVale | undefined;
  }

  /** `[LE.2.13]` `null` = no hay ODS de Kepler en esta base: el respaldo es «no medido», nunca «no paga nada». */
  protected async filasDelRespaldo(trx: Knex.Transaction, tenantId: string, pares: ReadonlyArray<[string, string]>)
    : Promise<{ gastos: FilaRespaldoGasto[]; compras: FilaRespaldoCompra[] } | null> {
    const hay = (await trx.raw(`SELECT (to_regclass('kepler_ods.kdm5') IS NOT NULL AND to_regclass('kepler_ods.kdxf') IS NOT NULL
      AND to_regclass('kepler_ods.kdxe') IS NOT NULL AND to_regclass('kepler_ods.kdm1') IS NOT NULL
      AND to_regclass('analytics.expense_documents') IS NOT NULL) AS ok`)).rows[0]?.ok === true;
    if (!hay) return null;
    const s = pares.map((p) => p[0]), f = pares.map((p) => p[1]);
    const gastos = (await trx.raw(SQL_RESPALDO_GASTO, [s, f, s, f, tenantId, tenantId])).rows as FilaRespaldoGasto[];
    const compras = (await trx.raw(SQL_RESPALDO_COMPRA, [s, f, s, f])).rows as FilaRespaldoCompra[];
    return { gastos, compras };
  }

  /** `[LE.2.13]` El importe de los documentos de la cola, por lote. `protected`: la prueba contra base real lo sustituye. */
  protected async filasDeDocumentos(trx: Knex.Transaction, tenantId: string, pares: ReadonlyArray<[string, string]>): Promise<FilaDocumentoLote[]> {
    const s = pares.map((p) => p[0]), f = pares.map((p) => p[1]);
    return (await trx.raw(SQL_DOCUMENTOS, [tenantId, s, f, s, f])).rows as FilaDocumentoLote[];
  }

  /**
   * `[LE.2.13]` El respaldo del documento y sus vales (`undefined` = sin ODS: no medido). Una entrada cuyo
   * importe Kepler no tiene no se puede verificar: ese documento cae a «ninguno» (firma Tesorería), no a «cuadra».
   */
  private async respaldo(trx: Knex.Transaction, tenantId: string, origenRef: string): Promise<{ respaldo: Respaldo | undefined; vales: ValeConId[] }> {
    const [, sucursal, tipo, folio] = LLAVE_DOCUMENTO.exec(origenRef) as RegExpExecArray;
    if (tipo !== 'X-D-26') return { respaldo: undefined, vales: [] };
    return (await this.respaldosDe(trx, tenantId, [[sucursal, folio]])).get(`${sucursal}|${folio}`) ?? { respaldo: undefined, vales: [], detalle: [] };
  }

  /**
   * `[LE.2.13]` El respaldo de varios documentos en un viaje, por `sucursal|folio` (`undefined` = sin
   * ODS: no medido). Una entrada cuyo importe Kepler no tiene no se puede verificar: ese documento cae
   * a «ninguno» (firma Tesorería), no a «cuadra».
   */
  private async respaldosDe(trx: Knex.Transaction, tenantId: string, pares: ReadonlyArray<[string, string]>)
    : Promise<Map<string, { respaldo: Respaldo | undefined; vales: ValeConId[]; detalle: VeredictoDePago['detalle'] }>> {
    const out = new Map<string, { respaldo: Respaldo | undefined; vales: ValeConId[]; detalle: VeredictoDePago['detalle'] }>();
    const f = pares.length ? await this.filasDelRespaldo(trx, tenantId, pares) : null;
    for (const [sucursal, folio] of pares) {
      const k = `${sucursal}|${folio}`;
      // Sin ODS no se afirma «Kepler no dice qué paga»: no se midió. Queda la regla de siempre (el vale de la cajera).
      if (!f) { out.set(k, { respaldo: undefined, vales: [], detalle: [] }); continue; }
      const gs = f.gastos.filter((g) => g.sucursal === sucursal && g.folio === folio);
      const cs = f.compras.filter((c) => c.sucursal === sucursal && c.folio === folio);
      if (gs.length) {
        const gastos = gs.map((g) => ({
          folio: g.gasto,
          vale: g.vale_id ? { id: g.vale_id, folio: String(g.vale_folio), estado: String(g.vale_estado),
            importeCentavos: pesosACentavos(String(g.vale_importe ?? '0')), aprobadoAt: g.vale_aprobado_at } : null,
        }));
        out.set(k, { respaldo: { tipo: 'gasto', aplicadoCentavos: gs.reduce((t, g) => t + pesosACentavos(g.aplicado), 0n), gastos },
          vales: gastos.flatMap((g) => (g.vale ? [g.vale] : [])),
          detalle: gs.map((g, i) => ({ tipo: 'gasto' as const, folio: g.gasto, aplicado_minor: centavosATexto(pesosACentavos(g.aplicado)),
            vale_folio: g.vale_folio ?? null, aprobado: gastos[i].vale ? gastos[i].vale?.estado !== 'rechazada' && !!gastos[i].vale?.aprobadoAt : null })) });
      } else if (cs.length && cs.every((c) => c.importe_doc !== null && c.aplicado_total !== null)) {
        const pagadosDeMas = cs.filter((c) => pesosACentavos(String(c.aplicado_total)) > pesosACentavos(String(c.importe_doc))).length;
        out.set(k, { respaldo: { tipo: 'compra', aplicadoCentavos: cs.reduce((t, c) => t + pesosACentavos(c.aplicado), 0n),
          documentos: cs.length, pagadosDeMas }, vales: [],
          detalle: cs.map((c) => ({ tipo: 'entrada' as const, folio: c.doc, aplicado_minor: centavosATexto(pesosACentavos(c.aplicado)),
            vale_folio: null, aprobado: null })) });
      } else {
        out.set(k, { respaldo: { tipo: 'ninguno' }, vales: [], detalle: [] });
      }
    }
    return out;
  }

  /**
   * `[LE.2.13]` Los veredictos de la cola «Por pagar hoy», por lote: el mismo motor que `pagar`
   * (`veredictoDePago`), con el vale que pone Kepler. Lo que no se puede leer se dice por fila
   * (`documento_invalido`, `documento_inexistente`, `documento_ambiguo`), nunca se omite.
   */
  async veredictos(docs: string[] | undefined): Promise<VeredictoDePago[]> {
    const lista = [...new Set((docs ?? []).map((d) => String(d ?? '').trim()).filter(Boolean))];
    if (lista.length > 200) throw new BadRequestException({ codigo: 'demasiados_documentos', mensaje: 'Se piden hasta 200 documentos a la vez.' });
    return this.run(async (trx, tenantId) => {
      const llaves = lista.map((d) => ({ d, m: LLAVE_DOCUMENTO.exec(d) }));
      const pares = llaves.filter((x) => x.m && x.m[2] === 'X-D-26').map((x) => [x.m![1], x.m![3]] as [string, string]);
      const docsLote = pares.length ? await this.filasDeDocumentos(trx, tenantId, pares) : [];
      // El anticipo (X-D-60), uno por uno: son pocos (3 en 30 días, medido el 2026-11-04) y su folio puede repetir el de un X-D-26.
      const anticipos = new Map<string, FilaDocumento[]>();
      for (const x of llaves) if (x.m && x.m[2] === 'X-D-60') anticipos.set(x.d, await this.filasDelDocumento(trx, [tenantId, x.m[1], 'X-D-60', x.m[3], '0011']));
      const respaldos = await this.respaldosDe(trx, tenantId, pares);
      const ya = new Map<string, { ordenado: boolean; pagado: boolean }>(
        ((await trx.raw(`
          SELECT d AS ref,
                 EXISTS (SELECT 1 FROM cashbook.withdrawal_orders o
                          WHERE o.tenant_id = ? AND o.source_ref = d AND o.state IN ('por_firmar','vigente','usada')) AS ordenado,
                 EXISTS (SELECT 1 FROM finance.cash_ledger l
                          WHERE l.tenant_id = ? AND (l.origen_ref = d OR l.declared_doc_ref = d)
                            AND l.deleted_at IS NULL AND l.estado <> 'cancelado') AS pagado
            FROM unnest(?::text[]) AS d`, [tenantId, tenantId, lista])).rows as Array<{ ref: string; ordenado: boolean; pagado: boolean }>)
          .map((r) => [r.ref, { ordenado: r.ordenado, pagado: r.pagado }]));
      return llaves.map(({ d, m }): VeredictoDePago => {
        const base = { origen_ref: d, respaldo: 'no_medido' as const, puede: false, requiere_firma: false, arreglo: null, detalle: [] };
        if (!m) return { ...base, bloqueo: 'documento_invalido', motivo: 'La Ventanilla paga un X-D-26 o un X-D-60 de la caja 0011.' };
        const filas = m[2] === 'X-D-60' ? (anticipos.get(d) ?? []) : docsLote.filter((x) => x.sucursal === m[1] && x.folio === m[3]);
        if (filas.length === 0) return { ...base, bloqueo: 'documento_inexistente', motivo: 'Kepler no tiene ese documento como egreso de la caja.' };
        if (filas.length > 1) return { ...base, bloqueo: 'documento_ambiguo', motivo: 'Ese documento tiene más de un renglón en Kepler: no se paga hasta aclararlo.' };
        const r = m[2] === 'X-D-26' ? respaldos.get(`${m[1]}|${m[3]}`) : undefined;
        const v = veredictoDePago(pesosACentavos(filas[0].importe), { yaOrdenado: !!ya.get(d)?.ordenado, yaPagado: !!ya.get(d)?.pagado, respaldo: r?.respaldo });
        const res = r?.respaldo;
        return {
          origen_ref: d,
          respaldo: res ? res.tipo : 'no_medido',
          puede: v.bloqueo === null,
          requiere_firma: v.bloqueo === null && v.requiereFirma,
          bloqueo: v.bloqueo,
          motivo: v.bloqueo ? MOTIVO_BLOQUEO[v.bloqueo] : v.requiereFirma ? v.motivoFirma : null,
          arreglo: v.bloqueo ? ARREGLO_DEL_BLOQUEO[v.bloqueo] ?? null : null,
          detalle: r?.detalle ?? [],
        };
      });
    });
  }

  /** El X-D-26 tal como lo tiene Kepler. Nunca el importe de la pantalla. */
  private async documento(trx: Knex.Transaction, tenantId: string, origenRef: string, cuenta: string | null): Promise<DocumentoAPagar> {
    const m = LLAVE_DOCUMENTO.exec(String(origenRef ?? '').trim());
    if (!m) {
      throw new BadRequestException({ codigo: 'documento_invalido', mensaje: 'La Ventanilla paga un X-D-26 o un X-D-60 de la Caja General (sucursal|tipo|folio|0011).' });
    }
    const [, sucursal, docTipo, folio, clave] = m;
    const filas = await this.filasDelDocumento(trx, [tenantId, sucursal, docTipo, folio, clave]);
    if (filas.length === 0) throw new NotFoundException({ codigo: 'documento_inexistente', mensaje: 'Kepler no tiene ese documento como egreso de la Caja General.' });
    if (filas.length > 1) {
      throw new UnprocessableEntityException({ codigo: 'documento_ambiguo', mensaje: 'Ese documento tiene más de un renglón en Kepler: no se paga hasta aclararlo.' });
    }
    const f = filas[0];
    return { origenRef: m[0], folio: f.folio, beneficiario: f.beneficiario, importeCentavos: pesosACentavos(f.importe), cuentaKepler: cuenta };
  }

  private async vale(trx: Knex.Transaction, tenantId: string, valeId: string | undefined): Promise<ValeElegido & { id: string } | null> {
    if (!valeId) return null;
    if (!UUID.test(valeId)) throw new BadRequestException({ codigo: 'vale_invalido', mensaje: 'El vale se elige de la lista de aprobación de gastos.' });
    const v = await this.filaDelVale(trx, tenantId, valeId);
    if (!v) throw new NotFoundException({ codigo: 'vale_inexistente', mensaje: 'No existe ese vale.' });
    return { id: v.id, folio: v.folio, estado: v.status, importeCentavos: pesosACentavos(v.importe), aprobadoAt: v.aprobado_at };
  }

  private async yaTomado(trx: Knex.Transaction, tenantId: string, origenRef: string): Promise<{ ordenado: boolean; pagado: boolean }> {
    const r = (await trx.raw(`
      SELECT EXISTS (SELECT 1 FROM cashbook.withdrawal_orders
                      WHERE tenant_id = ? AND source_ref = ? AND state IN ('por_firmar','vigente','usada')) AS ordenado,
             EXISTS (SELECT 1 FROM finance.cash_ledger
                      WHERE tenant_id = ? AND (origen_ref = ? OR declared_doc_ref = ?)
                        AND deleted_at IS NULL AND estado <> 'cancelado') AS pagado`,
    [tenantId, origenRef, tenantId, origenRef, origenRef])).rows[0] as { ordenado: boolean; pagado: boolean };
    return r;
  }

  private async armarPlan(trx: Knex.Transaction, tenantId: string, origenRef: string, cuenta: string | null, valeId: string | undefined) {
    const doc = await this.documento(trx, tenantId, origenRef, cuenta?.trim() || null);
    const { respaldo, vales } = await this.respaldo(trx, tenantId, doc.origenRef);
    let vale = await this.vale(trx, tenantId, valeId);
    // `[LE.2.13]` El vale lo dice Kepler: el que elija la cajera tiene que ser uno de los del documento.
    if (vale && respaldo?.tipo === 'gasto' && !vales.some((v) => v.id === vale?.id)) {
      throw new BadRequestException({ codigo: 'vale_no_corresponde', mensaje: `El vale ${vale.folio} no es de ningún gasto que pague este documento.` });
    }
    if (!vale && vales.length === 1) vale = vales[0];
    const ya = await this.yaTomado(trx, tenantId, doc.origenRef);
    return { plan: planDePago(doc, { yaOrdenado: ya.ordenado, yaPagado: ya.pagado, vale, respaldo }), vale, vales };
  }

  private static aTexto(p: PlanDePago): PlanDePagoVentanilla {
    return {
      origen_ref: p.documento.origenRef, folio: p.documento.folio, beneficiario: p.documento.beneficiario,
      importe_minor: centavosATexto(p.documento.importeCentavos), pagable_minor: centavosATexto(p.pagableCentavos),
      redondeo_minor: centavosATexto(p.redondeoCentavos), maquina_minor: centavosATexto(p.maquinaCentavos),
      cajon_minor: centavosATexto(p.cajonCentavos), requiere_firma: p.requiereFirma, motivo_firma: p.motivoFirma,
      bloqueo: p.bloqueo, motivo_bloqueo: p.bloqueo ? MOTIVO_BLOQUEO[p.bloqueo] : null,
    };
  }

  /** Lo que se va a pagar, sin escribir nada: el mismo motor que `pagar`. */
  async plan(origenRef: string, cuentaKepler: string | undefined, valeId: string | undefined): Promise<PlanDePagoVentanilla> {
    return this.run(async (trx, tenantId) => {
      await this.exigeVentanilla(trx);
      return CashbookVentanillaService.aTexto((await this.armarPlan(trx, tenantId, origenRef, cuentaKepler ?? null, valeId)).plan);
    });
  }

  /** Asienta lo del cajón de un pago (si hay algo que asentar). La cajera es quien paga. */
  private async asentarCajon(trx: Knex.Transaction, orden: { id: string; documento: string; concepto: string; cajera: string;
    llave: string | null; acto: ActoDePago; firmo?: string }): Promise<string | null> {
    const ctx: Contexto = { actor: { kind: 'persona', user_id: orden.cajera }, valueAt: new Date().toISOString(),
      ...(orden.llave ? { requestId: orden.llave } : {}) };
    const p = pagoDelCajon({ concepto: orden.concepto, documento: orden.documento, orden: orden.id, piezas: orden.acto.piezas_cajon,
      redondeo: BigInt(orden.acto.redondeo_minor), recibe: orden.acto.recibe },
    ctx, orden.firmo ? { meta: { firmo: orden.firmo } } : {});
    if (!p) return null;
    for (const c of p.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...c, user_id: orden.cajera })]);
    return (await trx.raw('SELECT cashbook.post_entry(?::jsonb) AS id', [JSON.stringify(p.asiento)])).rows[0].id as string;
  }

  private async resultadoDe(trx: Knex.Transaction, ordenId: string): Promise<ResultadoPago> {
    const o = (await trx.raw(`
      SELECT o.id, o.code, o.state, o.amount_minor::text AS amount_minor, o.act, o.expires_at::text AS vence,
             (SELECT e.id FROM cashbook.entries e WHERE e.tenant_id = o.tenant_id AND e.event_kind IN ('gasto', 'retiro_a_custodia')
                AND e.event_ref = 'pago:' || o.id::text ORDER BY e.event_version DESC LIMIT 1) AS entry_id
        FROM cashbook.withdrawal_orders o WHERE o.id = ?`, [ordenId])).rows[0] as
      { id: string; code: string | null; state: string; amount_minor: string; act: ActoDePago | null; vence: string; entry_id: string | null } | undefined;
    if (!o) throw new NotFoundException({ codigo: 'cashbook_orden_inexistente', mensaje: 'No existe esa orden.' });
    if (o.state === 'por_firmar') return { estado: 'por_firmar', orden_id: o.id, motivo: o.act?.motivo_firma ?? 'espera la firma de Tesorería' };
    if (o.state === 'anulada' || o.state === 'vencida') {
      throw new ConflictException({ codigo: `orden_${o.state}`, mensaje: `Esa orden está ${o.state}: el documento se vuelve a pagar desde el principio.` });
    }
    return { estado: 'pagado', orden_id: o.id, codigo: o.amount_minor === '0' ? null : o.code, maquina_minor: o.amount_minor,
      cajon_minor: o.act?.cajon_minor ?? '0', redondeo_minor: o.act?.redondeo_minor ?? '0', entry_id: o.entry_id, vence: o.vence };
  }

  /** Pagar un X-D-26: con vale aprobado sale el código; sin él, queda por firmar. */
  async pagar(body: PagoEnVentanilla, usuario: UsuarioDelLibro, idempotencyKey: string | undefined): Promise<ResultadoPago> {
    const cajera = this.quien(usuario);
    const key = this.llave(idempotencyKey);
    const recibe = String(body?.recibe?.nombre ?? '').trim();
    if (!recibe) throw new BadRequestException({ codigo: 'sin_quien_recibe', mensaje: 'Falta quién recibe el dinero (V5: con nombre).' });
    return this.run(async (trx, tenantId) => {
      await this.exigeVentanilla(trx);
      // Un reintento con la misma llave devuelve lo mismo, aunque el documento ya esté tomado (por él).
      const previa = (await trx.raw(`SELECT id, source_ref FROM cashbook.withdrawal_orders WHERE tenant_id = ? AND idempotency_key = ?`,
        [tenantId, key])).rows[0] as { id: string; source_ref: string } | undefined;
      if (previa) {
        if (previa.source_ref !== String(body.origen_ref ?? '').trim()) {
          throw new ConflictException({ codigo: 'cashbook_peticion_reusada', mensaje: 'Esa petición ya se registró con otro contenido.' });
        }
        return this.resultadoDe(trx, previa.id);
      }

      const { plan, vale, vales } = await this.armarPlan(trx, tenantId, body.origen_ref, body.cuenta_kepler ?? null, body.vale_id);
      if (plan.bloqueo) {
        const cuerpo = { codigo: plan.bloqueo, mensaje: MOTIVO_BLOQUEO[plan.bloqueo] };
        if (plan.bloqueo === 'ya_ordenado' || plan.bloqueo === 'ya_pagado') throw new ConflictException(cuerpo);
        throw new UnprocessableEntityException(cuerpo);
      }
      const piezas = body.piezas_cajon ?? {};
      const contado = sumaDePiezas(piezas);
      if (contado !== plan.cajonCentavos) {
        throw new UnprocessableEntityException({ codigo: 'cajon_no_cuadra',
          mensaje: `Del cajón salen ${formatearDinero(plan.cajonCentavos)}: las piezas suman ${formatearDinero(contado)}.` });
      }

      const acto: ActoDePago = {
        piezas_cajon: piezas, recibe, recibe_empleado: body.recibe?.empleado?.trim() || null,
        cajon_minor: centavosATexto(plan.cajonCentavos), redondeo_minor: centavosATexto(plan.redondeoCentavos),
        beneficiario: plan.documento.beneficiario, folio: plan.documento.folio, motivo_firma: plan.motivoFirma,
      };
      const concepto = plan.documento.cuentaKepler as string;
      const vence = (await trx.raw(`SELECT ${FIN_DEL_DIA} AS fin`)).rows[0].fin as Date;
      const o = (await trx.raw('SELECT cashbook.issue_order(?::jsonb) AS o', [JSON.stringify({
        kind: 'pago', amount_minor: centavosATexto(plan.maquinaCentavos), source_ref: plan.documento.origenRef,
        classification: { tipo: 'pago', concepto, documento: plan.documento.origenRef, ...(vale ? { vale: vale.id } : {}),
          // `[LE.2.13]` Un documento que paga varios gastos guarda todos sus vales; el «una vez» de la base mira `vale`.
          ...(vales.length > 1 ? { vales: vales.map((v) => v.id) } : {}) },
        actor: { kind: 'persona', user_id: cajera }, expires_at: new Date(vence).toISOString(),
        por_firmar: plan.requiereFirma, act: acto, idempotency_key: key,
      })])).rows[0].o as OrdenEmitida;

      if (plan.requiereFirma) {
        this.logger.log(`[LE.4.10] ${plan.documento.origenRef} por firmar (${plan.motivoFirma})`);
        return { estado: 'por_firmar', orden_id: o.id, motivo: plan.motivoFirma ?? 'espera la firma de Tesorería' };
      }
      await this.asentarCajon(trx, { id: o.id, documento: plan.documento.origenRef, concepto, cajera, llave: key, acto });
      return this.resultadoDe(trx, o.id);
    });
  }

  /** Tesorería firma: nace el código y se asienta lo del cajón, a nombre de quien paga. */
  async firmar(ordenId: string, usuario: UsuarioDelLibro): Promise<ResultadoPago> {
    const firma = this.quien(usuario);
    if (!UUID.test(String(ordenId))) throw new BadRequestException({ codigo: 'orden_invalida', mensaje: 'Esa no es una orden.' });
    return this.run(async (trx) => {
      await this.exigeVentanilla(trx);
      const r = (await trx.raw(`SELECT cashbook.sign_order(?, ?, NULL, ${FIN_DEL_DIA}) AS r`, [ordenId, firma])).rows[0].r as {
        id: string; kind: string; source_ref: string; classification: { concepto: string }; act: ActoDePago | null;
        issued_by: string; idempotency_key: string | null };
      if (r.kind === 'pago' && r.act) {
        await this.asentarCajon(trx, { id: r.id, documento: r.source_ref, concepto: r.classification.concepto, cajera: r.issued_by,
          llave: r.idempotency_key, acto: r.act, firmo: firma });
      }
      // `[LE.6.8]` En una reposición, lo del cajón se va con quien lleva el depósito (su custodia), por pieza.
      if (r.kind === 'reposicion' && r.act && BigInt(r.act.cajon_minor ?? '0') > 0n && r.act.recibe_empleado) {
        const ctx: Contexto = { actor: { kind: 'persona', user_id: r.issued_by }, valueAt: new Date().toISOString() };
        const p = aCustodiaDesdeCajon({ empleado: r.act.recibe_empleado, nombre: r.act.recibe, piezas: r.act.piezas_cajon,
          para: `reposición ${r.source_ref.split(':')[1] ?? ''}` }, ctx, { event_ref: `pago:${r.id}`, meta: { orden: r.id, firmo: firma } });
        for (const c of p.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...c, user_id: r.issued_by })]);
        await trx.raw('SELECT cashbook.post_entry(?::jsonb)', [JSON.stringify(p.asiento)]);
      }
      this.logger.log(`[LE.4.10] orden ${r.id} firmada por ${usuario.username ?? firma}`);
      return this.resultadoDe(trx, r.id);
    });
  }

  async rechazar(ordenId: string, nota: string | undefined, usuario: UsuarioDelLibro): Promise<void> {
    const firma = this.quien(usuario);
    if (!UUID.test(String(ordenId))) throw new BadRequestException({ codigo: 'orden_invalida', mensaje: 'Esa no es una orden.' });
    await this.run(async (trx) => {
      await this.exigeVentanilla(trx);
      await trx.raw('SELECT cashbook.reject_order(?, ?, ?)', [ordenId, firma, nota ?? '']);
    });
  }

  /** Lo que espera la firma de Tesorería, lo más viejo primero (es lo que más espera la ventanilla). */
  async porFirmar(): Promise<OrdenPorFirmar[]> {
    return this.run(async (trx, tenantId) => {
      await this.exigeVentanilla(trx);
      const filas = (await trx.raw(`
        SELECT o.id, o.kind, o.source_ref, o.amount_minor::text AS amount_minor, o.act, o.created_at::text AS created_at,
               o.expires_at::text AS expires_at, coalesce(u.username, o.issued_by::text) AS pedida_por
          FROM cashbook.withdrawal_orders o
          LEFT JOIN identity.users u ON u.tenant_id = o.tenant_id AND u.id = o.issued_by
         WHERE o.tenant_id = ? AND o.state = 'por_firmar' AND o.expires_at > clock_timestamp()
         ORDER BY o.created_at`, [tenantId])).rows as {
        id: string; kind: string; source_ref: string | null; amount_minor: string; act: ActoDePago | null;
        created_at: string; expires_at: string; pedida_por: string }[];
      return filas.map((f) => ({
        id: f.id, kind: f.kind, origen_ref: f.source_ref, beneficiario: f.act?.beneficiario ?? null,
        maquina_minor: f.amount_minor, cajon_minor: f.act?.cajon_minor ?? '0', redondeo_minor: f.act?.redondeo_minor ?? '0',
        recibe: f.act?.recibe ?? null, motivo_firma: f.act?.motivo_firma ?? null,
        pedida_por: f.pedida_por, pedida_at: f.created_at, vence: f.expires_at,
      }));
    });
  }

  // ── `[LE.6.7]` Recibir un cobro (R3): la ruta o la sucursal entrega, la cajera cuenta por pieza ──

  /** Las dos fuentes de un cobro, por lote. `protected`: la prueba contra base real las sustituye. */
  protected async filasDeCobros(trx: Knex.Transaction, tenantId: string, pares: ReadonlyArray<[string, string]>)
    : Promise<{ ruta: FilaCobroRuta[]; sucursal: FilaCobroSucursal[] }> {
    const s = pares.map((p) => p[0]);
    const f = pares.map((p) => p[1]);
    const ruta = (await trx.raw(SQL_COBROS_RUTA, [tenantId, s, f, s, f])).rows as FilaCobroRuta[];
    const sucursal = (await trx.raw(SQL_COBROS_SUCURSAL, [tenantId, s, f, s, f])).rows as FilaCobroSucursal[];
    return { ruta, sucursal };
  }

  private async clasificados(trx: Knex.Transaction, tenantId: string, refs: readonly string[]): Promise<Map<string, CobroClasificado>> {
    const pares = refs.map((r) => parDelCobro(r)).filter((p): p is [string, string] => !!p);
    const { ruta, sucursal } = pares.length ? await this.filasDeCobros(trx, tenantId, pares) : { ruta: [], sucursal: [] };
    const porRuta = new Map(ruta.map((r) => [`${r.almacen}|${r.folio}`, r]));
    const porSucursal = new Map(sucursal.map((r) => [`${r.sucursal}|${r.folio}`, r]));
    const out = new Map<string, CobroClasificado>();
    for (const ref of refs) {
      const p = parDelCobro(ref);
      out.set(ref, p ? clasificarCobro(porRuta.get(p.join('|')), porSucursal.get(p.join('|')))
        : { tipo: 'detenido', esperado: null, motivo: 'No es un cobro de la Caja General (almacén|U-A-5|folio|0011).' });
    }
    return out;
  }

  /**
   * Lo que ya está recibido: en el libro nuevo (asiento, o solicitud que espera firma o ya firmada) o,
   * mientras conviven, en el viejo (`finance.cash_ledger`). Un documento se recibe una vez.
   */
  private async recibidos(trx: Knex.Transaction, tenantId: string, refs: readonly string[]): Promise<Set<string>> {
    if (!refs.length) return new Set();
    const filas = (await trx.raw(`
      SELECT r AS ref FROM unnest(?::text[]) r
       WHERE EXISTS (SELECT 1 FROM cashbook.entries e WHERE e.tenant_id = ? AND e.event_kind IN ('entrega_ruta', 'otro_ingreso')
                       AND e.event_ref = 'cobro:' || r)
          OR EXISTS (SELECT 1 FROM cashbook.requests q WHERE q.tenant_id = ? AND q.state IN ('pendiente', 'autorizada')
                       AND q.payload->>'event_ref' = 'cobro:' || r)
          OR EXISTS (SELECT 1 FROM finance.cash_ledger l WHERE l.tenant_id = ? AND l.origen_ref = r
                       AND l.deleted_at IS NULL AND l.estado <> 'cancelado')`,
    [[...refs], tenantId, tenantId, tenantId])).rows as { ref: string }[];
    return new Set(filas.map((f) => f.ref));
  }

  /** Cómo está cada cobro de la cola, en un viaje (hasta 200): de ruta, de sucursal o detenido, y si ya se recibió. */
  async estadoDeCobros(docs: string[] | undefined): Promise<EstadoDeCobro[]> {
    const refs = [...new Set((docs ?? []).map((d) => String(d).trim()).filter(Boolean))];
    if (refs.length > 200) throw new BadRequestException({ codigo: 'demasiados_documentos', mensaje: 'Hasta 200 cobros por consulta.' });
    if (!refs.length) return [];
    return this.run(async (trx, tenantId) => {
      const c = await this.clasificados(trx, tenantId, refs);
      const ya = await this.recibidos(trx, tenantId, refs);
      return refs.map((ref): EstadoDeCobro => {
        const k = c.get(ref) as CobroClasificado;
        return { origen_ref: ref, tipo: k.tipo, ruta: k.tipo === 'ruta' ? k.ruta : null,
          esperado_minor: k.esperado === null ? null : centavosATexto(k.esperado), recibido: ya.has(ref),
          motivo: k.tipo === 'detenido' ? k.motivo : null };
      });
    });
  }

  /**
   * Recibir un cobro: lo contado por pieza entra al cajón en un acto. De ruta, contra lo que la ruta
   * debe rendir (E-04: si faltó, la ruta lo sigue debiendo); de sucursal, como otro ingreso (D17).
   * El importe de Kepler no viaja: lo relee el servidor, y la diferencia se declara, no se ajusta.
   */
  async recibir(body: CobroEnVentanilla, usuario: UsuarioDelLibro, idempotencyKey: string | undefined): Promise<ResultadoCobro> {
    const cajera = this.quien(usuario);
    const key = this.llave(idempotencyKey);
    const entrega = String(body?.entrega?.nombre ?? '').trim();
    if (!entrega) throw new BadRequestException({ codigo: 'sin_quien_entrega', mensaje: 'Falta quién entrega el dinero (V5: con nombre).' });
    const piezas: PiezasTexto = body?.piezas ?? {};
    const contado = sumaDePiezas(piezas);
    if (contado <= 0n) throw new BadRequestException({ codigo: 'sin_piezas', mensaje: 'Lo que se recibe se cuenta por pieza (V7).' });
    const ref = String(body?.origen_ref ?? '').trim();
    if (!parDelCobro(ref)) {
      throw new BadRequestException({ codigo: 'cobro_invalido', mensaje: 'La Ventanilla recibe un cobro de la Caja General (almacén|U-A-5|folio|0011).' });
    }
    return this.run(async (trx, tenantId) => {
      // Un reintento con la misma llave devuelve lo mismo (la base también lo garantiza, I12).
      const previa = await this.cobroPrevio(trx, tenantId, key);
      if (previa) {
        if (previa.event_ref !== eventoDeCobro(ref)) {
          throw new ConflictException({ codigo: 'cashbook_peticion_reusada', mensaje: 'Esa petición ya se registró con otro contenido.' });
        }
        return previa.resultado;
      }
      const c = (await this.clasificados(trx, tenantId, [ref])).get(ref) as CobroClasificado;
      if (c.tipo === 'detenido') {
        if (c.esperado === null) throw new NotFoundException({ codigo: 'cobro_detenido', mensaje: c.motivo });
        throw new UnprocessableEntityException({ codigo: 'cobro_detenido', mensaje: c.motivo });
      }
      if ((await this.recibidos(trx, tenantId, [ref])).has(ref)) {
        throw new ConflictException({ codigo: 'ya_recibido', mensaje: 'Ese cobro ya está recibido: no entra dos veces.' });
      }
      const diferencia = contado - c.esperado;
      const cuenta: CuentaDelCobro = {
        tipo: c.tipo, ruta: c.tipo === 'ruta' ? c.ruta : null, contado_minor: centavosATexto(contado),
        esperado_minor: centavosATexto(c.esperado), diferencia_minor: centavosATexto(diferencia),
        es_redondeo: diferencia !== 0n && diferencia > -50n && diferencia < 50n,
      };
      const ctx: Contexto = { actor: { kind: 'persona', user_id: cajera }, valueAt: new Date().toISOString(), requestId: key };
      // Lo que se contestó va en `meta`: un reintento lo devuelve tal cual, sin volver a leer Kepler.
      const extra = { event_ref: eventoDeCobro(ref), meta: { origen: 'ventanilla', documento: ref, entrega,
        contado_minor: cuenta.contado_minor, esperado_minor: cuenta.esperado_minor, diferencia_minor: cuenta.diferencia_minor,
        ...(c.tipo === 'ruta' ? { ruta: c.ruta } : {}) } };
      const p: Propuesta = c.tipo === 'ruta'
        ? entregaRuta({ ruta: c.ruta, piezas }, ctx, extra)
        : otroIngreso({ concepto: `cobro de sucursal ${warehouseName(c.sucursal)}`, piezas }, ctx, extra);
      for (const a of p.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...a, user_id: cajera })]);
      await trx.raw('SAVEPOINT le_cobro');
      try {
        const id = (await trx.raw('SELECT cashbook.post_entry(?::jsonb) AS id', [JSON.stringify(p.asiento)])).rows[0].id as string;
        await trx.raw('RELEASE SAVEPOINT le_cobro');
        return { estado: 'recibido', entry_id: id, ...cuenta };
      } catch (e) {
        await trx.raw('ROLLBACK TO SAVEPOINT le_cobro');
        if ((e as { constraint?: string }).constraint !== 'cashbook_requiere_autorizacion') throw e;
        const r = await trx.raw(`SELECT cashbook.create_request(?::jsonb, clock_timestamp() + interval '72 hours') AS id`, [JSON.stringify(p.asiento)]);
        return { estado: 'por_autorizar', request_id: r.rows[0].id as string, motivo: 'pasa el umbral de autorización', ...cuenta };
      }
    });
  }

  // ── `[LE.6.7]` Suspenso: lo que la máquina hizo y nadie explicó (V2) ──────────────────────

  /** Lo abierto en Suspenso, lo más viejo primero; con `ref`, sólo ese movimiento. */
  private async enSuspenso(trx: Knex.Transaction, tenantId: string, ref: string | null): Promise<PartidaEnSuspenso[]> {
    const filas = (await trx.raw(SQL_SUSPENSO, [tenantId, ref, ref, tenantId, tenantId, tenantId])).rows as
      Array<{ entry_id: string; event_ref: string; value_at: string; neto: string; motivo: string | null;
        type_label: string | null; ref: string | null; user_external: string | null }>;
    return filas.map((f) => ({
      event_ref: f.event_ref, entry_id: f.entry_id, esta_en: BigInt(f.neto) > 0n ? 'debe' : 'haber',
      monto_minor: (BigInt(f.neto) < 0n ? -BigInt(f.neto) : BigInt(f.neto)).toString(), fecha: f.value_at,
      movimiento: f.type_label, texto: f.ref, usuario_maquina: f.user_external, motivo: f.motivo,
    }));
  }

  /** Lo que está en Suspenso y nadie ha explicado (ni con una explicación esperando firma). */
  async suspenso(): Promise<PartidaEnSuspenso[]> {
    return this.run((trx, tenantId) => this.enSuspenso(trx, tenantId, null));
  }

  /**
   * Explicar un movimiento en Suspenso: a qué ruta era el depósito, o que fue (o venía) del cajón,
   * o que se fue al banco. El importe y la dirección los lee el servidor del libro; las piezas del
   * cajón son las del movimiento de la máquina (V7: el cajón se mueve por pieza).
   */
  async explicar(body: ExplicarSuspenso, usuario: UsuarioDelLibro, idempotencyKey: string | undefined): Promise<ResultadoHecho> {
    const quien = this.quien(usuario);
    const key = this.llave(idempotencyKey);
    const ref = String(body?.event_ref ?? '').trim();
    if (!/^caos:[^:]+:\d+$/.test(ref)) throw new BadRequestException({ codigo: 'movimiento_invalido', mensaje: 'Se explica un movimiento de la máquina (caos:equipo:número).' });
    const hacia = body?.hacia;
    if (!hacia || !['ruta', 'cajon', 'transito'].includes(hacia.tipo)) {
      throw new BadRequestException({ codigo: 'destino_invalido', mensaje: 'A dónde fue: una ruta, el cajón o el banco.' });
    }
    if (hacia.tipo === 'ruta' && !/^\d{1,4}$/.test(String(hacia.ruta ?? '').trim())) {
      throw new BadRequestException({ codigo: 'ruta_invalida', mensaje: 'La ruta es su número.' });
    }
    return this.run(async (trx, tenantId) => {
      const previa = (await trx.raw(`
        SELECT 'asentado' AS estado, id::text AS id, event_ref FROM cashbook.entries WHERE tenant_id = ? AND request_id = ?
        UNION ALL
        SELECT 'por_autorizar', id::text, payload->>'event_ref' FROM cashbook.requests WHERE tenant_id = ? AND request_id = ?`,
      [tenantId, key, tenantId, key])).rows[0] as { estado: 'asentado' | 'por_autorizar'; id: string; event_ref: string } | undefined;
      if (previa) {
        if (previa.event_ref !== `clasifica:${ref}`) {
          throw new ConflictException({ codigo: 'cashbook_peticion_reusada', mensaje: 'Esa petición ya se registró con otro contenido.' });
        }
        return previa.estado === 'asentado' ? { estado: 'asentado', entry_id: previa.id }
          : { estado: 'por_autorizar', request_id: previa.id, motivo: 'pasa el umbral de autorización' };
      }
      const p = (await this.enSuspenso(trx, tenantId, ref))[0];
      if (!p) throw new ConflictException({ codigo: 'no_esta_en_suspenso', mensaje: 'Ese movimiento no está en Suspenso: ya se explicó, o nunca estuvo.' });
      if (hacia.tipo === 'ruta' && p.esta_en !== 'haber') {
        throw new UnprocessableEntityException({ codigo: 'destino_no_corresponde', mensaje: 'Sólo un depósito es de una ruta: esto salió de la máquina.' });
      }
      if (hacia.tipo === 'transito' && p.esta_en !== 'debe') {
        throw new UnprocessableEntityException({ codigo: 'destino_no_corresponde', mensaje: 'Al banco sólo va lo que salió de la máquina: esto entró.' });
      }
      const piezas = hacia.tipo === 'cajon' ? await this.piezasDeLaMaquina(trx, p.entry_id) : undefined;
      if (hacia.tipo === 'cajon' && !piezas) {
        throw new UnprocessableEntityException({ codigo: 'sin_piezas', mensaje: 'La máquina no dejó sus piezas en ese movimiento: no se pasa al cajón sin contarlo.' });
      }
      const cuenta = hacia.tipo === 'ruta' ? CUENTA.porRendirRuta(String(hacia.ruta).trim())
        : hacia.tipo === 'cajon' ? CUENTAS_FIJAS.CAJA_MXN : CUENTAS_FIJAS.TRANSITO_BANCO;
      const ctx: Contexto = { actor: { kind: 'persona', user_id: quien }, valueAt: new Date().toISOString(), requestId: key };
      const prop = clasificarSuspenso({ eventRefOriginal: ref, monto: p.monto_minor, estaEn: p.esta_en, hacia: cuenta, piezas }, ctx);
      for (const a of prop.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...a, user_id: quien })]);
      await trx.raw('SAVEPOINT le_explicar');
      try {
        const id = (await trx.raw('SELECT cashbook.post_entry(?::jsonb) AS id', [JSON.stringify(prop.asiento)])).rows[0].id as string;
        await trx.raw('RELEASE SAVEPOINT le_explicar');
        return { estado: 'asentado', entry_id: id };
      } catch (e) {
        await trx.raw('ROLLBACK TO SAVEPOINT le_explicar');
        if ((e as { constraint?: string }).constraint !== 'cashbook_requiere_autorizacion') throw e;
        const r = await trx.raw(`SELECT cashbook.create_request(?::jsonb, clock_timestamp() + interval '72 hours') AS id`, [JSON.stringify(prop.asiento)]);
        return { estado: 'por_autorizar', request_id: r.rows[0].id as string, motivo: 'pasa el umbral de autorización' };
      }
    });
  }

  // ── `[LE.6.8]` La reposición (§5.5): una hoja, una firma de Tesorería, un código ────────────

  /** Los pagos de la zona: la MISMA consulta que la hoja (CGA-A.65). `protected`: la prueba la sustituye. */
  protected async pagosDeZona(trx: Knex.Transaction, tenantId: string, zona: ZonaHojaGastos): Promise<PagoDeZona[]> {
    return (await consultasHoja.pagos(trx, tenantId, [...zona.sucursales], zona.desde, { conHojas: true })) as PagoDeZona[];
  }

  /** El primer día del libro: lo anterior no entra a una hoja de la Ventanilla (D-R2). */
  private async arranque(trx: Knex.Transaction, tenantId: string): Promise<string | null> {
    return ((await trx.raw(`SELECT min(business_date)::text AS d FROM cashbook.business_days WHERE tenant_id = ?`, [tenantId])).rows[0]?.d as string | null) ?? null;
  }

  /** Los pagos que ya van en una orden de reposición viva: no vuelven a entrar a una hoja. */
  private async tomados(trx: Knex.Transaction, tenantId: string): Promise<Set<string>> {
    const filas = (await trx.raw(`
      SELECT DISTINCT d AS ref FROM cashbook.withdrawal_orders o, jsonb_array_elements_text(coalesce(o.act->'documentos', '[]'::jsonb)) d
       WHERE o.tenant_id = ? AND o.kind = 'reposicion' AND o.state IN ('por_firmar', 'vigente', 'usada')`, [tenantId])).rows as { ref: string }[];
    return new Set(filas.map((f) => f.ref));
  }

  private async hojas(trx: Knex.Transaction, tenantId: string): Promise<HojaDeReposicion[]> {
    const arranque = await this.arranque(trx, tenantId);
    const tomados = await this.tomados(trx, tenantId);
    const out: HojaDeReposicion[] = [];
    for (const z of ZONAS_HOJA_GASTOS) out.push(hojaDeReposicion(z, await this.pagosDeZona(trx, tenantId, z), arranque, tomados));
    return out;
  }

  /** La hoja de cada zona, lista para pedir. */
  async reposiciones(): Promise<HojaDeReposicion[]> {
    return this.run(async (trx, tenantId) => { await this.exigeVentanilla(trx); return this.hojas(trx, tenantId); });
  }

  /** Quién puede llevar el depósito: la responsabilidad dada a la persona (D35). Vacío = falta nombrarlos. */
  async quienLleva(): Promise<QuienLlevaDeposito[]> {
    return this.run(async (trx, tenantId) => (await trx.raw(SQL_QUIEN_LLEVA, [tenantId])).rows as QuienLlevaDeposito[]);
  }

  /**
   * Pedir la reposición de una zona: la orden nace «por firmar» SIEMPRE (D-R1); la firma de Tesorería
   * es la aprobación de la hoja (D28) y es la única. Lo que da la máquina y lo del cajón quedan en
   * custodia de quien lleva el depósito hasta que el banco lo confirma (§5.5).
   */
  async pedirReposicion(body: PedirReposicion, usuario: UsuarioDelLibro, idempotencyKey: string | undefined): Promise<ResultadoPago> {
    const cajera = this.quien(usuario);
    const key = this.llave(idempotencyKey);
    const zona = ZONAS_HOJA_GASTOS.find((z) => z.clave === String(body?.zona ?? '').trim());
    if (!zona) throw new BadRequestException({ codigo: 'zona_invalida', mensaje: 'Esa zona no repone gastos.' });
    const documentos = [...new Set((body?.documentos ?? []).map((d) => String(d).trim()))];
    return this.run(async (trx, tenantId) => {
      await this.exigeVentanilla(trx);
      const previa = (await trx.raw(`SELECT id, source_ref FROM cashbook.withdrawal_orders WHERE tenant_id = ? AND idempotency_key = ?`,
        [tenantId, key])).rows[0] as { id: string; source_ref: string } | undefined;
      if (previa) {
        if (!previa.source_ref.startsWith(`reposicion:${zona.clave}:`)) {
          throw new ConflictException({ codigo: 'cashbook_peticion_reusada', mensaje: 'Esa petición ya se registró con otro contenido.' });
        }
        return this.resultadoDe(trx, previa.id);
      }
      const lleva = ((await trx.raw(SQL_QUIEN_LLEVA, [tenantId])).rows as QuienLlevaDeposito[]).find((q) => q.usuario_id === String(body?.lleva ?? ''));
      if (!lleva) {
        throw new UnprocessableEntityException({ codigo: 'sin_quien_lleva',
          mensaje: 'Quien lleva el depósito tiene que tener la responsabilidad «lleva el depósito de la reposición» (D35).' });
      }
      const hoja = hojaDeReposicion(zona, await this.pagosDeZona(trx, tenantId, zona), await this.arranque(trx, tenantId), await this.tomados(trx, tenantId));
      if (!hoja.renglones.length) throw new UnprocessableEntityException({ codigo: 'hoja_vacia', mensaje: 'La hoja de esa zona no tiene pagos que reponer.' });
      const enHoja = hoja.renglones.map((r) => r.origen_ref);
      if (enHoja.length !== documentos.length || enHoja.some((r) => !documentos.includes(r))) {
        throw new ConflictException({ codigo: 'hoja_cambio', mensaje: 'La hoja cambió desde que se vio (entró o salió un pago): se vuelve a ver antes de pedirla.' });
      }
      const piezas = body?.piezas_cajon ?? {};
      if (sumaDePiezas(piezas) !== BigInt(hoja.cajon_minor)) {
        throw new UnprocessableEntityException({ codigo: 'cajon_no_cuadra',
          mensaje: `Del cajón salen ${formatearDinero(BigInt(hoja.cajon_minor))}: las piezas suman ${formatearDinero(sumaDePiezas(piezas))}.` });
      }
      if (BigInt(hoja.maquina_minor) <= 0n) {
        throw new UnprocessableEntityException({ codigo: 'reposicion_sin_maquina', mensaje: 'Una reposición de menos de $20 no pasa por la máquina: se paga del cajón.' });
      }
      const acto = {
        piezas_cajon: piezas, recibe: lleva.nombre, recibe_empleado: lleva.usuario_id, cajon_minor: hoja.cajon_minor, redondeo_minor: '0',
        beneficiario: `Reposición ${zona.nombre}`, folio: `${enHoja.length} pagos`, motivo_firma: 'la reposición la firma Tesorería (D-R1)',
        documentos: enHoja, zona: zona.clave, total_minor: hoja.total_minor,
      };
      const vence = (await trx.raw(`SELECT ${FIN_DEL_DIA} AS fin`)).rows[0].fin as Date;
      const o = (await trx.raw('SELECT cashbook.issue_order(?::jsonb) AS o', [JSON.stringify({
        kind: 'reposicion', amount_minor: hoja.maquina_minor, source_ref: `reposicion:${zona.clave}:${key}`,
        classification: { tipo: 'custodia', empleado: lleva.usuario_id, nombre: lleva.nombre },
        actor: { kind: 'persona', user_id: cajera }, expires_at: new Date(vence).toISOString(),
        por_firmar: true, act: acto, idempotency_key: key,
      })])).rows[0].o as OrdenEmitida;
      this.logger.log(`[LE.6.8] reposición ${zona.clave} (${enHoja.length} pagos) por firmar`);
      return { estado: 'por_firmar', orden_id: o.id, motivo: acto.motivo_firma };
    });
  }

  // ── `[LE.6.5]` Custodias: dinero a cargo de una persona hasta que rinde (V6) ──────────────────

  /** Las personas que pueden tener dinero a su cargo: usuarios activos de la Suite (el catálogo del empleado es LE.1.15). */
  async personas(q: string | undefined): Promise<PersonaDeCustodia[]> {
    const texto = String(q ?? '').trim();
    if (texto.length < 2) return [];
    return this.run(async (trx, tenantId) => (await trx.raw(`
      SELECT u.id::text AS usuario_id, coalesce(nullif(btrim(u.nombre), ''), u.username) AS nombre
        FROM identity.users u
       WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
         AND (u.nombre ILIKE ? OR u.username ILIKE ?)
       ORDER BY 2 LIMIT 20`, [tenantId, `%${texto}%`, `%${texto}%`])).rows as PersonaDeCustodia[]);
  }

  private async persona(trx: Knex.Transaction, tenantId: string, id: string): Promise<PersonaDeCustodia> {
    if (!UUID.test(String(id ?? ''))) throw new BadRequestException({ codigo: 'persona_invalida', mensaje: 'La custodia es de una persona con su usuario.' });
    const p = (await trx.raw(`SELECT u.id::text AS usuario_id, coalesce(nullif(btrim(u.nombre), ''), u.username) AS nombre
      FROM identity.users u WHERE u.tenant_id = ? AND u.id = ? AND u.activo AND u.deleted_at IS NULL`, [tenantId, id])).rows[0] as PersonaDeCustodia | undefined;
    if (!p) throw new NotFoundException({ codigo: 'persona_inexistente', mensaje: 'No hay un usuario activo con ese id.' });
    return p;
  }

  /** Lo que tiene a su cargo cada persona, desde cuándo, y las reposiciones que esperan su depósito. */
  async custodias(): Promise<CustodiaAbierta[]> {
    return this.run(async (trx, tenantId) => {
      const filas = (await trx.raw(SQL_CUSTODIAS, [tenantId])).rows as Array<{ persona: string; nombre: string; saldo_minor: string; desde: string | null }>;
      const repos = (await trx.raw(`
        SELECT o.id::text AS orden_id, o.classification->>'empleado' AS persona, o.act->>'zona' AS zona, o.act->>'total_minor' AS total_minor,
               jsonb_array_length(coalesce(o.act->'documentos', '[]'::jsonb)) AS documentos, (o.created_at AT TIME ZONE 'America/Mexico_City')::date::text AS dia
          FROM cashbook.withdrawal_orders o
         WHERE o.tenant_id = ? AND o.kind = 'reposicion' AND o.state IN ('vigente', 'usada')
           AND NOT EXISTS (SELECT 1 FROM cashbook.entries e WHERE e.tenant_id = o.tenant_id AND e.event_kind = 'gasto'
                             AND e.meta->>'reposicion' = o.id::text)
         ORDER BY o.created_at`, [tenantId])).rows as Array<ReposicionPorConfirmar & { persona: string }>;
      return filas.map((f) => ({ ...f, reposiciones: repos.filter((r) => r.persona === f.persona).map((r) => ({ orden_id: r.orden_id, zona: r.zona, total_minor: r.total_minor, documentos: Number(r.documentos), dia: r.dia })) }));
    });
  }

  /**
   * Sacar dinero a la custodia de una persona (V6). De la máquina: una orden con código, y desde el
   * umbral (D3) la firma Tesorería —sin umbral configurado, siempre: lo no medido no se da por
   * pequeño—. Del cajón: por pieza, en el acto (el libro aplica su propio umbral).
   */
  async retiroACustodia(body: RetiroACustodia, usuario: UsuarioDelLibro, idempotencyKey: string | undefined): Promise<ResultadoPago | ResultadoHecho> {
    const cajera = this.quien(usuario);
    const key = this.llave(idempotencyKey);
    const para = String(body?.para ?? '').trim();
    if (para.length < 5) throw new BadRequestException({ codigo: 'sin_para_que', mensaje: 'Para qué se lleva el dinero (V6: la custodia dice para qué).' });
    return this.run(async (trx, tenantId) => {
      const p = await this.persona(trx, tenantId, body?.persona);
      if (body?.desde?.tipo === 'cajon') {
        const ctx: Contexto = { actor: { kind: 'persona', user_id: cajera }, valueAt: new Date().toISOString(), requestId: key };
        const prop = aCustodiaDesdeCajon({ empleado: p.usuario_id, nombre: p.nombre, piezas: body.desde.piezas, para }, ctx);
        return this.asentarOPedir(trx, prop, cajera, 'le_custodia');
      }
      if (body?.desde?.tipo !== 'maquina') throw new BadRequestException({ codigo: 'origen_invalido', mensaje: 'De la máquina o del cajón.' });
      await this.exigeVentanilla(trx);
      const monto = BigInt(String(body.desde.monto_minor ?? '0'));
      if (monto <= 0n || pesosACentavos(String(pagableConBilletesCaos(Number(monto) / 100))) !== monto) {
        throw new UnprocessableEntityException({ codigo: 'monto_no_es_de_billetes', mensaje: 'De la máquina salen billetes: el monto es múltiplo de los que da.' });
      }
      const previa = (await trx.raw(`SELECT id FROM cashbook.withdrawal_orders WHERE tenant_id = ? AND idempotency_key = ?`, [tenantId, key])).rows[0] as { id: string } | undefined;
      if (previa) return this.resultadoDe(trx, previa.id);
      const umbral = (await trx.raw(`SELECT threshold_minor::text AS u FROM cashbook.authorization_rules WHERE tenant_id = ? AND event_kind = 'retiro_a_custodia'`,
        [tenantId])).rows[0]?.u as string | undefined;
      const firma = umbral === undefined || monto >= BigInt(umbral);
      const vence = (await trx.raw(`SELECT ${FIN_DEL_DIA} AS fin`)).rows[0].fin as Date;
      const motivo = umbral === undefined ? 'no hay umbral configurado: la firma Tesorería (D3)' : 'desde el umbral la firma Tesorería (D3)';
      const o = (await trx.raw('SELECT cashbook.issue_order(?::jsonb) AS o', [JSON.stringify({
        kind: 'custodia', amount_minor: monto.toString(), source_ref: `custodia:${key}`,
        classification: { tipo: 'custodia', empleado: p.usuario_id, nombre: p.nombre },
        actor: { kind: 'persona', user_id: cajera }, expires_at: new Date(vence).toISOString(), por_firmar: firma,
        act: { piezas_cajon: {}, recibe: p.nombre, recibe_empleado: p.usuario_id, cajon_minor: '0', redondeo_minor: '0',
          beneficiario: `Custodia · ${p.nombre}`, folio: para, motivo_firma: firma ? motivo : null }, idempotency_key: key,
      })])).rows[0].o as OrdenEmitida;
      if (firma) return { estado: 'por_firmar', orden_id: o.id, motivo };
      return this.resultadoDe(trx, o.id);
    });
  }

  /** Asienta, o lo deja como solicitud si el libro dice que pasa el umbral. */
  private async asentarOPedir(trx: Knex.Transaction, prop: Propuesta, quien: string, punto: string): Promise<ResultadoHecho> {
    for (const a of prop.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...a, user_id: quien })]);
    await trx.raw(`SAVEPOINT ${punto}`);
    try {
      const id = (await trx.raw('SELECT cashbook.post_entry(?::jsonb) AS id', [JSON.stringify(prop.asiento)])).rows[0].id as string;
      await trx.raw(`RELEASE SAVEPOINT ${punto}`);
      return { estado: 'asentado', entry_id: id };
    } catch (e) {
      await trx.raw(`ROLLBACK TO SAVEPOINT ${punto}`);
      if ((e as { constraint?: string }).constraint !== 'cashbook_requiere_autorizacion') throw e;
      const r = await trx.raw(`SELECT cashbook.create_request(?::jsonb, clock_timestamp() + interval '72 hours') AS id`, [JSON.stringify(prop.asiento)]);
      return { estado: 'por_autorizar', request_id: r.rows[0].id as string, motivo: 'pasa el umbral de autorización' };
    }
  }

  /**
   * Rendir: cada documento de Kepler que pagó con el dinero de su custodia (un documento se rinde UNA
   * vez y no puede estar pagado por otro lado) y lo que regresa al cajón, por pieza. La custodia no
   * puede quedar negativa: lo garantiza la base.
   */
  async rendir(body: RendirCustodia, usuario: UsuarioDelLibro, idempotencyKey: string | undefined): Promise<ResultadoRendicion> {
    const cajera = this.quien(usuario);
    const key = this.llave(idempotencyKey);
    const docs = body?.documentos ?? [];
    const regresa = body?.regresa && Object.keys(body.regresa).length ? body.regresa : null;
    if (!docs.length && !regresa) throw new BadRequestException({ codigo: 'nada_que_rendir', mensaje: 'Se rinde con documentos, con lo que regresa, o con los dos.' });
    return this.run(async (trx, tenantId) => {
      const p = await this.persona(trx, tenantId, body?.persona);
      const ya = (await trx.raw(`SELECT id::text AS id FROM cashbook.entries WHERE tenant_id = ? AND meta->>'rendicion' = ? ORDER BY seq`, [tenantId, key])).rows as { id: string }[];
      if (ya.length) return { asientos: ya.map((x) => x.id), saldo_minor: await this.saldoDeCustodia(trx, tenantId, p.usuario_id) };
      const asientos: string[] = [];
      const ctx: Contexto = { actor: { kind: 'persona', user_id: cajera }, valueAt: new Date().toISOString() };
      for (const d of docs) {
        const doc = await this.documento(trx, tenantId, d.origen_ref, d.cuenta_kepler?.trim() || null);
        if (!doc.cuentaKepler) throw new UnprocessableEntityException({ codigo: 'sin_cuenta', mensaje: `El ${doc.folio} no trae su cuenta de Kepler.` });
        const t = await this.yaTomado(trx, tenantId, doc.origenRef);
        const rendido = (await trx.raw(`SELECT 1 FROM cashbook.entries WHERE tenant_id = ? AND event_ref = ?`, [tenantId, `rinde:${doc.origenRef}`])).rows.length > 0;
        if (t.ordenado || t.pagado || rendido) {
          throw new ConflictException({ codigo: 'documento_ya_pagado', mensaje: `El X-D-26 ${doc.folio} ya está pagado o rendido: no entra dos veces.` });
        }
        const prop = gasto({ concepto: doc.cuentaKepler, desde: { tipo: 'custodia', empleado: p.usuario_id, nombre: p.nombre, monto: doc.importeCentavos.toString() } },
          ctx, { event_ref: `rinde:${doc.origenRef}`, meta: { rendicion: key, documento: doc.origenRef } });
        const r = await this.asentarOPedir(trx, prop, cajera, 'le_rinde');
        if (r.estado !== 'asentado') throw new UnprocessableEntityException({ codigo: 'rendicion_por_autorizar', mensaje: 'Ese documento pasa el umbral: se rinde con la firma de otra persona.' });
        asientos.push(r.entry_id);
      }
      if (regresa) {
        const prop = regresoCustodiaAlCajon({ empleado: p.usuario_id, nombre: p.nombre, piezas: regresa }, ctx, { event_ref: `regresa:${key}`, meta: { rendicion: key } });
        const r = await this.asentarOPedir(trx, prop, cajera, 'le_regresa');
        if (r.estado === 'asentado') asientos.push(r.entry_id);
      }
      return { asientos, saldo_minor: await this.saldoDeCustodia(trx, tenantId, p.usuario_id) };
    });
  }

  private async saldoDeCustodia(trx: Knex.Transaction, tenantId: string, persona: string): Promise<string> {
    return ((await trx.raw(`SELECT balance_minor::text AS s FROM cashbook.v_saldos WHERE code = ?`, [CUENTA.custodia(persona, 'x').code])).rows[0]?.s as string | undefined) ?? '0';
  }

  /** Los depósitos a la cuenta de la zona desde un día (la MISMA lectura que la hoja). `protected`: la prueba los sustituye. */
  protected async depositosDelBanco(trx: Knex.Transaction, tenantId: string, zona: ZonaHojaGastos, desde: string): Promise<DepositoBancoHoja[] | null> {
    if (!zona.cuenta_deposito) return null;
    const cuentas = (await trx('finance.bank_accounts').where('tenant_id', tenantId)
      .whereRaw('upper(btrim(bank)) = ?', [zona.cuenta_deposito.banco.toUpperCase()])
      .where('account_label', zona.cuenta_deposito.terminacion).select('id')).map((r: { id: string }) => String(r.id));
    if (!cuentas.length) return null;
    return (await trx('finance.bank_movements').where('tenant_id', tenantId).whereNull('deleted_at').where('amount_in', '>', 0)
      .whereIn('bank_account_id', cuentas).where('movement_date', '>=', desde)
      .select(trx.raw('id::text AS id'), trx.raw(`to_char(movement_date, 'YYYY-MM-DD') AS dia`), 'amount_in'))
      .map((d: { id: string; dia: string; amount_in: string }) => ({ id: d.id, dia: d.dia, importe: Math.round(Number(d.amount_in) * 100) / 100 }));
  }

  /**
   * Cerrar una reposición con su testigo: el depósito en la cuenta de la zona (uno o dos depósitos que
   * suman el total ± $0.50, del día del retiro a siete después: `depositoDeHoja`, la regla de la hoja).
   * Encontrado → cada pago de la hoja queda como gasto desde la custodia y la persona queda descargada.
   * Sin cuenta medida, sin depósito o con más de una combinación posible: NO se cierra (se dice por qué).
   */
  async confirmarDeposito(ordenId: string, usuario: UsuarioDelLibro): Promise<ResultadoRendicion> {
    const cajera = this.quien(usuario);
    if (!UUID.test(String(ordenId))) throw new BadRequestException({ codigo: 'orden_invalida', mensaje: 'Esa no es una orden.' });
    return this.run(async (trx, tenantId) => {
      const o = (await trx.raw(`SELECT id::text AS id, kind, state, classification, act, (created_at AT TIME ZONE 'America/Mexico_City')::date::text AS dia
        FROM cashbook.withdrawal_orders WHERE tenant_id = ? AND id = ?`, [tenantId, ordenId])).rows[0] as
        { id: string; kind: string; state: string; classification: { empleado: string; nombre: string }; act: ActoDePago; dia: string } | undefined;
      if (!o || o.kind !== 'reposicion') throw new NotFoundException({ codigo: 'orden_inexistente', mensaje: 'No es una reposición.' });
      if (!['vigente', 'usada'].includes(o.state)) throw new ConflictException({ codigo: 'reposicion_sin_pagar', mensaje: 'Esa reposición no se ha pagado: no hay depósito que confirmar.' });
      const ya = (await trx.raw(`SELECT id::text AS id FROM cashbook.entries WHERE tenant_id = ? AND event_kind = 'gasto' AND meta->>'reposicion' = ? ORDER BY seq`,
        [tenantId, o.id])).rows as { id: string }[];
      if (ya.length) return { asientos: ya.map((x) => x.id), saldo_minor: await this.saldoDeCustodia(trx, tenantId, o.classification.empleado) };
      const zona = ZONAS_HOJA_GASTOS.find((z) => z.clave === o.act.zona);
      if (!zona) throw new UnprocessableEntityException({ codigo: 'zona_invalida', mensaje: 'La reposición no dice su zona.' });
      const todos = await this.depositosDelBanco(trx, tenantId, zona, o.dia);
      if (todos === null) {
        throw new UnprocessableEntityException({ codigo: 'cuenta_no_medida', mensaje: `La cuenta donde se deposita la reposición de ${zona.nombre} no está medida: no se confirma a ciegas.` });
      }
      const usados = new Set(((await trx.raw(`SELECT DISTINCT unnest(string_to_array(meta->>'deposito', ',')) AS id FROM cashbook.entries
        WHERE tenant_id = ? AND event_kind = 'gasto' AND meta->>'deposito' IS NOT NULL`, [tenantId])).rows as { id: string }[]).map((x) => x.id));
      const total = Number(o.act.total_minor ?? '0') / 100;
      const dep = depositoDeHoja(total, o.dia, todos.filter((d) => !usados.has(d.id)));
      if (dep.estado === 'no_encontrado') throw new ConflictException({ codigo: 'deposito_no_encontrado', mensaje: 'El banco todavía no muestra el depósito de esa reposición.' });
      if (dep.estado === 'ambiguo') throw new ConflictException({ codigo: 'deposito_ambiguo', mensaje: `Hay ${dep.opciones} formas de llegar al total con los depósitos de esos días: lo liga una persona.` });
      const docs = o.act.documentos ?? [];
      const pares = docs.map((d) => d.split('|')).map((x) => [x[0], x[2]] as [string, string]);
      const filas = await this.filasDeDocumentos(trx, tenantId, pares);
      const ctx: Contexto = { actor: { kind: 'persona', user_id: cajera }, valueAt: new Date().toISOString() };
      const asientos: string[] = [];
      for (const ref of docs) {
        const [s, , f] = ref.split('|');
        const fila = filas.find((x) => x.sucursal === s && x.folio === f);
        if (!fila) throw new UnprocessableEntityException({ codigo: 'documento_inexistente', mensaje: `Kepler ya no tiene el ${f}: la reposición se revisa antes de cerrarla.` });
        const prop = gasto({ concepto: `reposicion ${zona.clave}`, desde: { tipo: 'custodia', empleado: o.classification.empleado, nombre: o.classification.nombre,
          monto: pesosACentavos(fila.importe).toString() } }, ctx,
        { event_ref: `rinde:${ref}`, meta: { reposicion: o.id, deposito: dep.ids.join(','), documento: ref } });
        for (const a of prop.cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...a, user_id: cajera })]);
        asientos.push((await trx.raw('SELECT cashbook.post_entry(?::jsonb) AS id', [JSON.stringify(prop.asiento)])).rows[0].id as string);
      }
      this.logger.log(`[LE.6.8] reposición ${o.id} cerrada con el depósito ${dep.ids.join(',')}`);
      return { asientos, saldo_minor: await this.saldoDeCustodia(trx, tenantId, o.classification.empleado) };
    });
  }

  /** Las piezas que movió la máquina en ese asiento, en positivo (la regla les pone el signo). */
  private async piezasDeLaMaquina(trx: Knex.Transaction, entryId: string): Promise<PiezasTexto | undefined> {
    const filas = (await trx.raw(`
      SELECT p.denom_key, abs(p.pieces)::text AS n
        FROM cashbook.entry_lines l JOIN cashbook.accounts a ON a.id = l.account_id
        JOIN cashbook.entry_pieces p ON p.line_id = l.id
       WHERE l.entry_id = ? AND a.code = 'BOVEDA_CAOS' AND l.currency = 'MXN'`, [entryId])).rows as { denom_key: string; n: string }[];
    return filas.length ? Object.fromEntries(filas.map((f) => [f.denom_key, f.n])) : undefined;
  }

  /** El cobro que ya registró esta llave (asiento o solicitud), con lo que se contestó la primera vez. */
  private async cobroPrevio(trx: Knex.Transaction, tenantId: string, key: string): Promise<{ event_ref: string; resultado: ResultadoCobro } | null> {
    const e = (await trx.raw(`SELECT id, event_ref, meta, event_kind FROM cashbook.entries WHERE tenant_id = ? AND request_id = ?`,
      [tenantId, key])).rows[0] as { id: string; event_ref: string | null; meta: Record<string, string> | null; event_kind: string } | undefined;
    const q = e ? undefined : (await trx.raw(`SELECT id, payload FROM cashbook.requests WHERE tenant_id = ? AND request_id = ?`, [tenantId, key])).rows[0] as
      { id: string; payload: { event_ref?: string; event_kind?: string; meta?: Record<string, string> } } | undefined;
    if (!e && !q) return null;
    const meta = (e ? e.meta : q?.payload.meta) ?? {};
    const kind = e ? e.event_kind : q?.payload.event_kind;
    const dif = BigInt(meta['diferencia_minor'] ?? '0');
    const cuenta: CuentaDelCobro = {
      tipo: kind === 'entrega_ruta' ? 'ruta' : 'sucursal', ruta: meta['ruta'] ?? null,
      contado_minor: meta['contado_minor'] ?? '0', esperado_minor: meta['esperado_minor'] ?? '0', diferencia_minor: meta['diferencia_minor'] ?? '0',
      es_redondeo: dif !== 0n && dif > -50n && dif < 50n,
    };
    if (e) return { event_ref: e.event_ref ?? '', resultado: { estado: 'recibido', entry_id: e.id, ...cuenta } };
    return { event_ref: q?.payload.event_ref ?? '',
      resultado: { estado: 'por_autorizar', request_id: q?.id ?? '', motivo: 'pasa el umbral de autorización', ...cuenta } };
  }
}
