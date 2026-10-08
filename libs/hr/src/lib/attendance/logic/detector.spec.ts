/**
 * `[RH.1.5]` El recorrido del agente de alertas: universo, turno asignado contra el general, y
 * el corte de quien ya no viene (sin él, cientos de faltas de gente que no está).
 */
import { detectarEnDatos, type EntradaDetector, type HorarioSitio } from './detector';
import { CONFIG_DEFAULT } from './config-reglas';

const general: HorarioSitio = {
  id: 'h-general', nombre: 'General', dias: [1, 2, 3, 4, 5, 6], entrada: '09:00', salida: '18:00',
  inicioComida: null, finComida: null, toleranciaMin: 10, activo: true,
};
const tarde: HorarioSitio = { ...general, id: 'h-tarde', nombre: 'Tarde', entrada: '14:00', salida: '22:00', dias: [1, 2, 3, 4, 5] };
const checa = (codigo: string, fecha: string, ...horas: string[]) =>
  horas.map((h) => ({ codigo, nombre: null, fecha, fechaHora: `${fecha}T${h}:00`, hora: `${h}:00`, tipo: null }));

function entrada(over: Partial<EntradaDetector> = {}): EntradaDetector {
  return {
    sucursalId: 'cedis', desde: '2026-07-06', hasta: '2026-07-08', config: CONFIG_DEFAULT, hoy: '2026-07-20',
    personas: [
      { codigo: '15', nombre: 'Ana', horarioId: null, excluida: false },
      { codigo: '16', nombre: 'Beto', horarioId: 'h-tarde', excluida: false },
      { codigo: '17', nombre: 'Promotora', horarioId: null, excluida: true },
    ],
    horarios: [general, tarde],
    checadas: [
      ...checa('15', '2026-07-06', '09:02', '18:00'),
      ...checa('15', '2026-07-08', '09:40', '18:00'),          // retardo contra el general
      ...checa('16', '2026-07-06', '14:05', '22:00'),
      ...checa('16', '2026-07-07', '14:00', '22:00'),
      ...checa('16', '2026-07-08', '14:00', '22:01'),
    ],
    cortePorCodigo: new Map(),
    ...over,
  };
}
const claves = (r: ReturnType<typeof detectarEnDatos>) => r.borradores.map((b) => `${b.empleadoCodigo}|${b.fecha}|${b.regla}`).sort();

describe('detector de alertas', () => {
  it('Ana faltó el martes y llegó tarde el miércoles; Beto se mide contra SU turno de la tarde', () => {
    expect(claves(detectarEnDatos(entrada()))).toEqual([
      '15|2026-07-07|falta',
      '15|2026-07-08|retardo',
    ]);
  });
  it('la promotora queda fuera: sin checadas no se le inventa falta', () => {
    const r = detectarEnDatos(entrada());
    expect(r.borradores.some((b) => b.empleadoCodigo === '17')).toBe(false);
    expect(r.resumen.empleadosAnalizados).toBe(2);
  });
  it('quien dejó de venir se analiza sólo hasta su última checada', () => {
    const r = detectarEnDatos(entrada({ cortePorCodigo: new Map([['15', '2026-07-06']]) }));
    expect(claves(r).filter((k) => k.startsWith('15|'))).toEqual([]);
    expect(r.resumen.exTrabajadoresOmitidos).toBe(1);
  });
  it('un día sin cerrar no genera falta', () => {
    expect(claves(detectarEnDatos(entrada({ hoy: '2026-07-07' })))).not.toContain('15|2026-07-07|falta');
  });
  it('con la regla apagada por configuración, no hay borrador de esa regla (prueba negativa)', () => {
    const cfg = { ...CONFIG_DEFAULT, reglasActivas: { ...CONFIG_DEFAULT.reglasActivas, retardo: false } };
    expect(claves(detectarEnDatos(entrada({ config: cfg })))).toEqual(['15|2026-07-07|falta']);
  });
});
