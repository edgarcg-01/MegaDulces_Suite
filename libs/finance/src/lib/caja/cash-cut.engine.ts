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
import { denomKeyDeValor } from '@megadulces/contracts';
import { diaCorto } from './caja-corte-abierto.engine';

export type TipoMovimiento = 'ingreso' | 'gasto' | 'deposito';

import type { VeredictoCorte } from '@megadulces/contracts';

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
  /**
   * ⭐⭐ `[CG.95]` **CUÁNTO DE ESTE MOVIMIENTO NUNCA PASÓ POR EL CAJÓN.**
   *
   * Edgar: *"ponemos que a caja general entró 103 mil, pero eso no ingresó; ingresó sólo monedas
   * y lo de CAOS se queda en CAOS"*.
   *
   * Un cobro de ruta entra en dos pedazos: los **billetes** los traga el cajero (CAOS) y se
   * quedan en la bóveda; sólo la **morralla** llega al cajón. Un gasto pagado con efectivo que
   * CAOS dispensó tampoco sale del cajón: salió de la bóveda.
   *
   * Medido en prod el 2026-10-12 sobre la jornada entera:
   *
   *     la pantalla publicaba   ingresos $111,845.00   gastos $57,040.05
   *     pasó por la bóveda      ingresos $111,795.00   gastos $11,000.00
   *     entró al cajón de verdad          $     50.00
   *
   * O sea que el `esperado` pedía contar **~$90,000 que están dentro de la máquina**. El arqueo
   * de cada día nacía con un faltante gigante, y nadie puede cuadrar contra eso.
   *
   * ⚠️ El TOTAL del día no cambia: el dinero entró y se registró. Lo que cambia es **dónde está**,
   * y el arqueo cuenta un cajón, no una bóveda. Por eso `ingresos`/`gastos` se siguen publicando
   * en bruto y lo que se corrige es el `esperado`.
   *
   * `0` cuando el efectivo sí pasó por el cajón. Nunca `null`: acá la ausencia de enlace significa
   * "no se declaró que viniera de la bóveda", y eso es cero por definición.
   */
  en_boveda?: number;
}

/**
 * ⚠️ `[CG.152]` `denom_key` es **opcional y nuevo**. La base lo exige (`NOT NULL`, y es parte de
 * la PK junto con `momento`) porque `denominacion` sola no identifica: el billete de $20 y la
 * moneda de $20 valen lo mismo. Quien pueda mandarlo, que lo mande; quien no, el servicio lo
 * deriva del catálogo y **declara** que ante un $20 sin llave asume billete.
 */
export interface ConteoDenominacion { denominacion: number; piezas: number; denom_key?: string | null }

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
  /**
   * `cuadra` sólo si |diferencia| ≤ 1 centavo. `sin_contar` NO es `cuadra`.
   *
   * ⛔ `[CG.42]` `sin_base` tampoco. Si no se midió con cuánto arrancó la caja, el `esperado` no
   * es un hecho: es una resta que arranca de un supuesto. Decir `cuadra` ahí sería afirmar que
   * coincide con algo que nadie midió.
   */
  veredicto: VeredictoCorte;
  /**
   * `[CG.42]` No se midió con qué arrancó la caja (`fondo_inicial IS NULL`, `fondo_origen =
   * 'sin_medir'`). Va aparte del veredicto porque se puede estar sin base Y sin contar, y la
   * pantalla tiene que poder decir las dos cosas.
   */
  fondo_sin_medir: boolean;
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

