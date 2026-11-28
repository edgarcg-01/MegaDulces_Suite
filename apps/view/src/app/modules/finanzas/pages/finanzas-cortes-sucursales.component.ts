import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, HostListener, Injector, OnInit, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { SucursalPipe } from '../../../shared/pipes/sucursal.pipe';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { DatePickerModule } from 'primeng/datepicker';
import { TagModule } from 'primeng/tag';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { filtrarPorBusqueda } from '@megadulces/ui-web';
import type {
  CorteArqueo, CorteCobro, CorteConteoCajero, CorteConteoFuera, CorteCuadre, CorteDeclaracionCajero, CorteEstadoCobro, CorteLlegadaEstado, CorteRow, CorteSucursalResumen,
  CortesSucursalesResponse, FacturaContado, FacturasContadoResponse,
} from '@megadulces/contracts';
import { SidePeekComponent } from '../../../shared/components/side-peek/side-peek.component';
import { environment } from '../../../../environments/environment';
import { MetricStripComponent, MetricStripItem } from '../../../shared/components/metric-strip/metric-strip.component';
import { FINANZAS_SHARED_STYLES } from './finanzas-shared.styles';
import { money, dmy } from './finanzas-format';
import { PageTabsComponent } from '../../../shared/components/page-tabs/page-tabs.component';
import { ContextHelpComponent } from '../../../shared/context-help/context-help.component';
import { CORTES_ARQUEOS_TABS } from '../cortes-arqueos-tabs';

type Sev = 'success' | 'info' | 'warn' | 'danger' | 'secondary';

const COBRO: Record<CorteEstadoCobro, { label: string; sev: Sev }> = {
  sin_cobro: { label: 'Sin cobro', sev: 'secondary' },
  parcial: { label: 'Cobro parcial', sev: 'warn' },
  cobrado: { label: 'Cobrado', sev: 'success' },
  sobrecobrado: { label: 'Cobrado de más', sev: 'danger' },
};
const CUADRE: Record<CorteCuadre, { label: string; sev: Sev }> = {
  cuadra: { label: 'Cuadra', sev: 'success' },
  faltante_arqueo: { label: 'Faltante en arqueo', sev: 'danger' },
  sobrante_arqueo: { label: 'Sobrante en arqueo', sev: 'warn' },
  corte_distinto: { label: 'Corte distinto', sev: 'warn' },
  sin_arqueo: { label: 'Sin arqueo', sev: 'info' },
};

/**
 * La etiqueta del cuadre como se pinta (con la diferencia cuando la hay). La usan la tabla y el buscador.
 * `[CSU.31]` D4 del anexo FB: cuando la venta del turno explica el «Corte distinto» (el corte pasa lo que la caja
 * registró cobrado y es igual a tickets − devoluciones), se llama por su nombre: «Venta sin forma de pago».
 */
export function etiquetaCuadre(c: CorteRow): string {
  if (c.venta_sin_forma_de_pago != null) return `Venta sin forma de pago ${money(c.venta_sin_forma_de_pago)}`;
  const base = CUADRE[c.cuadre].label;
  return c.cuadre === 'cuadra' || c.cuadre === 'sin_arqueo' || c.diferencia === null ? base : `${base} ${money(c.diferencia)}`;
}

/** `[CSU.31]` Cómo se busca el estado de llegada de un corte. */
const LLEGADA_BUSCABLE: Record<CorteLlegadaEstado, string> = {
  llego: 'llegó', por_saber: 'por saber', sin_conciliar: 'sin conciliar', parcial: 'falta depositar parcial', sin_deposito: 'sin depósito',
};

/**
 * `[CSU.13]` Todo lo que una persona puede traer en la mano para encontrar un corte: el folio (con y sin
 * ceros: «12» encuentra UD2301-0000012), la caja-turno, la sucursal, la fecha como se ve, los montos como
 * se ven («1,203» encuentra $1,203.36), los estados, el cajero, y los cobros y devoluciones del corte.
 */
export function camposBuscablesDeCorte(c: CorteRow): (string | number | null | undefined)[] {
  const sinCeros = (f: string | null | undefined): string => (f && /^\d+$/.test(f) ? String(Number(f)) : '');
  return [
    c.documento, c.folio, sinCeros(c.folio), c.referencia, c.caja && c.turno ? `${c.caja}-${c.turno}` : null,
    ...variantesDeFolio('UD2301', c.folio),
    c.sucursal, c.sucursal_nombre, dmy(c.fecha), c.fecha,
    money(c.monto), money(c.cobrado), money(c.saldo),
    COBRO[c.estado_cobro].label, etiquetaCuadre(c), c.arqueo?.cajero,
    // [CSU.31] El estado de llegada en palabras («por saber», «sin conciliar»…) y la fecha de cada cobro: así se
    // encuentra el cobro que Kepler fechó en el futuro (CSU.UI.1).
    c.llegada ? LLEGADA_BUSCABLE[c.llegada.estado] : null,
    ...c.cobros.flatMap((x) => [`${x.doc_prefix}-${x.folio}`, ...variantesDeFolio(x.doc_prefix, x.folio), x.folio, sinCeros(x.folio),
      money(x.monto), x.forma_pago, x.concepto, x.cuenta_tesoreria, x.fecha ? dmy(x.fecha) : null]),
    ...c.devoluciones.flatMap((x) => [`${x.doc_prefix}-${x.folio}`, ...variantesDeFolio(x.doc_prefix, x.folio), sinCeros(x.folio),
      money(x.monto), x.cliente, x.motivo, x.cajero]),
    // [CSU.13] Los cancelados también se encuentran (por folio, monto o concepto), y «cancelado» lista
    // todos los cortes que tienen alguno.
    ...(c.cobros_cancelados ?? []).flatMap((x) => [`${x.doc_prefix}-${x.folio}`, ...variantesDeFolio(x.doc_prefix, x.folio), sinCeros(x.folio),
      money(x.monto), x.concepto, 'cancelado en kepler']),
  ];
}

/**
 * `[CSU.13]` Cómo se ESCRIBE un folio de Kepler a mano, medido en lo que reportó el PM: «au501-00076» para
 * el cobro `UA0501-0000076`. Tres diferencias contra el folio real, las tres comunes:
 *   · las letras al revés (`AU` por `UA`: el documento es U-A-5-1),
 *   · el tipo sin su cero (`501` por `0501`, o hasta `51`),
 *   · el folio con otra cantidad de ceros (`00076` por `0000076`).
 * Como la búsqueda compara FRAGMENTOS de texto, ninguna de esas formas encontraba nada. La regla: un folio
 * se compara por NÚMERO, no por texto. El documento publica sus variantes cortas (folio sin ceros) y la
 * consulta se lleva a esa misma forma corta con `consultaDeCortes`.
 */
export function variantesDeFolio(prefijo: string | null | undefined, folio: string | null | undefined): string[] {
  const m = (prefijo ?? '').toUpperCase().match(/^([A-Z])([A-Z])(\d{2})(\d{2})$/);
  if (!m || !folio || !/^\d+$/.test(folio)) return [];
  const [, a, b, tipo, serie] = m;
  const n = String(Number(folio));
  const tipos = [...new Set([`${tipo}${serie}`, `${Number(tipo)}${serie}`, `${Number(tipo)}${Number(serie)}`])];
  // `#` cierra el número: sin él, `ua0501-76` sería fragmento de `ua0501-761` y el folio 76 traería el 761.
  return [`${a}${b}`, `${b}${a}`].flatMap((letras) => tipos.map((t) => `${letras}${t}-${n}#`));
}

/** Lleva cada palabra con forma de folio (`au501-00076`, `UA0501-0000076`) a su forma corta (`au501-76#`). */
export function consultaDeCortes(q: string | null | undefined): string {
  return (q ?? '').split(/\s+/).map((t) => t.replace(/^([a-z]{2}\d{1,4})-0*(\d+)$/i, '$1-$2#')).join(' ');
}

/**
 * `[CSU.15]` Un día de una sucursal, con sus cortes adentro. Es la fila de la lista principal.
 *
 * El grano es **(fecha, sucursal)** y no sólo la fecha: el total que hoy se suma a mano es el de
 * una plaza en un día, y un renglón que mezclara ocho sucursales no se podría cuadrar contra nada.
 */
export interface DiaDeCortes {
  /** Llave de la fila para `dataKey`/expansión: `<fecha>|<sucursal>`. */
  clave: string;
  fecha: string;
  sucursal: string;
  sucursal_nombre: string;
  cortes: CorteRow[];
  monto: number;
  cobrado: number;
  saldo: number;
  /** Cortes del día que todavía no se cobraron completos. */
  pendientes: number;
  /** `[CSU.21]` De ésos, los que pasaron el plazo normal de cobro (`plazo_cobro_dias`). Sólo éstos son alarma. */
  vencidos: number;
  /**
   * Cortes del día que no cuadran: el corte contra lo que Kepler esperaba, o `[CSU.17]` un testigo
   * independiente (el cajero; si no contó, los billetes y monedas de Kepler).
   */
  descuadrados: number;
  /** `[CSU.20]` Lo que el cajero contó ese día en esa sucursal y no quedó en ningún corte. */
  fuera: CorteConteoFuera[];
}


/**
 * `[CSU.17]` Una diferencia de arqueo como se pinta en la lista, con su signo en palabras.
 * `null` = ese testigo no contó: se dice con `sinDato`, nunca «Cuadra».
 */
export function celdaArqueo(dif: number | null | undefined, sinDato: string, umbral = 50): { label: string; sev: Sev } {
  if (dif == null) return { label: sinDato, sev: 'secondary' };
  if (Math.abs(dif) < 1) return { label: 'Cuadra', sev: 'success' };
  const label = dif < 0 ? `Falta ${money(-dif)}` : `Sobra ${money(dif)}`;
  // [CSU.21] Debajo del umbral del arqueo es redondeo de monedas: se dice, en gris, sin alarma.
  if (Math.abs(dif) < umbral) return { label, sev: 'secondary' };
  return { label, sev: dif < 0 ? 'danger' : 'warn' };
}

/**
 * `[CSU.21]` La pastilla del corte contra lo que Kepler esperaba. Cuando Kepler registró como contado lo
 * mismo que esperaba (c25 = c15, el 91.5 % de octubre), «Cuadra» compara a Kepler contra sí mismo: se
 * dice «= esperado» en gris, y el verde queda para cuando hubo un contado distinto que sí coincidió.
 */
export function celdaCorte(c: CorteRow): { label: string; sev: Sev } {
  if (c.cuadre === 'cuadra' && c.arqueo?.arqueo_declarado) return { label: '= esperado', sev: 'secondary' };
  return { label: etiquetaCuadre(c), sev: CUADRE[c.cuadre].sev };
}

/** `[CSU.21]` Días entre dos fechas 'YYYY-MM-DD'. */
export function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
}

/** `[CSU.21]` Hoy en la hora de la tienda, 'YYYY-MM-DD'. */
export const hoyMx = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });

/**
 * `[CSU.20]` Por qué un conteo del cajero no está en ningún corte, en palabras. «Sin caja» es una
 * constancia (no tiene monto esperado): se dice lo que escribió quien contó.
 */
export function motivoFuera(x: CorteConteoFuera): string {
  if (x.por_que === 'sin_caja') return x.motivo ? `Constancia sin caja: «${x.motivo.replace(/\s+/g, ' ').trim()}»` : 'Constancia sin caja, sin motivo';
  if (x.por_que === 'folio_de_otro_turno') return x.folio ? `Apunta al turno ${x.folio}, que no estaba abierto cuando se capturó` : 'Apunta a un turno que no estaba abierto';
  return 'Sin folio, y a esa hora no había turno en esa caja';
}

/**
 * `[CSU.19]` El desglose de Kepler marca faltante y los créditos y cheques que declaró el cajero lo
 * explican (con ellos, el desglose concuerda con el cajero). Caso Canindo 5-46: −$9,532.87 de desglose,
 * $9,533.80 en créditos, el cajero +$0.93.
 */
export function creditosExplicanDesglose(a: CorteArqueo): boolean {
  return a.declaracion_cajero?.creditos_fuera_del_desglose === true && a.fisico_diferencia !== null && Math.abs(a.fisico_diferencia) >= 1;
}

/** `[CSU.24]` Una parte del renglón «Efectivo»: lo del cajero y lo de Kepler, lado a lado. */
export interface ParteEfectivo {
  etiqueta: string;
  cajero: number | null;
  kepler: number | null;
  /** Lo que va en la celda de Kepler cuando Kepler no tiene esa parte. */
  nota: string | null;
  difiere: boolean;
}

const conSigno = (x: number): string => (x > 0.005 ? `+${money(x)}` : money(x));

/**
 * `[CSU.24]` Lo que explica una parte que no da lo mismo. Medido en prod (noviembre 2026, 418 cortes
 * con los dos lados): en 22 el cajón da igual y sólo cambia el reparto entre billetes y monedas (hay
 * $20 de las dos); en 43 Kepler trae dentro de su cajón los créditos y cheques; y lo que Kepler retiró
 * y nadie contó se toma como bueno (CSU.16). Ninguno de esos es una diferencia de dinero.
 * `cajon` es `null` cuando el cajero no contó el cierre: los retiros se comparan igual (probado en
 * local el 2026-11-23: Padre Hidalgo, caja 2-128, contó $1,000 más en retiros y no se marcaba).
 */
function lecturaCajon(a: CorteArqueo): { cajon: 'igual' | 'reparto' | 'documentos' | 'difiere' | null; retirado: 'igual' | 'sin_contar' | 'difiere' } | null {
  const d = a.declaracion_cajero, k = a.desglose_kepler;
  if (!d || !k) return null;
  const dRet = d.retiros - k.retirado;
  const retirado = dRet <= -1 ? 'sin_contar' : dRet >= 1 ? 'difiere' : 'igual';
  if (d.cajon === null) return { cajon: null, retirado };
  const dCaj = d.cajon - (k.billetes + k.monedas);
  const dBil = d.cajon_billetes === null ? 0 : d.cajon_billetes - k.billetes;
  const cajon = Math.abs(dCaj) < 1 ? (Math.abs(dBil) >= 1 ? 'reparto' : 'igual')
    : d.documentos > 0 && Math.abs(dCaj + d.documentos) < 1 ? 'documentos' : 'difiere';
  return { cajon, retirado };
}

/**
 * `[CSU.24]` El renglón «Efectivo» del cuadre, parte por parte: billetes y monedas del cajón al cerrar,
 * créditos y cheques, y lo retirado en el turno. Del cajero, de sus piezas; de Kepler, de `c43`, `c44` y
 * `c48`. Las partes suman lo que el renglón ya decía de cada lado (medido sobre octubre y noviembre).
 * Kepler no guarda el conteo por denominación: se compara por familia, no pieza por pieza.
 */
export function partesDelEfectivo(a: CorteArqueo): ParteEfectivo[] {
  const d = a.declaracion_cajero, k = a.desglose_kepler;
  if (!d && !k) return [];
  const l = lecturaCajon(a);
  const dif = (x: number | null, y: number | null): boolean => x !== null && y !== null && Math.abs(x - y) >= 1;
  const cajonDifiere = l?.cajon === 'difiere';
  const partes: ParteEfectivo[] = [];
  if (d && d.cajon !== null && d.cajon_billetes === null) {
    // El cierre no se pudo partir (sin piezas o piezas que no dan el total): el cajón va entero.
    const kc = k ? k.billetes + k.monedas : null;
    partes.push({ etiqueta: 'Cajón al cerrar', cajero: d.cajon, kepler: kc, nota: null, difiere: cajonDifiere && dif(d.cajon, kc) });
  } else {
    const cb = d?.cajon_billetes ?? null, cm = d?.cajon_monedas ?? null;
    partes.push({ etiqueta: 'Billetes en el cajón', cajero: cb, kepler: k?.billetes ?? null, nota: null, difiere: cajonDifiere && dif(cb, k?.billetes ?? null) });
    partes.push({ etiqueta: 'Monedas en el cajón', cajero: cm, kepler: k?.monedas ?? null, nota: null, difiere: cajonDifiere && dif(cm, k?.monedas ?? null) });
  }
  if (d && d.documentos > 0) {
    partes.push({ etiqueta: 'Créditos y cheques en el cajón', cajero: d.documentos, kepler: null, nota: 'no los separa', difiere: false });
  }
  const cr = d ? d.retiros : null, kr = k ? k.retirado : null;
  if ((cr ?? 0) > 0 || (kr ?? 0) > 0) {
    const n = d?.retiros_n ?? 0;
    partes.push({
      etiqueta: n ? `Retirado en el turno · ${n} ${n === 1 ? 'retiro' : 'retiros'}` : 'Retirado en el turno',
      cajero: cr, kepler: kr, nota: null, difiere: l?.retirado === 'difiere',
    });
  }
  return partes;
}

