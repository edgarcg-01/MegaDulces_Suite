/**
 * EMB.19 — La guía ya no se teclea: tripulación elegida, comisión y viáticos CALCULADOS.
 *
 * Reglas puras (sin base de datos) de la guía MANUAL — la que se agrega a un embarque que no vino
 * de Kepler. La de Kepler sale de su hoja (`validarToma`) y comparte con ésta las dos fórmulas del
 * contrato (`comisionesDeLaGuia`, `viaticosDeLaGuia`): no hay una tercera.
 *
 * Por qué se frena en vez de guardar 0: Liquidaciones paga lo que dice la guía
 * (`driver_commission`, `per_diem_total`), y un 0 por omisión es no pagar.
 */
import { MOTIVO_MINIMO_REABRIR } from '@megadulces/contracts';
import type { CompletarGuiaBody, HorarioGuia, TarifaDeRuta, TarifasViatico, TripulacionGuiaBody, ViaticosDeLaGuia } from '@megadulces/contracts';
import {
  comisionesDeLaGuia, erroresDeGuiaManual, erroresDeTripulacion, erroresDeViaticos, horaAMinutos, viaticosDeLaGuia,
} from '@megadulces/contracts';

export interface GuiaCapturada {
  driver_id?: string | null;
  helper1_id?: string | null;
  helper2_id?: string | null;
  departure_time?: string | null;
  arrival_time?: string | null;
  overnight?: boolean | null;
  /** No se capturan: si vienen, tienen que coincidir con el cálculo. */
  driver_commission?: number | null;
  helper1_commission?: number | null;
  helper2_commission?: number | null;
  per_diem_total?: number | null;
}

export interface GuiaContexto {
  /** La ruta del embarque con su tarifa. null = el embarque no tiene ruta. */
  ruta: TarifaDeRuta | null;
  tarifas: TarifasViatico;
}

export interface GuiaCalculada {
  comisiones: { driver_commission: number; helper1_commission: number; helper2_commission: number };
  viaticos: ViaticosDeLaGuia;
}

export const COMISION_NO_SE_CAPTURA = 'La comisión se calcula de la tarifa de la ruta; no se captura.';
export const VIATICOS_NO_SE_CAPTURAN = 'Los viáticos se calculan del horario; no se capturan.';

const centavos = (v: unknown) => Math.round(Number(v) * 100);

export function horarioDe(c: Pick<GuiaCapturada, 'departure_time' | 'arrival_time' | 'overnight'>): HorarioGuia {
  return { salida: c.departure_time ?? null, llegada: c.arrival_time ?? null, duerme_fuera: !!c.overnight };
}

/**
 * Lo que trae tecleado y no coincide con lo calculado. Lo comparten la guía manual y la toma de
 * Kepler: el cuerpo no debería traer montos, y si los trae, no mandan.
 */
export function capturasQueNoCoinciden(c: GuiaCapturada, calc: GuiaCalculada): string[] {
  const e: string[] = [];
  const comision = (['driver_commission', 'helper1_commission', 'helper2_commission'] as const)
    .some((k) => c[k] != null && centavos(c[k]) !== centavos(calc.comisiones[k]));
  if (comision) e.push(COMISION_NO_SE_CAPTURA);
  if (c.per_diem_total != null && centavos(c.per_diem_total) !== centavos(calc.viaticos.total)) {
    e.push(VIATICOS_NO_SE_CAPTURAN);
  }
  return e;
}

/** El cálculo. Sólo tiene sentido cuando `validarGuiaManual` viene vacío. */
export function calcularGuia(c: GuiaCapturada, ctx: GuiaContexto): GuiaCalculada {
  const va = { driver: !!c.driver_id, helper1: !!c.helper1_id, helper2: !!c.helper2_id };
  return {
    comisiones: comisionesDeLaGuia({ driver: ctx.ruta?.driver ?? 0, helper: ctx.ruta?.helper ?? 0 }, va),
    viaticos: viaticosDeLaGuia(horarioDe(c), ctx.tarifas, va),
  };
}

/** Errores en lenguaje del usuario. Lista vacía = se puede crear la guía. */
export function validarGuiaManual(c: GuiaCapturada, ctx: GuiaContexto): string[] {
  const e = erroresDeGuiaManual(c, ctx.ruta, ctx.tarifas);
  // Sólo se compara lo tecleado contra un cálculo que se pudo hacer.
  if (!e.length) e.push(...capturasQueNoCoinciden(c, calcularGuia(c, ctx)));
  return e;
}

// ── Completar la guía que nació al tomar un viaje de Kepler (EMB.22) ───────────────────────────
//
// La guía nace con lo que Kepler tiene (el chofer, si lo trae). Lo que Kepler no tiene —ayudantes,
// horario y, si falta, el chofer— se captura UNA vez en la pestaña Guías; entonces se valida la
// tarifa y se calculan comisión y viáticos, y desde ahí todo queda bloqueado.

