/**
 * `[UB.PL.3]`–`[UB.PL.5]` **La pieza del croquis**: el mueble real del almacén, con su forma y su
 * lugar. Es lo que permite que el catálogo describa la tienda que existe en vez de una rejilla.
 *
 * ── El problema que resuelve (Edgar, 2026-11-26) ────────────────────────────────────────────
 * La captura masiva sólo sabía generar el producto cartesiano `pasillos × racks × niveles`, así que
 * **todo lo que no era un pasillo tenía que robarse una letra de pasillo**. Medido ese día en Padre
 * Hidalgo: **60 de 315 ubicaciones (19 %)** eran cabeceras dadas de alta como «pasillos D a H», y
 * el mapa las dibujaba como pasillos porque eso decían los datos. El dibujo no mentía: el dato no
 * podía decir la verdad.
 *
 * ⭐ **El código de ubicación NO cambia de FORMA** (D1 del anexo): sigue siendo
 * `[TB][A-Z][01-99][nivel]` en 5 caracteres, con el mismo `normalizeBinCode` del escáner y el mismo
 * ancho de CODE128. Lo único que se movió es el tope del nivel, de 6 a 9 (`[UB.NV.1]`, 2026-11-26).
 * Lo que la pieza agrega vive **al lado** del código, igual que el frente par/non de `[UB.RF.18]`.
 *
 * ⭐ El croquis es **topológico, no a escala**: `fila` y `columna` dicen qué está junto a qué, no
 * cuántos metros mide. Una tienda se recorre por vecindad, no por coordenadas.
 */

import { LOCATION_LEVEL_MAX, LOCATION_RACK_MAX, type LocationCodeParts, type LocationZone } from './warehouse-locations.contract';

/** Lo que una pieza puede ser. Agregar una es agregar un renglón acá: no pide migración. */
export type FixtureKind = 'anaquel' | 'cabecera' | 'isla' | 'caja' | 'mostrador';

export interface FixtureShape {
  /** Cómo se llama en la pantalla, en palabras de la tienda. */
  label: string;
  /** Qué es, en una línea, para quien configura el croquis. */
  ayuda: string;
  /** Máximo de racks (posiciones a lo largo) que admite la pieza. */
  racksMax: number;
  /** Máximo de niveles (entrepaños) que admite. */
  nivelesMax: number;
  /**
   * Si la pieza tiene **dos frentes enfrentados** (`[UB.RF.18]`): un anaquel de pasillo sí — los
   * nones de un lado y los pares del otro. Una cabecera NO: es un mueble de una cara, y por eso
   * dibujarla con corredor en medio es dibujar algo que no existe.
   */
  dosFrentes: boolean;
  /** Si genera ubicaciones con código. Un mostrador puede estar en el croquis y no tener códigos. */
  generaCodigos: boolean;
}

export const FIXTURE_KINDS: Readonly<Record<FixtureKind, FixtureShape>> = {
  anaquel: {
    label: 'Anaquel de pasillo',
    ayuda: 'El mueble largo que forma un pasillo. Tiene dos frentes: los racks nones de un lado y los pares del otro.',
    racksMax: LOCATION_RACK_MAX,
    nivelesMax: LOCATION_LEVEL_MAX,
    dosFrentes: true,
    generaCodigos: true,
  },
  cabecera: {
    label: 'Cabecera',
    ayuda: 'La punta de un anaquel, donde va la exhibición. Es de una sola cara y suele tener pocos racks.',
    racksMax: 4,
    nivelesMax: LOCATION_LEVEL_MAX,
    dosFrentes: false,
    generaCodigos: true,
  },
  isla: {
    label: 'Isla',
    ayuda: 'Un mueble suelto en medio del piso, sin pasillo. Se rodea por los cuatro lados.',
    racksMax: 8,
    nivelesMax: LOCATION_LEVEL_MAX,
    dosFrentes: false,
    generaCodigos: true,
  },
  caja: {
    label: 'Caja',
    ayuda: 'El punto de cobro. Va en el croquis para ubicarse, y no guarda mercancía con código.',
    racksMax: 1,
    nivelesMax: 1,
    dosFrentes: false,
    generaCodigos: false,
  },
  mostrador: {
    label: 'Mostrador',
    ayuda: 'Atención o despacho. Va en el croquis como referencia; no guarda mercancía con código.',
    racksMax: 1,
    nivelesMax: 1,
    dosFrentes: false,
    generaCodigos: false,
  },
};

