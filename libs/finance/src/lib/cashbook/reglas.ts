/**
 * `[LE.2.3]` — Las reglas de registro: qué asiento produce cada hecho (Fase LE, catálogo §5;
 * ADR-102). Puras: no leen la base ni el reloj. La base vuelve a validar TODO (`cashbook._post`);
 * estas reglas fallan antes y con el mismo nombre, para que un error de forma no llegue a la base.
 *
 * ── Tres decisiones, declaradas ─────────────────────────────────────────────────────────────
 *  1. Lo que la MÁQUINA hace se asienta siempre, en el momento: la bóveda del libro es igual a la
 *     máquina en todo momento (su testigo, B17). Si la contraparte no se sabe todavía —un retiro
 *     sin clasificar, un depósito sin ruta, un «Dotar» cuyo origen no está confirmado— va contra
 *     SUSPENSO, y Suspenso distinto de cero al cierre es un hallazgo (B46). Nunca se adivina.
 *  2. «Por rendir» es por RUTA, no por día: el depósito que dice «ruta 27» abona a la ruta 27 y el
 *     saldo de la ruta es lo que falta. No hay reparto por antigüedad (B19): el texto declara la
 *     ruta (`atribuirDeposito`, CG.58.6) o el depósito queda en Suspenso.
 *  3. Sin regla sólo lo que no mueve efectivo comprobable: «Fin de Día» (es una lectura del
 *     contenido, un testigo — E3), «Contenido Modificado» (sin piezas) y un «Cambio» cuya
 *     dirección nadie confirmó. Eso va a la cola de excepciones con hallazgo, no al libro.
 */
import {
  CUENTA,
  CUENTA_FIJA,
  centavos,
  centavosATexto,
  convertirMoneda,
  pesosACentavos,
  valorDePiezas,
  type ActorAsiento,
  type AsientoPropuesto,
  type CuentaPropuesta,
  type EventoLibro,
  type LineaAsiento,
  type MetaAsiento,
  type Moneda,
  type PiezasTexto,
} from '@megadulces/contracts';
import { atribuirDeposito, esVecinal } from '../caos/caos-deposito-grano';
import { efectoDeTipo } from '../caos/caos-saldo';
import { identidadDeCaos, identidadDeCobroKepler, piezasQueEntranALaMaquina, type MovimientoCaos } from './identidad';

/** Cambia cada vez que cambie QUÉ asiento produce un hecho. Va en cada asiento (B22). */
export const REGLAS_VERSION = 'le2-2026-10-27.1';

export class ReglaInvalida extends Error {
  constructor(readonly codigo: string, mensaje: string) {
    super(mensaje);
    this.name = 'ReglaInvalida';
  }
}

export interface Propuesta {
  asiento: AsientoPropuesto;
  /** Las cuentas que el asiento toca: la API las asegura (`open_account`, idempotente) antes. */
  cuentas: CuentaPropuesta[];
}

export interface SinRegla {
  sinRegla: true;
  motivo: string;
  event_ref: string;
}

export type ResultadoRegla = Propuesta | SinRegla;

export const esSinRegla = (r: ResultadoRegla): r is SinRegla => 'sinRegla' in r;

/** Quién, cuándo y con qué petición. El reloj lo pone quien llama, nunca la regla. */
export interface Contexto {
  actor: ActorAsiento;
  valueAt: string;
  requestId?: string;
  reason?: string;
}

const fija = (code: keyof typeof CUENTA_FIJA, name: string, clase: CuentaPropuesta['class'], currency: Moneda,
  tracks: boolean, negativo: boolean, witness: string): CuentaPropuesta =>
  ({ code: CUENTA_FIJA[code], name, class: clase, currency, tracks_pieces: tracks, allows_negative: negativo, holder_kind: 'ninguno', witness });

