/**
 * `[PGP.103]` **Un pago del Calendario está pagado cuando lo prueban el banco y su comprobante.**
 *
 * El flujo nuevo de Pagos (Edgar, 2026-11-09): armar → forma de pago → Dirección autoriza → se paga
 * → **se valida contra el estado de cuenta y el comprobante** → se escribe el `X-D-26` en Kepler.
 * «Pagado» deja de ser un clic: lo pone la evidencia (F2: banco Y comprobante).
 *
 * Medido en prod (sólo lectura, `[PGP.102]`, 2026-11-09), contra los 87 pagos del Calendario que
 * Kepler ya saldó como verdad independiente, con placebo (fechas corridas −35/−60 días):
 * - **Pago ↔ movimiento del banco**, MISMA cuenta de origen, ±$1, ±5 días del día del pago: 65 de 87
 *   casan, 0 con varios candidatos, **placebo 0**. Sin la cuenta (cualquier cuenta) el placebo sube a
 *   4–7 % por importes que se repiten (domiciliaciones, traspasos): por eso **sin cuenta no se
 *   valida** — se declara `sin_cuenta`, nunca se casa contra cualquier cuenta.
 * - **Comprobante ↔ movimiento**, por la cuenta de origen que lee el OCR, ±$1, ±5 días: 87 de 90,
 *   **placebo 0**. Así el comprobante se liga al pago A TRAVÉS del movimiento, sin depender del folio
 *   de Kepler (que en el flujo nuevo todavía no existe).
 * - Desfase salida ↔ día programado: 59 el mismo día, 12 a +1, 1 a +2, 2 a −4.
 * - Un pago partido en varias transferencias o varios pagos en una sola NO se distinguen del azar
 *   (7 reales contra 9 del placebo): no se casan solos, quedan para una persona.
 *
 * ⛔ **Uno a uno.** Un movimiento valida UN pago vigente y un comprobante, UN movimiento. Si dos los
 * reclaman, ninguno se valida: `discrepa` (medido: 1 par de pagos vigentes iguales del mismo acreedor).
 * ⛔ Lo que no se puede medir se DECLARA (ADR-056): sin cuenta de origen, efectivo (la ventanilla
 * hoy sólo deja rastro DESPUÉS de Kepler), estado de cuenta que no llega al día, y la CLABE destino
 * (el catálogo de cuentas de proveedor está vacío): nunca «validado» por omisión.
 */
import { TOLERANCIA_IMPORTE, VENTANA_MISMA_CUENTA_DIAS, difDias } from './salida-proveedor.contract';

/** Un pago vigente del Calendario, como lo necesita la validación. */
export interface PagoAValidar {
  id: string;
  /** Día al que está programado (`YYYY-MM-DD`). */
  dia: string;
  /** Lo que sale del banco: `amount_assigned` (el neto, con los descuentos al pagar ya restados). */
  importe: number;
  /** `payment_allocations.bank_account_id`; null = no se preparó la cuenta de origen. */
  cuenta_id: string | null;
  metodo: string | null;
}

/** Una salida del estado de cuenta (`finance.bank_movements`, `amount_out > 0`). */
export interface MovimientoBanco {
  id: string;
  cuenta_id: string;
  fecha: string;
  importe: number;
  /** Fecha imposible (posterior a hoy, o año mal tecleado): no se usa para validar. */
  fecha_invalida?: boolean;
}

/** Un comprobante de pago (PDF/OCR), con su cuenta de origen ya resuelta a `finance.bank_accounts`. */
export interface ComprobanteBanco {
  id: string;
  /** La cuenta propia que el OCR leyó como origen; null = no se pudo resolver. */
  cuenta_id: string | null;
  fecha: string | null;
  importe: number;
}

export type EstadoValidacion =
  | 'validado'
  | 'falta_comprobante'
  | 'sin_movimiento'
  | 'esperando_banco'
  | 'discrepa'
  | 'sin_cuenta'
  | 'efectivo_no_medido';

