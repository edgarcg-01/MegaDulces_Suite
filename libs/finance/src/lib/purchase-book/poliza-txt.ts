/**
 * Fase LC (ADR-052) — **El layout del TXT de pólizas de ContPAQi**, escritor y lector.
 *
 * Vive aparte del servicio, sin dependencias de Nest, por dos razones:
 *
 *  1. **se puede probar sin DI.** Decide sobre dinero: un archivo mal serializado es una
 *     póliza que ContPAQi rechaza, o peor, que acepta corrida de campo. El smoke
 *     `test-newdb-libro-compras-txt.js` carga este archivo tal cual (mismo patrón que
 *     `receipt-match.ts`), así que si el layout cambia de criterio el test se pone rojo.
 *  2. **escritor y lector no se pueden separar.** Los anchos y la alineación están una sola
 *     vez, en `LAYOUT_P` / `LAYOUT_M`, y los leen los dos: `construirTxt` los escribe y
 *     `parsearTxt` los lee. Si alguien mueve un ancho, se mueven los dos lados o ninguno.
 *
 * ⛔⛔ **CORRECCIÓN 2026-10-08 — esta cabecera decía que `SEP` era lo ÚNICO sin verificar, y
 * era FALSO.** Los 19 campos se validaron contra `Polizas`/`MovimientosPoliza`, pero eso prueba
 * qué **significa** cada campo, **no cuánto mide ni cómo se serializa**. Buscando el formato
 * oficial aparecieron **tres discrepancias concretas** con lo que hay acá — ver
 * `LAYOUT_SIN_VERIFICAR` abajo.
 *
 * Lo que sí se despejó: dos fuentes independientes coinciden en que los campos van **separados
 * por un espacio**, o sea que `SEP = ' '` es correcto y la hipótesis de concatenación pura
 * (`SEP = ''`) queda descartada.
 *
 * ⚠️ **Nada de esto se "corrigió" a lo que dicen las fuentes.** Serían dos layouts sin verificar
 * en vez de uno, y la cifra de una fuente de foro no vale más que un decode propio. Se DECLARA
 * el conflicto (ADR-056) y se cierra con el archivo que manda, no votando.
 *
 * ⭐ **El árbitro existe y tiene nombre:** `C:\Compac\Empresas\Esquemas\Contpaq\CT_EST_Poliza_NG.xls`
 * en `192.168.0.35` — el esquema que ContPAQi usa para leer el TXT. Re-medido el 2026-10-08:
 * **SMB sigue denegado** desde esta máquina. Ese archivo, o un TXT que ContPAQi ya haya
 * aceptado, cierra las cuatro preguntas de una sola vez.
 *
 * Va como constante y no como variable de entorno a propósito: un formato que PUEDE estar
 * mal en producción es peor que una constante que está bien.
 */

/** ContPAQi: 3 = Diario. Verificado contra su catálogo `TiposPolizas`. */
export const TIPO_POLIZA_DIARIO = '3';

export const SEP = ' ';

/**
 * ⛔⛔ **Lo que este layout NO tiene verificado, con nombre y número** (2026-10-08).
 *
 * Buscando el formato oficial aparecieron tres discrepancias concretas entre lo que está acá y
 * lo que describen fuentes externas. **Ninguna se "corrigió"**: cambiar un número sin verificar
 * por otro número sin verificar no es progreso, es mover el riesgo de lugar. Se declaran para
 * que (a) nadie vuelva a leer esta cabecera y crea que el layout está probado, y (b) el día que
 * llegue el árbitro se revisen estas tres primero.
 *
 * ⚠️ **Cada una de las tres corre TODOS los campos siguientes de su renglón.** No son errores
 * cosméticos: si `clase` mide 4 y acá mide 1, el concepto arranca 3 caracteres antes y ContPAQi
 * lee basura en cada campo desde ahí.
 *
 * ⭐ **Y una cuarta, que es la más importante y es de capacidad, no de ancho:** el formato
 * **SÍ transporta el UUID del CFDI**, con renglones `AD ` + UUID + espacio ubicados **después
 * del `P`**. `FASE_LC` afirma lo contrario (*"el layout no tiene campo de UUID"*) y de ahí
 * salió toda su estrategia de dos muletas (el UUID metido en `Concepto` + el CSV para el
 * Asociador). Si el renglón `AD` existe, los **0 de 33,303 movimientos sin asociar en 5 años**
 * no son una limitación del formato: son renglones que nadie emitió.
 */