/** Las cuentas fijas, con la MISMA forma que siembra la migración (prueba de paridad). */
export const CUENTAS_FIJAS: Readonly<Record<keyof typeof CUENTA_FIJA, CuentaPropuesta>> = {
  CAJA_MXN: fija('CAJA_MXN', 'Caja General · pesos', 'fisica', 'MXN', true, false, 'arqueo ciego'),
  CAJA_USD: fija('CAJA_USD', 'Caja General · dólares', 'fisica', 'USD', true, false, 'arqueo ciego'),
  CAJA_DOC: fija('CAJA_DOC', 'Caja General · documentos (cheques)', 'fisica', 'MXN', false, false, 'arqueo de documentos'),
  BOVEDA_CAOS: fija('BOVEDA_CAOS', 'Bóveda CAOS', 'fisica', 'MXN', true, false, 'conteo de la máquina'),
  TRANSITO_BANCO: fija('TRANSITO_BANCO', 'Valores en tránsito · banco', 'transito', 'MXN', false, false, 'estado de cuenta'),
  COBRANZA_KEPLER: fija('COBRANZA_KEPLER', 'Cobranza reconocida (Kepler)', 'contrapartida', 'MXN', false, true, 'cobranza de Kepler'),
  PUENTE_MXN: fija('PUENTE_MXN', 'Cambio de divisas · MXN', 'puente', 'MXN', false, true, 'tipo de cambio guardado'),
  PUENTE_USD: fija('PUENTE_USD', 'Cambio de divisas · USD', 'puente', 'USD', false, true, 'tipo de cambio guardado'),
  APERTURA_MXN: fija('APERTURA_MXN', 'Apertura · pesos', 'sistema', 'MXN', false, true, 'conteos de la fecha de apertura'),
  APERTURA_USD: fija('APERTURA_USD', 'Apertura · dólares', 'sistema', 'USD', false, true, 'conteos de la fecha de apertura'),
  SUSPENSO_MXN: fija('SUSPENSO_MXN', 'Suspenso · pesos', 'sistema', 'MXN', false, true, 'debe ser 0 al cierre'),
  SUSPENSO_USD: fija('SUSPENSO_USD', 'Suspenso · dólares', 'sistema', 'USD', false, true, 'debe ser 0 al cierre'),
};
const F = CUENTAS_FIJAS;

// ── Utilidades de piezas ──────────────────────────────────────────────────────────────────────

const aNumeros = (p: PiezasTexto): Record<string, number> =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Number(centavos(v))]));

export function negarPiezas(p: PiezasTexto): PiezasTexto {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, (-centavos(v)).toString()]));
}

function piezasValidas(p: PiezasTexto | undefined, que: string): PiezasTexto {
  if (!p || Object.keys(p).length === 0) throw new ReglaInvalida('cashbook_cuenta_exige_piezas', `${que}: un importe sin piezas no es un conteo (B16)`);
  return p;
}

/** Parte unas piezas con signo mixto (un cambio) en lo que entra y lo que sale. */
function porSigno(p: PiezasTexto): { entra: PiezasTexto; sale: PiezasTexto } {
  const entra: PiezasTexto = {};
  const sale: PiezasTexto = {};
  for (const [k, v] of Object.entries(p)) (centavos(v) > 0n ? entra : sale)[k] = v;
  return { entra, sale };
}

// ── El armado: lo que la base exigirá, verificado antes ──────────────────────────────────────

type Pierna = { cuenta: CuentaPropuesta; monto: bigint; piezas?: PiezasTexto };

