'use strict';

/**
 * End-to-end test for the LAN transfer service.
 *
 * Run with: node test/e2e.js
 * It boots an isolated server, drives two clients over HTTP + SSE, and checks
 * handshake, relay upload, progress events, authenticated downloads, range
 * requests, and declined/cancelled requests.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 19000 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DATA = path.join(ROOT, `.test-data-${process.pid}`);

let child = null;
const sseClients = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      /* not started yet */
    }
    await sleep(120);
  }
  throw new Error('Test server did not start in time.');
}

async function api(pathname, { token, method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders['x-client-token'] = token;
  const binary = Buffer.isBuffer(body) || ArrayBuffer.isView(body);
  if (body !== undefined && !binary && typeof body !== 'string') {
    requestHeaders['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${pathname}`, { method, headers: requestHeaders, body });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { response, status: response.status, data };
}

async function register(name, device) {
  const result = await api('/api/register', {
    method: 'POST',
    body: { name, device, kind: 'desktop' },
  });
  assert.equal(result.status, 200, `register ${name}`);
  assert.ok(result.data.token, 'registration token');
  assert.ok(result.data.client?.id, 'client id');
  return result.data;
}

function connectSSE(token) {
  const controller = new AbortController();
  const events = [];
  const waiters = [];
  let closed = false;

  const ready = fetch(`${BASE}/api/events?token=${encodeURIComponent(token)}`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  }).then(async (response) => {
    assert.equal(response.status, 200, 'SSE response status');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const emit = (block) => {
      let eventName = 'message';
      const dataLines = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) return;
      let parsed;
      try {
        parsed = JSON.parse(dataLines.join('\n'));
      } catch {
        return;
      }
      const record = { name: eventName, data: parsed, at: Date.now() };
      events.push(record);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter.name !== eventName) continue;
        let matches = false;
        try {
          matches = waiter.predicate(parsed);
        } catch {
          matches = false;
        }
        if (!matches) continue;
        clearTimeout(waiter.timer);
        waiters.splice(index, 1);
        waiter.resolve(parsed);
      }
    };

    (async () => {
      try {
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            emit(block);
          }
        }
      } catch (error) {
        if (!closed) events.push({ name: 'stream-error', data: { message: error.message } });
      }
    })();

    return {
      waitFor(name, predicate = () => true, timeout = 5000) {
        const existing = events.find((entry) => entry.name === name && predicate(entry.data));
        if (existing) return Promise.resolve(existing.data);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const index = waiters.findIndex((entry) => entry.timer === timer);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`Timed out waiting for SSE event "${name}". Saw: ${events.map((e) => e.name).join(', ')}`));
          }, timeout);
          waiters.push({ name, predicate, resolve, reject, timer });
        });
      },
      events,
      close() {
        closed = true;
        controller.abort();
      },
    };
  });

  const client = {
    ready,
    events,
    async waitFor(...args) {
      const stream = await ready;
      return stream.waitFor(...args);
    },
    close() {
      closed = true;
      controller.abort();
    },
  };
  sseClients.push(client);
  return client;
}

async function initClient(registration) {
  const sse = connectSSE(registration.token);
  await sse.ready;
  await sse.waitFor('init', () => true);
  return sse;
}

