import { ordenarSenales, resumenDeSenales, torreDeLlave } from './torres.contract';

describe('[TOR.1.1] resumen de señales', () => {
  it('⛔ NEGATIVA — lo no medido nunca cuenta como bien', () => {
    const r = resumenDeSenales([{ estado: 'no_medido' }, { estado: 'no_medido' }]);
    expect(r.ok).toBe(0);
    expect(r.no_medidos).toBe(2);
  });
  it('cuenta cada estado por separado', () => {
    expect(resumenDeSenales([{ estado: 'falla' }, { estado: 'riesgo' }, { estado: 'ok' }]))
      .toEqual({ fallas: 1, riesgos: 1, no_medidos: 0, ok: 1 });
  });
});

describe('[TOR.1.1] orden de la bandeja', () => {
  it('lo roto primero, y dentro lo más viejo primero; sin fecha, al final de su grupo', () => {
    const r = ordenarSenales([
      { estado: 'riesgo' as const, desde: '2026-11-01T00:00:00Z', k: 'r' },
      { estado: 'falla' as const, desde: null, k: 'f-sin-fecha' },
      { estado: 'falla' as const, desde: '2026-10-19T00:00:00Z', k: 'f-vieja' },
      { estado: 'no_medido' as const, desde: null, k: 'n' },
    ]);
    expect(r.map((x) => x.k)).toEqual(['f-vieja', 'f-sin-fecha', 'r', 'n']);
  });
});

describe('[TOR.1.2] cada carril va a una torre', () => {
  it('lo que llega de Kepler y de los puntos de venta es de Sistemas', () => {
    for (const k of ['kepler_server_07', 'ods_live_hot', 'cdc_reconcile', 'store_poller', 'route_collections', 'caja_general_replica_all', 'hr_attendance_ingest', 'feed_contpaqi']) {
      expect(`${k}:${torreDeLlave(k)}`).toBe(`${k}:sistemas`);
    }
  });
  it('nuestra plataforma es de Desarrollo', () => {
    for (const k of ['respaldo_fuera', 'backup_prod', 'auto_deploy', 'poda_disco', 'tunel_cloudflared', 'caja_autollenado', 'analytics_refresh_price_signals', 'connections']) {
      expect(`${k}:${torreDeLlave(k)}`).toBe(`${k}:desarrollo`);
    }
  });
});
