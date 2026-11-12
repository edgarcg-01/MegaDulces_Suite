# Preventa › Justificantes (corregir, cancelar y quitar con motivo)

Los tres roles del pedido de preventa vecinal —la **vendedora** (app de vendedores), el **surtidor** (`/almacen/surtir`
pestaña Sucursal y `/almacen/surtir-preventa`) y la **caja que revisa** (`/almacen/pedidos/revision`)— dejan el
**porqué** de cada cambio, y los otros dos lo ven en el mismo pedido. Las entradas más nuevas van arriba.

---

## Corregir, cancelar y quitar con justificante (MCP.18, 2026-11-10)

- **Problema:** medido en prod (sólo lectura, 30 días, control: 35 reaperturas sobre 28 pedidos de ruta, igual que la
  medición anterior):
  - **35 «Corregir»** (3 vendedoras; una sola hizo 31) y **las 35 sin motivo**: la app no lo pedía y el servidor
    guardaba «reabierto para corregir». 19 de 31 que se reagendaron **subieron** el total (el cliente quería más).
  - **15 se corrigieron con el surtido empezado, 11 ya surtido y 4 ya revisado en caja.** Reabrir saca el pedido de la
    bandeja del surtidor (sólo lee confirmados) y cambia los renglones: en las 5 que subieron después de surtir se
    agregaron **$2,235.98 que nadie surtió**. Y mientras la vendedora corrige, al surtidor que lo tenía abierto le
    sale «Pedido de preventa no encontrado» al cerrar (se reprodujo en la prueba de base).
  - **Cancelaciones:** 5, todas de vendedoras, todas con el texto fijo «Cancelado por el vendedor»; 1 era un pedido
    que ya había estado agendado (y la historia lo registraba como borrador).
  - **Surtidor:** 338 surtidos, 50 con faltantes, 84 renglones quitados y 14 recortados, **ninguno con motivo** (el
    reporte sólo podía decir «no hubo»).
  - **Caja:** 1,254 renglones revisados; 53 «no hubo» en 27 pedidos, **sin motivo**.
- **Solución (sin migración, sin permisos nuevos):**
  - **Vendedora · Corregir** (`/vendor/pending`): primero se pregunta si se puede; si el surtido ya empezó, dice quién lo
    tiene y desde qué hora, y qué hacer en su lugar («toma un pedido nuevo» / «pídele al surtidor que lo quite»). Si se
    puede, pide el motivo (lista corta + nota) y con él reabre.
  - **Vendedora · Cancelar** un pedido que estaba agendado (desde Tomar pedido, corrigiendo): pide el motivo. Descartar
    un borrador que nunca se agendó sigue igual, sin preguntar.
  - **Surtidor:** cada renglón con faltante («Faltante» o «No había nada») muestra «¿Por qué?» con **«No había en la
    sucursal» ya marcado** (lo que dice el botón); se cambia con un toque. Se guarda en el celular hasta cerrar.
  - **Caja:** al terminar, lo que la caja deja **por debajo de lo que surtió el surtidor** pide motivo, con «No venía en
    el carrito» ya marcado. Lo que ya faltaba del surtido no se vuelve a preguntar (ya trae el motivo del surtidor).
  - **Todos ven el porqué:** «Por qué cambió este pedido» (quién, hora, qué y motivo) en Mis pedidos de la vendedora, en
    el detalle del surtidor y en el de la caja. Lo guardado antes, sin motivo, dice **«Sin motivo registrado»**.
- **Implementada:**
  - Catálogos y decisiones en UN archivo: `libs/contracts/src/http/order-justification.contract.ts`.
  - Servidor: `POST commercial/orders/:id/reopen` acepta `{ reason_code, note }` (y `{ check_only: true }` para
    preguntar sin escribir) y bloquea con el surtido empezado (409); `POST …/cancel` acepta `{ reason_code, note }`.
    Ambos guardan «Etiqueta» o «Etiqueta: nota» en `commercial.order_status_history.reason` (el de cancelar también en
    `orders.cancellation_reason`). El cierre del surtido guarda `reason`/`reason_note` en cada renglón de
    `presale_picks.report`; el de la caja, en `presale_picks.review`. Un motivo inválido es 400 y no escribe nada.
    Los detalles del surtidor y de la caja, y `vendor/presale-status`, traen `justifications`.
  - Pantallas: hoja de motivo en la app de vendedores (`vendor-motivo-sheet`); en `apps/view`, `app-motivo-chips` y
    `app-justificantes` (en `modules/almacen/shared/`).
  - Contratos aditivos: una pantalla vieja que no manda motivo sigue funcionando (queda «sin motivo registrado»).
- **Por qué así:** el motivo vive donde ya vivía el registro de cada paso (historia del pedido, reporte del surtido,
  revisión de caja), así que no hace falta migración y lo viejo se sigue leyendo. Bloquear «Corregir» con el surtido
  empezado ataca la causa del desorden medido (renglones cambiando bajo la mano del surtidor), no sólo lo documenta.

### Decisiones de David (2026-11-11; cada una se revierte en una constante del contrato)

David: «que sea motivo obligatorio, agregas unas pre hechas, los tres roles».

