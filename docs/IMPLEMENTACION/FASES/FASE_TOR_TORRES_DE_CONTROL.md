# Fase TOR — Torres de control: Sistemas y Desarrollo

> El método que la gobierna: [`docs/METODO_DE_TRABAJO.md`](../../METODO_DE_TRABAJO.md).
> Nace de rehacer `/admin/db-health` desde cero (`[DH.5]` corrigió lo que mentía; esto la reemplaza).

```
OBJETIVO: que Sistemas vea si los servidores y carriles de Kepler funcionan, y Desarrollo si
          nuestra infraestructura está sana y al día con main — cada falla con dueño.
MÉTRICA:  fallas activas sin ver — HOY (2026-11-04): 25 alertas abiertas, 0 vistas, la más vieja
          de 42 días; 12 carriles en error o detenidos (5 de más de una semana); el respaldo fuera
          del servidor en error desde el 31-oct → META: ninguna falla abierta más de 24 h sin
          dueño que la haya visto, para 2026-11-30
CAPA TOPE: C3
ÁREA:      Plataforma
DUEÑO:     Edgar (firma) · dueños por carril: D5
ESTADO:    🔨 — abierta por el PM el 2026-11-04 («hagámoslo»), 8ª en curso, por encima del cupo de 4
```

Medido en sólo lectura el 2026-11-04: `pg-prod` (`system_identifier` 7688376744939610156) y la
fuente de réplicas en `md` `:5433` (7644631598664073265), más `git ls-remote` del carril de entrega.

---

## 1. Qué problema resuelve

`/admin/db-health` mezcla dos oficios en una sola columna de nueve bloques: **el de Sistemas**
(¿llegó el dato de cada sucursal?) y **el de Desarrollo** (¿qué versión corre, cómo está la base?).
Ninguno de los dos encuentra lo suyo, y la bandeja que debía juntarlos no la atiende nadie.

| Hecho medido hoy | Qué cuesta |
|---|---|
| El respaldo fuera del servidor (`respaldo_fuera`) en error desde el 31-oct | si se pierde `md`, se pierde todo lo que no está en otro lado |
| `md` se reinició completo el 1-nov 22:02 (prod y la fuente arrancaron en el mismo segundo) y ninguna pantalla lo dijo | un reinicio sin apagado limpio borra contadores; el motor dio «Crítico» falso hasta `[DH.5]` |
| 12 carriles en error o detenidos; cobranza de ruta y autollenado de caja desde el 19-oct | dato que la operación cree vigente y no lo es |
| 2 commits sellados sin soltar y 4 migraciones sin aplicar (una del 2-nov) | lo terminado no llega |
| 269 tipos de consulta con media de más de 500 ms desde el reinicio (`pg_stat_statements`) | por regla del proyecto, una consulta de más de 500 ms no funciona |
| 14 permisos declarados que no tiene ningún rol | módulos «entregados» que nadie puede abrir (regla 20) |
| 25 alertas abiertas, 0 vistas | la bandeja es papel tapiz |
| Réplicas de sucursal: 9 de 9 reciben (la más atrasada, 26 s); 5 errores de aplicación acumulados | hoy está bien, pero **la API de prod no lo puede ver** (§3, TOR.0.1) |

---

## 2. Qué NO incluye

- **Arreglar** cada falla de §1: van como incidentes a su carril, no esperan a esta fase (§8).
- Escribir en Kepler ni en ningún servidor desde la pantalla (la escritura Suite→Kepler está apagada).
- Botones que reinicien pods, apliquen migraciones o suelten versiones: la torre **informa y
  manda al runbook**; ejecutar sigue siendo el carril `entrega` en `md`. Un botón así es una
  credencial con forma de botón (regla 7).
- Telemetría de navegador o de uso por pantalla.
- Borrar `/admin/db-health`: se redirige a la torre de Desarrollo cuando ésta esté en prod.

---

## 3. Las dos pantallas

### 3.1 Torre de Sistemas — servidores y carriles de Kepler

**La frase:** *¿qué servidor o carril de Kepler está caído o atrasado, en qué sucursal, y qué hago?*

