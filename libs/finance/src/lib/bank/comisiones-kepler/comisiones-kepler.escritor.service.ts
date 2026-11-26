import { Injectable, Logger } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService, toMxDateKey, todayMx } from '@megadulces/platform-core';

import { KeplerGastoSinkAdapter } from '../../expense-proofs/comprobacion-kepler/kepler-gasto-sink.adapter';
import { KeplerSolicitudGastoSinkAdapter } from '../../expense-proofs/solicitud-kepler/kepler-solicitud-gasto-sink.adapter';
import { KeplerPagoSinkAdapter } from '../../payment-calendar/kepler-pago/kepler-pago-sink.adapter';
import { entregasDelDia, marcaDeComisiones, type EntregasDelDia } from './comisiones-kepler.escritor';
import { ComisionesKeplerService } from './comisiones-kepler.service';
import type { DiaPropuesta, PropuestaComisiones } from './comisiones-kepler.query';

/**
 * `[CB.62.4]` C2 — **La Suite escribe en Kepler las comisiones de la terminal que nadie ha capturado.**
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CB_CONCILIACION_BANCARIA.md` §9.5.
 *
 * ⛔ **Este servicio NO escribe en Kepler.** Encadena a los tres que ya saben hacerlo, cada uno con sus propios
 * candados, su plantilla por servidor y su `GRANT`:
 *
 *   1. `KeplerSolicitudGastoSinkAdapter` → la solicitud `X-A-15`, que **nace en `A`** (medido: 16 vivas así);
 *   2. `KeplerGastoSinkAdapter` → el gasto `X-A-10` con su póliza D y sus acumulados, que de paso **deja la
 *      solicitud en `F` con saldo 0** (por eso nace en `A` y no en `F`);
 *   3. `KeplerPagoSinkAdapter` → un `X-D-26` por cargo del banco, con su `kdm5`, su póliza E y su `kdxf`
 *      aplicado contra la CxP del gasto, que queda en 0.
 *
 * Lo que este servicio aporta es lo único que los tres no saben: **qué días van**, con qué cargos, de qué
 * sucursal y de qué día de venta. Eso lo decide el armador de CB.62 (C0/C1) y lo traduce `entregasDelDia`.
 *
 * ── Los diales, y los cinco tienen que estar abiertos ────────────────────────────────────────────────────────
 *   1. `KEPLER_COMISIONES_TERMINAL=encendida` (apagado por default): el freno de este proceso;
 *   2. los interruptores de los tres escritores (`KEPLER_GASTO_SOLICITUD`, `KEPLER_GASTO_COMPROBACION`,
 *      `KEPLER_PAGO_ESCRITURA`) — los revisa cada uno en su `entregar`, no este servicio;
 *   3. el renglón `comisiones_terminal` de `commercial.kepler_push_switch`, por sucursal, con su tope del día;
 *   4. ⭐ **D3: `finance.bank_accounts.comisiones_kepler_desde`, por CUENTA y con fecha.** Una cuenta sin fecha
 *      la sigue capturando Finanzas; un cargo anterior a esa fecha es atraso de Finanzas y no se escribe;
 *   5. los `GRANT` en el Kepler de la sucursal (`ops/prod/kepler-grants/cb62_comisiones_terminal.sql`).
 *
 * ── Qué tan cerrados están los tres candados contra duplicados ───────────────────────────────────────────────
 * `candadosDelDia` (pago capturado · comisión ya en un gasto de Finanzas · cualquier captura de Finanzas ese día)
 * corre sobre el **ODS**, que replica el Kepler de cada sucursal con minutos de retraso (medido el 2026-11-26:
 * trae documentos capturados HOY en 00, 05, 06 y 08). La propuesta se vuelve a leer **dentro de este método**,
 * nunca de una caché de la pantalla, y encima la solicitud se busca por su **marca en el Kepler vivo** antes de
 * escribir (eso sí es tiempo real, y es lo que impide que la Suite escriba dos veces).
 *
 * ⚠️ **Lo que queda abierto y se declara, no se dibuja como cerrado:** la ventana del retraso del ODS contra una
 * persona de Finanzas capturando ESE día en ESE minuto. Lo que de verdad la cierra es **D3**: la cuenta pasa a la
 * Suite y Finanzas deja de capturarla. Por eso el dial 4 es por cuenta, y por eso no se enciende una cuenta sin
 * avisarle a Finanzas.
 */

