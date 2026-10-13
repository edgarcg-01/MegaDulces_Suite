import type { CampoFijo } from '../purchase-book/poliza-txt';
import { LAYOUT_P, LAYOUT_M, SEP } from '../purchase-book/poliza-txt';

/**
 * Fase CP `[CP.8.12]` — **Los parámetros del TXT, puestos por nosotros y declarados uno por uno.**
 *
 * ── Por qué existe este archivo ─────────────────────────────────────────────────────────────
 * Edgar, 2026-10-08: *"necesito que nosotros pongamos los parámetros, ¿por qué necesitas leer un
 * txt de lo que debes de saber?"*. Tenía razón y corrige un error mío de encuadre: **el layout
 * NO es una ley de ContPAQi**. ContPAQi lee el TXT según un archivo de esquema que vive en la
 * instalación de la empresa (`C:\Compac\Empresas\Esquemas\Contpaq\CT_EST_Poliza_NG.xls`). O sea
 * que es **configuración, no arqueología**: se decide, no se adivina.
 *
 * Lo que este archivo cambia es la naturaleza del problema. Antes: *"no sabemos el formato"*.
 * Ahora: *"éstos son los parámetros, con su estado y su dueño"*. Un ancho que se confirme deja
 * de ser un cambio de código y pasa a ser un cambio de una línea acá.
 *
 * ── Los TRES estados, y por qué no son dos ──────────────────────────────────────────────────
 *   `decidido` — lo fijamos nosotros y no depende de nadie más (ej: el tipo de póliza, el token).
 *   `heredado` — viene del esquema que la empresa YA usa. No lo podemos cambiar sin romper las
 *                109,305 pólizas que entran por ahí. Es el que hay que CONFIRMAR, no inventar.
 *   `en_disputa` — dos fuentes dan números distintos y ninguna es el esquema real.
 *
 * ⛔ Un `en_disputa` **no se resuelve votando** ni eligiendo el más nuevo: se resuelve mirando el
 * esquema de la empresa o importando un archivo. Lo que sí se puede hacer sin eso es ELEGIR qué
 * camino tomamos (§ `ESTRATEGIA`), y eso es una decisión de negocio, no técnica.
 */

export type EstadoParam = 'decidido' | 'heredado' | 'en_disputa';

export interface Param<T> {
  valor: T;
  estado: EstadoParam;
  /** Quién o qué lo sostiene. Nunca vacío: un parámetro sin respaldo es una suposición. */
  respaldo: string;
}

const p = <T>(valor: T, estado: EstadoParam, respaldo: string): Param<T> => ({ valor, estado, respaldo });

/**
 * ⭐ **LA decisión que destraba todo, y es de negocio.**
 *
 *  `alinear`  — nos acomodamos al esquema que la empresa ya usa. La contadora no cambia nada,
 *               pero hay que CONFIRMAR tres anchos (ver `EN_DISPUTA`). Riesgo: bajo. Costo:
 *               una mirada al esquema, o una importación de prueba.
 *
 *  `propio`   — agregamos un esquema NUESTRO para el flujo del puente. Definimos los anchos
 *               enteros y nadie los discute. ContPAQi admite varios formatos de importación.
 *               Riesgo: hay que darlo de alta en la instalación (una vez). Costo: cero dudas
 *               después.
 *
 * ⚠️ Lo que NO se puede: emitir con anchos inventados contra el esquema existente y esperar que
 * funcione. Si `clase` mide 4 y mandamos 1, todo el renglón se corre y ContPAQi lee basura.
 */
export const ESTRATEGIA = p<'alinear' | 'propio'>(
  'alinear',
  'decidido',
  'RESUELTO con el archivo real: ya sabemos exactamente qué formato usa la empresa, así que ' +
    '`propio` perdió su único motivo (evitar dudas). Alinearse no toca el flujo de la contadora ' +
    'ni exige dar de alta un esquema nuevo en la instalación.',
);

