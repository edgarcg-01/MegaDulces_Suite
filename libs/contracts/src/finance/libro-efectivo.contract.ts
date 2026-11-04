/**
 * `[LE.2.2]` — El contrato del libro de efectivo de partida doble (Fase LE, ADR-102/103).
 *
 * Lo que la API manda a `cashbook.post_entry` / `create_request`, las cuentas que un asiento
 * necesita y el catálogo de eventos. Puro y sin dependencias: lo comparten la API, el trabajador de
 * hechos externos y la pantalla.
 *
 * ⚠️ Los montos viajan como TEXTO de centavos enteros (`'123450'`), nunca como pesos ni `number`
 *    (B6). El primitivo es `libs/contracts/src/money/centavos.ts`.
 */
import type { Moneda } from '../money/centavos';

export type ClaseCuenta =
  | 'fisica' | 'custodia' | 'por_rendir' | 'transito' | 'contrapartida' | 'diferencia' | 'puente' | 'sistema';

export type TitularCuenta = 'ninguno' | 'empleado' | 'ruta' | 'concepto';

/** Lo que `cashbook.open_account` recibe. Pedirla otra vez con la misma forma es inofensivo. */
export interface CuentaPropuesta {
  code: string;
  name: string;
  class: ClaseCuenta;
  currency: Moneda;
  tracks_pieces: boolean;
  allows_negative: boolean;
  holder_kind: TitularCuenta;
  holder_ref?: string;
  witness?: string;
}

/** Piezas con signo por llave de denominación, como TEXTO entero (`{ '500': '-50' }`). */
export type PiezasTexto = Record<string, string>;

export interface LineaAsiento {
  account: string;
  amount_minor: string;
  pieces?: PiezasTexto;
}

export type ActorAsiento =
  | { kind: 'persona'; user_id: string; employee_id?: string }
  | { kind: 'servicio'; service: string };

/** Datos que firman el asiento y no son líneas: tipo de cambio, folio de un cheque, el origen. */
export interface MetaAsiento {
  tipo_de_cambio?: string;
  tc_fuente?: string;
  tc_fijado_por?: string;
  folio?: string;
  origen?: string;
  grano?: string;
  motivo?: string;
  [extra: string]: string | undefined;
}

export interface AsientoPropuesto {
  event_kind: EventoLibro;
  event_ref?: string;
  event_version?: number;
  event_hash?: string;
  request_id?: string;
  rule_version: string;
  value_at: string;
  reason?: string;
  meta?: MetaAsiento;
  actor: ActorAsiento;
  lines: LineaAsiento[];
}

/**
 * Los eventos del catálogo §5 del plan. `faltante`, `sobrante`, `apertura` y `ajuste` SIEMPRE los
 * autoriza otra persona (lo hace cumplir la base, `cashbook._post`).
 */
export const EVENTOS_LIBRO = [
  'cobranza_ruta', 'deposito_caos', 'retiro_caos', 'clasificar_suspenso', 'entrega_ruta',
  'retiro_a_custodia', 'gasto', 'regreso_custodia', 'deposito_caja_caos', 'cambio',
  'envio_a_banco', 'deposito_banco', 'cobro_usd', 'cheque_recibido', 'cheque_depositado',
  'cheque_devuelto', 'otro_ingreso', 'faltante', 'sobrante', 'ajuste', 'apertura',
] as const;
export type EventoLibro = (typeof EVENTOS_LIBRO)[number];

export const EVENTOS_SIEMPRE_AUTORIZADOS: readonly EventoLibro[] = ['ajuste', 'faltante', 'sobrante', 'apertura'];

