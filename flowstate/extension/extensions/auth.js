import { authRest } from './firebase-rest.js';
import { GOOGLE_CLIENT_ID } from './firebase-config.js';

// DOM elements
const googleSigninBtn = document.getElementById('google-signin');
const emailSigninBtn = document.getElementById('email-signin');
const emailSignupBtn = document.getElementById('email-signup');
const showSignupLink = document.getElementById('show-signup');
const showSigninLink = document.getElementById('show-signin');
const signinForm = document.getElementById('signin-form');
const signupForm = document.getElementById('signup-form');
const errorMessage = document.getElementById('error-message');

// Check for invite token in URL
const urlParams = new URLSearchParams(window.location.search);
const inviteToken = urlParams.get('token');

// Toggle between signin and signup forms
const typeSelection = document.getElementById('signup-type-selection');
const detailsForm = document.getElementById('signup-details');
const orgDetails = document.getElementById('org-details');
const rankBuilder = document.getElementById('rank-builder');

showSignupLink.addEventListener('click', () => {
  signinForm.style.display = 'none';
  signupForm.style.display = 'block';
  typeSelection.style.display = 'block';
  detailsForm.style.display = 'none';
  clearError();
});

showSigninLink.addEventListener('click', () => {
  signupForm.style.display = 'none';
  signinForm.style.display = 'block';
  clearError();
});

// Dynamic Ranks Logic
let customRanks = []; // Array of { id, name, color, level }
let currentLevel = 100;
let rankCounter = 0;

  let activeColorBtn = null;
  const colorPickerFlyout = document.getElementById('custom-color-picker');
  const colorPickerHex = document.getElementById('color-picker-hex');

  function openColorPicker(btn, idx) {
    activeColorBtn = { btn, idx };
    const rect = btn.getBoundingClientRect();
    colorPickerFlyout.style.top = (rect.bottom + window.scrollY + 10) + 'px';
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
      <input type="text" class="input-field" style="margin:0; flex:1; padding:8px;" placeholder="Rank Name" value="${rank.name}" data-idx="${idx}">
      <div class="custom-color-btn" style="background:${rank.color};" data-idx="${idx}"></div>
      ${idx > 0 ? `<button class="auth-button btn-remove" style="width:36px; height:36px; padding:0; margin:0; background:rgba(255,51,102,0.1); border:1px solid rgba(255,51,102,0.4); color:#ff3366;" data-idx="${idx}">✕</button>` : `<div style="width:36px;"></div>`}
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

document.getElementById('add-lower-rank').addEventListener('click', (e) => {
  e.preventDefault();
  currentLevel -= 10;
  if(currentLevel < 10) currentLevel = 10;
  customRanks.push({ id: `rank_${rankCounter++}`, name: 'New Rank', color: '#00e5ff', level: currentLevel });
  renderRanks();
});

document.getElementById('add-same-rank').addEventListener('click', (e) => {
  e.preventDefault();
  customRanks.push({ id: `rank_${rankCounter++}`, name: 'Co-Rank', color: '#ffaa00', level: currentLevel });
  renderRanks();
});

document.getElementById('btn-next-step').addEventListener('click', () => {
  const selectedType = document.querySelector('input[name="account-type"]:checked').value;
  typeSelection.style.display = 'none';
  detailsForm.style.display = 'block';
  
  if (selectedType === 'organization') {
    orgDetails.style.display = 'block';
    initRankBuilder();
  } else {
    orgDetails.style.display = 'none';
  }
});

document.getElementById('btn-back-step').addEventListener('click', (e) => {
  e.preventDefault();
  detailsForm.style.display = 'none';
  typeSelection.style.display = 'block';
});


// Google Sign-In via chrome.identity
googleSigninBtn.addEventListener('click', async () => {
  clearError();
  const redirectUri = chrome.identity.getRedirectURL();
  const scopes = ['openid', 'email', 'profile'];
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', scopes.join(' '));

  try {
    setButtonLoading(googleSigninBtn, true);
    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        { url: authUrl.toString(), interactive: true },
        (callbackUrl) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(callbackUrl);
        }
      );
    });

    const params = new URLSearchParams(new URL(responseUrl.replace('#', '?')).search);
    const accessToken = params.get('access_token');
    if (!accessToken) throw new Error('No access token received from Google');

    const firebaseData = await authRest.signInWithIdp(accessToken, 'google.com');
    await completeLogin(firebaseData, null, { type: 'individual' }); // Assume individual for google sign-in existing users
  } catch (error) {
    console.error('Google sign-in error:', error);
    if (!error.message.includes('User cancelled') && !error.message.includes('canceled')) {
      showError(error.message || 'Google sign-in failed');
    }
    setButtonLoading(googleSigninBtn, false);
  }
});

