'use strict';

// ============================================================
// Configuration
// ============================================================
const JANUS_WS_URL = 'wss://janus-legacy.conf.meetecho.com/ws';
const DISPLAY_DOMAIN = 'janus-legacy.conf.meetecho.com';
const ROOM_PIN = 'sors';
const ROOM_SECRET = 'sors';
const ADMIN_KEY = 'PASSWORD-ADMIN-KEY';   // Replace with your actual admin key
const INCOMING_CALL_TIMEOUT_MS = 45000;   // Auto-dismiss incoming modal after this

// ============================================================
// State
// ============================================================
let janus = null;
let callHandle = null;
let roomHandle = null;

let myUsername = null;
let peerUsername = null;
let isVideoCall = true;
let pendingIncomingJsep = null;
let isInCall = false;
let incomingCallTimeoutId = null;         // safety net for the modal

let myFeedId = null;
let privateId = null;
let subscribers = {};
let myStream = null;
let isInRoom = false;
let currentRoomId = null;
let myDisplayName = null;

const opaqueId = 'dual-' + Janus.randomString(12);
let listRefreshInterval = null;

const modals = {};
let els = {};

let pendingUserList = null;
let pendingRoomList = null;

pageLog('call.js loaded', 'info');

// ============================================================
// Helpers
// ============================================================
function byId(id) { return document.getElementById(id); }
function show(el) { if (el) el.classList.remove('d-none'); }
function hide(el) { if (el) el.classList.add('d-none'); }

function showAlert(message) {
	pageLog('showAlert: ' + message, 'warn');
	els.alertBody.textContent = message;
	modals.alert.show();
}

function setStatus(text, variant) {
	pageLog('setStatus: ' + text, 'info');
	els.statusBadge.textContent = text;
	els.statusBadge.className = 'badge ' + (variant || 'bg-secondary');
}

function notifyIncomingCall(fromUser) {
	if (!('Notification' in window) || Notification.permission !== 'granted') return;
	try { new Notification('Incoming call', { body: fromUser + ' is calling you' }); } catch(e) {}
}

// ============================================================
// Sound Engine — hybrid (mp3 first, Web Audio fallback)
//
// IMPORTANT DESIGN NOTE
// The slot for a given sound is reserved SYNCHRONOUSLY when play()
// is called. If stop() runs before the mp3 promise settles, the slot
// is marked cancelled and the Web Audio fallback knows to abort.
// This prevents the "ring keeps playing after hangup" bug.
// ============================================================
const SOUND_PROFILES = {
	incoming: {
		mp3: 'assets/ring.mp3',
		vibrate: [1000, 1000, 1000, 1000, 1000, 1000],
		webAudio: { freqs: [440, 480], burstMs: 2000, gapMs: 4000, gain: 0.15 }
	},
	ringback: {
		mp3: 'assets/ringBack.mp3',
		vibrate: null,
		webAudio: { freqs: [440, 480], burstMs: 2000, gapMs: 4000, gain: 0.10 }
	},
	userJoined: {
		mp3: null,
		vibrate: null,
		webAudio: { freqs: [880], burstMs: 150, gapMs: 0, gain: 0.10 }
	},
	hangup: {
		mp3: null,
		vibrate: null,
		webAudio: { freqs: [600, 400], burstMs: 200, gapMs: 100, gain: 0.12, repeatBursts: 2 }
	}
};