/** `[CSU.24]` En una o dos frases, dónde se separan el cajero y Kepler. `null` si falta uno de los dos lados. */
export function lecturaDelEfectivo(a: CorteArqueo): string | null {
  const l = lecturaCajon(a);
  const d = a.declaracion_cajero, k = a.desglose_kepler;
  if (!l || !d || !k) return null;
  const frases: string[] = [];
  if (d.cajon === null) {
    frases.push('El cajero no contó el cajón al cerrar.');
    if (l.retirado === 'igual') frases.push('Lo retirado coincide.');
  }
  const dCaj = (d.cajon ?? 0) - (k.billetes + k.monedas);
  if (l.cajon === 'reparto') frases.push('El cajón da lo mismo; sólo cambia el reparto entre billetes y monedas.');
  else if (l.cajon === 'documentos') frases.push(`Kepler cuenta dentro de su cajón los ${money(d.documentos)} de créditos y cheques; sin ellos, el cajón da lo mismo.`);
  else if (l.cajon === 'difiere') {
    const fam = d.cajon_billetes === null || d.cajon_monedas === null ? ''
      : ` (billetes ${conSigno(d.cajon_billetes - k.billetes)}, monedas ${conSigno(d.cajon_monedas - k.monedas)})`;
    frases.push(`El cajón difiere: el cajero contó ${conSigno(dCaj)} contra Kepler${fam}.`);
  }
  if (l.retirado === 'sin_contar') frases.push(`Kepler registra ${money(k.retirado - d.retiros)} retirados que el cajero no contó; se toman como buenos.`);
  else if (l.retirado === 'difiere') frases.push(`El cajero contó ${money(d.retiros - k.retirado)} más en retiros de lo que Kepler registra.`);
  return frases.length ? frases.join(' ') : 'El cajero y Kepler coinciden parte por parte.';
}

/**
 * `[CSU.15]` Englobar los cortes por día de sucursal — **el único cambio al proceso de hoy**.
 *
 * ⭐ Agrupa lo que ya se está viendo, no lo que trajo el servidor: recibe la lista **ya filtrada**
 * (sucursal elegida, «sólo con saldo», búsqueda). Si agrupara el universo completo, el total del
 * renglón no sería el de los cortes que se despliegan debajo — un número que no cuadra con su
 * propio detalle, que es peor que no tenerlo.
 *
 * Orden: el día más reciente primero y, dentro del día, por nombre de sucursal. Los cortes de cada
 * día conservan el orden en que venían.
 */
export function agruparCortesPorDia(
  cortes: readonly CorteRow[], fuera: readonly CorteConteoFuera[] = [], hoy: string = hoyMx(), plazo = 3,
): DiaDeCortes[] {
  const grupos = new Map<string, DiaDeCortes>();
  for (const c of cortes) {
    const clave = `${c.fecha}|${c.sucursal}`;
    let g = grupos.get(clave);
    if (!g) {
      g = {
        clave, fecha: c.fecha, sucursal: c.sucursal, sucursal_nombre: c.sucursal_nombre,
        cortes: [], monto: 0, cobrado: 0, saldo: 0, pendientes: 0, vencidos: 0, descuadrados: 0, fuera: [],
      };
      grupos.set(clave, g);
    }
    g.cortes.push(c);
    g.monto += c.monto;
    g.cobrado += c.cobrado;
    g.saldo += c.saldo;
    if (c.saldo > 0.005) g.pendientes++;
    // [CSU.21] La regla de «sin cuadrar» es UNA y la calcula el backend (`sinCuadrar`): la misma del indicador.
    if (c.sin_cuadrar) g.descuadrados++;
    if (c.saldo > 0.005 && diasEntre(c.fecha, hoy) > plazo) g.vencidos++;
  }
  // [CSU.20] Se pegan al día-sucursal que ya se ve (la lista filtrada); los de un día sin cortes
  // visibles no se pierden: los cuenta la barra de arriba.
  for (const x of fuera) grupos.get(`${x.fecha}|${x.sucursal}`)?.fuera.push(x);
  return [...grupos.values()].sort((a, b) =>
    a.fecha === b.fecha ? a.sucursal_nombre.localeCompare(b.sucursal_nombre, 'es') : b.fecha.localeCompare(a.fecha));
}

// ─── [CSU.31] Anexo FB: ¿dónde está hoy el dinero que vendió cada caja? ─────────────────────────────────────

const plural = (n: number, uno: string, varios: string): string => `${n.toLocaleString('es-MX')} ${n === 1 ? uno : varios}`;

/**
 * `[CSU.31]` CSU.UI.1 — el último cobro aplicado **hasta hoy**. Kepler trae cobros con fecha futura (medido el
 * 2026-11-27: `04 UA0501-0000134` fechado el 13-dic): tomar el máximo publicaba como frescura una fecha que no ha
 * llegado. Los futuros se cuentan aparte para decirlos, con su fecha para buscarlos.
 */
export function ultimoCobroHasta(cortes: readonly CorteRow[], hoy: string): { fecha: string | null; futuros: number; primeraFutura: string | null } {
  let fecha: string | null = null, primeraFutura: string | null = null, futuros = 0;
  for (const c of cortes) {
    for (const b of c.cobros) {
      if (!b.fecha) continue;
      if (b.fecha > hoy) { futuros++; if (!primeraFutura || b.fecha < primeraFutura) primeraFutura = b.fecha; continue; }
      if (!fecha || b.fecha > fecha) fecha = b.fecha;
    }
  }
  return { fecha, futuros, primeraFutura };
}

/**
 * `[CSU.31]` Lo que muestra la lista. ⭐ CSU.UI.2: cada filtro es la MISMA regla que la cifra que lo abre (un
 * indicador, una frase o una opción de «Mostrar»), así que contar y sumar los cortes filtrados da el número publicado.
 * Los de llegada van por MONTO —un corte puede tener una parte llegada y otra por saber—, no por el estado del
 * corte: la suma de los filtrados es, al centavo, la del resumen del periodo (`anexarLlegadaYVenta` suma corte por
 * corte).
 */
export type FiltroCortes =
  | 'todos' | 'con_saldo' | 'vencido' | 'sin_cuadrar' | 'venta_sin_forma_de_pago'
  | 'con_llegada' | 'por_saber' | 'sin_conciliar' | 'fuera_de_corte';

/** El orden del selector «Mostrar». */
export const FILTROS_CORTES: readonly FiltroCortes[] = [
  'todos', 'con_saldo', 'vencido', 'sin_cuadrar', 'venta_sin_forma_de_pago', 'con_llegada', 'por_saber', 'sin_conciliar', 'fuera_de_corte',
];
/** Los filtros que dependen de la llegada al banco (CSU.26–29): sin medición no se ofrecen como si dieran cero. */
export const FILTROS_DE_LLEGADA: ReadonlySet<FiltroCortes> = new Set<FiltroCortes>(['con_llegada', 'por_saber', 'sin_conciliar']);

export function etiquetaFiltro(f: FiltroCortes, plazo: number): string {
  switch (f) {
    case 'todos': return 'Todos los cortes';
    case 'con_saldo': return 'Con saldo por cobrar';
    case 'vencido': return `Con saldo de más de ${plazo} días`;
    case 'sin_cuadrar': return 'Sin cuadrar';
    case 'venta_sin_forma_de_pago': return 'Venta sin forma de pago';
    case 'con_llegada': return 'Con dinero que ya llegó';
    case 'por_saber': return 'Por saber: Bancos no tiene el banco de esa fecha';
    case 'sin_conciliar': return 'Sin conciliar en Bancos ni en Caja General';
    case 'fuera_de_corte': return 'Días con conteos fuera de corte';
  }
}

export function cumpleFiltro(c: CorteRow, f: FiltroCortes, hoy: string, plazo: number, diasConFuera: ReadonlySet<string>): boolean {
  const l = c.llegada ?? null;
  switch (f) {
    case 'todos': return true;
    case 'con_saldo': return c.saldo > 0.005;
    // La MISMA regla del indicador «Pendiente de cobro · con más de N días» y de la fila del día.
    case 'vencido': return c.saldo > 0.005 && diasEntre(c.fecha, hoy) > plazo;
    case 'sin_cuadrar': return !!c.sin_cuadrar;
    case 'venta_sin_forma_de_pago': return c.venta_sin_forma_de_pago != null;
    case 'con_llegada': return !!l && l.llego > 0.005;
    case 'por_saber': return !!l && l.por_saber > 0.005;
    case 'sin_conciliar': return !!l && l.sin_conciliar > 0.005;
    case 'fuera_de_corte': return diasConFuera.has(`${c.fecha}|${c.sucursal}`);
  }
}

/** `[CSU.31]` El monto que acompaña a un filtro —el mismo que publica su cifra—; `null` = ese filtro sólo cuenta. */
export function montoDelFiltro(c: CorteRow, f: FiltroCortes): number | null {
  const l = c.llegada ?? null;
  switch (f) {
    case 'con_saldo': case 'vencido': return Math.max(c.saldo, 0);
    case 'venta_sin_forma_de_pago': return c.venta_sin_forma_de_pago ?? 0;
    case 'con_llegada': return l?.llego ?? 0;
    case 'por_saber': return l?.por_saber ?? 0;
    case 'sin_conciliar': return l?.sin_conciliar ?? 0;
    default: return null;
  }
}

/** `[CSU.31]` Cuántos cortes pasan un filtro y cuánto suman (`null` = el filtro no lleva monto). */
export function resumenDelFiltro(
  cortes: readonly CorteRow[], f: FiltroCortes, hoy: string, plazo: number, diasConFuera: ReadonlySet<string>,
): { cortes: number; monto: number | null } {
  let n = 0, monto: number | null = null;
  for (const c of cortes) {
    if (!cumpleFiltro(c, f, hoy, plazo, diasConFuera)) continue;
    n++;
    const m = montoDelFiltro(c, f);
    if (m !== null) monto = (monto ?? 0) + m;
  }
  return { cortes: n, monto: monto === null ? null : Math.round(monto * 100) / 100 };
}

/** `[CSU.31]` Las cuentas cuyo libro de Bancos todavía no llega a sus depósitos: cuánto espera cada una y hasta dónde llega. */
export function cuentasPorSaber(cortes: readonly CorteRow[]): { cuenta: string; libro_hasta: string | null; monto: number }[] {
  const m = new Map<string, { cuenta: string; libro_hasta: string | null; monto: number }>();
  for (const c of cortes) {
    for (const b of c.cobros) {
      const l = b.llegada;
      if (!l || l.estado !== 'banco_sin_libro') continue;
      const k = l.cuenta_bancos ?? b.cuenta_tesoreria ?? l.cuenta ?? 'cuenta sin nombre';
      const x = m.get(k) ?? { cuenta: k, libro_hasta: l.libro_hasta, monto: 0 };
      x.monto += b.monto;
      m.set(k, x);
    }
  }
  return [...m.values()].map((x) => ({ ...x, monto: Math.round(x.monto * 100) / 100 })).sort((a, b) => b.monto - a.monto);
}

/** `[CSU.31]` Un trozo de la frase del periodo: texto, o un número que abre sus cortes (`filtro`). */
export interface TrozoFrase { texto: string; filtro?: FiltroCortes }

/**
 * `[CSU.31]` La respuesta del periodo, en una frase (Q.1, CSU.UI.10): dónde está el dinero que Kepler aplicó a los
 * cortes y qué falta. Se calcula sobre los cortes que se ven (la sucursal elegida, o todas) y cada número que la
 * frase cuenta abre exactamente esos cortes (CSU.UI.2). `llegadaMedida = false` → se dice, nunca «no llegó».
 */
export function fraseDelPeriodo(
  cortes: readonly CorteRow[],
  ctx: { hoy: string; plazo: number; llegadaMedida: boolean; ventaMedida: boolean; donde: string | null; diasConFuera: ReadonlySet<string> },
): TrozoFrase[] {
  if (!cortes.length) return [];
  const r = (f: FiltroCortes) => resumenDelFiltro(cortes, f, ctx.hoy, ctx.plazo, ctx.diasConFuera);
  const t: TrozoFrase[] = [];
  const add = (texto: string, filtro?: FiltroCortes) => t.push(filtro ? { texto, filtro } : { texto });
  const aplicado = Math.round(cortes.reduce((s, c) => s + c.cobros.reduce((x, b) => x + b.monto, 0), 0) * 100) / 100;
  const inicio = ctx.donde ? `En ${ctx.donde}, de` : 'De';
  if (!ctx.llegadaMedida) {
    add(`${inicio} los cortes, Kepler aplicó ${money(aplicado)} en depósitos. No se pudo medir si ese dinero llegó al banco o a Caja General.`);
  } else {
    const llego = r('con_llegada').monto ?? 0;
    const puente = Math.round(cortes.reduce((s, c) => s + (c.llegada?.puente ?? 0), 0) * 100) / 100;
    const pct = aplicado > 0 ? ` (${((llego / aplicado) * 100).toFixed(1)} %)` : '';
    add(`${inicio} ${money(aplicado)} que Kepler aplicó a los cortes, ${money(llego)}${pct} ya están en el banco o en Caja General`);
    add(puente > 0.005 ? `; ${money(puente)} son devoluciones o ajustes que no viajan al banco.` : '.');
    const ps = r('por_saber');
    if (ps.cortes) {
      const cuentas = cuentasPorSaber(cortes);
      const lista = cuentas.slice(0, 2).map((x) => `${x.cuenta}${x.libro_hasta ? ` llega al ${dmy(x.libro_hasta)}` : ''}`).join('; ');
      add(` ${money(ps.monto ?? 0)} no se pueden saber todavía: Bancos no tiene el estado de cuenta de esa fecha (${lista}${cuentas.length > 2 ? '; y otras' : ''}), en `);
      add(plural(ps.cortes, 'corte', 'cortes'), 'por_saber');
      add('.');
    }
    const sc = r('sin_conciliar');
    if (sc.cortes) {
      add(' ');
      add(plural(sc.cortes, 'corte tiene', 'cortes tienen'), 'sin_conciliar');
      add(` ${money(sc.monto ?? 0)} sin conciliar: sin renglón del banco ni entrada de Caja General que los respalde.`);
    }
  }
  const cs = r('con_saldo');
  if (cs.cortes) {
    add(' ');
    add(plural(cs.cortes, 'corte tiene', 'cortes tienen'), 'con_saldo');
    add(` saldo sin depósito en Kepler por ${money(cs.monto ?? 0)}`);
    const v = r('vencido');
    if (v.cortes) { add(', '); add(`${v.cortes.toLocaleString('es-MX')} con más de ${ctx.plazo} días`, 'vencido'); }
    add('.');
  }
  if (!ctx.ventaMedida) {
    add(' La venta del turno no se pudo medir.');
  } else {
    const vs = r('venta_sin_forma_de_pago');
    if (vs.cortes) {
      add(' ');
      add(plural(vs.cortes, 'corte tiene', 'cortes tienen'), 'venta_sin_forma_de_pago');
      add(` venta sin forma de pago por ${money(vs.monto ?? 0)}.`);
    }
  }
  return t;
}

/**
 * `[CSU.31]` ¿Llegó el dinero del corte?, como se pinta en la lista y en el detalle. `null` = no se midió: la celda
 * cae al estado de cobro de siempre (nunca «no llegó»). Color (CSU.UI.7): «llegó» y «por saber» neutros; ámbar lo
 * que lleva más del plazo sin depósito y lo aplicado sin testigo.
 */
export function celdaLlegada(c: CorteRow, hoy: string, plazo: number): { label: string; sev: Sev } | null {
  const l = c.llegada ?? null;
  if (!l) return null;
  const edad = l.edad_dias ?? diasEntre(c.fecha, hoy);
  switch (l.estado) {
    // Revisión: un corte saldado SÓLO con devoluciones o ajustes (cuenta puente) queda «llegó» con $0 llegado: nada
    // falta, pero tampoco llegó dinero. Se dice lo que es (y así no choca con «Con dinero que ya llegó»).
    case 'llego': return l.llego < 0.005 && l.puente > 0.005 ? { label: 'Saldado con devoluciones o ajustes', sev: 'secondary' } : { label: 'Llegó', sev: 'secondary' };
    case 'por_saber': return { label: `Por saber ${money(l.por_saber)}`, sev: 'secondary' };
    case 'sin_conciliar': return { label: `Sin conciliar ${money(l.sin_conciliar)}`, sev: 'warn' };
    case 'parcial': return { label: `Falta depositar ${money(l.sin_deposito)}`, sev: edad > plazo ? 'warn' : 'secondary' };
    case 'sin_deposito': return { label: `Sin depósito · ${plural(edad, 'día', 'días')}`, sev: edad > plazo ? 'warn' : 'secondary' };
  }
}

