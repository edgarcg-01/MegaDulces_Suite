/**
 * CG.20 — **Confirmar en lote y capturar por frecuencia**, en funciones PURAS (ADR-070).
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 *
 * Medido contra la réplica cruda del Control (`md:5433/caja_general`, 30 días):
 *
 *   · **338 de 374 ingresos (90 %) YA existen como cobro en Kepler** — $5,336,935 de $6,508,337,
 *     el **82 % del dinero**. La persona teclea algo que el sistema ya sabe.
 *   · **El registro va 4.7 días detrás del dinero** (673 movimientos que llevan la fecha del hecho
 *     en el texto); sólo el **11 %** se captura el mismo día, el peor caso son **34 días**.
 *   · Del lado del gasto, **562 de 978 (57 %)** repiten el mismo par (cuenta, concepto).
 *
 * De ahí salen las dos mitades de este motor: el ingreso se **confirma** (no se teclea) y el gasto
 * se **repite** (no se reescribe).
 *
 * ⛔ **Lo que este archivo NO hace, y es deliberado: casar por importe.** Se intentó y se midió:
 * cruzar el ingreso de caja contra la VENTA de la ruta acierta el **14 %**, porque la ruta entrega
 * lo COBRADO en efectivo y su venta trae crédito y tarjeta. Contra el **cobro** acierta el 90 %.
 * Pero ni siquiera hace falta casar: la fila de caja se **crea desde** el cobro, con `origen_ref`
 * explícito. (Los **155 cruces ambiguos** que se midieron son una propiedad del pasado — dos
 * sistemas capturados por separado — no de este diseño.)
 *
 * ── CG.21: el egreso entra por la misma puerta ────────────────────────────────────────────────
 *
 * 🔴 **La frase de arriba "el gasto se repite (no se reescribe)" era la respuesta a una pregunta
 * mal hecha.** CG.20 declaró que el gasto "no está en Kepler"; está entero, y el discriminante es
 * `kdm1.c45`, la cuenta por la que salió el dinero, que `kdb1` nombra `0011 CAJA GENERAL /
 * EFECTIVO`. Cobertura medida sobre 5 meses cerrados: **$44,108,221.92 en la caja del Control vs
 * $44,123,427.09 en Kepler = 100 %, Δ 0.03 %**. El gasto también se **confirma**; los frecuentes
 * quedan para el 8 % que no tiene documento.
 *
 * ⛔ Y el control negativo que justifica no casar nunca: el mismo cruce por importe contra una
 * ventana placebo desplazada 180 días acierta **23-34 %**. Un tercio de cualquier "match" por
 * monto es densidad, no verdad.
 */

/** Tolerancia del cuadre: un centavo, la misma que el arqueo y el corte. */
export const LOTE_EPSILON = 0.005;

/*
 * ⭐ `CAJA_VENTANA_DIAS` (cuántos días atrás siguen siendo TRABAJO) **NO vive acá**: vive en
 * `@megadulces/contracts` (`work/caja-window.contract.ts`), porque lo consumen esta librería y
 * `libs/trade` —la bandeja de «Mi trabajo»— y no se pueden importar entre sí. Escribirlo dos veces
 * haría que la pantalla y el tablero contaran colas distintas sin que nadie lo notara.
 */

export type MotivoNoConfirmable =
  | 'sin_mapa'        // la ruta no está en `finance.route_customer_map`
  | 'sin_confirmar'   // hay propuesta, pero ningún humano la firmó
  | 'sin_cuenta'      // firmada la identidad, pero sin cuenta contable declarada
  | 'sin_monto'       // el documento del ERP no trae importe utilizable
  | 'sin_regla'       // CG.21 · egreso: ninguna regla de `finance.caja_classify_rules` aplica
  | 'fecha_futura';   // el documento viene fechado DESPUÉS de hoy → su fecha es un error del ERP

