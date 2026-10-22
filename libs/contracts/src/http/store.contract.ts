import { z } from 'zod';

// [TDA.1] Eventos del proyecto Tienda que viajan por WebSocket, compartidos por backend y frontend
// (ADR-052 / ADR-056).
//
// ── POR QUÉ ACÁ ──────────────────────────────────────────────────────────────────────────
// El módulo de tienda ya tiene `LiveTicket` y `StoreAlert` escritos DOS veces a mano —una en
// `apps/api/src/modules/store/store.types.ts` y otra en
// `apps/view/.../tienda/store-socket.service.ts`— porque un tipo de `apps/api` no se puede importar
// desde `apps/view`. Es el patrón exacto que `provenance.contract.ts` existe para cortar: dos
// declaraciones del mismo hecho que se separan en silencio y nadie se entera hasta que el payload
// cambia de un lado.
//
// El evento nuevo entra derecho acá. Los dos viejos NO se retrofitean en este pase: son 3 interfaces
// con campos opcionales en uso vivo, y mezclar el retrofit con la feature haría un diff donde no se
// puede ver qué cambió de comportamiento. Queda anotado como deuda con nombre.

/**
 * El precio de etiqueta de estos productos cambió en Kepler y ya está recomputado en la base.
 *
 * ── Qué problema resuelve que esto exista ────────────────────────────────────────────────
 * La cadena Kepler → base es rápida (replicación lógica → carril hash @15 s → `hop-2` sincrónico),
 * pero el último tramo no existía: el sistema es 100 % pull y la etiquetera sólo consulta el precio
 * cuando el operador escanea, con la frescura congelada pegada a cada ítem de la cola. Si se
 * corregía un precio mientras alguien tenía etiquetas en cola, esas filas conservaban el precio
 * viejo **y se imprimían así**. Es el incidente del SKU 88222 visto desde la pantalla: se arregló en
 * Kepler un precio 54 % bajo costo y el cambio no llegaba.
 *
 * ── Cómo leerlo sin equivocarse ──────────────────────────────────────────────────────────
 * · Lleva `product_id`, no `sku`: es la llave que la pantalla ya tiene por ítem (la devuelve
 *   `resolve`), así que el match es exacto y no hay que resolver nada de vuelta.
 * · **`truncated` no es un detalle.** En un cambio masivo de catálogo la lista viene recortada; ahí
 *   la pantalla tiene que asumir que CUALQUIERA de sus filas puede estar vieja, en vez de creerle a
 *   una lista parcial y dar por buenas las que no aparecen.
 * · Es un AVISO, no el dato. El precio nuevo se pide por HTTP como siempre. Un aviso perdido
 *   degrada al comportamiento viejo (se ve al siguiente escaneo), nunca a un precio inventado.
 */
export interface LabelPricesChanged {
  /** Los productos que cambiaron. Puede venir recortada — ver `truncated`. */
  product_ids: string[];
  /** Cuántos cambiaron en total. Puede ser mayor que `product_ids.length`. */
  total: number;
  /** `true` = la lista está recortada y no alcanza para decidir qué NO cambió. */
  truncated: boolean;
  /** ISO del momento en que se recomputaron. */
  at: string;
}

