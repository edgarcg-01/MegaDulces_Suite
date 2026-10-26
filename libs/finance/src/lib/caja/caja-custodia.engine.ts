/**
 * ⭐⭐ `[CGA-A.50]` **El retiro de CAOS que se lleva una persona a pagar: una cuenta abierta a su
 * cargo, no efectivo del cajón.**
 *
 * Edgar, 2026-10-23: *«hoy sacan 200 mil del cajero porque saben que se van a pagar 200 mil;
 * entonces ese movimiento ya no se puede asociar a una salida de CAOS como tal»* — y después:
 * *«necesito que no arreglemos diferencias, es por eso que debemos vincular pequeñas»*.
 *
 * ── El defecto, medido en prod (sólo lectura, 2026-10-23) ───────────────────────────────────
 *
 * `[CG.96]` cuenta TODO lo dispensado como efectivo que entra al cajón ese día, y todo gasto como
 * efectivo que sale. Es correcto cuando el dinero de verdad pasa por el cajón. No lo es cuando
 * alguien retira en bulto y paga en los días siguientes:
 *
 *     19-oct  retirado $261,110 · gastos $32,705   → esperado +$228,405 de más → «falta» −$188,885
 *     21-oct  retirado $176,460 · gastos $573,568  → esperado −$221,512        → «sobra» +$245,269
 *
 * Ninguno de los dos números es un faltante ni un sobrante: es el mismo dinero contado en la
 * jornada equivocada. El cajón no lo tenía porque estaba **en la calle, pagando**.
 *
 * ── El modelo ───────────────────────────────────────────────────────────────────────────────
 *
 * Un retiro se CLASIFICA:
 *   · `cajon`    — los billetes entraron al cajón. Es lo de siempre (`[CG.96]`), y es también lo
 *                  que vale para un retiro sin clasificar, para no mover un solo corte viejo.
 *   · `custodia` — los billetes quedaron a cargo de una persona. NO entran al cajón. Cada gasto
 *                  pagado con ellos se ENLAZA al retiro y tampoco sale del cajón.
 *
 * Un retiro en custodia se cierra de una de tres formas, y sólo de ésas:
 *   · `regreso_caos` — lo que sobró volvió a la máquina (un depósito de CAOS: lo cuenta el equipo).
 *   · `cajon`        — lo que sobró se entregó al cajón ese día.
 *   · `faltante`     — no apareció: queda con monto y con nombre.
 *
 * ⚠️ Lo que este motor NO prueba: que un gasto enlazado sea VERDAD. Un gasto inventado se enlaza y
 * cuadra perfecto. Eso lo cierra la prueba de un tercero por gasto (CFDI / factura y recepción en
 * Kepler), que es otro item. Acá se garantiza que ningún peso quede sin explicación, no que la
 * explicación sea cierta.
 *
 * Puro y determinista: recibe los hechos ya leídos, no toca la base.
 */

const r2 = (n: number): number => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Tolerancia de redondeo, la misma del corte (`CORTE_EPSILON`). */
export const CUSTODIA_EPSILON = 0.01;

export type DestinoRetiro = 'cajon' | 'custodia';
export type CierreCustodia = 'regreso_caos' | 'cajon' | 'faltante';

/** Un retiro (Dispensar) de CAOS. `dia` = su jornada (`accounting_date`). */
export interface RetiroCaos {
  device: string;
  external_id: number;
  total: number;
  dia: string;
  /** `occurred_at` en ISO. Para la antigüedad. */
  at: string;
  operador: string | null;
}

/** La clasificación de un retiro, y su cierre si ya lo tuvo. */
export interface CustodiaRetiro {
  device: string;
  external_id: number;
  destino: DestinoRetiro;
  /** Quién lo tiene a su cargo. Obligatorio en `custodia`. */
  responsable: string | null;
  cierre?: {
    tipo: CierreCustodia;
    monto: number;
    /** Jornada del cierre. Un sobrante que vuelve al cajón entra a ESE corte. */
    dia: string;
    /** El depósito de CAOS que lo regresó, cuando `tipo = 'regreso_caos'`. */
    deposito_external_id?: number | null;
  } | null;
}

