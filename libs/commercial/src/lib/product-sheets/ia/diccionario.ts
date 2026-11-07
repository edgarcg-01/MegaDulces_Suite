/**
 * `[NP.7.L.11d]` **Diccionario del catálogo**: marcas, fabricantes, variantes, denominaciones y tipos de
 * empaque de TODAS las fichas leídas, con las formas en que aparece cada término («Bon o Bon»,
 * «BON O BON», «Bonobon» → una sola entrada `bonobon` con 3 formas).
 *
 * ⛔ Se DERIVA de las propuestas al pedirlo (derive-no-copy, regla principal): no hay tabla del
 * diccionario. Sirve para ver cuántas formas tiene una marca antes de cerrarla en una lista, y para
 * auditar descripciones de Kepler con el vocabulario real de los empaques.
 *
 * Función pura: quien la llama lee `catalog.product_sheets.ai_raw.propuesta` y se las pasa.
 */
import { normalizarBusqueda } from '../../commercial-products/catalogo-busqueda';
import {
  ALERGENOS, LECTURA_FOTO_VERSION, LEYENDAS_NOM051, SELLOS_NOM051,
  type DiccionarioCatalogo, type EntradaDiccionario, type PropuestaAmpliada,
} from './lectura-foto.contract';

/**
 * Clave del diccionario: minúsculas, sin acentos (ñ→n, como `f_unaccent`) y sólo letras y dígitos. Sin
 * espacios a propósito: «BON O BON» y «Bonobon» tienen que caer en la misma clave.
 */
export function normalizarClave(texto: string | null | undefined): string {
  return normalizarBusqueda(texto).replace(/[^a-z0-9]/g, '');
}

/** La forma tal como se leyó, sólo sin espacios de sobra (las mayúsculas se conservan: son evidencia). */
function forma(texto: string): string {
  return texto.trim().replace(/\s+/g, ' ');
}

/** Acumula términos por clave y entrega las entradas ordenadas por SKUs (desc). */
class Acumulador {
  private readonly porClave = new Map<string, { formas: Map<string, number>; skus: Set<string> }>();

  agregar(texto: string | null | undefined, sku: string): void {
    if (typeof texto !== 'string') return;
    const clave = normalizarClave(texto);
    if (!clave) return;
    const e = this.porClave.get(clave) ?? { formas: new Map<string, number>(), skus: new Set<string>() };
    const f = forma(texto);
    e.formas.set(f, (e.formas.get(f) ?? 0) + 1);
    e.skus.add(sku);
    this.porClave.set(clave, e);
  }

  entradas(): EntradaDiccionario[] {
    const lista = [...this.porClave.entries()].map(([clave, e]) => {
      // Más vista primero; en empate, la primera que apareció (el Map conserva el orden de llegada y
      // `sort` es estable).
      const formas = [...e.formas.entries()].map(([texto, veces]) => ({ texto, veces })).sort((a, b) => b.veces - a.veces);
      return { clave, forma_principal: formas[0].texto, formas, skus: [...e.skus] };
    });
    // Más SKUs primero; en empate, por clave, para que el resultado no dependa del orden de las fichas.
    return lista.sort((a, b) => b.skus.length - a.skus.length || (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0));
  }
}

/**
 * Cuenta SKUs (no fotos ni fichas repetidas) por valor de una lista cerrada. Toda la lista aparece,
 * con 0 si nadie la trae: el 0 aquí es medido (sobre `fichas_leidas`), no un faltante. Lo que llegue
 * fuera de la lista (no debería: el contrato la valida) también se cuenta, para que se vea.
 */
function conteoPorSku(cerrada: readonly string[], porSku: Map<string, Set<string>>): Record<string, number> {
  const cuenta = new Map<string, number>(cerrada.map((k) => [k, 0]));
  for (const valores of porSku.values()) {
    for (const v of valores) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
  }
  const orden = [...cuenta.entries()].sort((a, b) => b[1] - a[1]); // estable: empate → orden de la lista cerrada
  return Object.fromEntries(orden);
}

function agregarLista(porSku: Map<string, Set<string>>, sku: string, valores: readonly string[] | null | undefined): void {
  if (!valores?.length) return;
  const s = porSku.get(sku) ?? new Set<string>();
  for (const v of valores) s.add(v);
  porSku.set(sku, s);
}

export function construirDiccionario(fichas: Array<{ sku: string; propuesta: PropuestaAmpliada }>): DiccionarioCatalogo {
  const marcas = new Acumulador();
  const fabricantes = new Acumulador();
  const variantes = new Acumulador();
  const denominaciones = new Acumulador();
  const tiposEmpaque = new Acumulador();
  const alergenosOtros = new Acumulador();
  const sellos = new Map<string, Set<string>>();
  const leyendas = new Map<string, Set<string>>();
  const alergenos = new Map<string, Set<string>>();

  for (const { sku, propuesta } of fichas) {
    const c = propuesta?.campos;
    if (!c) continue;
    marcas.agregar(c.marca?.valor, sku);
    fabricantes.agregar(c.fabricante?.valor, sku);
    variantes.agregar(c.variante?.valor, sku);
    denominaciones.agregar(c.denominacion?.valor, sku);
    tiposEmpaque.agregar(c.empaque?.valor?.tipo, sku);
    for (const a of c.alergenos_otros?.valor ?? []) alergenosOtros.agregar(a, sku);
    agregarLista(sellos, sku, c.sellos_nom051?.valor);
    agregarLista(leyendas, sku, c.leyendas_nom051?.valor);
    agregarLista(alergenos, sku, c.alergenos?.valor);
  }

  return {
    version: LECTURA_FOTO_VERSION,
    fichas_leidas: fichas.length,
    marcas: marcas.entradas(),
    fabricantes: fabricantes.entradas(),
    variantes: variantes.entradas(),
    denominaciones: denominaciones.entradas(),
    tipos_empaque: tiposEmpaque.entradas(),
    sellos: conteoPorSku(SELLOS_NOM051, sellos),
    leyendas: conteoPorSku(LEYENDAS_NOM051, leyendas),
    alergenos: conteoPorSku(ALERGENOS, alergenos),
    alergenos_otros: alergenosOtros.entradas(),
  };
}
