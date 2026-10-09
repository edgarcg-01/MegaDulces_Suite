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
   * ⛔ **Por qué existe este campo.** `efectivo_contado` NO es un conteo verificado: es un número
   * que el cajero DECLARA al cerrar, y medido sobre **996 cortes desde sep-2026 es idéntico al
   * esperado en el 81.2 %**. O sea que el veredicto «cuadra» salía de comparar una cifra contra
   * sí misma — una tautología, no una medición.
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
  /** `[CSU.9]` `conteo_fisico` − `efectivo_contado`. `null` si no hay conteo físico. */
  fisico_diferencia: number | null;
  /**
   * `[CSU.9]` ⛔ **El arqueo declaró lo esperado en vez de contarlo** (`efectivo_contado` ===
   * `efectivo_esperado`). Cuando es `true`, «cuadra» NO significa que cuadró: significa que nadie
   * midió. La pantalla tiene que decirlo — medido, pasa en el **81.2 %** de los cortes.
   */
  arqueo_declarado: boolean;
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
  };
  sucursales: CorteSucursalResumen[];
  cortes: CorteRow[];
  /** Cortes en blanco (monto < $1) que se dejaron fuera de la lista. Se declaran, no se esconden. */
  cortes_en_blanco: number;
  /** Fecha del corte más reciente del periodo; `null` si no hubo cortes. */
  ultimo_corte: string | null;
}
