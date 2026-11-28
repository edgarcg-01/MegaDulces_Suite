/**
 * `[ICR.K1]` — **Las TRES formas de documento del inventario físico de Kepler.**
 *
 * Plan: [`FASE_ICR_ANEXO_ANATOMIA_INVENTARIO_FISICO_KEPLER_2026-11-27.md`](../../../../../docs/IMPLEMENTACION/FASES/FASE_ICR_ANEXO_ANATOMIA_INVENTARIO_FISICO_KEPLER_2026-11-27.md).
 * Hermano de [`kepler-doctipo.ts`](../commercial-replenishment/kepler-doctipo.ts) (compra y
 * traspaso) y con el mismo estándar: **cada campo lleva su cifra y contra qué se midió.**
 *
 * Todo lo de este archivo se midió en `kepler_ods` (prod, `system_identifier`
 * 7688376744939610156) el **2026-11-27**, sobre los 312 `N-A-45`, 249 `N-A-30` y 227 `N-D-30` de
 * las nueve sucursales, y el documento de referencia es el inventario de **Yurécuaro (04) del
 * 17-sep-2026** (acta 1/0000003 · 1,567 renglones · $679,888.72; entrada 1/0000004 · 264 ·
 * $116,053.19; salida 1/0000003 · 346 · $64,540.70).
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ **CUÁL MUEVE LA EXISTENCIA: la entrada y la salida. El acta NO.**
 * ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * Es la pregunta que decide todo lo demás —escribir el documento equivocado, o los dos, ajusta de
 * verdad y en el ERP— y la contestan **tres testigos independientes que dicen lo mismo**:
 *
 * 1. **El kardex (`kdij`), que es el hecho.** Acotado a la ventana que el ODS replica de cada
 *    sucursal (arranca en fecha distinta por plaza: `01` el 27-jun, `06` el 14-ago, `07` el
 *    07-sep, `08` el 18-sep) y a los documentos vivos (`c43='N'`):
 *      · `N-A-45` → **0 filas de kardex en 123 de 123 actas**. Ni una.
 *      · `N-A-30` → **108 de 108** tienen kardex, con `c30='E'` (entrada).
 *      · `N-D-30` → **94 de 94** tienen kardex, con `c30='S'` (salida).
 *    Y es 1 renglón ↔ 1 fila: en Yurécuaro, 264 y 346 filas de kardex contra 264 y 346 renglones,
 *    **misma cantidad y misma unidad en las 610** (cero diferencias).
 * 2. **El catálogo (`kdmm.c8`)**, que es la bandera «afecta inventario» del propio ERP:
 *    `N-A-45` = `'N'`; `N-A-30` y `N-D-30` = `'S'`. La bandera se comporta: la trae `U-D-10`
 *    (venta POS), `U-A-50` (recepción) y `U-D-41` (embarque), y no la trae `U-D-40` (pedido).
 * 3. **La contabilidad (`kdmm.c19`/`c20`)**: el acta **no tiene cuentas**; la entrada mueve
 *    `114-001 → 114-006` y la salida `114-006 → 114-001`.
 *
 * ⭐ Y la aritmética cierra: 264 + 346 = **610** SKUs ajustados de **1,567** contados; los otros
 * 957 cuadraron y no generaron nada. Ningún SKU está en la entrada y en la salida a la vez
 * (0 de 610), y los 610 están en el acta (264/264 y 346/346).
 *
 * ⛔⛔ **La cantidad del movimiento es la DIFERENCIA, no lo contado.** Medido: 114 de los 610
 * movimientos son MAYORES que la cantidad contada del mismo SKU —imposible si fuera un absoluto—.
 * Por eso el adapter la calcula contra la existencia del propio Kepler y no la recibe hecha.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ **CÓMO SE LIGAN: por `c11`, no por `c36`…`c39`.**
 * ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * La entrada y la salida llevan **el folio del acta en `kdm1.c11`** (y también por renglón, en
 * `kdm2.c28`). No hay `c36`/`c37`/`c38`/`c39` como en la OC: esta familia liga por referencia.
 * Medido: `c11` es un folio de 7 dígitos en **243 de 249** entradas y **221 de 227** salidas, y
 * resuelve a un acta de la MISMA sucursal en 250 y 227 casos, el mismo día en 243 y 221.
 * Comparten serie (1) pero **no folio**: en Yurécuaro el acta es la 3, la entrada la 4 y la
 * salida la 3 — cada tipo tiene su propio contador.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * ⛔⛔ **QUÉ SIGNIFICA `c11` ACÁ — la trampa del carril, medida.**
 * ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * En `X-A-30` `c11` es referencia libre y en `U-D-40` es el ESTADO del flujo. Acá es **una tercera
 * cosa, y distinta entre el acta y sus movimientos**:
 *
 * | | qué es `c11` | medido |
 * |---|---|---|
 * | `N-A-45` acta | **la ZONA que se contó** — texto libre que la gente usa | 192 de 312 llenos: `T01`…`T06` (41 veces `T02`), `B01`…`B06`, `RESTOS`, `PROMO`, `GLOBO`, y nombres (`VIVI 01`, `CLAU 02`). **Cero** folios de 7 dígitos |
 * | `N-A-30` / `N-D-30` | **el FOLIO DEL ACTA** — la liga estructural | 243/249 y 221/227 son un folio de 7 dígitos |
 *
 * ⇒ **La marca de la Suite va a `c24` en los tres.** En la entrada y la salida `c11` está ocupado
 * por la liga —pisarlo deja el movimiento huérfano del acta que lo explica— y en el acta `c11` ya
 * tiene dueño: es la etiqueta de zona con la que La Piedad (02) y 8 Esquinas (03) organizan sus
 * conteos parciales (217 y 79 actas, contra 1 a 5 en las demás plazas).
 *
 * `c24` es texto libre de verdad en los tres, igual que en `U-D-40`: 33 actas, 17 entradas y 22
 * salidas lo traen, con cosas como `MATA`, `PIMENTEL`, `AJUSTE INV`, `CAPTURA VIVI` y
 * *«SE REALIZA MOV. POR ERROR AL MOMENTO DE SU SALIDA PATY PROMO»*.
 *
 * ⭐ Y la marca no es decorativa: el 2026-10-13 hubo que limpiar documentos de prueba del ERP y
 * lo único que permitió distinguirlos de los que captura la gente fue esa marca.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * ⭐ **`c43` ES EL ESTADO VIVO/CANCELADO, y se midió.**
 * ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * `c43='C'` = cancelado: **50 actas y 3 entradas**, y las 53 tienen **cero filas de kardex y
 * `c16`=0**, sin una sola excepción. `c43='N'` = vivo. Por eso el adapter lo FUERZA a `'N'`: si
 * la plantilla fuera un documento cancelado, el clon nacería cancelado y no movería nada —
 * fallaría en silencio, que es la peor forma.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────
 * ⭐ **`limpiar` ESTÁ VACÍA EN LOS TRES, y eso se midió — no se supuso.**
 * ──────────────────────────────────────────────────────────────────────────────────────────
 *
 * En `U-D-40` la lista eran los responsables de surtir/checar/embarcar (`c100`/`c102`/`c103`), que
 * el 90-91 % de los procesados traía y el 0 % de los nuevos. Acá se buscó lo mismo comparando las
 * **245 actas ya procesadas** (las que tienen un movimiento apuntándolas) contra las **67 que no**,
 * columna por columna de las 201 de `kdm1`, y **no hay ninguna que marque «ya se procesó»**:
 *
 * - Las 67 sin procesar son **borradores vacíos**: 49 no tienen un solo renglón, y las 18 que sí
 *   promedian 9 renglones contra 250 de las procesadas.
 * - Lo único que se correlacionaba (`c14` lleno en 244/245 contra 18/67) **sigue a los renglones,
 *   no al proceso**: `c14` es el IVA del acta y vale exactamente el 16 % del importe contado
 *   (679,888.72 × 0.16 = **108,782.20**, que es el `c14` de Yurécuaro al centavo).
 * - `c18`, `c41`, `c91`, `c101`, `c188`, `c191`, `c195`, `c197` aparecen en 5 de 245 con el valor
 *   `1800-01-01T00:00:00`: es **otro centinela de vacío** (el habitual es `1800-01-01T06:36:36`),
 *   y sólo en las plazas cuyo Kepler se actualizó a partir del 04-sep-2026. Es una diferencia de
 *   versión del ERP, no una huella de proceso.
 *
 * ⇒ **La huella del proceso no vive en el acta: vive en sus hijos.** Lo que dice que un acta ya se
 * procesó es que existe una entrada o una salida con su folio en `c11`. Clonar un acta procesada
 * es seguro; clonar su entrada, también.
 */