**Las cinco preguntas** ([`diseno` §0b](../../../.claude/skills/diseno/SKILL.md)):

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | Qué ve y en qué orden | Veredicto («2 sucursales con problema») → **matriz sucursal × carril** → bandeja de lo que hay que atender, lo más grave primero |
| 2 | Qué no ve | Versiones, migraciones, el motor de prod, CI: eso es de Desarrollo |
| 3 | Accesibilidad | Sucursal **por nombre**; cada celda con estado en palabra + edad; desglose al lado sin salir |
| 4 | Ligada a otro proceso | Cada falla enlaza a su runbook y, si la reporta alguien, al ticket de Mesa de Servicio |
| 5 | ¿Le toca? | Sí: es el trabajo diario de Sistemas. Los tickets de Mesa de Servicio (12 asignados hoy) viven acá |

> Boceto: los valores son de ejemplo, no medidos.

**Jerarquía:** primario = el veredicto y las celdas en rojo · secundario = la matriz completa ·
terciario = notas y edad de cada celda.

```
 Torre de Sistemas                                      verificado hace 40 s
 ─────────────────────────────────────────────────────────────────────────
 2 sucursales con problema · 1 carril detenido · 3 tickets esperando
 ─────────────────────────────────────────────────────────────────────────
                     Servidor   Réplica   Al ODS   Caja    Camionetas  Relojes
 Matriz              Kepler     lógica             (mdb)   (push)
 Morelia Madero      ●  arriba  ● 4 s     ● 1 min  —       ● hoy       ● 2 min
 La Piedad Abastos   ●  arriba  ▲ 3 err   ● 1 min  —       ✕ 18 d      ● 5 min
 CEDIS               ○ NO MEDIDO (Access 97)        …
 …
 ─────────────────────────────────────────────────────────────────────────
 Atender                                           dueño     desde
 ✕ Camioneta 504 sin día nuevo                     —         18 d   runbook ›
 ▲ Réplica La Piedad: 3 errores de aplicación      —         ?      runbook ›
 Ticket SD-0081 «no me cuadra la caja»            Sistemas  2 d    abrir ›
```

**Carriles** (columnas de la matriz y renglones de servidores sin sucursal):

| Carril | Fuente hoy | ¿La API de prod la ve? |
|---|---|---|
| Servidor Kepler de cada sucursal + réplica lógica | `pg_stat_subscription` en la fuente `:5433` | ❌ no tiene conexión a la fuente → TOR.0.1 |
| Del espejo al ODS | latidos `ods_live_*`, `cdc_reconcile*` (por sucursal sólo en texto libre) | 🟡 → TOR.0.2 |
| Caja General (`.mdb`) | latido `caja_general_replica_all` | ✅ |
| CEDIS (Access 97) | sonda en `db-health` | ✅ |
| Wincaja (`.249`) | sondas `wincaja_*` (retiradas, laten si revive) | ✅ |
| Camionetas (push de ruta, 11 cuelgan del reenvío de `.249`) | `rd_route_push_dia` | ✅ |
| Relojes checadores | `hr_attendance_*` | ✅ |
| GPS de flota | `vehicle_positions` | ✅ |
| Escritorio `.249` (Windows, requiere sesión) | — | ❌ NO MEDIDO → TOR.0.3 |
| Mesa de Servicio | `servicedesk.requests` | ✅ |

#### 3.1-bis Lo que Sistemas tiene que saber de Kepler (medido 2026-11-04, 30 días)

Las preguntas de Sistemas, tal como las hizo Edgar: *¿cómo sé cuándo se cae un servidor? ¿qué
alerta tengo? ¿cómo sé qué falló?*

**El camino del dato.** 9 servidores Kepler (Postgres, uno por sucursal) → réplica lógica a la
fuente de `md` `:5433` (9 suscripciones) → ODS en prod (`ods_live_*`, cada ~10 s) → la suite.
Aparte, `store_poller` se conecta **directo** a cada servidor cada ~25 s (tienda en vivo), y por
`.249` pasan CEDIS (Access 97), Wincaja y el push de las camionetas.

**1. ¿Cómo sé que se cayó un servidor? Hoy, no te enteras.** Hay dos señales que sí lo ven:

