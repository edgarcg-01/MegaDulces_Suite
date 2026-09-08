import { Controller, Get } from '@nestjs/common';
import { SaludService } from './salud.service';

@Controller('salud')
export class SaludController {
  constructor(private readonly salud: SaludService) {}

  /**
   * GET /api/salud
   *
   * Publica y sin sesion, a proposito: la usa el vigilante, que corre como
   * tarea programada y no tiene con que autenticarse. No revela nada: dice
   * si el proceso vive y si la base contesta, sin datos ni nombres.
   *
   * SIEMPRE responde 200 mientras el proceso este vivo, aunque la base este
   * caida. Eso es lo importante. Antes el vigilante sondeaba una ruta que
   * consultaba la base, asi que una base inaccesible se veia igual que una
   * API muerta, y el vigilante reiniciaba una y otra vez algo que ningun
   * reinicio podia arreglar. El 01/09/2026 lo hizo 47 veces en 9 horas.
   *
   * Portado literal de megadulces-api-ready/src/salud (Fase CV, CV.15) —
   * apareció en el proyecto origen DESPUÉS de las sub-fases CV.0-CV.10 que
   * portaron módulo por módulo, así que no había existido para portarse
   * hasta ahora. Vigilar_API.ps1 lo consume tal cual desde .163.
   */
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