export interface WarehouseFixture {
  id: string;
  warehouse_id: string;
  zona: LocationZone;
  tipo: FixtureKind;
  /** La letra que la pieza usa en el código de sus ubicaciones; `null` si no genera códigos. */
  pasillo: string | null;
  racks: number;
  niveles: number;
  /** Dónde cae en el croquis. `null` mientras nadie la haya acomodado. */
  fila: number | null;
  columna: number | null;
  orden: number | null;
  label: string | null;
}

export type FixtureSpec = Pick<WarehouseFixture, 'zona' | 'tipo' | 'pasillo' | 'racks' | 'niveles'>;

/** Lo que la pantalla manda para agregar una pieza. */
export interface CrearPiezaBody extends FixtureSpec {
  warehouse_id: string;
  fila?: number | null;
  columna?: number | null;
  label?: string | null;
}

/** Mover una pieza en el croquis o renombrarla. No toca ninguna ubicación. */
export interface MoverPiezaBody {
  fila?: number | null;
  columna?: number | null;
  label?: string | null;
}

export interface CroquisResponse {
  warehouse: { id: string; code: string; name: string };
  zona: LocationZone;
  piezas: WarehouseFixture[];
  /** `[UB.PL.11]` Las caras de esas piezas: lo que de verdad se acomoda en la planta. */
  caras: FixtureFace[];

  /** Ubicaciones de la zona que todavía NO cuelgan de ninguna pieza: el hueco, dicho (ADR-056). */
  sin_pieza: number;

  /**
   * `[UB.PL.13]` Las letras de esas ubicaciones, para que el hueco se pueda **verificar sin abrir
   * la base**: «I, J y K» le dice a quien capturó ayer exactamente qué quedó fuera, y «110» no.
   */
  sin_pieza_letras: string[];
}

export interface DerivarPiezasResult {
  piezas: number;
  ubicaciones: number;
  ya_tenian: number;
  /**
   * `[UB.PL.13]` Piezas que ya existían y quedaron al día: la captura les agregó racks o niveles
   * después de armarlas. Medido en Padre Hidalgo el 2026-11-27: la pieza del pasillo B decía **17
   * racks** y sus ubicaciones llegaban al **22**, así que los racks 18 a 22 no caían en ninguna cara.
   */
  actualizadas: number;
}

/**
 * `[UB.PL.13]` Qué le falta a una pieza para describir las ubicaciones que ya cuelgan de ella.
 * Devuelve `null` cuando no le falta nada.
 *
 * ⭐ **Sólo SUBE, nunca baja**, y la asimetría es deliberada: una ubicación dada de alta es un
 * hecho, y un mueble con menos racks que sus códigos es un mueble que no puede contener lo que
 * contiene. Al revés no: un anaquel de 22 racks con sólo 17 codificados es perfectamente normal
 * —los otros cinco todavía no se capturaron— y bajarlo a 17 pisaría lo que alguien escribió a mano.
 */
export function piezaAlDia(
  pieza: { racks: number; niveles: number },
  segunSusUbicaciones: { racks: number; niveles: number },
): { racks: number; niveles: number } | null {
  const racks = Math.max(pieza.racks || 0, segunSusUbicaciones.racks || 0);
  const niveles = Math.max(pieza.niveles || 0, segunSusUbicaciones.niveles || 0);
  if (racks === pieza.racks && niveles === pieza.niveles) return null;
  return { racks, niveles };
}

export type FixtureExpand =
  | { ok: true; total: number; partes: LocationCodeParts[] }
  | { ok: false; motivo: string };

/**
 * `[UB.PL.4]` Los códigos que produce **una pieza**. Reemplaza al rango cartesiano como forma de
 * crear ubicaciones: antes se pedían «pasillos A–H × racks 1–17 × niveles 1–5» y una cabecera tenía
 * que entrar como si fuera un pasillo; ahora cada pieza dice qué es y genera lo suyo.
 *
 * El rango sigue existiendo para el caso en que de verdad son varios anaqueles iguales: eso es
 * repetir esta función por pieza, no al revés.
 */