/** Las cuentas fijas que siembra la migración `20261027111930`. */
export const CUENTA_FIJA = {
  CAJA_MXN: 'CAJA_MXN',
  CAJA_USD: 'CAJA_USD',
  CAJA_DOC: 'CAJA_DOC',
  BOVEDA_CAOS: 'BOVEDA_CAOS',
  TRANSITO_BANCO: 'TRANSITO_BANCO',
  COBRANZA_KEPLER: 'COBRANZA_KEPLER',
  PUENTE_MXN: 'PUENTE_MXN',
  PUENTE_USD: 'PUENTE_USD',
  APERTURA_MXN: 'APERTURA_MXN',
  APERTURA_USD: 'APERTURA_USD',
  SUSPENSO_MXN: 'SUSPENSO_MXN',
  SUSPENSO_USD: 'SUSPENSO_USD',
} as const;

/**
 * Una parte de código de cuenta: MAYÚSCULAS, sin acentos, lo demás a `_`. La base exige
 * `^[A-Z][A-Z0-9_:.-]*$`; una parte vacía revienta (una cuenta sin titular no existe).
 */
export function parteDeCodigo(texto: string): string {
  const limpio = String(texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!limpio) throw new Error(`«${texto}» no sirve como parte de un código de cuenta`);
  return limpio;
}