/** `[CSU.31]` La respuesta del corte, arriba del detalle (Q.1): dónde está su dinero, en una o dos frases. */
export function fraseDelCorte(c: CorteRow): string | null {
  const l = c.llegada ?? null;
  if (!l) return null;
  const fechas = c.cobros.map((b) => b.fecha).filter((f): f is string => !!f).sort();
  const cuando = !fechas.length ? '' : fechas[0] === fechas[fechas.length - 1] ? ` el ${dmy(fechas[0])}` : ` del ${dmy(fechas[0])} al ${dmy(fechas[fechas.length - 1])}`;
  const cuentas = [...new Set(c.cobros.map((b) => b.llegada?.cuenta_bancos ?? b.cuenta_tesoreria).filter((x): x is string => !!x))];
  const a = cuentas.length ? ` a ${cuentas.length > 2 ? `${cuentas.length} cuentas` : cuentas.join(' y ')}` : '';
  const tambien = l.llego > 0.005 ? ` ${money(l.llego)} sí llegaron.` : '';
  switch (l.estado) {
    case 'llego':
      if (l.llego < 0.005 && l.puente > 0.005) return `Kepler saldó el corte con devoluciones o ajustes por ${money(l.puente)}: ese dinero no viaja al banco.`;
      return `El dinero del corte llegó: ${money(l.llego)} en ${plural(c.cobros.length, 'depósito', 'depósitos')}${cuando}${a}.`;
    case 'por_saber': return `${money(l.por_saber)} están en una cuenta cuyo estado de cuenta Bancos todavía no tiene completo para esa fecha: no se puede saber si llegaron.${tambien}`;
    // Revisión: «sin conciliar» es que falta el TESTIGO, no que falte el dinero: se dice eso.
    case 'sin_conciliar': return `${money(l.sin_conciliar)} que Kepler aplicó a este corte no tienen renglón del banco ni entrada de Caja General que los respalde: Bancos no los ha conciliado.${tambien}`;
    case 'parcial': return `Falta depositar ${money(l.sin_deposito)} de ${money(c.monto)}.${tambien}`;
    case 'sin_deposito': return `Kepler no le ha aplicado ningún depósito${l.edad_dias != null ? `; el corte tiene ${plural(l.edad_dias, 'día', 'días')}` : ''}.`;
  }
}

/** `[CSU.31]` Dónde llegó UN depósito, en palabras. `alerta` = lo aplicado no tiene testigo. */
export function llegadaDelCobro(b: CorteCobro): { titulo: string; alerta: boolean } {
  const l = b.llegada ?? null;
  if (!l) return { titulo: 'No se pudo medir si llegó.', alerta: false };
  const cuenta = l.cuenta_bancos ?? b.cuenta_tesoreria ?? l.cuenta;
  switch (l.estado) {
    case 'en_banco': return { titulo: l.renglones.some((r) => r.debil) ? 'En el banco (probable: lo ligó un pase débil de la conciliación)' : 'En el banco', alerta: false };
    case 'en_caja_general': return { titulo: 'En Caja General', alerta: false };
    case 'caja_sin_asiento': return { titulo: 'Falta su entrada en Caja General', alerta: true };
    case 'banco_sin_libro': {
      // El último día del estado de cuenta suele venir cortado (CSU.26): si llega justo al día del depósito, se dice.
      const mismoDia = !!l.libro_hasta && !!b.fecha && l.libro_hasta >= b.fecha ? ', el mismo día del depósito, y ese último día suele venir incompleto' : '';
      return { titulo: `Todavía no se puede saber: el estado de cuenta de ${cuenta ?? 'esa cuenta'} en Bancos llega al ${l.libro_hasta ? dmy(l.libro_hasta) : '—'}${mismoDia}`, alerta: false };
    }
    case 'sin_conciliar': return { titulo: `Sin conciliar en Bancos${cuenta ? ` (${cuenta}${l.libro_hasta ? `, su estado de cuenta llega al ${dmy(l.libro_hasta)}` : ''})` : ''}`, alerta: true };
    case 'puente': return { titulo: 'No viaja a un banco: devolución, ajuste o traspaso', alerta: false };
    case 'sin_cuenta': return { titulo: 'Sin cuenta de tesorería en Kepler', alerta: true };
  }
}

/** El corte de caja POS (U-D-23) arrancó en Kepler con el cambio del 1-oct-2026. */
const INICIO_CORTES = '2026-10-01';

const pad = (n: number): string => String(n).padStart(2, '0');
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

/**
 * `[CSU.2]` Cortes/Sucursales — el dinero de mostrador por turno de caja.
 *
 * Corte de caja POS (Kepler `U-D-23`, cliente CONTADO) → cobros aplicados (`U-A-5`) → arqueo del
 * turno. Responde "¿cuánto vendió cada caja, cuánto ya se cobró y qué falta?". Sólo lectura: el
 * cobro se captura en Kepler. El paso al banco (y el tramo del efectivo por Caja Fuerte) es la
 * entrega 2 y se DECLARA en el detalle, no se dibuja como pendiente.
 */