async function run() {
  await fs.rm(TEST_DATA, { recursive: true, force: true });
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TEST_DATA },
    stdio: 'inherit',
  });
  let serverLog = '';
  child.on('exit', (code) => {
    if (code !== null && code !== 0) serverLog += `\n[server exited ${code}]`;
  });

  process.on('exit', () => {
    if (child && !child.killed) child.kill();
  });

  try {
    await waitForServer();
    console.log('✓ health endpoint');

    const home = await fetch(`${BASE}/`);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /邻传/);
    assert.match(html, /NearDrop/);
    const css = await fetch(`${BASE}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(await css.text(), /--blue:/);
    const traversal = await fetch(`${BASE}/%2e%2e/server.js`);
    assert.notEqual(traversal.status, 200, 'path traversal must not serve server.js');
    console.log('✓ static app and path traversal guard');

    const alice = await register('测试小鹿', 'Windows · Edge');
    const bob = await register('测试海豚', 'Mac · Safari');
    assert.notEqual(alice.client.id, bob.client.id);
    const sameName = await register('测试小鹿', 'Linux · Firefox');
    assert.notEqual(sameName.client.name, alice.client.name, 'automatic names stay unambiguous');
    assert.match(sameName.client.name, /^测试小鹿 \d+$/);

    const aliceSSE = await initClient(alice);
    const bobSSE = await initClient(bob);

    const alicePeers = await aliceSSE.waitFor('peers', (data) => data.peers.some((peer) => peer.id === bob.client.id));
    assert.ok(alicePeers.peers.find((peer) => peer.id === bob.client.id), 'Alice sees Bob');
    const bobPeers = await bobSSE.waitFor('peers', (data) => data.peers.some((peer) => peer.id === alice.client.id));
    assert.ok(bobPeers.peers.find((peer) => peer.id === alice.client.id), 'Bob sees Alice');
    console.log('✓ presence discovery');

    const connect = await api('/api/connections', {
      token: alice.token,
      method: 'POST',
      body: { toId: bob.client.id },
    });
    assert.equal(connect.status, 201, 'connection request created');
    const requestId = connect.data.request.id;
    const incoming = await bobSSE.waitFor('connection-request', (data) => data.request.id === requestId);
    assert.equal(incoming.request.from.name, '测试小鹿');
    await aliceSSE.waitFor('connection-pending', (data) => data.request.id === requestId);

    const accept = await api(`/api/connections/${requestId}/accept`, { token: bob.token, method: 'POST' });
    assert.equal(accept.status, 200, 'connection accepted');
    const sessionId = accept.data.session.id;
    assert.ok(sessionId, 'session id');
    const aliceSessionEvent = await aliceSSE.waitFor('session-started', (data) => data.session?.id === sessionId);
    const bobSessionEvent = await bobSSE.waitFor('session-started', (data) => data.session?.id === sessionId);
    assert.equal(aliceSessionEvent.session.peer.name, '测试海豚');
    assert.equal(bobSessionEvent.session.peer.name, '测试小鹿');
    console.log('✓ two-sided handshake');

    await sleep(50);

    const files = [
      { name: '你好 世界.txt', size: Buffer.byteLength('Hello from 邻传!\n二行。\n'), type: 'text/plain' },
      { name: 'empty.dat', size: 0, type: 'application/octet-stream' },
    ];
    const offerResult = await api(`/api/sessions/${sessionId}/offers`, {
      token: alice.token,
      method: 'POST',
      body: { files },
    });
    assert.equal(offerResult.status, 201, 'file offer created');
    const offerId = offerResult.data.offer.id;
    const offerReceived = await bobSSE.waitFor('offer-received', (data) => data.offer.id === offerId);
    assert.equal(offerReceived.offer.files.length, 2);
    assert.equal(offerReceived.offer.files[0].name, '你好 世界.txt');

    const acceptOffer = await api(`/api/offers/${offerId}/accept`, { token: bob.token, method: 'POST' });
    assert.equal(acceptOffer.status, 200, 'file offer accepted');
    await aliceSSE.waitFor('offer-accepted', (data) => data.offer?.id === offerId);

    const content = Buffer.from('Hello from 邻传!\n二行。\n', 'utf8');
    const uploadOne = await api(`/api/sessions/${sessionId}/offers/${offerId}/files/0`, {
      token: alice.token,
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: content,
    });
    assert.equal(uploadOne.status, 200, `first upload: ${JSON.stringify(uploadOne.data)}`);
    const readyOne = await bobSSE.waitFor('file-ready', (data) => data.transfer?.fileIndex === 0);
    assert.equal(readyOne.transfer.size, content.length);
    assert.equal(readyOne.transfer.toId, bob.client.id);
    assert.ok(readyOne.transfer.downloadUrl, 'download URL');
    assert.match(readyOne.transfer.downloadUrl, /^\/api\/transfers\/.+\/download\?token=/);

    const download = await fetch(`${BASE}${readyOne.transfer.downloadUrl}`);
    assert.equal(download.status, 200, 'download without client header token');
    assert.equal(Buffer.from(await download.arrayBuffer()).toString(), content.toString());
    assert.match(download.headers.get('content-disposition') || '', /attachment/);
    assert.match(download.headers.get('content-disposition') || '', /filename\*=UTF-8''/);

    const range = await fetch(`${BASE}${readyOne.transfer.downloadUrl}`, {
      headers: { range: 'bytes=0-4' },
    });
    assert.equal(range.status, 206, 'range request');
    assert.equal(await range.text(), 'Hello');
    assert.match(range.headers.get('content-range') || '', /^bytes 0-4\//);

    const missingToken = await fetch(`${BASE}/api/transfers/${readyOne.transfer.id}/download`);
    assert.equal(missingToken.status, 404, 'download token required');

    const uploadTwo = await api(`/api/sessions/${sessionId}/offers/${offerId}/files/1`, {
      token: alice.token,
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    });
    assert.equal(uploadTwo.status, 200, `empty file upload: ${JSON.stringify(uploadTwo.data)}`);
    const readyTwo = await bobSSE.waitFor('file-ready', (data) => data.transfer?.fileIndex === 1);
    assert.equal(readyTwo.transfer.size, 0);
    const done = await bobSSE.waitFor('offer-completed', (data) => data.offerId === offerId);
    assert.equal(done.count, 2);
    const emptyDownload = await fetch(`${BASE}${readyTwo.transfer.downloadUrl}`);
    assert.equal(emptyDownload.status, 200);
    assert.equal((await emptyDownload.arrayBuffer()).byteLength, 0);
    console.log('✓ file offer, relay upload, progress, and authenticated download');

    // The reverse direction must work too.
    const reverseBytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    const reverseOffer = await api(`/api/sessions/${sessionId}/offers`, {
      token: bob.token,
      method: 'POST',
      body: { files: [{ name: 'reverse.bin', size: reverseBytes.length, type: 'application/octet-stream' }] },
    });
    assert.equal(reverseOffer.status, 201);
    const reverseOfferId = reverseOffer.data.offer.id;
    await aliceSSE.waitFor('offer-received', (data) => data.offer.id === reverseOfferId);
    await api(`/api/offers/${reverseOfferId}/accept`, { token: alice.token, method: 'POST' });
    await bobSSE.waitFor('offer-accepted', (data) => data.offer?.id === reverseOfferId);
    const reverseUpload = await fetch(`${BASE}/api/sessions/${sessionId}/offers/${reverseOfferId}/files/0`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'x-client-token': bob.token },
      body: reverseBytes,
    });
    assert.equal(reverseUpload.status, 200);
    const reverseReady = await aliceSSE.waitFor('file-ready', (data) => data.offerId === reverseOfferId);
    const reverseDownload = await fetch(`${BASE}${reverseReady.transfer.downloadUrl}`);
    assert.deepEqual(Buffer.from(await reverseDownload.arrayBuffer()), reverseBytes);
    console.log('✓ bidirectional transfer');

    // Validation: metadata size must match the actual request body.
    const mismatchOffer = await api(`/api/sessions/${sessionId}/offers`, {
      token: alice.token,
      method: 'POST',
      body: { files: [{ name: 'mismatch.txt', size: 10, type: 'text/plain' }] },
    });
    assert.equal(mismatchOffer.status, 201);
    const mismatchId = mismatchOffer.data.offer.id;
    await bobSSE.waitFor('offer-received', (data) => data.offer.id === mismatchId);
    await api(`/api/offers/${mismatchId}/accept`, { token: bob.token, method: 'POST' });
    await aliceSSE.waitFor('offer-accepted', (data) => data.offer?.id === mismatchId);
    const shortUpload = await fetch(`${BASE}/api/sessions/${sessionId}/offers/${mismatchId}/files/0`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', 'x-client-token': alice.token },
      body: 'short',
    });
    assert.equal(shortUpload.status, 400, 'size mismatch rejected');
    const mismatchBody = await shortUpload.json();
    assert.equal(mismatchBody.error.code, 'SIZE_MISMATCH');

    const cancelMismatch = await api(`/api/offers/${mismatchId}/cancel`, { token: alice.token, method: 'POST' });
    assert.equal(cancelMismatch.status, 200, 'cancel accepted offer with no ready file');
    console.log('✓ upload validation and offer cancellation');

    // Close the session and confirm both sides are notified.
    const close = await api(`/api/sessions/${sessionId}/close`, { token: bob.token, method: 'POST' });
    assert.equal(close.status, 200);
    await aliceSSE.waitFor('session-ended', (data) => data.sessionId === sessionId);
    await bobSSE.waitFor('session-ended', (data) => data.sessionId === sessionId);
    console.log('✓ session close notifications');

    // A fresh handshake lets us exercise decline and cancellation paths.
    const connectAgain = await api('/api/connections', {
      token: alice.token,
      method: 'POST',
      body: { toId: bob.client.id },
    });
    assert.equal(connectAgain.status, 201);
    const requestAgain = connectAgain.data.request.id;
    await bobSSE.waitFor('connection-request', (data) => data.request.id === requestAgain);
    const decline = await api(`/api/connections/${requestAgain}/decline`, { token: bob.token, method: 'POST' });
    assert.equal(decline.status, 200);
    await aliceSSE.waitFor('connection-declined', (data) => data.requestId === requestAgain);

    const connectThird = await api('/api/connections', {
      token: alice.token,
      method: 'POST',
      body: { toId: bob.client.id },
    });
    assert.equal(connectThird.status, 201);
    const requestThird = connectThird.data.request.id;
    await bobSSE.waitFor('connection-request', (data) => data.request.id === requestThird);
    const cancel = await api(`/api/connections/${requestThird}/cancel`, { token: alice.token, method: 'POST' });
    assert.equal(cancel.status, 200);
    await bobSSE.waitFor('connection-cancelled', (data) => data.requestId === requestThird);
    console.log('✓ connection decline and cancellation');

    // Authentication guards.
    const unauth = await api('/api/state');
    assert.equal(unauth.status, 401);
    const badToken = await api('/api/state', { token: 'not-a-real-token' });
    assert.equal(badToken.status, 401);
    const selfConnect = await api('/api/connections', {
      token: alice.token,
      method: 'POST',
      body: { toId: alice.client.id },
    });
    assert.equal(selfConnect.status, 400);
    console.log('✓ auth and self-connection guards');

    console.log('\nAll end-to-end checks passed.');
  } catch (error) {
    console.error('\nTest failed:', error.message);
    if (serverLog) {
      console.error('\n--- server log ---\n' + serverLog);
    }
    process.exitCode = 1;
  } finally {
    for (const client of sseClients) {
      try {
        client.close();
      } catch {
        /* noop */
      }
    }
    if (child) {
      child.kill();
      await sleep(100);
    }
    await fs.rm(TEST_DATA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(ROOT, '.test-data'), { recursive: true, force: true }).catch(() => {});
  }
}

run();