export interface CompletarContexto {
  /** El chofer que ya trae la guía (de Kepler). Si lo trae, no se cambia aquí. */
  chofer_guia: string | null;
  /** La tarifa por persona: la del viaje de Kepler (la mayor de sus rutas) o la de la ruta del embarque. */
  comision: { driver: number | null; helper: number | null };
  /** Lo que falta de tarifa según quién va (la regla depende de si va ayudante). */
  erroresDeTarifa: (ayudantes: { helper1: boolean; helper2: boolean }) => string[];
  tarifas: TarifasViatico;
}

export const CHOFER_DE_KEPLER = 'El chofer viene de Kepler y no se cambia aquí: corrígelo en Kepler.';

/** La captura con el chofer que manda: el de Kepler si lo trae; si no, el elegido. */
export function capturaCompleta(body: CompletarGuiaBody, ctx: Pick<CompletarContexto, 'chofer_guia'>): GuiaCapturada {
  return { ...body, driver_id: ctx.chofer_guia || body.driver_id || null };
}

/** Errores en lenguaje del usuario. Lista vacía = se puede completar. */
export function validarCompletar(body: CompletarGuiaBody, ctx: CompletarContexto): string[] {
  const c = capturaCompleta(body, ctx);
  const ayudantes = { helper1: !!c.helper1_id, helper2: !!c.helper2_id };
  return [
    ...(ctx.chofer_guia && body.driver_id && body.driver_id !== ctx.chofer_guia ? [CHOFER_DE_KEPLER] : []),
    ...erroresDeTripulacion({ driver_id: c.driver_id || null, helper1_id: c.helper1_id || null, helper2_id: c.helper2_id || null }),
    ...ctx.erroresDeTarifa(ayudantes),
    ...erroresDeViaticos(horarioDe(c), ctx.tarifas),
  ];
}

/** El cálculo al completar. Sólo tiene sentido cuando `validarCompletar` viene vacío. */
export function calcularCompletar(body: CompletarGuiaBody, ctx: CompletarContexto): GuiaCalculada {
  const c = capturaCompleta(body, ctx);
  const va = { driver: !!c.driver_id, helper1: !!c.helper1_id, helper2: !!c.helper2_id };
  return {
    comisiones: comisionesDeLaGuia(ctx.comision, va),
    viaticos: viaticosDeLaGuia(horarioDe(c), ctx.tarifas, va),
  };
}

// ── [CML.HV] La tripulación al salir ─────────────────────────────────────────────────────────
// Al despachar, el coordinador ya sabe quién va; el horario llega al regreso. Guardar la
// tripulación sola NO calcula nada: la guía sigue incompleta y se puede corregir hasta que se
// capture el horario, que es cuando se calculan comisión y viático y todo queda bloqueado.

export const TRIPULACION_YA_CON_HORARIO =
  'El horario de esta guía ya se capturó: con él se calcularon la comisión y el viático, y la tripulación ya no se cambia.';

/** Null = la tripulación todavía se puede guardar o corregir; si no, el porqué en llano. */
export function bloqueoDeTripulacion(guia: { departure_time?: string | null; arrival_time?: string | null }): string | null {
  return guia.departure_time && guia.arrival_time ? TRIPULACION_YA_CON_HORARIO : null;
}

/** Errores al guardar la tripulación SIN horario. Lista vacía = se puede guardar. */
export function validarTripulacion(body: TripulacionGuiaBody, ctx: Pick<CompletarContexto, 'chofer_guia'>): string[] {
  const driver = ctx.chofer_guia || body.driver_id || null;
  return [
    ...(ctx.chofer_guia && body.driver_id && body.driver_id !== ctx.chofer_guia ? [CHOFER_DE_KEPLER] : []),
    ...erroresDeTripulacion({ driver_id: driver, helper1_id: body.helper1_id || null, helper2_id: body.helper2_id || null }),
  ];
}

// ── [CML.J] El mismo viaje físico (D17 opción A) ─────────────────────────────────────────────

const CLAVE_KEPLER = /^[0-9A-Za-z]{1,3}\|[0-9]{1,10}$/;

/**
 * Errores al confirmar que dos guías son el mismo viaje. Lista vacía = se puede. Sólo se liga una
 * guía de la MISMA unidad: si la unidad no se sabe en alguna de las dos, no se afirma.
 */