@Component({
  selector: 'app-finanzas-cortes-sucursales',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, TableModule, SelectModule, DatePickerModule, TagModule,
    InputTextModule, IconFieldModule, InputIconModule, MetricStripComponent, SucursalPipe, PageTabsComponent, ContextHelpComponent, SidePeekComponent],
  template: `
    <div class="surf-page in">
      <header class="surf-page-head">
        <div class="surf-page-head-text">
          <h1>Cortes / Sucursales</h1>
          <!-- [CSU.31] CSU.UI.10: en un renglón. El «CONTADO» en negritas se partía en su propio renglón en el celular. -->
          <p class="surf-page-sub">Del corte de caja al banco: lo que vendió cada caja, lo que Kepler cobró y si el dinero llegó.</p>
        </div>
        <div class="cs-actions">
          <app-context-help topic="cortes-sucursales" />
          <button pButton type="button" class="p-button-sm p-button-outlined cs-tap" [loading]="loading()" (click)="reload()"><span class="p-button-icon p-button-icon-left pi pi-refresh" aria-hidden="true"></span><span class="p-button-label">Actualizar</span></button>
        </div>
      </header>

      <app-page-tabs [tabs]="apartadoTabs" />

      <div class="cs-filters">
        <!-- [CSU.13] Buscador sobre la lista COMPLETA del periodo (no paginada en el servidor): token por
             token, sin acentos y en todos los campos del corte, sus cobros y sus devoluciones. -->
        <div class="cs-field cs-buscar"><label for="cs-q">Buscar corte <kbd class="cs-kbd" aria-hidden="true">/</kbd></label>
          <p-iconfield>
            <!-- El ícono va ADENTRO. Medido en el navegador: PrimeNG 22 pisa el class del host de p-inputicon
                 (host [class] = cx root) y su plantilla es sólo ng-content, así que styleClass y class se pierden y
                 la lupa queda en 0 px. Las otras 3 pantallas que usan styleClass tienen la lupa invisible igual. -->
            <p-inputicon><i class="pi pi-search" aria-hidden="true"></i></p-inputicon>
            <input #buscador pInputText id="cs-q" type="search" class="cs-q" autocomplete="off" [ngModel]="q()" (ngModelChange)="q.set($event)"
                   (keydown.escape)="limpiarBusqueda()" placeholder="Folio, caja-turno, cobro, monto, cajero…"
                   aria-describedby="cs-q-ayuda" />
          </p-iconfield>
          <span id="cs-q-ayuda" class="sr-only">Busca en todas las sucursales del periodo. Varias palabras en cualquier orden. Escape limpia.</span>
        </div>
        <div class="cs-field"><label for="cs-mes">Mes</label>
          <p-select inputId="cs-mes" [options]="mesOpts" optionLabel="label" optionValue="value" [ngModel]="mes()" (onChange)="pickMes($event.value)" placeholder="Rango" appendTo="body" class="cs-sel" /></div>
        <div class="cs-field"><label for="cs-rango">Rango específico</label>
          <p-datepicker inputId="cs-rango" [(ngModel)]="rangeDates" selectionMode="range" dateFormat="dd/mm/yy" [showIcon]="true" appendTo="body" placeholder="Elegir fechas" (onClose)="onRange()" /></div>
        <!-- [CSU.31] CSU.UI.2: «Mostrar» reemplaza el interruptor «Sólo con saldo». Cada opción lleva su número, el
             mismo que el indicador o la frase que la abre; las de llegada se apagan si la llegada no se midió. -->
        <div class="cs-field"><label for="cs-mostrar">Mostrar</label>
          <p-select inputId="cs-mostrar" [options]="opcionesFiltro()" optionLabel="label" optionValue="value" optionDisabled="disabled"
                    [ngModel]="filtro()" (onChange)="ponerFiltro($event.value, false)" appendTo="body" class="cs-sel" /></div>
      </div>

      @if (err(); as e) { <div class="cs-errbox" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span class="cs-errbox-txt">{{ e }}</span><button pButton type="button" class="p-button-sm p-button-outlined" (click)="reload()"><span class="p-button-label">Reintentar</span></button></div> }

      @if (loading() && !data()) { <div class="fb-skeleton" aria-busy="true">@for (i of skel; track $index) { <div class="fb-skel-row"></div> }</div> }
      @else if (data(); as d) {
        <p class="cs-periodo">Periodo {{ dmy(d.periodo.from) }} – {{ dmy(d.periodo.to) }}@if (d.ultimo_corte) { · último corte {{ dmy(d.ultimo_corte) }} }@if (d.cortes_en_blanco) { · {{ d.cortes_en_blanco }} corte(s) en blanco (menos de $1) no se listan }</p>
        @if (!d.alcance.todas) {
          @if (d.alcance.sucursales.length) {
            <div class="cs-note" role="note"><i class="pi pi-shop" aria-hidden="true"></i><span>Viendo sólo {{ d.alcance.sucursales.length === 1 ? 'tu sucursal' : 'tus sucursales' }}: <b>{{ sucursalesTexto(d) }}</b>.</span></div>
          } @else {
            <div class="cs-note cs-note-bad" role="alert"><i class="pi pi-exclamation-triangle" aria-hidden="true"></i><span>Tu ficha no tiene una sucursal asignada, así que no hay cortes que mostrarte. Pide que te la asignen en <b>Administración › Personas</b>.</span></div>
          }
        }
        @if (antesDeCortes(d)) {
          <div class="cs-note" role="note"><i class="pi pi-info-circle" aria-hidden="true"></i><span>El corte de caja POS en Kepler arrancó el <b>01/10/2026</b>. Antes de esa fecha casi no hay cortes; un periodo anterior se ve vacío por eso, no porque no haya habido venta.</span></div>
        }

        <!-- [CSU.31] La respuesta del periodo (Q.1): dónde está el dinero. Cada número abre sus cortes (CSU.UI.2). -->
        @if (frase().length) {
          <p class="cs-respuesta">@for (t of frase(); track $index) {@if (t.filtro) {<button type="button" class="cs-link cs-link-frase" [class.cs-link-on]="filtro() === t.filtro"
              [attr.aria-pressed]="filtro() === t.filtro" (click)="ponerFiltro(t.filtro, false)">{{ t.texto }}</button>} @else {<span>{{ t.texto }}</span>}}</p>
        }

        <app-metric-strip [items]="kpiItems()" [instant]="true" ariaLabel="Resumen de cortes del periodo" [selected]="drillActivo()" (drill)="ponerFiltro($any($event), true)" />

        <section class="cs-block dt-scope" aria-labelledby="cs-h-suc">
          <div class="cs-bh"><h2 id="cs-h-suc">Por sucursal</h2>
            <span class="cs-hint" aria-live="polite">@if (selSuc(); as s) { Viendo {{ s.sucursal_nombre }}@if (sucursalesOcultas()) { · {{ sucursalesOcultas() }} oculta{{ sucursalesOcultas() > 1 ? 's' : '' }} } · <button type="button" class="cs-link" (click)="pickSuc(null)">ver todas</button> } @else { Elige una sucursal para ver sus cortes }</span></div>
          <!-- [CSU.14] Con una sucursal elegida sólo queda su fila: las demás se ocultan para dar el espacio a sus
               cortes. Vuelven con «ver todas» o con otro clic sobre la misma fila. -->
          <p-table [value]="sucursalesVisibles()" size="small" class="surf-table dt-stack" [rowHover]="true" selectionMode="single" [selection]="selSuc()" (selectionChange)="pickSuc($event)" dataKey="sucursal">
            <ng-template #header><tr class="cs-thr"><th>Sucursal</th><th class="ta-r">Cortes</th><th class="ta-r">Vendido</th><th class="ta-r">Cobrado</th><th class="ta-r">Pendiente</th><th class="ta-r">% cobrado</th><th>Abierto desde</th><th>Revisar</th></tr></ng-template>
            <ng-template #body let-s>
              <tr [pSelectableRow]="s">
                <td role="cell" data-label="Sucursal">{{ s.sucursal_nombre }}</td>
                <td class="ta-r num" role="cell" data-label="Cortes">{{ s.cortes }}</td>
                <td class="ta-r num" role="cell" data-label="Vendido">{{ money(s.vendido) }}</td>
                <td class="ta-r num" role="cell" data-label="Cobrado" [class.muted]="!s.cobrado">{{ s.cobrado ? money(s.cobrado) : '—' }}</td>
                <td class="ta-r num cs-strong" role="cell" data-label="Pendiente">{{ money(s.pendiente) }}</td>
                <td class="ta-r num" role="cell" data-label="% cobrado">{{ pct(s.cobrado, s.vendido) }}</td>
                <td role="cell" data-label="Abierto desde">@if (s.abierto_desde) { {{ dmy(s.abierto_desde) }} <span class="muted">· {{ dias(s.abierto_desde) }} d</span> } @else { <span class="muted">—</span> }</td>
                <td role="cell" data-label="Revisar">
                  @if (s.con_diferencia) { <p-tag [value]="s.con_diferencia + ' sin cuadrar'" severity="danger" styleClass="cs-tag" /> }
                  @if (s.sin_arqueo) { <p-tag [value]="s.sin_arqueo + ' sin arqueo'" severity="info" styleClass="cs-tag" /> }
                  @if (!s.con_diferencia && !s.sin_arqueo) { <span class="muted">—</span> }
                </td>
              </tr>
            </ng-template>
            <ng-template #emptymessage><tr><td colspan="8"><div class="cs-empty"><i class="pi pi-inbox" aria-hidden="true"></i><span>Sin cortes de caja en el periodo.</span></div></td></tr></ng-template>
          </p-table>
        </section>

        <div class="cs-split" [class.cs-split-solo]="!selCorte() || angosta()">
          <section class="cs-block dt-scope" aria-labelledby="cs-h-cortes">
            <div class="cs-bh"><h2 id="cs-h-cortes">Cortes @if (selSuc(); as s) { · {{ s.sucursal_nombre }} }</h2>
              <span class="cs-hint" aria-live="polite">
                <!-- [CSU.31] CSU.UI.2: con un filtro, cuántos de cuántos y cuánto suman —el número de la cifra que lo abrió—. -->
                @if (filtro() !== 'todos') { <b>{{ resumenFiltroActivo().cortes }} de {{ cortesEnAlcance().length }} cortes · {{ etiquetaFiltro(filtro(), plazo()) }}@if (resumenFiltroActivo().monto !== null) { · {{ money(resumenFiltroActivo().monto!) }} }@if (filtro() === 'fuera_de_corte') { · {{ fueraEnLista().n }} conteo(s)@if (fueraEnLista().fuera) { ({{ fueraEnLista().fuera }} más en días sin cortes, que la lista no muestra) } }</b> · <button type="button" class="cs-link" (click)="ponerFiltro('todos', false)">Quitar filtro</button> · }
                @if (q().trim()) { {{ cortes().length }} de {{ cortesBase().length }} corte(s) con «{{ q().trim() }}» · <button type="button" class="cs-link" (click)="limpiarBusqueda()">limpiar</button> · } @else { {{ diasDeCortes().length }} día(s) · {{ cortes().length }} corte(s) · } pendiente {{ money(pendienteVisible()) }}@if (fueraVisibles().length) { · <button type="button" class="cs-link" (click)="ponerFiltro('fuera_de_corte', false)">{{ fueraVisibles().length }} conteo(s) fuera de corte</button> por {{ money(sumaFuera(fueraVisibles())) }} }
                <!-- [CSU.31] CSU.UI.1: el último cobro HASTA HOY; los que Kepler fechó en el futuro se dicen y se buscan. -->
                @if (ultimoCobro().fecha; as u) { · último cobro aplicado en Kepler: {{ dmy(u) }} }@if (ultimoCobro().futuros) { · <button type="button" class="cs-link" (click)="buscar(dmy(ultimoCobro().primeraFutura!))">{{ ultimoCobro().futuros }} cobro(s) con fecha posterior a hoy</button> }
                @if (!plegadoBloqueado() && diasDeCortes().length > 1) { · <button type="button" class="cs-link" (click)="todosLosDias(!algunDiaAbierto())">{{ algunDiaAbierto() ? 'plegar todos' : 'desplegar todos' }}</button> }</span></div>
            <p-table [value]="diasDeCortes()" size="small" class="surf-table dt-stack" [rowHover]="true" [scrollable]="true" scrollHeight="58vh" dataKey="clave" [expandedRowKeys]="diasAbiertos()" [paginator]="diasDeCortes().length > 100" [rows]="100">
              <ng-template #header><tr class="cs-thr"><th class="cs-togcol"><span class="sr-only">Desplegar</span></th><th>Día</th>@if (!selSuc()) { <th>Sucursal</th> }<th class="ta-r">Cortes</th><th class="ta-r">Monto<span class="cs-th-de">cortes en Kepler</span></th><th class="ta-r">Cobrado<span class="cs-th-de">aplicado en Kepler</span></th><th class="ta-r">Saldo<span class="cs-th-de">por cobrar</span></th><th>Estado</th></tr></ng-template>
              <ng-template #body let-d let-expanded="expanded">
                <tr class="cs-dia" [class.cs-dia-abierta]="expanded">
                  <td role="cell" data-label="Desplegar"><button type="button" class="cs-tog" (click)="toggleDia(d)" [disabled]="plegadoBloqueado()"
                      [attr.aria-expanded]="expanded" [attr.aria-label]="(expanded ? 'Plegar ' : 'Desplegar ') + d.cortes.length + ' cortes de ' + (d.sucursal | sucursal) + ' del ' + dmy(d.fecha)">
                      <i class="pi" [class.pi-chevron-down]="expanded" [class.pi-chevron-right]="!expanded" aria-hidden="true"></i></button></td>
                  <td class="cs-mono cs-strong" role="cell" data-label="Día">{{ dmy(d.fecha) }}</td>
                  @if (!selSuc()) { <td role="cell" data-label="Sucursal">{{ d.sucursal | sucursal }}</td> }
                  <td class="ta-r num muted" role="cell" data-label="Cortes">{{ d.cortes.length }}</td>
                  <td class="ta-r num cs-strong" role="cell" data-label="Monto">{{ money(d.monto) }}</td>
                  <td class="ta-r num" role="cell" data-label="Cobrado" [class.muted]="!d.cobrado">{{ d.cobrado ? money(d.cobrado) : '—' }}</td>
                  <td class="ta-r num cs-strong" role="cell" data-label="Saldo" [class.cs-bad]="d.vencidos > 0">{{ money(d.saldo) }}</td>
                  <td role="cell" data-label="Estado">
                    @if (d.vencidos) { <p-tag [value]="d.vencidos + ' por cobrar · más de ' + plazo() + ' días'" severity="warn" styleClass="cs-tag" /> }
                    @if (d.pendientes - d.vencidos) { <p-tag [value]="(d.pendientes - d.vencidos) + ' en plazo'" severity="secondary" styleClass="cs-tag" /> }
                    <!-- [CSU.31] Con la llegada medida, «cobrado» ya no es el final: se dice si llegó (CSU.UI.7: neutro) y lo que
                         no se puede saber o no tiene testigo. Sin medición, lo de siempre. -->
                    @let ld = llegadaDelDia(d);
                    @if (ld) {
                      @if (ld.sin_conciliar) { <p-tag [value]="ld.sin_conciliar + ' sin conciliar'" severity="warn" styleClass="cs-tag" /> }
                      @if (ld.por_saber) { <p-tag [value]="ld.por_saber + ' por saber'" severity="secondary" styleClass="cs-tag" /> }
                      @if (!d.pendientes && !ld.sin_conciliar && !ld.por_saber && ld.llegaron) { <p-tag value="Llegó todo" severity="secondary" styleClass="cs-tag" /> }
                    } @else if (!d.pendientes) { <p-tag value="Todo cobrado" severity="success" styleClass="cs-tag" /> }
                    @if (d.descuadrados) { <p-tag [value]="d.descuadrados + ' sin cuadrar'" severity="danger" styleClass="cs-tag" /> }
                    @if (d.fuera.length) { <p-tag [value]="d.fuera.length + ' fuera de corte'" severity="info" styleClass="cs-tag" /> }
                  </td>
                </tr>
              </ng-template>
              <ng-template #expandedrow let-d>
                <tr class="cs-dia-det"><td [attr.colspan]="selSuc() ? 7 : 8">
                  <table class="cs-cortes">
                    <!-- [CSU.17] Cada número dice de quién es. Los tres arqueos son diferencias contra lo
                         que Kepler esperaba: el corte (Kepler contra si mismo), el cajero (su arqueo ciego)
                         y los billetes y monedas que capturo Kepler. -->
                    <!-- [CSU.31] CSU.UI.5: «¿Llegó?» REEMPLAZA a «Cobro» (sin depósito ≈ sin cobro, falta depositar ≈ parcial)
                         y la caja-turno va bajo el folio: 8 columnas, no 10. CSU.UI.4: cada celda lleva su rótulo para
                         cuando la fila se apila en el celular. -->
                    <thead><tr><th>Corte<span class="cs-th-de">caja-turno</span></th><th class="ta-r">Monto</th><th class="ta-r">Cobrado<span class="cs-th-de">en Kepler</span></th><th class="ta-r">Saldo</th><th>¿Llegó?<span class="cs-th-de">banco o Caja General</span></th>
                      <th>Corte<span class="cs-th-de">vs esperado Kepler</span></th><th>Cajero<span class="cs-th-de">arqueo ciego</span></th><th>Billetes y monedas<span class="cs-th-de">Kepler · sin créditos</span></th></tr></thead>
                    <tbody>
                      @for (c of d.cortes; track c.clave) {
                        <tr class="cs-corte" [class.cs-corte-sel]="selCorte()?.clave === c.clave" (click)="selCorte.set(c)" tabindex="0"
                            (keydown.enter)="selCorte.set(c)" (keydown.space)="selCorte.set(c); $event.preventDefault()"
                            [attr.aria-label]="'Ver el corte ' + c.documento">
                          <td role="cell" class="dt-id" data-label="Corte"><span class="cs-mono">{{ c.documento }}</span><span class="cs-sub-celda cs-mono">{{ c.caja && c.turno ? c.caja + '-' + c.turno : c.referencia }}</span></td>
                          <td role="cell" class="ta-r num" data-label="Monto">{{ money(c.monto) }}</td>
                          <td role="cell" class="ta-r num" data-label="Cobrado en Kepler" [class.muted]="!c.cobrado">{{ c.cobrado ? money(c.cobrado) : '—' }}</td>
                          <td role="cell" class="ta-r num cs-strong" data-label="Saldo" [class.cs-bad]="c.saldo > 0.005 && vencido(c)">{{ money(c.saldo) }}</td>
                          @let lc = celdaDeLlegada(c);
                          <td role="cell" data-label="¿Llegó?">@if (lc) { <p-tag [value]="lc.label" [severity]="lc.sev" styleClass="cs-tag" /> } @else { <p-tag [value]="cobroLabel(c.estado_cobro)" [severity]="cobroSev(c.estado_cobro)" styleClass="cs-tag" /> }
                            @if (lc && c.estado_cobro === 'sobrecobrado') { <p-tag [value]="cobroLabel(c.estado_cobro)" [severity]="cobroSev(c.estado_cobro)" styleClass="cs-tag" /> }
                            @if (c.cobros_cancelados.length) { <p-tag [value]="c.cobros_cancelados.length + ' cancelado' + (c.cobros_cancelados.length > 1 ? 's' : '')" severity="secondary" styleClass="cs-tag" [attr.title]="'Cobros cancelados en Kepler: no suman'" /> }</td>
                          @let cc = celdaDelCorte(c);
                          <td role="cell" data-label="Corte vs esperado"><p-tag [value]="cc.label" [severity]="cc.sev" styleClass="cs-tag" /></td>
                          @if (c.arqueo; as a) {
                            @let cj = celdaCajero(a);
                            @let kp = celdaKepler(a);
                            <!-- [CSU.25] Si el cajero contó algo, su aviso lleva directo a sus conteos (antes: abrir
                                 el corte y bajar a buscarlos). Las teclas no suben a la fila: Espacio la seleccionaría
                                 y le quitaría el clic al botón. -->
                            <td role="cell" data-label="Cajero">@if (a.conteos_cajero.length) {
                                <button type="button" class="cs-ir" (click)="verConteos(c)" (keydown.enter)="$event.stopPropagation()" (keydown.space)="$event.stopPropagation()"
                                  [attr.aria-label]="'Ver lo que contó el cajero en ' + c.documento + ': ' + cj.label"><p-tag [value]="cj.label" [severity]="cj.sev" styleClass="cs-tag" /><i class="pi pi-chevron-right" aria-hidden="true"></i></button>
                              } @else { <p-tag [value]="cj.label" [severity]="cj.sev" styleClass="cs-tag" /> }
                              @if (a.declaracion_cajero?.concuerda_con_kepler === false) { <p-tag value="no concuerda con Kepler" severity="secondary" styleClass="cs-tag" /> }</td>
                            <td role="cell" data-label="Billetes y monedas"><p-tag [value]="kp.label" [severity]="kp.sev" styleClass="cs-tag" /></td>
                          } @else {
                            <td role="cell" class="muted" data-label="Cajero">—</td><td role="cell" class="muted" data-label="Billetes y monedas">—</td>
                          }
                        </tr>
                      }
                    </tbody>
                  </table>
                  <!-- [CSU.20] Lo que el cajero conto ese dia y no quedo en ningun corte: conteos «sin caja»
                       (constancias: fondo, deposito, la venta de la vispera) y retiros o cierres sin turno.
                       Se ven para que no se pierdan; no suman ni restan a ningun corte. -->
                  @if (d.fuera.length) {
                    <p class="cs-sub cs-pad-fuera">Contado fuera de un corte · {{ money(sumaFuera(d.fuera)) }} · no suma ni resta a los cortes</p>
                    <table class="cs-cortes">
                      <thead><tr><th class="cs-togcol"><span class="sr-only">Ver lo que contó</span></th><th>Hora</th><th>Qué</th><th>Caja</th><th class="ta-r">Importe</th><th>Por qué no está en un corte</th><th>Quién contó</th></tr></thead>
                      <tbody>
                        @for (x of d.fuera; track $index) {
                          @let abierto = !!x.id && conteosAbiertos().has(x.id);
                          <tr><td role="cell" class="cs-togcol" data-label="Ver"><button type="button" class="cs-tog" [disabled]="!x.id" (click)="toggleConteo(x.id)"
                                [attr.aria-expanded]="abierto" [attr.aria-controls]="'cs-ct-' + x.id"
                                [attr.aria-label]="(abierto ? 'Ocultar' : 'Ver') + ' lo que contó a las ' + x.hora.slice(0, 5)"><i class="pi" [class.pi-chevron-right]="!abierto" [class.pi-chevron-down]="abierto" aria-hidden="true"></i></button></td>
                            <td role="cell" class="cs-mono" data-label="Hora">{{ x.hora.slice(0, 5) }}</td><td role="cell" data-label="Qué">{{ fueraTipo(x) }}</td><td role="cell" class="cs-mono" data-label="Caja">{{ x.caja ?? '—' }}</td>
                            <td role="cell" class="ta-r num" data-label="Importe">{{ money(x.total) }}</td><td role="cell" data-label="Por qué no está en un corte">{{ fueraPorQue(x) }}</td><td role="cell" data-label="Quién contó">{{ x.usuario ?? '—' }}</td></tr>
                          @if (abierto) {
                            <tr class="cs-ct-fila"><td></td><td colspan="6" [id]="'cs-ct-' + x.id">
                              <ng-container *ngTemplateOutlet="detConteo; context: { $implicit: x, medios: [], ligado: null }" />
                            </td></tr>
                          }
                        }
                      </tbody>
                    </table>
                  }
                </td></tr>
              </ng-template>
              <ng-template #emptymessage><tr><td [attr.colspan]="selSuc() ? 7 : 8">
                @if (q().trim()) {
                  <div class="cs-empty"><i class="pi pi-search" aria-hidden="true"></i><span>Ningún corte coincide con «{{ q().trim() }}»{{ filtro() !== 'todos' ? ' entre «' + etiquetaFiltro(filtro(), plazo()) + '»' : '' }}.</span>
                    @if (enOtrasSucursales()) { <span>Hay {{ enOtrasSucursales() }} en otras sucursales · <button type="button" class="cs-link" (click)="pickSuc(null)">ver todas</button></span> }
                    <button type="button" class="cs-link" (click)="limpiarBusqueda()">Limpiar búsqueda</button></div>
                } @else {
                  <div class="cs-empty"><i class="pi pi-check-circle" aria-hidden="true"></i><span>{{ filtro() !== 'todos' ? 'Ningún corte en «' + etiquetaFiltro(filtro(), plazo()) + '».' : 'Sin cortes en el periodo.' }}</span>
                    @if (filtro() !== 'todos') { <button type="button" class="cs-link" (click)="ponerFiltro('todos', false)">Quitar filtro</button> }</div>
                }
              </td></tr></ng-template>
            </p-table>
          </section>

          <!-- [CSU.21] El detalle aparece al elegir un corte; mientras, la lista toma todo el ancho.
               [CSU.31] CSU.UI.3: en pantallas angostas el detalle se abría DEBAJO de toda la lista, fuera de la vista
               (medido: en el celular su borde quedaba detrás de la barra inferior). Ahí se abre en un panel lateral. -->
          @if (selCorte() && !angosta()) {
          <section class="cs-block cs-detail" aria-labelledby="cs-h-det" aria-live="polite">
            @if (selCorte(); as c) {
              @let et = etiquetaDelCorte(c);
              <div class="cs-bh"><h2 id="cs-h-det">{{ c.documento }} · {{ c.referencia }}</h2><p-tag [value]="et.label" [severity]="et.sev" styleClass="cs-tag" /></div>
              <ng-container *ngTemplateOutlet="detalleCorte; context: { $implicit: c }" />
            }
          </section>
          }
        </div>

        <app-side-peek [open]="angosta() && !!selCorte()" (openChange)="$event ? null : selCorte.set(null)" [width]="680"
                       [title]="selCorte() ? selCorte()!.documento + ' · ' + selCorte()!.referencia : 'Corte'"
                       [subtitle]="selCorte() ? etiquetaDelCorte(selCorte()!).label : null">
          @if (angosta() && selCorte(); as c) { <ng-container *ngTemplateOutlet="detalleCorte; context: { $implicit: c }" /> }
        </app-side-peek>

        <!-- [CSU.31] El detalle de un corte, en tres pasos: la venta del turno, el arqueo (CSU.16–25, como estaba) y los
             cobros con a dónde llegó cada uno. Una sola plantilla para el panel de al lado y el lateral. -->
        <ng-template #detalleCorte let-c>
              <p class="cs-hint cs-pad">{{ c.sucursal | sucursal }} · {{ dmy(c.fecha) }}@if (c.arqueo?.cajero) { · cerró {{ c.arqueo?.cajero_nombre || c.arqueo?.cajero }} }</p>
              <!-- La respuesta del corte, primero (Q.1). -->
              @if (fraseCorte(c); as fr) { <p class="cs-frase-corte">{{ fr }}</p> }
              @if (c.venta_sin_forma_de_pago != null) { <p class="cs-frase-corte">El turno vendió <b>{{ money(c.venta_sin_forma_de_pago) }}</b> más de lo que la caja registró cobrado: venta sin forma de pago (paso 1).</p> }

              <div class="cs-step">
                <h3><span class="cs-n">1</span> La venta del turno</h3>
                @if (c.venta_turno; as vt) {
                  <div class="cs-row"><span>Tickets del turno ({{ vt.tickets }})</span><span class="num">{{ money(vt.total) }}</span></div>
                  @if (vt.devoluciones > 0.005) { <div class="cs-row"><span>Devoluciones pagadas en la caja</span><span class="num">−{{ money(vt.devoluciones) }}</span></div> }
                  <div class="cs-row cs-tot"><span>@if (vt.igual_al_corte) { Igual al corte } @else { Neto del turno <span class="muted">(el corte dice {{ money(c.monto) }})</span> }</span><span class="num">{{ money(vt.neto) }}</span></div>
                  @if (c.venta_sin_forma_de_pago != null && c.arqueo) {
                    <div class="cs-row"><span>Lo que la caja registró cobrado <span class="muted">(lo que Kepler esperaba, neto de devoluciones)</span></span><span class="num">{{ money(c.arqueo.esperado_neto) }}</span></div>
                    <div class="cs-row cs-tot"><span>Venta sin forma de pago</span><span class="num">{{ money(c.venta_sin_forma_de_pago) }}</span></div>
                    <p class="cs-hint">Tickets que la caja cerró sin registrar cómo se pagaron. Si su dinero llegó, se ve en el paso 3.</p>
                  }
                } @else if (ventaMedida()) {
                  <p class="cs-hint">No se pudo ligar la venta de este turno: el corte no trae caja-turno, Kepler no tiene sus tickets, o el mismo turno se repite en otro corte cercano.</p>
                } @else {
                  <p class="cs-hint">La venta del turno <b>no se pudo medir</b> en esta consulta.</p>
                }
                <!-- [CSU.31] Las facturas de contado del turno (CSU.30), aunque se hayan facturado otro día. Se piden al abrir el corte. -->
                <p class="cs-sub">Facturas de contado del turno</p>
                @if (facturasTurno(); as ft) {
                  @if (ft.estado === 'sin_turno') {
                    <p class="cs-hint">No se pueden buscar: sin la venta del turno ligada (arriba dice por qué), no hay tickets contra los cuales casar sus facturas.</p>
                  } @else if (ft.estado === 'cargando') {
                    <p class="cs-hint" aria-busy="true">Buscando las facturas del turno…</p>
                  } @else if (ft.estado === 'error') {
                    <p class="cs-hint">No se pudieron traer las facturas del turno. <button type="button" class="cs-link" (click)="pedirFacturas(c, true)">Reintentar</button></p>
                  } @else if (!ft.facturas.length) {
                    <p class="cs-hint">Ningún ticket de este turno se facturó.</p>
                  } @else {
                    <div class="dt-scope"><table class="cs-mini cs-facturas dt-stack">
                      <thead><tr><th scope="col">Factura</th><th scope="col">Ticket</th><th scope="col">Cliente</th><th scope="col" class="ta-r">Monto</th><th scope="col">Nota de crédito</th></tr></thead>
                      <tbody>
                        @for (f of ft.facturas; track f.tipo + '-' + f.folio) {
                          <tr><td role="cell" data-label="Factura"><span class="cs-mono">{{ f.folio }}</span><span class="cs-sub-celda">{{ f.tipo_nombre ?? ('Tipo ' + f.tipo) }}@if (f.fecha !== c.fecha) { · facturada el {{ dmy(f.fecha) }} }</span></td>
                            <td role="cell" class="cs-mono" data-label="Ticket">{{ f.ticket ? f.ticket.caja + '-' + sinCerosFolio(f.ticket.folio) : '—' }}</td>
                            <td role="cell" data-label="Cliente">{{ f.cliente ?? '—' }}</td>
                            <td role="cell" class="ta-r num" data-label="Monto">{{ money(f.total) }}</td>
                            <td role="cell" data-label="Nota de crédito">@for (n of f.notas; track n.doc_prefix + n.folio) { <span class="cs-nota-cr">{{ n.doc_prefix }}-{{ n.folio }} <span class="num">−{{ money(n.monto) }}</span>@if (n.motivo) {<span class="muted"> «{{ n.motivo }}»</span>}</span> } @empty { <span class="muted">—</span> }</td></tr>
                        }
                      </tbody>
                    </table></div>
                    <p class="cs-hint">Una factura de contado es un ticket que ya está en la venta del turno: no suma aparte.</p>
                  }
                }
              </div>

              <div class="cs-step">
                <h3><span class="cs-n">2</span> Corte contra el arqueo del turno</h3>
                @if (c.arqueo; as a) {
                  @let d = a.declaracion_cajero;
                  <table class="cs-mini">
                    <!-- [CSU.16] Esperado lo pone el SISTEMA; Declarado, el CAJERO (su arqueo ciego en
                         /tienda/arqueo). Hasta CSU.16 la columna de en medio era c25: otro numero de
                         Kepler, identico al esperado en el 85.1% de los cortes. Se imprimia un solo tipo
                         dos veces. La de la derecha es el desglose que Kepler guarda (solo efectivo). -->
                    <thead><tr><th scope="col"><span class="sr-only">Concepto</span></th><th scope="col" class="ta-r">Esperado<span class="cs-th-de">sistema</span></th><th scope="col" class="ta-r">Declarado<span class="cs-th-de">cajero</span></th><th scope="col" class="ta-r">Desglose<span class="cs-th-de">Kepler</span></th></tr></thead>
                    <tbody>
                      <!-- [CSU.18] Con devoluciones pagadas del cajon, el esperado se pinta NETO: las dos
                           diferencias de abajo son contra el neto, y el bruto contra el desglose se leia
                           como un faltante que no existe (Madero 1-48: $221.23 = sus dos devoluciones). -->
                      <tr><td>Efectivo@if (c.devoluciones_total > 0) { <span class="muted"> neto de devoluciones</span> }</td><td class="ta-r num">{{ money(a.efectivo_esperado - c.devoluciones_total) }}</td><td class="ta-r num cs-strong">{{ d?.efectivo == null ? '—' : money(d.efectivo) }}</td><td class="ta-r num">{{ a.conteo_fisico === null ? '—' : money(a.conteo_fisico) }}</td></tr>
                      <!-- [CSU.24] El efectivo, parte por parte: dónde se separan el cajero y Kepler. Suman el
                           renglón de arriba de cada lado. El sistema no espera por parte: esa celda va vacía. -->
                      @for (p of partesEfectivo(); track p.etiqueta) {
                        <tr class="cs-parte" [class.cs-parte-dif]="p.difiere"><td>{{ p.etiqueta }}@if (p.difiere) { <span class="sr-only"> (difieren)</span> }</td><td></td>
                          <td class="ta-r num">{{ p.cajero === null ? '—' : money(p.cajero) }}</td>
                          <td class="ta-r num">@if (p.nota) { <span class="muted">{{ p.nota }}</span> } @else { {{ p.kepler === null ? '—' : money(p.kepler) }} }</td></tr>
                      }
                      <!-- [CSU.19] Tarjeta y transferencia en UN renglon: el cierre del cajero las trae juntas
                           (112 de 126 en octubre) y Kepler tambien (c45 «otros»). Separadas se leian como
                           un sobrante de tarjeta y una transferencia sin declarar. -->
                      <tr><td>Tarjeta y transferencia</td><td class="ta-r num">{{ money(a.tarjeta_esperado + a.transfer_esperado) }}</td><td class="ta-r num">{{ d?.electronico == null ? '—' : money(d.electronico) }}</td><td class="ta-r num" [class.muted]="a.electronico_kepler === null">{{ a.electronico_kepler === null ? '—' : money(a.electronico_kepler) }}</td></tr>
                      <tr class="cs-tot"><td>Total</td><td class="ta-r num">{{ money(a.esperado_neto) }}</td><td class="ta-r num">{{ d?.total == null ? '—' : money(d.total) }}</td><td class="ta-r num" [class.muted]="a.conteo_fisico === null || a.electronico_kepler === null">{{ a.conteo_fisico === null || a.electronico_kepler === null ? '—' : money(a.conteo_fisico + a.electronico_kepler) }}</td></tr>
                    </tbody>
                  </table>
                  @if (lecturaEfectivo(); as le) { <p class="cs-hint cs-donde">{{ le }}</p> }
                  @if (c.devoluciones.length) {
                    <p class="cs-sub">Devoluciones pagadas en esta caja</p>
                    @for (v of c.devoluciones; track v.doc_prefix + v.folio) {
                      <div class="cs-row cs-dev">
                        <span>{{ v.doc_prefix }}-{{ v.folio }}@if (v.cliente) { · {{ v.cliente }} }@if (v.motivo) { <span class="muted cs-motivo"> · {{ v.motivo }}</span> }</span>
                        <span class="num">-{{ money(v.monto) }}</span>
                      </div>
                    }
                    <div class="cs-row cs-tot"><span>Kepler esperaba {{ money(a.esperado_total) }} bruto; menos devoluciones, el esperado de la tabla</span><span class="num">{{ money(a.esperado_neto) }}</span></div>
                  }
                  <div class="cs-row"><span>Monto del corte en Kepler</span><span class="num cs-strong">{{ money(c.monto) }}</span></div>
                  <div class="cs-row"><span>{{ cuadreLabel(c) }}</span><span class="num" [class.cs-bad]="c.cuadre !== 'cuadra'">{{ c.diferencia === null ? '—' : money(c.diferencia) }}</span></div>
                  <!-- [CSU.16] Los testigos independientes del veredicto: primero el cajero, luego el
                       desglose de Kepler. Van DESPUES del veredicto a proposito: lo corrigen, no lo
                       reemplazan. Las dos diferencias son contra el mismo esperado (neto de devoluciones). -->
                  @if (d) {
                    <div class="cs-row cs-fis">
                      <span>Declarado por el cajero menos esperado <span class="muted">(efectivo)</span></span>
                      <span class="num" [class.cs-bad]="d.diferencia !== null && abs(d.diferencia) > 1">{{ d.diferencia === null ? '—' : signo(d.diferencia) }}</span>
                    </div>
                    <p class="cs-hint">{{ composicionCajero(d) }}</p>
                    @if (d.efectivo === null) {
                      <p class="cs-hint cs-nota">Contó {{ d.retiros_n }} retiro(s) pero <b>no capturó el cierre</b>: no hay declaración completa del efectivo contra la cual medir.</p>
                    }
                    @if (d.concuerda_con_kepler === false) {
                      <p class="cs-hint cs-nota"><b>El cajero y el desglose de Kepler no concuerdan</b> por más de $50: uno de los dos conteos está mal, o este conteo no es de este turno.</p>
                    }
                  }
                  @if (a.conteo_fisico !== null) {
                    <div class="cs-row" [class.cs-fis]="!d">
                      <span>Desglose de Kepler menos esperado <span class="muted">(billetes + monedas + retirado)</span></span>
                      <span class="num" [class.cs-bad]="a.fisico_diferencia !== null && abs(a.fisico_diferencia) > 1 && !creditosExplican(a)">{{ a.fisico_diferencia === null ? '—' : signo(a.fisico_diferencia) }}</span>
                    </div>
                    <!-- [CSU.19] El desglose de Kepler solo cuenta billetes y monedas: los creditos y cheques del
                         cajon no entran. Con el cajero se puede separar; sin el, se advierte. -->
                    @if (creditosExplican(a)) {
                      <p class="cs-hint">No es faltante: son los <b>{{ money(d!.documentos) }} en créditos y cheques</b> que declaró el cajero, que Kepler no cuenta en su desglose. Con ellos, el desglose da {{ signo(d!.fisico_con_documentos!) }}.</p>
                    } @else if (!d && a.fisico_diferencia !== null && a.fisico_diferencia <= -1) {
                      <p class="cs-hint">El desglose de Kepler sólo cuenta billetes y monedas: si en el cajón había <b>créditos o cheques</b>, aparecen aquí como faltante. Sin el arqueo del cajero no se pueden separar.</p>
                    }
                  } @else {
                    <p class="cs-hint">Kepler <b>no trae el desglose por denominación</b> de este corte.</p>
                  }
                  @if (!d) {
                    <p class="cs-hint cs-nota">
                      @if (a.conteos_cajero_sin_ligar) {
                        <b>Sin declaración del cajero para este turno.</b> Ese día se capturaron {{ a.conteos_cajero_sin_ligar }} conteo(s) en esta caja que no se pudieron ligar a ningún turno (su folio apunta a otro turno, o no hay turno a esa hora): no se usan.
                      } @else {
                        <b>El cajero no hizo arqueo ciego de este turno.</b>
                      }
                      @if (a.arqueo_declarado) {
                        Kepler registró como contado lo mismo que esperaba, así que «{{ cuadreLabel(c) }}» compara a Kepler contra sí mismo@if (pctContadoIgual(); as p) { (pasa en el {{ p }} de los cortes del periodo)}.
                      }
                    </p>
                  }
                  @if (cuadraPorBruto(c, a)) {
                    <p class="cs-hint cs-nota">El corte salió por lo esperado <b>sin restar</b> la devolución: Kepler no la descontó en este corte. Cuadra contra el esperado bruto ({{ money(a.esperado_total) }}).</p>
                  }
                  <!-- [CSU.23] La evidencia de «Declarado · cajero»: cada retiro y el cierre que contó en este
                       turno, con sus piezas. Antes sólo llegaba la suma; para ver un retiro había que ir a
                       /tienda/arqueo, que Finanzas no tiene (SM.47). -->
                  @if (a.conteos_cajero.length) {
                    <p class="cs-sub" id="cs-conteos-t" tabindex="-1">Lo que contó el cajero · {{ a.conteos_cajero.length }} conteo(s)</p>
                    <ul class="cs-conteos">
                      @for (k of a.conteos_cajero; track k.id; let i = $index) {
                        @let abierto = conteosAbiertos().has(k.id);
                        <li>
                          <button type="button" class="cs-conteo" (click)="toggleConteo(k.id)" [attr.aria-expanded]="abierto" [attr.aria-controls]="'cs-ct-' + k.id">
                            <i class="pi" [class.pi-chevron-right]="!abierto" [class.pi-chevron-down]="abierto" aria-hidden="true"></i>
                            <span class="cs-mono">{{ k.hora }}</span>
                            <span class="cs-conteo-que">{{ etiquetaConteo(a.conteos_cajero, i) }}@if (k.usuario) { <span class="muted"> · {{ k.usuario }}</span> }</span>
                            <span class="num">{{ money(k.total) }}</span>
                          </button>
                          @if (abierto) {
                            <div class="cs-ct-det" [id]="'cs-ct-' + k.id">
                              <ng-container *ngTemplateOutlet="detConteo; context: { $implicit: k, medios: k.medios, ligado: k.ligado }" />
                            </div>
                          }
                        </li>
                      }
                    </ul>
                  }
                } @else {
                  <p class="cs-hint">No se encontró el arqueo del turno {{ c.referencia }}. El cuadre queda <b>sin medir</b>; no es lo mismo que cuadrar.</p>
                }
              </div>

              <div class="cs-step">
                <h3><span class="cs-n">3</span> Cobros aplicados en Kepler y a dónde llegaron</h3>
                @for (b of c.cobros; track b.doc_prefix + b.folio) {
                  <div class="cs-row cs-row-cobro"><span>{{ b.doc_prefix }}-{{ b.folio }} · {{ b.forma_pago || 'sin forma' }}@if (b.fecha) { · {{ dmy(b.fecha) }} }@if (b.concepto) { <span class="muted"> · {{ b.concepto }}</span> }
                    <span class="cs-dep" [class.muted]="b.medio_cobro !== 'banco'"><i class="pi {{ depositoIcon(b) }}" aria-hidden="true"></i>{{ depositoLabel(b) }}</span></span><span class="num">{{ money(b.monto) }}</span></div>
                  <!-- [CSU.31] Dónde llegó este depósito: el renglón del banco o la entrada de Caja General son el testigo
                       (la conciliación de Bancos, CSU.26), no la cuenta que dice Kepler. -->
                  @let ll = llegadaCobro(b);
                  <div class="cs-llega" [class.cs-llega-alerta]="ll.alerta">
                    <span class="cs-llega-t"><i class="pi" [class.pi-check]="!ll.alerta && (b.llegada?.estado === 'en_banco' || b.llegada?.estado === 'en_caja_general')" [class.pi-exclamation-circle]="ll.alerta" [class.pi-clock]="b.llegada?.estado === 'banco_sin_libro'" aria-hidden="true"></i>{{ ll.titulo }}</span>
                    @for (r of b.llegada?.renglones ?? []; track $index) {
                      <span class="cs-llega-r">{{ r.cuenta }} · {{ dmy(r.fecha) }} · {{ money(r.monto) }}@if (r.concepto) { · «{{ r.concepto }}» }@if (abs(r.monto - b.monto) >= 0.01 && (b.llegada?.renglones?.length ?? 0) === 1) { <span class="muted"> · un abono que cubre este y otros depósitos</span> }</span>
                    }
                    @for (x of b.llegada?.caja_general ?? []; track x.entrada) {
                      <span class="cs-llega-r">{{ x.entrada }} · {{ dmy(x.fecha) }} · {{ money(x.monto) }} → @if (x.corte) { corte {{ x.corte }} } @else { <span class="muted">sin corte de Caja General todavía</span> }</span>
                    }
                  </div>
                } @empty {
                  <p class="cs-hint">Ningún cobro aplicado a este corte.</p>
                }
                @if (c.llegada; as l) {
                  <div class="cs-row cs-tot"><span>Llegó, de lo aplicado al corte</span><span class="num">{{ money(l.llego) }} de {{ money(aplicadoDe(c)) }}</span></div>
                }
                <div class="cs-row cs-tot"><span>Saldo del corte</span><span class="num" [class.cs-bad]="c.saldo > 0.005">{{ money(c.saldo) }}</span></div>
                <!-- [CSU.13] Cancelados en Kepler: se VEN, marcados, y no entran a la cuenta de arriba. -->
                @if (c.cobros_cancelados.length) {
                  <div class="cs-cancelados" role="group" aria-label="Cobros cancelados en Kepler, no suman">
                    @for (x of c.cobros_cancelados; track x.doc_prefix + x.folio) {
                      <div class="cs-row cs-cancelado"><span>{{ x.doc_prefix }}-{{ x.folio }}@if (x.fecha) { · {{ dmy(x.fecha) }} }@if (x.concepto) { <span class="muted"> · {{ x.concepto }}</span> }
                        <p-tag value="Cancelado en Kepler — no suma" severity="secondary" styleClass="cs-tag" /></span><span class="num cs-tachado">{{ money(x.monto) }}</span></div>
                    }
                  </div>
                }
              </div>

        </ng-template>
      }
    </div>

    <!-- [CSU.23] Lo que contó un conteo: sus piezas, lo que declaró aparte (sólo el cierre) y su nota.
         Lo usan el detalle del corte y los conteos fuera de corte; una sola forma de leer un conteo. -->
    <ng-template #detConteo let-k let-medios="medios" let-ligado="ligado">
      @if (k.piezas.length) {
        <table class="cs-mini cs-piezas">
          <thead><tr><th>Pieza</th><th class="ta-r">Cuántas</th><th class="ta-r">Importe</th></tr></thead>
          <tbody>
            @for (p of k.piezas; track p.denom_key) {
              <tr><td>{{ p.etiqueta }}</td><td class="ta-r num">{{ p.piezas }}</td><td class="ta-r num">{{ money(p.importe) }}</td></tr>
            }
            <tr class="cs-tot"><td>Suma de las piezas</td><td></td><td class="ta-r num">{{ money(k.total + (k.piezas_diferencia ?? 0)) }}</td></tr>
          </tbody>
        </table>
        @if (k.piezas_diferencia !== null && abs(k.piezas_diferencia) >= 0.01) {
          <p class="cs-hint cs-nota"><b>Las piezas no dan el total capturado</b>: suman {{ money(k.total + k.piezas_diferencia) }} y el conteo dice {{ money(k.total) }} ({{ signo(k.piezas_diferencia) }}).</p>
        }
      } @else if (abs(k.total) < 0.005) {
        <!-- Medido (30 días a 2026-11-20): los 26 conteos sin piezas son de $0, el cajón vacío. -->
        <p class="cs-hint">Contó <b>$0.00</b>: el cajón estaba vacío.</p>
      } @else {
        <p class="cs-hint">No guardó las piezas: sólo el total de {{ money(k.total) }}.</p>
      }
      @if (medios.length) {
        <p class="cs-sub">Declaró además</p>
        @for (m of medios; track m.clave) {
          <div class="cs-row"><span>{{ m.etiqueta }}</span><span class="num">{{ money(m.monto) }}</span></div>
        }
      }
      @if (k.nota) { <p class="cs-hint cs-nota">Nota de quien contó: «{{ k.nota }}»</p> }
      @if (ligado === 'hora') { <p class="cs-hint">Ligado a este turno por caja y hora: la captura no trae el folio del turno.</p> }
    </ng-template>
  `,
  styles: [FINANZAS_SHARED_STYLES, `
    :host { display:block; }
    .surf-page-head { display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap; }
    .cs-actions { display:flex; gap:.5rem; align-items:center; }
    .cs-filters { display:flex; flex-wrap:wrap; gap:.8rem; align-items:flex-end; margin:.4rem 0 .6rem; }
    .cs-field { display:flex; flex-direction:column; gap:.25rem; }
    .cs-field label { font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); }
    /* [CSU.13] El buscador es el primer filtro y el más ancho: es por donde se entra a un corte. */
    .cs-buscar { flex:1 1 20rem; max-width:28rem; }
    .cs-buscar p-iconfield, .cs-q { width:100%; }
    /* [CSU.13] Cobro cancelado: se lee como «ya no cuenta» por el texto de la etiqueta y por el tachado,
       nunca sólo por el color (Alto Contraste de Windows). */
    .cs-cancelados { margin-top:var(--sp-2); padding-top:var(--sp-2); border-top:1px dashed var(--border-color); }
    .cs-cancelado { color:var(--text-muted); }
    .cs-tachado { text-decoration:line-through; }
    .cs-kbd { font:inherit; font-family:var(--font-mono); font-size:var(--fs-micro); border:1px solid var(--border-color); border-radius:var(--r-sm); padding:0 var(--sp-1); margin-left:var(--sp-1); color:var(--text-muted); }
    :host ::ng-deep .cs-sel { min-width:11rem; }
    .cs-periodo { margin:.2rem 0 .4rem; font-size:var(--fs-xs); color:var(--text-muted); }
    .cs-note { display:flex; gap:.5rem; align-items:flex-start; padding:.6rem .8rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); font-size:var(--fs-sm); }
    .cs-note .pi { color:var(--text-muted); margin-top:.15rem; }
    .cs-note-bad { border-left:3px solid var(--bad-fg); }
    .cs-note-bad .pi { color:var(--bad-fg); }
    app-metric-strip { display:block; margin:.6rem 0; }
    .cs-block { border:1px solid var(--border-color); border-radius:var(--r-md); background:var(--card-bg); min-width:0; margin-bottom:1rem; }
    .cs-bh { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:.5rem; padding:.6rem .85rem; border-bottom:1px solid var(--border-color); }
    .cs-bh h2 { font-size:var(--fs-h3); font-weight:700; margin:0; }
    .cs-hint { font-size:var(--fs-xs); color:var(--text-muted); margin:0; }
    .cs-pad { padding:.5rem .85rem 0; }
    .cs-link { background:none; border:0; padding:0; color:var(--action); cursor:pointer; font:inherit; text-decoration:underline; }
    .cs-split { display:grid; grid-template-columns:minmax(0,1.6fr) minmax(0,1fr); gap:1rem; align-items:start; }
    .cs-split.cs-split-solo { grid-template-columns:minmax(0,1fr); }
    @media (max-width:68.75rem) { .cs-split { grid-template-columns:minmax(0,1fr); } }
    .cs-detail { position:sticky; top:.5rem; }
    .cs-step { padding:.7rem .85rem; border-top:1px solid var(--border-color); }
    .cs-step:first-of-type { border-top:0; }
    .cs-step h3 { display:flex; align-items:center; gap:.45rem; font-size:var(--fs-sm); font-weight:700; margin:0 0 .45rem; }
    .cs-n { display:inline-grid; place-items:center; width:1.3rem; height:1.3rem; border-radius:50%; background:var(--hover-bg); font-size:var(--fs-micro); }
    .cs-row { display:flex; justify-content:space-between; gap:.8rem; font-size:var(--fs-sm); padding:.22rem 0; border-bottom:1px dashed var(--border-color); }
    .cs-row span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    /* [CSU.8] La cuenta del deposito, en su propio renglon: es el dato que cierra el recorrido
       del dinero y enterrado en la linea del folio no se encuentra. */
    .cs-dep { display:flex; align-items:center; gap:.3rem; font-size:var(--fs-xs); margin-top:.1rem; }
    .cs-dep i { font-size:var(--fs-nano); }
    .cs-tot { font-weight:600; border-bottom:0; }
    .cs-mini { width:100%; border-collapse:collapse; font-size:var(--fs-sm); margin-bottom:.4rem; }
    .cs-mini th { font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; padding:.2rem 0; text-align:left; }
    .cs-mini td { padding:.2rem 0; border-bottom:1px dashed var(--border-color); }
    /* [CSU.24] Las partes del efectivo: un nivel abajo (sangría y texto secundario); la que difiere, en peso, no en color. */
    .cs-mini .cs-parte td { font-size:var(--fs-xs); color:var(--text-muted); border-bottom-style:dotted; }
    .cs-mini .cs-parte td:first-child { padding-left:1rem; }
    .cs-mini .cs-parte-dif td { color:var(--text-main); font-weight:var(--fw-medium); }
    .cs-mini .cs-parte-dif td:first-child::before { content:'≠'; display:inline-block; width:1rem; margin-left:-1rem; }
    .cs-donde { margin:.1rem 0 .5rem; font-size:var(--fs-sm); color:var(--text-main); }
    .cs-th-de { display:block; text-transform:none; letter-spacing:0; font-weight:400; color:var(--text-faint); }
    .cs-mini tr.cs-tot td { border-bottom:0; }
    .cs-pad-fuera { margin-top:var(--sp-3); }
    .cs-sub { margin:.5rem 0 .15rem; font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; }
    .cs-dev span:first-child { white-space:normal; }
    .cs-motivo { font-size:var(--fs-xs); }
    .cs-nota { margin-top:.35rem; }
    /* [CSU.9] El conteo por denominacion: el unico efectivo que alguien conto de verdad. */
    .cs-fis { font-weight:600; }
    /* [CSU.15] La fila de día: el renglón que antes se sumaba a mano. El grupo se forma con
       espaciado y con el peso del total, no con cajas ni con zebra. */
    .cs-togcol { width:2.25rem; }
    /* [CSU.31] CSU.UI.9: 28 px al dedo (20×28 en el celular) → 44 con puntero grueso, vía --tap-min. */
    .cs-tog { display:inline-grid; place-items:center; width:max(1.75rem, var(--tap-min)); height:max(1.75rem, var(--tap-min)); flex:0 0 auto; padding:0; border:0; border-radius:var(--r-sm); background:none; color:var(--text-muted); cursor:pointer; }
    .cs-tog:hover:not(:disabled) { background:var(--overlay-hover); color:var(--text-main); }
    .cs-tog:disabled { cursor:default; opacity:.45; }
    .cs-tog .pi { font-size:var(--fs-xs); }
    .cs-dia-abierta > td { font-weight:600; }
    /* El detalle cuelga del día: sin borde propio, sangrado y con un filete a la izquierda que
       dice de quién es. El borde de 1px es lo que lleva la profundidad en dark. */
    .cs-dia-det > td { padding:0 0 var(--sp-2) 2.25rem; background:var(--hover-bg); }
    .cs-cortes { width:100%; border-collapse:collapse; font-size:var(--fs-sm); border-left:2px solid var(--border-color); }
    .cs-cortes th { font-size:var(--fs-micro); letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; text-align:left; padding:var(--sp-2) var(--sp-2) var(--sp-1); }
    .cs-cortes th.ta-r { text-align:right; }
    .cs-cortes td { padding:var(--sp-1) var(--sp-2); border-top:1px solid var(--border-color); }
    .cs-corte { cursor:pointer; }
    .cs-corte:hover { background:var(--overlay-hover); }
    .cs-corte:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-2px; }
    .cs-corte-sel { background:var(--overlay-selected); }
    .ta-r { text-align:right !important; }
    .num, .cs-mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; white-space:nowrap; }
    .cs-strong { font-weight:600; }
    .cs-bad { color:var(--bad-fg); }
    .muted { color:var(--text-muted); }
    :host ::ng-deep .cs-tag { font-size:var(--fs-nano); margin-right:.25rem; }
    .cs-errbox { display:flex; align-items:center; gap:.6rem; padding:.7rem .85rem; margin:.2rem 0 .6rem; border:1px solid var(--border-color); border-left:3px solid var(--bad-fg); border-radius:var(--r-md); background:var(--card-bg); }
    .cs-errbox .pi { color:var(--bad-fg); } .cs-errbox-txt { flex:1; font-size:var(--fs-sm); }
    .cs-empty { display:flex; flex-direction:column; align-items:center; gap:var(--sp-2); padding:var(--sp-6); text-align:center; color:var(--text-muted); }
    .cs-empty .pi { font-size:var(--fs-lg); }
    /* [CSU.23] Los conteos del cajero: un renglón por conteo que se abre en sus piezas. */
    .cs-conteos { list-style:none; margin:0; padding:0; }
    .cs-conteo { display:grid; grid-template-columns:auto auto minmax(0,1fr) auto; align-items:center; gap:.5rem; width:100%; padding:.3rem .15rem; border:0; border-bottom:1px dashed var(--border-color); background:none; color:inherit; font:inherit; font-size:var(--fs-sm); text-align:left; cursor:pointer; }
    .cs-conteo:hover { background:var(--overlay-hover); }
    .cs-conteo:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-2px; }
    .cs-ir { display:inline-flex; align-items:center; gap:.1rem; min-height:max(1.5rem, var(--tap-min)); padding:0 .15rem 0 0; border:0; background:none; color:var(--text-muted); font:inherit; cursor:pointer; border-radius:var(--radius-sm); }
    .cs-conteo { min-height:var(--tap-min); }
    .cs-ir .pi { font-size:var(--fs-nano); }
    .cs-ir:hover .pi { color:var(--text-main); }
    .cs-ir:focus-visible, #cs-conteos-t:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }
    .cs-conteo .pi { font-size:var(--fs-nano); color:var(--text-muted); }
    .cs-conteo-que { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cs-ct-det { padding:.35rem 0 .5rem 1.4rem; }
    .cs-ct-fila > td { border-top:0 !important; padding-top:0 !important; }
    .cs-piezas { max-width:22rem; }

    /* ── [CSU.31] ¿Llegó el dinero? ─────────────────────────────────────────────────────────────────────── */
    /* CSU.UI.6: los encabezados de las tablas iban a 16 px (más que las celdas, igual que el título de la sección)
       y con su sub-rótulo bajaban a tres renglones. Al tamaño de la celda o menos, un solo estilo. */
    /* Sin selector profundo (check:cascada): los <tr> de encabezado son de ESTA plantilla y llevan la clase. */
    .cs-thr > th { font-size:var(--fs-xs); line-height:1.25; }
    .cs-th-de { font-size:var(--fs-micro); }
    /* Primario: la respuesta del periodo. Más grande que las celdas, en el color del texto; los números que abren
       sus cortes son enlaces (subrayado), no color. */
    .cs-respuesta { margin:.1rem 0 .5rem; max-width:72rem; font-size:var(--fs-body); line-height:1.5; color:var(--text-main); }
    .cs-link-frase { font-weight:600; }
    .cs-link-on { text-decoration-thickness:2px; background:var(--overlay-selected); border-radius:var(--r-sm); }
    .cs-tap { min-height:var(--tap-min); }
    @media (pointer: coarse) {
      .cs-link { display:inline-flex; align-items:center; justify-content:center; min-height:var(--tap-min); min-width:var(--tap-min); }
    }
    .cs-sub-celda { display:block; font-size:var(--fs-xs); color:var(--text-muted); }
    .cs-frase-corte { margin:0; padding:.45rem .85rem 0; font-size:var(--fs-sm); line-height:1.45; color:var(--text-main); }
    .cs-row-cobro { border-bottom:0; padding-bottom:0; }
    /* Dónde llegó un depósito: un nivel abajo de su renglón. Lo que no tiene testigo va en peso y con su ícono,
       no en rojo (CSU.UI.7). */
    .cs-llega { display:flex; flex-direction:column; gap:.1rem; padding:.1rem 0 .4rem 1rem; font-size:var(--fs-xs); color:var(--text-muted); border-bottom:1px dashed var(--border-color); }
    .cs-llega-t { display:flex; align-items:center; gap:.35rem; color:var(--text-main); }
    .cs-llega-t .pi { font-size:var(--fs-nano); }
    .cs-llega-alerta .cs-llega-t { font-weight:600; }
    .cs-llega-r { overflow-wrap:anywhere; }
    /* Prueba visual (Fold): con el padding 0 de .cs-mini las columnas se pegaban («3-5168RICARDO», «MONTONOTA»). */
    .cs-facturas th, .cs-facturas td { vertical-align:top; padding-right:var(--sp-3); }
    .cs-facturas th:last-child, .cs-facturas td:last-child { padding-right:0; }
    /* CSU.UI.5, medido en el Fold (750 px): 8 columnas con --sp-2 por lado aún se desplazaban 15 px dentro de la tabla. */
    @media (max-width: 52rem) {
      .cs-cortes th, .cs-cortes td { padding-left:var(--sp-1); padding-right:var(--sp-1); }
    }
    .cs-nota-cr { display:block; }
  `],
})
export class FinanzasCortesSucursalesComponent implements OnInit {
  /** [NAV.7] La barra del apartado «Cortes y arqueos» del sidebar de Finanzas: la pintan todas sus páginas. */
  readonly apartadoTabs = CORTES_ARQUEOS_TABS;
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly base = `${environment.apiUrl}/finance/cortes-sucursales`;

