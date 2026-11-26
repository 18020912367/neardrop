'use strict';

/**
 * 邻传 NearDrop — a zero-dependency LAN file transfer service.
 *
 * Devices join from the same Wi-Fi, discover one another over Server-Sent
 * Events, confirm a two-sided handshake, then relay files through this local
 * server. Files are written to .data with random names and are only reachable
 * with an unguessable per-transfer download token.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const APP_NAME = '邻传 NearDrop';
const VERSION = '1.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '.data'));
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 10 * 1024 ** 3); // 10 GiB
const MAX_BATCH_SIZE = Number(process.env.MAX_BATCH_SIZE || 20 * 1024 ** 3); // 20 GiB
const MAX_FILES_PER_OFFER = 100;
const TRANSFER_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const OFFLINE_GRACE_MS = 8000;
const REQUEST_TTL_MS = 90 * 1000;
const OFFER_TTL_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 20 * 1000;
const MAX_CLIENTS = 400;
const MAX_SSE_PER_CLIENT = 4;

const clients = new Map(); // id -> client
const tokenIndex = new Map(); // token -> client id
const pendingRequests = new Map(); // id -> request
const sessions = new Map(); // id -> session
const transfers = new Map(); // id -> transfer

const COLORS = ['#3355E8', '#D95032', '#0A8F6A', '#7C4DDB', '#B57016', '#0E7490', '#C23B78', '#4B5563'];
const ADJECTIVES = ['晚风', '晴天', '青柠', '小满', '初雪', '海盐', '山茶', '晨雾', '柚子', '松间', '橘子', '薄荷', '夏夜', '云朵', '麦田', '星野'];
const ANIMALS = ['小鹿', '海豚', '狐狸', '水獭', '山雀', '鲸鱼', '刺猬', '兔子', '猫头鹰', '小熊', '企鹅', '松鼠', '白鹭', '浣熊'];

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function now() {
  return Date.now();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cleanText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const clipped = Array.from(cleaned).slice(0, maxLength).join('').trim();
  return clipped || fallback;
}

function cleanFileName(value) {
  if (typeof value !== 'string') return '';
  const base = path.basename(value.replace(/\\/g, '/'));
  return Array.from(base.replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, 180).join('').trim();
}

function cleanMime(value) {
  if (typeof value !== 'string') return 'application/octet-stream';
  const mime = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)) {
    return 'application/octet-stream';
  }
  return mime.slice(0, 120);
}

function randomName() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return a + b;
}

function uniqueName(preferred) {
  let name = preferred;
  let suffix = 2;
  const taken = () => [...clients.values()].some((client) => client.name === name);
  while (taken() && suffix < 1000) {
    name = `${preferred} ${suffix}`;
    suffix += 1;
  }
  return name;
}

function colorFor(id) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function lanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const [iface, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (address.address.startsWith('169.254.')) continue;
      result.push({ iface, address: address.address });
    }
  }
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  return result.sort((a, b) => score(a.address) - score(b.address) || a.iface.localeCompare(b.iface));
}

function serverInfo() {
  const port = server.address()?.port || PORT;
  const hosts = HOST === '0.0.0.0' || HOST === '::' ? lanAddresses() : [{ iface: HOST, address: HOST }];
  const urls = hosts.map((entry) => ({
    ...entry,
    url: `http://${entry.address.includes(':') ? `[${entry.address}]` : entry.address}:${port}`,
  }));
  return {
    app: APP_NAME,
    version: VERSION,
    port,
    urls,
    limits: {
      maxFileSize: MAX_FILE_SIZE,
      maxBatchSize: MAX_BATCH_SIZE,
      maxFiles: MAX_FILES_PER_OFFER,
    },
  };
}

function publicClient(client, viewerId = null) {
  return {
    id: client.id,
    name: client.name,
    device: client.device,
    kind: client.kind,
    color: client.color,
    online: Boolean(client.online),
    busy: Boolean(client.sessionId),
    isSelf: viewerId === client.id,
  };
}

function onlinePeers(clientId) {
  return [...clients.values()]
    .filter((client) => client.id !== clientId && client.online)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((client) => publicClient(client, clientId));
}

function requestView(request) {
  const from = clients.get(request.fromId);
  const to = clients.get(request.toId);
  return {
    id: request.id,
    fromId: request.fromId,
    toId: request.toId,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    from: from ? publicClient(from) : null,
    to: to ? publicClient(to) : null,
  };
}

function offerView(offer) {
  return {
    id: offer.id,
    fromId: offer.fromId,
    toId: offer.toId,
    status: offer.status,
    createdAt: offer.createdAt,
    expiresAt: offer.expiresAt || null,
    files: offer.files.map((file) => ({
      index: file.index,
      name: file.name,
      size: file.size,
      mime: file.mime,
      state: file.state,
    })),
  };
}

function transferView(transfer) {
  const ready = transfer.status === 'ready';
  return {
    id: transfer.id,
    offerId: transfer.offerId,
    fileIndex: transfer.fileIndex,
    fromId: transfer.fromId,
    toId: transfer.toId,
    name: transfer.name,
    size: transfer.size,
    mime: transfer.mime,
    bytes: transfer.bytes,
    status: transfer.status,
    createdAt: transfer.createdAt,
    readyAt: transfer.readyAt || null,
    downloadUrl: ready ? `/api/transfers/${transfer.id}/download?token=${encodeURIComponent(transfer.downloadToken)}` : null,
  };
}

function sessionView(session, viewerId) {
  if (!session) return null;
  const peerId = session.aId === viewerId ? session.bId : session.aId;
  const peer = clients.get(peerId);
  return {
    id: session.id,
    role: session.aId === viewerId ? 'host' : 'guest',
    createdAt: session.createdAt,
    peer: peer ? publicClient(peer, viewerId) : null,
    offer: session.offer ? offerView(session.offer) : null,
    transfers: session.transfers.map(transferView),
  };
}

function stateFor(client) {
  const request = client.pendingRequestId ? pendingRequests.get(client.pendingRequestId) : null;
  const session = client.sessionId ? sessions.get(client.sessionId) : null;
  return {
    client: publicClient(client, client.id),
    peers: onlinePeers(client.id),
    pendingIncoming: request && request.toId === client.id ? requestView(request) : null,
    pendingOutgoing: request && request.fromId === client.id ? requestView(request) : null,
    session: session && session.status === 'active' ? sessionView(session, client.id) : null,
    server: serverInfo(),
  };
}

function registerPayload(client) {
  return {
    token: client.token,
    ...stateFor(client),
  };
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

function sseWrite(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // The connection is going away; its close handler will clean it up.
  }
}

function sendTo(clientOrId, event, data) {
  const client = typeof clientOrId === 'string' ? clients.get(clientOrId) : clientOrId;
  if (!client) return;
  for (const res of client.sseConnections) sseWrite(res, event, data);
}

function sendToSession(session, event, data) {
  if (!session) return;
  sendTo(session.aId, event, data);
  sendTo(session.bId, event, data);
}

function broadcastPeers() {
  for (const client of clients.values()) {
    if (!client.online) continue;
    sendTo(client, 'peers', { peers: onlinePeers(client.id) });
  }
}

function connectSSE(client, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  if (client.sseConnections.size >= MAX_SSE_PER_CLIENT) {
    const oldest = client.sseConnections.values().next().value;
    if (oldest) {
      oldest.end();
      client.sseConnections.delete(oldest);
    }
  }

  if (client.offlineTimer) {
    clearTimeout(client.offlineTimer);
    client.offlineTimer = null;
  }

  const wasOnline = client.online;
  client.online = true;
  client.lastSeen = now();
  client.sseConnections.add(res);

  sseWrite(res, 'init', stateFor(client));
  if (!wasOnline) {
    broadcastPeers();
    log(`设备上线  ${client.name} (${client.id.slice(0, 10)})`);
  }

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(': ping\n\n');
    client.lastSeen = now();
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(heartbeat);
    client.sseConnections.delete(res);
    if (client.sseConnections.size > 0) return;
    scheduleOffline(client);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
}

function scheduleOffline(client) {
  if (client.offlineTimer) clearTimeout(client.offlineTimer);
  client.offlineTimer = setTimeout(() => {
    client.offlineTimer = null;
    if (client.sseConnections.size > 0) return;
    client.online = false;
    client.lastSeen = now();
    log(`设备离线  ${client.name}`);
    if (client.pendingRequestId) {
      const request = pendingRequests.get(client.pendingRequestId);
      if (request) cancelRequest(request, 'expired', { silentFor: client.id });
    }
    if (client.sessionId) {
      const session = sessions.get(client.sessionId);
      if (session && session.status === 'active') {
        endSession(session, 'peer-offline', null);
      }
    }
    broadcastPeers();
  }, OFFLINE_GRACE_MS);
}

/* ------------------------------------------------------------------ */
/* Connection handshake                                                */
/* ------------------------------------------------------------------ */