export function expandFixture(f: FixtureSpec): FixtureExpand {
  const forma = FIXTURE_KINDS[f.tipo];
  if (!forma) return { ok: false, motivo: `No conozco una pieza de tipo «${String(f.tipo)}».` };
  if (f.zona !== 'T' && f.zona !== 'B') return { ok: false, motivo: 'Elige la zona: T (tienda) o B (bodega).' };

  if (!forma.generaCodigos) {
    // Una caja o un mostrador existen en el croquis y no guardan mercancía: cero códigos NO es un
    // error, y decirlo así evita que alguien «arregle» el cero inventándole ubicaciones.
    if (f.pasillo) return { ok: false, motivo: `${forma.label} no lleva letra de pasillo: no guarda mercancía con código.` };
    return { ok: true, total: 0, partes: [] };
  }

  const pasillo = String(f.pasillo ?? '').trim().toUpperCase();
  if (!/^[A-Z]$/.test(pasillo)) return { ok: false, motivo: 'La pieza necesita una letra de la A a la Z (una sola, sin Ñ).' };

  const entero = (v: unknown) => (Number.isInteger(Number(v)) ? Number(v) : NaN);
  const racks = entero(f.racks);
  const niveles = entero(f.niveles);
  if (!(racks >= 1 && racks <= forma.racksMax)) {
    return { ok: false, motivo: `${forma.label}: de 1 a ${forma.racksMax} racks. Pediste ${f.racks}.` };
  }
  if (!(niveles >= 1 && niveles <= forma.nivelesMax)) {
    return { ok: false, motivo: `${forma.label}: de 1 a ${forma.nivelesMax} niveles. Pediste ${f.niveles}.` };
  }

  const partes: LocationCodeParts[] = [];
  for (let rack = 1; rack <= racks; rack++) {
    for (let nivel = 1; nivel <= niveles; nivel++) partes.push({ zona: f.zona, pasillo, rack, nivel });
  }
  return { ok: true, total: partes.length, partes };
}

export type FixtureChoque =
  | { ok: true }
  | { ok: false; motivo: string };

/**
 * `[UB.PL.5]` Si una pieza puede entrar al croquis sin pisar a otra. Dos reglas, y las dos existen
 * por lo mismo: **que dos piezas no generen el mismo código y que el croquis no dibuje dos muebles
 * en el mismo lugar.**
 *
 * La letra es la que manda sobre los códigos: si dos piezas de la misma zona comparten letra,
 * producen `TA011` las dos. La celda es la del dibujo. Las dos están además como índices únicos en
 * la base, para que no dependa de que alguien llame a esta función.
 */
export function cabeEnElCroquis(nueva: Partial<WarehouseFixture>, existentes: readonly WarehouseFixture[]): FixtureChoque {
  const mismaZona = existentes.filter((e) => e.zona === nueva.zona && e.id !== nueva.id);
  if (nueva.pasillo) {
    const choca = mismaZona.find((e) => e.pasillo === nueva.pasillo);
    if (choca) {
      return { ok: false, motivo: `La letra ${nueva.pasillo} ya es de ${nombrePieza(choca)}: dos piezas con la misma letra producen los mismos códigos.` };
    }
  }
  if (nueva.fila != null && nueva.columna != null) {
    const choca = mismaZona.find((e) => e.fila === nueva.fila && e.columna === nueva.columna);
    if (choca) return { ok: false, motivo: `Ahí ya está ${nombrePieza(choca)}. Muévela a otro lugar del croquis.` };
  }
  return { ok: true };
}

export function nombrePieza(f: Pick<WarehouseFixture, 'tipo' | 'pasillo' | 'label'>): string {
  if (f.label) return f.label;
  const forma = FIXTURE_KINDS[f.tipo];
  const base = forma ? forma.label : f.tipo;
  return f.pasillo ? `${base} ${f.pasillo}` : base;
}

/**
 * `[UB.PL.2]` Las piezas que se deducen de un catálogo que ya existe, para no recapturar nada. Cada
 * grupo de ubicaciones que comparte **zona, letra y tipo** es una pieza; sus racks y niveles salen
 * de lo que hay. El tipo de ubicación se traduce al de pieza: lo que estaba marcado como cabecera
 * de tienda **deja de ser un pasillo** y pasa a ser una cabecera.
 *
 * Es lo que permite que Padre Hidalgo quede configurado sin que nadie vuelva a capturar sus 315
 * ubicaciones ni se toque una sola de sus 51 asignaciones.
 */
