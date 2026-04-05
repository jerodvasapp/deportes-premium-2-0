const userBadge = document.getElementById("userBadge");
const adminLink = document.getElementById("adminLink");

let demoTimerInterval = null;
let isLoadingChannel = false;
let currentHls = null;
let userInteracted = false;
let infoTimeout = null;
let searchTimeout = null;
let iptvBarTimer = null;
let activeChannel = null;
let stalledRefreshTimer = null;
let demoExpired = false;
let serviceExpired = false;
let currentChannelUrl = null;
let miniChannelsHideTimer = null;
let fullscreenControlsHideTimer = null;

function showFullscreenControls() {
  if (!document.body.classList.contains("fullscreen-active")) return;

  document.body.classList.add("show-fullscreen-controls");

  clearTimeout(fullscreenControlsHideTimer);
  fullscreenControlsHideTimer = setTimeout(() => {
    document.body.classList.remove("show-fullscreen-controls");
  }, 2500);
}

function hideFullscreenControls() {
  clearTimeout(fullscreenControlsHideTimer);
  document.body.classList.remove("show-fullscreen-controls");
}

const video = document.getElementById("streamVideo");
if (video) {
  video.preload = "metadata";
  video.controls = false;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("x5-playsinline", "");
}

const leftContainer = document.getElementById("categoriaContainer");
const rightContainer = document.getElementById("categoriaContainerDerecha");
const searchInput = document.getElementById("searchInput");
const channelInfo = document.getElementById("channelInfo");
const currentChannelName = document.getElementById("currentChannelName");
const currentChannelCategory = document.getElementById("currentChannelCategory");
const iptvBottomBar = document.getElementById("iptvBottomBar");
const iptvChannelName = document.getElementById("iptvChannelName");
const iptvChannelCategory = document.getElementById("iptvChannelCategory");
const iptvStatus = document.getElementById("iptvStatus");
const iptvClock = document.getElementById("iptvClock");
const streamContainer = document.getElementById("streamContainer");
const fullscreenMiniChannelsList = document.getElementById("fullscreenMiniChannelsList");
const fullscreenChannelTitle = document.getElementById("fullscreenChannelTitle");
const topButtons = document.querySelector(".top-buttons");

let channelsToggleBtn = null;
let prevChannelBtn = null;
let nextChannelBtn = null;
let refreshBtn = null;
let soundBtn = null;
let fullscreenBtn = null;

if (topButtons) {
  topButtons.innerHTML = `
    <button id="channelsToggleBtn" type="button">Canales</button>
    <button id="prevChannelBtn" type="button">Anterior</button>
    <button id="nextChannelBtn" type="button">Siguiente</button>
    <button id="refreshBtn" type="button">Recargar</button>
    <button id="soundBtn" type="button">Audio off</button>
    <button id="fullscreenBtn" type="button">Pantalla completa</button>
  `;

  channelsToggleBtn = document.getElementById("channelsToggleBtn");
  prevChannelBtn = document.getElementById("prevChannelBtn");
  nextChannelBtn = document.getElementById("nextChannelBtn");
  refreshBtn = document.getElementById("refreshBtn");
  soundBtn = document.getElementById("soundBtn");
  fullscreenBtn = document.getElementById("fullscreenBtn");
}

