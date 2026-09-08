import { Controller, Get } from '@nestjs/common';
import { Public } from '@megadulces/platform-core';
import { SaludService } from './salud.service';

/**
 * GET /api/salud
 *
 * Publica y sin sesion, a proposito: la puede sondear cualquier vigilante
 * externo (Task Scheduler, uptime monitor) que no tiene con que autenticarse.
 * No revela nada: dice si el proceso vive y si DATABASE_URL_NEW contesta, sin
 * datos ni nombres.
 *
 * SIEMPRE responde 200 mientras el proceso este vivo, aunque la base este
 * caida. Eso es lo importante — distingue "el proceso murio" de "el proceso
 * vive pero la base no contesta", que son problemas distintos con acciones
 * distintas. Antes (megadulces-api-ready, Fase CV) el vigilante sondeaba una
 * ruta que consultaba la base, asi que una base inaccesible se veia igual
 * que una API muerta, y el vigilante reiniciaba una y otra vez algo que
 * ningun reinicio podia arreglar: el 01/09/2026 lo hizo 47 veces en 9 horas.
 *
 * Distinto de `GET /api/health` (el healthcheck de DEPLOY de Railway,
 * deliberadamente sin tocar la base — ver app.controller.ts) y de
 * `GET /admin/db-health` (reporte de frescura de datos, gateado por permiso,
 * para un humano en el panel de administracion). Esta ruta es la unica de
 * las tres pensada para un vigilante NO autenticado que decide si vale la
 * pena reiniciar el proceso.
 *
 * Portado de megadulces-api-ready -> apps/catalogo-kp (CV.15) -> se perdio
 * al absorber ese app a apps/api (commit 1df656a7) -> recuperado y portado
 * una tercera vez aqui.
 */
@Controller('salud')
export class SaludController {
  constructor(private readonly salud: SaludService) {}

  @Public()
  @Get()
  async estado() {
    const base = await this.salud.estadoBase();
    return {
      api: 'ok',
      desde: this.salud.desde().toISOString(),
      segundos_activa: this.salud.segundosActiva(),
      base,
      // Para que quien lea esto a las 3 de la manana no tenga que interpretar.
      accion: base.estado === 'ok'
        ? 'ninguna'
        : base.estado === 'sin_acceso'
          ? 'NO reiniciar: la base rechaza las credenciales, hace falta una persona'
          : base.estado === 'sin_respuesta'
            ? 'revisar que PostgreSQL este encendido y accesible'
            : 'todavia sin lectura',
    };
  }
}
