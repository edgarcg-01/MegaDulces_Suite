/**
 * `[CSU.1]` La FORMA del wire de Cortes/Sucursales (`/finanzas/cortes-sucursales`).
 *
 * Sigue el dinero de mostrador por turno de caja: el **corte** (Kepler `U-D-23` "Corte de Caja POS",
 * que deja un cargo al cliente `CONTADO`) → los **cobros** que se le aplicaron (`U-A-5` "Cobro PUE",
 * vía `kdm5`) → el **arqueo** del mismo turno (`analytics.cash_cuts`), que es el testigo de lo que
 * el POS esperaba y de lo que el cajero contó.
 *
 * La LÓGICA (estado de cobro y veredicto del cuadre) vive en
 * `libs/finance/src/lib/cortes-sucursales/cortes-sucursales.engine.ts`; acá sólo la forma.
 */

/** Dónde va el cobro del corte. */
export type CorteEstadoCobro = 'sin_cobro' | 'parcial' | 'cobrado' | 'sobrecobrado';

/**
 * Veredicto del corte contra el arqueo de SU turno (no contra los tickets del día: un turno puede
 * cruzar la medianoche y el día daba diferencias falsas de ±$90 mil).
 *
 * `[CSU.7]` "Lo esperado" es NETO de las devoluciones pagadas en la caja del turno: el arqueo de
 * Kepler (`kdpv_folio_caja`) espera la venta bruta y el corte `U-D-23` ya descuenta las notas
 * de crédito POS. Sin restarlas, una devolución salía como "faltante" o "corte distinto".
 *  · `cuadra`          — corte = lo que el POS esperaba, neto de devoluciones (tolerancia $1).
 *  · `faltante_arqueo` — corte = lo contado, y lo contado quedó ABAJO de lo esperado.
 *  · `sobrante_arqueo` — corte = lo contado, y lo contado quedó ARRIBA de lo esperado.
 *  · `corte_distinto`  — el corte no coincide ni con lo esperado ni con lo contado.
 *  · `sin_arqueo`      — no se encontró el arqueo del turno: NO se sabe, no es "cuadra".
 */
export type CorteCuadre = 'cuadra' | 'faltante_arqueo' | 'sobrante_arqueo' | 'corte_distinto' | 'sin_arqueo';

/**
 * `[CSU.8]` Clase de la cuenta de tesorería a la que ENTRÓ el cobro — `kdm1.c45` ⋈ `kdb1`.
 *
 * ⛔ No confundir con `forma_pago`, que es cómo pagó el **cliente**. Son dos preguntas distintas:
 * un cobro con `forma_pago: 'tarjeta'` puede entrar a un banco, y uno en efectivo a `CAJA GENERAL`.
 *
 *  · `banco`        — cuenta bancaria; `cuenta_tesoreria` trae su nombre (ej. `BBVA  4885`).
 *  · `caja`         — ⭐ entró en EFECTIVO a una caja, no a un banco. Medido: **3,599 cobros por
 *                     $75,075,947.72 a `CAJA GENERAL`**, o sea ~15 %. No es un hueco: es la
 *                     respuesta.
 *  · `puente`       — cuenta que no es ni caja ni banco (`DEVOLUCIONES`, `AJUSTE A SALDO`,
 *                     `TRASPASOS DE SUCURSAL`).
 *  · `sin_declarar` — el documento no trae cuenta de tesorería. Medido: **6 de 24,763** (0.02 %).
 *  · `no_resuelve`  — trae cuenta pero no existe en `kdb1`. Medido: **cero**; existe para que el
 *                     día que aparezca se vea, en vez de colgarse del lado «banco».
 *
 * ⚠️ Las dos ausencias son DISTINTAS a propósito (ADR-056): `sin_declarar` lo arregla quien captura
 * en Kepler, `no_resuelve` lo arregla el catálogo.
 */
export type CorteMedioCobro = 'banco' | 'caja' | 'puente' | 'sin_declarar' | 'no_resuelve';