/** El tipo del renglón de `commercial.kepler_push_switch`. */
export const TIPO_INTERRUPTOR_COMISIONES = 'comisiones_terminal';

/** Los estados desde los que un día SE PUEDE retomar. `escrito` y `en_duda` no están, a propósito. */
export const ESTADOS_RETOMABLES = ['pendiente', 'reintento', 'rechazado'] as const;

/** Por qué no se pudo reclamar el día, con su estado real. Puro, para probarlo solo. */
export function motivoDeNoReclamar(estado: string | undefined): string {
  switch (estado) {
    case 'escrito': return 'Este día ya se escribió en Kepler';
    case 'escribiendo': return 'Otro proceso está escribiendo este día ahora mismo';
    case 'en_duda': return '⛔ Este día quedó EN DUDA: la respuesta de Kepler no volvió. Búscalo en Kepler antes de reintentar';
    case undefined: return 'No se pudo reclamar el día y su renglón desapareció: no se intentó escribir';
    default: return `No se pudo reclamar el día (quedó en «${estado}»)`;
  }
}

/** El freno global de este proceso. Nace apagado: sin él no se intenta nada. */
export function escrituraDeComisionesEncendida(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env['KEPLER_COMISIONES_TERMINAL'] ?? '').trim() === 'encendida';
}

/** Lo que pasó con un día. `apagado` NO cuenta como intento: el día sigue esperando a que lo enciendan. */
export type ResultadoDia =
  | { estado: 'escrito'; llave: string; sucursal: string; dia_venta: string; solicitud: string; gasto: string; pagos: { cargo: string; folio: string }[]; total: number }
  | { estado: 'ya_estaba'; llave: string; sucursal: string; dia_venta: string; solicitud: string; nota: string }
  | { estado: 'apagado'; llave: string; sucursal: string; dia_venta: string; motivo: string }
  | { estado: 'rechazado'; llave: string; sucursal: string; dia_venta: string; motivo: string }
  /** El COMMIT salió y la respuesta no volvió. ⛔ NO se reintenta sin buscar antes la marca en Kepler. */
  | { estado: 'en_duda'; llave: string; sucursal: string; dia_venta: string; motivo: string };

export interface ResultadoGeneracion {
  /** Lo que la propuesta traía como `lista` al empezar. */
  candidatos: number;
  escritos: number;
  resultados: ResultadoDia[];
  /** La propuesta con la que se decidió, para que la pantalla no vuelva a pedirla. */
  propuesta: PropuestaComisiones;
}

/** El dial de D3 de una cuenta: desde cuándo la escribe la Suite. */
export interface DialDeCuenta { account_label: string; comisiones_kepler_desde: string | null }

/**
 * ⛔⛔ **La fecha de D3 tal como la devuelve la base, convertida a `YYYY-MM-DD`.**
 *
 * `pg` entrega una columna `date` como **objeto `Date`**, no como texto. Esto estaba escrito
 * `String(valor).slice(0, 10)`, que sobre un `Date` da **`'Tue Nov 1'`** — y entonces
 * `'2026-11-17' < 'Tue Nov 1'` es **true** (`'2' < 'T'` en ASCII), así que TODO cargo quedaba como
 * «atraso de Finanzas» y **ninguna cuenta podía escribir jamás**, con un motivo que suena legítimo.
 *
 * Lo encontró el canario del 2026-11-26, no una prueba: las 9 de `dialDeD3Cierra` son puras y le
 * pasan strings, así que nunca cruzan la frontera base→código, que es donde estaba el defecto.
 *
 * `toMxDateKey` es el primitivo del repo para esto (ADR-056) y no desplaza el día por zona horaria.
 */
export function fechaDelDial(valor: Date | string | null | undefined): string | null {
  const k = toMxDateKey(valor);
  return k || null;
}

