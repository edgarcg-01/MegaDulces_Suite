/**
 * `[PQ.131]` La recepción según Kepler (`[PQ.26]`) costaba 455 ms en CADA lectura de la bandeja y de la
 * ficha (5,505 corridas medidas en prod el 2026-11-18, 119 filas cambiadas en total). Se mide el
 * código, como `requisicion-oc.spec.ts`: el servicio pide Nest y una base para construirse.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
// Sin `import ... from 'vitest'`: la config usa `globals: true` (ver requisicion-oc.spec.ts).

const SVC = readFileSync(join(__dirname, 'commercial-replenishment.service.ts'), 'utf8');
const CODIGO = SVC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

function cuerpo(nombre: string): string {
  const i = CODIGO.indexOf(`${nombre}(`);
  if (i < 0) throw new Error(`No existe ${nombre}()`);
  const resto = CODIGO.slice(i + nombre.length);
  const fin = resto.search(/\n {2}(?:async |private |\/\*\* |[a-zA-Z]+\()/);
  return fin < 0 ? CODIGO.slice(i) : CODIGO.slice(i, i + nombre.length + fin);
}

describe('[PQ.131] la recepción según Kepler no la espera la bandeja', () => {
  const asociar = cuerpo('private async asociarOcDeKepler');
  const recepcion = cuerpo('private async marcarRecibidasSegunKepler');

  it('⛔ el UPDATE de «recibida» ya no corre dentro de asociarOcDeKepler (que la bandeja espera)', () => {
    expect(asociar).not.toContain(`SET estado = 'received'`);
    expect(asociar).not.toContain('erp_purchase_orders');
  });

  it('se lanza sin esperarlo, desde la misma lectura (sin reloj)', () => {
    expect(asociar).toContain('void this.marcarRecibidasSegunKepler(tenantId)');
    expect(asociar).not.toMatch(/await this\.marcarRecibidasSegunKepler/);
  });

  it('a lo más cada 5 minutos por tenant, y con el mismo decode de siempre', () => {
    expect(recepcion).toContain('5 * 60_000');
    expect(recepcion).toContain('this.ultimaRecepcion.get(tenantId)');
    expect(recepcion).toContain(`SET estado = 'received'`);
    expect(recepcion).toContain('FROM analytics.erp_purchase_orders o');
    expect(recepcion).toContain('AND o.cerrada');
  });

  it('el ligado barato (PQ.25, 2 ms) sigue dentro: la OC recién ligada se ve en la misma lectura', () => {
    expect(asociar).toContain(`SET estado = 'ordered', oc_sucursal = r.kepler_sucursal, oc_folio = o.oc`);
  });
});
