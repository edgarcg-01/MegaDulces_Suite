/* eslint-disable no-console */
/**
 * `[RD.93]` — **El lector del libro de comisiones RD** (`INDICADORES RD 2026.xlsx`).
 *
 * Lo usan DOS guiones y por eso vive aparte: `cargar-libro-comisiones-rd.js` (el espejo de
 * `[RD.51]`) y `comparar-libro-motor-rd.js` (el contraste quincena por quincena). Si cada uno
 * leyera el Excel con su propia copia, una corrección al parseo —ya hubo tres: los centavos, la
 * fecha en dos formatos y los bonos del recibo— dejaría a uno de los dos midiendo otra cosa.
 *
 * La historia de cada regla está en el encabezado de `cargar-libro-comisiones-rd.js`.
 */
'use strict';

const BONOS_CHOFER = [
  { nombre: 'Lavadas', umbral: 215999.99, monto: 200 },
  { nombre: 'Lonche', umbral: 239999.99, monto: 800 },
  { nombre: 'Chalan', umbral: 259999.99, monto: 1000 },
];
const bonosDe = (venta, paga) => (!paga || venta == null ? 0
  : BONOS_CHOFER.reduce((s, b) => s + (venta >= b.umbral ? b.monto : 0), 0));

const V = (cell) => {
  const v = cell && cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if ('result' in v) return v.result === undefined ? null : v.result;
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    return v.text ?? null;
  }
  return v;
};
const F = (cell) => {
  const v = cell && cell.value;
  if (!v || typeof v !== 'object') return null;
  return v.formula || null;
};
const num = (x) => (typeof x === 'number' ? x : null);
/**
 * ⭐ A CENTAVOS, en el borde — al LEER el libro, no al escribir.
 *
 * El libro guarda full precision y sólo MUESTRA dos decimales: su "comisión" de la Q1 ruta 21
 * es `9135.2008`, no `9135.20`. Las columnas son `numeric(14,2)`, así que Postgres redondea
 * cada renglón al insertarlo. La primera carga sumó los flotantes crudos por periodo y
 * redondeó al final: lo guardado quedó **3 centavos** por encima del libro y, peor, el total
 * de la corrida no coincidía con la suma de sus propias líneas. Dos campos del mismo hecho
 * tienen que salir del mismo cálculo.
 */
const cent = (x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : null);
/** `YYYY-MM-DD` venga como texto o como `Date` (exceljs entrega medianoche UTC). */
const fechaISO = (x) => {
  if (x instanceof Date) return x.toISOString().slice(0, 10);
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x)) return x.slice(0, 10);
  return null;
};
const letras = (s) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };


/**
 * ⭐ El mapa ruta → bloque sale del PROPIO workbook, no de una lista tecleada.
 * `FORMATO DE PAGO` filas 12-24: columna B = la ruta, columna C = una fórmula gigante cuyo
 * primer `COMISIONES!<col><fila>` dice exactamente de qué bloque sale esa ruta. Los rótulos de
 * la hoja COMISIONES no sirven para esto: dicen "RUTA CANINDO 503 (501)" — el número entre
 * paréntesis es un nombre viejo, y leerlo mal cambia a quién se le paga.
 */
function mapaRutas(wb) {
  const ws = wb.getWorksheet('FORMATO DE PAGO');
  const mapa = [];
  for (let r = 12; r <= 30; r++) {
    const ruta = V(ws.getRow(r).getCell(2));
    const f = F(ws.getRow(r).getCell(3));
    if (ruta === null || !f) continue;
    const m = /COMISIONES!([A-Z]+)(\d+)/.exec(f);
    if (!m) continue;
    mapa.push({ route_code: String(ruta).trim(), colCosto: letras(m[1]), filaBase: Number(m[2]) });
  }
  return mapa;
}