async function checkSession() {
  try {
    const response = await fetch("/api/session");

    if (!response.ok) {
      window.location.href = "/login.html";
      return;
    }

    const data = await response.json();

    if (!data.loggedIn) {
      window.location.href = "/login.html";
      return;
    }

    if (userBadge) {
      userBadge.textContent = "Usuario: " + data.user.username;
    }

    if (adminLink) {
      adminLink.hidden = !(data.user && data.user.role === "admin");
    }

    const popup = document.getElementById("diasRestantesPopup");
    const texto = document.getElementById("diasRestantesTexto");
    const demoTimer = document.getElementById("demoTimer");
    const cerrar = document.getElementById("cerrarPopup");
    const demoBadge = document.getElementById("demoBadge");

    if (demoTimer) {
      demoTimer.textContent = "";
    }

    if (data.user.expires_at && popup && texto && demoTimer && demoBadge) {
      const expires = new Date(data.user.expires_at);

      texto.textContent = "Tiempo restante del demo:";
      popup.hidden = false;
      demoBadge.hidden = false;

      if (demoTimerInterval) {
        clearInterval(demoTimerInterval);
      }

      const updateDemoTimer = () => {
        const now = new Date();
        const diff = expires - now;

        if (diff <= 0) {
          demoExpired = true;

          demoTimer.textContent = "Demo finalizado";
          demoBadge.textContent = "Demo finalizado";
          demoBadge.className = "demo-badge demo-danger";

          destroyCurrentHls();

          if (video) {
            video.pause();
            video.removeAttribute("src");
            video.load();
            video.controls = false;
          }

          document.querySelectorAll(".canales button").forEach((btn) => {
            btn.disabled = true;
          });

          texto.textContent = "❌ Tu demo ha finalizado. Contacta a tu vendedor.";
          popup.hidden = false;

          if (demoTimerInterval) {
            clearInterval(demoTimerInterval);
            demoTimerInterval = null;
          }

          return;
        }

        const totalSeconds = Math.floor(diff / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        demoTimer.textContent = `${minutes}m ${seconds}s`;
        demoBadge.textContent = `Demo: ${minutes}m ${String(seconds).padStart(2, "0")}s`;

        if (minutes < 5) {
          demoBadge.className = "demo-badge demo-danger";
        } else if (minutes < 10) {
          demoBadge.className = "demo-badge demo-warning";
        } else {
          demoBadge.className = "demo-badge";
        }
      };

      updateDemoTimer();
      demoTimerInterval = setInterval(updateDemoTimer, 1000);
    }

    if (data.user.end_date && popup && texto && !data.user.expires_at) {
      const hoy = new Date();
      const fin = new Date(data.user.end_date);
      const dias = Math.ceil((fin - hoy) / (1000 * 60 * 60 * 24));

      if (dias === 1) {
        texto.textContent = "⚠️ Tu servicio vence mañana. Contacta a tu vendedor.";
        popup.hidden = false;
      }

      if (dias <= 0) {
        serviceExpired = true;

        texto.textContent = "❌ Tu servicio está vencido. Contacta a tu vendedor.";
        popup.hidden = false;

        destroyCurrentHls();

        if (video) {
          video.pause();
          video.removeAttribute("src");
          video.load();
          video.controls = false;
        }

        document.querySelectorAll(".canales button").forEach((btn) => {
          btn.disabled = true;
        });
      }
    }

    if (cerrar && popup) {
      cerrar.onclick = async () => {
        popup.hidden = true;

        if (demoExpired || serviceExpired) {
          try {
            await fetch("/logout", { method: "POST" });
          } catch (e) {}

          window.location.href = "/login.html";
        }
      };
    }
  } catch (error) {
    window.location.href = "/login.html";
  }
}

checkSession();

function proxifyChannelUrl(url, type) {
  if (!url || typeof url !== "string") return url;

  const lowerUrl = url.toLowerCase();
  const isHls = type === "hls" || lowerUrl.includes(".m3u8");
  const mustProxy = lowerUrl.includes("167.17.67.240");

  if (!mustProxy) {
    return url;
  }

  if (isHls) {
    return "/proxy/hls?url=" + encodeURIComponent(url);
  }

  return "/proxy/file?url=" + encodeURIComponent(url);
}

const CHANNELS = [
  { name: "ESPN 1", category: "deportes espn", url: "http://167.17.67.240:8888/Espn1/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "ESPN 2", category: "deportes espn", url: "http://167.17.67.240:8888/Espn2/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "ESPN 3", category: "deportes espn", url: "http://167.17.67.240:8888/Espn3/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "ESPN 4", category: "deportes espn", url: "http://167.17.67.240:8888/Espn4/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "ESPN 5", category: "deportes espn", url: "http://167.17.67.240:8888/Espn5/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "ESPN 6", category: "deportes espn", url: "http://167.17.67.240:8888/Espn6/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "ESPN 7", category: "deportes espn", url: "http://167.17.67.240:8888/Espn7/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Win Sports", category: "Win Sport", url: "http://167.17.67.240:8888/WINSPORTSHDECUA/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Win Sports +", category: "Win Sport", url: "http://167.17.67.240:8888/WINMASHDECUADOR/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Dsports", category: "Dgo", url: "http://167.17.67.240:8888/Dsportsmas/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Dsports+", category: "Dgo", url: "http://167.17.67.240:8888/DSPORTS/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Dsports2", category: "Dgo", url: "http://167.17.67.240:8888/dsport2colombia/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Fox Sports", category: "Fox Sports", url: "http://167.17.67.240:8888/Foxdeportes/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Fox Sports 2", category: "Fox Sports", url: "http://167.17.67.240:8888/FOXSPORTS/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Fox Sports 3", category: "Fox Sports", url: "http://167.17.67.240:8888/FOXSPORTS3/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Fox Sports 4 ", category: "Fox Sports", url: "http://167.17.67.240:8888/foxsportsdiablo/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Fox Sports 5", category: "Fox Sports", url: "http://167.17.67.240:8888/foxone1/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Fox Sports 6", category: "Fox Sports", url: "http://167.17.67.240:8888/FOXSPORTSTUBI/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Win sd", category: "Win Sport", url: "http://167.17.67.240:8888/winmassddany/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Win + 4K", category: "Win Sport", url: "http://167.17.67.240:8888/winmas4k/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Dazn 1", category: "Dazn", url: "http://167.17.67.240:8888/dazn1/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Dazn 2", category: "Dazn", url: "http://167.17.67.240:8888/DAZNFL/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Dazn la liga", category: "Dazn", url: "http://167.17.67.240:8888/DAZN4/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Tigo Sports", category: "Tigo Sports", url: "http://167.17.67.240:8888/Tigosports/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "TNT Sports Premium", category: "TNT Sports", url: "http://167.17.67.240:8888/tntsports/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Movistar", category: "Movistar", url: "http://167.17.67.240:8888/MovistarVAMOS/tracks-v1a1/mono.m3u", type: "hls" },
  { name: "Movistar1", category: "Movistar", url: "http://167.17.67.240:8888/ligacampeones/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Bein Sports", category: "Bein", url: "http://167.17.67.240:8888/beinsports/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "TyC Sports", category: "TyC Sports", url: "http://167.17.67.240:8888/TyCSposrts/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "L1 Max", category: "L1max", url: "http://167.17.67.240:8888/La1/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "ECDF", category: "ECDF", url: "http://167.17.67.240:8888/ecdfecuador/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Otros", category: "Otros", url: "https://d63fabad.wurl.com/manifest/f36d25e7e52f1ba8d7e56eb859c636563214f541/UmFrdXRlblRWLWVzX0ZJRkFQbHVzU3BhbmlzaF9ITFM/ce61c15a-ca22-4d3f-9485-4ae94418925d/3.m3u8", type: "hls" },
  { name: "FTV HD", category: "FTV", url: "https://master.tucableip.com/ftvhd/tracks-v1a1/mono.ts.m3u8", type: "hls" },
  { name: "Sky sports", category: "Sky", url: "http://167.17.67.240:8888/SKYBUNDESLIGA/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Caracol", category: "Nacionales", url: "http://167.17.67.240:8888/caracilfulhd/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Caracol SD", category: "Nacionales", url: "http://167.17.67.240:8888/CARACOLSD/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "RCN", category: "Nacionales", url: "http://167.17.67.240:8888/Rcn/tracks-v1a1/mono.m3u8", type: "hls" },
  { name: "Tv azteca deportes", category: "Tv Azteca", url: "https://deportes.ksdjugfsddeports.com:9092/MTg2LjExMy4xNTEuMTM2/34_.m3u8?token=w7rGPyniwmmzAKyKCVKOYw&expires=1775371207", type: "hls"}
];

const CHANNELS_PROXIED = CHANNELS.map((channel) => ({
  ...channel,
  url: proxifyChannelUrl(channel.url, channel.type)
}));

const CHANNEL_COLORS = [
  { match: "tv Azteca", color: "linear-gradient(135deg,  #008f5a, #b0c400)" },
  { match: "espn", color: "linear-gradient(135deg, #d90429, #ff4d6d)" },
  { match: "fox", color: "linear-gradient(135deg, #0038a8, #3a86ff)" },
  { match: "tnt", color: "linear-gradient(135deg, #6601b962, #f703ff)" },
  { match: "dazn", color: "linear-gradient(135deg, #807d7d, #111111)" },
  { match: "win", color: "linear-gradient(135deg, #ff6803, #386b72)" },
  { match: "tudn", color: "linear-gradient(135deg, #008f5a, #00c46a)" },
  { match: "sky", color: "linear-gradient(135deg, #0057b8, #00a8ff)" },
  { match: "bein", color: "linear-gradient(135deg, #5a189a, #9d4edd)" },
  { match: "dsports", color: "linear-gradient(135deg, #1b4fd6, #4ea8ff)" },
  { match: "directv", color: "linear-gradient(135deg, #1b4fd6, #4ea8ff)" },
  { match: "ecdf", color: "linear-gradient(135deg, #d90429, #ff4d6d)" },
  { match: "ftv", color: "linear-gradient(135deg, #d90429, #ff4d6d)" },
  { match: "l1", color: "linear-gradient(135deg, #d90429, #ff4d6e57)" },
  { match: "movistar", color: "linear-gradient(135deg, #84c5fa, #00a8ff)" },
  { match: "caracol", color: "linear-gradient(135deg, #585be9, #234a5e)" },
  { match: "tigo", color: "linear-gradient(135deg, #1b1ee7, #e7eb13)" },
  { match: "tyc", color: "linear-gradient(135deg, #010497, #fafaf8)" }
];

const CHANNEL_LOGOS = [
  { match: "tv Azteca", file: "/img/tvazteca.png", alt: "Tv Azteca" },
  { match: "espn", file: "img/espn.png", alt: "ESPN" },
  { match: "fox sports", file: "img/fox-sports.png", alt: "FOX Sports" },
  { match: "tnt sports", file: "img/tnt.png", alt: "TNT Sports" },
  { match: "dazn", file: "img/dazn.png", alt: "DAZN" },
  { match: "win", file: "img/win-sports.png", alt: "Win Sports" },
  { match: "tudn", file: "img/tudn.png", alt: "TUDN" },
  { match: "directv", file: "img/directv-sports.png", alt: "DirecTV Sports" },
  { match: "dsports", file: "img/directv-sports.png", alt: "DirecTV Sports" },
  { match: "bein", file: "img/bein-sports.png", alt: "beIN Sports" },
  { match: "sky", file: "img/sky.png", alt: "Sky Sports" },
  { match: "ecdf", file: "img/ecdf.jpg", alt: "ecdf" },
  { match: "ftv", file: "img/ftv.png", alt: "ftv" },
  { match: "l1 max", file: "img/l1max.png", alt: "L1 MAX" },
  { match: "movistar", file: "img/movistartv.png", alt: "Movistar" },
  { match: "caracol", file: "img/caracol.png", alt: "Caracol" },
  { match: "rcn", file: "img/rcn.png", alt: "rcn" },
  { match: "tigo", file: "img/tigo.png", alt: "tigo" },
  { match: "tyc", file: "img/tyc.png", alt: "tyc" }
];

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function getChannelColor(name) {
  const lower = name.toLowerCase();

  for (const c of CHANNEL_COLORS) {
    if (lower.includes(c.match)) {
      return c.color;
    }
  }

  return "linear-gradient(135deg, #00c2ff, #355cff)";
}

function getChannelLogo(channelName) {
  const name = channelName.toLowerCase();

  for (const logo of CHANNEL_LOGOS) {
    if (name.includes(logo.match)) {
      return logo;
    }
  }

  return null;
}

function showIptvBar() {
  if (!iptvBottomBar) return;

  // 🔥 SOLO ocultar en fullscreen
  if (!document.body.classList.contains("fullscreen-active")) {
    iptvBottomBar.classList.remove("iptv-hidden");
    return;
  }

  iptvBottomBar.classList.remove("iptv-hidden");

  clearTimeout(iptvBarTimer);

  iptvBarTimer = setTimeout(() => {
    hideIptvBar();
  }, 3000);
}

function hideIptvBar() {
  if (!iptvBottomBar) return;
  iptvBottomBar.classList.add("iptv-hidden");
}

function setIptvStatus(text, className = "") {
  if (!iptvStatus) return;

  iptvStatus.textContent = text;
  iptvStatus.className = "iptv-badge";

  if (className) {
    iptvStatus.classList.add(className);
  }
}

function updateIptvInfo(name, category) {
  if (iptvChannelName) {
    iptvChannelName.textContent = name || "Sin canal seleccionado";
  }

  if (iptvChannelCategory) {
    iptvChannelCategory.textContent = category || "Categoría";
  }
}

function updateChannelInfo(name, category) {
  if (currentChannelName) {
    currentChannelName.textContent = name;
  }

  if (currentChannelCategory) {
    currentChannelCategory.textContent = capitalize(category);
  }

  if (channelInfo) {
    channelInfo.style.display = "block";
  }

  if (fullscreenChannelTitle) {
    fullscreenChannelTitle.textContent = name;
  }

  updateIptvInfo(name, capitalize(category));
  setIptvStatus("EN VIVO", "iptv-status-live");

  clearTimeout(infoTimeout);
  infoTimeout = setTimeout(() => {
    if (channelInfo) {
      channelInfo.style.display = "none";
    }
  }, 4000);
}

function showLoadingIndicator() {
  hideLoadingIndicator();

  if (!streamContainer) return;

  const loader = document.createElement("div");
  loader.className = "loading-indicator";
  loader.innerHTML = '<div class="spinner"></div><p>Cargando transmisión...</p>';

  streamContainer.appendChild(loader);
}

function hideLoadingIndicator() {
  const loader = document.querySelector(".loading-indicator");
  if (loader) loader.remove();
}

function destroyCurrentHls() {
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }

  currentChannelUrl = null;

  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

function setPlayerMeta(channel) {
  updateIptvInfo(channel.name, capitalize(channel.category));
  setIptvStatus("CARGANDO", "iptv-status-buffer");
}

function setActiveChannel(button) {
  document.querySelectorAll(".canales button").forEach((btn) => btn.classList.remove("active"));
  button.classList.add("active");
  button.focus();
}

function markMiniChannelActive(channelName) {
  if (!fullscreenMiniChannelsList) return;

  fullscreenMiniChannelsList.querySelectorAll(".fullscreen-mini-channel-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.channelName === channelName);
  });
}

function getCurrentChannelIndex() {
  if (!activeChannel) return -1;
  return CHANNELS_PROXIED.findIndex((c) => c.name === activeChannel.name);
}

function loadPreviousChannel() {
  const currentIndex = getCurrentChannelIndex();
  if (currentIndex <= 0) return;

  const previousChannel = CHANNELS_PROXIED[currentIndex - 1];
  if (previousChannel) {
    loadStream(previousChannel);
  }
}

function loadNextChannel() {
  const currentIndex = getCurrentChannelIndex();
  if (currentIndex < 0 || currentIndex >= CHANNELS_PROXIED.length - 1) return;

  const nextChannel = CHANNELS_PROXIED[currentIndex + 1];
  if (nextChannel) {
    loadStream(nextChannel);
  }
}

function attachNativeVideo(channel) {
  if (!video) return;

  video.src = channel.url;
  video.load();

  const onCanPlay = () => {
    video.removeEventListener("canplay", onCanPlay);
    hideLoadingIndicator();
    video.play().catch(() => {});
  };

  video.addEventListener("canplay", onCanPlay);
}

function showMiniChannels() {
  if (!document.body.classList.contains("fullscreen-active")) return;
  document.body.classList.add("show-mini-channels");
}

function hideMiniChannels() {
  document.body.classList.remove("show-mini-channels");
}


function updateSoundButtonLabel() {
  if (!soundBtn || !video) return;

  if (!activeChannel || !currentChannelUrl || !video.src) {
    soundBtn.textContent = "Audio off";
    return;
  }

  soundBtn.textContent = video.muted ? "Audio off" : "Audio on";
}

function updateFullscreenButtonLabel() {
  if (!fullscreenBtn) return;
  fullscreenBtn.textContent = document.fullscreenElement
    ? "Salir full"
    : "Pantalla completa";
}

async function loadStream(channel) {
  if (!video) return;
  if (demoExpired || serviceExpired) return;
  if (isLoadingChannel) return;
  if (currentChannelUrl === channel.url) return;

  isLoadingChannel = true;

  try {
    activeChannel = channel;

    if (stalledRefreshTimer) {
      clearTimeout(stalledRefreshTimer);
      stalledRefreshTimer = null;
    }

    showLoadingIndicator();
    destroyCurrentHls();
    currentChannelUrl = channel.url;

    video.pause();
    video.muted = !userInteracted;

    setPlayerMeta(channel);
    updateChannelInfo(channel.name, channel.category);
    markMiniChannelActive(channel.name);
    updateSoundButtonLabel();

    const isHls = channel.type === "hls" || channel.url.toLowerCase().includes(".m3u8");

    if (isHls) {
      if (window.Hls && Hls.isSupported()) {
        currentHls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 20,
          maxBufferLength: 15,
          maxMaxBufferLength: 30,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 5,
          fragLoadingTimeOut: 15000,
          manifestLoadingTimeOut: 10000,
          levelLoadingTimeOut: 10000,
          fragLoadingRetryDelay: 1500,
          manifestLoadingRetryDelay: 1500,
          levelLoadingRetryDelay: 1500
        });

        currentHls.loadSource(channel.url);
        currentHls.attachMedia(video);

        currentHls.on(Hls.Events.MANIFEST_PARSED, () => {
          hideLoadingIndicator();
          video.play().catch(() => {});
        });

        currentHls.on(Hls.Events.ERROR, (event, data) => {
          if (!data.fatal) return;

          hideLoadingIndicator();
          setIptvStatus("ERROR", "iptv-status-error");

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              currentHls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              currentHls.recoverMediaError();
              break;
            default:
              destroyCurrentHls();
              alert("No se pudo cargar el stream HLS. Revisa la URL del canal.");
          }
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        attachNativeVideo(channel);
      } else {
        hideLoadingIndicator();
        alert("Este navegador no soporta HLS.");
      }
    } else {
      attachNativeVideo(channel);
    }
  } finally {
    isLoadingChannel = false;
  }
}

if (video) {
  video.addEventListener("waiting", () => {
    setIptvStatus("BUFFER", "iptv-status-buffer");
    showLoadingIndicator();
  });

  video.addEventListener("playing", () => {
    setIptvStatus("EN VIVO", "iptv-status-live");
    hideLoadingIndicator();
  });

  video.addEventListener("pause", () => {
    if (!video.ended && video.currentTime > 0) {
      setIptvStatus("PAUSA", "iptv-status-pause");
    }
  });

  video.addEventListener("ended", () => {
    setIptvStatus("FIN", "iptv-status-pause");
  });

  video.addEventListener("volumechange", updateSoundButtonLabel);
  video.addEventListener("loadedmetadata", updateSoundButtonLabel);

  video.addEventListener("error", () => {
    setIptvStatus("ERROR", "iptv-status-error");
    hideLoadingIndicator();

    if (activeChannel) {
      setTimeout(() => {
        destroyCurrentHls();
        if (video) {
          video.pause();
          video.removeAttribute("src");
          video.load();
        }
        loadStream(activeChannel);
      }, 2000);
    }
  });
}

if (video) {
  video.addEventListener("webkitbeginfullscreen", () => {
    document.body.classList.remove("fullscreen-active");
    hideMiniChannels();
    hideFullscreenControls();
  });

  video.addEventListener("webkitendfullscreen", () => {
    document.body.classList.remove("fullscreen-active");
    hideMiniChannels();
    hideFullscreenControls();
    updateFullscreenButtonLabel();
  });
}

function groupChannels(channels) {
  return channels.reduce((acc, channel) => {
    const category = (channel.category || "otros").toLowerCase();

    if (!acc[category]) {
      acc[category] = [];
    }

    acc[category].push(channel);
    return acc;
  }, {});
}

function renderGroupedChannels(channels) {
  if (!leftContainer || !rightContainer) return;

  leftContainer.innerHTML = "";
  rightContainer.innerHTML = "";

  const grouped = groupChannels(channels);
  const categories = Object.keys(grouped).sort((a, b) => a.localeCompare(b));

  if (!categories.length) {
    leftContainer.innerHTML = '<div class="empty-state">No se encontraron canales.</div>';
    rightContainer.innerHTML = "";
    return;
  }

  categories.forEach((category) => {
    const section = document.createElement("div");
    section.className = "categoria";

    const header = document.createElement("h3");
    header.textContent = "⚽ " + capitalize(category);
    header.tabIndex = 0;
    header.setAttribute("role", "button");
    header.setAttribute("aria-expanded", "false");

    const content = document.createElement("div");
    content.className = "canales";

    const toggle = () => {
      const allContents = document.querySelectorAll(".canales");
      const allHeaders = document.querySelectorAll(".categoria h3");
      const willOpen = !content.classList.contains("show");

      allContents.forEach((item) => item.classList.remove("show"));
      allHeaders.forEach((item) => item.setAttribute("aria-expanded", "false"));

      if (willOpen) {
        content.classList.add("show");
        header.setAttribute("aria-expanded", "true");
      }
    };

    function ensureIptvVisible() {
      if (!iptvBottomBar) return;

      if (!document.body.classList.contains("fullscreen-active")) {
        iptvBottomBar.classList.remove("iptv-hidden");
      }
    }

    header.addEventListener("click", toggle);
    header.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });

    grouped[category].forEach((channel) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.channel = channel.name;
      button.tabIndex = 0;
      button.style.background = getChannelColor(channel.name);

      const logo = getChannelLogo(channel.name);

      if (logo) {
        button.innerHTML = `
          <span class="channel-btn-content">
            <img src="${logo.file}" alt="${logo.alt}" class="channel-logo">
            <span class="channel-label">${channel.name}</span>
          </span>
        `;
      } else {
        button.innerHTML = `
          <span class="channel-btn-content">
            <span class="channel-label">${channel.name}</span>
          </span>
        `;
      }

      button.addEventListener("click", () => {
        setActiveChannel(button);
        loadStream(channel);

        if (window.innerWidth <= 900) {
          document.body.classList.remove("mobile-channels-open");
        }
      });

      content.appendChild(button);
    });

    section.appendChild(header);
    section.appendChild(content);
    leftContainer.appendChild(section);
  });

  rightContainer.innerHTML = "";
}