/**
 * ⭐ **D3, el dial que de verdad importa.** ¿Esta cuenta ya pasó a la Suite, y este cargo es posterior al cambio
 * de manos? Devuelve el motivo si no, `null` si pasa. Puro, para probarlo solo.
 *
 * Dos reglas, y las dos nacen de lo mismo —no escribir encima de Finanzas—:
 *  - una cuenta **sin fecha** la sigue capturando Finanzas: no se escribe nada de ella;
 *  - un cargo **anterior** a la fecha es atraso de Finanzas, no trabajo de la Suite. Sin esto, encender BBVA 4885
 *    habría escrito también el atraso que Finanzas tiene a medio capturar, que es justo lo que los tres candados
 *    intentan evitar.
 *
 * ⛔ Un día con cargos de DOS cuentas necesita que las dos hayan pasado: media cuenta no se escribe, porque el
 * gasto es uno solo y no se parte.
 */
export function dialDeD3Cierra(
  cargos: readonly { cuenta: string; fecha: string }[], diales: ReadonlyMap<string, DialDeCuenta>,
): string | null {
  for (const cuenta of [...new Set(cargos.map((c) => String(c.cuenta).trim()))]) {
    const desde = diales.get(cuenta)?.comisiones_kepler_desde ?? null;
    if (!desde) return `La cuenta ${cuenta} todavía la captura Finanzas: no tiene fecha de cambio de manos (D3)`;
    const antes = cargos.filter((c) => String(c.cuenta).trim() === cuenta && c.fecha < desde);
    if (antes.length) return `${antes.length} cargo(s) de la cuenta ${cuenta} son anteriores al cambio de manos (${desde}): son atraso de Finanzas`;
  }
  return null;
}

type Trx = Knex | Knex.Transaction;

@Injectable()
export class ComisionesKeplerEscritorService {
  private readonly logger = new Logger(ComisionesKeplerEscritorService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly propuestaSvc: ComisionesKeplerService,
    private readonly solicitudes: KeplerSolicitudGastoSinkAdapter,
    private readonly gastos: KeplerGastoSinkAdapter,
    private readonly pagos: KeplerPagoSinkAdapter,
  ) {}

  /** Las variables de entorno en un método, no en el constructor: un parámetro sin token tumba el arranque (#414). */
  protected get env(): Readonly<Record<string, string | undefined>> { return process.env; }

  /**
   * Escribe en Kepler los días `lista` de la ventana. Nunca lanza hacia la pantalla: cada día devuelve lo que le
   * pasó, y lo que no se pudo escribir queda dicho con su motivo.
   */
  async generar(dias = 14, hoy = todayMx()): Promise<ResultadoGeneracion> {
    const tenantId = this.tenantCtx.requireTenantId();
    // ⛔ La propuesta se vuelve a leer AQUÍ: la que pintó la pantalla puede tener minutos y en ese rato Finanzas
    // pudo capturar el día. Nunca se escribe con lo que mandó el navegador.
    const propuesta = await this.propuestaSvc.propuesta(dias, hoy);
    const candidatos = propuesta.dias.filter((d) => d.estado === 'lista');
    const resultados: ResultadoDia[] = [];

    if (!propuesta.medido) {
      return { candidatos: 0, escritos: 0, resultados, propuesta };
    }
    if (!escrituraDeComisionesEncendida(this.env)) {
      for (const d of candidatos) resultados.push(this.apagado(d, 'La escritura de comisiones a Kepler está apagada (KEPLER_COMISIONES_TERMINAL)'));
      return { candidatos: candidatos.length, escritos: 0, resultados, propuesta };
    }

    const diales = await this.dialesDeCuenta(tenantId);
    const interruptores = await this.interruptores(tenantId);

    for (const d of candidatos) {
      const r = await this.unDia(tenantId, d, diales, interruptores, hoy).catch((e: unknown) => this.rechazo(d, `Falla inesperada: ${(e as Error)?.message ?? e}`));
      resultados.push(r);
    }
    return { candidatos: candidatos.length, escritos: resultados.filter((r) => r.estado === 'escrito').length, resultados, propuesta };
  }

  // ── Los diales ───────────────────────────────────────────────────────────────────────────────────────────

