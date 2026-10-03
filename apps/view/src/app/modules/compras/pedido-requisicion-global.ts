/**
 * `[RA-PRO.54]` Agrupación de la requisición GLOBAL por proveedor, aislada del componente para
 * probarla sin Angular (ADR-056: lo que decide un número se prueba).
 *
 * Entra una lista plana de renglones de compra (producto × sucursal que lo necesita, con dónde lo
 * ENTREGA el proveedor) y sale una hoja por proveedor con:
 *  - sus puntos de entrega (cada uno = una requisición del sistema = una O. Compra a mano);
 *  - el pedido por producto, con la cantidad que llega a cada punto;
 *  - la repartición: por cada punto que recibe consolidado, cuánto le toca a cada sucursal.
 *
 * Es la misma agrupación que usa `buildReq` para registrar (proveedor × punto de entrega), así que
 * el papel y el sistema cuentan las mismas requisiciones.
 */

import type { EtiquetaUnidades, PedidoTipicoEval } from './pedido-redondeo';

export interface LineaCompra {
  supplierId: string | null;
  supplierName: string;
  productId: string;
  sku: string; nombre: string;
  uxc: number; unidad: string;
  /** [RA-PRO.68] Rótulos de mayor a menor (cj · paq · pz). Opcional: sin ellos el PDF dice cj/pz como antes. */
  et?: EtiquetaUnidades;
  branchCode: string; branchName: string;   // la sucursal que NECESITA la mercancía
  entregaCode: string; entregaName: string; // dónde la entrega el proveedor (= branch si es directo)
  cajas: number;
  valor: number;
}

export interface PuntoEntrega {
  code: string; name: string;
  consolidado: boolean;   // recibe para otras sucursales (hay traspasos que salen de aquí)
  cajas: number; valor: number;
}
export interface ProductoProveedor {
  productId: string; sku: string; nombre: string; uxc: number; unidad: string; et?: EtiquetaUnidades;
  porPunto: Record<string, number>;   // entregaCode → cajas
  cajas: number; valor: number;
}
export interface RepartoPunto {
  code: string; name: string;
  destinos: { code: string; name: string }[];              // columnas, en orden de aparición
  filas: { productId: string; sku: string; nombre: string; uxc: number; et?: EtiquetaUnidades; porDestino: Record<string, number> }[];
}
export interface HojaProveedor {
  supplierId: string | null; supplierName: string;
  puntos: PuntoEntrega[];
  productos: ProductoProveedor[];
  repartos: RepartoPunto[];
  cajas: number; valor: number;
  nTraspasos: number;
  /** [RA-PRO.69] Pedido típico del proveedor (derivado del historial; referencia, NO mínimo). */
  tipico?: PedidoTipicoEval;
}

/**
 * Orden alfabético por nombre de producto, como se lee en español: sin distinguir mayúsculas ni
 * acentos, y con los números en orden natural ("15X25" antes que "120X90"). Empate → código.
 */
const COLLATOR = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
export const porNombre = (a: { nombre: string; sku: string }, b: { nombre: string; sku: string }) =>
  COLLATOR.compare((a.nombre || '').trim(), (b.nombre || '').trim()) || COLLATOR.compare(a.sku || '', b.sku || '');