| Señal | Qué ve | Lo que mostró en 30 días |
|---|---|---|
| Bitácora de `store_poller` (`cron_run_log`) | cada intento de conexión fallido, **con la sucursal y el motivo** | 8,305 fallas (8,215 con sucursal). **16 episodios de 10 min o más.** El peor: **Morelia Madero, del 19-oct 09:32 al 20-oct 16:11, ~30 h seguidas con la tienda abierta** (lento, no inalcanzable). **Morelia Abastos inalcanzable toda la noche del 15 al 16-oct** (11 h). Canindo, Yurécuaro y CEDIS, de 1 a 3 h |
| Réplica lógica (`pg_stat_subscription` en `:5433`) | segundos desde el último mensaje de cada servidor (hay latido aunque no haya ventas) | hoy, las 9 a menos de 30 s. **Sin historia**: sólo se ve el instante, y la API de prod no la alcanza |
| Sensor `kepler_ods_branch_stale` (existe) | la sucursal con la venta más vieja del día, de 10:00 a 21:30 | **falsa alarma cada noche** por Canindo (deja de vender ~17:10) y rotula «activas 8/6» (escrito para 6 sucursales) |

⚠️ Un *timeout* del poller no prueba que el servidor esté apagado: puede ser lento o la red
saturada. *Inalcanzable* (`EHOSTUNREACH`) sí apunta a red o servidor apagado. La pantalla tiene que
decir cuál de los dos es, no «caído» para todo.

**2. ¿Qué alerta tengo? Ninguna fuera de la pantalla.** En 30 días se abrieron **633 alertas
(244 críticas) y no se notificó ninguna** (`last_notified_at` vacío en todas). El aviso por correo
(DBH.3) y por WhatsApp (OBS.5.2) están escritos y **apagados**: les faltan destinatarios y la
plantilla aprobada en Meta (`DB_HEALTH_ALERT_PHONES`, `DB_HEALTH_WA_TEMPLATE`). El toast de la
suite sólo lo ve quien tiene la pantalla abierta.

**3. ¿Cómo sé qué falló?** Las fallas de Kepler que se pueden distinguir, y si hoy se miden:

| Falla | Cómo se ve | ¿Se mide hoy? |
|---|---|---|
| Servidor o red caídos | el poller da *inalcanzable* y la réplica deja de recibir | ✅ poller · 🟡 réplica sólo en `md` |
| Servidor lento o saturado | el poller da *timeout*; la réplica sigue | ✅ poller |
| Réplica rota (conflicto al aplicar) | `apply_error_count` sube y la suscripción puede detenerse | 🟡 sólo en `md`. Acumulados hoy: CEDIS 3, Canindo 1, 8 Esquinas 1 |
| Réplica viva, dato congelado | mensajes llegan pero no hay ventas nuevas en horario | 🟡 el sensor existe, sin horario por sucursal |
| **Disco del servidor Kepler** | si `md` deja de consumir, el slot retiene WAL en la sucursal **hasta llenar su disco y tirar la caja** (runbook de replicación §0.3) | ❌ sólo se ve en cada servidor (`pg_replication_slots`) |
| Servidor reiniciado | arranque reciente | ❌ (`pg_postmaster_start_time()` en cada servidor) |
| Actualización de Kepler que quita una tabla de la publicación | esa tabla deja de replicar **en silencio** (runbook §0-bis) | ❌ (`pg_publication_tables` contra la lista esperada) |
| `md` mismo caído | todo lo anterior a la vez | ✅ watchdog; el reinicio completo del 1-nov 22:02 no lo dijo ninguna pantalla |

