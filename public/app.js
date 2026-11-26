'use strict';

/*
 * 邻传 NearDrop — browser client.
 *
 * All state changes initiated by the server arrive over one EventSource.
 * File bytes use XHR so the sender gets real upload progress; downloads are
 * plain browser navigations handled by the download manager.
 */
(() => {
  const AUTH_KEY = 'neardrop.auth.v1';
  const NAME_KEY = 'neardrop.name.v1';
  const AUTO_DOWNLOAD_KEY = 'neardrop.autoDownload.v1';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const els = {
    netStatus: $('#netStatus'),
    netLabel: $('#netLabel'),
    selfAvatar: $('#selfAvatar'),
    selfName: $('#selfName'),
    selfDevice: $('#selfDevice'),
    profileBtn: $('#profileBtn'),
    inviteBtn: $('#inviteBtn'),
    refreshBtn: $('#refreshBtn'),
    peerCount: $('#peerCount'),
    peerList: $('#peerList'),
    pendingSpot: $('#pendingSpot'),
    emptyState: $('#emptyState'),
    sessionPanel: $('#sessionPanel'),
    peerAvatar: $('#peerAvatar'),
    selfAvatarSession: $('#selfAvatarSession'),
    sessionTitle: $('#sessionTitle'),
    sessionMeta: $('#sessionMeta'),
    disconnectBtn: $('#disconnectBtn'),
    composerBody: $('#composerBody'),
    activityBody: $('#activityBody'),
    autoDownload: $('#autoDownload'),
    emptyInviteBtn: $('#emptyInviteBtn'),
    helpBtn: $('#helpBtn'),
    footerHelpBtn: $('#footerHelpBtn'),
    modalRoot: $('#modalRoot'),
    toastRoot: $('#toastRoot'),
  };

  const ui = {
    booting: true,
    bootError: false,
    network: 'connecting',
    connectBusy: false,
    connectingPeerId: null,
    sendBusy: false,
    modalBusy: false,
    staged: [],
    activeFiles: new Map(),
    activeOfferId: null,
    uploading: false,
    activeXHR: null,
    uploadError: null,
    completedOfferId: null,
    downloaded: new Set(),
    autoDownloadQueue: [],
    autoDownloadRunning: false,
    lastRequestId: null,
    lastOfferId: null,
    lastSessionToastId: null,
    lastCompletionToastId: null,
    recoveryTimer: null,
    rejoining: false,
    modal: null,
    previousFocus: null,
  };

  const state = {
    token: null,
    me: null,
    peers: [],
    incomingRequest: null,
    outgoingRequest: null,
    session: null,
    server: null,
    sse: null,
    autoDownload: readAutoDownload(),
  };

  boot();

  async function boot() {
    bindStaticEvents();
    syncAutoDownloadInputs();
    const saved = readAuth();
    if (saved?.token) state.token = saved.token;
    await registerClient({ initial: true });
  }

  function readAuth() {
    try {
      const raw = sessionStorage.getItem(AUTH_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.token === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeAuth(token) {
    try {
      sessionStorage.setItem(AUTH_KEY, JSON.stringify({ token }));
    } catch {
      /* Private mode can reject storage; the page still works for this load. */
    }
  }

  function readAutoDownload() {
    try {
      const stored = localStorage.getItem(AUTO_DOWNLOAD_KEY);
      if (stored === null) return true;
      return stored === '1';
    } catch {
      return true;
    }
  }

  function saveAutoDownload(value) {
    state.autoDownload = Boolean(value);
    try {
      localStorage.setItem(AUTO_DOWNLOAD_KEY, value ? '1' : '0');
    } catch {
      /* noop */
    }
    syncAutoDownloadInputs();
  }

  function syncAutoDownloadInputs() {
    if (els.autoDownload) els.autoDownload.checked = state.autoDownload;
    const modalToggle = $('#offerAutoDownload');
    if (modalToggle) modalToggle.checked = state.autoDownload;
  }

  function detectDevice() {
    const ua = navigator.userAgent;
    let os = '未知设备';
    if (/iPhone/.test(ua)) os = 'iPhone';
    else if (/iPad/.test(ua)) os = 'iPad';
    else if (/Android/.test(ua)) os = /Mobile/.test(ua) ? 'Android 手机' : 'Android 平板';
    else if (/Windows/.test(ua)) os = 'Windows';
    else if (/Mac OS X|Macintosh/.test(ua)) os = 'Mac';
    else if (/Linux/.test(ua)) os = 'Linux';

    let browser = '浏览器';
    if (/Edg\//.test(ua)) browser = 'Edge';
    else if (/OPR\//.test(ua)) browser = 'Opera';
    else if (/Chrome\//.test(ua)) browser = 'Chrome';
    else if (/Firefox\//.test(ua)) browser = 'Firefox';
    else if (/Safari\//.test(ua)) browser = 'Safari';

    const kind = /iPad|Tablet/.test(ua) ? 'tablet' : /iPhone|Android.*Mobile|Mobile/.test(ua) ? 'phone' : 'desktop';
    return { device: `${os} · ${browser}`, kind };
  }

  /* ---------------------------------------------------------------------- */
  /* API                                                                    */
  /* ---------------------------------------------------------------------- */

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (!options.noAuth) {
      if (!state.token) throw new Error('尚未连接到本地服务。');
      headers.set('x-client-token', state.token);
    }
    if (options.body && typeof options.body === 'string' && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    let response;
    try {
      response = await fetch(path, { ...options, headers });
    } catch {
      const error = new Error('无法连接本地服务，请确认服务仍在运行。');
      error.network = true;
      throw error;
    }
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || `请求失败（${response.status}）`);
      error.status = response.status;
      error.code = data?.error?.code || 'HTTP_ERROR';
      if (response.status === 401 && !options.noAuth) startRecoveryCheck();
      throw error;
    }
    return data;
  }

  async function registerClient({ initial = false } = {}) {
    if (!initial) ui.booting = true;
    ui.bootError = false;
    setNetwork(initial ? 'connecting' : 'reconnecting');
    const saved = readAuth();
    const storedName = (() => {
      try {
        return localStorage.getItem(NAME_KEY) || '';
      } catch {
        return '';
      }
    })();
    const device = detectDevice();
    try {
      const data = await api('/api/register', {
        method: 'POST',
        noAuth: true,
        body: JSON.stringify({
          token: saved?.token || state.token || undefined,
          name: storedName || undefined,
          device: device.device,
          kind: device.kind,
        }),
      });
      state.token = data.token;
      writeAuth(data.token);
      if (!storedName && data.client?.name) {
        try {
          localStorage.setItem(NAME_KEY, data.client.name);
        } catch {
          /* noop */
        }
      }
      ui.booting = false;
      ui.bootError = false;
      applyServerState(data);
      startSSE();
      maybeShowPendingModals();
    } catch (error) {
      ui.booting = false;
      ui.bootError = true;
      setNetwork('offline');
      renderProfile();
      renderPeers();
      renderPending();
      toast('无法连接本地服务，请确认服务仍在运行，然后重试。', 'error', '加入失败');
    }
  }

  function startSSE() {
    if (state.sse) {
      try {
        state.sse.close();
      } catch {
        /* noop */
      }
    }
    if (!state.token) return;
    setNetwork('reconnecting');
    const source = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
    state.sse = source;
    source.addEventListener('open', () => {
      setNetwork('online');
      stopRecoveryCheck();
    });
    source.addEventListener('error', () => {
      if (source.readyState === EventSource.CLOSED) {
        setNetwork('offline');
      } else {
        setNetwork('reconnecting');
      }
      startRecoveryCheck();
    });
    const events = [
      'init',
      'peers',
      'peer-updated',
      'connection-request',
      'connection-pending',
      'connection-request-resolved',
      'connection-declined',
      'connection-cancelled',
      'connection-expired',
      'session-started',
      'session-ended',
      'offer-received',
      'offer-accepted',
      'offer-declined',
      'offer-cancelled',
      'offer-expired',
      'offer-updated',
      'transfer-started',
      'transfer-progress',
      'transfer-failed',
      'file-ready',
      'offer-completed',
    ];
    for (const name of events) {
      source.addEventListener(name, (event) => {
        let payload = null;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        handleServerEvent(name, payload);
      });
    }
  }

  function startRecoveryCheck() {
    if (ui.recoveryTimer) return;
    ui.recoveryTimer = setInterval(async () => {
      if (state.sse && state.sse.readyState === EventSource.OPEN) {
        stopRecoveryCheck();
        return;
      }
      try {
        const response = await fetch('/api/state', {
          headers: { 'x-client-token': state.token || '' },
          cache: 'no-store',
        });
        if (response.status === 401) {
          stopRecoveryCheck();
          await rejoinAfterRestart();
          return;
        }
        if (response.ok) {
          const data = await response.json();
          applyServerState(data);
          setNetwork('reconnecting');
        }
      } catch {
        /* The service is still unreachable; keep trying. */
      }
    }, 4000);
  }

  function stopRecoveryCheck() {
    if (ui.recoveryTimer) {
      clearInterval(ui.recoveryTimer);
      ui.recoveryTimer = null;
    }
  }

  async function rejoinAfterRestart() {
    if (ui.rejoining) return;
    ui.rejoining = true;
    try {
      applySession(null);
      state.peers = [];
      state.incomingRequest = null;
      state.outgoingRequest = null;
      state.token = null;
      renderAll();
      await registerClient({ initial: false });
      toast('本地服务已重新连接，传输通道需要重新建立。', 'info', '已重新加入局域网');
    } catch {
      setNetwork('offline');
    } finally {
      ui.rejoining = false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Server state & events                                                  */
  /* ---------------------------------------------------------------------- */

  function applyServerState(data) {
    if (!data || !data.client) return;
    state.me = data.client;
    if (Array.isArray(data.peers)) state.peers = data.peers;
    if ('pendingIncoming' in data) state.incomingRequest = data.pendingIncoming;
    if ('pendingOutgoing' in data) state.outgoingRequest = data.pendingOutgoing;
    if (data.server) state.server = data.server;
    if ('session' in data) applySession(data.session);
    renderAll();
  }

  function applySession(next) {
    const previous = state.session;
    if (next?.id !== previous?.id) {
      resetSessionUi();
      if (next) {
        state.session = next;
        renderAll();
        maybeResumeUploads();
        return;
      }
      state.session = null;
      return;
    }
    state.session = next || null;
    if (next) syncSessionPeer();
  }

  function resetSessionUi() {
    if (ui.activeXHR) {
      try {
        ui.activeXHR.abort();
      } catch {
        /* noop */
      }
      ui.activeXHR = null;
    }
    ui.staged = [];
    ui.activeFiles.clear();
    ui.activeOfferId = null;
    ui.uploading = false;
    ui.uploadError = null;
    ui.completedOfferId = null;
    ui.downloaded.clear();
    ui.autoDownloadQueue = [];
    ui.autoDownloadRunning = false;
    ui.sendBusy = false;
    ui.lastCompletionToastId = null;
  }

  function syncSessionPeer() {
    const session = state.session;
    if (!session?.peer) return;
    const fresh = state.peers.find((peer) => peer.id === session.peer.id);
    if (fresh) session.peer = { ...session.peer, ...fresh };
  }

  function handleServerEvent(name, data) {
    switch (name) {
      case 'init':
        setNetwork('online');
        applyServerState(data);
        maybeShowPendingModals();
        break;

      case 'peers':
        state.peers = Array.isArray(data.peers) ? data.peers : [];
        if (state.session) syncSessionPeer();
        renderProfile();
        renderPeers();
        if (state.session) renderSessionHeader();
        break;

      case 'peer-updated':
        if (data.peer) {
          const index = state.peers.findIndex((peer) => peer.id === data.peer.id);
          if (index >= 0) state.peers[index] = data.peer;
          if (state.session?.peer?.id === data.peer.id) {
            state.session.peer = { ...state.session.peer, ...data.peer };
            renderSessionHeader();
          }
          renderPeers();
        }
        break;

      case 'connection-request':
        state.incomingRequest = data.request || null;
        renderPeers();
        renderPending();
        if (state.incomingRequest) showConnectionModal(state.incomingRequest);
        break;

      case 'connection-pending':
        state.outgoingRequest = data.request || null;
        renderPeers();
        renderPending();
        break;

      case 'connection-request-resolved':
        if (state.incomingRequest?.id === data.requestId) {
          state.incomingRequest = null;
          closeModal(`connection:${data.requestId}`);
          renderPeers();
          renderPending();
        }
        break;

      case 'connection-declined': {
        const outgoing = state.outgoingRequest;
        const nameOfPeer = outgoing?.to?.name || state.peers.find((peer) => peer.id === data.peerId)?.name || '对方';
        state.outgoingRequest = null;
        renderPeers();
        renderPending();
        toast(`「${nameOfPeer}」拒绝了这次连接请求。`, 'info', '连接未建立');
        break;
      }

      case 'connection-cancelled':
        if (state.incomingRequest?.id === data.requestId) {
          state.incomingRequest = null;
          closeModal(`connection:${data.requestId}`);
          renderPeers();
          renderPending();
          toast('对方取消了连接请求。', 'info');
        }
        break;

      case 'connection-expired':
        if (state.incomingRequest?.id === data.requestId) state.incomingRequest = null;
        if (state.outgoingRequest?.id === data.requestId) state.outgoingRequest = null;
        closeModal(`connection:${data.requestId}`);
        renderPeers();
        renderPending();
        toast('连接请求已超时，请重新发起。', 'info');
        break;

      case 'session-started':
        state.incomingRequest = null;
        state.outgoingRequest = null;
        closeAllTransientModals();
        applySession(data.session);
        renderAll();
        maybeShowPendingModals();
        if (data.session?.id && ui.lastSessionToastId !== data.session.id) {
          ui.lastSessionToastId = data.session.id;
          dismissToastGroup('connection');
          toast(
            data.session.peer
              ? `你已与「${data.session.peer.name}」建立传输通道，可以开始互传文件了。`
              : '双方已确认连接，可以开始互传文件了。',
            'success',
            '握手成功',
          );
        }
        break;

      case 'session-ended': {
        const peerName = state.session?.peer?.name || '对方';
        const wasMine = !data.byId || data.byId === state.me?.id;
        applySession(null);
        closeAllTransientModals();
        ui.lastSessionToastId = null;
        renderAll();
        if (data.reason === 'peer-offline') {
          toast(`「${peerName}」已离线，传输通道已关闭。`, 'info', '连接已断开');
        } else if (wasMine) {
          toast('传输通道已关闭，你可以重新邀请其他设备。', 'info', '已断开连接');
        } else {
          toast(`「${peerName}」断开了连接。`, 'info', '连接已断开');
        }
        break;
      }

      case 'offer-received':
        if (state.session) {
          state.session.offer = data.offer;
          if (data.from) state.session.peer = { ...(state.session.peer || {}), ...data.from };
        }
        renderAll();
        maybeShowPendingModals();
        break;

      case 'offer-accepted': {
        if (!state.session) break;
        if (data.offer) state.session.offer = data.offer;
        renderComposer();
        renderActivity();
        if (data.offer?.fromId === state.me?.id) {
          toast('对方已接收，开始发送文件…', 'info', '正在发送');
          beginUploads();
        } else {
          renderActivity();
        }
        break;
      }

      case 'offer-declined': {
        if (!state.session) break;
        const offer = state.session.offer;
        if (offer && offer.id === data.offerId) offer.status = 'declined';
        closeModal(`offer:${data.offerId}`);
        if (offer?.fromId === state.me?.id) {
          restoreActiveFiles(offer);
          ui.uploadError = null;
          toast('对方拒绝了这批文件，你可以调整后重新发送。', 'info', '文件未发送');
        } else if (data.byId !== state.me?.id) {
          toast('文件请求已被拒绝。', 'info');
        }
        renderAll();
        break;
      }

      case 'offer-cancelled': {
        if (!state.session) break;
        const offer = state.session.offer;
        if (offer && offer.id === data.offerId) offer.status = 'cancelled';
        closeModal(`offer:${data.offerId}`);
        ui.activeFiles.clear();
        ui.activeOfferId = null;
        ui.uploadError = null;
        if (data.byId !== state.me?.id) {
          toast('对方取消了本次文件传输。', 'info');
        }
        renderAll();
        break;
      }

      case 'offer-expired': {
        if (!state.session) break;
        const offer = state.session.offer;
        if (offer && offer.id === data.offerId) offer.status = 'expired';
        closeModal(`offer:${data.offerId}`);
        if (offer?.fromId === state.me?.id) {
          restoreActiveFiles(offer);
          ui.uploadError = null;
          toast('对方没有及时确认，文件请求已过期。', 'info', '请求已过期');
        } else {
          toast('文件请求已过期。', 'info');
        }
        renderAll();
        break;
      }

      case 'offer-updated':
        if (state.session && data.offer) {
          state.session.offer = data.offer;
          renderComposer();
          renderActivity();
          if (state.session.offer.status !== 'pending') closeModal(`offer:${data.offer.id}`);
        }
        break;

      case 'transfer-started':
        if (state.session && data.transfer) {
          upsertTransfer(data.transfer);
          markOfferFileState(data.offerId, data.transfer.fileIndex, 'uploading');
          if (
            ui.uploadError &&
            ui.uploadError.offerId === data.offerId &&
            ui.uploadError.fileIndex === data.transfer.fileIndex
          ) {
            ui.uploadError = null;
          }
          renderActivity();
        }
        break;

      case 'transfer-progress':
        applyProgress(data);
        break;

      case 'file-ready':
        if (state.session) {
          if (data.offer) state.session.offer = data.offer;
          else markOfferFileState(data.offerId, data.fileIndex, 'ready');
          if (data.transfer) upsertTransfer(data.transfer);
          if (
            ui.uploadError &&
            ui.uploadError.offerId === data.offerId &&
            ui.uploadError.fileIndex === data.fileIndex
          ) {
            ui.uploadError = null;
          }
          if (data.transfer?.toId === state.me?.id) {
            maybeAutoDownload(data.transfer, data.offerId);
          }
          renderComposer();
          renderActivity();
          if (data.offer?.status === 'completed') maybeAnnounceCompletion(data.offer);
        }
        break;

      case 'offer-completed':
        if (!state.session) break;
        if (state.session.offer && state.session.offer.id === data.offerId) {
          state.session.offer.status = 'completed';
          state.session.offer.files.forEach((file) => {
            file.state = 'ready';
          });
        }
        ui.uploadError = null;
        ui.activeFiles.clear();
        renderComposer();
        renderActivity();
        maybeAnnounceCompletion(state.session.offer);
        break;

      case 'transfer-failed':
        if (!state.session) break;
        state.session.transfers = state.session.transfers.filter((transfer) => transfer.offerId !== data.offerId || transfer.fileIndex !== data.fileIndex);
        markOfferFileState(data.offerId, data.fileIndex, 'pending');
        if (state.session.offer?.fromId === state.me?.id) {
          ui.uploadError = {
            offerId: data.offerId,
            fileIndex: data.fileIndex,
            fileName: state.session.offer?.files?.[data.fileIndex]?.name || '文件',
            message: data.message || '文件传输中断',
          };
          toast(`「${ui.uploadError.fileName}」传输中断，可以重试。`, 'error', '发送失败');
        } else {
          toast('对方发送文件时中断了，请等待对方重试。', 'error', '接收中断');
        }
        renderActivity();
        break;

      default:
        break;
    }
  }

  function upsertTransfer(transfer) {
    if (!state.session || !transfer) return;
    const list = state.session.transfers;
    const index = list.findIndex((entry) => entry.id === transfer.id);
    if (index >= 0) list[index] = { ...list[index], ...transfer };
    else list.push(transfer);
    markOfferFileState(transfer.offerId, transfer.fileIndex, transfer.status === 'ready' ? 'ready' : 'uploading');
  }

  function markOfferFileState(offerId, index, fileState) {
    const offer = state.session?.offer;
    if (!offer || offer.id !== offerId) return;
    const file = offer.files.find((entry) => entry.index === index);
    if (file) file.state = fileState;
  }

  function applyProgress(data) {
    if (!state.session) return;
    const transfer = state.session.transfers.find((entry) => entry.id === data.transferId);
    if (!transfer) {
      renderActivity();
      return;
    }
    transfer.bytes = data.bytes;
    transfer.status = 'uploading';
    markOfferFileState(data.offerId, data.fileIndex, 'uploading');
    const item = els.activityBody.querySelector(`[data-transfer-id="${cssEscape(data.transferId)}"]`);
    if (!item) {
      renderActivity();
      return;
    }
    const percent = data.size > 0 ? Math.min(100, Math.round((data.bytes / data.size) * 100)) : 0;
    const fill = item.querySelector('.progress-fill');
    const percentEl = item.querySelector('.progress-percent');
    const bytesEl = item.querySelector('[data-progress-bytes]');
    if (fill) fill.style.setProperty('--progress', `${percent}%`);
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (bytesEl) bytesEl.textContent = `${formatBytes(data.bytes)} / ${formatBytes(data.size)}`;
  }

  function updateOptimisticProgress(offerId, fileIndex, loaded, total) {
    if (!state.session?.offer || state.session.offer.id !== offerId) return;
    const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    const transfer = state.session.transfers.find((entry) => entry.offerId === offerId && entry.fileIndex === fileIndex);
    if (transfer) {
      transfer.bytes = loaded;
      const item = els.activityBody.querySelector(`[data-transfer-id="${cssEscape(transfer.id)}"]`);
      applyProgressToElement(item, percent, loaded, total);
    } else {
      const item = els.activityBody.querySelector(`[data-file-index="${fileIndex}"][data-offer-id="${cssEscape(offerId)}"]`);
      applyProgressToElement(item, percent, loaded, total);
    }
  }

  function applyProgressToElement(item, percent, loaded, total) {
    if (!item) return;
    const fill = item.querySelector('.progress-fill');
    const percentEl = item.querySelector('.progress-percent');
    const bytesEl = item.querySelector('[data-progress-bytes]');
    if (fill) fill.style.setProperty('--progress', `${percent}%`);
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (bytesEl) bytesEl.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                              */
  /* ---------------------------------------------------------------------- */

  function renderAll() {
    renderProfile();
    renderPeers();
    renderPending();
    renderStage();
    if (state.session) {
      renderSessionHeader();
      renderComposer();
      renderActivity();
    }
    updateDocumentTitle();
    syncAutoDownloadInputs();
  }

  function renderProfile() {
    const me = state.me;
    if (!me) {
      els.selfName.textContent = ui.bootError ? '未连接到服务' : '正在加入…';
      els.selfDevice.textContent = '本机';
      setAvatar(els.selfAvatar, '·', '#3355e8');
      setAvatar(els.selfAvatarSession, '·', '#2c2e3d');
      return;
    }
    els.selfName.textContent = me.name;
    els.selfDevice.textContent = me.device || '本机';
    setAvatar(els.selfAvatar, initials(me.name), me.color);
    setAvatar(els.selfAvatarSession, initials(me.name), me.color);
    els.profileBtn.setAttribute('aria-label', `修改我的昵称，当前为 ${me.name}`);
  }

  function renderPeers() {
    els.peerCount.textContent = String(state.peers.length);
    if (!state.me && ui.booting) {
      els.peerList.innerHTML = `
        <div class="peer-skeleton"><span></span><div><i></i><i></i></div></div>
        <div class="peer-skeleton"><span></span><div><i></i><i></i></div></div>
      `;
      return;
    }
    if (ui.bootError) {
      els.peerList.innerHTML = `
        <div class="peer-empty">
          <span class="peer-empty-icon"><svg class="icon"><use href="#i-alert"></use></svg></span>
          <strong>暂时连不上本地服务</strong>
          <p>请确认服务窗口仍在运行，或检查是否连接到了同一个 Wi-Fi。</p>
          <button class="text-btn" type="button" data-action="retry-join">重新连接 <svg class="icon"><use href="#i-refresh"></use></svg></button>
        </div>
      `;
      return;
    }
    if (state.peers.length === 0) {
      els.peerList.innerHTML = `
        <div class="peer-empty">
          <span class="peer-empty-icon"><svg class="icon"><use href="#i-wifi"></use></svg></span>
          <strong>${state.outgoingRequest ? '等待对方确认…' : '等待另一台设备加入'}</strong>
          <p>让对方连接同一个 Wi-Fi，并在浏览器中打开这个页面。设备会自动出现在这里。</p>
          <button class="text-btn" type="button" data-action="open-invite">查看加入方式 <svg class="icon"><use href="#i-arrow"></use></svg></button>
        </div>
        <div class="coming-online" aria-hidden="true">
          <span class="dot-typing"><i></i><i></i><i></i></span>
          正在自动发现附近设备
        </div>
      `;
      return;
    }

    const currentPeerId = state.session?.peer?.id || null;
    const outgoingPeerId = state.outgoingRequest?.toId || null;
    const incomingPeerId = state.incomingRequest?.fromId || null;
    const blockNewRequests = Boolean(
      state.session || state.outgoingRequest || state.incomingRequest || ui.connectBusy,
    );

    els.peerList.innerHTML = state.peers
      .map((peer, index) => {
        const connected = currentPeerId === peer.id;
        const outgoing = outgoingPeerId === peer.id;
        const incoming = incomingPeerId === peer.id;
        const busy = Boolean(peer.busy) && !connected;
        const disabled = blockNewRequests || busy;
        let badge = '';
        let statusText = '可以连接';
        if (connected) {
          badge = '<em class="is-connected">已连接</em>';
          statusText = '通道已建立';
        } else if (outgoing) {
          badge = '<em>等待确认</em>';
          statusText = '等待对方确认';
        } else if (incoming) {
          badge = '<em>请求连接</em>';
          statusText = '请求与你连接';
        } else if (busy) {
          badge = '<em>忙碌中</em>';
          statusText = '正在与其他设备传输';
        }
        const cta = outgoing || (ui.connectBusy && ui.connectingPeerId === peer.id)
          ? '<span class="spinner" aria-hidden="true"></span>'
          : '<svg class="icon"><use href="#i-arrow"></use></svg>';
        return `
          <button
            class="peer-card ${busy ? 'is-busy' : ''} ${connected ? 'is-connected' : ''}"
            type="button"
            data-peer-id="${escapeAttr(peer.id)}"
            style="--i:${index};--peer-color:${escapeAttr(peer.color || '#3355e8')}"
            ${disabled ? 'disabled' : ''}
            aria-label="${escapeAttr(connected ? '已连接' : `连接 ${peer.name}`)}，${escapeAttr(peer.device || '局域网设备')}"
          >
            <span class="peer-avatar-wrap">
              <span class="avatar avatar--md">${escapeHtml(initials(peer.name))}</span>
              <span class="peer-device-badge"><svg class="icon"><use href="#i-${peer.kind === 'phone' ? 'phone' : peer.kind === 'tablet' ? 'phone' : 'monitor'}"></use></svg></span>
            </span>
            <span class="peer-info">
              <span class="peer-name"><strong>${escapeHtml(peer.name)}</strong>${badge}</span>
              <span class="peer-meta">${escapeHtml(peer.device || '局域网设备')}<i></i><span>${statusText}</span></span>
            </span>
            <span class="peer-cta" aria-hidden="true">${cta}</span>
          </button>
        `;
      })
      .join('');
  }

  function renderPending() {
    const outgoing = state.outgoingRequest;
    if (!outgoing) {
      els.pendingSpot.innerHTML = '';
      return;
    }
    const peer = outgoing.to;
    els.pendingSpot.innerHTML = `
      <div class="pending-card">
        <div class="pending-head"><span class="spinner"></span>请求已发送</div>
        <p>等「${escapeHtml(peer?.name || '对方')}」在另一台设备上确认后，通道就会建立。</p>
        <div class="pending-actions">
          <span class="pending-name">
            <span class="avatar" style="--avatar-color:${escapeAttr(peer?.color || '#3355e8')}">${escapeHtml(initials(peer?.name || '?'))}</span>
            ${escapeHtml(peer?.device || '局域网设备')}
          </span>
          <button class="pending-cancel" type="button" data-action="cancel-request">取消请求</button>
        </div>
      </div>
    `;
  }

  function renderStage() {
    const hasSession = Boolean(state.session);
    els.emptyState.hidden = hasSession;
    els.sessionPanel.hidden = !hasSession;
    document.body.classList.toggle('has-session', hasSession);
  }

  function renderSessionHeader() {
    const session = state.session;
    if (!session) return;
    const peer = session.peer || { name: '对方', color: '#3355e8', device: '局域网设备' };
    setAvatar(els.peerAvatar, initials(peer.name), peer.color);
    els.sessionTitle.textContent = `与“${peer.name}”互传文件`;
    els.sessionMeta.textContent = `${peer.device || '局域网设备'} · 同一局域网 · 双方已确认`;
    if (state.me) setAvatar(els.selfAvatarSession, initials(state.me.name), state.me.color);
  }

  function openOffer(session = state.session) {
    if (!session?.offer) return null;
    return ['pending', 'accepted'].includes(session.offer.status) ? session.offer : null;
  }

  function renderComposer() {
    const session = state.session;
    if (!session) {
      els.composerBody.innerHTML = '';
      return;
    }
    const offer = openOffer(session);
    const peerName = session.peer?.name || '对方';
    const limits = state.server?.limits || { maxFiles: 100, maxFileSize: 10 * 1024 ** 3 };
    const staged = ui.staged;
    const total = staged.reduce((sum, file) => sum + file.size, 0);
    const blocked = Boolean(offer);
    const senderLostFiles =
      offer &&
      offer.fromId === state.me?.id &&
      offer.status === 'accepted' &&
      offer.files.some((file) => file.state !== 'ready') &&
      offer.files.some((file) => file.state !== 'ready' && !ui.activeFiles.has(file.index));

    const stagedHtml = staged.length
      ? `
        <div class="staged-wrap">
          <div class="staged-head">
            <span>已选择 ${staged.length} 个文件</span>
            <button type="button" data-action="clear-staged">清空</button>
          </div>
          <div class="staged-list">
            ${staged
              .map(
                (file, index) => `
                <div class="staged-file">
                  ${fileIcon(file.name, file.type)}
                  <div class="staged-file-info">
                    <strong title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</strong>
                    <small>${formatBytes(file.size)}</small>
                  </div>
                  <button class="remove-file" type="button" data-action="remove-staged" data-index="${index}" aria-label="移除 ${escapeAttr(file.name)}">
                    <svg class="icon"><use href="#i-close"></use></svg>
                  </button>
                </div>`
              )
              .join('')}
          </div>
        </div>`
      : '';

    let blockedHtml = '';
    if (offer) {
      if (offer.status === 'pending') {
        blockedHtml = `<div class="composer-blocked"><svg class="icon"><use href="#i-clock"></use></svg><span>${
          offer.fromId === state.me?.id
            ? '这批文件正在等待对方确认，确认后就能继续发送。'
            : '对方发来了文件请求，请先接收或拒绝后再发送新文件。'
        }</span></div>`;
      } else if (offer.status === 'accepted') {
        blockedHtml = `<div class="composer-blocked"><svg class="icon"><use href="#i-clock"></use></svg><span>当前有文件正在传输，完成或取消后可以继续发送。</span></div>`;
      }
    }
    if (senderLostFiles) {
      blockedHtml = `
        <div class="composer-blocked">
          <svg class="icon"><use href="#i-alert"></use></svg>
          <span>页面刷新后无法继续读取原始文件。请取消本次传输，再重新选择文件发送。</span>
          <button class="text-btn" type="button" data-action="cancel-offer">结束本次传输</button>
        </div>`;
    }

    const footnote = staged.length
      ? `<div class="composer-note"><svg class="icon"><use href="#i-shield"></use></svg>文件只在这条已确认的连接中传输，不经过互联网。</div>`
      : '';

    els.composerBody.innerHTML = `
      <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="选择要发送的文件">
        <input type="file" id="fileInput" multiple hidden />
        <span class="dropzone-icon"><svg class="icon"><use href="#i-upload"></use></svg></span>
        <strong>拖入文件，或点击选择</strong>
        <p>支持任意类型 · 单个文件最大 ${formatBytes(limits.maxFileSize)}</p>
        <span class="drop-or">${state.server?.limits?.maxFiles || 100} 个文件以内 <span></span> 可一次发送</span>
      </div>
      ${stagedHtml}
      ${blockedHtml}
      ${
        staged.length
          ? `<div class="composer-foot">
              <div class="composer-total"><strong>${formatBytes(total)}</strong><span>${staged.length} 个文件 · 发送给 ${escapeHtml(peerName)}</span></div>
              <button class="btn btn--primary" type="button" data-action="send-files" ${blocked || ui.sendBusy ? 'disabled' : ''}>
                ${
                  ui.sendBusy
                    ? '<span class="spinner"></span> 正在发起'
                    : `<svg class="icon"><use href="#i-send"></use></svg> 发送给 ${escapeHtml(peerName)}`
                }
              </button>
            </div>`
          : `<div class="composer-foot">
              <div class="composer-note"><svg class="icon"><use href="#i-shield"></use></svg>文件只发送给已连接的设备，不经过互联网。</div>
            </div>`
      }
      ${footnote}
    `;
  }

  function renderActivity() {
    const session = state.session;
    if (!session) {
      els.activityBody.innerHTML = '';
      return;
    }
    const offer = session.offer;
    const transfers = session.transfers || [];
    const isReceiver = offer?.toId === state.me?.id;
    const isSender = offer?.fromId === state.me?.id;
    const currentTransfers = offer ? transfers.filter((transfer) => transfer.offerId === offer.id) : [];
    const pastTransfers = offer ? transfers.filter((transfer) => transfer.offerId !== offer.id) : transfers;
    const fragments = [];

    if (ui.uploadError && isSender && (!offer || offer.id === ui.uploadError.offerId)) {
      fragments.push(`
        <div class="inline-alert">
          <span class="inline-alert-icon"><svg class="icon"><use href="#i-alert"></use></svg></span>
          <div>
            <strong>「${escapeHtml(ui.uploadError.fileName)}」发送未完成</strong>
            <p>${escapeHtml(ui.uploadError.message)}</p>
            <button class="text-btn" type="button" data-action="retry-upload">重试发送 <svg class="icon"><use href="#i-refresh"></use></svg></button>
          </div>
        </div>
      `);
    }

    if (offer) {
      if (offer.status === 'pending' && isReceiver) {
        fragments.push(`
          <div class="offer-banner">
            <div class="offer-banner-head">
              <span class="offer-banner-icon"><svg class="icon"><use href="#i-download"></use></svg></span>
              <div>
                <strong>「${escapeHtml(session.peer?.name || '对方')}」发来文件请求</strong>
                <p>${offer.files.length} 个文件 · ${formatBytes(totalOfferSize(offer))} · 等待你确认</p>
              </div>
            </div>
            <div class="offer-actions">
              <button class="btn btn--ghost" type="button" data-action="decline-offer">拒绝</button>
              <button class="btn btn--blue" type="button" data-action="accept-offer">
                <svg class="icon"><use href="#i-check"></use></svg> 接收文件
              </button>
            </div>
          </div>
        `);
      } else if (offer.status === 'pending' && isSender) {
        fragments.push(`
          <div class="offer-pending">
            <span class="spinner"></span>
            <span>等待「${escapeHtml(session.peer?.name || '对方')}」确认接收…</span>
            <button type="button" data-action="cancel-offer">取消</button>
          </div>
        `);
      } else if (offer.status === 'accepted') {
        const readyCount = offer.files.filter((file) => file.state === 'ready').length;
        const active = currentTransfers.some((transfer) => transfer.status === 'uploading');
        const readyToSave = currentTransfers.filter(
          (transfer) => transfer.status === 'ready' && transfer.toId === state.me?.id && !ui.downloaded.has(transfer.id),
        );
        fragments.push(`
          <div class="activity-summary">
            <strong>
              ${active ? '<span class="spinner" style="color:var(--blue)"></span>' : '<svg class="icon"><use href="#i-send"></use></svg>'}
              ${isSender ? '正在向' : '正在从'}「${escapeHtml(session.peer?.name || '对方')}」${isSender ? '发送' : '接收'}文件
            </strong>
            <span>${readyCount}/${offer.files.length} ${isReceiver ? '已到达' : '已完成'}</span>
          </div>
        `);
        if (isReceiver && readyToSave.length) {
          fragments.push(`
            <div class="save-prompt">
              <span><svg class="icon"><use href="#i-download"></use></svg>${readyToSave.length} 个文件等待保存到浏览器下载目录</span>
              <button class="btn btn--soft btn--small" type="button" data-action="download-all">
                <svg class="icon"><use href="#i-download"></use></svg> 保存全部
              </button>
            </div>
          `);
        }
        if (isSender && !ui.uploading) {
          fragments.push(`
            <div class="offer-pending">
              <span class="status-dot" style="box-shadow:none"></span>
              <span>传输即将开始${ui.uploadError ? '，你可以重试中断的文件' : '…'}</span>
              <button type="button" data-action="cancel-offer">结束本次传输</button>
            </div>
          `);
        }
      } else {
        fragments.push(statusBannerForOffer(offer, isReceiver, currentTransfers));
      }

      fragments.push(`
        <div class="activity-recent">
          <div class="activity-recent-head">
            <span>${isReceiver ? '接收文件' : '发送文件'}</span>
            <span>${formatBytes(totalOfferSize(offer))}</span>
          </div>
          <div class="transfer-list">
            ${offer.files
              .map((file) => {
                const transfer = currentTransfers.find((entry) => entry.fileIndex === file.index);
                return transferRow(offer, file, transfer, isReceiver);
              })
              .join('')}
          </div>
        </div>
      `);
    }

    if (pastTransfers.length) {
      const readyPast = pastTransfers.filter((transfer) => transfer.status === 'ready').slice(-6).reverse();
      if (readyPast.length) {
        fragments.push(`
          <div class="activity-recent">
            <div class="activity-recent-head"><span>最近文件</span><span>${pastTransfers.length} 个</span></div>
            ${readyPast
              .map(
                (transfer) => `
                <div class="recent-item">
                  ${fileIcon(transfer.name, transfer.mime)}
                  <div class="recent-info">
                    <strong title="${escapeAttr(transfer.name)}">${escapeHtml(transfer.name)}</strong>
                    <small>${formatBytes(transfer.size)}${
                      transfer.toId === state.me?.id
                        ? ui.downloaded.has(transfer.id)
                          ? ' · 已交给浏览器'
                          : ' · 待保存'
                        : ' · 已送达'
                    }</small>
                  </div>
                  ${
                    transfer.toId === state.me?.id
                      ? `<button class="transfer-action" type="button" data-download-id="${escapeAttr(transfer.id)}" aria-label="${ui.downloaded.has(transfer.id) ? '再次保存' : '保存'} ${escapeAttr(transfer.name)}"><svg class="icon"><use href="#i-download"></use></svg></button>`
                      : '<span class="transfer-check"><svg class="icon"><use href="#i-check"></use></svg></span>'
                  }
                </div>`
              )
              .join('')}
          </div>
        `);
      }
    }

    if (!offer && !pastTransfers.length) {
      fragments.push(`
        <div class="activity-empty">
          <div class="activity-empty-art"><span><svg class="icon"><use href="#i-file"></use></svg></span></div>
          <strong>还没有传输记录</strong>
          <p>选择左边的文件发送，或等对方发起。双方确认后，文件会直接出现在这里。</p>
        </div>
      `);
    }

    const footnote = isReceiver
      ? `<div class="activity-footnote"><svg class="icon"><use href="#i-download"></use></svg>${
          state.autoDownload
            ? '文件到达本机后会自动交给浏览器保存到默认下载目录。若浏览器询问是否允许下载多个文件，请选择允许；没看到文件时使用“保存全部”。'
            : '自动保存已关闭。点击“保存全部”或文件右侧按钮，让浏览器保存到默认下载目录。'
        }</div>`
      : `<div class="activity-footnote"><svg class="icon"><use href="#i-shield"></use></svg>文件只在这条已确认的局域网连接中传输。</div>`;

    els.activityBody.innerHTML = `<div class="activity-scroll">${fragments.join('')}</div>${footnote}`;
  }

  function statusBannerForOffer(offer, isReceiver, currentTransfers = []) {
    let title = '';
    let description = '';
    if (offer.status === 'completed') {
      if (!isReceiver) {
        return `
          <div class="activity-summary">
            <strong><svg class="icon"><use href="#i-check"></use></svg>全部文件已送达</strong>
            <span>${offer.files.length} 个文件 · ${formatBytes(totalOfferSize(offer))}</span>
          </div>`;
      }
      const readyTransfers = currentTransfers.filter(
        (transfer) => transfer.status === 'ready' && transfer.toId === state.me?.id,
      );
      const waitingToSave = readyTransfers.filter((transfer) => !ui.downloaded.has(transfer.id));
      if (waitingToSave.length) {
        return `
          <div class="completion-card is-needs-save">
            <span class="completion-icon"><svg class="icon"><use href="#i-download"></use></svg></span>
            <div class="completion-copy">
              <strong>文件已到达本机，还有 ${waitingToSave.length} 个待保存</strong>
              <p>${state.autoDownload ? '浏览器可能拦截了自动保存。' : '自动保存已关闭。'}点击“保存全部”，把文件交给浏览器下载到默认下载目录。</p>
            </div>
            <button class="btn btn--blue btn--small" type="button" data-action="download-all">
              <svg class="icon"><use href="#i-download"></use></svg> 保存全部
            </button>
          </div>`;
      }
      return `
        <div class="completion-card">
          <span class="completion-icon is-done"><svg class="icon"><use href="#i-check"></use></svg></span>
          <div class="completion-copy">
            <strong>全部文件已交给浏览器保存</strong>
            <p>请查看浏览器默认下载目录。如果没有出现文件，可以使用“再次全部保存”。</p>
          </div>
          <button class="btn btn--ghost btn--small" type="button" data-action="download-all">
            <svg class="icon"><use href="#i-download"></use></svg> 再次全部保存
          </button>
        </div>`;
    }
    if (offer.status === 'declined') {
      title = isReceiver ? '你已拒绝这批文件' : '对方拒绝了这批文件';
      description = isReceiver ? '可以等待对方重新发起。' : '文件仍在你的设备上，没有发送出去。';
    } else if (offer.status === 'cancelled') {
      title = '本次文件传输已取消';
      description = '可以重新选择文件发起新的传输。';
    } else if (offer.status === 'expired') {
      title = '文件请求已过期';
      description = '对方没有在有效期内确认。';
    } else {
      title = '本次文件传输已结束';
      description = '连接状态发生变化，未完成的文件不会继续发送。';
    }
    return `
      <div class="offer-banner is-declined">
        <div class="offer-banner-head">
          <span class="offer-banner-icon" style="background:var(--surface);color:var(--muted);box-shadow:inset 0 0 0 1px var(--line)">
            <svg class="icon"><use href="#i-clock"></use></svg>
          </span>
          <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>
        </div>
      </div>`;
  }

  function transferRow(offer, file, transfer, isReceiver) {
    const ready = file.state === 'ready' || transfer?.status === 'ready';
    const uploading = transfer?.status === 'uploading';
    const handedToBrowser = ready && isReceiver && transfer && ui.downloaded.has(transfer.id);
    const percent = uploading && file.size > 0 ? Math.min(100, Math.round((transfer.bytes / file.size) * 100)) : 0;
    let meta = formatBytes(file.size);
    if (ready) {
      if (isReceiver) meta += ` · ${handedToBrowser ? '已开始保存' : '待保存'}`;
      else meta += ' · 已送达';
    } else if (uploading) meta += ` · ${isReceiver ? '正在接收' : '正在发送'}`;
    else if (offer.status === 'pending') meta += ' · 等待确认';
    else if (offer.status === 'accepted') meta += isReceiver ? ' · 等待发送' : ' · 准备发送';
    else meta += ' · 未传输';

    let action = '';
    if (ready && isReceiver) {
      action = handedToBrowser
        ? `<button class="transfer-again" type="button" data-download-id="${escapeAttr(transfer.id)}" title="再次交给浏览器保存">再次保存</button>`
        : `<button class="transfer-save" type="button" data-download-id="${escapeAttr(transfer.id)}"><svg class="icon"><use href="#i-download"></use></svg> 保存</button>`;
    } else if (ready && !isReceiver) {
      action = '<span class="transfer-check"><svg class="icon"><use href="#i-check"></use></svg></span>';
    } else if (uploading) {
      action = `<span class="progress-percent" style="width:auto">${percent}%</span>`;
    } else {
      action = '<span class="transfer-check" style="background:var(--blue-soft);color:var(--blue)"><svg class="icon"><use href="#i-clock"></use></svg></span>';
    }

    const progress = uploading
      ? `<div class="progress-line">
          <div class="progress-track"><div class="progress-fill" style="--progress:${percent}%"></div></div>
          <span class="progress-percent">${percent}%</span>
        </div>`
      : '';

    return `
      <div class="transfer-item ${ready ? 'is-complete' : ''} ${ui.uploadError?.fileIndex === file.index && offer.fromId === state.me?.id ? 'is-error' : ''}"
           data-transfer-id="${escapeAttr(transfer?.id || '')}"
           data-offer-id="${escapeAttr(offer.id)}"
           data-file-index="${file.index}">
        <div class="transfer-main">
          ${fileIcon(file.name, file.mime)}
          <div class="transfer-info">
            <span class="transfer-name" title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</span>
            <span class="transfer-meta"><span data-progress-bytes>${meta}</span></span>
          </div>
          ${action}
        </div>
        ${progress}
      </div>
    `;
  }

  function maybeShowPendingModals() {
    if (ui.booting) return;
    if (state.session?.offer?.status === 'pending' && state.session.offer.toId === state.me?.id) {
      showOfferModal(state.session.offer);
      return;
    }
    if (!state.session && state.incomingRequest) {
      showConnectionModal(state.incomingRequest);
    }
  }

  function updateDocumentTitle() {
    if (state.session?.peer) {
      document.title = `与 ${state.session.peer.name} 连接中 · 邻传 NearDrop`;
    } else {
      document.title = '邻传 NearDrop · 局域网文件互传';
    }
  }

  function maybeAutoDownload(transfer, offerId) {
    if (!state.autoDownload) return;
    if (transfer.toId !== state.me?.id) return;
    if (ui.downloaded.has(transfer.id)) return;
    if (ui.autoDownloadQueue.some((item) => item.transfer.id === transfer.id)) return;
    ui.autoDownloadQueue.push({ transfer, offerId });
    runAutoDownloadQueue();
  }

  async function runAutoDownloadQueue() {
    if (ui.autoDownloadRunning) return;
    ui.autoDownloadRunning = true;
    try {
      while (ui.autoDownloadQueue.length) {
        const item = ui.autoDownloadQueue.shift();
        if (!state.session || !state.autoDownload) continue;
        if (item.transfer.toId !== state.me?.id || ui.downloaded.has(item.transfer.id)) continue;
        downloadTransfer(item.transfer, { auto: true });
        renderActivity();
        if (ui.autoDownloadQueue.length) await delay(450);
      }
    } finally {
      ui.autoDownloadRunning = false;
    }
  }

  function downloadAllReady() {
    const session = state.session;
    const offer = session?.offer;
    if (!offer) return;
    const ready = (session.transfers || []).filter(
      (transfer) => transfer.offerId === offer.id && transfer.status === 'ready' && transfer.toId === state.me?.id,
    );
    if (!ready.length) {
      toast('还没有可保存的文件。', 'info');
      return;
    }
    ready.forEach((transfer, index) => {
      ui.downloaded.add(transfer.id);
      if (index === 0) downloadTransfer(transfer, { auto: true });
      else setTimeout(() => downloadTransfer(transfer, { auto: true }), index * 450);
    });
    renderActivity();
    toast(`已开始把 ${ready.length} 个文件交给浏览器保存，请查看默认下载目录。`, 'info', '正在保存');
  }

  function downloadTransfer(transfer, { auto = false } = {}) {
    if (!transfer?.downloadUrl || transfer.toId !== state.me?.id) return;
    const anchor = document.createElement('a');
    anchor.href = transfer.downloadUrl;
    anchor.download = transfer.name;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    ui.downloaded.add(transfer.id);
    if (!auto) {
      toast(`「${transfer.name}」已交给浏览器，正在保存到默认下载目录。`, 'success', '正在保存');
      renderActivity();
    }
  }

  function maybeAnnounceCompletion(offer) {
    if (!offer) return;
    if (offer.status !== 'completed') return;
    if (ui.lastCompletionToastId === offer.id) return;
    ui.lastCompletionToastId = offer.id;
    const receiver = offer.toId === state.me?.id;
    if (receiver) {
      if (state.autoDownload) {
        toast(
          `${offer.files.length} 个文件已到达本机，正在自动交给浏览器保存。请查看默认下载目录，若未出现可使用“保存全部”。`,
          'success',
          '传输完成',
        );
      } else {
        toast(`${offer.files.length} 个文件已到达本机，请点击“保存全部”保存到下载目录。`, 'info', '传输完成');
      }
      return;
    }
    toast(`${offer.files.length} 个文件已送达「${state.session?.peer?.name || '对方'}」。`, 'success', '发送完成');
  }

  /* ---------------------------------------------------------------------- */
  /* File selection and upload                                              */
  /* ---------------------------------------------------------------------- */

  function addFiles(fileList) {
    if (!state.session) return;
    const limits = state.server?.limits || { maxFiles: 100, maxFileSize: 10 * 1024 ** 3, maxBatchSize: 20 * 1024 ** 3 };
    const incoming = [...fileList];
    if (!incoming.length) return;
    const existingKeys = new Set(ui.staged.map(fileKey));
    let added = 0;
    let duplicate = 0;
    let rejectedSize = 0;
    for (const file of incoming) {
      if (ui.staged.length >= limits.maxFiles) {
        toast(`一次最多选择 ${limits.maxFiles} 个文件。`, 'info');
        break;
      }
      const key = fileKey(file);
      if (existingKeys.has(key)) {
        duplicate += 1;
        continue;
      }
      if (file.size > limits.maxFileSize) {
        rejectedSize += 1;
        continue;
      }
      const total = ui.staged.reduce((sum, entry) => sum + entry.size, 0);
      if (total + file.size > limits.maxBatchSize) {
        toast('这批文件总大小超出限制，请分批发发送。', 'error', '文件过多');
        break;
      }
      ui.staged.push(file);
      existingKeys.add(key);
      added += 1;
    }
    if (rejectedSize) toast(`${rejectedSize} 个文件超过单文件大小限制。`, 'error', '无法加入');
    if (!added && duplicate) toast('这些文件已经在待发送列表里。', 'info');
    if (added) renderComposer();
  }

  function fileKey(file) {
    return `${file.name}::${file.size}::${file.lastModified || 0}`;
  }

  async function sendStagedFiles() {
    if (ui.sendBusy || !state.session || !ui.staged.length) return;
    if (openOffer()) {
      toast('当前还有一批文件在处理中，请稍后。', 'info');
      return;
    }
    const files = ui.staged.slice();
    ui.sendBusy = true;
    renderComposer();
    try {
      const payload = {
        files: files.map((file) => ({
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
        })),
      };
      const data = await api(`/api/sessions/${state.session.id}/offers`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (data.session) applySession(data.session);
      if (data.offer) {
        if (!state.session) throw new Error('连接已断开。');
        state.session.offer = data.offer;
        ui.activeOfferId = data.offer.id;
        ui.activeFiles = new Map(files.map((file, index) => [index, file]));
      }
      ui.staged = [];
      ui.uploadError = null;
      renderAll();
      toast('文件请求已发出，等待对方确认。', 'info', '等待接收');
    } catch (error) {
      if (error.status === 401) {
        toast('连接状态已失效，正在尝试重新加入。', 'error');
        startRecoveryCheck();
      } else {
        toast(error.message || '无法发送文件请求。', 'error', '发送失败');
      }
    } finally {
      ui.sendBusy = false;
      renderComposer();
    }
  }

  function maybeResumeUploads() {
    if (!state.session || !state.me) return;
    const offer = state.session.offer;
    if (!offer || offer.fromId !== state.me.id || offer.status !== 'accepted') return;
    const hasAnyFile = offer.files.some((file) => file.state !== 'ready' && ui.activeFiles.has(file.index));
    if (hasAnyFile && !ui.uploading) beginUploads();
  }

  async function beginUploads() {
    if (ui.uploading || !state.session || !state.me) return;
    const session = state.session;
    const offer = session.offer;
    if (!offer || offer.fromId !== state.me.id || offer.status !== 'accepted') return;
    const pending = offer.files.filter((file) => file.state !== 'ready');
    if (!pending.length) return;
    if (!pending.some((file) => ui.activeFiles.has(file.index))) {
      ui.uploadError = {
        offerId: offer.id,
        fileIndex: pending[0].index,
        fileName: pending[0].name,
        message: '页面刷新后原始文件已不可用，请取消本次传输后重新选择文件。',
      };
      renderComposer();
      renderActivity();
      return;
    }

    ui.uploading = true;
    ui.uploadError = null;
    renderComposer();
    renderActivity();
    let failed = false;
    try {
      for (const meta of pending) {
        if (!state.session || state.session.id !== session.id) throw abortError();
        const currentOffer = state.session.offer;
        if (!currentOffer || currentOffer.id !== offer.id || currentOffer.status !== 'accepted') throw abortError();
        const currentFile = currentOffer.files.find((file) => file.index === meta.index);
        if (currentFile?.state === 'ready') continue;
        const file = ui.activeFiles.get(meta.index);
        if (!file) throw new Error('页面刷新后原始文件已不可用。');
        const result = await uploadFileWithRetry(session.id, offer.id, meta, file);
        if (result?.offer && state.session?.offer?.id === result.offer.id) {
          state.session.offer = result.offer;
        }
        if (result?.transfer) upsertTransfer(result.transfer);
        if (
          ui.uploadError &&
          ui.uploadError.offerId === offer.id &&
          ui.uploadError.fileIndex === meta.index
        ) {
          ui.uploadError = null;
        }
        renderComposer();
        renderActivity();
      }
    } catch (error) {
      failed = true;
      if (error.status === 401) startRecoveryCheck();
      if (!error.aborted) {
        const failedMeta = pending.find((file) => !state.session?.transfers?.some((transfer) => transfer.offerId === offer.id && transfer.fileIndex === file.index && transfer.status === 'ready'));
        const alreadyReported = ui.uploadError?.offerId === offer.id && ui.uploadError.fileIndex === failedMeta?.index;
        if (state.session?.offer?.id === offer.id && failedMeta) {
          markOfferFileState(offer.id, failedMeta.index, 'pending');
          if (state.session.transfers) {
            state.session.transfers = state.session.transfers.filter(
              (transfer) => !(transfer.offerId === offer.id && transfer.fileIndex === failedMeta.index && transfer.status !== 'ready'),
            );
          }
        }
        ui.uploadError = {
          offerId: offer.id,
          fileIndex: failedMeta?.index ?? pending[0].index,
          fileName: failedMeta?.name || pending[0].name,
          message: error.message || '文件发送中断，请重试。',
        };
        if (!alreadyReported) toast(error.message || '文件发送中断，请重试。', 'error', '发送中断');
      }
    } finally {
      ui.uploading = false;
      if (!failed && state.session?.offer?.status === 'completed') {
        ui.activeFiles.clear();
        ui.uploadError = null;
      }
      if (state.session?.offer?.status === 'completed') maybeAnnounceCompletion(state.session.offer);
      renderComposer();
      renderActivity();
    }
  }

  async function uploadFileWithRetry(sessionId, offerId, meta, file) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await uploadFileOnce(sessionId, offerId, meta, file);
      } catch (error) {
        lastError = error;
        if (error.aborted || error.status === 401 || (error.status >= 400 && error.status < 500)) throw error;
        if (attempt === 0) await delay(700);
      }
    }
    throw lastError || new Error('文件发送失败。');
  }

  function uploadFileOnce(sessionId, offerId, meta, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      ui.activeXHR = xhr;
      let lastProgressPaint = 0;
      xhr.open('PUT', `/api/sessions/${sessionId}/offers/${offerId}/files/${meta.index}`, true);
      xhr.setRequestHeader('x-client-token', state.token || '');
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        const tick = performance.now();
        if (tick - lastProgressPaint < 90 && event.loaded !== meta.size) return;
        lastProgressPaint = tick;
        updateOptimisticProgress(offerId, meta.index, event.loaded, meta.size);
      });
      xhr.addEventListener('load', () => {
        ui.activeXHR = null;
        let body = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          body = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body);
          return;
        }
        const error = new Error(body?.error?.message || `文件发送失败（${xhr.status}）`);
        error.status = xhr.status;
        error.code = body?.error?.code || 'UPLOAD_FAILED';
        reject(error);
      });
      xhr.addEventListener('error', () => {
        ui.activeXHR = null;
        const error = new Error('网络连接中断，文件未发送完成。');
        error.network = true;
        reject(error);
      });
      xhr.addEventListener('abort', () => {
        ui.activeXHR = null;
        reject(abortError());
      });
      xhr.send(file);
    });
  }

  function abortError() {
    const error = new Error('传输已取消。');
    error.aborted = true;
    return error;
  }

  function restoreActiveFiles(offer) {
    const restored = [];
    for (const file of offer.files) {
      const local = ui.activeFiles.get(file.index);
      if (local) restored.push(local);
    }
    if (restored.length) {
      const keys = new Set(ui.staged.map(fileKey));
      for (const file of restored) {
        if (!keys.has(fileKey(file))) {
          ui.staged.push(file);
          keys.add(fileKey(file));
        }
      }
    }
    ui.activeFiles.clear();
    ui.activeOfferId = null;
    renderComposer();
  }

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                */
  /* ---------------------------------------------------------------------- */

  async function connectToPeer(peerId) {
    if (ui.connectBusy || state.session) return;
    const peer = state.peers.find((entry) => entry.id === peerId);
    if (!peer) return;
    if (state.incomingRequest) {
      showConnectionModal(state.incomingRequest);
      return;
    }
    ui.connectBusy = true;
    ui.connectingPeerId = peerId;
    renderPeers();
    try {
      const data = await api('/api/connections', {
        method: 'POST',
        body: JSON.stringify({ toId: peerId }),
      });
      applyServerState(data);
      renderAll();
      toast(`请求已发送给「${peer.name}」，等待对方确认。`, 'info', '等待握手', 'connection');
    } catch (error) {
      toast(error.message || '连接请求发送失败。', 'error', '无法连接');
      if (error.status === 401) startRecoveryCheck();
    } finally {
      ui.connectBusy = false;
      ui.connectingPeerId = null;
      renderPeers();
    }
  }

  async function cancelOutgoingRequest() {
    const request = state.outgoingRequest;
    if (!request) return;
    try {
      const data = await api(`/api/connections/${request.id}/cancel`, { method: 'POST' });
      applyServerState(data);
      renderAll();
      toast('已取消连接请求。', 'info');
    } catch (error) {
      toast(error.message || '无法取消请求。', 'error');
    }
  }

  async function acceptConnectionRequest() {
    const request = state.incomingRequest;
    if (!request || ui.modalBusy) return;
    ui.modalBusy = true;
    setModalActionsDisabled(true, '正在连接');
    try {
      const data = await api(`/api/connections/${request.id}/accept`, { method: 'POST' });
      applyServerState(data);
      closeModal(`connection:${request.id}`);
      renderAll();
    } catch (error) {
      setModalActionsDisabled(false);
      toast(error.message || '无法接受连接。', 'error', '握手失败');
      if (error.status === 401) startRecoveryCheck();
    } finally {
      ui.modalBusy = false;
    }
  }

  async function declineConnectionRequest() {
    const request = state.incomingRequest;
    if (!request || ui.modalBusy) return;
    ui.modalBusy = true;
    setModalActionsDisabled(true, '正在拒绝');
    try {
      const data = await api(`/api/connections/${request.id}/decline`, { method: 'POST' });
      applyServerState(data);
      closeModal(`connection:${request.id}`);
      renderAll();
      toast('已拒绝这次连接请求。', 'info');
    } catch (error) {
      setModalActionsDisabled(false);
      toast(error.message || '无法拒绝连接。', 'error');
    } finally {
      ui.modalBusy = false;
    }
  }

  async function acceptOffer({ fromModal = false } = {}) {
    const offer = state.session?.offer;
    if (!offer || offer.status !== 'pending' || ui.modalBusy) return;
    if (fromModal) {
      const checkbox = $('#offerAutoDownload');
      if (checkbox) saveAutoDownload(checkbox.checked);
    }
    ui.modalBusy = true;
    setModalActionsDisabled(true, '正在接收');
    setActivityButtonsDisabled(true);
    try {
      const data = await api(`/api/offers/${offer.id}/accept`, { method: 'POST' });
      if (data.session) applySession(data.session);
      closeModal(`offer:${offer.id}`);
      renderAll();
      toast('已确认接收，等待对方开始发送文件。', 'info', '已准备接收');
    } catch (error) {
      setModalActionsDisabled(false);
      toast(error.message || '无法接收文件。', 'error');
    } finally {
      ui.modalBusy = false;
      setActivityButtonsDisabled(false);
    }
  }

  async function declineOffer({ fromModal = false } = {}) {
    const offer = state.session?.offer;
    if (!offer || offer.status !== 'pending' || ui.modalBusy) return;
    ui.modalBusy = true;
    setModalActionsDisabled(true, '正在拒绝');
    setActivityButtonsDisabled(true);
    try {
      const data = await api(`/api/offers/${offer.id}/decline`, { method: 'POST' });
      if (data.session) applySession(data.session);
      closeModal(`offer:${offer.id}`);
      renderAll();
      toast('已拒绝这批文件。', 'info');
    } catch (error) {
      setModalActionsDisabled(false);
      toast(error.message || '无法拒绝文件请求。', 'error');
    } finally {
      ui.modalBusy = false;
      setActivityButtonsDisabled(false);
    }
  }

  async function cancelOffer() {
    const offer = state.session?.offer;
    if (!offer || ui.modalBusy) return;
    ui.modalBusy = true;
    try {
      const data = await api(`/api/offers/${offer.id}/cancel`, { method: 'POST' });
      if (data.session) applySession(data.session);
      closeModal(`offer:${offer.id}`);
      ui.activeFiles.clear();
      ui.activeOfferId = null;
      ui.uploadError = null;
      renderAll();
      toast('已取消本次文件传输。', 'info');
    } catch (error) {
      toast(error.message || '无法取消传输。', 'error');
    } finally {
      ui.modalBusy = false;
    }
  }

  function retryUploads() {
    if (!state.session || !state.me) return;
    ui.uploadError = null;
    renderComposer();
    renderActivity();
    beginUploads();
  }

  async function disconnectSession() {
    const session = state.session;
    if (!session || ui.modalBusy) return;
    ui.modalBusy = true;
    setModalActionsDisabled(true, '正在断开');
    try {
      await api(`/api/sessions/${session.id}/close`, { method: 'POST' });
      closeModal('disconnect');
      renderAll();
    } catch (error) {
      setModalActionsDisabled(false);
      toast(error.message || '无法断开连接。', 'error');
    } finally {
      ui.modalBusy = false;
    }
  }

  async function saveProfile(name) {
    if (ui.modalBusy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast('昵称不能为空。', 'error');
      return;
    }
    ui.modalBusy = true;
    const submit = $('#profileSubmit');
    if (submit) {
      submit.disabled = true;
      submit.textContent = '保存中…';
    }
    try {
      const data = await api('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ name: trimmed }),
      });
      if (data.client) state.me = data.client;
      try {
        localStorage.setItem(NAME_KEY, trimmed);
      } catch {
        /* noop */
      }
      closeModal('profile');
      renderProfile();
      renderPeers();
      toast('昵称已更新，其他设备会看到新名字。', 'success', '已保存');
    } catch (error) {
      toast(error.message || '昵称保存失败。', 'error');
      if (submit) {
        submit.disabled = false;
        submit.textContent = '保存昵称';
      }
    } finally {
      ui.modalBusy = false;
    }
  }

  async function refreshPeers() {
    if (els.refreshBtn.classList.contains('is-spinning')) return;
    els.refreshBtn.classList.add('is-spinning');
    try {
      if (!state.me) {
        await registerClient({ initial: false });
        return;
      }
      const data = await api('/api/state', { cache: 'no-store' });
      applyServerState(data);
      renderAll();
      toast(`已刷新，当前有 ${state.peers.length} 台设备在线。`, 'info', '设备列表');
    } catch (error) {
      toast(error.message || '刷新失败。', 'error');
      if (error.status === 401) startRecoveryCheck();
    } finally {
      setTimeout(() => els.refreshBtn.classList.remove('is-spinning'), 450);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Modals                                                                 */
  /* ---------------------------------------------------------------------- */

  function showConnectionModal(request) {
    if (!request) return;
    const from = request.from || {};
    const key = `connection:${request.id}`;
    if (ui.modal?.key === key) return;
    showModal({
      key,
      dismissible: false,
      content: `
        <div class="modal-kicker"><svg class="icon"><use href="#i-link"></use></svg> CONNECTION REQUEST</div>
        <h2>「${escapeHtml(from.name || '附近设备')}」想和你建立连接</h2>
        <p class="modal-lead">接受后，你们就能在这条局域网通道里互相发送文件。需要两边都确认，通道才会建立。</p>
        <div class="modal-pair">
          <span class="avatar avatar--lg" style="--avatar-color:${escapeAttr(from.color || '#3355e8')}">${escapeHtml(initials(from.name || '?'))}</span>
          <span class="modal-pair-link"><span></span><span class="link-badge"><svg class="icon"><use href="#i-link"></use></svg></span><span></span></span>
          <span class="avatar avatar--lg" style="--avatar-color:${escapeAttr(state.me?.color || '#2c2e3d')}">${escapeHtml(initials(state.me?.name || '?'))}</span>
        </div>
        <div class="modal-requester">
          <strong>${escapeHtml(from.name || '附近设备')}</strong>
          <p>${escapeHtml(from.device || '局域网设备')} · 请求连接</p>
        </div>
        <div class="modal-actions">
          <button class="btn btn--ghost" type="button" data-action="decline-connection">拒绝</button>
          <button class="btn btn--primary" type="button" data-action="accept-connection">接受连接 <svg class="icon"><use href="#i-arrow"></use></svg></button>
        </div>
        <div class="modal-note"><svg class="icon"><use href="#i-info"></use></svg>连接请求会在一分半后自动失效；拒绝后不会建立通道。</div>
      `,
    });
  }

  function showOfferModal(offer) {
    if (!offer) return;
    const session = state.session;
    if (!session) return;
    const key = `offer:${offer.id}`;
    if (ui.modal?.key === key) return;
    const fromName = session.peer?.name || '对方';
    const files = offer.files || [];
    const shown = files.slice(0, 7);
    showModal({
      key,
      wide: true,
      dismissible: false,
      content: `
        <div class="modal-kicker"><svg class="icon"><use href="#i-download"></use></svg> INCOMING FILES</div>
        <h2>「${escapeHtml(fromName)}」想发送 ${files.length} 个文件</h2>
        <p class="modal-lead">接收后，文件会在传输完成时自动交给浏览器保存到下载目录；你也可以在传输动态里再次保存。</p>
        <span class="offer-count-badge"><svg class="icon"><use href="#i-file"></use></svg>${files.length} 个文件 · ${formatBytes(totalOfferSize(offer))}</span>
        <div class="modal-file-list">
          ${shown
            .map(
              (file) => `
              <div class="modal-file">
                ${fileIcon(file.name, file.mime)}
                <div class="modal-file-info"><strong title="${escapeAttr(file.name)}">${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></div>
              </div>`
            )
            .join('')}
          ${files.length > shown.length ? `<div class="modal-more">还有 ${files.length - shown.length} 个文件…</div>` : ''}
        </div>
        <label class="auto-download-choice">
          <input type="checkbox" id="offerAutoDownload" ${state.autoDownload ? 'checked' : ''} />
          <span><strong>接收后自动保存</strong><small>通过浏览器下载到默认下载目录。若浏览器询问是否允许下载多个文件，请选择允许；也可以在列表里点击“保存全部”。</small></span>
        </label>
        <div class="modal-actions">
          <button class="btn btn--ghost" type="button" data-action="decline-offer-modal">拒绝</button>
          <button class="btn btn--blue" type="button" data-action="accept-offer-modal">接收文件 <svg class="icon"><use href="#i-arrow"></use></svg></button>
        </div>
        <div class="modal-note"><svg class="icon"><use href="#i-shield"></use></svg>文件只通过这台局域网服务器中转，不会上传到互联网。对方需要保持页面打开，直到传输完成。</div>
      `,
    });
  }

  function showProfileModal() {
    if (!state.me) {
      toast('尚未连接到本地服务。', 'error');
      return;
    }
    showModal({
      key: 'profile',
      dismissible: true,
      content: `
        <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭"><svg class="icon"><use href="#i-close"></use></svg></button>
        <div class="modal-kicker"><svg class="icon"><use href="#i-edit"></use></svg> YOUR DEVICE</div>
        <h2>给这台设备一个昵称</h2>
        <p class="modal-lead">同一 Wi-Fi 下的其他设备会看到这个名字，方便对方认出你。</p>
        <form data-form="profile">
          <label class="field-label" for="profileNameInput">设备昵称</label>
          <input class="text-input" id="profileNameInput" name="name" type="text" maxlength="24" value="${escapeAttr(state.me.name)}" autocomplete="off" data-autofocus />
          <p class="input-hint">最多 24 个字符，可随时修改。</p>
          <div class="profile-device-line"><svg class="icon"><use href="#i-${state.me.kind === 'phone' || state.me.kind === 'tablet' ? 'phone' : 'monitor'}"></use></svg>${escapeHtml(state.me.device || '本机')}</div>
          <div class="modal-actions">
            <button class="btn btn--ghost" type="button" data-action="close-modal">取消</button>
            <button class="btn btn--primary" id="profileSubmit" type="submit">保存昵称</button>
          </div>
        </form>
      `,
    });
  }

  function showInviteModal() {
    const invite = inviteTarget();
    const alternatives = (state.server?.urls || []).map((entry) => entry.url).filter((url) => url !== invite.url);
    showModal({
      key: 'invite',
      dismissible: true,
      content: `
        <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭"><svg class="icon"><use href="#i-close"></use></svg></button>
        <div class="modal-kicker"><svg class="icon"><use href="#i-lan"></use></svg> JOIN THE DROP</div>
        <h2>让另一台设备加入</h2>
        <p class="modal-lead">不需要安装 App。让另一台设备连接同一个 Wi-Fi，打开下面的地址就好。</p>
        <div class="invite-hero">
          <span class="invite-hero-icon"><svg class="icon"><use href="#i-wifi"></use></svg></span>
          <div><strong>同一 Wi-Fi · 直接打开</strong><p>页面会自动发现彼此，然后由你选择要连接哪台设备。</p></div>
        </div>
        <div class="url-box">
          <span class="url-value" title="${escapeAttr(invite.url)}">${escapeHtml(invite.url)}</span>
          <button class="copy-btn" type="button" data-action="copy-url">复制</button>
        </div>
        ${alternatives.length ? `<p class="url-extra">其他可用地址：${alternatives.map(escapeHtml).join(' · ')}</p>` : ''}
        <div class="invite-steps">
          <div class="invite-step"><span class="invite-step-num">1</span><span>确认两台设备连接的是<strong>同一个 Wi-Fi</strong>，不是访客网络或手机热点。</span></div>
          <div class="invite-step"><span class="invite-step-num">2</span><span>在另一台设备的浏览器中打开上面的地址。</span></div>
          <div class="invite-step"><span class="invite-step-num">3</span><span>两边都会出现在设备列表中，选中对方，等双方都确认后即可互传。</span></div>
        </div>
        <div class="invite-warning"><svg class="icon"><use href="#i-alert"></use></svg><span>如果另一台设备打不开页面，请允许 Node.js 通过 Windows 专用网络防火墙，或确认路由器没有开启 AP 隔离。</span></div>
        <div class="modal-note"><svg class="icon"><use href="#i-download"></use></svg>接收后文件会由浏览器下载到默认目录，具体位置由浏览器设置决定；网页本身不能直接写入任意文件夹。</div>
      `,
    });
  }

  function inviteTarget() {
    const urls = state.server?.urls || [];
    const hostname = location.hostname;
    const exact = urls.find((entry) => entry.address === hostname);
    if (exact) return { url: exact.url };
    if (hostname && hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      return { url: location.origin };
    }
    return { url: urls[0]?.url || location.origin };
  }

  function showDisconnectModal() {
    if (!state.session) return;
    const peerName = state.session.peer?.name || '对方';
    showModal({
      key: 'disconnect',
      dismissible: true,
      content: `
        <button class="modal-close" type="button" data-action="close-modal" aria-label="关闭"><svg class="icon"><use href="#i-close"></use></svg></button>
        <div class="confirm-icon"><svg class="icon"><use href="#i-link-off"></use></svg></div>
        <h2>断开与「${escapeHtml(peerName)}」的连接？</h2>
        <p class="modal-lead">断开后可以重新发起连接。已经完成的下载仍会留在浏览器的下载目录中；未完成的传输会停止。</p>
        <div class="modal-actions">
          <button class="btn btn--ghost" type="button" data-action="close-modal">继续连接</button>
          <button class="btn btn--danger" type="button" data-action="disconnect-session">断开连接</button>
        </div>
      `,
    });
  }

  function showModal({ key, content, dismissible = false, wide = false }) {
    const previousKey = ui.modal?.key;
    if (previousKey === key) return;
    if (!ui.modal) ui.previousFocus = document.activeElement;
    ui.modal = { key, dismissible };
    els.modalRoot.innerHTML = `
      <div class="modal-backdrop" data-modal-key="${escapeAttr(key)}">
        <div class="modal ${wide ? 'modal--wide' : ''}" role="dialog" aria-modal="true" tabindex="-1">${content}</div>
      </div>
    `;
    document.body.classList.add('modal-open');
    const dialog = $('.modal', els.modalRoot);
    const autofocus = $('[data-autofocus]', dialog) || dialog;
    requestAnimationFrame(() => {
      try {
        autofocus.focus({ preventScroll: true });
      } catch {
        /* noop */
      }
    });
  }

  function closeModal(key = null) {
    if (!ui.modal) return;
    if (key && ui.modal.key !== key) return;
    const wasKey = ui.modal.key;
    ui.modal = null;
    els.modalRoot.innerHTML = '';
    document.body.classList.remove('modal-open');
    const focusTarget = ui.previousFocus;
    ui.previousFocus = null;
    if (focusTarget && typeof focusTarget.focus === 'function' && document.contains(focusTarget)) {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch {
        /* noop */
      }
    }
    if (wasKey?.startsWith('offer:')) {
      // The offer remains visible in the activity panel if the user dismissed a passive modal.
      renderActivity();
    }
  }

  function closeAllTransientModals() {
    if (!ui.modal) return;
    if (ui.modal.key.startsWith('connection:') || ui.modal.key.startsWith('offer:') || ui.modal.key === 'disconnect') {
      closeModal();
    }
  }

  function setModalActionsDisabled(disabled, busyLabel = '') {
    for (const button of $$('.modal-actions .btn', els.modalRoot)) {
      if (button.dataset.action === 'close-modal') continue;
      button.disabled = disabled;
      if (disabled && /accept|receive|接收|接受/.test(button.textContent)) {
        button.dataset.originalLabel = button.innerHTML;
        button.innerHTML = `<span class="spinner"></span>${busyLabel ? ` ${escapeHtml(busyLabel)}` : ''}`;
      } else if (!disabled && button.dataset.originalLabel) {
        button.innerHTML = button.dataset.originalLabel;
        delete button.dataset.originalLabel;
      }
    }
  }

  function setActivityButtonsDisabled(disabled) {
    for (const button of $$('[data-action="accept-offer"], [data-action="decline-offer"]', els.activityBody)) {
      button.disabled = disabled;
    }
  }

  function trapModalFocus(event) {
    if (!ui.modal || event.key !== 'Tab') return;
    const dialog = $('.modal', els.modalRoot);
    if (!dialog) return;
    const focusables = $$(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      dialog,
    ).filter((el) => el.offsetParent !== null);
    if (!focusables.length) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Toasts & helpers                                                       */
  /* ---------------------------------------------------------------------- */

  function toast(message, type = 'info', title = '', group = '') {
    const icons = { success: 'check', error: 'alert', info: 'info' };
    const node = document.createElement('div');
    node.className = `toast is-${type}`;
    if (group) node.dataset.toastGroup = group;
    node.innerHTML = `
      <span class="toast-icon"><svg class="icon"><use href="#i-${icons[type] || 'info'}"></use></svg></span>
      <div class="toast-content">${title ? `<strong>${escapeHtml(title)}</strong>` : ''}<span>${escapeHtml(message)}</span></div>
      <button class="toast-close" type="button" aria-label="关闭提示"><svg class="icon"><use href="#i-close"></use></svg></button>
    `;
    const remove = () => {
      if (!node.isConnected) return;
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 230);
    };
    $('.toast-close', node).addEventListener('click', remove);
    els.toastRoot.appendChild(node);
    while (els.toastRoot.children.length > 4) {
      els.toastRoot.firstElementChild?.remove();
    }
    setTimeout(remove, type === 'error' ? 6500 : 4200);
  }

  function dismissToastGroup(group) {
    for (const node of $$(`.toast[data-toast-group="${cssEscape(group)}"]`, els.toastRoot)) {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 230);
    }
  }

  function setNetwork(status) {
    ui.network = status;
    els.netStatus.classList.toggle('is-reconnecting', status === 'reconnecting');
    els.netStatus.classList.toggle('is-offline', status === 'offline');
    const labels = {
      online: '局域网在线',
      connecting: '正在连接局域网…',
      reconnecting: '正在重新连接…',
      offline: '连接已断开',
    };
    const label = labels[status] || '局域网状态';
    els.netLabel.textContent = label;
    els.netStatus.setAttribute('aria-label', label);
  }

  function setAvatar(element, text, color) {
    if (!element) return;
    element.textContent = text;
    element.style.setProperty('--avatar-color', color || '#3355e8');
  }

  function initials(name) {
    if (!name) return '?';
    return Array.from(String(name).trim())[0] || '?';
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const amount = value / 1024 ** exponent;
    return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
  }

  function totalOfferSize(offer) {
    if (!offer?.files) return 0;
    return offer.files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  }

  function fileIcon(name, mime) {
    const info = fileKind(name, mime);
    return `<span class="file-icon ${info.className}"><svg class="icon"><use href="#i-${info.icon}"></use></svg></span>`;
  }

  function fileKind(name = '', mime = '') {
    const ext = String(name).split('.').pop().toLowerCase();
    const type = String(mime).toLowerCase();
    if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp', 'avif'].includes(ext)) {
      return { className: 'is-image', icon: 'image' };
    }
    if (type.startsWith('video/') || ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'].includes(ext)) {
      return { className: 'is-video', icon: 'video' };
    }
    if (type.startsWith('audio/') || ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'].includes(ext)) {
      return { className: 'is-audio', icon: 'music' };
    }
    if (ext === 'pdf') return { className: 'is-pdf', icon: 'pdf' };
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return { className: 'is-archive', icon: 'archive' };
    if (['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'json', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'sh', 'md'].includes(ext)) {
      return { className: 'is-code', icon: 'code' };
    }
    return { className: '', icon: 'file' };
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* Clipboard API needs a secure context; the LAN page is plain HTTP. */
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand('copy');
      textarea.remove();
      return success;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Event wiring                                                           */
  /* ---------------------------------------------------------------------- */

  function bindStaticEvents() {
    els.profileBtn.addEventListener('click', () => {
      if (!state.me) {
        toast('还没有连接到本地服务，请稍候再试。', 'info');
        return;
      }
      showProfileModal();
    });

    els.inviteBtn.addEventListener('click', showInviteModal);
    els.emptyInviteBtn.addEventListener('click', showInviteModal);
    els.helpBtn.addEventListener('click', showInviteModal);
    els.footerHelpBtn.addEventListener('click', showInviteModal);
    els.refreshBtn.addEventListener('click', refreshPeers);
    els.disconnectBtn.addEventListener('click', showDisconnectModal);

    els.pendingSpot.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="cancel-request"]')) cancelOutgoingRequest();
    });

    els.peerList.addEventListener('click', (event) => {
      if (event.target.closest('[data-action="open-invite"]')) {
        showInviteModal();
        return;
      }
      if (event.target.closest('[data-action="retry-join"]')) {
        registerClient({ initial: false });
        return;
      }
      const card = event.target.closest('.peer-card');
      if (!card || card.disabled) return;
      connectToPeer(card.dataset.peerId);
    });

    els.autoDownload.addEventListener('change', () => {
      saveAutoDownload(els.autoDownload.checked);
      renderActivity();
      toast(
        state.autoDownload ? '之后传输完成的文件会自动交给浏览器保存到下载目录。' : '自动保存已关闭，可在文件列表中手动保存。',
        'info',
        state.autoDownload ? '自动保存已开启' : '自动保存已关闭',
      );
    });

    els.composerBody.addEventListener('click', (event) => {
      if (event.target.id === 'fileInput') return;
      const actionEl = event.target.closest('[data-action]');
      if (actionEl) {
        const action = actionEl.dataset.action;
        if (action === 'send-files') sendStagedFiles();
        else if (action === 'clear-staged') {
          ui.staged = [];
          renderComposer();
        } else if (action === 'remove-staged') {
          const index = Number(actionEl.dataset.index);
          if (Number.isInteger(index)) {
            ui.staged.splice(index, 1);
            renderComposer();
          }
        } else if (action === 'retry-upload') retryUploads();
        else if (action === 'cancel-offer') cancelOffer();
        else if (action === 'open-help') showInviteModal();
        return;
      }
      const dropzone = event.target.closest('#dropzone');
      if (dropzone) {
        const input = $('#fileInput', els.composerBody);
        if (input) input.click();
      }
    });

    els.composerBody.addEventListener('keydown', (event) => {
      if (!event.target.closest('#dropzone')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const input = $('#fileInput', els.composerBody);
        if (input) input.click();
      }
    });

    els.composerBody.addEventListener('change', (event) => {
      if (event.target.id === 'fileInput') {
        addFiles(event.target.files || []);
        event.target.value = '';
      }
    });

    els.composerBody.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      els.composerBody.querySelector('#dropzone')?.classList.add('is-dragging');
    });
    els.composerBody.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      els.composerBody.querySelector('#dropzone')?.classList.add('is-dragging');
    });
    els.composerBody.addEventListener('dragleave', (event) => {
      if (els.composerBody.contains(event.relatedTarget)) return;
      els.composerBody.querySelector('#dropzone')?.classList.remove('is-dragging');
    });
    els.composerBody.addEventListener('drop', (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      els.composerBody.querySelector('#dropzone')?.classList.remove('is-dragging');
      addFiles(event.dataTransfer.files);
    });

    els.activityBody.addEventListener('click', (event) => {
      const download = event.target.closest('[data-download-id]');
      if (download) {
        const transfer = state.session?.transfers?.find((entry) => entry.id === download.dataset.downloadId);
        if (transfer) downloadTransfer(transfer);
        return;
      }
      const actionEl = event.target.closest('[data-action]');
      if (!actionEl) return;
      const action = actionEl.dataset.action;
      if (action === 'accept-offer') acceptOffer();
      else if (action === 'decline-offer') declineOffer();
      else if (action === 'cancel-offer') cancelOffer();
      else if (action === 'retry-upload') retryUploads();
      else if (action === 'download-all') downloadAllReady();
    });

    els.modalRoot.addEventListener('click', (event) => {
      if (event.target.classList.contains('modal-backdrop') && ui.modal?.dismissible) {
        closeModal();
        return;
      }
      const actionEl = event.target.closest('[data-action]');
      if (!actionEl || actionEl.disabled) return;
      const action = actionEl.dataset.action;
      if (action === 'close-modal') closeModal();
      else if (action === 'accept-connection') acceptConnectionRequest();
      else if (action === 'decline-connection') declineConnectionRequest();
      else if (action === 'accept-offer-modal') acceptOffer({ fromModal: true });
      else if (action === 'decline-offer-modal') declineOffer({ fromModal: true });
      else if (action === 'disconnect-session') disconnectSession();
      else if (action === 'copy-url') copyInviteUrl(actionEl);
    });

    els.modalRoot.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-form="profile"]');
      if (!form) return;
      event.preventDefault();
      const input = $('#profileNameInput', form);
      if (input) saveProfile(input.value);
    });

    document.addEventListener('keydown', (event) => {
      if (!ui.modal) return;
      if (event.key === 'Escape' && ui.modal.dismissible) {
        closeModal();
        return;
      }
      trapModalFocus(event);
    });

    window.addEventListener('online', () => {
      if (state.sse?.readyState !== EventSource.OPEN) {
        startRecoveryCheck();
        if (state.me) refreshPeers();
      }
    });

    window.addEventListener('offline', () => setNetwork('offline'));

    window.addEventListener('beforeunload', (event) => {
      if (ui.uploading) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }

  async function copyInviteUrl(button) {
    const value = $('.url-value', els.modalRoot)?.textContent || '';
    const success = await copyText(value);
    if (success) {
      button.textContent = '已复制';
      setTimeout(() => {
        if (button.isConnected) button.textContent = '复制';
      }, 1800);
      toast('把地址发到另一台设备，用浏览器打开即可。', 'success', '已复制');
    } else {
      toast('复制失败，请手动选择地址复制。', 'error');
    }
  }
})();