if (searchInput) {
  searchInput.addEventListener("input", (event) => {
    clearTimeout(searchTimeout);

    searchTimeout = setTimeout(() => {
      const term = event.target.value.trim().toLowerCase();

      if (!term) {
        renderGroupedChannels(CHANNELS_PROXIED);
        return;
      }

      const filtered = CHANNELS_PROXIED.filter((channel) => {
        return (
          channel.name.toLowerCase().includes(term) ||
          channel.category.toLowerCase().includes(term)
        );
      });

      renderGroupedChannels(filtered);
    }, 180);
  });
}

async function toggleFullscreen() {
  if (!fullscreenBtn || !video) return;
  if (!activeChannel || !currentChannelUrl) return;

  const isIPhone = /iPhone/i.test(navigator.userAgent);

  try {
    // iPhone: usar fullscreen nativo del video
    if (isIPhone) {
      const enterNativeFs =
        video.webkitEnterFullscreen ||
        video.webkitEnterFullScreen;

      if (typeof enterNativeFs === "function") {
        // Asegura que el video esté intentando reproducirse
        try {
          await video.play();
        } catch (_) {}

        enterNativeFs.call(video);
        return;
      }

      // Si no existe API nativa, no forzar nada raro
      console.warn("Este iPhone no permite fullscreen nativo desde el video.");
      return;
    }

    // Resto de dispositivos: tu fullscreen web normal
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
      document.body.classList.add("fullscreen-active");
      hideMiniChannels();
      showFullscreenControls();
    } else {
      await document.exitFullscreen();
    }
  } catch (error) {
    console.warn("No se pudo cambiar pantalla completa:", error);
  }

  updateFullscreenButtonLabel();
}


