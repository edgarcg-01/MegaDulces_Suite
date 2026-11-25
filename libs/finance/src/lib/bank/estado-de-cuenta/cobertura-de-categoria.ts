/**
 * `[BFU.7.6]` **La cobertura del motor de categoría, para la API**: de los renglones de la descarga del banco de un
 * periodo, cuántos tienen categoría y, de los que no, **por qué y de quién** — y que las partes sumen el total.
 *
 * El motor guarda el motivo al correr (`category_reason`); «Kepler todavía no lo tiene» depende del DÍA, así que se
 * recalcula al leer: pasado el plazo de captura (`PLAZO_DE_CAPTURA` días hábiles) pasa a «Kepler no lo tiene» y al
 * área, aunque el motor no haya vuelto a correr.
 *
 * Un renglón sin categoría y SIN motivo (lo puso una persona sin categoría, o el motor todavía no lo evaluó) no se
 * esconde ni se reparte: va aparte, en `sin_motivo`.
 *
 * `[BFU.4.5.6]` Y por área, **quién explica cada peso**: de lo de cada área, cuánto está EXPLICADO según la regla única
 * `explicarRenglon` (BFU.2.8: documento de Kepler, categoría con evidencia, cliente declarado o pago del Calendario; el
 * depósito «cobranza» puesto sólo por ser depósito NO está explicado, D8) y cuánto falta ligar, con su atraso y su por
 * qué. `leerFila` es el ÚNICO lugar que decide el área y lo explicado de un renglón: la usan esta cifra y el filtro de
 * la lista de movimientos, para que el número y la lista que abre no puedan contar distinto.
 */
import { diasHabiles, PLAZO_DE_CAPTURA, RESPONSABLE, type MotivoSinCategoria, type Responsable } from './motor-de-categoria';
import { explicarRenglon, type PorDeCategoria } from './explicacion-del-renglon';
import { claveDeEntrada, ORDEN_DE_ORIGEN } from './origen-del-renglon';

/** Un grupo leído de la base: renglones del mismo estado, motivo, responsable y día. */
export interface FilaDeCobertura {
  con_categoria: boolean;
  motivo: string | null;
  responsable: string | null;
  /** `YYYY-MM-DD` del movimiento (`null` si no tiene: entonces no se recalcula). */
  fecha: string | null;
  n: number | string;
  monto: number | string | null;
  /** `[BFU.4.5.2]` El área dueña de la categoría (`movement_categories.owner_department_code`); `null` = «Otros». */
  area?: string | null;
  /** `[BFU.4.5.2]` `true` si el dinero entra (depósito). Decide a quién va un «área» sin nombre. */
  entra?: boolean | null;
  /**
   * `[BFU.4.5.6]` Los hechos para decidir si está EXPLICADO. Si `documento` no viene (`undefined`), lo explicado NO SE
   * MIDE y sale `null`: nunca se dibuja como cero.
   */
  categoria?: string | null;
  classified_by?: string | null;
  /** `category_evidence->>'fuente'` que dejó el motor (documento · banco · regla_del_libro · deposito). */
  fuente?: string | null;
  /** Casado con un documento de Kepler (`bank_recon_matches`). */
  documento?: boolean | null;
  /** Ligado a un pago del Calendario ejecutado (`payment_allocations.paid_bank_movement_id`). */
  pago?: boolean | null;
  /** Con cliente declarado (`customer_code`, CC.11). */
  cliente?: boolean | null;
  /** `[BFU.4.5.12]` El texto del banco (`bank_movements.concept`): de él sale lo que dice el banco de un depósito sin documento. */
  concepto?: string | null;
  /** `[BFU.4.5.12]` El origen de su documento de Kepler (`venta_tienda` · `cobranza` · `traspaso` · `otro_documento`), `null` sin documento. */
  origen_doc?: string | null;
  /** `[BFU.4.5.12]` La sucursal del corte, cuando es venta de tienda. */
  sucursal_doc?: string | null;
}

