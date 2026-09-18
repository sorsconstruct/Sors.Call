'use strict';

let _notificationAsked = false;

// Request permission (must be inside user gesture)
function initNotificationAccess() {
    if (_notificationAsked) return;
    _notificationAsked = true;

    if (!("Notification" in window)) {
        console.warn("This browser does not support notifications.");
        pageLog('This browser does not support notifications.', 'info');
        return;
    }

    Notification.requestPermission().then(result => {
        console.log("Notification permission:", result);
        pageLog('Notification permission: ' + result, 'info');
    });
}

// Global user interaction handler
function _globalUserInteractionHandler() {
    initNotificationAccess();

    // Remove listeners so it runs only once
    window.removeEventListener("mousedown", _globalUserInteractionHandler);
    window.removeEventListener("mouseup", _globalUserInteractionHandler);
    window.removeEventListener("click", _globalUserInteractionHandler);
    window.removeEventListener("mousemove", _globalUserInteractionHandler);
}

// Attach global listeners (allowed by browsers)
window.addEventListener("mousedown", _globalUserInteractionHandler);
window.addEventListener("mouseup", _globalUserInteractionHandler);
window.addEventListener("click", _globalUserInteractionHandler);
window.addEventListener("mousemove", _globalUserInteractionHandler);

// Main function to show notification
function showNotification(text) {
    if (!("Notification" in window)) {
        console.warn("Notifications are not supported.");
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
        console.warn("User blocked notifications.");
        pageLog('User blocked notifications.', 'info');
        return;
    }

    pageLog('Permission not granted yet.', 'info');
    console.warn("Permission not granted yet.");
}