  readonly skel = Array.from({ length: 8 });
  readonly money = money;
  readonly dmy = dmy;

  /** Los 12 meses hasta el actual; el default es el mes en curso. */
  readonly mesOpts: { label: string; value: string }[] = (() => {
    const out: { label: string; value: string }[] = [];
    const d = new Date();
    for (let i = 0; i < 12; i++) {
      const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push({ label: `${MESES[x.getMonth()]} ${x.getFullYear()}`, value: `${x.getFullYear()}-${pad(x.getMonth() + 1)}` });
    }
    return out;
  })();

  readonly mes = signal<string | null>(this.mesOpts[0].value);
  rangeDates: Date[] | null = null;
  /** `[CSU.31]` Lo que muestra la lista (reemplaza «Sólo con saldo»): una cifra, una frase o «Mostrar» lo ponen. */
  readonly filtro = signal<FiltroCortes>('todos');
  readonly etiquetaFiltro = etiquetaFiltro;
  readonly loading = signal(false);
  readonly err = signal<string | null>(null);
  readonly data = signal<CortesSucursalesResponse | null>(null);
  readonly selSuc = signal<CorteSucursalResumen | null>(null);

  /** `[CSU.14]` La tabla «Por sucursal»: todas, o sólo la elegida (las demás se ocultan para dar espacio). */
  readonly sucursalesVisibles = computed<CorteSucursalResumen[]>(() => {
    const d = this.data();
    const s = this.selSuc();
    if (!d) return [];
    return s ? d.sucursales.filter((x) => x.sucursal === s.sucursal) : d.sucursales;
  });
  readonly sucursalesOcultas = computed<number>(() => (this.data()?.sucursales.length ?? 0) - this.sucursalesVisibles().length);
  readonly selCorte = signal<CorteRow | null>(null);