export function erroresMismoViaje(
  propia: string, otra: string, unidadPropia: string | null, unidadOtra: string | null | undefined,
  fechas?: { propia: string | null; otra: string | null },
): string[] {
  if (!CLAVE_KEPLER.test(otra)) return ['La otra guía no es válida: usa sucursal|guía, por ejemplo 06|0001696.'];
  if (otra === propia) return ['Una guía no puede ser el mismo viaje que ella misma.'];
  if (unidadOtra === undefined) return [`La guía ${otra.split('|')[1]} no existe en Kepler.`];
  if (!unidadPropia || !unidadOtra) return ['Una de las dos guías no tiene unidad en Kepler: no se puede confirmar que sea el mismo viaje.'];
  if (unidadPropia !== unidadOtra) return [`La guía ${otra.split('|')[1]} va en otra unidad: no es el mismo viaje.`];
  // Las mismas ±2 días con que el GPS busca (lo cargado en la tarde sale al día siguiente).
  if (fechas?.propia && fechas.otra) {
    const dias = Math.abs(Date.parse(`${fechas.propia}T12:00:00Z`) - Date.parse(`${fechas.otra}T12:00:00Z`)) / 86_400_000;
    if (!(dias <= DIAS_ENTRE_GUIAS_DEL_MISMO_VIAJE)) {
      return [`La guía ${otra.split('|')[1]} es de ${fechas.otra} y ésta de ${fechas.propia}: más de ${DIAS_ENTRE_GUIAS_DEL_MISMO_VIAJE} días no es el mismo viaje.`];
    }
  }
  return [];
}

/** Días máximos entre las fechas de dos guías del mismo viaje (igual que `DIAS_MISMO_VIAJE` del GPS). */
export const DIAS_ENTRE_GUIAS_DEL_MISMO_VIAJE = 2;

// ── [CML.K] Reabrir un viaje cerrado ─────────────────────────────────────────────────────────
// El viaje se cierra una vez (Embarques › Cerrar viajes) y el historial no se edita. Para corregir
// un error se REABRE con motivo: se borran el horario y los montos calculados, la tripulación se
// queda, y el viaje vuelve a cerrarse con el horario correcto.

/** Mínimo de caracteres del motivo: «error» no explica nada; «el ayudante era otro» sí. */
export const MOTIVO_MINIMO = MOTIVO_MINIMO_REABRIR;

/** Errores al reabrir. Lista vacía = se puede. */
export function erroresReabrir(
  guia: { status?: string | null; departure_time?: string | null; arrival_time?: string | null },
  motivo: unknown,
): string[] {
  if (guia.status === 'cancelada') return ['La guía está cancelada: no se reabre.'];
  if (!guia.departure_time || !guia.arrival_time) return ['Este viaje todavía no se cierra: no hay nada que reabrir.'];
  const m = typeof motivo === 'string' ? motivo.trim() : '';
  if (m.length < MOTIVO_MINIMO) return [`Escribe por qué se reabre (al menos ${MOTIVO_MINIMO} letras): queda registrado.`];
  return [];
}

// ── Editar una guía ya creada ───────────────────────────────────────────────────────────────

/** Lo que se calcula al crear la guía y por eso no se edita después. */
const CAMPOS_CALCULADOS = [
  'driver_id', 'helper1_id', 'helper2_id', 'departure_time', 'arrival_time', 'overnight',
  'driver_commission', 'helper1_commission', 'helper2_commission', 'per_diem_total',
] as const;

export const GUIA_NO_SE_EDITA =
  'La tripulación, el horario, la comisión y los viáticos de la guía se calculan al crearla y no se editan: cancela la guía y crea otra.';

type GuiaGuardada = Partial<Record<(typeof CAMPOS_CALCULADOS)[number], unknown>>;

/**
 * Los campos calculados que un PATCH quiere cambiar. Mandar el MISMO valor no es cambiarlo (un
 * cliente que reenvía la guía entera para cambiar sólo el estado no debe chocar aquí).
 */
export function cambiosACamposCalculados(
  guardada: GuiaGuardada,
  patch: GuiaGuardada & { per_diem_breakdown?: unknown; auto_per_diem?: unknown },
): string[] {
  const igual = (k: (typeof CAMPOS_CALCULADOS)[number], a: unknown, b: unknown): boolean => {
    if (k === 'overnight') return !!a === !!b;
    if (k === 'departure_time' || k === 'arrival_time') return horaAMinutos(a as string) === horaAMinutos(b as string);
    if (k.endsWith('_id')) return (a || null) === (b || null);
    return centavos(a ?? 0) === centavos(b ?? 0);
  };
  const cambian: string[] = CAMPOS_CALCULADOS.filter((k) => patch[k] !== undefined && !igual(k, guardada[k], patch[k]));
  if (patch.per_diem_breakdown !== undefined) cambian.push('per_diem_breakdown');
  if (patch.auto_per_diem) cambian.push('auto_per_diem');
  return cambian;
}
