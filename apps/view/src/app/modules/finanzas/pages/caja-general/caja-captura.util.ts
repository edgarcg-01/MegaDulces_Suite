/**
 * CG.14 — Lógica pura de la captura de Caja General (ADR-070).
 *
 * Acá vive lo que la pantalla DECIDE: si el arqueo cuadra, si se puede guardar, y cómo se
 * le muestra al capturista de dónde salió cada campo autorrellenado. Sin Angular, sin HTTP,
 * sin DOM — para que se pueda probar de verdad y no por inspección visual.
 *
 * Las reglas de abajo son las MISMAS del backend a propósito. No es duplicación por descuido:
 * es que el capturista tiene que enterarse ANTES de mandar, no por un 400. Si alguna vez
 * divergen, la que manda es la del servidor (ahí está el candado); la de acá sólo puede ser
 * IGUAL o MÁS ESTRICTA, nunca más permisiva.
 */

import { seleccionarDenominaciones, type Denominacion, type VeredictoCorte } from '@megadulces/contracts';

/**
 * CG.23 — Los billetes que la Caja General cuenta, en el orden en que se cuentan.
 *
 * ── Qué cambió, y por qué
 *
 * Acá había un catálogo PROPIO de 14 valores sueltos
 * (`[1000, 500, …, 0.2, 0.1, 0.05]`), duplicando el que ya vive en
 * `libs/contracts/src/money/denominations.ts` y que consumen la pantalla de tienda, la de
 * almacén y `blind-count.service`. Era la misma deuda que SM.39 cerró allá y que ADR-056
 * nombra: un primitivo compartido vive en `libs/`, o queda declarado como deuda.
 *
 * Y no era sólo duplicación: el catálogo de acá está **indexado por VALOR**, que es
 * exactamente el defecto que SM.39 arregló — México tiene billete de $20 **y** moneda de
 * $20, y un número no puede distinguirlos. Acá no muerde porque la caja no desglosa
 * monedas, pero la forma equivocada invita al bug.
 *
 * ── Por qué es una SELECCIÓN y no una lista nueva
 *
 * Decisión de Edgar (2026-09-23): *"en valores, existen billetes de 500, 200, 100, 50 y 20.
 * monedas no es necesario desglosarlo. en morralla queda perfecto"*. Así que la caja cuenta
 * **cinco** denominaciones y todo el metal cae en el campo Morralla.
 *
 * Eso se expresa eligiendo llaves del catálogo compartido, NO escribiendo otra lista: si
 * mañana `BILLETES_MXN` cambia una llave, esto **revienta al construirse** en vez de dejar
 * de ofrecer un billete en silencio. Un billete que desaparece de la reja es dinero que no
 * se puede contar, y ésa es la peor forma de fallar en un arqueo.
 *
 * ⚠️ El CHECK de `finance.cash_ledger_denominations` sigue admitiendo las 14; acá se ofrecen
 * 5. Volver a ofrecer el de $1,000 es agregar su llave a esta lista — sin migración.
 */
/**
 * ⭐ 2026-10-16 — ENTRA EL DE $1,000. Pedido de Edgar. Es exactamente lo que el párrafo de
 * arriba decía que costaba: agregar su llave, sin migración, porque el CHECK de
 * `finance.cash_ledger_denominations` siempre admitió las 14.
 *
 * ⚠️ Y acá hay un hecho que conviene no perder: mientras NO estuvo ofrecido, un billete de
 * $1,000 que entraba a la caja sólo podía declararse partiéndolo en otras denominaciones o
 * cayendo en morralla — o sea, un desglose que no reconstruye lo que había en la mano. El
 * arqueo cuadraba en el total y mentía en la composición.
 */
const CAJA_BILLETES_KEYS = ['1000', '500', '200', '100', '50', '20'] as const;

/**
 * `[CG.38]` Las monedas que la caja cuenta, de la mayor a la menor.
 *
 * ── Qué cambió
 *
 * Hasta hoy todo el metal caía en el campo suelto "Morralla" — decisión de Edgar en `[CG.23]`:
 * *"monedas no es necesario desglosarlo"*. El 2026-10-06 la revirtió: *"la morralla se cuenta
 * por denominación"*, y eligió **las seis del catálogo compartido** (las mismas que ya usan
 * tienda y almacén), dejando un campo suelto para lo de menos de 50¢.
 *
 * ⚠️ `'20m'` es la moneda de $20, NO el billete. Valen lo mismo y son cosas distintas: es el
 * defecto que SM.39 arregló en el catálogo, y el que obligó a cambiarle la llave primaria a
 * `finance.cash_ledger_denominations` — con la identidad en el VALOR, estas dos pilas de dinero
 * no podían coexistir en un mismo movimiento.
 */
const CAJA_MONEDAS_KEYS = ['20m', '10', '5', '2', '1', '0.5'] as const;

/**
 * ⭐ El selector genérico **subió a `libs/contracts`** (`seleccionarDenominaciones`). Vivía acá,
 * local, mientras la caja contaba sólo billetes; al necesitar lo mismo para monedas habría
 * quedado escrito dos veces, y ADR-056 es explícito: *un mecanismo genérico vive en `libs/` o
 * queda declarado como deuda*. Estos dos envoltorios conservan el nombre y la firma de siempre
 * para no tocar a quien ya los usa.
 */
export function seleccionarBilletes(keys: readonly string[]): readonly Denominacion[] {
  return seleccionarDenominaciones(keys, 'billete');
}

export function seleccionarMonedas(keys: readonly string[]): readonly Denominacion[] {
  return seleccionarDenominaciones(keys, 'moneda');
}

/** Los cinco billetes de la caja, del mayor al menor. */
export const BILLETES_CAJA: readonly Denominacion[] = seleccionarBilletes(CAJA_BILLETES_KEYS);

/** Las seis monedas de la caja. Lo de menos de 50¢ sigue cayendo en el campo suelto. */
export const MONEDAS_CAJA: readonly Denominacion[] = seleccionarMonedas(CAJA_MONEDAS_KEYS);

