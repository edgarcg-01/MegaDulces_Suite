# Mis gastos v2 — «¿qué me toca?» y nada atorado sin dueño (`[GX.91]`–`[GX.97]`)

> Formato del módulo: problema · solución · implementada · por qué. Análisis de diseño según
> `diseno` §0a/§0b (por escrito, antes de la plantilla). Medido en prod (sólo lectura) el
> 2026-11-05; aquí van conteos, no importes.

## 1 · El problema (medido)

Auditoría en producción de `/finanzas/mis-gastos` y de la captura, recorriendo el proceso como
quien sube un gasto:

| Hallazgo | Medida |
|---|---|
| Un **doble clic** en «Enviar a aprobación» crea **dos vales** del mismo folio | 2 vales en el mismo segundo (la pantalla impedía el duplicado, el servidor no) |
| Revisados con el ciclo **terminado** que se quedan «Falta el gasto en Kepler» para siempre | **32** con la solicitud cancelada en Kepler; **24** de ellos además decían «ejercido» |
| Rechazos que **desaparecen a las 24 h** sin recapturarse | **19**, ninguno recapturado |
| Revisados que esperan a Kepler y sólo los ve quien capturó (que no puede hacer nada) | **62** (38 autorizados sin gasto, 24 sin autorizar); 13 con más de 30 días |
| Cifras que no cuadran | «En juego (abiertos)» en $0.00 con 5 abiertos; cerrados cortados en 200 sin aviso (1 persona tiene 354) |
| Asignados de antes del arranque de la Suite, en rojo para siempre | 3 |
| La caja de búsqueda promete «concepto» y no lo busca; lo asignado no se filtra | — |
| Mismo archivo adjunto dos veces sin aviso; el concepto se teclea aunque Kepler lo trae | — |
| Tablero de tres columnas desbalanceado | con 30 vales: 3,285 px contra 955 y 839; 4 pantallas de alto; 49 señales rojas |

## 2 · Las causas

- **Dos reglas de «cerrado» que se separaron.** El tablero cerraba un vale sólo con su gasto `XA1001`
  ligado (`cicloCerrado`, en la pantalla); la etapa salía de `etapaDeEjercicio` (en el contrato). Una
  solicitud cancelada no tiene gasto que esperar, y nunca cerraba.
- **El contrato contradecía su propio comentario**: «la cancelación manda», pero preguntaba primero
  si había gasto aplicado. Ninguna prueba cubría la cancelada **con** gasto.
- **`submit()` no revisaba si ya había un envío en curso**, y el servidor no frenaba el segundo vale.
- **El rechazo se ocultaba por reloj** (`[GX.29]`), no porque dejara de pedir algo.

## 3 · Decisiones del usuario (2026-11-06)

1. El rechazo se queda en «Te toca» hasta que **Kepler cancela la solicitud** o **se recaptura**.
2. Revisado con la solicitud cancelada: **se cierra**; si Kepler había generado el gasto, además es
   un **hallazgo** para quien aprueba («¿salió dinero?»).
3. Segundo vale vivo del mismo folio: **se bloquea** y se lleva a la persona a su vale. La regla es
   la que la pantalla ya tenía: cualquier vale no rechazado, de quien sea.
4. Alcance: todo, incluido el rediseño. **Fuera**, por decisión pendiente del PM: el mapeo usuario
   Kepler ↔ Suite (necesita tabla nueva) y los recordatorios por notificación (necesitan tarea
   programada).

## 4 · El diseño (diseno §0a/§0b)

**Propósito (la frase):** *¿Qué tengo que hacer con mis gastos?* Lo demás se ordena por **a quién le
toca**, que es lo que la auditoría mostró que faltaba: casi todo lo atorado esperaba a alguien que no
lo veía.

**Quién entra:** quien captura (entra directo a esta pestaña, `gastos-area-entry.guard`) y quien
aprueba, que además tiene el buscador de arriba (`[GX.88]`).

**Nivel 0, en este orden:**
1. Título + **«Capturar gasto»** (la única acción primaria; antes no había entrada a la captura).
2. La respuesta: «Te tocan N vales» o «Nada te toca», y cuánto sigue sin cerrar.
3. Un control segmentado **con sus conteos**: *Te toca · Esperan a Finanzas · Esperan a Kepler ·
   Cerrados*. Reemplaza la tira de 4 tarjetas: el conteo vive en el filtro, no repetido arriba.
4. La lista (tabla densa): folio (abre el visor) · proveedor · etapa · qué falta / a quién espera ·
   días · importe · acción.

**Qué se quita y por qué:**

| Pieza de hoy | Decisión | Por qué |
|---|---|---|
| Tira de 4 KPI con bordes de color | se va | repetía los conteos; «En juego» mentía |
| Tres columnas con zonas rojo/verde | una lista con filtro | desbalance medido; 49 señales rojas |
| Agrupado por clave de proveedor | columna ordenable | la clave sigue visible; agrupar dejaba grupos de 1 |
| Códigos XA1501 / XA1001 en encabezados | se van | jerga; el folio de Kepler sigue en el visor |
| Botón rojo relleno por tarjeta | botón secundario por renglón | rojo sólo para lo que está mal (devuelto, atorado) |

**Se conserva:** los nombres que la gente usa (*Solicitud · Pendiente de comprobación · Expediente*,
como etiqueta de etapa), el visor compartido, sumar evidencia (`[GX.87]`), el refresco al minuto
(`[GX.73]`) y que el servidor recorte por usuario (nunca el cliente).

