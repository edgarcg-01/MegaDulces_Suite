import {
  SQL_ES_CHEQUE_EMITIDO, SQL_LIBERADOS_QUE_SALIERON, SQL_PENDIENTES_VENCIDOS, SQL_SALIDA_DE_BANCO, notaReabierto, paramsSalidaDeBanco, testigoDelBanco,
} from './pagos-vencidos.sql';
import { SQL_COBERTURA_DE_LA_DESCARGA, sqlCuentaDormida } from './pago-por-el-banco.sql';

/**
 * `[PGP.202]` La cuenta dormida (sin descarga nunca y sin pagos de Kepler desde ella en 90 días) no frena el «no salió» del
 * pago sin cuenta preparada; el preparado en ella sigue sin poder afirmarse. Medido contra prod el 2026-11-23 (sólo
 * lectura): una cuenta así frenaba todas las liberaciones; la consulta de la cuenta tarda ~20 ms.
 */
describe('[PGP.202] la cuenta dormida en la cobertura del banco', () => {
  it('la liberación y la pantalla usan EL MISMO fragmento, sin parámetros nuevos', () => {
    expect(SQL_SALIDA_DE_BANCO).toContain(`${sqlCuentaDormida('ba')} AS dormida`);
    expect(SQL_COBERTURA_DE_LA_DESCARGA).toContain(`${sqlCuentaDormida('ba')} AS dormida`);
    expect(sqlCuentaDormida()).not.toContain('?');
    expect((SQL_COBERTURA_DE_LA_DESCARGA.match(/\?/g) ?? []).length).toBe(1);
  });

  it('la dormida sólo se salta para el pago SIN cuenta; con cuenta preparada se mira esa, dormida o no', () => {
    expect(SQL_SALIDA_DE_BANCO).toContain('((p.cuenta IS NULL AND NOT c.dormida) OR c.id = p.cuenta)');
  });

  it('dormida exige las dos cosas: sin descarga nunca Y sin pago de Kepler desde la cuenta', () => {
    const f = sqlCuentaDormida('ba');
    expect(f).toMatch(/^\(max\(f\.date_to\) IS NULL AND NOT EXISTS \(/);
    expect(f).toContain(`k.c3 = 'D'`);
    expect(f).toContain('btrim(k.c22) = btrim(ba.account_label)');
  });
});

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
    // [PGP.202] los pagos primero (los grupos se calculan una vez para la ventana de todos) · cobertura · grupos ·
    // libro · descarga · el grupo de cada pago · cubierto
    expect(p.slice(0, 4)).toEqual([['a'], [1], ['2026-11-10'], [null]]);
    expect(p.slice(4)).toEqual(['t', 't', '2026-11-18', 't', '2026-11-18', 't', '2026-11-18', '2026-11-18', '2026-11-18']);
    expect(SQL_SALIDA_DE_BANCO).toContain('cobertura AS MATERIALIZED');
    expect(SQL_SALIDA_DE_BANCO).toContain('grupos AS MATERIALIZED');
    expect((SQL_LIBERADOS_QUE_SALIERON.match(/\?/g) ?? []).length).toBe(1);
  });

  it('la nota del regresado dice cuándo salió, de qué cuenta y qué liberación no lo vio', () => {
    expect(notaReabierto('2026-11-19', { fecha: '2026-11-10', cuenta: 'BBVA 4176', importe: 779912.56, liberado: '2026-11-17' }))
      .toBe('[regresado 2026-11-19] Salió del banco el 2026-11-10 (BBVA 4176, $779912.56): la liberación del 2026-11-17 no lo vio porque el estado de cuenta del Calendario no tenía esa salida. Sus facturas vuelven a quedar apartadas por este pago.');
  });
});
