# Incidente 2026-09-10 · VL.2a — el motor de Docker de `.249` se cayó entero

> **Resultado: 17 minutos sin ingesta del ODS, sin pérdida de datos, recuperado por completo.**
> **Consecuencia para el plan: VL.2a se elimina.** El detalle está abajo — es el hallazgo real.

## Qué pasó, en orden

| Hora (MX) | |
|---|---|
| ~20:39 | **VL.2a ejecutado.** Carriles apagados en `.249`, levantados en `md`. Verificado por el cambio de `host` en los tres latidos de prod: `6c7d9e…`→`bc2ebd…`, `dd0941…`→`ecc4ff…`, `f7c85c…`→`978441…` |
| **20:45:34** | **El motor de Docker de `.249` se cae entero.** Todos los contenedores mueren por señal: `pgvector-md` **137** (SIGKILL), `ods-autoheal` **139** (SIGSEGV), `redis-md` 0. El demonio queda inalcanzable (`npipe:////./pipe/dockerDesktopLinuxEngine` no existe) |
| 20:45–20:53 | Con la fuente caída, los carriles de `md` reportan **`0/8 ramas`** y el caliente se cae y reinicia. **Las 8 suscripciones lógicas quedan paradas** → los 8 publicadores retienen WAL |
| ~20:47 | **Rollback**: carriles de `md` apagados, carriles de `.249` re-arrancados |
| ~20:53 | **Docker Desktop se recupera solo** y rearranca los contenedores por `restart: unless-stopped`. `ods-autoheal` y `redis-md` quedaron caídos y se levantaron a mano |
| 21:02 | **Recuperación completa**: `pgvector-md` aceptando · **8/8 suscripciones recibiendo** (3–7 s) · los 3 carriles en `8/8 ramas` · `cdc_reconcile` con **`huecos 0`** |

**Sin pérdida de datos.** Las suscripciones retomaron desde su slot y el reconciliador cerró en cero.

## Causa: NO establecida — y no la voy a dibujar

Lo que sí se midió:

- El **registro de eventos de Windows** en la ventana 20:40–20:56 trae **una sola entrada**: `Volsnap`, 20:54:38, *"se eliminaron las instantáneas del volumen C: porque el almacenamiento de instantáneas no se completó a tiempo"*. Es **posterior** a la caída y es síntoma de presión de disco, no causa probada.
- `.249`: **5.7 GB libres de 29.9 GB** de RAM · `C:` **95 GB libres de 432 (79 % usado)**.
- Docker Desktop no dejó evento propio de caída en el log de Windows.

La coincidencia temporal con VL.2a es evidente (6 minutos), y el mecanismo plausible sería la carga nueva: **3 carriles × 8 ramas = ~24 conexiones concurrentes desde la LAN atravesando el proxy de puertos de Docker Desktop en Windows**. Pero **una saturación de Postgres o del proxy no suele matar el motor entero**, y nada en el log lo demuestra. Queda como **no establecida**.

## ⭐ El hallazgo que cambia el plan: VL.2a se elimina

VL.2a existía como paso de **des-riesgo**: mover primero los carriles, dejar la fuente donde está, y recién después los 55 GB. La configuración que produce es:

```
  md (carriles)  ──LAN──▶  proxy de puertos de Docker Desktop (Windows)  ──▶  pgvector-md
```

O sea que **cada lectura del CDC pasa por el componente más débil de toda la cadena**, y encima cruzando la red. Las otras dos configuraciones posibles —todo en `.249`, o todo en `md`— **no** tienen ese salto.

**El paso que diseñé para bajar el riesgo es, plausiblemente, el de mayor riesgo de los tres.** Se elimina. Se va directo a **VL.2b**, que mueve fuente y carriles juntos — que es exactamente lo que §3 ya había identificado como la unidad mínima.

## Y el incidente es el argumento de la fase

La fuente de la venta publicada de la empresa vive **dentro de Docker Desktop, en una estación de trabajo Windows**, y hoy se cayó sola. Con o sin VL.2a, eso puede pasar cualquier día.

⚠️ **Y la alarma no habría sonado.** El hueco fue de **~17 minutos**; el umbral del carril caliente es `ODS_HB_MAX_MIN: 20`. **Quedó por debajo.** Si nadie hubiera estado mirando, esos 17 minutos pasaban en silencio — y un corte apenas más largo sí habría avisado, lo que hace peor la sensación de cobertura. Vale revisar el umbral en VL.4, cuando los carriles se declaren con su latido.

## Lo que quedó

- `.249`: los 8 contenedores arriba, 3 carriles entregando **8/8 ramas**, 8 suscripciones recibiendo.
- `md`: **en reposo**, con todo montado y probado (compose, imagen, secretos, `pg_hba` de las 8 ramas).
- **No se perdió nada del avance**: el prerrequisito de `pg_hba` —que era el bloqueo real— quedó resuelto hoy, 8/8 y 6/6.
