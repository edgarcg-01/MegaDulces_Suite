import {
  WAREHOUSE_DISPLAY_ORDER, diaMxDeInstante, pagableConBilletesCaos, warehouseName,
  type AfinidadRetiro, type ClaseReposicion, type EstadoDocReposicion, type ReposicionAsignacion,
  type ReposicionDoc, type ReposicionGrupo, type ReposicionPropuesta, type ReposicionRetiro,
  type ReposicionSucursales, type ReposicionVinculo, type AprobacionPago,
} from '@megadulces/contracts';
import { norm } from './caja-caos-match.engine';
import { redondea2, tomaDelRetiro } from './caja-lote.engine';

/**
 * ⭐ `[CGA-A.61]` **Reposición por sucursal** — el motor. Puro: decide qué se ve y qué se propone,
 * y por eso se rompe en una prueba sin base.
 *
 * Edgar, 2026-10-28: *«hagámoslo, pero desde una sola interfaz para tener más practicidad»*. Ese
 * mismo día había quitado a mano el vínculo de CG-2026-00512 desde Caja Fuerte y para volverlo a
 * ligar tenía que ir a otro movimiento, teclear el folio y el monto. Y vincular los 10 egresos de
 * Canindo del 27/10 eran diez veces eso. Aquí el motor arma la propuesta y una persona la confirma.
 *
 * ── Qué es una reposición (medido en prod el 2026-10-28) ─────────────────────────────────────
 * La sucursal paga con su venta y lo registra en SU Kepler: `X-D-26` contra su `0011` (583 de 583
 * egresos de `0011` de sucursal en 30 días son `X-D-26`). Oficinas lo repone con un retiro de CAOS
 * («gnf …» gastos, «nom …» nómina). El grupo es **sucursal × día de pago (`c9`)**, como la hoja
 * «Formato de autorización de gastos». `00` no se repone: Caja General paga directo lo suyo.
 *
 * ── Las reglas para PROPONER, y de dónde salen ─────────────────────────────────────────────────
 * El detector de CS.3.3 (`caja-caos-match.engine.ts`) ya pagó la lección: *un ref dice QUÉ clase
 * de movimiento es, nunca CUÁL* («nom canindo» se teclea cada semana: 5 veces en 45 días). Por eso
 * un retiro se propone sólo si cumple las TRES:
 *   1. **Es de esa sucursal**: su referencia la nombra, o ya paga egresos de ella.
 *   2. **No la contradice**: si nombra sucursales, ésta es una; si nombra clase, es la del documento.
 *   3. **Es de esa vez**: a ≤ `DIAS_INSTANCIA_REPOSICION` días del pago o de la captura en Kepler.
 * Sin las tres no hay propuesta: la persona elige a mano en la misma pantalla.
 *
 * ── El reparto ────────────────────────────────────────────────────────────────────────────────
 * El MISMO que el lote (`tomaDelRetiro`, `[CGA-A.60]`): en orden de folio, cada egreso toma lo que
 * le falta mientras el retiro alcance; no se redondea por renglón (los billetes salen en un fajo).
 * Después, el retiro que se usó barre los centavos que les faltan a los egresos de esa sucursal
 * para quedar explicado entero: sólo la DIFERENCIA toca el cajón (Edgar: *«sólo si tiene diferencia,
 * que se agregue de la caja o salga de la caja»*).
 */

/** Días entre el retiro y el documento para que el retiro sea de ESA reposición y no de otra. */
export const DIAS_INSTANCIA_REPOSICION = 3;

/** La sucursal de Oficinas no se repone: Caja General paga directo sus propios gastos. */
export const SUCURSALES_SIN_REPOSICION: readonly string[] = ['00'];

/**
 * Nómina o gasto, por el beneficiario de Kepler. Medido a 60 días: los 56 documentos de nómina de
 * sucursal dicen exactamente `NOMINA`. ⛔ El concepto NO se mira: el único que decía «nomina» en el
 * concepto era un gasto de caja chica de Canindo ($1,070).
 */
export function claseDelDocumento(beneficiario: string | null | undefined): ClaseReposicion {
  return /\bnominas?\b/.test(norm(beneficiario)) ? 'nomina' : 'gasto';
}

/**
 * Abreviaturas que la gente teclea en CAOS y el catálogo de sucursales no deriva solo. Medidas en
 * las referencias de los retiros de 45 días al 2026-10-28 («PAPAS JOAQIN 8E», «CUERITOS LUPITA
 * YURE», «inv yurec», «nom more»).
 */