export const LAYOUT_SIN_VERIFICAR = [
  { campo: 'referencia (M)', aqui: 10, fuente: 30, impacto: 'corre 20 chars todos los campos siguientes del movimiento' },
  { campo: 'seg_negocio (M)', aqui: 10, fuente: 4, impacto: 'corre 6 chars; nadie lo había puesto en duda' },
  { campo: 'guid (P y M)', aqui: 0, fuente: 36, impacto: 'campo que no teníamos: el Guid de la póliza / del movimiento' },
  { campo: 'fecha_aplicacion (M)', aqui: 0, fuente: 8, impacto: 'existe, y va en el MOVIMIENTO (no en el encabezado, como se creía)' },
  { campo: 'espacio final de línea', aqui: 0, fuente: 1, impacto: 'toda línea real termina en espacio; el emisor no lo escribe' },
  { campo: 'etiqueta del movimiento', aqui: 0, fuente: 0, impacto: 'el real dice "M1", el emisor escribe "M "' },
] as const;

/**
 * ⭐⭐ **Ya no es una duda: es una diferencia MEDIDA** (2026-10-08). El árbitro apareció — una
 * exportación real de ContPAQi encontrada por `02-evaluar-esquema.ps1` — y dice **P=185 / M=272**
 * contra los **147 / 211** que este archivo produce.
 *
 * Lo que `clase` enseña y conviene no olvidar: la fuente externa decía **4** y **nosotros
 * teníamos razón con 1**. Haber "corregido" a lo que decía el foro habría roto el único campo
 * que estaba bien. Por eso no se votó: se midió.
 *
 * El layout correcto vive en `libs/finance/src/lib/contpaqi/layout.params.ts`
 * (`LAYOUT_REAL_P` / `LAYOUT_REAL_M`). Este archivo sigue emitiendo el viejo **a propósito**:
 * cambiarlo toca el libro de compras, que mueve $30–56M al mes, y eso es un sprint con su
 * propio candado, no un `sed`.
 */
export const LAYOUT_ARBITRO = 'database/tests/fixtures/poliza-contpaqi-real-2026-09.txt (local, NO se publica)';

export const r2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
const padR = (s: unknown, n: number) => String(s ?? '').slice(0, n).padEnd(n, ' ');
const padL = (s: unknown, n: number) => String(s ?? '').slice(0, n).padStart(n, ' ');
/**
 * ContPAQi pide entre 1 y 2 decimales: `6.5` y `6.53` valen, `6` no.
 *
 * ⭐ `[CP.8.13]` — **el comentario de arriba siempre dijo esto y el código no lo hacía.** Escribía
 * `6.50` donde ContPAQi escribe `6.5`. Lo encontró el round-trip contra el archivo real: 3 de
 * las 14 pólizas diferían, y las tres por lo mismo (`11787.5` vs `11787.50`).
 *
 * La regla real es **mínima**: dos decimales sólo cuando el segundo no es cero.
 *     1078    -> "1078.0"      11787.5 -> "11787.5"      5775.86 -> "5775.86"
 */
export const impTxt = (n: number) => {
  const s = r2(n).toFixed(2);
  return s.endsWith('0') ? s.slice(0, -1) : s;
};

export interface CampoFijo {
  nombre: string;
  ancho: number;
  /** Alineado a la derecha (`padL`). Por default va a la izquierda (`padR`). */
  der?: boolean;
  /**
   * ⭐⭐ `[CP.8.28]` — **No lleva separador DESPUÉS de este campo.**
   *
   * El esquema del fabricante (`CT_EST_Poliza_NG.xls`) intercala un renglón `S | 1` entre cada
   * par de campos… **salvo entre `Concepto` y `SistOrig` del encabezado**, donde no hay ninguno.
   *
   * ⛔ Asumir que el separador es uniforme **cuadra el total igual** (185 de las dos formas) y
   * parte mal esos dos campos. Hoy no se nota porque `SistOrig` vale `11` y alineado a la derecha
   * en 3 da `" 11"`, que es byte por byte lo mismo que separador + `"11"`. Con un valor de 3
   * dígitos el archivo se correría entero.
   *
   * *Un total que cuadra no prueba que los campos estén donde van.*
   */
  sinSep?: boolean;
}

