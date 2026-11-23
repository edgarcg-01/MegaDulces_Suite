import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import { MOTIVO_MAX, PARAMETROS_PROPUESTOS } from '@megadulces/contracts';
import type {
  AccionDecisionPedido,
  DecisionPedidoBody,
  EstadoDecisionPedido,
  PedidoPorAutorizar,
  ResultadoDecisionPedido,
} from '@megadulces/contracts';
import { CustomerLedgerService } from './customer-ledger.service';
import { armarBandeja, leerBandeja } from './autorizacion-pedidos.service';
import { KeplerAutorizacionPedidoAdapter, type ResultadoEscrituraAutorizacion } from './kepler-autorizacion-pedido.adapter';

/**
 * `[GP.A.2]` C2 — **Lo que decide Crédito y cobranza sobre un pedido TELEMARK, registrado y (si toca) escrito en Kepler.**
 *
 * Mismo esquema que los teléfonos de la cartera (`[CXC.48]`): la fila de la bitácora (`finance.order_authorizations`)
 * nace ANTES de tocar Kepler, la escritura sale de la transacción de la Suite y la fila se cierra con lo que contestó
 * Kepler. Si algo se cae a medio camino, queda el rastro.
 *
 *  · `autorizar` / `regresar` escriben `kdm1.c11` con `KeplerAutorizacionPedidoAdapter` (idempotente; nunca lanza).
 *  · `rechazar` / `escalar` no tocan Kepler: el pedido sigue CREADO y la fila nace `registrado`.
 *
 * Candados para escribir (todos): la migración aplicada, el interruptor `autorizacion` encendido en la sucursal
 * (D-A14: encendido = se puede a mano; el automático necesita además un tope del día), y los tres del adaptador
 * (`KEPLER_AUTORIZACION_PEDIDOS`, la conexión de la sucursal y el GRANT de GP.A.0d).
 */

const TIPO = 'autorizacion';
const SUCURSAL = /^[0-9]{2}$/;
const ACCIONES: readonly AccionDecisionPedido[] = ['autorizar', 'regresar', 'rechazar', 'escalar'];
/** Una fila `pendiente` más vieja que esto se quedó a medias (la API se cayó entre Kepler y la Suite). */
export const PENDIENTE_VENCIDA_MIN = 2;

/** La fila de la bitácora. Texto aquí y no en el query builder: la prueba contra Postgres real corre ESTE SQL. */
export const INSERTAR_DECISION = `INSERT INTO finance.order_authorizations
      (tenant_id, sucursal, serie, folio, cliente_code, importe, accion, automatica, motivo, regla, estado, created_by, updated_by)
    VALUES (current_tenant_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
    RETURNING id`;

export const CERRAR_DECISION = `UPDATE finance.order_authorizations
       SET estado = ?, kepler_resultado = ?::jsonb, updated_by = ?, updated_at = now()
     WHERE id = ? AND estado = 'pendiente'`;

/** La que se quedó `pendiente` (la API se cayó después de escribir o antes): se cierra para no trabar el pedido. */
export const VENCER_PENDIENTES = `UPDATE finance.order_authorizations
       SET estado = 'rechazado', updated_at = now(),
           kepler_resultado = jsonb_build_object('motivo', 'Se quedó sin respuesta de Kepler; revisa el estatus del pedido en Kepler antes de repetir')
     WHERE sucursal = ? AND serie = ? AND folio = ? AND estado = 'pendiente'
       AND created_at < now() - make_interval(mins => ?)`;

/** La última autorización de la Suite que sigue vigente (no regresada después): lo único que se puede regresar (D-A7). */
export const ULTIMA_AUTORIZACION = `SELECT a.id, a.cliente_code, a.importe::float AS importe
      FROM finance.order_authorizations a
     WHERE a.sucursal = ? AND a.serie = ? AND a.folio = ? AND a.accion = 'autorizar' AND a.estado IN ('escrito', 'ya_estaba')
       AND NOT EXISTS (SELECT 1 FROM finance.order_authorizations r
                        WHERE r.sucursal = a.sucursal AND r.serie = a.serie AND r.folio = a.folio
                          AND r.accion = 'regresar' AND r.estado IN ('escrito', 'ya_estaba') AND r.created_at > a.created_at)
     ORDER BY a.created_at DESC LIMIT 1`;