/**
 * ⭐⭐ **RESUELTO 2026-10-08 — con un archivo REAL, no con fuentes.**
 *
 * `02-evaluar-esquema.ps1` encontró una **exportación de pólizas de ContPAQi** en esta misma
 * máquina. Es el árbitro que faltaba, y es definitivo por dos razones: la aritmética de los
 * anchos **cierra exacto** (P=185, M=272 derivados == reales), y el contenido **cruza contra la
 * base** — los 14 `Guid` de `P` existen en `Polizas`, los 82 de `M1` en `MovimientosPoliza`, y
 * los 62 UUID de `AD` resuelven a 234 filas de `AsocCFDIs`.
 *
 * **Quién tenía razón, campo por campo:**
 *
 * | Campo | Nuestro layout | Fuente externa | **REAL** | |
 * |---|--:|--:|--:|---|
 * | `clase` (P) | 1 | 4 | **1** | ⭐ teníamos razón nosotros |
 * | `referencia` (M) | 10 | 30 | **30** | la fuente externa tenía razón |
 * | `seg_negocio` (M) | 10 | — | **4** | se equivocaban los dos |
 * | `fecha_aplicacion` (M) | no existe | 8 | **8, y va en el M** | existe, pero no donde decían |
 *
 * **Y tres cosas que NADIE había visto, que son las que de verdad rompían el archivo:**
 *  1. Cada renglón lleva su **`Guid` de 36** al final (el de `Polizas` / `MovimientosPoliza`).
 *  2. **Toda línea termina en un espacio.** Verificado en las 232 del archivo.
 *  3. La etiqueta del movimiento es **`M1`**, no `M ` como escribíamos.
 */
export const RESUELTO_CON_ARCHIVO_REAL = {
  archivo: 'database/tests/fixtures/poliza-contpaqi-real-2026-09.txt (NO se publica: repo público)',
  largo_P: 185,
  largo_M: 272,
  cruce: '14/14 Polizas.Guid · 82/82 MovimientosPoliza.Guid · 62 AD -> 234 AsocCFDIs',
} as const;

// ──────────────────────────────────────────────────────────────────────────────────────────────
// LOS PARÁMETROS
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Separador entre campos. ⭐ **Esto SÍ quedó resuelto**: dos fuentes independientes coinciden en
 * que es un espacio, lo que descarta la hipótesis de concatenación pura que la cabecera de
 * `poliza-txt.ts` declaraba como la duda principal.
 */
export const SEPARADOR = p(SEP, 'heredado', 'dos fuentes independientes + el layout que ya usa LC');

/** `SistOrig`. Medido: las 110,633 pólizas de la empresa lo tienen en 11, sin excepción. */
export const SIST_ORIG = p('11', 'heredado', 'medido 2026-10-08: 110,633 de 110,706 pólizas en 11');

/**
 * Tipo de póliza por flujo del puente. **Decidido por nosotros.** No se deriva del contenido:
 * el libro de compras también carga a cuentas 5xxx y es Diario, así que "carga a gasto = egreso"
 * sería falso.
 */
export const TIPO_POLIZA = {
  egreso: p(2, 'decidido', 'ContPAQi: 1 Ingreso · 2 Egreso · 3 Diario · 4 Orden'),
  libro_compras: p(3, 'heredado', 'lo que la contadora ya usa: Diario folio 1, 20 meses verificados'),
} as const;

/**
 * Folio. ⭐ **Decidido: 0 = que ContPAQi asigne el suyo.** Pelearnos con su numeración sería
 * pedirle a su sistema que respete una secuencia nuestra; para reconocer el asiento de vuelta
 * está el token, que no le pide nada a nadie.
 */
export const FOLIO = p(0, 'decidido', 'no controlamos su numeración; el token hace la correlación');

/**
 * El token de correlación. **Decidido entero por nosotros**, y por eso es la pieza más sólida
 * del puente: no depende de ninguna duda de formato.
 *
 * `MD:` + 8 hex = 11 caracteres. Entra junto al UUID del CFDI (36) en los 100 del concepto.
 * El prefijo `MD:` existe para poder buscarlo con `LIKE 'MD:%'` y, el día que haga falta,
 * indexarlo parcialmente sin tocar el resto.
 */
