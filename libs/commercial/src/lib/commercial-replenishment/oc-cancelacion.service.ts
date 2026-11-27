import {
  BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService, todayMx } from '@megadulces/platform-core';
import {
  warehouseName, type OcCancelacionDisponibleDto, type OcCancelacionDto,
  type RequisicionCancelacionDisponibleDto, type RequisicionCancelacionDto,
  type OcEdicionDisponibleDto, type OcEdicionDto, type OcEdicionRenglonDto, type OcEditarInputDto,
} from '@megadulces/contracts';

import { KeplerOcCancelAdapter } from './kepler-oc-cancel.adapter';
import { decidirCancelacionOc, motivoValido, type EntradaDecision } from './kepler-oc-cancelacion';
import { motivoEdicionValido, presentacion, revisarOcEditable, type EntradaEdicion, type RenglonOcKepler } from './kepler-oc-edicion';
import { decidirCancelacionRequisicion, entradaDesdeReplica, motivoSuiteCancelada } from './kepler-req-cancelacion';
import { leerRequisicionEnReplica, type RequisicionEnReplica } from './kepler-requisicion-replica';
import { CAPTURISTA_SUITE, horaMx } from './kepler-requisition-sink.adapter';
import { filtroSucursalOc } from './oc-abiertas';

const AREA = 'compras';
const TABLA = 'commercial.purchase_order_cancellations';
/** `[KR.7]` La migración que extiende `TABLA` a requisiciones y siembra su interruptor. */
const MIGRACION_KR7 = '20261114120335';
/** `[PQ.160]` Las ediciones de cantidades (un renglón por intento) y su interruptor. */
const TABLA_EDICION = 'commercial.purchase_order_edits';
const MIGRACION_PQ160 = '20261126174034';
const INTERRUPTOR_EDICION = 'edita_oc';
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Qué se cancela. La OC se identifica por su llave de Kepler; la requisición, además, por su id en la Suite. */
type Documento =
  | { tipo: 'oc'; s: string; f: string }
  | { tipo: 'requisicion'; s: string; f: string; id: string };

/** El interruptor de `kepler_push_switch` de cada documento. */
const INTERRUPTOR: Record<Documento['tipo'], string> = { oc: 'cancela_oc', requisicion: 'cancela_requisicion' };

interface FilaCancelacion {
  sucursal: string; oc_folio: string | null; estado: 'cancelada' | 'rechazada'; rechazo: string | null;
  requisicion_folio: string | null; requisicion_reabierta: boolean;
  created_by_username: string | null; created_at: string | Date;
}

/**
 * `[KR.7]` C3: si esta requisición de la Suite se canceló EN KEPLER desde la Suite, cuándo, quién y por qué
 * (D43). Lo lee la ficha (`getRequisition`): la réplica tarda uno o dos minutos en verla en C, y sin esto la
 * ficha diría «en Kepler sigue viva» de algo que la Suite acaba de cancelar. `null` sin la migración
 * `20261114120335` (no hay columna ni renglones) o si no se canceló desde aquí.
 */