const SoundEngine = (function () {
	const audios = {};   // name -> HTMLAudioElement
	const active = {};   // name -> { intervalId, oscillators, cancelled }
	let ctx = null;
	let warmedUp = false;

	function getContext() {
		if (ctx) return ctx;
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) return null;
		try { ctx = new Ctx(); } catch (e) { ctx = null; }
		return ctx;
	}

	function prepare() {
		Object.keys(SOUND_PROFILES).forEach(function (name) {
			const p = SOUND_PROFILES[name];
			if (!p.mp3) return;
			const a = new Audio(p.mp3);
			a.preload = 'auto';
			a.loop = true;
			a.volume = 1.0;
			audios[name] = a;
		});
		getContext();
		pageLog('SoundEngine prepared', 'debug');
	}

	function warmUp() {
		if (warmedUp) return;
		warmedUp = true;

		const c = getContext();
		if (c && c.state === 'suspended') c.resume().catch(function () {});

		Object.keys(audios).forEach(function (name) {
			const a = audios[name];
			const prevMuted = a.muted;
			a.muted = true;
			const p = a.play();
			const done = function () {
				setTimeout(function () {
					try { a.pause(); a.currentTime = 0; } catch (e) {}
					a.muted = prevMuted;
				}, 30);
			};
			if (p && p.then) p.then(done).catch(function () { a.muted = prevMuted; });
			else done();
		});
		pageLog('SoundEngine warmed up on first gesture', 'debug');
	}

	function play(name) {
		const profile = SOUND_PROFILES[name];
		if (!profile) { pageLog('Unknown sound: ' + name, 'warn'); return; }

		// Stop any previous instance of this same sound first
		stop(name);

		// Reserve a slot SYNCHRONOUSLY so stop() can cancel this attempt
		// even if it is called before the mp3 promise settles.
		const slot = { intervalId: null, oscillators: [], cancelled: false };
		active[name] = slot;

		if (profile.mp3 && audios[name]) {
			const a = audios[name];
			a.currentTime = 0;
			const p = a.play();
			if (p && p.then) {
				p.then(function () {
					pageLog('Sound "' + name + '" (mp3) playing', 'debug');
				}).catch(function (e) {
					if (slot.cancelled || active[name] !== slot) {
						pageLog('Sound "' + name + '" mp3 failed but attempt was already cancelled', 'debug');
						return;
					}
					pageLog('Sound "' + name + '" mp3 blocked (' + e.message + ') – using Web Audio', 'warn');
					startWebAudio(name, profile, slot);
				});
			}
		} else {
			startWebAudio(name, profile, slot);
		}

		if (profile.vibrate && navigator.vibrate) {
			try { navigator.vibrate(profile.vibrate); } catch (e) {}
		}
	}

	function stop(name) {
		if (audios[name]) {
			try { audios[name].pause(); audios[name].currentTime = 0; } catch (e) {}
		}
		const slot = active[name];
		if (slot) {
			slot.cancelled = true;
			if (slot.intervalId != null) { clearInterval(slot.intervalId); slot.intervalId = null; }
			if (slot.oscillators) {
				slot.oscillators.forEach(function (osc) { try { osc.stop(); } catch (e) {} });
				slot.oscillators = [];
			}
			delete active[name];
		}
		if (SOUND_PROFILES[name] && SOUND_PROFILES[name].vibrate && navigator.vibrate) {
			try { navigator.vibrate(0); } catch (e) {}
		}
	}

	function stopAll() {
		Object.keys(SOUND_PROFILES).forEach(stop);
	}

	function startWebAudio(name, profile, slot) {
		// If stop() ran while we were waiting on the mp3 promise, abort.
		if (!slot || slot.cancelled || active[name] !== slot) {
			pageLog('Web Audio "' + name + '" aborted (was cancelled)', 'debug');
			return;
		}
		const c = getContext();
		if (!c) { pageLog('No Web Audio – cannot play "' + name + '"', 'warn'); return; }
		if (c.state === 'suspended') c.resume().catch(function () {});

		const spec = profile.webAudio || { freqs: [440], burstMs: 300, gapMs: 0, gain: 0.12 };

		function burst() {
			// If the slot was cancelled since scheduling, skip this burst
			if (slot.cancelled || active[name] !== slot) return;
			const now = c.currentTime;
			const seconds = spec.burstMs / 1000;
			const repeat = spec.repeatBursts || 1;
			const gap = (spec.gapMs || 0) / 1000;

			for (let i = 0; i < repeat; i++) {
				const t0 = now + i * (seconds + gap);
				spec.freqs.forEach(function (freq) {
					const osc = c.createOscillator();
					const g = c.createGain();
					osc.type = 'sine';
					osc.frequency.value = freq;
					g.gain.setValueAtTime(0.0001, t0);
					g.gain.linearRampToValueAtTime(spec.gain, t0 + 0.05);
					g.gain.setValueAtTime(spec.gain, t0 + Math.max(0.06, seconds - 0.05));
					g.gain.linearRampToValueAtTime(0.0001, t0 + seconds);
					osc.connect(g).connect(c.destination);
					osc.start(t0);
					osc.stop(t0 + seconds + 0.05);
					slot.oscillators.push(osc);
					osc.onended = function () {
						const idx = slot.oscillators.indexOf(osc);
						if (idx > -1) slot.oscillators.splice(idx, 1);
					};
				});
			}
		}

		burst();
		if (spec.gapMs > 0) {
			slot.intervalId = setInterval(burst, spec.burstMs + spec.gapMs);
		}
	}

	['click', 'touchstart', 'keydown'].forEach(function (ev) {
		document.addEventListener(ev, warmUp, { capture: true, passive: true });
	});

	return { prepare: prepare, play: play, stop: stop, stopAll: stopAll };
})();