/** Las cuentas que se abren al usarse, con titular. La forma es fija: pedirla dos veces no cambia nada. */
export const CUENTA = {
  porRendirRuta: (ruta: string): CuentaPropuesta => ({
    code: `POR_RENDIR:RUTA:${parteDeCodigo(ruta.replace(/^0+(?=\d)/, ''))}`, name: `Por rendir · ruta ${ruta.replace(/^0+(?=\d)/, '')}`,
    class: 'por_rendir', currency: 'MXN', tracks_pieces: false, allows_negative: true,
    holder_kind: 'ruta', holder_ref: ruta.replace(/^0+(?=\d)/, ''), witness: 'cobranza de Kepler',
  }),
  porRendirVecinal: (): CuentaPropuesta => ({
    code: 'POR_RENDIR:VECINAL', name: 'Por rendir · vecinal', class: 'por_rendir', currency: 'MXN',
    tracks_pieces: false, allows_negative: true, holder_kind: 'ruta', holder_ref: 'vecinal', witness: 'cobranza de Kepler',
  }),
  /**
   * `[LE · D15]` El depósito que sólo nombra la plaza (Canindo, Morelia) abona a la PLAZA: el texto
   * es exacto a ese nivel y elegir una de sus rutas sería inventar. Sus rutas siguen debiendo cada
   * una lo suyo; la plaza neta contra ellas cuando se mida qué rutas son de cuál plaza.
   */
  porRendirPlaza: (plaza: string): CuentaPropuesta => ({
    code: `POR_RENDIR:PLAZA:${parteDeCodigo(plaza)}`, name: `Por rendir · plaza ${plaza}`, class: 'por_rendir', currency: 'MXN',
    tracks_pieces: false, allows_negative: true, holder_kind: 'ruta', holder_ref: `plaza:${plaza.toLowerCase()}`, witness: 'cobranza de Kepler',
  }),
  /**
   * `[LE · D16]` Las monedas que la caja recibe o entrega SIN contarlas por pieza (la «morralla» de
   * la captura vieja). Física y nunca negativa, pero sin desglose: un importe tecleado no ensucia el
   * cajón, que se cuenta por pieza. Su testigo es la morralla del corte.
   */
  morralla: (): CuentaPropuesta => ({
    code: 'MORRALLA_MXN', name: 'Morralla sin desglose', class: 'fisica', currency: 'MXN',
    tracks_pieces: false, allows_negative: false, holder_kind: 'ninguno', witness: 'morralla del corte',
  }),
  custodia: (empleado: string, nombre: string): CuentaPropuesta => ({
    code: `CUSTODIA:${parteDeCodigo(empleado)}`, name: `En custodia · ${nombre}`, class: 'custodia', currency: 'MXN',
    tracks_pieces: false, allows_negative: false, holder_kind: 'empleado', holder_ref: empleado, witness: 'rendición con comprobantes',
  }),
  egreso: (concepto: string): CuentaPropuesta => ({
    code: `EGRESO:${parteDeCodigo(concepto)}`, name: `Egresos · ${concepto}`, class: 'contrapartida', currency: 'MXN',
    tracks_pieces: false, allows_negative: true, holder_kind: 'concepto', holder_ref: parteDeCodigo(concepto), witness: 'comprobante / egreso de Kepler',
  }),
  otrosIngresos: (concepto: string): CuentaPropuesta => ({
    code: `OTROS_INGRESOS:${parteDeCodigo(concepto)}`, name: `Otros ingresos · ${concepto}`, class: 'contrapartida', currency: 'MXN',
    tracks_pieces: false, allows_negative: true, holder_kind: 'concepto', holder_ref: parteDeCodigo(concepto), witness: 'documento soporte',
  }),
  faltante: (empleado: string, nombre: string): CuentaPropuesta => ({
    code: `FALTANTE:${parteDeCodigo(empleado)}`, name: `Faltante · ${nombre}`, class: 'diferencia', currency: 'MXN',
    tracks_pieces: false, allows_negative: true, holder_kind: 'empleado', holder_ref: empleado, witness: 'cierre firmado',
  }),
  sobrante: (empleado: string, nombre: string): CuentaPropuesta => ({
    code: `SOBRANTE:${parteDeCodigo(empleado)}`, name: `Sobrante · ${nombre}`, class: 'diferencia', currency: 'MXN',
    tracks_pieces: false, allows_negative: true, holder_kind: 'empleado', holder_ref: empleado, witness: 'cierre firmado',
  }),
  banco: (cuenta: string): CuentaPropuesta => ({
    code: `BANCO:${parteDeCodigo(cuenta)}`, name: `Banco · ${cuenta}`, class: 'contrapartida', currency: 'MXN',
    tracks_pieces: false, allows_negative: true, holder_kind: 'concepto', holder_ref: parteDeCodigo(cuenta), witness: 'estado de cuenta',
  }),
  /**
   * `[LE · D26]` Lo que se paga de más o de menos al llevar un pago al medio peso (nunca más de 25
   * centavos por pago). Declarado, nunca absorbido: cada peso tiene su explicación.
   */
  redondeo: (): CuentaPropuesta => ({
    code: 'REDONDEO_MXN', name: 'Redondeo al medio peso', class: 'diferencia', currency: 'MXN',
    tracks_pieces: false, allows_negative: true, holder_kind: 'ninguno', witness: 'D26: el documento contra lo pagado',
  }),
  /**
   * `[LE.2.11]` El otro lado de un cambio de monedas por billetes (el banco, un proveedor): puente y
   * sin piezas, porque las piezas cambian de forma y no se conservan. Queda en cero en el mismo acto.
   */
  cambioDeEfectivo: (conQuien: string): CuentaPropuesta => ({
    code: `CAMBIO_EFECTIVO:${parteDeCodigo(conQuien)}`, name: `Cambio de monedas · ${conQuien}`, class: 'puente', currency: 'MXN',
    tracks_pieces: false, allows_negative: true, holder_kind: 'concepto', holder_ref: parteDeCodigo(conQuien), witness: 'el comprobante del cambio',
  }),
};

// ── `[LE.4]` Lo que la API recibe y devuelve ────────────────────────────────────────────────────

/** Una contraparte con nombre: la persona que se lleva o rinde el dinero. */
export interface PersonaDeCaja {
  empleado: string;
  nombre: string;
}

/**
 * Un hecho que registra una PERSONA. El asiento lo arma la regla del servidor (`libs/finance`,
 * `reglas.ts`): la pantalla dice QUÉ pasó, nunca qué cuentas mover.
 */