**Lo que esto agrega a C0:**

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| TOR.0.8 | **Disponibilidad por servidor** derivada de la bitácora de `store_poller`: episodios por sucursal con inicio, fin, duración y tipo (*inalcanzable* / *lento*) — vista `analytics.v_kepler_server_episodes` sobre `cron_run_log`, sin copia, acotada a 35 días | 🔨 migración `20261104114612` escrita, **sin aplicar** | ✅ cuerpo ejercido contra prod en sólo lectura: 495 episodios en 35 días, 130–178 ms; control: la caída más larga de Morelia Madero da 1,249.7 min, igual que la medición independiente. ⚠️ el `up()` lo ejerce el CI, no prod |
| TOR.0.9 | **Latido por servidor Kepler** (`kepler_server_<código>`, cada ~4 min) desde `store_poller`, con la misma conexión que ya usa (sin credencial nueva): no responde (inalcanzable/lento) desde cuándo, slot sin consumidor o perdido, WAL retenido, tablas publicadas que bajan, reinicio. Regla en `database/importers/lib/kepler-servidor.js`; las 9 llaves registradas en `db-health` → una alerta por servidor | 🔨 código, **sin desplegar** (imagen `trade-ingest`, `ops/vl/deploy.sh`) | ✅ `test-kepler-servidor.js` 10/10, mutante del slot sin consumidor muerto · sonda ejercida contra prod y la fuente de `md` (sin slots: prueba la consulta, no un slot real). ⚠️ **NO MEDIDO contra un servidor Kepler** (desde aquí no hay credencial): se ve al primer latido. ⚠️ falta registrar la prueba en `run-all-tests.js` (el archivo tiene cambios de otra sesión) |
| TOR.0.10 | **Horario por sucursal, DERIVADO de su propia venta** (los mismos días de la semana de las 8 semanas anteriores; el domingo cierra antes), en vez de preguntarlo: el sensor «sucursal congelada» sólo mira a las que están abiertas según su horario, y una que no ha vendido nada hoy cuenta desde su apertura | 🔨 código, sin desplegar | ✅ simulación cada 15 min sobre 14 días: **67 alarmas falsas (todas Canindo cerrada) → 0** · ✅ prueba negativa: Zamora Centro sin ventas hoy → antes invisible («7 de 8», verde), ahora 4.9 h «sin venta desde que abrió» · 56–86 ms. ⚠️ la simulación usa el dato de hoy: no ve caídas que la réplica rellenó después |
| TOR.0.11 | **Que la alerta llegue**: prender correo y/o WhatsApp con destinatarios de Sistemas | ⬜ espera destinatarios (D7) | una falla provocada llega al teléfono (prueba negativa) |

### 3.2 Torre de Desarrollo — nuestra infraestructura

**La frase:** *¿producción está sana y al día con `main`, y qué rompimos?*

| # | Pregunta | Respuesta |
|---|---|---|
| 1 | Qué ve y en qué orden | Veredicto → **tira de entrega** (`main` → sellado → soltado → corriendo, con migraciones pendientes) → bandeja → seis carriles desglosables |
| 2 | Qué no ve | Sucursales, Kepler, tickets: eso es de Sistemas. Configuración de autovacuum y peso por schema quedan en un desglose |
| 3 | Accesibilidad | Commit corto copiable; cada carril se abre al lado; «no medido» explícito |
| 4 | Ligada a otro proceso | La tira de entrega es el carril de la skill `entrega`: cada paso dice qué falta y el comando para `md` |
| 5 | ¿Le toca? | Sí: los 4 devs y quien suelta |

> Boceto: los commits y conteos son los medidos el 2026-11-04; el resto, de ejemplo.

**Jerarquía:** primario = veredicto + tira de entrega · secundario = bandeja · terciario = carriles.

```
 Torre de Desarrollo                                    verificado hace 40 s
 ─────────────────────────────────────────────────────────────────────────
 Producción sana · 2 commits sin soltar · 4 migraciones pendientes
 ─────────────────────────────────────────────────────────────────────────
 main 23be29b ─● sellado 23be29b ─▲ soltado 7db184b ─● corriendo 7db184b
               4 migraciones sin aplicar (la más vieja del 02/11)   cómo ›
 ─────────────────────────────────────────────────────────────────────────
 Atender                                           dueño     desde
 ✕ Respaldo fuera del servidor en error            —         4 d    runbook ›
 ✕ Carril autollenado de caja detenido             —         16 d   ›
 ▲ 269 consultas con media > 500 ms                —         —      ver ›
 ─────────────────────────────────────────────────────────────────────────
 Vida ●   Base ▲   Respaldos ✕   Disco ○ sonda incoherente   Carriles ✕   Errores ○ NO MEDIDO
```

**Carriles:**

