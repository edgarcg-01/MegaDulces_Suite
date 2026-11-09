import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PoolClient } from 'pg';
import type { Env } from '@megadulces/platform-core';

import { fichaVacia } from './ficha-kepler';
import { armarClienteKepler, planConClave, serieDe, type PlanClienteKepler } from './kepler-cliente.armador';
import { KeplerClienteSinkAdapter, servidoresDeCliente } from './kepler-cliente-sink.adapter';

/**
 * `[ALC.2.7]` ENSAYO contra el Kepler REAL: corre el alta completa —la serie leída en las 10 bases,
 * la clave siguiente, el INSERT de `kdud`, de `kdfedir` y de la bitácora con sus tipos de verdad— y
 * en vez de confirmar relee las filas DENTRO de la transacción, las compara contra el plan y hace
 * ROLLBACK. No queda nada escrito. Es la herramienta que en KR cazó un «tipos de dato
 * inconsistentes» que ningún doble habría visto.
 *
 * ⛔ Sólo corre con `KEPLER_ENSAYO=1`, el maestro de `ops/prod/kepler-push-secretos.js` (con las 10
 * líneas `KEPLER_PUSH_URL_SC` y `_00`…`_08`) y desde una máquina que `pg_hba.conf` de Kepler acepte
 * (hoy: el servidor `md`). Sin eso se salta: NO MEDIDO, no verde. En CI no hay ERP.
 *
 *   KEPLER_ENSAYO=1 npx vitest run --config vitest.config.ts \
 *     src/lib/customer-onboarding/kepler-cliente-sink.ensayo.spec.ts
 */
const DIR = process.env.KEPLER_PUSH_SECRETOS || path.join(os.homedir(), 'kepler-push-secretos');
const MAESTRO = path.join(DIR, 'kepler-push.env');
const ACTIVO = process.env.KEPLER_ENSAYO === '1' && fs.existsSync(MAESTRO);

