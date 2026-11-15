# La solicitud de gasto, escrita por la Suite en Kepler (`[PGP.122]`)

Plan: [`FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md`](../../../docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md).
Código: `libs/finance/src/lib/expense-proofs/solicitud-kepler/` (armador, escritor y su revisión).
Prueba contra Postgres real (CI): `database/tests/test-newdb-kepler-solicitud-gasto.js`.

Todo está construido y probado contra un Kepler de prueba con los tipos reales. Lo que queda es **del
administrador de Kepler y del PM**, en este orden. Ningún paso enciende nada por sí solo.

## 0. La migración, ANTES de soltar el código

```bash
sh ops/prod/aplicar-migracion.sh 20261115003547_pgp122_solicitud_gasto_nace_en_la_suite.js
```

Es aditiva y el código tolera que falte (la pestaña no aparece y la firma hace lo de siempre), pero sin ella
no hay dónde guardar nada: va primero. Siembra el interruptor `solicitud_gasto` de las 9 sucursales
**apagado**, con tope 1 por día. No hay permisos nuevos ni hace falta volver a entrar.

## 1. Captura de prueba (S.1): qué toca Kepler al CREAR una solicitud

La hipótesis medida en el ODS es `kdm1` + `kdm6` + el contador `sqliov` (`KFXA1501.NN`). Se confirma una
vez, en **05** y en una hora tranquila, con la herramienta del pago:

```bash
node ops/prod/ensayo-pago-kepler/foto-contadores.js foto 05 > antes.json
#   → una persona captura UNA solicitud en Kepler (2 renglones, con IVA), la graba y NO la autoriza
node ops/prod/ensayo-pago-kepler/foto-contadores.js foto 05 > despues.json
node ops/prod/ensayo-pago-kepler/foto-contadores.js comparar antes.json despues.json
```

Se espera: `kdm1 +1 insertada`, `kdm6 +2 insertadas`, `sqliov 1 cambiada`. **Cualquier otra tabla se
explica antes de encender** y, si es de la solicitud, se agrega al permiso y al escritor. Además:

- Repetir con «Nuevo» y abandonar sin grabar: ¿se movió `sqliov`? (si sí, Kepler reserva el folio al abrir).
- Cancelar esa misma solicitud en Kepler y volver a comparar: qué cambia al cancelar (`c43`, `c16`/`c42`,
  `c68`/`c69`, ¿borra `kdm6`?).
- Con superusuario: el `xmin` de la fila nueva de `kdm1` y en qué tablas aparece ese xid (método de
  `[PGP.79]`), para saber si el contador se mueve en la MISMA transacción.

## 2. Permisos

```bash
node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp122_solicitud_gasto.sql --servidores 05
node ops/prod/kepler-sql-todos.js ops/prod/kepler-grants/pgp122_solicitud_gasto.sql --servidores 05 --aplicar
```

## 3. Ensayo contra el Kepler vivo (no escribe)

Corre el escritor real y termina en `ROLLBACK`. Mismo modelo que [`../ensayo-pago-kepler/`](../ensayo-pago-kepler/README.md):
desde `md`, empaquetado en un archivo, en un contenedor que se borra al terminar.

```bash
node ops/prod/ensayo-solicitud-gasto/empaquetar.js /tmp/ensayo-solgasto.cjs
scp /tmp/ensayo-solgasto.cjs superoot@192.168.0.222:/tmp/ensayo-solgasto-pgp122.cjs
{ echo "$KEPLER_PUSH_URL_05"; echo '{"sucursal":"05","plantilla":"0000079"}'; } \
  | ssh superoot@192.168.0.222 'docker run --rm -i --network host -v /tmp/ensayo-solgasto-pgp122.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs'
ssh superoot@192.168.0.222 'rm -f /tmp/ensayo-solgasto-pgp122.cjs'
```

- **Verde:** `fallas: []`, los 9 permisos en `true` y `control.intacto: true` (nada con la marca del ensayo
  y el contador como estaba).
- **Una plantilla con algo en las 169 columnas que en las 5,224 solicitudes medidas van vacías es FALLA**, no
  aviso: el escritor no escribe con ella (la solicitud espera, sin gastar intentos). Se elige otra.
- Si no se pasan acreedor y catálogos, el ensayo usa los de la última solicitud viva del servidor.
- ⚠️ El adaptador escribe en su log «Solicitud … → Kepler» porque no sabe que es un ensayo. **Lo que vale es
  el control.**

Plantillas candidatas (leerlas enteras en el Kepler vivo antes de fijarlas):

| 00 | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 |
|---|---|---|---|---|---|---|---|---|
| 0010887 | 0000174 | 0000353 | 0000202 | 0000114 | 0000079 | 0000297 | 0000162 | 0000414 |

## 4. Encender, servidor por servidor

En el secreto `kepler-push` (como el resto de los escritores):

```
KEPLER_GASTO_SOLICITUD=encendida
KEPLER_SOLGASTO_TEMPLATE_FOLIO_05=0000079
```

Y el renglón `solicitud_gasto` de **05** en `encendida`, con su tope (sembrado en 1). La pantalla de
escritura en Kepler de Compras no maneja este tipo: es un `UPDATE`, como el `GRANT`:

```sql
UPDATE commercial.kepler_push_switch SET encendida = true, nota = 'canario PGP.122', updated_at = now()
 WHERE tenant_id = '00000000-0000-0000-0000-00000000d01c' AND sucursal = '05' AND tipo = 'solicitud_gasto';
```

Con eso, en 05 aparece la pestaña «Registrar o pedir» en Finanzas › Gastos (antes no se ve en ningún lado).

**Canario (S.10):** una solicitud real escrita por la Suite en 05, que una persona **aplica** en Kepler (el
gasto X-A-10 se arma sobre ella) y otra que se **cancela** desde Kepler. Sin canario no se enciende el resto
(KR.7: «un documento que no se puede cancelar es peor que uno que no se puede crear»).

Orden del piloto (DS14): 05 → 07 y 08 → 01–04 y 06 → 00. Veda del 15-dic al 15-ene.

## Resultado

| Fecha | Servidor | Paso | Resultado |
|---|---|---|---|
| — | — | — | (pendiente: S.1, permisos, ensayo y canario) |