function playRing()      { SoundEngine.play('incoming'); }
function stopRing()      { SoundEngine.stop('incoming'); }
function playRingback()  { SoundEngine.play('ringback'); }
function stopRingback()  { SoundEngine.stop('ringback'); }

// ============================================================
// Janus logging hook
// ============================================================
function hookJanusLogging() {
	['trace', 'debug', 'vdebug', 'log', 'warn', 'error'].forEach(function (level) {
		const original = Janus[level];
		if (typeof original !== 'function') return;
		Janus[level] = function () {
			const args = Array.prototype.slice.call(arguments);
			try { original.apply(console, args); } catch (e) {}
			const text = args.map(function (a) {
				if (typeof a === 'string') return a;
				try { return JSON.stringify(a); } catch (e2) { return String(a); }
			}).join(' ');
			pageLog('[janus.js] ' + text, level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'debug'));
		};
	});
	pageLog('Janus logging hooked', 'info');
}

// ============================================================
// Janus bootstrap
// ============================================================
function initJanus() {
	pageLog('initJanus()', 'info');
	setStatus('Connecting…', 'bg-secondary');
	try {
		Janus.init({
			debug: 'all',
			callback: function () {
				pageLog('Janus.init() ready', 'info');
				hookJanusLogging();

				if (!Janus.isWebrtcSupported()) {
					pageLog('WebRTC not supported', 'error');
					setStatus('Unsupported browser', 'bg-danger');
					showAlert('This browser does not support WebRTC.');
					return;
				}
				pageLog('Opening session to ' + JANUS_WS_URL, 'info');
				janus = new Janus({
					server: JANUS_WS_URL,
					success: function () {
						pageLog('Janus session created OK', 'info');
						show(els.callWorkspace);
						setStatus('Ready', 'bg-success');
						attachCallPlugin();
						attachRoomPlugin();
						refreshList();
						listRefreshInterval = setInterval(refreshList, 30000);
					},
					error: function (error) {
						pageLog('Janus session error: ' + error, 'error');
						setStatus('Connection failed', 'bg-danger');
						showAlert('Could not connect to the call server: ' + error);
					},
					destroyed: function () {
						pageLog('Janus session destroyed', 'warn');
						setStatus('Disconnected', 'bg-danger');
						if (listRefreshInterval) clearInterval(listRefreshInterval);
					}
				});
			}
		});
	} catch (e) {
		pageLog('Exception in Janus.init(): ' + e.message, 'error');
		setStatus('Init failed', 'bg-danger');
		showAlert('Could not initialize Janus: ' + e.message);
	}
}

// ============================================================
// Attach plugins
// ============================================================
function attachCallPlugin() {
	if (callHandle) return;
	pageLog('Attaching videocall plugin…', 'info');
	janus.attach({
		plugin: 'janus.plugin.videocall',
		opaqueId: opaqueId,
		success: function (handle) {
			callHandle = handle;
			pageLog('VideoCall attached', 'info');
			registerRandomUser();
		},
		error: function (error) {
			pageLog('VideoCall attach error: ' + error, 'error');
		},
		consentDialog: function (on) { pageLog('consentDialog(call): ' + on, 'debug'); },
		onmessage: onCallMessage,
		onlocalstream: function (stream) {
			pageLog('Call local stream', 'info');
			Janus.attachMediaStream(els.localVideo, stream);
			show(els.localTile);
		},
		onremotestream: function (stream) {
			pageLog('Call remote stream', 'info');
			Janus.attachMediaStream(els.remoteVideo, stream);
			show(els.remoteTile);
		},
		oncleanup: function () {
			pageLog('Call cleanup', 'info');
			onCallEnded();
		}
	});
}

function attachRoomPlugin() {
	if (roomHandle) return;
	pageLog('Attaching videoroom plugin…', 'info');
	janus.attach({
		plugin: 'janus.plugin.videoroom',
		opaqueId: opaqueId,
		success: function (handle) {
			roomHandle = handle;
			pageLog('VideoRoom attached', 'info');
		},
		error: function (error) {
			pageLog('VideoRoom attach error: ' + error, 'error');
		},
		consentDialog: function (on) { pageLog('consentDialog(room): ' + on, 'debug'); },
		onmessage: onRoomMessage,
		onlocalstream: onRoomLocalStream,
		oncleanup: function () {
			pageLog('Room cleanup', 'info');
			if (isInRoom) leaveRoom(true);
		}
	});
}