export const TEXTO_NO_CONFIRMABLE: Record<MotivoNoConfirmable, string> = {
  sin_mapa: 'Esta ruta todavía no está declarada. Se captura a mano hasta que alguien la dé de alta.',
  sin_confirmar: 'La identidad de esta ruta es una propuesta sin firmar. Confirmala antes de aplicarle dinero.',
  sin_cuenta: 'Falta declarar con qué cuenta contable entra esta ruta.',
  sin_monto: 'El documento del ERP no trae importe: no hay nada que confirmar.',
  sin_regla: 'Nadie declaró con qué cuenta contable se registra este beneficiario. Se captura a mano.',
  fecha_futura: 'Este documento viene fechado después de hoy: su fecha es un error de captura del ERP. '
    + 'Capturalo a mano y corregí la fecha, o el movimiento se va a registrar en un mes que todavía no llegó.',
};

/**
 * ⛔ ¿La fecha del documento cae DESPUÉS de hoy? Entonces no se confirma en lote.
 *
 * No es una preferencia de estilo: está MEDIDO. El 2026-09-22 se contaron **8 documentos** del ERP
 * con `fecha_valor` futura, y los seis de `X-D-26` dicen en su propio concepto *"28-01-2026"*,
 * *"30-01-2026"*, *"21-01"* — son gastos de **enero** que Kepler fechó en **diciembre**.
 *
 * La pantalla ya los rotulaba con un aviso desde ese día, y el aviso **no alcanzó**: el
 * 2026-09-28 se confirmó `X-D-26 0001298` y entró al libro como `CG-2026-00002` con
 * `fecha = 2026-12-10`. Consecuencia medida: el filtro por default del libro (del 1º del mes a
 * hoy) mostraba **1 movimiento de los 2 que había** — la mitad del libro invisible hasta
 * diciembre. Un aviso que no frena es decoración (ADR-056).
 *
 * Por qué acá y no en un CHECK de la tabla: `current_date` es STABLE, no IMMUTABLE, y Postgres no
 * admite funciones no inmutables en un CHECK. Y aunque lo admitiera, un CHECK dejaría sin registrar
 * un depósito post-fechado legítimo sin forma de explicarlo; acá el motivo viaja con la fila.
 *
 * ⚠️ Compara texto `YYYY-MM-DD` contra texto `YYYY-MM-DD` a propósito: sin objetos `Date` no hay
 * husos que corrijan de más. `hoy` lo pone el llamador (día de México), para que la prueba pueda
 * fijarlo y no dependa del reloj.
 */
export function esFechaFutura(fecha: string | Date | null | undefined, hoy: string): boolean {
  if (!fecha || !hoy) return false;
  const f = fecha instanceof Date ? toYmd(fecha) : String(fecha).slice(0, 10);
  return f.length === 10 && f > String(hoy).slice(0, 10);
}

/** `YYYY-MM-DD` de un `Date`, en sus propios componentes locales (sin `toISOString`, que corre el día). */
function toYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Lo que la ruta tiene declarado. `null` = no existe fila en el mapa. */
export interface MapaRuta {
  cliente_code: string | null;
  confirmed_at: string | Date | null;
  kepler_cuenta: string | null;
  kepler_concepto: string | null;
}

export interface EntregaPendiente {
  origen_ref: string;
  cliente_code: string | null;
  monto: number;
}

export type Confirmable =
  | { ok: true; kepler_cuenta: string; kepler_concepto: string }
  | { ok: false; motivo: MotivoNoConfirmable };

/**
 * ¿Se puede confirmar esta entrega **sin que nadie elija nada**?
 *
 * ⛔ Los cuatro motivos se separan a propósito. Un solo `false` dejaría a la persona sin saber si
 * el problema lo arregla ella (confirmar el mapa) o no (la ruta no existe todavía). Y mientras
 * cualquiera de ellos esté, la entrega **cae a captura manual** — nunca a una cuenta adivinada.
 */
export function esConfirmable(e: EntregaPendiente, mapa: MapaRuta | null | undefined): Confirmable {
  if (!mapa) return { ok: false, motivo: 'sin_mapa' };
  if (!mapa.confirmed_at || !mapa.cliente_code) return { ok: false, motivo: 'sin_confirmar' };
  if (!mapa.kepler_cuenta || !mapa.kepler_concepto) return { ok: false, motivo: 'sin_cuenta' };
  if (!(Number(e.monto) > 0)) return { ok: false, motivo: 'sin_monto' };
  return { ok: true, kepler_cuenta: mapa.kepler_cuenta, kepler_concepto: mapa.kepler_concepto };
}