| Carril | Qué muestra | Fuente hoy |
|---|---|---|
| Entrega | refs `main`/`ci-green`/`prod-release`, lo que corre, migraciones pendientes | lo que corre: `/api/health` ✅ · refs y pendientes: ❌ → TOR.0.4 |
| Vida | API, worker, túnel, pods listos y reinicios, arranque de Postgres | túnel ✅ · `pg_postmaster_start_time()` ✅ · pods ❌ → TOR.0.5 |
| Base | conexiones, bloqueos, consultas > 500 ms, filas muertas (sobre `reltuples`) | `pg_stat_activity`, `pg_stat_statements` (schema `identity`) ✅ |
| Respaldos | local, pgbackrest, fuera del servidor, `pgvector-md` | latidos ✅ · `pgvector-md` sin respaldo (auditoría 31-oct) |
| Disco y capacidad | libre, consumo por día, días hasta `DiskPressure` | `vigia_disco` 🟡 se contradice (17.9 GB/día en 24 h, 0 en 72 h) → TOR.0.6 |
| Carriles de la suite | crons de API/worker: última corrida, fallas en 7 días | `cron_runs`, `cron_run_log` ✅ |
| Errores de la app | excepciones por endpoint | ❌ NO MEDIDO (`instrument.ts` de Sentry existe; no se sabe si está prendido) → D4 |
| Permisos | permisos declarados sin ningún rol | `identity.role_permissions` ✅ |

---

## 4. Las capas

### C0 · Dato

| # | Item | Estado | Verificado contra |
|---|---|---|---|
| TOR.0.1 | Estado de la réplica de cada sucursal visible para la API: el carril `kepler_replica_refresh` (ya corre en `md`) late **una fila por sucursal** (`kepler_sub_<código>`) con segundos desde el último mensaje y errores de aplicación | ⬜ | `pg_stat_subscription` leído directo en `:5433` el mismo minuto |
| TOR.0.2 | `analytics.cron_runs.detail jsonb` (nullable): el latido dice su dato con estructura. Primer escritor: `kepler_server_<código>` (réplica s, errores, WAL retenido, tablas, arranque, leídos en UNA consulta a `pg_subscription` del clúster) | 🔨 migración `20261104125552` sin aplicar; el poller la escribe sólo si la columna existe | ✅ consulta de réplicas ejercida en la fuente de md: 9 de 9 con código (la `sub_pilot` es 8 Esquinas); `test-kepler-servidor.js` 14/14 |
| TOR.0.3 | Latido de `.249` (escritorio Windows): sesión iniciada, Docker arriba, tareas de Wincaja corriendo | ⬜ | Programador de tareas en la máquina |
| TOR.0.4 | Latido de entrega: `vigia-ci-green` escribe `main`, `ci-green`, `prod-release` y migraciones pendientes en cada pasada | ⬜ | `git ls-remote` + `aplicar-migracion.sh --pendientes` en `md` |
| TOR.0.5 | Latido de pods: réplicas listas y reinicios por deployment de `prod` e `ingesta` | ⬜ | `kubectl get pods` en `md` |
| TOR.0.6 | `vigia_disco`: corregir la incoherencia 24 h/72 h antes de publicar «días hasta DiskPressure» | ⬜ | `df` en `md` en dos fechas |
| TOR.0.7 | Dueño por carril como **definición configurable** (primitivo de la Fase DP), no texto en el código | ⬜ | la pregunta contestada por Edgar |

⛔ Sin importer: todo es latido de un carril que ya corre o catálogo de Postgres. Lo que no llega se
dibuja **NO MEDIDO**, nunca verde.

### C1 · Dominio

| # | Item | Estado | Prueba que lo ejerce |
|---|---|---|---|
| TOR.1.1 | **Primitivo de señal** en `libs/contracts` (`torres.contract.ts`): `SenalTorre`, `resumenDeSenales` (lo no medido nunca cuenta como bien), `ordenarSenales` | 🧪 | spec 5/5 con negativa |
| TOR.1.2 | `torreDeLlave`: a Sistemas lo que LLEGA de otro servidor (Kepler, puntos de venta, ContPAQi, CAOS, relojes, GPS); el resto a Desarrollo. Ninguna llave sin torre | 🧪 | spec con las llaves reales de prod |

