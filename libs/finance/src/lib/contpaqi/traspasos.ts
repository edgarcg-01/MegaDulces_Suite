/**
 * Fase CP `[CP.8.92]` — **El armador de los traspasos entre cuentas (póliza de Diario).**
 *
 * Vive aparte del servicio y sin dependencias de Nest, como `poliza-egreso.ts`: decide sobre dinero y tiene que
 * poder probarse sin DI.
 *
 * ── La forma, MEDIDA en sus pólizas (réplica de ContPAQi, ene–oct 2026) ─────────────────────────────────────
 * Contabilidad asienta los traspasos en UNA póliza de Diario (tipo 3) por cuenta de ORIGEN y por mes, fechada el
 * último día: «TRASPASOS ENTRE CUENTAS <alias>», con el alias de `bank_accounts` («BBVA 5712», «BB 854»). Por cada
 * traspaso lleva un cargo a la cuenta destino y un abono a la de origen, los dos con la fecha de fin de mes y sin
 * concepto por renglón: 163 de 164 pólizas tienen tantos abonos como cargos.
 *
 * ── El par sale de Bancos ───────────────────────────────────────────────────────────────────────────────────
 * Cada traspaso deja DOS movimientos en `finance.bank_movements` (categoría `traspaso_entre_cuentas`): la salida en
 * la cuenta de origen y la entrada en la destino. Se emparejan uno a uno, por importe y fecha (±1 día), y el
 * concepto del banco desempata: casi siempre nombra a la otra cuenta, por su etiqueta («TRASPASO A BBVA 5712»),
 * truncada («TRASPASO ENTRE CTAS 366», por la 3660) o por el final de su número completo («… 201»). Medido ene–sep:
 * el 94.4 % de las salidas tiene su entrada por importe y fecha, pero el placebo —la entrada un mes después— casa el
 * 31.0 %, porque los importes redondos se repiten. Por eso:
 *   · un concepto que nombra OTRA cuenta conocida descarta al candidato;
 *   · un empate entre destinos distintos (o entre orígenes distintos) se declara `ambigua`, no se elige al azar.
 *
 * ⛔ Lo que no se empareja NO se arma: sale en `sinArmar` con su motivo. Un traspaso a una cuenta que la Suite no
 *    tiene (una línea de crédito, otra empresa) no es un traspaso entre SUS cuentas, y asentarlo sería inventar la
 *    contraparte.
 * ⛔ No serializa ni registra el lote: eso es del servicio y del transporte, como en el egreso.
 */
import { ABONO, Asiento, CARGO, MovimientoAsiento, asientoCuadra } from './poliza-egreso';

/** ContPAQi: 1 = Ingreso · 2 = Egreso · 3 = Diario. */
export const TIPO_POLIZA_DIARIO = 3;

/** Una cuenta de banco de la Suite (`finance.bank_accounts`). */
export interface CuentaTraspaso {
  id: string;
  /** Su cuenta en ContPAQi (`contpaqi_cuenta`). `null` = sin mapear: lo que la toque no se arma. */
  contpaqi: string | null;
  /** El nombre que ella usa en el título de la póliza (`alias`: «BBVA 5712»). */
  alias: string | null;
  /** La terminación con la que la cita el banco (`account_label`: «5712», «854»). */
  etiqueta: string | null;
  /** El nombre de su cuenta en ContPAQi (`contpaqi_cuenta_nombre`), que trae el número completo. */
  nombre_contpaqi: string | null;
}

/** Un movimiento de Bancos con categoría `traspaso_entre_cuentas`: una de las dos piernas de un traspaso. */
export interface PiernaTraspaso {
  id: string;
  /** `YYYY-MM-DD`, la del estado de cuenta. */
  fecha: string;
  cuenta_id: string;
  concepto: string | null;
  /** `amount_in` y `amount_out`: exactamente uno de los dos es positivo. */
  entra: number;
  sale: number;
  /**
   * `YYYY-MM` del estado de cuenta que la trajo (`bank_statements.period`). `[CP.8.93]` Una fecha a más de
   * `TOLERANCIA_DIAS_ESTADO` días de ese mes es basura del estado de cuenta (medido: años 0206 y 2027, y el 1-ene en el
   * de octubre) y la pierna no se usa. Las del último día del mes anterior sí valen: así cortan algunos bancos.
   */
  periodo?: string | null;
}

/** `[CP.8.93]` Cuánto puede alejarse la fecha de un movimiento del mes de su estado de cuenta sin ser basura. */
export const TOLERANCIA_DIAS_ESTADO = 7;