export function piezasDerivadas(
  ubicaciones: ReadonlyArray<{ zona: LocationZone | null; pasillo: string | null; rack: number | null; nivel: number | null; tipo: string | null; familia: string }>,
): FixtureSpec[] {
  const porLlave = new Map<string, { zona: LocationZone; pasillo: string; tipo: FixtureKind; racks: number; niveles: number }>();
  for (const u of ubicaciones) {
    if (u.familia !== 'ubicacion' || !u.zona || !u.pasillo) continue;
    const tipo = tipoDePieza(u.tipo);
    const llave = `${u.zona}|${u.pasillo}`;
    const ya = porLlave.get(llave);
    const racks = Math.max(ya?.racks ?? 0, u.rack ?? 0);
    const niveles = Math.max(ya?.niveles ?? 0, u.nivel ?? 0);
    // El tipo de la pieza es el de sus ubicaciones; si están mezcladas, gana el que no es anaquel,
    // porque «cabecera» es una afirmación y «anaquel» es el supuesto por defecto.
    const tipoFinal = ya && ya.tipo !== 'anaquel' ? ya.tipo : tipo;
    porLlave.set(llave, { zona: u.zona, pasillo: u.pasillo, tipo: tipoFinal, racks, niveles });
  }
  return [...porLlave.values()].sort((a, b) => (a.zona === b.zona ? a.pasillo.localeCompare(b.pasillo) : a.zona.localeCompare(b.zona)));
}

/** Del tipo de USO de una ubicación (para qué sirve) al tipo de PIEZA (qué mueble es). */
export function tipoDePieza(tipoUbicacion: string | null | undefined): FixtureKind {
  return tipoUbicacion === 'tienda_cabecera' ? 'cabecera' : 'anaquel';
}

// ── `[UB.PL.8]` Acomodar: decir DÓNDE está cada mueble ───────────────────────────────────────

/**
 * Cuántos renglones admite una planta. No es una restricción física: es el freno a un dedo que se
 * queda apretado. Una tienda de Mega Dulces no pasa de una docena de corridas de anaquel.
 */
export const CROQUIS_FILAS_MAX = 40;

/** Dónde se suelta una pieza. Es el gesto completo: qué se mueve, a qué renglón y en qué orden. */
export interface SoltarPieza {
  /** La pieza que se arrastra. */
  id: string;
  /** El renglón de destino. `null` la saca del croquis y la devuelve a la bandeja. */
  fila: number | null;
  /** Cae **antes** de esta pieza. `null` o ausente = al final del renglón. */
  antes_de?: string | null;
}

/** El lugar nuevo de una pieza. Sólo viajan las que de verdad se movieron. */
export interface PiezaAcomodada {
  id: string;
  fila: number | null;
  columna: number | null;
}

/** Lo que la pantalla manda al soltar: un gesto, una petición. */
export interface AcomodoBody {
  warehouse_id: string;
  zona: LocationZone;
  piezas: PiezaAcomodada[];
}

export type Acomodo =
  | { ok: true; cambios: PiezaAcomodada[] }
  | { ok: false; motivo: string };

/** El orden de un renglón: por columna, y a igualdad, por el orden en que llegaron. */
function enOrden(piezas: readonly WarehouseFixture[]): WarehouseFixture[] {
  return [...piezas].sort((a, b) => (a.columna ?? 0) - (b.columna ?? 0) || (a.orden ?? 0) - (b.orden ?? 0) || a.id.localeCompare(b.id));
}

/**
 * `[UB.PL.8]` **Soltar una pieza en el croquis.** Devuelve SÓLO las piezas cuyo lugar cambió, para
 * que un arrastre sea **una** petición y no una por mueble.
 *
 * El renglón de destino se renumera de 1 a n; el de origen se deja con su hueco a propósito —
 * las columnas sólo tienen que estar ORDENADAS, no ser consecutivas, y renumerar el origen
 * escribiría filas que nadie movió.
 *
 * ⭐ El croquis es topológico: dos piezas no «chocan» nunca, porque una columna no es un metro.
 * Por eso esto no puede fallar por ocupación — sólo por un renglón imposible.
 */
export function acomodar(
  piezas: readonly WarehouseFixture[],
  gesto: SoltarPieza,
): Acomodo {
  const movida = piezas.find((p) => p.id === gesto.id);
  if (!movida) return { ok: false, motivo: 'Esa pieza no está en el croquis de esta zona.' };

  if (gesto.fila != null && !(Number.isInteger(gesto.fila) && gesto.fila >= 1 && gesto.fila <= CROQUIS_FILAS_MAX)) {
    return { ok: false, motivo: `Los renglones van del 1 al ${CROQUIS_FILAS_MAX}.` };
  }
  if (gesto.antes_de && gesto.antes_de === gesto.id) {
    return { ok: false, motivo: 'Una pieza no se puede soltar sobre sí misma.' };
  }

  // Sacarla del croquis: se va a la bandeja y nadie más se mueve.
  if (gesto.fila == null) {
    if (movida.fila == null && movida.columna == null) return { ok: true, cambios: [] };
    return { ok: true, cambios: [{ id: movida.id, fila: null, columna: null }] };
  }

  const destino = enOrden(piezas.filter((p) => p.fila === gesto.fila && p.id !== gesto.id));
  const antes = gesto.antes_de ? destino.findIndex((p) => p.id === gesto.antes_de) : -1;
  if (gesto.antes_de && antes < 0) {
    return { ok: false, motivo: 'La pieza de referencia ya no está en ese renglón.' };
  }
  const nuevo = [...destino];
  nuevo.splice(antes < 0 ? nuevo.length : antes, 0, movida);

  const cambios: PiezaAcomodada[] = [];
  nuevo.forEach((p, i) => {
    const columna = i + 1;
    if (p.fila !== gesto.fila || p.columna !== columna) cambios.push({ id: p.id, fila: gesto.fila, columna });
  });
  return { ok: true, cambios };
}
// ── `[UB.PL.11]` La planta se arma con CARAS, no con corredores ──────────────────────────────