### C2 · API

| # | Item | Estado | ¿Escribe? | Prueba contra base real |
|---|---|---|---|---|
| TOR.2.1 | `GET /admin/db-health/torre/sistemas` (servicio `torres.service.ts`): servidores, caídas, «Atender», otros carriles, avisos, Mesa de Servicio | 🧪 no | ✅ cada consulta ejercida contra prod en sólo lectura: 0–117 ms. ⚠️ el servicio completo corre al soltar (no se levanta la API local) |
| TOR.2.2 | `GET /admin/db-health/torre/desarrollo`: entrega (refs leídas de GitHub, cache 5 min; sin respuesta → no medido), «Atender», carriles | 🧪 no | ✅ ídem; GitHub contestó desde aquí (932 ms). ⚠️ NO MEDIDO si el pod de la API tiene salida a GitHub |
| TOR.2.3 | Marcar vista reusa `POST alerts/:id/ack` (ya existía); «con quién» queda pendiente | ⬜ | — |

### C3 · UI

| # | Item | Estado | `check:pantalla` antes → después |
|---|---|---|---|
| TOR.3.1 | `/admin/torre/sistemas` — Torre de Sistemas (diseño aprobado el 2026-11-04) | 🧪 sin validación visual | ✅ nueva: cumple las 10 reglas; barrido 0 nuevas · `ngc` sin errores (control TS2339 cazado) |
| TOR.3.2 | `/admin/torre/desarrollo` — Torre de Desarrollo; `/admin/db-health` redirige; la pantalla vieja se retira | 🧪 sin validación visual | ✅ nueva: cumple las 10 reglas |
| TOR.3.3 | Sidebar (dos entradas), árbol de permisos (mismo `PLATFORM_HEALTH_VER`, una fila), `MATRIZ_ACCESOS.md` por regenerar | 🔨 | permisos: D2 sin firmar (hoy `superadmin` y `recursos_humanos`) |

---

## 5. Decisiones a firmar

| # | Decisión | Opciones | Recomendación |
|---|---|---|---|
| D1 | **Cupo** | (a) abrir TOR como 8ª 🔨 · (b) pasar una 🔨 a ⏸️ · (c) dejar TOR ⬜ y hacer sólo C0 como incidentes | **(b)**. Si no, **(c)**: C0 son latidos que hacen falta igual |
| D2 | **Rutas y permisos** | permiso nuevo por torre · uno solo | **Dos**: `SISTEMAS_TORRE_VER` (nuevo) y `PLATFORM_HEALTH_VER` para Desarrollo. Quitárselo a `recursos_humanos` |
| D3 | **Cómo ve la API las réplicas** | (A) darle una conexión de lectura a la fuente `:5433` · (B) latido por sucursal desde `md` | **(B)**: no toca credenciales (regla 7) y sigue el patrón de todos los carriles |
| D4 | **Errores de la app** | confirmar si Sentry está prendido en prod · prenderlo (Fase A.1, ⏸️) · dejarlo NO MEDIDO | Confirmar primero; mientras, «NO MEDIDO» visible |
| D5 | **Dueño de cada carril** | nombres por carril | Necesito los nombres de Sistemas y de los 4 devs por carril |
| D6 | **Mesa de Servicio** | en la torre de Sistemas · aparte | En la torre, como fila de la bandeja con enlace al ticket |
| D7 | **Por dónde llega la alerta** (TOR.0.11) | WhatsApp (plantilla aprobada en Meta) · correo · los dos | **Los dos**: el correo se puede prender ya; WhatsApp necesita que alguien dé de alta la plantilla. Necesito los teléfonos y correos de Sistemas |
| D8 | **Sonda en los servidores Kepler** (TOR.0.9) | conectar desde `md` con un rol de sólo lectura · no tocarlos | Conectar con sólo lectura: es la única forma de ver el disco de la sucursal antes de que tire la caja. Son servidores de terceros: confirmar que se puede |

---

## 6. Riesgos y bloqueos

