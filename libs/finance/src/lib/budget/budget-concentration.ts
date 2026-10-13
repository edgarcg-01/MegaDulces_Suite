/**
 * `[PU.VG.11]` LA CONCENTRACION: cuanto de un total esta en pocos renglones, y cuanto no.
 *
 * -- Por que existe ----------------------------------------------------------
 * La pregunta de Direccion frente a un presupuesto es "?puedo recortar?", y la pantalla mostraba
 * 14 renglones que se ven todos iguales. Medido contra prod el 2026-10-09:
 *
 *     GASTO   FY2027  14 partidas / $74,850,066.62  -- la mayor (SUELDOS) = 55.4954%, 4 cruzan el 80%
 *     INGRESO FY2027  33 partidas / $604,775,116.21 -- la mayor           = 20.32%,   9 cruzan el 80%
 *
 * Esa ASIMETRIA es el dato: el gasto esta concentrado y el ingreso no. O sea "no podes recortar
 * rapido, pero tampoco dependes de un cliente". Ninguna de las dos mitades lo decia.
 *
 * -- Por que es generico y no "de gasto" ------------------------------------
 * `[PU.VG.10]` nacio llamandose `concentracionDeGasto` y la sesion de Ventas llego al MISMO
 * primitivo por su cuenta, con otra forma. Dos implementaciones del mismo conteo es el defecto que
 * ADR-056 documenta en ocho bandejas de hallazgos distintas. Esto recibe filas con `concept` y
 * `original_amount` y no sabe de que son: sirve para gasto, para ingreso y para un canal.
 *
 * -- ?Cuantas filas hacen el 80%? La definicion importa ---------------------
 * Se cuenta la que CRUZA el umbral, no la ultima que queda por debajo. En el gasto de FY2027 las
 * tres primeras acumulan 79.46% -- tres NO alcanzan, hacen falta cuatro (88.70%). La lectura
 * "cuantas caben enteras abajo de la linea" subdeclara en uno, y es justo el renglon que habria
 * que tocar.
 *
 * -- ⛔ EL UNIVERSO ES PARTE DEL NUMERO, y por eso es un ARGUMENTO -----------
 * Las dos mitades del modulo cometieron la misma falta, espejada:
 *
 *   - este carril sumo FY2026+FY2027 y publico "38.72%", que no es de ningun ano fiscal;
 *   - la superficie de ingreso recorto a un canal y lo llamo "del plan": el 81.6% era de
 *     Mostrador (58.46% del ingreso); del PLAN esas cuatro entidades cargan 47.72%.
 *
 * Las dos son aritmeticamente correctas sobre un universo que la frase no nombra. Por eso el
 * universo entra por parametro y es una UNION DISCRIMINADA: no se puede construir un resultado sin
 * declarar si el conjunto esta completo o es un recorte, y de que es recorte. Un comentario que
 * pide nombrarlo se puede no leer; un tipo que no compila, no.
 *
 * -- Lo que este modulo NO hace ---------------------------------------------
 * No emite veredicto ni color. `analytics.kpi_thresholds` tiene CERO filas en todo el sistema
 * (medido 2026-10-09), asi que por ADR-076 cualquier semaforo seria `sin_meta`. Devuelve los
 * hechos y `umbral_registrado: false`.
 *
 * El 80% y el 5% de `menores` SON cortes de DESCRIPCION, no politicas: viajan en la salida
 * (`umbral_pct`, `umbral_menor_pct`) para que la frase pueda nombrarlos, y la frase los nombra.
 * Un corte que se usa y no se dice es indistinguible de una politica que nadie firmo.
 */

/** Una fila cualquiera con nombre e importe. No sabe si es gasto, ingreso o canal. */
export interface FilaConcentrable {
  id?: unknown;
  concept: unknown;
  account_code?: unknown;
  original_amount: unknown;
  control_level?: unknown;
  responsible?: unknown;
  expense_class?: unknown;
}

/** Retrocompatible con `[PU.VG.10]`: el gasto entra por acá. */
export type PartidaRow = FilaConcentrable;

/** El conjunto esta ENTERO: el porcentaje se lee contra todo lo que hay. */
export interface UniversoCompleto {
  nombre: string;
  completo: true;
}

/**
 * El conjunto es un RECORTE. `de` nombra el total mayor y `pct` dice que fraccion de el es este
 * recorte -- NULL si no se pudo medir, nunca 0. Sin esto, un recorte se lee como el todo: es
 * exactamente lo que pasaba con "el 81.6% del plan" siendo 81.6% de Mostrador.
 */
export interface UniversoRecorte {
  nombre: string;
  completo: false;
  de: string;
  pct: number | null;
}

export type Universo = UniversoCompleto | UniversoRecorte;