export interface ValidacionPago {
  estado: EstadoValidacion;
  movimiento_id: string | null;
  comprobante_id: string | null;
  /** Por qué no se validó, en palabras; null si se validó. */
  motivo: string | null;
  /** La CLABE destino no tiene contra qué compararse (catálogo de cuentas de proveedor vacío): se declara. */
  clabe: 'no_medido';
}

export interface EntradaValidacion {
  pagos: readonly PagoAValidar[];
  movimientos: readonly MovimientoBanco[];
  comprobantes: readonly ComprobanteBanco[];
  /** Hasta qué día está cargado el estado de cuenta de cada cuenta (`YYYY-MM-DD`). Sin fila = nada cargado. */
  cargado_hasta: ReadonlyMap<string, string>;
}

const casa = (importeA: number, importeB: number, fechaA: string, fechaB: string): boolean =>
  Math.abs(importeA - importeB) <= TOLERANCIA_IMPORTE && Math.abs(difDias(fechaA, fechaB)) <= VENTANA_MISMA_CUENTA_DIAS;

/** `YYYY-MM-DD` + n días. */
function masDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const resultado = (estado: EstadoValidacion, motivo: string | null, movimiento_id: string | null = null, comprobante_id: string | null = null): ValidacionPago =>
  ({ estado, movimiento_id, comprobante_id, motivo, clabe: 'no_medido' });

/**
 * Valida cada pago contra el estado de cuenta y los comprobantes. Pura: no toca la base.
 * Devuelve un resultado por cada pago de la entrada.
 */
export function validarPagos(e: EntradaValidacion): Map<string, ValidacionPago> {
  const movs = e.movimientos.filter((m) => !m.fecha_invalida && m.importe > 0);
  const out = new Map<string, ValidacionPago>();

  // 1. Candidatos de cada pago (misma cuenta, ±$1, ±5 días) y cuántos pagos reclaman cada movimiento.
  const candidatos = new Map<string, MovimientoBanco[]>();
  const reclamos = new Map<string, number>();
  for (const p of e.pagos) {
    if (p.metodo === 'efectivo' || !p.cuenta_id) continue;
    const c = movs.filter((m) => m.cuenta_id === p.cuenta_id && casa(p.importe, m.importe, p.dia, m.fecha));
    candidatos.set(p.id, c);
    for (const m of c) reclamos.set(m.id, (reclamos.get(m.id) ?? 0) + 1);
  }

  // 2. Cada comprobante, contra los movimientos (cuenta de origen del OCR, ±$1, ±5 días).
  const compPorMov = new Map<string, ComprobanteBanco[]>();
  const movsPorComp = new Map<string, number>();
  for (const c of e.comprobantes) {
    if (!c.cuenta_id || !c.fecha || !(c.importe > 0)) continue;
    for (const m of movs) {
      if (m.cuenta_id !== c.cuenta_id || !casa(c.importe, m.importe, c.fecha, m.fecha)) continue;
      const arr = compPorMov.get(m.id) ?? [];
      arr.push(c);
      compPorMov.set(m.id, arr);
      movsPorComp.set(c.id, (movsPorComp.get(c.id) ?? 0) + 1);
    }
  }

  for (const p of e.pagos) {
    if (p.metodo === 'efectivo') {
      out.set(p.id, resultado('efectivo_no_medido', 'Pago en efectivo: hoy la ventanilla sólo deja rastro después de capturarlo en Kepler. Se valida a mano.'));
      continue;
    }
    if (!p.cuenta_id) {
      out.set(p.id, resultado('sin_cuenta', 'Falta la cuenta de origen: sin ella no se puede buscar el pago en el estado de cuenta.'));
      continue;
    }
    const c = candidatos.get(p.id) ?? [];
    if (!c.length) {
      const hasta = e.cargado_hasta.get(p.cuenta_id) ?? null;
      // Mientras el estado de cuenta no cubra toda la ventana, la ausencia no prueba nada.
      if (!hasta || hasta < masDias(p.dia, VENTANA_MISMA_CUENTA_DIAS)) {
        out.set(p.id, resultado('esperando_banco', hasta
          ? `El estado de cuenta de esa cuenta llega al ${hasta}: todavía no cubre los días en que debió salir.`
          : 'No hay estado de cuenta cargado de esa cuenta.'));
      } else {
        out.set(p.id, resultado('sin_movimiento', 'No hay una salida de esa cuenta por ese importe (±$1) cerca del día del pago (±5 días).'));
      }
      continue;
    }
    if (c.length > 1) {
      out.set(p.id, resultado('discrepa', `Hay ${c.length} salidas posibles por ese importe en esa cuenta: elige cuál es.`));
      continue;
    }
    const m = c[0];
    if ((reclamos.get(m.id) ?? 0) > 1) {
      out.set(p.id, resultado('discrepa', 'La misma salida del banco casa con otro pago del Calendario: decide de cuál es.', m.id));
      continue;
    }
    const comps = (compPorMov.get(m.id) ?? []).filter((x) => (movsPorComp.get(x.id) ?? 0) === 1);
    if (!comps.length) {
      const ambiguos = (compPorMov.get(m.id) ?? []).length > 0;
      out.set(p.id, ambiguos
        ? resultado('discrepa', 'El comprobante casa con más de una salida del banco: decide de cuál es.', m.id)
        : resultado('falta_comprobante', 'La salida está en el banco; falta subir su comprobante.', m.id));
      continue;
    }
    if (comps.length > 1) {
      out.set(p.id, resultado('discrepa', `Hay ${comps.length} comprobantes para la misma salida: deja uno.`, m.id));
      continue;
    }
    out.set(p.id, resultado('validado', null, m.id, comps[0].id));
  }
  return out;
}

