'use strict';
/**
 * `[GX.73]` Documentos de `kdm1` cuyo ESTADO todavía puede cambiar en Kepler, y que por eso el
 * carril CTID tiene que re-enviar SIN depender de su fecha de negocio.
 *
 * EL PUNTO CIEGO (2026-10-07). El carril CTID de `replicate-ods-live.js` copia `kdm1` por
 * posición física (`ctid > watermark`) suponiendo que la tabla sólo crece. Su red de seguridad
 * re-envía la ventana reciente (`c9` o `c68` en los últimos 3 días). Pero autorizar una solicitud
 * de gasto en Kepler NO crea un renglón: MODIFICA el existente — medido en `[GX.48]`: lo único que
 * cambia es `c43`, de `N` a `A`, y **ninguna columna de fecha se llena**. En el subscriber de la
 * replicación lógica ese UPDATE deja la versión nueva del renglón en una página que el carril ya
 * pasó (el heap reusa espacio), así que `ctid > wm` la salta. Si la solicitud se levantó hace más
 * de 3 días —lo común: autorizar tarda de horas a semanas— tampoco la cubre la ventana, y las
 * reconciliaciones sólo comparan LLAVES, no valores. Resultado: la Suite muestra «por ejercer» un
 * vale que Kepler ya autorizó, y lo muestra indefinidamente.
 *
 * EL ARREGLO. En cada pasada de la red de seguridad se re-envían, de cada tipo declarado abajo:
 *
 *   1. los que siguen ABIERTOS (`N` o `A`), sin importar su antigüedad — la autorización `N → A`
 *      puede llegar semanas después;
 *   2. TODOS los capturados en los últimos `dias` (`c68`), en cualquier estado — porque el ÚLTIMO
 *      cambio (`A → F`, o la cancelación `→ C`) deja el documento CERRADO en la réplica, y con
 *      sólo el punto 1 esa transición final no se llevaría nunca.
 *
 * Son pocos: medido en `[GX.43]`, ~697 solicitudes en `N` y ~929 en `A` en todas las sucursales,
 * más lo capturado en 120 días. El re-envío es idempotente (`raw-upsert` filtra las idénticas).
 * Queda DECLARADO, no cubierto: la cancelación de una solicitud capturada hace más de `dias` días
 * que además ya estaba cerrada. Se mide con `database/scripts/medir-frescura-kdm1.js`.
 *
 * ⛔ EL ÍNDICE MANDA LA FORMA DEL FILTRO. `kdm1` tiene índice `(c1, c2, c3, c4, c5, c6)`; sin `c1`
 * (la sucursal) la consulta lee 1.8 GB y se cuelga (RUNBOOKS/GASTOS_SCRIPTS_QUE_NECESITAN_KEPLER).
 * Por eso la clave va con IGUALDAD EXACTA sobre `c1..c5`, con el literal del tipo de cada columna,
 * y el estado y la fecha al final como filtro residual. Comparar con `btrim(col::text)` —como hacen
 * las vistas— sería más tolerante y apagaría el índice. Si los datos trajeran espacios, la igualdad
 * exacta dejaría de ver renglones EN SILENCIO: por eso `medir-frescura-kdm1.js` compara este conteo
 * contra el del filtro tolerante (`openDocsSqlTolerante`) y lo reporta.
 */

/** Días de captura que se re-envían en cualquier estado. Ver el punto 2 del encabezado. */
const DIAS_DEFAULT = 120;

/** Los tipos de documento con estado que cambia después, por tabla. Constantes del decode. */
const ABIERTOS = Object.freeze({
  kdm1: Object.freeze([
    Object.freeze({
      nombre: 'solicitud de gasto XA1501',
      // c2/c3/c4/c5 = género/naturaleza/grupo/tipo (ERP_KEPLER §3). X-A-15-1 = «Sol. de gasto».
      clave: Object.freeze({ c2: 'X', c3: 'A', c4: '15', c5: '1' }),
      estado: 'c43',
      // N = por autorizar · A = autorizada (todavía puede pasar a F o a C).
      abiertos: Object.freeze(['N', 'A']),
      // Fecha de CAPTURA (ERP_KEPLER `kdm1.c68`): la que dice cuándo nació el renglón.
      captura: 'c68',
    }),
  ]),
});

/** La columna de sucursal: va primero en el índice de `kdm1`. */
const COL_SUCURSAL = 'c1';

const NUMERICO = /^(smallint|integer|bigint|numeric|decimal|real|double precision)$/i;
const FECHA = /date|timestamp/i;
const qid = (s) => `"${String(s).replace(/"/g, '""')}"`;

