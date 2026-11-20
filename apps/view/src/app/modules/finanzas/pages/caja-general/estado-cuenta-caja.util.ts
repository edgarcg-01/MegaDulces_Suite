/**
 * `[LE.6.38]` **Estado de cuenta de Caja General** — el cálculo, sin Angular.
 *
 * Arma, para un periodo, lo que un banco entrega: saldo inicial, cada movimiento con su saldo
 * corrido y el saldo final. La fuente es Captura (`finance.cash_ledger`) y sus cortes sellados
 * (`GET cortes/arqueos`); el libro nuevo (`cashbook`) NO: medido el 2026-11-20 en prod, su cuenta
 * «Caja General · pesos» tiene cero asientos (no hay apertura) y sus 685 asientos llevan la jornada
 * del 27-oct. Un estado de cuenta sobre él diría «caja vacía», que es falso.
 *
 * ── La identidad que se publica (y se comprueba) ─────────────────────────────────────────
 *
 *   contado(d) = fondo(d) + entradas − salidas − depósitos + caja fuerte neta + otros + diferencia
 *
 * con «otros» = esperado sellado − los seis términos (custodia, cheques: lo que el corte ajusta y
 * la fórmula de seis no nombra) y «diferencia» = lo contado − lo esperado. Y entre días:
 *
 *   salto(d) = fondo(d) − contado(d−1)      (0 cuando el fondo arranca del cierre anterior)
 *
 * Sumando el periodo, saldo final − saldo inicial = Σ todo lo anterior. Si no da (`residuo`), la
 * pantalla lo dice: un estado de cuenta que no cuadra consigo mismo no se dibuja como si cuadrara.
 *
 * ── Por qué los movimientos se agrupan por CORTE y no por fecha ─────────────────────────
 *
 * Medido el 2026-11-20: 421 de 1,369 movimientos vivos traen una fecha distinta a la de su corte
 * (el documento de Kepler es de otro día), siempre ANTES y a lo más 16 días. Por eso la pantalla
 * pide el libro desde 31 días antes del periodo y aquí se reparten por `corte_id`. Y en los 33
 * cortes la suma de sus movimientos da, al centavo, lo que el corte selló: esa misma comparación
 * corre en cada lectura (`movimientos_cuadran`) y, si falla, el saldo corrido no se publica.
 */
import { warehouseName, type ArqueoDia } from '@megadulces/contracts';
import type { MovimientoCaja } from '../../cash-ledger.service';

const r2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** Suma que se vuelve `null` si falta un término: lo no medido no se suma como cero. */
const sumaN = (xs: Array<number | null>): number | null => (xs.some((x) => x == null) ? null : r2(xs.reduce((a: number, x) => a + (x as number), 0)));

export interface LineaEstado {
  id: string;
  folio: string;
  fecha: string;
  hora: string | null;
  tipo: 'ingreso' | 'gasto';
  /** Concepto de Kepler si lo hay; si no, lo que se escribió al capturar. */
  concepto: string;
  beneficiario: string | null;
  /** Lo que se escribió al capturar, cuando dice algo más que el concepto y el beneficiario. */
  detalle: string | null;
  /** Ruta del cobro de camión («Ruta 501»); `null` si no es de ruta o no se supo. */
  ruta: string | null;
  /** De qué servidor de Kepler viene el documento («Pachuca · Ruta 501»), o la caja fuerte. */
  origen: string | null;
  sucursal: string;
  entrada: number;
  salida: number;
  /** Saldo después de este movimiento. `null` = no se publica (ver `movimientos_cuadran`). */
  saldo: number | null;
}

export interface DiaEstado {
  corte_id: string;
  fecha: string;
  folio: string;
  estado: string;
  saldo_inicial: number | null;
  fondo_origen: string | null;
  entradas: number | null;
  salidas: number | null;
  depositos: number | null;
  /** Lo que la caja fuerte (CAOS) dejó en el cajón menos lo que se llevó. */
  caja_fuerte: number | null;
  /** Esperado sellado − los seis términos. 0 casi siempre; distinto de 0 = custodia o documentos. */
  otros: number | null;
  esperado: number | null;
  contado: number | null;
  diferencia: number | null;
  /** fondo − contado del día anterior del periodo. `null` en el primer día o si falta un lado. */
  salto: number | null;
  sin_medir: string | null;
  movimientos: LineaEstado[];
  /** ¿La suma de los movimientos listados reproduce entradas y salidas del corte? */
  movimientos_cuadran: boolean;
}

/** Un concepto del periodo, con sus rutas cuando las tiene. */
export interface GrupoConcepto {
  concepto: string;
  movimientos: number;
  monto: number;
  rutas: Array<{ ruta: string; movimientos: number; monto: number }>;
}

