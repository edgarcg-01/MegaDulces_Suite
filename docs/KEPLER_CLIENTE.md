# Cliente Kepler 95 — decode del PROGRAMA

> Hermano de [`ERP_KEPLER.md`](ERP_KEPLER.md). Aquel decodifica **los datos** (qué significa
> `kdm1.c45`); éste decodifica **el programa** que los escribe: qué módulo hace qué, dónde vive
> el binding *etiqueta de pantalla ↔ columna `cN`*, y qué viaja por el puerto 1801.
>
> ⛔ **Análisis estático y de sólo lectura** de software que la empresa licencia y opera, con fin de
> interoperabilidad. Nada se ejecutó, nada se parchó, nada tocó la red ni producción. Parchear el
> cliente ya se descartó y está medido en
> [`FASE_BP_BITACORA_POS.md`](IMPLEMENTACION/FASES/FASE_BP_BITACORA_POS.md) §4: el cliente
> re-descarga sus páginas del servidor y pisa cualquier parche local.
>
> **Bitácora viva.** Cada afirmación dice cómo se midió. Lo no medido está en §10, declarado.
> **No es una fase**: la campaña de aterrizaje (`METODO_DE_TRABAJO.md` §7) impide abrir fases
> nuevas. Es una investigación con plan propio (§1) y deuda con nombre.

**Última medición: 2026-10-16.**

---

## 1. Plan de seguimiento

Reglas de todos los pasos: estático y de sólo lectura sobre copias aisladas; ningún paso toca la
red ni producción sin autorización explícita (🔒); cada paso cierra con un criterio binario.

✅ cerrado · 🔨 en curso · ⬜ pendiente · 🔒 requiere autorización

| # | Paso | Cómo | Cierra cuando | Estado |
|---|---|---|---|---|
| P0 | Procedencia | copia aislada + SHA-256 | hashes registrados (§2) | ✅ 2026-10-16 |
| P1 | Mapa de módulos | tablas de imports | rol de cada DLL medido (§3) | ✅ 2026-10-16 |
| P2 | Binding etiqueta ↔ `cN` | parser de `.kpl` sobre 94 formas | 3 decodes conocidos reproducidos (§5) | ✅ 70 columnas, ≥34 nuevas |
| P3 | Arquitectura de carga | decompilar `Principal` | tabla API ubicada (§6) | ✅ 2026-10-16 |
| P4 | Marco del 1801 | decompilar flush y transformación | algoritmo identificado por constantes (§8) | ✅ LZO1X-1 |
| P5 | Handshake / conexión | decompilar quien llama a `connect` | canal `CncIP`→`CliSrv` descrito (§7.1) | ✅ |
| P6 | Lado de recepción | `recv` y sus llamadores | marco de entrada confirmado simétrico (§8.1) | ✅ |
| P7 | Constructor de mensajes | métodos de `CliSrv`; camino desde `kdb.*` | gramática del payload descrita | ⬜ |
| P8 | Decodificador propio | Node: `lzo1x_decompress_safe` + parser de marco, con pruebas | pasa vectores conocidos + prueba negativa (marco corrupto → error) | ⬜ |
| P9 | Validar con tráfico real | captura **pasiva** con `pktmon` del cliente dev al abrir una forma | un marco real se descomprime y su contenido coincide con la forma abierta | 🔒 |
| P10 | Catálogo de páginas | identificar el comando que pide un `.kpl` | comando descrito; lector sólo-lectura diseñado (sin construir) | ⬜ / 🔒 para construir |
| P11 | Extractor completo | soportar la convención de `cxpcatpropag`; correr sobre el catálogo | cobertura re-medida y comparada contra 70 | ⬜ |
| P12 | Aterrizar en el repo | extractor a `scripts/`; columnas nuevas a `ERP_KEPLER.md` | commit con pathspec + tracker | 🔒 |
| S1 | **Seguridad** (Sistemas) | ¿algún `*.ddns.net:1801` alcanzable desde fuera? | exposición medida, sí o no | ⬜ — no es reversing |

---

## 2. Procedencia