// ── CG.21 · Egreso: la cuenta sale de una regla declarada, o no sale ──────────────────────────

/** Una fila viva de `finance.caja_classify_rules`. */
export interface ReglaGasto {
  id?: string;
  priority: number;
  match_tipo: string | null;
  match_glosa: string | null;
  match_beneficiario: string | null;
  kepler_cuenta: string;
  kepler_concepto: string;
  /**
   * `[CG.27-B.0]` La vida de la regla viaja EN LA REGLA, no sólo en el `WHERE` del SELECT.
   *
   * `reglasDeGasto()` ya filtra `active` y `suppressed_at` en SQL, así que en producción una
   * regla apagada nunca llegaba acá. Pero el motor también lo usan las pruebas, la
   * previsualización de un sembrado y ahora el autofill — y ahí sí llegaban. La prueba de
   * paridad lo destapó: una regla `active:false` **seguía clasificando** por este camino.
   * Opcionales porque el SELECT no siempre las trae; ausente = viva.
   */
  active?: boolean | null;
  suppressed_at?: Date | string | null;
}

export interface MovimientoAClasificar {
  tipo: string;
  glosa?: string | null;
  beneficiario?: string | null;
  monto: number;
}

/** Tope de tamaño del patrón y del texto. Un regex de la DB corre en NUESTRO proceso. */
export const REGLA_MAX_PATRON = 200;
export const REGLA_MAX_TEXTO = 400;

/**
 * Aplica un patrón guardado en la base contra un texto.
 *
 * ⚠️ El patrón lo escribe una persona en `/finanzas/caja` y se evalúa **en JS, nunca en SQL** —
 * `knex.raw` se come los `?` y un cuantificador en un regex ya costó una columna entera
 * (`20260819220000`). Acá el patrón viaja como dato y nunca toca el SQL.
 *
 * ⚠️ Un regex de la base corre en nuestro proceso: un patrón con anidamiento patológico puede
 * colgar el event loop (ReDoS). No hay forma de ponerle timeout sin sacarlo a un worker, así que
 * se acota lo que sí se puede — **el largo del patrón y el del texto** — y un patrón inválido
 * **no aplica** en vez de reventar la clasificación entera.
 */
export function aplicaPatron(patron: string | null | undefined, texto: string | null | undefined): boolean {
  if (!patron) return true;                       // sin matcher = comodín para ESE eje
  if (patron.length > REGLA_MAX_PATRON) return false;
  const t = String(texto ?? '').slice(0, REGLA_MAX_TEXTO);
  if (!t) return false;
  let re: RegExp;
  try {
    re = new RegExp(patron, 'i');
  } catch {
    return false;                                 // patrón inválido: no aplica, no rompe
  }
  if (re.test(t)) return true;
  // `[CG.27-B.0]` Segundo intento contra el texto NORMALIZADO, y es lo que cierra la divergencia
  // entre los dos motores. El autofill normalizaba el texto de entrada y **no el patrón**, así que
  // una regla declarada con acento o espacio doble matcheaba en la bandeja y no en el autofill.
  //
  // ⚠️ Se prueba el crudo PRIMERO y el normalizado después: así esto sólo puede AGREGAR matches,
  // nunca quitar uno que hoy funciona. Y no se normaliza el patrón — plegarle los acentos a un
  // regex puede romperle una clase de caracteres, y el patrón lo escribe una persona.
  const n = normalizaTexto(t);
  return n !== t && re.test(n);
}

/**
 * `[CG.27-B.0]` Normaliza un texto para comparar: mayúsculas, sin acentos, espacios colapsados.
 *
 * Vive acá y no en `caja-autofill.engine.ts` porque ahora la usan LOS DOS motores, y este archivo
 * no importa nada (el otro sí puede importar de éste sin ciclo). El autofill la reexporta con su
 * nombre viejo para no tocar a sus consumidores.
 */
