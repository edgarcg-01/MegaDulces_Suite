import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantKnexService } from '@megadulces/platform-core';
import { AJUSTE_ABONO_MOTIVO_MAX, RESTO_TOLERADO_CLIENTE } from '@megadulces/contracts';
import type { CerrarRestosBody, EstadoAjusteAbono, ResultadoAjusteAbono } from '@megadulces/contracts';

import { REFERENCIA_MAX } from './ajuste-abono.armador';
import { KeplerAjusteAbonoSinkAdapter, type ResultadoAjusteAbonoKepler } from './kepler-ajuste-abono-sink.adapter';

/**
 * `[GP.R.3]` C2 — **Cerrar los restos de centavos de un cliente: el interruptor, el registro y Kepler.**
 *
 * Mismo esquema que la decisión sobre un pedido (`[GP.A.2]`): la fila del registro nace ANTES de tocar Kepler, la
 * escritura sale de la transacción de la Suite, y la fila se cierra con lo que Kepler contestó. Si algo se cae a
 * medio camino, queda el rastro — que es la razón de ser de este módulo: hoy un resto se cierra con un «Cobro» de
 * centavos y dentro de tres meses nadie puede explicar quién lo decidió ni por qué.
 *
 * ── El doble testigo ──────────────────────────────────────────────────────────────────────────────────────────
 * El servicio lee el resto en **la cartera** (`analytics.customer_receivables_current`, que es lo que la pantalla
 * muestra) y el adaptador lo **relee del Kepler vivo**. Si los dos no coinciden al centavo, no se escribe. Son dos
 * instrumentos independientes sobre el mismo hecho, y es la regla de la casa: una cifra se arbitra contra un
 * testigo del mismo ERP y grano (ADR-059).
 *
 * ── ⛔⛔ Lo fiscal, que se DECLARA y no se dibuja ──────────────────────────────────────────────────────────────
 * Un Ajuste Abono **no emite CFDI**. Medido en prod el 2026-11-25 sobre los 260 restos vivos:
 *  · **220 ($166.36) son facturas `UD0801`, y las 220 tienen CFDI PPD** → al cerrarlas en Kepler **siguen debiendo
 *    sus centavos ante el SAT**, porque la suma de sus complementos ya no llegará al total.
 *  · **40 ($20.64) son `UD1301`/`UD1201` y NINGUNA tiene CFDI** (control: no existe serie `UD12`/`UD13` entre las
 *    emitidas, sólo `UD05`, `UD06` y `UD08`) → ahí el ajuste no deja nada abierto.
 * Por eso cada ajuste guarda {@link medirInsolutoSat} en su registro: lo que la factura sigue debiendo ante el SAT,
 * o `null` cuando no se pudo medir. **Nunca cero por omisión.** Cerrarlo de verdad es la nota de crédito `U-A-21`,
 * que sí timbra, y el timbre lo pone Kepler, no la Suite (D-F10, abierta).
 */

const TIPO = 'ajuste_abono';
const SUCURSAL = /^[0-9]{2}$/;
const FOLIO = /^[0-9A-Za-z-]{1,20}$/;
/** Una fila `pendiente` más vieja que esto se quedó a medias (la API se cayó entre Kepler y la Suite). */
export const PENDIENTE_VENCIDA_MIN = 2;

/** La fila del registro. Texto aquí y no en el query builder: la prueba contra Postgres real corre ESTE SQL. */
export const INSERTAR_AJUSTE = `INSERT INTO finance.customer_credit_adjustments
      (tenant_id, sucursal, cliente_code, referencia, importe, facturas, automatica, motivo, estado, created_by, updated_by)
    VALUES (current_tenant_id(), ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
    RETURNING id`;

export const CERRAR_AJUSTE = `UPDATE finance.customer_credit_adjustments
       SET estado = ?, kepler_folio = ?, kepler_resultado = ?::jsonb, cfdi_insoluto = ?, updated_by = ?, updated_at = now()
     WHERE id = ? AND estado = 'pendiente'`;

/** La que se quedó `pendiente`: se cierra para no trabar al cliente con el índice único parcial. */
export const VENCER_PENDIENTES = `UPDATE finance.customer_credit_adjustments
       SET estado = 'rechazado', updated_at = now(),
           kepler_resultado = jsonb_build_object('motivo', 'Se quedó sin respuesta de Kepler; revisa el saldo de la factura en Kepler antes de repetir')
     WHERE sucursal = ? AND cliente_code = ? AND estado = 'pendiente'
       AND created_at < now() - make_interval(mins => ?)`;