/**
 * ⭐⭐ `[CGA11Y-O3b]` LA TAXONOMÍA DE LA TIRA DE ACCESOS — declarada, no inferida.
 *
 * ⛔ **Por qué es una tabla y no un `startsWith()` en la plantilla.** El grupo de un movimiento no
 * existe como dato: en `finance.v_caja_movimientos_pendientes`, `origen_tipo` se calcula como
 * `signo > 0 ? 'cobro' : 'pago_proveedor'`, o sea que es un **sinónimo del signo** y no distingue
 * nada. Medido en prod el 2026-10-16: 1,428 gasto↔`pago_proveedor` y 479 ingreso↔`cobro`, sin una
 * sola excepción. Lo que sí separa es `doc_tipo`, que es el documento de Kepler.
 *
 * **El universo completo, medido sobre 365 días (prod, `clave_banco='0011'`):**
 *
 * | doc_tipo | tipo    | movs  | importe | grupo          |
 * |----------|---------|------:|--------:|----------------|
 * | `X-D-26` | gasto   | 9,589 | $77.0 M | Egresos        |
 * | `U-A-5`  | ingreso | 3,692 | $76.6 M | Depósitos      |
 * | `X-D-60` | gasto   |    47 | $ 4.4 M | Otros egresos  |
 * | `X-A-45` | ingreso |    45 | $ 3.9 M | Otros ingresos |
 * | `U-A-25` | ingreso |     3 | $ 3.7 K | Otros ingresos |
 * | `X-D-25` | gasto   |     1 | $ 9.8 K | Otros egresos  |
 *
 * Dos doctypes se llevan el **97%** de los movimientos; los otros cuatro son cola larga y se
 * agrupan para no poner cuatro accesos con un dígito cada uno.
 *
 * ⚠️ **Lo que NO está acá, a propósito:** «Vecinal». El cierre de ruta vecinal se timbra en la
 * caja de su sucursal y llega a Caja General **como un `U-A-5` ya agregado por día y plaza**
 * (`VEC.10`). Ponerlo como acceso propio pondría 572 cierres ENCIMA de 3,648 depósitos: ~$9 M
 * contados dos veces. Va como procedencia del depósito, no como grupo.
 *
 * ⚠️ Un `doc_tipo` que no esté acá **NO se reparte a ojo**: cae en «Sin clasificar», que es un
 * acceso de primera clase. Un grupo inventado es peor que un grupo que falta (ADR-056).
 */
export interface GrupoCola { clave: string; label: string; docTipos: readonly string[]; }

export const GRUPOS_COLA: readonly GrupoCola[] = [
  { clave: 'deposito', label: 'Depósitos',      docTipos: ['U-A-5'] },
  { clave: 'egreso',   label: 'Egresos',        docTipos: ['X-D-26'] },
  { clave: 'otros_in', label: 'Otros ingresos', docTipos: ['X-A-45', 'U-A-25'] },
  { clave: 'otros_eg', label: 'Otros egresos',  docTipos: ['X-D-60', 'X-D-25'] },
];

/** La clave de «no lo sé». No es un grupo más: es la declaración de que el mapa no alcanzó. */
export const GRUPO_SIN_CLASIFICAR = 'sin_clasificar';

/** A qué grupo pertenece un `doc_tipo`. Lo que el mapa no cubre se DECLARA, no se adivina. */
export function grupoDe(docTipo: string | null | undefined): string {
  const d = String(docTipo ?? '').trim();
  if (!d) return GRUPO_SIN_CLASIFICAR;
  return GRUPOS_COLA.find((g) => g.docTipos.includes(d))?.clave ?? GRUPO_SIN_CLASIFICAR;
}

/** Largo mínimo de la glosa. Espejo del CHECK de `finance.cash_ledger`. */
export const GLOSA_MIN = 5;

/** Tolerancia del cuadre: un centavo, por el redondeo de numeric. */
export const ARQUEO_EPSILON = 0.005;

/**
 * `[CG.120]` ¿Se ofrece capturar un movimiento **a mano**, sin documento del ERP?
 *
 * **No, desde el 2026-10-19** (decisión de Edgar). Un movimiento tecleado nace sin
 * `origen_ref`, o sea sin nada contra qué cuadrarlo: no lo alcanza el candado de duplicados del
 * servidor —que es por `origen_tipo + origen_ref`—, no entra en el descuento de la cola, y en la
 * conciliación aparece como una fila que no corresponde a ningún documento. Es la única puerta
 * de esta pantalla por la que puede entrar dinero sin procedencia.
 *
 * ⛔ **Esto apaga el BOTÓN, no `abrirCaptura()`.** Esa función es la puerta compartida de cuatro
 * caminos —la cola del ERP (`capturarDesde`), la bóveda (`capturarDesdeCaos`), un recurrente sin
 * regla (`declararDesdeRecurrente`) y este botón—, así que guardarla por dentro apagaría el
 * arqueo entero. Los tres primeros SIEMPRE traen documento; el único sin procedencia es éste.
 *
 * ⚠️ Lo que NO hace: no toca el servidor. `POST /cash-ledger` sigue aceptando un movimiento sin
 * origen —`sin_documento_motivo` existe justamente para eso (`[CG.160]`)— y hay otras pantallas
 * y el lote que lo usan. Esto es una puerta de ESTA pantalla que se cierra, no una regla de
 * negocio nueva; si la regla tiene que valer para todos, va en el backend y es otro cambio.
 *
 * Volver a abrirla es poner `true` acá.
 */
export const CAPTURA_MANUAL_HABILITADA = false;

/**
 * Un renglón contado.
 *
 * ⚠️ `[CG.38]` `denom_key` es la IDENTIDAD; `denominacion` es su valor, y se conserva porque es
 * lo que suma. **No son intercambiables**: el billete y la moneda de $20 valen los dos `20` y son
 * cosas distintas, así que indexar por el número hace que una de las dos pilas desaparezca.
 */
export interface DenominacionCapturada { denom_key: string; denominacion: number; piezas: number }

export type EstadoArqueo = 'sin_desglose' | 'cuadra' | 'difiere';

export interface ResultadoArqueo {
  estado: EstadoArqueo;
  /** Lo que suma el desglose + la morralla. 0 si no hay desglose. */
  desglosado: number;
  /** desglosado − monto. Positivo = sobra en el conteo; negativo = falta. */
  diferencia: number;
}