const TEXTO: Record<EstadoValidacion, string> = {
  validado: 'Pagado: banco y comprobante',
  falta_comprobante: 'En el banco · falta el comprobante',
  sin_movimiento: 'No aparece en el banco',
  esperando_banco: 'Esperando el estado de cuenta',
  discrepa: 'Revisar: no casa solo',
  sin_cuenta: 'Sin cuenta de origen: no se puede validar',
  efectivo_no_medido: 'Efectivo: se valida a mano',
};
/** La frase corta del renglón; el motivo largo va aparte. */
export function textoValidacion(e: EstadoValidacion): string { return TEXTO[e]; }

/** ¿Este pago ya se puede escribir en Kepler? Sólo lo validado con banco Y comprobante (F2). */
export function validadoParaKepler(v: ValidacionPago | null | undefined): boolean {
  return !!v && v.estado === 'validado';
}

// ───────────────────────────── [PGP.130] El comprobante dispara el pago ─────────────────────────────

/**
 * `[PGP.130]` Un pago del Calendario visto por su comprobante: lo que hace falta para casarlos sin el banco.
 * Edgar, 2026-11-17 (D1 del anexo «cero captura»): el comprobante validado dispara el registro en Kepler el
 * mismo día; el estado de cuenta lo confirma después.
 */
export interface PagoPorComprobante {
  id: string;
  /** Día al que está programado (`YYYY-MM-DD`). */
  dia: string;
  importe: number;
  /** La cuenta de origen preparada; sin ella no se casa (el placebo sube sin la cuenta, `[PGP.102]`). */
  cuenta_id: string | null;
  metodo: string | null;
  /** Autorizado por Dirección (el pago, `[PGP.113]`, o su día entero). */
  autorizado: boolean;
  /** Ya tiene un comprobante (ligado o esperando a ligarse). */
  con_comprobante: boolean;
}

export type EstadoComprobante = 'casa' | 'sin_lectura' | 'sin_pago' | 'varios' | 'disputado' | 'ya_tiene' | 'sin_autorizar';