/**
 * [TDA.4] Un escalón de mayoreo, tal como lo publica el mostrador.
 *
 * ── Por qué esto existe ──────────────────────────────────────────────────────────────────
 * Medido en prod (2026-09-09): **8,481 de 9,020 productos (94 %) tienen mayoreo real**. No es un
 * extra: es el caso normal, y el verificador —la pantalla donde se cierra la venta— no lo mostraba.
 *
 * ── Cómo leerlo sin equivocarse ──────────────────────────────────────────────────────────
 * · **`desde` es SIEMPRE un umbral real del ERP**, nunca un default. Si Kepler no lo tiene, el tier
 *   no viaja — la etiquetera aprendió por las malas que *"un mayoreo cuya condición de cantidad no
 *   se conoce fabrica una discusión en el mostrador"*. Un `MayoreoTier` que llega es un tier que se
 *   puede afirmar.
 * · **`realza` separa el DATO de la SEÑAL.** El precio es cierto igual, pero por debajo del 1 % de
 *   descuento pintarlo como oferta sería mentir con el color. Medido: 366 tiers caen ahí.
 * · **`ahorro_en_el_minimo` es lo que cierra la venta**: no es lo mismo "$44.57 c/u" que "llevando
 *   10 te ahorrás $14.10".
 * · `palabra` sale de la unidad BASE del producto, no del tier: si la base es KG, "desde 20 piezas"
 *   sería falso — son 20 kilos.
 *
 * ── `[TDA.7]` `aplica_a` y `unidad_monto`: la unidad del tier no se puede adivinar ────────
 * `wholesale_pack_price` **trae dos unidades distintas en la misma columna**, y cuál es depende de
 * si el producto tiene paquete registrado. Medido en prod el 2026-09-10, prestándole un precio
 * conocido a cada conjunto (la técnica del árbitro de ADR-059):
 *
 * | Conjunto | Productos | Mediana del ratio | Unidad real |
 * |---|---|---|---|
 * | base `PAQ`/`CJA` | 6,462 | `w / piece_price` = **0.92** | la BASE (el paquete/caja ES la base) |
 * | base pieza **con** `pack_price` y `pack_size` | 380 | `w / pack_price` = **0.93** | el **PAQUETE** |
 * | base pieza **sin** paquete registrado | 704 | `w / piece_price` = **0.91** | pieza (83 contradicen) |
 *
 * El `0.92`–`0.93` es un descuento de mayoreo creíble; leer el mismo número contra la base
 * equivocada daba `w / piece_price` = **8.99** ≈ `pack_size`, o sea un "descuento" de **−798 %**.
 * Por eso estos dos campos VIAJAN con el tier en vez de derivarse en la pantalla:
 *
 * · **`aplica_a`** dice de qué escalera es el escalón, y es lo que permite mostrar en grande el
 *   mayoreo de la unidad que se ESCANEÓ (si se leyó el código del paquete, manda el de paquete).
 *   Es la regla que la etiquetera ya tenía —*"el mayoreo debe ser el de la unidad leída"*,
 *   `label.component.ts` `hasMayoreoPza`— y que el mostrador no tenía.
 * · **`unidad_monto`** rotula el importe. No es cosmético: en los 380 el monto es el precio de un
 *   PAQUETE, y decirle "c/u" a $65.11 cuando la pieza cuesta $9.37 es errar la cifra por 7×.
 */
export interface MayoreoTier {
  /** `pieza` | `paquete` — de qué escalera es este tier. */
  etiqueta: string;
  /** El umbral REAL del ERP. Nunca un default. */
  desde: number;
  /** piezas / paquetes / cajas / kg. */
  palabra: string;
  precio_con_iva: number;
  ahorro_por_unidad: number;
  ahorro_en_el_minimo: number;
  descuento_pct: number;
  /** `true` = el descuento es perceptible (≥ 1 %) y merece señal visual. */
  realza: boolean;
  /**
   * `[TDA.7]` A qué unidad de venta pertenece este escalón: `base` = la unidad de factor 1 del
   * producto (pieza, o el paquete/caja cuando ESA es la base) · `paquete` = el paquete de piezas.
   * La pantalla destaca el que coincide con la unidad escaneada.
   */
  aplica_a: 'base' | 'paquete';
  /** `[TDA.7]` Cómo se rotula `precio_con_iva`: `c/u` o `por paquete`. Nunca se asume. */
  unidad_monto: string;
  /**
   * `[VAC.H3]` El mínimo del escalón expresado en la unidad BASE, ya con su palabra (`"144 piezas"`).
   * Sólo viene cuando el escalón es de PAQUETE: dos escalones con mínimos en unidades distintas
   * (3 piezas / 12 paquetes) se leían como si fueran comparables, y son 48 veces de distancia.
   * Opcional y `null`/ausente = no se pudo derivar (o ya está en base): la pantalla no inventa la
   * equivalencia. Los respaldos bajados antes de `VAC.H3` no lo traen y se leen como siempre.
   */
  equivale_a?: string | null;
}