export interface ResumenEstado {
  saldo_inicial: number | null;
  entradas: number | null;
  salidas: number | null;
  depositos: number | null;
  caja_fuerte: number | null;
  otros: number | null;
  diferencias: number | null;
  saltos: number | null;
  saldo_final: number | null;
  /** saldo final − (inicial + todo lo demás). `null` si algo no se midió; ≠ 0 = no cuadra. */
  residuo: number | null;
  dias: number;
  dias_sin_medir: number;
  dias_sin_cuadre_de_movimientos: number;
  movimientos: number;
  /** Movimientos de la ventana pedida sin corte (todavía no entran a ningún saldo). */
  sin_corte: number;
  /** De dónde entró y en qué salió, por concepto (de mayor a menor). Sale de los movimientos
   *  listados: si un día no cuadra, la suma de los grupos no da el total de los cortes. */
  por_concepto: { entradas: GrupoConcepto[]; salidas: GrupoConcepto[] };
}

export interface EstadoDeCuenta {
  dias: DiaEstado[];
  resumen: ResumenEstado;
}

/** `'501'`, `'ruta_501'` o `'ruta_501 · ruta_502'` → «Ruta 501» / «Ruta 501 · Ruta 502». */
export function etiquetaRuta(r: string | null | undefined): string | null {
  const t = String(r ?? '').trim();
  if (!t) return null;
  return t.split(/\s*·\s*/).map((u) => `Ruta ${u.replace(/^ruta[_\s]*/i, '')}`).join(' · ');
}

/**
 * De qué servidor viene el documento, por nombre. ⚠️ Misma regla que `servidorDe` de Captura
 * (`finanzas-caja-general.component.ts`, `[CGA-A.59]`): el prefijo de `origen_ref`, no `sucursal`.
 * Deuda con nombre (ADR-056): las dos deberían vivir en un util compartido.
 */
export function origenDelMovimiento(m: Pick<MovimientoCaja, 'origen_tipo' | 'origen_ref' | 'ruta'>): string | null {
  if (m.origen_tipo === 'caos') return 'Caja fuerte (CAOS)';
  const [srv, alm] = String(m.origen_ref ?? '').split('|')[0].trim().split('-');
  if (!/^\d{2}$/.test(srv ?? '')) return null;
  const nombre = warehouseName(srv);
  const ruta = etiquetaRuta(m.ruta);
  if (ruta) return `${nombre} · ${ruta}`;
  return alm ? `${nombre} · almacén ${alm}` : nombre;
}

const norm = (x: string): string => x.trim().toLowerCase().replace(/\s+/g, ' ');

function agrupar(lineas: LineaEstado[], lado: 'entrada' | 'salida'): GrupoConcepto[] {
  const g = new Map<string, GrupoConcepto>();
  for (const l of lineas) {
    const v = l[lado];
    if (!v) continue;
    const c = g.get(l.concepto) ?? { concepto: l.concepto, movimientos: 0, monto: 0, rutas: [] };
    c.movimientos++; c.monto = r2(c.monto + v);
    if (l.ruta) {
      let r = c.rutas.find((x) => x.ruta === l.ruta);
      if (!r) { r = { ruta: l.ruta, movimientos: 0, monto: 0 }; c.rutas.push(r); }
      r.movimientos++; r.monto = r2(r.monto + v);
    }
    g.set(l.concepto, c);
  }
  const out = [...g.values()].sort((a, b) => b.monto - a.monto);
  for (const c of out) c.rutas.sort((a, b) => b.monto - a.monto);
  return out;
}

function linea(m: MovimientoCaja): LineaEstado {
  const monto = r2(Number(m.monto) || 0);
  const ingreso = m.tipo === 'ingreso';
  const concepto = (m.kepler_concepto_nombre || m.glosa || '').trim() || 'Sin concepto';
  const glosa = (m.glosa || '').trim();
  return {
    id: m.id,
    folio: m.folio,
    fecha: String(m.fecha).slice(0, 10),
    hora: m.hora ?? null,
    tipo: ingreso ? 'ingreso' : 'gasto',
    concepto,
    beneficiario: m.beneficiario ?? null,
    detalle: glosa && norm(glosa) !== norm(concepto) && norm(glosa) !== norm(m.beneficiario ?? '') ? glosa : null,
    ruta: etiquetaRuta(m.ruta),
    origen: origenDelMovimiento(m),
    sucursal: m.sucursal,
    entrada: ingreso ? monto : 0,
    salida: ingreso ? 0 : monto,
    saldo: null,
  };
}

const ordenLinea = (a: LineaEstado, b: LineaEstado): number =>
  a.fecha.localeCompare(b.fecha) || (a.hora ?? '').localeCompare(b.hora ?? '') || a.folio.localeCompare(b.folio);

/**
 * @param arqueos  los cortes del periodo (`GET cortes/arqueos`), en cualquier orden.
 * @param movimientos el libro de la ventana pedida; los cancelados se descartan aquí.
 * @param periodo   para contar sólo los movimientos SIN corte que caen en el periodo.
 */