// ============================================================
// Registration (videocall)
// ============================================================
function registerRandomUser() {
	const stx = Janus.randomString(3);
	myUsername = stx;
	myDisplayName = stx + '@' + DISPLAY_DOMAIN;
	pageLog('registerRandomUser -> ' + stx, 'info');
	document.title = 'Sors.Call - ' + myDisplayName;
	els.myIdentity.textContent = 'Sors.Call - ' + myDisplayName;
	setStatus('Registering…', 'bg-secondary');
	callHandle.send({
		message: { request: 'register', username: stx }
	});
}

// ============================================================
// Incoming-call modal helpers
// ============================================================
function clearIncomingTimeout() {
	if (incomingCallTimeoutId) {
		clearTimeout(incomingCallTimeoutId);
		incomingCallTimeoutId = null;
	}
}

function hideIncomingModal() {
	clearIncomingTimeout();
	if (modals.incoming) {
		try { modals.incoming.hide(); } catch (e) {}
	}
}

// ============================================================
// Message handlers
// ============================================================
function onCallMessage(msg, jsep) {
	pageLog('Call msg: ' + JSON.stringify(msg), 'debug');
	const result = msg['result'];
	if (result && result['list'] !== undefined) {
		pageLog('User list captured in onCallMessage', 'info');
		pendingUserList = result['list'];
		renderUnifiedList();
		return;
	}
	if (!result) {
		if (msg['error']) showAlert(msg['error']);
		return;
	}
	switch (result['event']) {
		case 'registered':
			myUsername = result['username'];
			setStatus('Ready', 'bg-success');
			refreshList();
			break;
		case 'calling':
			setStatus('Ringing ' + peerUsername + '…', 'bg-warning');
			playRingback();
			break;
		case 'incomingcall':
			peerUsername = result['username'];
			pendingIncomingJsep = jsep;
			isVideoCall = !!(jsep && jsep.sdp && jsep.sdp.indexOf('m=video') > -1);
			els.incomingCallerName.textContent = peerUsername;
			playRing();
			notifyIncomingCall(peerUsername);
			// Safety net: if no answer arrives and no hangup event reaches us,
			// dismiss the modal after INCOMING_CALL_TIMEOUT_MS so it does not
			// stay stuck forever.
			clearIncomingTimeout();
			incomingCallTimeoutId = setTimeout(function () {
				pageLog('Incoming call timed out, auto-declining', 'warn');
				declineIncomingCall();
			}, INCOMING_CALL_TIMEOUT_MS);
			modals.incoming.show();
			break;
		case 'accepted':
			stopRingback();
			if (jsep) callHandle.handleRemoteJsep({ jsep: jsep });
			setStatus('In call with ' + peerUsername, 'bg-success');
			isInCall = true;
			updateHangupButton('call');
			showInCallUi();
			break;
		case 'hangup':
			pageLog('Remote peer hung up', 'info');
			stopRing();
			stopRingback();
			hideIncomingModal();
			callHandle.hangup();
			onCallEnded();
			break;
		default:
			pageLog('Unhandled call event: ' + result['event'], 'warn');
	}
}

function onRoomMessage(msg, jsep) {
	pageLog('Room msg: ' + JSON.stringify(msg), 'debug');
	const event = msg['videoroom'];
	if (!event) return;

	switch (event) {
		case 'joined':
			myFeedId = msg['id'];
			privateId = msg['private_id'];
			pageLog('Joined room, feed: ' + myFeedId, 'info');
			setStatus('In room ' + currentRoomId, 'bg-success');
			isInRoom = true;
			showInCallUi();
			updateHangupButton('room');
			publishRoomStream(roomHandle);
			listParticipants();
			break;

		case 'event':
			if (msg['publishers']) {
				const publishers = msg['publishers'];
				publishers.forEach(function (pub) {
					if (pub['id'] !== myFeedId) {
						createRoomSubscriber(pub['id'], pub['display']);
					}
				});
			}
			if (msg['published']) {
				const pub = msg['published'];
				if (pub['id'] !== myFeedId) {
					createRoomSubscriber(pub['id'], pub['display']);
					SoundEngine.play('userJoined');
				}
			}
			if (msg['unpublished']) {
				const feedId = msg['unpublished'];
				removeRoomSubscriber(feedId);
			}
			break;

		case 'leaving':
			pageLog('Leaving event', 'info');
			break;

		default:
			pageLog('Unhandled room event: ' + event, 'warn');
	}

	if (jsep) {
		roomHandle.handleRemoteJsep({ jsep: jsep });
	}
}