/**
 * El mismo tier con las claves cortas del snapshot offline.
 *
 * No es una segunda definición: el cómputo y las reglas viven una sola vez, del lado del servidor.
 * Esto es la codificación del cable, y la comparte el resto del snapshot (`c`/`b`/`bu`/`n`/`u`).
 * Medido: con nombres largos el snapshot crecía **1,386 KB crudos** y los nombres eran el **51 %**
 * de los bytes, repetidos 8,383 veces — medio mega de nombres de campo por cero información.
 */
export interface MayoreoTierCompacto {
  e: string;
  d: number;
  w: string;
  p: number;
  au: number;
  am: number;
  pc: number;
  r: 0 | 1;
  /** `[TDA.7]` `aplica_a`: `0` = base, `1` = paquete. Ausente en respaldos previos a TDA.7. */
  a?: 0 | 1;
  /** `[TDA.7]` `unidad_monto`. Ausente en respaldos previos a TDA.7. */
  um?: string;
  /** `[VAC.H3]` `equivale_a`. Ausente en respaldos previos a VAC.H3 y en escalones de base. */
  eq?: string;
}

/**
 * Comprime un tier a la forma de cable. Vive PEGADO a su inversa a propósito: son las dos
 * mitades de la misma codificación y separarlas es cómo se desincronizan.
 */
export function compactarTier(t: MayoreoTier): MayoreoTierCompacto {
  return {
    e: t.etiqueta,
    d: t.desde,
    w: t.palabra,
    p: t.precio_con_iva,
    au: t.ahorro_por_unidad,
    am: t.ahorro_en_el_minimo,
    pc: t.descuento_pct,
    r: t.realza ? 1 : 0,
    a: t.aplica_a === 'paquete' ? 1 : 0,
    um: t.unidad_monto,
    ...(t.equivale_a ? { eq: t.equivale_a } : {}),
  };
}

/**
 * Expande la forma de cable. Es la inversa exacta de `compactarTier`.
 *
 * `[TDA.7]` Los defaults de `a`/`um` NO son un relleno cosmético: un kiosco puede tener un
 * respaldo bajado antes de TDA.7, y esos tiers se calcularon con la regla vieja. El default
 * reproduce EXACTAMENTE el comportamiento con el que se generaron (`base` + `c/u`) en vez de
 * afirmar una unidad que ese dato nunca tuvo — el respaldo viejo se sigue leyendo como se leía, y
 * "Actualizar respaldo" lo corrige. Inventar acá la unidad nueva sobre cifras viejas sería
 * publicar una etiqueta que el número no respalda.
 */
export function expandirTier(t: MayoreoTierCompacto): MayoreoTier {
  return {
    etiqueta: t.e,
    desde: t.d,
    palabra: t.w,
    precio_con_iva: t.p,
    ahorro_por_unidad: t.au,
    ahorro_en_el_minimo: t.am,
    descuento_pct: t.pc,
    realza: t.r === 1,
    aplica_a: t.a === 1 ? 'paquete' : 'base',
    unidad_monto: t.um || 'c/u',
    equivale_a: t.eq || null,
  };
}

// ── [VAC.L1] Lo que RESPONDEN los endpoints del verificador, declarado una sola vez ────────
// Antes `UnidadPrecio`, el renglón del snapshot y la sucursal existían DOS veces (en `KpService` y
// en `verificador.service.ts`) y la respuesta en vivo se leía como `any`: el día que el backend
// agregaba un campo, nada avisaba del otro lado. Ahora el backend lo EMITE con este tipo y el
// frontend lo CONSUME con el mismo.