| Bloqueo | Dueño | Causa | Qué lo destraba |
|---|---|---|---|
| C0 de pods, entrega y `.249` corre en `md` y en `.249` | quien tenga acceso a `md` | los latidos se escriben desde scripts del servidor, no desde la API | D1 + un dev con `ssh` a `md` |
| `ops/k3s` del repo no es lo que se aplica | — | memoria de plataforma | medir en `md` antes de prometer un latido nuevo |

---

## 7. Observaciones de diseño UI — revisión del plan (2026-11-04)

Nivel C: se lee el plan, no la pantalla. 🔴 bloquea C3 → 🚀 · 🟠 dentro de la fase · 🟡 mejora.

| # | Sev | Observación y costo | Ley | Criterio de aceptación |
|---|---|---|---|---|
| TOR.UI.1 | 🔴 | Una celda sin fuente pintada como sano repetiría el «todo sano» de `[DH.5]` | ADR-056 | toda celda sin dato dice «no medido» en palabra y no cuenta para el veredicto como sano |
| TOR.UI.2 | 🔴 | La sucursal por código («01») no le dice nada a Sistemas | sucursal por nombre | la matriz usa `warehouseName()`; cero códigos crudos |
| TOR.UI.3 | 🔴 | Un veredicto que cuenta fallas sin dueño las vuelve a normalizar (25 abiertas, 0 vistas) | Q.4 redirección | cada fila de la bandeja lleva dueño (o «sin dueño» en rojo) y enlace a su runbook |
| TOR.UI.4 | 🟠 | Dos torres con piezas distintas para lo mismo | Jakob | las dos usan el mismo componente de señal, de bandeja y de desglose (`app-side-peek`) |
| TOR.UI.5 | 🟠 | La matriz de 9 × 6 celdas con color solo | color nunca solo | cada celda: icono + palabra + edad; `forced-colors` revisado |
| TOR.UI.6 | 🟠 | El auto-refresco que habla en cada vuelta | `aria-live` ruidoso | un solo `aria-live` para el veredicto, sólo cuando cambia |
| TOR.UI.7 | 🟡 | Texto en ámbar `-fg` (2.15:1) | contraste AA | texto en `-soft-fg`, como `[DH.5]` |

---

## 8. Lo que no espera a esta fase

1. `respaldo_fuera` en error desde el 31-oct.
2. 4 migraciones sin aplicar y 2 commits sin soltar.
3. Carriles detenidos más de una semana: `route_collections`, `caja_autollenado`, `mv_caja_push`,
   `caos_ingreso_conciliar`, `feed_route_stock`.

---

## 9. Definición de Terminado

- [ ] 1. Métrica de la cabecera **remedida**, antes/después publicado
- [ ] 2. Cada capa verificada **o declarada NO MEDIDA** (ADR-056)
- [ ] 3. Todo endpoint que escribe **ejercido contra base real** con el payload de la pantalla
- [ ] 4. Toda compuerta nueva **rota a propósito una vez**, rojo verificado
- [ ] 5. Todo primitivo genérico en `libs/` compartido **o** deuda con nombre en el tracker
- [ ] 6. Tracker + `03_LOG_REVISIONES.md` + roadmap de `CLAUDE.md` al día
- [ ] 7. **En prod**, o escrito por qué no y qué falta

---

## 10. Bitácora

| Fecha | Qué pasó | Quién |
|---|---|---|
| 2026-11-04 | Edgar pide rehacer `/admin/db-health` como torre de control, y después partirla en dos: Sistemas (servidores y Kepler) y Desarrollo (nuestra infraestructura). Plan escrito con lo medido en prod | Edgar · Claude |
| 2026-11-04 | El PM abre la fase («hagámoslo»). C0 de Sistemas: vista de caídas por servidor (TOR.0.8) y latido por servidor con sonda de slot, WAL y tablas publicadas (TOR.0.9), sin credencial nueva. Esperan: horarios (TOR.0.10), destinatarios de la alerta (TOR.0.11) | Edgar · Claude |
| 2026-11-04 | Diseño de las dos torres aprobado por Edgar y construido: contrato compartido, endpoints de sólo lectura, dos pantallas que comparten pastilla y bandeja, rutas y menú. Falta soltar y validarlas en pantalla | Edgar · Claude |
