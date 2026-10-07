/**
 * `[RE.25]` — **El cuadre del DOCUMENTO, no de sus renglones.**
 *
 * La auditoría renglón-por-renglón salió del alcance (decisión de Edgar, 2026-09-02): el lineado
 * se verifica ANTES de subir a Kepler, así que cuando el papel llega acá las líneas ya están
 * bien. Lo que nadie verificaba es el documento como un todo: **quién** lo emitió y **por
 * cuánto**.
 *
 * Este módulo es puro y sin dependencias a propósito: cada veredicto tiene que poder explicarse
 * con una regla y reproducirse en un test, porque decide sobre dinero. Hereda ADR-016 — el motor
 * decide, el LLM se queda leyendo el papel.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * TODO LO DE ABAJO ESTÁ MEDIDO sobre los 161 comprobantes que hay en prod (2026-09-02), no
 * supuesto. Los números importan porque explican por qué las reglas son así y no más estrictas:
 *
 *   · **El nombre del proveedor es la señal fuerte: 60/79 = 76%.**
 *   · **El RFC es la señal DÉBIL: 33/67 = 49%**, y por eso corrobora pero NUNCA es puerta.
 *     Dos causas medidas, las dos ajenas al proveedor:
 *       - Kepler lo trae poblado en el **48%** de las entradas, y con 123 RFCs para 462
 *         proveedores distintos: no es una identidad.
 *       - Está sucio en ambos lados. `NAL73213BKA` (Kepler) le falta un dígito a la fecha;
 *         `ACO1011124I1` vs `ACO101112411` es la `I`/`1` del OCR. Normalizar y plegar glifos
 *         parecidos sólo lo movió de 42% a 49%: el resto son RFCs genuinamente distintos.
 *       - Y en 5 documentos, contra **5 proveedores distintos**, el OCR leyó `LOGL851014AQ5`
 *         = *LUIS FCO. LÓPEZ GUTIÉRREZ*, que somos NOSOTROS. Confundió emisor con receptor.
 *   · **El total cuadra en 84/116 = 72%** de los que lograron leer un importe.
 *   · **44 de 161 (27%) no dieron NINGUNA señal comparable.** Ése es el bucket `sin_datos`, y
 *     existe porque llamarlos "por revisar" mezcla *"el papel dice otra cosa"* con *"no pudimos
 *     leer el papel"* — que se arreglan distinto: uno lo revisa un humano, el otro se vuelve a
 *     escanear.
 * ──────────────────────────────────────────────────────────────────────────────────────────
 */

/** Un importe iguala a otro por debajo de esto. Se sobreescribe con `receipt_settings`. */
export const TOLERANCIA_DEFAULT = 1;

/**
 * Umbral del parecido de nombres. 0.5 = la mitad de las palabras largas del nombre más corto
 * aparecen en el otro. Medido: separa *"AZTECA CONFITERIA, S.A. DE C.V."* ↔ *"AZTECA CONFITERIA
 * S.A DE CV"* (cuadra) de *"ALTOS DE LA LUZ"* ↔ *"BOLSAS DE LOS ALTOS"* (no cuadra), que era el
 * par difícil de la muestra.
 */
export const UMBRAL_NOMBRE = 0.5;

/**
 * Sufijos societarios y conectores: aportan cero identidad y todos los proveedores los comparten.
 * Sin quitarlos, *"X S.A. DE C.V."* y *"Y S.A. DE C.V."* ya arrancan pareciéndose.
 */
const SOCIETARIO =
  /\b(S\.?A\.?P?I?|DE|C\.?V\.?|R\.?L\.?|S\.?C\.?|SRL|CIA|COMPANIA|Y|INC|LTD|GRUPO|COMERCIALIZADORA|DISTRIBUIDORA)\b/g;

/**
 * Artículos y preposiciones de 3+ letras: pasan el filtro de longitud pero no distinguen a
 * nadie. Sin quitar `LOS`, *"BOLSAS DE LOS ALTOS"* le presta una palabra a cualquier nombre que
 * también lo traiga.
 */
const VACIAS = new Set(['LOS', 'LAS', 'DEL', 'CON', 'POR', 'PARA', 'SUS', 'SUC', 'THE']);