  private async dialesDeCuenta(tenantId: string): Promise<Map<string, DialDeCuenta>> {
    const filas = await this.tk.run((trx: Trx) => trx('finance.bank_accounts')
      .where({ tenant_id: tenantId })
      .select<DialDeCuenta[]>('account_label', 'comisiones_kepler_desde'));
    return new Map(filas.map((f) => [String(f.account_label).trim(), { ...f, comisiones_kepler_desde: fechaDelDial(f.comisiones_kepler_desde) }]));
  }

  private async interruptores(tenantId: string): Promise<Map<string, { encendida: boolean; tope_dia: number | null }>> {
    const filas = await this.tk.run((trx: Trx) => trx('commercial.kepler_push_switch')
      .where({ tenant_id: tenantId, tipo: TIPO_INTERRUPTOR_COMISIONES })
      .select<{ sucursal: string; encendida: boolean; tope_dia: number | null }[]>('sucursal', 'encendida', 'tope_dia'));
    return new Map(filas.map((f) => [String(f.sucursal).trim(), { encendida: !!f.encendida, tope_dia: f.tope_dia ?? null }]));
  }

  // ── Un día ───────────────────────────────────────────────────────────────────────────────────────────────

  private async unDia(
    tenantId: string, d: DiaPropuesta, diales: Map<string, DialDeCuenta>,
    interruptores: Map<string, { encendida: boolean; tope_dia: number | null }>, hoy: string,
  ): Promise<ResultadoDia> {
    const sw = interruptores.get(d.sucursal);
    if (!sw?.encendida) return this.apagado(d, `El interruptor ${TIPO_INTERRUPTOR_COMISIONES} de la sucursal ${d.sucursal} está apagado`);
    const cerrado = dialDeD3Cierra(d.cargos, diales);
    if (cerrado) return this.apagado(d, cerrado);
    if (!d.plan) return this.rechazo(d, 'El armador no dejó plan para este día');

    // ⛔ La plantilla la publica la consulta, que la midió del último gasto real de esa sucursal con ese banco.
    // No se deduce del plan deshaciendo sus textos (ver `DiaPropuesta.plantilla`).
    if (!d.plantilla) return this.rechazo(d, 'El día no trae plantilla: sin un gasto de comisiones anterior no se copia de otra sucursal');
    const capturadaEn = { fecha: hoy, hora: horaMx() };
    const armado = entregasDelDia(d, d.plantilla, capturadaEn);
    if (!armado.ok) return this.rechazo(d, armado.motivos.join(' · '));
    const e = armado.entregas;

    if (sw.tope_dia !== null && (await this.escritosHoy(tenantId, d.sucursal, hoy)) >= sw.tope_dia) {
      return this.apagado(d, `La sucursal ${d.sucursal} ya alcanzó su tope de ${sw.tope_dia} día(s) de comisiones hoy`);
    }

    // ⛔ El reclamo atómico ANTES de hablar con Kepler: dos pestañas o el cron a la vez no escriben dos veces.
    const noReclamado = await this.reclamar(tenantId, e);
    if (noReclamado) return this.apagado(d, noReclamado);

    try {
      return await this.escribir(tenantId, d, e, sw.tope_dia);
    } catch (err) {
      const motivo = `Falla al escribir: ${(err as Error)?.message ?? err}`;
      await this.anotar(tenantId, e, { estado: 'rechazado', nota: motivo });
      return this.rechazo(d, motivo);
    }
  }