/** Cuántos lugares admite un renglón. Mismo porqué que `CROQUIS_FILAS_MAX`: frenar un dedo trabado. */
export const CROQUIS_COLUMNAS_MAX = 60;

/**
 * `[UB.PL.11]` **Lo que se acomoda es una CARA, y cada cara dice hacia dónde mira.**
 *
 * Hasta `[UB.PL.8]` lo que se colocaba era la pieza entera, con sus dos frentes ya pegados uno
 * enfrente del otro. Eso decidía por el usuario: daba por hecho que una letra es un **corredor**
 * con dos frentes enfrentados, y entonces un anaquel que vive **entre** dos pasillos no se podía
 * decir — sus dos caras pertenecen a letras distintas.
 *
 * *Lo planteó Edgar el 2026-11-26: «¿y si los anaqueles están entre pasillos?», y al ofrecerle
 * elegir entre los dos modelos contestó que no: «que todo pueda ser configurable, un sistema más
 * libre acomodar».*
 *
 * El modelo libre, en tres reglas:
 *
 *  1. la planta es una rejilla de **celdas** (`fila`, `columna`); una celda es **un mueble**;
 *  2. cada cara se coloca en una celda y dice si **mira arriba o abajo** — o sea, a cuál de los dos
 *     corredores que tocan esa fila le sirve;
 *  3. **dos caras en la misma celda mirando a lados opuestos son el mismo mueble**, espalda con
 *     espalda. El anaquel entre pasillos queda dicho por el acto de ponerlas juntas, sin inventar
 *     un concepto aparte.
 *
 * ⭐ El **corredor no se acomoda**: es lo que queda entre dos filas, y «es el pasillo A» porque las
 * caras que lo tocan son de A. Por eso «qué tengo enfrente» deja de ser una suposición de la regla
 * par/non y pasa a **leerse del dibujo** (`queTieneEnfrente`).
 */
export type MiraHacia = 'arriba' | 'abajo' | 'izquierda' | 'derecha';

/** Las cuatro, en orden de reloj. Un corredor VERTICAL se sirve con 'izquierda' y 'derecha'. */
export const MIRAS: readonly MiraHacia[] = ['arriba', 'derecha', 'abajo', 'izquierda'];

/**
 * La celda de enfrente, según hacia dónde mira la cara: un paso en esa dirección. El croquis es
 * topológico, así que "un paso" es la celda vecina y no una distancia.
 */
export function celdaDeEnfrente(c: { fila: number; columna: number }, mira: MiraHacia): { fila: number; columna: number } {
  if (mira === 'arriba') return { fila: c.fila - 1, columna: c.columna };
  if (mira === 'abajo') return { fila: c.fila + 1, columna: c.columna };
  if (mira === 'izquierda') return { fila: c.fila, columna: c.columna - 1 };
  return { fila: c.fila, columna: c.columna + 1 };
}

/** Las caras que tiene una pieza: dos si es de pasillo, una si es cabecera, caja o mostrador. */
export type CaraDePieza = 'nones' | 'pares' | 'unica';

export interface FixtureFace {
  id: string;
  fixture_id: string;
  /** Identidad de la cara dentro de su pieza: 1 a 4. */
  slot: number;
  /** [UB.PL.12] Qué racks lleva: nones, pares, todos, un rango, o ninguno. */
  racks_modo: RacksDeCara;
  rack_desde: number | null;
  rack_hasta: number | null;
  /** Nombre propio de la cara, si alguien se lo puso. */
  label: string | null;
  /** Dónde cae en la planta. `null` mientras nadie la haya colocado. */
  fila: number | null;
  columna: number | null;
  mira: MiraHacia | null;
}

