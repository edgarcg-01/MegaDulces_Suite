/**
 * `[PGP.223]` **La norma fiscal del CFDI: qué factura sirve para pagar, comprar, gastar o vender.**
 *
 * Pedido de Francisco (2026-11-26, anexo NF): los UUID de `fiscal.cfdis` (ContPAQi + descarga del SAT) ya
 * están al día para cargarlos a compras, gastos y ventas, pero **ninguno de los 16 puntos de la Suite que
 * registran con un UUID aplicaba la norma** (medido ese día, anexo NF §1). Esta es la regla, UNA vez
 * (ADR-056): la consultan el servidor (para rechazar) y la pantalla (para decirlo), sin otra copia.
 *
 * | Regla | Cuándo | Pagar | Compra / gasto | Venta |
 * |---|---|---|---|---|
 * | N0 `cancelada` | `estatus_sat` cancelado | informativa | informativa | informativa |
 * | `rol` | recibida usada como venta, o emitida usada como pago/compra/gasto | informativa | informativa | informativa |
 * | N1 `pue_mes_anterior` | PUE, forma 02/03, y el dinero sale después del mes de la factura | **no se paga** | — | — |
 * | N2 `sin_efectos_fiscales` | uso S01 | autorización | autorización | — (la factura global es S01) |
 * | N3 `regimen` | recibida: régimen del receptor ≠ 612 · emitida: del emisor ≠ 612 | autorización | autorización | **no es venta** |
 * | N4 `sin_verificar` | el SAT todavía no la verifica | **espera** | aviso | aviso |
 *
 * Decisiones del 2026-11-26: N1 es **candado** (D-NF1, Francisco; ratificado por Edgar) · **el IMSS es excepción
 * por regla** del régimen (D-NF3: timbra con 606 y no re-timbra; el resto, con autorización) · lo **sin verificar
 * no se paga** hasta que el SAT la verifique (D-NF5) · **basta una firma**, de Administración o de Contabilidad
 * (D-NF2) · **la S01 de las comisiones que el banco cobra solo no pide autorización** (D-NF4) · las rentas
 * emitidas con 606 no son venta (D-NF8).
 *
 * ⛔ La fecha del CFDI es la de emisión (`Fecha`), leída como día de México (D-NF9): un `timestamptz` de las
 * 23:30 del 31-oct es octubre aunque en UTC ya sea 1-nov.
 * ⛔ N1 se mide contra el día en que SALE el dinero, nunca antes de hoy: un pago programado en octubre que
 * se autoriza en noviembre ya sale en noviembre.
 */
import { FORMAS_PUE_POR_PAGAR, fechaCortaMx, finDeMes, type CfdiRecibido } from './cfdi-factura.contract';
import { diaDeFecha, diaMxDeInstante } from './dia-negocio.contract';

/** La empresa es persona física con actividad empresarial (`fiscal.issuer_config.regimen_fiscal`, medido 2026-11-26). */
export const REGIMEN_DE_LA_EMPRESA = '612';

/**
 * Emisores que timbran a nuestro nombre con otro régimen y que, **por regla**, se aceptan sin autorización
 * (Francisco, 2026-11-26). Medido en 2026: el IMSS, 27 facturas con 606 ($2.97 M); en 2025–26 alterna 606 y 612.
 */
export const EXCEPTUADOS_DEL_REGIMEN: ReadonlyMap<string, string> = new Map([['IMS421231I45', 'IMSS']]);

/**
 * `[D-NF4]` Bancos que timbran sus comisiones con S01 y **las cobran solos** de la cuenta: nadie las paga ni las
 * puede detener, así que pedir autorización no tiene salida (Francisco, 2026-11-26: «el banco las cobra solo»).
 * Medido en 2026 (recibidas S01 no canceladas): BBVA 110 (PUE/03), Banorte 21 (I y E; confirmado por Francisco el
 * mismo día). Un banco nuevo que timbre
 * S01 pide autorización hasta que se agregue aquí: se ve, no se da por bueno.
 */
export const COBRAN_SOLOS_SUS_COMISIONES: ReadonlyMap<string, string> = new Map([
  ['BBA830831LJ2', 'BBVA'],
  ['BMN930209927', 'Banorte'],
]);

export type UsoDelCfdi = 'pago' | 'compra' | 'gasto' | 'venta';
export type ReglaNorma = 'cancelada' | 'rol' | 'pue_mes_anterior' | 'sin_efectos_fiscales' | 'regimen' | 'sin_verificar';

/**
 * - `apta`: se puede usar para registrar.
 * - `requiere_autorizacion`: no se usa hasta que Administración o Contabilidad decida (basta una firma, D-NF2).
 * - `sin_medir`: no se sabe (el SAT no la verificó, falta un dato): se dice, nunca se pinta como apta.
 * - `solo_informativa`: se ve y se consulta; **no** registra un pago, una compra, un gasto ni una venta.
 */
