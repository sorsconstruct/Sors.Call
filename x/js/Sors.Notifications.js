'use strict';

let _notificationAsked = false;

// REAL user gesture handler
function _userGesturePermissionRequest(e) {
    if (_notificationAsked) return;
    _notificationAsked = true;

    if (!("Notification" in window)) {
        pageLog('This browser does not support notifications.', 'info');
        return;
    }

    Notification.requestPermission().then(result => {
        pageLog('Notification permission: ' + result, 'info');
    });

    // Remove listeners after first gesture
    window.removeEventListener("click", _userGesturePermissionRequest);
    window.removeEventListener("mousedown", _userGesturePermissionRequest);
    window.removeEventListener("mouseup", _userGesturePermissionRequest);
    window.removeEventListener("keydown", _userGesturePermissionRequest);
    window.removeEventListener("touchstart", _userGesturePermissionRequest);
}

// Attach ONLY real gesture events
window.addEventListener("click", _userGesturePermissionRequest);
window.addEventListener("mousedown", _userGesturePermissionRequest);
window.addEventListener("mouseup", _userGesturePermissionRequest);
window.addEventListener("keydown", _userGesturePermissionRequest);
window.addEventListener("touchstart", _userGesturePermissionRequest);

// Show notification
function showNotification(text) {
    if (!("Notification" in window)) {
        pageLog('Notifications are not supported.', 'info');
        return;
    }

    if (Notification.permission === "granted") {
        new Notification("Sors Notification", {
            body: text,
            icon: "assets/notification.png"
        });
        return;
    }

    if (Notification.permission === "denied") {
        pageLog('User blocked notifications.', 'info');
        return;
    }

    pageLog('Permission not granted yet.', 'info');
}