/**
 * ⭐⭐ `[CG.156]` **El veredicto, en UNA definición, porque ahora hay DOS lugares que lo necesitan.**
 *
 * Hasta acá el veredicto nacía y moría dentro de `calcularCorte()`: se calculaba al sellar y
 * viajaba en la respuesta HTTP de `POST /contar`. **Nadie lo guardaba y ningún `GET` lo devolvía**
 * — medido en prod el 2026-10-14 sobre el único corte que existió en la vida del módulo:
 *
 *     contado    = 3,653.50   ← sellado
 *     esperado   = NULL
 *     diferencia = NULL       ← justo lo que el diálogo promete revelar
 *
 * O sea que al recargar la página la revelación se perdía para siempre. **Un dato que no se puede
 * volver a leer no es un dato: es un mensaje.** Y la pantalla, sin forma de saber que el corte ya
 * tenía conteo, volvía a ofrecer «Guardar conteo» — que el servidor rechaza con *«este corte ya
 * tiene un conteo sellado»*. Cerrar y recontar quedaban detrás de una rama que nunca se pintaba.
 *
 * ⛔ **La ceguera del primer conteo es deliberada; la amnesia del segundo no.** Por eso la salida
 * no es aflojar el conteo ciego —eso convertiría el arqueo en una transcripción del esperado, que
 * es lo que `[CG.19]` revirtió a propósito— sino **persistir el veredicto al sellar** y publicarlo
 * al leer.
 *
 * Y por eso esta función se extrae: con el veredicto guardado hay un segundo consumidor (la
 * lectura), y dos implementaciones del mismo juicio divergen. Es la misma lección que `[CG.155]`
 * acaba de pagar con producción caída dos días seguidos por tres copias de la misma escritura.
 *
 * ⚠️ El orden de las tres preguntas **no es intercambiable** y cada una costó un hallazgo:
 *
 *  1. `sin_contar` PRIMERO: si nadie contó no hay con qué comparar, tenga base o no. Si devolviera
 *     `cuadra` (0 contra 0), un día que nadie contó se vería igual que uno que cuadró al centavo.
 *  2. `sin_base` antes que el cuadre (`[CG.42]`): con el fondo sin medir, `esperado` arranca de un
 *     supuesto, y declarar `cuadra` contra eso afirma coincidencia con algo que nadie midió — el
 *     error aparecería como un faltante del tamaño exacto del fondo, todos los días.
 *  3. Recién entonces el cuadre, con tolerancia de un centavo.
 */
