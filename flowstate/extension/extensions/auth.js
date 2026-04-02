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
showSignupLink.addEventListener('click', () => {
  signinForm.style.display = 'none';
  signupForm.style.display = 'block';
  clearError();
});

showSigninLink.addEventListener('click', () => {
  signupForm.style.display = 'none';
  signinForm.style.display = 'block';
  clearError();
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
    await completeLogin(firebaseData);
  } catch (error) {
    console.error('Google sign-in error:', error);
    if (!error.message.includes('User cancelled') && !error.message.includes('canceled')) {
      showError(error.message || 'Google sign-in failed');
    }
    setButtonLoading(googleSigninBtn, false);
  }
});

async function completeLogin(data, overrideName) {
  const uid = data.localId;
  const token = data.idToken;
  const email = data.email;
  const displayName = overrideName || data.displayName || email.split('@')[0];

  await new Promise(resolve => chrome.runtime.sendMessage({
    type: 'AUTH_SUCCESS',
    user: {
      uid,
      email,
      displayName,
      stsTokenManager: {
        accessToken: token,
        refreshToken: data.refreshToken || '',
        expirationTime: Date.now() + (parseInt(data.expiresIn || '3600') * 1000)
      }
    }
  }, resolve));

  // Ensure user has an org (creates Default Workspace if first login)
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'ENSURE_ORG' }, resolve));

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
    await completeLogin(data, fullName);
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