/** El literal con el tipo de la columna. Valida el valor: es SQL armado, aunque sea constante. */
function literal(valor, dataType) {
  const v = String(valor);
  if (NUMERICO.test(String(dataType || ''))) {
    if (!/^\d+$/.test(v)) throw new Error(`[ods-open-docs] valor no numérico para columna numérica: ${v}`);
    return v;
  }
  if (!/^[A-Za-z0-9]+$/.test(v)) throw new Error(`[ods-open-docs] valor inválido: ${v}`);
  return `'${v}'`;
}

function diasValidos(d) {
  const n = Math.trunc(Number(d));
  return Number.isFinite(n) && n > 0 ? n : DIAS_DEFAULT;
}

/**
 * Arma el predicado. `tolerante` cambia la igualdad exacta (usa el índice) por `btrim(col::text)`
 * (la forma de las vistas, no usa el índice): sólo para MEDIR que la exacta no pierda renglones.
 */
function armar(table, cols, { paramSucursal = '$1', dias = DIAS_DEFAULT, tolerante = false } = {}) {
  const defs = ABIERTOS[table];
  if (!defs) return null;
  const tipos = new Map((cols || []).map((c) => [c.column_name, c.data_type]));
  if (!tipos.has(COL_SUCURSAL)) return null;
  const n = diasValidos(dias);

  const partes = [];
  const nombres = [];
  for (const d of defs) {
    const necesarias = [...Object.keys(d.clave), d.estado];
    if (!necesarias.every((c) => tipos.has(c))) continue;
    const conds = Object.entries(d.clave).map(([c, v]) => (tolerante
      ? `btrim(${qid(c)}::text) = ${literal(v, 'text')}`
      : `${qid(c)} = ${literal(v, tipos.get(c))}`));
    const abierto = `btrim(${qid(d.estado)}::text) IN (${d.abiertos.map((v) => literal(v, 'text')).join(', ')})`;
    // La rama de captura reciente sólo entra si la columna existe y ES fecha: comparar un texto
    // contra `current_date` tira "operator does not exist" en cada pasada.
    const reciente = d.captura && FECHA.test(String(tipos.get(d.captura) || ''))
      ? `${qid(d.captura)} >= current_date - ${n}` : null;
    conds.push(reciente ? `(${abierto} OR ${reciente})` : abierto);
    partes.push(`(${conds.join(' AND ')})`);
    nombres.push(d.nombre);
  }
  if (!partes.length) return null;
  const docs = partes.length === 1 ? partes[0] : `(${partes.join(' OR ')})`;
  const suc = tolerante ? `btrim(${qid(COL_SUCURSAL)}::text) = ${paramSucursal}` : `${qid(COL_SUCURSAL)} = ${paramSucursal}`;
  return { sql: `${suc} AND ${docs}`, nombres };
}

/**
 * Predicado de los documentos que todavía pueden cambiar de estado, en la réplica de UNA
 * sucursal, o `null` si la tabla no tiene tipos declarados o le falta alguna columna
 * (degradación limpia). La sucursal viaja como parámetro (`$1` por default), no se interpola.
 *
 * @param {string} table
 * @param {{column_name:string,data_type:string}[]} cols  columnas de la réplica
 * @param {{ paramSucursal?: string, dias?: number }} [opts]
 * @returns {{ sql: string, nombres: string[] } | null}
 */
function openDocsSql(table, cols, opts = {}) {
  return armar(table, cols, { ...opts, tolerante: false });
}

/** El mismo universo con el filtro TOLERANTE de las vistas. Sólo para medir; no usa el índice. */
function openDocsSqlTolerante(table, cols, opts = {}) {
  const r = armar(table, cols, { ...opts, tolerante: true });
  return r ? r.sql : null;
}

/**
 * Sólo la CLAVE de los tipos declarados (sucursal + tipo de documento), sin estado ni fecha: el
 * universo completo que mide `medir-frescura-kdm1.js`. Misma igualdad exacta que `openDocsSql`.
 */
function docTypeSql(table, cols, { paramSucursal = '$1' } = {}) {
  const defs = ABIERTOS[table];
  if (!defs) return null;
  const tipos = new Map((cols || []).map((c) => [c.column_name, c.data_type]));
  if (!tipos.has(COL_SUCURSAL)) return null;
  const partes = defs
    .filter((d) => Object.keys(d.clave).every((c) => tipos.has(c)))
    .map((d) => `(${Object.entries(d.clave).map(([c, v]) => `${qid(c)} = ${literal(v, tipos.get(c))}`).join(' AND ')})`);
  if (!partes.length) return null;
  const docs = partes.length === 1 ? partes[0] : `(${partes.join(' OR ')})`;
  return `${qid(COL_SUCURSAL)} = ${paramSucursal} AND ${docs}`;
}

module.exports = { ABIERTOS, COL_SUCURSAL, DIAS_DEFAULT, openDocsSql, openDocsSqlTolerante, docTypeSql };
