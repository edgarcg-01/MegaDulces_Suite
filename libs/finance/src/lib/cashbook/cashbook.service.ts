/**
 * `[LE.4.3]`–`[LE.4.6]` — El libro de efectivo detrás de la API (Fase LE, E4).
 *
 * La pantalla dice QUÉ pasó (`HechoDePersona`); la regla del servidor arma el asiento; la base lo
 * valida TODO otra vez y es la única que escribe (`cashbook.post_entry` / `create_request` /
 * `authorize_request`). Este servicio no decide nada que la base no vuelva a revisar.
 *
 * ── Decisiones, declaradas ──────────────────────────────────────────────────────────────────
 *  · La petición lleva `Idempotency-Key` (uuid): es el `request_id`. Un reintento idéntico
 *    devuelve lo mismo; con otro contenido, la base lo rechaza (B3).
 *  · Un hecho que siempre pide cuatro ojos (faltante, sobrante, ajuste, apertura) o que pasa el
 *    umbral de `authorization_rules` NO entra: queda como solicitud que otra persona autoriza.
 *  · Una solicitud vence a las 72 horas (B45). D3 dijo «sin plazo para RENDIR»; esto es otra cosa:
 *    el plazo para que alguien firme lo que se pidió.
 *  · Cerrar la jornada: quien cierra es quien hizo el ÚLTIMO arqueo de cierre de la caja en esa
 *    jornada (se lee de la base, no lo dice el cliente) y quien autoriza es la sesión. Sin arqueo
 *    no hay cierre; si son la misma persona, la base lo rechaza (B9).
 *  · El vínculo usuario → empleado no existe todavía: se manda sólo el usuario (deuda de LE.4).
 *  · La reautenticación al autorizar (B27) NO está: deuda con nombre, antes del cambio (E7).
 */