export type VeredictoNorma = 'apta' | 'sin_medir' | 'requiere_autorizacion' | 'solo_informativa';

/** Las reglas que Administración o Contabilidad pueden autorizar; las demás no tienen esa salida. */
export const REGLAS_AUTORIZABLES: ReadonlySet<ReglaNorma> = new Set<ReglaNorma>(['sin_efectos_fiscales', 'regimen']);

/** El CFDI tal como está en `fiscal.cfdis`. */
export interface CfdiParaNorma {
  uuid: string;
  rol: 'recibidas' | 'emitidas' | string;
  /** `timestamptz` (llega como `Date`), ISO con hora o `YYYY-MM-DD`. */
  fecha: Date | string | null;
  estatus_sat: string | null;
  metodo_pago: string | null;
  forma_pago: string | null;
  receptor_uso_cfdi: string | null;
  receptor_regimen: string | null;
  emisor_regimen: string | null;
  emisor_rfc: string | null;
  /**
   * `I` ingreso · `E` egreso · `T` traslado · `P` pago · `N` nómina. Un traslado lleva S01 por regla del SAT
   * (no ampara dinero: 116 de 2026, $0), así que N2 no aplica. Ausente = no se sabe: N2 aplica.
   */
  tipo_comprobante?: string | null;
}

/**
 * `[PGP.224]` La decisión sobre ESTE UUID y UNA regla (`finance.cfdi_norm_authorizations`, un renglón vivo por
 * regla). Basta una firma, de Administración o de Contabilidad (D-NF2). Si aparece otra regla después (p. ej. la
 * cancelan), esa no está cubierta y vuelve a detener.
 */
export interface AutorizacionNorma {
  regla: ReglaNorma;
  decision: 'se_usa' | 'no_se_usa';
  /** Quién decidió (para decirlo en el motivo); null = no se sabe. */
  por?: string | null;
}

export interface EntradaNorma {
  cfdi: CfdiParaNorma;
  uso: UsoDelCfdi;
  /** El día en que sale el dinero o se registra la operación (`YYYY-MM-DD`, México). */
  fecha_operacion: string;
  /** Hoy en México (`YYYY-MM-DD`): nada sale antes de hoy. */
  hoy: string;
  /** Las decisiones vivas de este UUID, una por regla. */
  autorizaciones?: readonly AutorizacionNorma[] | null;
}

export interface MotivoNorma {
  regla: ReglaNorma;
  /** Lo que esta regla sola decide; `apta` con texto = aviso que se muestra pero no detiene. */
  veredicto: VeredictoNorma;
  texto: string;
}

export interface NormaDelCfdi {
  /** El más severo de los motivos; `apta` si no hay ninguno que detenga. */
  veredicto: VeredictoNorma;
  /** Del más severo al aviso. */
  motivos: MotivoNorma[];
}

const SEVERIDAD: Record<VeredictoNorma, number> = { apta: 0, sin_medir: 1, requiere_autorizacion: 2, solo_informativa: 3 };

const limpio = (v: string | null | undefined): string => String(v ?? '').trim();

/** El día (México) de la fecha del CFDI: un texto sin zona es hora de México; un instante se pasa a México. */
export function diaDelCfdi(v: Date | string | null | undefined): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return diaMxDeInstante(v);
  const s = String(v).trim();
  return /(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? diaMxDeInstante(s) : diaDeFecha(s);
}

const usoTexto: Record<UsoDelCfdi, string> = { pago: 'un pago', compra: 'una compra', gasto: 'un gasto', venta: 'una venta' };

/**
 * `[PGP.223]` **El veredicto de la norma para usar un CFDI.** Pura: no lee la base ni el reloj.
 */
