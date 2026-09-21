/**
 * CG.15 — Aritmética del corte de caja, en funciones PURAS (ADR-070).
 *
 * El corte es el momento en que alguien dice "esto es lo que hay". Si la cuenta que produce
 * ese número vive enredada con los SELECT, no se puede auditar sin levantar una base. Acá
 * está sola, con sus casos, y el servicio sólo le pasa filas.
 *
 * ⚠️ **CORREGIDO (CG.19).** Acá decía que "la misma cuenta la hace la DB
 * (`cut_cerrado_completo_chk`)". **Es falso**: ese CHECK sólo exige que `esperado`, `contado` y
 * `diferencia` NO sean NULL — no verifica ninguna aritmética. **Esta función es la única llave que
 * existe**, no una de dos. Afirmar un candado que no está es peor que no tenerlo: invita a confiar.
 *
 * ⛔ **Y decía que la pantalla debe mostrar la diferencia "mientras cuenta". Eso se revierte.**
 * Era un requisito explícito, no un descuido, así que queda escrito por qué cambió: ver la
 * diferencia converger a cero mientras se teclea convierte el arqueo en una transcripción del
 * esperado. El conteo pasa a ser CIEGO (CG.19 Capa 1) — se cuenta sin ver, y se revela al guardar.
 *
 * ⚠️ **Y hay un defecto de FONDO que esta función sola no puede arreglar** (CG.19): el `esperado`
 * se deriva de los movimientos que un HUMANO capturó, así que si alguien no captura una entrega,
 * el esperado baja junto con el contado y el corte **cuadra perfecto**. Un número que audita a una
 * persona no puede calcularse con lo que esa persona tecleó (regla M4).
 *
 * ⛔ **CG.19 Capa 1 — REFUTADO, con medición: el `esperado` NO puede salir de
 * `analytics.customer_receivables.saldo_ajustado`**, como decía el plan aprobado. El saldo de la
 * cartera mide **lo que la ruta DEBE**, o sea exactamente la parte que **no** se volvió efectivo:
 * los 1,504 documentos con estatus `EFECTIVO` suman **$85,951,094.54 de importe** contra
 * **$915.00 de saldo**. Y para los clientes de ruta (`RD028`, `RV002`, …) el `saldo_ajustado`
 * viene en **0 o NULL**. Peor: las dos cifras se mueven en **direcciones opuestas** — mientras más
 * cobra la ruta, más efectivo hay en el cajón y más BAJA el saldo. Como `esperado`, mediría al revés.
 *
 * ✅ **Lo que sí ancla el ingreso: `analytics.erp_collections` con `tipo_cuenta = 'ruta'`** — el
 * COBRO registrado en Kepler, con su `monto` y su llave `(sucursal, folio)`, que está **medida**
 * como identidad real (2,708 llaves para 2,708 filas). Ahí el valor se **toma** de Kepler en vez
 * de recapturarse, y el documento existe **antes** de que el efectivo se mueva: es el orden que
 * esta fase viene a invertir.
 *
 * ⚠️ **Y no alcanza para todo, medido:** los cobros de ruta son ~55-60% del ingreso de la caja
 * general (ene-2026: $5.38M contra $9.95M; jul-2026: $6.07M contra $10.45M). El resto —préstamos,
 * pagarés, directivos, venta de piso— sigue siendo captura humana. Por eso esta función **no
 * finge** que el esperado ya es de Kepler: reporta `cobertura_ingreso`, que es qué proporción del
 * ingreso descansa en un hecho del ERP y no en un teclado. Un corte con cobertura 0.58 y otro con
 * 1.00 no pueden leerse igual.
 */

export type TipoMovimiento = 'ingreso' | 'gasto' | 'deposito';

export interface MovimientoDelCorte {
  tipo: TipoMovimiento;
  monto: number;
  /** Un movimiento cancelado NO entra al corte, pero sigue existiendo (se audita que se canceló). */
  estado?: string;
  /**
   * CG.19 Capa 1 — ¿este movimiento está atado a un hecho de Kepler (`origen_tipo`/`origen_ref`)
   * o lo tecleó una persona? No cambia la aritmética: **cambia cuánto vale el resultado.**
   * Ver `cobertura_ingreso`.
   */
  anclado?: boolean;
}

export interface ConteoDenominacion { denominacion: number; piezas: number }