/** Una fila del libro: periodo × ruta, con las diez columnas del bloque. */
function leerBloque(ws, { route_code, colCosto, filaBase }) {
  const out = [];
  // El bloque arranca en `filaBase` (periodo 1) y baja de a una fila por quincena.
  for (let i = 0; i < 27; i++) {
    const r = filaBase + i;
    const row = ws.getRow(r);
    const periodo = num(V(row.getCell(3)));
    if (periodo === null) continue;
    const g = (off) => V(row.getCell(colCosto + off));
    const costo = num(g(0)); const subtotal = num(g(1)); const venta = num(g(2));
    if (costo === null && subtotal === null && venta === null) continue;
    const tierTxt = g(4);
    const pct = typeof tierTxt === 'string' && /%$/.test(tierTxt) ? Number(tierTxt.replace('%', '')) : null;
    out.push({
      route_code, periodo,
      // ⚠️ La fecha llega de DOS formas: texto en la fila que alguien tecleó, y `Date` (UTC
      // medianoche) en las ~19 que son fórmula. Tomar sólo el texto dejaba **1 de 20**
      // comprobadas y la precondición salía ✔ igual — que es dibujar un verde sobre una
      // muestra de uno. Es la alineación periodo-del-libro ↔ periodo-de-la-base: si el bloque
      // estuviera corrido una fila, sin esto no se notaría.
      fecha_fin: fechaISO(V(row.getCell(2))),
      costo: cent(costo), subtotal: cent(subtotal), venta: cent(venta),
      markup: num(g(3)) === null ? null : Math.round(num(g(3)) * 100 * 10000) / 10000,
      pct_aplicado: pct,
      // Los crudos se conservan para poder DECLARAR cuánto mueve el redondeo, en vez de
      // comparar contra el libro con un número y guardar otro.
      comision_crudo: num(g(7)), a_pagar_crudo: num(g(9)), supervisor_crudo: num(g(6)),
      supervisor: cent(num(g(6))),
      comision: cent(num(g(7))),
      nomina_banco: cent(num(g(8))),
      // `a_pagar_hoja` es lo que trae la columna A PAGAR de COMISIONES (comision - nomina).
      // Lo que de verdad se le deposita al chofer lleva los bonos encima: se arma abajo.
      a_pagar_hoja: cent(num(g(9))),
      /** El libro dice `NO APLICA` cuando la venta no alcanzó el tramo: NO es cero. */
      motivo_no_pago: typeof g(9) === 'string' ? 'bajo_umbral' : null,
    });
  }
  // Los bonos se derivan de la venta YA redondeada, y el pago real del recibo se arma acá:
  // `comision - nomina + bonos`, que es la formula BN43 del propio FORMATO DE PAGO.
  for (const f of out) {
    f.bonos = bonosDe(f.venta, f.motivo_no_pago === null);
    f.a_pagar = f.a_pagar_hoja === null ? null : cent(f.a_pagar_hoja + f.bonos);
    // ⚠️ `a_pagar_crudo` se deja COMO LO TRAE LA HOJA (sin bonos): es contra eso que se valida
    // el parseo. El del recibo va aparte -- mezclarlos hacía que el cuadre comparara una cifra
    // contra otra que no es la suya, y el chequeo de redondeo marcara $140,800 de "redondeo".
    f.a_pagar_recibo_crudo = f.a_pagar_crudo === null ? null : f.a_pagar_crudo + f.bonos;
  }
  return out;
}

/** El libro entero: el mapa de rutas y una fila por ruta × quincena con dato. */
async function leerLibro(archivo) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(archivo);
  const mapa = mapaRutas(wb);
  const ws = wb.getWorksheet('COMISIONES');
  const filas = [];
  for (const b of mapa) filas.push(...leerBloque(ws, b));
  return { wb, mapa, filas };
}

module.exports = { BONOS_CHOFER, bonosDe, V, F, num, cent, fechaISO, letras, mapaRutas, leerBloque, leerLibro };
