/**
 * `[PGP.121]` **El banco dispara el pago.** Edgar, 2026-11-13: «hay que encenderla» — y, al preguntarle qué la
 * dispara, eligió el banco: la Suite marca pagado (y, con el interruptor encendido, escribe el `X-D-26` en Kepler)
 * cuando el estado de cuenta muestra la salida por ese importe. **Sin autorizar ni marcar pagado a mano, y sin
 * capturar la cuenta de origen**: la cuenta sale del propio movimiento del banco.
 *
 * ── Por qué se puede (medido en prod, sólo lectura, 2026-11-13) ─────────────────────────────────────
 * - Contra lo que Tesorería capturó en Kepler (459 pagos a proveedores de compra de agosto a noviembre, sucursal
 *   00): buscando la salida por importe (±$1) y fecha (±1 día) en TODAS las cuentas, **442 caen en una sola
 *   cuenta y 439 son la cuenta que Tesorería capturó** (99.3 %, el 97.7 % del dinero). Placebo (las mismas fechas
 *   +40 días): 1 de 459.
 * - Sobre los pagos DEL CALENDARIO (183 de días pasados), con la fecha planeada: 86 caen en una sola cuenta; los 60
 *   que tienen captura de Tesorería como testigo, **60 de 60 en la cuenta correcta**. Placebo: 0 de 183.
 *   Tesorería captura el mismo día que el plan (p50 0 días, p90 1, máximo 3): por eso la ventana es de 3 días.
 *
 * ── Lo que NO se decide aquí, y se dice ──────────────────────────────────────────────────────────────
 * - **`varias_cuentas`**: el mismo importe salió de dos cuentas en la ventana. No se adivina.
 * - **`disputada`**: la salida casa con más de un pago pendiente, o el pago con más de una salida. Uno a uno, o nada.
 * - **`excluido`**: cheque (Kepler lo registra distinto) y efectivo (no pasa por el banco).
 * - **`sin_salida`**: el banco no la tiene todavía (se carga por lotes, unas tres veces por semana) o no se pagó.
 *
 * Función pura: recibe los pagos pendientes, las salidas del banco y las que ya están ligadas a otro pago.
 */

import type { SalidaSegunLaDescarga } from '@megadulces/contracts';

/** Días alrededor del día planeado en que se busca la salida (medido: Tesorería paga el día, a lo más 3 después). */
export const VENTANA_BANCO_DIAS = 3;
/** Pesos de tolerancia entre el importe del pago y la salida (redondeos del banco). */
export const TOLERANCIA_BANCO = 1;

export interface PagoPendiente {
  id: string;
  /** Día planeado del pago (`YYYY-MM-DD`). */
  dia: string;
  importe: number;
  /** `payment_allocations.payment_method`; null = nadie lo preparó (casi todos hoy). */
  metodo: string | null;
  /** `[PGP.166]` `payment_allocations.reference_text`: en un cheque, su número. */
  referencia?: string | null;
  /** `[PGP.166]` La cuenta que alguien preparó; null = nadie. Un cheque se busca en ESA cuenta. */
  cuenta_planeada?: string | null;
}

export interface SalidaBanco {
  id: string;
  cuenta_id: string;
  fecha: string;
  importe: number;
  /** `[PGP.201]` El concepto del banco; de él sale la referencia que comparten las partes de un pago partido. */
  concepto?: string | null;
}

export type DecisionBanco =
  | {
    estado: 'probado'; movimiento_id: string; cuenta_id: string; fecha: string; importe: number;
    /** `[PGP.201]` Pago partido en varias transferencias: TODAS sus salidas (`movimiento_id` es la mayor). */
    grupo?: string[];
    /** `[PGP.166]` El número del cheque cuyo cobro lo prueba. */
    cheque?: string;
  }
  | { estado: 'sin_salida' | 'varias_cuentas' | 'disputada' | 'excluido'; motivo: string };