export function normalizaTexto(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `[CG.27-B.3]` Días sin cobrar a partir de los cuales un recurrente cuenta como **caído**.
 *
 * 21 y no 30: medido entre días distintos, la cadencia de TODOS los recurrentes tiene mediana de
 * **2 a 5 días** y el hueco máximo observado ronda los 13-17. A los 21 ya no es un puente ni una
 * quincena: es que dejó de cobrar. Con 30 se perderían los 11 que hoy están caídos.
 */
export const CAIDO_DIAS = 21;

/**
 * `[CG.27-B.1]` Coeficiente de variación del importe (σ/μ), a dos decimales.
 *
 * ⭐ Es lo ÚNICO que discrimina para decidir qué se le puede proponer a un beneficiario. La
 * cadencia no sirve —medida bien, la mediana es 2-5 días para todos— pero el CV parte el
 * universo limpio: `CAPITAN DE MARCA` 0.36 y `BOTANAS PAU` 0.43 contra `GASTOS GENERALES OFICINAS`
 * **4.39**. Con CV bajo el importe se puede proponer; con CV alto, la cuenta sí y el monto jamás.
 *
 * ⚠️ Devuelve `null`, no 0, cuando no se puede calcular (menos de dos muestras, o media cero). Un
 * CV de 0 significa "siempre el mismo importe", que es la señal más fuerte que existe acá —
 * confundirlo con "no se pudo medir" haría proponer importes sobre nada.
 */
export function cvDe(valores: readonly number[] | null | undefined): number | null {
  const v = (valores ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (v.length < 2) return null;
  const media = v.reduce((a, b) => a + b, 0) / v.length;
  if (!media) return null;
  const varianza = v.reduce((a, b) => a + (b - media) ** 2, 0) / (v.length - 1);
  return Math.round((Math.sqrt(varianza) / Math.abs(media)) * 100) / 100;
}

/**
 * `[CG.27-B.1]` La propuesta contable de un beneficiario, o `null` con el motivo implícito.
 *
 * ⛔ Mismos umbrales que el Nivel 2 del autorrelleno (`LEARNED_DEFAULTS`: 3 usos, 60 % de
 * dominancia) **a propósito**: si esta lista propusiera con un criterio más flojo, ofrecería un
 * par que el autorrelleno después se niega a proponer, y la persona no entendería por qué.
 *
 * ⚠️ Soporte bajo o dominancia baja → **no propone**. Un default disfrazado es peor que un campo
 * vacío, porque se acepta sin mirarlo.
 */
export function propuestaDe(
  h: { cuenta: string; concepto: string; usos: number; tot: number } | null | undefined,
): { kepler_cuenta: string; kepler_concepto: string; soporte: number; dominancia: number } | null {
  if (!h || !h.cuenta || !h.concepto) return null;
  if (h.tot < 3) return null;
  const dominancia = h.usos / h.tot;
  if (dominancia < 0.6) return null;
  return {
    kepler_cuenta: h.cuenta,
    kepler_concepto: h.concepto,
    soporte: h.tot,
    dominancia: Math.round(dominancia * 100) / 100,
  };
}

/** Una regla juega si está activa y no fue suprimida por su propia tasa de corrección. */
export function reglaVive(r: Pick<ReglaGasto, 'active' | 'suppressed_at'>): boolean {
  return r.active !== false && !r.suppressed_at;
}

/**
 * ⭐ `[CG.27-B.0]` **EL matcher. UNO solo, para los dos caminos.**
 *
 * Devuelve la regla que aplica, o `null`. Lo que antes estaba duplicado —y divergente— entre
 * `cuentaPorRegla` (bandeja/lote) y `classifyByRules` (autofill) vive acá:
 *
 *   · sólo reglas vivas (`active` y sin `suppressed_at`);
 *   · sólo reglas con al menos un matcher y con el par contable completo;
 *   · orden por `priority` y **desempate total por `id`** — sin él, dos reglas de igual prioridad
 *     mandan el dinero a cuentas distintas según cómo viniera ordenado el SELECT;
 *   · **la primera que aplica gana**, y aplica sólo si TODOS sus matchers no nulos dan;
 *   · si ninguna aplica, `null`. **Jamás un default.**
 */
export function reglaQueAplica<T extends ReglaGasto>(
  reglas: readonly T[] | null | undefined,
  mov: { tipo?: string | null; glosa?: string | null; beneficiario?: string | null },
): T | null {
  const vivas = [...(reglas ?? [])]
    .filter(reglaVive)
    .filter((r) => r.match_tipo || r.match_glosa || r.match_beneficiario)
    .filter((r) => r.kepler_cuenta && r.kepler_concepto)
    .sort((a, b) => Number(a.priority) - Number(b.priority)
      || String(a.id ?? '').localeCompare(String(b.id ?? '')));
  for (const r of vivas) {
    if (!aplicaPatron(r.match_tipo, mov.tipo)) continue;
    if (!aplicaPatron(r.match_glosa, mov.glosa)) continue;
    if (!aplicaPatron(r.match_beneficiario, mov.beneficiario)) continue;
    return r;
  }
  return null;
}

/**
 * ¿Qué cuenta le toca a este egreso, sin que nadie elija nada?
 *
 * ⛔ **La primera regla que aplica GANA, y si ninguna aplica NO se propone nada.** No hay default:
 * una cuenta por descarte se vería igual que una cuenta declarada, y es exactamente el "default
 * disfrazado" que el CHECK `caja_rule_matcher_chk` de `20260918160000` ya prohíbe del lado de la
 * base. El movimiento cae a captura manual con `sin_regla`.
 *
 * ⚠️ Una regla sin ningún matcher aplicaría a TODO. La base lo impide con un CHECK; acá se vuelve
 * a verificar porque este motor también corre contra reglas que todavía no pasaron por la base
 * (pruebas, previsualización de un sembrado).
 *
 * ⚠️ El orden lo decide `priority` y se desempata por `id` — sin desempate total, dos reglas con
 * la misma prioridad mandarían el dinero a cuentas distintas según cómo viniera ordenado el
 * SELECT, que es justo el bug que `ordenCanonico` vino a matar en el cuadre.
 */
export function cuentaPorRegla(
  mov: MovimientoAClasificar, reglas: readonly ReglaGasto[] | null | undefined,
): Confirmable {
  if (!(Number(mov.monto) > 0)) return { ok: false, motivo: 'sin_monto' };
  // La decisión vive en `reglaQueAplica`, compartida con el autofill. Acá sólo se le pone la
  // forma que este camino necesita: si los dos la calcularan por su cuenta, volverían a divergir.
  const r = reglaQueAplica(reglas, mov);
  return r
    ? { ok: true, kepler_cuenta: r.kepler_cuenta, kepler_concepto: r.kepler_concepto }
    : { ok: false, motivo: 'sin_regla' };
}

// ── El resultado del lote ──────────────────────────────────────────────────────────────────────

export type EstadoFila = 'guardado' | 'duplicado' | 'rechazado' | 'no_confirmable';

export interface FilaLote {
  origen_ref: string;
  estado: EstadoFila;
  /** Folio del movimiento cuando se guardó. */
  folio?: string;
  /** Por qué no entró. Va SIEMPRE que el estado no sea `guardado`. */
  motivo?: string;
}

export interface ResumenLote {
  filas: FilaLote[];
  guardados: number;
  duplicados: number;
  rechazados: number;
  no_confirmables: number;
  /** Σ de lo efectivamente guardado. Lo rechazado NO suma: un total optimista es una mentira. */
  monto_guardado: number;
}

export function redondea2(v: number): number {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

/**
 * Arma el resultado del lote.
 *
 * ⛔ **Una fila que falla no tumba a las demás.** Confirmar 12 entregas y perder las 12 porque la
 * tercera ya estaba aplicada convierte el lote en un castigo, y la persona vuelve a capturar de a
 * una. El duplicado se separa del rechazo porque **no es un error de nadie**: es el candado
 * `ux_cash_ledger_origen_vivo` haciendo su trabajo (dos personas confirmaron lo mismo).
 */
export function resumirLote(filas: FilaLote[], montos: Map<string, number>): ResumenLote {
  const cuenta = (e: EstadoFila) => filas.filter((f) => f.estado === e).length;
  const guardado = filas
    .filter((f) => f.estado === 'guardado')
    .reduce((a, f) => a + (Number(montos.get(f.origen_ref)) || 0), 0);
  return {
    filas,
    guardados: cuenta('guardado'),
    duplicados: cuenta('duplicado'),
    rechazados: cuenta('rechazado'),
    no_confirmables: cuenta('no_confirmable'),
    monto_guardado: redondea2(guardado),
  };
}

// ── El descuadre entre lo que dice el ERP y lo que se contó ────────────────────────────────────

export interface Descuadre {
  hay: boolean;
  diferencia: number;
  /** Llave estable del hallazgo: correrlo dos veces no puede crear dos. */
  dedup_key: string;
  resumen: string;
}

/**
 * Prefijo del `dedup_key`. Se separan **a propósito**: un ingreso que no cuadra y un egreso que no
 * cuadra no son el mismo hallazgo ni los revisa la misma persona, y fundirlos en una sola clase
 * haría que el segundo dedupe contra el primero cuando comparten `origen_ref`.
 */
export type ClaseDescuadre = 'caja_entrega' | 'caja_egreso';

/**
 * Compara el importe del cobro contra lo contado.
 *
 * ⭐ **Nunca rechaza efectivo** (decisión de Edgar): el movimiento se guarda con lo CONTADO y la
 * diferencia se levanta como hallazgo. Lo que queda fuera del libro es peor que lo que queda
 * marcado — y bloquear empuja a teclear el importe del ERP para poder cerrar, que es exactamente
 * lo que el arqueo ciego vino a evitar.
 */
export function evaluarDescuadre(
  origenRef: string, montoDocumento: number, montoContado: number,
  clase: ClaseDescuadre = 'caja_entrega',
): Descuadre {
  const diferencia = redondea2(Number(montoContado) - Number(montoDocumento));
  const hay = Math.abs(diferencia) > LOTE_EPSILON;
  const signo = diferencia > 0 ? 'sobra' : 'falta';
  const doc = clase === 'caja_entrega' ? 'El cobro' : 'El documento';
  return {
    hay,
    diferencia,
    dedup_key: `${clase}|${origenRef}`,
    resumen: hay
      ? `${doc} dice ${montoDocumento.toFixed(2)} y se contaron ${Number(montoContado).toFixed(2)}: `
        + `${signo} ${Math.abs(diferencia).toFixed(2)}.`
      : `Lo contado coincide con ${clase === 'caja_entrega' ? 'el cobro' : 'el documento'}.`,
  };
}

// ── Gasto: lo que se repite se ofrece, no se reescribe ────────────────────────────────────────

export interface UsoGasto {
  kepler_cuenta: string;
  kepler_concepto: string;
  glosa: string | null;
  beneficiario: string | null;
  usos: number;
  ultimo_uso: string | Date | null;
}

export interface Frecuente extends UsoGasto {
  /** Posición 1..N. Se publica para que la pantalla no reordene por su cuenta. */
  rango: number;
}

/** Mínimo de repeticiones para ofrecer algo como frecuente. Menos que esto es una casualidad. */
export const FRECUENTE_MIN_USOS = 3;

/**
 * Ordena los pares que se repiten.
 *
 * ⚠️ El desempate es **ESTABLE y total** (usos ↓, último uso ↓, cuenta, concepto, glosa): dos
 * cargas de la misma pantalla tienen que ofrecer los mismos chips en el mismo orden. Un orden que
 * baila hace que la persona toque el chip equivocado por memoria muscular — y acá eso manda dinero
 * a otra cuenta contable.
 *
 * ⛔ Lo que no llega a `FRECUENTE_MIN_USOS` **no se ofrece**, no se ofrece con menos énfasis. Un
 * chip es una recomendación: ofrecer una casualidad es peor que no ofrecer nada.
 */
export function rankearFrecuentes(usos: UsoGasto[], limite = 12): Frecuente[] {
  const t = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : 0);
  return [...(usos ?? [])]
    .filter((u) => Number(u.usos) >= FRECUENTE_MIN_USOS && u.kepler_cuenta && u.kepler_concepto)
    .sort((a, b) =>
      Number(b.usos) - Number(a.usos)
      || t(b.ultimo_uso) - t(a.ultimo_uso)
      || String(a.kepler_cuenta).localeCompare(String(b.kepler_cuenta))
      || String(a.kepler_concepto).localeCompare(String(b.kepler_concepto))
      || String(a.glosa ?? '').localeCompare(String(b.glosa ?? '')))
    .slice(0, Math.max(1, limite))
    .map((u, i) => ({ ...u, rango: i + 1 }));
}
