import { storageManager } from './storage.js';

// Initialize storage manager on start
chrome.runtime.onInstalled.addListener(() => {
  console.log('FlowState Extension installed/updated');
});

// Message listener for various operations
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.type) {
    case 'AUTH_SUCCESS':
      storageManager.setAccount(request.user);
      // Persist user status locally
      chrome.storage.local.set({ user: request.user });
      sendResponse({ ok: true });
      break;

    case 'SIGN_OUT':
      storageManager.setAccount(null);
      chrome.storage.local.remove(['user']);
      sendResponse({ ok: true });
      break;

    case 'GET_AUTH_STATUS':
      chrome.storage.local.get(['user'], (result) => {
        if (result.user) {
          storageManager.setAccount(result.user);
        }
        sendResponse({ user: result.user || null });
      });
      return true; // Keep channel open for async response

    case 'SAVE_SESSION':
      chrome.tabs.query({ currentWindow: true }, async (tabs) => {
        const session = {
          session_id: crypto.randomUUID(),
          name: request.name || 'Untitled Session',
          created_at: new Date().toISOString(),
          tabs: tabs.map(t => ({
            url: t.url,
            title: t.title,
            pinned: t.pinned
          })),
          notes: request.notes || ''
        };
        
        try {
          await storageManager.saveSession(session);
          sendResponse({ ok: true });
        } catch (e) {
          console.error(e);
          sendResponse({ ok: false });
        }
      });
      return true;

    case 'LIST_SESSIONS':
      chrome.storage.local.get(['sessions'], (result) => {
        sendResponse({ ok: true, data: result.sessions || [] });
      });
      return true;

    case 'DELETE_SESSION':
      storageManager.deleteSession(request.session_id)
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;

    case 'RESTORE_SESSION':
      chrome.storage.local.get(['sessions'], (result) => {
        const session = (result.sessions || []).find(s => s.session_id === request.session_id);
        if (session) {
          session.tabs.forEach(tab => chrome.tabs.create({ url: tab.url, pinned: tab.pinned }));
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false });
        }
      });
      return true;
  }
});