export function agruparPorProveedor(lineas: LineaCompra[]): HojaProveedor[] {
  const hojas = new Map<string, HojaProveedor>();
  const orden = (s: string | null, n: string) => `${s ?? 'none'}|${n}`;

  for (const l of lineas) {
    if (!(l.cajas > 0)) continue;
    const k = orden(l.supplierId, l.supplierName);
    let h = hojas.get(k);
    if (!h) {
      h = { supplierId: l.supplierId, supplierName: l.supplierName, puntos: [], productos: [], repartos: [], cajas: 0, valor: 0, nTraspasos: 0 };
      hojas.set(k, h);
    }
    h.cajas += l.cajas; h.valor += l.valor;

    const traspaso = l.entregaCode !== l.branchCode;

    let p = h.puntos.find((x) => x.code === l.entregaCode);
    if (!p) { p = { code: l.entregaCode, name: l.entregaName, consolidado: false, cajas: 0, valor: 0 }; h.puntos.push(p); }
    p.cajas += l.cajas; p.valor += l.valor;
    if (traspaso) { p.consolidado = true; h.nTraspasos++; }

    let pr = h.productos.find((x) => x.productId === l.productId);
    if (!pr) {
      pr = { productId: l.productId, sku: l.sku, nombre: l.nombre, uxc: l.uxc, unidad: l.unidad, et: l.et, porPunto: {}, cajas: 0, valor: 0 };
      h.productos.push(pr);
    }
    pr.porPunto[l.entregaCode] = (pr.porPunto[l.entregaCode] ?? 0) + l.cajas;
    pr.cajas += l.cajas; pr.valor += l.valor;
  }

  // La repartición se arma DESPUÉS: un punto es "consolidado" si al menos una línea baja de él, y
  // entonces su propio pedido (si lo tiene) también va en su cuadro, como "se queda".
  for (const h of hojas.values()) {
    for (const p of h.puntos.filter((x) => x.consolidado)) {
      const rp: RepartoPunto = { code: p.code, name: p.name, destinos: [], filas: [] };
      for (const l of lineas) {
        if (!(l.cajas > 0) || l.entregaCode !== p.code || orden(l.supplierId, l.supplierName) !== orden(h.supplierId, h.supplierName)) continue;
        if (!rp.destinos.some((d) => d.code === l.branchCode)) rp.destinos.push({ code: l.branchCode, name: l.branchName });
        let f = rp.filas.find((x) => x.productId === l.productId);
        if (!f) { f = { productId: l.productId, sku: l.sku, nombre: l.nombre, uxc: l.uxc, et: l.et, porDestino: {} }; rp.filas.push(f); }
        f.porDestino[l.branchCode] = (f.porDestino[l.branchCode] ?? 0) + l.cajas;
      }
      // El propio CEDIS ("se queda") primero; el resto en el orden en que aparecen.
      rp.destinos.sort((a, b) => Number(b.code === p.code) - Number(a.code === p.code));
      h.repartos.push(rp);
    }
    // Consolidados primero (son los que generan traspasos), después por valor.
    h.puntos.sort((a, b) => Number(b.consolidado) - Number(a.consolidado) || b.valor - a.valor);
    // [RA-PRO.56] Productos en orden ALFABÉTICO, en el pedido y en cada repartición: con el papel
    // en la mano frente a la mercancía, se busca por nombre, no por cuánto se pidió.
    h.productos.sort(porNombre);
    for (const rp of h.repartos) rp.filas.sort(porNombre);
  }

  return [...hojas.values()].sort((a, b) => b.valor - a.valor);
}

/**
 * `[RA-PRO.53]` Repartición de UN producto, para el PDF por producto: un bloque por CEDIS que
 * recibe consolidado —su propia sucursal "se queda" primero, las demás bajan por traspaso— y un
 * bloque final (`receptor: null`) con lo que el proveedor entrega directo en cada sucursal.
 *
 * `entregaCode` null o igual a la sucursal = entrega directa (consolidar en uno mismo no es
 * consolidar). Los CEDIS receptores se ordenan por cajas, de mayor a menor.
 */
export interface RenglonSucursal { branchCode: string; entregaCode: string | null; cajas: number; }
export interface GrupoReparto<T> { receptor: string | null; cajas: number; filas: { item: T; seQueda: boolean }[]; }

export function repartoProducto<T extends RenglonSucursal>(items: T[]): GrupoReparto<T>[] {
  const vivos = items.filter((i) => i.cajas > 0);
  const destino = (i: T) => (i.entregaCode && i.entregaCode !== i.branchCode ? i.entregaCode : null);

  const receptores = new Map<string, number>();
  for (const i of vivos) {
    const d = destino(i);
    if (d) receptores.set(d, (receptores.get(d) ?? 0) + i.cajas);
  }
  const grupos: GrupoReparto<T>[] = [];
  for (const code of [...receptores.keys()]) {
    const queda = vivos.filter((i) => i.branchCode === code && !destino(i));
    const bajan = vivos.filter((i) => destino(i) === code);
    const filas = [...queda.map((item) => ({ item, seQueda: true })), ...bajan.map((item) => ({ item, seQueda: false }))];
    grupos.push({ receptor: code, cajas: filas.reduce((s, f) => s + f.item.cajas, 0), filas });
  }
  grupos.sort((a, b) => b.cajas - a.cajas);

  // Directo: lo que no baja de un CEDIS y no es el propio pedido de un CEDIS receptor (ese ya
  // salió arriba como "se queda").
  const directas = vivos.filter((i) => !destino(i) && !receptores.has(i.branchCode));
  if (directas.length) {
    grupos.push({ receptor: null, cajas: directas.reduce((s, i) => s + i.cajas, 0), filas: directas.map((item) => ({ item, seQueda: false })) });
  }
  return grupos;
}
