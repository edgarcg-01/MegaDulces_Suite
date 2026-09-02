/**
 * **De dónde viene la mercancía: proveedor externo o traspaso interno.**
 *
 * En el andén son dos cosas distintas aunque lleguen por la misma puerta. Si
 * falta media tarima, a un **proveedor** se le reclama y le pega en su
 * scorecard; a un **traspaso** se le reclama a la sucursal que embarcó, y el
 * faltante es de la casa. Hoy la pantalla las muestra igual y el operario no
 * tiene cómo saber a quién llamar.
 *
 * **No hace falta modelar nada: Kepler ya lo dice en el código del "proveedor".**
 * Verificado contra `analytics.erp_goods_receipts` en producción (2026-09-02):
 *
 *   `TI###`  traspaso interno   — 1,176 entradas, ~$38.4M
 *            `TI000` = "CENTRO DE DISTRIBUCIÓN ( CEDIS)"
 *            `TI001`…`TI008` = las sucursales
 *   `C###`   proveedor externo  — `CD015` De la Rosa, `CC030` Cueritos Lupita…
 *
 * Y ya está pasando por el Andén: el vale `VE-2026-00013` trae
 * `supplier_code = TI001` con almacén destino `02` — salió de Padre Hidalgo y
 * entró a La Piedad Abastos. O sea que en un traspaso el "proveedor" es el
 * **origen** y el almacén del vale es el **destino**.
 *
 * ⚠️ **Lo que acá NO se hace: traducir `TI###` a una sucursal concreta.** El
 * mapeo no está limpio en el ERP — `TI001` aparece con dos nombres ("PADRE
 * HIDALGO" y "PADRE HIDALGO 322") y `TI005` sale como "ZAMORA CANINDO" y
 * también como "ABASTOS LP", mientras `analytics.transfer_dest_map` dice que
 * Canindo es `TI006`. Esa contradicción la tiene que resolver operaciones, no
 * un heurístico. Hasta entonces se muestra el **nombre que trae el documento**,
 * que es un hecho, en vez de una sucursal deducida, que sería una invención.
 */

export type ReceivingOriginKind = 'supplier' | 'transfer';

export interface ReceivingOrigin {
  kind: ReceivingOriginKind;
  /** `true` sólo para `TI000`, que el ERP nombra explícitamente como el CEDIS. */
  isCedis: boolean;
  /** Etiqueta corta para el chip: "Proveedor" · "CEDIS" · "Traspaso". */
  label: string;
  /** Nombre tal cual lo trae el documento. Nunca deducido. */
  name: string | null;
}

/** Prefijo de traspaso interno en el catálogo de "proveedores" de Kepler. */
const PREFIJO_TRASPASO = /^TI\d/i;

/** El único código que el ERP nombra como el centro de distribución. */
const CODIGO_CEDIS = /^TI0*00$/i;

/**
 * Clasifica el origen a partir del código de proveedor del documento.
 *
 * Sin código no se adivina: cae en `supplier`, que es el caso mayoritario y el
 * que no cambia el comportamiento actual de la pantalla.
 */
export function classifyReceivingOrigin(
  supplierCode: string | null | undefined,
  supplierName?: string | null,
): ReceivingOrigin {
  const code = String(supplierCode ?? '').trim();
  const name = supplierName?.trim() || null;

  if (!PREFIJO_TRASPASO.test(code)) {
    return { kind: 'supplier', isCedis: false, label: 'Proveedor', name };
  }

  const isCedis = CODIGO_CEDIS.test(code);
  return {
    kind: 'transfer',
    isCedis,
    label: isCedis ? 'CEDIS' : 'Traspaso',
    name,
  };
}
