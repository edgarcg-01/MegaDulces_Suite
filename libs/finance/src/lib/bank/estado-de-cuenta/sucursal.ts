/**
 * `[CB.61]` La sucursal (la «S» del libro: la unidad de negocio, VERDAD_ABSOLUTA §37.1) de un renglón
 * del banco, SIN que Tesorería la escriba.
 *
 * El banco no dice la sucursal, pero trae una LLAVE que pertenece a una: la terminal de venta con tarjeta
 * (`VENTAS DEBITO/145096809`), la afiliación (`AFIL.-007760888`), la tarjeta de la empresa con que se pagó
 * (`Tarjeta 5161020005170990`) o el propio concepto del banco. La
 * sucursal de cada llave se APRENDE de los pares banco↔libro de días ANTERIORES (nunca del mismo día: eso
 * sería medirse contra sí mismo), y sólo cuenta una llave PURA: la que en lo aprendido tuvo una sola S.
 *
 * Medido en prod (2026-11-10, 15 cuentas): aprendiendo del 1 al 5-nov y probando del 6 al 10, la sucursal
 * sale en 278 de 322 movimientos y acierta 272 (98 %); barajando la S de lo aprendido, 22 de 52. Las
 * compras con tarjeta en casetas y gasolineras se cargan a otra unidad que el concepto no anticipa: ahí sólo
 * cuenta la tarjeta.
 *
 * ⛔ El documento de Kepler NO es llave: su sucursal es la SUCURSAL y una sucursal tiene varias unidades
 * (Morelia Abastos = 30 y su telemarketing = 73). Con él, el servicio real en prod deducía 542 y acertaba
 * 93.5 %; sin él, 428 al 98.1 %; además pidiendo que la llave se haya visto 2 veces, 383 al 99.0 %.
 */

export type LlaveDeSucursal = 'terminal' | 'afiliacion' | 'tarjeta' | 'concepto';

/** Una llave se cree cuando es pura y se vio al menos estas veces (medido: 1 → 98.1 %, 2 → 99.0 %, 3 → 99.2 %). */
const VECES_MINIMAS = 2;

export interface RenglonParaSucursal {
  amount_in: number | string;
  concepto?: string | null;
  referencia?: string | null;
}

const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();

/** Las llaves del renglón, de la más específica a la más general. */
export function llavesDeSucursal(r: RenglonParaSucursal): [LlaveDeSucursal, string][] {
  const t = norm(r.concepto), ref = norm(r.referencia);
  const out: [LlaveDeSucursal, string][] = [];
  const tarjeta = t.match(/TARJETA (\d{16})/);
  if (tarjeta) out.push(['tarjeta', tarjeta[1]]);
  const terminal = t.match(/(?:VENTAS (?:CREDITO|DEBITO)|TASA DE DESC? (?:CREDITO|DEBITO)|V(?:EN)?TAS TDC INTER|VENTA NAL\. AMEX|VTA\. NAL\. AMEX)\/(\d{6,})/);
  if (terminal) out.push(['terminal', terminal[1]]);
  const afil = `${ref} ${t}`.match(/AFIL\.?-?(\d{6,})|COMISION (\d{6,})[CD]|IVA COMISION (\d{6,})[CD]/);
  if (afil) out.push(['afiliacion', afil[1] || afil[2] || afil[3]]);
  // La compra con tarjeta se carga a quien trae la tarjeta, no al lugar (caseta, gasolinera).
  if (!tarjeta) out.push(['concepto', `${Number(r.amount_in) > 0 ? 'D' : 'R'}|${t.replace(/[0-9]+/g, '#')}`]);
  return out;
}

/** Lo aprendido de una cuenta: cada llave con las sucursales que tuvo. */
export class MapaDeSucursal {
  private readonly vistas = new Map<string, Set<string>>();
  private readonly veces = new Map<string, number>();


  aprender(r: RenglonParaSucursal, sucursal: string): void {
    for (const [tipo, k] of llavesDeSucursal(r)) {
      const id = `${tipo}|${k}`;
      (this.vistas.get(id) ?? this.vistas.set(id, new Set()).get(id)!).add(sucursal);
      this.veces.set(id, (this.veces.get(id) ?? 0) + 1);
    }
  }

  /** La sucursal de la primera llave PURA (una sola S en lo aprendido), o `null`: no se adivina. */
  deducir(r: RenglonParaSucursal): { sucursal: string; por: LlaveDeSucursal } | null {
    for (const [tipo, k] of llavesDeSucursal(r)) {
      const s = this.vistas.get(`${tipo}|${k}`);
      if (s && s.size === 1 && (this.veces.get(`${tipo}|${k}`) ?? 0) >= VECES_MINIMAS) return { sucursal: [...s][0], por: tipo };
    }
    return null;
  }
}