function createConnectionRequest(from, to) {
  if (!to.online) throw new AppError(409, 'PEER_OFFLINE', '对方已离线，请刷新设备列表。');
  if (from.pendingRequestId) throw new AppError(409, 'REQUEST_PENDING', '你已有待处理的连接请求，请先取消。');
  if (to.pendingRequestId) throw new AppError(409, 'PEER_BUSY_REQUEST', '对方正在处理另一个连接请求。');
  if (from.sessionId) throw new AppError(409, 'ALREADY_CONNECTED', '请先断开当前连接。');
  if (to.sessionId) throw new AppError(409, 'PEER_BUSY', '对方正在与另一台设备传输。');

  const request = {
    id: randomId('req'),
    fromId: from.id,
    toId: to.id,
    status: 'pending',
    createdAt: now(),
    expiresAt: now() + REQUEST_TTL_MS,
    timer: null,
  };
  request.timer = setTimeout(() => {
    if (request.status === 'pending') cancelRequest(request, 'expired');
  }, REQUEST_TTL_MS);
  request.timer.unref?.();

  pendingRequests.set(request.id, request);
  from.pendingRequestId = request.id;
  to.pendingRequestId = request.id;

  sendTo(to.id, 'connection-request', { request: requestView(request) });
  sendTo(from.id, 'connection-pending', { request: requestView(request) });
  log(`连接请求  ${from.name} → ${to.name}`);
  return request;
}

