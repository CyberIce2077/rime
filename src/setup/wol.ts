// Wake-on-LAN: a magic packet (6 x 0xFF, then the MAC 16 times) as a UDP broadcast.

import dgram from 'node:dgram';

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
