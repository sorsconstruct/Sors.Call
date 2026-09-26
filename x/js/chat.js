/**
 * SorsChat Module
 * Handles UI messaging, local chat history, unread badge counts,
 * and WebRTC Data Channel integration.
 */
(function (window, document) {
    'use strict';

    // State management
    var chatState = {
        activeTarget: null,
        history: {},      // Structure: { username: [ { sender, text, timestamp, isLocal } ] }
        unreadCounts: {}, // Structure: { username: number }
        dataChannelHandle: null // Janus handle reference for data transmission
    };

    var SorsChat = {
        /**
         * Initialize SorsChat engine and UI listeners
         */
        init: function () {
            this.bindUIEvents();
            this.pageLog('SorsChat engine initialized.', 'info');
        },

        /**
         * Set the current Janus Handle capable of data channel transmission
         * @param {Object} handle - Janus plugin handle
         */
        setDataChannelHandle: function (handle) {
            chatState.dataChannelHandle = handle;
            this.pageLog('Data channel handle attached to SorsChat.', 'info');
        },

        /**
         * Select a contact from Display 2
         * @param {string} username 
         */
        selectContact: function (username) {
            if (!username) return;

            chatState.activeTarget = username;
            
            // Clear unread badge count for selected contact
            chatState.unreadCounts[username] = 0;
            this.updateUnreadBadgeUI(username);

            // Update UI headers and display history
            var headerEl = document.getElementById('chat-active-user-header');
            if (headerEl) {
                headerEl.textContent = username;
            }

            this.renderChatHistory(username);
            this.pageLog('Active chat target set to: ' + username, 'info');
        },

        /**
         * Send a text message to the currently selected contact
         * @param {string} text 
         */
        sendTextMessage: function (text) {
            var target = chatState.activeTarget;
            var trimmedText = (text || '').trim();

            if (!trimmedText) {
                return;
            }

            if (!target) {
                this.pageLog('Cannot send message: No target selected in Display 2.', 'warn');
                return;
            }

            // Save message locally
            var messageObj = {
                sender: 'Me',
                text: trimmedText,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                isLocal: true
            };

            this.storeMessage(target, messageObj);

            // Append to current chat view (Display 3)
            this.appendMessageUI(messageObj);

            // Clear chat input box
            var inputEl = document.getElementById('chat-input-field');
            if (inputEl) {
                inputEl.value = '';
            }

            // Transmit via Janus Data Channel
            this.sendJanusTextMessage(target, trimmedText);
        },

        /**
         * Transmit payload via WebRTC Data Channel or gracefully handle fallback
         * @param {string} targetUsername 
         * @param {string} text 
         */
        sendJanusTextMessage: function (targetUsername, text) {
            var payload = JSON.stringify({
                text: text,
                sender: 'Me',
                target: targetUsername,
                timestamp: Date.now()
            });

            var handle = chatState.dataChannelHandle;

            // Check if handle exists and has data channel capability
            if (handle && typeof handle.data === 'function') {
                try {
                    handle.data({
                        text: payload,
                        error: function (err) {
                            window.SorsChat.pageLog('Data channel send error: ' + err, 'error');
                        },
                        success: function () {
                            window.SorsChat.pageLog('Message successfully sent via Data Channel to ' + targetUsername, 'info');
                        }
                    });
                    return;
                } catch (e) {
                    this.pageLog('Data channel exception: ' + e.message, 'error');
                }
            }

            // Graceful Fallback Notice (Requirement 2)
            var notice = '[ChatEngine] Notice: Target "' + targetUsername + '" is not in an active WebRTC Data Channel session. Message saved in local chat history.';
            this.pageLog(notice, 'info');
        },

        /**
         * Callback invoked when a remote WebRTC Data Channel packet arrives
         * @param {string} sender 
         * @param {string} text 
         */
        onRemoteMessageReceived: function (sender, text) {
            var senderName = sender || 'Remote';

            var messageObj = {
                sender: senderName,
                text: text,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                isLocal: false
            };

            // Store message in local storage history
            this.storeMessage(senderName, messageObj);

            // Requirement 3 & 4: Determine if message belongs to active conversation or unread badge
            if (chatState.activeTarget === senderName) {
                this.appendMessageUI(messageObj);
            } else {
                // Increment unread count for Display 2 user item
                chatState.unreadCounts[senderName] = (chatState.unreadCounts[senderName] || 0) + 1;
                this.updateUnreadBadgeUI(senderName);
            }
        },

        /**
         * Store message object in history dictionary
         */
        storeMessage: function (target, messageObj) {
            if (!chatState.history[target]) {
                chatState.history[target] = [];
            }
            chatState.history[target].push(messageObj);
        },

        /**
         * Render full chat history for active user in Display 3
         */
        renderChatHistory: function (target) {
            var container = document.getElementById('chat-messages-container');
            if (!container) return;

            container.innerHTML = ''; // Clear container
            var history = chatState.history[target] || [];

            for (var i = 0; i < history.length; i++) {
                this.appendMessageUI(history[i]);
            }

            this.scrollToBottom();
        },

        /**
         * Render single message item into Display 3 container
         * Requirement 3: Local messages left-aligned/styled, Remote messages right-aligned
         */
        appendMessageUI: function (msgObj) {
            var container = document.getElementById('chat-messages-container');
            if (!container) return;

            var msgRow = document.createElement('div');
            msgRow.className = 'chat-message-row ' + (msgObj.isLocal ? 'local-row' : 'remote-row');

            var bubble = document.createElement('div');
            bubble.className = 'chat-message-bubble ' + (msgObj.isLocal ? 'bubble-local' : 'bubble-remote');

            var meta = document.createElement('div');
            meta.className = 'chat-message-meta';
            meta.textContent = msgObj.sender + ' • ' + msgObj.timestamp;

            var body = document.createElement('div');
            body.className = 'chat-message-body';
            body.textContent = msgObj.text;

            bubble.appendChild(meta);
            bubble.appendChild(body);
            msgRow.appendChild(bubble);
            container.appendChild(msgRow);

            this.scrollToBottom();
        },

        /**
         * Update Display 2 unread badge UI elements
         * Requirement 4: Display 2 unread counter maintenance
         */
        updateUnreadBadgeUI: function (username) {
            var userItem = document.querySelector('[data-username="' + username + '"]');
            if (!userItem) return;

            var badge = userItem.querySelector('.unread-badge');
            var count = chatState.unreadCounts[username] || 0;

            if (count > 0) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'unread-badge';
                    userItem.appendChild(badge);
                }
                badge.textContent = count > 99 ? '99+' : count;
                badge.style.display = 'inline-block';
            } else if (badge) {
                badge.style.display = 'none';
                badge.textContent = '0';
            }
        },

        /**
         * Scroll message display area to bottom
         */
        scrollToBottom: function () {
            var container = document.getElementById('chat-messages-container');
            if (container) {
                container.scrollTop = container.scrollHeight;
            }
        },

        /**
         * Attach DOM button clicks and keypress listeners
         */
        bindUIEvents: function () {
            var self = this;

            // Send button handler
            var sendBtn = document.getElementById('chat-send-btn');
            if (sendBtn) {
                sendBtn.addEventListener('click', function () {
                    var inputEl = document.getElementById('chat-input-field');
                    if (inputEl) {
                        self.sendTextMessage(inputEl.value);
                    }
                });
            }

            // Input field Enter key handler
            var inputEl = document.getElementById('chat-input-field');
            if (inputEl) {
                inputEl.addEventListener('keypress', function (e) {
                    if (e.key === 'Enter' || e.keyCode === 13) {
                        e.preventDefault();
                        self.sendTextMessage(inputEl.value);
                    }
                });
            }

            // Display 2 contact items delegated click listener
            var contactList = document.getElementById('display2-user-list');
            if (contactList) {
                contactList.addEventListener('click', function (e) {
                    var target = e.target.closest('[data-username]');
                    if (target) {
                        var username = target.getAttribute('data-username');
                        self.selectContact(username);
                    }
                });
            }
        },

        /**
         * Internal logger wrapper
         */
        pageLog: function (msg, level) {
            var timeStr = '[' + new Date().toLocaleTimeString() + ']';
            var formatted = timeStr + ' [ChatEngine] ' + msg;
            if (level === 'error') {
                console.error(formatted);
            } else if (level === 'warn') {
                console.warn(formatted);
            } else {
                console.log(formatted);
            }
        }
    };

    // Expose to window scope
    window.SorsChat = SorsChat;

    // Initialize when DOM is ready
    document.addEventListener('DOMContentLoaded', function () {
        window.SorsChat.init();
    });

})(window, document);