export interface CorteCobro {
  /** Prefijo del documento que abona, ej. `UA0501` (Cobro PUE). */
  doc_prefix: string;
  folio: string;
  /** `YYYY-MM-DD` del cobro; `null` si el cobro no está en `analytics.erp_collections`. */
  fecha: string | null;
  monto: number;
  forma_pago: string | null;
  concepto: string | null;
  /** `[CSU.8]` Clase de la cuenta donde entró el dinero. `null` si el cobro no está en la vista. */
  medio_cobro: CorteMedioCobro | null;
  /**
   * `[CSU.8]` Nombre de la cuenta (`kdb1.c2`): el banco del depósito, o `CAJA GENERAL` cuando entró
   * en efectivo. `null` cuando `medio_cobro` es `sin_declarar`/`no_resuelve` — o sea, **nunca se
   * dibuja un banco que no se sabe**.
   */
  cuenta_tesoreria: string | null;
}

/**
 * `[CSU.13]` Un cobro que se aplicó al corte y luego se CANCELÓ en Kepler (cabecera `kdm1.c43 = 'C'`).
 * Sale de `analytics.kepler_kdm5_cancelado`. ⛔ **No suma**: no entra a `cobrado` ni al saldo. Se publica
 * para que se vea marcado («Cancelado en Kepler — no suma») y para que el buscador lo encuentre: el PM
 * pidió omitir el MONTO, no esconder el documento.
 */
export interface CorteCobroCancelado {
  doc_prefix: string;
  folio: string;
  /** `YYYY-MM-DD` del documento cancelado (`kdm1.c9`); `null` si su cabecera no se encontró. */
  fecha: string | null;
  /** Lo que la aplicación decía (`kdm5.c13`): el monto que YA NO cuenta. */
  monto: number;
  /** Concepto que capturó Kepler en el cobro (`kdm1.c24`). */
  concepto: string | null;
}

/**
 * `[CSU.7]` Devolución pagada en la caja del turno: nota de crédito POS de Kepler, ligada al turno
 * por `kdm1.c81` (caja) y `kdm1.c80` (folio de turno). Dos documentos:
 *  · `UA2101` — "Nota Créd/Dev POS" (fiscal).
 *  · `UA2501` — "Nota Créd/Dev NoFis POS" (no fiscal).
 */
export interface CorteDevolucion {
  doc_prefix: string;
  folio: string;
  /** `YYYY-MM-DD` del documento. */
  fecha: string;
  monto: number;
  /** Nombre del cliente al que se le devolvió (`kdm1.c32`). */
  cliente: string | null;
  /** Motivo que capturó la caja (`kdm1.c24`); Kepler lo guarda cortado. */
  motivo: string | null;
  cajero: string | null;
}

