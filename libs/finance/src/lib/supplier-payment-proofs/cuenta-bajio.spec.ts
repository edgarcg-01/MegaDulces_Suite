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

/**
 * `[PC.7]` ⛔ **La causa raíz estaba en la instrucción del OCR**: pedía «si es larga, los últimos 4
 * dígitos». En BanBajío los últimos 4 son `0201` en TODAS las cuentas, así que la lectura guardaba
 * `0201` y ninguna regla posterior podía saber de qué cuenta salió el pago («todas marcan la misma
 * cuenta», reporte del 2026-10-04). La lectura tiene que traer el número completo.
 */
describe('[PC.7] el OCR del comprobante lee la cuenta COMPLETA', () => {
  const EXTRACTOR = readFileSync(join(__dirname, '..', '..', '..', '..', 'platform-core', 'src', 'lib', 'ai', 'llm-extractor.service.ts'), 'utf8');
  const tool = EXTRACTOR.slice(EXTRACTOR.indexOf("name: 'extract_supplier_payment'"), EXTRACTOR.indexOf("required: ['monto', 'fecha', 'concepto', 'cuenta_origen'"));
  const campo = (k: string) => { const i = tool.indexOf(`${k}: {`); return tool.slice(i, tool.indexOf('},', i)); };

  it.each(['cuenta_origen', 'cuenta_destino'])('⛔ %s ya no pide recortar a los últimos dígitos', (k) => {
    expect(campo(k)).toContain('COMPLETO');
    expect(campo(k)).not.toMatch(/[ÚU]ltimos 4|los últimos 4 dígitos\. null/);
  });

  it('cuenta_origen explica el caso BanBajío con un ejemplo real', () => {
    expect(campo('cuenta_origen')).toContain('245765060201');
    expect(campo('cuenta_origen')).toContain('NUNCA lo recortes');
  });

  it('«Volver a comparar» recalcula también la alerta de cuenta ajena con la regla vigente', () => {
    const recheck = SERVICIO.slice(SERVICIO.indexOf('async recheck('), SERVICIO.indexOf('async detail('));
    expect(recheck).toContain('const tails = await this.ownBankTails(trx)');
    expect(recheck).toContain('cuenta_propia: this.isOwnAccount(p.ocr_cuenta_origen, tails)');
  });
});