  /** Los tres pasos, en orden. Cada escritor es idempotente por su cuenta; aquí sólo se encadenan. */
  private async escribir(tenantId: string, d: DiaPropuesta, e: EntregasDelDia, tope: number | null): Promise<ResultadoDia> {
    const base = { llave: e.llave, sucursal: d.sucursal, dia_venta: d.dia_venta };

    // 1 · La solicitud X-A-15. Si su marca ya está en el Kepler vivo, el escritor devuelve ese folio y no escribe otra.
    const rs = await this.solicitudes.entregar({ ...e.solicitud, tope_dia: tope });
    if (rs.estado === 'apagado' || rs.estado === 'rechazado') {
      await this.anotar(tenantId, e, { estado: rs.estado === 'apagado' ? 'pendiente' : 'rechazado', nota: `Solicitud: ${rs.motivo}` });
      return rs.estado === 'apagado' ? { ...base, estado: 'apagado', motivo: `Solicitud: ${rs.motivo}` } : { ...base, estado: 'rechazado', motivo: `Solicitud: ${rs.motivo}` };
    }
    if (rs.estado === 'en_duda') {
      await this.anotar(tenantId, e, { estado: 'en_duda', nota: `Solicitud en duda: ${rs.motivo}` });
      return { ...base, estado: 'en_duda', motivo: `Solicitud en duda: ${rs.motivo}` };
    }
    const solicitud = rs.folio;
    await this.anotar(tenantId, e, { estado: 'escribiendo', solicitud_folio: solicitud, nota: null });

    // 2 · El gasto X-A-10: clona esa solicitud, hace su póliza D y la deja en `F` con saldo 0.
    const rg = await this.gastos.entregar({
      sucursal: d.sucursal, solicitud, fecha: d.dia_venta, capturadoEn: e.solicitud.capturadaEn,
      vale: `CB62 ${e.llave}`, tope_dia: tope,
      esperado: e.gasto.esperado,
    });
    if (rg.estado === 'apagado' || rg.estado === 'rechazado') {
      await this.anotar(tenantId, e, { estado: 'reintento', solicitud_folio: solicitud, nota: `Gasto: ${rg.motivo}` });
      return { ...base, estado: rg.estado === 'apagado' ? 'apagado' : 'rechazado', motivo: `Gasto: ${rg.motivo}` };
    }
    if (rg.estado === 'en_duda') {
      await this.anotar(tenantId, e, { estado: 'en_duda', solicitud_folio: solicitud, nota: `Gasto en duda: ${rg.motivo}` });
      return { ...base, estado: 'en_duda', motivo: `Gasto en duda: ${rg.motivo}` };
    }
    const gasto = rg.folio;
    await this.anotar(tenantId, e, { estado: 'escribiendo', solicitud_folio: solicitud, gasto_folio: gasto, nota: null });

    // 3 · Un X-D-26 por cargo del banco, aplicado contra la CxP del gasto (kdxe c3='A', c4=10).
    const escritos: { cargo: string; folio: string }[] = [];
    for (const p of e.pagos) {
      const rp = await this.pagos.entregar({
        sucursal: d.sucursal, fecha: p.fecha, hora: e.solicitud.capturadaEn.hora,
        referencia: `${p.referencia} ${e.llave}`, acreedor: e.solicitud.acreedor, importe: p.importe,
        origen: { bank: p.banco, account_label: p.cuenta }, destino: null,
        facturas: [{ tipo: 10, subtipo: 1, folio: gasto, aplicado: p.importe }],
      });
      if (rp.estado === 'rechazado') {
        const nota = `Gasto ${gasto} escrito; el pago del cargo ${p.cargoId} falló: ${rp.motivo}`;
        await this.anotar(tenantId, e, { estado: 'reintento', solicitud_folio: solicitud, gasto_folio: gasto, pagos: escritos, nota });
        return { ...base, estado: 'rechazado', motivo: nota };
      }
      escritos.push(...rp.kepler.folios.map((f) => ({ cargo: p.cargoId, folio: f })));
    }

    await this.anotar(tenantId, e, { estado: 'escrito', solicitud_folio: solicitud, gasto_folio: gasto, pagos: escritos, nota: null });
    this.logger.log(`[CB.62.4] ${e.llave}: solicitud ${solicitud}, gasto ${gasto}, ${escritos.length} pagos, $${e.total.toFixed(2)}`);
    return { ...base, estado: 'escrito', solicitud, gasto, pagos: escritos, total: e.total };
  }

  // ── La bitácora ──────────────────────────────────────────────────────────────────────────────────────────