  /** `[CSU.13]` Lo que escribió la persona en el buscador. */
  readonly q = signal('');
  private readonly buscador = viewChild<ElementRef<HTMLInputElement>>('buscador');

  /** `[CSU.31]` Los cortes de la sucursal elegida (o de todas): el universo del que salen la frase y «N de M». */
  readonly cortesEnAlcance = computed<CorteRow[]>(() => {
    const d = this.data();
    const s = this.selSuc();
    if (!d) return [];
    return s ? d.cortes.filter((c) => c.sucursal === s.sucursal) : d.cortes;
  });

  /** `[CSU.31]` Los días-sucursal con conteos fuera de corte (para «Mostrar: días con conteos fuera de corte»). */
  private readonly diasConFuera = computed<ReadonlySet<string>>(() => new Set((this.data()?.conteos_fuera_de_corte ?? []).map((x) => `${x.fecha}|${x.sucursal}`)));

  /** Los cortes antes de buscar: sucursal elegida + `[CSU.31]` el filtro (antes, «sólo con saldo»). */
  readonly cortesBase = computed<CorteRow[]>(() => {
    const f = this.filtro();
    const base = this.cortesEnAlcance();
    if (f === 'todos') return base;
    const hoy = hoyMx(), plazo = this.plazo(), fuera = this.diasConFuera();
    return base.filter((c) => cumpleFiltro(c, f, hoy, plazo, fuera));
  });

