/**
 * `[PGP.1]` La FORMA del wire de **«a quién le falta cuenta de pago»**
 * (`GET /finance/supplier-payment-accounts/faltantes`).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────────────
 *
 * Medido en prod el 2026-10-22: `commercial.supplier_payment_accounts` tiene **cero filas**. Sin
 * cuenta destino no se puede **preparar** un pago del Calendario (`prepare()` exige cuenta del
 * catálogo o CLABE tecleada), y `releaseLot()` rechaza el día entero si queda **un solo** pago sin
 * preparar. Resultado medido: 13 pagos armados, 10 pendientes, **0 preparados, 0 autorizados, 0
 * ejecutados**, y 6 lotes parados en `draft` desde el 16-oct.
 *
 * ⭐ **Por eso esta lista no es un reporte: es la llave del circuito.** Y no hay que sembrar los
 * 169 proveedores que cobran por banco — medido jul–oct 2026 sobre $129,254,884: **10 cubren el
 * 50 % del dinero y 37 cubren el 80 %**.
 *
 * ── ⛔ Lo que esta respuesta NO trae, y por qué ──────────────────────────────────────────────
 *
 * **No trae la CLABE sugerida, ni el nombre del beneficiario según el banco.** Se midió:
 *
 *  · De 14,456 salidas bancarias desde julio, **24 (0.17 %)** traen 18 dígitos seguidos en el
 *    concepto. El estado de cuenta **no guarda la cuenta destino**, guarda el nombre.
 *  · Cruzar ese nombre contra el proveedor de Kepler por las primeras tres palabras normalizadas
 *    casa el **36.1 %** (61 de 169) — y **sin control placebo no se sabe si eso es señal o ruido**
 *    (la trampa ya cobrada en el cruce folio↔entrada: 86.7 % de señal contra 83.7 % de placebo).
 *
 * Así que en lugar de un nombre adivinado, cada renglón trae **el último pago real (fecha y monto
 * al centavo)**, que es exacto y le sirve a Tesorería para ubicar al beneficiario en la banca en
 * línea por importe. La CLABE la captura una persona; no se deriva.
 *
 * ── ⭐ El denominador ────────────────────────────────────────────────────────────────────────
 *
 * `pct_del_total` y `acumulado_pct` se calculan sobre **TODO lo pagado por banco en la ventana**,
 * no sólo sobre lo que falta. Si el denominador fuera el de los faltantes, los porcentajes
 * quedarían clavados en 100 % y **no se podría ver el avance**: lo que mide el progreso es que
 * `pct_monto_cubierto` suba conforme se siembran cuentas.
 */

/** Un proveedor al que se le paga por banco y **no** tiene cuenta activa en el catálogo. */
export interface CuentaPagoFaltante {
  /** `catalog.suppliers.id` — con esto se abre la solicitud de alta (TP.7). */
  supplier_id: string;
  /** Clave de Kepler (`C*` mercancía, `G*` servicios). Resuelve al catálogo al **100 %**: 169 de 169. */
  codigo: string;
  nombre: string;
  /** Movimientos de pago por banco en la ventana. */
  pagos: number;
  /** Σ pagado por banco en la ventana, en pesos. */
  monto: number;
  /** % de `universo.monto_total` (todo lo pagado por banco), no del monto faltante. */
  pct_del_total: number;
  /**
   * Cobertura que habría si se sembrara **hasta este renglón inclusive**: parte de
   * `universo.pct_monto_cubierto` y le suma los `pct_del_total` de arriba. Así el número sigue
   * siendo legible cuando ya hay cuentas sembradas — un acumulado que arrancara en cero diría
   * que falta más de lo que falta.
   */
  acumulado_pct: number;
  /** Fecha del último pago por banco (AAAA-MM-DD). Para ubicarlo en la banca en línea. */
  ultimo_pago_date: string;
  /** Importe de ese último pago, al centavo. Es el dato exacto; el nombre del banco no lo es. */
  ultimo_pago_monto: number;
}

/**
 * El universo de la medición. Se publica entero porque **un número sin su universo no se puede
 * verificar** (ADR-056): «faltan 169» no dice nada sin saber sobre cuántos ni en qué ventana.
 */
