# Investigación + plan: envío de ventas de ruta con conectividad intermitente

> Objetivo: mejorar **cómo** las camionetas nos mandan la venta, de modo que **detecten cuando tienen internet y envíen solas**, sin depender de que alguien esté al pendiente.
> Contexto: el push actual dejó de subir venta en `ruta_23`/`ruta_27` desde el 1–2 de julio 2026 sin que nadie se enterara (ver [`INVENTARIO_Y_PLAN_RUTAS.md`](INVENTARIO_Y_PLAN_RUTAS.md) §1.1).
> Fecha: **2026-07-13**.

---

## 1. El problema en una frase

El envío hoy es **"ciego y a ciegas"**: dispara cada 15 min pase lo que pase, y si en ese instante no hay internet, **falla en silencio** y espera al siguiente tick. Si la tarea se detiene, la laptop se apaga o pierde red por días, **nadie se entera** y la venta de esa ruta desaparece del análisis.

Queremos pasar a un envío **reactivo a la red** (envía en cuanto hay conexión) y **observable** (si una ruta deja de reportar, salta una alerta).

---

## 2. Cómo funciona hoy (y qué ya resuelve solo)

`push-ruta.cmd` (Task Scheduler, cada 15 min, como `SYSTEM`, oculto):
1. Lee la venta local de la camioneta (`md.kdm1⋈kdm2`, últimos **15 días**).
2. La streamea por pipe al runner `192.168.0.249:5433` → `ingest.route_sales_stg`.
3. `ingest.merge_route_sales('ruta_NN')` → `mart.ventas`.

**Propiedad importante (del [`runner-ingest-setup.sql`](runner-ingest-setup.sql)):** el merge borra **solo las fechas presentes en el lote** y el pull trae **una ventana móvil de 15 días**. Consecuencia:

> ✅ **La DB local de la camioneta YA es la cola durable.** No se necesita una cola/archivo de "pendientes": mientras la venta esté dentro de la ventana de 15 días, **un solo envío exitoso tras reconectar recupera todo lo atrasado**. El corte de 11 días de `ruta_23/27` cabe dentro de la ventana → se recuperaría con **una** corrida buena.

Esto acota el problema: **no es "guardar y reenviar", es "asegurar que dispare y conecte, y avisar si no lo hace"**. Mucho más simple que un sync offline genérico.

### Modos de falla reales
| Falla | ¿El diseño actual la maneja? | Hueco |
|---|---|---|
| Sin internet en el tick de 15 min | Parcial — reintenta en 15 min | Si el timeout de `psql` es largo, la tarea queda colgada; no reacciona al reconectar |
| Laptop vuelve a base con wifi 2 min | ❌ | Puede caer entre ticks; no hay disparo "al conectar" |
| Tarea borrada / deshabilitada | ❌ | Nadie se entera |
| Laptop apagada varios días | ✅ (si <15 días) | Solo si al prender vuelve a disparar y conectar |
| Cambió clave del runner / serie local | ❌ | Falla en silencio (0 filas) |
| Corte > 15 días | ❌ | Fuera de ventana → pérdida real |

---

## 3. Pregunta que define el diseño (confirmar antes de implementar)

**¿Cómo alcanza la camioneta al runner `192.168.0.249` (IP privada)?**

- **(a) Solo en la LAN de base** (la van sincroniza cuando regresa al CEDIS y se une al wifi de la empresa). → "Tener internet" en realidad es "estar de vuelta en la red de la empresa". El disparo debe reaccionar a *unirse a esa red*.
- **(b) Por VPN / DDNS desde la calle** (como las sucursales, que exponen Kepler por `*.ddns.net:1801`). → Puede sincronizar en tiempo casi real; el disparo reacciona a *cualquier internet* + VPN arriba.

**✅ CONFIRMADO (2026-07-13): escenario (a).** Las camionetas llegan y se conectan a la red de **PH o CEDIS**, y **todo es una sola red interna** — no hay VPN desde la calle. Es decir: **una camioneta sincroniza cuando regresa a base y se une a la red interna**. Implicaciones:
> - El disparo por **evento de red (10000)** es el mecanismo ideal: dispara en el instante en que la van se une al wifi/LAN de PH/CEDIS.
> - La **frescura es por-retorno** (aprox. diaria), no intradía. La alerta de frescura debe medir "¿reportó al volver?" (~24–30 h), no umbrales cortos de horas.
> - Confirmar de una vez que `192.168.0.249:5433` es alcanzable **desde ambos segmentos** (PH y CEDIS) — el usuario indica que es una red interna única, así que debería serlo.

> Dato: este equipo (analítica) sí alcanza `.249` y `.245` → está en la misma red interna. Las sucursales usan DDNS+puerto.

---

## 4. Opciones evaluadas

### Opción A — Task Scheduler nativo, reactivo a la red *(recomendada)*
Windows ya sabe avisar cuando una red se conecta. Se combinan **dos disparadores** + condiciones:

