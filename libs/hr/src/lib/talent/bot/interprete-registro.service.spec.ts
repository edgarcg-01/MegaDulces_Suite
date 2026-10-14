/**
 * `[RH.3.2.1]` El intérprete con IA, con un cliente falso: qué se le pide al modelo, qué se acepta de vuelta y que
 * cualquier falla degrada a `null` (la conversación sigue por el camino determinista).
 */
import { HrRecruitmentInterpreterService, esquema, limpiar, sistema } from './interprete-registro.service';
import type { VacanteBot } from './registro';

const VACANTES: VacanteBot[] = [
  { id: 'v1', name: 'Cajero(a)', salary_text: '$8,000 al mes', branch_codes: [], schedule_text: 'L-S 8 a 16', requirements: 'Secundaria' },
];

function falso(o: { hasApiKey?: boolean; responde?: unknown; truena?: boolean } = {}) {
  const llamadas: Array<Record<string, unknown>> = [];
  const cliente = {
    hasApiKey: o.hasApiKey ?? true,
    messages: async (p: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
      llamadas.push({ ...p, timeoutMs: opts?.timeoutMs });
      if (o.truena) throw new Error('Anthropic HTTP 529');
      return o.responde;
    },
  };
  return { svc: new HrRecruitmentInterpreterService(cliente as never), llamadas };
}
const usoDe = (input: unknown) => ({ content: [{ type: 'tool_use', name: 'registrar_datos', input }] });

describe('[RH.3.2.1] intérprete del registro', () => {
  it('⭐ pide SÓLO los campos que faltan, con salida forzada por herramienta y tiempo máximo de 8 s', async () => {
    const { svc, llamadas } = falso({ responde: usoDe({ datos: { full_name: 'Ana', city_branch: 'Zamora' }, respuesta_pregunta: null }) });
    const r = await svc.interpretar('soy Ana de Zamora', ['full_name', 'city_branch'], VACANTES);
    expect(r).toEqual({ datos: { full_name: 'Ana', city_branch: 'Zamora' }, respuesta_pregunta: null });
    const p = llamadas[0];
    expect(p['toolChoice']).toEqual({ type: 'tool', name: 'registrar_datos' });
    expect(p['timeoutMs']).toBe(8000);
    const props = Object.keys(((esquema(['full_name', 'city_branch']).properties as Record<string, { properties: object }>).datos).properties);
    expect(props).toEqual(['full_name', 'city_branch']);
  });

  it('⛔ un campo que NO faltaba no entra aunque el modelo lo mande; vacíos y no-texto se tiran', () => {
    expect(limpiar({ datos: { full_name: 'Ana', rfc: 'LOGA900101AB1', email: '  ', nss: 12345678901 }, respuesta_pregunta: '  ' },
      ['full_name', 'email', 'nss'])).toEqual({ datos: { full_name: 'Ana' }, respuesta_pregunta: null });
    expect(limpiar('basura', ['full_name'])).toBeNull();
  });

  it('degrada limpio: sin clave no llama; error, respuesta sin herramienta o texto vacío → null', async () => {
    const sinClave = falso({ hasApiKey: false });
    expect(await sinClave.svc.interpretar('hola', ['full_name'], VACANTES)).toBeNull();
    expect(sinClave.llamadas).toHaveLength(0);
    expect(await falso({ truena: true }).svc.interpretar('hola', ['full_name'], VACANTES)).toBeNull();
    expect(await falso({ responde: { content: [{ type: 'text' }] } }).svc.interpretar('hola', ['full_name'], VACANTES)).toBeNull();
    expect(await falso({ responde: usoDe({}) }).svc.interpretar('   ', ['full_name'], VACANTES)).toBeNull();
    expect(await falso({ responde: usoDe({}) }).svc.interpretar('hola', [], VACANTES)).toBeNull();
  });

  it('las dudas se contestan sólo con datos reales: vacantes con sueldo/horario y sucursales; sin prometer la plaza', () => {
    const s = sistema(VACANTES);
    expect(s).toContain('Cajero(a) · sueldo: $8,000 al mes · horario: L-S 8 a 16');
    expect(s).toContain('Zamora:');
    expect(s).toMatch(/Capital Humano se lo confirma/);
    expect(s).toMatch(/Nunca prometas que lo van a contratar/);
    expect(sistema([])).toContain('ninguna publicada');
  });
});