/** Normaliza un nombre: sin acentos, sin puntuación, sin sufijos societarios. */
export function normalizarNombre(s?: string | null): string | null {
  if (!s) return null;
  const n = String(s)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // marcas de acento que deja NFD
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(SOCIETARIO, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n || null;
}

/** Palabras con identidad: 3+ letras y que no sean de relleno. */
function palabras(s?: string | null): string[] {
  const n = normalizarNombre(s);
  return n ? n.split(' ').filter((t) => t.length > 2 && !VACIAS.has(t)) : [];
}

/**
 * Parecido de dos nombres, 0..1. `null` cuando falta alguno de los dos — que **no es lo mismo
 * que 0**: 0 dice "son distintos", `null` dice "no se pudo comparar", y el bucket los trata
 * diferente.
 *
 * Se divide entre el conjunto MÁS CHICO (overlap coefficient, no Jaccard) porque un proveedor se
 * factura con el nombre corto y se registra con el largo: *"AZTECA CONFITERIA"* ⊂ *"AZTECA
 * CONFITERIA DE OCCIDENTE PLANTA 2"*. Con Jaccard eso puntúa bajo por las palabras extra del
 * lado largo, y castigaría al que SÍ es el mismo.
 */
export function parecidoNombre(a?: string | null, b?: string | null): number | null {
  const A = new Set(palabras(a));
  const B = new Set(palabras(b));
  if (!A.size || !B.size) return null;
  let comunes = 0;
  for (const w of A) if (B.has(w)) comunes++;

  // ⚠️ **Una sola palabra en común NO es identidad** cuando los dos nombres tienen varias.
  // Medido: *"ALTOS DE LA LUZ"* y *"BOLSAS DE LOS ALTOS"* son proveedores distintos, comparten
  // sólo `ALTOS`, y el overlap los daba exactamente en `0.5` — o sea, cuadraban. Con evidencia
  // así de flaca se mide por Jaccard, que sí castiga lo que cada nombre tiene de propio
  // (1/3 en ese par). Si uno de los nombres es de UNA palabra, esa palabra es todo lo que hay
  // y sigue contando por overlap.
  if (comunes < 2 && A.size > 1 && B.size > 1) {
    return Number((comunes / (A.size + B.size - comunes)).toFixed(3));
  }
  return Number((comunes / Math.min(A.size, B.size)).toFixed(3));
}

/**
 * Glifos que el OCR intercambia. Se plieganizan a un representante para comparar, NUNCA para
 * guardar: el RFC que se persiste es el que se leyó.
 *
 * Sólo las confusiones que aparecieron de verdad en la muestra (`I`↔`1`, `O`↔`0`, `S`↔`5`,
 * `B`↔`8`, `Z`↔`2`, `G`↔`6`). No se agregan más "por si acaso": cada pliegue de más es un RFC
 * distinto que empieza a parecer igual, y acá un falso positivo dice *"es el proveedor correcto"*
 * sobre un documento que no lo es.
 */
const GLIFOS: Record<string, string> = { O: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };

/** RFC comparable: sin puntuación, en mayúsculas, con los glifos ambiguos plegados. */
export function rfcComparable(s?: string | null): string | null {
  if (!s) return null;
  const limpio = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!limpio) return null;
  return limpio
    .split('')
    .map((ch) => GLIFOS[ch] ?? ch)
    .join('');
}

/** RFC con forma de RFC (moral 12 / física 13). Medido: 108 de 123 de Kepler la cumplen. */
export function rfcBienFormado(s?: string | null): boolean {
  const limpio = (s || '').toUpperCase().replace(/[^A-Z0-9Ñ&]/g, '');
  return /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(limpio);
}

/**
 * Los roles de hoja que valen como **nuestra hoja interna** — el documento que prueba que la
 * mercancía se recibió contra ESTA orden de entrada. `vale` entra porque el vale de recepción
 * cumple la misma función en las sucursales que no imprimen la orden.
 */
export const HOJAS_INTERNAS = new Set(['orden_entrada', 'vale']);
const ROLES_HOJA_INTERNA = HOJAS_INTERNAS;