export type HechoDePersona =
  | { tipo: 'entrega_ruta'; ruta: string; piezas: PiezasTexto }
  | { tipo: 'gasto'; concepto: string; desde: { tipo: 'cajon'; piezas: PiezasTexto } | ({ tipo: 'custodia'; monto_minor: string } & PersonaDeCaja) }
  | ({ tipo: 'regreso_custodia'; piezas: PiezasTexto } & PersonaDeCaja)
  | ({ tipo: 'faltante'; de: OrigenDiferencia } & PersonaDeCaja)
  | ({ tipo: 'sobrante'; en: OrigenDiferencia } & PersonaDeCaja)
  | { tipo: 'cobro_usd'; ruta: string; piezas_usd: PiezasTexto; tipo_de_cambio: string; fuente: string }
  | { tipo: 'cheque_recibido'; ruta: string; folio: string; monto_minor: string }
  | { tipo: 'cheque_depositado'; folio: string; monto_minor: string }
  | { tipo: 'cheque_devuelto'; ruta: string; folio: string; monto_minor: string; cuenta_banco?: string }
  | { tipo: 'deposito_banco'; cuenta_banco: string; monto_minor: string; referencia: string }
  | { tipo: 'otro_ingreso'; concepto: string; piezas: PiezasTexto }
  | { tipo: 'clasificar_suspenso'; event_ref_original: string; monto_minor: string; esta_en: 'debe' | 'haber'; hacia: DestinoDeSuspenso; piezas?: PiezasTexto }
  | { tipo: 'apertura'; moneda: Moneda; fecha: string; conteos: { cuenta: 'CAJA_MXN' | 'CAJA_USD' | 'BOVEDA_CAOS'; piezas: PiezasTexto }[] };

export type OrigenDiferencia =
  | { tipo: 'ruta'; ruta: string; monto_minor: string }
  | ({ tipo: 'custodia'; monto_minor: string } & PersonaDeCaja)
  | { tipo: 'cajon'; piezas: PiezasTexto };

export type DestinoDeSuspenso =
  | { tipo: 'cajon' }
  | { tipo: 'transito' }
  | { tipo: 'ruta'; ruta: string }
  | ({ tipo: 'custodia' } & PersonaDeCaja);

/** Qué pasó con un hecho: entró al libro, o espera la firma de otra persona. */
export type ResultadoHecho =
  | { estado: 'asentado'; entry_id: string }
  | { estado: 'por_autorizar'; request_id: string; motivo: string };

export interface ConteoDeCaja {
  cuenta: 'CAJA_MXN' | 'CAJA_USD' | 'BOVEDA_CAOS';
  tipo: 'cierre' | 'sorpresa' | 'relevo';
  piezas: PiezasTexto;
  /** Obligatorio en un arqueo sorpresa: otra persona presente. */
  testigo?: string;
  contado_en: string;
}

/**
 * Lo que vuelve de un conteo. En un arqueo SORPRESA no vuelve ni el esperado ni la diferencia:
 * quien cuenta no los ve (arqueo ciego, B11); los ve quien concilia en los hallazgos.
 */
export type ResultadoConteo =
  | { ciego: false; count_id: string; total_minor: string; esperado_minor: string; diferencia_minor: string; hallazgo_id: string | null }
  | { ciego: true; count_id: string; total_minor: string };

export interface SaldoDeCuenta {
  code: string;
  name: string;
  class: ClaseCuenta;
  currency: Moneda;
  balance_minor: string;
  last_seq: string;
  /** Sólo para quien autoriza: el desglose es el esperado de un arqueo. */
  piezas?: PiezasTexto;
}

export interface SaldosDelLibro {
  cuentas: SaldoDeCuenta[];
  ultimo_asiento: string;
  jornada_abierta: string | null;
  /** La cadena recorrida al momento de responder (B2): vacía = íntegra. */
  integridad: { integra: boolean; problemas: { seq: string; problema: string }[] };
}

// ── `[LE.4.10]` La Ventanilla: pagar un documento de Kepler en un solo acto ────────────────────

