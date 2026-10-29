import { ComprasOcAbiertasComponent } from './compras-oc-abiertas.component';

/**
 * `[PQ.28]` El estado de una OC abierta en UNA frase. Antes eran tres columnas con color
 * («Finalizada» + «Falta orden de entrada» + «0 %») que decían lo mismo.
 */
function comp(clasifOk = true) {
  const c = Object.create(ComprasOcAbiertasComponent.prototype) as ComprasOcAbiertasComponent & Record<string, unknown>;
  (c as unknown as { clasifOk: () => boolean }).clasifOk = () => clasifOk;
  return c;
}
const fila = (o: Record<string, unknown>) => ({ _clase: 'x', _claseLabel: 'Falta orden de entrada', estatus: 'F', prob: 0, ...o }) as never;

describe('[PQ.28] OC abiertas — el estado en una frase', () => {
  it('una OC ya convertida en Kepler NO lleva la probabilidad (era el «0 %» en rojo)', () => {
    expect(comp().estadoTexto(fila({ estatus: 'F', prob: 0 }))).toBe('Falta orden de entrada');
  });

  it('una pendiente sí dice cuánto llega, en la misma frase', () => {
    expect(comp().estadoTexto(fila({ estatus: 'N', _claseLabel: 'Sin vale', prob: 35 }))).toBe('Sin vale · llega 35 %');
  });

  it('las órdenes internas dejaron de ser pestaña pero siguen alcanzables desde aquí, con su permiso', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, 'compras-oc-abiertas.component.ts'), 'utf8');
    expect(src).toMatch(/@if \(puedeHistorico\) \{[^}]*routerLink="\/compras\/ordenes"/);
    expect(src).toContain('Permission.COMPRAS_ORDENES_VER');
  });

  it('NEGATIVA: sin la clasificación del servidor no inventa una: usa el estatus de Kepler', () => {
    expect(comp(false).estadoTexto(fila({ estatus: 'R', prob: null }))).toBe('Recibida');
  });
});