document.addEventListener("fullscreenchange", () => {
  const isFullscreen = !!document.fullscreenElement;

  document.body.classList.toggle("fullscreen-active", isFullscreen);

  if (!isFullscreen) {
    hideMiniChannels();
    hideFullscreenControls();
  } else {
    showFullscreenControls();
  }

  updateFullscreenButtonLabel();
});

if (fullscreenBtn) {
  fullscreenBtn.addEventListener("click", toggleFullscreen);
}


if (soundBtn && video) {
  soundBtn.addEventListener("click", () => {
    if (demoExpired || serviceExpired) return;
    if (!activeChannel || !currentChannelUrl) return;

    userInteracted = true;
    video.muted = !video.muted;

    if (!video.muted && video.volume === 0) {
      video.volume = 1;
    }

    video.play().catch(() => {});
    updateSoundButtonLabel();
  });
}

if (refreshBtn && video) {
  refreshBtn.addEventListener("click", () => {
    if (!activeChannel) return;

    destroyCurrentHls();
    video.pause();
    video.removeAttribute("src");
    video.load();
    loadStream(activeChannel);
  });
}

if (channelsToggleBtn) {
  channelsToggleBtn.addEventListener("click", () => {
    if (document.body.classList.contains("fullscreen-active")) {
      if (document.body.classList.contains("show-mini-channels")) {
        hideMiniChannels();
      } else {
        showMiniChannels();
      }
      return;
    }

    if (window.innerWidth <= 900) {
      document.body.classList.toggle("mobile-channels-open");
    }
  });
}