/** Un pedazo de un gasto pagado con un retiro (`finance.caos_cash_links`). */
export interface EnlaceRetiro {
  device: string;
  external_id: number;
  cash_ledger_id: string;
  monto: number;
  /** Jornada del GASTO (`cash_ledger.fecha`), no la del retiro. */
  dia_gasto: string;
}

export type EstadoRetiro =
  /** No se dijo a dónde fue. Cuenta como cajón (lo de siempre) y frena el cierre del corte. */
  | 'sin_clasificar'
  | 'al_cajon'
  /** En custodia, con saldo, dentro del plazo. */
  | 'abierto'
  /** En custodia, con saldo, pasado el plazo. */
  | 'vencido'
  | 'cerrado'
  /** Cerrado, pero el cierre no explica todo el saldo (o explica de más). */
  | 'cerrado_con_diferencia'
  /** Enlazado por encima de lo que salió. La base lo impide; si aparece, se declara. */
  | 'excedido';

export interface SaldoRetiro {
  device: string;
  external_id: number;
  total: number;
  enlazado: number;
  /** Lo que explicó el cierre (regreso, cajón o faltante). 0 si sigue abierto. */
  cerrado: number;
  /** total − enlazado − cerrado. Lo que la persona todavía tiene que explicar. */
  disponible: number;
  estado: EstadoRetiro;
  responsable: string | null;
  /** Horas desde el retiro. `null` si `ahora` no se pudo leer. */
  horas: number | null;
  gastos: number;
}

const llave = (device: string, id: number): string => `${device}|${id}`;

/** Cuánto le queda a UN retiro y en qué estado está. */
export function saldoDeRetiro(
  retiro: RetiroCaos,
  custodia: CustodiaRetiro | null | undefined,
  enlaces: EnlaceRetiro[],
  ahora: string,
  plazoHoras: number,
): SaldoRetiro {
  const k = llave(retiro.device, retiro.external_id);
  const propios = enlaces.filter((e) => llave(e.device, e.external_id) === k);
  const enlazado = r2(propios.reduce((a, e) => a + Math.abs(Number(e.monto) || 0), 0));
  const total = r2(Math.abs(Number(retiro.total) || 0));
  const cerrado = custodia?.cierre ? r2(Math.abs(Number(custodia.cierre.monto) || 0)) : 0;
  const disponible = r2(total - enlazado - cerrado);
  const t0 = Date.parse(retiro.at);
  const t1 = Date.parse(ahora);
  const horas = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, Math.floor((t1 - t0) / 3_600_000)) : null;

  const base = {
    device: retiro.device, external_id: retiro.external_id, total, enlazado, cerrado, disponible,
    responsable: custodia?.responsable ?? null, horas, gastos: propios.length,
  };

  // El exceso se mira PRIMERO: un retiro enlazado de más esconde un gasto pagado con otro dinero.
  if (total - enlazado < -CUSTODIA_EPSILON) return { ...base, estado: 'excedido' };
  if (!custodia) return { ...base, estado: 'sin_clasificar' };
  if (custodia.destino === 'cajon') return { ...base, estado: 'al_cajon' };
  if (custodia.cierre) {
    return { ...base, estado: Math.abs(disponible) <= CUSTODIA_EPSILON ? 'cerrado' : 'cerrado_con_diferencia' };
  }
  if (disponible <= CUSTODIA_EPSILON) return { ...base, disponible: 0, estado: 'cerrado' };
  return { ...base, estado: horas != null && horas > plazoHoras ? 'vencido' : 'abierto' };
}

/**
 * Las cuatro piernas que un corte necesita para no contar la custodia como cajón.
 *
 * Se SUMAN al esperado de `[CG.96]` (ver `calcularCorte`):
 *
 *     esperado = … + dispensado − depositado            ← [CG.96], todo lo de la máquina
 *              − dispensado_en_custodia                 ← los retiros de HOY que se llevó alguien
 *              + gastos_de_custodia                     ← los gastos de HOY pagados con un retiro en custodia
 *              + sobrantes_al_cajon                     ← lo que HOY volvió de la custodia al cajón
 *              + regresos_a_caos                        ← los depósitos de HOY que vinieron de la custodia, no del cajón
 *
 * ⭐ Sin ninguna custodia declarada las cuatro dan 0 y el corte es idéntico al de hoy. Eso es lo
 * que permite entrar sin recalcular un solo corte cerrado.
 */