  /** `true` si este proceso se quedó con el día. Falla cerrada: si ya está `escribiendo` o `escrito`, no. */
  /**
   * El reclamo atómico del día. Devuelve `null` si quedó reclamado, o **el motivo real** si no.
   *
   * ⭐ `rechazado` SE PUEDE RETOMAR, y antes no: un rechazo es «no se escribió nada» (la escritura va en
   * una transacción y el catch anota el motivo), así que reintentarlo es seguro. Sin esto, el primer
   * fallo dejaba el día **bloqueado para siempre** — y encima el aviso culpaba a «otro proceso», que no
   * existía. Lo encontró el canario del 2026-11-26: el día de la 05 falló por el renglón AMPARA, y al
   * reintentar con el arreglo ya puesto la pantalla seguía diciendo «Otro proceso está escribiendo este
   * día (o ya lo escribió)».
   *
   * ⛔ `en_duda` NO se retoma: ahí el COMMIT pudo salir y la respuesta no volvió, así que hay que buscar
   * los documentos en Kepler antes de tocar nada. `escrito` tampoco, obviamente.
   */
  private async reclamar(tenantId: string, e: EntregasDelDia): Promise<string | null> {
    return this.tk.run(async (trx: Trx) => {
      const llave = { tenant_id: tenantId, sucursal: e.sucursal, dia_venta: e.solicitud.fechaSolicitud, acreedor: e.solicitud.acreedor };
      await trx('finance.bank_commission_kepler_days').insert({
        ...llave, cuenta: e.pagos[0]?.cuenta ?? null, estado: 'pendiente',
        total: e.total, iva: e.iva, cargos: e.pagos.length,
      }).onConflict(['tenant_id', 'sucursal', 'dia_venta', 'acreedor']).ignore();
      const n = await trx('finance.bank_commission_kepler_days').where(llave)
        .whereIn('estado', ESTADOS_RETOMABLES)
        .update({ estado: 'escribiendo', intentos: trx.raw('intentos + 1'), updated_at: trx.fn.now() });
      if (n === 1) return null;
      // No se pudo reclamar: se dice POR QUÉ, con el estado real. Un aviso que inventa la causa manda
      // a buscar el problema donde no está.
      const [fila] = await trx('finance.bank_commission_kepler_days').where(llave).select('estado');
      return motivoDeNoReclamar(fila?.['estado'] as string | undefined);
    });
  }

  private async anotar(tenantId: string, e: EntregasDelDia, campos: Record<string, unknown>): Promise<void> {
    const llave = { tenant_id: tenantId, sucursal: e.sucursal, dia_venta: e.solicitud.fechaSolicitud, acreedor: e.solicitud.acreedor };
    await this.tk.run((trx: Trx) => trx('finance.bank_commission_kepler_days').where(llave)
      .update({ ...campos, ...(campos['pagos'] ? { pagos: JSON.stringify(campos['pagos']) } : {}), updated_at: trx.fn.now() }));
  }

  /** Cuántos días de esa sucursal ya escribió la Suite hoy (el tope del interruptor). */
  private async escritosHoy(tenantId: string, sucursal: string, hoy: string): Promise<number> {
    const [r] = await this.tk.run((trx: Trx) => trx('finance.bank_commission_kepler_days')
      .where({ tenant_id: tenantId, sucursal, estado: 'escrito' })
      .whereRaw(`(updated_at AT TIME ZONE 'America/Mexico_City')::date = ?::date`, [hoy])
      .count<{ count: string }[]>('* as count'));
    return Number(r?.count ?? 0);
  }

  private apagado(d: DiaPropuesta, motivo: string): ResultadoDia {
    return { estado: 'apagado', llave: `${d.sucursal}|${d.dia_venta}|${d.acreedor}`, sucursal: d.sucursal, dia_venta: d.dia_venta, motivo };
  }

  private rechazo(d: DiaPropuesta, motivo: string): ResultadoDia {
    return { estado: 'rechazado', llave: `${d.sucursal}|${d.dia_venta}|${d.acreedor}`, sucursal: d.sucursal, dia_venta: d.dia_venta, motivo };
  }
}

/** `HH:MM` en México, para `c69`. */
function horaMx(d = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return `${p['hour']}:${p['minute']}`;
}

/** Lo que la pantalla necesita saber del plan: re-exportado para que el controlador no importe el armador. */
export type { EntregasDelDia };
export { marcaDeComisiones };