export interface DecisionValidada { sucursal: string; serie: number; folio: string; accion: AccionDecisionPedido; motivo: string }

/** Lo que manda el panel, revisado. Puro: se prueba sin base. */
export function validarDecision(sucursal: string, serie: string | number, folio: string, body: Partial<DecisionPedidoBody> | undefined): DecisionValidada {
  const s = String(sucursal ?? '').trim();
  const n = Number(serie);
  const f = String(folio ?? '').trim();
  if (!SUCURSAL.test(s)) throw new BadRequestException('sucursal inválida');
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException('serie inválida');
  if (!/^[0-9A-Za-z-]{1,20}$/.test(f)) throw new BadRequestException('folio inválido');
  const accion = body?.accion as AccionDecisionPedido;
  if (!ACCIONES.includes(accion)) throw new BadRequestException(`acción inválida: ${String(body?.accion)}`);
  const motivo = String(body?.motivo ?? '').trim();
  if (!motivo) throw new BadRequestException('Escribe el motivo: queda registrado con tu nombre.');
  if (motivo.length > MOTIVO_MAX) throw new BadRequestException(`El motivo pasa de ${MOTIVO_MAX} caracteres.`);
  return { sucursal: s, serie: n, folio: f, accion, motivo };
}

/** Lo que vio la regla al decidir: va a la bitácora (`regla`), para poder explicar la decisión después. */
export function fotoDeLaRegla(p: PedidoPorAutorizar, data_as_of: string | null): Record<string, unknown> {
  return {
    decision: p.resultado.decision,
    motivos: p.resultado.motivos,
    numeros: {
      importe: p.importe, limite: p.limite, plazo_dias: p.plazo_dias, por_cobrar_kepler: p.por_cobrar_kepler,
      otros_pedidos: p.otros_pedidos, saldo_cartera: p.saldo_cartera,
    },
    pedido: { fecha: p.fecha, dias_esperando: p.dias_esperando, es_contado: p.es_contado, ruta_vecinal: p.ruta_vecinal },
    parametros: PARAMETROS_PROPUESTOS,
    data_as_of,
  };
}

/** La frase para la persona y el estado de la bitácora, de lo que contestó Kepler. Puro. */
export function desenlace(accion: AccionDecisionPedido, r: ResultadoEscrituraAutorizacion | null): { estado: EstadoDecisionPedido; mensaje: string; reintentable: boolean } {
  if (r == null) {
    return accion === 'rechazar'
      ? { estado: 'registrado', mensaje: 'Rechazado. El pedido sigue sin autorizar en Kepler y el motivo quedó registrado.', reintentable: false }
      : { estado: 'registrado', mensaje: 'Pasado a Dirección General con tu motivo.', reintentable: false };
  }
  const hecho = accion === 'autorizar' ? 'Autorizado en Kepler.' : 'Regresado a CREADO en Kepler.';
  const yaEstaba = accion === 'autorizar' ? 'Ya estaba autorizado en Kepler.' : 'Ya estaba en CREADO en Kepler.';
  switch (r.estado) {
    case 'escrito': return { estado: 'escrito', mensaje: hecho, reintentable: false };
    case 'ya_estaba': return { estado: 'ya_estaba', mensaje: yaEstaba, reintentable: false };
    case 'apagado': return { estado: 'apagado', mensaje: r.motivo, reintentable: false };
    case 'rechazado': return { estado: 'rechazado', mensaje: r.motivo, reintentable: r.reintentable };
  }
}

const esUnicaEnCurso = (err: unknown): boolean => {
  const e = err as { code?: string; constraint?: string; message?: string };
  return e?.code === '23505' && /ux_fin_oa_una_en_curso/.test(`${e.constraint ?? ''} ${e.message ?? ''}`);
};