/** Suma el desglose. Ignora renglones en cero: teclear 0 piezas es no haberlo capturado. */
export function sumaDesglose(dens: DenominacionCapturada[] | null | undefined, morralla = 0): number {
  const suma = (dens ?? [])
    .filter((d) => d && Number(d.piezas) > 0)
    .reduce((a, d) => a + Number(d.denominacion) * Number(d.piezas), 0);
  return redondea(suma + Number(morralla || 0));
}

/** Redondeo a centavos. Sin esto, 0.1+0.2 deja residuos que se ven como descuadre. */
export function redondea(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Estado del arqueo. **Sin desglose NO es "cuadra"**: es que no se contó. Esa distinción es
 * la que evita que un movimiento sin arqueo se vea igual que uno arqueado y correcto.
 */
export function estadoArqueo(
  monto: number,
  dens: DenominacionCapturada[] | null | undefined,
  morralla = 0,
  ventaCredito = 0,
  /**
   * `[CG.38]` El cambio que SALIÓ de la caja en este mismo acto. Se RESTA del desglose.
   *
   * ⛔ Sin esto, un cobro de $4,830 pagado con un billete de $5,000 bloqueaba el guardado con
   * `arqueo_no_cuadra`: el desglose sumaba 5,000 contra un monto de 4,830 y la diferencia era
   * justo el cambio devuelto. Lo encontró la prueba del envío al servidor, no la lectura.
   */
  devuelto: DenominacionCapturada[] | null | undefined = null,
): ResultadoArqueo {
  // CS.3.13 — El monto = EFECTIVO (denominaciones + morralla) + VENTA A CRÉDITO. La parte a crédito
  // no se cuenta en billetes pero es parte del total; por eso «cuenta» como desglose y su ausencia de
  // efectivo NO es «sin desglose» cuando hay crédito. `efectivo + crédito = monto`.
  const credito = Math.max(0, Number(ventaCredito) || 0);
  const conPiezas = (dens ?? []).filter((d) => d && Number(d.piezas) > 0);
  if (conPiezas.length === 0 && !Number(morralla) && credito <= 0) {
    return { estado: 'sin_desglose', desglosado: 0, diferencia: 0 };
  }
  const desglosado = redondea(sumaDesglose(dens, morralla) - sumaDesglose(devuelto, 0) + credito);
  const diferencia = redondea(desglosado - Number(monto || 0));
  return { estado: Math.abs(diferencia) <= ARQUEO_EPSILON ? 'cuadra' : 'difiere', desglosado, diferencia };
}

export interface FormularioCaja {
  tipo?: string | null;
  fecha?: string | null;
  sucursal?: string | null;
  kepler_cuenta?: string | null;
  kepler_concepto?: string | null;
  glosa?: string | null;
  monto?: number | null;
  morralla?: number | null;
  denominaciones?: DenominacionCapturada[] | null;
  /** CS.3.13 — parte a crédito (no efectivo). `efectivo + venta_credito = monto`. */
  venta_credito?: number | null;
  /** `[CG.38]` El cambio que salió de la caja en este acto. Se resta: `recibido − devuelto = monto`. */
  devuelto?: DenominacionCapturada[] | null;
  /**
   * `[CG.160]` El enlace al documento de Kepler o al movimiento del cajero. Vacío = sin conciliar,
   * y entonces hace falta decir por qué (`sin_documento_motivo`).
   */
  origen_ref?: string | null;
  /** `[CG.160]` Por qué este movimiento NO se puede enlazar. Lo exige el servidor desde `[CG.124]`. */
  sin_documento_motivo?: string | null;
}

export type MotivoBloqueo =
  | 'falta_tipo' | 'falta_fecha' | 'falta_sucursal' | 'fecha_futura'
  | 'falta_concepto' | 'falta_concepto_de_cuenta' | 'glosa_corta' | 'monto_invalido' | 'falta_desglose' | 'arqueo_no_cuadra'
  | 'falta_motivo_sin_documento';

/**
 * ⛔⛔ `[CG.160]` **Largo mínimo del motivo, ESPEJADO del servidor.**
 *
 * El servidor lo exige desde `[CG.124]` (`MOTIVO_MIN` en `caja-conciliacion.engine.ts`). ⚠️ Está
 * escrito dos veces porque `apps/view` **no puede importar de `@megadulces/finance`** —sólo
 * `contracts`, y la compuerta de fronteras lo hace cumplir—, que es la misma razón por la que
 * `VeredictoCorte` tuvo que subir a `libs/contracts`. Queda declarado como deuda: si alguien mueve
 * uno, el otro sigue siendo plausible por separado.
 *
 * ⚠️ Va ANTES de `TEXTO_BLOQUEO` a propósito: ese objeto lo interpola al construirse, y un `const`
 * declarado después queda en zona muerta temporal — el módulo reventaría al cargar.
 */
export const MOTIVO_SIN_DOC_MIN = 12;

/** Texto que ve el capturista. Dice QUÉ falta, no "formulario inválido". */
export const TEXTO_BLOQUEO: Record<MotivoBloqueo, string> = {
  falta_tipo: 'Elige el tipo de movimiento.',
  falta_fecha: 'Falta la fecha.',
  fecha_futura: 'Esa fecha es posterior a hoy. Pon el día en que se movió el efectivo: fechado adelante, '
    + 'el movimiento desaparece del libro hasta que llegue ese mes.',
  falta_sucursal: 'Falta la sucursal.',
  falta_concepto: 'Falta la cuenta y el concepto de Kepler: sin eso el movimiento no se puede contabilizar.',
  falta_concepto_de_cuenta: 'Falta el concepto de Kepler de esa cuenta: elígelo para poder contabilizar.',
  glosa_corta: `Cuenta qué pasó, con al menos ${GLOSA_MIN} caracteres. El concepto dice a qué cuenta va; esto dice qué pasó.`,
  monto_invalido: 'El monto tiene que ser mayor a cero.',
  falta_desglose: 'Cuenta el efectivo por denominación: el desglose es obligatorio, y de ahí sale el monto.',
  arqueo_no_cuadra: 'El desglose por denominación no cuadra con el monto.',
  falta_motivo_sin_documento:
    `Este movimiento no está enlazado a un documento de Kepler ni a uno del cajero. `
    + `Di por qué, con al menos ${MOTIVO_SIN_DOC_MIN} caracteres `
    + `(por ejemplo: cobranza de ruta que nadie registró en Kepler).`,
};

/**
 * ¿Se puede guardar? Devuelve TODOS los motivos, no el primero: que el capturista vea de una
 * vez lo que le falta en vez de descubrirlo de a uno.
 */
export function motivosDeBloqueo(f: FormularioCaja, hoy?: string | null): MotivoBloqueo[] {
  const m: MotivoBloqueo[] = [];
  if (!f.tipo) m.push('falta_tipo');
  if (!f.fecha) m.push('falta_fecha');
  // ⛔ Fechado DESPUÉS de hoy. Acá el freno sí es corregible: el campo de fecha del formulario es
  // editable, así que la persona lee el motivo y lo arregla sin salir de la captura — que es
  // justamente lo que el rótulo de la bandeja no ofrecía.
  //
  // `hoy` llega del llamador (día de México) y NO se lee del reloj acá: este archivo es lógica pura
  // y una prueba que dependa de qué día se corre no prueba nada. Sin `hoy` el motivo no se evalúa,
  // y por eso el candado que MANDA está en el servidor (`create()`), no acá.
  else if (hoy && String(f.fecha).slice(0, 10) > String(hoy).slice(0, 10)) m.push('fecha_futura');
  if (!f.sucursal) m.push('falta_sucursal');
  // El par va COMPLETO o no va: media cuenta no contabiliza nada. CS.3.1b — si la cuenta ya está
  // (vino del documento o se eligió) y sólo falta el concepto, se dice ESO, no "falta la cuenta":
  // decir que falta un dato presente es la mentira que esta fase vino a quitar.
  if (!f.kepler_cuenta) m.push('falta_concepto');
  else if (!f.kepler_concepto) m.push('falta_concepto_de_cuenta');
  if (!f.glosa || f.glosa.trim().length < GLOSA_MIN) m.push('glosa_corta');

  // CG.23 — El arqueo es OBLIGATORIO, no un detalle plegado. Decisión de Edgar: "el desglose
  // no es opcional". Antes el desglose era un `<details>` rotulado "(opcional)" y el monto se
  // tecleaba suelto, así que el caso normal era registrar efectivo SIN contarlo y `sin_desglose`
  // no frenaba nada. Ahora el monto SALE del conteo, así que "no contó" y "monto en cero" son
  // la misma situación — y se dice UNA vez, con el texto que sirve ("contá"), no dos.
  const arqueo = estadoArqueo(
    Number(f.monto), f.denominaciones, Number(f.morralla || 0), Number(f.venta_credito || 0), f.devuelto);
  if (arqueo.estado === 'sin_desglose') {
    m.push('falta_desglose');
  } else if (!(Number(f.monto) > 0)) {
    m.push('monto_invalido');
  }
  // Sigue vivo aunque la pantalla derive el monto del conteo: esta función es el contrato laxo
  // que consume cualquier llamador, y uno que mande monto y desglose por separado tiene que
  // chocar acá y no en un 400 del servidor.
  if (arqueo.estado === 'difiere') m.push('arqueo_no_cuadra');

  /**
   * ⛔⛔ `[CG.160]` **El servidor exigía esto y la pantalla no tenía dónde escribirlo.**
   *
   * `[CG.124]` puso la regla en el servidor: un movimiento sin `origen_ref` necesita decir por qué,
   * en al menos 12 caracteres. ⚠️ **Pero el campo nunca llegó a la pantalla** — `grep` de
   * `sin_documento_motivo` en todo `apps/view`: **cero**. Así que quien captura efectivo que no
   * tiene documento en Kepler —cobranza de ruta, por ejemplo— chocaba con un 400 que le explicaba
   * perfectamente qué hacer **y no tenía dónde hacerlo**.
   *
   * Medido en prod el 2026-10-14: de 71 movimientos vivos, 6 sin origen y **CERO** con motivo. Los
   * únicos dos que alguna vez lo trajeron los mandó una auditoría por POST a mano. Por la pantalla
   * la regla era **insatisfacible**.
   *
   * ⭐ El freno se agrega acá y no se afloja allá: la regla del servidor es correcta —un movimiento
   * sin origen y sin motivo no se puede auditar después— y lo que faltaba era la puerta. Esto sólo
   * adelanta el mismo veredicto al botón, con su texto, en vez de dejar que la persona lo descubra
   * cuando ya tecleó todo.
   */
  const tieneOrigen = String(f.origen_ref ?? '').trim().length > 0;
  const motivo = String(f.sin_documento_motivo ?? '').trim();
  if (!tieneOrigen && motivo.length < MOTIVO_SIN_DOC_MIN) m.push('falta_motivo_sin_documento');

  return m;
}

export function puedeGuardar(f: FormularioCaja, hoy?: string | null): boolean {
  return motivosDeBloqueo(f, hoy).length === 0;
}

// ── Cómo se le muestra al capturista de dónde salió un campo ────────────────────────────

export interface PropuestaVista {
  value: unknown;
  source: string | null;
  confidence: number | null;
  support?: number;
  supportRatio?: number;
  reason?: string;
}

export interface EtiquetaProcedencia {
  /**
   * 'propuesto' pinta el campo como sugerido; 'vacio' lo deja en blanco con su aviso;
   * 'manual' es lo que el humano eligió él mismo.
   *
   * ⚠️ 'manual' se agregó en CG.22 porque faltaba el tercer estado y su ausencia MENTÍA: la
   * pantalla sólo miraba la propuesta, así que después de elegir el concepto a mano en el
   * buscador seguía diciendo "Propuesto de la sesión — 12 antecedentes, 80% coinciden". La
   * etiqueta existe justamente para separar propuesto de tecleado.
   */
  tono: 'propuesto' | 'vacio' | 'manual';
  texto: string;
}

/** Lo eligió la persona. No hay procedencia que declarar más que esa. */
export function etiquetaManual(): EtiquetaProcedencia {
  return { tono: 'manual', texto: 'Elegido a mano por ti.' };
}

const TEXTO_FUENTE: Record<string, string> = {
  contexto: 'de la sesión',
  documento: 'del documento',
  aprendido: 'de lo que contabilidad ya hizo',
  regla: 'de una regla',
  ocr: 'del comprobante escaneado',
};

const TEXTO_MOTIVO: Record<string, string> = {
  sin_historia: 'Sin propuesta: no hay historia de este proveedor.',
  soporte_insuficiente: 'Sin propuesta: hay muy pocos antecedentes para arriesgar uno.',
  empate: 'Sin propuesta: los antecedentes están repartidos entre varios conceptos.',
  sin_regla: 'Sin propuesta: ninguna regla aplica.',
  sin_documento: 'Sin propuesta: no se encontró un documento de origen.',
};

/**
 * ⛔ Un campo propuesto NUNCA se muestra como si el humano lo hubiera puesto. La etiqueta
 * es la diferencia entre "el sistema sugiere esto" y "esto es un hecho": sin ella, el
 * autorrelleno se acepta sin mirarlo y cambiamos movimientos sin concepto por movimientos
 * mal clasificados (ADR-070 §8.5).
 */
/**
 * `[CG.180]` **`fuenteVacia` cambia lo que significa un `sin_historia`, y por eso entra acá.**
 *
 * «No hay historia de este proveedor» es una afirmación sobre el proveedor. Cuando la copia del
 * historial está vacía, la afirmación verdadera es sobre NOSOTROS: no hay con qué proponer. Son
 * dos hechos distintos y hasta hoy se decían con la misma frase — medido por la sesión de
 * backend, la copia llegó a prod con cero filas y el nivel «entidad» devolvía `sin_historia`
 * para TODA entidad, así que la frase era falsa en el 100 % de los casos.
 *
 * ⚠️ Sólo pisa a `sin_historia`. Los otros motivos (`empate`, `soporte_insuficiente`…) SÍ hablan
 * del proveedor y siguen siendo ciertos aunque la copia esté vacía — de hecho no pueden ocurrir
 * con la copia vacía, y si ocurren es que la propuesta vino de otro nivel.
 */
export function etiquetaProcedencia(
  p: PropuestaVista | null | undefined,
  fuenteVacia = false,
): EtiquetaProcedencia {
  if (!p || p.value === null || p.value === undefined) {
    if (fuenteVacia && p?.reason === 'sin_historia') {
      return { tono: 'vacio', texto: 'Sin propuesta: la copia del historial está vacía, así que no hay con qué proponer. No es que este beneficiario no tenga historia — lo revisa Sistemas.' };
    }
    const motivo = p?.reason ? TEXTO_MOTIVO[p.reason] : undefined;
    // Un vacío sin motivo conocido se declara como tal; NO se inventa una explicación.
    return { tono: 'vacio', texto: motivo ?? 'Sin propuesta: captúralo a mano.' };
  }
  const fuente = TEXTO_FUENTE[p.source ?? ''] ?? 'de origen no declarado';
  if (p.support && p.supportRatio) {
    const pct = Math.round(p.supportRatio * 100);
    return { tono: 'propuesto', texto: `Propuesto ${fuente} — ${p.support} antecedentes, ${pct}% coinciden.` };
  }
  return { tono: 'propuesto', texto: `Propuesto ${fuente}.` };
}

/**
 * Cobertura del catálogo, en una línea. Va SIEMPRE en pantalla: "0 conceptos" por carril
 * caído no puede leerse igual que "esta sucursal no tiene conceptos" (ADR-056).
 */
export function textoCobertura(filas: Array<{ usables: number; filas_origen: number; sin_subcuenta: number }> | null | undefined): string {
  if (!filas || filas.length === 0) return 'Cobertura del catálogo: sin medir.';
  const usables = filas.reduce((a, r) => a + Number(r.usables || 0), 0);
  const origen = filas.reduce((a, r) => a + Number(r.filas_origen || 0), 0);
  const sinSub = filas.reduce((a, r) => a + Number(r.sin_subcuenta || 0), 0);
  if (usables === 0) return `Catálogo de conceptos VACÍO (${origen} filas en el origen). Revisa el carril del ODS antes de capturar.`;
  const cola = sinSub > 0 ? ` · ${sinSub} sin subcuenta, fuera del catálogo` : '';
  return `${usables.toLocaleString('es-MX')} conceptos de ${origen.toLocaleString('es-MX')}${cola}.`;
}

// ── CG.15 · El corte de caja, del lado de la pantalla ───────────────────────────────────
//
// ⚠️ ESTO ESPEJA a `libs/finance/src/lib/caja/cash-cut.engine.ts` A PROPÓSITO, no por
// descuido: `apps/view` no puede importar de `@megadulces/finance` (sólo consume
// `contracts`, `shared-scoring` y `ui-web`, y la compuerta de fronteras lo hace cumplir).
// Existe para apagar un botón con su motivo en vez de que el usuario choque contra un 403.
// **El candado está en la DB** (`cut_doble_llave_chk`); si esto y el servidor divergen manda
// el servidor, y esto sólo puede ser IGUAL o MÁS ESTRICTO.

// `[CG.42.1]` El veredicto ya NO se espeja a mano: vive en `libs/contracts` y los dos lados lo
// importan. Escribirlo dos veces fue lo que rompió el build al agregar `sin_base` — y el comentario
// de arriba decía que espejaba "a propósito" sin que nada comprobara que seguía igual.
export type { VeredictoCorte };

export interface CorteVista {
  id: string;
  folio: string;
  estado: 'borrador' | 'cerrado' | 'autorizado';
  closed_by?: string | null;
  closed_by_username?: string | null;
  authorized_by_username?: string | null;
  /** `[CG.42]` `null` = no se midió con qué arrancó la caja. No es `0`. */
  fondo_inicial?: number | null;
  esperado?: number | null;
  contado?: number | null;
  diferencia?: number | null;
}

/**
 * ⛔ **RETIRADA (CG.19 Capa 1b) — no la vuelvas a cablear.**
 *
 * Calculaba el veredicto **en el navegador**, a partir de un `esperado` que el servidor le había
 * mandado. Eso es exactamente lo que el arqueo ciego elimina: con el esperado en el bundle,
 * ocultarlo en la plantilla no oculta nada, y la persona cuenta hasta que la diferencia dé cero.
 *
 * El veredicto ahora lo produce el SERVIDOR al **sellar** el conteo
 * (`POST /finance/cash-ledger/cortes/:id/contar` → `cash-cut.engine.ts#calcularCorte`), que es el
 * único momento en que el conteo ya no se puede retocar en silencio.
 *
 * Se deja la firma borrada a propósito en vez de dejar la función "por si acaso": una herramienta
 * que hace justo lo que el candado prohíbe es una invitación a romperlo sin querer. Lo único que
 * valía la pena de acá —que `sin_contar` es un estado propio y no `cuadra`— ya está probado del
 * lado del servidor, en `cash-cut.engine.spec.ts`.
 *
 * ⚠️ `sumaDesglose` SÍ sigue viva y es legítima: suma lo que la persona misma tecleó y no toca el
 * esperado. Es lo que la pantalla muestra mientras se cuenta a ciegas.
 */

/** La doble llave, para el botón. Devuelve el motivo, no un booleano pelado. */
export function puedeAutorizarUI(
  c: CorteVista | null, userId: string | null | undefined,
): { ok: boolean; texto: string } {
  if (!c) return { ok: false, texto: 'No hay corte.' };
  if (!userId) return { ok: false, texto: 'No se pudo identificar quién autoriza.' };
  if (c.estado === 'autorizado') {
    return { ok: false, texto: `Autorizado por ${c.authorized_by_username ?? 'otra persona'}.` };
  }
  if (c.estado !== 'cerrado') return { ok: false, texto: 'Primero hay que cerrar el corte.' };
  if (c.closed_by && c.closed_by === userId) {
    return { ok: false, texto: 'Tú cerraste este corte: tiene que autorizarlo otra persona.' };
  }
  return { ok: true, texto: `Cerrado por ${c.closed_by_username ?? 'el capturista'} — listo para autorizar.` };
}

export function puedeCerrarUI(c: CorteVista | null, veredicto: VeredictoCorte): { ok: boolean; texto: string } {
  if (!c) return { ok: false, texto: 'No hay corte abierto.' };
  if (c.estado !== 'borrador') return { ok: false, texto: 'Este corte ya está cerrado.' };
  if (veredicto === 'sin_contar') return { ok: false, texto: 'Cuenta el efectivo antes de cerrar.' };
  // Se puede cerrar aunque NO cuadre: un faltante se registra, no se esconde.
  //
  // ⛔ `[CG.42]` `sin_base` NO cae en "no cuadra". Sin saber con cuánto arrancó la caja, la
  // diferencia no mide un faltante: mide la falta del dato. Mandarla al mismo texto haría que la
  // persona saliera a buscar efectivo que nunca se perdió.
  //
  // ⚠️ Se DEJA cerrar a propósito: el servidor hoy lo permite y esta compuerta sólo puede ser
  // igual o más estricta que él. Bloquearlo acá escondería el problema en la pantalla mientras el
  // API lo sigue aceptando — y es una decisión de negocio, no de la UI.
  if (veredicto === 'sin_base') {
    return {
      ok: true,
      texto: 'Se puede cerrar, pero no se va a poder decir si cuadra: nadie midió con cuánto arrancó la caja.',
    };
  }
  // ⛔ `[CG.156]` `sin_medir` TAMPOCO cae en "no cuadra". Es un conteo que se selló cuando el
  // veredicto no se guardaba (`esperado` y `diferencia` quedaron en NULL): el efectivo se contó,
  // pero no hay con qué compararlo guardado. Dejarlo caer en la rama de abajo haría que la
  // pantalla AFIRMARA un faltante que nadie calculó — el error exacto que esta familia de
  // arreglos viene cerrando.
  if (veredicto === 'sin_medir') {
    return {
      ok: true,
      texto: 'Se contó, pero la revelación de ese conteo no quedó guardada: se puede cerrar, sin poder decir si cuadra.',
    };
  }
  // ⛔⛔ `[CG.195]` `esperado_imposible` TAMPOCO cae en "no cuadra", por la misma razón que las dos
  // de arriba: el esperado salió bajo cero y un cajón no debe dinero. La diferencia contra ese
  // número es positiva siempre, así que la rama de abajo diría «no cuadra, la diferencia queda
  // registrada» sobre un sobrante que nadie puede ir a buscar.
  //
  // ⚠️ Se DEJA cerrar, igual que `sin_base`: el servidor lo permite y esta compuerta sólo puede ser
  // igual o más estricta. Bloquearlo acá trabaría la jornada sin arreglar la cuenta, que es lo que
  // de verdad está mal.
  if (veredicto === 'esperado_imposible') {
    return {
      ok: true,
      texto: 'Se puede cerrar, pero no se va a poder decir si cuadra: la cuenta del esperado dio bajo cero y un cajón no debe dinero.',
    };
  }
  return {
    ok: true,
    texto: veredicto === 'cuadra'
      ? 'Cuadra — listo para cerrar.'
      : 'No cuadra, pero se puede cerrar: la diferencia queda registrada.',
  };
}

/**
 * El saldo. `null` NO es cero: sin corte abierto la caja no tiene punto de partida, y
 * dibujar $0.00 sería inventar un dato (ADR-056).
 */
export function textoSaldo(
  r: {
    saldo: number | null; saldo_oculto?: boolean; sin_corte_abierto?: boolean;
    corte_abierto?: { folio: string } | null;
  } | null | undefined,
): string {
  if (!r) return 'Saldo: sin medir.';
  if (r.sin_corte_abierto) return 'Saldo: sin corte abierto — la caja no tiene punto de partida.';
  /**
   * ⛔ `[CG.71]` **EL CUARTO ESTADO, QUE ACÁ SE LEÍA COMO EL SEGUNDO.**
   *
   * La respuesta distingue cuatro cosas y esta función sólo tres: con `saldo_oculto` el servidor
   * manda `saldo: null` **a propósito** —`[CG.19]`, quien captura cuenta a ciegas y el esperado se
   * revela al sellar—, y la condición de arriba lo barría junto con `sin_corte_abierto`. O sea
   * que a un cajero con su corte ABIERTO la pantalla le iba a decir *"sin corte abierto"*: no es
   * un texto impreciso, es un hecho falso, y el siguiente paso que sugiere —abrir uno— es
   * exactamente el peor sobre un corte vivo.
   *
   * Es la falla que ADR-056 nombra: dos ausencias distintas con el mismo mensaje. `null` por
   * candado y `null` por falta de punto de partida se arreglan de maneras opuestas — ésta la
   * resuelve quien autoriza; aquélla, quien abre la caja. El backend ya las separaba
   * (`saldo_oculto` vs `sin_corte_abierto`); se perdían acá, en la última traducción.
   */
  if (r.saldo_oculto) {
    return `Saldo: oculto hasta sellar el conteo (corte ${r.corte_abierto?.folio ?? '—'}).`;
  }
  if (r.saldo === null || r.saldo === undefined) return 'Saldo: sin medir.';
  const m = r.saldo.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  /**
   * ⛔⛔ `[CG.112]` **DECÍA "Saldo en caja", Y NO ES UN SALDO.**
   *
   * Edgar, con la pantalla delante: *"mi saldo en caja no se entiende"*. Tenía razón y el defecto
   * era el rótulo, no el número: esta cifra es **`esperado`** —`cash-cut.service` lo dice con
   * todas sus letras: *"`saldo` también se recorta: es literalmente `t.esperado` con otro
   * nombre"*— y el panel de la jornada publica ESE MISMO número rotulado *"Esperado en caja
   * general"*. El mismo valor con dos nombres, en la misma pantalla, a la vez.
   *
   * ⭐ Y la diferencia entre las dos palabras es la que vuelve legible un negativo: un **saldo**
   * es lo que HAY, y leer *"saldo −$125,868.34"* no tiene sentido físico. Un **esperado** es lo
   * que el libro dice que debería haber, y puede salir negativo cuando el libro arrastra
   * movimientos viejos sin cerrar — que es exactamente lo que pasa hoy.
   */
  return `Esperado en caja: ${m} (corte ${r.corte_abierto?.folio ?? '—'}).`;
}

/**
 * `[CGP-V.12]` El 409 de `cerrar()` cuando el esperado cambió desde que se contó (`[CGP-L.2]`).
 *
 * Si entró un movimiento de la jornada después de contar, el servidor ya no firma en silencio otro
 * esperado: responde 409 con las dos cifras. Esto las lee para que el diálogo de cierre las MUESTRE
 * y ofrezca confirmar la nueva; sin esto el 409 caía en un aviso de 7 s sin salida — un callejón.
 *
 * ⚠️ Sin las dos cifras numéricas devuelve `null`: no se ofrece confirmar un número que no llegó, y
 * el error sigue por el aviso normal.
 */
export interface ConflictoEsperado { mostrado: number; actual: number; mensaje: string }

export function conflictoDeEsperado(e: unknown): ConflictoEsperado | null {
  const err = e as {
    status?: number;
    error?: { motivo?: string; message?: unknown; esperado_mostrado?: unknown; esperado_actual?: unknown };
  } | null;
  if (!err || err.status !== 409 || err.error?.motivo !== 'esperado_cambio') return null;
  const mostrado = Number(err.error.esperado_mostrado);
  const actual = Number(err.error.esperado_actual);
  if (!Number.isFinite(mostrado) || !Number.isFinite(actual)) return null;
  return { mostrado, actual, mensaje: String(err.error.message ?? '') };
}

// ── `[CGP-V.1]` En qué paso va el corte ──────────────────────────────────────────────────────────

/**
 * Los pasos de un corte, en el orden de la jornada. Revisar la diferencia va aparte de cerrar
 * porque son dos decisiones: si hay diferencia se puede recontar una vez, y después ya no.
 */
export type PasoCorte = 'abrir' | 'contar' | 'revisar' | 'cerrar' | 'autorizar';

export const PASOS_CORTE: ReadonlyArray<{ paso: PasoCorte; label: string }> = [
  { paso: 'abrir', label: 'Abrir' },
  { paso: 'contar', label: 'Contar a ciegas' },
  { paso: 'revisar', label: 'Revisar la diferencia' },
  { paso: 'cerrar', label: 'Cerrar' },
  { paso: 'autorizar', label: 'Autorizar' },
];

/** Lo que hace falta saber para decir el paso. Todo sale del servidor. */
export interface EstadoParaPaso {
  /** `null` = el saldo no se pudo medir: no se sabe si hay corte abierto. */
  corteAbierto: boolean | null;
  /** El conteo sellado del corte abierto; `null` mientras nadie contó. */
  sellado: { ofreceRecontar: boolean } | null;
  /** El esperado cambió desde el conteo (el 409 de `[CGP-L.2]`). */
  conflicto: boolean;
  /** Sin corte abierto, el último corte quedó cerrado y nadie lo autorizó todavía. */
  porAutorizar: boolean;
  /** La persona eligió recontar: la reja vuelve a abrirse. */
  recontando: boolean;
}

/**
 * ⛔ Devuelve `null` cuando no se sabe si hay corte: afirmar «abrir» ahí invitaría a abrir un
 * segundo corte encima de uno vivo, que es justo lo que ese «sin medir» protege.
 */
export function pasoDelCorte(e: EstadoParaPaso): PasoCorte | null {
  if (e.corteAbierto === null) return null;
  if (!e.corteAbierto) return e.porAutorizar ? 'autorizar' : 'abrir';
  if (!e.sellado || e.recontando) return 'contar';
  if (e.conflicto || e.sellado.ofreceRecontar) return 'revisar';
  return 'cerrar';
}

/** Qué sigue, en una frase. El folio sólo se usa para nombrar el corte que falta autorizar. */
export function textoPaso(p: PasoCorte, folio?: string | null): string {
  switch (p) {
    case 'abrir': return 'No hay corte abierto: sigue abrir el de la jornada.';
    case 'contar': return 'Sigue contar el efectivo sin ver el esperado. Al guardar el conteo se revela la diferencia.';
    case 'revisar': return 'Revisa la diferencia: se puede recontar una sola vez, con motivo, o cerrar con ella.';
    case 'cerrar': return 'Sigue cerrar el corte. Después lo autoriza otra persona.';
    case 'autorizar': return `${folio ? `El corte ${folio} quedó cerrado: falta` : 'Falta'} que lo autorice otra persona, porque quien cierra no autoriza.`;
  }
}

// ── `[CGP-V.5]` El error dice lo que dijo el servidor ─────────────────────────────────────────────

/** Lo que Nest manda cuando el guardia de permisos frena: no dice nada de la regla de negocio. */
const FORBIDDEN_GENERICO = 'Forbidden resource';

/**
 * El texto de un error del servidor, para mostrarlo donde la persona lo va a leer.
 *
 * ⛔ Un 403 se pintaba siempre «No tenés permiso». Pero el 403 de autorizar trae la frase de la
 * doble llave («Quien cerró el corte no puede autorizarlo»), y taparla hacía creer que faltaba un
 * permiso. Sólo el 403 genérico del guardia (sin frase, o con la de Nest en inglés) se traduce.
 * Las frases de validación pueden venir en lista: se juntan, no se pierde ninguna.
 */
export function textoDeError(e: unknown): string {
  const err = e as { status?: number; error?: { message?: unknown } } | null;
  const crudo = err?.error?.message;
  const frase = Array.isArray(crudo)
    ? crudo.map((m) => String(m).trim().replace(/\.$/, '')).filter(Boolean).join('. ') + '.'
    : typeof crudo === 'string' ? crudo.trim() : '';
  if (err?.status === 0) return 'No hay conexión con el servidor.';
  if (err?.status === 429) return 'El servidor pidió esperar: hubo demasiadas peticiones a la vez. Reintenta en unos segundos.';
  if (err?.status === 403) return frase && frase !== FORBIDDEN_GENERICO ? frase : 'No tienes permiso para esta acción.';
  if (err?.status === 409) return frase || 'Ese movimiento ya estaba aplicado.';
  return frase || 'El servidor respondió con un error.';
}

// ── `[CGP-L.8]` Las dos pilas del detalle ──────────────────────────────────────────────────────

/**
 * Separa lo que entró del cambio que salió. El detalle del servidor trae las dos pilas en una lista
 * con su `flujo`; sin separarlas, el comprobante imprimía el cambio como recibido. Un renglón sin
 * `flujo` (un movimiento anterior a `[CG.38]`) es lo recibido. Las cifras llegan como texto (el
 * `numeric` de Postgres): se convierten.
 */
export function separarPorFlujo(
  dens: ReadonlyArray<{ denominacion: number | string; piezas: number | string; flujo?: string | null }> | null | undefined,
): { recibido: Array<{ denominacion: number; piezas: number }>; devuelto: Array<{ denominacion: number; piezas: number }> } {
  const recibido: Array<{ denominacion: number; piezas: number }> = [];
  const devuelto: Array<{ denominacion: number; piezas: number }> = [];
  for (const d of dens ?? []) {
    const r = { denominacion: Number(d.denominacion), piezas: Number(d.piezas) };
    (d.flujo === 'devuelto' ? devuelto : recibido).push(r);
  }
  return { recibido, devuelto };
}

/**
 * ⭐⭐ `[CGP-V.3b]` **¿Se puede sellar el conteo?** — la decisión, separada de la pantalla.
 *
 * Vive acá y no como un `computed` del componente por lo mismo que `puedeCerrarUI` y
 * `puedeAutorizarUI`: una regla que decide sobre dinero necesita prueba, y un `computed` dentro de
 * un componente de 8,000 líneas no la tiene.
 *
 * ── El defecto que cierra, medido en prod el 2026-10-20 ─────────────────────────────────────
 *
 * «Cerrar jornada y rendir cuentas» abre **la jornada atrasada más vieja** (`[CGP-V.3]`), no la de
 * hoy. La pantalla pide contar el efectivo **antes** de decir a qué día se pega ese conteo, así que
 * con atraso lo pega al día equivocado y nada avisa:
 *
 *     corte del 12-oct  selló $3,653.50   = el conteo del 13 (idéntico pieza por pieza)
 *     corte del 13-oct  selló $57,571.00  = el conteo del 15
 *     corte del 14-oct  selló $24,960.00  = sin corroboración en ningún lado
 *     corte del 15-oct  selló $11,820.00  = sin corroboración en ningún lado
 *     ────────────────────────────────────────────────────────────────────
 *     4 de 7 cortes con el conteo de otro día · $19,811.50 de diferencia
 *
 * ⭐ El 16 y el 17 cuadran **al centavo** contra los arqueos de Control: el procedimiento funciona
 * cuando no hay atraso. Falla exactamente en el caso que esta regla cubre.
 *
 * ⚠️ La confirmación se pide **sólo con jornada atrasada**. Pedirla todos los días la convierte en
 * un clic reflejo, y entonces no defiende nada el día que importa.
 */
export interface SellarUI {
  /** Lo que suma la reja más la morralla. */
  readonly contado: number;
  /** `[CGP-V.9]` «Conté y no hay efectivo»: un cero declarado es un conteo. */
  readonly ceroDeclarado: boolean;
  /** La jornada del corte ya pasó. */
  readonly atrasado: boolean;
  /** La persona declaró que el efectivo contado es de ESA jornada. */
  readonly jornadaConfirmada: boolean;
}

export function puedeSellarUI(i: SellarUI): { ok: boolean; motivo: 'sin_conteo' | 'jornada_sin_confirmar' | null } {
  // ⛔ El orden importa: sin conteo no hay nada que sellar, y decirle «confirmá la jornada» a
  // quien todavía no contó manda a arreglar lo que no está mal.
  if (!(Number(i.contado) > 0 || i.ceroDeclarado)) return { ok: false, motivo: 'sin_conteo' };
  if (i.atrasado && !i.jornadaConfirmada) return { ok: false, motivo: 'jornada_sin_confirmar' };
  return { ok: true, motivo: null };
}
