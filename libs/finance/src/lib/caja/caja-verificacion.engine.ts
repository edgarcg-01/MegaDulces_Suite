import { VEREDICTOS_SIN_RESPUESTA, type VeredictoCorte, type VerificacionCorte } from '@megadulces/contracts';

/**
 * ⭐⭐ `[CGS.12]` — **Lo que la supervisora revisa cada mañana, calculado y no recordado.**
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CGS_SUPERVISION_DE_CAJA.md` §2.3. Cada verificación sale
 * con uno de TRES estados —`cumple`, `no_cumple`, `no_medido`— y su detalle en palabras (ADR-056:
 * lo que no se pudo medir se dice, no se pinta de verde).
 *
 * ⚠️ Es una función pura a propósito: la llaman `arqueos()` (la pantalla) y `autorizar()` (la
 * regla de firma, `[CGS.17]`). Dos copias del mismo juicio divergen.
 *
 * Medido en prod el 2026-10-21 sobre los 7 cortes: 3 de 7 cerrados el mismo día, 1 eslabón de
 * fondo roto (CC-3 → CC-4, $10,831.50), 4 con esperado imposible, 28 movimientos editados después
 * de cerrar su corte.
 *
 * ⛔ V9 (lo de la caja fuerte que no llegó al libro) se declara NO MEDIDO: las dos piernas del
 * cajero ya entran a la fórmula del esperado, y decidir qué movimiento de CAOS «debió» capturarse
 * depende de `[CGA-A.33]`, que sigue abierto. Inventar la regla acá sería publicar un verde o un
 * rojo sin fundamento. V10 (quién revisa) depende de quién mira: lo resuelve la pantalla.
 */
export interface EntradaVerificacion {
  /** El día del corte, `YYYY-MM-DD`. */
  fecha: string;
  /** El día (México) en que se cerró, `YYYY-MM-DD`. `null` = no está cerrado. */
  cerrado_dia: string | null;
  contado: number | null;
  morralla: number;
  /** Lo que suman las piezas del desglose de cierre. `null` = no se guardó desglose. */
  suma_piezas: number | null;
  fondo_inicial: number | null;
  /** Lo que contó el corte ANTERIOR de la misma caja. `undefined` = no hay corte anterior. */
  contado_anterior: number | null | undefined;
  folio_anterior: string | null;
  veredicto: VeredictoCorte;
  diferencia: number | null;
  /** Explicación de la caja: la nota del corte o su respuesta a una observación. */
  explicacion: string | null;
  /** Gastos del corte sin firma, sin documento, sin vínculo y sin motivo. */
  gastos_sin_respaldo: number;
  /** Movimientos capturados a mano (sin documento) con la fecha de otro día. */
  manuales_otra_fecha: number;
  /** Movimientos capturados ESE día después de que el corte ya estaba cerrado: quedaron sueltos. */
  sueltos_despues: number;
  /** Movimientos del corte editados después de cerrarlo. */
  editados_despues: number;
}

const dias = (a: string, b: string): number =>
  Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))
    - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000);