/** Una unidad de venta con su precio (PZA, PAQ, CJA, KG…). `factor` = cuántas unidades BASE trae. */
export interface UnidadPrecioVerificador {
  u: string;
  precio_con_iva: number;
  precio_sin_iva: number;
  factor: number;
}

/** Un producto entre los que comparten un mismo código (`codigo_ambiguo`). */
export interface CandidatoVerificador {
  codigo: string;
  nombre: string;
  precio_con_iva: number | null;
}

/** `GET /kp/precio` cuando el producto existe. */
export interface VerificadorPrecioOk {
  ok: true;
  codigo: string;
  nombre: string;
  unidad: string;
  precio_con_iva: number | null;
  precio_sin_iva: number | null;
  /** Base primero: los `factor` de las demás se refieren a la primera. */
  unidades: UnidadPrecioVerificador[];
  /** De qué unidad es el código escaneado. `null` = "no sé", nunca "es la base". */
  unidad_escaneada: string | null;
  unidad_base: string | null;
  mayoreo: MayoreoTier[];
  contenido: string | null;
  /** Llave del aviso en vivo. `null` = no se puede saber si un aviso le habla a esta pantalla. */
  product_id: string | null;
  iva_pct: number;
  ieps_pct: number;
  sucursal_precio: string | null;
  precio_ambiguo: boolean;
  plazas_con_precio_distinto: number;
  codigo_ambiguo: boolean;
  productos_candidatos: CandidatoVerificador[];
  plaza_pedida_sin_dato: boolean;
  origen_precio: 'kepler' | 'override_manual';
  /** `[MOS.1]` El proveedor de la ficha. `null` = sin proveedor o no se pudo leer. */
  proveedor?: string | null;
  /**
   * `[ETQ-PROMO.2]` El código es una PROMOCIÓN, bonificación o ajuste de Kepler (a $0.01), no un
   * producto: `precio_con_iva` y `unidades` son el centavo simbólico y NO un precio de venta. La
   * pantalla avisa en vez de cobrarlo. Regla única: `esCodigoSimbolico` (`codigo-simbolico.contract`).
   * Ausente = servidor anterior a esta marca (se lee como «no sé», no como «no lo es»).
   */
  es_promocion?: boolean;
}

/** `GET /kp/precio` cuando NO está (200 con `ok:false`: es una respuesta, no un error). */
export interface VerificadorPrecioNoEncontrado {
  ok: false;
  code?: string;
  error: string;
}

export type VerificadorPrecioResponse = VerificadorPrecioOk | VerificadorPrecioNoEncontrado;

/** Un renglón del snapshot offline, con las claves cortas del cable. */
export interface VerificadorSnapshotItem {
  c: string;
  b: string[];
  /** La unidad de cada barcode, en el mismo índice que `b`. Ausente en respaldos anteriores. */
  bu?: (string | null)[];
  n: string;
  /**
   * Las presentaciones, base primero. `f` = cuántas unidades BASE trae (`kdii.c81`/`c84`; la base
   * es 1). Es relativo a la base, no al peldaño anterior: `costo_peldaño = costo_base × factor`
   * cuadra en 98.5 % de la Unidad Tres (`ERP_KEPLER.md` §2.1.1). Ausente en formatos < 3.
   */
  u: Array<{ u: string; p: number; s: number; f?: number }>;
  /** Mayoreo compacto. Ausente = "este respaldo no sabe de mayoreo". */
  m?: MayoreoTierCompacto[];
  /** Gramaje. */
  g?: string;
  /** `[ETQ-PROMO.2]` `1` = promoción/ajuste de Kepler (no un producto). Se OMITE si no lo es (formato ≥ 4). */
  pm?: 1;
  /**
   * `[MOS.1]` El proveedor, como ÍNDICE en `VerificadorSnapshot.pr`. Índice y no texto: el mismo
   * nombre se repite en cientos de productos y el snapshot es una descarga por kiosco. Ausente =
   * sin proveedor en la ficha (o formato < 3).
   */
  pv?: number;
}

