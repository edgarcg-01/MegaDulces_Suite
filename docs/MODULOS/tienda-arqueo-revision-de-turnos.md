# Tienda › Arqueo › Retiros por revisar — emparejar los retiros de la Suite con los de Kepler (SM.55)

## Problema

Medido en producción (solo lectura, 1 al 22 de noviembre de 2026, 749 turnos cerrados en 8 sucursales):

- En **94 turnos** Kepler registró retiros (sangrías) que la Suite no tiene completos: en 57 no se contó
  ninguno y en 37 solo algunos.
- En **51 de esos 57** nadie abrió el arqueo para ese turno: tampoco se contó el cajón. En total, **280 de 749**
  turnos cerraron sin conteo del cajón.
- Desde SM.51 (#489) la cajera ya no ve el aviso «retiros sin contar».
- La bandeja de descuadres (`/almacen/cuadre`) tiene 2,591 hallazgos de caja y **cero respuestas** desde que existe;
  «Validar arqueo» (SM.12) lleva 0 de 1,309 retiros validados.

Lo que se ve como «faltante» es, sobre todo, retiros que Kepler registró y nadie contó en la Suite. La meta es que
**el total de retiros de la Suite empate con el de Kepler**, y que lo que no empate quede explicado, con dueña: la
encargada de la sucursal.

## Solución

- Pestaña **«Retiros por revisar»** dentro de Arqueo (`/tienda/arqueo/revision`), solo para quien valida. La pestaña
  lleva el **aviso**: «Retiros por revisar 3» = turnos cuyos retiros no empatan y nadie ha explicado (también en
  «Por cajera»).
- Arriba, de los últimos 7 días que terminan ayer: **Retiros en Kepler · Contados en la Suite · Diferencia**. La
  diferencia neta es lo más visible; debajo dice cuánto no empata **sin signo** (para que un turno de +$2,000 no
  esconda uno de −$5,000), en cuántos turnos, de cuántas cajeras, y cuántos faltan por explicar.
- Una lista **por cajera**, la de mayor descuadre primero, con sus totales (Kepler, Suite, Diferencia) y **sus turnos
  siempre visibles** debajo, cada uno con sus tres cifras. Solo salen las cajeras con retiros que no empatan.
- El **cajón sin contar** va como una línea por cajera («Además, 2 cierres sin contar el cajón · Ver su historial»).
  Es dato: no se justifica aquí. «Ver su historial» lleva a la pestaña «Por cajera».
- **Justificar** abre un panel: Kepler / Suite / Diferencia del turno, la lectura en llano («Kepler registró $25,000
  en retiros y en la Suite no se contó ninguno»), la causa (no se capturó · otra caja · otro tipo o concepto ·
  duplicado · error en Kepler · faltante real · otro) y una nota obligatoria. Se puede corregir mientras no esté
  cerrado; queda quién y cuándo.
- Si la cajera cuenta el retiro que faltaba y los totales empatan, el turno **sale solo** de la lista.

## Cómo se implementó

- **Regla** (pura): `libs/reconciliation/src/lib/turno-revision.ts` — motivos, estado de los retiros
  (`descuadraRetiros`: solo «retiros sin contar» y «retiros de más» se justifican), historial, totales por cajera y
  `totalesRetiros`. Se apoya en `armarCajasDelDia`, la misma liga conteo ↔ turno de «Sucursales y sus cajas» (SM.48):
  no hay una segunda versión de la regla.
- **Servicio**: `turno-revision.service.ts`. La lista se calcula al momento. Lo que escribe la encargada se guarda en
  el **motor de hallazgos que ya existía** (ADR-056), sin migración: el turno es un hallazgo `turno_sin_verificar`
  en `reconciliation.discrepancies` (regla registrada **apagada** para que el escáner nocturno no la corra) y su
  historial son filas de `reconciliation.discrepancy_feedback`. Status `confirmado`/`corregido`: no entra a la
  bandeja general. El servidor conserva también acciones, cierre y firma del día (`/accion`, `/dia`), que la versión
  simple no muestra.
- **API**: `GET /store/arqueo-revision` (+ `/resumen` para el aviso; trae `totales` y las cajeras con sus totales),
  `POST /` (causa). Clave `RECONCILIATION_VER` (la de «Validar arqueo»: la tiene `encargado_tienda` y no `cajero`,
  medido en prod el 2026-11-23) y el alcance de **escritura** por sucursal. No hay permiso nuevo.
- **Pantalla**: `tienda-arqueo-revision.component.ts` + `arqueo-revision.service.ts` (con `ArqueoAvisoService`),
  pestaña en `arqueo-tabs.ts`, ruta con `permissionGuard` y guarda de cambios sin guardar.
- **Pruebas**: `turno-revision.spec.ts` (24) · `test-newdb-arqueo-revision.js` contra base real con los payloads de
  la pantalla (40, filas leídas, negativas: justificar un turno de solo cajón, uno que empata, uno abierto…) ·
  `tienda-arqueo-revision.component.spec.ts` (8). Las tres, rotas a propósito una vez: salen en rojo.

## Por qué así

- **Emparejar, no contar otra vez**: al día siguiente el dinero ya se movió. Lo que se puede hacer es capturar el
  retiro que faltó (y el turno empata solo) o explicar por qué no.
- **Simple antes que completo**: la primera versión (contadores, tres vistas, acciones, cierre y firma del día)
  abrumaba. Se dejó lo que contesta la pregunta: ¿empata?, ¿de quién no?, ¿por qué?
- **Dueña con nombre, no bandeja anónima**: la bandeja general tiene miles de hallazgos sin una sola respuesta.
- **Aparte de «Por cajera»**: esa es el historial de cada cajera; esta es lo que falta explicar. Juntas, la encargada
  buscaría sus pendientes entre todos los cortes.
- **Sin tabla nueva**: el motor de hallazgos ya guarda causa, nota, quién y cuándo.
- La prueba contra base real encontró una trampa: `now()` es la hora de inicio de la transacción; se guarda con
  `clock_timestamp()`.

## Pendiente

- El aviso en `/tienda/arqueo` (donde entra la encargada): una línea en un archivo que otra sesión está editando.
- Aviso a Edgar (la regla toca su decisión SM.34 y el motor es suyo en buena parte).
- «Por cajera» liga conteos con su propia regla (`porCajera`), no con `armarCajasDelDia`: puede dar otra cifra del
  cajón sin contar. No medido.
- Validación visual en el navegador y el 403 por HTTP (cajera / otra sucursal): **no medidos**.
- Medir en dos semanas: la diferencia neta por sucursal y el % de turnos explicados al día siguiente.