export interface CasaComprobante {
  estado: EstadoComprobante;
  pago_id: string | null;
  /** En palabras; null si casa. */
  motivo: string | null;
  /**
   * `[PGP.232]` Casó con un pago que la Suite no había autorizado (D6: el dinero ya salió). Sólo viene cuando casa.
   * Ya no se produce el estado `sin_autorizar`: se queda en el tipo para las pantallas que lo pintan.
   */
  sin_autorizar?: boolean;
}

/** Métodos que nunca salen como transferencia: su comprobante no es un SPEI. */
const NO_TRANSFERENCIA = new Set(['efectivo', 'cheque']);

/**
 * `[PGP.130]` **Cada comprobante, contra los pagos del Calendario, sin pasar por el banco.** Pura.
 *
 * La regla es la de `validarPagos` (misma cuenta de origen, ±$1, ±5 días del día programado) aplicada
 * directo comprobante ↔ pago. Medido en prod el 2026-11-17 con los 101 comprobantes de transferencia del
 * 3 al 13 de noviembre: de los 47 con pago del Calendario que se podían leer, **46 casan solos con su pago
 * y ninguno con otro**; con las fechas corridas −35, −60 y +35 días (placebo) casan **0 de 99**.
 *
 * ⛔ Uno a uno: si dos comprobantes reclaman el mismo pago, ninguno casa (`disputado`); si un comprobante
 * tiene dos pagos posibles, no se adivina (`varios`).
 *
 * `[PGP.232]` Edgar, 2026-11-27: *«cuando se agregue el comprobante se escriba en Kepler y se re-afirme con el
 * movimiento de banco»*. Antes, un pago sin autorizar no lo pagaba un comprobante y esperaba al estado de cuenta; como
 * ningún pago se autoriza en la Suite (207 de 207 desde octubre), el comprobante nunca disparaba nada. Ahora casa igual,
 * con `sin_autorizar: true` (D6: se registra y se marca); el banco lo confirma después (`[PGP.130b]`) o avisa que la
 * salida no apareció.
 */
export function casarComprobantesConPagos(
  comprobantes: readonly ComprobanteBanco[], pagos: readonly PagoPorComprobante[],
): Map<string, CasaComprobante> {
  const out = new Map<string, CasaComprobante>();
  const r = (estado: EstadoComprobante, motivo: string | null, pago_id: string | null = null): CasaComprobante => ({ estado, pago_id, motivo });
  const candidatos = new Map<string, PagoPorComprobante[]>();
  const reclamos = new Map<string, number>();
  for (const c of comprobantes) {
    if (!c.cuenta_id || !c.fecha || !(c.importe > 0)) continue;
    const cand = pagos.filter((p) => !NO_TRANSFERENCIA.has(String(p.metodo ?? '')) && p.cuenta_id === c.cuenta_id
      && casa(c.importe, p.importe, c.fecha as string, p.dia));
    candidatos.set(c.id, cand);
    if (cand.length === 1) reclamos.set(cand[0].id, (reclamos.get(cand[0].id) ?? 0) + 1);
  }
  for (const c of comprobantes) {
    if (!c.cuenta_id || !c.fecha || !(c.importe > 0)) {
      out.set(c.id, r('sin_lectura', !c.cuenta_id
        ? 'No se leyó una cuenta de origen nuestra en el comprobante: sin ella no se casa con ningún pago.'
        : 'El comprobante no trae fecha o importe legibles.'));
      continue;
    }
    const cand = candidatos.get(c.id) ?? [];
    if (!cand.length) {
      out.set(c.id, r('sin_pago', 'Ningún pago del Calendario sale de esa cuenta por ese importe (±$1) cerca de esa fecha (±5 días).'));
      continue;
    }
    if (cand.length > 1) {
      out.set(c.id, r('varios', `Casa con ${cand.length} pagos del Calendario: no se adivina cuál es.`));
      continue;
    }
    const p = cand[0];
    if ((reclamos.get(p.id) ?? 0) > 1) { out.set(c.id, r('disputado', 'Otro comprobante casa con el mismo pago: deja uno.', p.id)); continue; }
    if (p.con_comprobante) { out.set(c.id, r('ya_tiene', 'Ese pago ya tiene su comprobante.', p.id)); continue; }
    out.set(c.id, { ...r('casa', null, p.id), sin_autorizar: !p.autorizado });
  }
  return out;
}

