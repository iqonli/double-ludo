(function () {
  'use strict';

  const {
    DoubleFlightEngine,
    COLORS,
    PATH_COLORS,
    SHORTCUTS,
    FINISH_ENTRY_INDEX,
    BOARD_PATH_LENGTH
  } = window.DoubleFlight;
  const ActionProtocol = window.DoubleFlightProtocol;

  const PALETTE_DEFAULTS = {
    redPiece:      { label: '红色棋子', value: [217, 75, 80] },
    redCell:       { label: '红色格子', value: [225, 112, 116] },
    redAirport:    { label: '红色机场', value: [246, 207, 209] },
    yellowPiece:   { label: '黄色棋子', value: [229, 189, 52] },
    yellowCell:    { label: '黄色格子', value: [238, 205, 91] },
    yellowAirport: { label: '黄色机场', value: [250, 239, 192] },
    bluePiece:     { label: '蓝色棋子', value: [49, 133, 216] },
    blueCell:      { label: '蓝色格子', value: [103, 165, 226] },
    blueAirport:   { label: '蓝色机场', value: [207, 229, 249] },
    greenPiece:    { label: '绿色棋子', value: [53, 162, 102] },
    greenCell:     { label: '绿色格子', value: [102, 188, 138] },
    greenAirport:  { label: '绿色机场', value: [207, 238, 219] }
  };
  const palette = Object.fromEntries(Object.entries(PALETTE_DEFAULTS).map(([key, item]) => [key, item.value.slice()]));
  const timing = {
    loopWaitMs: 250,
    stepDurationMs: 300,
    specialDurationMs: 300,
    stageWaitMs: 100
  };
  const COLOR_HEX = { red: '', yellow: '', blue: '', green: '' };
  const BOARD_COLORS = {
    outer: 'rgb(231, 233, 237)',
    surface: 'rgb(248, 249, 250)',
    neutral: 'rgb(238, 240, 243)',
    border: 'rgb(90, 94, 101)',
    arrow: 'rgb(70, 73, 79)'
  };
  const COLOR_TEXT = { red: '红色', yellow: '黄色', blue: '蓝色', green: '绿色' };
  const COLOR_SHORT = { red: '红', yellow: '黄', blue: '蓝', green: '绿' };

  // 15×15 layout supplied in ludo csv mark.csv.
  const MAIN_GRID = [
    [4,0],[4,1],[4,2],[4,3],[3,4],[2,4],[1,4],[0,4],[0,5],[0,6],[0,8],[0,9],
    [0,10],[1,10],[2,10],[3,10],[4,11],[4,12],[4,13],[4,14],[5,14],[6,14],[8,14],[9,14],
    [10,14],[10,13],[10,12],[10,11],[11,10],[12,10],[13,10],[14,10],[14,9],[14,8],[14,6],[14,5],
    [14,4],[13,4],[12,4],[11,4],[10,3],[10,2],[10,1],[10,0],[9,0],[8,0],[6,0],[5,0]
  ];
  if (MAIN_GRID.length !== BOARD_PATH_LENGTH) {
    throw new Error('棋盘公共航道坐标数量与规则引擎不一致');
  }

  const BOARD_SIZE = 700;
  const GRID_ORIGIN = 35;
  const CELL = 42;
  const CELL_GAP = 2;

  const gridPoint = (row, col) => [
    GRID_ORIGIN + (col + 0.5) * CELL,
    GRID_ORIGIN + (row + 0.5) * CELL
  ];
  const MAIN_PATH = MAIN_GRID.map(([row, col]) => gridPoint(row, col));
  const LAUNCH = {
    yellow: gridPoint(3, 0),
    blue: gridPoint(0, 11),
    green: gridPoint(11, 14),
    red: gridPoint(14, 3)
  };
  const fractionalGridPoint = (row, col) => [
    GRID_ORIGIN + (col + 0.5) * CELL,
    GRID_ORIGIN + (row + 0.5) * CELL
  ];
  const homePoints = (row, col) => [
    fractionalGridPoint(row + 0.25, col + 0.25),
    fractionalGridPoint(row + 0.25, col + 1.75),
    fractionalGridPoint(row + 1.75, col + 0.25),
    fractionalGridPoint(row + 1.75, col + 1.75)
  ];
  const HOME = {
    yellow: homePoints(0, 0),
    blue: homePoints(0, 12),
    green: homePoints(12, 12),
    red: homePoints(12, 0)
  };
  const LANE = {
    yellow: [0,1,2,3,4,5].map(col => gridPoint(7, col)),
    blue: [0,1,2,3,4,5].map(row => gridPoint(row, 7)),
    green: [14,13,12,11,10,9].map(col => gridPoint(7, col)),
    red: [14,13,12,11,10,9].map(row => gridPoint(row, 7))
  };
  const CENTER = gridPoint(7, 7);
  const FINISH = {
    yellow: gridPoint(7, 6),
    blue: gridPoint(6, 7),
    green: gridPoint(7, 8),
    red: gridPoint(8, 7)
  };

  let mode = 'classic';
  let playerAColors = [];
  let protectedColors = new Set();
  let launchValues = new Set([5, 6]);
  let tripleSixPenaltyEnabled = true;
  let orderRolls = { A: null, B: null };
  let firstPlayer = 'A';
  let engine = null;
  let swapMode = false;
  let swapSelection = [];
  let interactionLocked = false;
  let openingRollPending = true;
  let previewAnimationToken = 0;
  let defeatDialogResolve = null;
  let defeatUndoClicks = 0;
  let expandedOverlapKey = null;
  let lockedOverlapKey = null;
  let overlapCollapseTimer = null;
  let overlapHitRegions = new Map();
  let toastTimer = null;
  let victoryShownFor = null;
  let secondConfirmEnabled = false;
  let boardRotation = 0;
  let pendingConfirmation = null;
  let pendingSwapOrderChoice = null;
  let confirmationAnimationToken = 0;
  let undoRecord = null;
  let assignmentCheckpoint = null;
  const AI_DEFAULT_MODEL = 'normal-v1';
  const AI_THINK_DELAY_MS = 320;
  let setupAiControllers = { A: null, B: null };
  let aiControllers = { A: null, B: null };
  let aiLoopToken = 0;
  let aiLoopScheduled = false;
  let aiModalPlayerId = null;
  let suspendedGame = null;
  let runtimeMode = 'local';
  let lanClient = null;
  let lanConnected = false;
  let lanRole = null;
  let lanRoomStatus = 'closed';
  let lanVersion = -1;
  let lanStateHash = 0;
  let lanConnectedPlayers = { A: false, B: false };
  let lanLastError = null;
  let lanLatencyMs = null;
  let lanLobbyConfig = null;
  let lanLobbySyncTimer = null;
  let lanLobbySyncPending = false;
  let lanLobbySyncSerial = 0;
  let lanProtectionSubmitting = false;
  let lanPlayerBReady = false;
  let lanUndoAvailable = false;
  let lanUndoRequest = null;
  let lanUndoResponding = false;
  let lanDefeatRegretRequest = null;
  let lanDefeatRegretRequesting = false;
  let lanDefeatRegretResponding = false;
  let lanChatVersion = -1;
  let lanChatMessages = [];
  let lanChatSending = false;
  let lanChatSendKeyMode = 'enter';
  let lanSearching = false;
  let lanVisualVersion = -1;
  let lanVisualRoomStatus = 'closed';
  let lanVisualQueue = Promise.resolve();
  let lanAnimationActive = false;
  let lastOwnLanTurn = false;

  const el = {};
  const byId = id => document.getElementById(id);

  const localDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });

  function parseServerDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? `${raw.replace(' ', 'T')}Z`
      : raw;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function formatServerTimeLocal(value) {
    const date = parseServerDate(value);
    return date ? localDateTimeFormatter.format(date) : String(value || '');
  }
  const delay = ms => new Promise(resolve => window.setTimeout(resolve, ms));
  const cloneData = value => JSON.parse(JSON.stringify(value));


  const randomBetween = (minimum, maximum) => minimum + Math.random() * (maximum - minimum);

  function visibleLanChatPanel() {
    const candidates = [];
    if (el.undoRequestModal && !el.undoRequestModal.classList.contains('hidden') && el.undoLanChatPanel) candidates.push(el.undoLanChatPanel);
    if (el.defeatModal && !el.defeatModal.classList.contains('hidden') && el.defeatLanChatPanel) candidates.push(el.defeatLanChatPanel);
    if (el.setupOverlay && !el.setupOverlay.classList.contains('hidden') && el.setupLanChatPanel) candidates.push(el.setupLanChatPanel);
    if (el.lanChatPanel) candidates.push(el.lanChatPanel);
    return candidates.find(panel => {
      const rect = panel.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 && getComputedStyle(panel).display !== 'none';
    }) || null;
  }

  function launchLanSpirit(kind) {
    if (!isLanMode() || !lanConnected || !el.lanSpiritLayer || !el.board) return;
    const boardRect = el.board.getBoundingClientRect();
    if (!boardRect.width || !boardRect.height) return;
    const size = Math.round(randomBetween(150, 200));
    const duration = Math.round(randomBetween(500, 1000));
    let startX;
    let startY;
    let endX;
    let endY;
    let color;
    if (kind === 'chat') {
      const chatPanel = visibleLanChatPanel();
      if (!chatPanel) return;
      const chatRect = chatPanel.getBoundingClientRect();
      startX = boardRect.right;
      startY = randomBetween(boardRect.top, boardRect.bottom);
      endX = chatRect.left;
      endY = randomBetween(chatRect.top, chatRect.bottom);
      color = '231, 185, 40';
    } else {
      startX = boardRect.left;
      startY = randomBetween(boardRect.top, boardRect.bottom);
      endX = boardRect.right;
      endY = randomBetween(boardRect.top, boardRect.bottom);
      color = '223, 244, 228';
    }
    const orb = document.createElement('i');
    orb.className = `lan-spirit-orb ${kind === 'chat' ? 'chat-spirit' : 'turn-spirit'}`;
    orb.style.width = `${size}px`;
    orb.style.height = `${size}px`;
    orb.style.background = `radial-gradient(circle, rgba(${color}, .60) 0%, rgba(${color}, .42) 28%, rgba(${color}, .20) 58%, rgba(${color}, 0) 76%)`;
    el.lanSpiritLayer.appendChild(orb);
    const from = `translate3d(${startX - size / 2}px, ${startY - size / 2}px, 0) scale(.78)`;
    const middleX = startX + (endX - startX) * .52;
    const middleY = startY + (endY - startY) * .52 + randomBetween(-36, 36);
    const middle = `translate3d(${middleX - size / 2}px, ${middleY - size / 2}px, 0) scale(1.08)`;
    const to = `translate3d(${endX - size / 2}px, ${endY - size / 2}px, 0) scale(.68)`;
    const animation = orb.animate([
      { transform: from, opacity: 0, offset: 0 },
      { transform: from, opacity: .95, offset: .12 },
      { transform: middle, opacity: .9, offset: .58 },
      { transform: to, opacity: 0, offset: 1 }
    ], { duration, easing: 'cubic-bezier(.22,.72,.25,1)', fill: 'forwards' });
    animation.finished.catch(() => {}).finally(() => orb.remove());
  }

  function initChatPanelResizers() {
    chatPanelRefs().forEach(ref => {
      // The setup chat is one fixed section of the combined setup card.
      // It deliberately has no independent resize state or drag handle.
      if (ref.panel.id === 'setupLanChatPanel') {
        ref.panel.querySelector('.lan-chat-resize-handle')?.remove();
        ref.panel.style.height = '800px';
        try { localStorage.removeItem('doubleFlightChatHeight:setupLanChatPanel'); } catch (_) {}
        return;
      }
      if (ref.panel.querySelector('.lan-chat-resize-handle')) return;
      const handle = document.createElement('div');
      handle.className = 'lan-chat-resize-handle';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-label', '拖动调整聊天卡片高度');
      handle.setAttribute('aria-orientation', 'horizontal');
      ref.panel.appendChild(handle);
      let startY = 0;
      let startHeight = 0;
      const stop = () => {
        document.body.classList.remove('resizing-chat-panel');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        try { localStorage.setItem(`doubleFlightChatHeight:${ref.panel.id}`, String(Math.round(ref.panel.getBoundingClientRect().height))); } catch (_) {}
      };
      const move = event => {
        const maxHeight = Math.max(260, window.innerHeight - 24);
        ref.panel.style.height = `${clamp(startHeight + event.clientY - startY, 240, maxHeight)}px`;
      };
      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        startY = event.clientY;
        startHeight = ref.panel.getBoundingClientRect().height;
        handle.setPointerCapture?.(event.pointerId);
        document.body.classList.add('resizing-chat-panel');
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
        window.addEventListener('pointercancel', stop, { once: true });
      });
      try {
        const maximum = Math.max(260, window.innerHeight - 24);
        const saved = Number(localStorage.getItem(`doubleFlightChatHeight:${ref.panel.id}`));
        const initialHeight = Number.isFinite(saved) && saved >= 240 ? saved : 500;
        ref.panel.style.height = `${clamp(initialHeight, 240, maximum)}px`;
      } catch (_) {
        ref.panel.style.height = `${clamp(500, 240, Math.max(260, window.innerHeight - 24))}px`;
      }
    });
  }

  function initWorkspaceResizers() {
    if (!el.workspace || !el.leftColumnResizer || !el.rightColumnResizer) return;
    const rootStyle = document.documentElement.style;
    const restore = (name, fallback, min, max) => {
      try {
        const saved = Number(localStorage.getItem(name));
        if (Number.isFinite(saved)) rootStyle.setProperty(name === 'doubleFlightLeftPanelWidth' ? '--left-panel-width' : '--right-panel-width', `${clamp(saved, min, max)}px`);
      } catch (_) {}
    };
    restore('doubleFlightLeftPanelWidth', 350, 220, 480);
    restore('doubleFlightRightPanelWidth', 350, 250, 520);
    const bind = (handle, side) => {
      let startX = 0;
      let startWidth = 0;
      const panel = side === 'left' ? el.leftPanel : el.turnInteractionPanel;
      const cssVar = side === 'left' ? '--left-panel-width' : '--right-panel-width';
      const storageKey = side === 'left' ? 'doubleFlightLeftPanelWidth' : 'doubleFlightRightPanelWidth';
      const minimum = side === 'left' ? 220 : 250;
      const maximum = side === 'left' ? 480 : 520;
      const move = event => {
        const delta = event.clientX - startX;
        const width = clamp(startWidth + (side === 'left' ? delta : -delta), minimum, maximum);
        rootStyle.setProperty(cssVar, `${width}px`);
      };
      const stop = () => {
        document.body.classList.remove('resizing-columns');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        try { localStorage.setItem(storageKey, String(Math.round(panel.getBoundingClientRect().width))); } catch (_) {}
      };
      handle.addEventListener('pointerdown', event => {
        if (matchMedia('(max-width: 960px)').matches) return;
        event.preventDefault();
        startX = event.clientX;
        startWidth = panel.getBoundingClientRect().width;
        handle.setPointerCapture?.(event.pointerId);
        document.body.classList.add('resizing-columns');
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop, { once: true });
        window.addEventListener('pointercancel', stop, { once: true });
      });
      handle.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const current = panel.getBoundingClientRect().width;
        const delta = event.key === 'ArrowRight' ? 12 : -12;
        const width = clamp(current + (side === 'left' ? delta : -delta), minimum, maximum);
        rootStyle.setProperty(cssVar, `${width}px`);
        try { localStorage.setItem(storageKey, String(Math.round(width))); } catch (_) {}
      });
    };
    bind(el.leftColumnResizer, 'left');
    bind(el.rightColumnResizer, 'right');
  }

  function isLanMode() {
    return runtimeMode === 'lan';
  }

  function lanCanControlCurrentPlayer() {
    return Boolean(
      isLanMode() && lanConnected && lanRoomStatus === 'playing' && engine &&
      lanRole === engine.currentPlayerId && !engine.gameOver && !engine.pendingDefeat && !lanAnimationActive && !lanUndoRequest
    );
  }

  function formatLanLatency() {
    return Number.isFinite(Number(lanLatencyMs)) ? `${Math.max(0, Math.round(Number(lanLatencyMs)))}ms` : '--ms';
  }

  function lanBadgeText() {
    return isLanMode()
      ? (lanConnected ? `LAN - 玩家${lanRole || '?'} ${formatLanLatency()}` : 'LAN - 未连接')
      : '本地';
  }

  function setLanStatus(text, state = '') {
    if (el.lanConnectionStatus) el.lanConnectionStatus.textContent = text;
    if (el.networkBadge) {
      el.networkBadge.textContent = lanBadgeText();
      el.networkBadge.classList.remove('online', 'offline');
      if (state) el.networkBadge.classList.add(state);
    }
  }

  function createEngineFromSnapshot(snapshot) {
    const playerA = snapshot.players.find(player => player.id === 'A');
    const protectedList = Object.entries(snapshot.colorState || {})
      .filter(([, value]) => value && value.protected)
      .map(([color]) => color);
    const restored = new DoubleFlightEngine({
      mode: snapshot.mode,
      playerAColors: playerA ? playerA.colors : ['red', 'yellow'],
      protectedColors: protectedList,
      launchValues: snapshot.launchValues,
      tripleSixPenalty: snapshot.tripleSixPenalty !== false,
      firstPlayer: snapshot.currentPlayerId
    });
    restored.restore(snapshot);
    return restored;
  }

  function resetLanInteractionState() {
    cancelAiLoop();
    aiControllers = { A: null, B: null };
    swapMode = false;
    swapSelection = [];
    interactionLocked = false;
    pendingConfirmation = null;
    pendingSwapOrderChoice = null;
    undoRecord = null;
    assignmentCheckpoint = null;
    if (!(isLanMode() && lanConnected)) secondConfirmEnabled = false;
    document.body.classList.remove('pending-confirmation');
    if (el.confirmActionButton) el.confirmActionButton.classList.add('hidden');
    hidePreview();
  }

  function showLanDefeatPopup(color) {
    defeatUndoClicks = 0;
    defeatDialogResolve = 'lan';
    el.defeatText.textContent = `666你的${COLOR_TEXT[color]}被击败了！！！`;
    el.undoDefeat.textContent = '申请反悔';
    el.acceptDefeat.textContent = '我接受';
    const canDecide = Boolean(engine && lanRole === engine.currentPlayerId);
    el.undoDefeat.disabled = !canDecide || lanDefeatRegretRequesting;
    el.acceptDefeat.disabled = !canDecide || lanDefeatRegretRequesting;
    el.defeatModal.classList.toggle('hidden', !canDecide);
    if (canDecide) renderLanChat();
  }

  function snapshotPiece(snapshot, pieceId) {
    const groups = snapshot && snapshot.pieces && typeof snapshot.pieces === 'object'
      ? Object.values(snapshot.pieces)
      : [];
    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      const piece = group.find(item => item && item.id === pieceId);
      if (piece) return piece;
    }
    return null;
  }

  async function animateLanSwap(action, state) {
    const pieceIds = action && Array.isArray(action.pieceIds) ? action.pieceIds : [];
    if (pieceIds.length !== 2 || !state) return;
    const duration = Math.max(0, timing.specialDurationMs);
    for (const pieceId of pieceIds) {
      const piece = snapshotPiece(state, pieceId);
      const node = el.pieceLayer.querySelector(`[data-piece-id="${pieceId}"]`);
      if (!piece || !node) continue;
      node.classList.add('animating', 'special-motion');
      node.style.setProperty('--motion-ms', `${duration}ms`);
      positionNodeAtLocation(node, piece.location, 0, 1);
    }
    if (duration > 0) await delay(duration);
    for (const pieceId of pieceIds) {
      const node = el.pieceLayer.querySelector(`[data-piece-id="${pieceId}"]`);
      if (!node) continue;
      node.classList.remove('animating', 'special-motion');
      node.style.removeProperty('--motion-ms');
    }
  }

  function commitLanSnapshot(state, openingPending) {
    const oldPieceCount = engine ? engine.getAllPieces().length : -1;
    engine = createEngineFromSnapshot(state);
    openingRollPending = Boolean(openingPending);
    mode = engine.mode;
    const playerA = engine.getPlayer('A');
    playerAColors = playerA.colors.slice();
    protectedColors = new Set(Object.entries(engine.colorState).filter(([, value]) => value.protected).map(([color]) => color));
    launchValues = new Set(engine.launchValues);
    tripleSixPenaltyEnabled = engine.tripleSixPenalty !== false;
    resetLanInteractionState();
    suspendedGame = null;
    el.backToGame.classList.add('hidden');
    el.setupOverlay.classList.add('hidden');
    if (oldPieceCount !== engine.getAllPieces().length || !el.pieceLayer.querySelector('.piece')) createPieceElements();
    renderGame();
    if (engine.pendingDefeat && lanRole === engine.currentPlayerId) showLanDefeatPopup(engine.pendingDefeat.color);
    else if (defeatDialogResolve === 'lan') {
      defeatDialogResolve = null;
      el.defeatModal.classList.add('hidden');
    }
    updateLanUndoRequestModal();
    if (engine.gameOver) showVictoryPopup();
    else closeVictoryPopup();
  }

  async function animateLanTransition(transition) {
    if (!transition || !transition.state) return;
    const action = transition.action || null;
    if (action && Number(action.actionCode) === 0) {
      const rolls = Array.isArray(action.rolls) && action.rolls.length
        ? action.rolls
        : (Array.isArray(action.values) ? [action.values] : []);
      for (let index = 0; index < rolls.length; index += 1) {
        await animateDiceRoll(rolls[index]);
        if (index < rolls.length - 1 && timing.loopWaitMs > 0) await delay(timing.loopWaitMs);
      }
    }
    if (action && Number(action.actionCode) >= 20 && Number(action.actionCode) <= 275) {
      await animateLanSwap(action, transition.state);
    }
    if (Array.isArray(transition.events) && transition.events.length) {
      await animateMovementEvents(transition.events);
    }
    commitLanSnapshot(transition.state, transition.openingRollPending);
    lanVisualVersion = Number(transition.version);
  }

  async function applyLanGamePayload(payload) {
    const incomingVersion = Number(payload.version);
    const targetStatus = payload.roomStatus || lanVisualRoomStatus;
    if (targetStatus !== 'playing' || !payload.state) {
      resetLanInteractionState();
      engine = null;
      closeVictoryPopup();
      el.defeatModal.classList.add('hidden');
      defeatDialogResolve = null;
      el.setupOverlay.classList.remove('hidden');
      lanVisualVersion = incomingVersion;
      lanVisualRoomStatus = targetStatus;
      renderSetup();
      return;
    }

    const transitions = Array.isArray(payload.transitions)
      ? payload.transitions.filter(item => Number(item.version) > lanVisualVersion).sort((a, b) => Number(a.version) - Number(b.version))
      : [];
    const canAnimate = Boolean(engine && lanVisualRoomStatus === 'playing' && transitions.length);
    if (!canAnimate) {
      commitLanSnapshot(payload.state, payload.openingRollPending);
      lanVisualVersion = incomingVersion;
      lanVisualRoomStatus = targetStatus;
      return;
    }

    lanAnimationActive = true;
    if (engine) renderGame();
    try {
      for (const transition of transitions) await animateLanTransition(transition);
      if (lanVisualVersion < incomingVersion) {
        commitLanSnapshot(payload.state, payload.openingRollPending);
        lanVisualVersion = incomingVersion;
      }
    } finally {
      lanAnimationActive = false;
      lanVisualRoomStatus = targetStatus;
      if (engine) renderGame();
    }
  }

  // Chat-only responses update the chat panel without rebuilding the game;
  // visual game transitions are queued independently from network polling.
  function applyLanPayload(payload) {
    if (!payload) return;
    const incomingVersion = Number(payload.version);
    const targetStatus = payload.roomStatus || lanRoomStatus;
    const needsVisualUpdate = !engine || incomingVersion > lanVisualVersion || targetStatus !== lanVisualRoomStatus;

    const previousChatVersion = Number(lanChatVersion);
    const previousChatIds = new Set(lanChatMessages.map(message => String(message && message.id || '')));
    lanConnected = true;
    lanRole = payload.player || lanRole;
    lanRoomStatus = targetStatus;
    lanVersion = incomingVersion;
    lanStateHash = Number(payload.stateHash || 0);
    lanConnectedPlayers = payload.connected || lanConnectedPlayers;
    lanPlayerBReady = Boolean(payload.lobbyReady && payload.lobbyReady.B);
    if (payload.lobbySpeedRolls && typeof payload.lobbySpeedRolls === 'object') {
      orderRolls = {
        A: Array.isArray(payload.lobbySpeedRolls.A) ? payload.lobbySpeedRolls.A.slice(0, 2) : null,
        B: Array.isArray(payload.lobbySpeedRolls.B) ? payload.lobbySpeedRolls.B.slice(0, 2) : null
      };
    }
    lanUndoAvailable = Boolean(payload.undoAvailable);
    lanUndoRequest = payload.undoRequest && typeof payload.undoRequest === 'object' ? cloneData(payload.undoRequest) : null;
    lanDefeatRegretRequest = payload.defeatRegretRequest && typeof payload.defeatRegretRequest === 'object'
      ? cloneData(payload.defeatRegretRequest)
      : null;
    updateLanUndoRequestModal();
    lanLastError = null;
    if (payload.lobbyConfig && typeof payload.lobbyConfig === 'object') {
      lanLobbyConfig = cloneData(payload.lobbyConfig);
      if (lanRoomStatus === 'lobby') applyLobbyConfigToSetup(lanLobbyConfig);
    }
    if (Number.isFinite(Number(payload.chatVersion))) lanChatVersion = Number(payload.chatVersion);
    if (Array.isArray(payload.chatMessages)) lanChatMessages = payload.chatMessages.slice();
    const incomingChatMessages = Number.isFinite(previousChatVersion) && previousChatVersion >= 0 && Number(lanChatVersion) > previousChatVersion
      ? lanChatMessages.filter(message => !previousChatIds.has(String(message && message.id || '')) && message.player !== lanRole)
      : [];
    const hasIncomingChat = incomingChatMessages.length > 0;
    if (hasIncomingChat) {
      shakeLanChatPanels();
      launchLanSpirit('chat');
    }
    if (lanClient) {
      lanClient.version = lanVersion;
      lanClient.stateHash = lanStateHash;
      lanClient.chatVersion = lanChatVersion;
    }
    setLanStatus(`已登录为玩家${lanRole} - ${lanRoomStatus === 'playing' ? '游戏中' : '等待开局'} - 版本${lanVersion}`, 'online');
    renderLanChat(incomingChatMessages.length);

    if (needsVisualUpdate) {
      const queuedPayload = cloneData(payload);
      lanVisualQueue = lanVisualQueue
        .then(() => applyLanGamePayload(queuedPayload))
        .catch(error => {
          lanAnimationActive = false;
          console.error(error);
          showError(error);
          if (queuedPayload.state) {
            commitLanSnapshot(queuedPayload.state, queuedPayload.openingRollPending);
            lanVisualVersion = Number(queuedPayload.version);
            lanVisualRoomStatus = queuedPayload.roomStatus || 'playing';
          }
        });
    }
  }

  function handleLanSessionInvalid(error) {
    lanConnected = false;
    lastOwnLanTurn = false;
    lanRole = null;
    lanRoomStatus = 'closed';
    lanVersion = -1;
    lanStateHash = 0;
    lanUndoAvailable = false;
    lanUndoRequest = null;
    lanUndoResponding = false;
    lanDefeatRegretRequest = null;
    lanDefeatRegretRequesting = false;
    lanDefeatRegretResponding = false;
    updateLanUndoRequestModal();
    lanChatVersion = -1;
    lanChatMessages = [];
    lanVisualVersion = -1;
    lanVisualRoomStatus = 'closed';
    lanVisualQueue = Promise.resolve();
    lanAnimationActive = false;
    lanProtectionSubmitting = false;
    lanPlayerBReady = false;
    engine = null;
    resetLanInteractionState();
    el.setupOverlay.classList.remove('hidden');
    setLanStatus(error ? error.message : '会话已经退出。', 'offline');
    renderSetup();
    renderLanChat();
  }

  function handleLanNetworkStatus(info) {
    if (info && Number.isFinite(Number(info.latencyMs))) lanLatencyMs = Number(info.latencyMs);
    if (!isLanMode() || !lanConnected) return;
    if (info.online) setLanStatus(`已登录为玩家${lanRole} - ${lanRoomStatus === 'playing' ? '游戏中' : '等待开局'} - 版本${lanVersion}`, 'online');
    else setLanStatus(`连接暂时中断，正在重试：${info.error ? info.error.message : ''}`, 'offline');
    // Latency/status callbacks run for every HTTP request. Rebuilding the setup
    // form here would replace a checkbox or button between pointerdown and click.
    // Only the small status elements are updated; authoritative payloads render
    // the setup when the lobby version actually changes.
    if (engine) renderGame();
  }

  function parseIpv4(text) {
    const matches = String(text || '').match(/(?:^|[^\d])((?:\d{1,3}\.){3}\d{1,3})(?=$|[^\d])/g) || [];
    for (const raw of matches) {
      const candidate = raw.match(/(?:\d{1,3}\.){3}\d{1,3}/)?.[0] || '';
      const parts = candidate.split('.').map(Number);
      if (parts.length === 4 && parts.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return candidate;
    }
    return '';
  }

  function parseInviteDetails(text) {
    const source = String(text || '').trim();
    let serverUrl = '';
    let code = '';
    let port = '';
    const urls = source.match(/https?:\/\/[^\s，。；;]+/gi) || [];
    for (const raw of urls) {
      try {
        const parsed = new URL(raw.replace(/[)\]}>]+$/, ''));
        const queryCode = parsed.searchParams.get('port') || parsed.searchParams.get('code') || '';
        const queryUrl = parsed.searchParams.get('URL') || parsed.searchParams.get('url') || '';
        if (/^\d{5}(?:[A-HJ-KM-NP-Z]{1,2})?$/i.test(queryCode)) code = queryCode.toUpperCase();
        if (queryUrl) serverUrl = queryUrl;
        else if (!serverUrl) serverUrl = parsed.origin;
        if (code || queryUrl) break;
      } catch (_) {}
    }
    if (!serverUrl) {
      const explicit = source.match(/(?:^|\s)([\w.-]+\.onrender\.com)(?=$|\s|[，。；;])/i)?.[1];
      if (explicit) serverUrl = `https://${explicit}`;
    }
    if (!code) code = source.match(/(?:^|[^0-9A-Z])(\d{5}[A-HJ-KM-NP-Z]{1,2}|\d{5})(?![0-9A-Z])/i)?.[1]?.toUpperCase() || '';
    const ip = parseIpv4(source);
    if (!serverUrl && ip) serverUrl = ip;
    if (ip || (!serverUrl && !urls.length)) port = source.match(/(?:^|\D)(\d{4})(?!\d)/)?.[1] || '';
    return { serverUrl, code, port, ip };
  }

  function applySmartLanInput() {
    const details = parseInviteDetails(el.lanSmartInput.value);
    if (details.serverUrl) el.lanHost.value = details.serverUrl;
    if (details.port) el.lanPort.value = details.port;
    else if (/^https?:\/\//i.test(details.serverUrl)) el.lanPort.value = '';
    if (details.code) el.lanLoginCode.value = details.code;
    const found = [details.serverUrl && '服务器地址', details.port && '端口', details.code && '登录码'].filter(Boolean);
    if (!found.length) showError(new Error('智能输入中未找到合法的服务器地址、端口或登录码。'));
    else showError(new Error(`已填写：${found.join('、')}`));
    return Boolean(found.length);
  }

  function validIpv4(value) {
    return parseIpv4(String(value || '').trim()) === String(value || '').trim();
  }

  async function gatherWebRtcIpv4() {
    const found = new Set();
    if (typeof RTCPeerConnection !== 'function') return found;
    let pc = null;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel('lan-discovery');
      pc.onicecandidate = event => {
        const candidate = event && event.candidate && event.candidate.candidate;
        if (!candidate) return;
        const ip = parseIpv4(candidate);
        if (ip) found.add(ip);
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await delay(650);
    } catch (_) {
      // Some mobile browsers deliberately hide local addresses. Common subnets
      // are still scanned below.
    } finally {
      if (pc) pc.close();
    }
    return found;
  }

  async function probeLanServer(ip, port, timeoutMs = 420) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const requestFetch = window.DoubleLudoRequestRetry && window.DoubleLudoRequestRetry.fetch
        ? window.DoubleLudoRequestRetry.fetch
        : window.fetch.bind(window);
      const response = await requestFetch(`http://${ip}:${port}/api/info`, {
        method: 'GET', cache: 'no-store', mode: 'cors', signal: controller ? controller.signal : undefined
      }, { retry404: false });
      if (!response.ok) return false;
      const payload = await response.json();
      return Boolean(payload && ['double-flight-server', 'double-flight-lan-server'].includes(payload.name));
    } catch (_) {
      return false;
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  function lanPrefixes(ips) {
    const prefixes = new Set();
    for (const ip of ips) {
      if (!validIpv4(ip) || ip === '127.0.0.1') continue;
      prefixes.add(ip.split('.').slice(0, 3).join('.'));
    }
    [
      '192.168.0','192.168.1','192.168.2','192.168.10','192.168.31','192.168.50','192.168.100','192.168.137','192.168.203',
      '10.0.0','10.0.1','10.1.1','172.16.0','172.20.0','172.21.176','172.27.96','172.28.48','172.30.48'
    ].forEach(prefix => prefixes.add(prefix));
    return [...prefixes].slice(0, 24);
  }

  async function autoSearchLanIp() {
    if (lanSearching) return;
    const port = Number(el.lanPort.value);
    if (!Number.isInteger(port) || port < 1000 || port > 9999) {
      showError(new Error('自动搜索本地服务器前，请先输入4位端口。'));
      return;
    }
    lanSearching = true;
    el.lanAutoSearchButton.disabled = true;
    const originalText = el.lanAutoSearchButton.textContent;
    el.lanAutoSearchButton.textContent = '搜索中…';
    setLanStatus('正在搜索本地服务器……');
    try {
      const seedIps = new Set();
      const entered = String(el.lanHost.value || '').trim();
      if (validIpv4(entered)) seedIps.add(entered);
      if (validIpv4(location.hostname)) seedIps.add(location.hostname);
      try {
        const previous = localStorage.getItem('doubleFlightLastLanIp');
        if (validIpv4(previous)) seedIps.add(previous);
      } catch (_) {}
      const rtcIps = await gatherWebRtcIpv4();
      rtcIps.forEach(ip => seedIps.add(ip));

      const candidates = [];
      const seen = new Set();
      const add = ip => { if (validIpv4(ip) && !seen.has(ip)) { seen.add(ip); candidates.push(ip); } };
      add('127.0.0.1');
      seedIps.forEach(add);
      const prefixes = lanPrefixes(seedIps);
      const quickHosts = [1, 2, 10, 17, 50, 100, 128, 254];
      prefixes.forEach(prefix => quickHosts.forEach(host => add(`${prefix}.${host}`)));
      prefixes.forEach(prefix => { for (let host = 1; host <= 254; host += 1) add(`${prefix}.${host}`); });

      let cursor = 0;
      let checked = 0;
      let found = '';
      const workers = Array.from({ length: Math.min(72, candidates.length) }, async () => {
        while (!found) {
          const index = cursor++;
          if (index >= candidates.length) return;
          const ip = candidates[index];
          if (await probeLanServer(ip, port)) {
            found = ip;
            return;
          }
          checked += 1;
          if (checked % 120 === 0) setLanStatus(`正在搜索本地服务器……已尝试${checked}个地址`);
        }
      });
      await Promise.all(workers);
      if (!found) {
        setLanStatus('尚未连接。', 'offline');
        showError(new Error('未找到本地服务器'));
        return;
      }
      el.lanHost.value = found;
      try { localStorage.setItem('doubleFlightLastLanIp', found); } catch (_) {}
      setLanStatus(`已找到服务器：${found}:${port}`);
      showError(new Error(`已找到本地服务器：${found}`));
    } finally {
      lanSearching = false;
      el.lanAutoSearchButton.disabled = false;
      el.lanAutoSearchButton.textContent = originalText;
    }
  }

  async function connectLan() {
    const code = String(el.lanLoginCode.value || '').trim().toUpperCase();
    if (!/^\d{5}(?:[A-HJ-KM-NP-Z]{1,2})?$/.test(code)) {
      showError(new Error('登录码应为5位数字，或5位数字加1至2位字母（不使用I、L、O）。'));
      return;
    }
    const host = String(el.lanHost.value || '').trim();
    if (!host) {
      showError(new Error('请输入服务器地址或IP。'));
      return;
    }
    el.lanLoginCode.value = code;
    el.lanConnectButton.disabled = true;
    setLanStatus('正在连接……');
    try {
      await lanClient.login(host, el.lanPort.value, code);
      try { localStorage.setItem('doubleFlightLastLanIp', host); } catch (_) {}
      renderSetup();
    } catch (error) {
      setLanStatus(error.message, 'offline');
      showError(error);
    } finally {
      el.lanConnectButton.disabled = false;
    }
  }

  function applyInviteFromPageUrl() {
    const params = new URLSearchParams(location.search);
    const code = String(params.get('port') || params.get('code') || '').trim().toUpperCase();
    if (!/^\d{5}(?:[A-HJ-KM-NP-Z]{1,2})?$/.test(code)) return false;
    const serverUrl = String(params.get('URL') || params.get('url') || ((location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : '')).trim();
    if (!serverUrl) return false;
    runtimeMode = 'lan';
    el.lanHost.value = serverUrl;
    el.lanPort.value = '';
    el.lanLoginCode.value = code;
    renderSetup();
    window.setTimeout(() => connectLan(), 0);
    return true;
  }

  function chatPanelRefs() {
    const refs = [];
    if (el.lanChatPanel && el.lanChatLog) {
      refs.push({
        panel: el.lanChatPanel,
        log: el.lanChatLog,
        count: el.lanChatCount,
        input: el.lanChatInput,
        hint: el.lanChatHint,
        send: el.lanChatSend,
        unread: el.lanChatUnread
      });
    }
    if (el.setupLanChatPanel && el.setupLanChatLog) {
      refs.push({
        panel: el.setupLanChatPanel,
        log: el.setupLanChatLog,
        count: el.setupLanChatCount,
        input: el.setupLanChatInput,
        hint: el.setupLanChatHint,
        send: el.setupLanChatSend,
        unread: el.setupLanChatUnread
      });
    }
    if (el.defeatLanChatPanel && el.defeatLanChatLog) {
      refs.push({ panel: el.defeatLanChatPanel, log: el.defeatLanChatLog, count: el.defeatLanChatCount, input: el.defeatLanChatInput, hint: el.defeatLanChatHint, send: el.defeatLanChatSend, unread: el.defeatLanChatUnread });
    }
    if (el.undoLanChatPanel && el.undoLanChatLog) {
      refs.push({ panel: el.undoLanChatPanel, log: el.undoLanChatLog, count: el.undoLanChatCount, input: el.undoLanChatInput, hint: el.undoLanChatHint, send: el.undoLanChatSend, unread: el.undoLanChatUnread });
    }
    return refs;
  }

  function activeLanChatInput() {
    const active = document.activeElement;
    const match = chatPanelRefs().find(ref => ref.input === active);
    return match ? match.input : (el.lanChatInput || el.setupLanChatInput);
  }

  function shakeLanChatPanels() {
    chatPanelRefs().forEach(ref => {
      ref.panel.classList.remove('chat-shake');
      void ref.panel.offsetWidth;
      ref.panel.classList.add('chat-shake');
      window.setTimeout(() => ref.panel.classList.remove('chat-shake'), 540);
    });
  }

  function renderLanChat(incomingCount = 0) {
    const connected = isLanMode() && lanConnected && Boolean(lanRole);
    const activeInput = activeLanChatInput();
    const activeValue = activeInput ? activeInput.value : '';
    chatPanelRefs().forEach(ref => {
      const previousScrollTop = ref.log.scrollTop;
      const stickToBottom = ref.panel.dataset.followBottom !== 'false';
      let unreadCount = Number(ref.panel.dataset.unreadCount || 0);
      if (incomingCount > 0) unreadCount = stickToBottom ? 0 : unreadCount + incomingCount;
      if (ref.count) ref.count.textContent = String(lanChatMessages.length);
      ref.log.replaceChildren();
      if (!lanChatMessages.length) {
        const empty = document.createElement('p');
        empty.className = 'lan-chat-empty';
        empty.textContent = connected ? '暂无消息。' : '连接服务器后可聊天。';
        ref.log.appendChild(empty);
      } else {
        lanChatMessages.forEach(message => {
          const article = document.createElement('article');
          const messageClass = message.player === 'SERVER' ? ' server' : (message.player === lanRole ? ' own' : '');
          article.className = `lan-chat-message${messageClass}`;
          const meta = document.createElement('div');
          meta.className = 'lan-chat-meta';
          meta.textContent = `${formatServerTimeLocal(message.time)} ${message.name || `玩家${message.player}`}:`;
          const content = document.createElement('div');
          content.className = 'lan-chat-content';
          content.textContent = String(message.content || '');
          article.append(meta, content);
          ref.log.appendChild(article);
        });
      }
      const value = ref.input === activeInput ? activeValue : ref.input.value;
      ref.input.disabled = !connected || lanChatSending;
      ref.send.disabled = !connected || lanChatSending || !String(value || '').trim();
      ref.hint.disabled = !connected || lanChatSending;
      if (ref.unread) {
        ref.panel.dataset.unreadCount = String(unreadCount);
        ref.unread.textContent = `未读 ${unreadCount}`;
        ref.unread.classList.toggle('hidden', unreadCount <= 0);
      }
      ref.hint.textContent = lanChatSending
        ? '正在发送……'
        : `当前：${lanChatSendKeyMode === 'enter' ? 'Enter' : 'Shift+Enter'}发送`;
      window.requestAnimationFrame(() => {
        ref.log.scrollTop = stickToBottom ? ref.log.scrollHeight : previousScrollTop;
      });
    });
  }

  function toggleLanChatSendKeyMode(event) {
    lanChatSendKeyMode = lanChatSendKeyMode === 'enter' ? 'shift-enter' : 'enter';
    const panel = event && event.currentTarget ? event.currentTarget.closest('.lan-chat-panel') : null;
    const input = panel ? panel.querySelector('.lan-chat-input') : activeLanChatInput();
    renderLanChat();
    if (input && !input.disabled) input.focus();
  }

  async function sendLanChat(event) {
    if (!isLanMode() || !lanConnected || !lanClient || lanChatSending) return;
    const panel = event && event.currentTarget ? event.currentTarget.closest('.lan-chat-panel') : null;
    const sourceInput = (panel && panel.querySelector('.lan-chat-input')) || activeLanChatInput() || el.lanChatInput;
    const content = String(sourceInput.value || '').replace(/\r\n?/g, '\n').trim();
    if (!content) {
      renderLanChat();
      return;
    }
    lanChatSending = true;
    renderLanChat();
    try {
      await lanClient.sendChat(content);
      sourceInput.value = '';
      if (sourceInput !== el.lanChatInput) el.lanChatInput.value = '';
      if (sourceInput !== el.setupLanChatInput) el.setupLanChatInput.value = '';
    } catch (error) {
      showError(error);
    } finally {
      lanChatSending = false;
      renderLanChat();
      if (!sourceInput.disabled) sourceInput.focus();
    }
  }

  function bColorsFromA(aColors = playerAColors) {
    return COLORS.filter(color => !aColors.includes(color));
  }

  function ownProtectionColors() {
    return lanRole === 'B' ? bColorsFromA(playerAColors) : playerAColors.slice();
  }

  function setEquals(a, b) {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
  }

  function serverOwnProtectedSet(config = lanLobbyConfig) {
    const allowed = new Set(ownProtectionColors());
    const values = config && Array.isArray(config.protectedColors) ? config.protectedColors : [];
    return new Set(values.filter(color => allowed.has(color)));
  }

  function localOwnProtectedSet() {
    const allowed = new Set(ownProtectionColors());
    return new Set([...protectedColors].filter(color => allowed.has(color)));
  }

  function hasUnsubmittedProtection() {
    return Boolean(isLanMode() && lanConnected && lanRoomStatus === 'lobby' && !setEquals(localOwnProtectedSet(), serverOwnProtectedSet()));
  }

  async function submitLobbyProtection() {
    if (!isLanMode() || !lanConnected || lanRoomStatus !== 'lobby' || !lanClient || lanProtectionSubmitting) return;
    lanProtectionSubmitting = true;
    renderSetup();
    try {
      await lanClient.pausePollingBeforeRequest(600);
      await lanClient.setLobbyConfig(currentGameConfig());
    } catch (error) {
      showError(error);
    } finally {
      lanClient.resumePolling();
      lanProtectionSubmitting = false;
      renderSetup();
    }
  }

  function applyLobbyConfigToSetup(config) {
    if (!config || typeof config !== 'object' || !isLanMode() || lanRoomStatus !== 'lobby') return;
    if (lanRole !== 'A') {
      mode = config.mode === 'speed' ? 'speed' : 'classic';
      playerAColors = Array.isArray(config.playerAColors) ? config.playerAColors.filter(color => COLORS.includes(color)).slice(0, 2) : [];
      launchValues = new Set(Array.isArray(config.launchValues) ? config.launchValues.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 6) : [5, 6]);
      tripleSixPenaltyEnabled = config.tripleSixPenalty !== false;
      firstPlayer = mode === 'speed' ? (config.firstPlayer === 'B' ? 'B' : (config.firstPlayer === 'A' ? 'A' : null)) : 'A';
    }
    if (mode === 'speed') {
      firstPlayer = config.firstPlayer === 'B' ? 'B' : (config.firstPlayer === 'A' ? 'A' : null);
    }
    const allowed = lanRole === 'B' ? bColorsFromA(playerAColors) : playerAColors;
    const incomingProtected = Array.isArray(config.protectedColors) ? config.protectedColors.filter(color => COLORS.includes(color)) : [];
    const preserveOwnDraft = hasUnsubmittedProtection() || lanProtectionSubmitting;
    if (!preserveOwnDraft) {
      for (const color of allowed) {
        if (incomingProtected.includes(color)) protectedColors.add(color);
        else protectedColors.delete(color);
      }
    }
    const otherAllowed = COLORS.filter(color => !allowed.includes(color));
    for (const color of otherAllowed) {
      if (incomingProtected.includes(color)) protectedColors.add(color);
      else protectedColors.delete(color);
    }
  }

  function queueLobbyConfigSync() {
    if (!isLanMode() || !lanConnected || lanRoomStatus !== 'lobby' || !lanClient) return;
    const serial = ++lanLobbySyncSerial;
    lanLobbySyncPending = true;
    const config = currentGameConfig({ protectionSource: 'server' });
    window.clearTimeout(lanLobbySyncTimer);
    lanLobbySyncTimer = window.setTimeout(async () => {
      try {
        await lanClient.setLobbyConfig(config);
      } catch (error) {
        console.warn(error);
        showError(error);
      } finally {
        if (serial === lanLobbySyncSerial) {
          lanLobbySyncPending = false;
          renderSetup();
        }
      }
    }, 20);
  }

  function currentGameConfig(options = {}) {
    const useServerProtection = options.protectionSource === 'server' && lanLobbyConfig;
    return {
      mode,
      playerAColors: playerAColors.slice(),
      protectedColors: useServerProtection
        ? (Array.isArray(lanLobbyConfig.protectedColors) ? lanLobbyConfig.protectedColors.slice() : [])
        : [...protectedColors],
      launchValues: [...launchValues],
      tripleSixPenalty: tripleSixPenaltyEnabled,
      firstPlayer: mode === 'speed' ? firstPlayer : 'A'
    };
  }

  async function startLanGame() {
    if (!lanConnected || lanRole !== 'A' || lanRoomStatus !== 'lobby') {
      showError(new Error('只有已登录的玩家A可以开始联机对局。'));
      return;
    }
    if (!lanPlayerBReady) {
      showError(new Error('请等待玩家B准备。'));
      return;
    }
    interactionLocked = true;
    el.startGame.disabled = true;
    try {
      await lanClient.startGame(currentGameConfig());
    } catch (error) {
      showError(error);
      interactionLocked = false;
      renderSetup();
    }
  }

  async function setLanPlayerBReady() {
    if (!lanConnected || lanRole !== 'B' || lanRoomStatus !== 'lobby' || lanPlayerBReady || hasUnsubmittedProtection()) return;
    interactionLocked = true;
    el.startGame.disabled = true;
    try {
      await lanClient.setLobbyReady(true);
    } catch (error) {
      showError(error);
    } finally {
      interactionLocked = false;
      renderSetup();
    }
  }

  function lanActionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `${lanRole || 'X'}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function submitLanAction(actionCode) {
    if (!lanCanControlCurrentPlayer() || interactionLocked) return null;
    interactionLocked = true;
    hidePreview();
    renderGame();
    try {
      const authoritative = engine;
      if (!authoritative || lanRoomStatus !== 'playing' || authoritative.currentPlayerId !== lanRole) {
        throw new Error('当前不是你的回合。');
      }
      const numericAction = Number(actionCode);
      if (!Number.isInteger(numericAction) || numericAction < 0 || numericAction >= ActionProtocol.ACTION_SPACE) {
        throw new Error('动作编号无效。');
      }
      // 联机客户端只做宽松预判。交换动作只规范化两种颜色的编码顺序；
      // 复杂阶段、交换组合和边界规则仍全部由服务端权威判断。
      const normalizedAction = ActionProtocol.normalizeSwapAction(authoritative, numericAction);
      return await lanClient.action(normalizedAction, lanActionId());
    } catch (error) {
      if (error.code === 'STALE_STATE' && error.payload && error.payload.details) applyLanPayload(error.payload.details);
      showError(error);
      return null;
    } finally {
      interactionLocked = false;
      if (engine) renderGame();
    }
  }

  async function submitLanCommand(command) {
    if (!isLanMode() || !lanConnected || interactionLocked) return;
    interactionLocked = true;
    try {
      await lanClient.command(command);
    } catch (error) {
      showError(error);
    } finally {
      interactionLocked = false;
      if (engine) renderGame();
    }
  }

  function rotateBoard(delta) {
    boardRotation = (boardRotation + delta) % 360;
    if (boardRotation < 0) boardRotation += 360;
    applyBoardRotation();
  }

  function applyBoardRotation() {
    if (!el.board) return;
    el.board.style.setProperty('--board-rotation', `${boardRotation}deg`);
    el.board.style.setProperty('--confirm-counter-rotation', `${-boardRotation}deg`);
  }

  function cloneAiControllers(value) {
    return {
      A: value && value.A ? { modelId: value.A.modelId || AI_DEFAULT_MODEL } : null,
      B: value && value.B ? { modelId: value.B.modelId || AI_DEFAULT_MODEL } : null
    };
  }

  function modelLabel(modelId) {
    const option = window.DoubleFlightAI && window.DoubleFlightAI.modelOptions.find(item => item.id === modelId);
    return option ? option.label : modelId;
  }

  function isPlayerAi(playerId) {
    if (isLanMode()) return false;
    return Boolean(engine && engine.mode === 'classic' && aiControllers[playerId]);
  }

  function isCurrentPlayerAi() {
    return Boolean(engine && isPlayerAi(engine.currentPlayerId));
  }

  function setupOverlayVisible() {
    return Boolean(el.setupOverlay && !el.setupOverlay.classList.contains('hidden'));
  }

  function cancelAiLoop() {
    aiLoopToken += 1;
    aiLoopScheduled = false;
  }

  function canRunAiNow() {
    return Boolean(
      !isLanMode() && engine && engine.mode === 'classic' && !engine.gameOver && isCurrentPlayerAi() &&
      !setupOverlayVisible() && !interactionLocked && !pendingConfirmation && !pendingSwapOrderChoice &&
      el.aiControlModal.classList.contains('hidden') && el.defeatModal.classList.contains('hidden')
    );
  }

  function scheduleAiTurn() {
    if (!canRunAiNow() || aiLoopScheduled) return;
    const token = aiLoopToken;
    aiLoopScheduled = true;
    window.setTimeout(async () => {
      aiLoopScheduled = false;
      if (token !== aiLoopToken || !canRunAiNow()) return;
      try {
        const controller = aiControllers[engine.currentPlayerId];
        const decision = window.DoubleFlightAI.predict(controller.modelId, engine, openingRollPending);
        await executeAiAction(decision.action);
      } catch (error) {
        showError(new Error(`人机执行失败：${error.message}`));
        const playerId = engine && engine.currentPlayerId;
        if (playerId) aiControllers[playerId] = null;
        cancelAiLoop();
        renderGame();
        return;
      }
      if (token === aiLoopToken) scheduleAiTurn();
    }, AI_THINK_DELAY_MS);
  }

  async function executeAiAction(action) {
    if (!engine || !isCurrentPlayerAi()) return;
    if (action === 0) {
      await handleRoll({ ai: true });
      return;
    }
    if (action === 1) {
      await executePassTurn();
      return;
    }
    if (action >= 2 && action <= 3) {
      await executeDieSelection(action - 2);
      return;
    }
    if (action >= 4 && action <= 19) {
      const pieceId = window.DoubleFlightAI.pieceIdFromGlobal(action - 4);
      await commitMove(pieceId, assignmentCheckpoint || engine.serialize());
      return;
    }
    if (action >= 20 && action <= 275) {
      const packed = action - 20;
      const firstId = window.DoubleFlightAI.pieceIdFromGlobal(Math.floor(packed / 16));
      const secondId = window.DoubleFlightAI.pieceIdFromGlobal(packed % 16);
      await commitSwap([firstId, secondId], engine.serialize());
      return;
    }
    if (action >= 276 && action <= 291) {
      interactionLocked = true;
      hidePreview();
      try {
        const pieceId = window.DoubleFlightAI.pieceIdFromGlobal(action - 276);
        const events = engine.resolveSwapOrder(pieceId);
        await animateMovementEvents(events);
        if (engine.gameOver) showVictoryPopup();
      } finally {
        interactionLocked = false;
        renderGame();
      }
      return;
    }
    throw new Error(`未知人机动作：${action}`);
  }

  function openAiControlModal(playerId) {
    if (!engine || engine.mode === 'speed') return;
    aiModalPlayerId = playerId;
    el.aiControlTitle.textContent = `${engine.getPlayer(playerId).name}切换为人机`;
    el.runtimeAiModel.value = AI_DEFAULT_MODEL;
    el.aiControlModal.classList.remove('hidden');
  }

  function closeAiControlModal() {
    aiModalPlayerId = null;
    el.aiControlModal.classList.add('hidden');
  }

  function handlePlayerAiToggle(event) {
    if (isLanMode()) return;
    const button = event.target.closest('[data-ai-toggle-player]');
    if (!button || !engine || engine.mode === 'speed') return;
    const playerId = button.dataset.aiTogglePlayer;
    if (aiControllers[playerId]) {
      aiControllers[playerId] = null;
      cancelAiLoop();
      renderGame();
      return;
    }
    openAiControlModal(playerId);
  }

  function confirmRuntimeAiControl() {
    if (isLanMode()) return;
    if (!engine || !aiModalPlayerId || engine.mode === 'speed') return;
    aiControllers[aiModalPlayerId] = { modelId: el.runtimeAiModel.value || AI_DEFAULT_MODEL };
    closeAiControlModal();
    cancelAiLoop();
    renderGame();
    scheduleAiTurn();
  }

  function captureSuspendedGame() {
    return {
      mode,
      playerAColors: playerAColors.slice(),
      protectedColors: [...protectedColors],
      launchValues: [...launchValues],
      tripleSixPenaltyEnabled,
      orderRolls: cloneData(orderRolls),
      firstPlayer,
      openingRollPending,
      setupAiControllers: cloneAiControllers(setupAiControllers),
      aiControllers: cloneAiControllers(aiControllers),
      swapMode,
      swapSelection: swapSelection.slice(),
      secondConfirmEnabled,
      pendingConfirmation: pendingConfirmation ? cloneData(pendingConfirmation) : null,
      pendingSwapOrderChoice: pendingSwapOrderChoice ? cloneData(pendingSwapOrderChoice) : null,
      undoRecord: undoRecord ? cloneData(undoRecord) : null,
      assignmentCheckpoint: assignmentCheckpoint ? cloneData(assignmentCheckpoint) : null,
      expandedOverlapKey,
      lockedOverlapKey,
      victoryShownFor
    };
  }

  function returnToSuspendedGame() {
    if (!engine || !suspendedGame) return;
    const saved = suspendedGame;
    mode = saved.mode;
    playerAColors = saved.playerAColors.slice();
    protectedColors = new Set(saved.protectedColors);
    launchValues = new Set(saved.launchValues);
    tripleSixPenaltyEnabled = saved.tripleSixPenaltyEnabled;
    orderRolls = cloneData(saved.orderRolls);
    firstPlayer = saved.firstPlayer;
    openingRollPending = saved.openingRollPending;
    setupAiControllers = cloneAiControllers(saved.setupAiControllers);
    aiControllers = cloneAiControllers(saved.aiControllers);
    swapMode = Boolean(saved.swapMode);
    swapSelection = saved.swapSelection ? saved.swapSelection.slice() : [];
    secondConfirmEnabled = Boolean(saved.secondConfirmEnabled);
    pendingConfirmation = saved.pendingConfirmation ? cloneData(saved.pendingConfirmation) : null;
    pendingSwapOrderChoice = saved.pendingSwapOrderChoice ? cloneData(saved.pendingSwapOrderChoice) : null;
    undoRecord = saved.undoRecord ? cloneData(saved.undoRecord) : null;
    assignmentCheckpoint = saved.assignmentCheckpoint ? cloneData(saved.assignmentCheckpoint) : null;
    expandedOverlapKey = saved.expandedOverlapKey || null;
    lockedOverlapKey = saved.lockedOverlapKey || null;
    victoryShownFor = saved.victoryShownFor || null;
    suspendedGame = null;
    el.backToGame.classList.add('hidden');
    el.setupOverlay.classList.add('hidden');
    if (pendingConfirmation) {
      document.body.classList.add('pending-confirmation');
      if (pendingConfirmation.type === 'swap') startSwapConfirmationPreview(pendingConfirmation);
      else {
        const piece = engine.getPiece(pendingConfirmation.pieceId);
        if (piece) showPreview(piece.color, pendingConfirmation.preview);
      }
    }
    renderGame();
    if (engine.gameOver) {
      victoryShownFor = null;
      showVictoryPopup();
    } else {
      scheduleAiTurn();
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    Object.assign(el, {
      setupOverlay: byId('setupOverlay'),
      backToGame: byId('backToGame'),
      runtimeButtons: byId('runtimeButtons'),
      lanConnectPanel: byId('lanConnectPanel'),
      lanHost: byId('lanHost'),
      lanPort: byId('lanPort'),
      lanLoginCode: byId('lanLoginCode'),
      lanAutoSearchButton: byId('lanAutoSearchButton'),
      lanSmartInput: byId('lanSmartInput'),
      lanSmartApplyButton: byId('lanSmartApplyButton'),
      lanConnectButton: byId('lanConnectButton'),
      lanConnectionStatus: byId('lanConnectionStatus'),
      lanWaitingSection: byId('lanWaitingSection'),
      lanWaitingText: byId('lanWaitingText'),
      modeSection: byId('modeSection'),
      colorSection: byId('colorSection'),
      ruleSettingsSection: byId('ruleSettingsSection'),
      modeButtons: byId('modeButtons'),
      aiSetupSection: byId('aiSetupSection'),
      setupAiAEnabled: byId('setupAiAEnabled'),
      setupAiAModel: byId('setupAiAModel'),
      setupAiBEnabled: byId('setupAiBEnabled'),
      setupAiBModel: byId('setupAiBModel'),
      colorPicker: byId('colorPicker'),
      colorSummary: byId('colorSummary'),
      protectionSection: byId('protectionSection'),
      protectionChoices: byId('protectionChoices'),
      speedOrderSection: byId('speedOrderSection'),
      rollOrderA: byId('rollOrderA'),
      rollOrderB: byId('rollOrderB'),
      orderResultA: byId('orderResultA'),
      orderResultB: byId('orderResultB'),
      orderSummary: byId('orderSummary'),
      startGame: byId('startGame'),
      launchValueChoices: byId('launchValueChoices'),
      tripleSixPenalty: byId('tripleSixPenalty'),
      launchSummary: byId('launchSummary'),
      gameTitle: byId('gameTitle'),
      turnLabel: byId('turnLabel'),
      networkBadge: byId('networkBadge'),
      newGame: byId('newGame'),
      setupAboutButton: byId('setupAboutButton'),
      gameAboutButton: byId('gameAboutButton'),
      aboutModal: byId('aboutModal'),
      closeAboutButton: byId('closeAboutButton'),
      workspace: byId('workspace'),
      leftPanel: byId('leftPanel'),
      boardPanel: byId('boardPanel'),
      leftColumnResizer: byId('leftColumnResizer'),
      rightColumnResizer: byId('rightColumnResizer'),
      lanSpiritLayer: byId('lanSpiritLayer'),
      playerCards: byId('playerCards'),
      setupLanChatPanel: byId('setupLanChatPanel'),
      setupLanChatLog: byId('setupLanChatLog'),
      setupLanChatCount: byId('setupLanChatCount'),
      setupLanChatInput: byId('setupLanChatInput'),
      setupLanChatHint: byId('setupLanChatHint'),
      setupLanChatSend: byId('setupLanChatSend'),
      setupLanChatUnread: byId('setupLanChatUnread'),
      lanChatPanel: byId('lanChatPanel'),
      lanChatLog: byId('lanChatLog'),
      lanChatCount: byId('lanChatCount'),
      lanChatInput: byId('lanChatInput'),
      lanChatHint: byId('lanChatHint'),
      lanChatSend: byId('lanChatSend'),
      lanChatUnread: byId('lanChatUnread'),
      defeatLanChatPanel: byId('defeatLanChatPanel'),
      defeatLanChatLog: byId('defeatLanChatLog'),
      defeatLanChatCount: byId('defeatLanChatCount'),
      defeatLanChatInput: byId('defeatLanChatInput'),
      defeatLanChatHint: byId('defeatLanChatHint'),
      defeatLanChatSend: byId('defeatLanChatSend'),
      defeatLanChatUnread: byId('defeatLanChatUnread'),
      undoRequestModal: byId('undoRequestModal'),
      undoRequestText: byId('undoRequestText'),
      rejectUndoRequest: byId('rejectUndoRequest'),
      allowUndoRequest: byId('allowUndoRequest'),
      undoLanChatPanel: byId('undoLanChatPanel'),
      undoLanChatLog: byId('undoLanChatLog'),
      undoLanChatCount: byId('undoLanChatCount'),
      undoLanChatInput: byId('undoLanChatInput'),
      undoLanChatHint: byId('undoLanChatHint'),
      undoLanChatSend: byId('undoLanChatSend'),
      undoLanChatUnread: byId('undoLanChatUnread'),
      currentOperator: byId('currentOperator'),
      turnInteractionPanel: byId('turnInteractionPanel'),
      diceRow: byId('diceRow'),
      die0: byId('die0'),
      die1: byId('die1'),
      rollButton: byId('rollButton'),
      swapButton: byId('swapButton'),
      nextPlayerButton: byId('nextPlayerButton'),
      secondConfirm: byId('secondConfirm'),
      undoActionButton: byId('undoActionButton'),
      confirmActionButton: byId('confirmActionButton'),
      confirmationArrowLayer: byId('confirmationArrowLayer'),
      confirmationArrowGroup: byId('confirmationArrowGroup'),
      board: byId('board'),
      rotateBoardLeft: byId('rotateBoardLeft'),
      rotateBoardRight: byId('rotateBoardRight'),
      statusToast: byId('statusToast'),
      boardSvg: byId('boardSvg'),
      pieceLayer: byId('pieceLayer'),
      previewPiece: byId('previewPiece'),
      previewGhost: byId('previewGhost'),
      timingControls: byId('timingControls'),
      loopWaitMs: byId('loopWaitMs'),
      stepDurationMs: byId('stepDurationMs'),
      specialDurationMs: byId('specialDurationMs'),
      stageWaitMs: byId('stageWaitMs'),
      colorControls: byId('colorControls'),
      resetPalette: byId('resetPalette'),
      copyPalette: byId('copyPalette'),
      defeatModal: byId('defeatModal'),
      defeatText: byId('defeatText'),
      undoDefeat: byId('undoDefeat'),
      acceptDefeat: byId('acceptDefeat'),
      victoryModal: byId('victoryModal'),
      victoryText: byId('victoryText'),
      replayGame: byId('replayGame'),
      continueGame: byId('continueGame'),
      aiControlModal: byId('aiControlModal'),
      aiControlTitle: byId('aiControlTitle'),
      runtimeAiModel: byId('runtimeAiModel'),
      cancelAiControl: byId('cancelAiControl'),
      confirmAiControl: byId('confirmAiControl'),
      gameLog: byId('gameLog'),
      logCount: byId('logCount')
    });

    lanClient = new window.DoubleFlightNetwork.LanClient({
      intervalMs: 1000,
      requestTimeoutMs: 10000,
      pollTimeoutMs: 35000,
      onState: applyLanPayload,
      onStatus: handleLanNetworkStatus,
      onSessionInvalid: handleLanSessionInvalid
    });
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      el.lanHost.value = location.origin || location.hostname || '';
      el.lanPort.value = '';
    }

    buildTimingControls();
    buildPaletteControls();
    applyPalette();
    applyTimingSettings();
    drawBoard();
    applyBoardRotation();
    bindSetup();
    bindGameControls();
    initChatPanelResizers();
    initWorkspaceResizers();
    renderSetup();
    applyInviteFromPageUrl();
  });

  function rgbString(value) {
    return `rgb(${Math.round(value[0])}, ${Math.round(value[1])}, ${Math.round(value[2])})`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function rgbToHex(value) {
    return `#${value.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
  }

  function rgbToHsl(value) {
    let [r, g, b] = value.map(channel => clamp(channel, 0, 255) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    if (max === min) return [0, 0, lightness * 100];
    const delta = max - min;
    const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let hue;
    if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0));
    else if (max === g) hue = ((b - r) / delta + 2);
    else hue = ((r - g) / delta + 4);
    return [hue * 60, saturation * 100, lightness * 100];
  }

  function hslToRgb(value) {
    let [h, s, l] = value;
    h = ((Number(h) % 360) + 360) % 360 / 360;
    s = clamp(Number(s), 0, 100) / 100;
    l = clamp(Number(l), 0, 100) / 100;
    if (s === 0) {
      const channel = l * 255;
      return [channel, channel, channel];
    }
    const hueToRgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      hueToRgb(p, q, h + 1 / 3) * 255,
      hueToRgb(p, q, h) * 255,
      hueToRgb(p, q, h - 1 / 3) * 255
    ];
  }

  function parseColorText(text) {
    const value = String(text).trim();
    const hex = value.match(/^#([0-9a-f]{6})$/i);
    if (hex) return [0, 2, 4].map(offset => parseInt(hex[1].slice(offset, offset + 2), 16));
    const rgb = value.match(/^rgb\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)$/i);
    if (rgb) return [clamp(Number(rgb[1]), 0, 255), clamp(Number(rgb[2]), 0, 255), clamp(Number(rgb[3]), 0, 255)];
    const hsl = value.match(/^hsl\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*\)$/i);
    if (hsl) return hslToRgb([Number(hsl[1]), Number(hsl[2]), Number(hsl[3])]);
    return null;
  }

  function buildTimingControls() {
    const inputs = [
      [el.loopWaitMs, 'loopWaitMs'],
      [el.stepDurationMs, 'stepDurationMs'],
      [el.specialDurationMs, 'specialDurationMs'],
      [el.stageWaitMs, 'stageWaitMs']
    ];
    inputs.forEach(([input, key]) => {
      input.value = String(timing[key]);
      input.addEventListener('input', () => {
        const parsed = Number(input.value);
        if (!Number.isFinite(parsed)) return;
        timing[key] = clamp(Math.round(parsed), 0, 5000);
        input.value = String(timing[key]);
        applyTimingSettings();
      });
    });
  }

  function applyTimingSettings() {
    const root = document.documentElement;
    root.style.setProperty('--step-ms', `${timing.stepDurationMs}ms`);
    root.style.setProperty('--special-ms', `${timing.specialDurationMs}ms`);
  }

  function stageDuration(stageType) {
    return stageType === 'move' ? timing.stepDurationMs : timing.specialDurationMs;
  }

  function buildPaletteControls() {
    const channels = [
      ['R', 'r', 0, 255], ['G', 'g', 0, 255], ['B', 'b', 0, 255],
      ['H', 'h', 0, 359], ['S', 's', 0, 100], ['L', 'l', 0, 100]
    ];
    el.colorControls.innerHTML = Object.entries(PALETTE_DEFAULTS).map(([key, item]) => `
      <div class="color-control" data-palette-key="${key}">
        <div class="color-control-title"><span class="color-swatch"></span><span>${item.label}</span></div>
        <input class="color-value-input" type="text" spellcheck="false" aria-label="${item.label}颜色值">
        <div class="channel-sliders">
          ${channels.map(([label, channel, min, max]) => `
            <label class="channel-slider"><span>${label}</span><input type="range" data-channel="${channel}" min="${min}" max="${max}" step="1"></label>
          `).join('')}
        </div>
      </div>
    `).join('');

    el.colorControls.addEventListener('input', event => {
      const row = event.target.closest('[data-palette-key]');
      if (!row) return;
      const key = row.dataset.paletteKey;
      if (event.target.classList.contains('color-value-input')) {
        const parsed = parseColorText(event.target.value);
        if (!parsed) {
          event.target.setAttribute('aria-invalid', 'true');
          return;
        }
        event.target.removeAttribute('aria-invalid');
        palette[key] = parsed;
      } else if (event.target.matches('input[type="range"][data-channel]')) {
        const channel = event.target.dataset.channel;
        const numeric = Number(event.target.value);
        if (['r', 'g', 'b'].includes(channel)) {
          const index = { r: 0, g: 1, b: 2 }[channel];
          palette[key][index] = numeric;
        } else {
          const hsl = rgbToHsl(palette[key]);
          const index = { h: 0, s: 1, l: 2 }[channel];
          hsl[index] = numeric;
          palette[key] = hslToRgb(hsl);
        }
      } else {
        return;
      }
      applyPalette();
      refreshPaletteControls(key);
      drawBoard();
      if (engine) renderGame(); else renderSetup();
    });
    refreshPaletteControls();
  }

  function refreshPaletteControls(onlyKey) {
    const rows = onlyKey
      ? [el.colorControls.querySelector(`[data-palette-key="${onlyKey}"]`)]
      : [...el.colorControls.querySelectorAll('[data-palette-key]')];
    rows.filter(Boolean).forEach(row => {
      const key = row.dataset.paletteKey;
      const value = palette[key];
      const hsl = rgbToHsl(value);
      row.style.setProperty('--swatch', rgbString(value));
      const textInput = row.querySelector('.color-value-input');
      if (document.activeElement !== textInput || !textInput.hasAttribute('aria-invalid')) {
        textInput.value = rgbToHex(value);
      }
      row.querySelectorAll('input[type="range"][data-channel]').forEach(input => {
        const channel = input.dataset.channel;
        const valueByChannel = {
          r: value[0], g: value[1], b: value[2],
          h: hsl[0], s: hsl[1], l: hsl[2]
        };
        input.value = Math.round(valueByChannel[channel]);
      });
    });
  }

  function applyPalette() {
    const root = document.documentElement;
    COLORS.forEach(color => {
      const piece = rgbString(palette[`${color}Piece`]);
      const cell = rgbString(palette[`${color}Cell`]);
      const airport = rgbString(palette[`${color}Airport`]);
      COLOR_HEX[color] = piece;
      root.style.setProperty(`--${color}`, piece);
      root.style.setProperty(`--${color}-piece`, piece);
      root.style.setProperty(`--${color}-cell`, cell);
      root.style.setProperty(`--${color}-airport`, airport);
    });
  }

  async function copyPalette() {
    const output = {};
    Object.entries(PALETTE_DEFAULTS).forEach(([key, item]) => {
      const rgb = palette[key].map(channel => Math.round(channel));
      const hsl = rgbToHsl(rgb).map(channel => Math.round(channel));
      output[item.label] = {
        HEX: rgbToHex(rgb),
        RGB: `rgb(${rgb.join(', ')})`,
        HSL: `hsl(${hsl[0]}, ${hsl[1]}%, ${hsl[2]}%)`
      };
    });
    const text = JSON.stringify(output, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    const original = el.copyPalette.textContent;
    el.copyPalette.textContent = '已复制全部颜色';
    window.setTimeout(() => { el.copyPalette.textContent = original; }, 1200);
  }

  function resetPalette() {
    Object.entries(PALETTE_DEFAULTS).forEach(([key, item]) => { palette[key] = item.value.slice(); });
    timing.loopWaitMs = 250;
    timing.stepDurationMs = 300;
    timing.specialDurationMs = 300;
    timing.stageWaitMs = 100;
    el.loopWaitMs.value = '250';
    el.stepDurationMs.value = '300';
    el.specialDurationMs.value = '300';
    el.stageWaitMs.value = '100';
    applyTimingSettings();
    applyPalette();
    refreshPaletteControls();
    drawBoard();
    if (engine) renderGame(); else renderSetup();
  }

  function bindSetup() {
    el.runtimeButtons.addEventListener('click', event => {
      const button = event.target.closest('[data-runtime-mode]');
      if (!button) return;
      const nextMode = button.dataset.runtimeMode;
      if (nextMode === runtimeMode) return;
      if (runtimeMode === 'lan' && lanClient && lanConnected) lanClient.logout();
      runtimeMode = nextMode === 'lan' ? 'lan' : 'local';
      document.body.classList.toggle('lan-mode', isLanMode());
    if (el.turnInteractionPanel && (!engine || !isLanMode() || !lanConnected)) el.turnInteractionPanel.classList.remove('your-turn');
      if (!isLanMode()) {
        lanConnected = false;
        lanRole = null;
        lanRoomStatus = 'closed';
        lanPlayerBReady = false;
        setLanStatus('尚未连接。');
        lanChatVersion = -1;
        lanChatMessages = [];
        lanVisualVersion = -1;
        lanVisualRoomStatus = 'closed';
        lanVisualQueue = Promise.resolve();
        lanAnimationActive = false;
      }
      engine = null;
      el.setupOverlay.classList.remove('hidden');
      renderSetup();
    });
    el.lanConnectButton.addEventListener('click', connectLan);
    el.lanAutoSearchButton.addEventListener('click', autoSearchLanIp);
    el.lanSmartApplyButton.addEventListener('click', applySmartLanInput);
    el.lanLoginCode.addEventListener('input', () => {
      el.lanLoginCode.value = el.lanLoginCode.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 7);
    });
    el.lanLoginCode.addEventListener('keydown', event => {
      if (event.key === 'Enter') connectLan();
    });
    const clearUnreadAndScroll = ref => {
      ref.panel.dataset.unreadCount = '0';
      ref.panel.dataset.followBottom = 'true';
      const scrollToBottom = () => { ref.log.scrollTop = Math.max(0, ref.log.scrollHeight - ref.log.clientHeight); };
      scrollToBottom();
      window.requestAnimationFrame(scrollToBottom);
      if (ref.unread) ref.unread.classList.add('hidden');
    };
    chatPanelRefs().forEach(ref => {
      if (ref.unread) ref.unread.addEventListener('click', () => clearUnreadAndScroll(ref));
      ref.log.addEventListener('scroll', () => {
        const atBottom = ref.log.scrollHeight - ref.log.clientHeight - ref.log.scrollTop < 24;
        ref.panel.dataset.followBottom = atBottom ? 'true' : 'false';
        if (atBottom) {
          ref.panel.dataset.unreadCount = '0';
          if (ref.unread) ref.unread.classList.add('hidden');
        }
      }, { passive: true });
    });
    chatPanelRefs().forEach(ref => {
      ref.input.addEventListener('input', renderLanChat);
      ref.hint.addEventListener('click', toggleLanChatSendKeyMode);
      ref.send.addEventListener('click', sendLanChat);
      ref.input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        const shouldSend = lanChatSendKeyMode === 'enter' ? !event.shiftKey : event.shiftKey;
        if (!shouldSend) return;
        event.preventDefault();
        sendLanChat();
      });
    });

    el.modeButtons.addEventListener('click', event => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      mode = button.dataset.mode;
      orderRolls = { A: null, B: null };
      firstPlayer = mode === 'classic' ? 'A' : null;
      protectedColors.clear();
      renderSetup();
      queueLobbyConfigSync();
    });

    const syncSetupAi = playerId => {
      const enabled = playerId === 'A' ? el.setupAiAEnabled : el.setupAiBEnabled;
      const select = playerId === 'A' ? el.setupAiAModel : el.setupAiBModel;
      setupAiControllers[playerId] = enabled.checked ? { modelId: select.value || AI_DEFAULT_MODEL } : null;
      renderSetup();
    };
    el.setupAiAEnabled.addEventListener('change', () => syncSetupAi('A'));
    el.setupAiBEnabled.addEventListener('change', () => syncSetupAi('B'));
    el.setupAiAModel.addEventListener('change', () => syncSetupAi('A'));
    el.setupAiBModel.addEventListener('change', () => syncSetupAi('B'));
    el.backToGame.addEventListener('click', returnToSuspendedGame);

    el.colorPicker.addEventListener('click', event => {
      const button = event.target.closest('[data-color]');
      if (!button) return;
      const color = button.dataset.color;
      if (playerAColors.includes(color)) {
        playerAColors = playerAColors.filter(item => item !== color);
      } else if (playerAColors.length < 2) {
        playerAColors.push(color);
      }
      protectedColors.clear();
      orderRolls = { A: null, B: null };
      firstPlayer = mode === 'classic' ? 'A' : null;
      renderSetup();
      queueLobbyConfigSync();
    });

    el.protectionChoices.addEventListener('change', event => {
      const input = event.target.closest('input[data-protect-color]');
      if (!input) return;
      if (input.checked) protectedColors.add(input.dataset.protectColor);
      else protectedColors.delete(input.dataset.protectColor);
      renderSetup();
    });

    el.protectionChoices.addEventListener('click', event => {
      const button = event.target.closest('[data-submit-protection]');
      if (!button) return;
      submitLobbyProtection();
    });

    el.launchValueChoices.addEventListener('change', event => {
      const input = event.target.closest('input[type="checkbox"]');
      if (!input) return;
      const value = Number(input.value);
      if (input.checked) launchValues.add(value);
      else launchValues.delete(value);
      if (launchValues.size === 0) {
        launchValues.add(value);
        input.checked = true;
        showError(new Error('至少保留一个起飞点数。'));
      }
      renderSetup();
      queueLobbyConfigSync();
    });
    el.tripleSixPenalty.addEventListener('change', () => {
      tripleSixPenaltyEnabled = el.tripleSixPenalty.checked;
      renderSetup();
      queueLobbyConfigSync();
    });

    el.rollOrderA.addEventListener('click', () => rollStartingOrder('A'));
    el.rollOrderB.addEventListener('click', () => rollStartingOrder('B'));
    el.startGame.addEventListener('click', startGame);
  }

  function bindGameControls() {
    const openAbout = () => el.aboutModal.classList.remove('hidden');
    const closeAbout = () => el.aboutModal.classList.add('hidden');
    el.newGame.addEventListener('click', resetToSetup);
    el.setupAboutButton.addEventListener('click', openAbout);
    el.gameAboutButton.addEventListener('click', openAbout);
    el.closeAboutButton.addEventListener('click', closeAbout);
    el.aboutModal.addEventListener('click', event => { if (event.target === el.aboutModal) closeAbout(); });
    el.playerCards.addEventListener('click', handlePlayerAiToggle);
    el.cancelAiControl.addEventListener('click', closeAiControlModal);
    el.confirmAiControl.addEventListener('click', confirmRuntimeAiControl);
    el.rotateBoardLeft.addEventListener('click', () => rotateBoard(-90));
    el.rotateBoardRight.addEventListener('click', () => rotateBoard(90));
    el.rollButton.addEventListener('click', handleRoll);
    el.swapButton.addEventListener('click', toggleSwapMode);
    el.nextPlayerButton.addEventListener('click', handlePassTurn);
    el.secondConfirm.addEventListener('change', handleSecondConfirmChange);
    el.undoActionButton.addEventListener('click', handleUndoAction);
    el.rejectUndoRequest.addEventListener('click', () => respondLanUndoRequest(false));
    el.allowUndoRequest.addEventListener('click', () => respondLanUndoRequest(true));
    el.confirmActionButton.addEventListener('click', handleConfirmAction);
    el.diceRow.addEventListener('click', handleDieClick);
    el.pieceLayer.addEventListener('click', handlePieceClick);
    el.pieceLayer.addEventListener('pointerover', handlePieceHover);
    el.pieceLayer.addEventListener('pointerout', handlePieceOut);
    el.board.addEventListener('click', handleBoardClick);
    el.board.addEventListener('pointermove', handleBoardPointerMove);
    el.board.addEventListener('pointerleave', handleBoardPointerLeave);
    el.resetPalette.addEventListener('click', resetPalette);
    el.copyPalette.addEventListener('click', copyPalette);
    el.undoDefeat.addEventListener('click', handleDefeatUndo);
    el.acceptDefeat.addEventListener('click', handleDefeatAccept);
    el.replayGame.addEventListener('click', handleReplayGame);
    el.continueGame.addEventListener('click', handleContinueGame);
  }

  function renderSetup() {
    [...el.runtimeButtons.querySelectorAll('[data-runtime-mode]')].forEach(button => {
      button.classList.toggle('active', button.dataset.runtimeMode === runtimeMode);
    });
    document.body.classList.toggle('lan-mode', isLanMode());
    if (el.turnInteractionPanel && (!engine || !isLanMode() || !lanConnected)) el.turnInteractionPanel.classList.remove('your-turn');
    el.lanConnectPanel.classList.toggle('hidden', !isLanMode());
    if (el.networkBadge) {
      el.networkBadge.textContent = lanBadgeText();
      el.networkBadge.classList.toggle('online', isLanMode() && lanConnected);
      el.networkBadge.classList.toggle('offline', isLanMode() && !lanConnected);
    }

    const lanPlayerASetup = isLanMode() && lanConnected && lanRole === 'A' && lanRoomStatus === 'lobby';
    const lanPlayerBSetup = isLanMode() && lanConnected && lanRole === 'B' && lanRoomStatus === 'lobby';
    const localSetup = !isLanMode();
    const showGameConfig = localSetup || lanPlayerASetup;
    const showBProtection = lanPlayerBSetup && playerAColors.length === 2 && mode === 'classic';
    [el.modeSection, el.colorSection, el.ruleSettingsSection]
      .filter(Boolean)
      .forEach(section => section.classList.toggle('hidden', !showGameConfig));
    el.protectionSection.classList.toggle('hidden', !(showGameConfig || showBProtection));
    el.lanWaitingSection.classList.toggle('hidden', !lanPlayerBSetup);
    if (lanPlayerBSetup) {
      const tip = playerAColors.length === 2
        ? (lanPlayerBReady ? '你已准备，等待玩家A开始。' : '玩家A已选择颜色，请设置保护并点击准备。')
        : '等待玩家A完成颜色选择。';
      el.lanWaitingText.textContent = `已登录为玩家B，${tip} A：${lanConnectedPlayers.A ? '在线' : '未登录'}，B：在线。`;
    }

    [...el.modeButtons.querySelectorAll('[data-mode]')].forEach(button => {
      button.classList.toggle('active', button.dataset.mode === mode);
    });
    [...el.colorPicker.querySelectorAll('[data-color]')].forEach(button => {
      button.classList.toggle('selected', playerAColors.includes(button.dataset.color));
    });

    if (playerAColors.length === 2) {
      const bColors = COLORS.filter(color => !playerAColors.includes(color));
      el.colorSummary.innerHTML = `玩家A：${playerAColors.map(colorTextWithDot).join('、')}<br>玩家B：${bColors.map(colorTextWithDot).join('、')}`;
      renderProtectionChoices(playerAColors, bColors);
    } else {
      el.colorSummary.textContent = '玩家A尚未选满两个颜色。';
      el.protectionChoices.innerHTML = '';
      delete el.protectionChoices.dataset.renderSignature;
    }

    [...el.launchValueChoices.querySelectorAll('input[type="checkbox"]')].forEach(input => {
      input.checked = launchValues.has(Number(input.value));
    });
    el.tripleSixPenalty.checked = tripleSixPenaltyEnabled;
    el.launchSummary.textContent = `起飞点数：${[...launchValues].sort((a, b) => a - b).join('、')}`;

    const speed = mode === 'speed';
    el.aiSetupSection.classList.toggle('hidden', speed || isLanMode() || !showGameConfig);
    el.setupAiAEnabled.checked = Boolean(setupAiControllers.A);
    el.setupAiBEnabled.checked = Boolean(setupAiControllers.B);
    el.setupAiAModel.value = setupAiControllers.A ? setupAiControllers.A.modelId : AI_DEFAULT_MODEL;
    el.setupAiBModel.value = setupAiControllers.B ? setupAiControllers.B.modelId : AI_DEFAULT_MODEL;
    el.setupAiAModel.disabled = speed || !el.setupAiAEnabled.checked;
    el.setupAiBModel.disabled = speed || !el.setupAiBEnabled.checked;
    el.setupAiAEnabled.disabled = speed;
    el.setupAiBEnabled.disabled = speed;
    if (showGameConfig || showBProtection) el.protectionSection.classList.toggle('hidden', speed && !showBProtection);
    const showSpeedOrder = speed && (showGameConfig || lanPlayerBSetup);
    el.speedOrderSection.classList.toggle('hidden', !showSpeedOrder);
    el.orderResultA.textContent = formatOrderRoll(orderRolls.A);
    el.orderResultB.textContent = formatOrderRoll(orderRolls.B);
    [el.rollOrderA, el.rollOrderB].forEach((button, index) => {
      const playerId = index === 0 ? 'A' : 'B';
      const ownLanButton = isLanMode() && lanConnected && lanRoomStatus === 'lobby' && lanRole === playerId;
      button.classList.toggle('own-roll', ownLanButton);
      button.classList.toggle('rolled', Boolean(orderRolls[playerId]));
      if (isLanMode()) {
        button.disabled = !showSpeedOrder || !ownLanButton || Boolean(orderRolls[playerId]) || interactionLocked;
      } else {
        button.disabled = !showSpeedOrder || Boolean(orderRolls[playerId]);
      }
    });

    if (speed) {
      if (firstPlayer) {
        const tied = orderRolls.A && orderRolls.B && sum(orderRolls.A) === sum(orderRolls.B);
        el.orderSummary.textContent = tied
          ? `点数和相同，服务端自动加赛后由${firstPlayer === 'A' ? '玩家A' : '玩家B'}先手。`
          : `${firstPlayer === 'A' ? '玩家A' : '玩家B'}先手。`;
      } else if (orderRolls.A && !orderRolls.B) {
        el.orderSummary.textContent = '玩家A已投掷，等待玩家B。';
      } else if (!orderRolls.A && orderRolls.B) {
        el.orderSummary.textContent = '玩家B已投掷，等待玩家A。';
      } else {
        el.orderSummary.textContent = '双方各投掷一次，点数较大者先手。';
      }
    }
    const baseInvalid = playerAColors.length !== 2 || launchValues.size === 0 || (speed && !firstPlayer);
    const lanLobbyRole = isLanMode() && lanConnected && lanRoomStatus === 'lobby' && (lanRole === 'A' || lanRole === 'B');
    el.startGame.classList.toggle('hidden', isLanMode() && !lanLobbyRole);
    if (!isLanMode()) {
      el.startGame.textContent = '开始游戏';
      el.startGame.disabled = baseInvalid;
    } else if (lanRole === 'B') {
      el.startGame.textContent = lanPlayerBReady ? '已准备' : '准备';
      const bReadyInvalid = playerAColors.length !== 2 || launchValues.size === 0 || (speed && !orderRolls.B);
      el.startGame.disabled = bReadyInvalid || hasUnsubmittedProtection() || lanPlayerBReady || interactionLocked;
    } else {
      el.startGame.textContent = lanPlayerBReady ? '开始联机游戏' : '等待玩家B准备';
      el.startGame.disabled = baseInvalid || hasUnsubmittedProtection() || !lanPlayerBReady || interactionLocked;
    }
    el.launchSummary.classList.toggle('hidden', !showGameConfig);
    el.backToGame.classList.toggle('hidden', isLanMode() || !suspendedGame);
    renderLanChat();
  }

  function renderProtectionChoices(aColors, bColors) {
    let groups = [
      ['玩家A', aColors],
      ['玩家B', bColors]
    ];
    if (isLanMode() && lanRoomStatus === 'lobby') {
      groups = lanRole === 'B' ? [['玩家B', bColors]] : [['玩家A', aColors]];
    }
    const signature = JSON.stringify({ lan: isLanMode(), role: lanRole, groups });
    if (el.protectionChoices.dataset.renderSignature !== signature) {
      el.protectionChoices.dataset.renderSignature = signature;
      el.protectionChoices.innerHTML = groups.map(([name, colors]) => `
        <div class="protection-group">
          <div class="protection-group-heading">
            <strong>${name}</strong>
            ${isLanMode() ? '<span class="protection-unsaved hidden" data-protection-unsaved>当前设置未提交，请点击提交</span>' : ''}
            ${isLanMode() ? '<button type="button" class="ghost-btn protection-submit" data-submit-protection>提交</button>' : ''}
          </div>
          ${colors.map(color => `
            <label class="protection-option">
              <input type="checkbox" data-protect-color="${color}">
              <span class="color-dot" style="background:${COLOR_HEX[color]}"></span>
              ${COLOR_TEXT[color]}永久保护
            </label>
          `).join('')}
        </div>
      `).join('');
    }
    const dirty = hasUnsubmittedProtection();
    const lockBReady = isLanMode() && lanRole === 'B' && lanPlayerBReady;
    el.protectionChoices.querySelectorAll('input[data-protect-color]').forEach(input => {
      input.checked = protectedColors.has(input.dataset.protectColor);
      input.disabled = lanProtectionSubmitting || lockBReady;
    });
    el.protectionChoices.querySelectorAll('[data-protection-unsaved]').forEach(node => {
      node.classList.toggle('hidden', !dirty);
    });
    el.protectionChoices.querySelectorAll('[data-submit-protection]').forEach(button => {
      button.disabled = lanProtectionSubmitting || lockBReady || !dirty;
      button.textContent = lanProtectionSubmitting ? '提交中…' : (lockBReady ? '已准备' : '提交');
    });
  }

  async function rollStartingOrder(playerId) {
    if (mode !== 'speed') return;
    if (isLanMode()) {
      if (!lanConnected || lanRoomStatus !== 'lobby' || !lanClient || lanRole !== playerId || orderRolls[playerId] || interactionLocked) return;
      interactionLocked = true;
      renderSetup();
      try {
        await lanClient.rollLobbyOrder();
      } catch (error) {
        showError(error);
      } finally {
        interactionLocked = false;
        renderSetup();
      }
      return;
    }
    if (playerAColors.length !== 2) {
      el.orderSummary.textContent = '请先完成颜色选择。';
      return;
    }
    if (orderRolls[playerId]) return;
    orderRolls[playerId] = [randomDie(), randomDie()];
    if (orderRolls.A && orderRolls.B) {
      const a = sum(orderRolls.A);
      const b = sum(orderRolls.B);
      if (a === b) {
        firstPlayer = Math.random() < .5 ? 'A' : 'B';
      } else {
        firstPlayer = a > b ? 'A' : 'B';
      }
    }
    renderSetup();
  }

  async function startGame() {
    if (playerAColors.length !== 2) return;
    if (isLanMode()) {
      if (lanRole === 'B') await setLanPlayerBReady();
      else await startLanGame();
      return;
    }
    try {
      engine = new DoubleFlightEngine(currentGameConfig());
      aiControllers = mode === 'classic' ? cloneAiControllers(setupAiControllers) : { A: null, B: null };
      suspendedGame = null;
      el.backToGame.classList.add('hidden');
      cancelAiLoop();
      swapMode = false;
      swapSelection = [];
      interactionLocked = false;
      openingRollPending = mode === 'classic';
      victoryShownFor = null;
      expandedOverlapKey = null;
      lockedOverlapKey = null;
      pendingConfirmation = null;
      pendingSwapOrderChoice = null;
      confirmationAnimationToken += 1;
      undoRecord = null;
        assignmentCheckpoint = null;
      document.body.classList.remove('pending-confirmation');
      if (el.confirmActionButton) el.confirmActionButton.classList.add('hidden');
      closeVictoryPopup();
      el.setupOverlay.classList.add('hidden');
      createPieceElements();
      renderGame();
      scheduleAiTurn();
    } catch (error) {
      el.colorSummary.textContent = error.message;
    }
  }

  function resetToSetup() {
    if (isLanMode()) {
      showError(new Error('联机对局请在服务端管理页点击“重新回到开局设置”。'));
      return;
    }
    if (interactionLocked) {
      showError(new Error('当前动画尚未结束，请稍后再重新开局。'));
      return;
    }
    if (engine) suspendedGame = captureSuspendedGame();
    cancelAiLoop();
    closeAiControlModal();
    swapMode = false;
    swapSelection = [];
    interactionLocked = false;
    victoryShownFor = null;
    expandedOverlapKey = null;
    lockedOverlapKey = null;
    pendingConfirmation = null;
    pendingSwapOrderChoice = null;
    confirmationAnimationToken += 1;
    undoRecord = null;
    assignmentCheckpoint = null;
    document.body.classList.remove('pending-confirmation');
    if (el.confirmActionButton) el.confirmActionButton.classList.add('hidden');
    closeVictoryPopup();
    hidePreview();

    // Prepare a fresh setup without destroying the current engine. The player can
    // use the top-left button to return to the untouched original position.
    playerAColors = [];
    protectedColors.clear();
    orderRolls = { A: null, B: null };
    firstPlayer = mode === 'classic' ? 'A' : null;
    setupAiControllers = { A: null, B: null };
    el.backToGame.classList.toggle('hidden', !suspendedGame);
    el.setupOverlay.classList.remove('hidden');
    renderSetup();
  }

  function clearUndoRecord() {
    undoRecord = null;
    assignmentCheckpoint = null;
  }

  function stopConfirmationPreview() {
    confirmationAnimationToken += 1;
    previewAnimationToken += 1;
    el.previewPiece.classList.add('hidden');
    el.previewGhost.classList.add('hidden');
    [...el.pieceLayer.querySelectorAll('.preview-capture-ghost, .preview-swap-ghost')].forEach(node => node.remove());
    el.confirmActionButton.classList.add('hidden');
    renderConfirmationArrows();
    document.body.classList.remove('pending-confirmation');
  }

  function cancelPendingConfirmation() {
    if (!pendingConfirmation) return null;
    const pending = pendingConfirmation;
    pendingConfirmation = null;
    stopConfirmationPreview();
    if (pending.type === 'move') {
      // Cancellation keeps the selected die. Only the selected piece is cleared.
      engine.restore(pending.selectionSnapshot);
      assignmentCheckpoint = pending.commitSnapshot;
    } else if (pending.type === 'swap') {
      engine.restore(pending.snapshot);
      assignmentCheckpoint = null;
    }
    pendingSwapOrderChoice = null;
    swapMode = false;
    swapSelection = [];
    renderGame();
    return pending.type;
  }

  function beginMoveConfirmation(pieceId) {
    window.clearTimeout(overlapCollapseTimer);
    overlapCollapseTimer = null;
    const preview = engine.previewSelectedPiece(pieceId);
    if (!preview) return false;
    const piece = engine.getPiece(pieceId);
    pendingConfirmation = {
      type: 'move',
      pieceId,
      // commitSnapshot is the state before the die assignment and is used by Undo.
      commitSnapshot: assignmentCheckpoint || engine.serialize(),
      // selectionSnapshot is after the die was selected and is used by Cancel.
      selectionSnapshot: engine.serialize(),
      preview
    };
    document.body.classList.add('pending-confirmation');
    el.confirmActionButton.classList.remove('hidden');
    showPreview(piece.color, preview);
    renderGame();
    return true;
  }

  function simulateSwap(pieceIds) {
    const snapshot = engine.serialize();
    const startLocations = pieceIds.map(id => cloneData(engine.getPiece(id).location));
    let endLocations = [];
    let plan;
    try {
      engine.beginSwap(pieceIds[0], pieceIds[1]);
      endLocations = pieceIds.map(id => cloneData(engine.getPiece(id).location));
      plan = cloneData(engine.analyzePendingSwap());
    } finally {
      engine.restore(snapshot);
    }
    return { pieceIds: pieceIds.slice(), snapshot, startLocations, endLocations, plan };
  }

  function beginSwapConfirmation(pieceIds, firstPieceId = null, simulation = null) {
    window.clearTimeout(overlapCollapseTimer);
    overlapCollapseTimer = null;
    const simulated = simulation || simulateSwap(pieceIds);
    const plan = simulated.plan;

    // When the two settlement orders differ, do not show a guessed preview.
    // Keep both real pieces highlighted and let the player choose the first one.
    if (!plan.equivalent && !firstPieceId) {
      pendingSwapOrderChoice = simulated;
      swapMode = false;
      swapSelection = [];
      hidePreview(false);
      renderGame();
      return false;
    }

    const resolvedFirstPieceId = firstPieceId || plan.automaticFirstPieceId;
    const outcome = plan.outcomes.find(item => item.firstPieceId === resolvedFirstPieceId);
    if (!outcome) throw new Error('无法生成交换结算预览');

    pendingSwapOrderChoice = null;
    pendingConfirmation = {
      type: 'swap',
      pieceIds: simulated.pieceIds.slice(),
      snapshot: simulated.snapshot,
      startLocations: cloneData(simulated.startLocations),
      endLocations: cloneData(simulated.endLocations),
      selectedFirstPieceId: resolvedFirstPieceId,
      previewPlan: {
        equivalent: plan.equivalent,
        automaticFirstPieceId: plan.automaticFirstPieceId,
        events: cloneData(outcome.events)
      }
    };
    swapMode = false;
    swapSelection = [];
    document.body.classList.add('pending-confirmation');
    el.confirmActionButton.classList.remove('hidden');
    startSwapConfirmationPreview(pendingConfirmation);
    renderGame();
    return true;
  }

  function startSwapConfirmationPreview(pending) {
    const token = ++confirmationAnimationToken;
    const ghostByPieceId = new Map();
    pending.pieceIds.forEach((id, index) => {
      const piece = engine.getPiece(id);
      const node = document.createElement('div');
      node.className = `preview-swap-ghost ${piece.color}`;
      node.dataset.previewSwapIndex = String(index);
      node.dataset.previewPieceId = id;
      el.pieceLayer.appendChild(node);
      ghostByPieceId.set(id, node);
    });

    const followUpStages = buildAnimationStages((pending.previewPlan && pending.previewPlan.events) || []);
    const stages = [{ type: 'swap', events: [] }, ...followUpStages];

    (async () => {
      while (token === confirmationAnimationToken && pendingConfirmation === pending) {
        [...el.pieceLayer.querySelectorAll('.preview-capture-ghost')].forEach(node => node.remove());
        pending.pieceIds.forEach((id, index) => {
          const node = ghostByPieceId.get(id);
          node.classList.add('no-transition');
          positionNodeAtLocation(node, pending.startLocations[index], 0, 1);
        });
        void el.pieceLayer.offsetWidth;

        for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
          if (token !== confirmationAnimationToken || pendingConfirmation !== pending) return;
          const stage = stages[stageIndex];
          const duration = stage.type === 'swap' ? timing.specialDurationMs : stageDuration(stage.type);

          if (stage.type === 'swap') {
            pending.pieceIds.forEach((id, index) => {
              const node = ghostByPieceId.get(id);
              node.classList.remove('no-transition');
              node.style.setProperty('--motion-ms', `${duration}ms`);
              positionNodeAtLocation(node, pending.endLocations[index], 0, 1);
            });
            await delay(duration);
          } else if (stage.type === 'capture') {
            const captureGhosts = stage.events.map(event => {
              const node = document.createElement('div');
              node.className = `preview-capture-ghost ${event.targetColor || ''} no-transition`;
              node.style.setProperty('--motion-ms', `${duration}ms`);
              positionNodeAtLocation(node, event.fromLocation, 0, 1);
              el.pieceLayer.appendChild(node);
              return { node, event };
            });
            void el.pieceLayer.offsetWidth;
            captureGhosts.forEach(({ node, event }) => {
              node.classList.remove('no-transition');
              positionNodeAtLocation(node, event.location, 0, 1);
            });
            await delay(duration);
          } else {
            stage.events.forEach(event => {
              const node = ghostByPieceId.get(event.pieceId);
              if (!node || !event.location) return;
              node.classList.remove('no-transition');
              node.style.setProperty('--motion-ms', `${duration}ms`);
              positionNodeAtLocation(node, event.location, 0, 1);
            });
            await delay(duration);
          }

          if (stageIndex < stages.length - 1 && timing.stageWaitMs > 0) {
            await delay(timing.stageWaitMs);
          }
        }

        if (token !== confirmationAnimationToken || pendingConfirmation !== pending) return;
        await delay(timing.loopWaitMs);
      }
    })();
  }

  async function handleBoardClick(event) {
    if (interactionLocked || isCurrentPlayerAi()) return;
    if (event.target.closest('#confirmActionButton')) return;

    if (pendingConfirmation) {
      cancelPendingConfirmation();
      renderGame();
      return;
    }

    // In touch-care mode, an expanded stack stays locked until another board
    // area is tapped. Piece clicks stop propagation, so this handles the rest.
    if (secondConfirmEnabled && lockedOverlapKey) {
      lockedOverlapKey = null;
      expandedOverlapKey = null;
      hidePreview(false);
      renderPieces();
    }
  }

  function handleSecondConfirmChange() {
    if (isCurrentPlayerAi()) { el.secondConfirm.checked = secondConfirmEnabled; return; }
    secondConfirmEnabled = Boolean(el.secondConfirm.checked);
    if (!secondConfirmEnabled) {
      lockedOverlapKey = null;
      expandedOverlapKey = null;
      hidePreview(false);
    }
    renderGame();
  }

  async function handleConfirmAction() {
    if (!pendingConfirmation || interactionLocked || isCurrentPlayerAi()) return;
    const pending = pendingConfirmation;
    pendingConfirmation = null;
    stopConfirmationPreview();
    document.body.classList.remove('pending-confirmation');
    el.confirmActionButton.classList.add('hidden');
    if (isLanMode()) {
      if (pending.type === 'move') {
        await submitLanAction(4 + ActionProtocol.globalPieceIndex(pending.pieceId));
      } else if (pending.type === 'swap') {
        const first = await submitLanAction(ActionProtocol.swapAction(pending.pieceIds[0], pending.pieceIds[1]));
        if (first && pending.selectedFirstPieceId && first.state && first.state.phase === 'chooseSwapOrder') {
          await submitLanAction(276 + ActionProtocol.globalPieceIndex(pending.selectedFirstPieceId));
        }
      }
      return;
    }
    if (pending.type === 'move') {
      await commitMove(pending.pieceId, pending.commitSnapshot);
    } else if (pending.type === 'swap') {
      await commitSwap(pending.pieceIds, pending.snapshot, pending.selectedFirstPieceId);
    }
  }

  function buildUndoAnimationEvents(snapshot) {
    if (!engine || !snapshot || !snapshot.pieces) return [];
    const savedById = new Map();
    Object.values(snapshot.pieces).flat().forEach(piece => savedById.set(piece.id, piece));
    const events = [];
    engine.getAllPieces().forEach(piece => {
      const saved = savedById.get(piece.id);
      if (!saved) return;
      const currentKey = JSON.stringify(piece.location);
      const savedKey = JSON.stringify(saved.location);
      if (currentKey === savedKey && Boolean(piece.finished) === Boolean(saved.finished)) return;
      events.push({
        type: 'undoAction',
        pieceId: piece.id,
        location: JSON.parse(JSON.stringify(saved.location))
      });
    });
    return events;
  }


  function updateLanUndoRequestModal() {
    if (!el.undoRequestModal) return;
    const defeatRequestForMe = Boolean(
      isLanMode() && lanConnected && lanDefeatRegretRequest && lanDefeatRegretRequest.approver === lanRole
    );
    const undoRequestForMe = Boolean(
      isLanMode() && lanConnected && lanUndoRequest && lanUndoRequest.approver === lanRole
    );
    const shouldShow = defeatRequestForMe || undoRequestForMe;
    el.undoRequestModal.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;

    if (defeatRequestForMe) {
      el.undoRequestText.textContent = `玩家${lanDefeatRegretRequest.requester}申请反悔三6遣返！`;
      el.rejectUndoRequest.textContent = '666我要是不同意呢';
      el.allowUndoRequest.textContent = '我同意了';
      el.rejectUndoRequest.disabled = lanDefeatRegretResponding;
      el.allowUndoRequest.disabled = lanDefeatRegretResponding;
    } else {
      el.undoRequestText.textContent = `允许玩家${lanUndoRequest.requester}撤销？`;
      el.rejectUndoRequest.textContent = '拒绝';
      el.allowUndoRequest.textContent = '允许';
      el.rejectUndoRequest.disabled = lanUndoResponding;
      el.allowUndoRequest.disabled = lanUndoResponding;
    }
    renderLanChat();
  }

  async function respondLanUndoRequest(allow) {
    if (!lanClient) return;
    if (lanDefeatRegretRequest && lanDefeatRegretRequest.approver === lanRole) {
      if (lanDefeatRegretResponding) return;
      lanDefeatRegretResponding = true;
      updateLanUndoRequestModal();
      try {
        await lanClient.respondDefeatRegret(Boolean(allow));
      } catch (error) {
        showError(error);
      } finally {
        lanDefeatRegretResponding = false;
        updateLanUndoRequestModal();
        if (engine) renderGame();
      }
      return;
    }
    if (!lanUndoRequest || lanUndoRequest.approver !== lanRole || lanUndoResponding) return;
    lanUndoResponding = true;
    updateLanUndoRequestModal();
    try {
      await lanClient.respondUndo(Boolean(allow));
    } catch (error) {
      showError(error);
    } finally {
      lanUndoResponding = false;
      updateLanUndoRequestModal();
      if (engine) renderGame();
    }
  }

  async function handleUndoAction() {
    if (!engine || interactionLocked || isCurrentPlayerAi()) return;
    if (pendingConfirmation) {
      cancelPendingConfirmation();
      renderGame();
      return;
    }
    if (isLanMode()) {
      if (!lanConnected || !lanUndoAvailable || lanUndoRequest) return;
      interactionLocked = true;
      try {
        await lanClient.requestUndo();
      } catch (error) {
        showError(error);
      } finally {
        interactionLocked = false;
        renderGame();
      }
      return;
    }
    if (!undoRecord) return;

    interactionLocked = true;
    hidePreview();
    const record = undoRecord;
    const events = buildUndoAnimationEvents(record.snapshot);
    undoRecord = null;
    assignmentCheckpoint = null;
    closeVictoryPopup();
    victoryShownFor = null;
    engine.restore(record.snapshot);
    swapMode = false;
    swapSelection = [];
    // Keep the DOM at the committed positions until the reverse animation starts.
    await animateMovementEvents(events);
    if (record.kind === 'move') await autoSelectForcedDie();
    interactionLocked = false;
    renderGame();
  }

  async function commitMove(pieceId, snapshot) {
    interactionLocked = true;
    hidePreview();
    try {
      const before = snapshot || assignmentCheckpoint || engine.serialize();
      const events = engine.moveSelectedPiece(pieceId);
      // 三连6使用专用的10次反悔弹窗，不能被普通撤销按钮绕过。
      undoRecord = engine.pendingDefeat ? null : { kind: 'move', snapshot: before };
      assignmentCheckpoint = null;
        await animateMovementEvents(events);
      if (engine.pendingDefeat) await resolveDefeatPopup(engine.pendingDefeat.color);
      if (engine.gameOver) {
        renderGame();
        showVictoryPopup();
      } else {
        await autoSelectForcedDie();
      }
    } catch (error) {
      showError(error);
    } finally {
      interactionLocked = false;
      renderGame();
    }
  }

  async function commitSwap(pieceIds, snapshot, selectedFirstPieceId = null) {
    interactionLocked = true;
    hidePreview();
    try {
      const before = snapshot || engine.serialize();
      const swappedIds = pieceIds.slice();
      swappedIds.forEach(id => {
        const node = el.pieceLayer.querySelector(`[data-piece-id="${id}"]`);
        if (!node) return;
        node.classList.add('animating', 'special-motion');
        node.style.setProperty('--motion-ms', `${timing.specialDurationMs}ms`);
      });
      engine.beginSwap(swappedIds[0], swappedIds[1]);
      undoRecord = { kind: 'swap', snapshot: before };
      assignmentCheckpoint = null;
        swapMode = false;
      swapSelection = [];
      renderPieces();
      await delay(timing.specialDurationMs);
      swappedIds.forEach(id => {
        const node = el.pieceLayer.querySelector(`[data-piece-id="${id}"]`);
        if (!node) return;
        node.classList.remove('animating', 'special-motion');
        node.style.removeProperty('--motion-ms');
      });

      const plan = engine.analyzePendingSwap();
      const firstPieceId = plan.equivalent ? plan.automaticFirstPieceId : selectedFirstPieceId;
      if (firstPieceId) {
        const events = engine.resolveSwapOrder(firstPieceId);
        if (events.length && timing.stageWaitMs > 0) await delay(timing.stageWaitMs);
        await animateMovementEvents(events);
        if (engine.gameOver) showVictoryPopup();
      }
    } catch (error) {
      showError(error);
    } finally {
      interactionLocked = false;
      renderGame();
    }
  }

  async function handleRoll(options = {}) {
    const aiDriven = Boolean(options && options.ai === true);
    if (isLanMode()) {
      await submitLanAction(0);
      return;
    }
    if (!engine || interactionLocked || pendingConfirmation || pendingSwapOrderChoice || engine.phase !== 'awaitRoll') return;
    if (isCurrentPlayerAi() && !aiDriven) return;
    if (swapMode) {
      swapMode = false;
      swapSelection = [];
    }
    clearUndoRecord();
    interactionLocked = true;
    hidePreview();
    renderGame();

    try {
      if (openingRollPending && engine.mode === 'classic' && engine.rollSpec.type === 'double') {
        let attempts = 0;
        while (openingRollPending) {
          attempts += 1;
          const launchList = [...launchValues];
          const values = attempts > 200
            ? [launchList[Math.floor(Math.random() * launchList.length)], randomDie()]
            : [randomDie(), randomDie()];
          await animateDiceRoll(values);

          // Revised rule: a six also ends the automatic opening rotation even if
          // six is not configured as a launch value, because it grants an extra roll.
          if (values.some(value => launchValues.has(value)) || values.includes(6)) {
            engine.rollDice(values);
            openingRollPending = false;
            break;
          }

          engine.skipOpeningRoll(values);
          renderGame();
          await delay(timing.specialDurationMs);
        }
      } else {
        const count = engine.rollSpec.type === 'single' ? 1 : 2;
        const values = Array.from({ length: count }, randomDie);
        await animateDiceRoll(values);
        engine.rollDice(values);
      }
      await autoSelectForcedDie();
    } catch (error) {
      showError(error);
    } finally {
      interactionLocked = false;
      renderGame();
    }
  }

  async function animateDiceRoll(values) {
    const frames = 4;
    for (let frame = 0; frame < frames - 1; frame += 1) {
      showTemporaryDice(values.map(() => randomDie()));
      await delay(timing.stepDurationMs / frames);
    }
    showTemporaryDice(values);
    await delay(timing.stepDurationMs / frames);
  }

  async function autoSelectForcedDie() {
    while (engine && engine.phase === 'selectDie' && engine.currentRoll) {
      const indices = engine.getSelectableDieIndices();
      const forcedSingle = engine.currentRoll.type === 'single' && indices.length === 1;
      const forcedRemainder = indices.length === 1 && engine.assignments.length > 0;
      if (!forcedSingle && !forcedRemainder) break;

      if (!assignmentCheckpoint) assignmentCheckpoint = engine.serialize();
      const result = engine.selectDie(indices[0]);
      if (result.events && result.events.length) await animateMovementEvents(result.events);
      if (result.autoPenalty && result.assignment) {
        assignmentCheckpoint = null;
        await resolveDefeatPopup(result.assignment.color);
      }
      if (result.autoSkipped) assignmentCheckpoint = null;
      if (result.noMoveForDie || engine.phase === 'selectPiece') break;
    }
  }

  function showDefeatPopup(color) {
    defeatUndoClicks = 0;
    el.defeatText.textContent = `666你的${COLOR_TEXT[color]}被击败了！！！`;
    el.undoDefeat.textContent = '按10次反悔';
    el.acceptDefeat.textContent = '我接受';
    el.defeatModal.classList.remove('hidden');
    return new Promise(resolve => { defeatDialogResolve = resolve; });
  }

  async function resolveDefeatPopup(color) {
    // Human players retain the ten-click regret interaction. AI must obey the
    // training rules and accepts the mandatory third-six defeat immediately.
    if (isCurrentPlayerAi()) {
      engine.acceptPendingDefeat();
      return 'accept';
    }
    const result = await showDefeatPopup(color);
    if (result === 'undo') {
      const events = engine.undoPendingDefeat();
      await animateMovementEvents(events);
    } else {
      engine.acceptPendingDefeat();
    }
    return result;
  }

  function closeDefeatPopup(result) {
    el.defeatModal.classList.add('hidden');
    const resolve = defeatDialogResolve;
    defeatDialogResolve = null;
    if (resolve) resolve(result);
  }

  async function handleDefeatUndo() {
    if (!defeatDialogResolve) return;
    if (isLanMode() && defeatDialogResolve === 'lan') {
      if (!lanClient || !engine || lanRole !== engine.currentPlayerId || lanDefeatRegretRequesting) return;
      lanDefeatRegretRequesting = true;
      showLanDefeatPopup(engine.pendingDefeat ? engine.pendingDefeat.color : 'red');
      try {
        await lanClient.requestDefeatRegret();
      } catch (error) {
        showError(error);
      } finally {
        lanDefeatRegretRequesting = false;
        if (engine && engine.pendingDefeat && lanRole === engine.currentPlayerId) showLanDefeatPopup(engine.pendingDefeat.color);
      }
      return;
    }
    defeatUndoClicks += 1;
    const remaining = 10 - defeatUndoClicks;
    if (remaining <= 0) {
      closeDefeatPopup('undo');
      return;
    }
    el.undoDefeat.textContent = `再按${remaining}次反悔`;
  }

  async function handleDefeatAccept() {
    if (!defeatDialogResolve) return;
    if (isLanMode() && defeatDialogResolve === 'lan') {
      if (!lanClient || !engine || lanRole !== engine.currentPlayerId || lanDefeatRegretRequesting) return;
      lanDefeatRegretRequesting = true;
      showLanDefeatPopup(engine.pendingDefeat ? engine.pendingDefeat.color : 'red');
      try {
        await submitLanCommand('accept-defeat');
      } finally {
        lanDefeatRegretRequesting = false;
        if (engine && engine.pendingDefeat && lanRole === engine.currentPlayerId) showLanDefeatPopup(engine.pendingDefeat.color);
      }
      return;
    }
    closeDefeatPopup('accept');
  }

  function showVictoryPopup() {
    if (!engine || !engine.gameOver) return;
    const popupKey = engine.remainderComplete ? 'remainder' : engine.winner;
    if (!popupKey || victoryShownFor === popupKey) return;
    victoryShownFor = popupKey;
    if (engine.remainderComplete) {
      el.victoryText.textContent = '残局结束。';
      el.continueGame.classList.add('hidden');
    } else {
      el.victoryText.textContent = `${engine.getPlayer(engine.winner).name}获胜！！！！！！`;
      el.continueGame.classList.remove('hidden');
    }
    el.victoryModal.classList.remove('hidden');
  }

  function closeVictoryPopup() {
    el.victoryModal.classList.add('hidden');
  }

  function handleReplayGame() {
    if (isLanMode()) {
      showError(new Error('请由房主在服务端管理页重新回到开局设置。'));
      return;
    }
    closeVictoryPopup();
    victoryShownFor = null;
    clearUndoRecord();
    setupAiControllers = cloneAiControllers(aiControllers);
    startGame();
  }

  function handleContinueGame() {
    if (!engine || !engine.gameOver || engine.remainderComplete || !engine.winner) return;
    if (isLanMode()) {
      closeVictoryPopup();
      submitLanCommand('continue-after-win');
      return;
    }
    closeVictoryPopup();
    clearUndoRecord();
    engine.continueAfterWin();
    victoryShownFor = null;
    interactionLocked = false;
    renderGame();
  }

  function showTemporaryDice(values) {
    [el.die0, el.die1].forEach((button, index) => {
      button.classList.remove('rolling');
      void button.offsetWidth;
      button.classList.add('rolling');
      const strong = button.querySelector('strong');
      strong.textContent = values[index] || '–';
    });
  }

  async function executePassTurn() {
    if (!engine || interactionLocked || !engine.canPassTurn()) return;
    hidePreview();
    swapMode = false;
    swapSelection = [];
    assignmentCheckpoint = null;
    interactionLocked = true;
    try {
      const result = engine.passTurn();
      if (result && result.events && result.events.length) await animateMovementEvents(result.events);
      if (engine.pendingDefeat) await resolveDefeatPopup(engine.pendingDefeat.color);
      await autoSelectForcedDie();
    } catch (error) {
      showError(error);
    } finally {
      interactionLocked = false;
      renderGame();
    }
  }

  async function handlePassTurn() {
    if (isLanMode()) {
      await submitLanAction(1);
      return;
    }
    if (isCurrentPlayerAi()) return;
    await executePassTurn();
  }

  function toggleSwapMode() {
    if (!engine || interactionLocked || pendingConfirmation || pendingSwapOrderChoice || isCurrentPlayerAi()) return;
    if (isLanMode() && !lanCanControlCurrentPlayer()) return;
    if (swapMode) {
      swapMode = false;
      swapSelection = [];
      renderGame();
      return;
    }
    if (!engine.canSwap()) {
      const locked = engine.rollSpec && engine.rollSpec.type === 'single';
      showError(new Error(locked
        ? '锁定单骰追加期间不能交换棋子。只有普通双骰或双6追加双骰可以交换。'
        : '交换双方颜色都必须至少有一枚已经离开机场、且尚未完成的棋子。'));
      return;
    }
    swapMode = true;
    swapSelection = [];
    assignmentCheckpoint = null;
    hidePreview();
    renderGame();
  }

  async function executeDieSelection(dieIndex) {
    if (!engine || interactionLocked || pendingConfirmation || pendingSwapOrderChoice || swapMode) return;
    interactionLocked = true;
    try {
      hidePreview();
      if (!assignmentCheckpoint) assignmentCheckpoint = engine.serialize();
      const result = engine.selectDie(Number(dieIndex));
      if (result.deselected || result.noMoveForDie) assignmentCheckpoint = null;
      if (result.events && result.events.length) await animateMovementEvents(result.events);
      if (result.autoPenalty && result.assignment) {
        assignmentCheckpoint = null;
        await resolveDefeatPopup(result.assignment.color);
      }
      if (result.autoSkipped) assignmentCheckpoint = null;
      if (result.noMoveForDie && !result.canPassTurn && !isCurrentPlayerAi()) {
        showError(new Error('这枚骰子没有可移动的棋子，请选择另一枚骰子。'));
      }
      await autoSelectForcedDie();
    } catch (error) {
      showError(error);
    } finally {
      interactionLocked = false;
      renderGame();
    }
  }

  async function handleDieClick(event) {
    if (isCurrentPlayerAi()) return;
    const button = event.target.closest('[data-die-index]');
    if (!button) return;
    const dieIndex = Number(button.dataset.dieIndex);
    if (isLanMode()) {
      await submitLanAction(2 + dieIndex);
      return;
    }
    await executeDieSelection(dieIndex);
  }

  async function handlePieceClick(event) {
    if (!engine || interactionLocked || isCurrentPlayerAi()) return;
    const pieceElement = event.target.closest('.piece');
    if (!pieceElement) return;
    if (pendingConfirmation) return;

    const locationKey = pieceElement.dataset.locationKey;
    const overlapCount = Number(pieceElement.dataset.overlapCount || 1);

    // Touch-care mode: the first tap on a stack only locks it open. A second
    // tap selects a concrete piece. The stack remains open until another board
    // area is tapped.
    if (secondConfirmEnabled && overlapCount > 1 &&
        (lockedOverlapKey !== locationKey || expandedOverlapKey !== locationKey)) {
      event.stopPropagation();
      lockedOverlapKey = locationKey;
      expandedOverlapKey = locationKey;
      hidePreview(false);
      renderPieces();
      return;
    }
    if (secondConfirmEnabled && lockedOverlapKey && lockedOverlapKey !== locationKey) {
      lockedOverlapKey = null;
      expandedOverlapKey = null;
      hidePreview(false);
      renderPieces();
    }

    // Prevent the same click that creates a pending confirmation from bubbling
    // to the board-level cancel handler. Later clicks while pending still bubble.
    event.stopPropagation();
    const pieceId = pieceElement.dataset.pieceId;

    try {
      if (isLanMode()) {
        if (!lanCanControlCurrentPlayer()) return;
        if (swapMode) {
          if (!pieceElement.classList.contains('selectable')) return;
          await handleSwapPieceSelection(pieceId);
        } else if (engine.phase === 'chooseSwapOrder' && engine.pendingSwap && engine.pendingSwap.pieceIds.includes(pieceId)) {
          await submitLanAction(276 + ActionProtocol.globalPieceIndex(pieceId));
        } else if (engine.phase === 'selectPiece' && pieceElement.classList.contains('selectable')) {
          if (secondConfirmEnabled) beginMoveConfirmation(pieceId);
          else await submitLanAction(4 + ActionProtocol.globalPieceIndex(pieceId));
        }
        return;
      }
      if (pendingSwapOrderChoice) {
        if (!pendingSwapOrderChoice.pieceIds.includes(pieceId)) return;
        if (secondConfirmEnabled) {
          beginSwapConfirmation(
            pendingSwapOrderChoice.pieceIds,
            pieceId,
            pendingSwapOrderChoice
          );
        } else {
          const choice = pendingSwapOrderChoice;
          pendingSwapOrderChoice = null;
          await commitSwap(choice.pieceIds, choice.snapshot, pieceId);
        }
      } else if (swapMode) {
        if (!pieceElement.classList.contains('selectable')) return;
        await handleSwapPieceSelection(pieceId);
      } else if (engine.phase === 'chooseSwapOrder' && engine.pendingSwap && engine.pendingSwap.pieceIds.includes(pieceId)) {
        if (!pieceElement.classList.contains('selectable')) return;
        interactionLocked = true;
        hidePreview();
        const events = engine.resolveSwapOrder(pieceId);
        await animateMovementEvents(events);
        if (engine.gameOver) showVictoryPopup();
        interactionLocked = false;
        renderGame();
      } else if (engine.phase === 'selectPiece') {
        if (!pieceElement.classList.contains('selectable')) return;
        if (secondConfirmEnabled) {
          beginMoveConfirmation(pieceId);
        } else {
          await commitMove(pieceId, assignmentCheckpoint || engine.serialize());
        }
      }
    } catch (error) {
      interactionLocked = false;
      showError(error);
      renderGame();
    }
  }

  async function handleSwapPieceSelection(pieceId) {
    const piece = engine.getPiece(pieceId);
    if (!piece || piece.finished || engine.ownerByColor[piece.color] !== engine.currentPlayerId) return;
    if (piece.location.zone === 'airport') {
      showError(new Error('机场内尚未起飞的棋子不能交换。'));
      return;
    }
    if (!engine.getSwapEligiblePieceIds(piece.color).includes(pieceId)) return;

    if (swapSelection.includes(pieceId)) {
      swapSelection = swapSelection.filter(id => id !== pieceId);
      renderGame();
      return;
    }
    if (swapSelection.length === 0) {
      swapSelection.push(pieceId);
      renderGame();
      return;
    }

    const firstPiece = engine.getPiece(swapSelection[0]);
    if (firstPiece.color === piece.color) {
      swapSelection = [pieceId];
      showError(new Error('交换必须选择另一个颜色的棋子。'));
      renderGame();
      return;
    }
    if (engine.getPhysicalLocationKey(firstPiece) === engine.getPhysicalLocationKey(piece)) {
      showError(new Error('位于同一格的两个棋子不能交换。'));
      return;
    }

    const ids = [firstPiece.id, piece.id];
    if (isLanMode()) {
      swapMode = false;
      swapSelection = [];
      renderGame();
      if (secondConfirmEnabled) beginSwapConfirmation(ids);
      else await submitLanAction(ActionProtocol.swapAction(ids[0], ids[1]));
      return;
    }
    if (secondConfirmEnabled) {
      beginSwapConfirmation(ids);
    } else {
      const simulation = simulateSwap(ids);
      if (simulation.plan && !simulation.plan.equivalent) {
        pendingSwapOrderChoice = simulation;
        swapMode = false;
        swapSelection = [];
        hidePreview(false);
        renderGame();
      } else {
        await commitSwap(ids, simulation.snapshot);
      }
    }
  }

  function handlePieceHover(event) {
    if (!engine || interactionLocked || pendingConfirmation || isCurrentPlayerAi()) return;
    const pieceElement = event.target.closest('.piece');
    if (!pieceElement) return;
    if (event.relatedTarget && pieceElement.contains(event.relatedTarget)) return;

    window.clearTimeout(overlapCollapseTimer);
    const locationKey = pieceElement.dataset.locationKey;
    const overlapCount = Number(pieceElement.dataset.overlapCount || 1);

    if (secondConfirmEnabled) {
      // Touch-care mode never expands a stack merely because a pointer hovers.
      // Only a tapped and locked stack exposes its individual pieces.
      if (overlapCount > 1 && lockedOverlapKey !== locationKey) return;
    } else {
      if (expandedOverlapKey && expandedOverlapKey !== locationKey) {
        expandedOverlapKey = null;
        renderPieces();
      }
      if (overlapCount > 1 && expandedOverlapKey !== locationKey) {
        expandedOverlapKey = locationKey;
        renderPieces();
      }
    }

    if (swapMode || pendingSwapOrderChoice || engine.phase !== 'selectPiece' || !pieceElement.classList.contains('selectable')) return;
    const preview = engine.previewSelectedPiece(pieceElement.dataset.pieceId);
    if (!preview) return;
    const piece = engine.getPiece(pieceElement.dataset.pieceId);
    showPreview(piece.color, preview);
  }

  function handlePieceOut(event) {
    if (pendingConfirmation || (secondConfirmEnabled && lockedOverlapKey)) return;
    const pieceElement = event.target.closest('.piece');
    if (!pieceElement) return;
    const overlapCount = Number(pieceElement.dataset.overlapCount || 1);
    if (overlapCount > 1) return;
    const relatedPiece = event.relatedTarget && event.relatedTarget.closest
      ? event.relatedTarget.closest('.piece')
      : null;
    if (relatedPiece) return;
    window.clearTimeout(overlapCollapseTimer);
    overlapCollapseTimer = window.setTimeout(() => {
      overlapCollapseTimer = null;
      if (pendingConfirmation || (secondConfirmEnabled && lockedOverlapKey)) return;
      hidePreview(false);
    }, 60);
  }

  function getExpandedOverlapClientRegion(locationKey) {
    if (!locationKey || !engine) return null;
    const nodes = [...el.pieceLayer.querySelectorAll('.piece')]
      .filter(node => node.dataset.locationKey === locationKey && node.classList.contains('overlap-expanded'));
    if (!nodes.length) return null;

    const rects = nodes.map(node => node.getBoundingClientRect())
      .filter(rect => rect.width && rect.height);
    if (!rects.length) return null;

    const centers = rects.map(rect => ({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      r: Math.max(rect.width, rect.height) / 2
    }));
    const x = centers.reduce((total, item) => total + item.x, 0) / centers.length;
    const y = centers.reduce((total, item) => total + item.y, 0) / centers.length;
    const radius = Math.max(...centers.map(item => Math.hypot(item.x - x, item.y - y) + item.r)) + 12;

    return { x, y, radius };
  }

  function handleBoardPointerMove(event) {
    if (pendingConfirmation || (secondConfirmEnabled && lockedOverlapKey)) return;
    if (!expandedOverlapKey) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || !target.closest('.piece')) hidePreview(false);
      return;
    }

    // Use a client-space simulated hit region derived from the expanded pieces.
    // This keeps the group open while the pointer crosses gaps and remains correct
    // when the responsive board is not rendered as an exact square.
    const region = getExpandedOverlapClientRegion(expandedOverlapKey);
    if (!region) return;
    const distance = Math.hypot(event.clientX - region.x, event.clientY - region.y);
    if (distance <= region.radius) return;

    expandedOverlapKey = null;
    hidePreview(false);
    renderPieces();
  }

  function handleBoardPointerLeave() {
    if (pendingConfirmation || (secondConfirmEnabled && lockedOverlapKey)) return;
    if (!expandedOverlapKey && el.previewPiece.classList.contains('hidden')) return;
    expandedOverlapKey = null;
    hidePreview(false);
    if (engine) renderPieces();
  }

  function buildAnimationStages(events) {
    const stages = [];
    let index = 0;
    while (index < events.length) {
      const event = events[index];
      if (['step', 'finish'].includes(event.type)) {
        let last = event;
        index += 1;
        while (index < events.length && ['step', 'finish'].includes(events[index].type) && events[index].pieceId === event.pieceId) {
          last = events[index];
          index += 1;
        }
        stages.push({ type: 'move', events: [last] });
        continue;
      }
      if (event.type === 'bounce') {
        let last = event;
        index += 1;
        while (index < events.length && ['step', 'finish'].includes(events[index].type) && events[index].pieceId === event.pieceId) {
          last = events[index];
          index += 1;
        }
        stages.push({ type: 'bounce', events: [{ ...last, type: 'bounce' }] });
        continue;
      }
      if (['returnHome', 'undoReturnHome', 'undoAction'].includes(event.type)) {
        const type = event.type;
        const group = [];
        while (index < events.length && events[index].type === type) {
          group.push(events[index]);
          index += 1;
        }
        stages.push({ type, events: group });
        continue;
      }
      if (event.type === 'capture') {
        const group = [];
        while (index < events.length && events[index].type === 'capture') {
          group.push(events[index]);
          index += 1;
        }
        stages.push({ type: 'capture', events: group });
        continue;
      }
      stages.push({ type: event.type, events: [event] });
      index += 1;
    }
    return stages;
  }

  async function animateMovementEvents(events) {
    const stages = buildAnimationStages(events || []);
    for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
      const stage = stages[stageIndex];
      const duration = stageDuration(stage.type);
      if (stage.type === 'capture') {
        stage.events.forEach(event => {
          const node = el.pieceLayer.querySelector(`[data-piece-id="${event.targetId}"]`);
          if (!node || !event.location) return;
          node.classList.add('animating', 'special-motion');
          node.style.setProperty('--motion-ms', `${duration}ms`);
          positionNodeAtLocation(node, event.location, 0, 1);
        });
        await delay(duration);
        stage.events.forEach(event => {
          const node = el.pieceLayer.querySelector(`[data-piece-id="${event.targetId}"]`);
          if (!node) return;
          node.classList.remove('special-motion');
          node.style.removeProperty('--motion-ms');
        });
      } else {
        stage.events.forEach(event => {
          if (!event.location || !event.pieceId) return;
          const node = el.pieceLayer.querySelector(`[data-piece-id="${event.pieceId}"]`);
          if (!node) return;
          node.classList.add('animating');
          node.style.setProperty('--motion-ms', `${duration}ms`);
          if (['jump', 'flight', 'bounce', 'takeoff', 'returnHome', 'undoReturnHome', 'undoAction'].includes(stage.type)) {
            node.classList.remove('special-motion');
            void node.offsetWidth;
            node.classList.add('special-motion');
          }
          positionNodeAtLocation(node, event.location, 0, 1);
        });
        await delay(duration);
        stage.events.forEach(event => {
          const node = event.pieceId && el.pieceLayer.querySelector(`[data-piece-id="${event.pieceId}"]`);
          if (!node) return;
          node.classList.remove('special-motion');
          node.style.removeProperty('--motion-ms');
        });
      }

      if (stageIndex < stages.length - 1 && timing.stageWaitMs > 0) {
        await delay(timing.stageWaitMs);
      }
    }
    [...el.pieceLayer.querySelectorAll('.piece.animating')].forEach(node => node.classList.remove('animating'));
  }

  function renderGame() {
    if (!engine) return;
    const current = engine.getCurrentPlayer();
    const ended = engine.gameOver;
    const normalWinner = ended && engine.winner && !engine.remainderComplete;
    const currentAi = isCurrentPlayerAi();
    const currentAiLabel = currentAi ? ` - 人机（${modelLabel(aiControllers[current.id].modelId)}）` : '';
    const lanCurrentLabel = isLanMode() ? (lanRole === current.id ? ' - 轮到你了' : ' - 等待对方') : '';
    el.gameTitle.textContent = engine.mode === 'speed' ? '极速双飞' : '双飞';
    el.turnLabel.textContent = engine.remainderComplete
      ? '残局结束'
      : normalWinner
        ? `${engine.getPlayer(engine.winner).name}获胜`
        : `第 ${engine.turnNumber} 回合`;
    el.currentOperator.textContent = engine.remainderComplete
      ? '残局结束。'
      : normalWinner
        ? `胜者：${engine.getPlayer(engine.winner).name}`
        : `当前操作：${current.name} ${current.colors.map(color => COLOR_SHORT[color]).join(' ')}${currentAiLabel}${lanCurrentLabel}`;
    if (el.turnInteractionPanel) {
      const ownLanTurn = isLanMode() && lanConnected && !ended && lanRole === current.id;
      el.turnInteractionPanel.classList.toggle('your-turn', ownLanTurn);
      if (ownLanTurn && !lastOwnLanTurn) window.requestAnimationFrame(() => launchLanSpirit('turn'));
      lastOwnLanTurn = ownLanTurn;
    }

    renderPlayerCards();
    renderLanChat();
    renderDice();
    renderPieces();
    renderConfirmationArrows();
    renderLog();

    const humanBlocked = isLanMode()
      ? (!lanCanControlCurrentPlayer() || interactionLocked || engine.gameOver)
      : (currentAi || interactionLocked || Boolean(pendingConfirmation) || Boolean(pendingSwapOrderChoice) || engine.gameOver);
    el.rollButton.disabled = humanBlocked || engine.phase !== 'awaitRoll';
    el.rollButton.textContent = engine.rollSpec.type === 'single'
      ? `投掷${COLOR_TEXT[engine.rollSpec.lockedColor]}`
      : '投掷';

    el.swapButton.disabled = humanBlocked || !engine.canSwap();
    el.swapButton.textContent = swapMode ? '取消交换' : '交换棋子';

    const canPass = isLanMode()
      ? (lanCanControlCurrentPlayer() && !interactionLocked && engine.canPassTurn())
      : (!currentAi && !interactionLocked && !pendingConfirmation && !pendingSwapOrderChoice && !engine.gameOver && engine.canPassTurn());
    el.nextPlayerButton.classList.toggle('hidden', !canPass);
    el.nextPlayerButton.disabled = !canPass;
    el.secondConfirm.checked = secondConfirmEnabled;
    el.secondConfirm.disabled = currentAi || interactionLocked || Boolean(pendingConfirmation) || Boolean(pendingSwapOrderChoice);
    const waitingUndoResponse = Boolean(isLanMode() && lanUndoRequest && lanUndoRequest.requester === lanRole);
    el.undoActionButton.disabled = currentAi || interactionLocked || (isLanMode()
      ? (!pendingConfirmation && (!lanUndoAvailable || Boolean(lanUndoRequest)))
      : (!pendingConfirmation && !undoRecord));
    el.undoActionButton.textContent = pendingConfirmation ? '取消' : (waitingUndoResponse ? '等待回应' : '撤销');
    el.confirmActionButton.classList.toggle('hidden', !pendingConfirmation || currentAi);
    el.newGame.textContent = isLanMode() ? '服务端重新开局' : '重新开局';
    if (el.networkBadge) {
      el.networkBadge.textContent = lanBadgeText();
      el.networkBadge.classList.toggle('online', isLanMode() && lanConnected);
    }
    scheduleAiTurn();
  }

  function getPieceVisualBoardCenter(piece) {
    if (!piece || !el.pieceLayer) return null;
    const node = el.pieceLayer.querySelector(`[data-piece-id="${piece.id}"]`);
    if (!node) return null;
    const leftPercent = Number.parseFloat(node.style.left);
    const topPercent = Number.parseFloat(node.style.top);
    if (Number.isFinite(leftPercent) && Number.isFinite(topPercent)) {
      return [
        (leftPercent / 100) * BOARD_SIZE,
        (topPercent / 100) * BOARD_SIZE
      ];
    }
    return null;
  }

  function renderConfirmationArrows() {
    if (!el.confirmationArrowLayer || !el.confirmationArrowGroup) return;
    el.confirmationArrowGroup.innerHTML = '';
    const ids = [];
    if (secondConfirmEnabled && pendingConfirmation) {
      if (pendingConfirmation.type === 'move') ids.push(pendingConfirmation.pieceId);
      if (pendingConfirmation.type === 'swap') ids.push(...pendingConfirmation.pieceIds);
    }
    if (!ids.length) {
      el.confirmationArrowLayer.classList.add('hidden');
      return;
    }

    const namespace = 'http://www.w3.org/2000/svg';
    ids.forEach(id => {
      const piece = engine.getPiece(id);
      if (!piece) return;
      const [x, y] = getPieceVisualBoardCenter(piece) || coordinatesForLocation(piece.location);
      const dx = CENTER[0] - x;
      const dy = CENTER[1] - y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      appendCustomArrow(el.confirmationArrowGroup, x, y, ux, uy, CELL * .18, 'confirmation-direction-arrow');
    });
    el.confirmationArrowLayer.classList.toggle('hidden', el.confirmationArrowGroup.childElementCount === 0);
  }

  function renderPlayerCards() {
    el.playerCards.innerHTML = engine.players.map(player => {
      const controller = aiControllers[player.id];
      const aiAvailable = !isLanMode() && engine.mode === 'classic';
      const controlButton = aiAvailable
        ? `<button type="button" class="ghost-btn player-ai-button" data-ai-toggle-player="${player.id}">${controller ? '夺回控制权' : '切换为人机'}</button>`
        : '';
      const aiState = isLanMode()
        ? `<span class="player-ai-status human">${player.id === lanRole ? '本机' : '对面'} - ${lanConnectedPlayers[player.id] ? '在线' : '未登录'} ${formatLanLatency()}</span>`
        : controller
          ? `<span class="player-ai-status">人机 · ${modelLabel(controller.modelId)}</span>`
          : `<span class="player-ai-status human">玩家控制</span>`;
      return `
        <article class="player-card ${player.id === engine.currentPlayerId && !engine.gameOver ? 'active' : ''} ${controller ? 'ai-controlled' : ''}">
          <div class="player-card-heading">
            <div><h3>${player.name}${player.id === engine.currentPlayerId && !engine.gameOver ? '<span class="turn-badge">当前回合</span>' : ''}</h3>${(engine.mode === 'classic' || isLanMode()) ? aiState : ''}</div>
            ${controlButton}
          </div>
          ${player.colors.map(color => {
            const done = engine.pieces[color].filter(piece => piece.finished).length;
            const sixes = engine.colorState[color].consecutiveSixes;
            return `
              <div class="color-line">
                <span class="color-badge">
                  <span class="color-dot" style="background:${COLOR_HEX[color]}"></span>
                  ${COLOR_TEXT[color]}
                  ${engine.isProtected(color) ? '<span class="protect-badge">保护</span>' : ''}
                </span>
                <span class="status-small">${done}/${engine.pieceCount}${sixes ? ` · 连6 ${sixes}` : ''}</span>
              </div>
            `;
          }).join('')}
        </article>`;
    }).join('');
  }

  function renderDice() {
    const buttons = [el.die0, el.die1];
    const roll = engine.currentRoll;
    const selectable = new Set(engine.getSelectableDieIndices());

    buttons.forEach((button, index) => {
      const strong = button.querySelector('strong');
      const small = button.querySelector('small');
      const value = roll && roll.values[index];
      strong.textContent = value || '–';
      button.classList.toggle('hidden-die', Boolean(roll && roll.type === 'single' && index === 1));
      button.classList.toggle('selected', Boolean(roll && engine.selectedDieIndex === index));
      button.classList.toggle('spent', Boolean(roll && roll.spent[index]));
      button.disabled = (isLanMode() ? !lanCanControlCurrentPlayer() : isCurrentPlayerAi()) || interactionLocked || Boolean(pendingConfirmation) || Boolean(pendingSwapOrderChoice) || !roll || !selectable.has(index) || !['selectDie', 'selectPiece'].includes(engine.phase);
      const assignedColor = roll && roll.colorByDie[index];
      const movableCount = roll && selectable.has(index) ? engine.getMovablePieceIdsForDie(index).length : 0;
      small.textContent = assignedColor
        ? `已给${COLOR_TEXT[assignedColor]}`
        : (value ? (movableCount > 0 ? '点击后选择棋子' : '无可移动棋子') : '');
      button.style.setProperty('--assigned-color', assignedColor ? COLOR_HEX[assignedColor] : 'var(--border-strong)');
    });
  }

  function createPieceElements() {
    [...el.pieceLayer.querySelectorAll('.piece')].forEach(node => node.remove());
    engine.getAllPieces().forEach(piece => {
      const node = document.createElement('button');
      const isProtectedPiece = engine.isProtected(piece.color);
      node.type = 'button';
      node.className = `piece ${piece.color}${isProtectedPiece ? ' protected' : ''}`;
      node.dataset.pieceId = piece.id;
      node.setAttribute('aria-label', engine.pieceLabel(piece));
      node.textContent = '';
      const visual = document.createElement('span');
      visual.className = 'piece-visual';
      visual.setAttribute('aria-hidden', 'true');
      if (isProtectedPiece) {
        const ring = document.createElement('span');
        ring.className = 'protected-ring';
        ring.setAttribute('aria-hidden', 'true');
        visual.appendChild(ring);
      }
      node.appendChild(visual);
      el.pieceLayer.insertBefore(node, el.previewPiece);
    });
  }

  function renderPieces() {
    const humanCanInteract = isLanMode() ? lanCanControlCurrentPlayer() : !isCurrentPlayerAi();
    const selectable = new Set();
    const pendingTargets = new Set();
    const rotatingSwapOrderTargets = new Set();
    if (pendingConfirmation) {
      if (pendingConfirmation.type === 'move') pendingTargets.add(pendingConfirmation.pieceId);
      if (pendingConfirmation.type === 'swap') {
        pendingConfirmation.pieceIds.forEach(id => {
          pendingTargets.add(id);
        });
      }
    }
    if (pendingSwapOrderChoice) {
      pendingSwapOrderChoice.pieceIds.forEach(id => {
        selectable.add(id);
        pendingTargets.add(id);
        if (!secondConfirmEnabled) rotatingSwapOrderTargets.add(id);
      });
    }
    if (!pendingConfirmation && !pendingSwapOrderChoice && swapMode) {
      const first = swapSelection.length === 1 ? engine.getPiece(swapSelection[0]) : null;
      if (first && !secondConfirmEnabled) rotatingSwapOrderTargets.add(first.id);
      engine.getCurrentPlayer().colors.forEach(color => {
        engine.getSwapEligiblePieceIds(color).forEach(id => {
          const candidate = engine.getPiece(id);
          if (first) {
            if (candidate.color === first.color) return;
            if (engine.getPhysicalLocationKey(candidate) === engine.getPhysicalLocationKey(first)) return;
          }
          selectable.add(id);
        });
      });
    } else if (!pendingConfirmation && !pendingSwapOrderChoice && engine.phase === 'selectPiece') {
      engine.getMovablePieceIdsForSelectedDie().forEach(id => selectable.add(id));
    } else if (!pendingConfirmation && !pendingSwapOrderChoice && engine.phase === 'chooseSwapOrder' && engine.pendingSwap) {
      engine.pendingSwap.pieceIds.forEach(id => {
        selectable.add(id);
        if (!secondConfirmEnabled) rotatingSwapOrderTargets.add(id);
      });
    }

    const groups = new Map();
    engine.getAllPieces().forEach(piece => {
      const key = engine.getPhysicalLocationKey(piece);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(piece);
    });

    overlapHitRegions = new Map();
    el.pieceLayer.querySelectorAll('.finish-count-label').forEach(node => node.remove());
    groups.forEach((group, locationKey) => {
      group.sort((a, b) => {
        const candidateDelta = Number(selectable.has(a.id)) - Number(selectable.has(b.id));
        return candidateDelta || a.id.localeCompare(b.id);
      });
      const expanded = expandedOverlapKey === locationKey && group.length > 1;
      const center = coordinatesForLocation(group[0].location);
      if (group.length > 1) {
        const layout = expandedOverlapLayout(group.length);
        overlapHitRegions.set(locationKey, {
          x: center[0],
          y: center[1],
          radius: layout.hitRadius
        });
      }
      group.forEach((piece, index) => {
        const node = el.pieceLayer.querySelector(`[data-piece-id="${piece.id}"]`);
        if (!node) return;
        positionNodeAtLocation(node, piece.location, index, group.length, expanded);
        node.dataset.locationKey = locationKey;
        node.dataset.overlapCount = String(group.length);
        node.classList.toggle('finished', piece.finished);
        node.classList.remove('finish-count-anchor');
        delete node.dataset.finishCount;
        node.classList.toggle('selectable', humanCanInteract && selectable.has(piece.id) && !interactionLocked);
        node.classList.toggle('pending-confirm-target', pendingTargets.has(piece.id));
        node.classList.toggle('rotating-swap-order-target', rotatingSwapOrderTargets.has(piece.id));
        node.classList.toggle('swap-selected', swapSelection.includes(piece.id));
        node.classList.toggle('swap-order-choice',
          (pendingSwapOrderChoice && pendingSwapOrderChoice.pieceIds.includes(piece.id)) ||
          (engine.phase === 'chooseSwapOrder' && engine.pendingSwap && engine.pendingSwap.pieceIds.includes(piece.id)));
        node.classList.toggle('overlapped', group.length > 1);
        node.classList.toggle('overlap-expanded', expanded);
        node.setAttribute('aria-disabled', humanCanInteract && selectable.has(piece.id) && !interactionLocked ? 'false' : 'true');
        node.disabled = false;
        node.style.zIndex = String((expanded ? 30 : 10) + index + (selectable.has(piece.id) ? 20 : 0));
      });
      if (engine.pieceCount === 4 && group.length === 4 && group.every(piece => piece.finished)) {
        const label = document.createElement('span');
        label.className = 'finish-count-label';
        label.textContent = '4';
        label.setAttribute('aria-hidden', 'true');
        label.style.left = `${(center[0] / BOARD_SIZE) * 100}%`;
        label.style.top = `${(center[1] / BOARD_SIZE) * 100}%`;
        el.pieceLayer.appendChild(label);
      }
    });
    renderConfirmationArrows();
  }

  function positionNodeAtLocation(node, location, overlapIndex, overlapCount, expanded = false) {
    const [x, y] = coordinatesForLocation(location);
    const [offsetX, offsetY] = overlapOffset(overlapIndex, overlapCount, expanded);
    node.style.left = `${((x + offsetX) / BOARD_SIZE) * 100}%`;
    node.style.top = `${((y + offsetY) / BOARD_SIZE) * 100}%`;
  }

  function coordinatesForLocation(location) {
    if (location.zone === 'airport') return HOME[location.zoneColor][Math.min(location.slot, HOME[location.zoneColor].length - 1)];
    if (location.zone === 'launch') return LAUNCH[location.zoneColor];
    if (location.zone === 'main') return MAIN_PATH[location.mainIndex];
    if (location.zone === 'lane') return LANE[location.laneColor][Math.min(location.laneIndex, 5)];
    if (location.zone === 'finished') return FINISH[location.finishColor];
    return CENTER;
  }

  function expandedOverlapLayout(count) {
    const diameter = 35;
    if (count === 2) {
      return { offsets: [[-diameter / 2, 0], [diameter / 2, 0]], hitRadius: diameter + 9 };
    }
    if (count === 3) {
      const radius = diameter / Math.sqrt(3);
      return {
        offsets: [0, 1, 2].map(index => {
          const angle = -Math.PI / 2 + index * Math.PI * 2 / 3;
          return [Math.cos(angle) * radius, Math.sin(angle) * radius];
        }),
        hitRadius: radius + diameter / 2 + 9
      };
    }
    if (count === 4) {
      const radius = 23;
      return {
        offsets: [0, 1, 2, 3].map(index => {
          const angle = -Math.PI / 2 + index * Math.PI / 2;
          return [Math.cos(angle) * radius, Math.sin(angle) * radius];
        }),
        hitRadius: radius + diameter / 2 + 9
      };
    }
    if (count === 5) {
      return {
        offsets: [
          [0, 0],
          [0, -diameter],
          [diameter, 0],
          [0, diameter],
          [-diameter, 0]
        ],
        hitRadius: diameter + diameter / 2 + 9
      };
    }
    const radius = Math.max(31, diameter / (2 * Math.sin(Math.PI / count)));
    return {
      offsets: Array.from({ length: count }, (_, index) => {
        const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius];
      }),
      hitRadius: radius + diameter / 2 + 9
    };
  }

  function overlapOffset(index, count, expanded = false) {
    if (count <= 1) return [0, 0];
    if (expanded) {
      const layout = expandedOverlapLayout(count);
      return layout.offsets[index] || [0, 0];
    }
    const radius = count <= 4 ? 3.5 : 5;
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  }

  function showPreview(color, preview) {
    el.previewPiece.className = `preview-piece ${color}${preview.penalty ? ' penalty' : ''}`;
    positionNodeAtLocation(el.previewPiece, preview.location, 0, 1);
    startGhostPreview(color, preview);
  }

  function startGhostPreview(color, preview) {
    const token = ++previewAnimationToken;
    const stages = buildAnimationStages(preview.events || []);
    if (!stages.length) {
      stages.push({
        type: 'move',
        events: [{ type: 'step', pieceId: null, location: preview.location }]
      });
    }

    el.previewGhost.className = `preview-ghost ${color}`;
    (async () => {
      while (token === previewAnimationToken && !el.previewGhost.classList.contains('hidden')) {
        [...el.pieceLayer.querySelectorAll('.preview-capture-ghost')].forEach(node => node.remove());
        el.previewGhost.classList.add('no-transition');
        positionNodeAtLocation(el.previewGhost, preview.startLocation, 0, 1);
        void el.previewGhost.offsetWidth;
        el.previewGhost.classList.remove('no-transition');

        for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
          const stage = stages[stageIndex];
          if (token !== previewAnimationToken) return;
          const duration = stageDuration(stage.type);
          if (stage.type === 'capture') {
            const captureGhosts = stage.events.map(event => {
              const node = document.createElement('div');
              node.className = `preview-capture-ghost ${event.targetColor || ''} no-transition`;
              node.style.setProperty('--motion-ms', `${duration}ms`);
              positionNodeAtLocation(node, event.fromLocation, 0, 1);
              el.pieceLayer.appendChild(node);
              return { node, event };
            });
            void el.pieceLayer.offsetWidth;
            captureGhosts.forEach(({ node, event }) => {
              node.classList.remove('no-transition');
              positionNodeAtLocation(node, event.location, 0, 1);
            });
            await delay(duration);
          } else {
            const last = stage.events[stage.events.length - 1];
            if (last && last.location) {
              el.previewGhost.style.setProperty('--motion-ms', `${duration}ms`);
              positionNodeAtLocation(el.previewGhost, last.location, 0, 1);
              await delay(duration);
            }
          }

          if (stageIndex < stages.length - 1 && timing.stageWaitMs > 0) {
            await delay(timing.stageWaitMs);
          }
        }
        if (token !== previewAnimationToken) return;
        await delay(timing.loopWaitMs);
      }
    })();
  }

  function hidePreview(collapseOverlap = true) {
    previewAnimationToken += 1;
    if (collapseOverlap) {
      expandedOverlapKey = null;
      lockedOverlapKey = null;
    }
    el.previewPiece.className = 'preview-piece hidden';
    el.previewGhost.className = 'preview-ghost hidden';
    [...el.pieceLayer.querySelectorAll('.preview-capture-ghost')].forEach(node => node.remove());
  }

  function compactCjkAsciiSpacing(text) {
    return String(text)
      .replace(/([\u3400-\u9FFF\u3040-\u30FF\uFF00-\uFFEF])\s+([A-Za-z0-9])/g, '$1$2')
      .replace(/([A-Za-z0-9])\s+([\u3400-\u9FFF\u3040-\u30FF\uFF00-\uFFEF])/g, '$1$2');
  }

  function renderLog() {
    const messages = engine.messages.slice(-60);
    el.gameLog.innerHTML = messages.map(message => `<li>${escapeHtml(compactCjkAsciiSpacing(message))}</li>`).join('');
    el.logCount.textContent = String(engine.messages.length);
    el.gameLog.scrollTop = el.gameLog.scrollHeight;
  }

  function showError(error) {
    const text = error && error.message ? error.message : String(error);
    if (!el.statusToast) {
      console.error(text);
      return;
    }
    window.clearTimeout(toastTimer);
    el.statusToast.textContent = text;
    el.statusToast.classList.remove('hidden');
    toastTimer = window.setTimeout(() => el.statusToast.classList.add('hidden'), 2400);
  }

  function randomDie() {
    if (window.crypto && window.crypto.getRandomValues) {
      const buffer = new Uint32Array(1);
      window.crypto.getRandomValues(buffer);
      return (buffer[0] % 6) + 1;
    }
    return Math.floor(Math.random() * 6) + 1;
  }

  function sum(values) {
    return values.reduce((total, value) => total + value, 0);
  }

  function formatOrderRoll(values) {
    return values ? `${values.join(' + ')} = ${sum(values)}` : '未投';
  }

  function colorTextWithDot(color) {
    return `<span class="color-dot" style="display:inline-block;background:${COLOR_HEX[color]};vertical-align:-1px;margin-right:5px"></span>${COLOR_TEXT[color]}`;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>\"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
  }

  function paletteColor(color, part) {
    const suffix = {
      piece: 'Piece',
      cell: 'Cell',
      airport: 'Airport'
    }[part];
    return rgbString(palette[`${color}${suffix}`]);
  }

  function createCustomArrowSegments(cx, cy, ux, uy, unit) {
    const len = Math.hypot(ux, uy) || 1;
    const dx = ux / len;
    const dy = uy / len;
    const px = -dy;
    const py = dx;

    // A is the arrow tip and D is the tail. The passed cx/cy is the midpoint of AD.
    // AD = 2 units, so A is one unit toward the target and D is one unit away from it.
    // AB = AC = 1 unit, AC ⟂ AB, and AD bisects ∠BAC.
    const aX = cx + dx * unit;
    const aY = cy + dy * unit;
    const dX = cx - dx * unit;
    const dY = cy - dy * unit;
    const abX = (-dx + px) / Math.SQRT2;
    const abY = (-dy + py) / Math.SQRT2;
    const acX = (-dx - px) / Math.SQRT2;
    const acY = (-dy - py) / Math.SQRT2;
    const bX = aX + abX * unit;
    const bY = aY + abY * unit;
    const cX = aX + acX * unit;
    const cY = aY + acY * unit;

    return [
      [aX, aY, bX, bY],
      [aX, aY, cX, cY],
      [aX, aY, dX, dY]
    ];
  }

  function appendCustomArrow(parent, cx, cy, ux, uy, unit, className) {
    const NS = 'http://www.w3.org/2000/svg';
    createCustomArrowSegments(cx, cy, ux, uy, unit).forEach(([x1, y1, x2, y2]) => {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      line.setAttribute('class', className);
      parent.appendChild(line);
    });
  }

  function drawBoard() {
    const svg = el.boardSvg;
    const NS = 'http://www.w3.org/2000/svg';
    svg.innerHTML = '';
    const make = (name, attributes, parent = svg) => {
      const node = document.createElementNS(NS, name);
      Object.entries(attributes || {}).forEach(([key, value]) => node.setAttribute(key, value));
      parent.appendChild(node);
      return node;
    };

    const boardBorder = BOARD_COLORS.border;
    const neutral = BOARD_COLORS.neutral;
    make('rect', { x: 0, y: 0, width: BOARD_SIZE, height: BOARD_SIZE, fill: BOARD_COLORS.outer });
    make('rect', {
      x: GRID_ORIGIN - 8,
      y: GRID_ORIGIN - 8,
      width: CELL * 15 + 16,
      height: CELL * 15 + 16,
      rx: 12,
      fill: BOARD_COLORS.surface,
      stroke: boardBorder,
      'stroke-width': 2
    });

    const homeAreas = {
      yellow: [0, 0],
      blue: [0, 12],
      green: [12, 12],
      red: [12, 0]
    };
    Object.entries(homeAreas).forEach(([color, [row, col]]) => {
      make('rect', {
        x: GRID_ORIGIN + col * CELL + CELL_GAP,
        y: GRID_ORIGIN + row * CELL + CELL_GAP,
        width: CELL * 3 - CELL_GAP * 2,
        height: CELL * 3 - CELL_GAP * 2,
        rx: 10,
        fill: paletteColor(color, 'airport'),
        stroke: paletteColor(color, 'piece'),
        'stroke-width': 2
      });
      HOME[color].forEach(([cx, cy]) => make('circle', {
        cx, cy, r: CELL * .36,
        fill: neutral,
        stroke: paletteColor(color, 'piece'),
        'stroke-width': 2.2
      }));
    });

    const indexColor = {};
    Object.entries(PATH_COLORS).forEach(([color, indexes]) => {
      indexes.forEach(index => { indexColor[index] = color; });
    });
    MAIN_PATH.forEach(([cx, cy], index) => {
      const color = indexColor[index];
      make('rect', {
        x: cx - CELL / 2 + CELL_GAP,
        y: cy - CELL / 2 + CELL_GAP,
        width: CELL - CELL_GAP * 2,
        height: CELL - CELL_GAP * 2,
        rx: 2,
        fill: paletteColor(color, 'cell'),
        stroke: boardBorder,
        'stroke-width': 1.2
      });
    });

    Object.entries(LAUNCH).forEach(([color, [cx, cy]]) => {
      make('rect', {
        x: cx - CELL / 2 + CELL_GAP,
        y: cy - CELL / 2 + CELL_GAP,
        width: CELL - CELL_GAP * 2,
        height: CELL - CELL_GAP * 2,
        rx: 2,
        fill: paletteColor(color, 'cell'),
        stroke: paletteColor(color, 'piece'),
        'stroke-width': 3
      });
      make('circle', {
        cx, cy, r: CELL * .16,
        fill: neutral,
        stroke: paletteColor(color, 'piece'),
        'stroke-width': 1.5
      });
    });

    Object.entries(LANE).forEach(([color, points]) => {
      points.forEach(([cx, cy]) => {
        make('rect', {
          x: cx - CELL / 2 + CELL_GAP,
          y: cy - CELL / 2 + CELL_GAP,
          width: CELL - CELL_GAP * 2,
          height: CELL - CELL_GAP * 2,
          rx: 2,
          fill: paletteColor(color, 'cell'),
          stroke: boardBorder,
          'stroke-width': 1.2
        });
      });
    });

    // The central finish is one continuous 3×3 field; no internal grid lines.
    const finishX1 = GRID_ORIGIN + 6 * CELL + CELL_GAP;
    const finishY1 = GRID_ORIGIN + 6 * CELL + CELL_GAP;
    const finishX2 = GRID_ORIGIN + 9 * CELL - CELL_GAP;
    const finishY2 = GRID_ORIGIN + 9 * CELL - CELL_GAP;
    const finishCx = (finishX1 + finishX2) / 2;
    const finishCy = (finishY1 + finishY2) / 2;
    make('rect', {
      x: finishX1, y: finishY1,
      width: finishX2 - finishX1, height: finishY2 - finishY1,
      rx: 5, fill: neutral, stroke: boardBorder, 'stroke-width': 2
    });
    make('polygon', { points: `${finishCx},${finishCy} ${finishX1},${finishY1} ${finishX1},${finishY2}`, fill: paletteColor('yellow', 'cell') });
    make('polygon', { points: `${finishCx},${finishCy} ${finishX1},${finishY1} ${finishX2},${finishY1}`, fill: paletteColor('blue', 'cell') });
    make('polygon', { points: `${finishCx},${finishCy} ${finishX2},${finishY1} ${finishX2},${finishY2}`, fill: paletteColor('green', 'cell') });
    make('polygon', { points: `${finishCx},${finishCy} ${finishX1},${finishY2} ${finishX2},${finishY2}`, fill: paletteColor('red', 'cell') });
    make('rect', { x: finishX1, y: finishY1, width: finishX2-finishX1, height: finishY2-finishY1, rx: 5, fill: 'none', stroke: boardBorder, 'stroke-width': 2 });

    // Four small neutral arrows inside the trigger cells. They are not tied to selection highlighting.
    Object.values(SHORTCUTS).forEach(shortcut => {
      const from = MAIN_PATH[shortcut.trigger];
      const to = MAIN_PATH[shortcut.destination];
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      appendCustomArrow(svg, from[0], from[1], dx, dy, CELL * .18, 'board-direction-arrow');
    });
  }


})();