import { normalizarSucursal, valorDeEnv as val, type Env, type Resolucion } from '@megadulces/platform-core';

/** Los tres documentos de la familia. El orden del array es el orden en que se escriben. */
export type KeplerInventarioDoctipo = 'acta' | 'entrada' | 'salida';

export interface InventarioDoctipoSpec {
  /** `(c2, c3, c4)` — género · naturaleza · grupo. `c5` (serie) es siempre 1, ver `SERIE`. */
  genero: 'N';
  naturaleza: 'A' | 'D';
  grupo: string;
  /** Cómo lo llama el propio ERP (`kdmm.c5`). */
  nombreKepler: string;
  /** `c31`, la etiqueta corta. Medido: 312/312, 249/249 y 227/227. */
  etiqueta: string;
  /** `c63`, el prefijo del folio. Medido: el acta lo trae en 312/312; los movimientos lo traen VACÍO en 243/249 y 221/227. */
  prefijo: string;
  /**
   * Qué va en `c11`.
   * - `'zona'` → el acta: texto libre que describe qué se contó (o vacío).
   * - `'folio_acta'` → el movimiento: el folio del `N-A-45` que lo originó. ⛔ No tocar.
   */
  c11: 'zona' | 'folio_acta';
  /** Dónde va la marca de la Suite. **`c24` en los tres**, y por qué está arriba. */
  marca: 'c24';
  /**
   * ⛔ Columnas que un documento NUEVO debe dejar vacías porque las llena el proceso.
   * **Vacía en los tres, MEDIDO** (245 procesadas contra 67 nuevas, 201 columnas): la huella del
   * proceso no está en el documento, está en que exista un hijo que lo referencie.
   */
  limpiar: readonly string[];
  /** `true` si este documento mueve la existencia (`kdmm.c8='S'` + filas en `kdij`). */
  mueveExistencia: boolean;
  /** Variables de entorno con la coordenada del documento plantilla. */
  envSerie: string;
  envFolio: string;
  /** Llave del contador de folios en `md.sqliov` — y es literalmente `kdmm.c17`. */
  contador: string;
}

