import type { HrAsistenciaResponse, HrDiaAsistencia, HrIncidenciaDto, HrPersonaAsistencia, HrSiteDto } from '@megadulces/contracts';

/** Datos de prueba de las pantallas de RH. Personas inventadas: el repo es público. */

export const SITIOS: HrSiteDto[] = [
  { code: 'PH', name: 'Padre Hidalgo', warehouse_code: '01', is_active: true },
  { code: 'CEDIS', name: 'CEDIS', warehouse_code: '00', is_active: true },
  { code: 'VIEJO', name: 'Sitio cerrado', warehouse_code: null, is_active: false },
];

export function dia(over: Partial<HrDiaAsistencia> = {}): HrDiaAsistencia {
  return {
    fecha: '2026-10-01', estado: 'a_tiempo', entrada: '08:00', salida: '18:00', atrasoMin: 0, absorbidoMin: 0, retardoRealMin: 0,
    bolsaAntes: 15, bolsaDespues: 15, comida: '13:00–14:00', horasNetas: '9:00', ...over,
  };
}

export function persona(over: Partial<HrPersonaAsistencia> = {}): HrPersonaAsistencia {
  return {
    codigo: '101', userId: 'u-101', nombre: 'Prueba Uno', nombreCompleto: 'Prueba Uno Ejemplo', departamento: null, esPracticante: false,
    puesto: '', fotoUrl: '', registrado: true, activo: true, tipo: 'fijo', horario: '08:00', turnos: ['08:00'], horarioConfirmado: false,
    costumbre: null, desfaseMin: null, salida: '18:00', dispersionMin: 3, diasLaborales: [1, 2, 3, 4, 5], diasUsados: 20, diasEnRango: 7,
    silencioDias: 0, pctUnaMarca: 0, retardoRealMin: 0, atrasoBrutoMin: 0, absorbidoMin: 0, diasConRetardo: 0, diasEvaluados: 5, faltas: 0,
    faltasJustificadas: 0, diasNoMedibles: 0, diasAtipicos: 0, horasTrabajadas: 45, minutosTrabajados: 2700, diasConIncidencia: 0,
    incidencias: [], desayunoExcesoMin: 0, diasDesayunoExcedido: 0, pctATiempo: 100,
    semanas: [{ inicio: '2026-10-01', bolsaInicial: 15, bolsaRestante: 15, atrasoMin: 0, retardoRealMin: 0, bolsaAgotada: false, dias: [dia()], minutosTrabajados: 540 }],
    marcas: [], usable: true, bloqueadoPor: [], horarioAsignado: null, minutosEsperados: null, ...over,
  };
}

export function asistencia(personas: HrPersonaAsistencia[]): HrAsistenciaResponse {
  return {
    sucursalId: 'PH', desde: '2026-10-01', hasta: '2026-10-07', desdeHorario: '2026-07-01', ventanaHorarioDias: 90, bolsaSemanalMin: 15,
    corteSemana: 'jueves', diaInicioSemana: 4, diasExTrabajador: 30, desayunoAlertaMin: 20, mideRetardo: true,
    resumen: {
      personas: personas.length, usables: personas.filter((p) => p.usable).length, conPendiente: 0, fijos: 0, rotativos: 0, sinPatron: 0,
      sinDatos: 0, horarioAmbiguo: 0, horarioConfirmado: 0, soloUnaMarca: 0, exTrabajadores: 0, fueraDelPadron: 0, retardoRealMin: 0,
      retardoRealUsableMin: 0, atrasoBrutoMin: 0, absorbidoMin: 0, faltas: personas.reduce((a, p) => a + p.faltas, 0), faltasJustificadas: 0,
      diasNoMedibles: 0, horasTrabajadas: 0, desayunoExcesoMin: 0, diasDesayunoExcedido: 0,
    },
    personas,
  };
}

export function incidencia(over: Partial<HrIncidenciaDto> = {}): HrIncidenciaDto {
  return {
    id: 'i-1', site_code: 'PH', person_code: '101', incident_type: 'vacaciones', date_from: '2026-10-02', date_to: '2026-10-02', minutes: null,
    note: null, status: 'capturada', authorized_by_name: null, base_schedule_minutes: null, created_by: 'u-9', created_by_name: 'Captura Prueba',
    created_at: '2026-10-02T15:00:00.000Z', rated_by: null, rated_by_name: null, rated_at: null, rejection_reason: null, audited_by: null,
    audited_by_name: null, audited_at: null, audit_note: null, voided_by: null, voided_by_name: null, voided_at: null, void_reason: null,
    banderas: [], ...over,
  };
}

/** Un `PermissionsService` falso con exactamente estas claves. */
export function permisos(...claves: string[]) {
  const set = new Set(claves);
  return { has: (p: string) => set.has(p), hasAny: (...ps: string[]) => ps.some((p) => set.has(p)), isAdmin: () => false };
}

/** Un `AuthService` falso con las mismas claves (las pestañas leen los permisos del usuario). */
export function authCon(...claves: string[]) {
  const permissions = Object.fromEntries(claves.map((c) => [c, true]));
  return { user: () => ({ permissions }), isAuthenticated: true };
}