function armar(kind: EventoLibro, ctx: Contexto, piernas: Pierna[],
  extra: { event_ref?: string; event_version?: number; event_hash?: string; meta?: MetaAsiento } = {}): Propuesta {
  if (piernas.length < 2) throw new ReglaInvalida('cashbook_asiento_minimo', `${kind}: un asiento lleva al menos dos líneas`);
  const porMoneda = new Map<Moneda, bigint>();
  const piezasConservadas = new Map<string, bigint>();
  const todasConPiezas = piernas.every((p) => p.cuenta.tracks_pieces);
  const lines: LineaAsiento[] = piernas.map(({ cuenta, monto, piezas }) => {
    if (monto === 0n) throw new ReglaInvalida('cashbook_linea_no_cero', `${kind}: ${cuenta.code} en cero`);
    if (cuenta.tracks_pieces) {
      const p = piezasValidas(piezas, `${kind} · ${cuenta.code}`);
      const valor = valorDePiezas(aNumeros(p), cuenta.currency);
      if (valor !== monto) throw new ReglaInvalida('cashbook_piezas_no_suman', `${kind} · ${cuenta.code}: piezas ${valor} ≠ línea ${monto}`);
      for (const [k, v] of Object.entries(p)) {
        const llave = `${cuenta.currency}|${k}`;
        piezasConservadas.set(llave, (piezasConservadas.get(llave) ?? 0n) + centavos(v));
      }
    } else if (piezas && Object.keys(piezas).length > 0) {
      throw new ReglaInvalida('cashbook_cuenta_sin_desglose', `${kind}: ${cuenta.code} no lleva piezas`);
    }
    porMoneda.set(cuenta.currency, (porMoneda.get(cuenta.currency) ?? 0n) + monto);
    return { account: cuenta.code, amount_minor: centavosATexto(monto), ...(cuenta.tracks_pieces ? { pieces: piezas } : {}) };
  });
  for (const [moneda, suma] of porMoneda) {
    if (suma !== 0n) throw new ReglaInvalida('cashbook_no_cuadra', `${kind}: ${moneda} suma ${suma}`);
  }
  if (todasConPiezas) {
    for (const [llave, n] of piezasConservadas) {
      if (n !== 0n) throw new ReglaInvalida('cashbook_piezas_no_cuadran', `${kind}: ${llave} no se conserva (${n})`);
    }
  }
  const cuentas = [...new Map(piernas.map((p) => [p.cuenta.code, p.cuenta])).values()];
  const asiento: AsientoPropuesto = {
    event_kind: kind,
    rule_version: REGLAS_VERSION,
    value_at: ctx.valueAt,
    actor: ctx.actor,
    lines,
    ...(ctx.requestId ? { request_id: ctx.requestId } : {}),
    ...(ctx.reason ? { reason: ctx.reason } : {}),
    ...(extra.event_ref ? { event_ref: extra.event_ref, event_version: extra.event_version ?? 1 } : {}),
    ...(extra.event_hash ? { event_hash: extra.event_hash } : {}),
    ...(extra.meta ? { meta: extra.meta } : {}),
  };
  return { asiento, cuentas };
}

const positivo = (monto: string | bigint, que: string): bigint => {
  const c = centavos(monto);
  if (c <= 0n) throw new ReglaInvalida('cashbook_monto_invalido', `${que}: el monto es positivo (${c})`);
  return c;
};

/** El monto de unas piezas que ENTRAN (todas positivas). */
const montoDe = (p: PiezasTexto, moneda: Moneda = 'MXN'): bigint => valorDePiezas(aNumeros(p), moneda);

// ── E-01 · Kepler reconoce la cobranza de una ruta ────────────────────────────────────────────

export function cobranzaRuta(h: { ruta: string; origenRef: string; monto: string; fecha: string; version?: number }, ctx: Contexto): Propuesta {
  const m = positivo(h.monto, 'cobranza_ruta');
  const id = identidadDeCobroKepler({ origen_ref: h.origenRef, monto: h.monto, fecha: h.fecha, ruta: h.ruta });
  return armar('cobranza_ruta', ctx, [
    { cuenta: CUENTA.porRendirRuta(h.ruta), monto: m },
    { cuenta: F.COBRANZA_KEPLER, monto: -m },
  ], { ...id, event_version: h.version ?? 1, meta: { origen: 'kepler', folio: h.origenRef } });
}

// ── E-02, E-07, E-08, E-13, E-14, E-15, E-17 · Lo que hace la máquina ─────────────────────────

