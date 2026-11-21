import type { PoolClient } from 'pg';
import { decidirEscrituraAutorizacion, sentenciaAutorizacion, LECTURA_PEDIDO } from './autorizacion-kepler';
import { KeplerAutorizacionPedidoAdapter } from './kepler-autorizacion-pedido.adapter';

/**
 * `[GP.A.2]` Autorizar (o regresar) un pedido TELEMARK en Kepler: la regla, la sentencia y el adaptador contra un
 * cliente simulado. La prueba contra el Kepler vivo es el ensayo con ROLLBACK (`ops/prod/ensayo-autorizacion-kepler`).
 */
const leido = (estado: string, o: Partial<{ canal: string; doc_estado: string }> = {}) => ({ estado, canal: 'TELEMARK', doc_estado: 'N', ...o });

describe('[GP.A.2] decidirEscrituraAutorizacion', () => {
  it('autorizar: CREADO → AUTORIZADO', () => {
    expect(decidirEscrituraAutorizacion([leido('CREADO')], 'autorizar')).toEqual({ ok: true, de: 'CREADO', a: 'AUTORIZADO' });
  });
  it('regresar: AUTORIZADO → CREADO', () => {
    expect(decidirEscrituraAutorizacion([leido('AUTORIZADO')], 'regresar')).toEqual({ ok: true, de: 'AUTORIZADO', a: 'CREADO' });
  });
  it('idempotente: autorizar uno ya autorizado dice «ya estaba» y no escribe', () => {
    expect(decidirEscrituraAutorizacion([leido('AUTORIZADO')], 'autorizar')).toMatchObject({ ok: false, yaEstaba: true });
  });
  it('negativo: no se autoriza uno que ya avanzó, ni se regresa uno surtido', () => {
    expect(decidirEscrituraAutorizacion([leido('SURTIDO')], 'autorizar')).toMatchObject({ ok: false });
    expect(decidirEscrituraAutorizacion([leido('SURTIDO')], 'regresar')).toEqual({ ok: false, motivo: 'Ya va en surtido en Kepler: un pedido surtido no se regresa' });
  });
  it('negativo: ni de sucursal, ni cancelado, ni ausente, ni repetido', () => {
    expect(decidirEscrituraAutorizacion([leido('CREADO', { canal: 'SUCURSAL' })], 'autorizar')).toMatchObject({ ok: false, motivo: 'No es un pedido de telemarketing' });
    expect(decidirEscrituraAutorizacion([leido('CREADO', { doc_estado: 'C' })], 'autorizar')).toMatchObject({ ok: false, motivo: 'El pedido está cancelado en Kepler' });
    expect(decidirEscrituraAutorizacion([], 'autorizar')).toMatchObject({ ok: false });
    expect(decidirEscrituraAutorizacion([leido('CREADO'), leido('CREADO')], 'autorizar')).toMatchObject({ ok: false });
  });
});

describe('[GP.A.2] sentenciaAutorizacion', () => {
  it('sólo toca c11 y repite el estatus leído en el WHERE (no pisa un cambio hecho en Kepler)', () => {
    const s = sentenciaAutorizacion({ sucursal: '08', serie: 1, folio: '0001842', de: 'CREADO', a: 'AUTORIZADO' });
    expect(s.sql).toMatch(/^UPDATE md\.kdm1 SET c11 = \$4 WHERE /);
    expect(s.sql).toContain('btrim(c11) = $5');
    expect(s.sql).not.toMatch(/SET[^W]*c(?!11\b)\d+\s*=/);
    expect(s.params).toEqual(['08', 1, '0001842', 'AUTORIZADO', 'CREADO']);
    expect(s.esperadas).toBe(1);
  });
  it('la lectura toma el candado de la fila', () => {
    expect(LECTURA_PEDIDO).toMatch(/FOR UPDATE$/);
  });
});

/** Un cliente de Kepler simulado: responde a la lectura con `filas` y al UPDATE con `tocadas`. */
function cliente(filas: Array<Record<string, string>>, tocadas = 1) {
  const sql: string[] = [];
  const c = {
    query: async (q: string) => {
      sql.push(q.trim().split(/\s+/).slice(0, 2).join(' '));
      if (q.includes('FOR UPDATE')) return { rows: filas, rowCount: filas.length };
      if (q.startsWith('UPDATE')) return { rows: [], rowCount: tocadas };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  return { c, sql };
}

function adaptador(env: Record<string, string>, c: PoolClient) {
  return new (class extends KeplerAutorizacionPedidoAdapter {
    protected override get env() { return env; }
    protected override async conectar() { return c; }
  })();
}

const ENCENDIDO = { KEPLER_AUTORIZACION_PEDIDOS: 'encendida', KEPLER_PUSH_URL_08: 'postgres://kepler_push@x/kepler' };
const pedido = { sucursal: '08', serie: 1, folio: '0001842', accion: 'autorizar' as const };

describe('[GP.A.2] KeplerAutorizacionPedidoAdapter', () => {
  it('⛔ apagado por default: ni se conecta', async () => {
    const { c, sql } = cliente([leido('CREADO')]);
    expect(await adaptador({}, c).escribir(pedido)).toMatchObject({ estado: 'apagado' });
    expect(sql).toEqual([]);
  });

  it('autoriza: lee con candado, escribe una fila y confirma', async () => {
    const { c, sql } = cliente([leido('CREADO')]);
    expect(await adaptador(ENCENDIDO, c).escribir(pedido)).toEqual({ estado: 'escrito', de: 'CREADO', a: 'AUTORIZADO' });
    expect(sql).toEqual(['BEGIN', 'SET LOCAL', 'SELECT btrim(c11)', 'UPDATE md.kdm1', 'COMMIT']);
  });

  it('ya autorizado: «ya estaba», deshace y no escribe', async () => {
    const { c, sql } = cliente([leido('AUTORIZADO')]);
    expect(await adaptador(ENCENDIDO, c).escribir(pedido)).toMatchObject({ estado: 'ya_estaba' });
    expect(sql).not.toContain('UPDATE md.kdm1');
    expect(sql[sql.length - 1]).toBe('ROLLBACK');
  });

  it('⛔ alguien lo movió en Kepler entre la lectura y la escritura (0 filas): deshace y lo dice', async () => {
    const { c, sql } = cliente([leido('CREADO')], 0);
    const r = await adaptador(ENCENDIDO, c).escribir(pedido);
    expect(r).toMatchObject({ estado: 'rechazado', reintentable: true });
    expect(sql).not.toContain('COMMIT');
    expect(sql[sql.length - 1]).toBe('ROLLBACK');
  });

  it('regresar un pedido ya surtido: rechazado, sin reintento', async () => {
    const { c } = cliente([leido('SURTIDO')]);
    expect(await adaptador(ENCENDIDO, c).escribir({ ...pedido, accion: 'regresar' })).toMatchObject({ estado: 'rechazado', reintentable: false });
  });

  it('sin la conexión de la sucursal: apagado, con el motivo', async () => {
    const { c } = cliente([leido('CREADO')]);
    expect(await adaptador({ KEPLER_AUTORIZACION_PEDIDOS: 'encendida' }, c).escribir(pedido)).toMatchObject({ estado: 'apagado' });
  });
});
