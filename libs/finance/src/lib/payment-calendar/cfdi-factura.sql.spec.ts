import { SQL_CFDIS_CANCELADOS, SQL_CFDIS_CANDIDATOS } from './cfdi-factura.sql';

describe('[PGP.163] los candidatos cancelados son los MISMOS con el estatus al revés', () => {
  it('sólo cambia el filtro de estatus del SAT', () => {
    expect(SQL_CFDIS_CANDIDATOS).toContain("c.estatus_sat <> 'cancelado'");
    expect(SQL_CFDIS_CANCELADOS).toContain("c.estatus_sat = 'cancelado'");
    expect(SQL_CFDIS_CANCELADOS).not.toContain("<> 'cancelado'");
    expect(SQL_CFDIS_CANCELADOS.replace("= 'cancelado'", "<> 'cancelado'")).toBe(SQL_CFDIS_CANDIDATOS);
  });
});