/**
 * Los restos vivos del cliente, como los ve la pantalla. `doc_code` trae el tipo y la serie del documento de Kepler
 * (`UD0801` = tipo 8, serie 1) y es también el sufijo de la serie del CFDI (`08` + `UD0801` → `08UD0801`).
 */
export const RESTOS_DEL_CLIENTE = `SELECT doc_code, btrim(folio) AS folio,
         round(importe::numeric, 2)::float8 AS importe, round(saldo_documento::numeric, 2)::float8 AS saldo
    FROM analytics.customer_receivables_current
   WHERE tenant_id = current_tenant_id() AND sucursal = ? AND cliente_code = ?
     AND cargo_abono = 'C' AND saldo_documento > 0.004`;

/**
 * Lo que la factura sigue debiendo **ante el SAT**: el `ImpSaldoInsoluto` del último complemento de pago que la
 * nombra. El parseo se validó el 2026-11-25 contra los 9,889 complementos de 2026 con un control aritmético
 * (`ImpSaldoAnt − ImpPagado = ImpSaldoInsoluto`): **0 de 15,160 renglones sin cuadrar**.
 * ⛔ El `raw` del complemento **no** trae el nodo de pagos: el dato sólo está en el XML, y por eso se lee de ahí.
 */
export const INSOLUTO_SAT = `
  WITH nodos AS (
    SELECT c.fecha, (regexp_matches(c.xml, '<[a-zA-Z0-9]*:?DoctoRelacionado ([^>]*)>', 'g'))[1] AS a
      FROM fiscal.cfdis c
     WHERE c.rol = 'emitidas' AND c.tipo_comprobante = 'P' AND c.xml IS NOT NULL
       AND coalesce(c.estatus_sat, '') <> 'Cancelado' AND c.xml LIKE '%' || ? || '%'
  )
  SELECT substring(a from 'ImpSaldoInsoluto="([0-9.]+)"')::numeric::float8 AS insoluto
    FROM nodos
   WHERE substring(a from 'Serie="([^"]*)"') = ? AND btrim(substring(a from 'Folio="([^"]*)"')) = ?
   ORDER BY substring(a from 'NumParcialidad="([0-9]+)"')::int DESC NULLS LAST, fecha DESC
   LIMIT 1`;

export interface CierreValidado { sucursal: string; cliente: string; motivo: string; facturas: { tipo: number; serie: number; folio: string }[] }

/** Lo que manda la pantalla, revisado. Puro: se prueba sin base. */
export function validarCierre(sucursal: string, body: Partial<CerrarRestosBody> | undefined): CierreValidado {
  const s = String(sucursal ?? '').trim();
  if (!SUCURSAL.test(s)) throw new BadRequestException('sucursal inválida');
  const cliente = String(body?.cliente ?? '').trim();
  if (!cliente) throw new BadRequestException('Falta el cliente: un Ajuste Abono es de UN cliente.');
  const motivo = String(body?.motivo ?? '').trim();
  if (!motivo) throw new BadRequestException('Escribe el motivo: queda registrado con tu nombre.');
  if (motivo.length > AJUSTE_ABONO_MOTIVO_MAX) throw new BadRequestException(`El motivo pasa de ${AJUSTE_ABONO_MOTIVO_MAX} caracteres.`);
  const lista = Array.isArray(body?.facturas) ? body.facturas : [];
  if (!lista.length) throw new BadRequestException('Elige al menos una factura con resto.');
  const facturas = lista.map((f) => {
    const tipo = Number(f?.tipo); const serie = Number(f?.serie); const folio = String(f?.folio ?? '').trim();
    if (!Number.isInteger(tipo) || tipo <= 0) throw new BadRequestException(`tipo de documento inválido: ${String(f?.tipo)}`);
    if (!Number.isInteger(serie) || serie <= 0) throw new BadRequestException(`serie inválida: ${String(f?.serie)}`);
    if (!FOLIO.test(folio)) throw new BadRequestException(`folio inválido: ${String(f?.folio)}`);
    return { tipo, serie, folio };
  });
  const vistas = new Set(facturas.map((f) => `${f.tipo}-${f.serie}-${f.folio}`));
  if (vistas.size !== facturas.length) throw new BadRequestException('Una factura viene dos veces: se aplicaría su resto doble.');
  return { sucursal: s, cliente, motivo, facturas };
}