// ============================================================
// Room actions
// ============================================================
function createRoom() {
	if (!roomHandle) { showAlert('Room plugin not ready.'); return; }
	if (isInCall) hangupCall();
	if (isInRoom) leaveRoom(true);

	const input = els.peerInput.value.trim();
	if (!input) { joinRoom(1234); return; }

	if (/^\d+$/.test(input)) {
		joinRoom(parseInt(input, 10));
		return;
	}

	const description = input;
	pageLog('Looking for room with description: ' + description, 'info');
	roomHandle.send({
		message: { request: 'list' },
		success: function (data) {
			const rooms = data.list || [];
			const found = rooms.find(function (r) { return r.description === description; });
			if (found) {
				joinRoom(found.room);
			} else {
				attemptCreateRoom(description);
			}
		},
		error: function () { attemptCreateRoom(description); }
	});
}

function attemptCreateRoom(description) {
	const roomId = Math.floor(Math.random() * 9000 + 1000);
	pageLog('Creating room ' + roomId + ': ' + description, 'info');
	setStatus('Creating room…', 'bg-warning');

	roomHandle.send({
		message: {
			request: 'create',
			room: roomId,
			description: description,
			pin: ROOM_PIN,
			secret: ROOM_SECRET,
			admin_key: ADMIN_KEY,
			permanent: false,
			is_private: false,
			notify_joining: true,
			publishers: 10,
			bitrate: 128000
		},
		success: function () { joinRoom(roomId); },
		error: function (error) {
			pageLog('Create failed: ' + error, 'error');
			showAlert('Could not create room: ' + error);
			joinRoom(1234);
		}
	});
}

function joinRoom(roomId) {
	if (!roomHandle) { showAlert('Room plugin not ready.'); return; }
	if (isInCall) hangupCall();
	if (isInRoom && currentRoomId === roomId) return;
	if (isInRoom) leaveRoom(true);

	currentRoomId = roomId;
	pageLog('Joining room ' + roomId, 'info');
	setStatus('Joining room…', 'bg-warning');

	roomHandle.send({
		message: {
			request: 'join',
			room: roomId,
			ptype: 'publisher',
			display: myDisplayName,
			pin: ROOM_PIN
		},
		success: function () { pageLog('Join request sent', 'info'); },
		error: function (error) {
			pageLog('Join error: ' + error, 'error');
			showAlert('Failed to join room: ' + error);
			currentRoomId = null;
		}
	});
}

// ============================================================
// Participants
// ============================================================
function listParticipants() {
	if (!roomHandle) return;
	pageLog('Requesting list of participants in room ' + currentRoomId, 'info');
	roomHandle.send({
		message: { request: 'listparticipants', room: currentRoomId },
		success: function (data) {
			if (data && data.participants) {
				data.participants.forEach(function (participant) {
					if (participant.id !== myFeedId) {
						createRoomSubscriber(participant.id, participant.display);
					}
				});
			}
		},
		error: function (error) { pageLog('listparticipants error: ' + error, 'error'); }
	});
}

function publishRoomStream(handle) {
	pageLog('Publishing stream to room', 'info');
	handle.createOffer({
		media: { audio: true, video: true },
		success: function (jsep) {
			handle.send({ message: { request: 'publish' }, jsep: jsep });
		},
		error: function (error) {
			pageLog('Publish error: ' + error.message, 'error');
			showAlert('Could not publish: ' + error.message);
			leaveRoom(false);
		}
	});
}

function onRoomLocalStream(stream) {
	pageLog('Room local stream', 'info');
	myStream = stream;
	const grid = els.videoGrid;
	grid.classList.remove('d-none');
	hide(els.videoStage);

	const tile = document.createElement('div');
	tile.className = 'video-tile';
	tile.id = 'localTileRoom';
	const video = document.createElement('video');
	video.autoplay = true;
	video.playsInline = true;
	video.muted = true;
	video.srcObject = stream;
	const label = document.createElement('div');
	label.className = 'tile-label';
	label.textContent = 'You';
	tile.appendChild(video);
	tile.appendChild(label);
	grid.prepend(tile);
}