  /** `[CSU.31]` ¿Se midió la llegada y la venta del turno? `null` o ausente = no (una API anterior a CSU.29, o la consulta falló). */
  readonly llegadaMedida = computed(() => (this.data()?.llegada ?? null) !== null);
  readonly ventaMedida = computed(() => (this.data()?.venta_sin_forma_de_pago ?? null) !== null);

  /** `[CSU.31]` Cuántos cortes y cuánto suma el filtro puesto, sobre la sucursal elegida o todas. */
  readonly resumenFiltroActivo = computed(() => resumenDelFiltro(this.cortesEnAlcance(), this.filtro(), hoyMx(), this.plazo(), this.diasConFuera()));

  /** `[CSU.31]` Las opciones de «Mostrar», cada una con su número (el mismo que su cifra). */
  readonly opcionesFiltro = computed(() => {
    const cortes = this.cortesEnAlcance(), hoy = hoyMx(), plazo = this.plazo(), fuera = this.diasConFuera(), medida = this.llegadaMedida();
    return FILTROS_CORTES.map((f) => {
      const sinMedir = (FILTROS_DE_LLEGADA.has(f) && !medida) || (f === 'venta_sin_forma_de_pago' && !this.ventaMedida());
      const n = f === 'todos' ? cortes.length : resumenDelFiltro(cortes, f, hoy, plazo, fuera).cortes;
      return { value: f, label: `${etiquetaFiltro(f, plazo)} · ${sinMedir ? 'no se pudo medir' : n.toLocaleString('es-MX')}`, disabled: sinMedir };
    });
  });

  /** `[CSU.31]` La respuesta del periodo (ver `fraseDelPeriodo`). */
  readonly frase = computed<TrozoFrase[]>(() => {
    if (!this.data()) return [];
    return fraseDelPeriodo(this.cortesEnAlcance(), {
      hoy: hoyMx(), plazo: this.plazo(), llegadaMedida: this.llegadaMedida(), ventaMedida: this.ventaMedida(),
      donde: this.selSuc()?.sucursal_nombre ?? null, diasConFuera: this.diasConFuera(),
    });
  });

  /** `[CSU.31]` La tarjeta del indicador que está filtrando, si la hay. */
  readonly drillActivo = computed<string | null>(() => (['con_llegada', 'con_saldo', 'sin_cuadrar'] as string[]).includes(this.filtro()) ? this.filtro() : null);

  /**
   * `[CSU.31]` Poner un filtro. Desde un indicador (`deIndicador`) se ven TODAS las sucursales: los indicadores son del
   * periodo entero, y la lista tiene que llegar a su número (CSU.UI.2). Tocar el filtro puesto lo quita.
   */
  ponerFiltro(f: FiltroCortes | null | undefined, deIndicador: boolean): void {
    const nuevo: FiltroCortes = !f || (deIndicador && this.filtro() === f) ? 'todos' : f;
    if (deIndicador && nuevo !== 'todos') this.pickSuc(null);
    this.filtro.set(nuevo);
  }

  /** `[CSU.31]` Llevar algo al buscador (la fecha de un cobro fechado en el futuro). */
  buscar(texto: string): void {
    this.q.set(texto);
    this.buscador()?.nativeElement.focus();
  }

  /**
   * `[CSU.13]` La lista que se ve. Se filtra en el cliente porque llega COMPLETA (el periodo entero, sin
   * paginar en el servidor): `filtrarPorBusqueda` exige cada palabra, en cualquier orden y en cualquier
   * campo, sin acentos — la misma semántica que `applySmartSearch` del servidor.
   */
  readonly cortes = computed<CorteRow[]>(() => filtrarPorBusqueda(this.cortesBase(), consultaDeCortes(this.q()), (c) => this.camposBuscables(c)));

  /**
   * `[CSU.15]` La lista principal: **un renglón por día de sucursal**, con el total que antes se
   * sumaba a mano. Se deriva de `cortes()` —la lista ya filtrada— para que el total del renglón
   * sea exactamente la suma de lo que se despliega debajo.
   */
  readonly diasDeCortes = computed<DiaDeCortes[]>(() => agruparCortesPorDia(this.cortes(), this.fueraVisibles(), hoyMx(), this.plazo()));
  /** `[CSU.20]` Los conteos fuera de corte de la sucursal elegida (o de todas). */
  readonly fueraVisibles = computed<CorteConteoFuera[]>(() => {
    const todos = this.data()?.conteos_fuera_de_corte ?? [];
    const s = this.selSuc();
    return s ? todos.filter((x) => x.sucursal === s.sucursal) : todos;
  });

  /** Qué días abrió la persona. La llave es `<fecha>|<sucursal>`. */
  private readonly abiertosManual = signal<Record<string, boolean>>({});

  /**
   * Lo que de verdad se ve abierto.
   *
   * ⛔ Con una búsqueda activa se abren **todos**: plegar lo que alguien acaba de buscar lo
   * obligaría a un clic por día para encontrar el folio que ya escribió, y esconder lo vital
   * detrás de un acordeón es justo lo que la ley de Tesler prohíbe. Igual cuando hay un solo día:
   * no hay nada que elegir.
   */
  readonly diasAbiertos = computed<Record<string, boolean>>(() => {
    const dias = this.diasDeCortes();
    if (this.q().trim() || dias.length === 1) return Object.fromEntries(dias.map((d) => [d.clave, true]));
    return this.abiertosManual();
  });

  /** ¿La persona puede plegar/desplegar, o están abiertos por la búsqueda? */
  readonly plegadoBloqueado = computed<boolean>(() => !!this.q().trim() || this.diasDeCortes().length === 1);

  /** Para que el botón diga lo que va a hacer, no un rótulo fijo. */
  readonly algunDiaAbierto = computed<boolean>(() => Object.keys(this.abiertosManual()).length > 0);

  toggleDia(d: DiaDeCortes): void {
    if (this.plegadoBloqueado()) return;
    this.abiertosManual.update((e) => {
      const n = { ...e };
      if (n[d.clave]) delete n[d.clave]; else n[d.clave] = true;
      return n;
    });
  }

  todosLosDias(abrir: boolean): void {
    this.abiertosManual.set(abrir ? Object.fromEntries(this.diasDeCortes().map((d) => [d.clave, true])) : {});
  }

  /** Con una sucursal elegida y la búsqueda sin resultados ahí: cuántos casan en las demás. */
  readonly enOtrasSucursales = computed<number>(() => {
    const d = this.data();
    const s = this.selSuc();
    const q = this.q();
    const f = this.filtro(), hoy = hoyMx(), plazo = this.plazo(), fuera = this.diasConFuera();
    if (!d || !s || !q.trim()) return 0;
    const otras = d.cortes.filter((c) => c.sucursal !== s.sucursal && cumpleFiltro(c, f, hoy, plazo, fuera));
    return filtrarPorBusqueda(otras, consultaDeCortes(q), (c) => this.camposBuscables(c)).length;
  });

  camposBuscables(c: CorteRow): (string | number | null | undefined)[] { return camposBuscablesDeCorte(c); }

  limpiarBusqueda(): void {
    this.q.set('');
    this.buscador()?.nativeElement.focus();
  }

  /** `/` lleva al buscador desde cualquier parte de la pantalla (si no se está escribiendo en otro campo). */
  @HostListener('document:keydown', ['$event'])
  atajoBuscar(e: KeyboardEvent): void {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
    e.preventDefault();
    this.buscador()?.nativeElement.focus();
  }
  readonly kpiItems = computed<MetricStripItem[]>(() => { const d = this.data(); return d ? this.kpis(d) : []; });
  readonly pendienteVisible = computed(() => this.cortes().reduce((t, c) => t + Math.max(c.saldo, 0), 0));

  /**
   * `[BFU.4.5.12]` Llegar ya filtrado desde Bancos: «Ver sus cortes de caja» de una sucursal abre ESTA pantalla en el mes
   * y la sucursal de los depósitos (`?month=2026-11&sucursal=08`). Opcional a propósito: sin router (pruebas) no cambia nada.
   */
  private readonly route = inject(ActivatedRoute, { optional: true });
  private sucursalPedida: string | null = null;

  /**
   * `[CSU.31]` CSU.UI.3: debajo de 68.75rem la rejilla pone el detalle DEBAJO de la lista (fuera de la vista); ahí
   * se abre en `app-side-peek`. El mismo corte de la regla `@media` de `.cs-split`.
   */
  readonly angosta = signal(false);

