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

const POR_KEY = new Map(DENOMINACIONES_MXN.map((d) => [d.key, d]));

/** Las llaves validas del JSONB. Lo que no esta aca se rechaza. */
export const DENOM_KEYS: readonly string[] = DENOMINACIONES_MXN.map((d) => d.key);

/** La denominacion de una llave, o `undefined` si no existe. */
export const denomDe = (key: string): Denominacion | undefined => POR_KEY.get(String(key));

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
