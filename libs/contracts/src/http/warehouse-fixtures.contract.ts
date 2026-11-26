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
  /** Ubicaciones de la zona que todavía NO cuelgan de ninguna pieza: el hueco, dicho (ADR-056). */
  sin_pieza: number;
}

export interface DerivarPiezasResult {
  piezas: number;
  ubicaciones: number;
  ya_tenian: number;
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