/** Qué dijo una PERSONA de un movimiento de la máquina. Sin esto, la contraparte es Suspenso. */
export type ClasificacionCaos =
  | { tipo: 'cajon' }
  | { tipo: 'custodia'; empleado: string; nombre: string }
  | { tipo: 'banco' }
  | { tipo: 'cambio_con_cajon'; direccionConfirmada: true };

export function movimientoCaos(m: MovimientoCaos, ctx: Contexto, clasificacion?: ClasificacionCaos): ResultadoRegla {
  const id = identidadDeCaos(m);
  const efecto = efectoDeTipo(m.type_id);
  const leidas = piezasQueEntranALaMaquina(m);
  if (!leidas) return { sinRegla: true, motivo: `${m.type_label}: ${efecto.motivo}`, event_ref: id.event_ref };
  if (!leidas.direccionProbada && clasificacion?.tipo !== 'cambio_con_cajon') {
    return { sinRegla: true, motivo: `${m.type_label}: la dirección por denominación no está confirmada; una persona la confirma`, event_ref: id.event_ref };
  }
  const piezas = leidas.piezas;
  const neto = valorDePiezas(aNumeros(piezas), 'MXN');
  const total = pesosACentavos(String(m.total));
  if (neto !== total * BigInt(efecto.signo || 1) && m.type_id !== 7) {
    return { sinRegla: true, motivo: `${m.type_label}: el total (${total}) no coincide con su desglose (${neto})`, event_ref: id.event_ref };
  }
  const extra = { ...id, meta: { origen: 'caos', motivo: m.type_label } as MetaAsiento };

  if (m.type_id === 7) {
    const { entra, sale } = porSigno(piezas);
    const vEntra = montoDe(entra);
    const vSale = -montoDe(sale);
    return armar('cambio', ctx, [
      { cuenta: F.BOVEDA_CAOS, monto: vEntra, piezas: entra },
      { cuenta: F.CAJA_MXN, monto: -vEntra, piezas: negarPiezas(entra) },
      { cuenta: F.BOVEDA_CAOS, monto: -vSale, piezas: sale },
      { cuenta: F.CAJA_MXN, monto: vSale, piezas: negarPiezas(sale) },
    ], extra);
  }

  // La pierna de la máquina: entra (+) o sale (−) con sus piezas.
  const maquina: Pierna = { cuenta: F.BOVEDA_CAOS, monto: neto, piezas };
  const espejo = (cuenta: CuentaPropuesta): Pierna =>
    ({ cuenta, monto: -neto, ...(cuenta.tracks_pieces ? { piezas: negarPiezas(piezas) } : {}) });

  if (m.type_id === 0) {
    if (clasificacion?.tipo === 'cajon') return armar('deposito_caja_caos', ctx, [maquina, espejo(F.CAJA_MXN)], extra);
    if (clasificacion?.tipo === 'custodia') {
      return armar('regreso_custodia', ctx, [maquina, espejo(CUENTA.custodia(clasificacion.empleado, clasificacion.nombre))], extra);
    }
    if (esVecinal(m.ref)) return armar('deposito_caos', ctx, [maquina, espejo(CUENTA.porRendirVecinal())], { ...extra, meta: { ...extra.meta, grano: 'vecinal' } });
    const a = atribuirDeposito(m.ref, m.occurred_at);
    if ((a.grano === 'ruta' || a.grano === 'ruta_dia') && a.ruta) {
      return armar('deposito_caos', ctx, [maquina, espejo(CUENTA.porRendirRuta(a.ruta))], { ...extra, meta: { ...extra.meta, grano: a.grano } });
    }
    return armar('deposito_caos', ctx, [maquina, espejo(F.SUSPENSO_MXN)], { ...extra, meta: { ...extra.meta, grano: a.grano, motivo: a.motivo } });
  }
  if (m.type_id === 4) {
    if (clasificacion?.tipo === 'cajon') return armar('retiro_caos', ctx, [maquina, espejo(F.CAJA_MXN)], extra);
    if (clasificacion?.tipo === 'custodia') {
      return armar('retiro_a_custodia', ctx, [maquina, espejo(CUENTA.custodia(clasificacion.empleado, clasificacion.nombre))], extra);
    }
    return armar('retiro_caos', ctx, [maquina, espejo(F.SUSPENSO_MXN)], { ...extra, meta: { ...extra.meta, motivo: 'retiro sin clasificar' } });
  }
  if (m.type_id === 8 || m.type_id === 5) {
    if (clasificacion?.tipo === 'cajon') return armar(m.type_id === 8 ? 'deposito_caja_caos' : 'retiro_caos', ctx, [maquina, espejo(F.CAJA_MXN)], extra);
    if (clasificacion?.tipo === 'banco' && m.type_id === 5) return armar('envio_a_banco', ctx, [maquina, espejo(F.TRANSITO_BANCO)], extra);
    return armar(m.type_id === 8 ? 'deposito_caja_caos' : 'retiro_caos', ctx, [maquina, espejo(F.SUSPENSO_MXN)],
      { ...extra, meta: { ...extra.meta, motivo: `${m.type_label}: origen/destino sin confirmar (LE.0.2)` } });
  }
  return { sinRegla: true, motivo: `${m.type_label}: tipo sin regla`, event_ref: id.event_ref };
}