export interface PiernasCustodia {
  dispensado_en_custodia: number;
  gastos_de_custodia: number;
  sobrantes_al_cajon: number;
  regresos_a_caos: number;
  /** Retiros de la jornada que nadie clasificó: cuentan como cajón y frenan el cierre. */
  sin_clasificar: { retiros: number; monto: number };
}

export function piernasDeCustodia(
  dia: string,
  retiros: RetiroCaos[],
  custodias: CustodiaRetiro[],
  enlaces: EnlaceRetiro[],
): PiernasCustodia {
  const porRetiro = new Map(custodias.map((c) => [llave(c.device, c.external_id), c]));
  const enCustodia = (device: string, id: number) => porRetiro.get(llave(device, id))?.destino === 'custodia';

  let dispensado_en_custodia = 0;
  let sin_n = 0;
  let sin_monto = 0;
  for (const r of retiros) {
    if (r.dia !== dia) continue;
    const c = porRetiro.get(llave(r.device, r.external_id));
    if (!c) { sin_n += 1; sin_monto += Math.abs(Number(r.total) || 0); continue; }
    if (c.destino === 'custodia') dispensado_en_custodia += Math.abs(Number(r.total) || 0);
  }

  // Sólo los enlaces a un retiro EN CUSTODIA. Un gasto enlazado a un retiro que fue al cajón sí
  // salió del cajón: el retiro ya sumó al cajón y el gasto tiene que restar.
  const gastos_de_custodia = enlaces
    .filter((e) => e.dia_gasto === dia && enCustodia(e.device, e.external_id))
    .reduce((a, e) => a + Math.abs(Number(e.monto) || 0), 0);

  let sobrantes_al_cajon = 0;
  let regresos_a_caos = 0;
  for (const c of custodias) {
    if (c.destino !== 'custodia' || !c.cierre || c.cierre.dia !== dia) continue;
    const m = Math.abs(Number(c.cierre.monto) || 0);
    if (c.cierre.tipo === 'cajon') sobrantes_al_cajon += m;
    if (c.cierre.tipo === 'regreso_caos') regresos_a_caos += m;
    // `faltante` no entra a ningún lado: no apareció. Queda en el saldo de la persona.
  }

  return {
    dispensado_en_custodia: r2(dispensado_en_custodia),
    gastos_de_custodia: r2(gastos_de_custodia),
    sobrantes_al_cajon: r2(sobrantes_al_cajon),
    regresos_a_caos: r2(regresos_a_caos),
    sin_clasificar: { retiros: sin_n, monto: r2(sin_monto) },
  };
}

/** El ajuste neto al esperado. Positivo = el cajón debe tener MÁS que lo que decía `[CG.96]`. */
export function ajusteDeCustodia(p: PiernasCustodia | null | undefined): number {
  if (!p) return 0;
  return r2(-p.dispensado_en_custodia + p.gastos_de_custodia + p.sobrantes_al_cajon + p.regresos_a_caos);
}

/**
 * ¿Puede cerrar el corte? NO mientras haya retiros de la jornada sin clasificar: un retiro sin
 * destino hace que el esperado dependa de una suposición (que fue al cajón), y eso es exactamente
 * lo que produjo los ±$200,000 de octubre.
 */
export function custodiaPermiteCerrar(p: PiernasCustodia | null | undefined):
  { ok: true } | { ok: false; motivo: 'retiros_sin_clasificar'; retiros: number; monto: number } {
  if (!p || p.sin_clasificar.retiros === 0) return { ok: true };
  return { ok: false, motivo: 'retiros_sin_clasificar', retiros: p.sin_clasificar.retiros, monto: p.sin_clasificar.monto };
}

// ── `[CGA-A.55]` Los billetes del retiro ────────────────────────────────────────────────────