// ============================================================
// Subscribers — synchronous reservation prevents duplicates
// ============================================================
function createRoomSubscriber(feedId, displayName) {
	if (subscribers[feedId]) {
		pageLog('Already subscribed (or subscribing) to ' + feedId, 'debug');
		return;
	}
	subscribers[feedId] = {
		handle: null,
		display: displayName,
		element: null,
		pending: true
	};

	pageLog('Subscribing to ' + feedId + ' (' + displayName + ')', 'info');

	janus.attach({
		plugin: 'janus.plugin.videoroom',
		opaqueId: opaqueId,
		success: function (subHandle) {
			const sub = subscribers[feedId];
			if (!sub) {
				subHandle.detach({ asyncRequest: false });
				return;
			}
			sub.handle = subHandle;
			sub.pending = false;

			subHandle.onmessage = function(msg, jsep) {
				pageLog('Subscriber message for ' + feedId + ': ' + JSON.stringify(msg), 'debug');
				if (jsep) {
					subHandle.createAnswer({
						jsep: jsep,
						media: { audioSend: false, audioRecv: true, videoSend: false, videoRecv: true },
						success: function (answerJsep) {
							subHandle.send({
								message: {
									request: 'start',
									room: currentRoomId,
									ptype: 'subscriber',
									feed: feedId,
									private_id: privateId
								},
								jsep: answerJsep
							});
						},
						error: function (error) { pageLog('Create answer error: ' + error, 'error'); }
					});
				}
			};

			subHandle.send({
				message: {
					request: 'join',
					room: currentRoomId,
					ptype: 'subscriber',
					feed: feedId,
					private_id: privateId,
					pin: ROOM_PIN
				},
				error: function (error) { pageLog('Subscriber join error: ' + error, 'error'); }
			});
		},
		onremotestream: function (stream) {
			const sub = subscribers[feedId];
			if (!sub) return;

			if (sub.element) {
				pageLog('Ignoring duplicate remote stream for ' + feedId, 'warn');
				return;
			}

			const grid = els.videoGrid;
			const tile = document.createElement('div');
			tile.className = 'video-tile';
			const video = document.createElement('video');
			video.autoplay = true;
			video.playsInline = true;
			video.srcObject = stream;
			const label = document.createElement('div');
			label.className = 'tile-label';
			label.textContent = sub.display || 'Unknown';
			tile.appendChild(video);
			tile.appendChild(label);
			grid.appendChild(tile);
			sub.element = tile;
			sub.stream = stream;
		},
		oncleanup: function () { removeRoomSubscriber(feedId); },
		error: function (error) {
			pageLog('Subscriber attach error: ' + error, 'error');
			if (subscribers[feedId] && subscribers[feedId].pending) {
				delete subscribers[feedId];
			}
		}
	});
}

function removeRoomSubscriber(feedId) {
	const sub = subscribers[feedId];
	if (!sub) return;
	delete subscribers[feedId];    // delete FIRST to break recursion
	if (sub.element && sub.element.parentNode) {
		sub.element.parentNode.removeChild(sub.element);
	}
	if (sub.handle) {
		sub.handle.detach({ asyncRequest: false });
	}
}

// ============================================================
// Leave room
// ============================================================
function leaveRoom(silent) {
	if (!isInRoom) return;
	isInRoom = false;
	pageLog('Leaving room', 'info');

	if (roomHandle) {
		roomHandle.send({ message: { request: 'unpublish' } });
		roomHandle.hangup();
	}

	Object.keys(subscribers).forEach(function (feedId) {
		removeRoomSubscriber(feedId);
	});

	const localTile = document.getElementById('localTileRoom');
	if (localTile) localTile.remove();
	els.videoGrid.classList.add('d-none');
	els.videoGrid.innerHTML = '';
	hide(els.videoStage);
	hide(els.inCallBar);
	currentRoomId = null;
	myFeedId = null;
	privateId = null;
	myStream = null;

	setStatus(myUsername ? ('Registered as ' + myUsername) : 'Ready', 'bg-success');
	refreshList();
	if (!silent) pageLog('Left room', 'info');
}

// ============================================================
// Direct calls
// ============================================================
function startCall(username) {
	if (!callHandle) { showAlert('Call plugin not ready.'); return; }
	if (isInRoom) leaveRoom(true);
	if (isInCall) hangupCall();

	peerUsername = username;
	isVideoCall = true;
	setStatus('Calling ' + username + '…', 'bg-warning');
	showInCallUi();
	updateHangupButton('call');

	callHandle.createOffer({
		media: { audioSend: true, audioRecv: true, videoSend: true, videoRecv: true },
		success: function (jsep) {
			callHandle.send({ message: { request: 'call', username: username }, jsep: jsep });
		},
		error: function (error) {
			pageLog('Start call error: ' + error.message, 'error');
			showAlert('Could not start call: ' + error.message);
			onCallEnded();
		}
	});
}

