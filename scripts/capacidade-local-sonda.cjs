/* eslint-disable @typescript-eslint/no-require-imports */
// Somente harness local: bloqueia conexões externas e amostra RAM/CPU do processo Next real.
const fs = require('node:fs');
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof a === 'object' ? a?.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!['localhost', '127.0.0.1', '::1'].includes(host ?? 'localhost')) throw Error('CAPACIDADE_REDE_EXTERNA_RECUSADA');
  return original.apply(this, args);
};
const destino = process.env.KIDMAIS_CAPACIDADE_METRICAS;
if (destino) {
  const registrar = () => fs.appendFileSync(destino, JSON.stringify({ t: Date.now(), pid: process.pid,
    ...process.memoryUsage(), cpu: process.cpuUsage() }) + '\n');
  registrar();
  setInterval(registrar, 200).unref();
}