/**
 * `[PGP.201]` **La referencia que comparten las transferencias de un mismo pago.** El banco escribe al final del concepto
 * la referencia numérica que capturó Tesorería («SPEI ENVIADO CITI MEXICO/0036039880 124 018112610087»): las partes de
 * un pago partido la repiten. Sólo cuenta una de 6 dígitos o más que no sea puros ceros. Pura.
 */
export function referenciaDeSalida(concepto: string | null | undefined): string | null {
  const m = /([0-9]{6,})\s*$/.exec(String(concepto ?? '').trim());
  if (!m || /^0+$/.test(m[1])) return null;
  return m[1];
}

/**
 * `[PGP.201]` Las salidas que juntas pagan UN pago: misma cuenta, mismo día, misma referencia, dos o más, y su suma da el
 * importe (±$1) dentro de la ventana del pago. Caso que lo pidió (2026-11-23): Effem (CE012), 18-nov, dos SPEI desde la
 * misma cuenta con la referencia `018112610087`; el carril buscaba una sola salida por el importe completo, no la
 * encontraba y el pago seguía «pendiente» — listo para pagarse otra vez. Medido en prod: de 103 grupos de octubre y
 * noviembre, casan 3 pagos (el de Effem, su original cancelado y uno de CP007 ya pagado); control +$100: 0.
 */
export function gruposQueCasan(p: PagoPendiente, libres: readonly SalidaBanco[]): SalidaBanco[][] {
  const grupos = new Map<string, SalidaBanco[]>();
  for (const s of libres) {
    const ref = referenciaDeSalida(s.concepto);
    if (!ref) continue;
    const k = `${s.cuenta_id}|${s.fecha}|${ref}`;
    const g = grupos.get(k) ?? [];
    g.push(s);
    grupos.set(k, g);
  }
  return [...grupos.values()].filter((g) => g.length >= 2
    && Math.abs(g.reduce((t, s) => t + s.importe, 0) - p.importe) <= TOLERANCIA_BANCO
    && Math.abs(dias(p.dia, g[0].fecha)) <= VENTANA_BANCO_DIAS);
}

/** Quién firma en la bitácora y en `updated_by` lo que hizo el banco. */
export const AUTOR_PAGO_POR_EL_BANCO = 'sistema:banco';
/** El evento de `finance.payment_allocation_history` (el catálogo crece sin migración). */
export const EVENTO_PAGADO_POR_EL_BANCO = 'pagado_por_el_banco';

export interface ResultadoPagoPorElBanco {
  hoy: string;
  /** Pagos pendientes de días que ya llegaron. */
  revisados: number;
  pagados: number;
  monto: number;
  ids_pagados: string[];
  /** Los que el banco no decide, por motivo: se dicen, no se callan. */
  sin_decidir: Record<'sin_salida' | 'varias_cuentas' | 'disputada' | 'excluido', number>;
}

/** Métodos que no salen como transferencia del estado de cuenta. */
const NO_TRANSFERENCIA = new Set(['cheque', 'efectivo']);

const dias = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * `[PGP.166]` El número de un cheque emitido: el primer número de 3 dígitos o más de la referencia del pago (Tesorería lo
 * teclea al llenarlo, `[PGP.173]`), sin ceros a la izquierda. Pura.
 */
export function numeroDeChequeEmitido(referencia: string | null | undefined): string | null {
  const m = /([0-9]{3,})/.exec(String(referencia ?? ''));
  return m ? m[1].replace(/^0+/, '') || null : null;
}

/**
 * `[PGP.166]` El número del cheque que cobró el banco, del concepto de la salida. BanBajío (4166):
 * «Doc. Pagado por Camara de Compensacion por (7,120.32) mxn numero de cheque | 5395 | Recibo | …». Santander (2169)
 * lo pone sólo en la referencia de la descarga, que el libro no guarda (NO MEDIDO aquí). Pura.
 */
export function numeroDeChequeCobrado(concepto: string | null | undefined): string | null {
  const m = /numero de cheque\s*\|\s*([0-9]+)/i.exec(String(concepto ?? ''));
  return m ? m[1].replace(/^0+/, '') || null : null;
}