/** Lo que se lee de un renglón al día `hoy`: a quién le toca, si está explicado y, si no, por qué. */
export interface LecturaDeLaFila {
  area: string;
  /** El motivo sin categoría, ya recalculado el plazo (`null` si tiene categoría o no tiene motivo). */
  motivo: string | null;
  responsable: string | null;
  /** «Todavía no» que pasó el plazo al leer. */
  vencido_al_leer: boolean;
  /** `null` = no medido (faltan los hechos). */
  explicado: boolean | null;
  /** Si no está explicado: por qué, en una clave (`deposito_sin_documento`, `cobranza_sin_cliente`, el motivo…). */
  por_que_no: string | null;
  /** Lleva más de `PLAZO_DE_CAPTURA` días hábiles (sólo cuenta para lo que falta ligar). */
  atrasado: boolean;
}

/** Quién puso la categoría, en el vocabulario de `explicarRenglon`. */
function porDeLaFila(f: FilaDeCobertura): PorDeCategoria {
  if (f.classified_by === 'manual') return 'manual';
  if (f.fuente === 'documento' || f.fuente === 'banco' || f.fuente === 'regla_del_libro' || f.fuente === 'deposito') return f.fuente;
  if (f.classified_by === 'rule') return 'regla_del_libro';
  return 'ninguna';
}

export interface PorResolver { motivo: MotivoSinCategoria | string; responsable: Responsable | string; n: number; monto: number }

/**
 * `[BFU.4.5.2]` A quién le toca cada renglón. `area` es un código de `identity.departments` o uno de estos grupos
 * DECLARADOS (no se reparten en silencio):
 *   · `otros` — con categoría, pero la categoría no tiene área (BFU.4.5.1, Edgar 2026-11-24); los atiende Tesorería;
 *   · `por_asignar` — un RETIRO que Kepler no tiene, sin Calendario ni acreedor que diga de quién es: Tesorería lo asigna;
 *   · `quien_captura` — un DEPÓSITO que Kepler no tiene: va a quien captura los depósitos de esa cuenta
 *     (`analytics.v_kepler_deposit_capturers`, D18), una persona y no un departamento;
 *   · `en_plazo` — Kepler todavía puede capturarlo (D13): de nadie todavía;
 *   · `sin_motivo` — sin categoría y sin motivo: el motor no lo decidió.
 */
export interface CoberturaPorArea {
  area: string;
  /** Departamento que responde por el grupo cuando no es un área (`otros`, `por_asignar` → `tesoreria`); `null` si no hay. */
  atiende: string | null;
  n: number;
  monto: number;
  /** De esos, los que no tienen categoría: lo que el área tiene que resolver. */
  sin_categoria: { n: number; monto: number };
  /** `[BFU.4.5.6]` Explicados (regla `explicarRenglon`); `null` = no medido. */
  explicado: { n: number; monto: number } | null;
  /** `[BFU.4.5.6]` Lo que falta ligar = n − explicado; `null` = no medido. */
  por_ligar: { n: number; monto: number } | null;
  /** `[BFU.4.5.6]` De lo que falta ligar, cuántos llevan más de `PLAZO_DE_CAPTURA` días hábiles; `null` = no medido. */
  atrasados: number | null;
  /** `[BFU.4.5.6]` Por qué falta ligar, el de más dinero primero. */
  motivos: { motivo: string; n: number; monto: number }[];
  /** El nombre que se muestra (lo pone la API con `identity.departments`; los grupos declarados, `NOMBRE_DE_GRUPO`). */
  nombre?: string;
  /** `[BFU.4.5.12]` Sólo en la venta de tienda: por sucursal del corte, la de más dinero primero. La suma es la del grupo. */
  sucursales?: { sucursal: string; nombre?: string; n: number; monto: number }[];
}

/**
 * `[BFU.4.5.12]` Lo que ENTRÓ o lo que SALIÓ del periodo, con sus grupos: las entradas por su origen (`claveDeEntrada`),
 * las salidas por el área que las explica (`leerFila`). Los grupos de una dirección suman la dirección, y las dos
 * direcciones suman el periodo. `[BFU.4.5.14]` Lo que se movió entre tus cuentas es el grupo `traspaso` en LAS DOS
 * direcciones (no es ingreso ni egreso): la pantalla lo pone fuera de los totales.
 */
