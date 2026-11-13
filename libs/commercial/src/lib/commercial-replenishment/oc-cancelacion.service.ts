import {
  BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService, todayMx } from '@megadulces/platform-core';
import { warehouseName, type OcCancelacionDisponibleDto, type OcCancelacionDto } from '@megadulces/contracts';

import { KeplerOcCancelAdapter } from './kepler-oc-cancel.adapter';
import { decidirCancelacionOc, motivoValido, type EntradaDecision } from './kepler-oc-cancelacion';
import { CAPTURISTA_SUITE, horaMx } from './kepler-requisition-sink.adapter';
import { filtroSucursalOc } from './oc-abiertas';

const AREA = 'compras';
const TABLA = 'commercial.purchase_order_cancellations';

interface FilaCancelacion {
  sucursal: string; oc_folio: string; estado: 'cancelada' | 'rechazada'; rechazo: string | null;
  requisicion_folio: string | null; requisicion_reabierta: boolean;
  created_by_username: string | null; created_at: string | Date;
}

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

    const c = await this.candados(s, f, true);
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
      c = await this.candados(s, f, false);
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
  private async candados(s: string, f: string, paraCancelar: boolean): Promise<Candados> {
    const tenantId = this.tenantCtx.requireTenantId();
    const hoy = todayMx();
    const suc = warehouseName(s);
    const leido = await this.tk.run(async (trx) => {
      if (!(await trx.raw(`SELECT to_regclass(?) AS t`, [TABLA])).rows[0]?.t) {
        throw new ServiceUnavailableException('Cancelar OC todavía no está habilitado: falta aplicar la migración 20261113142557.');
      }
      const sw = await trx('commercial.kepler_push_switch').where({ tenant_id: tenantId, sucursal: s, tipo: 'cancela_oc' }).first();
      const ultima = (await trx(TABLA).where({ tenant_id: tenantId, sucursal: s, oc_folio: f }).whereNull('deleted_at')
        .orderByRaw(`(estado = 'cancelada') DESC, created_at DESC`)
        .first('sucursal', 'oc_folio', 'estado', 'rechazo', 'requisicion_folio', 'requisicion_reabierta', 'created_by_username', 'created_at')) as FilaCancelacion | undefined;
      const n = await trx(TABLA)
        .where({ tenant_id: tenantId, sucursal: s, estado: 'cancelada' }).whereNull('deleted_at')
        .whereRaw(`(created_at AT TIME ZONE 'America/Mexico_City')::date = ?::date`, [hoy])
        .count<{ n: string }[]>('* as n');
      return { sw, ultima: ultima ?? null, hoyN: Number(n[0]?.n ?? 0) };
    });
    const base = { tenantId, hoy, ultima: leido.ultima };
    if (leido.ultima?.estado === 'cancelada') {
      return { ...base, bloqueo: { status: 409, porque: `La OC ${f} de ${suc} ya se canceló desde la Suite` } };
    }
    if (!leido.sw?.encendida) {
      return { ...base, bloqueo: { status: 503, porque: `Cancelar OC en Kepler está apagado para ${suc}: ciérrala en Kepler a mano` } };
    }
    const tope = leido.sw.tope_dia === null || leido.sw.tope_dia === undefined ? null : Number(leido.sw.tope_dia);
    if (tope !== null && leido.hoyN >= tope) {
      const dicho = paraCancelar ? `ya canceló hoy ${leido.hoyN} OC desde la Suite` : `llegó hoy a su tope de cancelaciones desde la Suite`;
      return { ...base, bloqueo: { status: 503, porque: `${suc} ${dicho} (tope ${tope}): ciérrala en Kepler a mano` } };
    }
    return { ...base, bloqueo: null };
  }

  private aDto(r: FilaCancelacion): OcCancelacionDto {
    return {
      sucursal: r.sucursal, folio: r.oc_folio, estado: r.estado, rechazo: r.rechazo,
      requisicion_reabierta: r.requisicion_reabierta ? r.requisicion_folio : null,
      cancelada_por: r.created_by_username, cancelada_en: new Date(r.created_at).toISOString(),
    };
  }
}
