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
import type { CompletarGuiaBody, HorarioGuia, TarifaDeRuta, TarifasViatico, ViaticosDeLaGuia } from '@megadulces/contracts';
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