export function normaFiscalDelCfdi(e: EntradaNorma): NormaDelCfdi {
  const c = e.cfdi;
  const m: MotivoNorma[] = [];
  const estatus = limpio(c.estatus_sat).toLowerCase();
  const recibida = limpio(c.rol).toLowerCase() === 'recibidas';
  const emitida = limpio(c.rol).toLowerCase() === 'emitidas';
  const venta = e.uso === 'venta';

  // N0 · cancelada (cualquier caja: «Cancelado» con mayúscula también es cancelado).
  if (estatus.startsWith('cancel')) {
    m.push({ regla: 'cancelada', veredicto: 'solo_informativa', texto: 'El SAT la tiene cancelada: sólo informativa. Pide la que la sustituye' });
  }

  // El rol: una emitida no ampara un pago, una compra ni un gasto; una recibida no es venta.
  if (venta ? !emitida : !recibida) {
    m.push({
      regla: 'rol',
      veredicto: 'solo_informativa',
      texto: venta ? 'Es una factura recibida: no es venta' : `Es una factura emitida por nosotros: no ampara ${usoTexto[e.uso]}`,
    });
  }

  // N1 · PUE de un mes anterior: sólo al pagar, sólo cheque o transferencia (con tarjeta o efectivo ya se pagó).
  if (e.uso === 'pago' && limpio(c.metodo_pago).toUpperCase() === 'PUE' && FORMAS_PUE_POR_PAGAR.has(limpio(c.forma_pago))) {
    const dia = diaDelCfdi(c.fecha);
    const sale = e.fecha_operacion > e.hoy ? e.fecha_operacion : e.hoy;
    if (!dia) {
      m.push({ regla: 'pue_mes_anterior', veredicto: 'sin_medir', texto: 'Es PUE y no se pudo leer su fecha: no se sabe si su mes ya cerró' });
    } else if (sale > finDeMes(dia)) {
      m.push({
        regla: 'pue_mes_anterior',
        veredicto: 'solo_informativa',
        texto: `PUE del ${fechaCortaMx(dia)}: su mes cerró el ${fechaCortaMx(finDeMes(dia))} y el pago sale el ${fechaCortaMx(sale)}. No se paga: pide al proveedor que la sustituya por PPD`,
      });
    }
  }

  const conAutorizacion = (regla: ReglaNorma, que: string, salida: string): MotivoNorma => {
    const a = (e.autorizaciones ?? []).find((x) => x.regla === regla);
    const quien = limpio(a?.por);
    if (a?.decision === 'se_usa') {
      return { regla, veredicto: 'apta', texto: `${que}: autorizada${quien ? ` por ${quien}` : ''} (Administración o Contabilidad)` };
    }
    if (a?.decision === 'no_se_usa') {
      return { regla, veredicto: 'solo_informativa', texto: `${que}: ${quien || 'Administración o Contabilidad'} decidió que no se usa` };
    }
    return { regla, veredicto: 'requiere_autorizacion', texto: `${que}: ${salida}` };
  };
  const pideAutorizacion = 'necesita la autorización de Administración o Contabilidad';

  // N2 · sin efectos fiscales. En venta, S01 es lo normal (la factura global a público en general); en un
  // traslado, también (el SAT lo exige). La comisión que el banco cobra solo no tiene a quién pedirle (D-NF4).
  const traslado = limpio(c.tipo_comprobante).toUpperCase() === 'T';
  if (!venta && recibida && !traslado && limpio(c.receptor_uso_cfdi).toUpperCase() === 'S01') {
    const banco = COBRAN_SOLOS_SUS_COMISIONES.get(limpio(c.emisor_rfc).toUpperCase());
    m.push(banco
      ? { regla: 'sin_efectos_fiscales', veredicto: 'apta', texto: `Uso S01 de ${banco}: el banco la cobra solo, no pide autorización` }
      : conAutorizacion('sin_efectos_fiscales', 'Uso S01 (sin efectos fiscales)', pideAutorizacion));
  }

  // N3 · régimen: el nuestro en la recibida, el del emisor (nosotros) en la emitida.
  const regimen = limpio(recibida ? c.receptor_regimen : c.emisor_regimen);
  if (recibida || emitida) {
    if (!regimen) {
      m.push({ regla: 'regimen', veredicto: 'sin_medir', texto: 'La factura no dice el régimen fiscal: no se puede revisar' });
    } else if (regimen !== REGIMEN_DE_LA_EMPRESA) {
      const exceptuado = recibida ? EXCEPTUADOS_DEL_REGIMEN.get(limpio(c.emisor_rfc).toUpperCase()) : undefined;
      if (exceptuado) {
        m.push({ regla: 'regimen', veredicto: 'apta', texto: `Régimen ${regimen}: el ${exceptuado} es excepción por regla` });
      } else if (emitida) {
        m.push({ regla: 'regimen', veredicto: 'solo_informativa', texto: `Emitida con régimen ${regimen}, no ${REGIMEN_DE_LA_EMPRESA}: no es venta de la distribuidora` });
      } else {
        m.push(conAutorizacion('regimen', `Viene a nuestro nombre con régimen ${regimen}, no ${REGIMEN_DE_LA_EMPRESA}`, `${pideAutorizacion}, o que el emisor la vuelva a timbrar`));
      }
    }
  }

  // N4 · sin verificar: no se paga hasta que el SAT la verifique; para registrar, sólo se avisa.
  if (estatus !== 'vigente' && !estatus.startsWith('cancel')) {
    m.push(e.uso === 'pago'
      ? { regla: 'sin_verificar', veredicto: 'sin_medir', texto: 'El SAT todavía no la verifica: no se paga hasta que el escáner nocturno la verifique' }
      : { regla: 'sin_verificar', veredicto: 'apta', texto: 'El SAT todavía no la verifica' });
  }

  m.sort((a, b) => SEVERIDAD[b.veredicto] - SEVERIDAD[a.veredicto]);
  return { veredicto: m.length ? m[0].veredicto : 'apta', motivos: m };
}

