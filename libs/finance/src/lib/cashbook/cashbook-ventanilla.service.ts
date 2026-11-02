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
  centavosATexto, formatearDinero, pesosACentavos, valorDePiezas,
  type OrdenPorFirmar, type PagoEnVentanilla, type PiezasTexto, type PlanDePagoVentanilla, type ResultadoPago,
} from '@megadulces/contracts';
import { traducirErrorDelLibro } from './errores';
import { MOTIVO_BLOQUEO, planDePago, type DocumentoAPagar, type PlanDePago, type ValeElegido } from './plan-de-pago';
import { pagoDelCajon, type Contexto } from './reglas';
import type { UsuarioDelLibro } from './cashbook.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LLAVE_DOCUMENTO = /^([0-9]{2}(?:-[0-9]+)?)\|(X-D-26)\|([^|]+)\|(0011)$/;
const FIN_DEL_DIA = `((date_trunc('day', clock_timestamp() AT TIME ZONE 'America/Mexico_City') + interval '1 day')
  AT TIME ZONE 'America/Mexico_City')`;

/** Lo que la cajera capturó y se asienta al pagar (o al firmar). Vive en `withdrawal_orders.act`. */
interface ActoDePago {
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

export interface FilaDocumento { folio: string; beneficiario: string; importe: string }
export interface FilaVale { id: string; folio: string; status: string; importe: string; aprobado_at: string | null }

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

  /** El X-D-26 tal como lo tiene Kepler. Nunca el importe de la pantalla. */
  private async documento(trx: Knex.Transaction, tenantId: string, origenRef: string, cuenta: string | null): Promise<DocumentoAPagar> {
    const m = LLAVE_DOCUMENTO.exec(String(origenRef ?? '').trim());
    if (!m) {
      throw new BadRequestException({ codigo: 'documento_invalido', mensaje: 'La Ventanilla paga un X-D-26 de la Caja General (sucursal|X-D-26|folio|0011).' });
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
    const vale = await this.vale(trx, tenantId, valeId);
    const ya = await this.yaTomado(trx, tenantId, doc.origenRef);
    return { plan: planDePago(doc, { yaOrdenado: ya.ordenado, yaPagado: ya.pagado, vale }), vale };
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
             (SELECT e.id FROM cashbook.entries e WHERE e.tenant_id = o.tenant_id AND e.event_kind = 'gasto'
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

      const { plan, vale } = await this.armarPlan(trx, tenantId, body.origen_ref, body.cuenta_kepler ?? null, body.vale_id);
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
        classification: { tipo: 'pago', concepto, documento: plan.documento.origenRef, ...(vale ? { vale: vale.id } : {}) },
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
}