/**
 * ⭐ **La serie es 1, siempre.** Medido sobre los 2,310 documentos de la familia (312 actas, 249
 * entradas, 227 salidas y 1,522 pre-capturas `N-A-44`): `kdm1.c5 = 1` en todos, sin excepción.
 */
export const SERIE_INVENTARIO = 1;

/**
 * Prefijo con el que la Suite marca estos documentos en Kepler (`c24`). Es el folio del conteo de
 * la Suite, que ya nace con esta forma (`INV-2026-00007`, `inventory-count.service.ts`
 * `nextFolio`): no hay que inventar una marca nueva, y liga el documento del ERP con el folio que
 * la gente ve en la pantalla.
 */
export const MARCA_INVENTARIO = 'INV-';

export const DOCTIPOS_INVENTARIO: Readonly<Record<KeplerInventarioDoctipo, InventarioDoctipoSpec>> = Object.freeze({
  /** El ACTA del conteo. No mueve nada: es el registro de lo que se contó. */
  acta: {
    genero: 'N', naturaleza: 'A', grupo: '45',
    nombreKepler: 'Captura inventario físico',
    etiqueta: 'Cap', prefijo: 'NA4501-',
    c11: 'zona', marca: 'c24', limpiar: [],
    mueveExistencia: false,
    envSerie: 'KEPLER_INV_ACTA_TEMPLATE_SERIE', envFolio: 'KEPLER_INV_ACTA_TEMPLATE_FOLIO',
    contador: 'KFNA4501',
  },
  /** Los SOBRANTES: lo contado de más entra al almacén. */
  entrada: {
    genero: 'N', naturaleza: 'A', grupo: '30',
    nombreKepler: 'Entrada Inventario físico',
    etiqueta: 'Ent', prefijo: '',
    c11: 'folio_acta', marca: 'c24', limpiar: [],
    mueveExistencia: true,
    envSerie: 'KEPLER_INV_ENTRADA_TEMPLATE_SERIE', envFolio: 'KEPLER_INV_ENTRADA_TEMPLATE_FOLIO',
    contador: 'KFNA3001',
  },
  /** Los FALTANTES: lo que no apareció sale del almacén. */
  salida: {
    genero: 'N', naturaleza: 'D', grupo: '30',
    nombreKepler: 'Salida inventario físico',
    etiqueta: 'Sal', prefijo: '',
    c11: 'folio_acta', marca: 'c24', limpiar: [],
    mueveExistencia: true,
    envSerie: 'KEPLER_INV_SALIDA_TEMPLATE_SERIE', envFolio: 'KEPLER_INV_SALIDA_TEMPLATE_FOLIO',
    contador: 'KFND3001',
  },
});