/** Sólo una factura `apta` registra un pago, una compra, un gasto o una venta. */
export function puedeRegistrar(n: NormaDelCfdi): boolean {
  return n.veredicto === 'apta';
}

/** El motivo que detiene (para el 409 y el renglón); null si es apta. */
export function motivoQueDetiene(n: NormaDelCfdi): MotivoNorma | null {
  return n.veredicto === 'apta' ? null : n.motivos[0];
}

// ─── [PGP.225] El freno en Pagos ─────────────────────────────────────────────────────────────────
//
// Se revisa al PROGRAMAR (crear el pago, sumarle una factura, reprogramarlo) y al AUTORIZAR (el pago
// o el día completo). ⛔ No al marcar pagado: para entonces el banco ya mostró la salida, y negarse
// dejaría un pago que salió como pendiente. Lo que pasó fuera de norma ahí lo dice el aviso
// `pue_pagada_fuera` de `[PGP.158]`.

export type MomentoDelPago = 'programar' | 'autorizar';

/**
 * Lo que detiene un pago:
 * - `solo_informativa` (cancelada, PUE de mes anterior): siempre.
 * - `sin_medir`: al autorizar (D-NF5: no se paga hasta que el SAT la verifique), salvo el régimen que la
 *   factura no trae (los CFDI 3.3 no lo tenían; 0 sin régimen en 2026, medido): se dice, no detiene.
 *   Programarla para otro día sí se puede: el escáner la verifica en la noche.
 * - `requiere_autorizacion` (S01, régimen sin decisión): al autorizar (`[PGP.229]`). Se programa para que
 *   el pago se vea y quien decide lo encuentre en la bandeja «Facturas fuera de norma», pero no sale sin que
 *   Administración o Contabilidad diga «se usa». Una decisión «no se usa» detiene siempre (es `solo_informativa`).
 */
export function detieneElPago(n: NormaDelCfdi, momento: MomentoDelPago): MotivoNorma | null {
  return n.motivos.find((m) => m.veredicto === 'solo_informativa'
    || (momento === 'autorizar' && m.veredicto === 'sin_medir' && m.regla !== 'regimen')
    || (momento === 'autorizar' && m.veredicto === 'requiere_autorizacion')) ?? null;
}

/** `[PGP.229]` Dónde se decide lo que pide decisión (lo dice el 409, para que tenga salida). */
export const DONDE_SE_DECIDE = 'decídela en Finanzas › Facturas fuera de norma';

/**
 * La norma de una factura del Calendario al pagarla, con el CFDI recibido que se le ligó (vigente o el cancelado
 * que casa) y las decisiones vivas de ese UUID (`[PGP.224]`).
 */
export function normaDelPago(
  c: CfdiRecibido, fecha_pago: string, hoy: string, autorizaciones?: readonly AutorizacionNorma[] | null,
): NormaDelCfdi {
  return normaFiscalDelCfdi({
    cfdi: {
      uuid: c.uuid, rol: 'recibidas', fecha: c.fecha, estatus_sat: c.estatus_sat ?? null, metodo_pago: c.metodo_pago, forma_pago: c.forma_pago,
      receptor_uso_cfdi: c.receptor_uso_cfdi ?? null, receptor_regimen: c.receptor_regimen ?? null, emisor_regimen: c.emisor_regimen ?? null,
      emisor_rfc: c.emisor_rfc, tipo_comprobante: 'I',   // `CfdiRecibido` es tipo I por definición (lo filtra su consulta)
    },
    uso: 'pago', fecha_operacion: fecha_pago, hoy, autorizaciones,
  });
}

/** Una factura del pago que la norma detiene. */
export interface FrenoDelPago {
  uuid: string;
  total: number;
  motivo: MotivoNorma;
}

const PESOS = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });

/** El mensaje del rechazo (409): qué factura y por qué, una por una. */
export function textoDelFreno(frenos: readonly FrenoDelPago[], momento: MomentoDelPago): string {
  const una = (f: FrenoDelPago) => `la factura de ${PESOS.format(f.total)} (CFDI ${f.uuid.slice(0, 8).toUpperCase()}): ${f.motivo.texto}`
    + (f.motivo.veredicto === 'requiere_autorizacion' ? ` (${DONDE_SE_DECIDE})` : '');
  return `No se puede ${momento} este pago — ${frenos.map(una).join(' · ')}`;
}
