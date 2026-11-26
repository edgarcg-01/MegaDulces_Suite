/**
 * `[PGP.218]` **Antes del programa, el dinero del cargo en su cuenta** (anexo CR §3.0, DCR9 de Francisco: «que el
 * cargo se contemple antes de hacer el programa, para evitar moras, intereses o gastos de cobranza»).
 *
 * Por cada cuenta de origen: el saldo al cierre de su último día conocido (`saldosConocidos`, el instrumento de
 * Bancos), menos lo que ya sale de ella en la ventana, menos los cargos que el banco va a cobrar solo en la ventana,
 * menos su saldo mínimo. Los depósitos por venir NO se suman: el cálculo es del lado seguro.
 *
 * ⭐ El cargo sin cubrir se busca EN ORDEN DE FECHA, con el cargo antes que los pagos de su mismo día (el banco
 * cobra la domiciliación al abrir el día): es el que el aviso nombra, «no cubre el cargo de X del D: faltan $Y».
 *
 * Lo que no se sabe se dice: sin saldo → `no_medido` (nunca «alcanza»); saldo de hace más de 2 días → `saldo_viejo`;
 * sin saldo mínimo registrado → `saldo_minimo: null` (cuenta cero); sin la vista de cargos → `cargos_medidos: false`;
 * un cargo con más de 31 días de atraso → `cargos_detenidos` (no se cuenta, y se lista).
 *
 * Vive en contracts porque la usan los dos lados: el servidor arma la suficiencia de hoy y la pantalla de «Preparar
 * pago» vuelve a recorrer la cuenta CON el pago que se está preparando (`conUnPagoMas`). Una regla, no dos.
 *
 * Medido el 2026-11-25 contra prod, reconstruyendo el día: Santander 2169 cerró el 12-nov con $31,144.45 y esperaba
 * para el 14 los 4 cargos de la arrendadora ($79,876): faltaban $48,731.55 aun sin programa; el banco los cobró el
 * 13, 17, 18 y 23. BanBajío 4166 cerró el 16-jul con $729,576.86 y el 17 salieron $738,682.31: faltaban $9,105.45;
 * ese día el banco rechazó un pago por intento de sobregiro y cobró la penalización.
 */

/** La ventana: hoy y los próximos 7 días (anexo CR §3.0). */
export const DIAS_DE_LA_VENTANA = 7;
/** Más de 2 días sin descarga: el aviso dice «saldo de hace N días». */
export const DIAS_SALDO_VIEJO = 2;
/**
 * Un cargo cuyo día pasó hace MÁS de 31 días y que el banco no ha cobrado ya se saltó un ciclo entero: el del mes
 * siguiente también debió llegar. No se cuenta ni se le busca dinero; se muestra aparte (`cargos_detenidos`).
 * Por qué: la vigencia de `[PGP.209]` se mide contra el último movimiento de SU cuenta (una cuenta sin descarga no
 * apaga sus series), y eso dejaba en la ventana cargos de agosto. Medido el 2026-11-26 contra prod: Santander 5565
 * salía «no alcanza, faltan $83.20» por un IVA esperado el 1-ago (saldo del libro de hace 115 días) y BanBajío 3660
 * con una penalización del 31-ago «atrasada»: 1 de las 3 cuentas del aviso era falsa. El atraso más largo de un
 * cargo vivo que se midió fue de 11 días (la arrendadora, en noviembre): 31 deja holgura de sobra.
 */
export const DIAS_CARGO_DETENIDO = 31;

/**
 * Un cargo que el banco cobra solo y que cae en la ventana de una cuenta. Mientras no hay contrato confirmado sale de
 * la historia del banco (`[PGP.209]`): «esperado por historia».
 */
export interface CargoEsperadoDeLaCuenta {
  series_key: string;
  origen: 'historia';
  /** La cabeza del concepto con que el banco lo cobra (p. ej. «DOMICILIACION PAGO SERVICIO»). */
  concepto: string;
  /** El concepto completo del último cobro, para reconocerlo. */
  concepto_reciente: string | null;
  /** Cuándo se espera (YYYY-MM-DD). */
  fecha: string;
  importe: number;
  /** Importe variable (un interés): se espera el último cobrado. */
  estimado: boolean;
  /** Su fecha ya pasó y el banco todavía no lo cobra. */
  atrasado: boolean;
  /** En el recorrido de la cuenta, ¿cabe? `null` = la cuenta no tiene saldo medido: no se sabe. */
  cubierto: boolean | null;
}

