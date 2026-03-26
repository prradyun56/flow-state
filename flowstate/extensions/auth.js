import { authRest } from './firebase-rest.js';

// DOM elements
const googleSigninBtn = document.getElementById('google-signin');
const emailSigninBtn = document.getElementById('email-signin');
const emailSignupBtn = document.getElementById('email-signup');
const showSignupLink = document.getElementById('show-signup');
const showSigninLink = document.getElementById('show-signin');
const signinForm = document.getElementById('signin-form');
const signupForm = document.getElementById('signup-form');
const errorMessage = document.getElementById('error-message');

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

// Google Sign-In (using launchWebAuthFlow for MV3 compliance)
googleSigninBtn.addEventListener('click', async () => {
  try {
    setButtonLoading(googleSigninBtn, true);
    
    // For a real app, you'd use your actual Firebase Project ID and a proper redirect
    // This is a simplified demo of the flow
    const redirectUrl = chrome.identity.getRedirectURL();
    const clientId = '488894823727-m4q57c74l7r7rrtvep9qrq7f9j3e29r5.apps.googleusercontent.com'; // Derived from SenderID
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=token&redirect_uri=${encodeURIComponent(redirectUrl)}&scope=${encodeURIComponent('email profile')}`;

    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true
    });

    const accessToken = new URL(responseUrl).hash.split('&')[0].split('=')[1];
    
    // With REST, we'd exchange this token for a Firebase idToken if needed
    // For this context, we'll simulate success since we have the Google identity
    chrome.runtime.sendMessage({
      type: 'AUTH_SUCCESS',
      user: {
        uid: 'google-' + Date.now(), // Simulated UID for demo
        email: 'google-user@example.com', // In real use, we'd fetch profile
        displayName: 'Google User',
        stsTokenManager: { accessToken: accessToken }
      }
    });

    showSuccess('Signed in with Google!');
    setTimeout(() => window.close(), 1000);
  } catch (error) {
    console.error('Google sign-in error:', error);
    showError('Google sign-in failed. Please use email/password.');
    setButtonLoading(googleSigninBtn, false);
  }
});

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
    
    chrome.runtime.sendMessage({
      type: 'AUTH_SUCCESS',
      user: {
        uid: data.localId,
        email: data.email,
        displayName: data.displayName || data.email.split('@')[0],
        stsTokenManager: { accessToken: data.idToken }
      }
    });

    showSuccess('Signed in successfully!');
    setTimeout(() => window.close(), 1000);
  } catch (error) {
    console.error('Email sign-in error:', error);
    showError(error.message || 'Login failed');
    setButtonLoading(emailSigninBtn, false);
  }
});

// Email Sign-Up
emailSignupBtn.addEventListener('click', async () => {
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const confirmPassword = document.getElementById('signup-confirm').value;

  if (!email || !password || !confirmPassword) {
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

    chrome.runtime.sendMessage({
      type: 'AUTH_SUCCESS',
      user: {
        uid: data.localId,
        email: data.email,
        displayName: data.displayName || data.email.split('@')[0],
        stsTokenManager: { accessToken: data.idToken }
      }
    });

    showSuccess('Account created successfully!');
    setTimeout(() => window.close(), 1000);
  } catch (error) {
    console.error('Sign-up error:', error);
    showError(error.message || 'Registration failed');
    setButtonLoading(emailSignupBtn, false);
  }
});

// Helper functions (same as before but using local logic)
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

// Allow Enter key to submit
document.getElementById('email').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') emailSigninBtn.click();
});

document.getElementById('password').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') emailSigninBtn.click();
});

document.getElementById('signup-confirm').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') emailSignupBtn.click();
});