/** Piezas por `denom_key` del catálogo (`'500'`, `'200'`, … billetes; `'20m'`, `'10'`, … monedas). */
export type Piezas = Record<string, number>;

/** Valor de una llave del catálogo. `'20m'` es la moneda de $20. `null` si no es una llave. */
export function valorDeLlave(k: string): number | null {
  return /^[0-9]+(\.[0-9]+)?m?$/.test(k) ? Number(k.replace('m', '')) : null;
}

/** Las únicas llaves que la máquina entrega: billetes. */
export const LLAVES_BILLETE_CAOS = ['1000', '500', '200', '100', '50', '20'] as const;

export function valorDePiezas(p: Piezas | null | undefined): number {
  return r2(Object.entries(p ?? {}).reduce((a, [k, n]) => a + (valorDeLlave(k) ?? 0) * Number(n || 0), 0));
}

export interface RemanenteRetiro {
  /** Lo que debe quedar, por llave. Sólo llaves con piezas > 0. */
  remanente: Piezas;
  valor: number;
  /** Llaves donde se entregó más de lo que había. La base lo impide; si aparece, se declara. */
  faltan: Array<{ llave: string; faltan: number }>;
  /**
   * `false` si algún enlace no dice qué billetes salieron (los anteriores al 2026-10-26): entonces
   * el remanente por denominación NO se puede afirmar — sólo el monto.
   */
  completo: boolean;
}

/**
 * Lo que debe quedar de un retiro, por denominación (Edgar: *«ese movimiento tenía 100, los 4
 * movimientos usaron 80, deberían existir 20 en caja con cierta denominación»*):
 *
 *     remanente[d] = lo que trajo el retiro[d] (máquina) + el cambio que regresó[d] − lo entregado[d]
 */
export function remanenteDeRetiro(
  retiro: Piezas,
  enlaces: Array<{ billetes?: Piezas | null; cambio?: Piezas | null }>,
): RemanenteRetiro {
  const saldo = new Map<string, number>();
  const suma = (p: Piezas | null | undefined, signo: 1 | -1) => {
    for (const [k, n] of Object.entries(p ?? {})) saldo.set(k, (saldo.get(k) ?? 0) + signo * Number(n || 0));
  };
  suma(retiro, 1);
  let completo = true;
  for (const e of enlaces) {
    if (!e.billetes) completo = false;
    suma(e.billetes, -1);
    suma(e.cambio, 1);
  }
  const remanente: Piezas = {};
  const faltan: RemanenteRetiro['faltan'] = [];
  for (const [k, n] of [...saldo.entries()].sort((a, b) => (valorDeLlave(b[0]) ?? 0) - (valorDeLlave(a[0]) ?? 0))) {
    if (n > 0) remanente[k] = n;
    if (n < 0) faltan.push({ llave: k, faltan: -n });
  }
  return { remanente, valor: valorDePiezas(remanente), faltan, completo };
}

/**
 * ¿El depósito de CAOS es EXACTAMENTE lo que le quedaba al retiro? Se compara billete por billete:
 * la máquina contó el depósito, así que esto es el único cuadre de billetes que no declara nadie.
 * Las monedas del remanente no pueden volver a la máquina: si hay, el regreso no es completo.
 */
export function regresoCuadra(remanente: Piezas, deposito: Piezas):
  { ok: true } | { ok: false; diferencias: Array<{ llave: string; quedaba: number; regreso: number }> } {
  const llaves = new Set([...Object.keys(remanente), ...Object.keys(deposito)]);
  const diferencias: Array<{ llave: string; quedaba: number; regreso: number }> = [];
  for (const k of llaves) {
    const q = Number(remanente[k] ?? 0);
    const d = Number(deposito[k] ?? 0);
    if (q !== d) diferencias.push({ llave: k, quedaba: q, regreso: d });
  }
  return diferencias.length ? { ok: false, diferencias } : { ok: true };
}

// ── `[CGA-A.56]` De dónde salió el efectivo de un egreso ──────────────────────────────────────

