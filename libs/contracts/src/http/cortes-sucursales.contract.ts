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
  /**
   * `[CSU.26]` Dónde está este depósito: el renglón del banco, su entrada de Caja General, o por qué todavía no se
   * puede decir. `null` = **no se midió** (la consulta falló; la respuesta lo dice en `llegada`), nunca «no llegó».
   */
  llegada: CobroLlegada | null;
}

/**
 * `[CSU.26]` Dónde está un depósito aplicado al corte (anexo FB). El testigo es la conciliación de Bancos
 * (`bank_recon_matches`), no un pareo de esta pantalla:
 *  · `en_banco`          la conciliación lo casó con uno o más renglones del banco.
 *  · `en_caja_general`   el depósito a caja tiene su entrada en el libro de Caja General.
 *  · `caja_sin_asiento`  cuenta de caja sin entrada en el libro de Caja General.
 *  · `banco_sin_libro`   el libro de Bancos de esa cuenta termina ANTES del depósito: todavía no se puede saber.
 *  · `sin_conciliar`     el libro cubre la fecha y la conciliación no lo casó.
 *  · `puente`            devoluciones, ajuste a saldo, traspasos: no viaja a un banco.
 *  · `sin_cuenta`        sin cuenta de tesorería, o el depósito no está en Kepler.
 */
export type CobroLlegadaEstado =
  | 'en_banco' | 'en_caja_general' | 'caja_sin_asiento' | 'banco_sin_libro' | 'sin_conciliar' | 'puente' | 'sin_cuenta';

export interface CobroRenglonBanco {
  /** Alias de la cuenta en Bancos (`STDR 1604`). */
  cuenta: string;
  fecha: string;
  /** Lo que entró al banco en ese renglón (un abono puede cubrir varios depósitos de Kepler). */
  monto: number;
  concepto: string | null;
  /** `matched_by` de la conciliación (`motor-tes`, `motor-tes-group`…). */
  pareo: string;
  /** Pase que el motor de categoría no usa para decidir (`PASES_DEBILES`): la pantalla dice «probable». */
  debil: boolean;
}

export interface CobroAsientoCajaGeneral {
  /** Folio de la entrada (`CI-2026-00343`). */
  entrada: string;
  fecha: string;
  monto: number;
  estado: string;
  /** Corte de Caja General que la cerró (`CC-2026-00023`); `null` si sigue abierta. */
  corte: string | null;
  corte_estado: string | null;
}

export interface CobroLlegada {
  estado: CobroLlegadaEstado;
  /** Cuenta de tesorería que registró Kepler (`1604`); `null` si no trae. */
  cuenta: string | null;
  renglones: CobroRenglonBanco[];
  caja_general: CobroAsientoCajaGeneral[];
  /** La cuenta de Bancos que concilia esa cuenta de Kepler (la de más pareos), y hasta qué día llega su libro. */
  cuenta_bancos: string | null;
  libro_hasta: string | null;
}

/**
 * `[CSU.27]` ¿Llegó el dinero del corte? La primera que se cumple: `sin_deposito` (Kepler no le aplicó nada; lleva
 * su edad) → `sin_conciliar` (algo aplicado sin testigo) → `parcial` (falta depositar parte) → `por_saber` (en una
 * cuenta cuyo libro de Bancos no llega a esa fecha) → `llego`.
 */
export type CorteLlegadaEstado = 'sin_deposito' | 'sin_conciliar' | 'parcial' | 'por_saber' | 'llego';

export interface CorteLlegada {
  estado: CorteLlegadaEstado;
  /** En el banco o en Caja General, con testigo. */
  llego: number;
  /** En una cuenta cuyo libro de Bancos no llega a la fecha del depósito. */
  por_saber: number;
  /** Aplicado sin testigo: sin pareo, caja sin asiento o sin cuenta. */
  sin_conciliar: number;
  /** Devoluciones, ajuste a saldo, traspasos: no viaja a un banco. */
  puente: number;
  /** Lo que Kepler no ha aplicado: monto − aplicado. */
  sin_deposito: number;
  /** Días desde el corte (hora de México); sólo cuando falta depositar algo. */
  edad_dias: number | null;
}

