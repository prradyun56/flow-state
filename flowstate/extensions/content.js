// content.js - FlowState state tracker for scroll and video position

let pageState = {
  scrollY: 0,
  scrollX: 0,
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

// Track scrolling
window.addEventListener('scroll', (e) => {
  // Use the window scroll if it exists, otherwise try to get it from the event target
  let currY = window.scrollY;
  let currX = window.scrollX;
  
  if (currY === 0 && e.target && e.target.scrollTop > 0) {
    currY = e.target.scrollTop;
    currX = e.target.scrollLeft;
  }
  
  // Only update if we actually have a scroll value to avoid resetting to 0 erroneously
  if (currY > 0 || currX > 0) {
    pageState.scrollY = currY;
    pageState.scrollX = currX;
    throttleSync();
  }
}, { passive: true, capture: true });

// --- Native Chrome PDF Viewer Injection ---
// Chrome encapsulates its native PDF reader in a <pdf-viewer> shadow DOM
// We must aggressively hunt for its internal #scroller to track reading
function setupPdfTracking() {
  const viewer = document.querySelector('pdf-viewer');
  if (viewer && viewer.shadowRoot) {
    const scroller = viewer.shadowRoot.querySelector('#scroller');
    if (scroller) {
      scroller.addEventListener('scroll', (e) => {
        if (e.target.scrollTop > 0 || e.target.scrollLeft > 0) {
          pageState.scrollY = e.target.scrollTop;
          pageState.scrollX = e.target.scrollLeft;
          pageState.isNativePdf = true;
          throttleSync();
        }
      }, { passive: true });
    }
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

// Setup tracking when mutations happen to catch dynamically inserted videos or PDFs
const observer = new MutationObserver((mutations) => {
  if (document.querySelector('video')) {
    setupVideoTracking();
  }
  if (document.querySelector('pdf-viewer')) {
    setupPdfTracking();
  }
});
observer.observe(document.body, { childList: true, subtree: true });

// Initial setup
if (document.readyState === 'complete') {
  setupVideoTracking();
  setupPdfTracking();
} else {
  window.addEventListener('load', () => {
    setupVideoTracking();
    setupPdfTracking();
  });
}

// On load, ask background for any restored state to apply
chrome.runtime.sendMessage({ type: 'GET_RESTORED_STATE' }, (response) => {
  if (response && response.state) {
    const { scrollX, scrollY, videoState, isNativePdf } = response.state;
    if (scrollY !== undefined || scrollX !== undefined) {
      // Try normal scroll
      window.scrollTo(scrollX || 0, scrollY || 0);

      // Persistently try to scroll for several seconds
      let scrollAttempts = 0;
      const scrollInterval = setInterval(() => {
        window.scrollTo(scrollX || 0, scrollY || 0);
        
        // Native Chrome PDF viewer injection logic
        if (isNativePdf) {
          const viewer = document.querySelector('pdf-viewer');
          if (viewer && viewer.shadowRoot) {
            const scroller = viewer.shadowRoot.querySelector('#scroller');
            if (scroller) {
              scroller.scrollTop = scrollY;
              scroller.scrollLeft = scrollX;
            }
          }
        }
        
        scrollAttempts++;
        if (scrollAttempts > 15) { // 7.5 seconds
          clearInterval(scrollInterval);
        }
      }, 500);
      
      // Also attach to window load if it hasn't fired yet
      window.addEventListener('load', () => {
        window.scrollTo(scrollX || 0, scrollY || 0);
      });
    }
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
