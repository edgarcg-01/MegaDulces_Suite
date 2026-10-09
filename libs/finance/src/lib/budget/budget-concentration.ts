/**
 * `[PU.VG.10]` LA CONCENTRACION: cuanto del gasto de un ejercicio puede mover Direccion, y cuanto no.
 *
 * -- Por que existe ----------------------------------------------------------
 * La pregunta de Direccion frente a un presupuesto es "?puedo recortar?", y la pantalla muestra 14
 * renglones que se ven todos iguales. Medido contra prod el 2026-10-09:
 *
 *     FY2027 -- 14 partidas / $74,850,066.62 -- SUELDOS Y SALARIOS solo = 55.50%
 *     FY2026 -- 12 partidas / $32,425,843.06 -- SUELDOS Y SALARIOS solo = 50.22%
 *
 * O sea que la respuesta honesta es "no rapido, y no sin tocar gente", y hoy no esta en ninguna
 * superficie. Esto la pone, sin proponer el recorte: decir "recorta SUELDOS" es una decision de
 * negocio con gente adentro, no una salida de funcion.
 *
 * -- ?Cuantas partidas hacen el 80%? La definicion importa ------------------
 * Se cuenta la partida que CRUZA el 80%, no la ultima que queda por debajo. En FY2027 las tres
 * primeras acumulan 79.46% -- tres partidas NO alcanzan el 80%, hacen falta cuatro (88.70%). La
 * lectura "cuantas caben enteras abajo de la linea" subdeclara en uno y es la que produce el
 * clasico fuera-por-uno; la que le sirve a Direccion es "cuantos renglones tengo que tocar para
 * mover el 80% del gasto". Medido con la definicion correcta: FY2027 = 4, FY2026 = 3.
 *
 * -- El agregado de dos ejercicios NO es un dato ----------------------------
 * Sumar FY2026 + FY2027 da "$107.3M, SUELDOS 53.90%": una cifra que no corresponde a ningun ano y
 * contra la que nadie puede firmar. Por eso esta funcion recibe las partidas de UN ejercicio y no
 * tiene manera de mezclarlos -- la restriccion vive en la forma del argumento, no en un comentario.
 *
 * -- Lo que este modulo NO hace ---------------------------------------------
 * No emite veredicto ni color. `analytics.kpi_thresholds` tiene CERO filas en todo el sistema
 * (medido 2026-10-09), asi que por ADR-076 cualquier semaforo seria `sin_meta` y pintarlo verde
 * seria el `cfg ? classify : 'ok'` que la Fase VP ya midio dando verde incondicional. Devuelve los
 * hechos y `umbral_registrado: false`, que es la ausencia con nombre.
 *
 * Tampoco inventa lo que falta capturar: `responsible` y `expense_class` estan en 0 de 26 filas, y
 * eso se DECLARA como cobertura -- no se rellena con "operativo" ni con el nombre de quien capturo.
 */

/** Una partida de gasto del ledger, tal como vive en `budget.budget_lines`. */
export interface PartidaRow {
  id?: unknown;
  concept: unknown;
  account_code?: unknown;
  original_amount: unknown;
  control_level?: unknown;
  responsible?: unknown;
  expense_class?: unknown;
}

export interface ConcentracionFila {
  id: string | null;
  concepto: string;
  account_code: string | null;
  /** NULL cuando la fila no trae un monto legible. Nunca 0 para decir "no se". */
  monto: number | null;
  /** Porcentaje del total del EJERCICIO. NULL si el total no es medible o la fila no tiene monto. */
  pct: number | null;
  acumulado: number | null;
  responsable: string | null;
  clase: string | null;
  freno: string | null;
}

export interface CoberturaConcentracion {
  partidas: number;
  /** Partidas cuyo `original_amount` no se pudo leer: entran a la lista, no al total. */
  sin_monto: number;
  con_responsable: number;
  con_clase: number;
  con_freno_duro: number;
}

