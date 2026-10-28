/**
 * SM.39 — El catalogo de denominaciones MXN, en UN solo lugar.
 *
 * ── Por que existe este archivo
 *
 * Pedido de Edgar: "en el apartado de monedas debemos agregar las monedas de
 * $20". Y no se podia: **la clave de una denominacion era su VALOR**, asi que el
 * `20` ya estaba ocupado por el BILLETE, y el reparto billetes/monedas se hacia
 * comparando `valor >= 20` -- con lo cual una moneda de $20 habria caido en la
 * columna de billetes incluso si se lograra capturar.
 *
 * Mexico tiene billete de $20 **y** moneda de $20 (las bimetalicas, que
 * circulan). Son dos cosas distintas que valen lo mismo, y una clave que es el
 * valor no puede distinguirlas. Es el mismo defecto de siempre: una columna
 * -aca una clave- significando dos cosas.
 *
 * ── Por que vive en `libs/contracts` y no donde estaba
 *
 * Estaba escrito **tres veces**: `blind-count.service.ts`, la pantalla de tienda
 * y la de almacen; mas el umbral `>= 20` repetido en el servicio, en la pantalla
 * y en el ticket. Cuatro lugares que tenian que estar de acuerdo y nada los
 * ataba. ADR-056: un primitivo compartido vive en `libs/`, o queda declarado
 * como deuda con nombre.
 *
 * ── La clave, y la compatibilidad
 *
 * La clave del billete sigue siendo el valor a secas (`'20'`), asi que **todo lo
 * ya capturado conserva su significado** -- no hay backfill ni migracion. La
 * moneda que colisiona lleva sufijo `m`: `'20m'`.
 *
 * ⚠️ Al agregar una denominacion, agregarla ACA. Si el valor colisiona con uno
 * que ya existe en la otra familia, la nueva lleva el sufijo -- nunca se le
 * cambia la clave a la vieja, que es lo que invalidaria los arqueos guardados.
 */

export type FamiliaDenominacion = 'billete' | 'moneda';

export interface Denominacion {
  /** Lo que se guarda como llave en el JSONB `denominations`. */
  key: string;
  /** Cuanto vale una pieza, en pesos. */
  valor: number;
  familia: FamiliaDenominacion;
  /** Como se escribe en pantalla y en el ticket. */
  label: string;
}

/** Billetes, del mayor al menor: es el orden de captura en pantalla. */
export const BILLETES_MXN: readonly Denominacion[] = [
  { key: '1000', valor: 1000, familia: 'billete', label: '$1,000' },
  { key: '500', valor: 500, familia: 'billete', label: '$500' },
  { key: '200', valor: 200, familia: 'billete', label: '$200' },
  { key: '100', valor: 100, familia: 'billete', label: '$100' },
  { key: '50', valor: 50, familia: 'billete', label: '$50' },
  { key: '20', valor: 20, familia: 'billete', label: '$20' },
];

/**
 * Monedas, del mayor al menor. La de $20 va PRIMERA porque es la mas grande y
 * porque es la que se acaba de agregar: si fuera al final, quien ya conoce la
 * pantalla no la encuentra.
 */
export const MONEDAS_MXN: readonly Denominacion[] = [
  { key: '20m', valor: 20, familia: 'moneda', label: '$20' },
  { key: '10', valor: 10, familia: 'moneda', label: '$10' },
  { key: '5', valor: 5, familia: 'moneda', label: '$5' },
  { key: '2', valor: 2, familia: 'moneda', label: '$2' },
  { key: '1', valor: 1, familia: 'moneda', label: '$1' },
  { key: '0.5', valor: 0.5, familia: 'moneda', label: '50¢' },
];

export const DENOMINACIONES_MXN: readonly Denominacion[] = [...BILLETES_MXN, ...MONEDAS_MXN];

/**
 * `[LE.1]` Los billetes de dólar que recibe la Caja General (Fase LE, D2). Sin monedas: no se
 * reciben. Viven aparte del catálogo MXN a propósito — las llaves `'100'` o `'20'` significan
 * otra cosa en cada moneda, y un saldo nunca mezcla monedas.
 */