function clearPendingRequest(request) {
  if (request.timer) clearTimeout(request.timer);
  request.timer = null;
  pendingRequests.delete(request.id);
  const from = clients.get(request.fromId);
  const to = clients.get(request.toId);
  if (from && from.pendingRequestId === request.id) from.pendingRequestId = null;
  if (to && to.pendingRequestId === request.id) to.pendingRequestId = null;
}

function cancelRequest(request, reason, options = {}) {
  if (request.status !== 'pending') return;
  request.status = reason;
  clearPendingRequest(request);
  if (reason === 'expired') {
    if (options.silentFor !== request.fromId) {
      sendTo(request.fromId, 'connection-expired', { requestId: request.id });
    }
    if (options.silentFor !== request.toId) {
      sendTo(request.toId, 'connection-expired', { requestId: request.id });
    }
  } else if (reason === 'cancelled') {
    sendTo(request.toId, 'connection-cancelled', { requestId: request.id, peerId: request.fromId });
  } else if (reason === 'declined') {
    sendTo(request.fromId, 'connection-declined', { requestId: request.id, peerId: request.toId });
  }
  broadcastPeers();
}

function acceptRequest(request, target) {
  if (request.status !== 'pending') throw new AppError(409, 'REQUEST_CLOSED', '该连接请求已失效。');
  if (request.toId !== target.id) throw new AppError(403, 'FORBIDDEN', '你无法处理这个连接请求。');
  const from = clients.get(request.fromId);
  if (!from || !from.online) throw new AppError(409, 'PEER_OFFLINE', '对方已离线，无法完成连接。');
  if (from.sessionId || target.sessionId) throw new AppError(409, 'ALREADY_CONNECTED', '其中一方已建立其他连接。');

  request.status = 'accepted';
  clearPendingRequest(request);

  const session = {
    id: randomId('ses'),
    aId: from.id,
    bId: target.id,
    createdAt: now(),
    endedAt: null,
    status: 'active',
    offer: null,
    transfers: [],
  };
  sessions.set(session.id, session);
  from.sessionId = session.id;
  target.sessionId = session.id;

  sendTo(from.id, 'session-started', { session: sessionView(session, from.id) });
  sendTo(target.id, 'session-started', { session: sessionView(session, target.id) });
  broadcastPeers();
  log(`握手成功  ${from.name} ↔ ${target.name}`);
  return session;
}

function endSession(session, reason = 'closed', byId = null) {
  if (!session || session.status !== 'active') return;
  session.status = 'ended';
  session.endedAt = now();
  for (const id of [session.aId, session.bId]) {
    const client = clients.get(id);
    if (client && client.sessionId === session.id) client.sessionId = null;
  }
  if (session.offer) {
    if (session.offer.timer) clearTimeout(session.offer.timer);
    session.offer.timer = null;
    if (session.offer.status === 'pending' || session.offer.status === 'accepted') {
      session.offer.status = 'ended';
    }
  }
  const payload = { sessionId: session.id, reason, byId };
  sendTo(session.aId, 'session-ended', payload);
  sendTo(session.bId, 'session-ended', payload);
  broadcastPeers();
  log(`连接断开  ${clients.get(session.aId)?.name || '?'} ↔ ${clients.get(session.bId)?.name || '?'} (${reason})`);
}

function requireSession(sessionId, client) {
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'active') throw new AppError(404, 'SESSION_NOT_FOUND', '连接已断开。');
  if (session.aId !== client.id && session.bId !== client.id) {
    throw new AppError(403, 'FORBIDDEN', '你不在这个连接中。');
  }
  return session;
}

function peerIdOf(session, clientId) {
  return session.aId === clientId ? session.bId : session.aId;
}

/* ------------------------------------------------------------------ */
/* Files: offer → accept → streaming upload → download                 */
/* ------------------------------------------------------------------ */

