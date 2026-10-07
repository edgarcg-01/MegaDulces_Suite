/**
 * `[RH.1.8]` Los guiones del corte de asistencia no se desfasan entre sí. Prueba PURA (sin base): corre en CI.
 *
 * El aplicador de migraciones, el pre-vuelo y la carga única se copian SOLOS al pod de prod, así que no
 * pueden compartir un módulo: cada uno lleva su copia de la identidad del clúster y de la cadena de
 * migraciones. Esto es lo que impide que las copias diverjan. Nació el mismo día en que cuatro migraciones
 * de la fase se renombraron por chocar con `main`: un guion con el nombre viejo habría fallado EN EL CORTE.
 */
import fs from 'fs';
import path from 'path';

const RAIZ = path.resolve(__dirname, '../../../../..');
const MIGS = path.join(RAIZ, 'database/migrations-newdb');
const prevuelo = require(path.join(RAIZ, 'database/scripts/rh/prevuelo-corte-asistencia.js'));
const carga = require(path.join(RAIZ, 'database/scripts/rh/carga-unica-mega-talento.js'));

describe('[RH.1.8] guiones del corte — copias que no pueden divergir', () => {
  it('la identidad de prod es la MISMA en el aplicador, el pre-vuelo y la carga', () => {
    const aplicador = fs.readFileSync(path.join(RAIZ, 'database/scripts/apply-one-migration-prod.js'), 'utf8');
    const m = /PROD_CLUSTER_ID\s*=\s*process\.env\.PROD_CLUSTER_ID\s*\|\|\s*'(\d+)'/.exec(aplicador);
    expect(m).not.toBeNull();
    expect(prevuelo.PROD_CLUSTER_ID).toBe(m?.[1]);
    expect(carga.PROD_CLUSTER_ID).toBe(m?.[1]);
  });

  it('la cadena del pre-vuelo = base de CH + las de la carga + el reparto, y cada archivo existe', () => {
    const esperada = [carga.MIGRACION_BASE_CH, ...carga.MIGRACIONES_FASE, '20261007330000_hr_reparto_asistencia'].map((n: string) => `${n}.js`);
    expect(prevuelo.CADENA).toEqual(esperada);
    for (const f of prevuelo.CADENA) expect(fs.existsSync(path.join(MIGS, f))).toBe(true);
    // Ordenada: knex aplica por nombre, y el pre-vuelo dice «en este orden».
    expect([...prevuelo.CADENA].sort()).toEqual(prevuelo.CADENA);
  });

  it('⛔ NEGATIVA — los nombres viejos (antes del renombre) ya no existen como archivo', () => {
    for (const f of prevuelo.NOMBRES_VIEJOS) expect(fs.existsSync(path.join(MIGS, f))).toBe(false);
  });

  it('⛔ NEGATIVA — ninguna migración de la cadena comparte timestamp con otro archivo del repo', () => {
    const todos = fs.readdirSync(MIGS).filter((f) => f.endsWith('.js'));
    for (const f of prevuelo.CADENA) {
      const mismos = todos.filter((o) => o.slice(0, 14) === f.slice(0, 14));
      expect(mismos).toEqual([f]);
    }
  });

  it('el reparto que revisa el pre-vuelo es el que aplica la migración', () => {
    const mig = require(path.join(MIGS, '20261007330000_hr_reparto_asistencia.js'));
    expect(prevuelo.REPARTO).toEqual(mig.REPARTO);
  });
});