/**
 * `[UB.PL.12]` Con qué caras NACE una pieza, según su tipo. Es sólo el punto de partida al
 * derivarla: desde la pantalla se le agregan, se le quitan y se les cambia qué racks llevan.
 */
export function carasPorOmision(tipo: FixtureKind): RacksDeCara[] {
  return FIXTURE_KINDS[tipo]?.dosFrentes ? ['nones', 'pares'] : ['todos'];
}

/** Una cara está colocada cuando tiene celda **y** dirección: sin las tres no se puede dibujar. */
export function caraColocada(c: Pick<FixtureFace, 'fila' | 'columna' | 'mira'>): boolean {
  return c.fila != null && c.columna != null && c.mira != null;
}

/** El lado contrario. Lo usan tanto la validación como el dibujo. */
export function miraOpuesta(m: MiraHacia): MiraHacia {
  if (m === 'arriba') return 'abajo';
  if (m === 'abajo') return 'arriba';
  if (m === 'izquierda') return 'derecha';
  return 'izquierda';
}

/**
 * La **otra cara del mismo mueble**: la que comparte celda mirando al lado contrario. `null` si el
 * mueble es de una sola cara (contra una pared, o una cabecera).
 */
export function laOtraCaraDelMueble(caras: readonly FixtureFace[], id: string): FixtureFace | null {
  const c = caras.find((x) => x.id === id);
  if (!c || !caraColocada(c)) return null;
  return caras.find((o) => o.id !== id && o.fila === c.fila && o.columna === c.columna && o.mira === miraOpuesta(c.mira as MiraHacia)) ?? null;
}

/**
 * `[UB.PL.11]` **Qué hay enfrente, leído del croquis.** Dos caras están enfrentadas cuando comparten
 * columna y se miran a través del corredor que separa sus filas: la de arriba mirando `abajo` y la
 * de abajo mirando `arriba`. ⭐ Esto **reemplaza a la suposición** de que el rack 01 está siempre
 * enfrente del 02 (`[UB.RF.18]`), que sólo es cierta si la letra es un corredor.
 */
export function queTieneEnfrente(caras: readonly FixtureFace[], id: string): FixtureFace | null {
  const c = caras.find((x) => x.id === id);
  if (!c || !caraColocada(c)) return null;
  const d = celdaDeEnfrente({ fila: c.fila as number, columna: c.columna as number }, c.mira as MiraHacia);
  return caras.find((o) => o.fila === d.fila && o.columna === d.columna && o.mira === miraOpuesta(c.mira as MiraHacia)) ?? null;
}

/** El gesto: a qué celda va una cara y hacia dónde mira. `fila: null` la saca de la planta. */
export interface SoltarCara {
  id: string;
  fila: number | null;
  columna: number | null;
  mira: MiraHacia | null;
}

export type CaraAcomodada = Pick<FixtureFace, 'id' | 'fila' | 'columna' | 'mira'>;

export type AcomodoDeCara =
  | { ok: true; cambios: CaraAcomodada[] }
  | { ok: false; motivo: string };

/**
 * `[UB.PL.11]` Soltar una cara en una celda. Devuelve **sólo lo que cambió** —una cara, o ninguna
 * si ya estaba ahí—, porque un arrastre tiene que ser una petición y no una por mueble.
 *
 * ⛔ Lo único que se rechaza es lo imposible: dos caras **mirando al mismo lado** en la misma celda.
 * Eso no es una preferencia de diseño, es que no existe: un mueble tiene un frente por lado.
 */
export function acomodarCara(caras: readonly FixtureFace[], gesto: SoltarCara): AcomodoDeCara {
  const movida = caras.find((c) => c.id === gesto.id);
  if (!movida) return { ok: false, motivo: 'Esa cara no es de este croquis.' };

  if (gesto.fila == null) {
    if (!caraColocada(movida)) return { ok: true, cambios: [] };
    return { ok: true, cambios: [{ id: movida.id, fila: null, columna: null, mira: null }] };
  }

  if (!Number.isInteger(gesto.fila) || gesto.fila < 1 || gesto.fila > CROQUIS_FILAS_MAX) {
    return { ok: false, motivo: `Los renglones van del 1 al ${CROQUIS_FILAS_MAX}.` };
  }
  if (!Number.isInteger(gesto.columna) || (gesto.columna as number) < 1 || (gesto.columna as number) > CROQUIS_COLUMNAS_MAX) {
    return { ok: false, motivo: `Los lugares de un renglón van del 1 al ${CROQUIS_COLUMNAS_MAX}.` };
  }
  if (!gesto.mira || !MIRAS.includes(gesto.mira)) {
    return { ok: false, motivo: 'Falta decir hacia qué lado mira la cara.' };
  }

  const ocupa = caras.find((c) => c.id !== gesto.id && c.fila === gesto.fila && c.columna === gesto.columna && c.mira === gesto.mira);
  if (ocupa) {
    return { ok: false, motivo: 'Ya hay una cara mirando para ese lado en ese lugar: un mueble tiene un frente por lado.' };
  }

  if (movida.fila === gesto.fila && movida.columna === gesto.columna && movida.mira === gesto.mira) {
    return { ok: true, cambios: [] };
  }
  return { ok: true, cambios: [{ id: movida.id, fila: gesto.fila, columna: gesto.columna, mira: gesto.mira }] };
}