function validateOfferedFiles(input) {
  if (!Array.isArray(input) || input.length < 1) {
    throw new AppError(400, 'NO_FILES', '请至少选择一个文件。');
  }
  if (input.length > MAX_FILES_PER_OFFER) {
    throw new AppError(400, 'TOO_MANY_FILES', `一次最多发送 ${MAX_FILES_PER_OFFER} 个文件。`);
  }
  let total = 0;
  const files = input.map((file, index) => {
    if (!file || typeof file !== 'object') throw new AppError(400, 'BAD_FILE', '文件信息不完整。');
    const name = cleanFileName(file.name);
    if (!name) throw new AppError(400, 'BAD_FILE_NAME', '文件名不能为空。');
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new AppError(400, 'BAD_FILE_SIZE', '文件大小无效。');
    if (size > MAX_FILE_SIZE) throw new AppError(413, 'FILE_TOO_LARGE', `“${name}”超过单文件大小限制。`);
    total += size;
    return {
      index,
      name,
      size,
      mime: cleanMime(file.type || file.mime),
      state: 'pending',
      transferId: null,
      bytes: 0,
    };
  });
  if (total > MAX_BATCH_SIZE) throw new AppError(413, 'BATCH_TOO_LARGE', '本批文件总大小超出限制。');
  return { files, total };
}

function offerIsActive(offer) {
  if (!offer) return false;
  if (offer.status === 'pending' || offer.status === 'accepted') return true;
  return false;
}

function createOffer(session, client, input) {
  if (session.offer && offerIsActive(session.offer)) {
    throw new AppError(409, 'OFFER_ACTIVE', '当前已有一批文件正在传输，请完成后再发送。');
  }
  if (session.offer) session.offer.status = session.offer.status === 'accepted' ? 'completed' : session.offer.status;
  const { files, total } = validateOfferedFiles(input);
  const toId = peerIdOf(session, client.id);
  const to = clients.get(toId);
  if (!to || !to.online) throw new AppError(409, 'PEER_OFFLINE', '对方已离线。');

  const offer = {
    id: randomId('off'),
    fromId: client.id,
    toId,
    status: 'pending',
    createdAt: now(),
    expiresAt: now() + OFFER_TTL_MS,
    files,
    total,
    timer: null,
  };
  offer.timer = setTimeout(() => {
    if (offer.status !== 'pending') return;
    offer.status = 'expired';
    sendToSession(session, 'offer-expired', { offerId: offer.id });
    sendToSession(session, 'offer-updated', { offer: offerView(offer) });
    log(`文件请求过期  ${client.name} → ${to.name}`);
  }, OFFER_TTL_MS);
  offer.timer.unref?.();

  session.offer = offer;
  sendTo(toId, 'offer-received', {
    offer: offerView(offer),
    from: publicClient(client, toId),
    sessionId: session.id,
  });
  log(`文件请求  ${client.name} → ${to.name} · ${files.length} 个文件 · ${formatBytes(total)}`);
  return offer;
}

function acceptOffer(offer, client, session) {
  if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', '文件请求不存在。');
  if (offer.status !== 'pending') throw new AppError(409, 'OFFER_CLOSED', '该文件请求已失效。');
  if (offer.toId !== client.id) throw new AppError(403, 'FORBIDDEN', '你无法处理这个文件请求。');
  if (offer.timer) clearTimeout(offer.timer);
  offer.timer = null;
  offer.status = 'accepted';
  offer.acceptedAt = now();
  sendToSession(session, 'offer-accepted', {
    offer: offerView(offer),
    acceptedBy: publicClient(client),
    sessionId: session.id,
  });
  log(`文件请求已接受  ${offer.files.length} 个文件`);
  return offer;
}

function declineOffer(offer, client, session) {
  if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', '文件请求不存在。');
  if (offer.status !== 'pending') throw new AppError(409, 'OFFER_CLOSED', '该文件请求已失效。');
  if (offer.toId !== client.id) throw new AppError(403, 'FORBIDDEN', '你无法处理这个文件请求。');
  if (offer.timer) clearTimeout(offer.timer);
  offer.timer = null;
  offer.status = 'declined';
  offer.declinedAt = now();
  sendToSession(session, 'offer-declined', { offerId: offer.id, byId: client.id });
  sendToSession(session, 'offer-updated', { offer: offerView(offer) });
  log(`文件请求被拒绝  ${client.name}`);
  return offer;
}

function cancelOffer(offer, client, session) {
  if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', '文件请求不存在。');
  if (offer.fromId !== client.id) throw new AppError(403, 'FORBIDDEN', '只有发送方可以取消。');
  if (offer.status !== 'pending' && offer.status !== 'accepted') {
    throw new AppError(409, 'OFFER_CLOSED', '该文件请求已经结束。');
  }
  if (offer.status === 'accepted' && offer.uploadingIndex !== null && offer.uploadingIndex !== undefined) {
    throw new AppError(409, 'UPLOAD_IN_PROGRESS', '正在上传的文件结束后才能取消。');
  }
  if (offer.timer) clearTimeout(offer.timer);
  offer.timer = null;
  offer.status = 'cancelled';
  offer.cancelledAt = now();
  offer.uploadingIndex = null;
  sendToSession(session, 'offer-cancelled', { offerId: offer.id, byId: client.id });
  sendToSession(session, 'offer-updated', { offer: offerView(offer) });
  log(`文件请求已取消  ${client.name}`);
  return offer;
}