/** Un pago del Calendario que sale de esa cuenta en la ventana. */
export interface PagoDeLaCuenta {
  allocation_id: string;
  fecha: string;
  importe: number;
  /** Ya se marcó pagado, pero la descarga del banco todavía no lo muestra: se resta del saldo. */
  ejecutado_sin_descarga: boolean;
}

export type EstadoDeSuficiencia = 'alcanza' | 'no_alcanza' | 'no_medido';

export type CargoSinCubrir = CargoEsperadoDeLaCuenta & { faltan: number };

/** ¿Le alcanza a la cuenta para lo programado y para los cargos que el banco va a cobrar? */
export interface SuficienciaDeCuenta {
  bank_account_id: string;
  bank: string;
  account_label: string;
  alias: string | null;
  /** El saldo al cierre del último día conocido (la descarga del banco; si no hay, el libro). `null` = no medido. */
  saldo: number | null;
  saldo_fecha: string | null;
  saldo_fuente: 'banco' | 'libro' | null;
  /** Días entre la fecha del saldo y hoy. */
  saldo_dias: number | null;
  /** Más de 2 días: el aviso dice «saldo de hace N días». */
  saldo_viejo: boolean;
  /** `null` = la cuenta no tiene saldo mínimo registrado (se cuenta en cero y se dice). */
  saldo_minimo: number | null;
  pagos: PagoDeLaCuenta[];
  programado: number;
  cargos: CargoEsperadoDeLaCuenta[];
  cargos_total: number;
  /**
   * Los cargos cuyo día pasó hace más de `DIAS_CARGO_DETENIDO` días sin que el banco los cobre: NO están en `cargos`,
   * ni en `cargos_total`, ni en el recorrido. Se listan para que se vea qué se dejó de contar.
   */
  cargos_detenidos: CargoEsperadoDeLaCuenta[];
  /** saldo − programado − cargos − saldo mínimo. `null` si no hay saldo. */
  disponible: number | null;
  /** Lo que hay que meter a la cuenta para cubrir todo (0 si alcanza). `null` si no hay saldo. */
  faltan: number | null;
  estado: EstadoDeSuficiencia;
  /** El primer cargo que, en orden de fecha (el cargo antes que los pagos de su día), la cuenta no cubre. */
  cargo_sin_cubrir: CargoSinCubrir | null;
  /** Lo programado solo ya pasa el saldo. */
  programa_excede: boolean;
}

/** La suficiencia de las cuentas de origen: hoy y los próximos `dias`. Sólo lectura. */
export interface PaymentCalendarSuficiencia {
  hoy: string;
  hasta: string;
  dias: number;
  cuentas: SuficienciaDeCuenta[];
  /** Pagos pendientes de la ventana sin cuenta de origen (se elige al preparar): no se cuentan en ninguna cuenta. */
  sin_cuenta: { pagos: number; importe: number };
  /** `false` = la vista de cargos recurrentes no está (migración de `[PGP.209]` sin aplicar): los cargos NO se midieron. */
  cargos_medidos: boolean;
}

// ─── La entrada (la arma el servidor) ──────────────────────────────────────────────────────────

/** El último saldo conocido de una cuenta (la forma de `saldosConocidos` de Bancos). */
export interface SaldoDeLaCuenta { saldo: number; fecha: string; fuente: 'banco' | 'libro' }

export interface CuentaDeOrigen { id: string; bank: string; account_label: string; alias: string | null }

/** Una serie de `finance.v_recurring_bank_charges`, vigente, con su próximo cargo dentro de la ventana. */
export interface SerieEsperada {
  bank_account_id: string;
  series_key: string;
  rule: 'fixed_amount' | 'variable_amount';
  concept_head: string;
  latest_concept: string | null;
  next_expected_date: string;
  expected_monthly_amount: number;
}