export interface TotalesCorte {
  ingresos: number;
  gastos: number;
  depositos: number;
  /** fondo_inicial + ingresos − gastos − depósitos: lo que DEBERÍA haber en la caja. */
  esperado: number;
  /** Σ(denominación × piezas) + morralla: lo que la persona contó. */
  contado: number;
  /** contado − esperado. Positivo SOBRA, negativo FALTA. */
  diferencia: number;
  /** `cuadra` sólo si |diferencia| ≤ 1 centavo. `sin_contar` NO es `cuadra`. */
  veredicto: 'cuadra' | 'sobra' | 'falta' | 'sin_contar';
  /** Cuántos movimientos entraron y cuántos se ignoraron por estar cancelados. */
  movimientos: number;
  cancelados: number;

  // ── CG.19 Capa 1: de qué está hecho el `esperado` ──────────────────────────────────────────
  /** Σ de ingresos atados a un hecho de Kepler. El monto NO salió de un teclado. */
  ingresos_anclados: number;
  /** Σ de ingresos que alguien tecleó. Es la parte del `esperado` que no se puede auditar sola. */
  ingresos_capturados: number;
  /**
   * `ingresos_anclados / ingresos totales`, 0..1. **`null` si no hubo ingresos** — no 0:
   * "no se pudo medir" y "nada anclado" son cosas distintas (ADR-056), y un corte sin ingresos
   * no tiene cobertura buena ni mala, no tiene cobertura.
   */
  cobertura_ingreso: number | null;
}

/** Tolerancia del cuadre: un centavo, por el redondeo de numeric. */
export const CORTE_EPSILON = 0.005;

