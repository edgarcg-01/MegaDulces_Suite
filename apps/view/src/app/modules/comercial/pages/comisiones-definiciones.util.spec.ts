import { describe, expect, it } from 'vitest';
import type { DefinicionVista } from '@megadulces/contracts';
import { temasDeVista, textoTema } from './comisiones-definiciones.util';

/**
 * `[DP.3.2]` Lo que `/comercial/comisiones` dice de las reglas que el cálculo todavía no aplica.
 * Las cuatro formas de mentir: contar una descartada, decir «definido» de algo que el motor no usa,
 * callar que nadie la va a contestar, y ofrecerle el enlace a quien la pantalla no le muestra nada.
 */
const def = (key: string, extra: Partial<DefinicionVista> = {}): DefinicionVista => ({
  id: key, key, area: 'comercial', consumer: 'commercial.commissions', question: key, decides: '',
  value_type: 'text', choices: null, unit: null, config_route: null,
  suggested_value: null, suggested_source: null, status: 'pendiente',
  assigned_to: null, due_at: null, answered_at: null, discard_reason: null, asignado_nombre: null,
  vigente: { estado: 'sin_definir', motivo: 'sin_respuesta' }, respuestas: 0,
  ...extra,
} as DefinicionVista);

const LUPITA = { assigned_to: 'u-lupita', asignado_nombre: 'Lupita Sánchez' };

describe('[DP.3.2] reglas de la nómina sin definir', () => {
  const defs = [
    def('rd.universo.sigue_a'),
    def('rd.vecinal.tabulador'), def('rd.vecinal.quien_cobra'),
    def('rd.tlmk.tabulador', { status: 'descartada' }), def('rd.tlmk.quien_cobra'),
    def('rd.bono_asistencia.monto', LUPITA), def('rd.bono_asistencia.dia_pago', LUPITA),
    def('rd.bono_asistencia.fuente'),
    def('rd.faltante.forma_cobro', { ...LUPITA, status: 'respondida' }),
    def('rd.ausencia.ventana', { ...LUPITA, status: 'respondida' }),
    def('rd.ausencia.base'),
    def('rd.otro_tema.algo'),
  ];

  it('cada tema va a la vista donde pesa, y un tema que no está en la tabla no se pinta', () => {
    expect(temasDeVista(defs, 'padron', null).map((t) => t.tema)).toEqual(['universo', 'vecinal', 'tlmk']);
    expect(temasDeVista(defs, 'bonos', null).map((t) => t.tema)).toEqual(['bono_asistencia']);
    expect(temasDeVista(defs, 'quincena', null).map((t) => t.tema)).toEqual(['ausencia', 'faltante']);
    expect(temasDeVista(defs, 'tabulador', null)).toEqual([]);
  });

  it('una descartada no cuenta: TLMK es «sin definir», no «1 de 2»', () => {
    const tlmk = temasDeVista(defs, 'padron', null).find((t) => t.tema === 'tlmk')!;
    expect(tlmk.total).toBe(1);
    expect(textoTema(tlmk)).toBe('sin definir · sin dueño');
  });

  it('dueño y sin dueño se dicen los dos', () => {
    const bono = temasDeVista(defs, 'bonos', null)[0];
    expect(textoTema(bono)).toBe('3 de 3 sin definir · lo define Lupita Sánchez · 1 sin dueño');
    const vecinal = temasDeVista(defs, 'padron', null).find((t) => t.tema === 'vecinal')!;
    expect(textoTema(vecinal)).toBe('2 de 2 sin definir · sin dueño');
  });

  it('contestada NO es «definida»: el cálculo todavía no la usa', () => {
    const faltante = temasDeVista(defs, 'quincena', null).find((t) => t.tema === 'faltante')!;
    expect(textoTema(faltante)).toBe('contestada; el cálculo todavía no la usa');
    const ausencia = temasDeVista(defs, 'quincena', null).find((t) => t.tema === 'ausencia')!;
    expect(textoTema(ausencia)).toBe('1 de 2 sin definir · sin dueño');
  });

  it('«mías» sólo con una pendiente a mi nombre; sin usuario, nunca', () => {
    expect(temasDeVista(defs, 'bonos', 'u-lupita')[0].mias).toBe(true);
    expect(temasDeVista(defs, 'bonos', 'u-otro')[0].mias).toBe(false);
    expect(temasDeVista(defs, 'bonos', null)[0].mias).toBe(false);
    // La de faltante es de Lupita pero ya está contestada: no le queda nada que hacer ahí.
    expect(temasDeVista(defs, 'quincena', 'u-lupita').find((t) => t.tema === 'faltante')!.mias).toBe(false);
  });
});
