# Ensayo del COBRO `U-A-7` en el Kepler vivo (`[CC.23]`)

Contesta la pregunta de Edgar del 2026-11-26 —*«¿podemos insertar los abonos adecuadamente?»*— escribiendo un
cobro **de verdad** contra Kepler (folio del contador real, encabezado clonado, renglón de cartera, una aplicación
por factura **y su póliza**), comprobando que el saldo de la factura baja y que la póliza cuadra, y **deshaciéndolo**.
El `ROLLBACK` es **incondicional, en `finally`**: no hay ningún camino que confirme.

> ⛔⛔ **CORREGIDO el 2026-11-26, el mismo día:** la sección de abajo decía que el comprobante «sale solo» en
> cuanto el cobro existe. **Es al revés.** La ingeniería inversa (`CC.24` del anexo) midió que el timbre lo pone
> **el programa de Kepler al guardar**, no la base: 100 % de cobertura en 1,489 cobros, mediana de medio minuto,
> **26 de 27 cobros cancelados sin complemento**, y cero capturistas que no sean personas en todo 2026. Así que
> **si la Suite inserta el cobro en las tablas, el complemento NO se timbra** — y eso es peor que no capturarlo,
> porque un cobro que falta se ve y un complemento que nunca salió no se ve.
>
> ⭐ **Este ensayo sigue valiendo**, pero contesta otra pregunta: que la Suite escribe el cobro **mecánicamente
> bien**. Lo que ahora sabemos es que escribir bien las tablas **no es capturar un cobro**.

## ⛔⛔ Por qué este ensayo es más delicado que el del Ajuste Abono

Un Ajuste Abono no emite CFDI. **Un cobro sí.** Medido el 2026-11-26 sobre los cobros de noviembre: **783 de 785
tienen su complemento de pago timbrado** (serie `<suc>UA07<serie>` + el mismo folio). O sea que **en cuanto el cobro
existe, el comprobante fiscal sale solo**, y un cobro mal escrito se vuelve un CFDI mal timbrado —que ya no se
edita, sólo se cancela—. Por eso esto se ensaya **antes** de que exista un adaptador.

## Lo que escribe un cobro, medido

| Tabla | Qué | Cómo se midió |
|---|---|---|
| `kdm1` | el documento `U-A-7-01-<folio>` | `c31='Cob'`, `c63='UA0701-'`, `c43='N'` |
| `kdue` | **UN** renglón de abono en la cartera | 94 cobros de una semana → 94 renglones |
| `kdm5` | una aplicación por factura | esos 94 → 170 aplicaciones (1.8 por cobro) |
| `kdm2` | **NADA** | 0 renglones: un cobro no tiene producto |
| `kdc2AAMM` | ⛔ **la póliza, que el Ajuste Abono NO tiene** | 2 renglones: **cargo a `102`** (bancos) y **abono a `115`** (clientes), `c8='I'` |

⭐ **La caja (`kdm1.c12`) no se inventa: se deriva del cobro ANTERIOR del mismo cliente.** Es un código por sucursal
(la 06 usa `30003` y `30004`; la 08, `20003`–`20006`) y **cuál va no se adivina**: si el cliente no tiene un cobro
previo en ese servidor, el ensayo se niega en vez de elegir uno.

## Cómo se corre

La URL **se queda en `md`**: se lee del secreto ahí y se le pasa al contenedor por stdin.

```bash
node ops/prod/ensayo-cobro-kepler/empaquetar.js /tmp/ensayo-cobro.cjs     # no lleva credenciales
scp /tmp/ensayo-cobro.cjs superoot@192.168.0.222:/tmp/ensayo-cobro.cjs
ssh superoot@192.168.0.222 'bash -s' <<'EOF'
U=$(kubectl -n prod get secret kepler-push -o "jsonpath={.data.KEPLER_PUSH_URL_06}" | base64 -d)
J='{"sucursal":"06","cliente":"C3065","facturas":[{"tipo":8,"serie":1,"folio":"0001446","monto":15539.63}]}'
{ echo "$U"; echo "$J"; } | docker run --rm -i --network host \
  -v /tmp/ensayo-cobro.cjs:/e.cjs:ro mirror.gcr.io/library/node:22-alpine node /e.cjs
EOF
ssh superoot@192.168.0.222 'rm -f /tmp/ensayo-cobro.cjs'
```

## Cómo se lee

- `ANTES`: el saldo de cada factura, el contador y el máximo de pólizas `I`, con su propia conexión.
- `pasos`: cada operación con sus filas. Los `INSERT INTO md.*` dan 1, y la póliza **2**.
- `poliza_cuadre`: **cargo y abono tienen que ser iguales**. Si no, el asiento no cuadra y no sirve.
- `saldos_dentro`: el saldo **dentro** de la transacción. Para un cobro que paga la factura completa: **0.00**.
- La última línea es el **control**, con una tercera conexión.
- Código 2 = el control falló (quedó algo). Código 3 = el ensayo falló por dentro pero **no escribió nada**.

### ⛔ El control NO es «el contador quedó igual», y eso costó una corrida

La primera versión comparaba el contador y el máximo de pólizas antes/después, y **salió en rojo con todo bien**.
La causa: era jueves a las cinco de la tarde y **Crédito y cobranza seguía capturando**. La prueba de que el
`ROLLBACK` sí funcionó fue mirar el folio: el ensayo reservó el `0000868`, lo deshizo, y minutos después **ese folio
ya estaba tomado por una persona** —otro cliente, otro importe, su propio capturista—. Justamente porque se liberó.

⭐ Un control que se pone rojo cuando todo salió bien es peor que no tenerlo: enseña a ignorarlo. Ahora el control
mira **lo que es del ensayo** (sus documentos por referencia, sus saldos) y del contador sólo afirma que **no
retrocedió**, diciendo cuánto avanzó por capturas ajenas.

⚠️ **Y eso deja una lección para el adaptador, cuando exista:** en horario de captura, entre reservar el folio y
escribir, **una persona puede tomar el mismo folio**. La llave primaria lo impide, así que el choque es un rechazo
**reintentable**, no un error de negocio — igual que ya lo trata el adaptador del Ajuste Abono.

## Lo que ya encontró (2026-11-26, Morelia Madero, caso real)

✅ **Pasó de punta a punta, dos veces.** Sobre el depósito del 2026-11-23 que cuadra con el banco y no tenía cobro:
folio del contador real `KFUA0701.06` · **caja `30004` derivada de su cobro anterior** · `kdm1`, `kdue` y `kdm5`
escritos (1 fila cada uno) · **póliza de 2 renglones con cargo = abono = $15,539.63** · y **el saldo de la factura
`8-1-0001446` pasó de $15,539.63 a $0.00** dentro de la transacción. Control: 0 documentos con la referencia del
ensayo, saldos iguales, contador sin retroceder.

⭐ El caso es limpio porque **el cliente pagó una factura completa, al peso**: el depósito y la factura del 18 de
noviembre son por el mismo importe exacto.

## ⬜ Lo que este ensayo NO puede decir

`kdm1`, `kdm5`, `kdue` y `sqliov` tienen **cero disparadores**: todo lo hace el programa de Kepler. Así que **lo que
la aplicación mueve al postear —y sobre todo el TIMBRADO del complemento— no se ve acá**. Eso se mira sobre un
cobro real capturado por una persona, con foto antes/después. Mientras eso no se mida, **no se enciende ninguna
escritura de cobros**.