export interface CoberturaPorDireccion {
  n: number;
  monto: number;
  explicado: { n: number; monto: number } | null;
  por_ligar: { n: number; monto: number } | null;
  atrasados: number | null;
  grupos: CoberturaPorArea[];
}

const ATIENDE: Record<string, string | null> = { otros: 'tesoreria', por_asignar: 'tesoreria', quien_captura: null, en_plazo: null, sin_motivo: null };

/** Los grupos que no son un departamento, con su nombre para la pantalla y el Excel. */
export const NOMBRE_DE_GRUPO: Readonly<Record<string, string>> = {
  otros: 'Otros', por_asignar: 'Por asignar', quien_captura: 'Quien captura la cuenta', en_plazo: 'En plazo de captura', sin_motivo: 'Sin motivo',
  traspaso: 'Entre tus cuentas',
};

/**
 * `[BFU.4.5.13]` Un RETIRO que fue a otra cuenta tuya: casado con un traspaso de Kepler (`N-*-26`) o con la categoría de
 * traspaso. Es el único lugar que lo decide: lo usan la cifra «entre tus cuentas», el grupo de las salidas y el filtro.
 */
export function esTraspasoQueSale(f: Pick<FilaDeCobertura, 'origen_doc' | 'categoria'>): boolean {
  return f.origen_doc === 'traspaso' || f.categoria === 'traspaso_entre_cuentas';
}

/** El área de un renglón SIN categoría, por su responsable (ya recalculado el plazo) y la dirección del dinero. */
function areaDelResponsable(responsable: string, entra: boolean | null | undefined): string {
  if (responsable === 'nadie_todavia') return 'en_plazo';
  if (responsable === 'area') return entra === true ? 'quien_captura' : 'por_asignar';
  return responsable; // tesoreria · contabilidad · sistemas: son códigos de identity.departments
}

/**
 * `[BFU.4.5.6]` La lectura de UN renglón: el único lugar que decide su área y si está explicado. La cifra por área y el
 * filtro de la lista de movimientos la usan las dos.
 */
export function leerFila(f: FilaDeCobertura, hoy: string): LecturaDeLaFila {
  let motivo: string | null = null, responsable: string | null = null, vencido = false, area: string;
  if (f.con_categoria) area = f.area || 'otros';
  else if (!f.motivo) area = 'sin_motivo';
  else {
    motivo = f.motivo; responsable = f.responsable || RESPONSABLE[motivo as MotivoSinCategoria] || 'sistemas';
    if (motivo === 'kepler_aun_no_lo_tiene' && f.fecha && diasHabiles(f.fecha, hoy) > PLAZO_DE_CAPTURA) {
      motivo = 'kepler_no_lo_tiene'; responsable = RESPONSABLE.kepler_no_lo_tiene; vencido = true;
    }
    area = areaDelResponsable(responsable, f.entra);
  }
  let explicado: boolean | null = null, porQueNo: string | null = null;
  if (f.documento !== undefined && f.documento !== null) {
    const cat = f.con_categoria && f.categoria ? { codigo: f.categoria, por: porDeLaFila(f) } : null;
    explicado = explicarRenglon({ entra: f.entra ? 1 : 0, sale: f.entra ? 0 : 1, documento: f.documento ? { tipo: '', folio: '' } : null,
      categoria: cat, cliente: f.cliente ? 'declarado' : null, pago: f.pago ? 'calendario' : null }).explicado;
    if (!explicado) {
      porQueNo = !cat ? (motivo ?? 'sin_motivo')
        : cat.por === 'deposito' ? 'deposito_sin_documento'
          : cat.codigo === 'cobranza' ? 'cobranza_sin_cliente' : 'categoria_sin_evidencia';
    }
  }
  const atrasado = explicado === false && !!f.fecha && diasHabiles(f.fecha, hoy) > PLAZO_DE_CAPTURA;
  return { area, motivo, responsable, vencido_al_leer: vencido, explicado, por_que_no: porQueNo, atrasado };
}