const mx = (n: number): string => `$${Math.abs(n).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const EPS = 0.005;

export function verificarCorte(e: EntradaVerificacion): VerificacionCorte[] {
  const v: VerificacionCorte[] = [];
  const add = (id: string, pregunta: string, estado: VerificacionCorte['estado'], detalle: string) =>
    v.push({ id, pregunta, estado, detalle });

  // V1 — el mismo día
  if (!e.cerrado_dia) add('V1', 'Se cerró el mismo día', 'no_medido', 'El corte todavía no está cerrado.');
  else {
    const d = dias(e.fecha, e.cerrado_dia);
    if (d <= 0) add('V1', 'Se cerró el mismo día', 'cumple', 'Se cerró el mismo día de la jornada.');
    else add('V1', 'Se cerró el mismo día', 'no_cumple', `Se cerró ${d} día(s) después de la jornada.`);
  }

  // V2 — el desglose suma lo contado
  if (e.contado == null) add('V2', 'Las piezas suman lo contado', 'no_medido', 'No hay conteo sellado.');
  else if (e.suma_piezas == null) add('V2', 'Las piezas suman lo contado', 'no_medido', 'El conteo no guardó desglose por pieza.');
  else {
    const dif = Math.round((e.suma_piezas + e.morralla - e.contado) * 100) / 100;
    if (Math.abs(dif) <= EPS) add('V2', 'Las piezas suman lo contado', 'cumple', 'Las piezas más la morralla dan exactamente lo contado.');
    else add('V2', 'Las piezas suman lo contado', 'no_cumple', `Las piezas difieren ${mx(dif)} de lo contado.`);
  }

  // V3 — la cadena del fondo
  if (e.contado_anterior === undefined) {
    add('V3', 'Abrió con lo que contó el corte anterior', 'no_medido', 'Es el primer corte de esta caja: no hay anterior contra qué compararlo.');
  } else if (e.contado_anterior === null || e.fondo_inicial == null) {
    add('V3', 'Abrió con lo que contó el corte anterior', 'no_medido', 'El corte anterior o este no tienen el monto medido.');
  } else {
    const dif = Math.round((e.fondo_inicial - e.contado_anterior) * 100) / 100;
    if (Math.abs(dif) <= EPS) add('V3', 'Abrió con lo que contó el corte anterior', 'cumple', `Abrió con lo que contó ${e.folio_anterior ?? 'el anterior'}.`);
    else add('V3', 'Abrió con lo que contó el corte anterior', 'no_cumple',
      `Abrió con ${mx(e.fondo_inicial)} y ${e.folio_anterior ?? 'el anterior'} contó ${mx(e.contado_anterior)}: ${mx(dif)} que el esperado arrastra sin decirlo.`);
  }

  // V4 — el veredicto tiene respuesta
  if ((VEREDICTOS_SIN_RESPUESTA as readonly string[]).includes(e.veredicto)) {
    add('V4', 'La cuenta tiene respuesta', 'no_cumple',
      e.veredicto === 'esperado_imposible'
        ? 'El «debería haber» salió negativo: la cuenta cruzó mal una pierna. Se observa, no se autoriza.'
        : 'No se puede decir si cuadra (sin fondo medido o sin veredicto guardado). Se observa, no se autoriza.');
  } else add('V4', 'La cuenta tiene respuesta', 'cumple', 'El veredicto es concluyente.');

  // V5 — la diferencia está explicada (D5, la tolerancia, sigue abierta: toda diferencia pide explicación)
  if (e.diferencia == null) add('V5', 'La diferencia está explicada', 'no_medido', 'No hay diferencia calculada.');
  else if (Math.abs(e.diferencia) <= EPS) add('V5', 'La diferencia está explicada', 'cumple', 'Cuadra al centavo.');
  else if (e.explicacion && e.explicacion.trim().length >= 10) {
    add('V5', 'La diferencia está explicada', 'cumple', `Difiere ${mx(e.diferencia)} y la caja lo explicó: «${e.explicacion.trim()}».`);
  } else add('V5', 'La diferencia está explicada', 'no_cumple', `Difiere ${mx(e.diferencia)} y nadie lo explicó.`);

  // V6 — ningún gasto sin respaldo
  if (e.gastos_sin_respaldo === 0) add('V6', 'Todo gasto tiene firma, documento o motivo', 'cumple', 'Cada gasto trae firma, documento, vínculo o motivo.');
  else add('V6', 'Todo gasto tiene firma, documento o motivo', 'no_cumple', `${e.gastos_sin_respaldo} gasto(s) sin firma, sin documento y sin motivo.`);

  // V7 — capturas a mano con fecha de otro día
  if (e.manuales_otra_fecha === 0) add('V7', 'Lo capturado a mano es del día', 'cumple', 'Ningún movimiento a mano trae la fecha de otro día.');
  else add('V7', 'Lo capturado a mano es del día', 'no_cumple', `${e.manuales_otra_fecha} movimiento(s) capturado(s) a mano con la fecha de otro día.`);

  // V8 — nada quedó suelto después del cierre
  if (e.sueltos_despues === 0) add('V8', 'Nada se capturó después de cerrar', 'cumple', 'Ningún movimiento de ese día quedó fuera del corte.');
  else add('V8', 'Nada se capturó después de cerrar', 'no_cumple', `${e.sueltos_despues} movimiento(s) de ese día se capturaron después del cierre y quedaron fuera del corte.`);

  // V9 — CAOS: declarado
  add('V9', 'Lo de la caja fuerte llegó al libro', 'no_medido',
    'Todavía no hay regla para decidir qué movimiento de la caja fuerte debió capturarse (CGA-A.33). Las dos piernas ya entran a la cuenta.');

  // V11 — nada se editó después de firmar
  if (!e.cerrado_dia) add('V11', 'Nada se editó después de cerrar', 'no_medido', 'El corte todavía no está cerrado.');
  else if (e.editados_despues === 0) add('V11', 'Nada se editó después de cerrar', 'cumple', 'Ningún movimiento cambió después del cierre.');
  else add('V11', 'Nada se editó después de cerrar', 'no_cumple', `${e.editados_despues} movimiento(s) se editaron después del cierre.`);

  return v;
}

/** `[CGS.17]` Las verificaciones que fallan: cada una exige que la autorización diga por qué. */
export function fallasDe(v: VerificacionCorte[]): VerificacionCorte[] {
  return v.filter((x) => x.estado === 'no_cumple');
}

/** Lo que la lista necesita y no está en la fila del corte: lo lee el servicio de la base. */
export type HechosVerificacion = Pick<EntradaVerificacion,
  'cerrado_dia' | 'contado_anterior' | 'folio_anterior' | 'gastos_sin_respaldo'
  | 'manuales_otra_fecha' | 'sueltos_despues' | 'editados_despues'>;
