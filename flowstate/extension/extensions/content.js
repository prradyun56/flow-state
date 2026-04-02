// content.js - FlowState state tracker for video position

let pageState = {
  videoState: null
};

let syncTimer = null;

function throttleSync() {
  if (syncTimer) return;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    sendStateUpdate();
  }, 1000); // sync every 1 second at most
}

function sendStateUpdate() {
  try {
    chrome.runtime.sendMessage({
      type: 'TAB_STATE_UPDATE',
      state: pageState
    }).catch(() => {});
  } catch (e) {
    // Port closed or error sending message
  }
}

// Track video tags
function setupVideoTracking() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return;

  // Track the largest video by default as the main media
  const mainVideo = videos.reduce((prev, current) => {
    return (prev.getBoundingClientRect().width * prev.getBoundingClientRect().height) >
           (current.getBoundingClientRect().width * current.getBoundingClientRect().height) ? prev : current;
  });

  mainVideo.addEventListener('timeupdate', () => {
    pageState.videoState = {
      currentTime: mainVideo.currentTime,
      paused: mainVideo.paused
    };
    throttleSync();
  });

  mainVideo.addEventListener('pause', throttleSync);
  mainVideo.addEventListener('play', throttleSync);
}

// Setup tracking when mutations happen to catch dynamically inserted videos
const observer = new MutationObserver((mutations) => {
  if (document.querySelector('video')) {
    setupVideoTracking();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

// Initial setup
if (document.readyState === 'complete') {
  setupVideoTracking();
} else {
  window.addEventListener('load', () => {
    setupVideoTracking();
  });
}

// On load, ask background for any restored state to apply
chrome.runtime.sendMessage({ type: 'GET_RESTORED_STATE' }, (response) => {
  if (response && response.state) {
    const { videoState } = response.state;
    if (videoState) {
      const waitAndSetVideo = setInterval(() => {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length > 0) {
          clearInterval(waitAndSetVideo);
          const mainVideo = videos.reduce((prev, current) => {
            return (prev.getBoundingClientRect().width * prev.getBoundingClientRect().height) >
                   (current.getBoundingClientRect().width * current.getBoundingClientRect().height) ? prev : current;
          });
          mainVideo.currentTime = videoState.currentTime;
          if (!videoState.paused) {
            mainVideo.play().catch(() => {});
          }
        }
      }, 500);

      // Stop checking after 5 seconds
      setTimeout(() => clearInterval(waitAndSetVideo), 5000);
    }
  }
});

// Send final state before unload
window.addEventListener('beforeunload', () => {
  sendStateUpdate();
});

// Handle on-demand state requests from background (used during session save)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_CURRENT_STATE') {
    sendResponse({ state: pageState });
    return false;
  }
});