export interface CuentasPagoFaltantesUniverso {
  /** Ventana en días hacia atrás desde hoy. */
  dias: number;
  /** Extremos reales de la ventana (AAAA-MM-DD). */
  desde: string;
  hasta: string;
  /** Proveedores con al menos un pago por banco en la ventana. */
  proveedores_total: number;
  /** Σ pagado por banco en la ventana. Es el denominador de todos los porcentajes. */
  monto_total: number;
  /** De `proveedores_total`, los que YA tienen cuenta activa. */
  proveedores_con_cuenta: number;
  /** La parte de `monto_total` que corresponde a proveedores con cuenta. */
  monto_cubierto: number;
  /** `monto_cubierto / monto_total`. **Ésta es la métrica de avance de O1.** */
  pct_monto_cubierto: number;
  /**
   * En qué renglón de `faltantes` el acumulado llega al 80 % del dinero — o sea, cuántas cuentas
   * hay que sembrar para cubrirlo. `null` cuando no hay pagos en la ventana.
   * Medido el 2026-10-22 con `dias=120`: **37**.
   */
  corte_80pct: number | null;
  /**
   * Proveedores a los que se les pagó por banco y **no resuelven** a `catalog.suppliers` por su
   * clave de Kepler. Se declaran en vez de perderse en el `JOIN`: no se les puede abrir solicitud
   * de alta, así que son trabajo que esta pantalla **no** puede destrabar.
   * Medido el 2026-10-22 con `dias=120`: **0 de 169** — hoy resuelve el 100 %.
   */
  proveedores_sin_catalogo: number;
  /** La parte de `monto_total` de esos proveedores. Hoy: $0. */
  monto_sin_catalogo: number;
  /**
   * Cuándo se calculó por última vez el espejo de pagos del ERP (`computed_at` más reciente de la
   * ventana), en ISO. La pantalla lo publica como edad: un dato volátil sin edad **se lee como si
   * estuviera al día**. `null` = no hubo filas con las que medirlo, y entonces se dice eso, no
   * «hace un momento».
   */
  data_as_of: string | null;
}

export interface CuentasPagoFaltantesResponse {
  universo: CuentasPagoFaltantesUniverso;
  /** Ordenados por `monto` descendente: el de arriba es el que más destraba. */
  faltantes: CuentaPagoFaltante[];
}

/**
 * `[PGP.29]` (objetivo **O6**) — **La cuenta que el proveedor YA declaró, lista para solicitar.**
 *
 * ⭐ No sale de una captura ni de un correo: sale del **REP que él mismo timbró ante el SAT**
 * (`CtaBeneficiario`). Por eso trae su evidencia —qué comprobante, cuántas veces la declaró y
 * cuándo fue la última— y no sólo el número.
 *
 * ⛔⛔ **Esto PROPONE, no da de alta.** El alta sigue pasando por una solicitud que una persona
 * distinta aprueba (`requested_by` ≠ `decided_by`). Cambiar la cuenta de un proveedor es
 * exactamente el movimiento que un fraude necesita: la firma no se automatiza.
 *
 * Medido el 2026-10-28 contra prod: **22 acreedores proponibles**, 32 que sólo declararon una
 * cuenta corta, 2 con el dígito de control mal y 1 con varias CLABE distintas.
 */
export interface CuentaPagoPropuesta {
  /** Clave del acreedor en Kepler, la misma que trae `CuentaPagoFaltante.codigo`. */
  codigo: string;
  /** `catalog.suppliers.id`, cuando el acreedor resuelve al catálogo. Sin él no se puede solicitar. */
  supplier_id: string | null;
  nombre: string | null;
  /**
   * `propuesta` es el único estado accionable. Los demás **dicen por qué no** (ADR-056):
   * `varias` (declaró más de una CLABE: hay que elegir) · `control_invalido` (18 dígitos que no
   * pasan el dígito de control) · `solo_cuenta_corta` (declaró una cuenta que **no es** una
   * CLABE y **no se puede completar**: le falta la plaza) · `sin_rep` (nunca declaró una).
   */
  estado: 'propuesta' | 'varias' | 'control_invalido' | 'solo_cuenta_corta' | 'sin_rep';
  /** La CLABE de 18, con su dígito de control ya verificado. `null` salvo en `propuesta`. */
  clabe_propuesta: string | null;
  /**
   * Los 3 primeros dígitos de la CLABE: el **código** del banco, no su nombre. No hay en la casa
   * ningún catálogo que lo traduzca, así que no se inventa uno.
   */
  banco_codigo: string | null;
  /** El RFC del banco que el proveedor declaró en el comprobante, cuando lo trae. */
  banco_rfc: string | null;
  /** UUID del REP del que salió: es la evidencia que se adjunta a la solicitud. */
  rep_uuid: string | null;
  /** Cuántos comprobantes suyos declaran esta misma cuenta. Más veces, más confianza. */
  veces_declarada: number | null;
  /** La última vez que la declaró, ISO. Una cuenta vieja merece más revisión que una reciente. */
  ultima_vez: string | null;
  /** El RFC con el que se encontró su comprobante. */
  rfc: string | null;
  /**
   * De dónde salió ese RFC (`[PGP.27]`). `nombre` quiere decir que **Kepler no lo tiene, o lo
   * tiene mal escrito**, y lo resolvió un cruce del nombre. Quien firma el alta tiene derecho a
   * saberlo: la pantalla no lo presenta como dato del ERP.
   */
  rfc_fuente: 'kepler' | 'nombre' | 'ninguna';
  /** Por qué no se puede proponer. `null` cuando sí se puede. Nunca un hueco mudo (ADR-056). */
  motivo: string | null;
}
