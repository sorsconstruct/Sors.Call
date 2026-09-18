

// Ask for permission on first page load
(function initNotificationAccess() {
    if (!("Notification" in window)) {
        console.warn("This browser does not support notifications.");
        return;
    }

    // If permission is not granted, request it
    if (Notification.permission === "default") {
        Notification.requestPermission().then(result => {
            console.log("Notification permission:", result);
        });
    }
})();

// Main function to show notification
function showNotification(text) {
    if (!("Notification" in window)) {
        console.warn("Notifications are not supported.");
        return;
    }

    // If permission already granted → show notification
    if (Notification.permission === "granted") {
        new Notification("Sors Notification", {
            body: text,
            icon: "assets/notification.png" // optional
        });
        return;
    }

    // If permission denied → cannot show
    if (Notification.permission === "denied") {
        console.warn("User blocked notifications.");
        return;
    }

    // If permission not decided → ask again
    Notification.requestPermission().then(result => {
        if (result === "granted") {
            new Notification("Sors Notification", {
                body: text,
                icon: "assets/notification.png"
            });
        } else {
            console.warn("Notification permission not granted.");
        }
    });
}