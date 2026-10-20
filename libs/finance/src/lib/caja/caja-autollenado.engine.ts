/**
 * `[CG.190]` — **El autollenado: el movimiento no se teclea y tampoco se confirma a mano.**
 *
 * ── El pedido ────────────────────────────────────────────────────────────────────────────────
 * Edgar, 2026-10-16: *«nada de registrar movimientos a mano en `/finanzas/caja-general`… necesito
 * que todo ingreso o egreso lo autorrelles con información verídica y confiable… automatiza el
 * 100 % del llenado de los movimientos pasados, actuales y futuros»*.
 *
 * ── Qué cambia, y qué NO ─────────────────────────────────────────────────────────────────────
 * `[CG.20]`/`[CG.21]` ya habían quitado el **tecleo**: el movimiento se arma desde el documento de
 * Kepler y la persona sólo lo marcaba. Lo que queda por quitar es **el clic**: que nadie tenga que
 * entrar a la pantalla para que el libro refleje lo que el ERP ya registró.
 *
 * ⛔ **Lo que este motor NO hace, y es deliberado: no decide a qué cuenta va el dinero.** Esa
 * decisión vive donde ya vivía —`CashLedgerService.resolverCuentas()` (ruta declarada → regla
 * declarada → la póliza del propio documento)— y este motor **sólo elige a cuáles de sus
 * veredictos les da curso**. Duplicar el resolvedor acá sería fabricar una segunda verdad sobre
 * la misma pregunta, que es el defecto que `[CG.27-B.0]` ya pagó una vez entre la bandeja y el
 * autofill.
 *
 * ── Lo medido que lo justifica (prod, `system_identifier 7688376744939610156`, 2026-10-16) ───
 * Sobre la bandeja en el alcance vigente (desde el 10-oct), **130 movimientos / $530,341.82**,
 * corriendo el resolvedor REAL fila por fila:
 *
 *     ✅ se resuelve sin que nadie elija nada ...  117  (90.0 %)  $445,761.53
 *        · por la póliza del documento .........  113            $357,799.03
 *        · por el nombre de la cuenta ..........    3            $ 77,472.50
 *        · por regla declarada .................    1            $ 10,490.00
 *     ⛔ necesita a una persona ................   13  (10.0 %)  $ 84,580.29
 *        · mal fechados en Kepler ..............    7            $ 50,796.40
 *        · sucursal compuesta (defecto nuestro)     3            $ 32,083.89
 *        · póliza todavía sin postear ..........    3            $  1,700.00
 *
 * Y los dos huecos que no eran «falta configurar» resultaron **derivables**:
 *
 *  1. **Los 3 de sucursal compuesta eran un defecto nuestro**, corregido en `[CG.189]`
 *     (`sucursalBase()`): su póliza ya traía `115 ABONO A CLIENTES` y el nombre casa con un único
 *     concepto (`071`). Con el arreglo, se resuelven solos.
 *  2. **Los 3 `sin_regla` no necesitan regla: necesitan ESPERAR.** Medido, la cobertura de
 *     `analytics.v_caja_doc_contracuenta` sube con la edad del documento —
 *     **90.5 % a 0-2 días · 99.4 % a 3-7 · 100.0 % a 8-30 · 99.8 % a +30** — porque la póliza se
 *     postea en Kepler unos días después. Un documento que hoy no resuelve, resuelve solo.
 *     ⇒ **El mecanismo correcto es REINTENTAR, no adivinar**, y es la razón de que esto sea un
 *     cron y no un botón.
 *
 * ── ⛔⛔ La hipótesis que se midió y se DESCARTÓ, para que nadie la reconstruya ───────────────
 * Parecía natural rellenar lo que la póliza no cubre con el **Nivel 2** de ADR-070 §8.3 (lo que
 * contabilidad ya posteó para ese beneficiario, `analytics.expense_entries`). Se midió con
 * control: sobre los 120 pendientes donde la póliza SÍ resolvió —o sea donde hay respuesta
 * correcta contra la cual medir— la historia coincidió en **0 de 120 (0.0 %)**: discrepó en 25 y
 * no propuso en 95.
 *
 * ⭐ Y la causa no es ruido, es que **contestan preguntas distintas**: la póliza del pago dice
 * `201 PASIVO A PROVEEDORES` (el pago **salda un pasivo**) y la historia del gasto dice
 * `602-013`, `611-002`, `611-006` (dónde se **devengó el costo**). Las dos son correctas. Usar la
 * historia acá habría registrado cada pago como si fuera el gasto original — **contando el costo
 * dos veces**. El testigo del mismo grano lo confirma: para esos mismos beneficiarios, la póliza
 * de sus documentos hermanos postea `201` en el **96.0 % / 98.6 % / 99.6 %** de los casos.
 *
 * ⇒ **El Nivel 2 no entra al autollenado.** Sirve para sugerirle a una persona, no para decidir
 * solo.
 */