// ── E-03 · Sacar algo de Suspenso cuando una persona lo explica ───────────────────────────────

/**
 * `estaEn` dice de qué lado quedó en Suspenso: `'debe'` si Suspenso RECIBIÓ (un retiro sin
 * clasificar, un vaciado sin destino) y `'haber'` si Suspenso ENTREGÓ (un depósito sin ruta, un
 * dotar sin origen). La explicación es un hecho propio: una por hecho original.
 */
export function clasificarSuspenso(h: { eventRefOriginal: string; monto: string; estaEn: 'debe' | 'haber'; hacia: CuentaPropuesta; piezas?: PiezasTexto },
  ctx: Contexto): Propuesta {
  const m = positivo(h.monto, 'clasificar_suspenso');
  const signo = h.estaEn === 'debe' ? 1n : -1n;
  return armar('clasificar_suspenso', ctx, [
    { cuenta: F.SUSPENSO_MXN, monto: -signo * m },
    { cuenta: h.hacia, monto: signo * m, ...(h.hacia.tracks_pieces ? { piezas: signo > 0n ? piezasValidas(h.piezas, 'clasificar') : negarPiezas(piezasValidas(h.piezas, 'clasificar')) } : {}) },
  ], { event_ref: `clasifica:${h.eventRefOriginal}` });
}

// ── E-04 · La ruta entrega efectivo al cajón, contado por pieza ───────────────────────────────

export function entregaRuta(h: { ruta: string; piezas: PiezasTexto }, ctx: Contexto): Propuesta {
  const m = montoDe(piezasValidas(h.piezas, 'entrega_ruta'));
  return armar('entrega_ruta', ctx, [
    { cuenta: F.CAJA_MXN, monto: m, piezas: h.piezas },
    { cuenta: CUENTA.porRendirRuta(h.ruta), monto: -m },
  ]);
}

// ── E-09, E-10, E-24 · Un gasto: sale del cajón (con piezas) o de una custodia ───────────────

export function gasto(h: { concepto: string; desde: { tipo: 'cajon'; piezas: PiezasTexto } | { tipo: 'custodia'; empleado: string; nombre: string; monto: string } },
  ctx: Contexto): Propuesta {
  if (h.desde.tipo === 'cajon') {
    const m = montoDe(piezasValidas(h.desde.piezas, 'gasto'));
    return armar('gasto', ctx, [
      { cuenta: CUENTA.egreso(h.concepto), monto: m },
      { cuenta: F.CAJA_MXN, monto: -m, piezas: negarPiezas(h.desde.piezas) },
    ]);
  }
  const m = positivo(h.desde.monto, 'gasto');
  return armar('gasto', ctx, [
    { cuenta: CUENTA.egreso(h.concepto), monto: m },
    { cuenta: CUENTA.custodia(h.desde.empleado, h.desde.nombre), monto: -m },
  ]);
}