1. **Disparo por evento de red:** log `Microsoft-Windows-NetworkProfile/Operational`, **Event ID 10000 = "red conectada"**. En cuanto la laptop obtiene conectividad (wifi de base, datos, VPN), la tarea dispara (con un delay de ~30 s para que asiente DHCP/VPN).
2. **Disparo cada 15 min** (heartbeat/red de seguridad).
3. **Condición** "iniciar solo si hay una conexión de red disponible" → no gasta corridas sin red.
4. **"Ejecutar lo antes posible tras un inicio omitido"** → si la laptop estaba apagada al tocar el tick, corre al prender.
5. **"Reiniciar la tarea si falla": cada 5 min, 3 veces** → absorbe un reconecte a medias.
6. **Límite de ejecución 10 min** → no deja procesos colgados.

Costo: **cero código nuevo**; solo cambiar el registro de la tarea de `schtasks` plano a **importar un XML** (el CLI no expone trigger-por-evento ni restart-on-failure; el XML sí). Plantilla lista en Apéndice A.

- ✔️ Nativo, sin dependencias, robusto, se auto-recupera.
- ✔️ Cubre escenario (a) y (b).
- ➖ Config por XML (una vez por camioneta; se automatiza con la plantilla).

### Opción B — Precheck de conectividad dentro del `.cmd` *(complemento de A, recomendada)*
Antes de intentar el pipe, el script hace una prueba **corta** al runner y sale rápido si no hay línea, en vez de colgarse en el timeout de `psql`:
```
psql "…/kepler_consolidado?connect_timeout=5" -tAc "select 1"
```
Si falla → log `OFFLINE` y termina en <5 s (deja que el siguiente disparo lo reintente). Además se agrega `connect_timeout=5` a las URIs `SRC`/`DST`. Snippet en Apéndice B.

- ✔️ Elimina cuelgues; logs claros online/offline; trivial.

### Opción C — Servicio/watcher residente (NLM COM `INetworkListManager`)
Un pequeño proceso siempre activo escuchando eventos de conectividad y disparando el push.
- ➖ Más código, hay que mantenerlo como servicio, empaquetar, monitorear que viva. **Sobra**: la Opción A da lo mismo con infraestructura nativa. **Descartada.**

### Opción D — Cola/store-and-forward propio (archivos de pendientes, SQLite, etc.)
- ➖ **Innecesaria**: como se explicó en §2, la DB local + ventana de 15 días + merge idempotente ya son la cola. Agregar otra cola es duplicar estado y crear un segundo punto de falla. **Descartada** (salvo que se necesiten cortes > 15 días, entonces se **amplía la ventana**, no se agrega cola).

### Transversal — Heartbeat + alerta de frescura *(recomendada, es lo que faltó)*
Nada de lo anterior sirve si una ruta muere y no nos enteramos. Cada envío exitoso escribe su **latido** en el runner; un scanner central alerta si una ruta lleva > X horas hábiles sin reportar. Esto es lo que hubiera cachado la caída de `ruta_23/27`. SQL en Apéndice C.

---

## 5. Recomendación

**A + B + Heartbeat.** Es la combinación de mayor robustez con el menor código nuevo, 100% sobre herramientas ya presentes (Task Scheduler, psql, Postgres). Reactiva a la red, se auto-recupera, y es observable.

```
Red se conecta (evento 10000) ─┐
Cada 15 min (heartbeat)       ─┼─▶ Tarea (solo si hay red) ─▶ push-ruta.cmd
Inicio omitido / reintento    ─┘        │
                                         ├─ precheck runner (connect_timeout=5) → OFFLINE? log y sale
                                         ├─ pipe venta local → runner (idempotente)
                                         └─ escribe heartbeat  ◀── scanner central alerta si stale
```

---

## 6. Plan de implementación

### Fase 0 — Confirmar y sanear (bloqueante)
- [ ] Responder §3: ¿las camionetas llegan a `.249` por LAN de base o por VPN? Ajustar expectativa de frescura.
- [ ] Diagnosticar por qué murieron `ruta_23`/`ruta_27` (task borrada / laptop / red / clave / serie). Es el caso de prueba real.

### Fase 1 — Endurecer el agente (una camioneta piloto, ej. `ruta_27`)
- [ ] `push-ruta.cmd` v2 con **precheck + `connect_timeout`** (Apéndice B).
- [ ] Reemplazar el registro de tarea por **XML reactivo a red** (Apéndice A) vía `schtasks /Create /XML`.
- [ ] Aplicar **heartbeat** en el runner (Apéndice C) y que el script/función lo escriba.
- [ ] Probar: desconectar/reconectar la red de la laptop y confirmar que dispara solo al reconectar (evento 10000) y que el heartbeat avanza.

### Fase 2 — Alerta de frescura (central)
- [ ] Scanner/cron en la plataforma que consulte `ingest.route_push_heartbeat` y marque rutas `stale` en horario hábil → alerta (reusar el patrón de scanners/findings existente).
- [ ] Umbral (escenario (a), frescura por-retorno): sin latido > 30 h = warning (no reportó en su retorno esperado); > 72 h = crítico. Ajustar por cadencia real de cada ruta.