/**
 * ⭐⭐ **Desde dónde se llena, y por qué una fecha y no «todo».**
 *
 * Decisión de Edgar, 2026-10-16: *«nos enfocamos del día 10 para adelante, todo lo anterior ya
 * debería estar conciliado»*. El 10-oct es el último día que vivió en el Access `Control`; lo de
 * antes es historia de ese sistema, no cola de trabajo.
 *
 * ⛔ **No es una preferencia: sin piso, el autollenado escribiría 13,206 movimientos por
 * $162,080,748.92** que ya están conciliados del otro lado, y el libro pasaría a tener el mismo
 * dinero dos veces. El piso es lo que separa «automatizar el llenado» de «duplicar la
 * contabilidad».
 *
 * ⚠️ Se puede mover con `CAJA_AUTOLLENADO_PISO` (YYYY-MM-DD) sin redeploy, pero **moverlo hacia
 * atrás es una decisión de alcance contable**, no un parámetro de operación.
 */
export const PISO_ALCANCE_DEFAULT = '2026-10-10';

/** Cuántos documentos pide por vuelta. El tope de `movimientosPendientes()` es 500. */
export const TAMANO_PAGINA = 200;

/**
 * Cuántas vueltas da una corrida como máximo.
 *
 * No hay paginación por `offset`: cada confirmación **saca la fila de la cola** (la vista excluye
 * lo ya capturado por `origen_ref`), así que la vuelta siguiente trae lo que quedó. El tope existe
 * para que una fila que se niega a confirmarse por un motivo que el resolvedor no cambia no
 * convierta la corrida en un bucle — y cuando se toca, la corrida lo DECLARA (`tope_alcanzado`)
 * en vez de terminar callada como si hubiera vaciado la cola.
 */
export const MAX_VUELTAS = 12;

/** Por qué una fila pendiente no la tomó el autollenado. */
export type MotivoExclusion =
  /** El ERP fechó el documento después de hoy. Se corrige en Kepler, no acá. */
  | 'fecha_futura'
  /** El resolvedor no llegó a un par (cuenta, concepto) sin que alguien elija. */
  | 'sin_resolver'
  /** Cae antes del piso de alcance: es historia del Access, no cola de trabajo. */
  | 'fuera_de_alcance';

export interface PendienteResuelto {
  origen_ref: string;
  tipo?: string | null;
  fecha_valor?: string | Date | null;
  monto?: number | string | null;
  /** Lo que dictaminó `resolverCuentas()`. */
  confirmable?: boolean;
  /** Su motivo cuando `confirmable` es falso. */
  motivo?: string | null;
  motivo_texto?: string | null;
}

export interface Excluido {
  origen_ref: string;
  motivo: MotivoExclusion;
  /** El motivo fino del resolvedor (`sin_regla`, `elegir_concepto`…), tal cual vino. */
  detalle: string | null;
  monto: number;
}

export interface PlanVuelta {
  /** Los `origen_ref` que se van a confirmar, en orden estable. */
  aplicar: string[];
  /** Todo lo que NO se toca, con su motivo. Nunca se descarta en silencio. */
  excluidos: Excluido[];
  /** Suma de lo que se va a aplicar. Sirve para el renglón del latido. */
  monto_aplicar: number;
}

/** `YYYY-MM-DD` de una fecha que puede venir como `Date` (node-pg) o como texto. */
export function diaDe(f: string | Date | null | undefined): string {
  if (!f) return '';
  if (f instanceof Date) {
    // ⛔ Nada de `toISOString()`: corre el día seis horas y el corte caería en la tarde. Es el
    // mismo defecto que `[CG.162]` ya pagó sobre esta misma columna.
    return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
  }
  return String(f).slice(0, 10);
}

