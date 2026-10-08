import type { Regla, ReglaConfig } from './tipos';

/**
 * Fase RH · `[RH.1.5]` — los umbrales del agente de alertas. Copia de
 * `mega-talento-90/api/src/agente-horarios/config.ts` @ 63de029, partida en dos: aquí la parte
 * PURA (el respaldo en código y la fusión), y la lectura de `hr.attendance_rules` en
 * `attendance-reader.ts`. Así la fusión se prueba sin base.
 *
 * El orden de la fusión es el mismo de allá: respaldo de código → fila global (`site_code`
 * NULL) → política del sitio en código → fila del sitio. La tabla sigue mandando: la política
 * en código sólo evita que una regla nueva dependa de que alguien cargue la fila.
 */

const REGLAS: Regla[] = [
  'retardo', 'falta', 'checada_duplicada',
  'multiples_entradas', 'entrada_sin_salida', 'fuera_de_turno',
  'desayuno_excedido',
];

/** Respaldo en código (el mismo de Mega Talento). */
export const CONFIG_DEFAULT: ReglaConfig = {
  duplicadaMinutos: 5,
  saltoEntradasHoras: 4,
  ventanaFueraTurnoMin: 120,
  usarToleranciaHorario: true,
  toleranciaRetardoMin: null,
  marcarFaltas: true,
  soloDiasCerrados: true,
  faltaSoloConActividadEnRango: true,
  // 30 min es el default de la empresa; corporativo lleva 25 en su propia fila.
  desayunoTopeMin: 30,
  desayunoAlertaMin: 10,
  desayunoHastaHora: '13:00',
  desayunoMaxPlausibleMin: 120,
  desayunoCuentaComoJornada: false,
  // true en TODAS las plazas (28/09/2026): cada quien se mide contra su propio turno.
  medirRetardo: true,
  reglasActivas: {
    retardo: true,
    falta: true,
    checada_duplicada: true,
    multiples_entradas: true,
    entrada_sin_salida: true,
    salida_sin_entrada: true,
    fuera_de_turno: true,
    desayuno_excedido: true,
  },
};

/**
 * Lo que un sitio trae por POLÍTICA aunque su fila no lo diga todavía. La llave es el código
 * del sitio de checado (`hr.attendance_sites.code`), que conserva el slug de Mega Talento.
 */
export const POLITICA_POR_SITIO: Record<string, Partial<ReglaConfig>> = {
  // 25/09/2026, política de RH: en corporativo el desayuno se paga (sólo se descuenta la comida).
  corporativo: { desayunoCuentaComoJornada: true },
};

/** Merge superficial + merge de `reglasActivas`. `parcial` puede venir de la base. */
export function fusionar(base: ReglaConfig, parcial: unknown): ReglaConfig {
  if (!parcial || typeof parcial !== 'object') return base;
  const p = parcial as Partial<ReglaConfig>;
  const salida: ReglaConfig = { ...base, ...p };
  salida.reglasActivas = { ...base.reglasActivas, ...(p.reglasActivas || {}) };
  // Asegura una entrada por regla (salida_sin_entrada sigue a entrada_sin_salida).
  for (const r of REGLAS) {
    if (typeof salida.reglasActivas[r] !== 'boolean') salida.reglasActivas[r] = base.reglasActivas[r];
  }
  if (typeof salida.reglasActivas.salida_sin_entrada !== 'boolean') {
    salida.reglasActivas.salida_sin_entrada = salida.reglasActivas.entrada_sin_salida;
  }
  return salida;
}

/** La config efectiva de un sitio, con las dos filas de la tabla ya leídas. */
export function configEfectiva(siteCode: string, global: unknown, propia: unknown): ReglaConfig {
  return fusionar(fusionar(fusionar(CONFIG_DEFAULT, global), POLITICA_POR_SITIO[siteCode]), propia);
}