**Mapa de desglose:** cada conteo del filtro abre su lista; cada folio abre el visor del vale con
sus archivos; lo cerrado dice por qué cerró (gasto aplicado / solicitud cancelada).

**Lo que la interfaz NO resuelve:** las solicitudes de Kepler cuyo solicitante no coincide con un
usuario de la Suite (casi todas las que no tienen vale) no le aparecen a nadie aquí. Eso es el mapeo
pendiente del PM.

## 5 · Implementada

| Ticket | Qué |
|---|---|
| `[GX.91]` | Un envío a la vez (`submit()`), candado por folio en `create()` + 409 con el vale existente |
| `[GX.92]` | `cicloCerrado`/`motivoDeCierre` en el contrato: cierra con gasto **o** con la solicitud cancelada |
| `[GX.93]` | `etapaDeEjercicio`: la cancelación manda sobre el gasto aplicado (+ la prueba que faltaba) |
| `[GX.94]` | Rechazo visible en «Mis gastos» hasta recapturar o cancelación en Kepler |
| `[GX.95]` | Cifras: cortes declarados (abiertos, cerrados, asignados); búsqueda por concepto y en asignados; asignados desde el arranque |
| `[GX.96]` | `GET esperan-kepler` + pestaña «Esperan a Kepler» en Aprobación, con los hallazgos |
| `[GX.97]` | Rediseño de «Mis gastos»; archivo repetido avisado; «usar el concepto de Kepler» a un clic |

**Retirado tras medir:** dejar de firmar archivos en el refresco. Firmar es un cálculo local y las
firmas vencen a los 10 min: el refresco al minuto es lo que las mantiene vivas.

## 6 · Cómo se prueba en local

`node database/scripts/dev-seed-gx91-mis-gastos.js --usuario <tu usuario local>` (sólo destino seguro) crea un caso de cada
situación; `--limpiar` los borra. Ver el script para la lista.

## 7 · Aprobación: departamento de Kepler, evidencia en grande y sin regresar al inicio (`[GX.98]`–`[GX.100]`)

**Problema (medido en prod el 2026-11-06):**
- La barra «Por departamento» agrupaba por un dato falso: los **1,672 vales** dicen `Sucursal NN` en
  `departamento` (la captura nunca lo pregunta).
- La evidencia se pintaba a lo ancho del panel, una debajo de otra, sin poder acercar.
- Después de aprobar o al tocar «Actualizar», la lista se cambiaba por «Cargando…», la vista regresaba
  al inicio y se perdía el departamento elegido (reportado por el usuario).

**Solución:**
- `[GX.98]` El departamento sale de los renglones de la solicitud en Kepler (`kdm6.c16` → `kdc3`).
  Cobertura: 1,655 de 1,672 vales; 41 códigos, todos con nombre y el mismo en cada sucursal; 355 vales
  reparten el gasto entre 2 o más. **Decisión del usuario:** el repartido aparece en cada departamento
  con su parte («$750 de $1,250»), por proporción de sus renglones (458 los traen sin IVA) y repartido
  al centavo. La barra va en Hoy y en Atrasados. Una consulta para todos los vales (~110 ms / 500).
- `[GX.99]` Visor grande (`app-visor-evidencia`): el archivo en grande, flechas, acercar/alejar, girar,
  tira de miniaturas y «abrir aparte»; teclado ← → + − 0 R; **Esc cierra sólo el visor** (en la
  maqueta cerraba también el vale). En el panel, cada archivo **entero y sin scroll** (pedido del
  usuario): lado a lado, ajustado a su recuadro, el PDF con su página completa; el panel pasa de 820 a
  1,120 px y los datos ocupan menos alto. Medido: la evidencia queda arriba del pie a 900 y a 768 px.
- `[GX.100]` Actualizar y decidir **en silencio**: la lista se queda mientras llegan los datos nuevos,
  conserva pestaña, departamento y posición; si falla, avisa y deja lo de antes. Pestaña y departamento
  van en la URL (`?pestana=&depto=`), así que F5 regresa al mismo lugar. Medido en la maqueta: con el
  arreglo la vista sigue en 700 px tras aprobar; sin él (control) regresa a 0.

**Sin medir:** con datos reales (la maqueta usa la pantalla real con datos de demo y la API simulada),
modo claro, Alto Contraste de Windows y ancho de teléfono.

## 8 · El buscador de gastos junto al título (`[GX.101]`)

**Problema:** el buscador (`[GX.88]`) iba arriba de las pestañas como una barra a todo lo ancho, que se
leía como parte del encabezado de la página y no como algo para usar (pedido del usuario: «a uno más
visible»).

**Solución:** la caja va en el encabezado de cada pantalla (Aprobación, Mis gastos, Expediente,
Historial), a la derecha del título y junto a «Actualizar»; los resultados, debajo de ese encabezado. El
componente se parte en dos piezas (`parte="caja"` / `parte="resultados"`) que leen el MISMO estado del
shell: lo escrito se conserva al cambiar de pestaña. Al buscar, el encabezado se queda (si no, la caja se
iría mientras se escribe) y lo de abajo se cambia por los resultados. Sólo lo ve quien aprueba; quien sólo
captura conserva la búsqueda propia de «Mis gastos». Se quitó la segunda tachita (la del navegador).
