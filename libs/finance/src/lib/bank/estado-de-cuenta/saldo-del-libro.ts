/**
 * `[CB.59]` El saldo con que CERRÓ un día del libro «CUENTAS», reconstruido por la cadena de saldos.
 *
 * El libro no guarda el orden de los renglones dentro del día: `created_at` es el de la importación,
 * no el del banco. Medido en prod el 2026-11-05: el 30-oct de BTE 7744 tiene cuatro renglones y el
 * «último por created_at» daba $256,526.33; el cierre real era $16,254.00 —exactamente el saldo
 * inicial con que arranca la descarga del banco—, así que la cuenta no se podía atestiguar.
 *
 * Cada renglón dice de qué saldo viene (saldo − abono + cargo). El cierre es el único saldo del que
 * no viene ningún otro renglón. Si hay cero o más de uno, el día no tiene un cierre que se pueda
 * afirmar y se devuelve `null`: mejor «sin testigo» que un testigo inventado.
 */
export interface RenglonDelLibro {
  amount_in: number | string | null;
  amount_out: number | string | null;
  running_balance: number | string | null;
}

const centavos = (v: number | string | null) => Math.round(Number(v ?? 0) * 100);

export function cierreDelDia(renglones: readonly RenglonDelLibro[]): number | null {
  const conSaldo = renglones.filter((r) => r.running_balance !== null && r.running_balance !== undefined);
  if (!conSaldo.length) return null;
  const previos = new Set(conSaldo.map((r) => centavos(r.running_balance) - centavos(r.amount_in) + centavos(r.amount_out)));
  const cierres = conSaldo.filter((r) => !previos.has(centavos(r.running_balance)));
  return cierres.length === 1 ? centavos(cierres[0].running_balance) / 100 : null;
}