/** `[PGP.166]` Días antes del día del pago en que ya se acepta su cobro (el cheque se entrega antes de su día). */
export const DIAS_ANTES_COBRO_CHEQUE = 15;

/**
 * `[PGP.166]` **El cheque se da por cobrado cuando el banco trae su número** (anexo CH, frente 1; lo que el anexo CL
 * llamó `[PGP.200]`). Pide Francisco (2026-11-19): «controlar … cuando son cobrados y se reflejan en el estado de
 * cuenta». Medido el 2026-11-23 (prod, sólo lectura): de 15 cheques numerados «pendientes» en BanBajío 4166, **7 ya se
 * cobraron** (3 por un centavo de diferencia: el redondeo de `[PGP.165]`); control con el número +1000: 0.
 * Por número y en la cuenta preparada si la hay; uno a uno. Diferencia de hasta $1: pagado (la bitácora guarda los dos
 * importes). Más de $1: no se decide (`disputada`) y se dicen los dos importes. Sin cobro: `sin_salida`. Pura.
 */
export function decidirChequesCobrados(pagos: readonly PagoPendiente[], salidas: readonly SalidaBanco[]): Map<string, DecisionBanco> {
  const out = new Map<string, DecisionBanco>();
  const porNumero = new Map<string, SalidaBanco[]>();
  for (const s of salidas) {
    const n = numeroDeChequeCobrado(s.concepto);
    if (n) porNumero.set(n, [...(porNumero.get(n) ?? []), s]);
  }
  const cheques = pagos.filter((p) => p.metodo === 'cheque' && numeroDeChequeEmitido(p.referencia));
  const reclamado = new Map<string, number>();
  for (const p of cheques) reclamado.set(numeroDeChequeEmitido(p.referencia)!, (reclamado.get(numeroDeChequeEmitido(p.referencia)!) ?? 0) + 1);
  for (const p of cheques) {
    const n = numeroDeChequeEmitido(p.referencia)!;
    const c = (porNumero.get(n) ?? []).filter((s) => (!p.cuenta_planeada || s.cuenta_id === p.cuenta_planeada)
      && dias(p.dia, s.fecha) >= -DIAS_ANTES_COBRO_CHEQUE);
    if (!c.length) { out.set(p.id, { estado: 'sin_salida', motivo: `El cheque ${n} todavía no aparece cobrado en el banco` }); continue; }
    if (c.length > 1 || (reclamado.get(n) ?? 0) > 1) {
      out.set(p.id, { estado: 'disputada', motivo: c.length > 1 ? `El banco trae ${c.length} cobros del cheque ${n}: no se adivina cuál es`
        : `Hay más de un pago pendiente con el cheque ${n}: no se sabe de cuál es el cobro` });
      continue;
    }
    const s = c[0];
    if (Math.abs(s.importe - p.importe) > TOLERANCIA_BANCO) {
      out.set(p.id, { estado: 'disputada', motivo: `El cheque ${n} se cobró por $${s.importe.toFixed(2)} y el pago es por $${p.importe.toFixed(2)}: no se da por pagado` });
      continue;
    }
    out.set(p.id, { estado: 'probado', movimiento_id: s.id, cuenta_id: s.cuenta_id, fecha: s.fecha, importe: s.importe, cheque: n });
  }
  return out;
}

export function casaConElPago(p: PagoPendiente, s: SalidaBanco): boolean {
  return Math.abs(s.importe - p.importe) <= TOLERANCIA_BANCO && Math.abs(dias(p.dia, s.fecha)) <= VENTANA_BANCO_DIAS;
}

/**
 * Decide, pago por pago, si el banco prueba que salió y de qué cuenta. Sólo los pagos de días que ya llegaron
 * (`dia <= hoy`); los demás no aparecen en el resultado. `ligadas`: salidas que ya son la prueba de otro pago.
 */