| | |
|---|---|
| Origen | `D:\K95_Dev\` (cliente dev local) · espejo en `Z:\Kepler\K95_Dev\` = `\\192.168.0.245\D` |
| Copia de trabajo | `C:\tools\kepler-re\bin\` — **nunca se analiza sobre el cliente vivo** |
| Build | **2024-06-01**, PE32+ x64, MSVC 14.39 — **ninguno es .NET** |
| Corpus de formas | `Z:\Kepler\K95_Dev\temp\` — **94** formas de negocio |
| Herramientas | Ghidra **12.1.4 PUBLIC** (`C:\tools\ghidra_12.1.4_PUBLIC`) + Temurin JDK **21.0.12** x64, headless |

```
fd9b94d7c0751d3552c52d344cc26bc525ab9f6e41b6f40d3f142594ca39b59a  Kapi.dll
762ef1b05f0a97c6f97249452284eba6baf2c626d02d24f8c645c619be7d1a37  Kdb7.dll
7814d50bd0d7e3c29cfe8d17a3ac5a86223d5e34404de38122b686d137cd8e30  Kdb8.dll
79db70d219d3c2ecf025f471e9fc4621ff796c54aa0d28fe6c3d684db0db4264  Kepler95.exe
637bcb832fc6a695145c4b013a3b348dbb3f6715f4686cad4a3979a887dc7938  Kfrn.dll
66379dae2b0ac3d27d1b7020d9633c4ed4d3157566a099c2e2479c35dfe8a586  Kscr.dll
c96b38126be1dad7b132a598eefd92f3e6dbdc6009b2f3fae1a59cfb8dbbabc1  Kxml.dll
```

⚠️ Los binarios son estables (jun-2024); las formas cambian semanas. Lo decodificado del binario
dura; lo de una forma hay que re-verificarlo.

---

## 3. Reparto de responsabilidades — medido por tabla de imports

| Módulo | KB | Importa | Rol medido |
|---|---:|---|---|
| **`Kapi.dll`** | 202 | **WS2_32 (17)** + USER32/GDI32/COMCTL32/COMDLG32/SHELL32 (135) + ADVAPI32 (14) + ole32 | **única capa de red**, y toda la GUI |
| `Kfrn.dll` | 2,796 | sólo CRT + KERNEL32 | motor de formas (`frn.*`), sin E/S propia |
| `Kscr.dll` | 362 | sólo CRT + KERNEL32 | intérprete (`scr.*`) |
| `Kdb7` / `Kdb8` | 45 / 54 | sólo CRT + KERNEL32 | capa `kdb.*` — **cero sockets, ODBC o libpq: no habla con la base** |
| `Kxml.dll` | 102 | sólo CRT + KERNEL32 | parser XML de los `.kpl` |
| `Kepler95.exe` | 425 | sólo CRT + KERNEL32 | lanzador delgado |
| `KO*.dll` ×11 | 29–166 | — | librería de controles |

Exports casi vacíos (fábricas C++: `Kdb8` 6, `Kscr` 2, `Kfrn` y `Kapi` 1): no hay atajo, hace falta
decompilar.

`ADVAPI32` de `Kapi` **no es criptografía**: es Service Control Manager (`CreateServiceW`,
`StartServiceW`, `DeleteService`, `LockServiceDatabase`…). No se linkea ninguna librería TLS
(ni schannel, secur32, bcrypt ni OpenSSL).

---

## 4. ⛔ Hipótesis refutada: el diccionario `cN` NO está en los binarios

> Se registra para que nadie la reconstruya.

**Hipótesis:** si el cliente traduce nombre lógico → `cN`, esa tabla es la piedra Rosetta.

**Medición:** barrido ASCII + UTF-16 de `kdm1 kdm2 kdud kdii kdik kdmm kdij kdpv` sobre los 7
binarios → **cero**. `Kfrn.dll` sí trae fuente `.kpl` embebida y SQL (`SELECT ` ×53), pero sólo
contra los **módulos nuevos con nombre** (`docType`, `accBank`, `orgRate`, campos `k_*`) — las 21
de 340 tablas que `ERP_KEPLER.md` §2.4 ya declaró nombradas.

**Conclusión:** decompilar no destraba el decode de `cN`. Lo que sí lo destraba está en §5.

---

## 5. ⭐⭐ El binding etiqueta ↔ `tabla.cN` está en las formas, y es mecánico

```
tabla_base="kdii";   kdb.open("a," & tabla_base);
<txt>Minimo</txt>         <inp id="invMin" OnChange="Cambio(33,invMin)" type="number"/>
<txt>Punto reorden</txt>  <inp id="PR"     OnChange="Cambio(34,PR)"     type="number"/>