export type MotivoSinArmar =
  | 'importe_invalido'       // entra y sale a la vez, o ninguno: no es una pierna
  | 'fecha_fuera_del_estado' // la fecha no es del mes de su estado de cuenta: se corrige en Bancos, no aquí
  | 'cuenta_sin_mapear'      // una de las dos cuentas no tiene su cuenta de ContPAQi
  | 'ambigua'                // dos contrapartes posibles que cambian la póliza, sin evidencia para elegir
  | 'salida_sin_entrada'     // salió y no entró en ninguna otra cuenta de la Suite
  | 'entrada_sin_salida';

export interface PiernaSinArmar {
  id: string;
  fecha: string;
  /** El mes en que se reporta: el de su fecha, o el de su estado de cuenta si la fecha es basura. */
  mes: string;
  cuenta_id: string;
  importe: number;
  motivo: MotivoSinArmar;
  detalle: string;
}

export interface Traspaso {
  salida: PiernaTraspaso;
  entrada: PiernaTraspaso;
  importe: number;
  /** Cuántas de las dos piernas nombran a la otra en su concepto: 0, 1 o 2. */
  evidencia: number;
}

export interface PolizaDeTraspasos {
  /** La cuenta de ContPAQi de la cuenta de origen: la que abona en todos los renglones. */
  cuenta_origen: string;
  asiento: Asiento;
  traspasos: Traspaso[];
}

export interface ArmadoTraspasos {
  mes: string;
  polizas: PolizaDeTraspasos[];
  sinArmar: PiernaSinArmar[];
}

