import type { Freshness } from '../http/provenance.contract';
import type { VeredictoCorte } from '../work/caja-corte.contract';

/**
 * ⭐⭐ `[CGS.2]` — **El arqueo desglosado: contra qué se compara lo contado.**
 *
 * ## ⛔ La corrección que da origen a este archivo
 *
 * La primera versión de la pestaña «Arqueos» comparaba el corte de la Suite contra el arqueo que
 * captura el Access `Control`. Edgar lo corrigió el 2026-10-20: *«no se compara contra Control; el
 * arqueo se compara contra lo que dice el sistema, contra la fórmula que arroja lo real»*.
 *
 * Y es una diferencia de fondo, no de énfasis. Comparar dos sistemas es una **conciliación**:
 * responde *«¿los dos contaron lo mismo?»*. El arqueo responde otra cosa — *«¿está en el cajón lo
 * que el libro dice que debería estar?»* —, y esa pregunta sólo tiene un contendiente: la fórmula.
 * Control queda como **segundo testigo**, no como la vara.
 *
 * ## La fórmula, y por qué se publica término por término
 *
 *     esperado = fondo_inicial + ingresos − gastos − depósitos + dispensó CAOS − depositó CAOS
 *
 * ⛔ **Cuatro de esos seis términos viven en `finance.cash_ledger_cuts`; los dos de CAOS NO.** Se
 * reconstruyen de `analytics.caos_cash_movements` por `accounting_date`. Medido el 2026-10-20
 * contra prod: **los seis términos reproducen el `esperado` sellado en los 7 cortes, al centavo**
 * — por eso el desglose se publica como MEDIDO y no como una resta que cuadra por construcción.
 *
 * ⭐ Y publicarlo término por término es lo que vuelve accionable al número: con el total solo,
 * *«falta $208,594.59»* no se puede investigar. Con los términos se ve que el 19-oct entraron
 * $827,089.59 de ingresos capturados y que CAOS se llevó $581,830 — y entonces la pregunta deja
 * de ser «¿dónde está el dinero?» y pasa a ser «¿qué pierna está mal cruzada?».
 *
 * ## ⚠️ Lo que el desglose NO arregla
 *
 * El `esperado` se calcula con lo que una persona capturó. Si no se captura una entrega, el
 * esperado baja junto con el contado y el corte **cuadra perfecto** (regla M4 del motor). Un
 * número que audita a una persona no puede calcularse sólo con lo que esa persona tecleó.
 */

/** De dónde salió el fondo inicial. `sin_medir` = nadie contó con cuánto arrancó la caja. */
export interface ArqueoFondo {
  monto: number | null;
  /** `contado` · `cierre_anterior` · `sin_medir` — y `null` cuando el corte no lo declaró. */
  origen: string | null;
}

/**
 * Las piernas de la bóveda ese día. `null` = el feed de CAOS no estaba, que **no es cero**: un
 * cero afirmaría que la máquina no se movió.
 */
export interface ArqueoCaos {
  /** Salió de la bóveda y quedó EN EL CAJÓN: suma al esperado. */
  dispensado: number;
  /** Salió del cajón y se fue a la bóveda: resta del esperado. */
  depositado: number;
  /** ⚠️ Entra/sale por fuera de la caja chica: se declara, NO entra en la fórmula. */
  dotado: number;
  vaciado: number;
  movimientos: number;
}

/** Una pieza del conteo sellado. `clave` identifica; el valor NO: $20 es billete y moneda. */
export interface ArqueoPieza {
  clave: string;
  tipo: 'billete' | 'moneda';
  valor: number;
  piezas: number;
  importe: number;
}

/**
 * ⚠️ El **segundo testigo**, no la vara. Control arquea el mismo cajón por su cuenta; cuando
 * discrepa del conteo de la Suite eso es una pista, no un veredicto. Cuál de los dos arbitra es
 * una decisión de negocio que no está tomada (ADR-059), y esta pantalla no la toma.
 */