export function n2(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
}

/**
 * Parte las filas de una vuelta en **lo que se aplica** y **lo que se declara**.
 *
 * ⛔ **Las tres exclusiones son distintas y no se funden.** `fecha_futura` lo arregla Kepler,
 * `sin_resolver` lo arregla el tiempo (la póliza) o una persona, y `fuera_de_alcance` no es un
 * problema: es la decisión del piso. Un solo contador de «no se pudo» las volvería indistinguibles
 * y nadie sabría a quién le toca.
 *
 * ⚠️ `fecha_futura` se filtra **acá además de en `crearLote()`**. No es redundancia por gusto: un
 * documento fechado en diciembre entrando solo al libro mueve el mes en curso sin que nadie lo
 * haya pedido, y `[CG.24]` ya demostró que un aviso que no frena es decoración. Dos frenos sobre
 * dinero que se escribe sin supervisión humana es el número correcto.
 */
export function planearVuelta(
  rows: readonly PendienteResuelto[] | null | undefined,
  opts: { piso: string; hoy: string },
): PlanVuelta {
  const aplicar: string[] = [];
  const excluidos: Excluido[] = [];
  let monto_aplicar = 0;

  for (const r of rows ?? []) {
    if (!r?.origen_ref) continue;
    const monto = n2(r.monto);
    const dia = diaDe(r.fecha_valor);

    if (dia && opts.piso && dia < opts.piso) {
      excluidos.push({ origen_ref: r.origen_ref, motivo: 'fuera_de_alcance', detalle: dia, monto });
      continue;
    }
    // El freno de fecha futura va antes que el veredicto: aunque el resolvedor haya llegado a un
    // par contable, un documento de mañana no entra.
    if (dia && opts.hoy && dia > opts.hoy) {
      excluidos.push({ origen_ref: r.origen_ref, motivo: 'fecha_futura', detalle: dia, monto });
      continue;
    }
    if (r.confirmable !== true) {
      excluidos.push({
        origen_ref: r.origen_ref,
        motivo: 'sin_resolver',
        detalle: r.motivo ? String(r.motivo) : null,
        monto,
      });
      continue;
    }
    aplicar.push(r.origen_ref);
    monto_aplicar = n2(monto_aplicar + monto);
  }

  return { aplicar, excluidos, monto_aplicar };
}

export interface ResultadoFila {
  origen_ref: string;
  estado: 'guardado' | 'duplicado' | 'rechazado' | 'no_confirmable';
  folio?: string | null;
  motivo?: string | null;
}

export interface ResumenCorrida {
  /** Movimientos que ESTE motor escribió al libro. Es lo que late como `rowsAffected`. */
  registrados: number;
  monto_registrado: number;
  /** Ya estaban: otra corrida o una persona los confirmó antes. No es un error. */
  duplicados: number;
  /** El servidor los rechazó. Cada uno con su mensaje: un rechazo callado se lee como guardado. */
  rechazados: number;
  /** Lo que se dejó fuera a propósito, por motivo. */
  excluidos: Record<MotivoExclusion, { movimientos: number; monto: number }>;
  /** El detalle fino de `sin_resolver` (`sin_regla`, `elegir_concepto`, `sin_mapa`…). */
  sin_resolver_detalle: Record<string, number>;
  vueltas: number;
  /** `true` si la corrida paró por `MAX_VUELTAS` y NO porque la cola se vaciara. */
  tope_alcanzado: boolean;
  /** Mensajes de las filas rechazadas, para el latido. */
  fallas: string[];
}

export function resumenVacio(): ResumenCorrida {
  return {
    registrados: 0,
    monto_registrado: 0,
    duplicados: 0,
    rechazados: 0,
    excluidos: {
      fecha_futura: { movimientos: 0, monto: 0 },
      sin_resolver: { movimientos: 0, monto: 0 },
      fuera_de_alcance: { movimientos: 0, monto: 0 },
    },
    sin_resolver_detalle: {},
    vueltas: 0,
    tope_alcanzado: false,
    fallas: [],
  };
}

