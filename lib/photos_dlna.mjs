/**
 * DLNA / UPnP 投屏辅助
 *
 * 流程：UDP SSDP M-SEARCH（MediaRenderer）→ 收 LOCATION → GET 设备描述 XML →
 * 取 AVTransport 的 controlURL → SOAP SetAVTransportURI 推本机直链。
 * 全程限时、不占常驻进程；找不到设备就如实返回空列表，不假装成功。
 */
import dgram from 'node:dgram';
import crypto from 'node:crypto';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

function parseHeaders(buf) {
  const text = buf.toString('utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function xmlText(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block || '');
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
}

/** 从设备描述 XML 里取友好名与 AVTransport controlURL */
function parseDescription(xml, location) {
  let name = xmlText(xml, 'friendlyName') || '未知设备';
  let controlUrl = '';
  const blocks = xml.match(/<service>[\s\S]*?<\/service>/gi) || [];
  for (const b of blocks) {
    const st = xmlText(b, 'serviceType');
    if (st === AVT) {
      const ctrl = xmlText(b, 'controlURL');
      if (ctrl) controlUrl = new URL(ctrl, location).href;
      break;
    }
  }
  return { name, controlUrl };
}

/** 发现 MediaRenderer，timeoutMs 后停止收包 */
export function dlnaDiscover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const seen = new Map(); // location -> device

    const finish = () => {
      clearTimeout(timer);
      try { socket.close(); } catch {}
      const devices = [...seen.values()];
      resolve({
        devices,
        message: devices.length ? '' : '局域网里没有发现可用的投屏设备',
      });
    };

    const timer = setTimeout(finish, timeoutMs);

    socket.on('error', () => finish());

    socket.on('message', async (buf) => {
      const h = parseHeaders(buf);
      const location = h.location || h.location || '';
      if (!location || seen.has(location)) return;
      seen.set(location, { location, pending: true });
      // 异步拉设备描述，不阻塞收包；finish 前给一点时间
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 2500);
        const r = await fetch(location, { signal: ac.signal, cache: 'no-store' });
        clearTimeout(t);
        const xml = await r.text();
        const { name, controlUrl } = parseDescription(xml, location);
        seen.set(location, { id: sha1(location), name, location, controlUrl, ready: !!controlUrl });
      } catch {
        seen.set(location, { id: sha1(location), name: location, location, controlUrl: '', ready: false });
      }
    });

    socket.bind(0, '0.0.0.0', () => {
      const msg = Buffer.from(
        `M-SEARCH * HTTP/1.1\r\n` +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        `MAN: "ssdp:discover"\r\n` +
        `MX: 3\r\n` +
        `ST: ${AVT}\r\n\r\n`
      );
      socket.send(msg, SSDP_PORT, SSDP_ADDR, (err) => { if (err) finish(); });
    });
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function soapPost(controlUrl, action, bodyInner) {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body><u:${action} xmlns:u="${AVT}">${bodyInner}</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      'SOAPACTION': `"${AVT}#${action}"`,
    },
    body,
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`SOAP ${action} 返回 HTTP ${r.status}`);
  return r;
}

/** 把 uri 推给指定设备（先 SetAVTransportURI，再 Play 兜底） */
export async function dlnaCast(deviceId, uri) {
  if (!deviceId) throw new Error('缺少设备');
  if (!uri) throw new Error('本机局域网地址未知，无法生成直链');

  // 重新发现一次拿 controlURL（会话间设备列表可能过期）
  const found = await dlnaDiscover(2000);
  const device = found.devices.find((d) => d.id === deviceId);
  if (!device) throw new Error('设备已离线或未发现');
  if (!device.controlUrl) throw new Error('设备不支持 AVTransport 控制');

  await soapPost(device.controlUrl, 'SetAVTransportURI',
    `<InstanceID>0</InstanceID><CurrentURI>${esc(uri)}</CurrentURI><CurrentURIMetadata></CurrentURIMetadata>`);
  try {
    await soapPost(device.controlUrl, 'Play', `<InstanceID>0</InstanceID><Speed>1</Speed>`);
  } catch {}

  return { ok: true, device: { id: device.id, name: device.name }, message: `已推送到「${device.name}」` };
}
