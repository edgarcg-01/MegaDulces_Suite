import {
  SQL_ES_CHEQUE_EMITIDO, SQL_LIBERADOS_QUE_SALIERON, SQL_PENDIENTES_VENCIDOS, SQL_SALIDA_DE_BANCO, notaReabierto, paramsSalidaDeBanco, testigoDelBanco,
} from './pagos-vencidos.sql';

/**
 * `[PGP.173]` La lectura de los vencidos trae si el pago es un cheque emitido. El predicado contra Postgres real corre en
 * `database/tests/test-newdb-pgp173-cheque-no-se-libera.js`; aquí, que la consulta lo trae y no cambió sus parámetros.
 */
describe('[PGP.173] los vencidos dicen si son un cheque emitido', () => {
  it('la consulta trae `cheque_emitido` con el predicado compartido, y sigue pidiendo [tenant, hoy]', () => {
    expect(SQL_PENDIENTES_VENCIDOS).toContain(`${SQL_ES_CHEQUE_EMITIDO} AS cheque_emitido`);
    expect((SQL_PENDIENTES_VENCIDOS.match(/\?/g) ?? []).length).toBe(2);
  });

  it('el predicado exige método cheque Y un número en la referencia', () => {
    expect(SQL_ES_CHEQUE_EMITIDO).toContain(`a.payment_method = 'cheque'`);
    expect(SQL_ES_CHEQUE_EMITIDO).toContain(`~ '[0-9]{3,}'`);
  });
});

/**
 * `[PGP.149]` El testigo del banco de la liberación a la semana. La consulta corre contra base real en
 * `database/tests/test-newdb-pgp149-liberacion-mira-la-descarga.js`; aquí, lo que se puede probar sin base.
 */
describe('[PGP.149] el testigo del banco de la liberación', () => {
  it('salió gana; «no salió» sólo con la descarga cubriendo esos días; sin fila, NO MEDIDO', () => {
    expect(testigoDelBanco({ salio: true, cubierto: false })).toBe(true);
    expect(testigoDelBanco({ salio: false, cubierto: true })).toBe(false);
    // ⛔ El caso del 17-nov: el libro parado no es «no salió».
    expect(testigoDelBanco({ salio: false, cubierto: false })).toBeNull();
    expect(testigoDelBanco(undefined)).toBeNull();
  });

  it('los parámetros van en el orden y la cantidad de los «?» de la consulta', () => {
    const p = paramsSalidaDeBanco('t', '2026-11-18', [{ id: 'a', monto: 1, lot_date: '2026-11-10', cuenta: null }]);
    expect(p).toHaveLength((SQL_SALIDA_DE_BANCO.match(/\?/g) ?? []).length);
    // cobertura · libro · descarga · [PGP.201] pago partido · cubierto
    expect(p.slice(0, 8)).toEqual(['t', 't', '2026-11-18', 't', '2026-11-18', 't', '2026-11-18', '2026-11-18']);
    expect(p.slice(8)).toEqual([['a'], [1], ['2026-11-10'], [null]]);
    expect((SQL_LIBERADOS_QUE_SALIERON.match(/\?/g) ?? []).length).toBe(1);
  });

  it('la nota del regresado dice cuándo salió, de qué cuenta y qué liberación no lo vio', () => {
    expect(notaReabierto('2026-11-19', { fecha: '2026-11-10', cuenta: 'BBVA 4176', importe: 779912.56, liberado: '2026-11-17' }))
      .toBe('[regresado 2026-11-19] Salió del banco el 2026-11-10 (BBVA 4176, $779912.56): la liberación del 2026-11-17 no lo vio porque el estado de cuenta del Calendario no tenía esa salida. Sus facturas vuelven a quedar apartadas por este pago.');
  });
});