/** Centavos enteros: comparar pesos en punto flotante es cómo se cuelan descuadres de 1 ¢. */
const cent = (n: number) => Math.round(Number(n || 0) * 100);
const digitos = (s: string | null) => String(s ?? '').replace(/\D/g, '');
const dias = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** El último día de un mes `YYYY-MM`: la fecha de sus pólizas de traspasos. */
export function ultimoDiaDelMes(mes: string): string {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

/** `[CP.8.93]` ¿La fecha es del mes del estado de cuenta, con `TOLERANCIA_DIAS_ESTADO` días de margen a cada lado? */
export function fechaDelEstado(fecha: string, periodo: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  return dias(`${periodo}-01`, fecha) >= -TOLERANCIA_DIAS_ESTADO && dias(ultimoDiaDelMes(periodo), fecha) <= TOLERANCIA_DIAS_ESTADO;
}

/** La terminación numérica con la que el concepto del banco nombra a la otra cuenta («TRASPASO A BBVA 5712» → «5712»). */
export function contraparteDelConcepto(concepto: string | null): string | null {
  const m = String(concepto ?? '').trim().match(/(\d{3,})$/);
  return m ? m[1] : null;
}

/**
 * Las cuentas de la Suite a las que puede referirse esa terminación: por su etiqueta tal cual, por la etiqueta
 * truncada por el banco (366 por 3660) o por el final de su número completo. Vacío = no nombra a ninguna conocida, y
 * entonces el concepto no informa (puede ser una referencia o una cuenta de fuera).
 */
export function cuentasQueNombra(token: string | null, cuentas: CuentaTraspaso[]): Set<string> {
  const out = new Set<string>();
  if (!token) return out;
  for (const c of cuentas) {
    const etiqueta = digitos(c.etiqueta);
    const numero = digitos(c.nombre_contpaqi);
    if ((etiqueta && etiqueta.startsWith(token)) || (numero && numero.endsWith(token))) out.add(c.id);
  }
  return out;
}

interface Lado { p: PiernaTraspaso; c: number; nombra: Set<string> }
interface Arista { s: Lado; e: Lado; d: number; evidencia: number }

/**
 * Empareja salidas con entradas, uno a uno. Las aristas se toman de la más fuerte a la más débil (más evidencia del
 * concepto, menos días de diferencia); si al tomar una hay otra libre del mismo rango que daría OTRA póliza (otro
 * destino para esa salida, u otro origen para esa entrada), las dos piernas se declaran `ambigua`.
 */
export function emparejarTraspasos(piernas: PiernaTraspaso[], cuentas: CuentaTraspaso[], ventanaDias = 1):
  { traspasos: Traspaso[]; sinArmar: PiernaSinArmar[] } {
  const cuenta = new Map(cuentas.map((c) => [c.id, c]));
  const contable = (id: string) => cuenta.get(id)?.contpaqi ?? `sin_mapear:${id}`;
  const sinArmar: PiernaSinArmar[] = [];
  const salidas: Lado[] = [];
  const entradas: Lado[] = [];
  for (const p of piernas) {
    const ce = cent(p.entra);
    const cs = cent(p.sale);
    if (ce < 0 || cs < 0 || (ce > 0) === (cs > 0)) {
      sinArmar.push({ id: p.id, fecha: p.fecha, mes: p.fecha.slice(0, 7), cuenta_id: p.cuenta_id, importe: (ce || cs) / 100,
        motivo: 'importe_invalido', detalle: `entra ${p.entra} y sale ${p.sale}: una pierna mueve dinero en un solo sentido` });
      continue;
    }
    if (p.periodo && !fechaDelEstado(p.fecha, p.periodo)) {
      sinArmar.push({ id: p.id, fecha: p.fecha, mes: p.periodo, cuenta_id: p.cuenta_id, importe: (ce || cs) / 100,
        motivo: 'fecha_fuera_del_estado',
        detalle: `fechada ${p.fecha} en el estado de cuenta de ${p.periodo}: la fecha se corrige en Bancos, no aquí` });
      continue;
    }
    const lado = { p, c: cs || ce, nombra: cuentasQueNombra(contraparteDelConcepto(p.concepto), cuentas) };
    (cs > 0 ? salidas : entradas).push(lado);
  }

  const entradasPorImporte = new Map<number, Lado[]>();
  for (const e of entradas) entradasPorImporte.set(e.c, [...(entradasPorImporte.get(e.c) ?? []), e]);
  const aristas: Arista[] = [];
  for (const s of salidas) {
    for (const e of entradasPorImporte.get(s.c) ?? []) {
      if (e.p.cuenta_id === s.p.cuenta_id) continue;
      const d = Math.abs(dias(s.p.fecha, e.p.fecha));
      if (d > ventanaDias) continue;
      // ⛔ Un concepto que nombra OTRA cuenta conocida dice que el dinero fue (o vino) de otro lado.
      if (s.nombra.size && !s.nombra.has(e.p.cuenta_id)) continue;
      if (e.nombra.size && !e.nombra.has(s.p.cuenta_id)) continue;
      aristas.push({ s, e, d, evidencia: Number(s.nombra.has(e.p.cuenta_id)) + Number(e.nombra.has(s.p.cuenta_id)) });
    }
  }
  aristas.sort((a, b) => b.evidencia - a.evidencia || a.d - b.d || cmp(a.s.p.fecha, b.s.p.fecha)
    || cmp(a.s.p.id, b.s.p.id) || cmp(a.e.p.id, b.e.p.id));
  const porSalida = new Map<string, Arista[]>();
  const porEntrada = new Map<string, Arista[]>();
  for (const a of aristas) {
    porSalida.set(a.s.p.id, [...(porSalida.get(a.s.p.id) ?? []), a]);
    porEntrada.set(a.e.p.id, [...(porEntrada.get(a.e.p.id) ?? []), a]);
  }

  const usada = new Set<string>();
  const ambiguas = new Set<string>();
  const traspasos: Traspaso[] = [];
  const libre = (b: Arista) => !usada.has(b.s.p.id) && !usada.has(b.e.p.id);
  for (const a of aristas) {
    if (!libre(a)) continue;
    const mismoRango = (b: Arista) => b !== a && b.evidencia === a.evidencia && b.d === a.d && libre(b);
    const otroDestino = (porSalida.get(a.s.p.id) ?? []).filter((b) => mismoRango(b) && contable(b.e.p.cuenta_id) !== contable(a.e.p.cuenta_id));
    const otroOrigen = (porEntrada.get(a.e.p.id) ?? []).filter((b) => mismoRango(b) && contable(b.s.p.cuenta_id) !== contable(a.s.p.cuenta_id));
    if (otroDestino.length || otroOrigen.length) {
      // ⛔ Las que empatan también: si sólo se apartaran estas dos, la pareja que queda parecería forzada y su acierto
      // dependería de una elección al azar.
      for (const id of [a.s.p.id, a.e.p.id, ...otroDestino.map((b) => b.e.p.id), ...otroOrigen.map((b) => b.s.p.id)]) {
        usada.add(id);
        ambiguas.add(id);
      }
      continue;
    }
    usada.add(a.s.p.id);
    usada.add(a.e.p.id);
    traspasos.push({ salida: a.s.p, entrada: a.e.p, importe: a.s.c / 100, evidencia: a.evidencia });
  }

  for (const l of [...salidas, ...entradas]) {
    if (usada.has(l.p.id) && !ambiguas.has(l.p.id)) continue;
    const sale = salidas.includes(l);
    const cita = contraparteDelConcepto(l.p.concepto);
    sinArmar.push({
      id: l.p.id, fecha: l.p.fecha, mes: l.p.fecha.slice(0, 7), cuenta_id: l.p.cuenta_id, importe: l.c / 100,
      motivo: ambiguas.has(l.p.id) ? 'ambigua' : sale ? 'salida_sin_entrada' : 'entrada_sin_salida',
      detalle: ambiguas.has(l.p.id)
        ? 'más de una contraparte posible el mismo día y por el mismo importe, y el concepto no decide'
        : `${sale ? 'ninguna entrada' : 'ninguna salida'} por el mismo importe en otra cuenta de la Suite (±${ventanaDias} día)`
          + `${cita ? `; el concepto cita «${cita}»${l.nombra.size ? '' : ', que no es una cuenta de la Suite'}` : ''}`,
    });
  }
  return { traspasos, sinArmar };
}

/**
 * Arma las pólizas de traspasos de un mes: una por cuenta de origen, con un cargo a la destino y un abono a la origen
 * por traspaso. `piernas` puede traer días del mes vecino (la ventana del emparejamiento); el traspaso es del mes de su
 * SALIDA, y de lo que no se armó sólo se devuelve lo fechado en el mes.
 */
export function armarTraspasosDelMes(mes: string, piernas: PiernaTraspaso[], cuentas: CuentaTraspaso[], ventanaDias = 1):
  ArmadoTraspasos {
  const cuenta = new Map(cuentas.map((c) => [c.id, c]));
  const { traspasos, sinArmar } = emparejarTraspasos(piernas, cuentas, ventanaDias);
  const delMes = (fecha: string) => fecha.slice(0, 7) === mes;
  const fuera: PiernaSinArmar[] = sinArmar.filter((x) => x.mes === mes);

  const porOrigen = new Map<string, Traspaso[]>();
  for (const t of traspasos) {
    if (!delMes(t.salida.fecha)) continue;
    const origen = cuenta.get(t.salida.cuenta_id)?.contpaqi;
    const destino = cuenta.get(t.entrada.cuenta_id)?.contpaqi;
    if (!origen || !destino) {
      const faltan = [!origen && 'la de origen', !destino && 'la destino'].filter(Boolean).join(' y ');
      for (const p of [t.salida, t.entrada]) {
        fuera.push({ id: p.id, fecha: p.fecha, mes, cuenta_id: p.cuenta_id, importe: t.importe, motivo: 'cuenta_sin_mapear',
          detalle: `sin su cuenta de ContPAQi: ${faltan}` });
      }
      continue;
    }
    porOrigen.set(origen, [...(porOrigen.get(origen) ?? []), t]);
  }

  const fecha = ultimoDiaDelMes(mes);
  const polizas: PolizaDeTraspasos[] = [];
  for (const [origen, lista] of [...porOrigen].sort(([a], [b]) => cmp(a, b))) {
    lista.sort((a, b) => cmp(a.salida.fecha, b.salida.fecha) || cmp(a.salida.id, b.salida.id));
    const alias = cuenta.get(lista[0].salida.cuenta_id)?.alias;
    const renglon = (cta: string, abono: boolean, importe: number): MovimientoAsiento =>
      ({ cuenta: cta, abono, importe, concepto: '', seg_negocio: 0 });
    // Como ella: primero los cargos a las destino, después los abonos a la origen.
    const movimientos = [
      ...lista.map((t) => renglon(cuenta.get(t.entrada.cuenta_id)?.contpaqi as string, CARGO, t.importe)),
      ...lista.map((t) => renglon(origen, ABONO, t.importe)),
    ];
    const asiento: Asiento = {
      tipo_poliza: TIPO_POLIZA_DIARIO,
      fecha,
      concepto: `TRASPASOS ENTRE CUENTAS ${alias ?? origen}`,
      movimientos,
      total: lista.reduce((s, t) => s + cent(t.importe), 0) / 100,
    };
    // ⛔ Última compuerta: si no cuadra es un error de este código, no un dato malo.
    if (!asientoCuadra(asiento)) throw new Error(`armarTraspasosDelMes: la póliza de ${origen} (${mes}) no cuadra.`);
    polizas.push({ cuenta_origen: origen, asiento, traspasos: lista });
  }
  return { mes, polizas, sinArmar: fuera };
}