export const TOKEN = {
  prefijo: p('MD:', 'decidido', 'prefijo buscable; permite índice parcial sin tocar el resto'),
  // ⛔ Era 8 con un respaldo MAL RAZONADO — ver `token.ts`. El universo medido son 55,369
  // movimientos bancarios (no "~5k"), y comparar el tamaño del espacio contra el volumen es el
  // error clásico del cumpleaños: lo que importa es `n²/2N`. Con 8 hex daba 35.7% de colisión, y
  // el candado lo comprobó generando el universo real: **1 colisión de verdad**.
  largo_hex: p(12, 'decidido',
    'medido: 12 hex sobre 55,369 eventos reales da 0 colisiones; con 8 da 1. Cuesta 4 caracteres'),
  donde: p<'concepto_encabezado'>('concepto_encabezado', 'decidido',
    'el carril de vuelta trae `gl_polizas.concepto` cada minuto'),
} as const;

/**
 * Segmento de negocio. Medido: el renglón del gasto SÍ lo lleva (`IdSegNeg=8` en traslado de
 * efectivo), el del IVA y el del banco van en 0.
 *
 * ⚠️ Pero el 97.6% de los movimientos de la empresa va con `IdSegNeg=0`, así que **mandarlo no
 * es obligatorio**. Se manda cuando lo sabemos y se omite cuando no — nunca se inventa.
 */
export const SEG_NEGOCIO = p<'cuando_se_sabe'>('cuando_se_sabe', 'decidido',
  'medido: 97.6% de los movimientos van en 0; inventar un segmento sería peor que omitirlo');

/**
 * ⭐⭐ Renglones `AD ` + UUID. **La decisión de más valor del archivo, y hoy está APAGADA.**
 *
 * Dos fuentes describen que el formato transporta el UUID del CFDI con renglones `AD ` ubicados
 * después del `P`. Si es cierto, los **0 de 33,303 movimientos sin asociar en cinco años** no
 * son una limitación del formato: son renglones que nadie emitió.
 *
 * ⛔ Arranca en `false` **a propósito**: prenderlo sin confirmar que el esquema de la empresa los
 * acepta haría que ContPAQi rechace el archivo entero, y el flujo del libro de compras mueve
 * $30–56M al mes. Es un interruptor, no una pregunta abierta: se prende el día que se confirme.
 */
export const EMITE_AD_UUID = p(false, 'decidido',
  'CONFIRMADO con el archivo real: 62 renglones `AD ` + UUID de 40 chars, que cruzan a 234 filas ' +
  'de AsocCFDIs. El formato SÍ los lleva. Sigue en `false` porque el emisor todavía NO los ' +
  'escribe — es trabajo pendiente, ya no una duda. Implementarlo cierra el 0% de UUID sin SDK.');

// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PerfilLayout {
  nombre: string;
  P: readonly CampoFijo[];
  M: readonly CampoFijo[];
  sep: string;
  sist_orig: string;
  emite_ad_uuid: boolean;
}

/**
 * El perfil que usa el libro de compras HOY. **Es el estado actual, byte por byte** — existe
 * para que cualquier cambio del puente se mida contra él y no lo mueva.
 */
export const PERFIL_ACTUAL: PerfilLayout = {
  nombre: 'actual',
  P: LAYOUT_P,
  M: LAYOUT_M,
  sep: SEPARADOR.valor,
  sist_orig: SIST_ORIG.valor,
  emite_ad_uuid: false,
};

/**
 * El perfil del puente. **Hoy es idéntico al actual a propósito**: mientras `ESTRATEGIA` sea
 * `alinear`, emitir distinto sería emitir mal. Cuando se resuelva, los cambios van ACÁ y el
 * libro de compras no se entera.
 */
export const PERFIL_PUENTE: PerfilLayout = {
  ...PERFIL_ACTUAL,
  nombre: 'puente',
  emite_ad_uuid: EMITE_AD_UUID.valor,
};