export function veredictoDe(input: {
  huboConteo: boolean;
  fondoSinMedir: boolean;
  diferencia: number;
}): VeredictoCorte {
  if (!input.huboConteo) return 'sin_contar';
  if (input.fondoSinMedir) return 'sin_base';
  if (Math.abs(Number(input.diferencia)) <= CORTE_EPSILON) return 'cuadra';
  return Number(input.diferencia) > 0 ? 'sobra' : 'falta';
}

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
  /**
   * ⛔ `[CG.42]` `null` = **no se midió con qué arrancó la caja**, y NO es lo mismo que `0`
   * ("se contó y estaba vacía"). `[CG.39]` abrió esa distinción en la base y en `abrir()`; acá se
   * respeta en vez de aplastarla con un `|| 0`, que es lo que volvía al `esperado` una cifra sin
   * base y al veredicto un `cuadra` sobre un supuesto.
   */
  fondoInicial: number | null;
  movimientos: MovimientoDelCorte[];
  conteo?: ConteoDenominacion[] | null;
  morralla?: number;
  /**
   * `[CG.96]` Lo que el cajero movió en la jornada y **nadie capturó** como movimiento del libro.
   * Dispensado = billetes que salieron de la bóveda y están en el cajón; depositado = efectivo que
   * salió del cajón a la bóveda. Ausente = 0: no se asume nada sobre un cajero que no se midió.
   */
  cajeroSinCapturar?: { dispensado?: number; depositado?: number } | null;
}): TotalesCorte {
  const vivos = (input.movimientos ?? []).filter((m) => m && m.estado !== 'cancelado');
  const cancelados = (input.movimientos ?? []).length - vivos.length;

  const suma = (t: TipoMovimiento) =>
    redondea(vivos.filter((m) => m.tipo === t).reduce((a, m) => a + Number(m.monto || 0), 0));

  const ingresos = suma('ingreso');
  const gastos = suma('gasto');
  const depositos = suma('deposito');
  // `[CG.42]` `== null` a propósito: atrapa `null` y `undefined` y deja pasar el `0`, que es un
  // hecho medido. Un `|| 0` metía el cero en la misma bolsa que la ausencia.
  const fondo_sin_medir = input.fondoInicial == null;

  /**
   * ⭐⭐ `[CG.95]` **EL ESPERADO CUENTA EL CAJÓN, NO LA BÓVEDA.**
   *
   * Acá decía `fondoInicial + ingresos - gastos - depositos` con el monto BRUTO de cada
   * movimiento. Pero el arqueo pregunta *"¿cuánto efectivo hay en el cajón?"*, y de un cobro de
   * ruta de $15,542 los $15,510 de billetes están dentro del cajero: al cajón llegaron $32.
   *
   * Medido en prod el 2026-10-12: el esperado pedía **~$90,000 de más**. Un arqueo que arranca
   * con un faltante de noventa mil no se puede cuadrar, y lo que no se puede cuadrar se deja de
   * mirar.
   *
   * ⚠️ `ingresos`, `gastos` y `depositos` se siguen publicando EN BRUTO: el dinero entró y se
   * registró, y el cuadro del día tiene que decirlo. Lo que cambia es **dónde está** — y de eso
   * depende sólo el esperado.
   *
   * ⚠️ Se resta en los DOS lados. Un gasto pagado con efectivo dispensado por CAOS tampoco salió
   * del cajón; restarlo del esperado haría aparecer un sobrante del mismo tamaño.
   */
  const enBoveda = (t: TipoMovimiento) =>
    redondea(vivos.filter((m) => m.tipo === t).reduce((a, m) => a + Number(m.en_boveda || 0), 0));
  const ingresos_boveda = enBoveda('ingreso');
  const gastos_boveda = enBoveda('gasto');
  const depositos_boveda = enBoveda('deposito');

  /**
   * ⭐⭐ `[CG.96]` **LO QUE EL CAJERO MOVIÓ Y NADIE CAPTURÓ TAMBIÉN ESTÁ EN EL CAJÓN.**
   *
   * Edgar, corrigiendo mi modelo: *"si sobra se regresa a CAOS, si no se carga al arqueo de caja
   * general"*.
   *
   * Una dispensación saca billetes de la bóveda y los deja **en el cajón**. Si se pagan, salen; si
   * sobran, o vuelven al cajero (y entonces hay un depósito) o **se quedan en el cajón y el arqueo
   * los encuentra**. En los dos casos el cajón es la verdad — por eso no hace falta enlazar cada
   * dispensación con el gasto que financió.
   *
   * Reconstruido con los datos de hoy, al centavo:
   *
   *     'nom more' 20,800 + 'nom canindo' 11,420 = 32,220  ->  NOMINA (10 pagos)  32,237.00
   *     'palomitas'        13,800                          ->  otros dos gastos   13,803.05
   *     dispensado 46,020.00 + morralla 20.05 = gastos 46,040.05
   *
   * O sea: CAOS pone los BILLETES, el cajón pone la MORRALLA. Espejo exacto del lado de los
   * cobros, donde el cajero traga los billetes y sólo las monedas llegan al cajón. `20,800`,
   * `11,420` y `13,800` son todos múltiplos de 20: la máquina no maneja monedas en ninguna
   * dirección.
   *
   * ⛔ Sólo entra lo que NADIE capturó. Una dispensación ya capturada como gasto (`origen_tipo
   * ='caos'`) representa el ciclo entero —entró al cajón y salió— y su neto ya es cero; sumarla
   * otra vez sería contarla dos veces.
   *
   * ⚠️ Y los depósitos al cajero RESTAN por el mismo motivo: ese efectivo salió del cajón y se
   * fue a la bóveda.
   *
   * Medido: con esto el esperado de hoy pasa de **−$45,990.05** (imposible) a **$3,357.45**, que
   * es el fondo más unas monedas. Un número que se puede ir a contar.
   */
  const dispensadoCajero = Number(input.cajeroSinCapturar?.dispensado ?? 0);
  const depositadoCajero = Number(input.cajeroSinCapturar?.depositado ?? 0);

  /**
   * ⛔ Y acá se RETIRA el `en_boveda` del esperado, que fue mi primer intento y era peor.
   *
   * Restar la bóveda movimiento por movimiento dependía de que alguien hubiera ENLAZADO cada
   * cobro con su depósito y cada gasto con su dispensación. Con las dos piernas del cajero el
   * enlace no hace falta: cada pierna se cuenta una vez y la aritmética sale sola.
   *
   *     cobro de ruta $15,542  ->  ingreso +15,542 · depósito −15,510  =  +32  (la morralla)
   *     gasto con dispensación ->  dispensación +2,000 · gasto −2,000  =    0
   *     nómina $32,237 de dispensaciones $32,220  ->  −17  (la morralla que puso el cajón)
   *
   * ⭐ Y es MÁS exacto: `en_boveda` para un movimiento `origen_tipo='caos'` usaba su monto
   * entero, cuando la máquina sólo se llevó los billetes. Medido: el ingreso `CI-2026-00002` de
   * $21,790 se contaba completo contra un depósito real de $21,770 — se perdían $20 de morralla.
   * La máquina es el testigo duro; el enlace es una declaración.
   *
   * `en_boveda` se CONSERVA en el movimiento porque sirve para explicar un renglón en pantalla,
   * pero ya no decide el esperado.
   */
  const esperado = redondea(
    Number(input.fondoInicial ?? 0)
    + ingresos - gastos - depositos
    + dispensadoCajero - depositadoCajero,
  );

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

  const veredicto = veredictoDe({ huboConteo, fondoSinMedir: fondo_sin_medir, diferencia });

  return {
    ingresos, gastos, depositos, esperado,
    contado: huboConteo ? contado : 0,
    diferencia: huboConteo ? diferencia : 0,
    veredicto, fondo_sin_medir, movimientos: vivos.length, cancelados,
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
 * ⛔⛔ `[CG.31]` **El libro en cero mientras la bóveda se movió.**
 *
 * La pantalla ponía las dos columnas lado a lado —«Caja general $0.00 · 0 movimientos» y
 * «Cajero (CAOS) 6 movimientos, entra $71,150 / sale $95,500»— y el único aviso decía *«todavía
 * no rendiste cuentas»*. **Eso no es falta de rendición: son dos afirmaciones incompatibles sobre
 * el mismo día**, presentadas como dos columnas de un informe normal. Una contradicción que no se
 * nombra se lee como una tabla más.
 *
 * ⚠️ Dispara SÓLO con el libro en cero. Si el libro tiene movimientos y no cuadran contra el
 * cajero, ésa es otra pregunta —un descuadre, no un vacío— y la contesta el cuadre, no un aviso.
 *
 * @param movsLibro   movimientos registrados en `cash_ledger` ese día
 * @param movsCajero  movimientos que reportó CAOS
 * @param brutoCajero lo que entró **más** lo que salió (el flujo movido, no el neto: un día que
 *                    deposita y dispensa lo mismo tiene neto 0 y movió dinero igual)
 * @returns el aviso, o `null` si no hay contradicción que nombrar
 */
export function avisoLibroVacio(
  movsLibro: number, movsCajero: number, brutoCajero: number,
): string | null {
  if (!(movsLibro === 0 && movsCajero > 0)) return null;
  const mx = brutoCajero.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  return `El cajero registró ${movsCajero} movimiento(s) por ${mx} y el libro de caja no tiene ninguno: `
    + 'el efectivo se movió y nadie lo capturó. No es que falte rendir cuentas — es que el libro está vacío.';
}

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

// ── `[CGP-L.1]` El conteo sellado no se cambia al cerrar ──────────────────────────────────────

/** Lo que ya está sellado en el corte: su desglose de cierre y su morralla. */
export interface ConteoSellado { conteo: ConteoDenominacion[]; morralla: number }

export type DecisionConteoCierre =
  | { usar: 'cuerpo' }
  | { usar: 'sellado' }
  | { usar: 'rechazo'; motivo: 'conteo_distinto'; sellado: number; tecleado: number };

/** Piezas por denominación (la fila sin llave se identifica por su valor) + total + morralla. */
function huellaDelConteo(conteo: ConteoDenominacion[], morralla: number) {
  const mapa = new Map<string, number>();
  let suma = 0;
  for (const d of conteo) {
    const piezas = Number(d?.piezas);
    if (!d || !(piezas > 0)) continue;
    const llave = d.denom_key ?? denomKeyDeValor(d.denominacion) ?? String(Number(d.denominacion));
    mapa.set(llave, (mapa.get(llave) ?? 0) + piezas);
    suma += Number(d.denominacion) * piezas;
  }
  const m = redondea(Number(morralla || 0));
  return { mapa, morralla: m, total: redondea(suma + m) };
}

/**
 * ¿Con qué conteo se cierra?
 *
 * ⛔ `cerrar()` usaba lo que viniera en la reja en lugar del sellado y reescribía el desglose sellado
 * sin compararlos: contar, ver el esperado, teclear otra cifra y cerrar saltaba el arqueo ciego, sin
 * recontar y sin motivo. Desde `[CGP-D.3]` lo frena la base; acá se decide ANTES, para que la persona
 * reciba una frase y no un error de servidor.
 *
 *  · sin conteo sellado → el del cuerpo (contar y cerrar en un paso sigue existiendo);
 *  · sellado y la reja SIN piezas → el sellado. La morralla sola no es un conteo nuevo: rechazar
 *    ahí trabaría un cierre legítimo según cómo mande la pantalla ese campo;
 *  · sellado y la reja con el MISMO desglose (en cualquier orden, sin filas en cero) → el sellado;
 *  · sellado y cualquier otra cosa, aunque sume lo mismo → rechazo: lo sellado es el desglose.
 */
export function decidirConteoDelCierre(
  sellado: ConteoSellado | null,
  cuerpo: { conteo?: ConteoDenominacion[] | null; morralla?: number | null },
): DecisionConteoCierre {
  if (!sellado) return { usar: 'cuerpo' };
  const piezas = (cuerpo.conteo ?? []).filter((d) => d && Number(d.piezas) > 0);
  if (piezas.length === 0) return { usar: 'sellado' };
  const a = huellaDelConteo(sellado.conteo, sellado.morralla);
  const b = huellaDelConteo(piezas, Number(cuerpo.morralla || 0));
  const iguales = a.morralla === b.morralla
    && a.mapa.size === b.mapa.size
    && [...a.mapa].every(([k, v]) => b.mapa.get(k) === v);
  return iguales
    ? { usar: 'sellado' }
    : { usar: 'rechazo', motivo: 'conteo_distinto', sellado: a.total, tecleado: b.total };
}

// ── `[CGP-L.2]` Lo que se firma es lo que se reveló ──────────────────────────────────────────

/**
 * ¿El esperado cambió desde que la persona lo vio?
 *
 * `cerrar()` recalcula el esperado con el universo de ESE momento: si entró un movimiento de la
 * jornada después de contar, firmaba otro número sin decirlo. Se compara contra lo que la persona
 * VIO (`visto`, si la pantalla lo manda) o, si no, contra lo que `contar()` reveló y guardó.
 *
 * Un corte sellado antes de que el esperado se guardara (`[CG.156]`) no tiene contra qué compararse:
 * se DECLARA con `contra: null`, no se inventa.
 */
export function esperadoCambio(
  revelado: number | null, actual: number, visto?: number | null,
): { cambio: boolean; contra: number | null } {
  const v = visto == null ? NaN : Number(visto);
  const contra = Number.isFinite(v) ? redondea(v) : revelado == null ? null : redondea(Number(revelado));
  if (contra == null) return { cambio: false, contra: null };
  return { cambio: redondea(actual) !== contra, contra };
}

const pesos = (n: number) =>
  `$${Number(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function textoConteoDistinto(sellado: number, tecleado: number): string {
  return `El conteo de este corte ya está sellado en ${pesos(sellado)} y la reja trae ${pesos(tecleado)}. `
    + 'Lo sellado no se cambia al cerrar: para corregirlo hay que recontar, y el reconteo pide motivo.';
}

export function textoEsperadoCambio(contra: number, actual: number): string {
  return `El esperado cambió desde que se contó: se mostró ${pesos(contra)} y ahora da ${pesos(actual)}, `
    + 'porque entró o cambió un movimiento de la jornada. Revisá ese movimiento y confirmá el esperado nuevo para cerrar.';
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

export type MotivoNoRecuenta =
  | 'no_es_borrador' | 'ya_reconto' | 'sin_motivo' | 'no_hay_diferencia' | 'sin_conteo_previo';

export const TEXTO_NO_RECUENTA: Record<MotivoNoRecuenta, string> = {
  // `[CGP-L.3]` Lo decide el servicio con el corte en la mano (el gate puro no recibe el contado).
  sin_conteo_previo: 'Todavía no hay un conteo que recontar: primero se cuenta, y sólo si no cuadra se vuelve a contar.',
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `[CG.155]` El desglose por denominación: los renglones, en función PURA
// ─────────────────────────────────────────────────────────────────────────────────────────────

export interface FilaDenominacion {
  tenant_id: string;
  cut_id: string;
  momento: 'apertura' | 'cierre';
  denom_key: string;
  denominacion: number;
  piezas: number;
}

/** Una denominación que no está en el catálogo: no se inventa su llave, se nombra y se para. */
export class DenominacionFueraDeCatalogo extends Error {
  constructor(public readonly denominacion: number) {
    super(`Denominación ${denominacion} no está en el catálogo: no se puede registrar el conteo.`);
  }
}

/**
 * ⛔⛔ `[CG.155]` **Los renglones que se escriben, armados una sola vez.**
 *
 * Producción cayó dos veces en dos días por la misma causa: `finance.cash_ledger_cut_denominations`
 * tenía **TRES** caminos de escritura (`abrir`, `sellarConteo`, `cerrar`) y la migración que agregó
 * `denom_key NOT NULL` actualizó uno. El 13-oct reventó `contar`; se arregló ese camino y el 14-oct
 * reventó `cerrar` con el error idéntico. **Mientras haya tres implementaciones de la misma
 * escritura, arreglar una no es arreglar el defecto** — por eso los renglones se arman acá, en una
 * función sin base de datos, que sí puede tener candado.
 *
 * Dos reglas que la base exige:
 *
 * 1. `denom_key` es parte de la PK `(tenant_id, cut_id, momento, denom_key)` porque `denominacion`
 *    sola NO identifica: el billete de 20 y la moneda de 20 valen lo mismo y son **dos** renglones
 *    (lo fuerza `cut_denom_par_chk`). Si quien cuenta manda la llave se respeta; si no, se deriva
 *    del catálogo, que ante un 20 sin llave asume billete — y eso se declara, no se esconde.
 * 2. Las piezas en cero **no se guardan** (`cut_denom_piezas_chk`): una denominación que no se
 *    contó no es una fila con cero, es una fila que no existe.
 */
export function filasDenominacion(
  tenantId: string,
  cutId: string,
  momento: 'apertura' | 'cierre',
  conteo: ConteoDenominacion[] | null | undefined,
  llaveDe: (valor: number) => string | null,
): FilaDenominacion[] {
  return (conteo ?? [])
    .filter((d) => Number(d.piezas) > 0)
    .map((d) => {
      const key = d.denom_key ?? llaveDe(Number(d.denominacion));
      if (!key) throw new DenominacionFueraDeCatalogo(Number(d.denominacion));
      return {
        tenant_id: tenantId,
        cut_id: cutId,
        momento,
        denom_key: key,
        denominacion: Number(d.denominacion),
        piezas: Number(d.piezas),
      };
    });
}

// ── `[CGP-L.4]` ¿Se puede abrir el corte de esta fecha? ─────────────────────────────────────

export type MotivoNoAbre = 'fecha_invalida' | 'fecha_futura' | 'ya_existe' | 'hay_posterior';

/** 'YYYY-MM-DD' que además es un día real del calendario (sin `2026-02-30`). */
function esFechaDeCalendario(f: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f ?? ''));
  if (!m) return false;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(a, mes - 1, d));
  return t.getUTCFullYear() === a && t.getUTCMonth() === mes - 1 && t.getUTCDate() === d;
}

/**
 * La pantalla abría siempre el corte de HOY y el servidor aceptaba cualquier fecha sin mirarla.
 * Ponerse al día con jornadas atrasadas exige abrir fechas pasadas; esto frena lo que no tiene
 * vuelta atrás:
 *  · una fecha que no es fecha, o que todavía no pasa (`hoy` lo da la base, en hora de México);
 *  · un día que ya tiene corte (la base también lo frena; acá sale con el folio);
 *  · ⛔ un día ANTERIOR a un corte que ya existe: el posterior heredó su fondo sin ese día, y un
 *    corte firmado ya no se corrige. Las jornadas se cierran en orden.
 *
 * ⚠️ La última regla choca con una decisión pendiente (`[CGP-0.6]`): si se decide capturar en la
 * Suite días anteriores al primer corte (7 al 10-oct), esta regla los frena. Se relaja con una
 * excepción EXPLÍCITA cuando esa decisión se tome, no en silencio.
 */
export function puedeAbrirCorte(i: {
  fecha: string;
  hoy: string;
  mismoDia: { folio: string } | null;
  posterior: { folio: string; fecha: string } | null;
}): { ok: boolean; motivo?: MotivoNoAbre; texto?: string } {
  if (!esFechaDeCalendario(i.fecha)) {
    return { ok: false, motivo: 'fecha_invalida', texto: 'La fecha del corte no es una fecha válida (AAAA-MM-DD).' };
  }
  if (i.fecha > i.hoy) {
    return { ok: false, motivo: 'fecha_futura', texto: `El ${diaCorto(i.fecha)} todavía no pasa: no se abre un corte de un día que no terminó.` };
  }
  if (i.mismoDia) {
    return { ok: false, motivo: 'ya_existe', texto: `El ${diaCorto(i.fecha)} ya tiene su corte: ${i.mismoDia.folio}.` };
  }
  if (i.posterior) {
    return {
      ok: false, motivo: 'hay_posterior',
      texto: `Ya existe el corte ${i.posterior.folio} del ${diaCorto(i.posterior.fecha)}. Las jornadas se cierran en orden: `
        + `abrir una anterior dejaría a ese corte con un fondo que no contó este día.`,
    };
  }
  return { ok: true };
}