fun Cambio(numero_campo, objeto, desplazamiento){ //Realiza un cambio de valor en la BD
   var cmd = "datos,a,1," & camposLlave() & ",&," & numero_campo & ",'" & frn.get(...) & "'...
```

El parámetro se llama **`numero_campo`** en el fuente del proveedor, y entra como ordinal de
columna contra el alias `a` = `tabla_base`. `Cambio` está declarada **en cada forma** (se buscó en
`libKepler`, `libGeneral`, `md_lib`, `pv_lib`, `libRep`: no es builtin), así que el extractor
verifica la convención **forma por forma** antes de atribuir el ordinal.

### 5.1 Verificado contra tres hechos independientes

| Prueba | Resultado |
|---|---|
| `invcatprdpag.kpl` → `kdii.c33/c34/c35` | **coincide** con ADR-030 / FASE_RA (mínimo, punto de reorden, máximo; decodificado 2026-07-08 por otra vía) |
| `md_cat_cli.kpl` → `kdud.c17` = "Descuentos (1)" | **coincide** con `ERP_KEPLER.md` §2.6 (2026-09-28, por otra vía) |
| log de la propia `Cambio()` | `kdb.write("logmov,h,1,…")` con ordinales 1–6 = usuario, fecha, hora, archivo, **número de campo** — **coincide** con `kdlogmov` medido en FASE_BP §5 |

Cada decode salió además de **dos formas distintas** sin contradecirse.

### 5.2 Cobertura medida

```
formas en el corpus            94
formas con binding confirmado   8
bindings etiqueta -> columna  103
columnas distintas             70   kdii kdud kdudent kduv kdcp kdm_rutas
-- DECLARADO SIN MEDIR --
formas salteadas               86   (84 sin campos editables; 2 huecos reales, §10)
bindings sin etiqueta           0
columnas con etiqueta en conflicto  0
```

Contra los 290 `.md` del repo: **≤ 36 ya documentadas** (el control pasa: `kdii.c33/34/35` y
`kdud.c17` salen marcadas) y **≥ 34 nuevas**. El 36 es cota superior: parte del match es por
cercanía en la línea.

| Columna | Etiqueta en pantalla | Dónde importa |
|---|---|---|
| `kdii.c23` · `c24` | Precio lista proveedor · Descuento proveedor | escalera de costos, ADR-051 |
| `kdii.c95`–`c98` | Unidad Dos · Unidad Tres | [`UNIDADES_DE_MEDIDA.md`](UNIDADES_DE_MEDIDA.md) |
| `kdii.c101` | Días de Caducidad | FEFO |
| `kdii.c25` · `c26` | Producto substituto · equivalente | FLT |
| `kdii.c99` | Obsoleto? | catálogo |
| `kduv.c4` · `c5` · `c6` | Comisión s/ventas · s/utilidad · s/cobros | comisiones de vendedor |
| `kdud.c28` · `c29` | Comisiones S/Venta · S/Cobro | cartera |
| `kdud.c17`/`c18`/`c19` | Descuentos (1)(2)(3) — **tres ranuras** | `ERP_KEPLER.md` §3.1 |

⚠️ Una etiqueta de pantalla **no sustituye** la prueba de unidad de `ERP_KEPLER.md` §5 regla 0.
`kdii.c7` y `kdii.c93` tienen etiqueta "1": el parser conserva lo que vino, no lo inventa.

---

## 6. Arquitectura de carga — `Kapi.Principal`

```
Kapi.Principal(a, b, c, d):
  h = LoadLibrary("Kfrn");  Kfrn.Param(c)
  api  = malloc(0x398)       // DAT_180030a38: tabla de funciones del host
  api2 = malloc(0xb0)        // DAT_180030a28: 20 callbacks de ventana
  FUN_180009e60(api)         // llena 65 ranuras
  Kfrn.Principal(cb, MnjWin2, api, api2)
```

**`Kfrn.dll` no importa red porque no la necesita: recibe de `Kapi` una tabla de punteros.** Esa
tabla de 0x398 bytes es la frontera entre el motor de formas y el transporte. `DAT_180030a38` la
escribe **sólo** `Principal` (1 escritura, 8 lecturas).

## 7. Clases recuperadas por RTTI

Red: `Socket · SockCli · SockSrv · CncIP · CliSrv`.
GUI: `MnjWin · MnjWin2 · Kwnd · Kwnd2 · Menu · Menu2 · DevCon · DeCon2 · BmpApi · bmp · color ·
color2 · SpaceSecMat`. RTTI da la clase, no los nombres de método.

Núcleo de sockets (8 funciones):

| Función | Primitivas | Rol |
|---|---|---|
| `FUN_180003110` | WSAStartup · socket · gethostbyname · inet_addr · htons · setsockopt · connect | conectar |
| `FUN_180003370` | WSAStartup · socket · htons · setsockopt · bind · listen | escuchar |
| `FUN_180003590` · `FUN_1800036a0` | accept | aceptar |
| `FUN_180002e60` | send en bucle hasta completar | sendAll |
| `FUN_180002cf0` · `FUN_180002fc0` | recv · shutdown · closesocket | recibir / cerrar |
| `FUN_180002ef0` | select · `__WSAFDIsSet` | esperar |

### 7.1 El canal `CncIP` → `CliSrv` (P5)

`CncIP` es una **interfaz abstracta** (vftable de 14 métodos `_purecall`); `CliSrv` es la
implementación concreta. El motor de formas recibe la conexión como esta interfaz, no como sockets
crudos. Sus 14 métodos, decompilados:

| Slot | Función | Qué hace |
|---|---|---|
| +0x00 | `FUN_180004050` | enviar un int32 |
| +0x08 | `FUN_180003f70` | enviar una cadena UTF-16 (con longitud por delante si se pide) |
| +0x10 | `FUN_180003d60` | **write** al acumulador (§8) |
| +0x18 | `FUN_180003e70` | **leer** una cadena UTF-16 del buffer recibido |
| +0x20 | `FUN_180004070` | leer un int32 |
| +0x28 | `FUN_1800039e0` | tomar `n` bytes del buffer recibido (con relleno por `FUN_180003aa0`) |
| +0x40 | `FUN_180003e40` | **flush** del acumulador (§8) |
| +0x30/38/48–68 | varios | estado del canal, `select` con timeout, modo buffer on/off |

**Conexión** (`FUN_180003810` crea `CliSrv`; `FUN_180003110` conecta): TCP (`socket(AF_INET,
SOCK_STREAM, IPPROTO_TCP)`), `SO_KEEPALIVE=1`, timeout de recepción opcional (`SO_RCVTIMEO`).
Intenta primero `inet_addr(host)`; si la conexión falla, resuelve por `gethostbyname` y reintenta
— por eso los nombres `*.ddns.net` funcionan.

⚠️ **El handshake de aplicación/autenticación NO está decompilado**: `FUN_180004090`, la fábrica
del canal, no tiene llamadores en `Kapi` (la invoca `Kfrn` vía la tabla API). Lo que sigue a la
conexión —login, credenciales— vive del lado de `Kfrn.dll` / las formas, no acá. Declarado en §10.

---

## 8. ⭐⭐ El marco del puerto 1801 — decodificado

Emisor: `FUN_180003d60` (write) acumula; `FUN_180003c00` (flush) emite:

```
frame = [int32 LE  len_comprimido]
        [int32 LE  len_original  ]
        [len_comprimido bytes LZO1X-1]
```

- El acumulador reserva 8 bytes de cabecera; crece a `len + 200000 + n` cuando no entra.
- **Little-endian**: `htonl` no se importa (sólo `htons`, para el puerto).
- Transformación = ranura `api + 0x268` = `FUN_1800055d0` → `FUN_180021cc0`; inversa en
  `api + 0x270` = `FUN_180005640` → `FUN_180021ee0`.

**Algoritmo identificado por constantes, no por firma:**

| Lado | Constante | Significado en LZO |
|---|---|---|
| compresor | `0xc000` | tramos de 49152 B (LZO ≥ 2.04) |
| compresor | `0x11, 0, 0` | marcador de fin `M4_MARKER\|1` |
| compresor | `0x12`, `0xef` | primer literal `17+t` si `t ≤ 238` |
| compresor | wrkmem 131088 B en pila | `LZO1X_1_MEM_COMPRESS` en x64 |
| descompresor | `0x801`, `0x4000`, `0x7ff` | `1+M2_MAX_OFFSET`, base M4 |
| descompresor | `0xff`, `0xf`, `0x1f`, `0x7` | extensión de longitudes |
| descompresor | **−4 −5 −6 −8** | `LZO_E_INPUT_OVERRUN / OUTPUT_OVERRUN / LOOKBEHIND_OVERRUN / INPUT_NOT_CONSUMED` — exclusivos de **`lzo1x_decompress_safe`** |

**Conclusión: el transporte es LZO1X-1 (miniLZO 2.x). Compresión, no cifrado.** En el camino de
envío no hay ninguna capa criptográfica.

### 8.1 El lector de marco entrante — confirma el formato por la otra punta

`FUN_180003aa0` (método de lectura de `CliSrv`) hace la inversa exacta del emisor:

```
recv_exacto(4) -> len_comprimido     // FUN_180002fc0 lee N bytes en bucle, tope 100 MB
recv_exacto(4) -> len_original
recv_exacto(len_comprimido) -> payload
descomprime(payload, api+0x270) -> destino     // la inversa de api+0x268
assert(tam_descomprimido == len_original)      // si no, descarta: tamaño = 0
```

⭐ Ese `assert` zanja la duda de §8: **el `len_original` de la cabecera es la longitud
descomprimida esperada** — justo lo que `lzo1x_decompress_safe` necesita para reservar. Un cifrado
de bloque no llevaría el tamaño descomprimido en claro en la cabecera. **Es compresión,
confirmado por las dos puntas.**

`FUN_180002fc0` (recv) hace *read-fully*: reserva `n+1`, recibe en bucle hasta completar `n`,
cierra con NUL. `recv == 0` → conexión cerrada por el par.

## 9. ⚠️ Implicación de seguridad (S1, para Sistemas)

`md.pv_suc_ip` publica los 9 servidores de aplicación como `*.ddns.net:1801`. Si alguno es
alcanzable desde fuera de la LAN, el tráfico del ERP viaja sin cifrar una vez descomprimido.
**No medido todavía**: no afirmar exposición sin verificarla.

---

## 10. Declarado sin medir

- **Contenido del payload descomprimido.** Hipótesis: las cadenas de comando `kdb`
  (`"datos,a,1,...,&,33,'valor'"`). Pendiente P7 / P9.
- **Lado de recepción**: asumido simétrico, no visto (P6).
- **Handshake / autenticación** al conectar (P5).
- **Para qué el cliente hace `bind/listen/accept`** y **para qué controla servicios de Windows**.
- **Tamaño del catálogo de páginas del servidor**: sólo se ve el caché (94).
- **Huecos del extractor**: `cxpcatpropag.kpl` (proveedores, 17 campos) usa una `Cambio` que no
  escribe contra el alias `a`; `conPolizaDoc_Consulta.kpl` no declara `fun Cambio`.

## 11. Reproducir

```bash
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
G=/c/tools/ghidra_12.1.4_PUBLIC/support/analyzeHeadless.bat
# primera vez: importa y analiza (~26 s)
$G C:\tools\kepler-re\proj kepler -import C:\tools\kepler-re\bin\Kapi.dll \
   -scriptPath C:\tools\kepler-re\scripts -postScript KeplerInventory.java C:\tools\kepler-re\out\Kapi-inventory.txt
# siguientes: sin re-analizar
$G C:\tools\kepler-re\proj kepler -process Kapi.dll -noanalysis -scriptPath C:\tools\kepler-re\scripts \
   -postScript KeplerDecompile.java C:\tools\kepler-re\out\X.c <addr> [addr...]
```

Scripts Ghidra (Java, en `C:\tools\kepler-re\scripts\`): `KeplerInventory`, `KeplerExternals`
(imports y llamadores), `KeplerClasses` (RTTI), `KeplerRefs` (lecturas/escrituras a una
dirección), `KeplerDecompile` (C + llamadores). Scripts Node del extractor y del mapa de imports:
hoy en el scratchpad de la sesión; pasan a `scripts/kepler/` en P12.

⛔ **Nunca se ejecuta `Kepler95.exe` bajo instrumentación contra los servidores de producción.**
Sería un escritor que nadie declaró — la misma regla que prohíbe levantar el backend local
apuntando a prod.

---

## 12. Log

| Fecha | Paso | Resultado |
|---|---|---|
| 2026-10-16 | P0–P4 | procedencia, mapa de módulos, extractor `.kpl` (70 col), tabla API, marco LZO1X-1 |
| 2026-10-16 | P5–P6 | canal `CncIP`→`CliSrv` (14 métodos); lector de marco entrante confirma el formato por la otra punta. Autorización de Dirección registrada. S1 pendiente |
