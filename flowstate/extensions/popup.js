document.addEventListener('DOMContentLoaded', () => {
  const tabCountEl = document.getElementById('tab-count');
  const sessionNameInput = document.getElementById('session-name');
  const sessionNotesInput = document.getElementById('session-notes');
  const saveBtn = document.getElementById('save-btn');
  const sessionsListEl = document.getElementById('sessions-list');
  const toastEl = document.getElementById('toast');
  const userEmailEl = document.getElementById('user-email');
  const authBtn = document.getElementById('auth-btn');
  const syncStatusEl = document.getElementById('sync-status');
  const lastSyncEl = document.getElementById('last-sync');
  const approvalsSection = document.getElementById('approvals-section');
  const approvalsListEl = document.getElementById('approvals-list');

  let currentUser = null;

  // Check auth status on load
  chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, (response) => {
    if (response && response.user) {
      currentUser = response.user;
      userEmailEl.textContent = response.user.displayName || response.user.email;
      userEmailEl.className = 'user-info signed-in'; // reset classes
      
      const rank = (response.user.rank || 'jc').toLowerCase();
      userEmailEl.classList.add(`rank-${rank}`);
      
      const rankNames = { 'jc': 'Junior Core', 'sc': 'Senior Core', 'board': 'Board' };
      userEmailEl.textContent += ` (${rankNames[rank] || rank})`;

      authBtn.textContent = '⏻';
      authBtn.title = 'Sign Out';

      if (rank === 'board') {
        approvalsSection.style.display = 'block';
        loadApprovals();
      } else {
        approvalsSection.style.display = 'none';
      }
    }
  });

  // Auth button handler
  authBtn.addEventListener('click', () => {
    if (currentUser) {
      // Sign out
      if (confirm('Are you sure you want to sign out?')) {
        chrome.runtime.sendMessage({ type: 'SIGN_OUT' }, (response) => {
          if (response && response.ok) {
            currentUser = null;
            userEmailEl.textContent = 'Not signed in';
            userEmailEl.className = 'user-info';
            authBtn.textContent = '👤';
            authBtn.title = 'Sign In';
            syncStatusEl.classList.remove('synced', 'syncing', 'error');
            syncStatusEl.classList.add('offline');
            lastSyncEl.textContent = '';
            approvalsSection.style.display = 'none';
            loadSessions(); // Reload to show local sessions only
            showToast('Signed out successfully', 'success');
          }
        });
      }
    } else {
      // Open auth page
      chrome.tabs.create({ url: 'auth.html' });
    }
  });

  // Load current tab count
  if (chrome.tabs) {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
      tabCountEl.textContent = `${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`;
    });
  }

  // Load sessions
  loadSessions();

  // Listen for sync status updates
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'UPDATE_SYNC_STATUS') {
      updateSyncStatus(request.status);
      if (request.status === 'synced') {
        loadSessions();
      }
    }
  });

  saveBtn.addEventListener('click', () => {
    const name = sessionNameInput.value.trim();
    const notes = sessionNotesInput.value.trim();

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    chrome.runtime.sendMessage({
      type: 'SAVE_SESSION',
      name: name,
      notes: notes
    }, (response) => {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Session';
      
      if (response && response.ok) {
        showToast('Session saved!', 'success');
        sessionNameInput.value = '';
        sessionNotesInput.value = '';
        loadSessions();
      } else {
        showToast('Failed to save session.', 'error');
      }
    });
  });

  function loadSessions() {
    chrome.runtime.sendMessage({ type: 'LIST_SESSIONS' }, (response) => {
      if (chrome.runtime.lastError) {
        sessionsListEl.innerHTML = `<div style="color:#f43f5e; font-size:12px; padding:10px;">Port Error: ${escapeHtml(chrome.runtime.lastError.message)}</div>`;
        return;
      }
      try {
        if (response && response.ok) {
          renderSessions(response.data);
        } else {
          sessionsListEl.innerHTML = `<div style="color:#f43f5e; font-size:12px; padding:10px;">Bad Response: ${response ? response.error : 'Undefined Response'}</div>`;
        }
      } catch(e) {
        sessionsListEl.innerHTML = `<div style="color:#f43f5e; font-size:10px; padding:10px; font-family:monospace;">Render Crash: ${escapeHtml(e.message)} ${escapeHtml(e.stack)}</div>`;
      }
    });
  }

  function renderSessions(sessions) {
    sessionsListEl.innerHTML = '';
    
    if (!sessions || typeof sessions.length !== 'number') {
      sessionsListEl.innerHTML = `<div style="color:red">Corrupted Session List Rendered!</div>`;
      return;
    }

    if (sessions.length === 0) {
      sessionsListEl.innerHTML = '<div style="color: #666; font-size: 12px; text-align: center; padding: 20px;">No saved sessions.</div>';
      return;
    }

    const groups = { board: [], sc: [], jc: [] };
    sessions.forEach(s => {
      const rank = s.creator_rank || 'jc';
      if (groups[rank]) groups[rank].push(s);
      else groups.jc.push(s); 
    });

    const rankTitles = { board: 'Board Sessions', sc: 'Senior Core Sessions', jc: 'Junior Core Sessions' };
    const rankColors = { board: '#ffd700', sc: '#a371f7', jc: '#00e5a0' };

    ['board', 'sc', 'jc'].forEach(rank => {
      if (groups[rank].length > 0) {
        const header = document.createElement('h3');
        header.className = 'session-group-header';
        header.style.color = rankColors[rank];
        header.textContent = rankTitles[rank];
        sessionsListEl.appendChild(header);

        groups[rank].forEach(session => {
          const card = document.createElement('div');
          card.className = 'card';

          const timeAgo = getTimeAgo(new Date(session.created_at));
          const branchHtml = session.git_branch ? `<span class="meta-item card-branch">⎇ ${escapeHtml(session.git_branch)}</span>` : '';
          const notesHtml = session.notes ? `<div class="card-notes">${escapeHtml(session.notes)}</div>` : '';

          const creatorRank = session.creator_rank || 'jc';
          const rankBadge = `<span class="rank-badge ${creatorRank}">${creatorRank}</span>`;
          const sharedBadge = session.is_shared ? `<span class="session-shared-badge">Shared</span>` : '';
          const creatorName = session.creator_name ? `<span class="creator-name">by ${escapeHtml(session.creator_name)}</span>` : '';

          let shareBtnHtml = '';
          if (currentUser && (currentUser.rank === 'board' || currentUser.rank === 'sc') && session.user_id === currentUser.uid) {
            const activeClass = session.is_shared ? 'active' : '';
            shareBtnHtml = `<button class="icon-btn share-btn ${activeClass}" data-id="${session.session_id}" title="Toggle Share">🔗</button>`;
          }

          card.innerHTML = `
            <div class="card-header">
              <div class="card-title">
                ${escapeHtml(session.name || 'Untitled Session')}
                ${rankBadge}
                ${sharedBadge}
              </div>
              ${creatorName}
            </div>
            <div class="card-meta">
              <span class="meta-item">❏ ${session.tabs.length} tab${session.tabs.length !== 1 ? 's' : ''}</span>
              ${branchHtml}
              <span class="meta-item" style="margin-left:auto">⏱ ${timeAgo}</span>
            </div>
            ${notesHtml}
            <div class="card-actions">
              ${shareBtnHtml}
              <button class="icon-btn restore-btn" data-id="${session.session_id}" title="Restore">▶</button>
              <button class="icon-btn delete-btn" data-id="${session.session_id}" title="Delete">✕</button>
            </div>
          `;

          sessionsListEl.appendChild(card);
        });
      }
    });

    // Add event listeners to buttons
    document.querySelectorAll('.restore-btn').forEach(btn => {
      btn.addEventListener('click', (e) => restoreSession(e.currentTarget.dataset.id));
    });
    
    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => deleteSession(e.currentTarget.dataset.id));
    });

    document.querySelectorAll('.share-btn').forEach(btn => {
      btn.addEventListener('click', (e) => toggleShare(e.currentTarget.dataset.id, e.currentTarget));
    });
  }

  function toggleShare(id, btnEl) {
    chrome.runtime.sendMessage({ type: 'TOGGLE_SHARE', session_id: id }, (response) => {
      if (response && response.ok) {
        if (response.is_shared) {
          btnEl.classList.add('active');
          showToast('Session shared.', 'success');
        } else {
          btnEl.classList.remove('active');
          showToast('Session unshared.', 'success');
        }
        loadSessions();
      } else {
        showToast('Failed to toggle share.', 'error');
      }
    });
  }

  function loadApprovals() {
    if (!approvalsListEl) return;
    approvalsListEl.innerHTML = '<div style="color: #666; font-size: 12px;">Loading pending users...</div>';
    
    chrome.runtime.sendMessage({ type: 'GET_PENDING_APPROVALS' }, (response) => {
      if (response && response.ok) {
        const users = response.data || [];
        if (users.length === 0) {
          approvalsListEl.innerHTML = '<div style="color: #666; font-size: 12px;">No pending approvals</div>';
          return;
        }
        
        approvalsListEl.innerHTML = '';
        users.forEach(u => {
          const card = document.createElement('div');
          card.className = 'approval-card';
          card.innerHTML = `
            <div class="approval-info">
              <div><strong>${escapeHtml(u.email)}</strong></div>
              <div>Rank: <span style="color:#a371f7; text-transform: uppercase;">${escapeHtml(u.rank)}</span></div>
            </div>
            <button class="btn primary-btn" style="padding: 4px 8px; font-size: 11px;" data-uid="${u._id}">Approve</button>
          `;
          
          const btn = card.querySelector('button');
          btn.addEventListener('click', () => {
            btn.disabled = true;
            btn.textContent = '...';
            chrome.runtime.sendMessage({ type: 'APPROVE_USER', uid: u._id }, (res) => {
              if (res && res.ok) {
                showToast('User approved!', 'success');
                loadApprovals();
              } else {
                showToast('Approval failed.', 'error');
                btn.disabled = false;
                btn.textContent = 'Approve';
              }
            });
          });
          
          approvalsListEl.appendChild(card);
        });
      } else {
        approvalsListEl.innerHTML = '<div style="color: #f43f5e; font-size: 12px;">Failed to load.</div>';
      }
    });
  }

  function restoreSession(id) {
    chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', session_id: id }, (response) => {
      if (response && response.ok) {
        showToast('Session restored!', 'success');
      } else {
        showToast('Failed to restore session.', 'error');
      }
    });
  }

  function deleteSession(id) {
    chrome.runtime.sendMessage({ type: 'DELETE_SESSION', session_id: id }, (response) => {
      if (response && response.ok) {
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
    
    setTimeout(() => {
      toastEl.className = 'toast hidden';
    }, 3000);
  }

  function getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    let interval = seconds / 31536000;
    if (interval > 1) return Math.floor(interval) + " years ago";
    interval = seconds / 2592000;
    if (interval > 1) return Math.floor(interval) + " months ago";
    interval = seconds / 86400;
    if (interval > 1) return Math.floor(interval) + " days ago";
    interval = seconds / 3600;
    if (interval > 1) return Math.floor(interval) + " hours ago";
    interval = seconds / 60;
    if (interval > 1) return Math.floor(interval) + " mins ago";
    return "just now";
  }

  function escapeHtml(unsafe) {
    return (unsafe || '').toString()
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
  }

  function updateSyncStatus(status) {
    syncStatusEl.classList.remove('offline', 'syncing', 'synced', 'error');
    
    if (status === 'synced') {
      const now = new Date();
      lastSyncEl.textContent = `Synced: ${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
    }

    switch(status) {
      case 'syncing':
        syncStatusEl.classList.add('syncing');
        syncStatusEl.title = 'Syncing to cloud...';
        break;
      case 'synced':
        syncStatusEl.classList.add('synced');
        syncStatusEl.title = 'Synced to cloud';
        break;
      case 'error':
        syncStatusEl.classList.add('error');
        syncStatusEl.title = 'Sync error - will retry';
        break;
      default:
        syncStatusEl.classList.add('offline');
        syncStatusEl.title = currentUser ? 'Cloud sync enabled' : 'Not signed in';
    }
  }
});