function answerIncomingCall() {
	clearIncomingTimeout();
	hideIncomingModal();
	stopRing();
	showInCallUi();
	updateHangupButton('call');
	isInCall = true;

	callHandle.createAnswer({
		jsep: pendingIncomingJsep,
		media: { audioSend: true, audioRecv: true, videoSend: true, videoRecv: true },
		success: function (jsep) {
			callHandle.send({ message: { request: 'accept' }, jsep: jsep });
			setStatus('In call with ' + peerUsername, 'bg-success');
		},
		error: function (error) {
			showAlert('Could not answer: ' + error.message);
			callHandle.send({ message: { request: 'hangup' } });
			onCallEnded();
		}
	});
	pendingIncomingJsep = null;
}

function declineIncomingCall() {
	clearIncomingTimeout();
	hideIncomingModal();
	stopRing();
	if (callHandle) {
		callHandle.send({ message: { request: 'hangup' } });
	}
	pendingIncomingJsep = null;
	peerUsername = null;
}

// Works while the call is still ringing AND once it is connected.
// `peerUsername` is set the moment we start calling or receive an
// incoming call, and cleared in onCallEnded.
function hangupCall() {
	if (!callHandle) return;
	if (!peerUsername && !isInCall) return;

	// Send the hangup request first so it goes out on the WebSocket
	// before any local teardown.
	callHandle.send({ message: { request: 'hangup' } });
	SoundEngine.play('hangup');

	// Local cleanup. This fires the plugin's oncleanup, which calls
	// onCallEnded() for us, so no explicit call is needed here.
	callHandle.hangup();
}

function onCallEnded() {
	stopRing();
	stopRingback();
	hideIncomingModal();
	isInCall = false;

	hide(els.inCallBar);
	hide(els.videoStage);
	hide(els.localTile);
	hide(els.remoteTile);
	els.localVideo.srcObject = null;
	els.remoteVideo.srcObject = null;
	els.micBtn.classList.remove('muted');
	els.micBtn.querySelector('i').className = 'bi bi-mic-fill';
	els.cameraBtn.classList.remove('muted');
	els.cameraBtn.querySelector('i').className = 'bi bi-camera-video-fill';

	peerUsername = null;
	if (myUsername) {
		setStatus('Registered as ' + myUsername, 'bg-success');
		refreshList();
	} else {
		setStatus('Ready', 'bg-success');
	}
}

function showInCallUi() {
	show(els.inCallBar);
	if (isInRoom) {
		hide(els.videoStage);
		show(els.videoGrid);
	} else {
		show(els.videoStage);
		hide(els.videoGrid);
	}
}

function updateHangupButton(mode) {
	const btn = els.hangupBtn;
	if (mode === 'call') {
		btn.innerHTML = '<i class="bi bi-telephone-x-fill"></i>';
		btn.title = 'Hang up';
	} else {
		btn.innerHTML = '<i class="bi bi-box-arrow-right"></i>';
		btn.title = 'Leave room';
	}
}

// ============================================================
// Unified list
// ============================================================
function refreshList() {
	pageLog('refreshList()', 'debug');
	if (!callHandle || !roomHandle) {
		pageLog('Plugins not ready', 'warn');
		return;
	}
	pendingUserList = null;
	pendingRoomList = null;

	callHandle.send({ message: { request: 'list' } });

	roomHandle.send({
		message: { request: 'list' },
		success: function (data) {
			if (data && data.list) {
				pendingRoomList = data.list;
				renderUnifiedList();
			}
		},
		error: function (error) { pageLog('Room list error: ' + error, 'error'); }
	});
}

function renderUnifiedList() {
	pageLog('renderUnifiedList called', 'debug');
	if (pendingUserList === null || pendingRoomList === null) {
		pageLog('Waiting for both lists', 'debug');
		return;
	}
	const container = els.unifiedList;
	container.innerHTML = '';

	const users = Array.isArray(pendingUserList) ? pendingUserList : Object.values(pendingUserList || {});
	const rooms = Array.isArray(pendingRoomList) ? pendingRoomList : Object.values(pendingRoomList || {});

	const otherUsers = users.filter(function (u) { return u !== myUsername; });

	otherUsers.forEach(function (name) {
		const item = document.createElement('span');
		item.className = 'list-item user';
		item.innerHTML = '<span class="icon">👤</span><span class="name">' + name + '</span>';
		item.addEventListener('click', function () { startCall(name); });
		container.appendChild(item);
	});

	rooms.forEach(function (room) {
		const roomId = room.room || room;
		const description = room.description || 'Room ' + roomId;
		const item = document.createElement('span');
		item.className = 'list-item room';
		item.innerHTML = '<span class="icon">👥</span><span class="name">' + description + '</span>';
		item.addEventListener('click', function () { joinRoom(roomId); });
		container.appendChild(item);
	});

	if (otherUsers.length === 0 && rooms.length === 0) {
		container.innerHTML = '<span class="text-muted small">No users or rooms available.</span>';
	}

	pendingUserList = null;
	pendingRoomList = null;
}

