import 'reflect-metadata';
import { SolicitudGastoService } from './solicitud-gasto.service';

/**
 * `[PGP.122.14]` El catálogo de «Pedir un gasto» trae TODOS los conceptos del servidor, también los que no se pueden
 * pedir, cada uno con su motivo. Antes la consulta quitaba los que no tienen cuenta y la pantalla escondía los de activo
 * fijo, SUA, impuestos y capital: el 2026-11-21 se buscó el 364 «PC VERIFICADOR DE PRECIO» (150-002) y no salía nada.
 */
type Fila = { codigo: string; nombre: string; cuenta: string };
function catalogo(filas: Fila[], cedis: Fila[] = []) {
  const sql: string[] = [];
  const trx = {
    raw: async (q: string) => {
      sql.push(q);
      if (q.includes('kepler_ods.kdco') && q.includes("sucursal = '00'")) return { rows: cedis };
      if (q.includes('kepler_ods.kdco')) return { rows: filas };
      return { rows: [] };
    },
  };
  const tk = { run: async <T>(fn: (t: unknown) => Promise<T>) => fn(trx) };
  const svc = new SolicitudGastoService(tk as never, {} as never, {} as never, {} as never);
  (svc as unknown as { base: () => Promise<string> }).base = async () => '01';
  return { leer: () => svc.catalogo('01'), sql };
}

describe('[PGP.122.14] el catálogo trae todo, con el motivo de lo que no se puede pedir', () => {
  it('⭐ el 364 (activo fijo) y el concepto sin cuenta vienen, cada uno con su motivo; el de gasto, sin motivo', async () => {
    const { leer, sql } = catalogo([
      { codigo: '274', nombre: 'ALINEACION Y BALANCEO', cuenta: '' },
      { codigo: '364', nombre: 'PC VERIFICADOR DE PRECIO.', cuenta: '150-002' },
      { codigo: '512', nombre: 'GASOLINA', cuenta: '601-001' },
    ]);
    const r = await leer();
    const motivo = Object.fromEntries(r.conceptos.map((c) => [c.codigo, c.fuera_de_alcance]));
    expect(motivo['364']).toBe('La cuenta 150-002 es de activo fijo, no de gasto: ese renglón se captura en Kepler');
    expect(motivo['274']).toBe('Le falta la cuenta contable en el catálogo de Kepler de 01: se podrá pedir cuando Contabilidad la ponga');
    expect(motivo['512']).toBeNull();
    // La consulta del servidor ya no descarta los conceptos sin cuenta (la de CEDIS sí: compara cuentas).
    const q = sql.find((s) => s.includes('kepler_ods.kdco') && !s.includes("'00'"));
    expect(q).toBeDefined();
    expect(q).not.toMatch(/btrim\(c3\) <> ''/);
  });

  it('R14 sigue igual: el mismo concepto a otro rubro que en CEDIS trae su motivo aparte', async () => {
    const r = await catalogo([{ codigo: '074', nombre: 'CAPITAN DE MARCA.', cuenta: '102' }], [{ codigo: '074', nombre: 'CAPITAN DE MARCA', cuenta: '606-014' }]).leer();
    expect(r.conceptos[0].fuera_de_alcance).toBeNull();
    expect(r.conceptos[0].distinto_de_cedis).toMatch(/va a la cuenta 102 en el Kepler de esta sucursal y a 606-014 en CEDIS/);
  });
});