/**
 * ⭐⭐ `[CP.8.13]` — **Encabezado REAL. 174 chars de campos + 11 separadores = 185.**
 * Medido sobre una exportación de ContPAQi y cruzado contra su base (14/14 `Polizas.Guid`).
 */
export const LAYOUT_P: CampoFijo[] = [
  { nombre: 'tipo', ancho: 2 },
  { nombre: 'fecha', ancho: 8, der: true },
  { nombre: 'tipo_pol', ancho: 4, der: true },
  { nombre: 'folio', ancho: 9, der: true },
  // ⭐ 1, no 4. Una fuente externa decía 4; el archivo real le dio la razón a nuestro decode.
  { nombre: 'clase', ancho: 1, der: true },
  { nombre: 'id_diario', ancho: 10 },
  { nombre: 'concepto', ancho: 100, sinSep: true },
  { nombre: 'sist_orig', ancho: 3, der: true },
  { nombre: 'impresa', ancho: 1, der: true },
  { nombre: 'ajuste', ancho: 1, der: true },
  // ⭐ Campo que NO teníamos. Es `Polizas.Guid`, y es el mejor candidato a llave de correlación
  // del puente: estructural, no depende de que nadie edite un texto.
  { nombre: 'guid', ancho: 36 },
];

/**
 * ⭐⭐ `[CP.8.13]` — **Movimiento REAL. 261 chars de campos + 11 separadores = 272.**
 * Cruzado contra la base: 82/82 `MovimientosPoliza.Guid`.
 */
export const LAYOUT_M: CampoFijo[] = [
  // ⚠️ El valor real es `M1`, no `M `. Ver `construirTxt`.
  { nombre: 'tipo', ancho: 2 },
  { nombre: 'cuenta', ancho: 30 },
  { nombre: 'referencia', ancho: 30 },          // ⭐ 30, no 10
  { nombre: 'tipo_movto', ancho: 1, der: true },
  { nombre: 'importe', ancho: 20 },
  { nombre: 'id_diario', ancho: 10 },
  { nombre: 'importe_me', ancho: 20 },
  { nombre: 'concepto', ancho: 100 },
  { nombre: 'seg_negocio', ancho: 4 },          // ⭐ 4, no 10 — nadie lo había puesto en duda
  { nombre: 'guid', ancho: 36 },                // ⭐ MovimientosPoliza.Guid
  { nombre: 'fecha_aplicacion', ancho: 8 },     // ⭐ existe, y va en el MOVIMIENTO
];

/**
 * ⛔ El layout que este archivo emitía hasta el 2026-10-08 (P=147 / M=211). **Está mal** — se
 * midió contra un archivo real de ContPAQi y no coincide en 6 puntos.
 *
 * Se conserva por UNA razón concreta, no por nostalgia: `finance.purchase_book_runs` tiene
 * archivos ya guardados con este formato (medido: la corrida `2026-07/complemento`), y
 * `parsearTxt` tiene que poder leerlos. Si se borra, esas corridas dejan de re-parsear y los
 * cuadres de LC que dependen de eso se caen.
 *
 * ⚠️ **No se emite más.** Y hay algo que conviene saber antes de preocuparse: de las 3 corridas
 * que existen, **ninguna llegó a `entregado` ni a `aplicado`** — o sea que ningún archivo con
 * este formato llegó jamás a ContPAQi. No se rompió nada que estuviera funcionando.
 */
export const LAYOUT_P_LEGACY: CampoFijo[] = [
  { nombre: 'tipo', ancho: 2 }, { nombre: 'fecha', ancho: 8, der: true },
  { nombre: 'tipo_pol', ancho: 4, der: true }, { nombre: 'folio', ancho: 9, der: true },
  { nombre: 'clase', ancho: 1, der: true }, { nombre: 'id_diario', ancho: 10 },
  { nombre: 'concepto', ancho: 100 }, { nombre: 'sist_orig', ancho: 2, der: true },
  { nombre: 'impresa', ancho: 1, der: true }, { nombre: 'ajuste', ancho: 1, der: true },
];