/** Lo que manda la Ventanilla al pagar. El importe NO viaja: el servidor lo relee del documento. */
export interface PagoEnVentanilla {
  /** `sucursal|X-D-26|folio|0011`. */
  origen_ref: string;
  /** La cuenta de Kepler con que se asienta el egreso (`EGRESO:<cuenta>`). */
  cuenta_kepler: string;
  /** El vale de `/finanzas/aprobacion-gastos` que ampara el pago (D18). Sin él, firma Tesorería. */
  vale_id?: string;
  /** Las piezas que salen del cajón: deben sumar exactamente lo que el plan dice del cajón. */
  piezas_cajon?: PiezasTexto;
  /** Quien recibe el dinero (V5: con nombre). */
  recibe: { nombre: string; empleado?: string };
}

/** Lo que el servidor calcula antes de pagar (el mismo motor que usa al pagar). */
export interface PlanDePagoVentanilla {
  origen_ref: string;
  folio: string;
  beneficiario: string;
  importe_minor: string;
  pagable_minor: string;
  redondeo_minor: string;
  maquina_minor: string;
  cajon_minor: string;
  requiere_firma: boolean;
  motivo_firma: string | null;
  bloqueo: string | null;
  motivo_bloqueo: string | null;
}

/**
 * `[LE.2.13]` El veredicto de una fila de «Por pagar hoy», pedido por lote (`GET pagos/veredictos`).
 * Lo que respalda el pago lo dice Kepler: `gasto` (con el vale de su solicitud), `compra` (sus
 * entradas) o `ninguno` (firma Tesorería). `no_medido` = no hay ODS de Kepler en esa base: la
 * pantalla no afirma nada sobre el respaldo.
 */
export interface VeredictoDePago {
  origen_ref: string;
  respaldo: 'gasto' | 'compra' | 'ninguno' | 'no_medido';
  /** `true` = se puede pagar ya (con o sin la firma de Tesorería). */
  puede: boolean;
  requiere_firma: boolean;
  /** El código del bloqueo (`gasto_sin_aprobar`, `ya_ordenado`…) o `null`. */
  bloqueo: string | null;
  /** La frase para la fila: por qué no sale, o por qué firma Tesorería. */
  motivo: string | null;
  /** Dónde se arregla lo detenido; `null` = no se arregla aprobando. */
  arreglo: 'aprobacion_gastos' | null;
  /** Qué paga, renglón por renglón: los gastos con su vale, o las entradas de la compra. */
  detalle: Array<{ tipo: 'gasto' | 'entrada'; folio: string; aplicado_minor: string; vale_folio: string | null; aprobado: boolean | null }>;
}

/**
 * Qué pasó al pagar. `pagado`: la máquina entrega `maquina_minor` con `codigo` (null si todo sale
 * del cajón) y lo del cajón ya quedó asentado. `por_firmar`: Tesorería firma antes de que salga un peso.
 */
export type ResultadoPago =
  | { estado: 'pagado'; orden_id: string; codigo: string | null; maquina_minor: string; cajon_minor: string;
    redondeo_minor: string; entry_id: string | null; vence: string }
  | { estado: 'por_firmar'; orden_id: string; motivo: string };

// ── `[LE.6.7]` La Ventanilla: recibir un cobro de Kepler (U-A-5 de la 0011) ──────────────────

/**
 * Lo que manda la Ventanilla al recibir un cobro. El importe que se esperaba NO viaja: el servidor
 * lo relee del documento. Lo que viaja es lo CONTADO, por pieza (V7): eso es lo que entra al cajón.
 */
export interface CobroEnVentanilla {
  /** `almacen|U-A-5|folio|0011` (el de la cola de Kepler). */
  origen_ref: string;
  /** Billetes y monedas que entrega la ruta o la sucursal, por pieza. */
  piezas: PiezasTexto;
  /** Quién entrega el dinero (V5: con nombre). */
  entrega: { nombre: string };
}

