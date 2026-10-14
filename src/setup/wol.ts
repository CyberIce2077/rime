// Wake-on-LAN: a magic packet (6 x 0xFF, then the MAC 16 times) as a UDP broadcast.

import dgram from 'node:dgram';
import os from 'node:os';

// Whether an IPv4 address is on one of this computer's networks. A magic packet
// doesn't leave the LAN, so waking anything else would only wait. A name (not an
// address) can't be told, so it counts as maybe.
export function onLan(ip: string, nets = Object.values(os.networkInterfaces()).flat()) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return true;
  const n = (a: string) => a.split('.').reduce((x, o) => x * 256 + Number(o), 0);
  return nets.some((i) => i && i.family === 'IPv4' && !i.internal && (n(i.address) & n(i.netmask)) >>> 0 === (n(ip) & n(i.netmask)) >>> 0);
}

export function magicPacket(mac: string) {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`not a MAC address: ${mac}`);
  const m = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(m)]);
}

// x.y.z.w -> x.y.z.255 (a /24 home network)
export const broadcastFor = (ip: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip.replace(/\.\d+$/, '.255') : '255.255.255.255');

export function wake(mac: string, broadcast = '255.255.255.255', port = 9): Promise<void> {
  const pkt = magicPacket(mac);
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    s.once('error', (e) => {
      s.close();
      reject(e);
    });
    s.bind(() => {
      s.setBroadcast(true);
      s.send(pkt, port, broadcast, (e) => {
        s.close();
        if (e) reject(e);
        else resolve();
      });
    });
  });
}
