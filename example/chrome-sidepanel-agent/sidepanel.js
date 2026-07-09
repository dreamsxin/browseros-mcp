(() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    serviceUrl: 'http://127.0.0.1:8001',
  };

  const STORAGE_KEYS = {
    settings: 'browserControlAgentPanelSettings',
    sessionId: 'browserControlAgentPanelSessionId',
    messages: 'browserControlAgentPanelMessages',
  };

  const LEGACY_STORAGE_KEYS = {
    settings: 'browser' + 'osAgentPanelSettings',
    sessionId: 'browser' + 'osAgentPanelSessionId',
    messages: 'browser' + 'osAgentPanelMessages',
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    sessionId: null,
    messages: [],
    busy: false,
    editingLastUser: false,
    editingIndex: null,
    composerDraftBeforeEdit: '',
  };

  const $ = (selector) => document.querySelector(selector);
  const el = {
    messages: $('#messages'),
    emptyState: $('#empty-state'),
    promptInput: $('#prompt-input'),
    sendBtn: $('#send-btn'),
    cancelEditBtn: $('#cancel-edit-btn'),
    newChatBtn: $('#new-chat-btn'),
    serviceUrl: $('#service-url'),
    saveSettingsBtn: $('#save-settings-btn'),
    checkHealthBtn: $('#check-health-btn'),
    statusDot: $('#status-dot'),
    statusText: $('#status-text'),
    composer: $('#composer'),
  };

  async function loadState() {
    const data = await chrome.storage.local.get([
      ...Object.values(STORAGE_KEYS),
      ...Object.values(LEGACY_STORAGE_KEYS),
    ]);
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...(data[LEGACY_STORAGE_KEYS.settings] || {}),
      ...(data[STORAGE_KEYS.settings] || {}),
    };
    state.sessionId = data[STORAGE_KEYS.sessionId] || data[LEGACY_STORAGE_KEYS.sessionId] || null;
    const messages = data[STORAGE_KEYS.messages] || data[LEGACY_STORAGE_KEYS.messages];
    state.messages = Array.isArray(messages)
      ? messages
      : [];
  }

  async function persistState() {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: state.settings,
      [STORAGE_KEYS.sessionId]: state.sessionId,
      [STORAGE_KEYS.messages]: state.messages,
    });
  }

  function setBusy(busy) {
    state.busy = busy;
    el.sendBtn.disabled = busy;
    el.promptInput.disabled = busy;
    updateComposerMode();
  }

  function updateComposerMode() {
    el.sendBtn.textContent = state.busy
      ? 'Working...'
      : state.editingLastUser
        ? 'Resubmit'
        : 'Send';
    el.cancelEditBtn.classList.toggle('hidden', !state.editingLastUser || state.busy);
  }

  function updateStatus(kind, text) {
    el.statusDot.className = 'dot';
    if (kind === 'online') el.statusDot.classList.add('online');
    if (kind === 'error') el.statusDot.classList.add('error');
    el.statusText.textContent = text;
  }

  function render() {
    el.serviceUrl.value = state.settings.serviceUrl;
    const messages = state.messages;
    const keep = el.emptyState;
    [...el.messages.children].forEach((node) => {
      if (node !== keep) node.remove();
    });
    keep.classList.toggle('hidden', messages.length > 0);
    if (messages.length === 0) return;

    const lastUserIndex = findLastUserMessageIndex();
    for (const [index, message] of messages.entries()) {
      el.messages.appendChild(buildMessageNode(message, index, lastUserIndex));
    }
    scrollMessagesToBottom();
  }

  function scrollMessagesToBottom() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.messages.scrollTop = el.messages.scrollHeight;
      });
    });
  }

  function buildMessageNode(message, index, lastUserIndex) {
    const wrap = document.createElement('section');
    wrap.className = `message ${message.role}`;

    const header = document.createElement('div');
    header.className = 'message-header';

    const role = document.createElement('span');
    role.className = 'role';
    role.textContent =
      message.role === 'user' ? 'You' : message.role === 'error' ? 'Error' : 'Agent';

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${message.time || ''}${message.edited ? ' · edited' : ''}`;

    header.appendChild(role);
    const headerRight = document.createElement('div');
    headerRight.className = 'message-actions';
    headerRight.appendChild(meta);

    if (message.role === 'user' && index === lastUserIndex && !state.busy) {
      const editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'text-button';
      editButton.textContent = 'Edit';
      editButton.addEventListener('click', () => startEditLastUser());
      headerRight.appendChild(editButton);
    }

    header.appendChild(headerRight);

    const content = document.createElement('div');
    content.className = 'content';
    content.textContent = message.content || '';

    wrap.appendChild(header);
    wrap.appendChild(content);

    if (Array.isArray(message.events) && message.events.length > 0) {
      const details = document.createElement('details');
      details.className = 'trace';
      details.addEventListener('toggle', () => {
        if (details.open) scrollMessagesToBottom();
      });

      const summary = document.createElement('summary');
      summary.className = 'trace-summary';
      summary.textContent = `Execution trace (${message.events.length})`;
      details.appendChild(summary);

      const list = document.createElement('div');
      list.className = 'trace-list';

      for (const event of message.events) {
        const item = document.createElement('div');
        item.className = 'trace-item';

        const type = document.createElement('div');
        type.className = 'trace-type';
        type.textContent = `${event.timestamp || ''} ${event.type || 'event'}`.trim();

        const body = document.createElement('div');
        body.className = 'trace-text';
        body.textContent = formatEvent(event);

        item.appendChild(type);
        item.appendChild(body);
        list.appendChild(item);
      }

      details.appendChild(list);
      wrap.appendChild(details);
    }

    return wrap;
  }

  function formatEvent(event) {
    switch (event.type) {
      case 'status':
        return `${event.state}${event.turn ? ` turn=${event.turn}` : ''}${event.tool ? ` tool=${event.tool}` : ''}${event.elapsed_ms ? ` elapsed=${event.elapsed_ms}ms` : ''}`;
      case 'llm_request':
        return `messages=${event.message_count}, chars=${event.content_chars}\n${event.last_input || ''}`;
      case 'llm_response':
        return `finish_reason=${event.finish_reason}, tool_calls=${event.tool_calls}, cache=${event.cache}\n${event.content_preview || ''}`;
      case 'tool_call':
        return `${event.name}\n${safeJson(event.arguments)}`;
      case 'tool_result':
        return `${event.name} chars=${event.chars}\n${event.preview || ''}`;
      case 'diagnostic':
        return event.message || '';
      case 'agent_turn':
        return `tool_calls=${event.tool_calls}`;
      default:
        return safeJson(event);
    }
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (_error) {
      return String(value);
    }
  }

  function pushMessage(role, content, extra = {}) {
    state.messages.push({
      role,
      content,
      time: new Date().toLocaleTimeString(),
      ...extra,
    });
  }

  function findLastUserMessageIndex() {
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      if (state.messages[index].role === 'user') return index;
    }
    return -1;
  }

  function clearEditMode() {
    state.editingLastUser = false;
    state.editingIndex = null;
    state.composerDraftBeforeEdit = '';
    updateComposerMode();
  }

  function startEditLastUser() {
    const index = findLastUserMessageIndex();
    if (index < 0 || state.busy) return;
    state.editingLastUser = true;
    state.editingIndex = index;
    state.composerDraftBeforeEdit = el.promptInput.value;
    el.promptInput.value = state.messages[index].content || '';
    el.promptInput.focus();
    updateComposerMode();
    updateStatus('warn', 'Editing last question');
  }

  function cancelEditLastUser() {
    if (!state.editingLastUser || state.busy) return;
    const draft = state.composerDraftBeforeEdit || '';
    clearEditMode();
    el.promptInput.value = draft;
    el.promptInput.focus();
    updateStatus('warn', 'Edit canceled');
  }

  async function callService(path, payload, method = 'POST') {
    const url = state.settings.serviceUrl.replace(/\/$/, '') + path;
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = data && data.error ? data.error : `HTTP ${response.status}`;
      throw new Error(error);
    }
    return data;
  }

  async function checkHealth() {
    updateStatus('warn', 'Checking service...');
    try {
      const data = await callService('/health', null, 'GET');
      updateStatus('online', `${data.service} · ${data.model}`);
    } catch (error) {
      updateStatus('error', String(error.message || error));
    }
  }

  async function sendPrompt() {
    const message = el.promptInput.value.trim();
    if (!message || state.busy) return;

    const canReplaceLastUser =
      state.editingLastUser &&
      state.editingIndex === findLastUserMessageIndex();
    if (canReplaceLastUser) {
      state.messages = state.messages.slice(0, state.editingIndex);
    }
    pushMessage('user', message, canReplaceLastUser ? { edited: true } : {});
    clearEditMode();
    el.promptInput.value = '';
    render();
    scrollMessagesToBottom();
    await persistState();

    setBusy(true);
    updateStatus('warn', 'Running agent...');
    try {
      const response = await callService('/api/chat', {
        session_id: state.sessionId,
        message,
        replace_last_user: Boolean(canReplaceLastUser && state.sessionId),
      });
      state.sessionId = response.session_id || state.sessionId;
      if (response.ok) {
        pushMessage('assistant', response.answer || '(empty response)', {
          events: response.events || [],
        });
        updateStatus('online', `Completed in ${response.turns || 0} turn(s)`);
      } else {
        pushMessage('error', response.error || 'The agent did not finish cleanly.', {
          events: response.events || [],
        });
        updateStatus('error', response.error || 'Agent run failed');
      }
    } catch (error) {
      pushMessage('error', String(error.message || error));
      updateStatus('error', String(error.message || error));
    } finally {
      setBusy(false);
      render();
      scrollMessagesToBottom();
      await persistState();
    }
  }

  async function resetChat() {
    const previousSessionId = state.sessionId;
    state.sessionId = null;
    state.messages = [];
    clearEditMode();
    render();
    scrollMessagesToBottom();
    await persistState();
    updateStatus('warn', 'Chat reset');
    if (previousSessionId) {
      try {
        await callService('/api/reset', { session_id: previousSessionId });
      } catch (_error) {
        // The local state is already reset; ignore service cleanup failures.
      }
    }
  }

  async function saveSettings() {
    state.settings.serviceUrl = el.serviceUrl.value.trim() || DEFAULT_SETTINGS.serviceUrl;
    await persistState();
    updateStatus('warn', 'Settings saved');
    await checkHealth();
  }

  function bindEvents() {
    el.composer.addEventListener('submit', async (event) => {
      event.preventDefault();
      await sendPrompt();
    });

    el.promptInput.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        await sendPrompt();
      }
    });

    el.checkHealthBtn.addEventListener('click', checkHealth);
    el.saveSettingsBtn.addEventListener('click', saveSettings);
    el.newChatBtn.addEventListener('click', resetChat);
    el.cancelEditBtn.addEventListener('click', cancelEditLastUser);
  }

  async function init() {
    await loadState();
    bindEvents();
    render();
    await checkHealth();
  }

  init().catch((error) => {
    console.error('[browser-control-agent-panel] init failed', error);
    updateStatus('error', String(error.message || error));
  });
})();