const ABREVIATURAS: Readonly<Record<string, readonly string[]>> = {
  '8e': ['03'], yure: ['04'], yurec: ['04'], more: ['07', '08'], zc: ['05'],
};

const RX_NOMINA_REF = /^(nom|nomina|nominas|momina)$/;
const RX_GASTO_REF = /^(gnf|gasto|gastos|gsto|gstos|gatos)$/;

/** Las palabras del catálogo → códigos de servidor Kepler (`'01'`…`'08'`). Una sola fuente. */
const PALABRAS_SUCURSAL: ReadonlyMap<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  const poner = (t: string, codigos: readonly string[]) => {
    const ya = m.get(t) ?? [];
    for (const c of codigos) if (!ya.includes(c)) ya.push(c);
    m.set(t, ya);
  };
  for (const g of WAREHOUSE_DISPLAY_ORDER) {
    const codigos = g.codes.filter((c) => /^0\d$/.test(c));
    if (!codigos.length) continue;
    for (const t of norm(g.label).split(' ')) if (t.length >= 2) poner(t, codigos);
    for (const t of norm(g.name).split(' ')) if (t.length >= 4) poner(t, codigos);
  }
  for (const [t, codigos] of Object.entries(ABREVIATURAS)) poner(t, codigos);
  return m;
})();

/** Las palabras de una referencia: «canindo27 10 26» → `canindo`, `27`, `10`, `26`. */
function palabras(texto: string | null | undefined): string[] {
  const out: string[] = [];
  for (const t of norm(texto).split(' ')) {
    if (!t) continue;
    if (PALABRAS_SUCURSAL.has(t)) { out.push(t); continue; }
    // Letras pegadas a números («canindo27»): se separan. «8e» y «8esq» ya entraron enteras.
    for (const pieza of t.match(/[a-z]+|\d+/g) ?? []) out.push(pieza);
  }
  return out;
}

/**
 * Qué sucursales y qué clase nombra la referencia de un retiro de CAOS. Texto libre: lo que no se
 * reconoce no se adivina, se devuelve vacío.
 */
export function leerReferenciaRetiro(ref: string | null | undefined): { sucursales: string[]; clase: ClaseReposicion | null } {
  const sucursales: string[] = [];
  let nomina = false;
  let gasto = false;
  for (const p of palabras(ref)) {
    for (const c of PALABRAS_SUCURSAL.get(p) ?? []) if (!sucursales.includes(c)) sucursales.push(c);
    if (RX_NOMINA_REF.test(p)) nomina = true;
    if (RX_GASTO_REF.test(p)) gasto = true;
  }
  return { sucursales: sucursales.sort(), clase: nomina === gasto ? null : nomina ? 'nomina' : 'gasto' };
}

// ── Entradas (filas de la base, ya convertidas a número) ──────────────────────────────────────

export interface DocKepler {
  origen_ref: string;
  sucursal: string;
  doc_tipo: string;
  folio: string;
  fecha_valor: string | null;
  fecha_captura: string | null;
  beneficiario: string | null;
  monto: number;
}

export interface EgresoLibro {
  id: string;
  folio: string;
  origen_ref: string;
  monto: number;
  fecha: string;
  origen_efectivo: string | null;
}

export interface VinculoLibro {
  link_id: string;
  cash_ledger_id: string;
  device: string;
  external_id: number;
  ref: string | null;
  monto: number;
}

export interface RetiroLibre {
  device: string;
  external_id: number;
  occurred_at: string;
  ref: string | null;
  total: number;
  libre: number;
  sucursales_vinculadas: string[];
}

export interface EntradaReposicion {
  desde: string;
  hasta: string;
  docs: DocKepler[];
  egresos: EgresoLibro[];
  vinculos: VinculoLibro[];
  retiros: RetiroLibre[];
  /** Los servidores de Kepler que se miraron (sin `00`). Por defecto, los del catálogo. */
  sucursales?: string[];
  /**
   * `[CGA-A.62]` La aprobación de cada documento (`origen_ref` → juicio de `pago-aprobado.engine`).
   * Lo que espera firma o se rechazó NO entra a la propuesta ni a «Reponer». Sin mapa = no medido.
   */
  aprobaciones?: ReadonlyMap<string, AprobacionPago>;
}

const dia10 = (v: string | null | undefined): string | null => (v ? String(v).slice(0, 10) : null);