/** `[CSU.27]` La venta del turno, el testigo del corte: el corte = tickets − devoluciones en 698 de 707 (nov-2026). */
export interface CorteVentaTurno {
  tickets: number;
  /** Suma de los tickets del turno. */
  total: number;
  /** Devoluciones pagadas en la caja de ese turno (CSU.7). */
  devoluciones: number;
  /** total − devoluciones. */
  neto: number;
  /** ¿El corte es la venta del turno? */
  igual_al_corte: boolean;
}

/** `[CSU.28]` Nota de crédito aplicada a una factura de contado (`UA2101` fiscal, `UA2501` no fiscal). */
export interface FacturaNotaCredito {
  doc_prefix: string;
  folio: string;
  fecha: string;
  monto: number;
  motivo: string | null;
}

/** `[CSU.28]` El ticket del que salió una factura de contado. */
export interface FacturaTicket {
  caja: string;
  folio: string;
  fecha: string;
  turno: string | null;
  total: number;
  /** `kdm1.c97` tal cual: lo que el ticket dice que se pagó y el cambio. ⛔ NO es la forma de pago. */
  pago: { pago: number; cambio: number } | null;
}

/**
 * `[CSU.30]` Por qué una factura no tiene corte:
 *  · `sin_ticket`           su ticket no está en Kepler.
 *  · `antes_del_corte_pos`  su ticket es de antes del 1-oct-2026, cuando no existía el corte POS.
 *  · `otro_periodo`         su ticket es de fuera del periodo consultado (±1 día): su corte se ve en ese periodo.
 *  · `sin_corte`            no hay corte de ese turno.
 *  · `ambiguo`              dos cortes casan con su turno (el folio de turno se repitió).
 */
export type FacturaSinCorte = 'sin_ticket' | 'antes_del_corte_pos' | 'otro_periodo' | 'sin_corte' | 'ambiguo';

/** `[CSU.30]` Una factura de contado (`U-D-5` «TK Contado», `U-D-12` «Cont No Fiscal») con su ticket, notas y corte. */
export interface FacturaContado {
  sucursal: string;
  tipo: number;
  /** Nombre del tipo en Kepler (`kdmm`). */
  tipo_nombre: string | null;
  folio: string;
  fecha: string;
  cliente: string | null;
  total: number;
  notas: FacturaNotaCredito[];
  notas_total: number;
  /** total − notas de crédito. */
  neto: number;
  ticket: FacturaTicket | null;
  /** Clave del corte de su turno en `FacturasContadoResponse.cortes`; `null` → ver `sin_corte`. */
  corte: string | null;
  sin_corte: FacturaSinCorte | null;
}

/** `[CSU.30]` El estado del corte de una factura: su llegada, por qué no tiene corte, o `no_medido`. */
export type FacturaEstadoCorte = CorteLlegadaEstado | FacturaSinCorte | 'no_medido';

/** `[CSU.30]` Un tipo de factura de contado en el periodo. */
export interface FacturasContadoTipo {
  tipo: number;
  tipo_nombre: string | null;
  facturas: number;
  monto: number;
  /** Notas de crédito aplicadas a facturas de este tipo. */
  notas: number;
  notas_monto: number;
  neto: number;
  /** Cuántas facturas y cuánto, según el estado del corte de su turno. */
  por_corte: Record<FacturaEstadoCorte, { facturas: number; monto: number }>;
}

/** `[CSU.30]` Lo del corte que necesita la factura para decir a dónde llegó (el mismo `CorteRow` de la lista). */
export type FacturaCorte = Pick<CorteRow,
  'clave' | 'sucursal' | 'documento' | 'folio' | 'fecha' | 'referencia' | 'caja' | 'turno' | 'monto' | 'cuadre' | 'diferencia'
  | 'cobros' | 'llegada' | 'venta_turno' | 'venta_sin_forma_de_pago'>;