/** `[PGP.130]` La respuesta de `POST finance/supplier-payments/calendario`: un comprobante, leído y casado (o no). */
export interface ResultadoComprobanteCalendario {
  /** `repetido` = la misma clave de rastreo ya está en otro comprobante vivo. */
  estado: EstadoComprobante | 'repetido';
  /** El pago del Calendario con el que casó (o el que lo impidió); null si no hay uno. */
  pago_id: string | null;
  /** El comprobante guardado; null si no se guardó (sólo se guarda lo que casa). */
  comprobante_id: string | null;
  motivo: string | null;
  /** Lo que leyó el servidor del PDF, para que la persona vea por qué casó o no. */
  lectura: { importe: number | null; fecha: string | null; cuenta_origen: string | null; beneficiario: string | null; ocr_status: string };
  /**
   * La lectura completa (la que el servidor guardó con su huella `sha256`). Si no casa con el Calendario, la pantalla
   * sigue con el carril de Kepler (`match-pago` → `attach`) con ESTA lectura: el PDF no se manda a leer otra vez y
   * `attach` la recupera del servidor por su huella, no le cree al navegador.
   */
  ocr: LecturaComprobante;
}

/** `[PGP.130]` La lectura de un comprobante de transferencia, como la devuelve el servidor. */
export interface LecturaComprobante {
  monto: number | null; fecha: string | null; concepto: string | null; cuenta_origen: string | null; cuenta_destino: string | null;
  beneficiario: string | null; clave_rastreo: string | null; banco_destino: string | null; metodo: string | null;
  ocr_status: string; sha256?: string;
}

/**
 * `[PGP.191]` Un pago del Calendario visto desde SU renglón: la persona soltó el PDF sobre él, así que no se busca a
 * qué pago corresponde (eso es `casarComprobantesConPagos`) — se revisa que el PDF sea de ESTE pago.
 */
export interface PagoDelRenglon {
  /** `payment_allocations.status`: pending · executed · failed · cancelled. */
  status: string;
  metodo: string | null;
  /** La cuenta de origen preparada; null si nunca se preparó. */
  cuenta_id: string | null;
  importe: number;
  /** Día al que estaba programado (`YYYY-MM-DD`). */
  dia: string;
  /** Autorizado por Dirección (el pago o su día entero). */
  autorizado: boolean;
  /** Ya tiene un comprobante (ligado o esperando a ligarse). */
  con_comprobante: boolean;
}

/** Lo que el servidor leyó del PDF, con la cuenta de origen ya resuelta contra nuestras cuentas de banco. */
export interface LecturaDelRenglon {
  importe: number | null;
  fecha: string | null;
  /** Nuestra cuenta de banco que el PDF dice como origen; null si no es nuestra o no se leyó. */
  cuenta_id: string | null;
  /** Lo que el PDF dice como cuenta de origen, para decirlo si no es nuestra. */
  cuenta_leida: string | null;
}

export type DecisionDelRenglon =
  | {
    liga: true;
    /** DA1 (Francisco, 2026-11-21): un pago sin pagar y sin autorizar que paga su comprobante sale «sin autorizar» (`[PGP.192]`). */
    sin_autorizar: boolean;
    /** La cuenta que se le fija al pago: la del PDF, si el pago nunca se preparó. Null si ya la tenía. */
    fija_cuenta: string | null;
  }
  | { liga: false; motivo: string };

/** `[PGP.191]` Un PDF de más de 30 días antes del día programado no es de este pago: es de otro. */
export const DIAS_ANTES_DEL_PROGRAMA = 30;