if (prevChannelBtn) {
  prevChannelBtn.addEventListener("click", () => {
    loadPreviousChannel();
  });
}

if (nextChannelBtn) {
  nextChannelBtn.addEventListener("click", () => {
    loadNextChannel();
  });
}

function handleFirstInteraction() {
  if (demoExpired || serviceExpired || userInteracted || !video) return;

  userInteracted = true;

  // No hacer nada si todavía no hay canal cargado
  if (!activeChannel || !currentChannelUrl || !video.src) {
    video.muted = true;
    updateSoundButtonLabel();
    return;
  }

  video.muted = false;
  video.play().catch(() => {});
  updateSoundButtonLabel();
}

document.body.addEventListener("click", handleFirstInteraction, { once: true });
document.body.addEventListener("touchend", handleFirstInteraction, { once: true });

function startClock() {
  if (!iptvClock) return;

  const update = () => {
    const now = new Date();
    const time = now.toLocaleTimeString("es-CO", {
      hour: "2-digit",
      minute: "2-digit"
    });
    iptvClock.textContent = time;
  };

  update();
  setInterval(update, 1000);
}

startClock();

function renderFullscreenMiniChannels() {
  if (!fullscreenMiniChannelsList) return;

  fullscreenMiniChannelsList.innerHTML = CHANNELS_PROXIED.map((channel) => `
    <button class="fullscreen-mini-channel-btn" data-channel-name="${channel.name}">
      ${channel.name}
    </button>
  `).join("");

  fullscreenMiniChannelsList.querySelectorAll(".fullscreen-mini-channel-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const channel = CHANNELS_PROXIED.find((c) => c.name === btn.dataset.channelName);
      if (!channel) return;

      loadStream(channel);
      markMiniChannelActive(channel.name);
      hideMiniChannels();
    });
  });

}

renderFullscreenMiniChannels();
renderGroupedChannels(CHANNELS_PROXIED);
updateSoundButtonLabel();
updateFullscreenButtonLabel();

window.addEventListener("resize", () => {
  if (window.innerWidth > 900) {
    document.body.classList.remove("mobile-channels-open");
  }
});

if (streamContainer) {
  streamContainer.addEventListener("mousemove", () => {
    if (document.body.classList.contains("fullscreen-active")) {
      showFullscreenControls();
    }
  });

  streamContainer.addEventListener("click", () => {
    if (document.body.classList.contains("fullscreen-active")) {
      showFullscreenControls();
    }
  });

  streamContainer.addEventListener("touchstart", () => {
    if (document.body.classList.contains("fullscreen-active")) {
      showFullscreenControls();
    }
  }, { passive: true });

  streamContainer.addEventListener("touchend", () => {
    if (document.body.classList.contains("fullscreen-active")) {
      showFullscreenControls();
    }
  }, { passive: true });


}