function envDeEnsayo(): Env {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const line of fs.readFileSync(MAESTRO, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^#?\s*(KEPLER_PUSH_URL_(?:\d{2}|SC))=(\S+)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** Un cliente que no existe, con la cartera real de Morelia Abastos (piso). Nunca se confirma. */
function planDeEnsayo(): { plan: PlanClienteKepler; serie: NonNullable<ReturnType<typeof serieDe>> } {
  const a = armarClienteKepler({
    solicitud: {
      rfc: 'XAXX010101000', curp: null, tipo_persona: 'fisica', nombre_fiscal: 'ENSAYO DE LA SUITE NO USAR',
      regimen_fiscal: '616', codigo_postal_fiscal: '58260', uso_cfdi: 'S01', forma_pago: '01',
      ficha: { ...fichaVacia(), nombre: 'ENSAYO DE LA SUITE NO USAR', direccion_1: 'SIN CALLE 0', direccion_2: 'CENTRO MORELIA', estado: 'MICHOACAN', codigo_postal: '58260', rfc: 'XAXX010101000' },
      vendedor_code: '20002', grupo_code: '2VP01', zona_code: '20000', credito: null,
    },
    estadoDelCp: 'MICHOACAN',
    usos: [{ clave: 'S01', descripcion: 'Sin efectos fiscales.', regimenes: ['616'] }],
    formasPago: ['01'],
  });
  if (a.hallazgos.some((h) => h.gravedad === 'bloquea') || !a.serie) throw new Error(`El plan de ensayo no se arma: ${JSON.stringify(a.hallazgos)}`);
  return { plan: a.plan, serie: a.serie };
}

/** El adaptador real con el único paso que escribe cambiado por releer, comparar y ROLLBACK. */
class AdaptadorEnsayo extends KeplerClienteSinkAdapter {
  public fallas: string[] = [];
  public revisados: string[] = [];
  constructor(private readonly envEnsayo: Env) { super(); }
  protected override get env(): Env { return this.envEnsayo; }
  protected override async confirmar(c: PoolClient, servidor: string, plan: PlanClienteKepler): Promise<void> {
    const k = (await c.query(`SELECT * FROM md.kdud WHERE btrim(c2) = $1`, [plan.clave])).rows;
    const f = (await c.query(`SELECT * FROM md.kdfedir WHERE btrim(c1::text) = '3' AND btrim(c2) = $1 AND btrim(c3::text) = '1'`, [plan.clave])).rows;
    const l = (await c.query(`SELECT 1 FROM md.kdlogmov WHERE c1 = 'SUITE' AND c5 = 'ALTA' AND c9 = $1`, [`'${plan.clave}'`])).rowCount;
    if (k.length !== 1) this.fallas.push(`${servidor}: kdud tiene ${k.length} filas con ${plan.clave}`);
    if (f.length !== 1) this.fallas.push(`${servidor}: kdfedir tiene ${f.length} filas con ${plan.clave}`);
    if (!l) this.fallas.push(`${servidor}: sin renglón en kdlogmov`);
    const igual = (a: unknown, b: unknown) => String(a ?? '').trim() === String(b ?? '').trim() || (Number.isFinite(Number(a)) && String(a ?? '').trim() !== '' && Number(a) === Number(b));
    for (const [col, v] of Object.entries(plan.kdud)) if (k[0] && !igual(k[0][col], v)) this.fallas.push(`${servidor}: kdud.${col} = «${k[0][col]}», el plan decía «${v}»`);
    for (const [col, v] of Object.entries(plan.kdfedir)) if (f[0] && !igual(f[0][col], v)) this.fallas.push(`${servidor}: kdfedir.${col} = «${f[0][col]}», el plan decía «${v}»`);
    this.revisados.push(servidor);
    await c.query('ROLLBACK');
  }
}

describe('[ALC.2.7] KeplerClienteSinkAdapter — apagado por default', () => {
  it('sin variables, los 10 servidores están apagados y se dice cuál falta', () => {
    const s = servidoresDeCliente({});
    expect(s.map((x) => x.servidor)).toEqual(['SC', '00', '01', '02', '03', '04', '05', '06', '07', '08']);
    expect(s.every((x) => !x.configurado)).toBe(true);
    expect(s[0].motivo).toContain('KEPLER_PUSH_URL_SC');
  });

  it('NEGATIVA: la URL de oficinas NO sirve de comodín para el concentrador', () => {
    const s = servidoresDeCliente({ KEPLER_PUSH_URL: 'postgres://x', KEPLER_PUSH_URL_00: 'postgres://y' });
    expect(s.find((x) => x.servidor === 'SC')?.configurado).toBe(false);
    expect(s.find((x) => x.servidor === '00')?.configurado).toBe(true);
    expect(s.find((x) => x.servidor === '01')?.configurado).toBe(false);
  });

  it('con un servidor sin conexión, reservar la clave se niega sin conectarse a ninguno', async () => {
    const env: Record<string, string> = {};
    for (const s of ['00', '01', '02', '03', '04', '05', '06', '07', '08']) env[`KEPLER_PUSH_URL_${s}`] = 'postgres://nadie@127.0.0.1:1/x';
    const a = new (class extends KeplerClienteSinkAdapter { protected override get env(): Env { return env; } })();
    const r = await a.reservarClave(serieDe('20000', false)!, [], null);
    expect(r).toEqual({ ok: false, motivo: expect.stringContaining('KEPLER_PUSH_URL_SC') });
  });

  it('una clave reservada de otra serie no se reusa', async () => {
    const env: Record<string, string> = { KEPLER_PUSH_URL_SC: 'postgres://nadie@127.0.0.1:1/x' };
    for (const s of ['00', '01', '02', '03', '04', '05', '06', '07', '08']) env[`KEPLER_PUSH_URL_${s}`] = 'postgres://nadie@127.0.0.1:1/x';
    const a = new (class extends KeplerClienteSinkAdapter { protected override get env(): Env { return env; } })();
    const r = await a.reservarClave(serieDe('20000', true)!, [], '21055');
    expect(r.ok).toBe(false);
  });

  it('un plan sin su clave en las dos filas no se escribe', async () => {
    const { plan } = planDeEnsayo();
    await expect(new KeplerClienteSinkAdapter().entregar(plan, 'ALC-00000')).rejects.toThrow('no trae su clave');
  });
});

(ACTIVO ? describe : describe.skip)('[ALC.2.7] ENSAYO contra las 10 bases de Kepler (ROLLBACK)', () => {
  it('reserva la clave siguiente y escribe kdud + kdfedir + bitácora con los tipos reales, sin confirmar', async () => {
    const a = new AdaptadorEnsayo(envDeEnsayo());
    try {
      const { plan, serie } = planDeEnsayo();
      const clave = await a.reservarClave(serie, [], null);
      expect(clave.ok).toBe(true);
      if (!clave.ok) return;
      const r = await a.entregar(planConClave(plan, clave.clave), 'ALC-ENSAYO');
      expect(r.servidores.filter((s) => s.estado === 'rechazada')).toEqual([]);
      expect(a.revisados).toHaveLength(10);
      expect(a.fallas).toEqual([]);
    } finally {
      await a.onModuleDestroy();
    }
  }, 120000);
});