### Fase 3 — Desplegar al resto + parametrizar
- [ ] Convertir la plantilla en **parametrizable** (`config.cmd` con `TRUCK`/`ROUTE_SERIE`/`SRC` por máquina) para que el `.cmd` y el XML sean idénticos en todas las vans → alta = copiar + llenar config + importar XML.
- [ ] Onboarding camioneta por camioneta con la receta del inventario (§3 de [`INVENTARIO_Y_PLAN_RUTAS.md`](INVENTARIO_Y_PLAN_RUTAS.md)).
- [ ] (Opcional) rol `ingest` least-privilege en vez de `postgres/superoot` en las laptops.

### Fase 4 — Resiliencia extra (si aplica)
- [ ] Si aparecen cortes > 15 días: subir `DAYS` (p. ej. 30) — la única palanca necesaria, sin cambiar arquitectura.
- [ ] Considerar VPN estable si se quiere frescura intradía en escenario (a).

---

## Apéndice A — Task XML reactivo a la red (plantilla)

Guardar como `ruta.task.xml`, ajustar `<Command>`/`TASKNAME`, importar con:
`schtasks /Create /TN RutaNN /XML ruta.task.xml /F`

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Push de venta de ruta: cada 15 min + al conectar la red.</Description>
  </RegistrationInfo>
  <Triggers>
    <!-- Dispara EN CUANTO se conecta una red (NetworkProfile: red conectada) -->
    <EventTrigger>
      <Enabled>true</Enabled>
      <Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"&gt;&lt;Select Path="Microsoft-Windows-NetworkProfile/Operational"&gt;*[System[(EventID=10000)]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription>
      <Delay>PT30S</Delay>
    </EventTrigger>
    <!-- Heartbeat cada 15 min, todo el día -->
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition><Interval>PT15M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId> <!-- SYSTEM -->
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>            <!-- corre tras inicio omitido -->
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT5M</Interval><Count>3</Count></RestartOnFailure>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>C:\KeplerPush\push-ruta.cmd</Command></Exec>
  </Actions>
</Task>
```

## Apéndice B — Precheck de conectividad (push-ruta.cmd v2)

Insertar **antes** del paso 1 (limpiar staging), y agregar `?connect_timeout=5` a `SRC`/`DST`:

```bat
REM 0) Precheck: ¿el runner responde? Si no, salir rapido (no colgarse en timeout).
%PSQL% "%DST%" -tAc "select 1" >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] OFFLINE: runner .249 no alcanzable; se reintenta al reconectar >> "%LOG%"
  goto :eof
)
echo [%date% %time%] ONLINE: runner alcanzable, iniciando push %TRUCK% >> "%LOG%"
```
```
set SRC=postgresql://postgres:<CLAVE_LOCAL>@localhost:5432/<DB_LOCAL>?connect_timeout=5
set DST=postgresql://postgres:<CLAVE_RUNNER>@192.168.0.249:5433/kepler_consolidado?connect_timeout=5
```

## Apéndice C — Heartbeat en el runner

```sql
-- Latido de cada camioneta. Se actualiza SOLO en push exitoso.
CREATE TABLE IF NOT EXISTS ingest.route_push_heartbeat (
  truck      text PRIMARY KEY,
  last_ok    timestamptz NOT NULL,
  rows_last  bigint,
  last_run   timestamptz NOT NULL DEFAULT now()
);
GRANT INSERT, UPDATE, SELECT ON ingest.route_push_heartbeat TO ingest;

-- Opción 1: extender merge_route_sales para que escriba el latido (recomendado).
-- Al final de la función, antes del RETURN n;
--   INSERT INTO ingest.route_push_heartbeat(truck,last_ok,rows_last,last_run)
--   VALUES (p_truck, now(), n, now())
--   ON CONFLICT (truck) DO UPDATE
--     SET last_ok=EXCLUDED.last_ok, rows_last=EXCLUDED.rows_last, last_run=EXCLUDED.last_run;

-- Consulta de frescura (para el scanner/alerta central):
SELECT truck, last_ok, rows_last,
       round(extract(epoch FROM now()-last_ok)/3600,1) AS horas_sin_reportar
FROM ingest.route_push_heartbeat
ORDER BY last_ok;
```

---

## 7. Resumen ejecutivo

- El envío **ya tolera cortes de hasta 15 días** (la DB local es la cola); lo que falta es **disparar al reconectar** y **avisar cuando una ruta se calla**.
- Solución de menor código y mayor robustez: **Task Scheduler reactivo a la red (evento 10000) + heartbeat de -seguridad cada 15 min + precheck de conectividad + alerta central de frescura**. Todo con herramientas ya instaladas.
- No se necesita cola offline, ni servicio residente, ni reescribir el agente.
- **Bloqueante previo:** confirmar cómo llegan las vans al runner (LAN de base vs VPN) y sanear `ruta_23/27`.
```
