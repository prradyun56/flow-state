import { storageManager } from './storage.js';
import { firestoreRest } from './firebase-rest.js';

// Initialize storage manager on start
chrome.runtime.onInstalled.addListener(() => {
  console.log('FlowState Extension installed/updated');
});

// Message listener for various operations
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Boilerplate to re-hydrate memory state if Service Worker unloads
  const ensureAccount = (callback) => {
    chrome.storage.local.get(['user'], (result) => {
      if (result.user) storageManager.currentUser = result.user; // bypass explicit sync trigger
      callback();
    });
  };

  switch (request.type) {
    case 'AUTH_SUCCESS':
      chrome.storage.local.set({ user: request.user }, () => {
        storageManager.setAccount(request.user);
        sendResponse({ ok: true });
      });
      return true;

    case 'SIGN_OUT':
      storageManager.setAccount(null);
      // HARD WIPE OF CACHE - Eradicates all ghost sessions definitively
      chrome.storage.local.remove(['user', 'sessions'], () => {
        sendResponse({ ok: true });
      });
      return true;

    case 'GET_AUTH_STATUS':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], (result) => {
          sendResponse({ user: result.user || null });
        });
      });
      return true;

    case 'SAVE_SESSION':
      ensureAccount(() => {
        chrome.tabs.query({ currentWindow: true }, (tabs) => {
          const session = {
            session_id: crypto.randomUUID(),
            name: request.name || 'Untitled Session',
            created_at: new Date().toISOString(),
            tabs: tabs.map(t => ({ url: t.url, title: t.title, pinned: t.pinned })),
            notes: request.notes || ''
          };
          storageManager.saveSession(session).then(() => {
            sendResponse({ ok: true });
          });
        });
      });
      return true;

    case 'LIST_SESSIONS':
      ensureAccount(() => {
        chrome.storage.local.get(['sessions'], (result) => {
          sendResponse({ ok: true, data: result.sessions || [] });
        });
      });
      return true;

    case 'DELETE_SESSION':
      ensureAccount(() => {
        storageManager.deleteSession(request.session_id).then(() => {
          sendResponse({ ok: true });
        });
      });
      return true;

    case 'RESTORE_SESSION':
      chrome.storage.local.get(['sessions'], (result) => {
        const session = (result.sessions || []).find(s => s.session_id === request.session_id);
        if (session && session.tabs) {
          session.tabs.forEach(tab => chrome.tabs.create({ url: tab.url, active: false }));
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Session not found' });
        }
      });
      return true;

    case 'TOGGLE_SHARE':
      ensureAccount(() => {
        chrome.storage.local.get(['sessions', 'user'], async (result) => {
          const session = (result.sessions || []).find(s => s.session_id === request.session_id);
          if (session && result.user) {
            session.is_shared = !session.is_shared;
            try {
              await storageManager.saveSession(session);
              sendResponse({ ok: true, is_shared: session.is_shared });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false, error: 'Session not found' });
          }
        });
      });
      return true;

    case 'GET_PENDING_APPROVALS':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          if (result.user && result.user.rank === 'board' && result.user.stsTokenManager?.accessToken) {
            try {
              const token = result.user.stsTokenManager.accessToken;
              const vault = await firestoreRest.getDocument('vault/master', token);
              const pending = [];

              if (vault) {
                ['board', 'sc'].forEach(r => {
                  if (vault[r]) {
                    vault[r].forEach(u => {
                      if (u.status === 'pending') {
                        pending.push({ ...u, rank: r, _id: u.uid });
                      }
                    });
                  }
                });
              }
              sendResponse({ ok: true, data: pending });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false, data: [] });
          }
        });
      });
      return true;

    case 'APPROVE_USER':
      ensureAccount(() => {
        chrome.storage.local.get(['user'], async (result) => {
          if (result.user && result.user.rank === 'board' && result.user.stsTokenManager?.accessToken) {
            try {
              const token = result.user.stsTokenManager.accessToken;

              // Directly update local JSON vault (ignoring restrictive native Firestore users collection)
              let vault = await firestoreRest.getDocument('vault/master', token);
              if (vault) {
                ['board', 'sc'].forEach(r => {
                  if (vault[r]) {
                    const idx = vault[r].findIndex(u => u.uid === request.uid);
                    if (idx !== -1) vault[r][idx].status = 'approved';
                  }
                });
                await firestoreRest.setDocument('vault/master', vault, token);
              }

              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false });
          }
        });
      });
      return true;
  }
});