export const BILLETES_USD: readonly Denominacion[] = [
  { key: '100', valor: 100, familia: 'billete', label: 'US$100' },
  { key: '50', valor: 50, familia: 'billete', label: 'US$50' },
  { key: '20', valor: 20, familia: 'billete', label: 'US$20' },
  { key: '10', valor: 10, familia: 'billete', label: 'US$10' },
  { key: '5', valor: 5, familia: 'billete', label: 'US$5' },
  { key: '2', valor: 2, familia: 'billete', label: 'US$2' },
  { key: '1', valor: 1, familia: 'billete', label: 'US$1' },
];


const POR_KEY = new Map(DENOMINACIONES_MXN.map((d) => [d.key, d]));

/** Las llaves validas del JSONB. Lo que no esta aca se rechaza. */
export const DENOM_KEYS: readonly string[] = DENOMINACIONES_MXN.map((d) => d.key);

/** La denominacion de una llave, o `undefined` si no existe. */
export const denomDe = (key: string): Denominacion | undefined => POR_KEY.get(String(key));

/**
 * `[CG.38]` Elige denominaciones del catalogo por llave y **falla ruidosamente** si alguna no
 * existe o no es de la familia pedida.
 *
 * ── Por que vive aca y no en la pantalla
 *
 * Nacio como `seleccionarBilletes` DENTRO de `caja-captura.util.ts`, local, cuando la caja
 * contaba solo billetes. Al agregar monedas hacia falta la misma funcion otra vez -- y ADR-056
 * es explicito: *un mecanismo generico vive en `libs/` o queda declarado como deuda*. Dos
 * copias de esto es como una pantalla deja de ofrecer una denominacion en silencio.
 *
 * ⭐ Lo que protege: **una llave que desaparece del catalogo es dinero que no se puede contar**,
 * y esa es la peor forma de fallar en un arqueo. Por eso revienta al construirse, en vez de
 * devolver una lista mas corta y que nadie lo note.
 */
export function seleccionarDenominaciones(
  keys: readonly string[],
  familia?: FamiliaDenominacion,
): readonly Denominacion[] {
  return keys.map((k) => {
    const d = POR_KEY.get(String(k));
    if (!d) {
      throw new Error(
        'Denominacion "' + k + '" no existe en el catalogo MXN de @megadulces/contracts. ' +
        'Una pantalla no puede ofrecer una denominacion que el catalogo compartido no reconoce.',
      );
    }
    if (familia && d.familia !== familia) {
      throw new Error('La denominacion "' + k + '" es ' + d.familia + ', no ' + familia + '.');
    }
    return d;
  });
}

/**
 * Cuanto vale una pieza de esa llave. `null` si la llave no esta en el catalogo
 * — **null y no 0**: un cero se sumaria en silencio y daria un total mas chico
 * que el dinero real, que es la peor forma de fallar en un arqueo.
 */
export const valorDe = (key: string): number | null => POR_KEY.get(String(key))?.valor ?? null;

/**
 * Suma un conteo por denominacion. Devuelve el total y **enumera las llaves
 * desconocidas** en vez de ignorarlas: una llave que nadie reconoce es dinero
 * que no se conto, y tiene que poder verse.
 */
