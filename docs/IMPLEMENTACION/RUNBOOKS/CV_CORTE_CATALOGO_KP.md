# Runbook — Corte de `megadulces-api-ready` a `apps/catalogo-kp`

> Checklist para cuando se decida apuntar `.163` al build de este monorepo en
> vez del repo standalone. **No ejecutar de un tirón** — cada paso depende de
> que el anterior haya salido bien. Plan de fondo en
> [`FASE_CV`](../FASES/FASE_CV_CATALOGO_TIENDA_MAYOREO.md), sección CV.6.

**Bloqueante actual (2026-09-01):** la contraseña de `app_runtime` guardada
hoy no autentica contra el `KP_CONCENTRADA` real (`28P01` — ver
`docs/GOTCHAS.md` §24). Nada de este runbook se puede correr hasta que eso
se resuelva; sin eso, el paso 2 tampoco tiene con qué conectar.

---

## Paso 0 — Ver dónde está parado el sistema hoy

`ADMINISTRAR.bat` (raíz de `megadulces-api-ready`, en `.163`) → **opción 3,
"Ver estado del sistema"**. Sin riesgo, sólo lee. Correrla antes de tocar
cualquier otra cosa, y otra vez después de cada paso de abajo, para
confirmar que nada se rompió.

## Paso 1 — Resolver la credencial de `app_runtime`

Fuera del alcance de este runbook (es un problema de administración del
cluster `.245`, no de esta migración). Confirmar con quien administre esa
base que la contraseña vigente coincide con la que trae el `.env` de
`megadulces-api-ready`, o actualizar el `.env` con la correcta. **No seguir
al paso 2 sin esto** — de lo contrario `007_rol_dedicado.sql` va a fallar en
el `CREATE ROLE` o, peor, va a aplicarse con una contraseña que tampoco sirve.

## Paso 2 — Aplicar el rol dedicado (`catalogo_kp_runtime`)

Por qué: hoy `catalogo-kp` (en este monorepo) está preparado para usar un rol
propio, no `app_runtime` — ver `apps/catalogo-kp/sql/007_rol_dedicado.sql` y
el hallazgo de `GOTCHAS.md` §24 (compartir `app_runtime` con
`postgres_platform` en el mismo cluster acopla el blast radius de una
rotación de credencial).

1. Editar `apps/catalogo-kp/sql/007_rol_dedicado.sql` y reemplazar
   `CAMBIA_ESTE_PASSWORD` por una contraseña real (generarla, no reusar
   ninguna existente — este rol es nuevo, no hereda nada).
2. Copiar ese archivo a `sql\007_rol_dedicado.sql` dentro de
   `megadulces-api-ready` (la carpeta que usa el menú en `.163`) — el script
   `Aplicar_migracion.ps1` sólo lista lo que hay en el `sql\` de ese
   proyecto, no en este monorepo.
3. En `.163`: `ADMINISTRAR.bat` → **opción 8, "Aplicar una migración"** →
   elegir `007_rol_dedicado.sql` → contraseña de `postgres` (se pide oculta,
   no se guarda). Es aditivo — no toca `app_runtime` ni ninguna tabla
   existente, así que no hay nada que revertir si algo sale mal antes de
   este paso.
4. Verificar que el rol quedó creado y con los permisos esperados:
   ```sql
   -- Correr como postgres, con la opción 8 otra vez y este SQL suelto,
   -- o desde cualquier cliente que ya tenga acceso de postgres.
   SELECT rolname FROM pg_roles WHERE rolname = 'catalogo_kp_runtime';
   ```

## Paso 3 — Verificación end-to-end real

**3a. Sólo lectura (bajo riesgo) — catálogo y precios.**

Build de `catalogo-kp` sin `AdminModule`/`TiendaModule` (para no competir con
la cola ya viva en `.163` — ver la nota en el propio `app.module.ts` de la
corrida de verificación de CV.6), apuntado a `KP_CONCENTRADA` real con
`catalogo_kp_runtime`:

```bash
nx build catalogo-kp
DATABASE_URL_KP_CONCENTRADA="postgresql://catalogo_kp_runtime:<password>@192.168.0.245:5432/KP_CONCENTRADA" \
CATALOGO_KP_JWT_SECRET="<cualquiera, sólo para esta corrida>" \
PORT=3092 node dist/apps/catalogo-kp/main.js
```

Comparar contra la app viva en el mismo `.163`:

```bash
curl -s "http://localhost:3000/api/kp/precio?q=17083" > viejo.json
curl -s "http://localhost:3092/api/kp/precio?q=17083" > nuevo.json
diff viejo.json nuevo.json   # debe ser idéntico

curl -s "http://localhost:3000/api/kp/precios-todos?sucursal=03" > viejo_todos.json
curl -s "http://localhost:3092/api/kp/precios-todos?sucursal=03" > nuevo_todos.json
diff viejo_todos.json nuevo_todos.json
```

**3b. Camino de escritura (carrito/checkout/cola) — decisión de riesgo, no
sólo técnica.** Correr `catalogo-kp` completo (con `tienda`) contra el mismo
`KP_CONCENTRADA` real pone su motor de colas a competir por trabajos con el
que ya está vivo en `.163` — es seguro por diseño (`FOR UPDATE SKIP LOCKED`
está hecho exactamente para eso), pero significa que un `aviso_cliente` de un
pedido **real** podría tocarle al proceso nuevo, todavía no probado en
producción. Dos formas de bajar ese riesgo, a elegir según qué tan cómodos
estén con el riesgo residual:

- **Ventana corta, fuera de horario de pedidos reales**, con el canario
  (`POST /api/admin/cola/prueba`, no toca dinero) primero, y un carrito real
  de punta a punta después (crear → agregar un producto de bajo movimiento →
  checkout con OXXO → confirmar desde `/admin/pedidos/por-confirmar` →
  verificar que el aviso se envió). Es la prueba más real que se puede hacer.
- **Detener el proceso viejo primero** (el Service en `.163`) durante la
  ventana de prueba, para que sólo el worker nuevo procese la cola — pero
  eso es downtime real de la tienda, y hay que sopesarlo contra lo que se
  gana en certeza.

Ninguna de las dos se hace sin decirle a 0Sistemas primero — es la decisión
de negocio, no técnica.

## Paso 4 — El corte real (Service + tareas programadas)

Sólo después de 1–3. En `.163`:

1. Parar el Service actual (el que corre `node dist\main` del repo
   standalone).
2. Compilar `catalogo-kp` desde este monorepo y dejar `dist/apps/catalogo-kp/`
   donde el Service y las tareas programadas ya esperan encontrar `dist/`
   (copiar, o ajustar la ruta que usa el Service).
3. Ajustar `Vigilar_API.ps1`: hoy calcula `dist\main.js` relativo a su propio
   directorio padre — con el layout de Nx eso ya no calza (`dist/apps/catalogo-kp/main.js`
   vive en la raíz del monorepo, no bajo `apps/catalogo-kp/`). Cambiar esa
   única asunción de ruta; el resto del vigilante (chequeo de puerto,
   reinicio, alertas) no necesita tocarse.
4. Levantar el Service apuntando al build nuevo, confirmar `ADMINISTRAR.bat`
   opción 3 en verde, y dejarlo vigilado de cerca las primeras horas.

No se ejecuta ningún paso de este runbook desde una sesión de Claude Code sin
que 0Sistemas lo pida explícitamente para ese paso puntual — son cambios a
infraestructura que sirve pedidos reales.
