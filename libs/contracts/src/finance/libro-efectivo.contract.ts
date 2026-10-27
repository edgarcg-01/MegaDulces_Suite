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