export interface CoberturaDeCategoria {
  /** Renglones de la descarga del banco en el periodo (el universo del motor). */
  evaluados: number;
  con_categoria: { n: number; monto: number };
  /** Sin categoría, por motivo y responsable; el de más dinero primero. */
  por_resolver: PorResolver[];
  /** Sin categoría y sin motivo: no lo decidió el motor. Se declara aparte. */
  sin_motivo: { n: number; monto: number };
  /**
   * Los renglones agrupados contra un conteo INDEPENDIENTE del universo (otra consulta). Si no casan, el agrupado
   * perdió renglones (una fecha nula, un JOIN de más). `null` = no se midió.
   */
  suma_cuadra: boolean | null;
  /** Cuántos «todavía no» ya pasaron el plazo al leer (y por eso se cuentan como «no lo tiene»). */
  vencidos_al_leer: number;
  /** `[BFU.4.5.2]` Todos los renglones, por área: la suma de `n` es `evaluados`. El de más dinero primero. */
  por_area: CoberturaPorArea[];
  /**
   * `[BFU.4.5.6]` Quién explica cada peso, del periodo entero: explicados, lo que falta ligar y cuántos con más de
   * `PLAZO_DE_CAPTURA` días hábiles. `null` = no medido (las filas no traían los hechos).
   */
  explicado: { n: number; monto: number; por_ligar: { n: number; monto: number }; atrasados: number } | null;
  /**
   * `[BFU.4.5.12]` Lo que entró, por su origen (venta de tienda, cobranza, traspasos… y lo que falta ligar, con lo que
   * dice el banco). `null` si algún renglón no trae la dirección del dinero: no se reparte a ciegas.
   */
  entradas: CoberturaPorDireccion | null;
  /** `[BFU.4.5.12]` Lo que salió, por el área que lo explica. `null` como `entradas`. */
  salidas: CoberturaPorDireccion | null;
  /**
   * `[BFU.4.5.13]` Lo que se movió ENTRE TUS CUENTAS, de los mismos renglones: no es ingreso ni egreso, y sin apartarlo
   * «entró» y «salió» lo cuentan dos veces. Entra = la entrada cuyo origen es `traspaso`; sale = el retiro casado con un
   * traspaso de Kepler (`N-*-26`) o con la categoría `traspaso_entre_cuentas`. `null` como `entradas`.
   */
  entre_cuentas: { entra: { n: number; monto: number }; sale: { n: number; monto: number } } | null;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

type Acum = CoberturaPorArea & {
  _motivos: Map<string, { motivo: string; n: number; monto: number }>;
  _sucs: Map<string, { sucursal: string; n: number; monto: number }> | null;
  _medido: boolean;
};

function nuevoGrupo(clave: string, atiende: string | null, conSucursales = false): Acum {
  return { area: clave, atiende, n: 0, monto: 0, sin_categoria: { n: 0, monto: 0 }, explicado: { n: 0, monto: 0 },
    por_ligar: { n: 0, monto: 0 }, atrasados: 0, motivos: [], _motivos: new Map(), _sucs: conSucursales ? new Map() : null, _medido: true };
}

/** Suma UN renglón (ya leído) a un grupo. Las tres agrupaciones (área, entradas, salidas) pasan por aquí. */
function sumarAlGrupo(a: Acum, f: FilaDeCobertura, l: LecturaDeLaFila, n: number, monto: number): void {
  a.n += n; a.monto += monto;
  if (!f.con_categoria) { a.sin_categoria.n += n; a.sin_categoria.monto += monto; }
  if (l.explicado === null) a._medido = false;
  else if (l.explicado) { a.explicado!.n += n; a.explicado!.monto += monto; }
  else {
    a.por_ligar!.n += n; a.por_ligar!.monto += monto;
    if (l.atrasado) a.atrasados! += n;
    const m = a._motivos.get(l.por_que_no as string) ?? { motivo: l.por_que_no as string, n: 0, monto: 0 };
    m.n += n; m.monto += monto; a._motivos.set(m.motivo, m);
  }
  if (a._sucs) {
    const k = f.sucursal_doc ?? '';
    const s = a._sucs.get(k) ?? { sucursal: k, n: 0, monto: 0 };
    s.n += n; s.monto += monto; a._sucs.set(k, s);
  }
}

function cerrarGrupo({ _motivos, _sucs, _medido, ...a }: Acum): CoberturaPorArea {
  return {
    ...a, monto: r2(a.monto), sin_categoria: { n: a.sin_categoria.n, monto: r2(a.sin_categoria.monto) },
    // Un grupo con UN renglón sin hechos no se mide entero: una cifra parcial se leería como la del grupo.
    explicado: _medido ? { n: a.explicado!.n, monto: r2(a.explicado!.monto) } : null,
    por_ligar: _medido ? { n: a.por_ligar!.n, monto: r2(a.por_ligar!.monto) } : null,
    atrasados: _medido ? a.atrasados : null,
    motivos: _medido ? Array.from(_motivos.values()).map((m) => ({ ...m, monto: r2(m.monto) })).sort((x, y) => y.monto - x.monto || y.n - x.n) : [],
    ...(_sucs ? { sucursales: Array.from(_sucs.values()).map((s) => ({ ...s, monto: r2(s.monto) })).sort((x, y) => y.monto - x.monto || y.n - x.n) } : {}),
  };
}

/** La dirección entera a partir de sus grupos ya cerrados: se suma de ellos, así nunca puede contar distinto. */
function cerrarDireccion(grupos: CoberturaPorArea[]): CoberturaPorDireccion {
  const medido = grupos.every((g) => g.explicado !== null);
  const s = (k: (g: CoberturaPorArea) => number) => grupos.reduce((t, g) => t + k(g), 0);
  return {
    n: s((g) => g.n), monto: r2(s((g) => g.monto)),
    explicado: medido ? { n: s((g) => g.explicado!.n), monto: r2(s((g) => g.explicado!.monto)) } : null,
    por_ligar: medido ? { n: s((g) => g.por_ligar!.n), monto: r2(s((g) => g.por_ligar!.monto)) } : null,
    atrasados: medido ? s((g) => g.atrasados!) : null,
    grupos,
  };
}

export function coberturaDeCategoria(filas: readonly FilaDeCobertura[], hoy: string, totalIndependiente?: number | null): CoberturaDeCategoria {
  let evaluados = 0, vencidos = 0;
  const con = { n: 0, monto: 0 }, sinMotivo = { n: 0, monto: 0 };
  const grupos = new Map<string, PorResolver>();
  const areas = new Map<string, Acum>(), entradas = new Map<string, Acum>(), salidas = new Map<string, Acum>();
  let medidoTodo = filas.length > 0, conDireccion = filas.length > 0;
  const entre = { entra: { n: 0, monto: 0 }, sale: { n: 0, monto: 0 } };
  const total = { n: 0, monto: 0, ligar_n: 0, ligar_monto: 0, atrasados: 0 };
  for (const f of filas) {
    const n = Number(f.n || 0), monto = Number(f.monto || 0);
    evaluados += n;
    const l = leerFila(f, hoy);
    if (f.con_categoria) { con.n += n; con.monto += monto; }
    else if (!f.motivo) { sinMotivo.n += n; sinMotivo.monto += monto; }
    else {
      if (l.vencido_al_leer) vencidos += n;
      const k = `${l.motivo}|${l.responsable}`;
      const g = grupos.get(k) ?? { motivo: l.motivo as string, responsable: l.responsable as string, n: 0, monto: 0 };
      g.n += n; g.monto += monto; grupos.set(k, g);
    }
    const a = areas.get(l.area) ?? nuevoGrupo(l.area, l.area in ATIENDE ? ATIENDE[l.area] : l.area);
    sumarAlGrupo(a, f, l, n, monto);
    areas.set(l.area, a);
    if (l.explicado === null) medidoTodo = false;
    else if (l.explicado) { total.n += n; total.monto += monto; }
    else { total.ligar_n += n; total.ligar_monto += monto; if (l.atrasado) total.atrasados += n; }
    // [BFU.4.5.12] Y por dirección: lo que entró por su origen, lo que salió por su área.
    if (f.entra === true) {
      const k = claveDeEntrada(f);
      const e = entradas.get(k) ?? nuevoGrupo(k, null, k === 'venta_tienda');
      sumarAlGrupo(e, f, l, n, monto); entradas.set(k, e);
      if (k === 'traspaso') { entre.entra.n += n; entre.entra.monto += monto; }
    } else if (f.entra === false) {
      // [BFU.4.5.14] Lo que fue a otra cuenta tuya no es de ningún área: su propio grupo, como en las entradas.
      const traspaso = esTraspasoQueSale(f), ks = traspaso ? 'traspaso' : l.area;
      const s = salidas.get(ks) ?? nuevoGrupo(ks, traspaso ? null : l.area in ATIENDE ? ATIENDE[l.area] : l.area);
      sumarAlGrupo(s, f, l, n, monto); salidas.set(ks, s);
      if (traspaso) { entre.sale.n += n; entre.sale.monto += monto; }
    } else conDireccion = false;
  }
  const por_resolver = Array.from(grupos.values()).map((g) => ({ ...g, monto: r2(g.monto) }))
    .sort((a, b) => b.monto - a.monto || b.n - a.n);
  const porMonto = (a: CoberturaPorArea, b: CoberturaPorArea) => b.monto - a.monto || b.n - a.n;
  const por_area = Array.from(areas.values()).map(cerrarGrupo).sort(porMonto);
  const orden = (k: string) => { const i = ORDEN_DE_ORIGEN.indexOf(k); return i < 0 ? ORDEN_DE_ORIGEN.length : i; };
  // Las salidas: lo que más falta ligar primero (es lo que alguien tiene que ir a hacer), después por monto.
  const porLigarPrimero = (a: CoberturaPorArea, b: CoberturaPorArea) => (b.por_ligar?.monto ?? 0) - (a.por_ligar?.monto ?? 0) || porMonto(a, b);
  return {
    evaluados,
    con_categoria: { n: con.n, monto: r2(con.monto) },
    por_resolver,
    sin_motivo: { n: sinMotivo.n, monto: r2(sinMotivo.monto) },
    suma_cuadra: totalIndependiente == null ? null : Number(totalIndependiente) === evaluados,
    vencidos_al_leer: vencidos,
    por_area,
    explicado: medidoTodo ? { n: total.n, monto: r2(total.monto), por_ligar: { n: total.ligar_n, monto: r2(total.ligar_monto) }, atrasados: total.atrasados } : null,
    entradas: conDireccion ? cerrarDireccion(Array.from(entradas.values()).map(cerrarGrupo).sort((a, b) => orden(a.area) - orden(b.area) || porMonto(a, b))) : null,
    salidas: conDireccion ? cerrarDireccion(Array.from(salidas.values()).map(cerrarGrupo).sort(porLigarPrimero)) : null,
    entre_cuentas: conDireccion ? { entra: { n: entre.entra.n, monto: r2(entre.entra.monto) }, sale: { n: entre.sale.n, monto: r2(entre.sale.monto) } } : null,
  };
}

/**
 * `[BFU.4.5.12]` El grupo de UN renglón en su dirección: el mismo que usa la cifra (`coberturaDeCategoria`), para que el
 * filtro de la lista de movimientos abra exactamente lo que cuenta la celda.
 */
export function grupoDeLaFila(f: FilaDeCobertura, hoy: string): { direccion: 'entra' | 'sale' | null; grupo: string } {
  if (f.entra === true) return { direccion: 'entra', grupo: claveDeEntrada(f) };
  if (f.entra === false && esTraspasoQueSale(f)) return { direccion: 'sale', grupo: 'traspaso' };
  return { direccion: f.entra === false ? 'sale' : null, grupo: leerFila(f, hoy).area };
}
