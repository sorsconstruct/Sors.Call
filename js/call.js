'use strict';

// ============================================================
// Configuration
// ============================================================
const JANUS_WS_URL = 'wss://janus-legacy.conf.meetecho.com/ws';
const DISPLAY_DOMAIN = 'janus-legacy.conf.meetecho.com';
const ROOM_PIN = 'sors';
const ROOM_SECRET = 'sors';
const ADMIN_KEY = 'PASSWORD-ADMIN-KEY';   // Replace with your actual admin key

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

let myFeedId = null;
let privateId = null;
let subscribers = {};
let myStream = null;
let isInRoom = false;
let currentRoomId = null;
let myDisplayName = null;

const opaqueId = 'dual-' + Janus.randomString(12);
let listRefreshInterval = null;

let ringAudio = null;
let ringbackAudio = null;
const modals = {};
let els = {};

let pendingUserList = null;
let pendingRoomList = null;

pageLog('call.js (final) loaded', 'info');

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

function playRing() { if (ringAudio) { ringAudio.currentTime = 0; ringAudio.play().catch(()=>{}); } }
function stopRing() { if (ringAudio) { ringAudio.pause(); ringAudio.currentTime = 0; } }
function playRingback() { if (ringbackAudio) { ringbackAudio.currentTime = 0; ringbackAudio.play().catch(()=>{}); } }
function stopRingback() { if (ringbackAudio) { ringbackAudio.pause(); ringbackAudio.currentTime = 0; } }

