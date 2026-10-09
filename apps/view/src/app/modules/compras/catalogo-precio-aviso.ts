/**
 * `[CAT.PRECIO]` El aviso de frescura de la lista de precios, como función pura.
 *
 * ── El defecto que cierra ───────────────────────────────────────────────────────────────────
 *
 * El banner decía **«Precios actualizados el 6 oct 2026»** mientras la lista se había movido
 * **13 minutos antes** (medido en prod el 2026-10-09 buscando el SKU `44430`). La causa: el
 * backend calculaba `MAX(price_updated_at)` sobre el universo **filtrado por el buscador**, y la
 * pantalla publicaba esa fecha como una afirmación sobre **toda la red**.
 *
 * ```
 * con el término "44430"   → 2026-10-06 15:57   ← lo que el banner mostraba
 * sin término (la lista)   → 2026-10-09 15:44   ← lo que era cierto
 * ```
 *
 * ⛔ Y la rama de rezago era peor que un dato equivocado: con un producto de más de 7 días
 * imprimía *«Estos precios llevan N días sin actualizarse»* — acusando al carril de estar parado
 * por culpa de **un solo** SKU que nadie reprecia.
 *
 * ── Por qué es una función pura y recibe el reloj ───────────────────────────────────────────
 *
 * El `computed()` del componente no se puede probar sin montar Angular, y `Date.now()` adentro
 * vuelve la prueba dependiente de la hora de quien la corre. Recibir `ahora` es lo que permite
 * afirmar «a los 8 días dice rezago» sin esperar ocho días.
 *
 * ⚠️ `price_updated_at` es un **piso** de frescura, no una medición del carril: la lista se
 * escribe con un UPSERT sin churn, así que la marca dice *cuándo cambió algún precio*, no
 * *cuándo se verificó la lista*. Un día sin cambios de precio se ve igual que un día sin
 * ingesta. Es la misma trampa de `replenishment_plan.computed_at`, que decía «hace 4 min» sobre
 * 34 días sin verificar. Mientras no haya latido propio del carril, esto es lo que hay — y por
 * eso el texto dice «se actualizó» / «sin moverse», no «se verificó».
 */

/** Lo que el aviso necesita de `ProductStats`. Nada más, para que la prueba no monte la pantalla. */
export interface FrescuraDePrecio {
  /** Fecha del precio más reciente de la LISTA COMPLETA. `null` = la lista no trae fecha. */
  price_updated_at: string | null;
  /** Fecha del precio más reciente de lo FILTRADO. `null` cuando no hay búsqueda. */
  price_updated_at_filtrado: string | null;
}

export interface AvisoPrecio {
  /** `true` sólo cuando LA LISTA lleva más de 7 días sin moverse. Nunca por lo filtrado. */
  viejo: boolean;
  titulo: string;
  detalle: string;
}

const DIAS_PARA_REZAGO = 7;
const BASE =
  'Precio de mostrador (lista BASE-MXN), uno solo para toda la red: no distingue sucursal. '
  + 'El precio por sucursal vive en la pestana Precios.';

const dmy = (iso: string): string =>
  new Date(iso).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });

const diasDesde = (iso: string, ahora: number): number =>
  Math.floor((ahora - new Date(iso).getTime()) / 86400000);

/**
 * @param st  frescura de la lista y, si hay búsqueda, de lo filtrado.
 * @param ahora  epoch ms. Se inyecta a propósito — ver la cabecera.
 */
export function avisoDePrecio(st: FrescuraDePrecio | null, ahora: number): AvisoPrecio | null {
  if (!st) return null;
  const iso = st.price_updated_at;
  // ⛔ Sin fecha NO se dibuja una: «no se sabe» es una respuesta, inventar un «hoy» no (ADR-056).
  if (!iso) {
    return {
      viejo: true,
      titulo: 'No se sabe de cuando es este precio.',
      detalle: 'La lista de mostrador no trae fecha de actualizacion.',
    };
  }

  let detalle = BASE;
  // El título habla de LA LISTA. Lo filtrado se dice aparte y sólo si es MÁS VIEJO: si coincide,
  // repetir la misma fecha se lee como dos mediciones distintas.
  const isoF = st.price_updated_at_filtrado;
  if (isoF && new Date(isoF).getTime() < new Date(iso).getTime()) {
    const d = diasDesde(isoF, ahora);
    detalle += ` Lo que estas viendo es mas viejo: su precio mas reciente es del ${dmy(isoF)}`
      + (d > 0 ? `, hace ${d}${d === 1 ? ' dia.' : ' dias.'}` : '.');
  }

  const dias = diasDesde(iso, ahora);
  return dias > DIAS_PARA_REZAGO
    ? { viejo: true, titulo: `La lista lleva ${dias} dias sin moverse (ultimo cambio: ${dmy(iso)}).`, detalle }
    : { viejo: false, titulo: `La lista se actualizo el ${dmy(iso)}.`, detalle };
}