/** Una celda de la planta: el mueble que vive ahí, con la cara que da a cada lado. */
export interface CeldaDeLaPlanta {
  fila: number;
  columna: number;
  /** La cara que mira hacia cada lado. Hasta cuatro: una isla se ve de los cuatro costados. */
  caras: Partial<Record<MiraHacia, FixtureFace>>;
  /** Cuántas caras tiene de verdad: 0 celda libre, 1 contra pared, 2 el mueble entre pasillos. */
  cuantas: number;
}

/**
 * `[UB.PL.11]` La planta dibujable: los renglones que ya tienen muebles **más uno libre al final**,
 * y cada uno con sus celdas **más una libre al final**. Así siempre hay dónde seguir poniendo sin
 * tener que buscar un botón de «agregar».
 */
export function plantaDeCaras(caras: readonly FixtureFace[]): CeldaDeLaPlanta[][] {
  const puestas = caras.filter(caraColocada);
  const filas = Math.min(CROQUIS_FILAS_MAX, Math.max(0, ...puestas.map((c) => c.fila as number)) + 1);
  const columnas = Math.min(CROQUIS_COLUMNAS_MAX, Math.max(0, ...puestas.map((c) => c.columna as number)) + 1);
  const planta: CeldaDeLaPlanta[][] = [];
  for (let fila = 1; fila <= filas; fila++) {
    const renglon: CeldaDeLaPlanta[] = [];
    for (let columna = 1; columna <= columnas; columna++) {
      const aqui = puestas.filter((c) => c.fila === fila && c.columna === columna);
      const porLado: Partial<Record<MiraHacia, FixtureFace>> = {};
      for (const c of aqui) porLado[c.mira as MiraHacia] = c;
      renglon.push({ fila, columna, caras: porLado, cuantas: aqui.length });
    }
    planta.push(renglon);
  }
  return planta;
}

/** `[UB.PL.11]` Lo que la pantalla manda al soltar una cara: un gesto, una petición. */
export interface AcomodoCarasBody {
  warehouse_id: string;
  zona: LocationZone;
  gesto: SoltarCara;
}

/**
 * `[UB.PL.11]` El nombre de una CARA en palabras de la tienda: «Anaquel de pasillo A · nones».
 * Una pieza de una sola cara se llama como la pieza, sin sufijo: decir «Cabecera D · única» sería
 * ruido sobre algo que no tiene alternativa.
 */
export function nombreDeCara(f: Pick<WarehouseFixture, 'tipo' | 'pasillo' | 'label'>, cara: Pick<FixtureFace, 'racks_modo' | 'label'>): string {
  if (cara.label) return cara.label;
  const base = nombrePieza(f);
  const modo = RACKS_DE_CARA.find((m) => m.modo === cara.racks_modo);
  // Una cara que se lleva TODO el mueble, o que no guarda nada, se llama como la pieza y ya: decir
  // «Cabecera D · todos los racks» es ruido sobre algo que no tiene alternativa.
  if (cara.racks_modo === 'todos' || cara.racks_modo === 'ninguno') return base;
  return `${base} · ${modo ? modo.label.replace('Racks ', '') : cara.racks_modo}`;
}

// ── `[UB.PL.12]` La cara se CONFIGURA: cuántas hay y qué racks lleva cada una ─────────────────