/**
 * ¿El paquete trae nuestra hoja interna?
 *
 * Prioriza lo **declarado** sobre lo inferido, y la diferencia está medida: el rol la encuentra
 * en 93 de 161 comprobantes, `documents_present` en 7. Si no hay roles (comprobantes viejos), se
 * cae al OCR; si tampoco hay, devuelve `null` = *"no se sabe"*, que no es lo mismo que *"falta"*.
 */
export function evaluarPaquete(
  roles?: (string | null | undefined)[] | null,
  documentosOcr?: (string | null | undefined)[] | null,
): boolean | null {
  const declarados = (roles || []).filter(Boolean).map(String);
  if (declarados.length) return declarados.some((r) => ROLES_HOJA_INTERNA.has(r));
  const docs = (documentosOcr || []).filter(Boolean).map(String);
  if (docs.length) return docs.includes('aplica_orden_entrada');
  return null;
}

/**
 * `[RE.26]` — **El número de folio, sin el prefijo del doctype.**
 *
 * Nuestra hoja interna imprime el folio como `XA2001-0000353`: `XA2001` es el **doctype** de
 * Kepler, no parte del número. Kepler guarda `0000353`. Comparar los dos crudos —o quitando
 * todo lo que no sea dígito, que pega el `2001` al número— da falso negativo.
 *
 * Se midió el costo de equivocarse: con la normalización ingenua el cruce daba **4 de 63**;
 * quitando bien el prefijo da **46 de 63 (73%)**. O sea que un normalizador flojo habría
 * declarado "el folio no coincide" en 42 expedientes correctos.
 *
 * También tolera `No. 0006668` y `Folio 353`, que es como lo imprimen algunas sucursales.
 * Devuelve el número sin ceros a la izquierda, o `null` si no hay ninguno.
 */
export function folioNumero(s?: string | null): string | null {
  if (!s) return null;
  let t = String(s).toUpperCase().trim();
  t = t.replace(/^[A-Z]{1,3}\d{3,4}\s*[-–]\s*/, ''); // XA2001-… / UD41-…
  t = t.replace(/^(NO\.?|NUM\.?|FOLIO)\s*/, ''); // "No. 0006668"
  const m = t.match(/\d{2,}/); // el primer bloque numérico largo
  return m ? m[0].replace(/^0+/, '') || '0' : null;
}

/**
 * `[RE.26.3]` — ¿lo que el OCR leyó tiene **la forma de un folio nuestro**?
 *
 * Kepler imprime el nuestro de tres maneras y ninguna trae letras sueltas ni guiones internos:
 * `XA2001-0000353`, `No. 0006668`, o `0000353` con ceros a la izquierda. Un `F 97340`, un
 * `C9500254285` o un `10-3344` son **el folio del proveedor** — el OCR los levantó de la misma
 * hoja, que suele traer los dos números.
 *
 * Medido sobre los 63 folios leídos en prod, la forma predice el resultado sin excepción:
 *
 * | forma de lo leído          | casa | NO casa |
 * |----------------------------|-----:|--------:|
 * | `XA2001-…`                 |   42 |       2 |
 * | `No. NNNN`                 |    2 |       1 |
 * | ceros a la izquierda       |    2 |       2 |
 * | ajena (letras/guiones)     |  **0** |    10 |
 * | dígitos pelados            |  **0** |     2 |
 *
 * Las dos últimas filas **nunca** aciertan: son ruido. Exigir la forma nuestra no pierde ni uno
 * de los 46 aciertos y quita **12 acusaciones falsas** de 17 — la precisión del aviso pasa de
 * 5/17 a 5/5. Un control que grita 12 veces de 17 sin razón se deja de leer, y entonces también
 * se pierden los 5 reales.
 */
function esFolioNuestro(s?: string | null): boolean {
  const t = String(s || '').toUpperCase().trim();
  if (!t) return false;
  return /^XA\d{4}\s*[-–]\s*\d+$/.test(t) // XA2001-0000353
    || /^(NO\.?|NUM\.?|FOLIO)\s*\d+$/.test(t) // "No. 0006668"
    || /^0\d+$/.test(t); // 0000353 — el cero inicial es la firma del formato de Kepler
}