  ngOnInit(): void {
    const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 68.75rem)') : null;
    if (mq) {
      this.angosta.set(mq.matches);
      const cambio = (e: MediaQueryListEvent) => this.angosta.set(e.matches);
      mq.addEventListener?.('change', cambio);
      this.destroyRef.onDestroy(() => mq.removeEventListener?.('change', cambio));
    }
    const qp = this.route?.snapshot.queryParamMap;
    const m = qp?.get('month');
    if (m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m)) this.mes.set(m);
    this.sucursalPedida = qp?.get('sucursal') || null;
    this.reload();
  }

  pickMes(v: string | null): void {
    if (!v) return;
    this.mes.set(v);
    this.rangeDates = null;
    this.reload();
  }

  onRange(): void {
    const [a, b] = this.rangeDates || [];
    if (!a || !b) return; // rango a medio elegir: no se consulta todavía
    this.mes.set(null);
    this.reload();
  }

  pickSuc(s: CorteSucursalResumen | null): void {
    this.selSuc.set(s);
    const c = this.selCorte();
    if (s && c && c.sucursal !== s.sucursal) this.selCorte.set(null);
  }

  reload(): void {
    this.loading.set(true);
    this.err.set(null);
    const p = new URLSearchParams();
    const [a, b] = this.rangeDates || [];
    if (!this.mes() && a && b) { p.set('from', iso(a)); p.set('to', iso(b)); }
    else if (this.mes()) p.set('month', this.mes() as string);
    this.http.get<CortesSucursalesResponse>(`${this.base}?${p.toString()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (d) => {
        this.data.set(d);
        // Revisión: si esta respuesta ya no trae la llegada (o la venta del turno) medida, un filtro que depende de
        // ella daría una lista vacía que se lee como «ninguno»: se quita.
        const f = this.filtro();
        if ((FILTROS_DE_LLEGADA.has(f) && (d.llegada ?? null) === null) || (f === 'venta_sin_forma_de_pago' && (d.venta_sin_forma_de_pago ?? null) === null)) this.filtro.set('todos');
        const s = this.selSuc();
        this.selSuc.set(s ? d.sucursales.find((x) => x.sucursal === s.sucursal) ?? null : null);
        // [BFU.4.5.12] La sucursal que pidió la liga de Bancos, una sola vez (si no está en el alcance, no se inventa).
        if (this.sucursalPedida) { this.selSuc.set(d.sucursales.find((x) => x.sucursal === this.sucursalPedida) ?? this.selSuc()); this.sucursalPedida = null; }
        // Quien sólo ve UNA sucursal (encargado/auxiliar) la tiene seleccionada de entrada.
        if (!this.selSuc() && !d.alcance.todas && d.sucursales.length === 1) this.selSuc.set(d.sucursales[0]);
        const c = this.selCorte();
        this.selCorte.set(c ? d.cortes.find((x) => x.clave === c.clave) ?? null : null);
        this.loading.set(false);
      },
      error: () => { this.loading.set(false); this.err.set('No se pudieron cargar los cortes.'); },
    });
  }

  kpis(d: CortesSucursalesResponse): MetricStripItem[] {
    const t = d.totales;
    const hoy = hoyMx();
    const venc = d.cortes.filter((c) => c.saldo > 0.005 && diasEntre(c.fecha, hoy) > d.plazo_cobro_dias).reduce((x, c) => x + c.saldo, 0);
    // [CSU.31] «Llegó a la empresa» (CSU.26–29): neutro (CSU.UI.7). Sin medición se DECLARA, nunca un cero.
    const ll = d.llegada ?? null;
    const llego: MetricStripItem = ll
      ? {
        label: 'Llegó a la empresa', value: ll.llego, format: 'currency2', tone: 'default', drill: 'con_llegada', drillLabel: 'Ver los cortes cuyo dinero ya llegó',
        sub: `${this.pct(ll.llego, ll.aplicado)} de lo cobrado${ll.por_saber > 0.005 ? ` · ${money(ll.por_saber)} por saber` : ''}`,
      }
      : { label: 'Llegó a la empresa', value: 'No medido', format: 'text', tone: 'default', state: 'no_medido', stateNote: 'La consulta de la llegada al banco no respondió', sub: 'no se pudo medir' };
    const vsfp = d.venta_sin_forma_de_pago ?? null;
    return [
      { label: 'Vendido en cortes', value: t.vendido, format: 'currency2', tone: 'default', sub: `${t.cortes} cortes · ${d.sucursales.length} sucursales` },
      { label: 'Cobrado en Kepler', value: t.cobrado, format: 'currency2', tone: 'ok', sub: `${this.pct(t.cobrado, t.vendido)} de lo vendido` },
      llego,
      { label: 'Pendiente de cobro', value: t.pendiente, format: 'currency2', tone: venc > 0.005 ? 'bad' : 'default', sub: venc > 0.005 ? `${money(venc)} con más de ${d.plazo_cobro_dias} días` : `todo dentro de ${d.plazo_cobro_dias} días`,
        drill: 'con_saldo', drillLabel: 'Ver los cortes con saldo por cobrar' },
      // [CSU.21] La MISMA regla que «N sin cuadrar» de la lista (`sin_cuadrar` del backend). [CSU.31] D4: dice cuántos son venta sin forma de pago.
      { label: 'Sin cuadrar', value: t.con_diferencia, format: 'number', tone: t.con_diferencia ? 'bad' : 'ok', drill: 'sin_cuadrar', drillLabel: 'Ver los cortes sin cuadrar',
        sub: [vsfp?.cortes ? `${vsfp.cortes} son venta sin forma de pago` : 'corte, cajero o desglose', t.sin_arqueo ? `${t.sin_arqueo} sin arqueo` : ''].filter(Boolean).join(' · ') },
    ];
  }

  /** El periodo empieza antes de que existieran los cortes POS en Kepler. */
  antesDeCortes(d: CortesSucursalesResponse): boolean { return d.periodo.from < INICIO_CORTES; }
  sucursalesTexto(d: CortesSucursalesResponse): string { return d.alcance.sucursales.map((x) => x.nombre).join(', '); }
  pct(a: number, b: number): string { return b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—'; }
  dias(desde: string): number {
    const hoy = new Date();
    const [y, m, d] = desde.split('-').map(Number);
    return Math.max(0, Math.floor((Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()) - Date.UTC(y, m - 1, d)) / 86400000));
  }
  cobroLabel(e: CorteEstadoCobro): string { return COBRO[e].label; }
  cobroSev(e: CorteEstadoCobro): Sev { return COBRO[e].sev; }
  cuadreSev(q: CorteCuadre): Sev { return CUADRE[q].sev; }
  /** `[CSU.7]` Hubo devolución pero el corte coincide con el esperado BRUTO, no con el neto. */
  cuadraPorBruto(c: CorteRow, a: CorteArqueo): boolean {
    return c.cuadre === 'cuadra' && c.devoluciones_total > 0 && Math.abs(c.monto - a.esperado_neto) >= 1;
  }
  cuadreLabel(c: CorteRow): string { return etiquetaCuadre(c); }

  /**
   * `[CSU.8]` A qué cuenta entró el cobro.
   *
   * ⛔ **No se dibuja un banco que no se sabe.** Las dos ausencias se declaran con palabras
   * distintas porque las arregla gente distinta (ADR-056): `sin_declarar` lo arregla quien captura
   * en Kepler, `no_resuelve` lo arregla el catálogo de cuentas.
   *
   * ⭐ `caja` **no es un hueco, es la respuesta**: 3,599 cobros por $75M entraron en efectivo a
   * `CAJA GENERAL`. Se pinta apagado para que no se lea como banco, pero se pinta.
   */
  depositoLabel(b: CorteCobro): string {
    if (b.cuenta_tesoreria) return b.cuenta_tesoreria;
    if (b.medio_cobro === 'sin_declarar') return 'sin cuenta en Kepler';
    if (b.medio_cobro === 'no_resuelve') return 'cuenta fuera del catálogo';
    return 'cuenta no medida';
  }
  depositoIcon(b: CorteCobro): string {
    if (b.medio_cobro === 'banco') return 'pi-building';
    if (b.medio_cobro === 'caja') return 'pi-wallet';
    return 'pi-info-circle';
  }
  /** `[CSU.9]` Para pintar en rojo una diferencia de denominación en cualquiera de los dos sentidos. */
  abs(n: number): number { return Math.abs(n); }
  /** `[CSU.16]` Una diferencia con su signo a la vista: + sobra, − falta. */
  signo(n: number): string { return n > 0.005 ? `+${money(n)}` : money(n); }

  /**
   * `[CSU.16]` De qué está hecho lo que declaró el cajero, y qué tan firme es: contra lo retirado
   * que registra Kepler (para ver si la diferencia está en los retiros o en el cajón), cuándo
   * capturó el cierre y cómo se ligó al turno.
   */
  composicionCajero(d: CorteDeclaracionCajero): string {
    const partes: string[] = [];
    if (d.cajon !== null) partes.push(`cajón ${money(d.cajon)}`);
    if (d.retiros_n) partes.push(`${d.retiros_n} ${d.retiros_n === 1 ? 'retiro' : 'retiros'} ${money(d.retiros)}`);
    if (d.documentos > 0) partes.push(`créditos y cheques ${money(d.documentos)}`);
    const frases = [partes.join(' + ')];
    if (d.retiros_kepler > 0 || d.retiros > 0) {
      frases.push(Math.abs(d.retiros - d.retiros_kepler) < 0.5 ? 'los mismos retiros que registra Kepler' : `Kepler registra ${money(d.retiros_kepler)} retirados`);
    }
    if (d.retiros_sin_verificar > 0) frases.push(`${money(d.retiros_sin_verificar)} de retiros que nadie contó se toman como buenos`);
    if (d.capturado_at) frases.push(`cierre capturado ${dmyHora(d.capturado_at)}`);
    frases.push(d.ligado === 'folio' ? 'ligado por el folio del turno' : 'ligado por caja y hora (la captura no trae folio)');
    return `${frases.join(' · ')}.`;
  }

  /**
   * `[CSU.23]` Los conteos abiertos (por su id), en el detalle o en los de fuera de corte. `[CSU.25]` Varios
   * a la vez: abrir uno cerraba el anterior, y comparar dos retiros obligaba a ir y venir.
   */
  readonly conteosAbiertos = signal<ReadonlySet<string>>(new Set());
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  /**
   * `[CSU.25]` Desde el aviso «Cajero» de la lista: abre el corte y lleva la vista y el foco a sus conteos,
   * para que el teclado y el lector de pantalla sigan desde ahí. Sin animación (respeta movimiento reducido).
   */
  verConteos(c: CorteRow): void {
    this.selCorte.set(c);
    afterNextRender({
      read: () => {
        const t = this.host.nativeElement.querySelector<HTMLElement>('#cs-conteos-t');
        if (!t) return;
        t.scrollIntoView?.({ block: 'center' });
        t.focus({ preventScroll: true });
      },
    }, { injector: this.injector });
  }
  /** `[CSU.24]` El efectivo del corte abierto, parte por parte, y en palabras dónde se separan. */
  readonly partesEfectivo = computed(() => { const a = this.selCorte()?.arqueo; return a ? partesDelEfectivo(a) : []; });
  readonly lecturaEfectivo = computed(() => { const a = this.selCorte()?.arqueo; return a ? lecturaDelEfectivo(a) : null; });
  toggleConteo(id: string): void {
    if (!id) return;
    this.conteosAbiertos.update((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  /** `[CSU.23]` «Retiro 2 de 4» o «Cierre»: el número dice en qué orden los contó. */
  etiquetaConteo(xs: readonly CorteConteoCajero[], i: number): string {
    if (xs[i].tipo === 'cierre') return 'Cierre';
    const retiros = xs.filter((x) => x.tipo === 'retiro').length;
    const n = xs.slice(0, i + 1).filter((x) => x.tipo === 'retiro').length;
    return `Retiro ${n} de ${retiros}`;
  }

  /** `[CSU.20]` Conteos fuera de corte: cuánto suman, qué son y por qué no están en un corte. */
  sumaFuera(xs: readonly CorteConteoFuera[]): number { return xs.reduce((t, x) => t + x.total, 0); }
  fueraTipo(x: CorteConteoFuera): string { return x.tipo === 'sin_caja' ? 'Conteo sin caja' : x.tipo === 'cierre' ? 'Cierre' : 'Retiro'; }
  fueraPorQue(x: CorteConteoFuera): string { return motivoFuera(x); }
  /** `[CSU.17]` Celda de arqueo de la lista (ver `celdaArqueo`). */
  celda(dif: number | null | undefined, sinDato: string): { label: string; sev: Sev } { return celdaArqueo(dif, sinDato, this.umbral()); }
  /** `[CSU.21]` La pastilla del corte (ver `celdaCorte`). */
  celdaDelCorte(c: CorteRow): { label: string; sev: Sev } { return celdaCorte(c); }
  /** `[CSU.21]` El corte pasó el plazo normal de cobro. */
  vencido(c: CorteRow): boolean { return diasEntre(c.fecha, hoyMx()) > this.plazo(); }
  /** `[CSU.21]` Umbral del arqueo y plazo de cobro: los manda el backend, nadie los escribe dos veces. */
  readonly umbral = computed(() => this.data()?.umbral_descuadre ?? 50);
  readonly plazo = computed(() => this.data()?.plazo_cobro_dias ?? 3);
  /** `[CSU.19]` ¿El faltante del desglose de Kepler son los créditos y cheques que declaró el cajero? */
  creditosExplican(a: CorteArqueo): boolean { return creditosExplicanDesglose(a); }
  /** `[CSU.19]` Celda de billetes y monedas: si los créditos del cajero explican el faltante, se dice y va en gris. */
  celdaKepler(a: CorteArqueo): { label: string; sev: Sev } {
    if (creditosExplicanDesglose(a)) return { label: `${money(a.fisico_diferencia ?? 0)} · créditos del cajero`, sev: 'secondary' };
    return celdaArqueo(a.fisico_diferencia, 'Sin desglose', this.umbral());
  }
  /** `[CSU.17]` El cajero: su diferencia, o por qué no hay — no contó, no capturó el cierre, o sus conteos apuntan a otro turno. */
  celdaCajero(a: CorteArqueo): { label: string; sev: Sev } {
    const d = a.declaracion_cajero;
    if (d) return celdaArqueo(d.diferencia, 'Sin cierre', this.umbral());
    return celdaArqueo(null, a.conteos_cajero_sin_ligar ? `Sin ligar (${a.conteos_cajero_sin_ligar})` : 'No contó');
  }

  /**
   * `[CSU.17]` La fecha del último cobro aplicado en Kepler entre los cortes del periodo: un «Sin cobro»
   * de ayer con el último cobro de hace dos días es plazo de captura, no un defecto de la pantalla.
   */
  readonly ultimoCobro = computed(() => ultimoCobroHasta(this.data()?.cortes ?? [], hoyMx()));

  // ─── [CSU.31] El detalle: la venta del turno, sus facturas y a dónde llegó cada depósito ──────────────────

  /** Lo que se pinta en la pastilla del corte: su llegada, o (sin medición) su estado de cobro de siempre. */
  etiquetaDelCorte(c: CorteRow): { label: string; sev: Sev } {
    return celdaLlegada(c, hoyMx(), this.plazo()) ?? { label: COBRO[c.estado_cobro].label, sev: COBRO[c.estado_cobro].sev };
  }
  celdaDeLlegada(c: CorteRow): { label: string; sev: Sev } | null { return celdaLlegada(c, hoyMx(), this.plazo()); }
  fraseCorte(c: CorteRow): string | null { return fraseDelCorte(c); }
  llegadaCobro(b: CorteCobro): { titulo: string; alerta: boolean } { return llegadaDelCobro(b); }
  aplicadoDe(c: CorteRow): number { return Math.round(c.cobros.reduce((t, b) => t + b.monto, 0) * 100) / 100; }
  /** El folio del ticket como lo dice la caja: «5168», no «0005168» (la maqueta: «ticket 3-5114»). */
  sinCerosFolio(f: string): string { return /^\d+$/.test(f) ? String(Number(f)) : f; }

  /**
   * Del día: cuántos cortes tienen algo por saber o sin conciliar (la MISMA regla, por monto, que «Mostrar»).
   * `null` = la llegada no se midió en ninguno de sus cortes.
   */
  llegadaDelDia(d: DiaDeCortes): { por_saber: number; sin_conciliar: number; llegaron: number } | null {
    if (!d.cortes.some((c) => c.llegada)) return null;
    let por_saber = 0, sin_conciliar = 0, llegaron = 0;
    for (const c of d.cortes) {
      if ((c.llegada?.por_saber ?? 0) > 0.005) por_saber++;
      if ((c.llegada?.sin_conciliar ?? 0) > 0.005) sin_conciliar++;
      // Revisión: «Llegó todo» exige dinero que llegó (un día saldado sólo con devoluciones no «llegó»).
      if ((c.llegada?.llego ?? 0) > 0.005) llegaron++;
    }
    return { por_saber, sin_conciliar, llegaron };
  }

  /**
   * Revisión: «Mostrar: días con conteos fuera de corte» lista CORTES, y el enlace que lo abre cuenta CONTEOS. La pista
   * dice cuántos conteos quedan en la lista y cuántos caen en días sin cortes (que la lista no puede mostrar).
   */
  readonly fueraEnLista = computed(() => {
    const dias = new Set(this.cortesEnAlcance().map((c) => `${c.fecha}|${c.sucursal}`));
    const todos = this.fueraVisibles();
    const n = todos.filter((x) => dias.has(`${x.fecha}|${x.sucursal}`)).length;
    return { n, fuera: todos.length - n };
  });

  /**
   * Las facturas de contado del turno del corte abierto (`GET …/facturas?corte=<clave>`, CSU.30). El periodo es el
   * día del corte: la consulta trae las de los tickets de ese día aunque se hayan facturado después.
   */
  readonly facturasTurno = signal<{ clave: string; estado: 'cargando' | 'listo' | 'error' | 'sin_turno'; facturas: FacturaContado[] } | null>(null);
  private facturasSub: Subscription | null = null;
  private readonly alAbrirCorte = effect(() => {
    const c = this.selCorte();
    untracked(() => this.pedirFacturas(c, false));
  });

  pedirFacturas(c: CorteRow | null, otraVez: boolean): void {
    const actual = this.facturasTurno();
    if (c && !otraVez && actual?.clave === c.clave && actual.estado !== 'error') return; // el mismo corte tras «Actualizar»
    this.facturasSub?.unsubscribe();
    if (!c) { this.facturasTurno.set(null); return; }
    // Revisión: sin caja-turno (o con la venta del turno sin ligar) la regla ticket → corte no puede casar nada, y
    // «ningún ticket se facturó» sería afirmar lo que no se buscó. No se pide; se dice por qué.
    if (!c.caja || !c.turno || (this.ventaMedida() && !c.venta_turno)) { this.facturasTurno.set({ clave: c.clave, estado: 'sin_turno', facturas: [] }); return; }
    this.facturasTurno.set({ clave: c.clave, estado: 'cargando', facturas: [] });
    const p = new URLSearchParams({ from: c.fecha, to: c.fecha, sucursal: c.sucursal, corte: c.clave });
    this.facturasSub = this.http.get<FacturasContadoResponse>(`${this.base}/facturas?${p.toString()}`).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => this.facturasTurno.set({ clave: c.clave, estado: 'listo', facturas: r.facturas }),
      error: () => this.facturasTurno.set({ clave: c.clave, estado: 'error', facturas: [] }),
    });
  }

  /** `[CSU.16]` Cortes del periodo cuyo contado en Kepler es idéntico al esperado, sobre los que tienen arqueo. */
  readonly pctContadoIgual = computed(() => {
    const t = this.data()?.totales;
    const base = t ? t.cortes - t.sin_arqueo : 0;
    return t && base > 0 ? `${((t.contado_igual_esperado / base) * 100).toFixed(1)}%` : null;
  });
}

/** Fecha y hora de la tienda, «30/10 14:56». */
function dmyHora(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(',', '');
}