/** Un pago del Calendario con cuenta de origen: pendiente, o ya pagado sin que la descarga lo muestre todavía. */
export interface PagoConCuenta {
  allocation_id: string;
  bank_account_id: string;
  /** El día del pago (pendiente) o el día en que se marcó pagado (ejecutado). */
  fecha: string;
  importe: number;
  ejecutado: boolean;
}

export interface EntradaDeSuficiencia {
  hoy: string;
  hasta: string;
  cuentas: readonly CuentaDeOrigen[];
  saldos: ReadonlyMap<string, SaldoDeLaCuenta | null>;
  /** `null` = la vista de cargos no está: no se midieron. */
  series: readonly SerieEsperada[] | null;
  pagos: readonly PagoConCuenta[];
  sinCuenta: { pagos: number; importe: number };
  /** Saldo mínimo por cuenta; la que no está, no lo tiene registrado. */
  minimos?: ReadonlyMap<string, number>;
}

const centavos = (n: number) => Math.round(n * 100);
const pesos = (c: number) => c / 100;
const diasEntre = (desde: string, hasta: string) =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);

/** El día `n` días después de `fecha` (YYYY-MM-DD). */
export function masDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function armarSuficiencia(e: EntradaDeSuficiencia): PaymentCalendarSuficiencia {
  const cuentas = e.cuentas.map((c) => suficienciaDeUnaCuenta(c, e));
  return {
    hoy: e.hoy, hasta: e.hasta, dias: diasEntre(e.hoy, e.hasta), cuentas,
    sin_cuenta: { pagos: e.sinCuenta.pagos, importe: pesos(centavos(e.sinCuenta.importe)) },
    cargos_medidos: e.series !== null,
  };
}

/**
 * El recorrido en orden de fecha: lo vencido (pago o cargo atrasado) cuenta desde hoy, el cargo va antes que los
 * pagos de su día, y lo ya pagado sin descarga sale primero (el dinero ya no está). Devuelve el primer cargo que no
 * cabe, lo que falta para cubrirlo y la llave de cada cargo que no cabe.
 */
function recorrer(
  saldo: number, minimo: number | null, pagos: readonly PagoDeLaCuenta[], cargos: readonly CargoEsperadoDeLaCuenta[], hoy: string,
): { primero: CargoSinCubrir | null; sinCubrir: Set<string> } {
  type Evento = { fecha: string; orden: number; centavos: number; cargo: CargoEsperadoDeLaCuenta | null };
  const ev: Evento[] = [
    ...pagos.map((p) => ({ fecha: p.ejecutado_sin_descarga ? '' : (p.fecha < hoy ? hoy : p.fecha), orden: 1, centavos: centavos(p.importe), cargo: null })),
    ...cargos.map((x) => ({ fecha: x.fecha < hoy ? hoy : x.fecha, orden: 0, centavos: centavos(x.importe), cargo: x })),
  ].sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.orden - b.orden));
  let corre = centavos(saldo) - centavos(minimo ?? 0);
  let primero: CargoSinCubrir | null = null;
  const sinCubrir = new Set<string>();
  for (const x of ev) {
    corre -= x.centavos;
    if (x.cargo && corre < 0) {
      sinCubrir.add(x.cargo.series_key);
      if (!primero) primero = { ...x.cargo, cubierto: false, faltan: pesos(-corre) };
    }
  }
  return { primero, sinCubrir };
}