/** La coordenada del documento, para mensajes y para el `WHERE`. */
export const coordenadaInventario = (t: KeplerInventarioDoctipo): string => {
  const d = DOCTIPOS_INVENTARIO[t];
  return `${d.genero}-${d.naturaleza}-${d.grupo}`;
};

/**
 * `[ICR.K2]` **El IVA del acta: 16 % del importe contado.**
 *
 * `kdm1.c14` del acta = 16 % de la suma de sus renglones, al centavo: Yurécuaro contó
 * $679,888.72 y su `c14` dice **$108,782.20**, que es exactamente `round(679888.72 × 0.16, 2)`.
 * La tasa no se inventa: la declara el propio catálogo (`kdmm.c16` = `16` para `N-A-45` y `0`
 * para `N-A-30` y `N-D-30`), y los renglones del acta la repiten en `kdm2.c17`.
 *
 * ⛔ Los movimientos van en **cero**: `c14 = 0`, y su `c16`/`c42` es el importe pelado
 * (116,053.19 y 64,540.70 en Yurécuaro, idénticos a la suma de sus renglones).
 */
export const IVA_ACTA_PCT = 16;
export const ivaDelActa = (importe: number): number => Math.round(importe * IVA_ACTA_PCT) / 100;

/**
 * `[ICR.K3]` **El TOTAL del encabezado (`c16`/`c42`), medido.**
 *
 * - Acta: **0**. Mueve papel, no dinero — y el catálogo lo confirma: `N-A-45` no tiene cuentas
 *   contables (`kdmm.c19`/`c20` vacíos). Medido: 271 de 312 actas tienen `c16 = 0`.
 * - Entrada y salida: **el importe**, y `c42 = c16`. Medido: 246/249 y 227/227 con `c16 > 0`, y
 *   `c42 = c16` en los mismos.
 */
export const totalDelEncabezado = (t: KeplerInventarioDoctipo, importe: number): number =>
  (t === 'acta' ? 0 : importe);

/**
 * Coordenada del documento plantilla de ese tipo EN ese servidor. Misma regla que
 * `plantillaDe` de la compra y el traspaso: **el folio es de ESE servidor**, sin comodines y sin
 * default — un servidor sin su variable queda APAGADO, no redirigido a oficinas.
 *
 * ⛔⛔ **Y hay tres servidores donde la SALIDA no se puede escribir todavía**, medido el
 * 2026-11-27: `00` (CEDIS), `07` y `08` **no tienen un solo `N-D-30` en toda la historia**, así
 * que no hay documento que clonar — y tampoco tienen su contador `KFND3001.NN` en `md.sqliov`.
 * Las dos cosas fallan cerrado por separado; la primera salida de esas plazas la tiene que
 * capturar una persona en Kepler, o alguien de Sistemas tiene que crear el contador.
 * Para el acta y la entrada los nueve servidores tienen candidato vivo con renglones.
 */