function failUpload(session, offer, file, transfer, message) {
  if (transfer) {
    transfer.status = 'failed';
    transfer.error = message;
    transfers.delete(transfer.id);
    const index = session.transfers.indexOf(transfer);
    if (index >= 0) session.transfers.splice(index, 1);
  }
  if (offer) {
    offer.uploadingIndex = null;
    if (file && file.state !== 'ready') {
      file.state = 'pending';
      file.transferId = null;
      file.bytes = 0;
    }
  }
  if (session && offer) {
    sendToSession(session, 'transfer-failed', {
      offerId: offer.id,
      fileIndex: file ? file.index : null,
      message: message || '传输失败',
    });
  }
}

async function handleUpload(req, res, client, session, offer, file) {
  if (offer.status !== 'accepted') throw new AppError(409, 'OFFER_NOT_ACCEPTED', '对方尚未接收文件。');
  if (offer.fromId !== client.id) throw new AppError(403, 'FORBIDDEN', '你不是这批文件的发送方。');
  if (!file || file.state === 'ready') throw new AppError(409, 'ALREADY_UPLOADED', '该文件已上传。');
  if (offer.uploadingIndex !== undefined && offer.uploadingIndex !== null && offer.uploadingIndex !== file.index) {
    throw new AppError(409, 'UPLOAD_IN_PROGRESS', '请等待上一个文件传输完成。');
  }

  let declaredLength = Number(req.headers['content-length']);
  if (req.headers['content-length'] === undefined && file.size === 0) {
    // Some browsers omit Content-Length for an empty XHR body.
    declaredLength = 0;
  }
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    req.resume();
    throw new AppError(411, 'LENGTH_REQUIRED', '上传请求缺少文件长度。');
  }
  if (declaredLength !== file.size) {
    req.resume();
    throw new AppError(400, 'SIZE_MISMATCH', '上传文件大小与请求不一致。');
  }
  if (declaredLength > MAX_FILE_SIZE) {
    req.resume();
    throw new AppError(413, 'FILE_TOO_LARGE', '文件超过大小限制。');
  }

  const transferId = randomId('trf');
  const tempPath = path.join(DATA_DIR, `${transferId}.part`);
  const finalPath = path.join(DATA_DIR, `${transferId}.bin`);
  const transfer = {
    id: transferId,
    sessionId: session.id,
    offerId: offer.id,
    fileIndex: file.index,
    fromId: offer.fromId,
    toId: offer.toId,
    name: file.name,
    size: file.size,
    mime: file.mime,
    bytes: 0,
    status: 'uploading',
    downloadToken: randomToken(),
    createdAt: now(),
    readyAt: null,
    tempPath,
    path: null,
  };
  transfers.set(transfer.id, transfer);
  session.transfers.push(transfer);
  offer.uploadingIndex = file.index;
  file.state = 'uploading';
  file.transferId = transfer.id;
  file.bytes = 0;

  sendToSession(session, 'transfer-started', {
    transfer: transferView(transfer),
    offerId: offer.id,
    fileIndex: file.index,
  });

  let lastProgressAt = 0;
  let writeError = null;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      transfer.bytes += chunk.length;
      if (transfer.bytes > file.size) {
        writeError = new AppError(413, 'FILE_TOO_LARGE', '收到的文件大于声明大小。');
        callback(writeError);
        return;
      }
      file.bytes = transfer.bytes;
      const tick = now();
      if (tick - lastProgressAt > 120) {
        lastProgressAt = tick;
        sendToSession(session, 'transfer-progress', {
          transferId: transfer.id,
          offerId: offer.id,
          fileIndex: file.index,
          bytes: transfer.bytes,
          size: transfer.size,
          name: transfer.name,
        });
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, fs.createWriteStream(tempPath, { flags: 'wx' }));
    if (writeError) throw writeError;
    if (transfer.bytes !== file.size) {
      throw new AppError(400, 'SIZE_MISMATCH', `文件长度不完整（${transfer.bytes}/${file.size}）。`);
    }
    await fsp.rename(tempPath, finalPath);
    transfer.path = finalPath;
    transfer.status = 'ready';
    transfer.readyAt = now();
    transfer.bytes = file.size;
    file.state = 'ready';
    file.bytes = file.size;
    file.transferId = transfer.id;
    offer.uploadingIndex = null;

    sendToSession(session, 'transfer-progress', {
      transferId: transfer.id,
      offerId: offer.id,
      fileIndex: file.index,
      bytes: transfer.bytes,
      size: transfer.size,
      name: transfer.name,
    });

    const allReady = offer.files.every((entry) => entry.state === 'ready');
    if (allReady) {
      offer.status = 'completed';
      offer.completedAt = now();
    }
    sendToSession(session, 'file-ready', {
      transfer: transferView(transfer),
      offerId: offer.id,
      fileIndex: file.index,
      offer: offerView(offer),
    });
    if (allReady) {
      sendToSession(session, 'offer-completed', {
        offerId: offer.id,
        count: offer.files.length,
        totalBytes: offer.total,
      });
      log(`传输完成  ${offer.files.length} 个文件 · ${formatBytes(offer.total)}`);
    }
    json(res, 200, { transfer: transferView(transfer), offer: offerView(offer) });
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    failUpload(session, offer, file, transfer, error instanceof AppError ? error.message : '文件传输中断。');
    log(`传输失败  “${file.name}” · ${error.message}`);
    if (!res.writableEnded && !res.destroyed) {
      const status = error instanceof AppError ? error.status : 500;
      const code = error instanceof AppError ? error.code : 'UPLOAD_FAILED';
      json(res, status, { error: { code, message: '文件传输未完成，请重试。' } });
    } else {
      res.destroy();
    }
  }
}