function suficienciaDeUnaCuenta(c: CuentaDeOrigen, e: EntradaDeSuficiencia): SuficienciaDeCuenta {
  const s = e.saldos.get(c.id) ?? null;
  const minimo = e.minimos?.get(c.id) ?? null;

  const enLaVentana: CargoEsperadoDeLaCuenta[] = (e.series ?? [])
    .filter((x) => x.bank_account_id === c.id && x.next_expected_date <= e.hasta)
    .map((x) => ({
      series_key: x.series_key, origen: 'historia' as const, concepto: x.concept_head, concepto_reciente: x.latest_concept,
      fecha: x.next_expected_date, importe: pesos(centavos(Number(x.expected_monthly_amount))),
      estimado: x.rule === 'variable_amount', atrasado: x.next_expected_date < e.hoy, cubierto: null as boolean | null,
    }))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.concepto.localeCompare(b.concepto)));
  const limiteDetenido = masDias(e.hoy, -DIAS_CARGO_DETENIDO);
  const cargos = enLaVentana.filter((x) => x.fecha >= limiteDetenido);
  const cargosDetenidos = enLaVentana.filter((x) => x.fecha < limiteDetenido);

  // Lo pagado que la descarga ya muestra está en el saldo; sólo resta lo marcado pagado DESPUÉS del día del saldo.
  const pagos: PagoDeLaCuenta[] = e.pagos
    .filter((p) => p.bank_account_id === c.id && p.fecha <= e.hasta && (!p.ejecutado || (s !== null && p.fecha > s.fecha)))
    .map((p) => ({ allocation_id: p.allocation_id, fecha: p.fecha, importe: pesos(centavos(p.importe)), ejecutado_sin_descarga: p.ejecutado }))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));

  const programado = pesos(pagos.reduce((t, p) => t + centavos(p.importe), 0));
  const cargosTotal = pesos(cargos.reduce((t, x) => t + centavos(x.importe), 0));
  const base = {
    bank_account_id: c.id, bank: c.bank, account_label: c.account_label, alias: c.alias,
    saldo_minimo: minimo, pagos, programado, cargos, cargos_total: cargosTotal, cargos_detenidos: cargosDetenidos,
  };
  if (s === null) {
    return {
      ...base, saldo: null, saldo_fecha: null, saldo_fuente: null, saldo_dias: null, saldo_viejo: false,
      disponible: null, faltan: null, estado: 'no_medido', cargo_sin_cubrir: null, programa_excede: false,
    };
  }
  const disponible = pesos(centavos(s.saldo) - centavos(programado) - centavos(cargosTotal) - centavos(minimo ?? 0));
  const saldoDias = Math.max(0, diasEntre(s.fecha, e.hoy));
  const r = recorrer(s.saldo, minimo, pagos, cargos, e.hoy);
  return {
    ...base,
    cargos: cargos.map((x) => ({ ...x, cubierto: !r.sinCubrir.has(x.series_key) })),
    saldo: s.saldo, saldo_fecha: s.fecha, saldo_fuente: s.fuente, saldo_dias: saldoDias, saldo_viejo: saldoDias > DIAS_SALDO_VIEJO,
    disponible, faltan: disponible < 0 ? -disponible : 0,
    estado: disponible < 0 ? 'no_alcanza' : 'alcanza',
    cargo_sin_cubrir: r.primero,
    programa_excede: centavos(s.saldo) - centavos(minimo ?? 0) - centavos(programado) < 0,
  };
}

/** Lo que pasaría con la cuenta si además saliera este pago. `null` si la cuenta no tiene saldo (no se sabe). */
export interface ConUnPagoMas {
  /** Lo que quedaría (saldo − programado − cargos − mínimo − este pago); negativo = falta. */
  disponible: number;
  faltan: number;
  cargo_sin_cubrir: CargoSinCubrir | null;
  /** El pago ya estaba contado en la cuenta (ya se había preparado desde ella): no se suma dos veces. */
  ya_contado: boolean;
}

/**
 * `[PGP.218]` La pregunta de «Preparar pago»: si este pago sale de ESTA cuenta, ¿qué cargo del banco deja sin cubrir?
 * Vuelve a recorrer la cuenta con la misma regla, con el pago en su día. Si el pago ya estaba contado (se está
 * re-preparando desde la misma cuenta) no se suma otra vez.
 */
export function conUnPagoMas(c: SuficienciaDeCuenta, hoy: string, pago: { allocation_id: string; fecha: string; importe: number }): ConUnPagoMas | null {
  if (c.saldo === null) return null;
  const yaContado = c.pagos.some((p) => p.allocation_id === pago.allocation_id);
  const pagos = yaContado
    ? c.pagos
    : [...c.pagos, { allocation_id: pago.allocation_id, fecha: pago.fecha, importe: pesos(centavos(pago.importe)), ejecutado_sin_descarga: false }];
  const extra = yaContado ? 0 : centavos(pago.importe);
  const disponible = pesos(centavos(c.disponible ?? 0) - extra);
  return {
    disponible, faltan: disponible < 0 ? -disponible : 0,
    cargo_sin_cubrir: recorrer(c.saldo, c.saldo_minimo, pagos, c.cargos, hoy).primero,
    ya_contado: yaContado,
  };
}