export function redondea(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * La cuenta completa del corte. Devuelve TODO lo que hace falta para defender el número:
 * los tres totales, el esperado, el contado, la diferencia y el veredicto.
 *
 * ⚠️ `sin_contar` es un veredicto propio a propósito. Si un corte sin conteo devolviera
 * `cuadra` (diferencia 0 contra 0), un día que nadie contó se vería igual que un día que
 * cuadró al centavo — que es exactamente la clase de mentira que esta fase existe para matar.
 */
export function calcularCorte(input: {
  fondoInicial: number;
  movimientos: MovimientoDelCorte[];
  conteo?: ConteoDenominacion[] | null;
  morralla?: number;
}): TotalesCorte {
  const vivos = (input.movimientos ?? []).filter((m) => m && m.estado !== 'cancelado');
  const cancelados = (input.movimientos ?? []).length - vivos.length;

  const suma = (t: TipoMovimiento) =>
    redondea(vivos.filter((m) => m.tipo === t).reduce((a, m) => a + Number(m.monto || 0), 0));

  const ingresos = suma('ingreso');
  const gastos = suma('gasto');
  const depositos = suma('deposito');
  const esperado = redondea(Number(input.fondoInicial || 0) + ingresos - gastos - depositos);

  // De qué está hecho ese `esperado`. La aritmética no cambia; lo que cambia es que el corte
  // ahora DICE qué parte descansa en lo que alguien tecleó (ver el defecto de fondo, arriba).
  const sumaIngreso = (pred: (m: MovimientoDelCorte) => boolean) =>
    redondea(vivos.filter((m) => m.tipo === 'ingreso' && pred(m)).reduce((a, m) => a + Number(m.monto || 0), 0));
  const ingresos_anclados = sumaIngreso((m) => m.anclado === true);
  const ingresos_capturados = sumaIngreso((m) => m.anclado !== true);
  const cobertura_ingreso = ingresos > 0 ? Math.round((ingresos_anclados / ingresos) * 10000) / 10000 : null;

  const piezas = (input.conteo ?? []).filter((d) => d && Number(d.piezas) > 0);
  const morralla = Number(input.morralla || 0);
  const huboConteo = piezas.length > 0 || morralla > 0;
  const contado = redondea(piezas.reduce((a, d) => a + Number(d.denominacion) * Number(d.piezas), 0) + morralla);
  const diferencia = redondea(contado - esperado);

  let veredicto: TotalesCorte['veredicto'];
  if (!huboConteo) veredicto = 'sin_contar';
  else if (Math.abs(diferencia) <= CORTE_EPSILON) veredicto = 'cuadra';
  else veredicto = diferencia > 0 ? 'sobra' : 'falta';

  return {
    ingresos, gastos, depositos, esperado,
    contado: huboConteo ? contado : 0,
    diferencia: huboConteo ? diferencia : 0,
    veredicto, movimientos: vivos.length, cancelados,
    ingresos_anclados, ingresos_capturados, cobertura_ingreso,
  };
}

export interface CorteEstado {
  estado: 'borrador' | 'cerrado' | 'autorizado';
  closed_by?: string | null;
  authorized_by?: string | null;
}

export type MotivoNoAutoriza =
  | 'no_esta_cerrado'
  | 'ya_autorizado'
  | 'misma_persona_que_cerro'
  | 'sin_usuario';

export const TEXTO_NO_AUTORIZA: Record<MotivoNoAutoriza, string> = {
  no_esta_cerrado: 'El corte todavía no se cierra.',
  ya_autorizado: 'Este corte ya está autorizado.',
  misma_persona_que_cerro: 'Quien cerró el corte no puede autorizarlo: tiene que hacerlo otra persona.',
  sin_usuario: 'No se pudo identificar quién autoriza.',
};

/**
 * ⛔ LA DOBLE LLAVE, del lado del código. La DB ya lo impide con un CHECK; esto existe para
 * que el botón se apague con su motivo en vez de que el usuario descubra el candado con un
 * error de Postgres.
 */
export function puedeAutorizar(c: CorteEstado, userId: string | null | undefined): { ok: boolean; motivo?: MotivoNoAutoriza } {
  if (!userId) return { ok: false, motivo: 'sin_usuario' };
  if (c.estado === 'autorizado') return { ok: false, motivo: 'ya_autorizado' };
  if (c.estado !== 'cerrado') return { ok: false, motivo: 'no_esta_cerrado' };
  if (c.closed_by && c.closed_by === userId) return { ok: false, motivo: 'misma_persona_que_cerro' };
  return { ok: true };
}

export type MotivoNoCierra = 'no_es_borrador' | 'sin_conteo' | 'sin_usuario';

export const TEXTO_NO_CIERRA: Record<MotivoNoCierra, string> = {
  no_es_borrador: 'Este corte ya está cerrado.',
  sin_conteo: 'Contá el efectivo antes de cerrar: un corte sin conteo no cuadra nada.',
  sin_usuario: 'No se pudo identificar quién cierra.',
};

export function puedeCerrar(
  c: CorteEstado, userId: string | null | undefined, totales: TotalesCorte,
): { ok: boolean; motivo?: MotivoNoCierra } {
  if (!userId) return { ok: false, motivo: 'sin_usuario' };
  if (c.estado !== 'borrador') return { ok: false, motivo: 'no_es_borrador' };
  // Cerrar sin contar es firmar un papel en blanco.
  if (totales.veredicto === 'sin_contar') return { ok: false, motivo: 'sin_conteo' };
  return { ok: true };
}

/** Motivo de cancelación: mismo piso que el CHECK de la DB, para avisar antes del 400. */
export const CANCEL_MOTIVO_MIN = 5;

export function motivoCancelacionValido(motivo: string | null | undefined): boolean {
  return !!motivo && motivo.trim().length >= CANCEL_MOTIVO_MIN;
}

/**
 * ⛔ Un movimiento que ya entró a un corte CERRADO no se cancela: movería un cuadre que
 * alguien ya firmó. Lo que corresponde es un movimiento nuevo que lo corrija.
 */
export function puedeCancelarse(m: { estado?: string; corte_id?: string | null }, estadoDelCorte?: string | null): boolean {
  if (m.estado === 'cancelado') return false;
  if (m.corte_id && estadoDelCorte && estadoDelCorte !== 'borrador') return false;
  return true;
}

// ── CG.19 Capa 1b — EL ARQUEO CIEGO ───────────────────────────────────────────────────────────
//
// Se cuenta SIN ver el esperado, y se revela al guardar. Ver el esperado mientras se teclea
// convierte el arqueo en una transcripción: el que cuenta ajusta hasta que la diferencia dé cero.
//
// ⭐ **Y esto recién ahora sirve de algo.** Antes de la Capa 1, esconder el esperado era teatro:
// los dos números —el esperado y el contado— salían de la misma persona, así que taparle uno no
// le quitaba información. Con el ingreso anclado a un cobro de Kepler, el esperado es un hecho
// ajeno al que cuenta, y taparlo vuelve el conteo una medición independiente de verdad.
//
// ⚠️ **Antes de calcar esto se midió por qué el arqueo ciego que ya existe casi no se usa**
// (`reconciliation.blind_counts`, SM.8): tiene **5 filas en total**, todas del 27-ago al 02-sep —
// la ventana en que se construyó— y nada después. La causa NO es el software: de los **32 cajeros,
// sólo 8 se han logueado alguna vez, 7 en 30 días y CERO en los últimos 7**. El mecanismo estaba
// bien; la población no entra al sistema.
//
// El riesgo NO se traslada igual acá: la caja general la captura gente de oficina
// (`FINANCE_CAJA_GESTIONAR` → tesorería, finanzas_operativo, crédito y cobranza), que sí usa la
// plataforma. Pero son **pocas personas** (1 de tesorería, 3 activos de finanzas_operativo), así
// que el éxito de esta capa se mide con uso real, no con que compile.

/** Lo que se le oculta a quien cuenta. `diferencia` se va CON `esperado`: publicar uno es publicar los dos. */
export type TotalesCiegos = Omit<TotalesCorte, 'esperado' | 'diferencia' | 'veredicto'> & {
  /** Se dice que hay algo oculto. Un campo ausente y un campo en 0 no pueden confundirse. */
  oculto: true;
  /** `sin_contar` sí viaja: no revela nada y la pantalla necesita saber si ya hay conteo. */
  conto: boolean;
};

/**
 * Quita del corte todo lo que permita deducir el esperado.
 *
 * ⛔ `diferencia` sale junto con `esperado` **a propósito**: `esperado = contado − diferencia`,
 * así que publicar la diferencia es publicar el esperado con un paso de aritmética. Es la misma
 * regla que ya está escrita en `store-arqueo.controller.ts` (`proyectar`), y la razón de que
 * `veredicto` también se vaya: "sobra"/"falta" es el signo de la diferencia.
 */
export function proyectarCiego(t: TotalesCorte, revela: boolean): TotalesCorte | TotalesCiegos {
  if (revela) return t;
  const { esperado: _e, diferencia: _d, veredicto, ...ciego } = t;
  return { ...ciego, oculto: true, conto: veredicto !== 'sin_contar' };
}

export type MotivoNoRecuenta = 'no_es_borrador' | 'ya_reconto' | 'sin_motivo' | 'no_hay_diferencia';

export const TEXTO_NO_RECUENTA: Record<MotivoNoRecuenta, string> = {
  no_es_borrador: 'El corte ya está cerrado: para corregirlo hace falta un movimiento nuevo, no un reconteo.',
  ya_reconto: 'Ya se recontó una vez. El segundo conteo es el que vale; si sigue sin cuadrar, eso es el hallazgo.',
  sin_motivo: 'Decí por qué se vuelve a contar, con al menos 5 caracteres. Un reconteo sin razón no se distingue de un ajuste.',
  no_hay_diferencia: 'El conteo cuadró: no hay nada que recontar.',
};

/**
 * ¿Se puede volver a contar? **Una sola vez, con motivo, y el primer conteo NO se borra.**
 *
 * Un reconteo ilimitado es un ajuste con otro nombre: se cuenta hasta que dé. Uno solo, guardado
 * junto al primero y con su razón escrita, deja ver exactamente lo que pasó — que es el punto.
 */
export function puedeRecontar(
  c: { estado: string; conteo_previo?: unknown | null },
  totales: TotalesCorte,
  motivo: string | null | undefined,
): { ok: boolean; motivo?: MotivoNoRecuenta } {
  if (c.estado !== 'borrador') return { ok: false, motivo: 'no_es_borrador' };
  if (c.conteo_previo != null) return { ok: false, motivo: 'ya_reconto' };
  if (totales.veredicto === 'cuadra') return { ok: false, motivo: 'no_hay_diferencia' };
  if (!motivo || motivo.trim().length < CANCEL_MOTIVO_MIN) return { ok: false, motivo: 'sin_motivo' };
  return { ok: true };
}

/** Folio del corte. El consecutivo lo da Postgres; acá sólo se le da forma. */
export function buildFolioCorte(year: number, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`consecutivo inválido: ${seq}`);
  return `CC-${year}-${String(seq).padStart(5, '0')}`;
}