function distanciaDias(a: string | null, b: string | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
}

const llaveRetiro = (r: { device: string; external_id: number }) => `${r.device}|${r.external_id}`;

const ordenSucursal = (c: string): number => {
  const i = WAREHOUSE_DISPLAY_ORDER.findIndex((g) => g.codes.includes(c));
  return i < 0 ? 99 : i;
};

const pesos = (v: number) => `$${v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Los servidores de Kepler de sucursal (`'01'`…`'08'`), en el orden en que se muestran. */
export function sucursalesDeReposicion(): string[] {
  const out: string[] = [];
  for (const g of WAREHOUSE_DISPLAY_ORDER) {
    for (const c of g.codes) {
      if (/^0\d$/.test(c) && !SUCURSALES_SIN_REPOSICION.includes(c) && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

interface DocInterno extends ReposicionDoc {
  /** Fecha del grupo: `c9` de Kepler o, si Kepler ya no lo tiene, la del egreso. */
  dia: string;
}

/**
 * ¿Este retiro puede ser de este documento? Devuelve la afinidad, o `null` si no.
 *
 * «No contradice la sucursal» no lleva línea propia: las dos afinidades ya la exigen (la primera
 * pide que la nombre; la segunda, que no nombre a ninguna). La prueba de mutación lo encontró: una
 * guarda aparte no la mataba ninguna prueba. ⚠️ Es conservador a propósito: «nom canindo» también
 * pagó la nómina de Zamora Centro, y aun así no se propone para Zamora — eso lo elige una persona.
 */
function afinidad(r: ReposicionRetiro, d: DocInterno): AfinidadRetiro | null {
  if (r.clase_ref && r.clase_ref !== d.clase) return null;
  const cerca = Math.min(distanciaDias(r.dia, d.fecha_valor ?? d.dia), distanciaDias(r.dia, d.fecha_captura));
  if (!(cerca <= DIAS_INSTANCIA_REPOSICION)) return null;
  if (r.sucursales_ref.includes(d.sucursal)) return 'nombra_la_sucursal';
  if (!r.sucursales_ref.length && r.sucursales_vinculadas.includes(d.sucursal)) return 'ya_paga_la_sucursal';
  return null;
}

/** Los retiros que pueden ser de un documento, del más claro al menos claro. */
function candidatos(retiros: ReposicionRetiro[], d: DocInterno): Array<{ r: ReposicionRetiro; a: AfinidadRetiro }> {
  const out: Array<{ r: ReposicionRetiro; a: AfinidadRetiro; dist: number }> = [];
  for (const r of retiros) {
    const a = afinidad(r, d);
    if (a) out.push({ r, a, dist: distanciaDias(r.dia, d.fecha_valor ?? d.dia) });
  }
  return out.sort((x, y) =>
    (x.a === y.a ? 0 : x.a === 'nombra_la_sucursal' ? -1 : 1)
    // La referencia más ESPECÍFICA primero: «gnf ma» (una sucursal) antes que «gnf morelia» (dos).
    // Medido en prod el 2026-10-28: sin esto, los gastos de Abastos del 23/10 iban al de las dos.
    || x.r.sucursales_ref.length - y.r.sucursales_ref.length
    || x.dist - y.dist
    || x.r.occurred_at.localeCompare(y.r.occurred_at)
    || x.r.external_id - y.r.external_id);
}

function razonDeRetiro(r: ReposicionRetiro, a: AfinidadRetiro, sucursal: string): string {
  const quien = a === 'nombra_la_sucursal'
    ? `nombra a ${warehouseName(sucursal)}`
    : `ya paga egresos de ${r.sucursales_vinculadas.map((c) => warehouseName(c)).join(' y ')}`;
  const clase = r.clase_ref === 'nomina' ? ' y es de nómina' : r.clase_ref === 'gasto' ? ' y es de gastos' : '';
  // Lo libre ANTES de proponer: deja ver si el retiro es del tamaño de estos egresos o mucho mayor.
  return `«${r.ref ?? `retiro ${r.external_id}`}» ${quien}${clase}, del ${dm(r.dia)} (libres ${pesos(r.libre)})`;
}

/**
 * Arma la reposición: grupos sucursal × día de pago, con lo que explica cada peso y la propuesta
 * de vínculos para lo que falta.
 */
export function armarReposicion(e: EntradaReposicion): Omit<ReposicionSucursales, 'datos_al' | 'caos_al'> {
  const sucursales = e.sucursales ?? sucursalesDeReposicion();
  const egresoPorRef = new Map<string, EgresoLibro>();
  for (const g of e.egresos) if (!egresoPorRef.has(g.origen_ref)) egresoPorRef.set(g.origen_ref, g);
  const vinculosPorEgreso = new Map<string, VinculoLibro[]>();
  for (const v of e.vinculos) vinculosPorEgreso.set(v.cash_ledger_id, [...(vinculosPorEgreso.get(v.cash_ledger_id) ?? []), v]);

  const aDoc = (k: DocKepler | null, g: EgresoLibro | null): DocInterno | null => {
    const ref = k?.origen_ref ?? g?.origen_ref ?? '';
    const [suc, docTipo, folio] = ref.split('|');
    const sucursal = k?.sucursal ?? suc;
    if (!sucursal || SUCURSALES_SIN_REPOSICION.includes(sucursal)) return null;
    const dia = dia10(k?.fecha_valor) ?? dia10(g?.fecha);
    if (!dia) return null;
    const monto = redondea2(Number(k?.monto ?? g?.monto) || 0);
    const vinculos: ReposicionVinculo[] = (g ? vinculosPorEgreso.get(g.id) ?? [] : []).map((v) => ({
      link_id: v.link_id, device: v.device, external_id: v.external_id, ref: v.ref, monto: redondea2(v.monto),
    }));
    const enlazado = redondea2(vinculos.reduce((a, v) => a + v.monto, 0));
    const delCajon = g?.origen_efectivo === 'cajon';
    const falta = g && !delCajon ? redondea2(Math.max(0, monto - enlazado)) : 0;
    let estado: EstadoDocReposicion;
    if (!g) estado = 'por_capturar';
    else if (delCajon) estado = 'cajon';
    else if (pagableConBilletesCaos(falta) > 0) estado = 'sin_vincular';
    else estado = enlazado > 0 ? 'caos' : 'cajon';
    return {
      origen_ref: ref, sucursal, doc_tipo: k?.doc_tipo ?? docTipo ?? '', folio: k?.folio ?? folio ?? '',
      fecha_valor: dia10(k?.fecha_valor), fecha_captura: dia10(k?.fecha_captura),
      beneficiario: k?.beneficiario ?? null, monto, clase: claseDelDocumento(k?.beneficiario),
      en_kepler: !!k, ledger_id: g?.id ?? null, cg_folio: g?.folio ?? null, origen_efectivo: g?.origen_efectivo ?? null,
      enlazado, falta, estado, vinculos, dia,
      aprobacion: k ? e.aprobaciones?.get(ref) ?? null : null,
    };
  };
  /** `[CGA-A.62]` Espera firma o se rechazó: ni se propone ni se repone. */
  const bloqueado = (d: DocInterno) => d.aprobacion?.bloquea === true;

  const docs: DocInterno[] = [];
  const vistos = new Set<string>();
  for (const k of e.docs) {
    if (vistos.has(k.origen_ref)) continue;
    vistos.add(k.origen_ref);
    const d = aDoc(k, egresoPorRef.get(k.origen_ref) ?? null);
    if (d) docs.push(d);
  }
  // El libro tiene el egreso y Kepler ya no tiene el documento: se muestra, no se esconde.
  for (const g of e.egresos) {
    if (vistos.has(g.origen_ref)) continue;
    vistos.add(g.origen_ref);
    const d = aDoc(null, g);
    if (d) docs.push(d);
  }
  docs.sort((a, b) => a.dia.localeCompare(b.dia) || ordenSucursal(a.sucursal) - ordenSucursal(b.sucursal)
    || a.folio.localeCompare(b.folio) || a.origen_ref.localeCompare(b.origen_ref));

  const retiros: ReposicionRetiro[] = e.retiros
    .map((r) => {
      const leido = leerReferenciaRetiro(r.ref);
      return {
        device: r.device, external_id: Number(r.external_id), occurred_at: String(r.occurred_at),
        dia: diaMxDeInstante(r.occurred_at) ?? String(r.occurred_at).slice(0, 10),
        ref: r.ref, total: redondea2(r.total), libre: redondea2(r.libre),
        sucursales_ref: leido.sucursales, clase_ref: leido.clase,
        sucursales_vinculadas: [...new Set(r.sucursales_vinculadas)].sort(),
      };
    })
    .filter((r) => r.libre > 0.005)
    .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.external_id - b.external_id);

  // ── Reparto, paso 1: lo que les falta a los egresos sin vincular ─────────────────────────────
  const libre = new Map<string, number>(retiros.map((r) => [llaveRetiro(r), r.libre]));
  const asignaciones: Array<ReposicionAsignacion & { grupo: string; barrido: boolean }> = [];
  const usadoPor = new Map<string, { grupo: string; r: ReposicionRetiro; a: AfinidadRetiro; sucursal: string }>();
  const faltaViva = new Map<string, number>(docs.map((d) => [d.origen_ref, d.falta]));
  const claveGrupo = (d: DocInterno) => `${d.dia}|${d.sucursal}`;

  const tomar = (d: DocInterno, r: ReposicionRetiro, grupo: string, barrido: boolean): number => {
    const k = llaveRetiro(r);
    const t = tomaDelRetiro(faltaViva.get(d.origen_ref) ?? 0, libre.get(k) ?? 0);
    if (t <= 0) return 0;
    libre.set(k, redondea2((libre.get(k) ?? 0) - t));
    faltaViva.set(d.origen_ref, redondea2((faltaViva.get(d.origen_ref) ?? 0) - t));
    const previa = asignaciones.find((x) => x.ledger_id === d.ledger_id && llaveRetiro(x) === k);
    if (previa) previa.monto = redondea2(previa.monto + t);
    else {
      asignaciones.push({
        ledger_id: d.ledger_id as string, cg_folio: d.cg_folio as string, origen_ref: d.origen_ref,
        device: r.device, external_id: r.external_id, ref: r.ref, monto: t, grupo, barrido,
      });
    }
    return t;
  };

  for (const d of docs) {
    if (d.estado !== 'sin_vincular' || bloqueado(d)) continue;
    for (const { r, a } of candidatos(retiros, d)) {
      if ((faltaViva.get(d.origen_ref) ?? 0) <= 0.005) break;
      if (tomar(d, r, claveGrupo(d), false) > 0 && !usadoPor.has(llaveRetiro(r))) {
        usadoPor.set(llaveRetiro(r), { grupo: claveGrupo(d), r, a, sucursal: d.sucursal });
      }
    }
  }

  // ── Paso 2: el retiro que se usó barre los centavos de los egresos de su sucursal ────────────
  for (const [k, uso] of usadoPor) {
    for (const d of docs) {
      if ((libre.get(k) ?? 0) <= 0.005) break;
      // Un egreso «del cajón» no entra porque su `falta` ya es 0 (lo prueba una negativa); una
      // guarda aparte aquí era redundante y ninguna prueba la podía romper.
      if (!d.ledger_id || bloqueado(d) || (faltaViva.get(d.origen_ref) ?? 0) <= 0.005) continue;
      if (!afinidad(uso.r, d)) continue;
      tomar(d, uso.r, uso.grupo, true);
    }
  }

  // ── Grupos ────────────────────────────────────────────────────────────────────────────────
  const grupos = new Map<string, DocInterno[]>();
  for (const d of docs) grupos.set(claveGrupo(d), [...(grupos.get(claveGrupo(d)) ?? []), d]);

  const salida: ReposicionGrupo[] = [];
  for (const [clave, ds] of grupos) {
    const [fecha, sucursal] = clave.split('|');
    const total = redondea2(ds.reduce((a, d) => a + d.monto, 0));
    const pend = ds.filter((d) => d.estado === 'por_capturar');
    const sv = ds.filter((d) => d.estado === 'sin_vincular');
    const caos = redondea2(ds.reduce((a, d) => a + d.enlazado, 0));
    const sinVincular = redondea2(sv.reduce((a, d) => a + d.falta, 0));
    const porCapturar = redondea2(pend.reduce((a, d) => a + d.monto, 0));
    const cajon = redondea2(total - porCapturar - caos - sinVincular);

    const mias = asignaciones.filter((x) => x.grupo === clave);
    let propuesta: ReposicionPropuesta | null = null;
    if (mias.some((x) => !x.barrido)) {
      const monto = redondea2(mias.reduce((a, x) => a + x.monto, 0));
      const directo = redondea2(mias.filter((x) => !x.barrido).reduce((a, x) => a + x.monto, 0));
      const queda = redondea2(Math.max(0, sinVincular - directo));
      const barridos = new Set(mias.filter((x) => x.barrido).map((x) => x.ledger_id));
      // Los retiros que usa ESTE grupo (no sólo los que estrenó): cada uno con su afinidad aquí.
      const usados = new Map<string, string>();
      for (const x of mias.filter((y) => !y.barrido)) {
        const r = retiros.find((rr) => llaveRetiro(rr) === llaveRetiro(x));
        const d = ds.find((dd) => dd.ledger_id === x.ledger_id);
        const a = r && d ? afinidad(r, d) : null;
        if (r && a && !usados.has(llaveRetiro(r))) usados.set(llaveRetiro(r), razonDeRetiro(r, a, sucursal));
      }
      const nEgresos = new Set(mias.filter((x) => !x.barrido).map((x) => x.ledger_id)).size;
      const partes = [
        [...usados.values()].join('; '),
        `cubre ${pesos(directo)} de ${pesos(sinVincular)} sin vincular (${nEgresos} ${nEgresos === 1 ? 'egreso' : 'egresos'})`,
      ];
      if (queda > 0.005) partes.push(`${pesos(queda)} ${queda < 20 ? 'sale del cajón' : 'sigue sin retiro'}`);
      if (barridos.size) {
        partes.push(`y los centavos de ${barridos.size} ${barridos.size === 1 ? 'egreso' : 'egresos'} más, para que el retiro quede explicado entero`);
      }
      // La señal de INSTANCIA más fuerte que hay: lo libre de los retiros usados se va completo.
      const libresUsados = redondea2(retiros.filter((r) => usados.has(llaveRetiro(r))).reduce((a, r) => a + r.libre, 0));
      const aEsos = redondea2(mias.filter((x) => usados.has(llaveRetiro(x))).reduce((a, x) => a + x.monto, 0));
      if (usados.size && Math.abs(libresUsados - aEsos) <= 0.005) {
        partes.push(usados.size === 1 ? 'al peso: el retiro queda explicado entero' : 'al peso: los retiros quedan explicados enteros');
      }
      propuesta = {
        asignaciones: mias.map(({ grupo: _g, barrido: _b, ...x }) => x),
        monto, queda, razon: partes.join(' · '),
      };
    }

    // «Reponer»: el retiro para lo que está por capturar (el lote reparte igual que arriba).
    let retiroSugerido: ReposicionGrupo['retiro_sugerido'] = null;
    // `[CGA-A.62]` Sólo lo que se puede reponer: lo que espera firma o se rechazó no cuenta.
    const pendOk = pend.filter((d) => !bloqueado(d));
    if (pendOk.length) {
      const clases = new Set(pendOk.map((d) => d.clase));
      const muestra: DocInterno = { ...pendOk[0], clase: clases.size === 1 ? pendOk[0].clase : 'gasto' };
      const opciones = candidatos(retiros, muestra)
        .filter(({ r }) => clases.size === 1 || r.clase_ref === null)
        .filter(({ r }) => (libre.get(llaveRetiro(r)) ?? 0) > 0.005);
      const mejor = opciones[0];
      if (mejor) {
        const disp = libre.get(llaveRetiro(mejor.r)) ?? 0;
        retiroSugerido = {
          device: mejor.r.device, external_id: mejor.r.external_id, ref: mejor.r.ref, libre: disp,
          razon: `${razonDeRetiro(mejor.r, mejor.a, sucursal)}; libre ${pesos(disp)}`,
        };
      }
    }

    salida.push({
      clave, fecha, sucursal,
      docs: ds.map(({ dia: _d, ...d }) => d),
      total, por_capturar: porCapturar, n_por_capturar: pend.length,
      caos, cajon, sin_vincular: sinVincular, n_sin_vincular: sv.length,
      n_sin_aprobar: ds.filter((d) => bloqueado(d)).length,
      n_pagado_antes_de_aprobar: ds.filter((d) => d.aprobacion?.alerta === true).length,
      estado: pend.length ? 'por_capturar' : sv.length ? 'sin_vincular' : 'explicada',
      propuesta, retiro_sugerido: retiroSugerido,
    });
  }
  salida.sort((a, b) => b.fecha.localeCompare(a.fecha) || ordenSucursal(a.sucursal) - ordenSucursal(b.sucursal));

  const conDocs = new Set(docs.map((d) => d.sucursal));
  return {
    desde: e.desde, hasta: e.hasta, grupos: salida, retiros,
    universo: {
      sucursales,
      sin_documentos: sucursales.filter((c) => !conDocs.has(c)),
      excluidas: [...SUCURSALES_SIN_REPOSICION],
    },
  };
}