function contentDisposition(filename) {
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .trim() || 'download';
  const encoded = encodeURIComponent(filename).replace(/['()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function serveDownload(req, res, transfer) {
  if (!transfer || transfer.status !== 'ready' || !transfer.path) {
    throw new AppError(404, 'NOT_FOUND', '文件不存在或已过期。');
  }
  let stat;
  try {
    stat = await fsp.stat(transfer.path);
  } catch {
    throw new AppError(404, 'NOT_FOUND', '文件不存在或已过期。');
  }

  const headers = {
    'Content-Type': transfer.mime || 'application/octet-stream',
    'Content-Disposition': contentDisposition(transfer.name),
    'Cache-Control': 'private, no-store',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
  };

  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match && (match[1] !== '' || match[2] !== '')) {
      if (match[1] === '') {
        const suffix = Number(match[2]);
        start = Math.max(0, stat.size - suffix);
      } else {
        start = Number(match[1]);
      }
      if (match[2] !== '' && match[1] !== '') end = Math.min(Number(match[2]), stat.size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers['Content-Length'] = String(end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(transfer.path, { start, end }), res).catch((error) => {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
  });
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function json(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req, limit = 256 * 1024) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过大。');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new AppError(413, 'BODY_TOO_LARGE', '请求内容过大。');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'BAD_JSON', '请求格式不正确。');
  }
}

function authenticate(req, url) {
  const headerToken = req.headers['x-client-token'];
  const queryToken = url?.searchParams?.get('token');
  const token = typeof headerToken === 'string' && headerToken ? headerToken : queryToken;
  if (!token) throw new AppError(401, 'UNAUTHORIZED', '请刷新页面重新加入。');
  const client = clients.get(tokenIndex.get(token));
  if (!client || !safeEqual(client.token, token)) {
    throw new AppError(401, 'UNAUTHORIZED', '登录状态已失效，请刷新页面。');
  }
  client.lastSeen = now();
  return client;
}

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}

function clientIp(req) {
  return req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'local';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`;
}

function log(message) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`);
}

/* ------------------------------------------------------------------ */
/* Static files                                                        */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new AppError(405, 'METHOD_NOT_ALLOWED', '不支持此请求方法。');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new AppError(400, 'BAD_PATH', '路径无效。');
  }
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const relative = pathname.replace(/^\/+/, '');
  if (relative.split('/').includes('..')) throw new AppError(404, 'NOT_FOUND', '页面不存在。');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    throw new AppError(404, 'NOT_FOUND', '页面不存在。');
  }
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    throw new AppError(404, 'NOT_FOUND', '页面不存在。');
  }
  if (!stat.isFile()) throw new AppError(404, 'NOT_FOUND', '页面不存在。');
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(filePath), res).catch((error) => {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
  });
}

