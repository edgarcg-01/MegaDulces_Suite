/**
 * CG.20 — Leer, de la prosa que teclea el capturista, QUE RUTA y QUE DIA DE VENTA declara.
 *
 * ── Por que existe ───────────────────────────────────────────────────────────────────────────
 *
 * En la caja general (el `.mdb` Control) la venta de ruta entra a mano, con el detalle en texto
 * libre: `Ventas 01/10 RD21`, `Ventas Canindo 02/10 RD504`, `Ventas 06//10 RD 21`. El Cuadre
 * casaba esas filas contra las otras fuentes **por importe ±$5**, que es un atributo debil: medido
 * en el corpus real, 25.8% de los movimientos tienen mas de un candidato a esa distancia.
 *
 * Pero el texto NO es un atributo debil: declara la ruta y el dia. Si se lee, el casamiento deja
 * de ser "dos numeros parecidos el mismo dia" y pasa a ser una IDENTIDAD — esta fila es la venta
 * de la ruta 23 del 1 de octubre, y la venta de la ruta 23 del 1 de octubre es un hecho que el
 * Kepler de esa camioneta ya registro.
 *
 * ⛔ Esta funcion NO decide si la ruta existe. Devuelve lo que el texto DICE; el servicio lo
 * valida contra el registro operativo (`analytics.v_route_zone`). Esa separacion es el punto:
 * `Ventas Canindo 02/10 RD501` existe en el corpus y su importe es el de la ruta **502** — con la
 * validacion por fuera, un numero que no es ruta se rechaza en vez de postearse a la ruta que no
 * fue. Ver [[reference_kepler_route_inventory_docs]].
 *
 * ── Lo que el corpus real obliga a soportar, medido en octubre 2026 ──────────────────────────
 *
 *   'Ventas 01/10 RD21'            ruta pegada al numero
 *   'Ventas 02/10 RD 23'           con espacio
 *   'Ventas Canindo 01/10 RD 501'  una palabra entre 'RD' y el numero... no: la plaza va ANTES
 *   'Ventas 30/09 RD Canindo 504'  ...y a veces DESPUES de 'RD'
 *   'Ventas 06//10 RD 21'          doble barra -- error de tecleo que ya esta en produccion
 *   'Ventas 03/10 RD22'
 *
 * Y lo que NO declara ruta aunque hable de rutas (la vecinal entra por nombre de persona, no por
 * numero, y por eso aca devuelve null y la liga se resuelve por el mapa del ERP):
 *
 *   'Ventas Ruta Vecinal 30/09' · 'Ventas RV 02/10' · 'Vetas Ruta Vecinal 01/10'
 */

/** Lo que el texto declara. `anio` sólo si el texto lo trae; si no, lo pone `anioDeVenta`. */
export interface VentaDeRutaDeclarada {
  /** Numero de ruta tal como lo escribio la persona, sin ceros a la izquierda. */
  ruta: string;
  mes: number;
  dia: number;
  /** Presente sólo cuando el texto declara el año (el lado Kepler sí lo hace). */
  anio?: number;
}

/**
 * El numero de ruta. Dos formas, y las dos estan en el corpus: `RD <n>` y `RD <plaza> <n>`.
 * El `\b` final evita que `RD 5011` se lea como la ruta 501.
 */
const RX_RUTA = /\bR\.?\s?D\.?\s*(?:[A-Za-zÁÉÍÓÚÑáéíóúñ]+\s+)?0*(\d{2,3})\b/i;
/**
 * La fecha. UNA expresion para los DOS lados, y por eso acepta tres cosas que el corpus trae:
 *
 *   `01/10`        caja (Access)   -- sin anio
 *   `06//10`       caja            -- doble barra, errata que ya esta en produccion
 *   `01-10-2026`   Kepler (cobro)  -- con guiones y con anio
 *   `01/10/2026`   Kepler          -- el mismo concepto escrito con barras
 *
 * Tener una sola expresion es el punto: la identidad ruta+dia es la MISMA de los dos lados, y
 * dos parsers divergen (ya paso con el regex de ruta, que vivia en tres lugares con dos formas).
 *
 * ⚠️ El anio es opcional pero su grupo NO es `\d{2,4}`: con `\d{2}` se comeria el dia de
 * `01-10-26 RD 23` mal escrito. Cuatro digitos o nada.
 */
