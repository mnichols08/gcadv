(function () {
  const root = document.documentElement;
  if (document.getElementById("workspace")) document.getElementById("workspace").id = "adventure-map";
  document.querySelectorAll('.skip-link[href="#workspace"]').forEach((link) => link.setAttribute("href", "#adventure-map"));
  const oldExplorerHeading = document.querySelector("#explore-panel > h1");
  if (oldExplorerHeading) {
    const heading = document.createElement("h2");
    heading.innerHTML = oldExplorerHeading.innerHTML;
    oldExplorerHeading.replaceWith(heading);
  }
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const themeColor = document.querySelector('meta[name="theme-color"]');
  function updateThemeColor() {
    themeColor?.setAttribute("content", prefersDark.matches ? "#171d19" : "#f3f1e8");
  }
  updateThemeColor();
  prefersDark.addEventListener("change", updateThemeColor);

  const homeHero = document.querySelector(".home-hero");
  const homeNav = document.querySelector(".home-page .site-header");
  if (homeHero && homeNav) {
    let navThreshold = 0;
    const updateHomeNav = () => {
      const fixed = window.scrollY >= navThreshold;
      homeNav.classList.toggle("is-fixed", fixed);
      homeNav.style.top = fixed ? "0px" : `${navThreshold}px`;
    };
    const measureNav = () => {
      navThreshold = homeHero.offsetTop + homeHero.offsetHeight - homeNav.offsetHeight;
      updateHomeNav();
    };
    measureNav();
    window.addEventListener("scroll", updateHomeNav, { passive: true });
    window.addEventListener("resize", measureNav);
  }

  if (homeHero && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    let frame = 0;
    const updateHeroDepth = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const bounds = homeHero.getBoundingClientRect();
        const progress = Math.max(-80, Math.min(300, -bounds.top));
        homeHero.style.setProperty("--hero-image-y", `${progress * 0.35}px`);
        homeHero.style.setProperty("--hero-watermark-y", `${progress * 0.17}px`);
        homeHero.style.setProperty("--hero-copy-y", `${progress * 0.06}px`);
      });
    };
    updateHeroDepth();
    window.addEventListener("scroll", updateHeroDepth, { passive: true });
    window.addEventListener("resize", updateHeroDepth);
  }

  const installCard = document.getElementById("install-prompt");
  const installButton = document.getElementById("install-app");
  const installStatus = document.getElementById("install-status");
  const installHelp = installCard?.querySelector(".install-help");
  const offlineReadiness = document.getElementById("offline-readiness");
  const displayMode = window.matchMedia("(display-mode: standalone)");
  let installPrompt = null;

  function sayInstallStatus(message) {
    if (installStatus) installStatus.textContent = message;
  }

  function explainManualInstall() {
    if (installHelp instanceof HTMLDetailsElement) installHelp.open = true;
    const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
    const isWindows = /Windows/.test(navigator.userAgent);
    const message = isMac
      ? "Your browser has not opened an install prompt. In Safari, choose File > Add to Dock; in Chrome or Edge, use the Install app option in the address bar or menu."
      : isWindows
        ? "Your browser has not opened an install prompt. In Chrome or Edge, use the Install app icon in the address bar or choose Install Garrett County Adventures from the browser menu."
        : "Your browser has not opened an install prompt. Open the browser menu and choose Install app or Add to Home Screen.";
    sayInstallStatus(message);
  }

  if (displayMode.matches || navigator.standalone === true) {
    installCard?.classList.add("is-installed");
    if (installButton) installButton.hidden = true;
    sayInstallStatus("You’re using the installed app.");
  }

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    if (installButton) installButton.hidden = false;
  });

  installButton?.addEventListener("click", async () => {
    if (!installPrompt) {
      explainManualInstall();
      return;
    }
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") {
        sayInstallStatus("Thanks for installing Garrett County Adventures.");
        if (installButton) installButton.hidden = true;
      } else {
        sayInstallStatus("No problem. You can install it later from your browser menu.");
      }
    } catch {
      sayInstallStatus("Use your browser menu to install Garrett County Adventures.");
    } finally {
      installPrompt = null;
    }
  });

  window.addEventListener("appinstalled", () => {
    installCard?.classList.add("is-installed");
    if (installButton) installButton.hidden = true;
    sayInstallStatus("You’re using the installed app.");
  });

  const localDevelopment = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  if (localDevelopment && "serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      if (!registrations.length) return;
      return Promise.all([
        ...registrations.map((registration) => registration.unregister()),
        caches.keys().then((names) => Promise.all(names
          .filter((name) => name.startsWith("chingu-adventures-") || name.startsWith("chingu-mapbox-"))
          .map((name) => caches.delete(name)))),
      ]).then(() => location.reload());
    }).catch(() => {});
    return;
  }

  if (!("serviceWorker" in navigator)) {
    const message = "This browser can’t cache pages for offline use.";
    sayInstallStatus(message);
    if (offlineReadiness) offlineReadiness.textContent = message;
    return;
  }

  navigator.serviceWorker.register("./service-worker.js").then((registration) => {
    const ready = "Guides and saved trail details are available offline after setup. The map tiles need an internet connection.";
    if (registration.waiting && offlineReadiness) {
      offlineReadiness.textContent = "An update is ready. Close app tabs and reopen to use it.";
    } else if (registration.active && offlineReadiness) {
      offlineReadiness.textContent = ready;
    } else if (offlineReadiness) {
      offlineReadiness.textContent = "Preparing guide pages and the app shell for offline use...";
      registration.installing?.addEventListener("statechange", (event) => {
        const worker = event.currentTarget;
        if (worker.state === "activated") offlineReadiness.textContent = ready;
        if (worker.state === "redundant") offlineReadiness.textContent = "Offline setup failed. Reload while online to retry.";
      });
    }
    registration.addEventListener("updatefound", () => {
      registration.installing?.addEventListener("statechange", (event) => {
        const worker = event.currentTarget;
        if (worker.state === "installed" && navigator.serviceWorker.controller && offlineReadiness) {
          offlineReadiness.textContent = "An update is ready. Close app tabs and reopen to use it.";
        }
      });
    });
  }).catch(() => {
    const message = "Offline setup is unavailable right now. Visit once more while online to try again.";
    sayInstallStatus(message);
    if (offlineReadiness) offlineReadiness.textContent = message;
  });
})();
