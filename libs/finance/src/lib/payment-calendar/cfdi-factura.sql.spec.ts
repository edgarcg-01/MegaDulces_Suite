import { SQL_CFDIS_CANCELADOS, SQL_CFDIS_CANDIDATOS, SQL_LLAVES_DE_OBLIGACIONES, SQL_LLAVES_DE_RENGLONES, SQL_PAGADAS_CANCELADAS, SQL_PROVEEDORES_69B } from './cfdi-factura.sql';

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

describe('[PGP.178] las pagadas que el proveedor canceló: la misma liga del CFDI, los mismos pagos del cierre', () => {
  it('parte de los acreedores del día, último año, cancelados sin sustituta por el total ni por lo pagado', () => {
    expect(SQL_PAGADAS_CANCELADAS).toContain("c.estatus_sat = 'cancelado'");
    expect(SQL_PAGADAS_CANCELADAS).toContain('c.emisor_rfc = ANY(?::text[])');
    expect(SQL_PAGADAS_CANCELADAS).toContain("interval '365 days'");
    expect(SQL_PAGADAS_CANCELADAS).toContain('abs(f.importe - c.total) <= 1');
    expect(SQL_PAGADAS_CANCELADAS).toContain('c.f >= f.f_kep - 45 AND c.f < f.f_kep + 6');
    expect(SQL_PAGADAS_CANCELADAS).toContain('k.c4 IN (25, 26, 60)');
    expect(SQL_PAGADAS_CANCELADAS).toContain('abs(v.total - g.pagado) <= 1');
    expect(SQL_PAGADAS_CANCELADAS.split('?').length - 1).toBe(6);
  });
});

describe('[PGP.225] el freno lee lo mismo que la pantalla, desde la obligación', () => {
  it('la llave de la factura capturada es la MISMA desde el renglón y desde la obligación', () => {
    const llave = (sql: string) => /THEN (md5(.*)::uuid)/.exec(sql)?.[1];
    expect(llave(SQL_LLAVES_DE_OBLIGACIONES)).toBeTruthy();
    expect(llave(SQL_LLAVES_DE_OBLIGACIONES)).toBe(llave(SQL_LLAVES_DE_RENGLONES));
    expect(llave(SQL_LLAVES_DE_RENGLONES)).toContain("md5('kepler_payable|' || o.kepler_sucursal");
  });
  it('la obligación capturada se busca en su tenant; la derivada ya es su llave', () => {
    expect(SQL_LLAVES_DE_OBLIGACIONES).toContain("WHEN p.source = 'kepler_payable' THEN p.id");
    expect(SQL_LLAVES_DE_OBLIGACIONES).toContain('o.tenant_id = ?');
    expect(SQL_LLAVES_DE_OBLIGACIONES.split('?').length - 1).toBe(4);
  });
  it('los candidatos traen lo que lee la norma (y los cancelados también)', () => {
    for (const sql of [SQL_CFDIS_CANDIDATOS, SQL_CFDIS_CANCELADOS]) {
      expect(sql).toContain('c.estatus_sat, c.receptor_uso_cfdi, c.receptor_regimen, c.emisor_regimen');
    }
  });
});
