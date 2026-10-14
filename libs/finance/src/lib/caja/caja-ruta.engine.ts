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
 * ⛔ **La ruta VECINAL se rechaza ANTES de buscar la ruta, y es obligatorio.**
 *
 * `[CG.20]` lo conseguia por omision: su expresion exigia una `D` literal, asi que
 * `Ventas Ruta Vecinal 30/09` no matcheaba nada. Al admitir `ruta` como token (abajo, por el
 * corpus de CAOS) eso **deja de ser cierto**: `Ruta Vecinal 30` leeria la ruta **30**, y la caja
 * le aplicaria la venta de un camion a un vendedor que no lo maneja.
 *
 * Por eso el descarte es explicito y no un efecto lateral de la forma del otro regex. Cubre las
 * cuatro formas medidas en los dos corpus: `RV 02/10` · `RV321` (CAOS) · `Ruta Vecinal` ·
 * `RutaVecinal` (caja general, con y sin espacio).
 */
const RX_VECINAL = /\br\.?\s?v\b|\brv\d|ruta\s*vecinal/i;

/**
 * El numero de ruta. Las formas del corpus, de los DOS lados:
 *
 *   `RD 26` · `RD28` · `R.D. 21` · `RD Canindo 504`   caja general (Access) y CAOS
 *   `ruta 21` · `ruta 27` · `r23`                      CAOS  <- las que faltaban
 *
 * ⚠️ El `\b` final evita que `RD 5011` se lea como la ruta 501.
 *
 * ⚠️ El orden de la alternancia importa: `ruta` va ANTES que `r`, porque la alternancia de
 * JavaScript es ordenada y con `r` primero `ruta 21` leeria `r` y chocaria con la `u`.
 */
const RX_RUTA = /\b(?:ruta|R\.?\s?D\.?|R)\s*(?:[A-Za-zÁÉÍÓÚÑáéíóúñ]+\s+)?0*(\d{2,3})\b/i;
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
 * Las dos formas que CAOS agrega y que no llevan NINGUN separador. El operador del aparato
 * teclea la fecha pegada o con espacios:
 *
 *   `ruta 21 27 05 26`   -> 27/05/26   espacios
 *   `ruta 27 270526`     -> 27/05/26   pegada
 *
 * ⚠️ Van DESPUES de `RX_FECHA` en el orden de intento, no antes: `01-10-2026` tambien contiene
 * `10 20` si se mira con la expresion equivocada, y el separador es la senal mas fuerte.
 *
 * ⚠️ El anio de dos digitos se IGNORA a proposito, igual que en `RX_FECHA` ("cuatro digitos o
 * nada"): lo pone `anioDeVenta`, que ya esta probado contra la frontera de anio. Leer `26` como
 * 2026 funciona hoy y se rompe en 2099; inferirlo no.
 */
const RX_FECHA_ESPACIOS = /\b(\d{1,2})\s+(\d{1,2})\s+\d{2}\b/;
const RX_FECHA_PEGADA = /\b(\d{2})(\d{2})\d{2}\b/;

/**
 * Lee la declaracion. Devuelve null si falta cualquiera de las dos mitades: media declaracion no
 * sirve para ligar nada, y un null explicito es mejor que una fecha inventada (ADR-056).
 */
export function leerVentaDeRuta(texto: string | null | undefined): VentaDeRutaDeclarada | null {
  const t = String(texto || '');
  if (!t) return null;
  if (RX_VECINAL.test(t)) return null;
  const mr = t.match(RX_RUTA);
  if (!mr || mr.index === undefined) return null;
  /**
   * ⭐ La fecha se busca en el texto **sin los digitos que ya se gastaron en la ruta**, y no en
   * el texto entero ni solo despues de la ruta. Las dos razones son del corpus:
   *
   *   `Ventas 02/10 RD 23`   la fecha va ANTES  (caja general)
   *   `ruta 21 27 05 26`     la fecha va DESPUES (CAOS)
   *
   * Buscar solo despues rompia los ocho casos de la caja general; buscar en el texto entero deja
   * que `ruta 21 27 05 26` lea la propia ruta (`21 27`) como dia y mes.
   */
  const resto = t.slice(0, mr.index) + ' ' + t.slice(mr.index + mr[0].length);
  const mf = resto.match(RX_FECHA) || resto.match(RX_FECHA_ESPACIOS) || resto.match(RX_FECHA_PEGADA);
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