export function decidirPagosPorElBanco(
  pagos: readonly PagoPendiente[], salidas: readonly SalidaBanco[], hoy: string, ligadas: ReadonlySet<string> = new Set(),
): Map<string, DecisionBanco> {
  const out = new Map<string, DecisionBanco>();
  const sinLigar = salidas.filter((s) => !ligadas.has(s.id) && s.importe > 0);
  const vigentes = pagos.filter((p) => p.dia <= hoy);
  // `[PGP.166]` Primero los cheques con número: el número es una llave más fuerte que el importe. El cobro que toma un
  // cheque ya no lo puede reclamar una transferencia por coincidir en importe.
  const cobros = decidirChequesCobrados(vigentes, sinLigar);
  for (const [id, d] of cobros) out.set(id, d);
  const tomadasPorCheque = new Set<string>();
  for (const d of cobros.values()) if (d.estado === 'probado') tomadasPorCheque.add(d.movimiento_id);
  const libres = sinLigar.filter((s) => !tomadasPorCheque.has(s.id));
  const candidatas = new Map<string, SalidaBanco[]>();
  for (const p of vigentes) {
    if (p.metodo && NO_TRANSFERENCIA.has(p.metodo)) continue;
    candidatas.set(p.id, libres.filter((s) => casaConElPago(p, s)));
  }
  // Cuántos pagos reclaman cada salida: el uno a uno se mide con TODOS los pendientes, no sólo con el de al lado.
  const reclamos = new Map<string, number>();
  for (const c of candidatas.values()) for (const s of c) reclamos.set(s.id, (reclamos.get(s.id) ?? 0) + 1);
  // `[PGP.201]` Las salidas que ya tomó un pago partido en esta misma pasada: un grupo no explica dos pagos.
  const reclamadasPorGrupo = new Set<string>();

  for (const p of vigentes) {
    if (cobros.has(p.id)) continue;
    if (p.metodo && NO_TRANSFERENCIA.has(p.metodo)) {
      out.set(p.id, { estado: 'excluido', motivo: p.metodo === 'cheque'
        ? 'Pago con cheque sin número en la referencia: no hay con qué casar su cobro, sigue a mano'
        : 'Pago en efectivo: no pasa por el banco' });
      continue;
    }
    const c = candidatas.get(p.id) ?? [];
    if (!c.length) {
      // `[PGP.201]` Sin una salida por el importe completo: ¿lo pagaron varias con la misma referencia?
      const gs = gruposQueCasan(p, libres);
      if (gs.length === 1 && !gs[0].some((s) => reclamos.has(s.id) || reclamadasPorGrupo.has(s.id))) {
        const g = [...gs[0]].sort((a, b) => b.importe - a.importe || a.id.localeCompare(b.id));
        for (const s of g) reclamadasPorGrupo.add(s.id);
        out.set(p.id, { estado: 'probado', movimiento_id: g[0].id, cuenta_id: g[0].cuenta_id, fecha: g[0].fecha,
          importe: Math.round(g.reduce((t, s) => t + s.importe, 0) * 100) / 100, grupo: g.map((s) => s.id) });
        continue;
      }
      if (gs.length) {
        out.set(p.id, { estado: 'disputada', motivo: gs.length > 1
          ? `Hay ${gs.length} grupos de transferencias que suman el importe: no se sabe cuál es el de este pago`
          : 'Las transferencias que suman el importe también casan con otro pago: no se sabe de cuál son' });
        continue;
      }
      out.set(p.id, { estado: 'sin_salida', motivo: `El banco no tiene una salida de $${p.importe.toFixed(2)} (±$${TOLERANCIA_BANCO}) entre ${VENTANA_BANCO_DIAS} días antes y después del ${p.dia}` });
      continue;
    }
    const cuentas = new Set(c.map((s) => s.cuenta_id));
    if (cuentas.size > 1) {
      out.set(p.id, { estado: 'varias_cuentas', motivo: `El mismo importe salió de ${cuentas.size} cuentas en esos días: no se adivina de cuál fue` });
      continue;
    }
    if (c.length > 1 || (reclamos.get(c[0].id) ?? 0) > 1) {
      out.set(p.id, { estado: 'disputada', motivo: c.length > 1
        ? `Hay ${c.length} salidas de ese importe en esa cuenta: no se sabe cuál es la de este pago`
        : 'La misma salida del banco casa con otro pago pendiente: no se sabe de cuál es' });
      continue;
    }
    out.set(p.id, { estado: 'probado', movimiento_id: c[0].id, cuenta_id: c[0].cuenta_id, fecha: c[0].fecha, importe: c[0].importe });
  }
  return out;
}