/**
 * ¿El folio impreso en nuestra hoja interna es el de ESTA entrada?
 *
 * Es el control que faltaba: detecta la evidencia pegada a la orden equivocada. Medido, hay
 * casos genuinos —`0000863` contra un `XA2001-0001120`, `0003756` contra un `XA2001-0008744`.
 *
 * `null` = **no se pudo comparar**: la hoja no vino, el OCR no le leyó folio, o lo que leyó no
 * tiene forma de folio nuestro (ver `esFolioNuestro`). No es `false`, que significa "no es el de
 * esta entrada" — y acusar a un expediente correcto por un número que ni siquiera es nuestro es
 * peor que callarse.
 */
export function evaluarFolioInterno(
  folioLeido?: string | null,
  folioEntrada?: string | null,
): boolean | null {
  if (!esFolioNuestro(folioLeido)) return null;
  const a = folioNumero(folioLeido);
  const b = folioNumero(folioEntrada);
  if (!a || !b) return null;
  return a === b;
}

export interface SenalesEntrada {
  /** Total de Kepler (`c16`) — la referencia. */
  keplerMonto: number;
  /** Proveedor según Kepler. */
  keplerProveedor?: string | null;
  keplerRfc?: string | null;
  /** Lo que el OCR leyó del papel. */
  ocrTotal?: number | null;
  ocrSubtotal?: number | null;
  ocrProveedor?: string | null;
  ocrRfc?: string | null;
  /**
   * **Los roles que el capturista le puso a cada hoja al subirla** (`files[].role`), que es la
   * fuente buena para saber qué trae el paquete: es dato **declarado por una persona**, no
   * inferido por el modelo.
   *
   * Medido en prod (2026-09-02) sobre los mismos 161 comprobantes, y la diferencia no es
   * matizada: **el rol declarado encuentra la hoja interna en 93 (58%); `documents_present` en
   * 7 (4%)**. O sea que el paquete SÍ la trae y lo que falla es el reconocimiento del OCR.
   * Construir el control sobre `documents_present` reprobaba al capturista por un error del
   * modelo — que es exactamente al revés de lo que el control busca.
   */
  rolesDeclarados?: (string | null | undefined)[] | null;
  /**
   * Tipos que el OCR reconoció (`documents_present[].type`). Queda como **respaldo** para los
   * comprobantes viejos que se guardaron sin rol por hoja; nunca gana sobre lo declarado.
   */
  documentosEnPaquete?: (string | null | undefined)[] | null;
  /** Se compara contra el monto de la copia de oficinas cuando el par está vigente (RE.14.4). */
  gemelaMonto?: number | null;
  tolerancia?: number;
}

export type Cuadre = 'cuadra' | 'revisar' | 'sin_datos';

export interface SenalesCuadre {
  /** `null` = no se pudo comparar (no hay importe leído), no "no cuadra". */
  monto_match: boolean | null;
  prov_score: number | null;
  prov_rfc_match: boolean | null;
  /** ¿El paquete incluye NUESTRA hoja interna (la orden de entrada)? */
  paquete_ok: boolean | null;
  cuadre: Cuadre;
  /** Por qué cayó en ese bucket, en llano. Es lo que la fila muestra. */
  motivo: string;
}

/**
 * El veredicto del documento. **Determinista y explicable**: mismas entradas → mismo bucket, y
 * `motivo` siempre dice por qué.
 *
 * Regla de `cuadra`: **el importe cuadra Y el proveedor está corroborado** por al menos una de
 * sus dos señales. El importe solo no alcanza — dos facturas del mismo día por el mismo monto de
 * proveedores distintos cuadrarían igual, y ahí es donde se paga la factura equivocada.
 *
 * ⚠️ `paquete_ok` **NO entra en el bucket**, pero por una razón distinta de la que se creyó al
 * principio. La primera versión de esto decía *"sólo 7 de 161 paquetes traen la hoja interna,
 * exigirla mandaría el 96% a manual"* — y ese 7 salía de `documents_present`, o sea de lo que el
 * OCR **adivina**. Medido contra el rol que el capturista **declara** al subir cada hoja, la
 * traen **93 de 161 (58%)**: el paquete sí la incluye y lo que fallaba era el reconocimiento.
 *
 * Se queda fuera del bucket igual, y ahora por el motivo correcto: *"el documento no concuerda"*
 * y *"al paquete le falta una hoja"* son dos problemas distintos, con dos responsables distintos
 * y dos arreglos distintos. Mezclarlos haría que un expediente perfectamente cuadrado apareciera
 * como sospechoso de dinero. Viaja aparte como indicador de completitud — y con el 58% ya es un
 * número que se puede exigir, si se decide.
 */