export const LAYOUT_M_LEGACY: CampoFijo[] = [
  { nombre: 'tipo', ancho: 2 }, { nombre: 'cuenta', ancho: 30 },
  { nombre: 'referencia', ancho: 10 }, { nombre: 'tipo_movto', ancho: 1, der: true },
  { nombre: 'importe', ancho: 20 }, { nombre: 'id_diario', ancho: 10 },
  { nombre: 'importe_me', ancho: 20 }, { nombre: 'concepto', ancho: 100 },
  { nombre: 'seg_negocio', ancho: 10 },
];

/** El legado no cerraba la línea con separador; por eso su largo se calcula aparte. */
export const largoLineaLegacy = (layout: readonly CampoFijo[]) =>
  layout.reduce((a, c) => a + c.ancho, 0) + (layout.length - 1) * SEP.length;

/**
 * ⭐⭐ `[CP.8.29]` — **El renglón de asociación de CFDI.** `asocdocto.1` en el esquema del
 * fabricante: etiqueta `AD` + `UUID` de 36 = **40 caracteres** con sus dos separadores.
 *
 * Verificado por partida doble: el esquema lo declara así, y el archivo real trae **62 renglones
 * `AD`, los 62 de 40 caracteres**, que cruzan a 234 filas de `AsocCFDIs`.
 *
 * ⚠️ El archivo real usa el UUID **tanto en mayúsculas como en minúsculas** (32 y 30 de los 62),
 * así que ContPAQi no distingue. No se normaliza: se manda como viene.
 */
export const LARGO_UUID = 36;

export const LAYOUT_AD: CampoFijo[] = [
  { nombre: 'tipo', ancho: 2 },
  { nombre: 'uuid', ancho: LARGO_UUID },
];

export interface Movimiento {
  cuenta: string;
  referencia: string;
  abono: boolean;
  importe: number;
  concepto: string;
  /**
   * `[CP.8.5]` — `IdSegNeg`. **Opcional y vacío por default**, que es exactamente lo que el
   * libro de compras venía serializando: así los archivos de LC siguen saliendo byte por byte
   * iguales y su round-trip no se entera de que esta columna existe.
   *
   * Lo pide el puente de egresos: medido el 2026-10-08 sobre pólizas reales de ContPAQi, el
   * renglón del gasto SÍ lleva segmento (`IdSegNeg=8` en traslado de efectivo) aunque el del
   * IVA y el del banco vayan en 0.
   */
  seg_negocio?: string | number;
  /** `[CP.8.13]` `MovimientosPoliza.Guid`. Opcional: sale vacío y el renglón sigue siendo válido. */
  guid?: string;
  /** `[CP.8.13]` `yyyyMMdd`. Va en el MOVIMIENTO, no en el encabezado — contra lo que se creía. */
  fecha_aplicacion?: string;
}

/** El TXT desarmado. `movimientos` reusa la misma interfaz que produce el generador. */
export interface PolizaTxtParseada {
  header: { fecha: string; tipo_pol: string; folio: number; concepto: string; impresa: string; ajuste: string; guid?: string } | null;
  movimientos: Movimiento[];
  /** Renglones que no cumplen el layout. Si hay uno, el archivo NO es comparable. */
  invalidos: { linea: number; motivo: string; texto: string }[];
}

/**
 * ⭐ `[CP.8.13]` — **cierra con un separador final**, no sólo entre campos.
 *
 * Medido sobre una exportación real de ContPAQi (2026-10-08): **las 232 líneas del archivo
 * terminan en espacio**, sin excepción. La versión anterior hacía `join(SEP)` y dejaba el
 * renglón 1 carácter corto — un defecto invisible en pantalla y fatal al importar.
 */
export const armarLinea = (layout: readonly CampoFijo[], vals: unknown[]) =>
  layout.map((c, i) => (c.der ? padL(vals[i], c.ancho) : padR(vals[i], c.ancho))
    + (c.sinSep ? '' : SEP)).join('');