export type OrigenEfectivo = 'caos' | 'cajon';
export type MotivoOrigen = 'falta_origen' | 'origen_invalido' | 'cajon_con_retiros' | 'caos_sin_retiro';

export const TEXTO_ORIGEN: Record<MotivoOrigen, string> = {
  falta_origen: 'Falta decir de dónde salió el dinero de este egreso: de qué retiro(s) de CAOS, o del cajón.',
  origen_invalido: 'El origen del dinero sólo puede ser retiros de CAOS o el cajón.',
  cajon_con_retiros: 'Dijiste que salió del cajón, pero el egreso tiene retiros de CAOS enlazados. Es uno u otro.',
  caos_sin_retiro: 'Dijiste que salió de CAOS: falta elegir de qué retiro(s).',
};

/**
 * Edgar: *«todo egreso se vincule a un movimiento de CAOS»*, con la opción explícita de cajón.
 *
 *  · con retiros enlazados → `caos` (aunque la morralla salga del cajón: el billete vino de la máquina);
 *  · sin retiros y declarado `cajon` → `cajon`;
 *  · sin nada, en un egreso desde `desde` → se rechaza. Antes de `desde` (o sin `desde`) no se
 *    exige: el freno nace apagado, como `[CGS.3]` y `CAJA_CUSTODIA_DESDE`.
 *
 * Sólo los EGRESOS. Un ingreso no sale de ningún lado.
 */
export function origenDelEgreso(i: {
  tipo: string; fecha: string; retiros: number; declarado?: string | null; desde: string | null;
}): { ok: true; origen: OrigenEfectivo | null } | { ok: false; motivo: MotivoOrigen } {
  if (i.tipo !== 'gasto') return { ok: true, origen: null };
  const d = i.declarado == null || i.declarado === '' ? null : String(i.declarado);
  if (d !== null && d !== 'caos' && d !== 'cajon') return { ok: false, motivo: 'origen_invalido' };
  if (i.retiros > 0) return d === 'cajon' ? { ok: false, motivo: 'cajon_con_retiros' } : { ok: true, origen: 'caos' };
  if (d === 'caos') return { ok: false, motivo: 'caos_sin_retiro' };
  if (d === 'cajon') return { ok: true, origen: 'cajon' };
  const exige = !!i.desde && /^\d{4}-\d{2}-\d{2}$/.test(i.fecha) && i.fecha >= i.desde;
  return exige ? { ok: false, motivo: 'falta_origen' } : { ok: true, origen: null };
}

/** La frase del freno: cuántos retiros y cuánto dinero, para que se sepa qué buscar. */
export function textoRetirosSinClasificar(retiros: number, monto: number): string {
  const pesos = `$${Number(monto).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${retiros === 1 ? 'Hay 1 retiro' : `Hay ${retiros} retiros`} de CAOS de esta jornada (${pesos}) sin decir si `
    + 'entraron al cajón o quedaron a cargo de alguien. Clasifícalos antes de cerrar el corte.';
}

/** Lo que una persona tiene a su cargo hoy: la suma de sus retiros abiertos o vencidos. */
export function saldoPorResponsable(saldos: SaldoRetiro[]): Array<{
  responsable: string; abiertos: number; vencidos: number; monto: number; mas_viejo_horas: number | null;
}> {
  const m = new Map<string, { abiertos: number; vencidos: number; monto: number; mas_viejo_horas: number | null }>();
  for (const s of saldos) {
    if (s.estado !== 'abierto' && s.estado !== 'vencido') continue;
    const quien = s.responsable ?? '(sin responsable)';
    const a = m.get(quien) ?? { abiertos: 0, vencidos: 0, monto: 0, mas_viejo_horas: null };
    if (s.estado === 'abierto') a.abiertos += 1; else a.vencidos += 1;
    a.monto = r2(a.monto + s.disponible);
    if (s.horas != null) a.mas_viejo_horas = Math.max(a.mas_viejo_horas ?? 0, s.horas);
    m.set(quien, a);
  }
  return [...m.entries()].map(([responsable, v]) => ({ responsable, ...v })).sort((x, y) => y.monto - x.monto);
}