export interface Concentracion {
  /** Suma de las partidas con monto legible. NULL si no hay ninguna. */
  total: number | null;
  filas: ConcentracionFila[];
  /** Minimo numero de partidas cuya suma ALCANZA el 80% del total. NULL si el total no es medible. */
  partidas_80: number | null;
  /** Porcentaje de la partida mas grande. Es el numero que contesta "?puedo recortar?". */
  pct_mayor: number | null;
  cobertura: CoberturaConcentracion;
  /** Siempre false hoy: no hay un solo umbral registrado en el sistema. */
  umbral_registrado: boolean;
}

/** Lee un numero sin convertir ausencia en cero: '' y null son NULL, no 0. */
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const pct2 = (n: number) => Math.round(n * 10000) / 10000;

function texto(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Concentracion del gasto de UN ejercicio.
 *
 * El orden es descendente por monto, con desempate por concepto para que dos corridas sobre los
 * mismos datos den la misma lista (un orden ambiguo vuelve irreproducible el acumulado). Las filas
 * sin monto legible van al final y NO participan del total ni del acumulado: sumarlas como cero
 * subdeclararia la concentracion justo en el renglon del que no sabemos nada.
 */
export function concentracionDeGasto(partidas: readonly PartidaRow[]): Concentracion {
  const conMonto: Array<{ row: PartidaRow; monto: number }> = [];
  let sinMonto = 0;

  for (const p of partidas) {
    const m = num(p.original_amount);
    if (m == null) { sinMonto++; continue; }
    conMonto.push({ row: p, monto: cents(m) });
  }

  conMonto.sort((a, b) =>
    b.monto - a.monto || String(a.row.concept ?? '').localeCompare(String(b.row.concept ?? '')));

  const suma = cents(conMonto.reduce((acc, x) => acc + x.monto, 0));
  // Un total <= 0 no permite dividir: el porcentaje se DECLARA ausente en vez de dibujar 0% o NaN.
  const total = conMonto.length > 0 && suma > 0 ? suma : null;

  const filas: ConcentracionFila[] = [];
  let acum = 0;
  let partidas80: number | null = total == null ? null : 0;
  let alcanzado = false;

  for (const x of conMonto) {
    acum = cents(acum + x.monto);
    const pct = total == null ? null : pct2((x.monto / total) * 100);
    const acumulado = total == null ? null : pct2((acum / total) * 100);
    // ⭐ La partida que CRUZA el 80% cuenta. Con `>` en vez de `>=` una distribucion que cae
    // exactamente en 80.00 pediria un renglon de mas.
    if (total != null && !alcanzado) {
      partidas80 = (partidas80 ?? 0) + 1;
      if (acumulado != null && acumulado >= 80) alcanzado = true;
    }
    filas.push({
      id: texto(x.row.id),
      concepto: String(x.row.concept ?? '').trim() || '(sin concepto)',
      account_code: texto(x.row.account_code),
      monto: x.monto,
      pct,
      acumulado,
      responsable: texto(x.row.responsible),
      clase: texto(x.row.expense_class),
      freno: texto(x.row.control_level),
    });
  }

  for (const p of partidas) {
    if (num(p.original_amount) != null) continue;
    filas.push({
      id: texto(p.id),
      concepto: String(p.concept ?? '').trim() || '(sin concepto)',
      account_code: texto(p.account_code),
      monto: null, pct: null, acumulado: null,
      responsable: texto(p.responsible),
      clase: texto(p.expense_class),
      freno: texto(p.control_level),
    });
  }

  return {
    total,
    filas,
    partidas_80: partidas80,
    pct_mayor: filas.length && filas[0].pct != null ? filas[0].pct : null,
    cobertura: {
      partidas: partidas.length,
      sin_monto: sinMonto,
      con_responsable: partidas.filter((p) => texto(p.responsible) != null).length,
      con_clase: partidas.filter((p) => texto(p.expense_class) != null).length,
      con_freno_duro: partidas.filter((p) => texto(p.control_level) === 'bloqueo').length,
    },
    umbral_registrado: false,
  };
}
