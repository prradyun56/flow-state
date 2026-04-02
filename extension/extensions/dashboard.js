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
      case 'invites': loadInvites(); break;
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
      applySidebarRole(resp.orgName, currentRole);
    }
    loadSessions();
  });

  function applySidebarRole(orgName, role) {
    const accountType = currentUser?.accountType || 'individual';
    const isPersonalWorkspace = orgName === 'Personal Workspace' || (!role && accountType === 'individual');

    if (isPersonalWorkspace) {
      userRoleEl.textContent = 'Individual';
      userRoleEl.style.color = '#00e5ff';
      userRoleEl.className = 'sidebar-user-role';
      document.querySelector('[data-section="members"]').style.display = 'none';
      document.querySelector('[data-section="roles"]').style.display = 'none';
      document.querySelector('[data-section="invites"]').style.display = 'none';
    } else {
      userRoleEl.textContent = role ? role.name : 'Unknown Rank';
      userRoleEl.style.color = role ? (role.color || '#ffaa00') : '#888';
      userRoleEl.className = 'sidebar-user-role';
      document.querySelector('[data-section="members"]').style.display = 'flex';
      document.querySelector('[data-section="roles"]').style.display = 'flex';
      document.querySelector('[data-section="invites"]').style.display = 'flex';
    }
  }

  // Re-fetch the user's role for the current workspace and update sidebar
  function refreshSidebarRole() {
    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS' }, (resp) => {
      if (resp && resp.user) {
        currentRole = resp.role || null;
        currentOrgId = resp.orgId || null;
        applySidebarRole(resp.orgName, currentRole);
      }
    });
  }

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

      // Build uid -> role object mapping for the active org
      const uidToRole = {};
      members.forEach(m => {
        if (m.orgId === orgId) {
          const role = roles.find(r => r._id === m.roleId);
          uidToRole[m.uid] = role || { name: 'Unknown', level: 0, color: '#888' };
        }
      });

      // Group sessions
      const groups = {};
      filtered.forEach(s => {
        const role = uidToRole[s.ownerUid] || { name: 'Unknown', level: 0, color: '#888' };
        const roleName = role.name;
        if (!groups[roleName]) groups[roleName] = { role, items: [] };
        groups[roleName].items.push(s);
      });

      // Sort groups by role level descending
      const sortedGroupKeys = Object.keys(groups).sort((a, b) => {
        return groups[b].role.level - groups[a].role.level;
      });

      sessionsListEl.innerHTML = '';
      sortedGroupKeys.forEach(roleName => {
        const group = groups[roleName];
        const color = group.role.color || '#aaaaaa';
        // Role group header
        const header = document.createElement('div');
        header.className = 'session-role-group-header';
        header.innerHTML = `
          <span class="session-role-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>
          <span class="session-role-label" style="color:${color}">${esc(roleName)}</span>
          <span class="session-role-count">${group.items.length} session${group.items.length !== 1 ? 's' : ''}</span>
          <span class="session-role-line"></span>`;
        sessionsListEl.appendChild(header);

        group.items.forEach(s => {
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
  const createModal = document.getElementById('create-workspace-modal');
  const workspaceInput = document.getElementById('workspace-name-input');
  const cancelBtn = document.getElementById('btn-cancel-workspace');
  const submitBtn = document.getElementById('btn-submit-workspace');
  
  const rankBuilder = document.getElementById('dash-rank-builder');
  let customRanks = [];
  let currentLevel = 100;
  let rankCounter = 0;

  let activeColorBtn = null;
  const colorPickerFlyout = document.getElementById('custom-color-picker');
  const colorPickerHex = document.getElementById('color-picker-hex');

  function openColorPicker(btn, idx) {
    activeColorBtn = { btn, idx };
    const rect = btn.getBoundingClientRect();
    colorPickerFlyout.style.top = (rect.bottom + 10) + 'px';
    colorPickerFlyout.style.left = rect.left + 'px';
    colorPickerFlyout.classList.remove('hidden');
    colorPickerHex.value = customRanks[idx].color.toUpperCase();
  }

  document.addEventListener('click', (e) => {
    if (!colorPickerFlyout.contains(e.target) && !e.target.closest('.custom-color-btn')) {
      colorPickerFlyout.classList.add('hidden');
    }
  });

  colorPickerFlyout.querySelectorAll('.color-blob').forEach(blob => {
    blob.addEventListener('click', () => {
      if (!activeColorBtn) return;
      const hex = blob.dataset.hex;
      customRanks[activeColorBtn.idx].color = hex;
      activeColorBtn.btn.style.background = hex;
      colorPickerHex.value = hex.toUpperCase();
      colorPickerFlyout.classList.add('hidden');
    });
  });

  colorPickerHex.addEventListener('input', (e) => {
    if (!activeColorBtn) return;
    const hex = e.target.value;
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      customRanks[activeColorBtn.idx].color = hex;
      activeColorBtn.btn.style.background = hex;
    }
  });

  function renderRanks() {
    rankBuilder.innerHTML = '';
    customRanks.forEach((rank, idx) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '10px';
      row.style.alignItems = 'center';
      row.style.marginBottom = '5px';
      row.innerHTML = `
        <span style="color:#888; font-family:'JetBrains Mono',monospace; width:30px; font-size:12px;">L${rank.level}</span>
        <input type="text" class="dash-input" style="margin:0; flex:1; padding:8px;" placeholder="Rank Name" value="${rank.name}" data-idx="${idx}">
        <div class="custom-color-btn" style="background:${rank.color};" data-idx="${idx}"></div>
        ${idx > 0 ? `<button class="dash-btn btn-remove" style="width:36px; height:36px; padding:0; margin:0; background:rgba(255,51,102,0.1); border:1px solid rgba(255,51,102,0.4); color:#ff3366;" data-idx="${idx}">✕</button>` : `<div style="width:36px;"></div>`}
      `;
      rankBuilder.appendChild(row);
    });
    
    rankBuilder.querySelectorAll('input[type="text"]').forEach(input => {
      input.addEventListener('input', (e) => {
        customRanks[e.target.dataset.idx].name = e.target.value;
      });
    });
    rankBuilder.querySelectorAll('.custom-color-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        openColorPicker(e.currentTarget, parseInt(e.currentTarget.dataset.idx));
      });
    });
    rankBuilder.querySelectorAll('.btn-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        customRanks.splice(parseInt(e.currentTarget.dataset.idx), 1);
        renderRanks();
      });
    });
  }

  function initRankBuilder() {
    customRanks = [{ id: 'rank_0', name: 'Director', color: '#ff3366', level: 100 }];
    currentLevel = 100;
    rankCounter = 1;
    renderRanks();
  }

  document.getElementById('dash-add-lower-rank').addEventListener('click', (e) => {
    e.preventDefault();
    currentLevel -= 10;
    if(currentLevel < 10) currentLevel = 10;
    customRanks.push({ id: `rank_${rankCounter++}`, name: 'New Rank', color: '#00e5ff', level: currentLevel });
    renderRanks();
  });

  document.getElementById('dash-add-same-rank').addEventListener('click', (e) => {
    e.preventDefault();
    customRanks.push({ id: `rank_${rankCounter++}`, name: 'Co-Rank', color: '#ffaa00', level: currentLevel });
    renderRanks();
  });

  let isEditMode = false;
  let editingOrgId = null;

  const publicToggle = document.getElementById('public-workspace-toggle');

  createOrgBtn.addEventListener('click', () => {
    isEditMode = false;
    editingOrgId = null;
    createModal.classList.remove('hidden');
    document.querySelector('#create-workspace-modal h2').textContent = 'Create New Workspace';
    workspaceInput.value = '';
    workspaceInput.disabled = false;
    publicToggle.checked = true;
    submitBtn.textContent = 'Create';
    initRankBuilder();
    workspaceInput.focus();
  });

  window.openEditStructureModal = function() {
    isEditMode = true;
    editingOrgId = currentOrgId;
    createModal.classList.remove('hidden');
    document.querySelector('#create-workspace-modal h2').textContent = 'Edit Workspace Structure';
    
    chrome.storage.local.get(['organizations', 'roles'], (res) => {
      const org = (res.organizations || []).find(o => o._id === currentOrgId);
      if (org) {
        workspaceInput.value = org.name;
        publicToggle.checked = !!org.isPublic;
      }
      workspaceInput.disabled = true;
      
      const orgRoles = (res.roles || []).filter(r => r.orgId === currentOrgId);
      if (orgRoles.length > 0) {
        customRanks = orgRoles.map(r => ({
          id: r._id,
          name: r.name,
          color: r.color || '#fff',
          level: r.level || 0,
          originalId: r._id
        })).sort((a,b) => b.level - a.level);
        currentLevel = customRanks[customRanks.length - 1].level;
        rankCounter = customRanks.length;
      } else {
        initRankBuilder();
      }
      renderRanks();
      submitBtn.textContent = 'Save Changes';
    });
  }

  cancelBtn.addEventListener('click', () => {
    createModal.classList.add('hidden');
  });

  submitBtn.addEventListener('click', () => {
    const name = workspaceInput.value.trim();
    if (!isEditMode && !name) return;
    if (customRanks.some(r => !r.name.trim())) { toast('All ranks must have a valid name', 'error'); return; }
    submitBtn.textContent = isEditMode ? 'Saving...' : 'Creating...';
    submitBtn.disabled = true;

    const action = isEditMode ? 'UPDATE_ORG_RANKS' : 'CREATE_ORG_WITH_RANKS';
    const payload = isEditMode 
      ? { orgId: editingOrgId, customRanks, isPublic: publicToggle.checked } 
      : { name: name, customRanks, isPublic: publicToggle.checked };

    chrome.runtime.sendMessage({ type: action, ...payload }, (r) => {
      submitBtn.textContent = isEditMode ? 'Save Changes' : 'Create';
      submitBtn.disabled = false;
      if (r && r.ok) {
        createModal.classList.add('hidden');
        if (!isEditMode && r.orgId) currentOrgId = r.orgId;
        toast(isEditMode ? 'Structure updated successfully!' : `Workspace "${r.name}" created!`, 'success');
        loadOrgs();
        loadRoles();
      } else {
        toast(`Failed: ${r?.error || 'Unknown error'}`, 'error');
      }
    });
  });

  const expandedOrgs = new Set();

  function loadOrgs() {
    chrome.runtime.sendMessage({ type: 'LIST_ORGS' }, (resp) => {
      if (!resp || !resp.ok) { orgListEl.innerHTML = '<div class="empty-state">No organizations</div>'; return; }
      const orgs = resp.data || [];
      const activeId = resp.activeOrgId || currentOrgId;
      orgListEl.innerHTML = '';
      if (orgs.length === 0) { orgListEl.innerHTML = '<div class="empty-state">No organizations</div>'; return; }
      orgs.forEach(org => {
        const isActive = org._id === activeId;
        const isAdmin = isActive && currentRole && currentRole.level === 100;
        const isExpanded = expandedOrgs.has(org._id);
        
        const row = document.createElement('div');
        row.className = `org-row-container${isActive ? ' active-container' : ''}`;

        const isOwner = currentUser && org.ownerUid === currentUser.uid;
        const isPersonal = org.name === 'Personal Workspace';

        let actionButtons = '';
        if (!isActive) {
          actionButtons = `
            <div style="display:flex; gap:6px;">
              <button class="dash-btn" data-org-id="${org._id}">Switch</button>
              ${!isOwner && !isPersonal ? `<button class="dash-btn dash-btn-danger btn-leave-org" data-leave-org-id="${org._id}" title="Leave">Leave</button>` : ''}
            </div>`;
        } else if (!isPersonal) {
          let dropdownItems = '';
          if (isAdmin) {
            dropdownItems += `<button class="dropdown-item" data-action="invite">Invite Members</button>
              <button class="dropdown-item" data-action="edit-structure">Edit Structure</button>`;
          }
          if (!isOwner) {
            dropdownItems += `<button class="dropdown-item dropdown-item-danger" data-action="leave-org" data-leave-org-id="${org._id}">Leave Workspace</button>`;
          }
          if (isOwner) {
            dropdownItems += `<button class="dropdown-item dropdown-item-danger" data-action="delete-org" data-delete-org-id="${org._id}">Delete Workspace</button>`;
          }
          if (dropdownItems) {
            actionButtons = `
              <div class="org-dropdown-container" style="position:relative;">
                <button class="dash-btn-icon" data-dropdown-trigger="${org._id}">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle>
                  </svg>
                </button>
                <div class="org-dropdown hidden" id="dropdown-${org._id}">${dropdownItems}</div>
              </div>`;
          }
        }

        row.innerHTML = `
          <div class="org-row" data-row-org-id="${org._id}">
            <div style="display:flex; align-items:center; gap:12px; flex:1; cursor:pointer;" class="org-expand-trigger">
              <span class="chevron" style="transform: rotate(${isExpanded ? '90' : '0'}deg);">▶</span>
              <span class="org-name">${esc(org.name || 'Unnamed')}</span>
              ${isActive ? '<span class="badge badge-active" style="margin-left:4px;">Active</span>' : ''}
            </div>
            ${actionButtons}
          </div>
          <div class="org-hierarchy-panel ${isExpanded ? '' : 'hidden'}" id="hierarchy-${org._id}">
            <div style="font-size:11px; color:#555; padding:12px 0 4px 0;">Loading hierarchy...</div>
          </div>
        `;
        orgListEl.appendChild(row);

        if (isExpanded) renderOrgHierarchy(org._id);
      });
      
      orgListEl.querySelectorAll('.org-expand-trigger').forEach(trigger => {
        trigger.addEventListener('click', () => {
          const orgId = trigger.closest('.org-row').dataset.rowOrgId;
          const hierarchyEl = document.getElementById(`hierarchy-${orgId}`);
          const chevron = trigger.querySelector('.chevron');
          
          if (expandedOrgs.has(orgId)) {
            expandedOrgs.delete(orgId);
            hierarchyEl.classList.add('hidden');
            chevron.style.transform = 'rotate(0deg)';
          } else {
            expandedOrgs.add(orgId);
            hierarchyEl.classList.remove('hidden');
            chevron.style.transform = 'rotate(90deg)';
            renderOrgHierarchy(orgId);
          }
        });
      });
      
      // Close dropdowns when clicking outside
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.org-dropdown-container')) {
          document.querySelectorAll('.org-dropdown').forEach(d => d.classList.add('hidden'));
        }
      });
      
      // Bind Dropdown triggers
      orgListEl.querySelectorAll('[data-dropdown-trigger]').forEach(b => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetId = `dropdown-${b.dataset.dropdownTrigger}`;
          document.querySelectorAll('.org-dropdown').forEach(d => {
            if (d.id !== targetId) d.classList.add('hidden');
          });
          document.getElementById(targetId).classList.toggle('hidden');
        });
      });
      
      // Bind Dropdown actions
      orgListEl.querySelectorAll('[data-action="invite"]').forEach(b => {
        b.addEventListener('click', () => {
          navItems.forEach(n => n.classList.remove('active'));
          const inviteNav = document.querySelector('[data-section="invites"]');
          if (inviteNav) {
            inviteNav.classList.add('active');
            viewSections.forEach(s => s.classList.toggle('active', s.id === 'view-invites'));
            loadSectionData('invites');
          }
        });
      });
      orgListEl.querySelectorAll('[data-action="edit-structure"]').forEach(b => {
        b.addEventListener('click', () => openEditStructureModal());
      });
      orgListEl.querySelectorAll('[data-action="leave-org"]').forEach(b => {
        b.addEventListener('click', () => {
          if (!confirm('Leave this workspace? You will lose access immediately.')) return;
          chrome.runtime.sendMessage({ type: 'LEAVE_ORG', orgId: b.dataset.leaveOrgId }, (r) => {
            if (r && r.ok) { toast('Left workspace', 'success'); loadOrgs(); }
            else toast(r?.error || 'Failed to leave', 'error');
          });
        });
      });
      orgListEl.querySelectorAll('[data-action="delete-org"]').forEach(b => {
        b.addEventListener('click', () => {
          if (!confirm('Permanently delete this workspace and ALL its data? This cannot be undone.')) return;
          chrome.runtime.sendMessage({ type: 'DELETE_ORG', orgId: b.dataset.deleteOrgId }, (r) => {
            if (r && r.ok) { toast('Workspace deleted', 'success'); loadOrgs(); }
            else toast(r?.error || 'Failed to delete', 'error');
          });
        });
      });
      // Inline Leave buttons for non-active orgs
      orgListEl.querySelectorAll('.btn-leave-org').forEach(b => {
        b.addEventListener('click', () => {
          if (!confirm('Leave this workspace?')) return;
          chrome.runtime.sendMessage({ type: 'LEAVE_ORG', orgId: b.dataset.leaveOrgId }, (r) => {
            if (r && r.ok) { toast('Left workspace', 'success'); loadOrgs(); }
            else toast(r?.error || 'Failed to leave', 'error');
          });
        });
      });
      orgListEl.querySelectorAll('[data-org-id]').forEach(b =>
        b.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'SET_ACTIVE_ORG', orgId: b.dataset.orgId }, () => {
            currentOrgId = b.dataset.orgId;
            toast('Switched workspace', 'success');
            refreshSidebarRole();
            loadOrgs();
          });
        })
      );
    });
  }

  function renderOrgHierarchy(orgId) {
    const hierarchyEl = document.getElementById(`hierarchy-${orgId}`);
    if (!hierarchyEl) return;

    // Fetch both roles and members
    chrome.runtime.sendMessage({ type: 'GET_ORG_ROLES', orgId }, (roleResp) => {
      chrome.runtime.sendMessage({ type: 'GET_ORG_MEMBERS', orgId }, (memResp) => {
        if (!roleResp?.ok || !memResp?.ok) {
          hierarchyEl.innerHTML = '<div style="padding:10px; color:#ff3366; font-size:11px;">Failed to load hierarchy.</div>';
          return;
        }

        const roles = (roleResp.data || []).sort((a, b) => (b.level || 0) - (a.level || 0));
        const members = memResp.data || [];

        if (roles.length === 0) {
          hierarchyEl.innerHTML = '<div style="padding:10px; color:#666; font-size:11px;">No ranks defined.</div>';
          return;
        }

        let html = '<div class="org-hierarchy">';
        roles.forEach(role => {
          const roleMembers = members.filter(m => m.roleId === role._id);
          const color = role.color || '#888';
          
          html += `
            <div class="rank-group">
              <div class="rank-header" style="background:${color}15; color:${color}; border:1px solid ${color}30;">
                ${esc(role.name)} <span style="opacity:0.6; margin-left:4px;">L${role.level}</span>
              </div>
              <div class="rank-members" style="margin-left:12px; display:flex; flex-direction:column; gap:4px; margin-top:4px;">
          `;

          if (roleMembers.length === 0) {
            html += '<div style="font-size:11px; color:#444; padding:2px 8px;">No members</div>';
          } else {
            roleMembers.forEach(m => {
              const isPending = m.status === 'pending';
              const name = m.displayName || m.email || 'Unknown User';
              const isYou = (currentUser && m.uid === currentUser.uid) ? ' (You)' : '';
              
              html += `
                <div class="member-item">
                  <div style="display:flex; align-items:center;">
                    <span class="status-dot" style="background:${isPending ? '#ffaa00' : '#00e5a0'}"></span>
                    <span>${esc(name)}${isYou}</span>
                  </div>
                  ${isPending ? '<span style="font-size:9px; color:#ffaa00; text-transform:uppercase; font-weight:700;">Pending</span>' : ''}
                </div>
              `;
            });
          }

          html += `</div></div>`;
        });
        html += '</div>';
        hierarchyEl.innerHTML = html;
      });
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
    chrome.storage.local.get(['roles', 'activeOrgId', 'user'], (store) => {
      const roles = store.roles || [];
      const orgId = store.activeOrgId || currentOrgId;
      const currentUid = store.user?.uid;
      const currentDisplayName = store.user?.displayName || store.user?.email || '';
      const orgRoles = roles.filter(r => r.orgId === orgId);
      // Sort orgRoles by level descending for dropdown ordering
      const sortedOrgRoles = [...orgRoles].sort((a, b) => (b.level ?? 0) - (a.level ?? 0));

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

      // Sort members by role level (highest first = hierarchy order)
      filtered = [...filtered].sort((a, b) => {
        const roleA = roles.find(r => r._id === a.roleId);
        const roleB = roles.find(r => r._id === b.roleId);
        const levelA = roleA ? (roleA.level ?? 0) : -1;
        const levelB = roleB ? (roleB.level ?? 0) : -1;
        return levelB - levelA;
      });

      if (filtered.length === 0) {
        membersListEl.innerHTML = '<div class="empty-state">No members found</div>';
        return;
      }

      chrome.runtime.sendMessage({ type: 'CAN_DO', permission: 'members.changeRoles' }, (canResp) => {
        const canChangeRoles = canResp && canResp.ok && canResp.can;

        chrome.runtime.sendMessage({ type: 'CAN_DO', permission: 'members.kick' }, (kickResp) => {
          const canKick = kickResp && kickResp.ok && kickResp.can;

          let html = `<table class="members-table">
            <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>`;
          filtered.forEach(m => {
            const role = roles.find(r => r._id === m.roleId);
            const roleName = role ? role.name : 'Unknown';
            const roleColor = role ? (role.color || '#888') : '#888';
            const roleLevel = role ? (role.level ?? 0) : 0;
            const memberName = getMemberName(m, currentUid, currentDisplayName);
            const statusBadge = m.status === 'active'
              ? '<span class="badge badge-active">Active</span>'
              : '<span class="badge badge-pending">Pending</span>';
            const isYou = m.uid === currentUid ? ' <span style="color:var(--text-muted);font-size:9px;">(you)</span>' : '';
            const isNotSelf = m.uid !== currentUid;

            // Role cell: color-coded dropdown if authorized, otherwise static badge
            let roleCell = `<span class="role-badge-inline" style="background:${roleColor}15; color:${roleColor}; border:1px solid ${roleColor}40; padding:4px 12px; border-radius:3px; font-size:10px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase;">${esc(roleName)}</span>`;
            if (canChangeRoles && isNotSelf && sortedOrgRoles.length > 0) {
              const opts = sortedOrgRoles.map(r =>
                `<option value="${esc(r._id)}" ${r._id === m.roleId ? 'selected' : ''} style="color:${r.color || '#fff'}; background:#1a1a2e;">⬤ ${esc(r.name)} (L${r.level ?? 0})</option>`
              ).join('');
              roleCell = `<select class="dash-select role-change-select" style="font-size:11px; padding:4px 10px; height:auto; color:${roleColor}; border-color:${roleColor}40; background:${roleColor}08;" data-member-uid="${esc(m.uid)}" data-role-color="${roleColor}">${opts}</select>`;
            }

            // Actions: Approve button + Kick button
            let actionBtns = '';
            if (m.status === 'pending') {
              actionBtns += `<button class="dash-btn dash-btn-primary" data-approve-uid="${m._id}" style="font-size:10px; padding:4px 10px;">Approve</button> `;
            }
            if (canKick && isNotSelf) {
              actionBtns += `<button class="dash-btn dash-btn-danger" data-kick-uid="${esc(m.uid)}" data-kick-name="${esc(memberName)}" style="font-size:10px; padding:4px 10px;">Remove</button>`;
            }

            html += `<tr style="border-left:3px solid ${roleColor};">
              <td>
                <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;">${esc(memberName)}${isYou}</div>
                <div style="font-size:9px;color:var(--text-muted);margin-top:2px;letter-spacing:0.03em;">${esc(m.email || '')}</div>
              </td>
              <td>${roleCell}</td>
              <td>${statusBadge}</td>
              <td>${actionBtns}</td>
            </tr>`;
          });
          html += '</tbody></table>';
          membersListEl.innerHTML = html;

          // Bind approve buttons
          membersListEl.querySelectorAll('[data-approve-uid]').forEach(b =>
            b.addEventListener('click', () => {
              b.disabled = true; b.textContent = '...';
              chrome.runtime.sendMessage({ type: 'APPROVE_USER', uid: b.dataset.approveUid }, (r) => {
                if (r && r.ok) { toast('Approved!', 'success'); loadMembers(); }
                else { toast('Failed', 'error'); b.disabled = false; b.textContent = 'Approve'; }
              });
            })
          );

          // Bind role-change dropdowns
          membersListEl.querySelectorAll('.role-change-select').forEach(sel => {
            // Update dropdown color when selection changes
            const updateColor = () => {
              const selectedOpt = sel.options[sel.selectedIndex];
              const r = sortedOrgRoles.find(r => r._id === sel.value);
              if (r) {
                sel.style.color = r.color || '#fff';
                sel.style.borderColor = (r.color || '#888') + '40';
                sel.style.background = (r.color || '#888') + '08';
              }
            };
            sel.addEventListener('change', () => {
              updateColor();
              const targetUserId = sel.dataset.memberUid;
              const newRoleId = sel.value;
              chrome.runtime.sendMessage({ type: 'CHANGE_MEMBER_ROLE', targetUserId, newRoleId }, (r) => {
                if (r && r.ok) { toast('Role updated', 'success'); loadMembers(); }
                else { toast(r?.error || 'Failed to change role', 'error'); loadMembers(); }
              });
            });
          });

          // Bind kick buttons
          membersListEl.querySelectorAll('[data-kick-uid]').forEach(btn =>
            btn.addEventListener('click', () => {
              const name = btn.dataset.kickName || 'this member';
              if (!confirm(`Remove ${name} from this workspace? They will lose access immediately.`)) return;
              btn.disabled = true; btn.textContent = 'Removing...';
              chrome.runtime.sendMessage({ type: 'KICK_MEMBER', targetUserId: btn.dataset.kickUid }, (r) => {
                if (r && r.ok) {
                  toast(`${name} has been removed`, 'success');
                  loadMembers();
                } else {
                  toast(r?.error || 'Failed to remove member', 'error');
                  btn.disabled = false; btn.textContent = 'Remove';
                }
              });
            })
          );
        });
      });
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

  // Permission definitions for the create-role modal
  const PERM_DEFS = [
    { path: 'sessions.read',       label: 'Sessions: Read' },
    { path: 'sessions.write',      label: 'Sessions: Write' },
    { path: 'sessions.delete',     label: 'Sessions: Delete' },
    { path: 'members.invite',      label: 'Members: Invite' },
    { path: 'members.approve',     label: 'Members: Approve' },
    { path: 'members.changeRoles', label: 'Members: Change Roles' },
    { path: 'members.kick',        label: 'Members: Remove / Kick' },
    { path: 'roles.create',        label: 'Roles: Create' },
    { path: 'roles.edit',          label: 'Roles: Edit' },
    { path: 'roles.delete',        label: 'Roles: Delete' },
    { path: 'org.settings',        label: 'Org: Settings' },
    { path: 'org.delete',          label: 'Org: Delete' }
  ];

  const createRoleModal = document.getElementById('create-role-modal');
  const createRoleBtn = document.getElementById('dash-create-role-btn');
  const cancelRoleBtn = document.getElementById('btn-cancel-role');
  const submitRoleBtn = document.getElementById('btn-submit-role');
  const roleModalTitle = createRoleModal ? createRoleModal.querySelector('.dash-card-title') : null;
  const permGrid = document.getElementById('perm-grid');
  let rolePermState = {};
  let editingRoleId = null; // null = create mode, string = edit mode

  function buildPermGrid(existing) {
    rolePermState = {};
    permGrid.innerHTML = '';
    PERM_DEFS.forEach(def => {
      // Determine initial state from existing permissions
      let isOn = false;
      if (existing) {
        if (typeof existing === 'object' && !Array.isArray(existing)) {
          const parts = def.path.split('.');
          let cur = existing;
          for (const p of parts) { cur = cur?.[p]; }
          isOn = !!cur;
        } else if (Array.isArray(existing)) {
          // Legacy array: reverse-lookup. Map like 'roles.edit' -> check if array has 'manage_roles'
          const LEGACY_REVERSE = {
            'members.changeRoles': ['manage_roles'],
            'members.invite':      ['invite_users'],
            'members.approve':     ['approve_users'],
            'members.kick':        ['manage_roles'],
            'roles.create':        ['manage_roles'],
            'roles.edit':          ['manage_roles'],
            'roles.delete':        ['manage_roles'],
            'sessions.read':       ['view_all_sessions', 'view_team_sessions', 'view_shared_sessions', 'view_own_sessions'],
            'sessions.write':      ['share_sessions'],
            'sessions.delete':     ['delete_any_session'],
            'org.settings':        ['manage_roles'],
            'org.delete':          []
          };
          const legacyKeys = LEGACY_REVERSE[def.path];
          if (legacyKeys && legacyKeys.length > 0) {
            isOn = legacyKeys.some(k => existing.includes(k));
          }
        }
      }
      rolePermState[def.path] = isOn;
      const row = document.createElement('div');
      row.className = 'perm-row';
      row.innerHTML = `
        <span style="color:var(--text-color);">${esc(def.label)}</span>
        <div class="perm-toggle ${isOn ? 'on' : ''}" data-perm="${def.path}"></div>`;
      permGrid.appendChild(row);
    });
    permGrid.querySelectorAll('.perm-toggle').forEach(t => {
      t.addEventListener('click', () => {
        const p = t.dataset.perm;
        rolePermState[p] = !rolePermState[p];
        t.classList.toggle('on', rolePermState[p]);
      });
    });
  }

  // ===================== CREATE ROLE SWATCH LOGIC =====================
  const colorHiddenInput = document.getElementById('create-role-color-hidden');
  const customColorInput = document.getElementById('create-role-color');
  const swatches = document.querySelectorAll('.color-swatch[data-color]');

  function setRoleColor(color) {
    if (!colorHiddenInput) return;
    colorHiddenInput.value = color;
    if (customColorInput) customColorInput.value = color;

    // Remove selection from all preset swatches
    if (swatches) {
      swatches.forEach(s => {
        s.classList.remove('selected');
        s.style.boxShadow = 'none';
        if (s.dataset.color.toLowerCase() === color.toLowerCase()) {
          s.classList.add('selected');
          s.style.boxShadow = `0 0 6px ${color}`;
        }
      });
    }

    // Handle custom mapped colors
    const customTrigger = document.getElementById('custom-color-trigger');
    if (customTrigger && swatches) {
      const isPreset = Array.from(swatches).some(s => s.dataset.color.toLowerCase() === color.toLowerCase());
      if (!isPreset) {
        customTrigger.style.background = color;
        customTrigger.style.borderColor = color;
        customTrigger.classList.add('selected');
        customTrigger.style.boxShadow = `0 0 6px ${color}`;
        const plusSpan = customTrigger.querySelector('span');
        if (plusSpan) plusSpan.style.color = '#fff';
      } else {
        customTrigger.style.background = 'transparent';
        customTrigger.style.borderColor = 'var(--text-muted)';
        customTrigger.classList.remove('selected');
        customTrigger.style.boxShadow = 'none';
        const plusSpan = customTrigger.querySelector('span');
        if (plusSpan) plusSpan.style.color = 'var(--text-muted)';
      }
    }
  }

  if (swatches) {
    swatches.forEach(swatch => {
      swatch.addEventListener('click', () => setRoleColor(swatch.dataset.color));
    });
  }

  if (customColorInput) {
    customColorInput.addEventListener('input', (e) => setRoleColor(e.target.value));
  }

  if (createRoleBtn) {
    createRoleBtn.addEventListener('click', () => {
      editingRoleId = null;
      if (roleModalTitle) roleModalTitle.textContent = 'Create Role';
      if (submitRoleBtn) submitRoleBtn.textContent = 'Create Role';
      document.getElementById('create-role-name').value = '';
      document.getElementById('create-role-level').value = '50';
      setRoleColor('#00e5ff');
      buildPermGrid();
      createRoleModal.classList.remove('hidden');
    });
  }

  function openEditRoleModal(role) {
    editingRoleId = role._id;
    if (roleModalTitle) roleModalTitle.textContent = 'Edit Role';
    if (submitRoleBtn) submitRoleBtn.textContent = 'Save Changes';
    document.getElementById('create-role-name').value = role.name || '';
    document.getElementById('create-role-level').value = role.level ?? 50;
    setRoleColor(role.color || '#00e5ff');
    buildPermGrid(role.permissions);
    createRoleModal.classList.remove('hidden');
  }

  if (cancelRoleBtn) {
    cancelRoleBtn.addEventListener('click', () => createRoleModal.classList.add('hidden'));
  }

  if (submitRoleBtn) {
    submitRoleBtn.addEventListener('click', () => {
      const name = document.getElementById('create-role-name').value.trim();
      if (!name) { toast('Role name is required', 'error'); return; }
      const level = parseInt(document.getElementById('create-role-level').value, 10) || 50;
      const colorHidden = document.getElementById('create-role-color-hidden');
      const color = (colorHidden ? colorHidden.value : '#00e5ff') || '#00e5ff';

      // Build nested permissions object from toggle state
      const permissions = {};
      PERM_DEFS.forEach(def => {
        const [cat, key] = def.path.split('.');
        if (!permissions[cat]) permissions[cat] = {};
        permissions[cat][key] = !!rolePermState[def.path];
      });

      submitRoleBtn.disabled = true;

      if (editingRoleId) {
        // --- EDIT mode ---
        submitRoleBtn.textContent = 'Saving...';
        chrome.runtime.sendMessage({
          type: 'UPDATE_ROLE_V2',
          roleId: editingRoleId,
          name, level, color, permissions
        }, (r) => {
          submitRoleBtn.disabled = false;
          submitRoleBtn.textContent = 'Save Changes';
          if (r && r.ok) {
            createRoleModal.classList.add('hidden');
            toast(`Role "${name}" updated!`, 'success');
            loadRoles();
            refreshSidebarRole();
          } else {
            toast(r?.error || 'Failed to update role', 'error');
          }
        });
      } else {
        // --- CREATE mode ---
        submitRoleBtn.textContent = 'Creating...';
        chrome.runtime.sendMessage({ type: 'CREATE_ROLE_V2', name, level, color, permissions }, (r) => {
          submitRoleBtn.disabled = false;
          submitRoleBtn.textContent = 'Create Role';
          if (r && r.ok) {
            createRoleModal.classList.add('hidden');
            toast(`Role "${name}" created!`, 'success');
            loadRoles();
          } else {
            toast(r?.error || 'Failed to create role', 'error');
          }
        });
      }
    });
  }

  const expandedRoles = new Set();

  function loadRoles() {
    chrome.runtime.sendMessage({ type: 'CAN_DO', permission: 'roles.create' }, (canResp) => {
      const canCreate = canResp && canResp.ok && canResp.can;
      const createBtn = document.getElementById('dash-create-role-btn');
      if (createBtn) createBtn.classList.toggle('hidden', !canCreate);
    });

    // Fetch ALL members from Firestore (not local storage which only has current user's memberships)
    chrome.runtime.sendMessage({ type: 'GET_ORG_MEMBERS' }, (memResp) => {
      const orgMembers = (memResp && memResp.ok) ? (memResp.data || []) : [];

      chrome.storage.local.get(['roles', 'activeOrgId', 'user'], (result) => {
        const orgId = result.activeOrgId || currentOrgId;
        const roles = (result.roles || []).filter(r => r.orgId === orgId);
        const currentUid = result.user?.uid;
        const currentDisplayName = result.user?.displayName || result.user?.email || '';
        rolesListEl.innerHTML = '';
        if (roles.length === 0) { rolesListEl.innerHTML = '<div class="empty-state">No roles defined for this workspace</div>'; return; }

        const sorted = [...roles].sort((a, b) => ((b.level ?? 0) - (a.level ?? 0)));

        // Check edit permission for showing edit buttons
        chrome.runtime.sendMessage({ type: 'CAN_DO', permission: 'roles.edit' }, (editResp) => {
          const canEdit = editResp && editResp.ok && editResp.can;

          sorted.forEach(role => {
            const card = document.createElement('div');
            card.className = 'role-card';
            const rc = role.color || '#fff';
            const isExpanded = expandedRoles.has(role._id);

            // Count members in this role
            const roleMembers = orgMembers.filter(m => m.roleId === role._id);
            const memberCount = roleMembers.length;

            // Render permissions — support both array (legacy) and nested object (new)
            let permHtml = '';
            const perms = role.permissions;
            if (Array.isArray(perms)) {
              const LEGACY_LABELS = {
                'manage_roles': 'Manage Roles',
                'invite_users': 'Invite Members',
                'approve_users': 'Approve Members',
                'view_all_sessions': 'Sessions: View All',
                'view_team_sessions': 'Sessions: View Team',
                'view_shared_sessions': 'Sessions: View Shared',
                'view_own_sessions': 'Sessions: View Own',
                'share_sessions': 'Sessions: Share',
                'delete_any_session': 'Sessions: Delete'
              };
              permHtml = perms.map(p => `<span class="perm-tag">${esc(LEGACY_LABELS[p] || p)}</span>`).join('');
            } else if (perms && typeof perms === 'object') {
              const enabledPerms = [];
              for (const [cat, vals] of Object.entries(perms)) {
                for (const [key, val] of Object.entries(vals)) {
                  if (val) {
                    const path = `${cat}.${key}`;
                    const def = PERM_DEFS.find(d => d.path === path);
                    enabledPerms.push(def ? def.label : path);
                  }
                }
              }
              permHtml = enabledPerms.map(p => `<span class="perm-tag">${esc(p)}</span>`).join('');
            }

            const editBtn = canEdit
              ? `<button class="dash-btn role-edit-btn" data-role-id="${role._id}" style="font-size:10px; padding:4px 12px;">✎ Edit</button>`
              : '';

            // Build member list HTML
            let membersHtml = '';
            if (roleMembers.length === 0) {
              membersHtml = '<div style="padding:12px 16px; color:var(--text-muted); font-size:10px; letter-spacing:0.08em; text-transform:uppercase;">No members in this role</div>';
            } else {
              membersHtml = '<div class="role-members-list">';
              roleMembers.forEach(m => {
                const name = getMemberName(m, currentUid, currentDisplayName);
                const isYou = (currentUid && m.uid === currentUid) ? ' <span style="color:var(--text-muted);font-size:9px;">(you)</span>' : '';
                const isPending = m.status === 'pending';
                const statusDot = isPending ? '#ffaa00' : '#00e5a0';
                const statusLabel = isPending
                  ? '<span style="font-size:9px; color:#ffaa00; text-transform:uppercase; font-weight:700; letter-spacing:0.08em;">Pending</span>'
                  : '<span style="font-size:9px; color:#00e5a0; text-transform:uppercase; font-weight:700; letter-spacing:0.08em;">Active</span>';

                membersHtml += `
                  <div class="role-member-row">
                    <div style="display:flex; align-items:center; gap:8px;">
                      <span class="status-dot" style="background:${statusDot}; box-shadow:0 0 6px ${statusDot}; width:6px; height:6px; border-radius:50%; flex-shrink:0;"></span>
                      <span style="font-size:11px; font-weight:500; letter-spacing:0.04em;">${esc(name)}${isYou}</span>
                    </div>
                    ${statusLabel}
                  </div>`;
              });
              membersHtml += '</div>';
            }

            card.innerHTML = `
              <div class="role-card-header role-card-toggle" data-role-id="${role._id}" style="cursor:pointer;">
                <div style="display:flex; align-items:center; gap:8px; flex:1;">
                  <span class="role-expand-chevron" style="font-size:9px; color:var(--text-muted); transition:transform 0.25s ease; transform:rotate(${isExpanded ? '90' : '0'}deg);">▶</span>
                  <span class="role-card-name" style="color:${rc}; text-shadow:0 0 5px ${rc}50">${esc(role.name)}</span>
                  <span style="font-size:10px; color:#666;">L${role.level ?? 0}</span>
                  ${role.isSystem ? '<span class="role-system-badge">System</span>' : ''}
                  <span class="role-member-count" style="font-size:9px; color:var(--text-muted); letter-spacing:0.08em; text-transform:uppercase; margin-left:4px;">${memberCount} member${memberCount !== 1 ? 's' : ''}</span>
                </div>
                ${editBtn}
              </div>
              <div class="perm-list">${permHtml || '<span style="color:#444;font-size:10px;">No permissions</span>'}</div>
              <div class="role-members-panel ${isExpanded ? '' : 'hidden'}" id="role-members-${role._id}" style="border-top:1px solid ${rc}15; margin-top:12px; padding-top:8px;">
                ${membersHtml}
              </div>`;
            rolesListEl.appendChild(card);
          });

          // Bind toggle expand on role card headers
          rolesListEl.querySelectorAll('.role-card-toggle').forEach(header => {
            header.addEventListener('click', (e) => {
              // Don't toggle if clicking the edit button
              if (e.target.closest('.role-edit-btn')) return;
              const roleId = header.dataset.roleId;
              const panel = document.getElementById(`role-members-${roleId}`);
              const chevron = header.querySelector('.role-expand-chevron');
              if (!panel) return;

              if (expandedRoles.has(roleId)) {
                expandedRoles.delete(roleId);
                panel.classList.add('hidden');
                if (chevron) chevron.style.transform = 'rotate(0deg)';
              } else {
                expandedRoles.add(roleId);
                panel.classList.remove('hidden');
                if (chevron) chevron.style.transform = 'rotate(90deg)';
              }
            });
          });

          // Bind edit buttons
          rolesListEl.querySelectorAll('.role-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              const roleId = btn.dataset.roleId;
              const role = sorted.find(r => r._id === roleId);
              if (role) openEditRoleModal(role);
            });
          });
        });
      });
    });
  }

  // ===================== INVITES =====================
  const orgSearchInput = document.getElementById('dash-org-search');
  const searchResultsEl = document.getElementById('dash-search-results');
  const approvalsCard = document.getElementById('approvals-card');
  const approvalsListEl = document.getElementById('dash-approvals-list');
  const inviteLinkCard = document.getElementById('invite-link-card');
  const inviteRoleEl = document.getElementById('dash-invite-role');
  const createInviteBtn = document.getElementById('dash-create-invite-btn');
  const inviteResultEl = document.getElementById('dash-invite-result');
  const inviteLinkEl = document.getElementById('dash-invite-link');
  const copyInviteBtn = document.getElementById('dash-copy-invite');
  let searchTimeout = null;

  // --- Browse Public Workspaces ---
  orgSearchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = orgSearchInput.value.trim();
    if (!query) {
      searchResultsEl.innerHTML = '';
      searchResultsEl.classList.add('hidden');
      return;
    }
    searchTimeout = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'SEARCH_ORGS', query }, (resp) => {
        if (resp && resp.ok) renderSearchResults(resp.data);
      });
    }, 400);
  });

  function renderSearchResults(orgs) {
    searchResultsEl.innerHTML = '';
    if (orgs.length === 0) {
      searchResultsEl.innerHTML = '<div style="padding:10px; color:var(--text-muted); font-size:11px;">No public workspaces found matching that name.</div>';
    } else {
      orgs.forEach(org => {
        const row = document.createElement('div');
        row.className = 'search-result-row';
        row.innerHTML = `
          <div style="display:flex; align-items:center; gap:10px; flex:1;">
            <span style="font-weight:600; font-size:12px; letter-spacing:0.05em; text-transform:uppercase;">${esc(org.name)}</span>
            <span style="font-size:10px; color:var(--text-muted);">${org.memberCount ? org.memberCount + ' members' : ''}</span>
          </div>
          <button class="dash-btn dash-btn-primary btn-join" data-id="${org._id}" style="font-size:10px; padding:6px 16px;">Request to Join</button>
        `;
        searchResultsEl.appendChild(row);
      });

      searchResultsEl.querySelectorAll('.btn-join').forEach(b => {
        b.addEventListener('click', () => {
          b.disabled = true; b.textContent = 'Sending...';
          chrome.runtime.sendMessage({ type: 'REQUEST_JOIN_ORG', orgId: b.dataset.id }, (r) => {
            if (r && r.ok) {
              toast('Join request sent! Waiting for approval.', 'success');
              b.textContent = '✓ Sent';
              b.classList.remove('dash-btn-primary');
              b.style.borderColor = 'var(--accent-green)';
              b.style.color = 'var(--accent-green)';
            } else {
              toast(r?.error || 'Request failed', 'error');
              b.disabled = false; b.textContent = 'Request to Join';
            }
          });
        });
      });
    }
    searchResultsEl.classList.remove('hidden');
  }

  // --- Pending Approvals ---
  function loadApprovals() {
    chrome.runtime.sendMessage({ type: 'GET_JOIN_REQUESTS' }, (resp) => {
      if (!resp || !resp.ok) {
        // User doesn't have approval permissions — hide the card entirely
        approvalsCard.style.display = 'none';
        return;
      }

      const requests = resp.data || [];
      approvalsCard.style.display = 'block';

      if (requests.length === 0) {
        approvalsListEl.innerHTML = '<div class="empty-state" style="font-size:11px; padding:8px 0;">No pending requests</div>';
        return;
      }

      approvalsListEl.innerHTML = '';
      requests.forEach(req => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:var(--glass-bg); border:1px solid var(--glass-border); border-radius:var(--radius); margin-bottom:8px;';
        row.innerHTML = `
          <div style="flex:1;">
            <div style="font-weight:600; font-size:12px; color:var(--text-color);">${esc(req.displayName || req.email || 'Unknown User')}</div>
            <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">${esc(req.email || '')}</div>
          </div>
          <div style="display:flex; gap:8px;">
            <button class="dash-btn dash-btn-primary btn-approve-req" data-req-id="${req._id}" style="font-size:10px; padding:5px 14px;">✓ Approve</button>
            <button class="dash-btn dash-btn-danger btn-reject-req" data-req-id="${req._id}" style="font-size:10px; padding:5px 14px;">✕ Reject</button>
          </div>
        `;
        approvalsListEl.appendChild(row);
      });

      // Approve handler
      approvalsListEl.querySelectorAll('.btn-approve-req').forEach(btn => {
        btn.addEventListener('click', () => {
          btn.disabled = true; btn.textContent = '...';
          chrome.runtime.sendMessage({ type: 'APPROVE_JOIN_REQUEST', requestId: btn.dataset.reqId }, (r) => {
            if (r && r.ok) {
              toast('Member approved!', 'success');
              loadApprovals();
              loadMembers();
            } else {
              toast(r?.error || 'Failed to approve', 'error');
              btn.disabled = false; btn.textContent = '✓ Approve';
            }
          });
        });
      });

      // Reject handler
      approvalsListEl.querySelectorAll('.btn-reject-req').forEach(btn => {
        btn.addEventListener('click', () => {
          btn.disabled = true; btn.textContent = '...';
          chrome.runtime.sendMessage({ type: 'REJECT_JOIN_REQUEST', requestId: btn.dataset.reqId }, (r) => {
            if (r && r.ok) {
              toast('Request rejected', 'success');
              loadApprovals();
            } else {
              toast(r?.error || 'Failed to reject', 'error');
              btn.disabled = false; btn.textContent = '✕ Reject';
            }
          });
        });
      });
    });
  }

  // --- Generate Invite Link ---
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

    // Check if user can invite — if not, hide the invite link card
    chrome.runtime.sendMessage({ type: 'CAN_DO', permission: 'members.invite' }, (resp) => {
      if (resp && resp.ok && resp.can) {
        inviteLinkCard.style.display = 'block';
      } else {
        inviteLinkCard.style.display = 'none';
      }
    });
  }

  function loadInvites() {
    loadInviteRoles();
    loadApprovals();
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