export function totalDenominaciones(conteo: Record<string, number | string> | null | undefined): {
  total: number;
  billetes: number;
  monedas: number;
  desconocidas: string[];
} {
  let billetes = 0;
  let monedas = 0;
  const desconocidas: string[] = [];
  for (const [key, cant] of Object.entries(conteo || {})) {
    const d = POR_KEY.get(String(key));
    const n = Number(cant);
    if (!d) { desconocidas.push(String(key)); continue; }
    if (!Number.isFinite(n) || n <= 0) continue;
    const sub = d.valor * n;
    if (d.familia === 'billete') billetes += sub; else monedas += sub;
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { total: r2(billetes + monedas), billetes: r2(billetes), monedas: r2(monedas), desconocidas };
}

/**
 * ⛔ `[CG.152]` **La llave canonica de un valor suelto.** Existe porque la base la exige y hay
 * un camino que todavia no la manda.
 *
 * `finance.cash_ledger_cut_denominations` tiene `denom_key` NOT NULL y su llave primaria es
 * `(tenant_id, cut_id, momento, denom_key)` — porque `denominacion` sola **no identifica**: el
 * billete de $20 y la moneda de $20 valen lo mismo y son dos renglones distintos. El conteo del
 * arqueo viaja hoy como `{ denominacion, piezas }`, sin llave, y el insert reventaba con 23502.
 *
 * ⚠️ **Lo que esta funcion NO puede hacer: adivinar la familia.** Ante `20` devuelve la llave del
 * BILLETE (`'20'`), que es la convencion del catalogo —la moneda que colisiona lleva sufijo— y la
 * que conserva el significado de todo lo ya capturado. O sea que **una moneda de $20 contada sin
 * llave queda registrada como billete**.
 *
 * ⭐ El arqueo NO se ve afectado por eso: las dos valen 20, asi que el total contado es el mismo.
 * Lo que se pierde es el desglose por familia. El arreglo de fondo es que quien cuenta mande la
 * llave; mientras tanto, esto se declara en vez de inventar una heuristica.
 *
 * @returns la llave, o `null` si el valor no existe en el catalogo (no se inventa una).
 */
export function denomKeyDeValor(valor: number | string): string | null {
  const v = Number(valor);
  if (!Number.isFinite(v)) return null;
  // Los billetes van primero en `DENOMINACIONES_MXN`, asi que el `find` ya prefiere la familia
  // cuya llave es el valor pelado. Se deja explicito igual: depender del orden de un arreglo
  // para una decision de dinero es como se rompe en silencio el dia que alguien lo reordena.
  return BILLETES_MXN.find((d) => d.valor === v)?.key
    ?? MONEDAS_MXN.find((d) => d.valor === v)?.key
    ?? null;
}

/**
 * ⭐ `[CGA-A.56.1]` **Los billetes que maneja la bóveda CAOS.** Medido en prod el 2026-10-27 sobre
 * 60 días de `analytics.caos_cash_denominations`: en TODOS los tipos (Depósito, Dispensar, Dotar,
 * Vaciar, Cambio, Fin de Día) sólo aparecen $20, $50, $100, $200 y $500. Ni una moneda, ni un
 * billete de $1,000. Dispensó 3,078 billetes de $20 y 2,896 de $50: los billetes chicos SÍ los da.
 *
 * Por eso un retiro de CAOS nunca paga los pesos sueltos ni los centavos de un egreso: los pone el
 * cajón («CAOS pone los billetes, el cajón la morralla», `[CG.96]`).
 */
export const BILLETES_CAOS: readonly number[] = [500, 200, 100, 50, 20];

/**
 * `[CGA-A.56.1]` Lo MÁS que un retiro de CAOS puede pagar sin pasarse de `pesos`, con sus billetes.
 *
 * Con $20 y $50 se arma cualquier múltiplo de $10 desde $40 (40 = 20+20, 70 = 50+20, 90 =
 * 50+20+20…), y además $20: lo único múltiplo de $10 que NO se arma es $10 y $30. Lo demás —los
 * pesos sueltos y los centavos— queda para el cajón.
 *
 * ⚠️ Supone que el retiro trae de todo: si sólo trajo billetes de $500, en la vida real se paga de
 * más y vuelve cambio. Eso no se sabe sin el desglose por enlace (`[CGA-A.55]`) y no se adivina.
 *
 *   pagableConBilletesCaos(803)   → 800
 *   pagableConBilletesCaos(35.50) → 20
 *   pagableConBilletesCaos(30)    → 20
 */
export function pagableConBilletesCaos(pesos: number): number {
  const centavos = Math.round(Number(pesos) * 100);
  if (!Number.isFinite(centavos) || centavos < 2000) return 0;
  let decenas = Math.floor(centavos / 1000);
  if (decenas === 1 || decenas === 3) decenas -= 1;
  return decenas * 10;
}