| | Decisión | Quedó así | Dónde se cambia |
|---|---|---|---|
| D1 | ¿«Corregir» con el surtido empezado? | **No** (`hasta_que_empiece_el_surtido`), sin cambio | `POLITICA_CORREGIR` |
| D2 | Motivos ya hechos por acción | **Más opciones:** Corregir 7 (+ «Cambiar las indicaciones o la forma de entrega») · Cancelar 7 (+ «El cliente no tiene con qué pagar o no tiene crédito», «No hay lo que pidió», «Me equivoqué de cliente») · Surtido 6 (+ «El sistema dice que hay, pero no lo encontré», «No había en la presentación que pidió») · Caja 5 (+ «Venía otro producto o presentación»). Las claves de antes no cambian | `MOTIVOS_*` |
| D3 | ¿Foto o documento como evidencia? | **No construido**, sin cambio | — (pide almacenamiento y permiso) |
| D4 | ¿Motivo obligatorio? | **Sí, también en el servidor, en los tres roles.** Sin motivo es 400 y no se escribe nada: «Corregir»; cancelar un pedido AGENDADO que es tuyo; cada renglón que el surtidor quita o recorta; cada renglón que la caja deja por debajo de lo surtido. El texto fijo de antes («Cancelado por el vendedor», «reabierto para corregir») no cuenta. El 400 dice cómo salir: «ciérrala y vuelve a abrirla para tener la versión nueva». En surtido y caja el motivo más común sigue ya marcado (es lo que dice el botón que se tocó) | `MOTIVO_OBLIGATORIO_EN_SERVIDOR`, `MOTIVO_*_POR_OMISION` |
| D5 | ¿Quién ve qué? | **Los tres roles ven todo el porqué**, también el surtidor mientras surte (antes, sólo lo de la vendedora) | `almacen-surtir` (`justificantesPedido`) |

**Fuera de D4, a propósito:** el cliente del portal B2B (`customer_b2b`) y Comercial cancelando el pedido de otra persona
(su pantalla no pide motivo; en 30 días hubo 0 casos); el surtido por ruta (`SURTIDO_DE_RUTA`, apagado; su pantalla
no pide motivo). ⚠️ **Riesgo al soltar:** una pantalla vieja en caché (app de vendedores o de almacén) que no manda
motivo recibe el 400 con el aviso de recargar; lo que el surtidor ya marcó se guarda en el celular y no se pierde.

### Criterios de aceptación

- **Dado** un pedido agendado que nadie ha empezado a surtir, **cuando** la vendedora toca «Corregir», elige un motivo
  y confirma, **entonces** el pedido vuelve a borrador y su historia guarda el motivo.
- **Dado** un pedido que el surtidor ya empezó, **cuando** la vendedora toca «Corregir», **entonces** no se le pide
  motivo, el pedido sigue agendado y ve quién lo surte, desde qué hora y qué hacer.
- **Dado** un renglón marcado con faltante, **cuando** el surtidor termina sin tocar el motivo, **entonces** el reporte
  guarda «No había en la sucursal»; **y si** elige «Otro motivo» sin escribir, «Terminé de surtir» no se habilita.
- **Dado** un producto que el surtidor dio completo y la caja no encuentra, **cuando** la caja termina, **entonces** la
  revisión guarda el motivo de la caja; un faltante que ya venía del surtido no se vuelve a preguntar.
- **Dado** un pedido con cambios, **cuando** la vendedora, el surtidor o la caja lo abren, **entonces** ven quién, a
  qué hora, qué y por qué; lo guardado antes de este cambio dice «Sin motivo registrado».

### Lo que se probó

- **D4/D2/D5 (2026-11-11), base real:** justificantes 39 ✓ (3 corridas), recuento 36, monitoreo 22, revisión en caja 31,
  sustituto 53; sabotaje (motivo opcional) → 3 ✗. Unitarias: motor `justificantes.engine.spec.ts` 21 (obligatorio, texto fijo que no cuenta, motivos nuevos,
  renglones sin motivo con sus nombres); `presale-picking.service.spec.ts` con la negativa «un faltante sin motivo es
  400 y no recorta nada» (sabotaje: con `MOTIVO_OBLIGATORIO_EN_SERVIDOR = false` se pone en rojo).
- Base real (Docker local, una transacción revertida): `database/tests/test-newdb-justificantes-pedido.js` — 33 de 33,
  con el controlador real y el payload de la pantalla; negativas que no escriben (motivo de otra lista, «Otro» sin nota,
  nota de 201, motivo de caja al surtir); sabotaje: con `POLITICA_CORREGIR = 'permitir'` falla en 6 puntos.
- Unitarias: `justificantes.engine.spec.ts` (18), `motivos-preventa.spec.ts` (4), pruebas nuevas en las specs de
  Surtir, Pedidos por surtir y Revisión, y `vendor-justificantes.spec.ts` (9); cada comportamiento con su negativa y
  sabotaje que las pone en rojo.
- ⚠️ **Sin validación visual**: no se levantó ninguna app; lo pinta la prueba montada, no un navegador.

### Lo que NO se hizo (y por qué)

- **Cancelar desde Comercial** (`/comercial/pedidos/:id`) sigue sin pedir motivo y sin bloqueo por surtido (0 casos de
  cancelación de agendados en 30 días): queda «sin motivo registrado».
- **Surtido por ruta** (`SURTIDO_DE_RUTA`, apagado): su cierre no manda motivo.
- **Las olas de la consola de surtido** no bloquean «Corregir» (sólo `presale_picks`): no medido.
- **36 de 286 revisiones** las hizo la misma persona que surtió: fuera de alcance, se reporta.