export interface ConcentracionFila {
  id: string | null;
  concepto: string;
  account_code: string | null;
  /** NULL cuando la fila no trae un monto legible. Nunca 0 para decir "no se". */
  monto: number | null;
  /** Porcentaje del total del UNIVERSO. NULL si el total no es medible o la fila no tiene monto. */
  pct: number | null;
  acumulado: number | null;
  responsable: string | null;
  clase: string | null;
  freno: string | null;
}

export interface CoberturaConcentracion {
  partidas: number;
  /** Filas cuyo importe no se pudo leer: entran a la lista, no al total. */
  sin_monto: number;
  con_responsable: number;
  con_clase: number;
  con_freno_duro: number;
}

/**
 * La frase INVERSA: las que NO mueven la aguja. Le dice a quien decide donde **no** mirar, que es
 * la mitad que ninguna tabla ordenada por importe contesta. Idea tomada de la superficie de
 * ingreso de la sesion de Ventas ("2 entidades aportan menos del 5% cada una").
 */
export interface MenoresConcentracion {
  /** Cuantas filas aportan menos de `umbral_menor_pct` CADA UNA. */
  filas: number;
  /** Lo que suman entre todas. NULL si no hay ninguna o no es medible. */
  monto: number | null;
  /** Lo que pesan juntas, en puntos del universo. */
  pct: number | null;
}

export interface Concentracion {
  universo: Universo;
  /** Suma de las filas con monto legible. NULL si no hay ninguna. */
  total: number | null;
  filas: ConcentracionFila[];
  /** Minimo de filas cuya suma ALCANZA `umbral_pct`. La que CRUZA, no la ultima de abajo. */
  partidas_80: number | null;
  /** El corte que define `partidas_80`. Viaja para que la frase pueda nombrarlo. */
  umbral_pct: number;
  /** Porcentaje de la fila mas grande: el numero que contesta "?puedo recortar?". */
  pct_mayor: number | null;
  menores: MenoresConcentracion;
  /** El corte de `menores`. Viaja por el mismo motivo que `umbral_pct`. */
  umbral_menor_pct: number;
  cobertura: CoberturaConcentracion;
  /** Siempre false hoy: no hay un solo umbral registrado en el sistema. */
  umbral_registrado: boolean;
}

