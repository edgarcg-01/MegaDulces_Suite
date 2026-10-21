import { diaDeFecha } from './dia-negocio.contract';

/**
 * `[CGP-L.7]` **Un corte de caja, tal como lo publica la API.**
 *
 * `abrir`, `cerrar`, `autorizar` y la lista de cortes devolvían la fila cruda de Postgres: el dinero
 * como texto (`numeric` → `'1300.00'`: el repo no fija `setTypeParser`) y la fecha como `Date`, que
 * por JSON viaja con hora y zona. Cada consumidor tenía que acordarse de convertir, y uno que no se
 * acordaba comparaba texto contra número. Ahora la forma la fija el contrato y la convierte UNA
 * función, del lado del servidor.
 *
 * ⚠️ `null` sigue significando «no se midió» (ADR-056): el mapeo nunca lo vuelve 0.
 */
/**
 * `[CGS.18]` `observado`: la supervisora lo revisó y encontró algo; espera la respuesta de la caja.
 * Sigue FIRMADO (sus cifras no cambian). Al responder vuelve a `cerrado`, o sea a «por revisar».
 */
export type EstadoCorteCaja = 'borrador' | 'cerrado' | 'observado' | 'autorizado';

export interface CorteCajaDto {
  id: string;
  folio: string;
  /** La jornada, `YYYY-MM-DD`. */
  fecha: string;
  sucursal: string;
  estado: EstadoCorteCaja;
  fondo_inicial: number | null;
  fondo_origen: string | null;
  total_ingresos: number | null;
  total_gastos: number | null;
  total_depositos: number | null;
  esperado: number | null;
  contado: number | null;
  morralla: number;
  diferencia: number | null;
  nota: string | null;
  created_by: string | null;
  created_by_username: string | null;
  closed_by: string | null;
  closed_by_username: string | null;
  /** Instante ISO. */
  closed_at: string | null;
  authorized_by: string | null;
  authorized_by_username: string | null;
  /** Instante ISO. */
  authorized_at: string | null;
  reconteo_motivo: string | null;
  /** `[CGS.18]` Quién observó el corte, cuándo (instante ISO) y qué encontró. La última ronda. */
  observed_by_username: string | null;
  observed_at: string | null;
  observacion: string | null;
  /** `[CGS.18]` La respuesta de la caja a esa observación. */
  responded_by_username: string | null;
  responded_at: string | null;
  respuesta: string | null;
  /** `[CGS.17]` La nota con la que se autorizó: obligatoria si hubo diferencia. */
  authorization_note: string | null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const txt = (v: unknown): string | null => (v == null ? null : String(v));
const instante = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** De la fila de `finance.cash_ledger_cuts` al contrato. Lo que no es del contrato no sale. */
export function aCorteCajaDto(r: Record<string, unknown>): CorteCajaDto {
  return {
    id: String(r['id']),
    folio: String(r['folio']),
    fecha: diaDeFecha(r['fecha']) ?? '',
    sucursal: String(r['sucursal']),
    estado: r['estado'] as EstadoCorteCaja,
    fondo_inicial: num(r['fondo_inicial']),
    fondo_origen: txt(r['fondo_origen']),
    total_ingresos: num(r['total_ingresos']),
    total_gastos: num(r['total_gastos']),
    total_depositos: num(r['total_depositos']),
    esperado: num(r['esperado']),
    contado: num(r['contado']),
    morralla: num(r['morralla']) ?? 0,
    diferencia: num(r['diferencia']),
    nota: txt(r['nota']),
    created_by: txt(r['created_by']),
    created_by_username: txt(r['created_by_username']),
    closed_by: txt(r['closed_by']),
    closed_by_username: txt(r['closed_by_username']),
    closed_at: instante(r['closed_at']),
    authorized_by: txt(r['authorized_by']),
    authorized_by_username: txt(r['authorized_by_username']),
    authorized_at: instante(r['authorized_at']),
    reconteo_motivo: txt(r['reconteo_motivo']),
    observed_by_username: txt(r['observed_by_username']),
    observed_at: instante(r['observed_at']),
    observacion: txt(r['observacion']),
    responded_by_username: txt(r['responded_by_username']),
    responded_at: instante(r['responded_at']),
    respuesta: txt(r['respuesta']),
    authorization_note: txt(r['authorization_note']),
  };
}

/**
 * ⛔ `[CGS.14][CGS.15]` **El candado de la caja, tal como lo publica la API** (`GET
 * /finance/cash-ledger/candado`). Sin corte cerrado de una jornada anterior, no se captura; la
 * salida es cerrar ese corte o una llave de emergencia que da OTRA persona con motivo.
 *
 * `activo: false` = apagado por el interruptor de emergencia (`CAJA_CANDADO_CAPTURA=off`): se
 * DECLARA, no se esconde.
 */
export interface CandadoCajaDto {
  bloqueado: boolean;
  motivo: 'jornada_sin_corte' | 'corte_sin_cerrar' | null;
  /** La jornada que hay que cerrar primero, `YYYY-MM-DD`. */
  jornada: string | null;
  /** La frase para la persona: qué pasa y qué lo destraba. */
  texto: string | null;
  /** Se está capturando con llave: quién la dio, por qué y hasta cuándo (instante ISO). */
  con_llave: { otorgada_por_username: string | null; motivo: string; vence_at: string } | null;
  activo: boolean;
  /** Hoy en México, `YYYY-MM-DD`. */
  hoy: string;
  /** Quienes capturaron en los últimos 30 días, menos quien pregunta: a quién se le puede dar llave. */
  pueden_recibir_llave: Array<{ id: string; username: string | null }>;
}
