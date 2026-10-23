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
  /** `[CGS.52]` Por qué no tiene esperado, conteo o diferencia. `null` = no falta nada. */
  sin_medir_motivo: string | null;
  /** `[CGS.52]` Si sus cifras se recalcularon después de firmar: el porqué y cuándo (ISO). */
  recalculo_motivo: string | null;
  recalculado_at: string | null;
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
    sin_medir_motivo: txt(r['sin_medir_motivo']),
    recalculo_motivo: txt(r['recalculo_motivo']),
    recalculado_at: instante(r['recalculado_at']),
  };
}

/**
 * ⭐⭐ `[CGS.52]` **Lo que quedó en caja y la diferencia son DOS cosas, y se dicen por separado.**
 *
 * PM, 2026-10-23: *«diferencia vs lo que quedó en caja es diferente. Debemos ser claros y no
 * confundir al supervisor»*. Medido ese día: los cortes del 15, 16, 17 y 21-oct publicaban «sobra»
 * entre $49k y $245k porque su «debería haber» salía NEGATIVO — y con el esperado bajo cero la resta
 * sale positiva SIEMPRE, así que se leía un sobrante donde lo que había era un libro que no cuadra.
 *
 *  · **Quedó en caja** = el conteo físico. Un hecho: con eso arranca el día siguiente.
 *  · **Debería haber** = la cuenta del libro. Negativa es imposible en una caja física: se dice
 *    «no calculable» con cuánto excede el libro, nunca se pinta como cifra.
 *  · **Diferencia** = sólo si las dos existen y la cuenta tiene sentido.
 *
 * Vive acá porque la leen DOS pantallas (la lista de cortes y Arqueos): dos lecturas del mismo corte
 * divergen. `fmt` lo pone quien pinta; `difPublicada` deja pasar la diferencia que corrigieron los
 * testigos (`[CGS.36]`) sin que esta función tenga que saber de ellos.
 */
export interface LecturaCorte {
  quedo: { texto: string; sub: string | null; medido: boolean };
  deberia: { texto: string; sub: string | null; medido: boolean };
  dif: { texto: string; sub: string | null; tono: 'ok' | 'bad' | 'dim' };
}
export function leerCorte(
  c: { contado: number | null; esperado: number | null; diferencia: number | null; fondo_inicial: number | null; sin_medir_motivo: string | null },
  fmt: (n: number) => string,
  /** `atestiguada` = los testigos la confirmaron o corrigieron: sólo entonces vale con esperado negativo. */
  difPublicada?: { valor: number | null; nota: string | null; atestiguada: boolean } | null,
): LecturaCorte {
  const quedo = c.contado !== null
    ? { texto: fmt(c.contado), sub: null, medido: true }
    : { texto: c.sin_medir_motivo ? 'sin conteo físico' : 'sin contar', sub: null, medido: false };
  const deberia = c.esperado === null
    ? { texto: 'sin medir', sub: c.fondo_inicial === null ? 'no se sabe con cuánto arrancó' : null, medido: false }
    : c.esperado < 0
      ? { texto: 'no calculable', sub: `el libro trae ${fmt(-c.esperado)} más de salidas que de dinero`, medido: false }
      : { texto: fmt(c.esperado), sub: null, medido: true };
  let dif: LecturaCorte['dif'];
  const valor = difPublicada ? difPublicada.valor : c.diferencia;
  if (c.contado === null || c.esperado === null) {
    dif = { texto: 'sin medir', sub: c.sin_medir_motivo ? 'ver la nota del día' : null, tono: 'dim' };
  } else if (c.esperado < 0 && !difPublicada?.atestiguada) {
    dif = { texto: 'no calculable', sub: 'el libro no explica el dinero', tono: 'dim' };
  } else if (valor === null) {
    dif = { texto: '—', sub: null, tono: 'dim' };
  } else if (Math.abs(valor) < 0.005) {
    dif = { texto: fmt(0), sub: 'cuadra', tono: 'ok' };
  } else {
    const firmado = `${valor < 0 ? '−' : '+'}${fmt(Math.abs(valor))}`;
    const nota = difPublicada?.nota;
    dif = { texto: firmado, sub: `${valor > 0 ? 'sobra' : 'falta'}${nota ? ` · ${nota}` : ''}`, tono: 'bad' };
  }
  return { quedo, deberia, dif };
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