export interface CorteArqueo {
  fecha: string;
  efectivo_esperado: number;
  efectivo_contado: number;
  tarjeta_esperado: number;
  tarjeta_contado: number;
  transfer_esperado: number;
  transfer_contado: number;
  /** Lo que esperaba el POS, BRUTO (sin restar devoluciones), como lo guarda Kepler. */
  esperado_total: number;
  /** `[CSU.7]` `esperado_total` − devoluciones del turno: contra esto se juzga el corte. */
  esperado_neto: number;
  contado_total: number;
  cajero: string | null;
  /**
   * `[CSU.9]` ⭐⭐ **El único efectivo que alguien contó de verdad**: billetes + monedas + lo
   * retirado durante el turno (`kdpv_folio_caja` `c43 + c44 + c48`).
   *
   * ⛔ **Por qué existe este campo.** `efectivo_contado` NO es un conteo verificado: es el contado
   * que registra Kepler al cerrar, y medido sobre **996 cortes desde sep-2026 era idéntico al
   * esperado en el 81.2 %** (85.1 % de 1,560 al 2026-10-30). O sea que el veredicto «cuadra» salía
   * de comparar una cifra contra sí misma — una tautología, no una medición. `[CSU.16]` Lo que
   * declara el cajero está en `declaracion_cajero`.
   *
   * ⭐ El conteo por denominación es el testigo independiente, y **no coincide**: de 870 cortes
   * con denominación, **409 (47.0 %) difieren** del declarado, por **$1,106,561.32** en total
   * absoluto, peor caso **$56,329.65**, neto **−$133,292.90** (la declaración SOBREDECLARA).
   *
   * ⚠️ `arqueo_otros` (`c45`) **no** entra: con él la identidad cae del 53.4 % al 19.3 %.
   *
   * `null` cuando el corte no trae denominaciones (medido: 72 de 1,125 = 6.4 %). **No se dibuja
   * como 0**, porque «no contaron» y «contaron cero» no son lo mismo (ADR-056).
   */
  conteo_fisico: number | null;
  /**
   * `conteo_fisico` − el efectivo esperado neto de devoluciones: positivo = sobra, negativo = falta.
   * `null` si no hay conteo físico. `[CSU.16]` Antes se restaba contra `efectivo_contado` (`c25`),
   * que dejó de pintarse: es un número de Kepler, no del cajero. Sale de `cuadreTurno` (`diff_kepler`).
   */
  fisico_diferencia: number | null;
  /**
   * `[CSU.9]` Kepler registró como contado (`c25`) exactamente lo esperado (`c15`). Cuando es `true`
   * y el cajero no hizo arqueo ciego, «cuadra» NO significa que cuadró: nadie midió, y la pantalla
   * lo dice. `[CSU.16]` Re-medido el 2026-10-30: pasa en **1,327 de 1,560** cortes desde sep (85.1 %).
   * El porcentaje del periodo lo da `totales.contado_igual_esperado`; no se escribe en la pantalla.
   */
  arqueo_declarado: boolean;
  /**
   * `[CSU.16]` ⭐ Lo que declaró el CAJERO, que no es lo que declara el sistema. `null` = el cajero
   * no hizo arqueo ciego de este turno (o su conteo no se pudo ligar a él): se declara, no es cero.
   */
  declaracion_cajero: CorteDeclaracionCajero | null;
  /**
   * `[CSU.16]` Retiros o cierres que se contaron en esta caja el día del turno y NO se ligaron a
   * ninguno: su folio apunta a un turno de otro momento, o no había turno a esa hora. No se usan
   * para la diferencia, pero se dicen — «sin declaración» con 6 conteos sueltos no es «nadie contó».
   */
  conteos_cajero_sin_ligar: number;
}

/**
 * `[CSU.16]` La declaración del cajero en su arqueo ciego de la Suite (`/tienda/arqueo`,
 * `reconciliation.blind_counts`): el cajón que contó al cerrar más los retiros que contó en el turno.
 *
 * ⛔ Es la otra mitad de «Esperado contra Declarado». El Esperado lo pone el sistema (Kepler `c15`);
 * el Declarado lo pone el cajero. Hasta CSU.16 la pantalla llamaba «Declarado» a `c25`, que también
 * es de Kepler y repite al esperado en el 85.1 % de los cortes: se imprimía un solo tipo dos veces.
 *
 * El conteo se liga al turno con `ligarPorCaptura` (platform-core): el folio de la captura manda
 * sólo si el turno es del día en que se capturó o del anterior. Medido el 2026-10-30, el 49 % de los
 * conteos con folio apuntaba a un turno de días antes; colgarlos de él publicaba faltantes falsos.
 */
export interface CorteDeclaracionCajero {
  /** Cajón contado al cerrar. `null` = contó retiros pero no capturó el cierre: no hay declaración completa. */
  cajon: number | null;
  /** Suma de los retiros que contó en el turno. */
  retiros: number;
  retiros_n: number;
  /** Lo que Kepler registra como retirado en el turno (`c48`): contra esto se ve si la diferencia está en los retiros o en el cajón. */
  retiros_kepler: number;
  /** Lo que Kepler registra como retirado (`c48`) y nadie contó. Se toma como bueno para cerrar la cuenta, y se dice. */
  retiros_sin_verificar: number;
  /**
   * Créditos y cheques que declaró en el cierre: papeles que están en el cajón en lugar de billetes.
   * Kepler los espera DENTRO del efectivo (`c15`): medido, cajón + retiros + créditos + cheques = c15
   * al peso en 16 de 25 cierres con su folio. 0 si no declaró ninguno.
   */
  documentos: number;
  /** Cajón + retiros contados + créditos y cheques. `null` sin cierre. */
  efectivo: number | null;
  /** Lo que declaró en el cierre. `null` = no lo declaró, que no es lo mismo que cero. */
  tarjeta: number | null;
  transferencia: number | null;
  /** Efectivo + tarjeta + transferencia; `null` si falta una forma que el sistema sí esperaba. */
  total: number | null;
  /**
   * Efectivo declarado (más los retiros sin verificar) − efectivo esperado neto de devoluciones.
   * Positivo = sobró, negativo = faltó. `null` sin cierre. Es la identidad `cuadreTurno` (`diff_real`).
   */
  diferencia: number | null;
  /**
   * ¿El cajero y el desglose de Kepler (`fisico_diferencia`) dicen lo mismo, dentro del umbral del
   * arqueo ($50)? `false` = uno de los dos conteos está mal o el conteo no es de este turno.
   * `null` si falta uno de los dos.
   */
  concuerda_con_kepler: boolean | null;
  /** Cuándo capturó el cierre (ISO); `null` sin cierre. */
  capturado_at: string | null;
  /** Cómo se ligó al turno: por el folio que trae la captura, o por caja + hora. */
  ligado: 'folio' | 'hora';
}