import { BadRequestException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import {
  CUENTA,
  EVENTOS_SIEMPRE_AUTORIZADOS,
  type ConteoDeCaja,
  type CuentaPropuesta,
  type DestinoDeSuspenso,
  type HechoDePersona,
  type OrigenDiferencia,
  type PiezasTexto,
  type ResultadoConteo,
  type ResultadoHecho,
  type SaldoDeCuenta,
  type SaldosDelLibro,
} from '@megadulces/contracts';
import { traducirErrorDelLibro } from './errores';
import {
  CUENTAS_FIJAS, apertura, chequeDepositado, chequeDevuelto, chequeRecibido, clasificarSuspenso, cobroEnDolares, depositoEnBanco,
  entregaRuta, faltante, gasto, otroIngreso, regresoCustodiaAlCajon, sobrante, type Contexto, type Propuesta,
} from './reglas';

export interface UsuarioDelLibro {
  id?: string;
  username?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VIGENCIA_DE_SOLICITUD = '72 hours';

type Origen = Parameters<typeof faltante>[0]['de'];

function origen(o: OrigenDiferencia): Origen {
  if (o.tipo === 'ruta') return { tipo: 'ruta', ruta: o.ruta, monto: o.monto_minor };
  if (o.tipo === 'custodia') return { tipo: 'custodia', empleado: o.empleado, nombre: o.nombre, monto: o.monto_minor };
  return { tipo: 'cajon', piezas: o.piezas };
}

function destino(d: DestinoDeSuspenso): CuentaPropuesta {
  if (d.tipo === 'cajon') return CUENTAS_FIJAS.CAJA_MXN;
  if (d.tipo === 'transito') return CUENTAS_FIJAS.TRANSITO_BANCO;
  if (d.tipo === 'ruta') return CUENTA.porRendirRuta(d.ruta);
  return CUENTA.custodia(d.empleado, d.nombre);
}

/** El hecho de la pantalla → la propuesta de asiento (la regla pura de `reglas.ts`). */
export function propuestaDeHecho(h: HechoDePersona, ctx: Contexto, usuario: string): Propuesta {
  switch (h.tipo) {
    case 'entrega_ruta': return entregaRuta({ ruta: h.ruta, piezas: h.piezas }, ctx);
    case 'gasto':
      return gasto({ concepto: h.concepto, desde: h.desde.tipo === 'cajon' ? { tipo: 'cajon', piezas: h.desde.piezas }
        : { tipo: 'custodia', empleado: h.desde.empleado, nombre: h.desde.nombre, monto: h.desde.monto_minor } }, ctx);
    case 'regreso_custodia': return regresoCustodiaAlCajon({ empleado: h.empleado, nombre: h.nombre, piezas: h.piezas }, ctx);
    case 'faltante': return faltante({ de: origen(h.de), empleado: h.empleado, nombre: h.nombre }, ctx);
    case 'sobrante': return sobrante({ en: origen(h.en), empleado: h.empleado, nombre: h.nombre }, ctx);
    case 'cobro_usd':
      return cobroEnDolares({ ruta: h.ruta, piezasUsd: h.piezas_usd, tipoDeCambio: h.tipo_de_cambio, fuente: h.fuente, fijadoPor: usuario }, ctx);
    case 'cheque_recibido': return chequeRecibido({ ruta: h.ruta, folio: h.folio, monto: h.monto_minor }, ctx);
    case 'cheque_depositado': return chequeDepositado({ folio: h.folio, monto: h.monto_minor }, ctx);
    case 'cheque_devuelto':
      return chequeDevuelto({ ruta: h.ruta, folio: h.folio, monto: h.monto_minor,
        desde: h.cuenta_banco ? { tipo: 'banco', cuentaBanco: h.cuenta_banco } : { tipo: 'transito' } }, ctx);
    case 'deposito_banco': return depositoEnBanco({ cuentaBanco: h.cuenta_banco, monto: h.monto_minor, referencia: h.referencia }, ctx);
    case 'otro_ingreso': return otroIngreso({ concepto: h.concepto, piezas: h.piezas }, ctx);
    case 'clasificar_suspenso':
      return clasificarSuspenso({ eventRefOriginal: h.event_ref_original, monto: h.monto_minor, estaEn: h.esta_en, hacia: destino(h.hacia), piezas: h.piezas }, ctx);
    case 'apertura': return apertura({ moneda: h.moneda, fecha: h.fecha, conteos: h.conteos }, ctx);
    default: {
      const nunca: never = h;
      throw new BadRequestException({ codigo: 'hecho_desconocido', mensaje: `Tipo de hecho desconocido: ${JSON.stringify(nunca)}` });
    }
  }
}

@Injectable()
export class CashbookService {
  private readonly logger = new Logger(CashbookService.name);

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
      throw new BadRequestException({ codigo: 'sin_idempotency_key', mensaje: 'Cada registro lleva el encabezado Idempotency-Key (un uuid), para que un reintento no lo duplique.' });
    }
    return k.toLowerCase();
  }

  private run<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    this.tenantCtx.requireTenantId();
    return this.tk.run(fn).catch((e: unknown) => traducirErrorDelLibro(e));
  }

  private async asegurarCuentas(trx: Knex.Transaction, cuentas: CuentaPropuesta[], usuario: string): Promise<void> {
    for (const c of cuentas) await trx.raw('SELECT cashbook.open_account(?::jsonb)', [JSON.stringify({ ...c, user_id: usuario })]);
  }

  private async pedir(trx: Knex.Transaction, p: Propuesta, motivo: string): Promise<ResultadoHecho> {
    const r = await trx.raw(`SELECT cashbook.create_request(?::jsonb, clock_timestamp() + ?::interval) AS id`,
      [JSON.stringify(p.asiento), VIGENCIA_DE_SOLICITUD]);
    return { estado: 'por_autorizar', request_id: r.rows[0].id as string, motivo };
  }

  /** Registra un hecho de persona. Si pide cuatro ojos, queda como solicitud. */
  async registrarHecho(h: HechoDePersona, usuario: UsuarioDelLibro, idempotencyKey: string | undefined): Promise<ResultadoHecho> {
    const quien = this.quien(usuario);
    const key = this.llave(idempotencyKey);
    const ctx: Contexto = { actor: { kind: 'persona', user_id: quien }, valueAt: new Date().toISOString(), requestId: key };
    return this.run(async (trx) => {
      const p = propuestaDeHecho(h, ctx, quien);
      await this.asegurarCuentas(trx, p.cuentas, quien);
      if ((EVENTOS_SIEMPRE_AUTORIZADOS as readonly string[]).includes(p.asiento.event_kind)) {
        return this.pedir(trx, p, `${p.asiento.event_kind}: siempre lo autoriza otra persona`);
      }
      await trx.raw('SAVEPOINT le_registrar');
      try {
        const r = await trx.raw('SELECT cashbook.post_entry(?::jsonb) AS id', [JSON.stringify(p.asiento)]);
        await trx.raw('RELEASE SAVEPOINT le_registrar');
        return { estado: 'asentado', entry_id: r.rows[0].id as string };
      } catch (e) {
        await trx.raw('ROLLBACK TO SAVEPOINT le_registrar');
        if ((e as { constraint?: string }).constraint === 'cashbook_requiere_autorizacion') {
          return this.pedir(trx, p, 'pasa el umbral de autorización');
        }
        throw e;
      }
    });
  }

  async autorizar(requestId: string, usuario: UsuarioDelLibro): Promise<{ entry_id: string }> {
    const quien = this.quien(usuario);
    return this.run(async (trx) => {
      const r = await trx.raw('SELECT cashbook.authorize_request(?, ?, NULL) AS id', [requestId, quien]);
      this.logger.log(`[LE.4] solicitud ${requestId} autorizada por ${usuario.username ?? quien}`);
      return { entry_id: r.rows[0].id as string };
    });
  }

  async rechazar(requestId: string, nota: string, usuario: UsuarioDelLibro): Promise<void> {
    const quien = this.quien(usuario);
    await this.run((trx) => trx.raw('SELECT cashbook.reject_request(?, ?, NULL, ?)', [requestId, quien, nota ?? '']));
  }

  /** Pide la reversa de un asiento: siempre la autoriza otra persona. */
  async pedirReversa(entryId: string, motivo: string, usuario: UsuarioDelLibro, idempotencyKey: string | undefined): Promise<ResultadoHecho> {
    const quien = this.quien(usuario);
    const key = this.llave(idempotencyKey);
    return this.run(async (trx) => {
      const r = await trx.raw(`SELECT cashbook.create_request(?::jsonb, clock_timestamp() + ?::interval) AS id`, [JSON.stringify({
        reverses_entry_id: entryId, reason: motivo, request_id: key, actor: { kind: 'persona', user_id: quien }, lines: [],
      }), VIGENCIA_DE_SOLICITUD]);
      return { estado: 'por_autorizar', request_id: r.rows[0].id as string, motivo: 'una reversa siempre la autoriza otra persona' };
    });
  }

  /** Un arqueo. En uno SORPRESA no se devuelve ni el esperado ni la diferencia (B11). */
  async contar(c: ConteoDeCaja, usuario: UsuarioDelLibro): Promise<ResultadoConteo> {
    const quien = this.quien(usuario);
    return this.run(async (trx) => {
      const r = (await trx.raw('SELECT cashbook.register_count(?::jsonb) AS r', [JSON.stringify({
        account: c.cuenta, kind: c.tipo, source: 'persona', counted_by: quien, witness_by: c.testigo ?? null,
        counted_at: c.contado_en, blind: true, pieces: c.piezas,
      })])).rows[0].r as { count_id: string; total_minor: string; expected_minor: string; difference_minor: string; finding_id: string | null };
      if (c.tipo === 'sorpresa') return { ciego: true, count_id: r.count_id, total_minor: r.total_minor };
      return { ciego: false, count_id: r.count_id, total_minor: r.total_minor, esperado_minor: r.expected_minor,
        diferencia_minor: r.difference_minor, hallazgo_id: r.finding_id };
    });
  }

  async abrirJornada(fecha: string, usuario: UsuarioDelLibro): Promise<void> {
    const quien = this.quien(usuario);
    await this.run((trx) => trx.raw('SELECT cashbook.open_day(?::date, ?)', [fecha, quien]));
  }

  /** Cierra quien hizo el último arqueo de cierre de la caja en la jornada; autoriza la sesión. */
  async cerrarJornada(fecha: string, usuario: UsuarioDelLibro): Promise<{ cerro: string; autorizo: string }> {
    const autoriza = this.quien(usuario);
    return this.run(async (trx) => {
      const arqueo = (await trx.raw(`
        SELECT c.counted_by FROM cashbook.counts c
          JOIN cashbook.accounts a ON a.id = c.account_id
          JOIN cashbook.business_days d ON d.tenant_id = c.tenant_id AND d.business_date = ?::date
         WHERE a.code = 'CAJA_MXN' AND c.kind = 'cierre' AND c.recorded_at >= d.opened_at
         ORDER BY c.recorded_at DESC LIMIT 1`, [fecha])).rows[0] as { counted_by: string } | undefined;
      if (!arqueo) {
        throw new UnprocessableEntityException({ codigo: 'cashbook_cierre_sin_arqueo', mensaje: 'Antes de cerrar la jornada falta el arqueo de cierre de la caja.' });
      }
      await trx.raw('SELECT cashbook.close_day(?::date, ?, NULL, ?, NULL)', [fecha, arqueo.counted_by, autoriza]);
      return { cerro: arqueo.counted_by, autorizo: autoriza };
    });
  }

  /**
   * Con un asiento: lo cierra la sesión (el asiento ya pasó sus cuatro ojos). Con una nota: la
   * FIRMA la sesión y queda como quien cerró quien registró el hallazgo (se lee de la base, nunca
   * lo dice el cliente); si son la misma persona, la base lo rechaza.
   */
  async cerrarHallazgo(id: string, input: { entry_id?: string; nota?: string }, usuario: UsuarioDelLibro): Promise<void> {
    const quien = this.quien(usuario);
    await this.run(async (trx) => {
      if (input.entry_id) {
        await trx.raw('SELECT cashbook.close_finding(?, ?, NULL, ?, NULL, NULL)', [id, quien, input.entry_id]);
        return;
      }
      const f = (await trx.raw('SELECT created_by, source FROM cashbook.findings WHERE id = ?', [id])).rows[0] as
        { created_by: string | null; source: string } | undefined;
      // `[LE.4.8]` Una alerta de permisos la revisa UNA persona que no hizo el cambio ni lo recibió (lo exige la base).
      if (f?.source === 'permiso') {
        await trx.raw('SELECT cashbook.close_finding(?, ?, NULL, NULL, ?, NULL)', [id, quien, input.nota ?? null]);
        return;
      }
      if (!f?.created_by) {
        throw new UnprocessableEntityException({ codigo: 'cashbook_hallazgo_sin_registrante',
          mensaje: 'Ese hallazgo no dice quién lo registró: se cierra con un movimiento, no con una nota.' });
      }
      await trx.raw('SELECT cashbook.close_finding(?, ?, NULL, NULL, ?, ?)', [id, f.created_by, input.nota ?? null, quien]);
    });
  }

  // ── Lectura ───────────────────────────────────────────────────────────────────────────────

  async saldos(conPiezas: boolean): Promise<SaldosDelLibro> {
    return this.run(async (trx) => {
      const cuentas = (await trx.raw(`SELECT code, name, class, currency, balance_minor::text, last_seq::text
        FROM cashbook.v_saldos ORDER BY class, code`)).rows as SaldoDeCuenta[];
      if (conPiezas) {
        const piezas = (await trx.raw('SELECT code, denom_key, pieces::text FROM cashbook.v_saldos_piezas WHERE pieces <> 0')).rows as
          { code: string; denom_key: string; pieces: string }[];
        for (const c of cuentas) {
          const suyas = piezas.filter((p) => p.code === c.code);
          if (suyas.length) c.piezas = Object.fromEntries(suyas.map((p) => [p.denom_key, p.pieces])) as PiezasTexto;
        }
      }
      const ultimo = (await trx.raw('SELECT coalesce(max(last_seq), 0)::text AS s FROM cashbook.seq_counters')).rows[0].s as string;
      const jornada = (await trx.raw(`SELECT business_date::text AS d FROM cashbook.business_days WHERE state = 'abierta'`)).rows[0] as { d: string } | undefined;
      const problemas = (await trx.raw('SELECT seq::text, problema FROM cashbook.verify_chain()')).rows as { seq: string; problema: string }[];
      return { cuentas, ultimo_asiento: ultimo, jornada_abierta: jornada?.d ?? null, integridad: { integra: problemas.length === 0, problemas } };
    });
  }

  async mayor(desdeSeq: number, limite: number): Promise<Record<string, unknown>[]> {
    const tope = Math.min(Math.max(1, limite || 200), 1000);
    return this.run(async (trx) => (await trx.raw(`
      SELECT seq::text, business_date::text, value_at, event_kind, event_ref, actor_kind, created_by, service_name, authorized_by,
             reverses_entry_id, reason, rule_version, line_no, account_code, currency, amount_minor::text, entry_id
        FROM cashbook.v_mayor WHERE seq > ? ORDER BY seq, line_no LIMIT ?`, [desdeSeq || 0, tope])).rows as Record<string, unknown>[]);
  }

  async hallazgos(): Promise<Record<string, unknown>[]> {
    return this.run(async (trx) => (await trx.raw(`SELECT id, source, account_code, business_date::text, amount_minor::text, detail,
      owner_user, opened_at, dias_abierto FROM cashbook.v_hallazgos_abiertos ORDER BY opened_at`)).rows as Record<string, unknown>[]);
  }

  async pendientes(): Promise<Record<string, unknown>[]> {
    return this.run(async (trx) => (await trx.raw(`SELECT id, event_kind, gross_minor::text, registered_by, created_at, expires_at, payload
      FROM cashbook.requests WHERE state = 'pendiente' ORDER BY created_at`)).rows as Record<string, unknown>[]);
  }
}
