/**
 * `[CP.8.87]` — **Cotejar una póliza armada contra la que capturó la contadora.** Puro, sin base.
 *
 * Es la regla de `database/scripts/comparar-armado-contpaqi.js` (`[CP.8.81]`), traída al producto para que el
 * contador vea —antes de firmar una categoría «por proveedor»— cuántas pólizas de ese mes saldrían iguales a las
 * suyas. Se empareja por la pata de banco: misma cuenta, mismo importe, mismo día (si no, ±3 días); con más de una
 * candidata desempata la cuenta de gasto/proveedor; una póliza real se usa una vez.
 *
 *   igual     Σ por (cuenta, cargo/abono) idéntica a ±$0.02
 *   difiere   alguna cuenta falta, sobra o trae otro importe
 *   agrupada  la póliza real junta este pago con otros movimientos de banco
 *   sin_par   no hay póliza real con esa pata de banco (no capturada, otra fecha, otro importe)
 *   ambigua   dos o más candidatas que no se distinguen
 */

export interface RenglonCotejo { cuenta: string; abono: boolean; importe: number }
export interface PolizaReal { k: string; fecha: string; renglones: RenglonCotejo[] }
export interface PolizaArmadaCotejo { clave: string; fecha: string; renglones: RenglonCotejo[] }
export type ResultadoCotejo = 'igual' | 'difiere' | 'agrupada' | 'sin_par' | 'ambigua';

const cent = (n: number): number => Math.round(Number(n) * 100);
const esBanco = (c: string): boolean => /^102/.test(c);
const dias = (a: string, b: string): number => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);

function huella(rs: RenglonCotejo[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rs) { const k = `${r.cuenta}|${r.abono ? 'A' : 'C'}`; m.set(k, (m.get(k) ?? 0) + cent(r.importe)); }
  return m;
}

/** ¿Dos asientos cargan y abonan lo mismo a las mismas cuentas (±2 centavos por cuenta)? */
export function mismoAsiento(a: RenglonCotejo[], b: RenglonCotejo[]): boolean {
  const A = huella(a), B = huella(b);
  for (const k of new Set([...A.keys(), ...B.keys()])) if (Math.abs((A.get(k) ?? 0) - (B.get(k) ?? 0)) > 2) return false;
  return true;
}

export function cotejar(armadas: PolizaArmadaCotejo[], reales: PolizaReal[]): Map<string, ResultadoCotejo> {
  const porBanco = new Map<string, PolizaReal[]>();
  for (const p of reales) {
    for (const r of p.renglones.filter((x) => x.abono && esBanco(x.cuenta))) {
      const k = `${r.cuenta}|${cent(r.importe)}`;
      const xs = porBanco.get(k); if (xs) xs.push(p); else porBanco.set(k, [p]);
    }
  }
  const usadas = new Set<string>();
  const out = new Map<string, ResultadoCotejo>();
  for (const a of armadas) {
    const bancos = a.renglones.filter((x) => x.abono && esBanco(x.cuenta));
    if (bancos.length !== 1) { out.set(a.clave, 'agrupada'); continue; }
    const b = bancos[0];
    const libres = (porBanco.get(`${b.cuenta}|${cent(b.importe)}`) ?? []).filter((p) => !usadas.has(p.k));
    let c = libres.filter((p) => dias(p.fecha, a.fecha) === 0);
    if (!c.length) c = libres.filter((p) => Math.abs(dias(p.fecha, a.fecha)) <= 3);
    if (c.length > 1) {
      const clave = a.renglones.find((x) => !x.abono && !/^(102|1060|1470)/.test(x.cuenta));
      const conClave = clave ? c.filter((p) => p.renglones.some((r) => !r.abono && r.cuenta === clave.cuenta)) : [];
      if (conClave.length === 1) c = conClave;
    }
    if (!c.length) { out.set(a.clave, 'sin_par'); continue; }
    if (c.length > 1) { out.set(a.clave, 'ambigua'); continue; }
    usadas.add(c[0].k);
    if (c[0].renglones.filter((x) => x.abono && esBanco(x.cuenta)).length > 1) { out.set(a.clave, 'agrupada'); continue; }
    out.set(a.clave, mismoAsiento(a.renglones, c[0].renglones) ? 'igual' : 'difiere');
  }
  return out;
}
