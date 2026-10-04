import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `[PC.8]` — La lista de pagos declara CUÁNTO TARDÓ cada una de sus consultas. En prod la página
 * tarda 5–6 s y no se pudo reproducir (600k documentos sintéticos: ~110 ms; pantalla con API
 * simulada: ~1.2 s): el dato que falta es de prod y tiene que poder leerse sin abrir logs.
 */
const soloCodigo = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SERVICIO = soloCodigo(readFileSync(join(__dirname, 'supplier-payment-proofs.service.ts'), 'utf8'));
const CONTROLLER = soloCodigo(readFileSync(join(__dirname, 'supplier-payment-proofs.controller.ts'), 'utf8'));
const lista = SERVICIO.slice(SERVICIO.indexOf('async listPayments('), SERVICIO.indexOf('async uploadFile('));

describe('[PC.8] tiempos de la lista de pagos', () => {
  it('mide las TRES consultas por separado', () => {
    expect(lista).toContain("medir('duplicados',");
    expect(lista).toContain("medir('filas', b)");
    expect(lista).toContain("medir('kpis', kpiBase.select(");
  });
  it('los devuelve en la respuesta y avisa en el log arriba de 1 s', () => {
    expect(lista).toContain('return { ...out, tiempos_ms: tiempos }');
    expect(lista).toContain('if (tiempos.total > 1000)');
    expect(lista).toContain('this.logger.warn(');
  });
  it('el controller los publica en Server-Timing (DevTools → Network → Timing)', () => {
    expect(CONTROLLER).toContain("@Res({ passthrough: true }) res?: ConEncabezados");
    expect(CONTROLLER).toContain("res?.setHeader('Server-Timing'");
    expect(CONTROLLER).toMatch(/duplicados;dur=.*filas;dur=.*kpis;dur=.*total;dur=/);
  });
});