// ============================================================
// Controls
// ============================================================
function toggleMic() {
	const handle = isInRoom ? roomHandle : callHandle;
	if (!handle) return;
	const btn = els.micBtn;
	const icon = btn.querySelector('i');
	if (handle.isAudioMuted()) {
		handle.unmuteAudio();
		btn.classList.remove('muted');
		icon.className = 'bi bi-mic-fill';
	} else {
		handle.muteAudio();
		btn.classList.add('muted');
		icon.className = 'bi bi-mic-mute-fill';
	}
}

function toggleCamera() {
	const handle = isInRoom ? roomHandle : callHandle;
	if (!handle) return;
	const btn = els.cameraBtn;
	const icon = btn.querySelector('i');
	if (handle.isVideoMuted()) {
		handle.unmuteVideo();
		btn.classList.remove('muted');
		icon.className = 'bi bi-camera-video-fill';
	} else {
		handle.muteVideo();
		btn.classList.add('muted');
		icon.className = 'bi bi-camera-video-off-fill';
	}
}

function hangupAction() {
	if (peerUsername || isInCall) {
		hangupCall();
	} else if (isInRoom) {
		leaveRoom(false);
	} else {
		pageLog('Nothing to hang up', 'info');
	}
}

// ============================================================
// UI wiring
// ============================================================
document.addEventListener('DOMContentLoaded', function () {
	pageLog('DOMContentLoaded', 'info');

	els = {
		statusBadge: byId('statusBadge'),
		myIdentity: byId('myIdentity'),
		callWorkspace: byId('callWorkspace'),
		peerInput: byId('peerInput'),
		videoCallBtn: byId('videoCallBtn'),
		roomCreateBtn: byId('roomCreateBtn'),
		refreshListBtn: byId('refreshListBtn'),
		unifiedList: byId('unifiedList'),
		videoStage: byId('videoStage'),
		localTile: byId('localTile'),
		remoteTile: byId('remoteTile'),
		localVideo: byId('localVideo'),
		remoteVideo: byId('remoteVideo'),
		videoGrid: byId('videoGrid'),
		inCallBar: byId('inCallBar'),
		micBtn: byId('micBtn'),
		cameraBtn: byId('cameraBtn'),
		hangupBtn: byId('hangupBtn'),
		incomingCallerName: byId('incomingCallerName'),
		answerBtn: byId('answerBtn'),
		declineBtn: byId('declineBtn'),
		alertBody: byId('alertBody')
	};

	if (typeof bootstrap !== 'undefined') {
		modals.incoming = new bootstrap.Modal(byId('incomingCallModal'), { backdrop: 'static', keyboard: false });
		modals.alert = new bootstrap.Modal(byId('alertModal'));
	} else {
		pageLog('Bootstrap JS missing', 'error');
	}

	SoundEngine.prepare();

	if ('Notification' in window && Notification.permission === 'default') {
		Notification.requestPermission();
	}

	els.videoCallBtn.addEventListener('click', function () {
		const name = els.peerInput.value.trim();
		if (!name) { showAlert('Enter a username to call.'); return; }
		startCall(name);
	});

	els.roomCreateBtn.addEventListener('click', createRoom);
	els.refreshListBtn.addEventListener('click', refreshList);

	els.peerInput.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') {
			const name = els.peerInput.value.trim();
			if (name) startCall(name);
		}
	});

	els.micBtn.addEventListener('click', toggleMic);
	els.cameraBtn.addEventListener('click', toggleCamera);
	els.hangupBtn.addEventListener('click', hangupAction);

	els.answerBtn.addEventListener('click', answerIncomingCall);
	els.declineBtn.addEventListener('click', declineIncomingCall);

	if (typeof Janus === 'undefined') {
		pageLog('Janus undefined – janus.js missing', 'error');
		setStatus('janus.js missing', 'bg-danger');
		return;
	}
	initJanus();
});