const RX_FECHA = /\b(\d{1,2})[/-]+(\d{1,2})(?:[/-]+(\d{4}))?\b/;

/**
 * Lee la declaracion. Devuelve null si falta cualquiera de las dos mitades: media declaracion no
 * sirve para ligar nada, y un null explicito es mejor que una fecha inventada (ADR-056).
 */
export function leerVentaDeRuta(texto: string | null | undefined): VentaDeRutaDeclarada | null {
  const t = String(texto || '');
  if (!t) return null;
  const mr = t.match(RX_RUTA);
  if (!mr) return null;
  const mf = t.match(RX_FECHA);
  if (!mf) return null;
  const dia = Number(mf[1]);
  const mes = Number(mf[2]);
  if (!(mes >= 1 && mes <= 12) || !(dia >= 1 && dia <= 31)) return null;
  const anio = mf[3] ? Number(mf[3]) : undefined;
  return anio ? { ruta: String(Number(mr[1])), mes, dia, anio } : { ruta: String(Number(mr[1])), mes, dia };
}

/**
 * El anio que le toca a un `dd/mm` sin anio, dado el dia en que se CAPTURO el movimiento.
 *
 * El efectivo se captura entre 0 y 4 dias despues de la venta (medido en octubre), nunca antes.
 * Asi que la venta es del mismo anio que la captura, salvo en la frontera: una captura del 2 de
 * enero con `30/12` es del anio anterior. Se resuelve eligiendo el anio que deja la venta en el
 * pasado y mas cerca de la captura -- no con un `if (mes === 12)`, que falla el 1 de marzo.
 */
export function anioDeVenta(capturado: Date, mes: number, dia: number): number {
  const y = capturado.getUTCFullYear();
  const mismo = Date.UTC(y, mes - 1, dia);
  // Margen de 2 dias: la captura puede llevar un dia de diferencia por zona horaria, y una venta
  // "del futuro" por ese motivo sigue siendo de este anio.
  const limite = capturado.getTime() + 2 * 864e5;
  return mismo <= limite ? y : y - 1;
}

/**
 * `YYYY-MM-DD` de la venta declarada, o null si el texto no la declara.
 *
 * Si el texto TRAE el año (el concepto de Kepler lo trae: `VENTA RD 27 01-10-2026`) se usa ése y
 * no se infiere nada. `capturado` sólo hace falta para el lado de la caja, que escribe `dd/mm`.
 */
export function fechaDeVentaDeclarada(texto: string | null | undefined, capturado: string | Date): string | null {
  const d = leerVentaDeRuta(texto);
  if (!d) return null;
  if (d.anio) {
    const exacta = new Date(Date.UTC(d.anio, d.mes - 1, d.dia));
    if (exacta.getUTCMonth() !== d.mes - 1 || exacta.getUTCDate() !== d.dia) return null;
    return exacta.toISOString().slice(0, 10);
  }
  const cap = capturado instanceof Date ? capturado : new Date(`${String(capturado).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(cap.getTime())) return null;
  const y = anioDeVenta(cap, d.mes, d.dia);
  const iso = new Date(Date.UTC(y, d.mes - 1, d.dia));
  // Rechaza un 31/02: Date lo corre al 2 o 3 de marzo en silencio.
  if (iso.getUTCMonth() !== d.mes - 1 || iso.getUTCDate() !== d.dia) return null;
  return iso.toISOString().slice(0, 10);
}