/**
 * `[UB.PL.12]` **Qué racks lleva una cara.** Hasta aquí lo decidía el código: un anaquel tenía dos
 * caras y se repartían por par/non, porque así es Padre Hidalgo. Pero eso es **una** forma de armar
 * un pasillo, no la única — y decidirlo desde acá obliga a cada tienda a parecerse a aquélla.
 *
 * *Edgar, 2026-11-26: «que sea 100% libre de acomodar el croquis a gustos, si un pasillo tiene
 * pares y nones, si una cabecera tiene una frente a ella, todas las preguntas que me hiciste que se
 * puedan resolver desde interfaz».*
 *
 * Los cinco modos cubren lo que se ve en una tienda:
 *  · `nones` y `pares` — el pasillo clásico, un frente a cada lado del corredor;
 *  · `todos` — un mueble de una sola cara: contra la pared, o una cabecera entera;
 *  · `rango` — la corrida se parte por tramos y no por paridad (01–10 de un lado, 11–20 del otro);
 *  · `ninguno` — la cara existe y **no guarda códigos**: un refrigerador, una caja, una columna.
 */
export type RacksDeCara = 'nones' | 'pares' | 'todos' | 'rango' | 'ninguno';

export const RACKS_DE_CARA: { readonly modo: RacksDeCara; readonly label: string; readonly ayuda: string }[] = [
  { modo: 'nones', label: 'Racks nones', ayuda: '01, 03, 05… Un frente del pasillo.' },
  { modo: 'pares', label: 'Racks pares', ayuda: '02, 04, 06… El frente de enfrente.' },
  { modo: 'todos', label: 'Todos los racks', ayuda: 'Un mueble de una sola cara: contra la pared, o una cabecera entera.' },
  { modo: 'rango', label: 'Un tramo', ayuda: 'Del rack X al Y, cuando la corrida se parte por tramos y no por paridad.' },
  { modo: 'ninguno', label: 'No guarda nada', ayuda: 'Un refrigerador, una caja, una columna: va en el croquis para ubicarse.' },
];

/** Los racks que le tocan a una cara, dentro de los que tiene su pieza. */
export function racksDeLaCara(
  cara: Pick<FixtureFace, 'racks_modo' | 'rack_desde' | 'rack_hasta'>,
  racksDeLaPieza: number,
): number[] {
  if (cara.racks_modo === 'ninguno') return [];
  const todos = Array.from({ length: Math.max(0, racksDeLaPieza) }, (_, i) => i + 1);
  if (cara.racks_modo === 'nones') return todos.filter((r) => r % 2 === 1);
  if (cara.racks_modo === 'pares') return todos.filter((r) => r % 2 === 0);
  if (cara.racks_modo === 'rango') {
    const d = cara.rack_desde ?? 1;
    const h = cara.rack_hasta ?? racksDeLaPieza;
    return todos.filter((r) => r >= d && r <= h);
  }
  return todos;
}

export type CarasDeLaPieza =
  | { ok: true }
  | { ok: false; motivo: string };

/**
 * `[UB.PL.12]` **Las caras de una pieza no pueden pisarse.** Un rack está de un lado del mueble o
 * del otro, nunca en los dos: si dos caras reclaman el mismo, una de las dos miente y la etiqueta
 * terminaría pegada donde no va.
 *
 * ⭐ Lo que **no** se valida a propósito: que las caras cubran TODOS los racks. Una corrida puede
 * tener un tramo sin frente (una esquina, un hueco de paso), y exigir la cobertura completa
 * obligaría a inventar una cara para taparlo.
 */
export function carasCoherentes(
  caras: readonly Pick<FixtureFace, 'id' | 'racks_modo' | 'rack_desde' | 'rack_hasta'>[],
  racksDeLaPieza: number,
): CarasDeLaPieza {
  if (caras.length > 4) return { ok: false, motivo: 'Un mueble tiene cuatro costados como mucho.' };
  const visto = new Map<number, string>();
  for (const c of caras) {
    for (const r of racksDeLaCara(c, racksDeLaPieza)) {
      if (visto.has(r)) {
        return { ok: false, motivo: `El rack ${String(r).padStart(2, '0')} ya está en otra cara de este mueble: un rack va de un lado o del otro, no en los dos.` };
      }
      visto.set(r, c.id);
    }
  }
  return { ok: true };
}

/** `[UB.PL.12]` Lo que se manda para agregar, cambiar o quitar una cara. */
export interface CaraBody {
  fixture_id: string;
  racks_modo: RacksDeCara;
  rack_desde?: number | null;
  rack_hasta?: number | null;
  label?: string | null;
}

/** `[UB.PL.12]` Lo que se manda para renombrar una pieza o cambiarle el tipo. */
export interface PiezaBody {
  tipo?: FixtureKind;
  label?: string | null;
  racks?: number;
  niveles?: number;
}