/**
 * Acumula una vuelta en el resumen de la corrida.
 *
 * ⚠️ Los **excluidos se PISAN, no se suman**, y es a propósito: las mismas filas vuelven a
 * aparecer en cada vuelta (no se confirmaron, siguen en la cola), así que sumarlas multiplicaría
 * el rezago por el número de vueltas. Lo que vale es la foto de la ÚLTIMA vuelta, que es el estado
 * en que quedó la cola. Los registrados sí se suman: cada uno ocurrió una sola vez.
 */
export function acumular(
  acc: ResumenCorrida,
  plan: PlanVuelta,
  filas: readonly ResultadoFila[],
  montos: ReadonlyMap<string, number>,
): ResumenCorrida {
  const out: ResumenCorrida = { ...acc, vueltas: acc.vueltas + 1 };

  for (const f of filas) {
    if (f.estado === 'guardado') {
      out.registrados += 1;
      out.monto_registrado = n2(out.monto_registrado + n2(montos.get(f.origen_ref)));
    } else if (f.estado === 'duplicado') {
      out.duplicados += 1;
    } else {
      out.rechazados += 1;
      out.fallas = [...out.fallas, `${f.origen_ref}: ${f.motivo ?? f.estado}`];
    }
  }

  const ex: ResumenCorrida['excluidos'] = {
    fecha_futura: { movimientos: 0, monto: 0 },
    sin_resolver: { movimientos: 0, monto: 0 },
    fuera_de_alcance: { movimientos: 0, monto: 0 },
  };
  const det: Record<string, number> = {};
  for (const e of plan.excluidos) {
    ex[e.motivo].movimientos += 1;
    ex[e.motivo].monto = n2(ex[e.motivo].monto + e.monto);
    if (e.motivo === 'sin_resolver') {
      const k = e.detalle || 'sin_detalle';
      det[k] = (det[k] ?? 0) + 1;
    }
  }
  out.excluidos = ex;
  out.sin_resolver_detalle = det;
  return out;
}

/**
 * El renglón legible del latido. Dice lo que hizo **y lo que dejó**, porque un cron que sólo
 * reporta lo que logró no distingue «no había nada» de «no pudo con nada».
 */
export function notaDeCorrida(r: ResumenCorrida): string {
  const partes = [
    `${r.registrados} registrado${r.registrados === 1 ? '' : 's'} ($${r.monto_registrado.toLocaleString('es-MX')})`,
  ];
  if (r.duplicados) partes.push(`${r.duplicados} ya estaba${r.duplicados === 1 ? '' : 'n'}`);
  if (r.excluidos.sin_resolver.movimientos) {
    const d = Object.entries(r.sin_resolver_detalle)
      .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ');
    partes.push(`${r.excluidos.sin_resolver.movimientos} sin resolver${d ? ` (${d})` : ''}`);
  }
  if (r.excluidos.fecha_futura.movimientos) {
    partes.push(`${r.excluidos.fecha_futura.movimientos} mal fechado${r.excluidos.fecha_futura.movimientos === 1 ? '' : 's'} en Kepler`);
  }
  if (r.tope_alcanzado) partes.push(`⚠️ tope de ${MAX_VUELTAS} vueltas`);
  return partes.join(' · ');
}

/**
 * ⭐ **Por qué entregar CERO puede ser legítimo acá, y qué lo vuelve ilegítimo.**
 *
 * `latirCron` marca error cuando un job no escribe una sola fila, y hace bien: un cron que nunca
 * entrega suele estar muerto. Pero este motor **debe** entregar cero el día en que la cola está
 * vacía — que es el estado al que aspira.
 *
 * La excepción se acota: cero es `ok` **sólo si además no quedó nada sin resolver**. Si hay filas
 * en la cola y ninguna se registró, eso NO es una cola vacía: es un motor que no está pudiendo, y
 * tiene que verse rojo. Es la diferencia entre «no había trabajo» y «no hice el trabajo», que es
 * justo la que `[CG.162]` confundió durante 755 depósitos.
 */
export function motivoCeroOk(r: ResumenCorrida): string | undefined {
  if (r.registrados > 0) return undefined;
  if (r.excluidos.sin_resolver.movimientos > 0) return undefined;
  if (r.duplicados > 0) return 'la cola ya estaba cubierta: todo lo pendiente ya estaba en el libro';
  return 'no había documentos pendientes dentro del alcance';
}