export async function leerCancelacionKeplerDeRequisicion(
  trx: Knex | Knex.Transaction, tenantId: string, id: string,
): Promise<{ en: string; por: string | null; motivo: string } | null> {
  const col = (await trx.raw(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'commercial' AND table_name = 'purchase_order_cancellations' AND column_name = 'requisition_id'`)).rows.length;
  if (!col) return null;
  const k = await trx(TABLA)
    .where({ tenant_id: tenantId, requisition_id: id, document_type: 'requisicion', estado: 'cancelada' })
    .whereNull('deleted_at')
    .first<{ created_at: string | Date; created_by_username: string | null; motivo: string } | undefined>('created_at', 'created_by_username', 'motivo');
  return k ? { en: new Date(k.created_at).toISOString(), por: k.created_by_username ?? null, motivo: k.motivo } : null;
}

/** La requisición de la Suite, con su llave de Kepler (`null` si nunca llegó allá). */
interface RequisicionSuite { id: string; estado: string; source_type: string | null; sucursal: string | null; folio: string | null }

/** Los candados de la Suite, leídos una vez. `bloqueo` = el primero que cierra, con su código HTTP. */
interface Candados {
  tenantId: string;
  hoy: string;
  ultima: FilaCancelacion | null;
  bloqueo: { status: 409 | 503; porque: string } | null;
}

/**
 * `[PQ.110]` — **Cancelar desde la Suite una OC de Kepler pendiente y sin vale.**
 *
 * Candados, en orden (cada uno rechaza con su porqué y sin tocar Kepler):
 *  1. la llave `COMPRAS_OC_CANCELAR` (en el controlador) y el alcance por sucursal (como `oc-abiertas`);
 *  2. el motivo (≥ 10 letras);
 *  3. el interruptor `kepler_push_switch` tipo `cancela_oc` de ESA sucursal, y su tope diario;
 *  4. la regla y los permisos de Kepler (en el adaptador, dentro de su transacción).
 *
 * `disponible()` contesta lo mismo SIN escribir, para que la pantalla no ofrezca un botón que va a
 * fallar: los candados 1 y 3, y la regla de Kepler contra la réplica (`kepler_ods`).
 *
 * Todo intento que llega a Kepler queda en `purchase_order_cancellations`, cancelado o rechazado, con
 * lo que Kepler pierde al cancelar (capturista, fecha y hora originales).
 *
 * ⚠️ Kepler y la Suite son dos bases: si Kepler confirma y el registro de la Suite falla, la OC queda
 * cancelada sin renglón aquí. Se deja en el log de error TODO lo que el renglón iba a guardar.
 *
 * `[KR.7]` La REQUISICIÓN de compra se cancela con el mismo servicio (`cancelarRequisicion` /
 * `disponibleRequisicion`): mismos candados, su propio interruptor (`cancela_requisicion`) y su propio tope,
 * y el renglón en la misma tabla con `document_type = 'requisicion'`. Misma clase a propósito: una firma
 * inyectada nueva es un riesgo de arranque (#414) que esto no necesita.
 */
@Injectable()
export class OcCancelacionService {
  private readonly logger = new Logger(OcCancelacionService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly kepler: KeplerOcCancelAdapter,
  ) {}

  async cancelar(sucursal: string, folio: string, body: { motivo?: unknown }): Promise<OcCancelacionDto> {
    const { s, f } = this.llave(sucursal, folio);
    const m = motivoValido(typeof body?.motivo === 'string' ? body.motivo : null);
    if (!m.ok) throw new BadRequestException(m.motivo);
    await this.exigirAlcance(s);

    const c = await this.candados({ tipo: 'oc', s, f }, true);
    if (c.bloqueo) {
      throw c.bloqueo.status === 409 ? new ConflictException(c.bloqueo.porque) : new ServiceUnavailableException(c.bloqueo.porque);
    }
    const { tenantId, hoy } = c;

    const ctx = this.tenantCtx.get();
    const userId = ctx?.userId ?? null;
    const username = ctx?.username ?? null;
    const r = await this.kepler.cancelar({ sucursal: s, folio: f, capturista: CAPTURISTA_SUITE, fecha: hoy, hora: horaMx() });

    const fila = {
      tenant_id: tenantId, sucursal: s, oc_folio: f, motivo: m.valor, estado: r.estado,
      rechazo: r.estado === 'rechazada' ? (r.motivo ?? 'Kepler no la canceló') : null,
      kepler_original: r.original ? JSON.stringify(r.original) : null,
      requisicion_folio: r.original?.origen_tipo === '30' ? r.original.origen_folio : null,
      requisicion_reabierta: !!r.requisicion,
      created_by: userId, created_by_username: username, updated_by: userId,
    };
    let creada: string = new Date().toISOString();
    try {
      const [row] = await this.tk.run((trx) => trx(TABLA).insert(fila).returning(['created_at']));
      creada = new Date(row.created_at).toISOString();
    } catch (e) {
      this.logger.error(`[PQ.110] OC ${s}|${f} ${r.estado} en Kepler pero NO quedó registrada en la Suite: ${(e as Error).message} — ${JSON.stringify(fila)}`);
    }
    this.logger.log(`[PQ.110] OC ${s}|${f}: ${r.estado}${r.motivo ? ` (${r.motivo})` : ''} por ${username ?? userId ?? 'system'}`);
    return {
      sucursal: s, folio: f, estado: r.estado, rechazo: fila.rechazo,
      requisicion_reabierta: r.requisicion?.folio ?? null, cancelada_por: username, cancelada_en: creada,
    };
  }

  /** ¿Se puede OFRECER «Cancelar en Kepler» para esta OC? No escribe nada. */
  async disponible(sucursal: string, folio: string): Promise<OcCancelacionDisponibleDto> {
    const { s, f } = this.llave(sucursal, folio);
    await this.exigirAlcance(s);
    const base = { sucursal: s, folio: f, reabriria_requisicion: null };
    let c: Candados;
    try {
      c = await this.candados({ tipo: 'oc', s, f }, false);
    } catch (e) {
      // Sin la migración no hay botón: se dice, no se tira la pantalla.
      if (e instanceof HttpException) return { ...base, disponible: false, porque: e.message, ultima: null };
      throw e;
    }
    const ultima = c.ultima ? this.aDto(c.ultima) : null;
    if (c.bloqueo) return { ...base, disponible: false, porque: c.bloqueo.porque, ultima };

    const e = await this.tk.run((trx) => this.leerReplica(trx, s, f));
    if (!e) {
      return { ...base, disponible: false, porque: 'Esta base no tiene la réplica de Kepler: no se puede revisar la orden', ultima };
    }
    const d = decidirCancelacionOc(e);
    if (!d.ok) return { ...base, disponible: false, porque: d.motivo, ultima };
    return { ...base, disponible: true, porque: null, reabriria_requisicion: d.reabre_requisicion ? (e.oc?.origen_folio ?? null) : null, ultima };
  }

  /**
   * `[KR.7]` **Cancelar en Kepler la requisición de compra de esta ficha** — los mismos candados que la OC,
   * en el mismo orden (motivo, alcance, interruptor `cancela_requisicion` y su tope, y la regla de Kepler
   * dentro de la transacción del adaptador), y el mismo registro en `purchase_order_cancellations`.
   *
   * D43 (Edgar, 2026-11-14): si Kepler la cancela, la requisición de la Suite queda `cancelled` con el motivo
   * y quién (`rejection_*`, con el inicio `MOTIVO_CANCELADA_EN_KEPLER`). Si ya estaba cancelada aquí —la
   * ficha avisaba «sigue viva en Kepler»— no se toca: conserva su motivo.
   *
   * ⚠️ Kepler y la Suite son dos bases: el intento se registra primero y la requisición después, cada uno en
   * su transacción; si alguno falla con Kepler ya cancelado, el log de error lleva TODO lo que faltó.
   */
  async cancelarRequisicion(id: string, body: { motivo?: unknown }): Promise<RequisicionCancelacionDto> {
    const m = motivoValido(typeof body?.motivo === 'string' ? body.motivo : null, 'la requisición');
    if (!m.ok) throw new BadRequestException(m.motivo);
    const rq = await this.requisicionSuite(id);
    const noSe = this.porQueNoEstaEnKepler(rq);
    if (noSe) throw new ConflictException(noSe);
    const s = rq.sucursal as string;
    const f = rq.folio as string;
    await this.exigirAlcance(s);

    const c = await this.candados({ tipo: 'requisicion', s, f, id: rq.id }, true);
    if (c.bloqueo) {
      throw c.bloqueo.status === 409 ? new ConflictException(c.bloqueo.porque) : new ServiceUnavailableException(c.bloqueo.porque);
    }
    const { tenantId, hoy } = c;

    const ctx = this.tenantCtx.get();
    const userId = ctx?.userId ?? null;
    const username = ctx?.username ?? null;
    const r = await this.kepler.cancelarRequisicion({ sucursal: s, folio: f, capturista: CAPTURISTA_SUITE, fecha: hoy, hora: horaMx() });

    const fila = {
      tenant_id: tenantId, document_type: 'requisicion', requisition_id: rq.id, sucursal: s, oc_folio: null,
      requisicion_folio: f, requisicion_reabierta: false, motivo: m.valor, estado: r.estado,
      rechazo: r.estado === 'rechazada' ? (r.motivo ?? 'Kepler no la canceló') : null,
      kepler_original: r.original ? JSON.stringify(r.original) : null,
      created_by: userId, created_by_username: username, updated_by: userId,
    };
    let creada: string = new Date().toISOString();
    try {
      const [row] = await this.tk.run((trx) => trx(TABLA).insert(fila).returning(['created_at']));
      creada = new Date(row.created_at).toISOString();
    } catch (e) {
      this.logger.error(`[KR.7] Requisición ${s}|${f} ${r.estado} en Kepler pero el intento NO quedó registrado en la Suite: ${(e as Error).message} — ${JSON.stringify(fila)}`);
    }

    let suiteCancelada = false;
    if (r.estado === 'cancelada') {
      try {
        const n = await this.tk.run((trx) => trx('commercial.purchase_requisitions')
          .where({ tenant_id: tenantId, id: rq.id }).whereNot('estado', 'cancelled')
          .update({ estado: 'cancelled', rejection_reason: motivoSuiteCancelada(m.valor), rejected_by: userId, rejected_at: trx.fn.now(), updated_at: trx.fn.now() }));
        suiteCancelada = Number(n) > 0;
      } catch (e) {
        this.logger.error(`[KR.7] Requisición ${s}|${f} cancelada en Kepler pero la de la Suite (${rq.id}) NO quedó cancelada: ${(e as Error).message} — motivo «${m.valor}» por ${username ?? userId ?? 'system'}`);
      }
    }
    this.logger.log(`[KR.7] Requisición ${s}|${f} (${rq.id}): ${r.estado}${r.motivo ? ` (${r.motivo})` : ''}${suiteCancelada ? ', cancelada también en la Suite' : ''} por ${username ?? userId ?? 'system'}`);
    return {
      requisition_id: rq.id, sucursal: s, folio: f, estado: r.estado, rechazo: fila.rechazo,
      suite_cancelada: suiteCancelada, cancelada_por: username, cancelada_en: creada,
    };
  }

  /** `[KR.7]` ¿Se puede OFRECER «Cancelar en Kepler» en la ficha de esta requisición? No escribe nada. */
  async disponibleRequisicion(id: string): Promise<RequisicionCancelacionDisponibleDto> {
    const rq = await this.requisicionSuite(id);
    const base = { requisition_id: rq.id, sucursal: rq.sucursal, folio: rq.folio };
    const noSe = this.porQueNoEstaEnKepler(rq);
    if (noSe) return { ...base, disponible: false, porque: noSe, ultima: null };
    const s = rq.sucursal as string;
    const f = rq.folio as string;
    await this.exigirAlcance(s);
    let c: Candados;
    try {
      c = await this.candados({ tipo: 'requisicion', s, f, id: rq.id }, false);
    } catch (e) {
      if (e instanceof HttpException) return { ...base, disponible: false, porque: e.message, ultima: null };
      throw e;
    }
    const ultima = c.ultima ? this.aDtoRequisicion(c.ultima, rq.id) : null;
    if (c.bloqueo) return { ...base, disponible: false, porque: c.bloqueo.porque, ultima };

    const e = await this.tk.run((trx) => this.leerRequisicionReplica(trx, s, f));
    if (!e) {
      return { ...base, disponible: false, porque: 'Esta base no tiene la réplica de Kepler: no se puede revisar la requisición', ultima };
    }
    const d = decidirCancelacionRequisicion(entradaDesdeReplica(e));
    if (!d.ok) return { ...base, disponible: false, porque: d.motivo, ultima };
    return { ...base, disponible: true, porque: null, ultima };
  }

  /** `[KR.7]` La requisición en la réplica de Kepler, con sus OC. Método para que la prueba lo sustituya. */
  leerRequisicionReplica(trx: Knex.Transaction, s: string, f: string): Promise<RequisicionEnReplica | null> {
    return leerRequisicionEnReplica(trx, s, f);
  }

  private async requisicionSuite(id: string): Promise<RequisicionSuite> {
    if (!UUID_RX.test(String(id ?? ''))) throw new BadRequestException('id inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    const r = await this.tk.run((trx) => trx('commercial.purchase_requisitions').where({ tenant_id: tenantId, id })
      .first<{ id: string; estado: string; source_type: string | null; kepler_sucursal: string | null; kepler_folio: string | null } | undefined>(
        'id', 'estado', 'source_type', 'kepler_sucursal', 'kepler_folio'));
    if (!r) throw new NotFoundException('Requisición no encontrada');
    const limpio = (v: string | null) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
    return { id: r.id, estado: r.estado, source_type: r.source_type, sucursal: limpio(r.kepler_sucursal), folio: limpio(r.kepler_folio) };
  }

  /** `null` = sí está en Kepler como requisición de compra. */
  private porQueNoEstaEnKepler(rq: RequisicionSuite): string | null {
    if (rq.source_type === 'branch') return 'Es un traspaso: en Kepler no es una requisición de compra';
    if (!rq.sucursal || !rq.folio) return 'Esta requisición no llegó a Kepler: no hay nada que cancelar allá';
    if (!/^\d{2}$/.test(rq.sucursal) || !/^[A-Za-z0-9-]{1,30}$/.test(rq.folio)) {
      return `La llave de Kepler de esta requisición no es válida (${rq.sucursal}|${rq.folio})`;
    }
    return null;
  }

  /**
   * La entrada de la regla, leída de la RÉPLICA de Kepler (`kepler_ods.kdm1`), con las mismas llaves
   * que el adaptador usa contra Kepler vivo. `null` = la base no tiene la réplica.
   * En la réplica `c4`, `c5` y `c37` son `numeric` (en Kepler, texto): se comparan como número.
   */
  async leerReplica(trx: Knex.Transaction, s: string, f: string): Promise<EntradaDecision | null> {
    if (!(await trx.raw(`SELECT to_regclass('kepler_ods.kdm1') AS t`)).rows[0]?.t) return null;
    const DOC = (tipo: number) => `btrim(c1) = ? AND c2 = 'X' AND c3 = 'A' AND c4::numeric = ${tipo}`;
    const ocs = (await trx.raw(
      `SELECT (c5::numeric)::int::text AS serie, btrim(c6) AS folio, btrim(c43) AS estado, c16::float8 AS total,
              (c37::numeric)::int::text AS origen_tipo, nullif(btrim(c39), '') AS origen_folio
         FROM kepler_ods.kdm1 WHERE ${DOC(35)} AND btrim(c6) = ?`, [s, f])).rows as Array<Record<string, unknown>>;
    const o = ocs[0];
    const vales = (await trx.raw(
      `SELECT btrim(c6) AS folio FROM kepler_ods.kdm1
        WHERE ${DOC(37)} AND c37::numeric = 35 AND btrim(c39) = ? AND btrim(c43) <> 'C' ORDER BY 1`, [s, f])).rows as Array<{ folio: string }>;
    let requisicion: EntradaDecision['requisicion'] = null;
    let otras: string[] = [];
    const origenFolio = o ? (o['origen_folio'] as string | null) : null;
    if (o && o['origen_tipo'] === '30' && origenFolio) {
      const rq = (await trx.raw(
        `SELECT (c5::numeric)::int::text AS serie, btrim(c6) AS folio, btrim(c43) AS estado, c16::float8 AS total
           FROM kepler_ods.kdm1 WHERE ${DOC(30)} AND btrim(c6) = ? LIMIT 1`, [s, origenFolio])).rows[0] as Record<string, unknown> | undefined;
      // `renglones` no decide nada: lo cuenta el adaptador en Kepler vivo, al cancelar.
      if (rq) requisicion = { serie: String(rq['serie']), folio: String(rq['folio']), estado: String(rq['estado']), total: Number(rq['total']) || 0, renglones: 0 };
      otras = ((await trx.raw(
        `SELECT btrim(c6) AS folio FROM kepler_ods.kdm1
          WHERE ${DOC(35)} AND c37::numeric = 30 AND btrim(c39) = ? AND btrim(c6) <> ? AND btrim(c43) <> 'C' ORDER BY 1`,
        [s, origenFolio, f])).rows as Array<{ folio: string }>).map((x) => x.folio);
    }
    return {
      // Capturista, fecha, hora y renglones no deciden nada: los lee el adaptador en Kepler vivo, al cancelar.
      oc: o ? {
        serie: String(o['serie']), folio: String(o['folio']), estado: String(o['estado']), total: Number(o['total']) || 0,
        capturista: '', fecha_captura: '', hora_captura: '', renglones: 0,
        origen_tipo: (o['origen_tipo'] as string | null) ?? null, origen_folio: origenFolio,
      } : null,
      coincidencias: ocs.length,
      vales_vivos: vales.map((v) => v.folio),
      requisicion,
      otras_oc_vivas: otras,
    };
  }


  // ── [PQ.160] Editar cantidades de la OC en Kepler ─────────────────────────────────────────────────────

  /**
   * `[PQ.160]` **Cambiar en Kepler las cantidades de una OC pendiente y sin vale**, con motivo. Candados, en orden
   * (cada uno rechaza con su porqué y sin tocar Kepler): la llave `COMPRAS_OC_EDITAR` (controlador) y el alcance
   * por sucursal; el motivo; el interruptor `edita_oc` de esa sucursal y su tope diario; la regla y los permisos de
   * Kepler (en el adaptador, dentro de su transacción, contra Kepler vivo).
   *
   * Todo intento que llega a Kepler queda en `purchase_order_edits` (aplicada o rechazada), con cada renglón antes
   * y después: la requisición de la que salió no cambia, y esto es lo que explica la diferencia.
   * ⚠️ Kepler y la Suite son dos bases: si Kepler confirma y el registro falla, el log de error lleva todo el renglón.
   */
  async editar(sucursal: string, folio: string, body: Partial<OcEditarInputDto>): Promise<OcEdicionDto> {
    const { s, f } = this.llave(sucursal, folio);
    const m = motivoEdicionValido(typeof body?.motivo === 'string' ? body.motivo : null);
    if (!m.ok) throw new BadRequestException(m.motivo);
    const cambios = Array.isArray(body?.renglones)
      ? body.renglones.map((r) => ({ renglon: Number(r?.renglon), cantidad: Number(r?.cantidad) }))
      : [];
    if (!cambios.length) throw new BadRequestException('No cambiaste ninguna cantidad');
    if (cambios.length > 200) throw new BadRequestException('Demasiados renglones en una edición');
    await this.exigirAlcance(s);

    const c = await this.candadosEdicion(s, true);
    if (c.bloqueo) {
      throw c.bloqueo.status === 409 ? new ConflictException(c.bloqueo.porque) : new ServiceUnavailableException(c.bloqueo.porque);
    }
    const ctx = this.tenantCtx.get();
    const userId = ctx?.userId ?? null;
    const username = ctx?.username ?? null;
    const r = await this.kepler.editar({ sucursal: s, folio: f, cambios });

    const filas = (r.plan?.renglones ?? []).map((x) => ({
      renglon: x.renglon, sku: x.sku, unidad: x.unidad, antes: x.antes, despues: x.despues,
      importe_antes: x.importe_antes, importe_despues: x.importe_despues,
    }));
    const fila = {
      tenant_id: c.tenantId, sucursal: s, oc_folio: f, motivo: m.valor, estado: r.estado,
      rechazo: r.estado === 'rechazada' ? (r.motivo ?? 'Kepler no la editó') : null,
      cambios: JSON.stringify(filas), total_antes: r.plan?.total_antes ?? null, total_despues: r.estado === 'aplicada' ? (r.plan?.total ?? null) : null,
      origen: 'suite', created_by: userId, created_by_username: username, updated_by: userId,
    };
    let creada: string = new Date().toISOString();
    try {
      const [row] = await this.tk.run((trx) => trx(TABLA_EDICION).insert(fila).returning(['created_at']));
      creada = new Date(row.created_at).toISOString();
    } catch (e) {
      this.logger.error(`[PQ.160] OC ${s}|${f} ${r.estado} en Kepler pero NO quedó registrada en la Suite: ${(e as Error).message} — ${JSON.stringify(fila)}`);
    }
    this.logger.log(`[PQ.160] OC ${s}|${f}: ${r.estado}${r.motivo ? ` (${r.motivo})` : ''} por ${username ?? userId ?? 'system'}`);
    return {
      sucursal: s, folio: f, estado: r.estado, rechazo: fila.rechazo, motivo: m.valor, cambios: filas,
      total_antes: fila.total_antes, total_despues: fila.total_despues, editada_por: username, editada_en: creada,
    };
  }

  /** `[PQ.160]` ¿Se puede OFRECER «Editar cantidades» para esta OC, y con qué renglones? No escribe nada. */
  async disponibleEdicion(sucursal: string, folio: string): Promise<OcEdicionDisponibleDto> {
    const { s, f } = this.llave(sucursal, folio);
    await this.exigirAlcance(s);
    const base = { sucursal: s, folio: f, total: null, renglones: [] as OcEdicionRenglonDto[], requisicion: null as string | null };
    let c: Awaited<ReturnType<OcCancelacionService['candadosEdicion']>>;
    try {
      c = await this.candadosEdicion(s, false);
    } catch (e) {
      if (e instanceof HttpException) return { ...base, disponible: false, porque: e.message, ultima: null };
      throw e;
    }
    const leido = await this.tk.run(async (trx) => {
      const u = await trx(TABLA_EDICION).where({ tenant_id: c.tenantId, sucursal: s, oc_folio: f }).whereNull('deleted_at')
        .orderBy('created_at', 'desc').first();
      return { ultima: u ?? null, replica: await this.leerReplicaEdicion(trx, s, f) };
    });
    const ultima = leido.ultima ? this.aDtoEdicion(leido.ultima as Record<string, unknown>) : null;
    if (c.bloqueo) return { ...base, disponible: false, porque: c.bloqueo.porque, ultima };
    if (!leido.replica) return { ...base, disponible: false, porque: 'Esta base no tiene la réplica de Kepler: no se puede revisar la orden', ultima };
    const { entrada, referencia } = leido.replica;
    const rev = revisarOcEditable(entrada);
    if (!rev.ok) return { ...base, disponible: false, porque: rev.motivo, requisicion: referencia, ultima };
    const renglones: OcEdicionRenglonDto[] = rev.oc.renglones.map((r) => ({
      renglon: r.renglon, sku: r.sku, nombre: r.nombre, unidad: r.unidad, factor: r.factor,
      cantidad: presentacion(r) ?? 0, costo: Math.round(r.costo_base * r.factor * 10000) / 10000, importe: r.importe,
    }));
    return { sucursal: s, folio: f, disponible: true, porque: null, total: rev.oc.total, renglones, requisicion: referencia, ultima };
  }

  /** `[PQ.160]` La OC leída de la RÉPLICA, con la misma forma que el adaptador lee de Kepler vivo. */
  private async leerReplicaEdicion(trx: Knex.Transaction, s: string, f: string): Promise<{ entrada: EntradaEdicion; referencia: string | null } | null> {
    if (!(await trx.raw(`SELECT to_regclass('kepler_ods.kdm2') AS t`)).rows[0]?.t) return null;
    const DOC = (tipo: number) => `btrim(c1) = ? AND c2 = 'X' AND c3 = 'A' AND c4::numeric = ${tipo}`;
    const hs = (await trx.raw(
      `SELECT (c5::numeric)::int::text AS serie, btrim(c6) AS folio, btrim(c43) AS estado, coalesce(c13, 0)::float8 AS descuento,
              coalesce(c14, 0)::float8 AS iva, coalesce(c15, 0)::float8 AS ieps, coalesce(c16, 0)::float8 AS total,
              coalesce(c42, 0)::float8 AS saldo, nullif(btrim(c11), '') AS referencia
         FROM kepler_ods.kdm1 WHERE ${DOC(35)} AND btrim(c6) = ?`, [s, f])).rows as Array<Record<string, unknown>>;
    const vales = ((await trx.raw(
      `SELECT btrim(c6) AS folio FROM kepler_ods.kdm1
        WHERE ${DOC(37)} AND c37::numeric = 35 AND btrim(c39) = ? AND btrim(c43) <> 'C' ORDER BY 1`, [s, f])).rows as Array<{ folio: string }>).map((v) => v.folio);
    const h = hs[0];
    if (!h || hs.length !== 1) return { entrada: { oc: null, coincidencias: hs.length, vales_vivos: vales }, referencia: null };
    const rs = (await trx.raw(
      `SELECT c7::int AS renglon, btrim(c8) AS sku, btrim(coalesce(c10, '')) AS nombre,
              coalesce(nullif(btrim(c55::text), ''), btrim(coalesce(c11, ''))) AS unidad,
              coalesce(c9, 0)::float8 AS cantidad_base, coalesce(c12, 0)::float8 AS costo_base, coalesce(c13, 0)::float8 AS importe,
              coalesce(nullif(btrim(c17::text), ''), '0')::float8 AS iva, coalesce(c18, 0)::float8 AS ieps,
              coalesce(c24, 0)::float8 AS pendiente, c31::float8 AS c31,
              coalesce(btrim(c51::text), '') AS c51, coalesce(btrim(c56::text), '') AS c56,
              coalesce(nullif(btrim(c58::text), ''), '1')::float8 AS factor
         FROM kepler_ods.kdm2 WHERE ${DOC(35)} AND c5::numeric = ?::numeric AND btrim(c6) = ? ORDER BY c7::int`,
      [s, String(h['serie']), f])).rows as Array<Record<string, unknown>>;
    const renglones: RenglonOcKepler[] = rs.map((r) => ({
      renglon: Number(r['renglon']), sku: String(r['sku'] ?? ''), nombre: String(r['nombre'] ?? ''), unidad: String(r['unidad'] ?? ''),
      cantidad_base: Number(r['cantidad_base']), costo_base: Number(r['costo_base']), importe: Number(r['importe']),
      iva: Number(r['iva']), ieps: Number(r['ieps']), pendiente: Number(r['pendiente']),
      c31: r['c31'] === null || r['c31'] === undefined ? null : Number(r['c31']),
      c51: String(r['c51'] ?? ''), c56: String(r['c56'] ?? ''), factor: Number(r['factor']),
    }));
    return {
      referencia: (h['referencia'] as string | null) ?? null,
      entrada: {
        coincidencias: 1, vales_vivos: vales,
        oc: {
          serie: String(h['serie']), folio: String(h['folio']), estado: String(h['estado']), descuento: Number(h['descuento']),
          iva: Number(h['iva']), ieps: Number(h['ieps']), total: Number(h['total']), saldo: Number(h['saldo']), renglones,
        },
      },
    };
  }

  /** `[PQ.160]` Migración, interruptor y tope. Sin la tabla lanza 503 (`disponibleEdicion` lo vuelve «no disponible»). */
  private async candadosEdicion(s: string, paraEditar: boolean): Promise<{ tenantId: string; bloqueo: { status: 409 | 503; porque: string } | null }> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = todayMx();
    const suc = warehouseName(s);
    const leido = await this.tk.run(async (trx) => {
      if (!(await trx.raw(`SELECT to_regclass(?) AS t`, [TABLA_EDICION])).rows[0]?.t) {
        throw new ServiceUnavailableException(`Editar OC todavía no está habilitado: falta aplicar la migración ${MIGRACION_PQ160}.`);
      }
      const sw = await trx('commercial.kepler_push_switch').where({ tenant_id: tenantId, sucursal: s, tipo: INTERRUPTOR_EDICION }).first();
      const n = await trx(TABLA_EDICION)
        .where({ tenant_id: tenantId, sucursal: s, estado: 'aplicada', origen: 'suite' }).whereNull('deleted_at')
        .whereRaw(`(created_at AT TIME ZONE 'America/Mexico_City')::date = ?::date`, [hoy])
        .count<{ n: string }[]>('* as n');
      return { sw, hoyN: Number(n[0]?.n ?? 0) };
    });
    if (!leido.sw?.encendida) return { tenantId, bloqueo: { status: 503, porque: `Editar OC en Kepler está apagado para ${suc}: edítala en Kepler a mano` } };
    const tope = leido.sw.tope_dia === null || leido.sw.tope_dia === undefined ? null : Number(leido.sw.tope_dia);
    if (tope !== null && leido.hoyN >= tope) {
      const dicho = paraEditar ? `ya editó hoy ${leido.hoyN} OC desde la Suite` : 'llegó hoy a su tope de ediciones desde la Suite';
      return { tenantId, bloqueo: { status: 503, porque: `${suc} ${dicho} (tope ${tope}): edítala en Kepler a mano` } };
    }
    return { tenantId, bloqueo: null };
  }

  private aDtoEdicion(r: Record<string, unknown>): OcEdicionDto {
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const cambios = typeof r['cambios'] === 'string' ? JSON.parse(r['cambios'] as string) : (r['cambios'] ?? []);
    return {
      sucursal: String(r['sucursal']), folio: String(r['oc_folio']), estado: r['estado'] as OcEdicionDto['estado'],
      rechazo: (r['rechazo'] as string | null) ?? null, motivo: String(r['motivo'] ?? ''), cambios: cambios as OcEdicionDto['cambios'],
      total_antes: num(r['total_antes']), total_despues: num(r['total_despues']),
      editada_por: (r['created_by_username'] as string | null) ?? null, editada_en: new Date(r['created_at'] as string).toISOString(),
    };
  }

  private llave(sucursal: string, folio: string): { s: string; f: string } {
    const s = String(sucursal ?? '').trim();
    const f = String(folio ?? '').trim();
    if (!/^\d{2}$/.test(s)) throw new BadRequestException('sucursal inválida');
    if (!/^[A-Za-z0-9-]{1,30}$/.test(f)) throw new BadRequestException('folio inválido');
    return { s, f };
  }

  private async exigirAlcance(s: string): Promise<void> {
    const alcance = filtroSucursalOc(
      await this.scope.readParam({ warehouse_codes: s }, 'warehouse', 'compras/oc-abiertas', AREA));
    if (!(alcance.todas || alcance.codigos.includes(s))) throw new NotFoundException('Orden de compra no encontrada');
  }

  /**
   * Los candados de la Suite: migración, ya cancelada, interruptor y tope. Sin la tabla lanza 503
   * (el `POST` lo devuelve tal cual; `disponible()` lo convierte en «no disponible»).
   */
  private async candados(doc: Documento, paraCancelar: boolean): Promise<Candados> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = todayMx();
    const { s, f } = doc;
    const suc = warehouseName(s);
    const esOc = doc.tipo === 'oc';
    const leido = await this.tk.run(async (trx) => {
      const t = (await trx.raw(
        `SELECT to_regclass(?) AS t,
                EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'commercial' AND table_name = 'purchase_order_cancellations'
                           AND column_name = 'document_type') AS kr7`, [TABLA])).rows[0] as { t: string | null; kr7: boolean };
      if (!t?.t) {
        throw new ServiceUnavailableException('Cancelar OC todavía no está habilitado: falta aplicar la migración 20261113142557.');
      }
      if (!esOc && !t.kr7) {
        throw new ServiceUnavailableException(`Cancelar la requisición en Kepler todavía no está habilitado: falta aplicar la migración ${MIGRACION_KR7}.`);
      }
      const sw = await trx('commercial.kepler_push_switch').where({ tenant_id: tenantId, sucursal: s, tipo: INTERRUPTOR[doc.tipo] }).first();
      const ultima = (await trx(TABLA).where({ tenant_id: tenantId, sucursal: s }).whereNull('deleted_at')
        .where(esOc ? { oc_folio: f } : { document_type: 'requisicion', requisicion_folio: f })
        .orderByRaw(`(estado = 'cancelada') DESC, created_at DESC`)
        .first('sucursal', 'oc_folio', 'estado', 'rechazo', 'requisicion_folio', 'requisicion_reabierta', 'created_by_username', 'created_at')) as FilaCancelacion | undefined;
      // El tope es POR DOCUMENTO: una requisición cancelada no gasta el tope de las OC, ni al revés. Sin la
      // migración de KR.7 no existe la columna, y tampoco puede haber renglones de requisición.
      const n = await trx(TABLA)
        .where({ tenant_id: tenantId, sucursal: s, estado: 'cancelada' }).whereNull('deleted_at')
        .where((q) => { if (t.kr7) q.where({ document_type: doc.tipo }); })
        .whereRaw(`(created_at AT TIME ZONE 'America/Mexico_City')::date = ?::date`, [hoy])
        .count<{ n: string }[]>('* as n');
      return { sw, ultima: ultima ?? null, hoyN: Number(n[0]?.n ?? 0) };
    });
    const base = { tenantId, hoy, ultima: leido.ultima };
    if (leido.ultima?.estado === 'cancelada') {
      const porque = esOc ? `La OC ${f} de ${suc} ya se canceló desde la Suite` : `La requisición ${f} de ${suc} ya se canceló en Kepler desde la Suite`;
      return { ...base, bloqueo: { status: 409, porque } };
    }
    const aMano = esOc ? 'ciérrala en Kepler a mano' : 'cancélala en Kepler a mano';
    if (!leido.sw?.encendida) {
      const que = esOc ? 'Cancelar OC en Kepler' : 'Cancelar la requisición en Kepler';
      return { ...base, bloqueo: { status: 503, porque: `${que} está apagado para ${suc}: ${aMano}` } };
    }
    const tope = leido.sw.tope_dia === null || leido.sw.tope_dia === undefined ? null : Number(leido.sw.tope_dia);
    if (tope !== null && leido.hoyN >= tope) {
      const cuantas = esOc ? `${leido.hoyN} OC` : `${leido.hoyN} ${leido.hoyN === 1 ? 'requisición' : 'requisiciones'}`;
      const dicho = paraCancelar ? `ya canceló hoy ${cuantas} desde la Suite` : `llegó hoy a su tope de cancelaciones desde la Suite`;
      return { ...base, bloqueo: { status: 503, porque: `${suc} ${dicho} (tope ${tope}): ${aMano}` } };
    }
    return { ...base, bloqueo: null };
  }

  private aDtoRequisicion(r: FilaCancelacion, id: string): RequisicionCancelacionDto {
    return {
      requisition_id: id, sucursal: r.sucursal, folio: r.requisicion_folio ?? '', estado: r.estado, rechazo: r.rechazo,
      // Un intento anterior: la bitácora no guarda si la Suite la canceló (se ve en el estado de la requisición).
      suite_cancelada: null,
      cancelada_por: r.created_by_username, cancelada_en: new Date(r.created_at).toISOString(),
    };
  }

  private aDto(r: FilaCancelacion): OcCancelacionDto {
    return {
      sucursal: r.sucursal, folio: r.oc_folio ?? '', estado: r.estado, rechazo: r.rechazo,
      requisicion_reabierta: r.requisicion_reabierta ? r.requisicion_folio : null,
      cancelada_por: r.created_by_username, cancelada_en: new Date(r.created_at).toISOString(),
    };
  }
}