export const largoLinea = (layout: readonly CampoFijo[]) =>
  layout.reduce((a, c) => a + c.ancho + (c.sinSep ? 0 : SEP.length), 0);

/**
 * Corta una línea en sus campos por posición. **No se puede usar `split`** por el
 * separador: `cuenta` y `concepto` van rellenados con espacios y `referencia` puede venir
 * entera en blanco, así que partir por espacios corre todos los campos.
 */
export const partirLinea = (layout: CampoFijo[], linea: string): string[] => {
  const out: string[] = [];
  let i = 0;
  for (const c of layout) {
    out.push(linea.slice(i, i + c.ancho));
    i += c.ancho + (c.sinSep ? 0 : SEP.length);
  }
  return out;
};

/**
 * `fecha` va en `yyyyMMdd` — es el último día del mes de la póliza.
 *
 * **Invariante: ningún renglón se serializa sin cuenta.** Va acá, en el último momento
 * posible, y no sólo en quien arma los movimientos, porque atrapa CUALQUIER camino al
 * archivo. El modo de falla es invisible sin esto: `padR(null, 30)` produce 30 espacios,
 * el renglón se ve bien en pantalla, y ContPAQi rechaza el archivo entero al importarlo.
 */
export function construirTxt(
  fecha: string,
  folio: number,
  concepto: string,
  movs: Movimiento[],
  /**
   * `[CP.8.5]` — **Default `'3'` (Diario) a propósito**: el libro de compras llama sin este
   * argumento y sale idéntico al byte. El puente de egresos pasa `'2'`.
   *
   * ⚠️ No se derivó del contenido (por ejemplo "si carga a 5xxx es egreso"): el tipo de
   * póliza es una DECISIÓN de quien arma el asiento, no una propiedad de sus cuentas — el
   * libro de compras también carga a 5xxx y es Diario.
   */
  tipoPol: string = TIPO_POLIZA_DIARIO,
  /**
   * `[CP.8.13]` — `Polizas.Guid`. El archivo real lo trae en cada encabezado. ⭐ Es el mejor
   * candidato a llave de correlación del puente: estructural, y no gasta los 100 caracteres del
   * concepto ni depende de que nadie edite el texto.
   *
   * ⚠️ **Sin verificar: no se sabe si ContPAQi RESPETA el guid que uno manda o genera el suyo.**
   * Se descubre en la primera importación. Hasta entonces el token en el concepto sigue siendo
   * la llave, y esto va de más.
   */
  guid?: string,
  /**
   * `Impresa` / `Ajuste`. Van como parámetro y no clavados porque el round-trip contra el
   * archivo real lo exigió: su primera póliza trae `Impresa=1` (la base lo confirma) y el
   * emisor escribía `0` siempre — un byte de diferencia en la posición 144.
   *
   * El default `'0'` es el correcto para lo que NOSOTROS emitimos: una póliza recién importada
   * no está impresa ni es de ajuste.
   */
  impresa: string = '0',
  ajuste: string = '0',
  /**
   * ⭐⭐ `[CP.8.29]` — **Los UUID de CFDI que esta póliza asocia** (renglones `AD`).
   *
   * El esquema del fabricante lo define como `asocdocto.1`: etiqueta `AD` de 2 + separador +
   * `UUID` de 36 + separador = **40 caracteres**, y el archivo real trae 62 de esos, todos de 40.
   *
   * ⭐ **Van al FINAL de la póliza**, después de todos los `M1`. Medido sobre las 14 pólizas del
   * archivo real: la primera es `P M1 M1 M1 AD`. ⛔ Las fuentes externas decían *"después del
   * `P`"* (§9.1) — **es falso**, y ponerlo ahí habría sido el primer motivo de rechazo.
   *
   * ⚠️ Default `[]`: **el libro de compras llama sin este argumento y su archivo sale idéntico
   * al byte.** Es lo que permite prender esto sin tocar un flujo que mueve $30–56M al mes.
   */
  uuids: readonly string[] = [],
): string {
  const sinCuenta = movs.findIndex((m) => !m.cuenta || !String(m.cuenta).trim());
  if (sinCuenta >= 0) {
    throw new Error(`el movimiento ${sinCuenta + 1} no tiene cuenta contable; el archivo sería rechazado`);
  }
  const header = armarLinea(LAYOUT_P, [
    'P', fecha, tipoPol, String(folio), '1', '0', concepto, '11', impresa, ajuste, guid ?? '',
  ]);
  // ⚠️ `M1`, no `M `. Lo dice el archivo real: las 82 líneas de movimiento arrancan con `M1`.
  const lineas = movs.map((m) => armarLinea(LAYOUT_M, [
    'M1', m.cuenta, m.referencia, m.abono ? '1' : '0',
    impTxt(m.importe), '0', '0.0', m.concepto, m.seg_negocio ?? '',
    m.guid ?? '', m.fecha_aplicacion ?? '',
  ]));
  /**
   * `[CP.8.29]` — El renglón `AD`, con el layout del esquema: `AD` (2) + sep + UUID (36) + sep.
   *
   * ⛔ **Se niega ante un UUID que no mide 36.** Rellenarlo o recortarlo produciría un renglón de
   * 40 que el importador acepta y que asocia **el comprobante equivocado** — o ninguno. Un
   * archivo rechazado es infinitamente preferible (misma regla que `[LC.9]`).
   */
  const asociaciones = uuids.map((u) => {
    const s = String(u ?? '').trim();
    if (s.length !== LARGO_UUID) {
      throw new Error(
        `el UUID "${s}" mide ${s.length} y el renglón AD exige ${LARGO_UUID}; el archivo sería basura`,
      );
    }
    return armarLinea(LAYOUT_AD, ['AD', s]);
  });
  return [header, ...lineas, ...asociaciones].join('\r\n') + '\r\n';
}