export interface ArqueoTestigoControl {
  folio: string | null;
  efectivo: number | null;
  /** ¿La suma de las piezas de ESE ticket da su propio total? */
  cuadra_ticket: boolean | null;
  /** Lo contado por la Suite menos lo contado por Control. `null` = falta un lado. */
  diferencia: number | null;
}

export interface ArqueoDia {
  /** `YYYY-MM-DD`. */
  fecha: string;
  folio: string;
  estado: string;

  // ── Los seis términos de la fórmula ──────────────────────────────────────────────────────
  fondo: ArqueoFondo;
  ingresos: number | null;
  gastos: number | null;
  depositos: number | null;
  caos: ArqueoCaos | null;

  // ── El resultado ─────────────────────────────────────────────────────────────────────────
  /** El esperado **sellado**, congelado al cerrar. Es el que manda. */
  esperado: number | null;
  /**
   * El que sale de sumar los seis términos HOY. Se publica al lado del sellado a propósito: si
   * difieren, el desglose no explica el número que la pantalla está mostrando, y eso se dice en
   * vez de inventar un cuadre (ADR-056).
   */
  esperado_recompuesto: number | null;
  /** `false` = el desglose NO reproduce el esperado sellado. La pantalla tiene que declararlo. */
  desglose_explica: boolean;
  contado: number | null;
  morralla: number;
  diferencia: number | null;
  /**
   * ⛔ `esperado_imposible` es el que importa acá: un cajón no debe dinero. Con el esperado bajo
   * cero, `contado − esperado` sale positivo **siempre**, así que la diferencia diría «sobra»
   * justo cuando la cuenta está más rota. No es un sobrante: es una pierna mal cruzada.
   */
  veredicto: VeredictoCorte;

  // ── Quién, y la segunda llave ────────────────────────────────────────────────────────────
  cerro: string | null;
  closed_at: string | null;
  autorizo: string | null;
  authorized_at: string | null;
  autorizado: boolean;
  nota: string | null;
  reconteo_motivo: string | null;

  /** Lo que se contó, pieza por pieza. Vacío = el conteo no guardó desglose. */
  piezas: ArqueoPieza[];
  testigo_control: ArqueoTestigoControl | null;
}

/** `[CGA-A.48]` Un depósito a la caja fuerte que coincide con billetes que Control contó de más. */
export interface ArqueoDepositoEnCaos {
  id: string;
  dia: string;
  hora: string | null;
  total: number;
  ref: string | null;
}

/**
 * ⭐ `[CGA-A.48]` El ÚLTIMO conteo de Control contra el último cierre del libro, con lo que de la
 * diferencia está en la caja fuerte (CAOS) y no en el cajón. Caso que lo motivó: Control contó
 * $288,972.50 el 20-oct y 400 × $500 de eso eran el depósito «caja ahorro» que estaba en CAOS.
 *
 * ⚠️ `en_caos` es una COINCIDENCIA por denominación (todos los billetes del depósito caben en lo
 * que Control contó de más, y el depósito es anterior al conteo), no una prueba física.
 */
export interface ArqueoControlUltimo {
  folio: string | null;
  dia: string;
  hora: string | null;
  efectivo: number | null;
  /** El último cierre sellado del libro contra el que se compara. */
  libro_folio: string;
  libro_dia: string;
  libro_contado: number | null;
  /** Control − libro. `null` = falta un lado. */
  diferencia: number | null;
  en_caos: ArqueoDepositoEnCaos[];
  en_caos_total: number;
  /** `diferencia − en_caos_total`: lo que ningún depósito a CAOS explica. */
  sin_explicar: number | null;
}

export interface ArqueosResponse {
  rows: ArqueoDia[];
  /** `[CGA-A.48]` `null` = no hay conteo de Control o no hay cierre del libro con qué compararlo. */
  control_ultimo?: ArqueoControlUltimo | null;
  limit: number;
  fuente: string;
  frescura: Freshness | null;
  /** Lo que este endpoint NO puede afirmar, con nombre (ADR-056). */
  limites: string[];
}