/** `[CSU.30]` `GET /finance/cortes-sucursales/facturas`. */
export interface FacturasContadoResponse {
  periodo: { from: string; to: string };
  alcance: CortesAlcance;
  /** La sucursal pedida, o `null` = todas las visibles. */
  sucursal: string | null;
  /** El corte pedido (sus facturas del turno), o `null` = las facturas del periodo por su fecha. */
  corte: string | null;
  tipos: FacturasContadoTipo[];
  facturas: FacturaContado[];
  /** Los cortes de las facturas, una vez cada uno. */
  cortes: Record<string, FacturaCorte>;
  /** Los cortes se buscaron del periodo ±1 día: un ticket de fuera sale `otro_periodo`. */
  cortes_desde: string;
  cortes_hasta: string;
  /** `false` = la llegada de los cortes no se midió: el estado de cada factura sale `no_medido`. */
  llegada_medida: boolean;
}

/** `[CSU.29]` La llegada de todo el periodo (lo aplicado, sumado por clase) y cuántos cortes hay en cada estado. */
export interface CortesLlegadaResumen {
  /** Lo que Kepler aplicó a los cortes del periodo. */
  aplicado: number;
  llego: number;
  por_saber: number;
  sin_conciliar: number;
  puente: number;
  /** Lo que falta aplicar a los cortes del periodo. */
  sin_deposito: number;
  cortes: Record<CorteLlegadaEstado, number>;
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

/** `[CSU.24]` El desglose de Kepler en sus tres sumas (ver `CorteArqueo.desglose_kepler`). */
export interface CorteDesgloseKepler {
  billetes: number;
  monedas: number;
  retirado: number;
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
  /** Clave del cajero que cerró en Kepler (`c8`). */
  cajero: string | null;
  /** `[CSU.21]` Su nombre (`analytics.v_pos_cashiers`); `null` si el catálogo no lo tiene. */
  cajero_nombre: string | null;
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
   * `[CSU.24]` Las partes de `conteo_fisico`: billetes (`c43`) y monedas (`c44`) del cajón al cerrar y lo
   * retirado en el turno (`c48`). Suman `conteo_fisico`; `null` exactamente cuando él es `null`. Kepler
   * no guarda el conteo por denominación, sólo estas tres sumas: se comparan contra el cajero por familia.
   */
  desglose_kepler: CorteDesgloseKepler | null;
  /**
   * `[CSU.19]` Tarjeta + transferencia que Kepler tiene en el corte (`kdpv_folio_caja.c45`, «otros»):
   * = `c16 + c17` en 555 de 643 cortes de octubre. `null` si Kepler no lo trae.
   */
  electronico_kepler: number | null;
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
  /**
   * `[CSU.23]` Los retiros y el cierre que el cajero contó en ESTE turno, uno por uno y con sus piezas:
   * la evidencia de «Declarado · cajero». Del más viejo al más nuevo. Vacío = no contó nada ligado al turno.
   */
  conteos_cajero: CorteConteoCajero[];
}

/** `[CSU.23]` Una pieza contada: «Billete de $500 × 9 = $4,500». La etiqueta sale del catálogo compartido. */
export interface CorteConteoPieza {
  denom_key: string;
  etiqueta: string;
  valor: number;
  piezas: number;
  importe: number;
}

/** `[CSU.23]` Lo que el cierre declaró fuera del efectivo contado: tarjeta, transferencia, créditos, cheques. */
export interface CorteConteoMedio {
  clave: string;
  etiqueta: string;
  monto: number;
}

/**
 * `[CSU.23]` Un retiro o cierre del arqueo ciego del cajero (`reconciliation.blind_counts`), con lo que
 * contó. Medido el 2026-11-20 (30 días, 2,461 conteos): el 99.9 % guarda sus piezas; 0 tienen foto y
 * 0 los validó la encargada, por eso no viajan esos campos vacíos.
 */
export interface CorteConteoCajero {
  id: string;
  tipo: 'retiro' | 'cierre';
  /** Día y hora (`HH:MM`) de la tienda en que se capturó. */
  fecha: string;
  hora: string;
  total: number;
  /** Quién contó: nombre del usuario de la Suite, o su usuario si no tiene nombre. */
  usuario: string | null;
  nota: string | null;
  /** Vacío = el conteo no guardó piezas, que no es lo mismo que haber contado cero. */
  piezas: CorteConteoPieza[];
  /** Suma de las piezas − total. `null` sin piezas; distinto de 0 = las piezas no dan el total. */
  piezas_diferencia: number | null;
  /** Sólo el cierre: lo declarado fuera del efectivo. */
  medios: CorteConteoMedio[];
  /** Cómo se ligó al turno (`[CSU.16]`): por el folio que trae la captura, o por la hora. */
  ligado: 'folio' | 'hora';
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
  /**
   * `[CSU.24]` El cajón del cierre partido por familia, de sus piezas: lo que se compara contra los
   * billetes (`c43`) y las monedas (`c44`) de Kepler. `null` si no hay cierre, si no guardó piezas (salvo
   * el cajón vacío de $0, que es cero y cero), si una llave no está en el catálogo o si las piezas no dan
   * el total del cajón: no se adivina la parte.
   */
  cajon_billetes: number | null;
  cajon_monedas: number | null;
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
  /**
   * `[CSU.19]` Tarjeta + transferencia declaradas, JUNTAS: el campo «tarjeta» del cierre trae las dos
   * (= tarjeta + transferencia esperadas en 112 de 126 cierres de octubre). `null` si no declaró ninguna.
   */
  electronico: number | null;
  /** Efectivo + electrónico; `null` sin cierre, o si el sistema esperaba electrónico y no lo declaró. */
  total: number | null;
  /**
   * Efectivo declarado (más los retiros sin verificar) − efectivo esperado neto de devoluciones.
   * Positivo = sobró, negativo = faltó. `null` sin cierre. Es la identidad `cuadreTurno` (`diff_real`).
   */
  diferencia: number | null;
  /**
   * `[CSU.19]` El desglose de Kepler (`fisico_diferencia`) más los créditos y cheques que declaró el
   * cajero: el desglose sólo cuenta billetes y monedas. Es lo comparable con `diferencia`.
   */
  fisico_con_documentos: number | null;
  /**
   * `[CSU.19]` El desglose de Kepler deja FUERA los créditos y cheques que declaró el cajero: los dos
   * testigos sólo coinciden sumándoselos. Depende de cómo los capture cada caja en Kepler (en Padre
   * Hidalgo Caja 2 quedan fuera; en Yurécuaro Caja 3 ya vienen dentro).
   */
  creditos_fuera_del_desglose: boolean;
  /**
   * ¿El cajero y el desglose de Kepler dicen lo mismo, dentro del umbral del arqueo ($50), con o sin
   * los créditos y cheques del cajero? `false` = uno de los dos conteos está mal o el conteo no es de
   * este turno. `null` si falta uno de los dos.
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
  /**
   * `[CSU.21]` ⭐ **El corte no cuadra**, con UNA regla para toda la pantalla (indicador, «Por sucursal» y la
   * lista): el corte no coincide con lo que Kepler esperaba, o un testigo independiente —el cajero; si no
   * contó, el desglose de Kepler— se separa del esperado por `umbral_descuadre` o más. Antes el indicador
   * contaba sólo lo primero (55 en octubre) y la lista las dos (272): dos cifras del mismo hecho.
   */
  sin_cuadrar: boolean;
  /** `[CSU.27]` ¿Llegó el dinero del corte? `null` = no se midió (ver `CortesSucursalesResponse.llegada`). */
  llegada: CorteLlegada | null;
  /** `[CSU.27]` La venta del turno; `null` si no se midió, no hay tickets o el folio de turno es ambiguo. */
  venta_turno: CorteVentaTurno | null;
  /**
   * `[CSU.27]` Venta que el turno cerró sin forma de pago: sólo cuando el corte salió `corte_distinto`, ARRIBA de lo
   * esperado, y es igual a la venta del turno menos devoluciones. `null` en cualquier otro caso (sin testigo no hay causa).
   */
  venta_sin_forma_de_pago: number | null;
}

/**
 * `[CSU.20]` Por qué un conteo del cajero no está en ningún corte.
 *  · `sin_caja`            — se capturó como «Conteo de efectivo» sin caja: constancia, sin monto esperado.
 *  · `folio_de_otro_turno` — su folio apunta a un turno en el que no se capturó (ver `ligarPorCaptura`).
 *  · `sin_turno`           — sin folio, y a esa hora no había turno en esa caja.
 */
export type CorteConteoFueraMotivo = 'sin_caja' | 'folio_de_otro_turno' | 'sin_turno';

export interface CorteConteoFuera {
  sucursal: string;
  sucursal_nombre: string;
  /** Día y hora de la tienda en que se capturó. */
  fecha: string;
  hora: string;
  tipo: 'sin_caja' | 'retiro' | 'cierre';
  /** La caja que se capturó; `null` en «sin caja». */
  caja: string | null;
  total: number;
  por_que: CorteConteoFueraMotivo;
  /** Lo que escribió quien contó (el motivo de «sin caja»); `null` si no escribió nada. */
  motivo: string | null;
  /** El folio de turno que trae la captura, si trae. */
  folio: string | null;
  /** Quién contó: nombre del usuario de la Suite, o su usuario si no tiene nombre. */
  usuario: string | null;
  /** `[CSU.23]` Para abrirlo: su id, sus piezas y la nota (vacío = no guardó piezas). */
  id: string;
  piezas: CorteConteoPieza[];
  /** Suma de las piezas − total; `null` sin piezas (misma regla que `CorteConteoCajero`). */
  piezas_diferencia: number | null;
  nota: string | null;
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
  /**
   * `[CSU.29]` ¿Llegó el dinero del periodo? `null` = **no se midió** (la consulta de llegada falló): la pantalla lo
   * dice, no pinta ceros (ADR-056).
   */
  llegada: CortesLlegadaResumen | null;
  /** `[CSU.29]` Venta sin forma de pago del periodo, con testigo. `null` = la venta del turno no se midió. */
  venta_sin_forma_de_pago: { cortes: number; monto: number } | null;
  /**
   * `[CSU.20]` Efectivo que el cajero contó en el periodo y NO quedó en ningún corte: conteos «sin
   * caja» (constancias sin esperado: fondo, depósito al banco, la venta del día anterior…) y retiros o
   * cierres que no se pudieron ligar a un turno. No suman ni restan a ningún corte: se ven para que no
   * se pierdan. Fuera, a propósito: rutas RD/RV (son la liquidación de la ruta) y relevos (van en su turno).
   */
  conteos_fuera_de_corte: CorteConteoFuera[];
  /** Cortes en blanco (monto < $1) que se dejaron fuera de la lista. Se declaran, no se esconden. */
  cortes_en_blanco: number;
  /** Fecha del corte más reciente del periodo; `null` si no hubo cortes. */
  ultimo_corte: string | null;
  /**
   * `[CSU.21]` Desde cuántos pesos un testigo dice que el corte NO cuadra (`CUADRE_UMBRAL`, el mismo del
   * arqueo de tienda). Debajo es redondeo y se pinta en gris.
   */
  umbral_descuadre: number;
  /**
   * `[CSU.21]` Días en que un corte sin cobrar está EN PLAZO, no vencido. Medido en octubre: el 80 % de los
   * cortes recibió su primer cobro en 3 días o menos. Lo de adentro del plazo no se pinta como alarma.
   */
  plazo_cobro_dias: number;
}
