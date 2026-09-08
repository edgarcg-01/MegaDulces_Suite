import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';

/**
 * Estado de la base, visto desde la API.
 *
 *   ok            la base responde y el rol entra.
 *   sin_acceso    la base responde pero RECHAZA las credenciales. Reiniciar
 *                 la API no arregla esto nunca: hace falta una persona.
 *   sin_respuesta no se llego al servidor: apagado, red caida, puerto cerrado.
 *   revisando     todavia no hay una primera lectura.
 *
 * Portado de megadulces-api-ready/src/salud/salud.service.ts (Fase CV,
 * CV.15), y de ahi a apps/catalogo-kp (CV.23). Se perdio al absorber ese app
 * a apps/api (commit 1df656a7) — recuperado de git history y portado una
 * tercera vez, con un ajuste real: el port anterior usaba DATABASE_URL_NEW
 * (rol postgres, solo migraciones) porque en el app standalone esa SI era la
 * connection string de runtime; en apps/api la conexion de runtime real es
 * DATABASE_URL_NEW_RUNTIME (rol app_runtime, la que usa KNEX_NEW_DB de
 * verdad) — ver detalle en onModuleInit. Pool propio y minimo, deliberadamente
 * aislado del pool compartido de la app.
 */
export type EstadoBase = 'ok' | 'sin_acceso' | 'sin_respuesta' | 'revisando';

@Injectable()
export class SaludService implements OnModuleInit {
  private readonly log = new Logger('SaludService');
  private pool: Pool;
  private arranco = new Date();

  private estado: EstadoBase = 'revisando';
  private detalle = '';
  private revisadoEn = 0;

  /** La revision en curso, si la hay. Sirve para dos cosas: no lanzar veinte
   *  comprobaciones a la vez cuando llegan veinte peticiones, y poder esperar
   *  a la primera lectura en vez de contestar 'revisando'. */
  private enCurso: Promise<void> | null = null;

  /** Cada cuanto se vuelve a preguntar. El sondeo del vigilante es cada 10
   *  minutos, pero la ruta es publica y conviene que aguante mas trafico. */
  private static readonly VIGENCIA_MS = 15_000;

  /** Cuanto se espera a una lectura fresca antes de contestar con la ultima
   *  que hubiera. Holgado sobre los 4 s del tiempo de espera de conexion,
   *  pero acotado: esta ruta no puede quedarse colgada nunca. */
  private static readonly ESPERA_PRIMERA_MS = 6_000;

  onModuleInit() {
    // Pool propio y minimo: si la base esta caida, que el atasco no se lleve
    // por delante al pool compartido de KNEX_NEW_DB que usa el resto de la
    // app. Y con tiempos de espera cortos, porque esto tiene que contestar
    // rapido aunque nada funcione.
    //
    // OJO: usa DATABASE_URL_NEW_RUNTIME (rol app_runtime), NO DATABASE_URL_NEW
    // (rol postgres, superuser, solo para migraciones/KNEX_NEW_DB_ADMIN) — es
    // la MISMA resolucion de conexion que KNEX_NEW_DB (ver buildNewDbConfig en
    // new-database.module.ts), que es de la que depende KpService de verdad.
    // Un port anterior de este archivo (heredado de apps/catalogo-kp, donde
    // DATABASE_URL_NEW SI era la connection string de runtime) uso la variable
    // equivocada aqui: habria reportado "ok" con el rol de migraciones vivo
    // aunque app_runtime estuviera caido — exactamente el falso positivo que
    // esta ruta existe para evitar.
    const connStrRuntime = process.env.DATABASE_URL_NEW_RUNTIME;
    this.pool = new Pool(
      connStrRuntime
        ? { connectionString: connStrRuntime, max: 1, connectionTimeoutMillis: 4000, statement_timeout: 4000, idleTimeoutMillis: 30_000 }
        : {
            host: process.env.NEW_DB_HOST || '192.168.0.245',
            port: Number(process.env.NEW_DB_PORT) || 5432,
            database: process.env.NEW_DB_NAME || 'postgres_platform',
            user: 'app_runtime',
            password: process.env.APP_RUNTIME_PASSWORD || 'app_runtime',
            max: 1,
            connectionTimeoutMillis: 4000,
            statement_timeout: 4000,
            idleTimeoutMillis: 30_000,
          },
    );
    // Un Pool emite 'error' cuando una conexion ociosa se cae. Sin este
    // manejador, Node tumba el proceso entero.
    this.pool.on('error', () => {});
    void this.revisar();
  }

  /** Una sola revision a la vez. Las demas se enganchan a la que ya corre. */
  private revisar(): Promise<void> {
    if (!this.enCurso) {
      this.enCurso = this.revisarAhora().finally(() => { this.enCurso = null; });
    }
    return this.enCurso;
  }

  private async revisarAhora(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
      if (this.estado !== 'ok') this.log.log('La base volvio a responder.');
      this.estado = 'ok';
      this.detalle = '';
    } catch (e: any) {
      const codigo = e?.code || '';
      const anterior = this.estado;

      // 28P01 contrasena incorrecta, 28000 el pg_hba no deja pasar,
      // 3D000 la base no existe, 42501 sin permiso. Todos son problemas de
      // acceso: el servidor esta vivo y contesta que no.
      if (['28P01', '28000', '3D000', '42501'].includes(codigo)) {
        this.estado = 'sin_acceso';
      } else {
        this.estado = 'sin_respuesta';
      }

      this.detalle = codigo ? `${codigo}` : String(e?.message || '').slice(0, 120);
      if (anterior !== this.estado) {
        this.log.error(`Base: ${this.estado} (${this.detalle})`);
      }
    } finally {
      this.revisadoEn = Date.now();
    }
  }

  /**
   * Nunca lanza y nunca tarda: si la ultima lectura sigue vigente la
   * devuelve tal cual, y si no, dispara la siguiente en segundo plano y
   * devuelve la que hay. El sondeo del vigilante no puede quedarse colgado
   * esperando a una base que no contesta, porque entonces no distinguiria
   * este caso de "la API esta muerta", que es justo lo que hay que separar.
   */
  async estadoBase(): Promise<{ estado: EstadoBase; detalle: string; revisado_hace_s: number }> {
    const edad = Date.now() - this.revisadoEn;
    if (edad > SaludService.VIGENCIA_MS) {
      // Se ESPERA a la lectura, no se devuelve la vieja mientras la nueva va
      // por detras. Devolver la vieja retrasaba la deteccion un ciclo entero
      // del vigilante —diez minutos— porque el primer sondeo tras romperse la
      // base contestaba con el 'ok' guardado de antes.
      //
      // Cuesta poco: gracias al candado de arriba, veinte peticiones a la vez
      // comparten una sola consulta, y la espera esta acotada. Si se agota, se
      // devuelve lo ultimo que se sabia, que es mejor que no contestar: esta
      // ruta no puede colgarse nunca, es la que dice si todo lo demas vive.
      await Promise.race([
        this.revisar(),
        new Promise<void>(r => setTimeout(r, SaludService.ESPERA_PRIMERA_MS)),
      ]);
    }
    const edadFinal = Date.now() - this.revisadoEn;
    return {
      estado: this.estado,
      detalle: this.detalle,
      revisado_hace_s: this.revisadoEn ? Math.round(edadFinal / 1000) : -1,
    };
  }

  desde(): Date { return this.arranco; }

  segundosActiva(): number {
    return Math.round((Date.now() - this.arranco.getTime()) / 1000);
  }
}
