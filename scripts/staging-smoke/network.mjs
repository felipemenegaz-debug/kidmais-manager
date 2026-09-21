import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';

/** Installed before loading pg/domain modules. The sole egress allowed is pinned PostgreSQL/TLS. */
export function sealNetwork(host) {
  const restore = [];
  const allowedSockets = new WeakSet();
  const replace = (object, name, value) => { const old = object[name]; object[name] = value; restore.push(() => { object[name] = old; }); };
  const deny = () => { throw new Error('EXTERNAL_TRANSPORT_FORBIDDEN'); };
  const connect = net.Socket.prototype.connect;
  replace(net.Socket.prototype, 'connect', function (...args) {
    const first = Array.isArray(args[0]) ? args[0] : args;
    const options = typeof first[0] === 'object' ? first[0] : { port: first[0], host: first[1] };
    if (!options || 'path' in options || options.host !== host || Number(options.port) !== 5432) return deny();
    const result = connect.apply(this, args);
    allowedSockets.add(this);
    return result;
  });
  const tlsConnect = tls.connect;
  replace(tls, 'connect', function (options, ...rest) {
    if (!allowedSockets.has(options?.socket) || options.servername !== host || options.rejectUnauthorized !== false) return deny();
    return tlsConnect.call(this, options, ...rest);
  });
  for (const protocol of [http, https]) for (const method of ['request', 'get']) replace(protocol, method, deny);
  replace(http2, 'connect', deny); replace(dgram, 'createSocket', deny); replace(globalThis, 'fetch', deny);
  return () => { for (const undo of restore.reverse()) undo(); };
}
