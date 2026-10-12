import { Module } from '@nestjs/common';
import { CONTPAQI_POLIZA_SINK_PORT } from '@megadulces/contracts';
import { ContpaqiTxtSinkAdapter } from './txt-sink.adapter';
import { ContpaqiCuadreService } from './contpaqi-cuadre.service';
import { ContpaqiArmadoService } from './contpaqi-armado.service';
import { ContpaqiBridgeController } from './contpaqi-bridge.controller';
import { ContpaqiCierreService } from './contpaqi-cierre.service';
import { ContpaqiCierreController } from './contpaqi-cierre.controller';

/**
 * Fase CP `[CP.8]` — **El puente a ContPAQi.** Hereda ADR-040: la plataforma **nunca** escribe a
 * la base de ContPAQi; las únicas dos puertas son el archivo que su importador acepta y el SDK,
 * y las dos viven detrás de `CONTPAQI_POLIZA_SINK_PORT`.
 *
 * ── Qué se registra, y por qué en este orden ────────────────────────────────────────────────
 *  · `ContpaqiTxtSinkAdapter` — hoy es la ÚNICA implementación del puerto, y es además la
 *    **reversa permanente** del sink `sdk` cuando exista: no depende de ninguna máquina ni de
 *    ninguna licencia, así que nunca está caído.
 *  · `ContpaqiCuadreService` — el que cierra el puente. Su `@Cron` se agenda al registrarlo.
 *
 * ⚠️ **El cron sólo es seguro desde el 2026-10-09**, cuando `contpaqi.account_rules` y
 * `contpaqi.poliza_exports` entraron a prod (batches 856/857). Antes de eso este módulo
 * deliberadamente NO existía: registrarlo habría puesto un job fallando cada 10 minutos contra
 * tablas inexistentes, que es ruido que enseña a ignorar el tablero.
 *
 * ⛔ Sin controlador todavía: la bandeja (`[CP.8.7]` / `[CP.8.11]`) es trabajo aparte. Lo que
 * este módulo habilita hoy es que el cuadre corra y **late** — que es lo que convierte lo
 * entregado en verificable.
 */
@Module({
  // `[CP.8.32]` La bandeja: lo que saldria de poliza y, de lo que no, el motivo CON DUENO.
  // `[CPA.0]` El semaforo de cierre: que mes ya esta asentado y cual no. Vive en este modulo
  // porque lee lo mismo (`analytics.gl_polizas`), pero su permiso es OTRO —`FISCAL_CONTAB_VER`—
  // porque lo mira quien revisa los libros, no quien emite egresos.
  controllers: [ContpaqiBridgeController, ContpaqiCierreController],
  providers: [
    ContpaqiArmadoService,
    ContpaqiCuadreService,
    ContpaqiCierreService,
    ContpaqiTxtSinkAdapter,
    // El puerto apunta al sink de archivo. Cuando exista `SdkSinkAdapter`, esta línea es el
    // único lugar donde se elige — quien arma el asiento no se entera.
    { provide: CONTPAQI_POLIZA_SINK_PORT, useExisting: ContpaqiTxtSinkAdapter },
  ],
  exports: [ContpaqiArmadoService, ContpaqiCuadreService, ContpaqiCierreService, CONTPAQI_POLIZA_SINK_PORT],
})
export class FinanceContpaqiModule {}
