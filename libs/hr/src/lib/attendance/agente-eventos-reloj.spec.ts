/**
 * `[RH.1.3]` El reloj AVISA cada checada por la misma sesión TCP (probado en prod el 2026-11-11: 8-Esquinas y Morelia
 * Abastos, 19 avisos en 8 min). Prueba PURA de `database/importers/checadores/agente/zk/eventos.js`, sin reloj ni
 * `node-zklib` (que sólo vive en la imagen de ingesta): corre en CI.
 * Lo que defiende: el aviso se aparta ANTES de que lo vea `node-zklib` (que lo tomaría por la respuesta a un comando),
 * lleva su acuse, y todo lo que NO es aviso le llega a la librería byte por byte, aunque venga pegado a un aviso o partido.
 */
import { EventEmitter } from 'events';
import path from 'path';

const RAIZ = path.resolve(__dirname, '../../../../..');
const { escucharAvisosDelReloj, partirPaquetes, esAviso } = require(path.join(RAIZ, 'database/importers/checadores/agente/zk/eventos.js'));

/** Un paquete ZK sobre TCP: magia + largo (8 B), luego comando, checksum, sesión y reply (8 B), luego el cuerpo. */
function paquete(cmd: number, cuerpo: Buffer): Buffer {
  const zk = Buffer.alloc(8 + cuerpo.length);
  zk.writeUInt16LE(cmd, 0);
  zk.writeUInt16LE(0, 2);
  zk.writeUInt16LE(0x1234, 4);
  zk.writeUInt16LE(7, 6);
  cuerpo.copy(zk, 8);
  const tcp = Buffer.alloc(8);
  Buffer.from([0x50, 0x50, 0x82, 0x7d]).copy(tcp, 0);
  tcp.writeUInt32LE(zk.length, 4);
  return Buffer.concat([tcp, zk]);
}
const RESPUESTA = paquete(2000, Buffer.alloc(0));          // 16 B: el OK a un comando
const AVISO = paquete(500, Buffer.alloc(36, 1));           // 52 B: una checada avisada

function relojFalso() {
  const socket = new EventEmitter() as EventEmitter & { write: (b: Buffer) => void; escrito: Buffer[] };
  socket.escrito = [];
  socket.write = (b: Buffer) => { socket.escrito.push(b); };
  return { zklibTcp: { socket, sessionId: 0x1234, replyId: 3 } };
}
const utilsFalso = {
  createTCPHeader: (cmd: number) => Buffer.from(`cmd${cmd}`),
  decodeRecordRealTimeLog52: () => ({ userId: '106', attTime: new Date('2026-11-11T22:01:18Z') }),
};

describe('[RH.1.3] avisos del reloj — partir el flujo TCP', () => {
  it('separa paquetes pegados y deja entero lo que no termina', () => {
    const parcial = AVISO.subarray(0, 20);
    const partes = partirPaquetes(Buffer.concat([RESPUESTA, AVISO, parcial]));
    expect(partes.map((p: Buffer) => p.length)).toEqual([16, 52, 20]);
    expect([esAviso(partes[0]), esAviso(partes[1])]).toEqual([false, true]);
  });

  it('un trozo que no empieza con la magia (continuación de un paquete grande) pasa entero', () => {
    const datos = Buffer.alloc(3000, 7);
    expect(partirPaquetes(datos)).toEqual([datos]);
  });
});

describe('[RH.1.3] avisos del reloj — apartarlos de node-zklib', () => {
  it('⭐ el aviso pegado a una respuesta: la checada sale por aviso, con su acuse, y node-zklib recibe SÓLO la respuesta', () => {
    const zk = relojFalso();
    const recibidoPorLibreria: Buffer[] = [];
    zk.zklibTcp.socket.on('data', (d: Buffer) => recibidoPorLibreria.push(d));
    const checadas: unknown[] = [];
    escucharAvisosDelReloj(zk, { alChecada: (c: unknown) => checadas.push(c), log: () => undefined, utils: utilsFalso });
    expect(zk.zklibTcp.socket.escrito.map(String)).toEqual(['cmd500']);          // se registró a avisos
    expect(zk.zklibTcp.replyId).toBe(4);

    zk.zklibTcp.socket.emit('data', Buffer.concat([RESPUESTA, AVISO]));
    expect(checadas).toEqual([{ userId: '106', recordTime: new Date('2026-11-11T22:01:18Z') }]);
    expect(zk.zklibTcp.socket.escrito.map(String)).toEqual(['cmd500', 'cmd2000']);   // + el acuse
    expect(recibidoPorLibreria).toHaveLength(1);
    expect(recibidoPorLibreria[0].equals(RESPUESTA)).toBe(true);
  });

  it('un aviso solo no le llega a node-zklib; un trozo de datos sí, idéntico', () => {
    const zk = relojFalso();
    const recibido: Buffer[] = [];
    zk.zklibTcp.socket.on('data', (d: Buffer) => recibido.push(d));
    escucharAvisosDelReloj(zk, { alChecada: () => undefined, log: () => undefined, utils: utilsFalso });
    zk.zklibTcp.socket.emit('data', AVISO);
    const grande = Buffer.alloc(3000, 9);
    zk.zklibTcp.socket.emit('data', grande);
    expect(recibido).toEqual([grande]);
  });

  it('⛔ soltar() deja el socket como estaba: después, todo le llega a node-zklib', () => {
    const zk = relojFalso();
    const recibido: Buffer[] = [];
    zk.zklibTcp.socket.on('data', (d: Buffer) => recibido.push(d));
    const soltar = escucharAvisosDelReloj(zk, { alChecada: () => undefined, log: () => undefined, utils: utilsFalso });
    soltar();
    zk.zklibTcp.socket.emit('data', AVISO);
    expect(recibido).toEqual([AVISO]);
  });
});