export interface OpcionesConcentracion {
  /** Default 80. Es un corte de descripcion, no una politica. */
  umbralPct?: number;
  /** Default 5. Idem. */
  umbralMenorPct?: number;
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
 * Concentracion de un conjunto de filas dentro de UN universo declarado.
 *
 * El orden es descendente por monto, con desempate por concepto para que dos corridas sobre los
 * mismos datos den la misma lista (un orden ambiguo vuelve irreproducible el acumulado). Las filas
 * sin monto legible van al final y NO participan del total ni del acumulado: sumarlas como cero
 * subdeclararia la concentracion justo en el renglon del que no sabemos nada.
 */
export function concentracion(
  filas: readonly FilaConcentrable[],
  universo: Universo,
  opts: OpcionesConcentracion = {},
): Concentracion {
  const umbralPct = opts.umbralPct ?? 80;
  const umbralMenorPct = opts.umbralMenorPct ?? 5;

  const conMonto: Array<{ row: FilaConcentrable; monto: number }> = [];
  let sinMonto = 0;

  for (const p of filas) {
    const m = num(p.original_amount);
    if (m == null) { sinMonto++; continue; }
    conMonto.push({ row: p, monto: cents(m) });
  }

  conMonto.sort((a, b) =>
    b.monto - a.monto || String(a.row.concept ?? '').localeCompare(String(b.row.concept ?? '')));

  const suma = cents(conMonto.reduce((acc, x) => acc + x.monto, 0));
  // Un total <= 0 no permite dividir: el porcentaje se DECLARA ausente en vez de dibujar 0% o NaN.
  const total = conMonto.length > 0 && suma > 0 ? suma : null;

  const salida: ConcentracionFila[] = [];
  let acum = 0;
  let partidas80: number | null = total == null ? null : 0;
  let alcanzado = false;

  for (const x of conMonto) {
    acum = cents(acum + x.monto);
    const pct = total == null ? null : pct2((x.monto / total) * 100);
    const acumulado = total == null ? null : pct2((acum / total) * 100);
    // ⭐ La fila que CRUZA el umbral cuenta. Con `>` en vez de `>=` una distribucion que cae
    // exactamente en 80.00 pediria un renglon de mas.
    if (total != null && !alcanzado) {
      partidas80 = (partidas80 ?? 0) + 1;
      if (acumulado != null && acumulado >= umbralPct) alcanzado = true;
    }
    salida.push({
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

  for (const p of filas) {
    if (num(p.original_amount) != null) continue;
    salida.push({
      id: texto(p.id),
      concepto: String(p.concept ?? '').trim() || '(sin concepto)',
      account_code: texto(p.account_code),
      monto: null, pct: null, acumulado: null,
      responsable: texto(p.responsible),
      clase: texto(p.expense_class),
      freno: texto(p.control_level),
    });
  }

  // Las que no mueven la aguja. Se miden sobre las que TIENEN monto: una fila sin importe no se
  // puede llamar "chica" -- no se sabe cuanto es.
  const chicas = salida.filter((f) => f.pct != null && f.pct < umbralMenorPct);
  const montoChicas = chicas.reduce((a, f) => a + (f.monto ?? 0), 0);

  return {
    universo,
    total,
    filas: salida,
    partidas_80: partidas80,
    umbral_pct: umbralPct,
    pct_mayor: salida.length && salida[0].pct != null ? salida[0].pct : null,
    menores: {
      filas: chicas.length,
      monto: chicas.length ? cents(montoChicas) : null,
      pct: chicas.length && total != null ? pct2((montoChicas / total) * 100) : null,
    },
    umbral_menor_pct: umbralMenorPct,
    cobertura: {
      partidas: filas.length,
      sin_monto: sinMonto,
      con_responsable: filas.filter((p) => texto(p.responsible) != null).length,
      con_clase: filas.filter((p) => texto(p.expense_class) != null).length,
      con_freno_duro: filas.filter((p) => texto(p.control_level) === 'bloqueo').length,
    },
    umbral_registrado: false,
  };
}

/**
 * ⭐ LA GRAMATICA DE LA FRASE, compartida entre las dos mitades del modulo.
 *
 * Existe para que `/presupuestos` no diga la misma cosa de dos maneras: hoy la mitad de gasto
 * PREGUNTA ("?cuanto se puede mover?") y la de ingreso CONTESTA, y las dos cuentan la misma idea.
 * Acá la frase se arma una vez, nombra SIEMPRE el universo, y cuando no se puede decir nada lo
 * dice en el titular en vez de dejar un bloque vacio (que se lee como "todo bien").
 */
export interface FraseConcentracion {
  /** El titular. Contesta o declara que no se puede contestar; nunca pregunta. */
  titular: string;
  /** La linea de apoyo. NULL cuando no hay nada que apoyar. */
  detalle: string | null;
  /** La frase inversa: donde NO mirar. NULL si no hay filas chicas. */
  inversa: string | null;
  /** `true` cuando el titular es una ausencia declarada y no un hecho. */
  es_ausencia: boolean;
}

const pctTxt = (n: number) => `${(Math.round(n * 100) / 100).toFixed(2)} %`;

/**
 * `de` + `el` = `del`. Parece cosmetico y no lo es: esta frase se PUBLICA, y "el 80 % de el gasto
 * de 2027" delata que la armo una plantilla concatenando. Un tablero que escribe mal se lee como
 * un tablero que calcula mal.
 */
function deX(nombre: string): string {
  return /^el\s/i.test(nombre) ? `del ${nombre.slice(3)}` : `de ${nombre}`;
}

export function fraseConcentracion(c: Concentracion): FraseConcentracion {
  const u = c.universo.nombre;

  if (c.total == null || c.partidas_80 == null) {
    return {
      titular: `Todavía no se puede decir qué parte ${deX(u)} se puede mover.`,
      detalle: c.cobertura.partidas === 0
        ? 'No hay renglones cargados.'
        : `Hay ${c.cobertura.partidas} renglones y ninguno con un importe que se pueda sumar.`,
      inversa: null,
      es_ausencia: true,
    };
  }

  const recorte = c.universo.completo === false
    ? ` Ojo: ${u} es ${c.universo.pct == null ? 'una parte no medida' : pctTxt(c.universo.pct)} ${deX(c.universo.de)}.`
    : '';

  const titular = c.partidas_80 === 1
    ? `Un solo renglón decide ${u}.`
    : `${c.partidas_80} de ${c.cobertura.partidas} renglones deciden el ${c.umbral_pct} % ${deX(u)}.`;

  const detalle = c.pct_mayor == null ? null
    : `El mayor solo es el ${pctTxt(c.pct_mayor)}.${recorte}`;

  const inversa = c.menores.filas === 0 ? null
    : `${c.menores.filas} ${c.menores.filas === 1 ? 'renglon aporta' : 'renglones aportan'} menos del `
      + `${c.umbral_menor_pct} % cada uno${c.menores.pct == null ? '' : ` (${pctTxt(c.menores.pct)} entre todos)`}: `
      + 'no mueven el total.';

  return { titular, detalle, inversa, es_ausencia: false };
}
