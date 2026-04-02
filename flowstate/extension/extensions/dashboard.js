document.addEventListener('DOMContentLoaded', () => {
  // --- State ---
  let currentUser = null;
  let currentRole = null;
  let currentOrgId = null;
  let allSessions = [];
  let searchQuery = '';
  let allMembers = [];
  let memberSearchQuery = '';

  // --- DOM refs ---
  const navItems = document.querySelectorAll('.nav-item');
  const viewSections = document.querySelectorAll('.view-section');
  const toastEl = document.getElementById('dash-toast');
  const userEmailEl = document.getElementById('sidebar-user-email');
  const userRoleEl = document.getElementById('sidebar-user-role');

  // --- Navigation ---
  navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      navItems.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const target = btn.dataset.section;
      viewSections.forEach(s => {
        s.classList.toggle('active', s.id === `view-${target}`);
      });
      loadSectionData(target);
    });
  });

  function loadSectionData(section) {
    switch (section) {
      case 'sessions': loadSessions(); break;
      case 'organizations': loadOrgs(); break;
      case 'members': loadMembers(); break;
      case 'roles': loadRoles(); break;
      case 'invites': loadInviteRoles(); break;
      case 'privacy': loadPrivacy(); break;
    }
  }

  // --- Auth check ---
  chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, (resp) => {
    if (resp && resp.user) {
      currentUser = resp.user;
      currentRole = resp.role || null;
      currentOrgId = resp.orgId || null;
      userEmailEl.textContent = currentUser.displayName || currentUser.email;
      if (currentRole) {
        userRoleEl.textContent = currentRole.name;
        userRoleEl.className = 'sidebar-user-role ' + currentRole.name.toLowerCase();
      }
    }
    loadSessions();
  });

  // --- Logout ---
  document.getElementById('sidebar-logout-btn').addEventListener('click', () => {
    if (!confirm('Logout of FlowState?')) return;
    chrome.storage.local.remove(['user', 'token', 'refreshToken', 'tokenExpiry', 'activeOrgId', 'sessions', 'members', 'roles'], () => {
      window.close();
    });
  });

  // --- Live updates ---
  chrome.runtime.onMessage.addListener((req) => {
    if (req.type === 'CLOUD_UPDATED') {
      const activeSection = document.querySelector('.nav-item.active');
      if (activeSection) loadSectionData(activeSection.dataset.section);
    }
  });

  // ===================== SESSIONS =====================
  const sessionsListEl = document.getElementById('dash-sessions-list');
  const sessionSearchEl = document.getElementById('dash-session-search');

  sessionSearchEl.addEventListener('input', () => {
    searchQuery = sessionSearchEl.value.trim().toLowerCase();
    renderSessions(allSessions);
  });

  function loadSessions() {
    chrome.runtime.sendMessage({ type: 'LIST_SESSIONS' }, (resp) => {
      if (resp && resp.ok) {
        allSessions = resp.data || [];
        renderSessions(allSessions);
      }
    });
  }

  function renderSessions(sessions) {
    sessionsListEl.innerHTML = '';
    let filtered = sessions;
    if (searchQuery) {
      filtered = sessions.filter(s =>
        (s.name || '').toLowerCase().includes(searchQuery) ||
        (s.creator_name || '').toLowerCase().includes(searchQuery)
      );
    }
    if (filtered.length === 0) {
      sessionsListEl.innerHTML = '<div class="empty-state">No sessions found</div>';
      return;
    }

    // Group sessions by creator role
    chrome.storage.local.get(['members', 'roles', 'activeOrgId'], (store) => {
      const members = store.members || [];
      const roles = store.roles || [];
      const orgId = store.activeOrgId || currentOrgId;

      // Build uid -> role name mapping for the active org
      const uidToRole = {};
      members.forEach(m => {
        if (m.orgId === orgId) {
          const role = roles.find(r => r._id === m.roleId);
          uidToRole[m.uid] = role ? role.name : 'Unknown';
        }
      });

      // Group sessions
      const groups = {};
      const rolePriority = { 'Admin': 0, 'Editor': 1, 'Viewer': 2 };
      filtered.forEach(s => {
        const roleName = uidToRole[s.ownerUid] || 'Unknown';
        if (!groups[roleName]) groups[roleName] = [];
        groups[roleName].push(s);
      });

      // Sort groups by role priority
      const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
        return (rolePriority[a] ?? 99) - (rolePriority[b] ?? 99);
      });

      const roleColors = {
        'Admin': 'var(--accent-gold)',
        'Editor': 'var(--accent-purple)',
        'Viewer': 'var(--accent-green)'
      };

      sessionsListEl.innerHTML = '';
      sortedGroupKeys.forEach(roleName => {
        const color = roleColors[roleName] || 'var(--text-secondary)';
        // Role group header
        const header = document.createElement('div');
        header.className = 'session-role-group-header';
        header.innerHTML = `
          <span class="session-role-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>
          <span class="session-role-label" style="color:${color}">${esc(roleName)}</span>
          <span class="session-role-count">${groups[roleName].length} session${groups[roleName].length !== 1 ? 's' : ''}</span>
          <span class="session-role-line"></span>`;
        sessionsListEl.appendChild(header);

        groups[roleName].forEach(s => {
          const tabs = s.tabs || [];
          const time = s.created_at ? getTimeAgo(new Date(s.created_at)) : '';
          const vis = s.visibility || 'private';
          const visBadge = vis === 'private'
            ? '<span class="badge badge-private">Private</span>'
            : '<span class="badge badge-shared">Shared</span>';
          const creator = s.creator_name ? `by ${esc(s.creator_name)}` : '';

          const row = document.createElement('div');
          row.className = 'session-row';
          row.innerHTML = `
            <div class="session-info">
              <div class="session-name">${esc(s.name || 'Untitled')} ${visBadge}</div>
              <div class="session-meta">
                <span>❏ ${tabs.length} tab${tabs.length !== 1 ? 's' : ''}</span>
                ${creator ? `<span>${creator}</span>` : ''}
                ${time ? `<span>⏱ ${time}</span>` : ''}
              </div>
            </div>
            <div class="session-actions">
              <button class="dash-btn" data-action="restore" data-id="${s.session_id}" title="Restore">▶ Open</button>
              <button class="dash-btn ${s.is_shared ? 'dash-btn-primary' : ''}" data-action="share" data-id="${s.session_id}" title="Toggle share">🔗</button>
              <button class="dash-btn dash-btn-danger" data-action="delete" data-id="${s.session_id}" title="Delete">✕</button>
            </div>`;
          sessionsListEl.appendChild(row);
        });
      });

      // Re-attach button handlers
      sessionsListEl.querySelectorAll('[data-action="restore"]').forEach(b =>
        b.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'RESTORE_SESSION', session_id: b.dataset.id }, (r) => {
            toast(r && r.ok ? 'Session restored!' : 'Restore failed', r && r.ok ? 'success' : 'error');
          });
        })
      );
      sessionsListEl.querySelectorAll('[data-action="share"]').forEach(b =>
        b.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'TOGGLE_SHARE', session_id: b.dataset.id }, (r) => {
            if (r && r.ok) { toast(r.is_shared ? 'Shared' : 'Unshared', 'success'); loadSessions(); }
          });
        })
      );
      sessionsListEl.querySelectorAll('[data-action="delete"]').forEach(b =>
        b.addEventListener('click', () => {
          if (confirm('Delete this session?')) {
            chrome.runtime.sendMessage({ type: 'DELETE_SESSION', session_id: b.dataset.id }, (r) => {
              if (r && r.ok) { toast('Deleted', 'success'); loadSessions(); }
            });
          }
        })
      );
    });
  }

  // ===================== ORGANIZATIONS =====================
  const orgListEl = document.getElementById('dash-org-list');
  const createOrgBtn = document.getElementById('dash-create-org-btn');

  createOrgBtn.addEventListener('click', () => {
    const name = prompt('Workspace name:');
    if (!name || !name.trim()) return;
    chrome.runtime.sendMessage({ type: 'CREATE_ORG', name: name.trim() }, (r) => {
      if (r && r.ok) {
        currentOrgId = r.orgId;
        toast(`Workspace "${r.name}" created!`, 'success');
        loadOrgs();
      } else {
        toast('Failed to create workspace', 'error');
      }
    });
  });

  function loadOrgs() {
    chrome.runtime.sendMessage({ type: 'LIST_ORGS' }, (resp) => {
      if (!resp || !resp.ok) { orgListEl.innerHTML = '<div class="empty-state">No organizations</div>'; return; }
      const orgs = resp.data || [];
      const activeId = resp.activeOrgId || currentOrgId;
      orgListEl.innerHTML = '';
      if (orgs.length === 0) { orgListEl.innerHTML = '<div class="empty-state">No organizations</div>'; return; }
      orgs.forEach(org => {
        const isActive = org._id === activeId;
        const row = document.createElement('div');
        row.className = 'org-row' + (isActive ? ' active-org' : '');
        row.innerHTML = `
          <div><span class="org-name">${esc(org.name || 'Unnamed')}</span>
          ${isActive ? ' <span class="badge badge-active">Active</span>' : ''}</div>
          ${!isActive ? `<button class="dash-btn" data-org-id="${org._id}">Switch</button>` : ''}`;
        orgListEl.appendChild(row);
      });
      orgListEl.querySelectorAll('[data-org-id]').forEach(b =>
        b.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'SET_ACTIVE_ORG', orgId: b.dataset.orgId }, () => {
            currentOrgId = b.dataset.orgId;
            toast('Switched workspace', 'success');
            loadOrgs();
          });
        })
      );
    });
  }

  // ===================== MEMBERS =====================
  const membersListEl = document.getElementById('dash-members-list');
  const memberSearchEl = document.getElementById('dash-member-search');

  memberSearchEl.addEventListener('input', () => {
    memberSearchQuery = memberSearchEl.value.trim().toLowerCase();
    renderMembers(allMembers);
  });

  function loadMembers() {
    chrome.runtime.sendMessage({ type: 'GET_ORG_MEMBERS' }, (resp) => {
      if (!resp || !resp.ok || !resp.data || resp.data.length === 0) {
        allMembers = [];
        membersListEl.innerHTML = '<div class="empty-state">No members found</div>';
        return;
      }
      allMembers = resp.data;
      renderMembers(allMembers);
    });
  }

  function renderMembers(members) {
    chrome.storage.local.get(['roles', 'user'], (store) => {
      const roles = store.roles || [];
      const currentUid = store.user?.uid;
      const currentDisplayName = store.user?.displayName || store.user?.email || '';

      let filtered = members;
      if (memberSearchQuery) {
        filtered = members.filter(m => {
          const name = getMemberName(m, currentUid, currentDisplayName);
          const role = roles.find(r => r._id === m.roleId);
          const roleName = role ? role.name : '';
          return name.toLowerCase().includes(memberSearchQuery) ||
                 roleName.toLowerCase().includes(memberSearchQuery) ||
                 (m.status || '').toLowerCase().includes(memberSearchQuery);
        });
      }

      if (filtered.length === 0) {
        membersListEl.innerHTML = '<div class="empty-state">No members found</div>';
        return;
      }

      let html = `<table class="members-table">
        <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>`;
      filtered.forEach(m => {
        const role = roles.find(r => r._id === m.roleId);
        const roleName = role ? role.name : 'Unknown';
        const roleClass = roleName.toLowerCase();
        const memberName = getMemberName(m, currentUid, currentDisplayName);
        const statusBadge = m.status === 'active'
          ? '<span class="badge badge-active">Active</span>'
          : '<span class="badge badge-pending">Pending</span>';
        const approveBtn = m.status === 'pending'
          ? `<button class="dash-btn dash-btn-primary" data-approve-uid="${m._id}">Approve</button>`
          : '';
        const isYou = m.uid === currentUid ? ' <span style="color:var(--text-muted);font-size:9px;">(you)</span>' : '';
        html += `<tr>
          <td>
            <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;">${esc(memberName)}${isYou}</div>
            <div style="font-size:9px;color:var(--text-muted);margin-top:2px;letter-spacing:0.03em;">${esc(m.email || '')}</div>
          </td>
          <td><span class="role-badge-inline ${roleClass}">${esc(roleName)}</span></td>
          <td>${statusBadge}</td>
          <td>${approveBtn}</td>
        </tr>`;
      });
      html += '</tbody></table>';
      membersListEl.innerHTML = html;

      membersListEl.querySelectorAll('[data-approve-uid]').forEach(b =>
        b.addEventListener('click', () => {
          b.disabled = true; b.textContent = '...';
          chrome.runtime.sendMessage({ type: 'APPROVE_USER', uid: b.dataset.approveUid }, (r) => {
            if (r && r.ok) { toast('Approved!', 'success'); loadMembers(); }
            else { toast('Failed', 'error'); b.disabled = false; b.textContent = 'Approve'; }
          });
        })
      );
    });
  }

  function getMemberName(member, currentUid, currentDisplayName) {
    // If it's the current user, use their local displayName
    if (member.uid === currentUid) return currentDisplayName;
    // If member doc has displayName or email, use that
    if (member.displayName) return member.displayName;
    if (member.email) return member.email;
    // Fall back to shortened UID
    if (member.uid) return member.uid.substring(0, 8) + '…';
    return 'Unknown';
  }

  // ===================== ROLES =====================
  const rolesListEl = document.getElementById('dash-roles-list');

  function loadRoles() {
    chrome.storage.local.get(['roles', 'activeOrgId'], (result) => {
      const orgId = result.activeOrgId || currentOrgId;
      const roles = (result.roles || []).filter(r => r.orgId === orgId);
      rolesListEl.innerHTML = '';
      if (roles.length === 0) { rolesListEl.innerHTML = '<div class="empty-state">No roles defined for this workspace</div>'; return; }

      // Sort: Admin first, then Editor, then Viewer, then rest
      const priority = { admin: 0, editor: 1, viewer: 2 };
      const sorted = [...roles].sort((a, b) => {
        const pa = priority[a.name.toLowerCase()] ?? 99;
        const pb = priority[b.name.toLowerCase()] ?? 99;
        return pa - pb;
      });

      sorted.forEach(role => {
        const card = document.createElement('div');
        card.className = 'role-card';
        const nameClass = role.name.toLowerCase();
        card.innerHTML = `
          <div class="role-card-header">
            <span class="role-card-name ${nameClass}">${esc(role.name)}</span>
            ${role.isSystem ? '<span class="role-system-badge">System</span>' : ''}
          </div>
          <div class="perm-list">
            ${(role.permissions || []).map(p => `<span class="perm-tag">${esc(p)}</span>`).join('')}
          </div>`;
        rolesListEl.appendChild(card);
      });
    });
  }

  // ===================== INVITES =====================
  const inviteRoleEl = document.getElementById('dash-invite-role');
  const createInviteBtn = document.getElementById('dash-create-invite-btn');
  const inviteResultEl = document.getElementById('dash-invite-result');
  const inviteLinkEl = document.getElementById('dash-invite-link');
  const copyInviteBtn = document.getElementById('dash-copy-invite');

  function loadInviteRoles() {
    chrome.storage.local.get(['roles', 'activeOrgId'], (result) => {
      const orgId = result.activeOrgId || currentOrgId;
      const roles = (result.roles || []).filter(r => r.orgId === orgId);
      inviteRoleEl.innerHTML = '';
      roles.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.name;
        opt.textContent = r.name;
        inviteRoleEl.appendChild(opt);
      });
    });
  }

  createInviteBtn.addEventListener('click', () => {
    const roleName = inviteRoleEl.value || 'Viewer';
    createInviteBtn.disabled = true;
    createInviteBtn.textContent = 'Generating...';
    chrome.runtime.sendMessage({ type: 'CREATE_INVITE', roleName }, (r) => {
      createInviteBtn.disabled = false;
      createInviteBtn.textContent = 'Generate Invite Link';
      if (r && r.ok) {
        const link = `${chrome.runtime.getURL('auth.html')}?token=${r.token}`;
        inviteLinkEl.value = link;
        inviteResultEl.style.display = 'block';
        toast('Invite link created!', 'success');
      } else {
        toast(r?.error || 'Failed to create invite', 'error');
      }
    });
  });

  copyInviteBtn.addEventListener('click', () => {
    inviteLinkEl.select();
    navigator.clipboard.writeText(inviteLinkEl.value).then(() => toast('Copied!', 'success'));
  });

  // ===================== PRIVACY =====================
  const domainInput = document.getElementById('dash-domain-input');
  const addDomainBtn = document.getElementById('dash-add-domain-btn');
  const domainListEl = document.getElementById('dash-domain-list');
  const flaggedTabsListEl = document.getElementById('dash-flagged-tabs-list');

  function loadPrivacy() {
    chrome.runtime.sendMessage({ type: 'GET_PRIVACY_FLAGS' }, (resp) => {
      if (!resp || !resp.ok) return;
      // Domains
      const domains = resp.flaggedDomains || [];
      domainListEl.innerHTML = '';
      if (domains.length === 0) {
        domainListEl.innerHTML = '<div class="empty-state" style="padding:16px 0;">No flagged domains</div>';
      } else {
        domains.forEach(d => {
          const row = document.createElement('div');
          row.className = 'domain-row';
          row.innerHTML = `
            <div><div class="domain-row-name">${esc(d)}</div>
            <div class="domain-row-sub">all subdomains included</div></div>
            <button class="dash-btn dash-btn-danger" data-remove-domain="${esc(d)}">Remove</button>`;
          domainListEl.appendChild(row);
        });
        domainListEl.querySelectorAll('[data-remove-domain]').forEach(b =>
          b.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'REMOVE_DOMAIN_FLAG', domain: b.dataset.removeDomain }, (r) => {
              if (r && r.ok) { toast('Domain removed', 'success'); loadPrivacy(); }
            });
          })
        );
      }
      // Tabs
      const tabs = resp.flaggedTabs || [];
      flaggedTabsListEl.innerHTML = '';
      if (tabs.length === 0) {
        flaggedTabsListEl.innerHTML = '<div class="empty-state" style="padding:16px 0;">No flagged tabs</div>';
      } else {
        tabs.forEach(t => {
          const row = document.createElement('div');
          row.className = 'domain-row';
          row.innerHTML = `
            <div><div class="domain-row-name">${esc(t.hostname || t.title || 'Tab #' + t.id)}</div>
            <div class="domain-row-sub">${esc(t.title || t.url || '(closed)')}</div></div>
            <button class="dash-btn dash-btn-danger" data-unflag-tab="${t.id}">Unflag</button>`;
          flaggedTabsListEl.appendChild(row);
        });
        flaggedTabsListEl.querySelectorAll('[data-unflag-tab]').forEach(b =>
          b.addEventListener('click', () => {
            chrome.runtime.sendMessage({ type: 'TOGGLE_TAB_FLAG', tabId: parseInt(b.dataset.unflagTab, 10) }, (r) => {
              if (r && r.ok) { toast('Tab unflagged', 'success'); loadPrivacy(); }
            });
          })
        );
      }
    });
  }

  addDomainBtn.addEventListener('click', () => {
    const raw = domainInput.value.trim().toLowerCase();
    const domain = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) { toast('Enter a domain', 'error'); return; }
    chrome.runtime.sendMessage({ type: 'ADD_DOMAIN_FLAG', domain }, (r) => {
      if (r && r.ok) { domainInput.value = ''; toast(`"${domain}" flagged`, 'success'); loadPrivacy(); }
    });
  });
  domainInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addDomainBtn.click(); });

  // ===================== HELPERS =====================
  function toast(msg, type) {
    toastEl.textContent = msg;
    toastEl.className = `dash-toast ${type}`;
    setTimeout(() => { toastEl.className = 'dash-toast hidden'; }, 3000);
  }

  function esc(s) {
    return (s || '').toString()
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getTimeAgo(date) {
    const s = Math.floor((new Date() - date) / 1000);
    if (s / 31536000 > 1) return Math.floor(s / 31536000) + 'y ago';
    if (s / 2592000 > 1) return Math.floor(s / 2592000) + 'mo ago';
    if (s / 86400 > 1) return Math.floor(s / 86400) + 'd ago';
    if (s / 3600 > 1) return Math.floor(s / 3600) + 'h ago';
    if (s / 60 > 1) return Math.floor(s / 60) + 'm ago';
    return 'just now';
  }
});