/** `[PGP.146]` Un pago que reclama una salida de la descarga: pendiente o ya pagado (el pagado sigue siendo su dueño). */
export interface ReclamanteDeLaDescarga extends PagoPendiente {
  status: string;
  /** La cuenta que alguien preparó; null = nadie la preparó (casi todos). Sólo acota de qué cuentas se dice «no cubre». */
  cuenta_planeada: string | null;
}

/** `[PGP.146]` Hasta qué día cubre la descarga una cuenta de banco activa (null = nunca se subió). */
export interface CoberturaDeLaDescarga {
  cuenta_id: string;
  cuenta: string;
  hasta: string | null;
  /** `[PGP.202]` Sin descarga nunca y sin pagos de Kepler desde ella en 90 días: no cuenta para el pago sin cuenta preparada. */
  dormida?: boolean;
}

const masDias = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * `[PGP.146]` **Qué dice la descarga del banco de cada pago pendiente cuyo día ya llegó.** La regla es la de
 * `decidirPagosPorElBanco` (±$1, ±3 días, una sola cuenta, uno a uno), con dos diferencias que la hacen más
 * prudente, porque aquí nadie guardó qué salida es de qué pago:
 * - **Los pagados también reclaman.** Un pago que Kepler o el libro ya dieron por pagado sigue siendo dueño de su
 *   salida; si un pendiente por el mismo importe la reclama también, es `no_decide`, no `salio`.
 * - **«Sin salida» no es «no se pagó»**: se dice qué cuentas no cubren los días de la ventana (sólo la preparada,
 *   si alguien la preparó; si no, todas las de banco menos las dormidas, `[PGP.202]`).
 * Sólo lee. El resultado trae únicamente los pendientes con día ≤ hoy.
 */
export function segunLaDescarga(
  reclamantes: readonly ReclamanteDeLaDescarga[], salidas: readonly SalidaBanco[],
  cobertura: readonly CoberturaDeLaDescarga[], hoy: string,
): Map<string, SalidaSegunLaDescarga> {
  const decisiones = decidirPagosPorElBanco(reclamantes, salidas, hoy);
  const alias = new Map(cobertura.map((c) => [c.cuenta_id, c.cuenta]));
  const out = new Map<string, SalidaSegunLaDescarga>();
  for (const p of reclamantes) {
    if (p.status !== 'pending' || p.dia > hoy) continue;
    const d = decisiones.get(p.id);
    if (!d) continue;
    if (d.estado === 'probado') {
      out.set(p.id, { estado: 'salio', fecha: d.fecha, cuenta_id: d.cuenta_id, cuenta: alias.get(d.cuenta_id) ?? 'cuenta sin nombre', importe: d.importe });
    } else if (d.estado === 'sin_salida') {
      const necesita = [masDias(p.dia, VENTANA_BANCO_DIAS), hoy].sort()[0];
      const cuentas = p.cuenta_planeada ? cobertura.filter((c) => c.cuenta_id === p.cuenta_planeada) : cobertura.filter((c) => !c.dormida);
      const sinCubrir = cuentas.filter((c) => !c.hasta || c.hasta < necesita).map((c) => ({ cuenta: c.cuenta, hasta: c.hasta }));
      out.set(p.id, { estado: 'sin_salida', revisadas: cuentas.length - sinCubrir.length, sin_cubrir: sinCubrir });
    } else {
      out.set(p.id, { estado: 'no_decide', motivo: d.motivo });
    }
  }
  return out;
}