export function armarEstadoDeCuenta(
  arqueos: readonly ArqueoDia[], movimientos: readonly MovimientoCaja[], periodo?: { desde: string; hasta: string },
): EstadoDeCuenta {
  const vivos = movimientos.filter((m) => m.estado !== 'cancelado');
  const porCorte = new Map<string, LineaEstado[]>();
  for (const m of vivos) {
    if (!m.corte_id) continue;
    const l = porCorte.get(m.corte_id) ?? [];
    l.push(linea(m));
    porCorte.set(m.corte_id, l);
  }

  const ordenados = [...arqueos].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const dias: DiaEstado[] = [];
  let contadoPrevio: number | null | undefined;
  for (const a of ordenados) {
    const fondo = num(a.fondo?.monto);
    const entradas = num(a.ingresos);
    const salidas = num(a.gastos);
    const depositos = num(a.depositos);
    const caja_fuerte = a.caos ? r2(Number(a.caos.dispensado || 0) - Number(a.caos.depositado || 0)) : null;
    const esperado = num(a.esperado);
    const recompuesto = num(a.esperado_recompuesto);
    const contado = num(a.contado);

    const lineas = (porCorte.get(a.corte_id) ?? []).sort(ordenLinea);
    const sumE = r2(lineas.reduce((s, l) => s + l.entrada, 0));
    const sumS = r2(lineas.reduce((s, l) => s + l.salida, 0));
    const movimientos_cuadran = entradas != null && salidas != null && Math.abs(sumE - entradas) < 0.005 && Math.abs(sumS - salidas) < 0.005;
    if (movimientos_cuadran && fondo != null) {
      let s = fondo;
      for (const l of lineas) { s = r2(s + l.entrada - l.salida); l.saldo = s; }
    }

    dias.push({
      corte_id: a.corte_id,
      fecha: a.fecha,
      folio: a.folio,
      estado: a.estado,
      saldo_inicial: fondo,
      fondo_origen: a.fondo?.origen ?? null,
      entradas, salidas, depositos, caja_fuerte,
      otros: esperado != null && recompuesto != null ? r2(esperado - recompuesto) : null,
      esperado,
      contado,
      diferencia: num(a.diferencia),
      salto: contadoPrevio === undefined ? null : (contadoPrevio == null || fondo == null ? null : r2(fondo - contadoPrevio)),
      sin_medir: a.sin_medir_motivo ?? null,
      movimientos: lineas,
      movimientos_cuadran,
    });
    contadoPrevio = contado;
  }

  const primero = dias[0];
  const ultimo = dias[dias.length - 1];
  const r: ResumenEstado = {
    saldo_inicial: primero?.saldo_inicial ?? null,
    entradas: sumaN(dias.map((d) => d.entradas)),
    salidas: sumaN(dias.map((d) => d.salidas)),
    depositos: sumaN(dias.map((d) => d.depositos)),
    caja_fuerte: sumaN(dias.map((d) => d.caja_fuerte)),
    otros: sumaN(dias.map((d) => d.otros)),
    diferencias: sumaN(dias.map((d) => d.diferencia)),
    saltos: sumaN(dias.slice(1).map((d) => d.salto)),
    saldo_final: ultimo?.contado ?? null,
    residuo: null,
    dias: dias.length,
    dias_sin_medir: dias.filter((d) => d.contado == null || d.esperado == null || d.saldo_inicial == null).length,
    dias_sin_cuadre_de_movimientos: dias.filter((d) => !d.movimientos_cuadran).length,
    movimientos: dias.reduce((s, d) => s + d.movimientos.length, 0),
    por_concepto: { entradas: [], salidas: [] },
    sin_corte: vivos.filter((m) => !m.corte_id && (!periodo || (String(m.fecha).slice(0, 10) >= periodo.desde && String(m.fecha).slice(0, 10) <= periodo.hasta))).length,
  };
  const todas = dias.flatMap((d) => d.movimientos);
  r.por_concepto = { entradas: agrupar(todas, 'entrada'), salidas: agrupar(todas, 'salida') };
  const partes = [r.saldo_inicial, r.entradas, r.salidas, r.depositos, r.caja_fuerte, r.otros, r.diferencias, r.saltos, r.saldo_final];
  if (dias.length && partes.every((x) => x != null)) {
    r.residuo = r2((r.saldo_final as number) - ((r.saldo_inicial as number) + (r.entradas as number) - (r.salidas as number)
      - (r.depositos as number) + (r.caja_fuerte as number) + (r.otros as number) + (r.diferencias as number) + (r.saltos as number)));
  }
  return { dias, resumen: r };
}

/** Primer y último día (`YYYY-MM-DD`) de un mes `YYYY-MM`. */
export function limitesDeMes(mes: string): { desde: string; hasta: string } {
  const [y, m] = mes.split('-').map(Number);
  const ultimo = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { desde: `${mes}-01`, hasta: `${mes}-${String(ultimo).padStart(2, '0')}` };
}

/** `YYYY-MM-DD` menos `n` días, sin pasar por la zona del navegador. */
export function restarDias(dia: string, n: number): string {
  const [y, m, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}
