import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[PC.7]` — Los tres lugares del servicio que reconocen una cuenta propia leen el número con
 * `cuentaEsClave` (libs/contracts), que entiende BanBajío (la clave en el CENTRO del número de 12
 * dígitos). La regla se prueba en `coincidencia-pago.spec.ts` con los números reales de BajioNet;
 * aquí, que nadie vuelva a comparar por el final a mano.
 */
const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'supplier-payment-proofs.service.ts'), 'utf8'));
const tramo = (desde: string, hasta: string) => SERVICIO.slice(SERVICIO.indexOf(desde), SERVICIO.indexOf(hasta, SERVICIO.indexOf(desde) + 1));

describe('[PC.7] cuentas propias con la regla de libs/contracts', () => {
  it('isOwnAccount (alerta «cuenta ajena») usa cuentaEsClave con el banco de cada cuenta', () => {
    const f = tramo('private isOwnAccount(', 'private parseDataUri(');
    expect(f).toContain('cuentaEsClave(c, t.account_label, t.bank)');
    expect(f).not.toContain('.endsWith(');
  });
  it('findOwnAccountId (cargo del banco) usa cuentaEsClave con el banco de cada cuenta', () => {
    const f = tramo('private async findOwnAccountId(', 'private async ownBankTails(');
    expect(f).toContain('cuentaEsClave(cuenta, a.account_label, a.bank)');
    expect(f).not.toContain('.endsWith(');
  });
  it('ownBankTails trae el banco junto con la etiqueta', () => {
    expect(tramo('private async ownBankTails(', 'private isOwnAccount(')).toContain(".select('bank', 'account_label')");
  });
  it('pagoParaCoincidir trae el nombre del banco de Kepler (decide cómo se lee la cuenta)', () => {
    expect(tramo('private async pagoParaCoincidir(', 'async recheck(')).toContain("'kb.banco_nombre'");
  });
});
