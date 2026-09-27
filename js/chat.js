'use strict';

/**
 * SorsChat — chat transport + UI module.
 *
 * Depends on:
 *   - @microsoft/signalr (loaded before this file in index.html)
 *   - window.pageLog (from index.html)
 *
 * Exposes:
 *   window.SorsChat = {
 *     setConfig, init, openConversation, closeConversation,
 *     sendText, sendFile, refreshBadges
 *   }
 *
 * Responsibilities:
 *   - SignalR connection to the chat hub (direct + room messages)
 *   - REST calls for sending / history / file download
 *   - Rendering message bubbles and unread badges
 *   - Wiring the input box, send button, and file picker
 *
 * NOT responsible for display switching (1/2/3).
 * The app shell in index.html calls openConversation / closeConversation
 * at the right moments.
 */
(function (window, document) {

	const DEFAULTS = {
		apiBase: '/api',
		hubUrl:  '/hubs/chat'
	};

	const state = {
		config: { ...DEFAULTS },
		myUsername: null,
		hub: null,
		active: null,              // { type: 'user' | 'room', id, key }
		conversations: {},         // key -> [MessageDto]
		unreadCounts: {},          // key -> number
		knownIds: new Set(),       // dedupe SignalR echoes of our own sends
		uiBound: false
	};

	// ---- Key helpers ----------------------------------------------------

	function keyFor(type, id) {
		return type + ':' + id;
	}

	function convoKeyFor(dto, me) {
		if (dto.roomId != null) return 'room:' + dto.roomId;
		var other = dto.sender === me ? dto.recipient : dto.sender;
		return 'user:' + other;
	}

	// ---- HTTP helpers ---------------------------------------------------

	function apiPost(path, body) {
		return fetch(state.config.apiBase + path, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		}).then(function (r) {
			if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.statusText); });
			return r.json();
		});
	}

	function apiPostForm(path, formData) {
		return fetch(state.config.apiBase + path, { method: 'POST', body: formData })
			.then(function (r) {
				if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.statusText); });
				return r.json();
			});
	}

	function apiGet(path) {
		return fetch(state.config.apiBase + path).then(function (r) {
			if (!r.ok) return r.text().then(function (t) { throw new Error(t || r.statusText); });
			return r.json();
		});
	}

	function absoluteApiUrl(relativeUrl) {
		if (!relativeUrl) return relativeUrl;
		if (/^https?:/i.test(relativeUrl)) return relativeUrl;
		// apiBase is like "/api" or "https://host/api" — strip the "/api" tail for the site root.
		var root = state.config.apiBase.replace(/\/api\/?$/i, '');
		return root + relativeUrl;
	}

	// ---- DOM helpers ----------------------------------------------------

	function el(id) { return document.getElementById(id); }

	function formatBytes(n) {
		if (n === null || n === undefined) return '';
		if (n < 1024) return n + ' B';
		if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
		return (n / (1024 * 1024)).toFixed(1) + ' MB';
	}

	function appendMessageUI(dto) {
		var container = el('chatMessages');
		if (!container) return;

		var emptyNotice = container.querySelector('.text-muted');
		if (emptyNotice) emptyNotice.remove();

		var mine = dto.sender === state.myUsername;
		var wrap = document.createElement('div');
		wrap.className = 'chat-msg ' + (mine ? 'local' : 'remote');

		if (!mine) {
			var label = document.createElement('span');
			label.className = 'sender-label';
			label.textContent = dto.sender;
			wrap.appendChild(label);
		}

		if (dto.kind === 'file') {
			var link = document.createElement('a');
			link.href = absoluteApiUrl(dto.fileUrl);
			link.className = 'chat-file-link';
			link.textContent = (dto.fileName || 'file') + ' (' + formatBytes(dto.fileSize) + ')';
			link.setAttribute('download', dto.fileName || '');
			link.target = '_blank';
			wrap.appendChild(link);
		} else {
			wrap.appendChild(document.createTextNode(dto.text || ''));
		}

		container.appendChild(wrap);
		container.scrollTop = container.scrollHeight;
	}

	function renderHistory(list) {
		var container = el('chatMessages');
		if (!container) return;
		container.innerHTML = '';
		if (!list || list.length === 0) {
			container.innerHTML = '<div class="text-muted small text-center mt-4">Conversation started</div>';
			return;
		}
		list.forEach(appendMessageUI);
	}

	function updateUnreadBadgesUI() {
		var items = document.querySelectorAll('.list-item[data-chat-key]');
		for (var i = 0; i < items.length; i++) {
			var item = items[i];
			var key = item.getAttribute('data-chat-key');
			var count = state.unreadCounts[key] || 0;
			var badge = item.querySelector('.unread-badge');

			if (count > 0) {
				if (!badge) {
					badge = document.createElement('span');
					badge.className = 'badge bg-danger unread-badge';
					item.appendChild(badge);
				}
				badge.textContent = count > 99 ? '99+' : String(count);
			} else if (badge) {
				badge.remove();
			}
		}
	}

	function clearUnread(key) {
		if (state.unreadCounts[key]) {
			state.unreadCounts[key] = 0;
			updateUnreadBadgesUI();
		}
	}

	// ---- SignalR --------------------------------------------------------

	function onHubMessage(dto) {
		if (!dto || dto.id == null) return;
		if (state.knownIds.has(dto.id)) return;
		state.knownIds.add(dto.id);

		var key = convoKeyFor(dto, state.myUsername);
		if (!state.conversations[key]) state.conversations[key] = [];
		state.conversations[key].push(dto);

		var isMine = dto.sender === state.myUsername;
		var isActive = state.active && state.active.key === key;

		if (isActive) {
			appendMessageUI(dto);
		} else if (!isMine) {
			state.unreadCounts[key] = (state.unreadCounts[key] || 0) + 1;
			updateUnreadBadgesUI();
		}
	}

	function startHub() {
		if (!window.signalR) {
			pageLog('[Chat] signalR client library not loaded', 'error');
			return Promise.resolve();
		}

		var url = state.config.hubUrl + '?username=' + encodeURIComponent(state.myUsername);
		state.hub = new signalR.HubConnectionBuilder()
			.withUrl(url)
			.withAutomaticReconnect()
			.build();

		state.hub.on('message', onHubMessage);

		return state.hub.start().then(function () {
			pageLog('[Chat] SignalR connected as ' + state.myUsername, 'info');
		}).catch(function (e) {
			pageLog('[Chat] SignalR connect failed: ' + e.message, 'error');
		});
	}

	// ---- UI event bindings ----------------------------------------------

	function bindUIEvents() {
		if (state.uiBound) return;
		state.uiBound = true;

		var sendBtn   = el('chatSendBtn');
		var input     = el('chatInput');
		var attachBtn = el('chatAttachBtn');
		var fileInput = el('chatFileInput');

		if (sendBtn && input) {
			sendBtn.addEventListener('click', function () {
				var t = input.value;
				input.value = '';
				SorsChat.sendText(t);
			});
		}

		if (input) {
			input.addEventListener('keydown', function (e) {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					var t = input.value;
					input.value = '';
					SorsChat.sendText(t);
				}
			});
		}

		if (attachBtn && fileInput) {
			attachBtn.addEventListener('click', function () { fileInput.click(); });
			fileInput.addEventListener('change', function () {
				var f = fileInput.files && fileInput.files[0];
				if (f) SorsChat.sendFile(f);
				fileInput.value = '';
			});
		}
	}

	// ---- Public API -----------------------------------------------------

	var SorsChat = {
		/** Override defaults before init (useful when API lives on another origin). */
		setConfig: function (cfg) {
			if (!cfg) return;
			if (cfg.apiBase) state.config.apiBase = cfg.apiBase;
			if (cfg.hubUrl)  state.config.hubUrl  = cfg.hubUrl;
		},

		/** Called once by call.js after Janus registration succeeds. */
		init: function (myUsername) {
			if (!myUsername) throw new Error('SorsChat.init requires a username');
			state.myUsername = myUsername;
			bindUIEvents();
			return startHub();
		},

		/** Called by the app shell when entering Display 3. */
		openConversation: function (type, id) {
			return SorsChat.closeConversation().then(function () {
				var key = keyFor(type, id);
				state.active = { type: type, id: id, key: key };
				clearUnread(key);

				var joinRoom = Promise.resolve();
				if (type === 'room' && state.hub && state.hub.state === 'Connected') {
					joinRoom = state.hub.invoke('JoinRoom', Number(id)).catch(function (e) {
						pageLog('[Chat] JoinRoom failed: ' + e.message, 'warn');
					});
				}

				var loadHistory;
				if (type === 'room') {
					loadHistory = apiGet('/messages/room/' + encodeURIComponent(id) + '?take=100');
				} else {
					loadHistory = apiGet(
						'/messages/direct?userA=' + encodeURIComponent(state.myUsername) +
						'&userB=' + encodeURIComponent(id) +
						'&take=100');
				}

				return joinRoom.then(function () { return loadHistory; }).then(function (history) {
					history.forEach(function (m) { state.knownIds.add(m.id); });
					state.conversations[key] = history.slice();
					renderHistory(history);
				}).catch(function (e) {
					pageLog('[Chat] History load failed: ' + e.message, 'error');
					renderHistory([]);
				});
			});
		},

		/** Called by the app shell when leaving Display 3. */
		closeConversation: function () {
			if (!state.active) return Promise.resolve();
			var prev = state.active;
			state.active = null;
			if (prev.type === 'room' && state.hub && state.hub.state === 'Connected') {
				return state.hub.invoke('LeaveRoom', Number(prev.id)).catch(function () {});
			}
			return Promise.resolve();
		},

		sendText: function (text) {
			var t = (text || '').trim();
			if (!t) return;
			if (!state.active) { pageLog('[Chat] No active conversation', 'warn'); return; }

			var payload = { sender: state.myUsername, text: t };
			if (state.active.type === 'room') payload.roomId = Number(state.active.id);
			else payload.recipient = state.active.id;

			apiPost('/messages/text', payload).then(function (dto) {
				state.knownIds.add(dto.id);
				var key = convoKeyFor(dto, state.myUsername);
				if (!state.conversations[key]) state.conversations[key] = [];
				state.conversations[key].push(dto);
				if (state.active && state.active.key === key) appendMessageUI(dto);
			}).catch(function (e) {
				pageLog('[Chat] Send failed: ' + e.message, 'error');
			});
		},

		sendFile: function (file) {
			if (!file) return;
			if (!state.active) { pageLog('[Chat] No active conversation', 'warn'); return; }

			var fd = new FormData();
			fd.append('sender', state.myUsername);
			if (state.active.type === 'room') fd.append('roomId', String(state.active.id));
			else fd.append('recipient', state.active.id);
			fd.append('file', file, file.name);

			apiPostForm('/messages/file', fd).then(function (dto) {
				state.knownIds.add(dto.id);
				var key = convoKeyFor(dto, state.myUsername);
				if (!state.conversations[key]) state.conversations[key] = [];
				state.conversations[key].push(dto);
				if (state.active && state.active.key === key) appendMessageUI(dto);
			}).catch(function (e) {
				pageLog('[Chat] File upload failed: ' + e.message, 'error');
			});
		},

		/** Re-render badges (called by the app shell when Display 2 is shown). */
		refreshBadges: function () {
			updateUnreadBadgesUI();
		}
	};

	window.SorsChat = SorsChat;
})(window, document);