function notifyIncomingCall(fromUser) {
	if (!('Notification' in window) || Notification.permission !== 'granted') return;
	try { new Notification('Incoming call', { body: fromUser + ' is calling you' }); } catch(e) {}
}

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
             // Guard: only run the full leave sequence if we are still in a room.
             // This prevents the recursion triggered by roomHandle.hangup().
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
			stopRing();
			stopRingback();
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
// Room actions – create/join based on input
// ============================================================
function createRoom() {
	if (!roomHandle) { showAlert('Room plugin not ready.'); return; }
	if (isInCall) hangupCall();
	if (isInRoom) leaveRoom(true);

	const input = els.peerInput.value.trim();
	if (!input) {
		joinRoom(1234);
		return;
	}

	if (/^\d+$/.test(input)) {
		const roomId = parseInt(input, 10);
		pageLog('Joining room by ID: ' + roomId, 'info');
		joinRoom(roomId);
		return;
	}

	const description = input;
	pageLog('Looking for room with description: ' + description, 'info');

	roomHandle.send({
		message: { request: 'list' },
		success: function (data) {
			const rooms = data.list || [];
			const found = rooms.find(function (r) {
				return r.description === description;
			});
			if (found) {
				pageLog('Found room: ' + description + ' (ID ' + found.room + ')', 'info');
				joinRoom(found.room);
			} else {
				pageLog('Room not found, attempting to create: ' + description, 'info');
				attemptCreateRoom(description);
			}
		},
		error: function (error) {
			pageLog('List error: ' + error + ', trying to create anyway', 'error');
			attemptCreateRoom(description);
		}
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
		success: function () {
			pageLog('Room created, joining', 'info');
			joinRoom(roomId);
		},
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
// List participants
// ============================================================
function listParticipants() {
	if (!roomHandle) return;
	pageLog('Requesting list of participants in room ' + currentRoomId, 'info');
	roomHandle.send({
		message: { request: 'listparticipants', room: currentRoomId },
		success: function (data) {
			pageLog('Participants list received: ' + JSON.stringify(data), 'info');
			if (data && data.participants) {
				data.participants.forEach(function (participant) {
					if (participant.id !== myFeedId) {
						createRoomSubscriber(participant.id, participant.display);
					}
				});
			}
		},
		error: function (error) {
			pageLog('listparticipants error: ' + error, 'error');
		}
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

function createRoomSubscriber(feedId, displayName) {
    // Synchronously reserve the slot, so a second call for the same feed
    // (from another event that arrives a moment later) sees the entry
    // and returns immediately.
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
                // Slot was removed while we were attaching (e.g. user left).
                // Detach immediately and bail out.
                subHandle.detach({ asyncRequest: false });
                return;
            }
            sub.handle = subHandle;
            sub.pending = false;

            subHandle.onmessage = function(msg, jsep) {
                pageLog('Subscriber message for ' + feedId + ': ' + JSON.stringify(msg), 'debug');
                if (jsep) {
                    pageLog('Subscriber handling remote JSEP (offer) by creating answer', 'info');
                    subHandle.createAnswer({
                        jsep: jsep,
                        media: { audioSend: false, audioRecv: true, videoSend: false, videoRecv: true },
                        success: function (answerJsep) {
                            pageLog('Answer created for subscriber ' + feedId, 'info');
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
                        error: function (error) {
                            pageLog('Create answer error: ' + error, 'error');
                        }
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

            // Extra safety: if a tile already exists for this feed, don't create another.
            if (sub.element) {
                pageLog('Ignoring duplicate remote stream for ' + feedId, 'warn');
                return;
            }

            pageLog('Remote stream received for ' + feedId, 'info');
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
        oncleanup: function () {
            pageLog('Subscriber cleanup for ' + feedId, 'info');
            removeRoomSubscriber(feedId);
        },
        error: function (error) {
            pageLog('Subscriber attach error: ' + error, 'error');
            // Release the reserved slot so a later retry can happen
            if (subscribers[feedId] && subscribers[feedId].pending) {
                delete subscribers[feedId];
            }
        }
    });
}

function removeRoomSubscriber(feedId) {
    const sub = subscribers[feedId];
    if (!sub) return;

    // Delete FIRST so that when sub.handle.detach() fires the subscriber's
    // oncleanup, the re-entrant call sees nothing and returns immediately.
    delete subscribers[feedId];

    if (sub.element && sub.element.parentNode) {
        sub.element.parentNode.removeChild(sub.element);
    }
    if (sub.handle) {
        sub.handle.detach({ asyncRequest: false });
    }
}

function leaveRoom(silent) {
    if (!isInRoom) return;
    isInRoom = false;               // <-- flip FIRST, before any Janus calls
    pageLog('Leaving room', 'info');

    if (roomHandle) {
        roomHandle.send({ message: { request: 'unpublish' } });
        roomHandle.hangup();        // oncleanup will see isInRoom === false
    }

    // Remove every subscriber tile/handle
    Object.keys(subscribers).forEach(function (feedId) {
        removeRoomSubscriber(feedId);
    });

    // Reset UI
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
// Direct call functions
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
	modals.incoming.hide();
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
	modals.incoming.hide();
	stopRing();
	callHandle.send({ message: { request: 'hangup' } });
	pendingIncomingJsep = null;
	peerUsername = null;
}

function hangupCall() {
	if (!callHandle) return;
	if (isInCall) {
		callHandle.send({ message: { request: 'hangup' } });
		callHandle.hangup();
		onCallEnded();
	}
}

function onCallEnded() {
	stopRing();
	stopRingback();
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
			pageLog('Room list received via success: ' + JSON.stringify(data), 'info');
			if (data && data.list) {
				pendingRoomList = data.list;
				renderUnifiedList();
			}
		},
		error: function (error) {
			pageLog('Room list error: ' + error, 'error');
		}
	});
}

function renderUnifiedList() {
	pageLog('renderUnifiedList called, user=' + JSON.stringify(pendingUserList) + ', room=' + JSON.stringify(pendingRoomList), 'info');
	if (pendingUserList === null || pendingRoomList === null) {
		pageLog('Waiting for both lists', 'debug');
		return;
	}
	pageLog('Rendering unified list', 'info');
	const container = els.unifiedList;
	container.innerHTML = '';

	const users = Array.isArray(pendingUserList) ? pendingUserList : Object.values(pendingUserList || {});
	const rooms = Array.isArray(pendingRoomList) ? pendingRoomList : Object.values(pendingRoomList || {});

	const otherUsers = users.filter(function (u) { return u !== myUsername; });

	otherUsers.forEach(function (name) {
		const item = document.createElement('span');
		item.className = 'list-item user';
		item.innerHTML = '<span class="icon">👤</span><span class="name">' + name + '</span>';
		item.addEventListener('click', function () {
			pageLog('Clicked user: ' + name, 'info');
			startCall(name);
		});
		container.appendChild(item);
	});

	rooms.forEach(function (room) {
		const roomId = room.room || room;
		const description = room.description || 'Room ' + roomId;
		const item = document.createElement('span');
		item.className = 'list-item room';
		item.innerHTML = '<span class="icon">👥</span><span class="name">' + description + '</span>';
		item.addEventListener('click', function () {
			pageLog('Clicked room: ' + roomId, 'info');
			joinRoom(roomId);
		});
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
	if (isInCall) {
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

	ringAudio = new Audio('res/sip_sound.mp3');
	ringAudio.loop = true;
	ringbackAudio = new Audio('res/ringback4.mp3');
	ringbackAudio.loop = true;

	if ('Notification' in window && Notification.permission === 'default') {
		Notification.requestPermission();
	}

	els.videoCallBtn.addEventListener('click', function () {
		const name = els.peerInput.value.trim();
		if (!name) { showAlert('Enter a username to call.'); return; }
		startCall(name);
	});

	els.roomCreateBtn.addEventListener('click', createRoom);

	els.refreshListBtn.addEventListener('click', function () {
		refreshList();
	});

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