/** `doc_code` → tipo y serie del documento de Kepler (`UD0801` → tipo 8, serie 1). `null` si no tiene esa forma. */
export function tipoSerieDe(docCode: string): { tipo: number; serie: number } | null {
  const m = /^UD(\d{2})(\d{2})$/.exec(String(docCode ?? '').trim());
  return m ? { tipo: Number(m[1]), serie: Number(m[2]) } : null;
}

/** La serie del CFDI de una factura de Kepler: `<sucursal><doc_code>` (400 de 400 ligadas el 2026-11-25). */
export function serieCfdiDe(sucursal: string, docCode: string): string {
  return `${sucursal}${String(docCode ?? '').trim()}`;
}

/**
 * La llave de idempotencia que va a `kdm1.c11`. ⛔ **Tiene que caber en 20 caracteres** (medido escribiendo el
 * 2026-11-24: el primer ensayo murió con «el valor es demasiado largo»).
 */
export function referenciaDe(sucursal: string, ahora: number = Date.now()): string {
  const r = `RC${sucursal}${ahora.toString(36).toUpperCase()}`;
  return r.slice(0, REFERENCIA_MAX);
}

/** La frase para la persona y el estado del registro, de lo que contestó Kepler. Puro. */
export function desenlace(r: ResultadoAjusteAbonoKepler): { estado: EstadoAjusteAbono; mensaje: string; reintentable: boolean } {
  switch (r.estado) {
    case 'escrito':
      return r.ya_estaba
        ? { estado: 'ya_estaba', mensaje: `Ya estaba cerrado en Kepler (Ajuste Abono ${r.kepler.folio}).`, reintentable: false }
        : { estado: 'escrito', mensaje: `Cerrado en Kepler con el Ajuste Abono ${r.kepler.folio}.`, reintentable: false };
    case 'apagado':
      return { estado: 'apagado', mensaje: r.motivo, reintentable: false };
    case 'rechazado':
      return { estado: 'rechazado', mensaje: r.motivo, reintentable: r.reintentable };
  }
}

const esUnicaEnCurso = (err: unknown): boolean => {
  const e = err as { code?: string; constraint?: string; message?: string };
  return e?.code === '23505' && /ux_fin_cca_una_en_curso/.test(`${e.constraint ?? ''} ${e.message ?? ''}`);
};

@Injectable()
export class AjusteAbonoService {
  private readonly logger = new Logger(AjusteAbonoService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly kepler: KeplerAjusteAbonoSinkAdapter,
  ) {}

