import { SQL_CFDIS_CANCELADOS, SQL_CFDIS_CANDIDATOS, SQL_PROVEEDORES_69B } from './cfdi-factura.sql';

describe('[PGP.177] el proveedor en la 69-B se busca por su llave, sólo presunto o definitivo', () => {
  it('lista 69B, las dos situaciones que piden algo, por RFC', () => {
    expect(SQL_PROVEEDORES_69B).toContain("r.lista = '69B'");
    expect(SQL_PROVEEDORES_69B).toContain("r.situacion IN ('Presunto', 'Definitivo')");
    expect(SQL_PROVEEDORES_69B).toContain('r.rfc = ANY(?::text[])');
    expect(SQL_PROVEEDORES_69B).not.toMatch(/Desvirtuado|Sentencia/);
  });
});

describe('[PGP.163] los candidatos cancelados son los MISMOS con el estatus al revés', () => {
  it('sólo cambia el filtro de estatus del SAT', () => {
    expect(SQL_CFDIS_CANDIDATOS).toContain("c.estatus_sat <> 'cancelado'");
    expect(SQL_CFDIS_CANCELADOS).toContain("c.estatus_sat = 'cancelado'");
    expect(SQL_CFDIS_CANCELADOS).not.toContain("<> 'cancelado'");
    expect(SQL_CFDIS_CANCELADOS.replace("= 'cancelado'", "<> 'cancelado'")).toBe(SQL_CFDIS_CANDIDATOS);
  });
});