/**
 * ⭐ **El layout REAL de ContPAQi**, medido del archivo de exportación y cruzado contra la base.
 *
 * ⛔⛔ **`[CP.8.39]` — esto era una SEGUNDA declaración de los mismos anchos, y ya había
 * divergido.** Hasta el 2026-10-12 este archivo repetía la lista campo por campo, y cuando
 * `[CP.8.28]` corrigió el emisor —`sist_orig` de 2 a 3, sin separador después de `concepto`—
 * **la copia se quedó con la versión vieja**.
 *
 * ⭐ Y era invisible: las dos suman **185** (`174 + 11` separadores contra `175 + 10`), así que
 * el único candado que las miraba comparaba **el total** y pasaba en verde. Es exactamente la
 * lección que `[CP.8.28]` escribió dos secciones antes — *un total que cuadra no prueba que los
 * campos estén donde van*— aplicada al archivo que el plan señalaba como «el layout correcto».
 *
 * Y es exactamente el síntoma que `[CP.8.5]` predijo al rechazar un segundo serializador:
 * *«dos verdades sobre el mismo formato, y el síntoma aparece el día que alguien corrija un
 * ancho»*. Alguien corrigió un ancho.
 *
 * **Ahora los anchos viven UNA sola vez**, en `poliza-txt.ts`. Estos nombres se conservan porque
 * el candado del sink los cita, pero son alias, no una copia.
 *
 * ⚠️ **Cada renglón termina en UN ESPACIO** — verificado en las 232 líneas del archivo. Por eso
 * el largo es `Σanchos + nSeparadores` contando el final, y no `Σanchos + (nCampos − 1)` como
 * asumía el emisor viejo. ⛔ `nSeparadores` **no** es `nCampos`: los campos con `sinSep` no
 * llevan uno (hoy, `concepto` del encabezado). Para medir, `largoLinea()` — nunca una suma a mano.
 */
export const LAYOUT_REAL_P: readonly CampoFijo[] = LAYOUT_P;

export const LAYOUT_REAL_M: readonly CampoFijo[] = LAYOUT_M;

/** `AD ` + UUID(36) + espacio = 40. Asocia el CFDI; cruza a `AsocCFDIs.UUID`. */
export const LARGO_AD = 40;

/**
 * ⛔ **`AM`: 170 renglones de 40 chars que NO se pudieron explicar.** Sus guids **no** son
 * `MovimientosPoliza.Guid` ni `AsocCFDIs.GuidRef` — se cruzaron los dos y dieron **0**. Se
 * DECLARA sin interpretar (ADR-056): el archivo trae además renglones `AP`, `I`, `V` y `W2`,
 * que tampoco se decodificaron. Nada de eso hace falta para emitir una póliza, pero **no se
 * debe asumir que son opcionales** hasta medirlo.
 */
export const RENGLONES_SIN_DECODIFICAR = ['AM', 'AP', 'I', 'V', 'W2'] as const;

/** Todo lo que falta decidir, confirmar o construir, en un solo lugar y con dueño. */
export function pendientes() {
  const out: { que: string; estado: EstadoParam; respaldo: string }[] = [];
  const revisar = (nombre: string, par: Param<unknown>) => {
    if (par.estado !== 'decidido') out.push({ que: nombre, estado: par.estado, respaldo: par.respaldo });
  };
  revisar('ESTRATEGIA (alinear vs propio)', ESTRATEGIA);
  revisar('EMITE_AD_UUID', EMITE_AD_UUID);
  out.push({
    que: 'el emisor todavía escribe el layout VIEJO',
    estado: 'decidido',
    respaldo: `mide P=147/M=211 y el real es P=${RESUELTO_CON_ARCHIVO_REAL.largo_P}/` +
      `M=${RESUELTO_CON_ARCHIVO_REAL.largo_M}. Ya no es una duda: es trabajo.`,
  });
  out.push({
    que: `renglones sin decodificar: ${RENGLONES_SIN_DECODIFICAR.join(', ')}`,
    estado: 'en_disputa',
    respaldo: 'aparecen en el archivo real y no se sabe qué son; los guids de AM no cruzan con nada',
  });
  return out;
}