describe('[RH.1.8] pre-vuelo — evaluarLedger', () => {
  const C: string[] = prevuelo.CADENA;
  const otras = ['20260101000000_cualquiera.js', '20261007120000_rd_route_apertura_conteo_fisico.js'];

  it('todo aplicado: nada pendiente ni raro', () => {
    expect(prevuelo.evaluarLedger([...otras, ...C])).toEqual({ pendientes: [], fueraDeOrden: [], viejas: [], colisiones: [] });
  });

  it('sin la base de CH: va primero en la lista de pendientes', () => {
    const r = prevuelo.evaluarLedger(otras);
    expect(r.pendientes).toEqual(C);
    expect(r.pendientes[0]).toBe('20260817220000_hr_attendance.js');
  });

  it('⛔ NEGATIVA — aplicada una que va DESPUÉS de una pendiente: fuera de orden', () => {
    const r = prevuelo.evaluarLedger([C[0], C[2]]);
    expect(r.pendientes[0]).toBe(C[1]);
    expect(r.fueraDeOrden).toEqual([C[2]]);
  });

  it('⛔ NEGATIVA — alguien aplicó el nombre VIEJO: se acusa', () => {
    const r = prevuelo.evaluarLedger([...C.slice(0, 3), '20261007130000_hr_agente_corridas.js']);
    expect(r.viejas).toEqual(['20261007130000_hr_agente_corridas.js']);
  });

  it('⛔ NEGATIVA — otra migración de main con el mismo timestamp que una nuestra: colisión', () => {
    const r = prevuelo.evaluarLedger([...otras, '20261007300000_otra_de_main.js']);
    expect(r.colisiones).toEqual([{ aplicada: '20261007300000_otra_de_main.js', choca_con: '20261007300000_hr_incidencias_y_cierres.js' }]);
  });

  it('las de main que chocaban con los nombres VIEJOS ya no cuentan como colisión', () => {
    expect(prevuelo.evaluarLedger(otras).colisiones).toEqual([]);
  });
});

describe('[RH.1.8] pre-vuelo — padrón ligado ([RH.1.4])', () => {
  it('antes de la carga no hay qué medir: NO MEDIDO, no OK', () => {
    expect(prevuelo.evaluarPadron({ total: 0, ligados: 0, sinLigarRecientes: 0 }).estado).toBe('NO MEDIDO');
  });
  it('⛔ NEGATIVA — padrón cargado y nadie ligado: BLOQUEA (la paridad se midió CON personas)', () => {
    expect(prevuelo.evaluarPadron({ total: 1540, ligados: 0, sinLigarRecientes: 900 }).estado).toBe('BLOQUEA');
  });
  it('ligados pero con códigos recientes sin persona: AVISO con el número', () => {
    const r = prevuelo.evaluarPadron({ total: 1540, ligados: 1400, sinLigarRecientes: 12 });
    expect(r.estado).toBe('AVISO');
    expect(r.detalle).toContain('12 código(s)');
  });
  it('todo lo que checó tiene persona: OK', () => {
    expect(prevuelo.evaluarPadron({ total: 1540, ligados: 1500, sinLigarRecientes: 0 }).estado).toBe('OK');
  });
});

describe('[RH.1.8] pre-vuelo — horario y veredicto', () => {
  // 2026-10-07 es miércoles; México = UTC-6.
  it('hábil: miércoles 12:00 MX', () => expect(prevuelo.enHorarioHabil(new Date('2026-10-07T18:00:00Z'))).toBe(true));
  it('fuera: miércoles 21:00 MX y 07:59 MX', () => {
    expect(prevuelo.enHorarioHabil(new Date('2026-10-08T03:00:00Z'))).toBe(false);
    expect(prevuelo.enHorarioHabil(new Date('2026-10-07T13:59:00Z'))).toBe(false);
  });
  it('fuera: domingo a mediodía', () => expect(prevuelo.enHorarioHabil(new Date('2026-10-11T18:00:00Z'))).toBe(false));
  it('⛔ NEGATIVA — un solo BLOQUEA tumba el veredicto; NO MEDIDO no es OK pero tampoco bloquea', () => {
    expect(prevuelo.veredicto([{ estado: 'OK' }, { estado: 'NO MEDIDO' }]).ok).toBe(true);
    expect(prevuelo.veredicto([{ estado: 'OK' }, { estado: 'NO MEDIDO' }]).noMedido).toBe(1);
    expect(prevuelo.veredicto([{ estado: 'OK' }, { estado: 'BLOQUEA' }]).ok).toBe(false);
  });
});