@Injectable()
export class AutorizacionDecisionService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly cartera: CustomerLedgerService,
    private readonly kepler: KeplerAutorizacionPedidoAdapter,
  ) {}

  private async hayTabla(trx: Knex.Transaction): Promise<boolean> {
    return (await trx.raw(`SELECT to_regclass('finance.order_authorizations') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  }

  private async interruptorEncendido(trx: Knex.Transaction, sucursal: string): Promise<boolean> {
    const sw = (await trx.raw(
      `SELECT encendida FROM commercial.kepler_push_switch WHERE tenant_id = public.current_tenant_id() AND sucursal = ? AND tipo = ?`,
      [sucursal, TIPO])).rows[0];
    return sw?.encendida === true;
  }

  /** El pedido tal como lo ve la bandeja ahora (misma lectura, misma regla). `null` = ya no está CREADO en el ODS. */
  private async pedidoEnBandeja(trx: Knex.Transaction, tenantId: string, d: DecisionValidada): Promise<{ p: PedidoPorAutorizar; data_as_of: string | null } | null> {
    const fuente = await this.cartera.fuenteCartera(trx);
    const freshness = await this.cartera.freshness(trx, fuente);
    const b = armarBandeja(await leerBandeja(trx, tenantId, fuente.rel, d.sucursal, freshness, PARAMETROS_PROPUESTOS), PARAMETROS_PROPUESTOS);
    // `decididos` incluido a propósito: un pedido rechazado se puede volver a decidir (sigue CREADO en Kepler).
    const p = [...b.pendientes, ...b.aparte, ...b.contado, ...b.decididos].find((x) => x.serie === d.serie && x.folio.trim() === d.folio);
    return p ? { p, data_as_of: freshness.data_as_of ?? null } : null;
  }

  async decidir(sucursal: string, serie: string | number, folio: string, body: Partial<DecisionPedidoBody> | undefined, usuario?: string): Promise<ResultadoDecisionPedido> {
    const d = validarDecision(sucursal, serie, folio, body);
    if (!usuario) throw new BadRequestException('No sé quién decide: vuelve a iniciar sesión.');
    const tenantId = this.tenantCtx.requireTenantId();
    const escribe = d.accion === 'autorizar' || d.accion === 'regresar';

    // 1. Candados y la fila (antes de tocar Kepler).
    const id = await this.tk.run(async (trx) => {
      if (!(await this.hayTabla(trx))) throw new ConflictException('Falta aplicar la migración de GP.A.2.');
      if (escribe && !(await this.interruptorEncendido(trx, d.sucursal))) {
        throw new ConflictException('Autorizar desde la Suite está apagado en esta sucursal. Hazlo en Kepler › Autorización de Pedidos.');
      }
      await trx.raw(VENCER_PENDIENTES, [d.sucursal, d.serie, d.folio, PENDIENTE_VENCIDA_MIN]);

      let cliente: string; let importe: number; let regla: Record<string, unknown>;
      if (d.accion === 'regresar') {
        const a = (await trx.raw(ULTIMA_AUTORIZACION, [d.sucursal, d.serie, d.folio])).rows[0];
        if (!a) throw new ConflictException('La Suite sólo regresa un pedido que ella autorizó y que no se ha regresado.');
        cliente = String(a.cliente_code); importe = Number(a.importe); regla = { regresa: a.id };
      } else {
        const v = await this.pedidoEnBandeja(trx, tenantId, d);
        if (!v) throw new NotFoundException('El pedido ya no espera autorización: en Kepler no está CREADO (o se canceló).');
        cliente = v.p.cliente; importe = v.p.importe; regla = fotoDeLaRegla(v.p, v.data_as_of);
      }
      try {
        const r = await trx.raw(INSERTAR_DECISION, [
          d.sucursal, d.serie, d.folio, cliente, importe, d.accion, false, d.motivo, JSON.stringify(regla),
          escribe ? 'pendiente' : 'registrado', usuario, usuario,
        ]);
        return String(r.rows[0].id);
      } catch (err) {
        if (esUnicaEnCurso(err)) throw new ConflictException('Ese pedido se está escribiendo en Kepler en este momento; espera unos segundos.');
        throw err;
      }
    });

    if (!escribe) return { id, accion: d.accion, ...desenlace(d.accion, null) };

    // 2. Kepler (el adaptador nunca lanza: devuelve lo que pasó).
    const r = await this.kepler.escribir({ sucursal: d.sucursal, serie: d.serie, folio: d.folio, accion: d.accion === 'autorizar' ? 'autorizar' : 'regresar' });
    const fin = desenlace(d.accion, r);

    // 3. El resultado, en la fila.
    await this.tk.run((trx) => trx.raw(CERRAR_DECISION, [fin.estado, JSON.stringify(r), usuario, id]));
    return { id, accion: d.accion, ...fin };
  }
}