/**
 * Desarma un TXT de póliza. Es el inverso exacto de `construirTxt` y paga tres veces:
 *
 *  1. prueba el layout — `construirTxt(parsearTxt(real))` tiene que dar el archivo real
 *     byte por byte, y el primer byte distinto nombra el defecto (separador, dirección del
 *     pad, la regla de decimales de `impTxt`, CRLF);
 *  2. deja que LC.7 cuadre contra **lo entregado** en vez de re-derivarlo de datos que ya
 *     cambiaron;
 *  3. da el listado movimiento-a-UUID para el Asociador de CFDI de ContPAQi.
 *
 * El criterio es fallar ruidoso antes que adivinar: cualquier renglón dudoso se va a
 * `invalidos` y quien llama decide. Un default silencioso acá voltearía el signo de una
 * pata de millones sin que nadie lo vea.
 */
export function parsearTxt(txt: string): PolizaTxtParseada {
  const out: PolizaTxtParseada = { header: null, movimientos: [], invalidos: [] };
  if (!txt) {
    out.invalidos.push({ linea: 0, motivo: 'archivo vacío', texto: '' });
    return out;
  }
  // El archivo cierra con CRLF, así que la última línea del split viene vacía.
  const lineas = txt.split(/\r?\n/);
  while (lineas.length && lineas[lineas.length - 1].trim() === '') lineas.pop();

  // ⭐ `[CP.8.13]` — **el formato se detecta UNA VEZ POR ARCHIVO, y por la etiqueta.**
  //
  // Hay archivos guardados en `purchase_book_runs` con el layout viejo (P=147/M=211) y el emisor
  // ahora escribe el real (185/272). Elegir uno solo rompería la mitad.
  //
  // ⛔ La primera versión de esto detectaba **por largo de línea** y era un bug: un editor de
  // texto come los blancos del final, y una línea real recortada puede quedar más corta que 147
  // y leerse como legado — con los anchos equivocados, en silencio. Lo atrapó una aserción que
  // LC ya tenía justamente para ese caso.
  //
  // La etiqueta del movimiento SÍ es exacta y sobrevive el recorte: el formato real escribe
  // `M1`, el legado escribe `M `. Y se decide por archivo porque un archivo es homogéneo — así
  // el encabezado, que no tiene discriminante propio, hereda el del cuerpo.
  // ⚠️ El criterio va por la POSITIVA —"hay una etiqueta legada"— y no por la negativa
  // —"no hay ninguna M1"—. La diferencia aparece en un archivo que sólo trae encabezados: con
  // la negativa no hay nada que discrimine y caía a legado, rompiendo el parseo de lo que el
  // emisor acaba de escribir. El default correcto es el formato ACTUAL; el legado es la
  // excepción, y se declara sola con su etiqueta.
  const legado = lineas.some((l) => l.slice(0, 2) === 'M ');

  lineas.forEach((cruda, idx) => {
    const nro = idx + 1;
    const marca = cruda.slice(0, 1);
    const esP = marca === 'P';
    const esM = marca === 'M';
    if (!esP && !esM) {
      out.invalidos.push({ linea: nro, motivo: 'no arranca con P ni con M', texto: cruda.slice(0, 40) });
      return;
    }
    const layout = esP
      ? (legado ? LAYOUT_P_LEGACY : LAYOUT_P)
      : (legado ? LAYOUT_M_LEGACY : LAYOUT_M);
    const largo = legado ? largoLineaLegacy(layout) : largoLinea(layout);
    // Más corta se rellena: un editor de texto recorta los blancos del final y son
    // semánticamente vacíos. Más larga NO se toca — ahí sí hay algo que no entendemos.
    if (cruda.length > largo) {
      out.invalidos.push({ linea: nro, motivo: `mide ${cruda.length} y el layout pide ${largo}`, texto: cruda.slice(0, 40) });
      return;
    }
    const campos = partirLinea(layout, cruda.padEnd(largo, ' '));

    if (esP) {
      if (out.header) {
        out.invalidos.push({ linea: nro, motivo: 'segundo encabezado P en el mismo archivo', texto: cruda.slice(0, 40) });
        return;
      }
      const folio = Number(campos[3].trim());
      out.header = {
        fecha: campos[1].trim(),
        tipo_pol: campos[2].trim(),
        folio,
        concepto: campos[6].trimEnd(),
        impresa: campos[8].trim(),
        ajuste: campos[9].trim(),
        // `undefined` y no `''`: en el layout legado este campo NO EXISTE, y eso es distinto de
        // existir vacío. Colapsarlos haría que un archivo viejo se vea como uno nuevo sin guid.
        guid: campos[10] === undefined ? undefined : campos[10].trim() || undefined,
      };
      if (!Number.isFinite(folio)) {
        out.invalidos.push({ linea: nro, motivo: 'folio no numérico', texto: campos[3] });
      }
      return;
    }

    const cuenta = campos[1].trimEnd();
    const tipoMovto = campos[3].trim();
    const importe = Number(campos[4].trim());
    if (!cuenta) {
      out.invalidos.push({ linea: nro, motivo: 'movimiento sin cuenta', texto: cruda.slice(0, 40) });
      return;
    }
    // Sin default: 0 es cargo y 1 es abono, y cualquier otra cosa es un renglón que no
    // sabemos leer. Asumir "cargo" invertiría el asiento en silencio.
    if (tipoMovto !== '0' && tipoMovto !== '1') {
      out.invalidos.push({ linea: nro, motivo: `tipo de movimiento "${tipoMovto}" no es 0 ni 1`, texto: cruda.slice(0, 40) });
      return;
    }
    if (!Number.isFinite(importe)) {
      out.invalidos.push({ linea: nro, motivo: 'importe no numérico', texto: campos[4] });
      return;
    }
    out.movimientos.push({
      cuenta,
      referencia: campos[2].trimEnd(),
      abono: tipoMovto === '1',
      importe: r2(importe),
      concepto: campos[7].trimEnd(),
      // `[CP.8.5]` — se devuelve para que el round-trip siga siendo byte a byte cuando el
      // archivo SÍ trae segmento (los egresos lo traen). En los del libro de compras viene
      // vacío y vuelve a salir vacío: para LC esto no cambia un solo byte.
      seg_negocio: campos[8] === undefined ? '' : campos[8].trimEnd(),
      guid: campos[9] === undefined ? undefined : campos[9].trim() || undefined,
      fecha_aplicacion: campos[10] === undefined ? undefined : campos[10].trim() || undefined,
    });
  });

  if (!out.header && !out.invalidos.length) {
    out.invalidos.push({ linea: 0, motivo: 'el archivo no tiene encabezado P', texto: '' });
  }
  return out;
}