/**
 * Cómo está un cobro de la cola (`GET cobros/estado`, por lote). `ruta`: lo debe una ruta y se
 * recibe contra lo que le falta rendir (E-04). `sucursal`: cobro de una sucursal que no es ruta
 * (D17, otro ingreso). `detenido`: no se recibe aquí, y `motivo` dice por qué.
 */
export interface EstadoDeCobro {
  origen_ref: string;
  tipo: 'ruta' | 'sucursal' | 'detenido';
  ruta: string | null;
  /** Lo que Kepler dice que se cobró, en centavos; `null` si no se pudo leer. */
  esperado_minor: string | null;
  /** Ya está en el libro nuevo. */
  recibido: boolean;
  motivo: string | null;
}

/** Lo que se contó contra lo que Kepler esperaba. La diferencia se DECLARA, nunca se ajusta sola. */
export interface CuentaDelCobro {
  tipo: 'ruta' | 'sucursal';
  ruta: string | null;
  contado_minor: string;
  esperado_minor: string;
  /** contado − esperado: negativo = faltó, positivo = sobró. En una ruta queda en lo que debe rendir. */
  diferencia_minor: string;
  /**
   * La diferencia es de menos de 50 centavos: los centavos que no se cuentan en monedas (D26). Medido
   * el 2026-11-04: 11 de 138 cobros capturados en 14 días no cuadraban al centavo con Kepler, todos de
   * sucursal; los 8 vistos iban de 5 centavos a $1.20.
   */
  es_redondeo: boolean;
}

/**
 * Qué pasó al recibir. `recibido`: ya está en el libro. `por_autorizar`: pasó el umbral y lo autoriza
 * otra persona antes de entrar (el dinero ya está en el cajón; el asiento espera la firma).
 */
export type ResultadoCobro =
  | ({ estado: 'recibido'; entry_id: string } & CuentaDelCobro)
  | ({ estado: 'por_autorizar'; request_id: string; motivo: string } & CuentaDelCobro);

// ── `[LE.6.7]` Suspenso: lo que la máquina hizo y nadie explicó (V2) ─────────────────────────

/**
 * Un movimiento de la máquina que el libro dejó en Suspenso. `haber` = entró dinero sin decir de
 * quién (un depósito sin ruta); `debe` = salió sin orden (un retiro sin código, un vaciado sin
 * destino). El importe y la dirección los lee el servidor del libro: nunca viajan desde la pantalla.
 */
export interface PartidaEnSuspenso {
  /** `caos:<equipo>:<movimiento>`. */
  event_ref: string;
  entry_id: string;
  esta_en: 'debe' | 'haber';
  monto_minor: string;
  fecha: string;
  /** El movimiento de la máquina (`Deposito`, `Dispensar`…) y el texto que se tecleó en ella. */
  movimiento: string | null;
  texto: string | null;
  /** El usuario de la máquina. Su empleado lo dirá el catálogo firmado (LE.1.15); hoy es el usuario. */
  usuario_maquina: string | null;
  motivo: string | null;
}

/** A dónde fue lo que estaba en Suspenso. La custodia llega con LE.6.5. */
export type DestinoDeExplicacion = { tipo: 'ruta'; ruta: string } | { tipo: 'cajon' } | { tipo: 'transito' };

export interface ExplicarSuspenso {
  event_ref: string;
  hacia: DestinoDeExplicacion;
}

/** Una orden que espera la firma de Tesorería, con todo lo que hace falta para decidir. */
export interface OrdenPorFirmar {
  id: string;
  kind: string;
  origen_ref: string | null;
  beneficiario: string | null;
  maquina_minor: string;
  cajon_minor: string;
  redondeo_minor: string;
  recibe: string | null;
  motivo_firma: string | null;
  pedida_por: string;
  pedida_at: string;
  vence: string;
}