export interface CorteRow {
  /**
   * Llave única del corte en toda la red: `<sucursal>-<documento>`. ⚠️ El `documento` solo NO es
   * único — cada sucursal tiene su propio `UD2301-0000001`.
   */
  clave: string;
  sucursal: string;
  sucursal_nombre: string;
  /** `UD2301-0000001` — el folio con el que se ve en Kepler. */
  documento: string;
  folio: string;
  fecha: string;
  /** Texto de Kepler, ej. `Caja 4-199`. */
  referencia: string;
  caja: string | null;
  turno: string | null;
  monto: number;
  cobrado: number;
  saldo: number;
  estado_cobro: CorteEstadoCobro;
  cobros: CorteCobro[];
  /** `[CSU.13]` Cobros aplicados a este corte y cancelados en Kepler. NO suman (vacío si no hubo). */
  cobros_cancelados: CorteCobroCancelado[];
  /** `[CSU.7]` Devoluciones pagadas en la caja de este turno (vacío si no hubo). */
  devoluciones: CorteDevolucion[];
  devoluciones_total: number;
  arqueo: CorteArqueo | null;
  cuadre: CorteCuadre;
  /** Corte − esperado neto del arqueo. `null` cuando no hay arqueo. */
  diferencia: number | null;
}

export interface CorteSucursalResumen {
  sucursal: string;
  sucursal_nombre: string;
  cortes: number;
  vendido: number;
  cobrado: number;
  pendiente: number;
  sin_cobro: number;
  /** Fecha del corte más viejo con saldo; `null` si todo está cobrado. */
  abierto_desde: string | null;
  con_diferencia: number;
  sin_arqueo: number;
}

/**
 * `[CSU.6]` Qué sucursales puede ver quien consulta. Lo decide `ScopeService` (ADR-050), no la
 * pantalla: Finanzas tiene alcance `all`; encargados y auxiliares de tienda, `own` (su
 * `warehouse_code`).
 *  · `todas: true`                       → ve las 8 sucursales.
 *  · `todas: false` + `sucursales` llena → sólo ésas.
 *  · `todas: false` + `sucursales` vacía → NO tiene sucursal asignada en su ficha: no ve nada, y
 *    se le DICE (no es lo mismo que "no hubo cortes").
 */
export interface CortesAlcance {
  todas: boolean;
  sucursales: Array<{ codigo: string; nombre: string }>;
}

export interface CortesSucursalesResponse {
  periodo: { from: string; to: string };
  alcance: CortesAlcance;
  totales: {
    cortes: number;
    vendido: number;
    cobrado: number;
    pendiente: number;
    sin_cobro: number;
    con_diferencia: number;
    sin_arqueo: number;
    /** `[CSU.16]` Cortes con arqueo de Kepler cuyo contado (`c25`) es idéntico al esperado (`c15`). */
    contado_igual_esperado: number;
    /** `[CSU.16]` Cortes con declaración del cajero (arqueo ciego ligado al turno). */
    con_declaracion_cajero: number;
  };
  sucursales: CorteSucursalResumen[];
  cortes: CorteRow[];
  /** Cortes en blanco (monto < $1) que se dejaron fuera de la lista. Se declaran, no se esconden. */
  cortes_en_blanco: number;
  /** Fecha del corte más reciente del periodo; `null` si no hubo cortes. */
  ultimo_corte: string | null;
}