/**
 * `[VAC.L11]` Versión del FORMATO del snapshot que sirve `/kp/precios-todos`.
 *
 * El snapshot se guarda en el navegador del kiosco y vive 12 h, así que convive con backends más
 * nuevos. Hasta hoy un formato viejo se leía "con lo que tuviera" y la ausencia de un campo
 * degradaba en silencio (sin unidad escaneada, sin mayoreo). Ahora el snapshot DECLARA su versión:
 * el kiosco sabe que su respaldo es de un formato anterior, lo dice en pantalla y se re-descarga
 * en cuanto hay red en vez de esperar al vencimiento.
 *
 *  · 1 (o sin `v`) = anterior a esta marca: sin garantías sobre `bu`, `m` ni `g`.
 *  · 2 = lleva la unidad de cada código (`bu`), el mayoreo compacto con su equivalencia (`m`/`eq`)
 *        y el gramaje (`g`).
 *  · 3 = `[MOS.1]` además el factor de cada presentación (`u[].f`) y el proveedor (`pv` + `pr`),
 *        para que el buscador del mostrador encuentre por proveedor y cuente la caja en paquetes.
 *
 *  · 4 = `[ETQ-PROMO.2]` además la marca de promoción (`pm`): sin ella un respaldo de formato 3 mostraría
 *        el $0.01 de una promoción como si fuera su precio. El kiosco lo declara y se re-descarga.
 *
 * Se sube al CAMBIAR la forma del snapshot, no en cada release.
 */
export const VERIFICADOR_SNAPSHOT_FORMATO = 4;

/** `GET /kp/precios-todos`. */
export interface VerificadorSnapshot {
  /** Versión del formato (`VERIFICADOR_SNAPSHOT_FORMATO`). Ausente en respaldos anteriores a VAC.L11. */
  v: number;
  total: number;
  sucursal: string | null;
  generado: string;
  productos: VerificadorSnapshotItem[];
  /** `[MOS.1]` Los nombres de proveedor que referencian los `pv` de los productos. */
  pr?: string[];
}

/** `GET /sucursales`: la plaza y la frescura del ODS de esa plaza. */
export interface SucursalVerificador {
  codigo: string;
  nombre: string;
  direccion: string;
  ciudad: string;
  almacenes: string[];
  datos_al: string | null;
}

// ── [VAC.L6] La consulta del verificador, validada donde ENTRA el dato ─────────────────────
// Los endpoints `/kp/precio` y `/kp/precios-todos` son `@Public()`: la frontera es un kiosco sin
// cuenta, y hasta hoy el único control era un saneo a mano dentro del servicio (sin tope de
// longitud: un `q` de megabytes llegaba hasta el SQL). El esquema vive acá para que el pipe del
// backend y cualquier cliente hablen de LO MISMO.
//
// · `q` — tope de 64 caracteres: un EAN-14 mide 14 y las claves de Kepler 5; 64 deja margen para
//   espacios que el servicio ya limpia. Opcional a propósito: la ausencia sigue contestándose con
//   el 200 `{ ok: false, error: 'Sin código' }` que el frontend ya entiende.
// · `sucursal` — dos dígitos o ausente. Antes un valor mal formado se IGNORABA en silencio y la
//   respuesta caía en la plaza determinista: el error del que llama no se veía. Ahora es un 400.
//   `''` cuenta como ausente (un `?sucursal=` vacío no es una plaza).
const sucursalOpcional = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().regex(/^[0-9]{2}$/, 'sucursal debe ser de dos dígitos').optional(),
);

export const VerificadorPrecioQuery = z.object({
  q: z.string().max(64, 'q admite hasta 64 caracteres').optional(),
  sucursal: sucursalOpcional,
});
export type VerificadorPrecioQuery = z.infer<typeof VerificadorPrecioQuery>;

export const VerificadorPreciosTodosQuery = z.object({ sucursal: sucursalOpcional });
export type VerificadorPreciosTodosQuery = z.infer<typeof VerificadorPreciosTodosQuery>;