const pesos = (n: number) => `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const diasAntes = (iso: string, dias: number): string => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
};

/**
 * `[PGP.191]` **¿El PDF que soltaron sobre este renglón es el de este pago?** Pura.
 *
 * La persona eligió el pago, así que la regla no busca: revisa. Liga si el importe cuadra (±$1, `TOLERANCIA_IMPORTE`),
 * el PDF sale de una cuenta nuestra de banco —la preparada, si el pago se preparó— y su fecha no es futura ni de más de
 * 30 días antes del día programado. ⛔ Lo cancelado, lo rebotado, el efectivo y el cheque no se ligan: un SPEI no prueba
 * ninguno de ellos. ⛔ Un pago con comprobante no recibe otro.
 *
 * Un pago pendiente SIN autorizar sí se liga (DA1 de Francisco, 2026-11-21: el dinero ya salió) y sale marcado
 * `sin_autorizar`. Desde `[PGP.232]` el escritor de Kepler ya no lo retiene (lo hacía `[PGP.192]`): se escribe al ligarse
 * y el estado de cuenta lo re-afirma después, o avisa que la salida no apareció.
 */
export function decidirComprobanteDelRenglon(p: PagoDelRenglon, l: LecturaDelRenglon, hoy: string): DecisionDelRenglon {
  const no = (motivo: string): DecisionDelRenglon => ({ liga: false, motivo });
  if (p.status === 'cancelled') return no('Este pago está cancelado: no lleva comprobante.');
  if (p.status === 'failed') return no('Este pago rebotó: muévelo a otro día antes de ligarle un comprobante.');
  if (p.status !== 'pending' && p.status !== 'executed') return no('Este pago no admite comprobante en su estado.');
  if (p.metodo && NO_TRANSFERENCIA.has(p.metodo)) return no(`Este pago sale en ${p.metodo}: el PDF de una transferencia no lo prueba.`);
  if (p.con_comprobante) return no('Este pago ya tiene su comprobante.');
  if (l.importe == null) return no('No se pudo leer el importe del PDF: súbelo en PDF legible.');
  if (Math.abs(l.importe - p.importe) > TOLERANCIA_IMPORTE) {
    return no(`El PDF es por ${pesos(l.importe)} y este pago es de ${pesos(p.importe)}: ¿es el comprobante de otro pago?`);
  }
  if (!l.cuenta_id) {
    return no(l.cuenta_leida
      ? `El PDF sale de la cuenta ${l.cuenta_leida}, que no es una cuenta de banco nuestra.`
      : 'No se pudo leer de qué cuenta salió el dinero.');
  }
  if (p.cuenta_id && p.cuenta_id !== l.cuenta_id) return no('El PDF sale de otra cuenta que la preparada para este pago.');
  if (!l.fecha) return no('No se pudo leer la fecha del PDF.');
  if (l.fecha > hoy) return no(`El PDF tiene fecha ${l.fecha}, posterior a hoy: revisa que se haya leído bien.`);
  if (l.fecha < diasAntes(p.dia, DIAS_ANTES_DEL_PROGRAMA)) {
    return no(`El PDF es del ${l.fecha}, más de ${DIAS_ANTES_DEL_PROGRAMA} días antes del día de este pago (${p.dia}): ¿es de otro pago?`);
  }
  return { liga: true, sin_autorizar: p.status === 'pending' && !p.autorizado, fija_cuenta: p.cuenta_id ? null : l.cuenta_id };
}

/** `[PGP.191]` La respuesta de `POST finance/supplier-payments/calendario/:allocationId`. */
export interface ResultadoComprobanteDelRenglon {
  /** `ligado` = guardado; el worker lo da por pagado (o sólo lo liga) en su siguiente pasada. */
  estado: 'ligado' | 'no' | 'sin_lectura' | 'repetido';
  pago_id: string;
  comprobante_id: string | null;
  /** En palabras; null si se ligó. */
  motivo: string | null;
  /** `[PGP.192]` El pago estaba sin autorizar: sale marcado y Kepler espera al estado de cuenta. */
  sin_autorizar: boolean;
  lectura: { importe: number | null; fecha: string | null; cuenta_origen: string | null; beneficiario: string | null; ocr_status: string };
}