/* ------------------------------------------------------------------ */
/* API router                                                          */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;

  if (pathname === '/api/health' && method === 'GET') {
    return json(res, 200, { ok: true, app: APP_NAME, version: VERSION, uptime: Math.round(process.uptime()) });
  }

  if (pathname === '/api/info' && method === 'GET') {
    return json(res, 200, { ...serverInfo(), online: [...clients.values()].filter((c) => c.online).length });
  }

  if (pathname === '/api/register' && method === 'POST') {
    const body = await readJson(req);
    let client = null;
    if (typeof body.token === 'string' && body.token) {
      const existing = clients.get(tokenIndex.get(body.token));
      if (existing && safeEqual(existing.token, body.token)) client = existing;
    }
    const nameInput = cleanText(body.name, 24);
    const device = cleanText(body.device, 40, '局域网设备');
    const kind = cleanText(body.kind, 16, 'device');
    if (!client) {
      if (clients.size >= MAX_CLIENTS) {
        const stale = [...clients.values()]
          .filter((entry) => !entry.online)
          .sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (stale) {
          clients.delete(stale.id);
          tokenIndex.delete(stale.token);
        } else {
          throw new AppError(503, 'TOO_MANY_CLIENTS', '当前设备过多，请稍后再试。');
        }
      }
      client = {
        id: randomId('cli'),
        token: randomToken(),
        name: uniqueName(nameInput || randomName()),
        device,
        kind,
        color: '',
        createdAt: now(),
        lastSeen: now(),
        online: false,
        sseConnections: new Set(),
        pendingRequestId: null,
        sessionId: null,
        offlineTimer: null,
      };
      client.color = colorFor(client.id);
      clients.set(client.id, client);
      tokenIndex.set(client.token, client.id);
      log(`新设备  ${client.name} · ${client.device} · ${clientIp(req)}`);
    } else {
      if (nameInput) client.name = cleanText(nameInput, 24, client.name);
      if (typeof body.device === 'string') client.device = device;
      if (typeof body.kind === 'string') client.kind = kind;
      client.lastSeen = now();
    }
    return json(res, 200, registerPayload(client));
  }

  // Download URLs carry a dedicated, unguessable file token. They must not
  // require the page's client token: links are opened by the browser download
  // manager, which cannot attach custom headers.
  const downloadMatch = /^\/api\/transfers\/([a-z0-9_]+)\/download$/.exec(pathname);
  if (downloadMatch && (method === 'GET' || method === 'HEAD')) {
    const transfer = transfers.get(downloadMatch[1]);
    const token = url.searchParams.get('token') || '';
    if (!transfer || !safeEqual(transfer.downloadToken, token)) {
      throw new AppError(404, 'NOT_FOUND', '下载链接无效或已过期。');
    }
    return serveDownload(req, res, transfer);
  }

  const client = authenticate(req, url);

  if (pathname === '/api/state' && method === 'GET') {
    return json(res, 200, stateFor(client));
  }

  if (pathname === '/api/profile' && method === 'POST') {
    const body = await readJson(req);
    const name = cleanText(body.name, 24);
    if (!name) throw new AppError(400, 'BAD_NAME', '请输入一个昵称。');
    client.name = name;
    broadcastPeers();
    for (const sessionId of [client.sessionId]) {
      const session = sessionId ? sessions.get(sessionId) : null;
      if (session) {
        const peerId = peerIdOf(session, client.id);
        sendTo(peerId, 'peer-updated', { peer: publicClient(client) });
      }
    }
    return json(res, 200, { client: publicClient(client, client.id) });
  }

  if (pathname === '/api/events' && method === 'GET') {
    return connectSSE(client, req, res);
  }

  if (pathname === '/api/connections' && method === 'POST') {
    const body = await readJson(req);
    const to = clients.get(body.toId);
    if (!to) throw new AppError(404, 'PEER_NOT_FOUND', '设备不存在或已离开。');
    if (to.id === client.id) throw new AppError(400, 'SELF_CONNECT', '无法连接到自己。');
    const request = createConnectionRequest(client, to);
    return json(res, 201, { request: requestView(request), ...stateFor(client) });
  }

  const connectionMatch = /^\/api\/connections\/([a-z0-9_]+)\/(accept|decline|cancel)$/.exec(pathname);
  if (connectionMatch && method === 'POST') {
    const request = pendingRequests.get(connectionMatch[1]);
    if (!request) throw new AppError(404, 'REQUEST_NOT_FOUND', '连接请求已失效。');
    const action = connectionMatch[2];
    if (action === 'accept') {
      const session = acceptRequest(request, client);
      return json(res, 200, { session: sessionView(session, client.id), ...stateFor(client) });
    }
    if (action === 'decline') {
      if (request.toId !== client.id) throw new AppError(403, 'FORBIDDEN', '你无法处理这个连接请求。');
      request.status = 'declined';
      clearPendingRequest(request);
      sendTo(request.fromId, 'connection-declined', { requestId: request.id, peerId: client.id });
      sendTo(request.toId, 'connection-request-resolved', { requestId: request.id });
      broadcastPeers();
      return json(res, 200, { ok: true, ...stateFor(client) });
    }
    if (action === 'cancel') {
      if (request.fromId !== client.id) throw new AppError(403, 'FORBIDDEN', '你无法取消这个连接请求。');
      request.status = 'cancelled';
      clearPendingRequest(request);
      sendTo(request.toId, 'connection-cancelled', { requestId: request.id, peerId: client.id });
      broadcastPeers();
      return json(res, 200, { ok: true, ...stateFor(client) });
    }
  }

  const sessionMatch = /^\/api\/sessions\/([a-z0-9_]+)(?:\/(close|offers))?$/.exec(pathname);
  if (sessionMatch) {
    const session = requireSession(sessionMatch[1], client);
    const action = sessionMatch[2];
    if (!action && method === 'GET') {
      return json(res, 200, { session: sessionView(session, client.id) });
    }
    if (action === 'close' && method === 'POST') {
      endSession(session, 'closed', client.id);
      return json(res, 200, { ok: true, ...stateFor(client) });
    }
    if (action === 'offers' && method === 'POST') {
      const body = await readJson(req);
      const offer = createOffer(session, client, body.files);
      return json(res, 201, { offer: offerView(offer), session: sessionView(session, client.id) });
    }
  }

  const offerMatch = /^\/api\/offers\/([a-z0-9_]+)\/(accept|decline|cancel)$/.exec(pathname);
  if (offerMatch && method === 'POST') {
    if (!client.sessionId) throw new AppError(404, 'SESSION_NOT_FOUND', '连接已断开。');
    const session = requireSession(client.sessionId, client);
    const offer = session.offer;
    if (!offer || offer.id !== offerMatch[1]) throw new AppError(404, 'OFFER_NOT_FOUND', '文件请求不存在。');
    const action = offerMatch[2];
    if (action === 'accept') {
      acceptOffer(offer, client, session);
      return json(res, 200, { offer: offerView(offer), session: sessionView(session, client.id) });
    }
    if (action === 'decline') {
      declineOffer(offer, client, session);
      return json(res, 200, { offer: offerView(offer), session: sessionView(session, client.id) });
    }
    if (action === 'cancel') {
      cancelOffer(offer, client, session);
      return json(res, 200, { offer: offerView(offer), session: sessionView(session, client.id) });
    }
  }

  const uploadMatch = /^\/api\/sessions\/([a-z0-9_]+)\/offers\/([a-z0-9_]+)\/files\/(\d+)$/.exec(pathname);
  if (uploadMatch && method === 'PUT') {
    const session = requireSession(uploadMatch[1], client);
    const offer = session.offer;
    if (!offer || offer.id !== uploadMatch[2]) throw new AppError(404, 'OFFER_NOT_FOUND', '文件请求不存在。');
    const file = offer.files[Number(uploadMatch[3])];
    if (!file) throw new AppError(404, 'FILE_NOT_FOUND', '文件不存在。');
    return handleUpload(req, res, client, session, offer, file);
  }

  throw new AppError(404, 'NOT_FOUND', '接口不存在。');
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const startedAt = now();
  let pathnameForLog = '/';
  setCommonHeaders(res);
  try {
    // A fixed base avoids trusting the Host header and keeps malformed URLs
    // inside the normal error path.
    const url = new URL(req.url || '/', 'http://localhost');
    pathnameForLog = url.pathname;
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof AppError ? error.message : '服务器遇到错误，请稍后重试。';
    if (!(error instanceof AppError)) console.error(error);
    if (!res.writableEnded && !res.destroyed) {
      if (res.headersSent) {
        res.destroy();
      } else {
        json(res, status, { error: { code, message } });
      }
    }
  } finally {
    if (!pathnameForLog.startsWith('/api/events')) {
      const elapsed = now() - startedAt;
      if (pathnameForLog.startsWith('/api/') && elapsed > 20) {
        log(`${req.method} ${pathnameForLog} · ${elapsed}ms`);
      }
    }
  }
});