async function completeLogin(data, overrideName, metadata) {
  const uid = data.localId;
  const token = data.idToken;
  const email = data.email;
  const displayName = overrideName || data.displayName || email.split('@')[0];
  const accountType = metadata?.type || 'individual';
  const orgName = metadata?.orgName || null;
  const ranks = metadata?.customRanks || null;

  await new Promise(resolve => chrome.runtime.sendMessage({
    type: 'AUTH_SUCCESS',
    user: {
      uid,
      email,
      displayName,
      accountType, // Save account type
      stsTokenManager: {
        accessToken: token,
        refreshToken: data.refreshToken || '',
        expirationTime: Date.now() + (parseInt(data.expiresIn || '3600') * 1000)
      }
    }
  }, resolve));

  if (accountType === 'organization') {
    await new Promise(resolve => chrome.runtime.sendMessage({ 
      type: 'CREATE_ORG_WITH_RANKS', 
      name: orgName, 
      customRanks: ranks 
    }, resolve));
  } else {
    // For individuals, we still ENSURE_ORG to create a "Personal Workspace"
    await new Promise(resolve => chrome.runtime.sendMessage({ type: 'ENSURE_ORG' }, resolve));
  }

  // Accept invite if token is present in URL
  if (inviteToken) {
    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'ACCEPT_INVITE', token: inviteToken }, (resp) => {
          if (resp && resp.ok) resolve(resp);
          else reject(new Error(resp?.error || 'Failed to accept invite'));
        });
      });
      showSuccess('Joined organization successfully!');
    } catch (e) {
      showError(e.message || 'Failed to accept invite');
      return;
    }
  } else {
    showSuccess('Signed in successfully!');
  }

  setTimeout(() => window.close(), 1000);
}

// Email Sign-In
emailSigninBtn.addEventListener('click', async () => {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  if (!email || !password) {
    showError('Please enter both email and password');
    return;
  }

  try {
    setButtonLoading(emailSigninBtn, true);
    const data = await authRest.signIn(email, password);
    await completeLogin(data);
  } catch (error) {
    console.error('Email sign-in error:', error);
    showError(error.message || 'Login failed');
    setButtonLoading(emailSigninBtn, false);
  }
});

// Email Sign-Up
emailSignupBtn.addEventListener('click', async () => {
  const fullName = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const confirmPassword = document.getElementById('signup-confirm').value;

  const selectedType = document.querySelector('input[name="account-type"]:checked').value;
  let orgName = '';
  if (selectedType === 'organization') {
    orgName = document.getElementById('org-name').value.trim();
    if (!orgName) { showError('Please enter an Organization Name'); return; }
    if (customRanks.some(r => !r.name.trim())) { showError('All ranks must have a valid name'); return; }
  }

  if (!fullName || !email || !password || !confirmPassword) {
    showError('Please fill in all fields');
    return;
  }
  if (password.length < 6) {
    showError('Password must be at least 6 characters');
    return;
  }
  if (password !== confirmPassword) {
    showError('Passwords do not match');
    return;
  }

  try {
    setButtonLoading(emailSignupBtn, true);
    const data = await authRest.signUp(email, password);
    await completeLogin(data, fullName, { type: selectedType, orgName, customRanks });
  } catch (error) {
    console.error('Sign-up error:', error);
    showError(error.message || 'Registration failed');
    setButtonLoading(emailSignupBtn, false);
  }
});

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add('show');
  errorMessage.style.color = '#ff6b6b';
}

function showSuccess(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add('show');
  errorMessage.style.color = '#00e5a0';
}

function clearError() {
  errorMessage.classList.remove('show');
}

function setButtonLoading(button, loading) {
  if (loading) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.innerHTML = '<span class="loading"></span> Processing...';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText;
  }
}

document.getElementById('email').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') emailSigninBtn.click();
});
document.getElementById('password').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') emailSigninBtn.click();
});
document.getElementById('signup-confirm').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') emailSignupBtn.click();
});