export function plantillaInventarioDe(
  tipo: KeplerInventarioDoctipo,
  sucursal: string,
  env: Env,
): Resolucion<{ serie: string; folio: string }> {
  const n = normalizarSucursal(sucursal);
  if (!n.ok) return n;
  const s = n.valor;
  const d = DOCTIPOS_INVENTARIO[tipo];
  const folio = val(env, `${d.envFolio}_${s}`);
  const serie = val(env, `${d.envSerie}_${s}`) || String(SERIE_INVENTARIO);
  if (!folio) {
    return {
      ok: false,
      motivo: `Falta ${d.envFolio}_${s}: no hay ${coordenadaInventario(tipo)} plantilla elegido en el servidor ${s}`,
    };
  }
  return { ok: true, valor: { serie, folio } };
}

/**
 * `[ICR.K4]` **De dónde sale la cantidad de cada movimiento.**
 *
 * `diferencia = contado − existencia de Kepler`. Positiva → va a la **entrada**; negativa → su
 * valor absoluto va a la **salida**; cero → no genera renglón.
 *
 * ⛔⛔ **La existencia es la de Kepler, leída en la misma transacción que escribe** — nunca la de
 * la Suite. `commercial.stock` está muerta por decisión (`[CANON.7.5]`, última escritura el
 * 2026-11-25 a las 16:05:04.041 en las 8 sucursales, el mismo milisegundo), y el censo de
 * `[CANON.7.4d]` midió que **el 31 % de las celdas discrepa entre las dos copias, $22.1 M**.
 * Ajustar el ERP contra un libro que no es el suyo crea la diferencia que venía a cerrar.
 *
 * La fórmula es la del ERP y la misma que publica `analytics.v_erp_stock_on_hand`:
 * `kdil.c4 (inicial) + c8 (entradas) − c9 (salidas)`, con el piso en 0. ⚠️ `kdil.c9` **no** es la
 * existencia: son las salidas (leerlo solo da razón 0.1557 contra la real).
 */
export const SQL_EXISTENCIA_KEPLER = `
  SELECT btrim(c3) AS sku, GREATEST(c4 + c8 - c9, 0)::numeric AS existencia
    FROM md.kdil
   WHERE c1 = $1 AND btrim(c3) = ANY($2)`;

export interface DiferenciaInventario {
  sku: string;
  nombre: string;
  /** Lo que se contó en el piso, en la unidad base de Kepler. */
  contado: number;
  /** Lo que Kepler creía tener en el momento de escribir. */
  existencia: number;
  /** `contado − existencia`. Positiva = sobrante, negativa = faltante. */
  diferencia: number;
}

/**
 * Reparte las líneas contadas entre acta, entrada y salida. Función pura: es la regla de negocio
 * entera y se prueba sin base de datos.
 *
 * ⭐ El acta lleva **todo lo contado**, no sólo lo que difiere — así lo hace Kepler: 1,567
 * renglones en el acta contra 610 en los movimientos.
 */
export function repartirDiferencias(filas: readonly DiferenciaInventario[]): {
  acta: DiferenciaInventario[];
  entrada: DiferenciaInventario[];
  salida: DiferenciaInventario[];
} {
  const acta = [...filas];
  const entrada = filas.filter((f) => f.diferencia > 0);
  const salida = filas.filter((f) => f.diferencia < 0);
  return { acta, entrada, salida };
}

/** La cantidad que se escribe en el renglón de cada documento: lo contado en el acta, el valor absoluto de la diferencia en los movimientos. */
export const cantidadDelRenglon = (t: KeplerInventarioDoctipo, f: DiferenciaInventario): number =>
  (t === 'acta' ? f.contado : Math.abs(f.diferencia));