server.requestTimeout = 0;
server.headersTimeout = 30 * 1000;
server.timeout = 0;
server.keepAliveTimeout = 65 * 1000;

function cleanup() {
  const cutoff = now() - TRANSFER_TTL_MS;
  for (const transfer of transfers.values()) {
    if (transfer.status === 'ready' && transfer.createdAt < cutoff) {
      fsp.rm(transfer.path, { force: true }).catch(() => {});
      transfers.delete(transfer.id);
      const session = sessions.get(transfer.sessionId);
      if (session) {
        const index = session.transfers.findIndex((entry) => entry.id === transfer.id);
        if (index >= 0) session.transfers.splice(index, 1);
      }
    }
  }
  for (const [id, session] of sessions) {
    if (session.status !== 'active' && session.endedAt && session.endedAt < now() - SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
  for (const [id, request] of pendingRequests) {
    if (request.status === 'pending' && request.expiresAt < now()) {
      cancelRequest(request, 'expired');
      pendingRequests.delete(id);
    }
  }
  for (const [id, client] of clients) {
    if (!client.online && client.lastSeen < now() - 24 * 60 * 60 * 1000) {
      clients.delete(id);
      tokenIndex.delete(client.token);
    }
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref?.();

async function start() {
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  const info = serverInfo();
  const local = `http://localhost:${info.port}`;
  console.log('');
  console.log(`  ${APP_NAME} · v${VERSION}`);
  console.log(`  本机访问   ${local}`);
  for (const entry of info.urls) {
    console.log(`  局域网访问 ${entry.url}  (${entry.iface})`);
  }
  console.log('');
  console.log('  让两台设备连接同一个 Wi-Fi，并打开上面的局域网地址。');
  console.log('  如其他设备无法访问，请允许 Node.js 通过 Windows 专用网络防火墙。');
  console.log('');
}

process.on('SIGINT', () => {
  console.log('\n正在关闭服务…');
  for (const client of clients.values()) {
    for (const res of client.sseConnections) {
      try { res.end(); } catch { /* noop */ }
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});

start().catch((error) => {
  console.error('服务启动失败：', error.message);
  process.exit(1);
});