  private async hayTabla(trx: Knex.Transaction): Promise<boolean> {
    return (await trx.raw(`SELECT to_regclass('finance.customer_credit_adjustments') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  }

  private async interruptorEncendido(trx: Knex.Transaction, sucursal: string): Promise<boolean> {
    const sw = (await trx.raw(
      `SELECT encendida FROM commercial.kepler_push_switch WHERE tenant_id = public.current_tenant_id() AND sucursal = ? AND tipo = ?`,
      [sucursal, TIPO])).rows[0];
    return sw?.encendida === true;
  }

  /**
   * Lo que cada factura del ajuste **sigue debiendo ante el SAT**, sumado. `null` = NO MEDIDO (ninguna de sus
   * facturas tenía un complemento legible), que es distinto de cero.
   */
  async medirInsolutoSat(trx: Knex.Transaction, sucursal: string, facturas: { docCode: string; folio: string }[]): Promise<number | null> {
    let total: number | null = null;
    for (const f of facturas) {
      const serie = serieCfdiDe(sucursal, f.docCode);
      try {
        const r = (await trx.raw(INSOLUTO_SAT, [f.folio, serie, f.folio])).rows[0];
        if (r?.insoluto != null) total = (total ?? 0) + Number(r.insoluto);
      } catch (err) {
        this.logger.warn(`No pude leer el insoluto del SAT de ${serie}/${f.folio}: ${(err as Error).message}`);
      }
    }
    return total == null ? null : Math.round(total * 100) / 100;
  }

  async cerrarRestos(sucursal: string, body: Partial<CerrarRestosBody> | undefined, usuario?: string): Promise<ResultadoAjusteAbono> {
    const d = validarCierre(sucursal, body);
    if (!usuario) throw new BadRequestException('No sé quién cierra el resto: vuelve a iniciar sesión.');
    const referencia = referenciaDe(d.sucursal);

    // ── 1. Candados y la fila, antes de tocar Kepler ────────────────────────────────────────────────────────
    const paso1 = await this.tk.run(async (trx) => {
      if (!(await this.hayTabla(trx))) throw new ConflictException('Falta aplicar la migración de GP.R.2.');
      if (!(await this.interruptorEncendido(trx, d.sucursal))) {
        throw new ConflictException('Cerrar restos desde la Suite está apagado en esta sucursal.');
      }
      await trx.raw(VENCER_PENDIENTES, [d.sucursal, d.cliente, PENDIENTE_VENCIDA_MIN]);

      // El PRIMER testigo: el resto que ve la pantalla. El adaptador lo relee de Kepler y rechaza si no cuadra.
      const vivos = (await trx.raw(RESTOS_DEL_CLIENTE, [d.sucursal, d.cliente])).rows as
        { doc_code: string; folio: string; importe: number; saldo: number }[];
      const elegidas = d.facturas.map((f) => {
        const v = vivos.find((x) => {
          const ts = tipoSerieDe(x.doc_code);
          return ts?.tipo === f.tipo && ts.serie === f.serie && x.folio === f.folio;
        });
        if (!v) throw new NotFoundException(`La factura ${f.tipo}-${f.serie}-${f.folio} ya no tiene resto en la cartera del cliente ${d.cliente}.`);
        if (v.saldo > RESTO_TOLERADO_CLIENTE) {
          throw new ConflictException(`La factura ${f.tipo}-${f.serie}-${f.folio} debe ${v.saldo.toFixed(2)}, más que el tope de ${RESTO_TOLERADO_CLIENTE}: es deuda, no redondeo.`);
        }
        return { ...f, doc_code: v.doc_code, importe: v.importe, saldo: v.saldo };
      });
      const importe = Math.round(elegidas.reduce((s, f) => s + f.saldo, 0) * 100) / 100;

      try {
        const r = await trx.raw(INSERTAR_AJUSTE, [
          d.sucursal, d.cliente, referencia, importe,
          JSON.stringify(elegidas.map((f) => ({ tipo: f.tipo, serie: f.serie, folio: f.folio, doc_code: f.doc_code, importe: f.importe, saldo: f.saldo }))),
          false, d.motivo, 'pendiente', usuario, usuario,
        ]);
        return { id: String(r.rows[0].id), elegidas, importe };
      } catch (err) {
        if (esUnicaEnCurso(err)) throw new ConflictException('Ese cliente se está ajustando en este momento; espera unos segundos.');
        throw err;
      }
    });

    // ── 2. Kepler. El adaptador nunca lanza: devuelve lo que pasó ───────────────────────────────────────────
    const r = await this.kepler.entregar({
      sucursal: d.sucursal, cliente: d.cliente, referencia,
      facturas: d.facturas, tope: RESTO_TOLERADO_CLIENTE,
    });
    const fin = desenlace(r);

    // ── 3. El resultado en la fila, con lo que la factura sigue debiendo ante el SAT ────────────────────────
    const insoluto = await this.tk.run((trx) =>
      this.medirInsolutoSat(trx, d.sucursal, paso1.elegidas.map((f) => ({ docCode: f.doc_code, folio: f.folio }))));
    await this.tk.run((trx) => trx.raw(CERRAR_AJUSTE, [
      fin.estado, fin.estado === 'escrito' || fin.estado === 'ya_estaba' ? (r as { kepler: { folio: string } }).kepler.folio : null,
      JSON.stringify(r), insoluto, usuario, paso1.id,
    ]));

    return {
      estado: fin.estado, mensaje: fin.mensaje, referencia, reintentable: fin.reintentable,
      total: paso1.importe, facturas: paso1.elegidas.length, cfdi_insoluto: insoluto,
      kepler_folio: r.estado === 'escrito' ? r.kepler.folio : null,
    };
  }
}
