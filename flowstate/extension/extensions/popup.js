document.addEventListener('DOMContentLoaded', () => {
  const tabCountEl = document.getElementById('tab-count');
  const sessionNameInput = document.getElementById('session-name');
  const sessionNotesInput = document.getElementById('session-notes');
  const sessionVisibilityInput = document.getElementById('session-visibility');
  const saveBtn = document.getElementById('save-btn');
  const sessionsListEl = document.getElementById('sessions-list');
  const toastEl = document.getElementById('toast');
  const userEmailEl = document.getElementById('user-email');
  const authBtn = document.getElementById('auth-btn');
  const syncStatusEl = document.getElementById('sync-status');
  const lastSyncEl = document.getElementById('last-sync');
  const syncBtn = document.getElementById('sync-btn');
  const recordingIndicator = document.getElementById('recording-indicator');
  const stopRecBtn = document.getElementById('stop-rec-btn');
  const liveIndicator = document.getElementById('live-indicator');
  const sessionSearchInput = document.getElementById('session-search');
  const dashboardBtn = document.getElementById('dashboard-btn');

  // Privacy filter elements (simplified — flag-this-tab only)
  const privacyToggle = document.getElementById('privacy-toggle');
  const privacyPanel = document.getElementById('privacy-panel');
  const privacyExpandBtn = document.getElementById('privacy-expand-btn');
  const privacySummary = document.getElementById('privacy-summary');
  const currentTabStatusEl = document.getElementById('current-tab-status');
  const flagTabBtn = document.getElementById('flag-tab-btn');

  let currentUser = null;
  let currentRole = null;
  let currentOrgId = null;
  let recordingState = { active: false, sessionId: null, windowId: null };
  let currentTab = null;
  let privacyState = { flaggedTabs: [], flaggedDomains: [] };
  let allSessions = [];
  let searchQuery = '';

  chrome.runtime.sendMessage({ type: 'POPUP_OPENED' }).catch(() => {});
  window.addEventListener('unload', () => {
    chrome.runtime.sendMessage({ type: 'POPUP_CLOSED' }).catch(() => {});
  });

  // Check auth status on load
  chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, (response) => {
    if (response && response.user) {
      currentUser = response.user;
      currentRole = response.role || null;
      currentOrgId = response.orgId || null;

      userEmailEl.textContent = currentUser.displayName || currentUser.email;
      userEmailEl.className = 'user-info signed-in';

      const roleName = currentRole ? currentRole.name : '';
      if (roleName) {
        userEmailEl.classList.add(`role-${roleName.toLowerCase()}`);
        userEmailEl.textContent += ` (${roleName})`;
      }

      authBtn.textContent = '⏻';
      authBtn.title = 'Sign Out';
    }
  });

  // Check recording status on load
  chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' }, (response) => {
    if (response && response.recording) {
      recordingState = { active: true, sessionId: response.sessionId, windowId: response.windowId };
      updateRecordingUI();
    }
  });

  // Auth button handler
  authBtn.addEventListener('click', () => {
    if (currentUser) {
      if (confirm('Are you sure you want to sign out?')) {
        chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, (response) => {
          if (response && response.ok) {
            currentUser = null;
            currentRole = null;
            currentOrgId = null;
            recordingState = { active: false, sessionId: null, windowId: null };
            updateRecordingUI();
            userEmailEl.textContent = 'Not signed in';
            userEmailEl.className = 'user-info';
            authBtn.textContent = '👤';
            authBtn.title = 'Sign In';
            syncStatusEl.classList.remove('synced', 'syncing', 'error');
            syncStatusEl.classList.add('offline');
            lastSyncEl.textContent = '';
            loadSessions();
            showToast('Signed out successfully', 'success');
          }
        });
      }
    } else {
      chrome.tabs.create({ url: 'auth.html' });
    }
  });

  // Dashboard button — opens full control panel
  dashboardBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  });

  // Force sync button
  syncBtn.addEventListener('click', () => {
    if (!currentUser) { showToast('Sign in to sync', 'error'); return; }
    syncBtn.disabled = true;
    syncBtn.classList.add('spinning');
    chrome.runtime.sendMessage({ type: 'FORCE_SYNC' }, (response) => {
      syncBtn.disabled = false;
      syncBtn.classList.remove('spinning');
      if (response && response.ok) { showToast('Synced!', 'success'); loadSessions(); }
      else showToast('Sync failed', 'error');
    });
  });

  if (chrome.tabs) {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      tabCountEl.textContent = `${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`;
    });
  }

  loadSessions();

  chrome.runtime.onMessage.addListener((request) => {
    if (request.type === 'UPDATE_SYNC_STATUS') {
      updateSyncStatus(request.status);
      if (request.status === 'synced') loadSessions();
    }
    if (request.type === 'CLOUD_UPDATED') {
      loadSessions();
      flashLiveIndicator();
    }
    if (request.type === 'RECORDING_UPDATED') {
      if (!recordingState.active) {
        chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' }, (statusResp) => {
          if (statusResp && statusResp.recording) {
            recordingState = { active: true, sessionId: statusResp.sessionId, windowId: statusResp.windowId };
            updateRecordingUI();
          }
        });
      }
      loadSessions();
      if (chrome.tabs) {
        chrome.tabs.query({ currentWindow: true }, (tabs) => {
          tabCountEl.textContent = `${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`;
        });
      }
    }
  });

  saveBtn.addEventListener('click', () => {
    const name = sessionNameInput.value.trim();
    const notes = sessionNotesInput.value.trim();
    const visibility = sessionVisibilityInput ? sessionVisibilityInput.value : 'private';

    const proceedSave = () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      chrome.runtime.sendMessage({
        type: 'SAVE_SESSION', name, notes, visibility, startRecording: true
      }, (response) => {
        saveBtn.disabled = false;
        saveBtn.textContent = 'New Session';
        if (response && response.ok) {
          if (response.sessionId) {
            recordingState = { active: true, sessionId: response.sessionId, windowId: null };
            chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' }, (statusResp) => {
              if (statusResp && statusResp.recording) recordingState.windowId = statusResp.windowId;
              updateRecordingUI();
            });
            showToast('Session saved & recording started!', 'success');
          } else {
            showToast('Session saved!', 'success');
          }
          sessionNameInput.value = '';
          sessionNotesInput.value = '';
          loadSessions();
        } else {
          showToast('Failed to save session.', 'error');
        }
      });
    };

    if (visibility !== 'private') {
      chrome.tabs.query({ currentWindow: true }, (tabs) => {
        const sensitiveRegex = /(login|signin|signup|auth|oauth|password|credential|bank|checkout|stripe|paypal)/i;
        const hasSensitive = tabs.some(t => t.url && sensitiveRegex.test(t.url));
        if (hasSensitive) {
          if (confirm('Warning: Some tabs may contain sensitive information.\n\nShare this session?')) proceedSave();
        } else {
          proceedSave();
        }
      });
    } else {
      proceedSave();
    }
  });

  stopRecBtn.addEventListener('click', () => stopRecordingSession());

  function updateRecordingUI() {
    if (recordingState.active) {
      recordingIndicator.style.display = 'inline-flex';
      stopRecBtn.style.display = 'block';
    } else {
      recordingIndicator.style.display = 'none';
      stopRecBtn.style.display = 'none';
    }
  }

  function startRecordingSession(sessionId) {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', sessionId }, (response) => {
      if (response && response.ok) {
        recordingState = { active: true, sessionId, windowId: response.windowId };
        updateRecordingUI();
        showToast('Recording started!', 'success');
        loadSessions();
      } else {
        showToast('Failed to start recording.', 'error');
      }
    });
  }

  function stopRecordingSession() {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }, (response) => {
      if (response && response.ok) {
        recordingState = { active: false, sessionId: null, windowId: null };
        updateRecordingUI();
        showToast('Recording stopped.', 'success');
        loadSessions();
      } else {
        showToast('Failed to stop recording.', 'error');
      }
    });
  }

  // --- Privacy panel (simplified: flag-this-tab only) ---

  function loadPrivacyState() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      currentTab = tabs[0] || null;
      chrome.runtime.sendMessage({ type: 'GET_PRIVACY_FLAGS' }, (resp) => {
        if (resp && resp.ok) {
          privacyState = { flaggedTabs: resp.flaggedTabs || [], flaggedDomains: resp.flaggedDomains || [] };
          renderPrivacyPanel();
        }
      });
    });
  }

  function renderPrivacyPanel() {
    const total = privacyState.flaggedTabs.length + privacyState.flaggedDomains.length;
    privacySummary.textContent = total > 0 ? `[${total} EXCLUDED]` : '';
    privacySummary.className = 'privacy-summary' + (total > 0 ? ' active' : '');

    if (!currentTab) return;

    const isTabFlagged = privacyState.flaggedTabs.some(t => t.id === currentTab.id);
    let hostname = '';
    try { hostname = new URL(currentTab.url || '').hostname; } catch {}
    const isDomainFlagged = hostname
      ? privacyState.flaggedDomains.some(d => hostname === d || hostname.endsWith('.' + d))
      : false;

    if (isTabFlagged || isDomainFlagged) {
      const reason = isDomainFlagged ? `DOMAIN: ${escapeHtml(hostname)}` : `TAB: ${escapeHtml(hostname || currentTab.id.toString())}`;
      currentTabStatusEl.innerHTML = `<span class="privacy-excluded-badge">⊘ EXCLUDED</span><span class="privacy-reason"> via ${reason}</span>`;
      flagTabBtn.textContent = isTabFlagged ? 'UNFLAG_THIS_TAB()' : 'FLAG_THIS_TAB()';
      flagTabBtn.classList.toggle('active', isTabFlagged);
    } else {
      currentTabStatusEl.innerHTML = `<span class="privacy-recording-badge">● RECORDING</span>`;
      flagTabBtn.textContent = 'FLAG_THIS_TAB()';
      flagTabBtn.classList.remove('active');
    }
  }

  privacyToggle.addEventListener('click', () => {
    const isHidden = privacyPanel.classList.toggle('privacy-panel-hidden');
    privacyExpandBtn.textContent = isHidden ? '▾' : '▴';
    if (!isHidden) loadPrivacyState();
  });

  flagTabBtn.addEventListener('click', () => {
    if (!currentTab) return;
    chrome.runtime.sendMessage({ type: 'TOGGLE_TAB_FLAG', tabId: currentTab.id }, (resp) => {
      if (resp && resp.ok) {
        loadPrivacyState();
        showToast(resp.flagged ? 'Tab flagged — excluded from recording.' : 'Tab unflagged.', 'success');
      }
    });
  });

  sessionSearchInput.addEventListener('input', () => {
    searchQuery = sessionSearchInput.value.trim().toLowerCase();
    renderSessions(allSessions);
  });

  loadPrivacyState();

  function loadSessions() {
    chrome.runtime.sendMessage({ type: 'LIST_SESSIONS' }, (response) => {
      if (chrome.runtime.lastError) {
        sessionsListEl.innerHTML = `<div style="color:#f43f5e;font-size:12px;padding:10px;">Error: ${escapeHtml(chrome.runtime.lastError.message)}</div>`;
        return;
      }
      try {
        if (response && response.ok) {
          allSessions = response.data;
          renderSessions(response.data);
        } else {
          sessionsListEl.innerHTML = `<div style="color:#f43f5e;font-size:12px;padding:10px;">${response ? response.error : 'No response'}</div>`;
        }
      } catch (e) {
        sessionsListEl.innerHTML = `<div style="color:#f43f5e;font-size:10px;padding:10px;font-family:monospace;">Render error: ${escapeHtml(e.message)}</div>`;
      }
    });
  }

  function renderSessions(sessions) {
    sessionsListEl.innerHTML = '';

    if (!sessions || typeof sessions.length !== 'number') {
      sessionsListEl.innerHTML = `<div style="color:red">Corrupted session list</div>`;
      return;
    }

    if (searchQuery) {
      sessions = sessions.filter(s =>
        (s.name || '').toLowerCase().includes(searchQuery) ||
        (s.creator_name || '').toLowerCase().includes(searchQuery)
      );
    }

    if (sessions.length === 0) {
      sessionsListEl.innerHTML = '<div style="color:#666;font-size:12px;text-align:center;padding:20px;">No saved sessions.</div>';
      return;
    }

    const permissions = currentRole ? (currentRole.permissions || []) : [];
    const canShare = permissions.includes('share_sessions');

    sessions.forEach(session => {
      const card = document.createElement('div');
      card.className = 'card';

      const isRecording = recordingState.active && recordingState.sessionId === session.session_id;
      if (isRecording) card.classList.add('recording');

      const tabs = session.tabs || [];
      const createdAt = session.created_at ? new Date(session.created_at) : null;
      const timeAgo = createdAt && !isNaN(createdAt) ? getTimeAgo(createdAt) : '';
      const branchHtml = session.git_branch ? `<span class="meta-item card-branch">⎇ ${escapeHtml(session.git_branch)}</span>` : '';
      const notesHtml = session.notes ? `<div class="card-notes">${escapeHtml(session.notes)}</div>` : '';

      const roleName = session.creator_role || '';
      const roleBadge = roleName ? `<span class="role-badge role-${roleName.toLowerCase()}">${roleName}</span>` : '';
      const sharedBadge = session.is_shared ? `<span class="session-shared-badge">Shared</span>` : '';
      const creatorName = session.creator_name ? `<span class="creator-name">by ${escapeHtml(session.creator_name)}</span>` : '';
      const recordingBadge = isRecording ? `<span class="session-shared-badge" style="color:var(--accent-red);border-color:var(--accent-red);">REC</span>` : '';

      let shareBtnHtml = '';
      if (canShare && currentUser && session.user_id === currentUser.uid) {
        const activeClass = session.is_shared ? 'active' : '';
        shareBtnHtml = `<button class="icon-btn share-btn ${activeClass}" data-id="${session.session_id}" title="Toggle Share">🔗</button>`;
      }

      let recordBtnHtml = '';
      if (currentUser && session.user_id === currentUser.uid) {
        if (isRecording) {
          recordBtnHtml = `<button class="icon-btn stop-rec-btn" data-id="${session.session_id}" title="Stop Recording">⏹</button>`;
        } else {
          recordBtnHtml = `<button class="icon-btn record-btn" data-id="${session.session_id}" title="Record Session">⏺</button>`;
        }
      }

      const isOwn = currentUser && session.user_id === currentUser.uid;
      const canRestore = isOwn || session.visibility === 'edit';
      const restoreBtnHtml = canRestore
        ? `<button class="icon-btn restore-btn" data-id="${session.session_id}" title="Restore Tabs">▶</button>`
        : '';

      const tabListHtml = tabs.length > 0
        ? tabs.map(t => {
            const dur = t.duration ? formatDuration(t.duration) : '';
            return `<div class="tab-row">
              <span class="tab-row-title">${escapeHtml(t.title || t.url || 'Untitled')}</span>
              ${dur ? `<span class="tab-row-duration">${dur}</span>` : ''}
            </div>`;
          }).join('')
        : '<div class="tab-row-empty">No tab data</div>';

      card.innerHTML = `
        <div class="card-header">
          <div class="card-title">
            ${escapeHtml(session.name || 'Untitled Session')}
            ${roleBadge}
            ${sharedBadge}
            ${recordingBadge}
          </div>
          ${creatorName}
        </div>
        <div class="card-meta">
          <span class="meta-item">❏ ${tabs.length} tab${tabs.length !== 1 ? 's' : ''}</span>
          ${branchHtml}
          ${timeAgo ? `<span class="meta-item" style="margin-left:auto">⏱ ${timeAgo}</span>` : ''}
        </div>
        ${notesHtml}
        <div class="card-actions">
          ${recordBtnHtml}
          ${shareBtnHtml}
          <button class="icon-btn view-btn" data-id="${session.session_id}" title="View Tabs">VIEW</button>
          ${restoreBtnHtml}
          <button class="icon-btn delete-btn" data-id="${session.session_id}" title="Delete">✕</button>
        </div>
        <div class="tab-list tab-list-hidden" id="tabs-${session.session_id}">
          ${tabListHtml}
        </div>
      `;

      sessionsListEl.appendChild(card);
    });

    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const panel = document.getElementById(`tabs-${e.currentTarget.dataset.id}`);
        if (panel) panel.classList.toggle('tab-list-hidden');
      });
    });
    document.querySelectorAll('.restore-btn').forEach(btn => {
      btn.addEventListener('click', (e) => restoreSession(e.currentTarget.dataset.id));
    });
    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => deleteSession(e.currentTarget.dataset.id));
    });
    document.querySelectorAll('.share-btn').forEach(btn => {
      btn.addEventListener('click', (e) => toggleShare(e.currentTarget.dataset.id, e.currentTarget));
    });
    document.querySelectorAll('.record-btn').forEach(btn => {
      btn.addEventListener('click', (e) => startRecordingSession(e.currentTarget.dataset.id));
    });
    document.querySelectorAll('.stop-rec-btn').forEach(btn => {
      btn.addEventListener('click', () => stopRecordingSession());
    });
  }

  function toggleShare(id, btnEl) {
    chrome.runtime.sendMessage({ type: 'TOGGLE_SHARE', session_id: id }, (response) => {
      if (response && response.ok) {
        btnEl.classList.toggle('active', !!response.is_shared);
        showToast(response.is_shared ? 'Session shared.' : 'Session unshared.', 'success');
        loadSessions();
      } else {
        showToast('Failed to toggle share.', 'error');
      }
    });
  }

  function restoreSession(id) {
    chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', session_id: id }, (response) => {
      showToast(response && response.ok ? 'Session restored!' : 'Failed to restore session.', response && response.ok ? 'success' : 'error');
    });
  }

  function deleteSession(id) {
    chrome.runtime.sendMessage({ type: 'DELETE_SESSION', session_id: id }, (response) => {
      if (response && response.ok) {
        if (recordingState.active && recordingState.sessionId === id) {
          recordingState = { active: false, sessionId: null, windowId: null };
          updateRecordingUI();
        }
        showToast('Session deleted.', 'success');
        loadSessions();
      } else {
        showToast('Failed to delete.', 'error');
      }
    });
  }

  function showToast(message, type) {
    toastEl.textContent = message;
    toastEl.className = `toast ${type}`;
    setTimeout(() => { toastEl.className = 'toast hidden'; }, 3000);
  }

  function formatDuration(ms) {
    if (!ms || ms < 1000) return '';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  }

  function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + ' years ago';
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + ' months ago';
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + ' days ago';
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + ' hours ago';
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + ' mins ago';
    return 'just now';
  }

  function escapeHtml(unsafe) {
    return (unsafe || '').toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function flashLiveIndicator() {
    if (!liveIndicator) return;
    liveIndicator.classList.add('flash');
    setTimeout(() => liveIndicator.classList.remove('flash'), 1500);
  }

  function updateSyncStatus(status) {
    syncStatusEl.classList.remove('offline', 'syncing', 'synced', 'error');
    if (status === 'synced') {
      const now = new Date();
      lastSyncEl.textContent = `Synced: ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    }
    switch (status) {
      case 'syncing': syncStatusEl.classList.add('syncing'); syncStatusEl.title = 'Syncing...'; break;
      case 'synced':  syncStatusEl.classList.add('synced');  syncStatusEl.title = 'Synced'; break;
      case 'error':   syncStatusEl.classList.add('error');   syncStatusEl.title = 'Sync error'; break;
      default: syncStatusEl.classList.add('offline'); syncStatusEl.title = currentUser ? 'Cloud sync enabled' : 'Not signed in';
    }
  }
});
