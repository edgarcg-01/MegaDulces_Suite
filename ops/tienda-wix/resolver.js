// RESOLVEDOR: dado un renglon de la tienda, que DEBE decir segun nosotros.
// No escribe nada. Lo usa tanto el ensayo en seco como el aplicador.
const MAPA = { Caja: 'CJA', Paquete: 'PAQ', Pieza: 'PZA', Kilo: 'KG', Bulto: 'BTO' };
const TOPE = 50; // D2: tope por presentacion, criterio pendiente de ratificar

// Que unidad de Kepler corresponde a la presentacion que Wix llama `nom`.
// Regla 1: el nombre conocido. Regla 2: si el SKU tiene UNA sola unidad, esa.
function unidadDe(nom, k) {
  if (MAPA[nom]) return { u: k.u.find(x => x.u === MAPA[nom]), via: 'nombre' };
  // Regla 1b: Wix a veces guardo el CODIGO de unidad de Kepler como nombre ('500', 'Cub').
  const codigo = k.u.find(x => String(x.u).toUpperCase() === String(nom).trim().toUpperCase());
  if (codigo) return { u: codigo, via: 'codigo de unidad' };
  if (k.u.length === 1) return { u: k.u[0], via: 'unidad unica' };
  return { u: null, via: 'sin resolver' };
}

// Reparte la existencia S (unidades de inventario) entre las presentaciones,
// de mayor a menor factor, DESCONTANDO lo ya ofrecido. Cierra por construccion:
//   suma(qty_i * f_i) <= S
function repartir(renglones, S, tope = TOPE) {
  const orden = [...renglones].sort((a, b) => Number(b.f) - Number(a.f));
  let resto = Number(S) || 0;
  const out = new Map();
  for (const r of orden) {
    const f = Number(r.f) || 1;
    const q = Math.min(Math.floor(resto / f), tope);
    out.set(r.variantId, q);
    resto -= q * f;
  }
  return out;
}

// Decide la accion de cada renglon. `k` = producto del feed de Kepler (o null).
function accionDe({ nom, k }) {
  if (!k) return { accion: 'RETIRAR', motivo: 'SKU sin precio de mostrador' };
  if (nom === 'Pieza' && !k.u.some(x => x.u === 'PZA'))
    return { accion: 'OCULTAR', motivo: 'Pieza que el POS no honra' };
  const { u, via } = unidadDe(nom, k);
  if (!u || u.p == null) return { accion: 'DECLARAR', motivo: 'presentacion no resuelta (' + via + ')' };
  return { accion: 'SINCRONIZAR', motivo: 'unidad por ' + via, unidad: u.u, precio: Number(u.p), f: Number(u.f) };
}

module.exports = { MAPA, TOPE, unidadDe, repartir, accionDe };