export function evaluarCuadre(e: SenalesEntrada): SenalesCuadre {
  const tol = e.tolerancia ?? TOLERANCIA_DEFAULT;
  const cerca = (v: number | null | undefined, ref: number | null | undefined) =>
    v != null && ref != null && Math.abs(v - ref) <= tol;

  // El importe: total O subtotal contra Kepler. Los dos, porque el IVA puede venir incluido o no
  // según el producto (el dulce a granel suele ir a 0%), y contra la copia de oficinas cuando la
  // hay: si el papel casa con ella, el documento del proveedor está bien y lo que difiere son
  // NUESTRAS dos capturas.
  const hayImporte = e.ocrTotal != null || e.ocrSubtotal != null;
  const montoMatch = !hayImporte
    ? null
    : cerca(e.ocrTotal, e.keplerMonto) ||
      cerca(e.ocrSubtotal, e.keplerMonto) ||
      cerca(e.ocrTotal, e.gemelaMonto) ||
      cerca(e.ocrSubtotal, e.gemelaMonto);

  const provScore = parecidoNombre(e.ocrProveedor, e.keplerProveedor);

  // El RFC sólo se compara si los DOS lados tienen algo con forma de RFC. Comparar contra un
  // Kepler malformado produce un "no cuadra" que no es del proveedor sino de nuestro catálogo.
  const rfcA = rfcBienFormado(e.ocrRfc) ? rfcComparable(e.ocrRfc) : null;
  const rfcB = rfcBienFormado(e.keplerRfc) ? rfcComparable(e.keplerRfc) : null;
  const rfcMatch = rfcA && rfcB ? rfcA === rfcB : null;

  const paqueteOk = evaluarPaquete(e.rolesDeclarados, e.documentosEnPaquete);

  const provCorroborado = (provScore != null && provScore >= UMBRAL_NOMBRE) || rfcMatch === true;
  const provContradicho = rfcMatch === false || (provScore != null && provScore < UMBRAL_NOMBRE);

  // `sin_datos` primero: si no hay NADA que comparar, no es un descuadre.
  if (montoMatch === null && provScore === null && rfcMatch === null) {
    return {
      monto_match: null, prov_score: null, prov_rfc_match: null, paquete_ok: paqueteOk,
      cuadre: 'sin_datos',
      motivo: 'El OCR no pudo leer ni el importe ni el proveedor — hay que volver a escanear la hoja.',
    };
  }

  const base = { monto_match: montoMatch, prov_score: provScore, prov_rfc_match: rfcMatch, paquete_ok: paqueteOk };

  if (montoMatch === true && provCorroborado) {
    const como = rfcMatch === true ? 'RFC' : 'nombre';
    return { ...base, cuadre: 'cuadra', motivo: `El importe coincide y el proveedor también (por ${como}).` };
  }
  if (montoMatch === true && provScore === null && rfcMatch === null) {
    return { ...base, cuadre: 'revisar', motivo: 'El importe coincide, pero el OCR no leyó al proveedor: nadie confirmó de quién es la factura.' };
  }
  if (montoMatch === true && provContradicho) {
    return { ...base, cuadre: 'revisar', motivo: 'El importe coincide pero el proveedor del papel NO es el de la entrada — puede ser la factura de otra recepción.' };
  }
  if (montoMatch === false) {
    return {
      ...base, cuadre: 'revisar',
      motivo: provCorroborado
        ? 'El proveedor es el correcto pero el importe no coincide con Kepler.'
        : 'No coinciden ni el importe ni el proveedor.',
    };
  }
  // Queda: no hay importe leído pero sí algo del proveedor. Cuadrar sin importe es imposible.
  return { ...base, cuadre: 'revisar', motivo: 'El OCR no leyó el importe del papel: el total no se puede confirmar.' };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// El espejo SQL de la misma regla.
//
// Son DOS implementaciones de un solo criterio y eso es deliberado, no un descuido: la de TS
// decide al **escribir** (una remisión a la vez, con el objeto del OCR en la mano); la de SQL
// **filtra y cuenta** al leer, sobre 15,000 entradas, y eso no se puede hacer en TS sin traerse
// la tabla entera. Viven pegadas acá para que cambiar una sin la otra se vea, y el smoke
// `test-newdb-receipt-match` **compara las dos sobre las 72 combinaciones posibles** en vez de
// confiar en que sigan de acuerdo.
//
// `d.*` son los agregados del subquery de comprobantes de `list()`; `d.n` es cuántos hay.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * El bucket. Nótese el caso extra que la versión de TS no tiene: **`sin_evidencia`**. La lista
 * recorre ÓRDENES DE ENTRADA, y la mayoría todavía no tiene remisión adjunta; `evaluarCuadre()`
 * en cambio siempre parte de un comprobante que existe. Llamarlas `sin_datos` mezclaría *"no
 * subieron el papel"* con *"el papel no se pudo leer"*, que son dos trabajos distintos.
 */
export const CUADRE_SQL = `(CASE
  WHEN d.n IS NULL OR d.n = 0 THEN 'sin_evidencia'
  WHEN d.any_match IS NULL AND d.prov_score IS NULL AND d.prov_rfc_match IS NULL THEN 'sin_datos'
  WHEN d.any_match IS TRUE AND (d.prov_score >= ${UMBRAL_NOMBRE} OR d.prov_rfc_match IS TRUE) THEN 'cuadra'
  ELSE 'revisar' END)`;

/** Por qué cayó en ese bucket, en llano. Es el texto que la fila muestra. */
export const CUADRE_MOTIVO_SQL = `(CASE
  WHEN d.n IS NULL OR d.n = 0 THEN 'Todavía no se adjuntó la remisión del proveedor.'
  WHEN d.any_match IS NULL AND d.prov_score IS NULL AND d.prov_rfc_match IS NULL
    THEN 'El OCR no pudo leer ni el importe ni el proveedor — hay que volver a escanear la hoja.'
  WHEN d.any_match IS TRUE AND d.prov_rfc_match IS TRUE THEN 'El importe coincide y el proveedor también (por RFC).'
  WHEN d.any_match IS TRUE AND d.prov_score >= ${UMBRAL_NOMBRE} THEN 'El importe coincide y el proveedor también (por nombre).'
  WHEN d.any_match IS TRUE AND d.prov_score IS NULL AND d.prov_rfc_match IS NULL
    THEN 'El importe coincide, pero el OCR no leyó al proveedor: nadie confirmó de quién es la factura.'
  WHEN d.any_match IS TRUE
    THEN 'El importe coincide pero el proveedor del papel NO es el de la entrada — puede ser la factura de otra recepción.'
  WHEN d.any_match IS FALSE AND (d.prov_score >= ${UMBRAL_NOMBRE} OR d.prov_rfc_match IS TRUE)
    THEN 'El proveedor es el correcto pero el importe no coincide con Kepler.'
  WHEN d.any_match IS FALSE THEN 'No coinciden ni el importe ni el proveedor.'
  ELSE 'El OCR no leyó el importe del papel: el total no se puede confirmar.' END)`;

/**
 * El bucket a partir de las señales ya calculadas — la MISMA regla que `CUADRE_SQL`, en TS.
 * Existe para que el smoke pueda comparar las dos sin reconstruir un `SenalesEntrada` completo
 * (las señales de la DB ya vienen resueltas: no hay nombres que comparar, sólo un score).
 */
export function bucketDeSenales(s: {
  n?: number | null; any_match?: boolean | null; prov_score?: number | null; prov_rfc_match?: boolean | null;
}): Cuadre | 'sin_evidencia' {
  if (s.n == null || s.n === 0) return 'sin_evidencia';
  if (s.any_match == null && s.prov_score == null && s.prov_rfc_match == null) return 'sin_datos';
  if (s.any_match === true && ((s.prov_score != null && s.prov_score >= UMBRAL_NOMBRE) || s.prov_rfc_match === true)) return 'cuadra';
  return 'revisar';
}