// ── E-11 · Lo que sobró de una custodia regresa al cajón ──────────────────────────────────────

export function regresoCustodiaAlCajon(h: { empleado: string; nombre: string; piezas: PiezasTexto }, ctx: Contexto): Propuesta {
  const m = montoDe(piezasValidas(h.piezas, 'regreso_custodia'));
  return armar('regreso_custodia', ctx, [
    { cuenta: F.CAJA_MXN, monto: m, piezas: h.piezas },
    { cuenta: CUENTA.custodia(h.empleado, h.nombre), monto: -m },
  ]);
}

// ── E-05, E-12, E-20 · Faltante y sobrante: SIEMPRE con nombre, SIEMPRE autorizados ───────────

type Origen = { tipo: 'ruta'; ruta: string; monto: string } | { tipo: 'custodia'; empleado: string; nombre: string; monto: string } | { tipo: 'cajon'; piezas: PiezasTexto };

function piernaOrigen(o: Origen, signo: bigint): Pierna {
  if (o.tipo === 'cajon') {
    const m = montoDe(piezasValidas(o.piezas, 'diferencia'));
    return { cuenta: F.CAJA_MXN, monto: signo * m, piezas: signo > 0n ? o.piezas : negarPiezas(o.piezas) };
  }
  const m = positivo(o.monto, 'diferencia');
  return { cuenta: o.tipo === 'ruta' ? CUENTA.porRendirRuta(o.ruta) : CUENTA.custodia(o.empleado, o.nombre), monto: signo * m };
}

/** Faltó dinero: sale de donde debía estar y queda a cargo de una persona con nombre. */
export function faltante(h: { de: Origen; empleado: string; nombre: string }, ctx: Contexto): Propuesta {
  const sale = piernaOrigen(h.de, -1n);
  return armar('faltante', ctx, [{ cuenta: CUENTA.faltante(h.empleado, h.nombre), monto: -sale.monto }, sale], { meta: { origen: h.de.tipo } });
}

/** Sobró dinero: entra a donde está y queda registrado a nombre de quien lo entregó. */
export function sobrante(h: { en: Origen; empleado: string; nombre: string }, ctx: Contexto): Propuesta {
  const entra = piernaOrigen(h.en, 1n);
  return armar('sobrante', ctx, [entra, { cuenta: CUENTA.sobrante(h.empleado, h.nombre), monto: -entra.monto }], { meta: { origen: h.en.tipo } });
}

// ── E-16 · El banco confirma el depósito que iba en tránsito ──────────────────────────────────

export function depositoEnBanco(h: { cuentaBanco: string; monto: string; referencia: string }, ctx: Contexto): Propuesta {
  const m = positivo(h.monto, 'deposito_banco');
  return armar('deposito_banco', ctx, [
    { cuenta: CUENTA.banco(h.cuentaBanco), monto: m },
    { cuenta: F.TRANSITO_BANCO, monto: -m },
  ], { event_ref: `banco:${h.cuentaBanco}:${h.referencia}` });
}

// ── E-21 · Un cobro en dólares: por los puentes, con el tipo de cambio guardado (B44) ─────────

export function cobroEnDolares(h: { ruta: string; piezasUsd: PiezasTexto; tipoDeCambio: string; fuente: string; fijadoPor: string }, ctx: Contexto): Propuesta {
  const usd = montoDe(piezasValidas(h.piezasUsd, 'cobro_usd'), 'USD');
  const mxn = convertirMoneda(usd, h.tipoDeCambio);
  return armar('cobro_usd', ctx, [
    { cuenta: F.CAJA_USD, monto: usd, piezas: h.piezasUsd },
    { cuenta: F.PUENTE_USD, monto: -usd },
    { cuenta: F.PUENTE_MXN, monto: mxn },
    { cuenta: CUENTA.porRendirRuta(h.ruta), monto: -mxn },
  ], { meta: { tipo_de_cambio: h.tipoDeCambio, tc_fuente: h.fuente, tc_fijado_por: h.fijadoPor } });
}

// ── E-22 · Cheques: cada uno con su folio ─────────────────────────────────────────────────────

export function chequeRecibido(h: { ruta: string; folio: string; monto: string }, ctx: Contexto): Propuesta {
  const m = positivo(h.monto, 'cheque_recibido');
  return armar('cheque_recibido', ctx, [
    { cuenta: F.CAJA_DOC, monto: m },
    { cuenta: CUENTA.porRendirRuta(h.ruta), monto: -m },
  ], { event_ref: `cheque:${h.folio}`, meta: { folio: h.folio } });
}

export function chequeDepositado(h: { folio: string; monto: string }, ctx: Contexto): Propuesta {
  const m = positivo(h.monto, 'cheque_depositado');
  return armar('cheque_depositado', ctx, [
    { cuenta: F.TRANSITO_BANCO, monto: m },
    { cuenta: F.CAJA_DOC, monto: -m },
  ], { event_ref: `cheque-deposito:${h.folio}`, meta: { folio: h.folio } });
}

/** El banco devolvió el cheque: la ruta lo vuelve a deber. Sale de tránsito o del banco, según dónde iba. */
export function chequeDevuelto(h: { ruta: string; folio: string; monto: string; desde: { tipo: 'transito' } | { tipo: 'banco'; cuentaBanco: string } },
  ctx: Contexto): Propuesta {
  const m = positivo(h.monto, 'cheque_devuelto');
  return armar('cheque_devuelto', ctx, [
    { cuenta: CUENTA.porRendirRuta(h.ruta), monto: m },
    { cuenta: h.desde.tipo === 'transito' ? F.TRANSITO_BANCO : CUENTA.banco(h.desde.cuentaBanco), monto: -m },
  ], { event_ref: `cheque-devuelto:${h.folio}`, meta: { folio: h.folio } });
}

// ── E-23 · Un ingreso que no es cobro de ruta ─────────────────────────────────────────────────

export function otroIngreso(h: { concepto: string; piezas: PiezasTexto }, ctx: Contexto): Propuesta {
  const m = montoDe(piezasValidas(h.piezas, 'otro_ingreso'));
  return armar('otro_ingreso', ctx, [
    { cuenta: F.CAJA_MXN, monto: m, piezas: h.piezas },
    { cuenta: CUENTA.otrosIngresos(h.concepto), monto: -m },
  ]);
}

// ── E-27 · Apertura: lo contado en cada cuenta física, contra Apertura ────────────────────────

/** UNA moneda por asiento de apertura: dos monedas no se convierten, cada una cuadra contra su apertura. */
export function apertura(h: { moneda: Moneda; conteos: { cuenta: 'CAJA_MXN' | 'CAJA_USD' | 'BOVEDA_CAOS'; piezas: PiezasTexto }[]; fecha: string },
  ctx: Contexto): Propuesta {
  const piernas: Pierna[] = [];
  let total = 0n;
  for (const c of h.conteos) {
    const cuenta = F[c.cuenta];
    if (cuenta.currency !== h.moneda) throw new ReglaInvalida('cashbook_divisas_sin_puente', `apertura en ${h.moneda}: ${c.cuenta} es ${cuenta.currency}`);
    const m = montoDe(piezasValidas(c.piezas, `apertura ${c.cuenta}`), cuenta.currency);
    piernas.push({ cuenta, monto: m, piezas: c.piezas });
    total += m;
  }
  piernas.push({ cuenta: h.moneda === 'USD' ? F.APERTURA_USD : F.APERTURA_MXN, monto: -total });
  return armar('apertura', ctx, piernas, { event_ref: `apertura:${h.fecha}:${h.moneda}` });
}
