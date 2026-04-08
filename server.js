const express = require("express");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const helmet = require("helmet");
const path = require("path");
const { Readable } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || "/app/data/database.db";

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
});

// =========================
// Configuración general
// =========================

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set("trust proxy", 1);

app.use(
  session({
    name: "deportes_premium_2_0_sid",
    secret: process.env.SESSION_SECRET || "cambia-esto-por-una-clave-larga-y-segura",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,
      httpOnly: true,
      sameSite: "none",
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

// Evitar caché en login y admin
app.use((req, res, next) => {
  if (
    req.path === "/login.html" ||
    req.path === "/admin.html" ||
    req.path === "/admin-channels.html"
  ) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// =========================
// Base de datos
// =========================

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      start_date TEXT,
      end_date TEXT,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'activo',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(
    `ALTER TABLE users ADD COLUMN expires_at TEXT`,
    [],
    (err) => {
      if (err && !String(err.message || "").includes("duplicate column name")) {
        console.error("Error agregando expires_at:", err.message);
      }
    }
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      login_at TEXT DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT,
      user_agent TEXT,
      success INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(
    `ALTER TABLE user_sessions ADD COLUMN device_id TEXT`,
    [],
    (err) => {
      if (err && !String(err.message || "").includes("duplicate column name")) {
        console.error("Error agregando device_id:", err.message);
      }
    }
  );

  db.run(
    `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_device
     ON user_sessions(user_id, device_id)`,
    [],
    (err) => {
      if (err) {
        console.error("Error creando índice user/device:", err.message);
      }
    }
  );

  db.run(
    `CREATE INDEX IF NOT EXISTS idx_user_sessions_last_seen
     ON user_sessions(last_seen)`,
    [],
    (err) => {
      if (err) {
        console.error("Error creando índice last_seen:", err.message);
      }
    }
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      url TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'hls',
      is_active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(
    `CREATE INDEX IF NOT EXISTS idx_channels_active_order
     ON channels(is_active, sort_order, id)`,
    [],
    (err) => {
      if (err) {
        console.error("Error creando índice channels:", err.message);
      }
    }
  );
});

// =========================
// Helpers
// =========================

function cleanupUserSessions() {
  db.run(`
    DELETE FROM user_sessions
    WHERE datetime(last_seen) < datetime('now', '-30 days')
  `);
}

function isUserExpired(user) {
  if (user.expires_at) {
    return new Date() > new Date(user.expires_at);
  }

  if (!user.end_date) return false;

  const today = new Date();
  const endDate = new Date(user.end_date + "T23:59:59");

  return today > endDate;
}

function isUserNotStarted(user) {
  if (!user.start_date) return false;

  const today = new Date();
  const startDate = new Date(user.start_date + "T00:00:00");

  return today < startDate;
}

function getBogotaNow() {
  const now = new Date();
  const bogota = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Bogota" })
  );
  return bogota;
}

function formatSQLiteDateTime(date) {
  const pad = (n) => String(n).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizeChannelType(type) {
  const value = String(type || "").trim().toLowerCase();
  return value === "file" ? "file" : "hls";
}

function parseM3UContent(content) {
  const text = String(content || "").replace(/\r/g, "");
  const lines = text.split("\n");

  const channels = [];
  let pendingMeta = null;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const line = String(rawLine || "").trim();

    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      const tvgNameMatch = line.match(/tvg-name="([^"]*)"/i);
      const groupTitleMatch = line.match(/group-title="([^"]*)"/i);
      const commaIndex = line.lastIndexOf(",");
      const displayName = commaIndex >= 0 ? line.slice(commaIndex + 1).trim() : "";

      pendingMeta = {
        name:
          (tvgNameMatch && tvgNameMatch[1] && tvgNameMatch[1].trim()) ||
          displayName ||
          "Sin nombre",
        category:
          (groupTitleMatch && groupTitleMatch[1] && groupTitleMatch[1].trim()) ||
          "Otros"
      };

      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (/^https?:\/\//i.test(line)) {
      const url = line.trim();
      const lowerUrl = url.toLowerCase();

      const channel = {
        name: pendingMeta?.name || "Sin nombre",
        category: pendingMeta?.category || "Otros",
        url,
        type: lowerUrl.includes(".m3u8") ? "hls" : "file"
      };

      channels.push(channel);
      pendingMeta = null;
    }
  }

  return channels;
}

async function fetchTextFromUrl(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/plain, application/x-mpegURL, application/vnd.apple.mpegurl, */*"
    },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`No se pudo descargar la lista: ${response.status}`);
  }

  return response.text();
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user || !req.sessionID) {
    return res.redirect("/login.html");
  }

  db.get(
    "SELECT id FROM user_sessions WHERE session_id = ? AND user_id = ?",
    [req.sessionID, req.session.user.id],
    (err, row) => {
      if (err || !row) {
        return req.session.destroy(() => {
          return res.redirect("/login.html");
        });
      }

      next();
    }
  );
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user || req.session.user.role !== "admin" || !req.sessionID) {
    return res.status(403).json({ ok: false, message: "Acceso denegado" });
  }

  db.get(
    "SELECT id FROM user_sessions WHERE session_id = ? AND user_id = ?",
    [req.sessionID, req.session.user.id],
    (err, row) => {
      if (err || !row) {
        return req.session.destroy(() => {
          return res.status(403).json({ ok: false, message: "Sesión inválida" });
        });
      }

      next();
    }
  );
}

// =========================
// Rate limit básico login
// =========================

const loginAttempts = new Map();

function loginRateLimit(req, res, next) {
  const username = String(req.body?.username || "").trim().toLowerCase();

  if (username === "admin") {
    return next();
  }

  const ip = req.ip;
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maxAttempts = 10;

  const entry = loginAttempts.get(ip) || { count: 0, first: now };

  if (now - entry.first > windowMs) {
    entry.count = 0;
    entry.first = now;
  }

  entry.count += 1;
  loginAttempts.set(ip, entry);

  if (entry.count > maxAttempts) {
    return res.status(429).json({
      ok: false,
      message: "Demasiados intentos. Intenta más tarde."
    });
  }

  next();
}

// =========================
// Crear admin por defecto
// =========================

async function createDefaultAdmin() {
  const username = "admin";
  const password = "Qwerty123*";

  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, row) => {
    if (err) {
      console.error("Error buscando admin:", err);
      return;
    }

    if (!row) {
      const hash = await bcrypt.hash(password, 10);

      db.run(
        `INSERT INTO users (username, password_hash, role, start_date, end_date, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          username,
          hash,
          "admin",
          "2026-01-01",
          "2099-12-31",
          "activo"
        ],
        (insertErr) => {
          if (insertErr) {
            console.error("Error creando admin:", insertErr);
          } else {
            console.log("Usuario admin creado");
          }
        }
      );
    }
  });
}

createDefaultAdmin();

// =========================
// Proxy HLS / archivos
// =========================

const playlistCache = new Map();
const PLAYLIST_CACHE_MS = 6000;

function getCachedPlaylist(url) {
  const entry = playlistCache.get(url);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > PLAYLIST_CACHE_MS) {
    playlistCache.delete(url);
    return null;
  }

  return entry.data;
}

function setCachedPlaylist(url, data) {
  playlistCache.set(url, {
    data,
    timestamp: Date.now()
  });
}

setInterval(() => {
  const now = Date.now();

  for (const [url, entry] of playlistCache.entries()) {
    if (now - entry.timestamp > PLAYLIST_CACHE_MS) {
      playlistCache.delete(url);
    }
  }
}, 30000);

function isAllowedStreamHost(urlString) {
  try {
    const url = new URL(urlString);
    return url.hostname === "167.17.67.240";
  } catch {
    return false;
  }
}

function rewriteM3U8(content, baseUrl) {
  const lines = content.split("\n");

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      return line;
    }

    try {
      const absoluteUrl = new URL(trimmed, baseUrl).toString();

      if (absoluteUrl.includes(".m3u8")) {
        return `/proxy/hls?url=${encodeURIComponent(absoluteUrl)}`;
      }

      return `/proxy/segment?url=${encodeURIComponent(absoluteUrl)}`;
    } catch {
      return line;
    }
  });

  return rewritten.join("\n");
}

app.get("/proxy/hls", async (req, res) => {
  try {
    const targetUrl = req.query.url;

    if (!targetUrl || typeof targetUrl !== "string") {
      return res.status(400).send("Falta la URL del stream");
    }

    if (!isAllowedStreamHost(targetUrl)) {
      return res.status(403).send("Host no permitido");
    }

    const cached = getCachedPlaylist(targetUrl);
    if (cached) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=5");
      return res.send(cached);
    }

    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/vnd.apple.mpegurl, application/x-mpegURL, */*"
      },
      signal: AbortSignal.timeout(30000)
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Error cargando playlist: ${upstream.status}`);
    }

    const originalText = await upstream.text();
    const proxiedText = rewriteM3U8(originalText, targetUrl);

    setCachedPlaylist(targetUrl, proxiedText);

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "public, max-age=5");
    return res.send(proxiedText);
  } catch (error) {
    console.error("Error en /proxy/hls:", error);
    return res.status(500).send("Error cargando playlist HLS");
  }
});

app.get("/proxy/segment", async (req, res) => {
  try {
    const targetUrl = req.query.url;

    if (!targetUrl || typeof targetUrl !== "string") {
      return res.status(400).send("Falta la URL del segmento");
    }

    if (!isAllowedStreamHost(targetUrl)) {
      return res.status(403).send("Host no permitido");
    }

    const headers = {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*"
    };

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(20000)
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Error cargando segmento: ${upstream.status}`);
    }

    const contentType = upstream.headers.get("content-type");
    const contentLength = upstream.headers.get("content-length");
    const acceptRanges = upstream.headers.get("accept-ranges");
    const contentRange = upstream.headers.get("content-range");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    res.setHeader("Cache-Control", "public, max-age=10");
    res.status(upstream.status);

    if (!upstream.body) {
      return res.end();
    }

    const stream = Readable.fromWeb(upstream.body);

    stream.on("error", (err) => {
      console.error("Error de stream en /proxy/segment:", err.message || err);
      if (!res.headersSent) {
        res.status(504).end("Timeout en segmento");
      } else {
        res.end();
      }
    });

    res.on("close", () => {
      stream.destroy();
    });

    stream.pipe(res);
  } catch (error) {
    console.error("Error en /proxy/segment:", error);
    return res.status(500).send("Error cargando segmento HLS");
  }
});

app.get("/proxy/file", async (req, res) => {
  try {
    const targetUrl = req.query.url;

    if (!targetUrl || typeof targetUrl !== "string") {
      return res.status(400).send("Falta la URL");
    }

    if (!isAllowedStreamHost(targetUrl)) {
      return res.status(403).send("Host no permitido");
    }

    const headers = {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*"
    };

    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(20000)
    });

    if (!upstream.ok) {
      return res.status(upstream.status).send(`Error cargando archivo: ${upstream.status}`);
    }

    const contentType = upstream.headers.get("content-type");
    const contentLength = upstream.headers.get("content-length");
    const acceptRanges = upstream.headers.get("accept-ranges");
    const contentRange = upstream.headers.get("content-range");

    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (acceptRanges) res.setHeader("Accept-Ranges", acceptRanges);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    res.setHeader("Cache-Control", "public, max-age=30");
    res.status(upstream.status);

    if (!upstream.body) {
      return res.end();
    }

    const stream = Readable.fromWeb(upstream.body);

    stream.on("error", (err) => {
      console.error("Error de stream en /proxy/file:", err.message || err);
      if (!res.headersSent) {
        res.status(504).end("Timeout en archivo");
      } else {
        res.end();
      }
    });

    res.on("close", () => {
      stream.destroy();
    });

    stream.pipe(res);
  } catch (error) {
    console.error("Error en /proxy/file:", error);
    return res.status(500).send("Error cargando archivo");
  }
});

// =========================
// Rutas básicas
// =========================

app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/logout", (req, res) => {
  if (req.session) {
    const sid = req.sessionID;

    db.run("DELETE FROM user_sessions WHERE session_id = ?", [sid], () => {
      req.session.destroy(() => {
        res.redirect("/login.html");
      });
    });
  } else {
    res.redirect("/login.html");
  }
});

app.get("/", (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect("/index.html");
  }
  return res.redirect("/login.html");
});

app.get("/index.html", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/admin.html", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/admin-channels.html", requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-channels.html"));
});

// =========================
// Login / sesión
// =========================

app.post("/login", loginRateLimit, (req, res) => {
  const { username, password, deviceId, rememberMe } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      message: "Usuario y contraseña son obligatorios"
    });
  }

  const safeDeviceId =
    typeof deviceId === "string" && deviceId.trim()
      ? deviceId.trim().slice(0, 120)
      : null;

  if (!safeDeviceId) {
    return res.status(400).json({
      ok: false,
      message: "No se pudo identificar el dispositivo"
    });
  }

  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err) {
      console.error("Error buscando usuario:", err);
      return res.status(500).json({ ok: false, message: "Error del servidor" });
    }

    if (!user) {
      return res.status(401).json({ ok: false, message: "Usuario o contraseña incorrectos" });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);

    if (!passwordOk) {
      db.run(
        `INSERT INTO access_logs (user_id, username, ip_address, user_agent, success)
         VALUES (?, ?, ?, ?, ?)`,
        [user.id, user.username, req.ip, req.get("user-agent"), 0]
      );

      return res.status(401).json({ ok: false, message: "Usuario o contraseña incorrectos" });
    }

    if (user.status !== "activo") {
      return res.status(403).json({ ok: false, message: "Usuario suspendido" });
    }

    if (isUserNotStarted(user)) {
      return res.status(403).json({ ok: false, message: "Tu acceso aún no ha iniciado" });
    }

    if (isUserExpired(user)) {
      return res.status(403).json({ ok: false, message: "Tu acceso ha vencido" });
    }

    cleanupUserSessions();

    db.serialize(() => {
      db.run("BEGIN IMMEDIATE TRANSACTION", (beginErr) => {
        if (beginErr) {
          console.error("Error iniciando transacción:", beginErr);
          return res.status(500).json({ ok: false, message: "No se pudo iniciar el login" });
        }

        const rollback = (message, error) => {
          return db.run("ROLLBACK", () => {
            if (error) console.error(message, error);
            return res.status(500).json({ ok: false, message });
          });
        };

        db.all(
          `SELECT *
           FROM user_sessions
           WHERE user_id = ?
           ORDER BY last_seen DESC, created_at DESC`,
          [user.id],
          (sessionErr, sessions) => {
            if (sessionErr) {
              return rollback("Error validando sesiones activas", sessionErr);
            }

            const distinctDeviceIds = [
              ...new Set(
                sessions
                  .map((s) => s.device_id)
                  .filter(Boolean)
              )
            ];

            const sameDeviceExists = distinctDeviceIds.includes(safeDeviceId);

            if (user.role !== "admin" && !sameDeviceExists && distinctDeviceIds.length >= 2) {
              const oldestSession = sessions[sessions.length - 1];

              if (oldestSession && oldestSession.session_id) {
                db.run(
                  `DELETE FROM user_sessions WHERE session_id = ?`,
                  [oldestSession.session_id],
                  (deleteErr) => {
                    if (deleteErr) {
                      return rollback("Error eliminando sesión antigua", deleteErr);
                    }
                  }
                );
              }
            }

            db.run(
              `DELETE FROM user_sessions WHERE user_id = ? AND device_id = ?`,
              [user.id, safeDeviceId],
              (deleteErr) => {
                if (deleteErr) {
                  return rollback("Error limpiando sesión previa del dispositivo", deleteErr);
                }

                req.session.regenerate((regenErr) => {
                  if (regenErr) {
                    return rollback("No se pudo regenerar la sesión", regenErr);
                  }

                  req.session.user = {
                    id: user.id,
                    username: user.username,
                    role: user.role
                  };

                  req.session.deviceId = safeDeviceId;

                  req.session.cookie.maxAge = rememberMe
                    ? 1000 * 60 * 60 * 24 * 30
                    : 1000 * 60 * 60 * 8;

                  db.run(
                    `INSERT INTO user_sessions
                     (user_id, username, session_id, device_id, ip_address, user_agent, last_seen)
                     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
                    [
                      user.id,
                      user.username,
                      req.sessionID,
                      safeDeviceId,
                      req.ip,
                      req.get("user-agent")
                    ],
                    (insertErr) => {
                      if (insertErr) {
                        return rollback("No se pudo registrar la sesión", insertErr);
                      }

                      db.run("COMMIT", (commitErr) => {
                        if (commitErr) {
                          return rollback("No se pudo completar el login", commitErr);
                        }

                        db.run(
                          `INSERT INTO access_logs (user_id, username, ip_address, user_agent, success)
                           VALUES (?, ?, ?, ?, ?)`,
                          [user.id, user.username, req.ip, req.get("user-agent"), 1]
                        );

                        return res.json({
                          ok: true,
                          message: "Login correcto"
                        });
                      });
                    }
                  );
                });
              }
            );
          }
        );
      });
    });
  });
});

app.get("/api/session", (req, res) => {
  if (!req.session || !req.session.user || !req.sessionID) {
    return res.status(401).json({ loggedIn: false });
  }

  db.get(
    "SELECT id FROM user_sessions WHERE session_id = ? AND user_id = ?",
    [req.sessionID, req.session.user.id],
    (sessionErr, sessionRow) => {
      if (sessionErr || !sessionRow) {
        return req.session.destroy(() => {
          return res.status(401).json({ loggedIn: false });
        });
      }

      db.run(
        "UPDATE user_sessions SET last_seen = CURRENT_TIMESTAMP WHERE session_id = ?",
        [req.sessionID],
        () => {}
      );

      db.get(
        "SELECT start_date, end_date, expires_at, status FROM users WHERE id = ?",
        [req.session.user.id],
        (err, row) => {
          if (err) {
            return res.status(500).json({ loggedIn: false });
          }

          return res.json({
            loggedIn: true,
            user: {
              ...req.session.user,
              start_date: row?.start_date,
              end_date: row?.end_date,
              expires_at: row?.expires_at,
              status: row?.status
            }
          });
        }
      );
    }
  );
});

app.get("/api/channels", requireAuth, (req, res) => {
  db.all(
    `SELECT id, name, category, url, type
     FROM channels
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ ok: false, message: "Error cargando canales" });
      }

      return res.json({
        ok: true,
        channels: rows
      });
    }
  );
});

app.post("/logout", (req, res) => {
  if (req.session) {
    const sid = req.sessionID;

    db.run("DELETE FROM user_sessions WHERE session_id = ?", [sid], () => {
      req.session.destroy(() => {
        res.json({ ok: true });
      });
    });
  } else {
    res.json({ ok: true });
  }
});

app.post("/api/close-session", async (req, res) => {
  try {
    const { username, password, sessionId } = req.body;

    if (!username || !password || !sessionId) {
      return res.status(400).json({
        ok: false,
        message: "Faltan datos para cerrar la sesión"
      });
    }

    db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
      if (err) {
        return res.status(500).json({ ok: false, message: "Error del servidor" });
      }

      if (!user) {
        return res.status(401).json({ ok: false, message: "Usuario no encontrado" });
      }

      const passwordOk = await bcrypt.compare(password, user.password_hash);

      if (!passwordOk) {
        return res.status(401).json({ ok: false, message: "Contraseña incorrecta" });
      }

      db.get(
        "SELECT * FROM user_sessions WHERE session_id = ? AND user_id = ?",
        [sessionId, user.id],
        (sessionErr, sessionRow) => {
          if (sessionErr) {
            return res.status(500).json({ ok: false, message: "Error buscando la sesión" });
          }

          if (!sessionRow) {
            return res.status(404).json({ ok: false, message: "Sesión no encontrada" });
          }

          db.run(
            "DELETE FROM user_sessions WHERE session_id = ?",
            [sessionId],
            function (deleteErr) {
              if (deleteErr) {
                return res.status(500).json({ ok: false, message: "No se pudo cerrar la sesión" });
              }

              return res.json({
                ok: true,
                message: "Sesión cerrada correctamente"
              });
            }
          );
        }
      );
    });
  } catch (error) {
    console.error("Error en /api/close-session:", error);
    return res.status(500).json({ ok: false, message: "Error cerrando la sesión" });
  }
});

//
// importar m3u
//

app.post("/admin/channels/import-m3u", requireAdmin, async (req, res) => {
  try {
    const { m3uText, playlistUrl, replaceExisting, defaultCategory } = req.body;

    let content = "";

    if (typeof m3uText === "string" && m3uText.trim()) {
      content = m3uText.trim();
    } else if (typeof playlistUrl === "string" && playlistUrl.trim()) {
      content = await fetchTextFromUrl(playlistUrl.trim());
    } else {
      return res.status(400).json({
        ok: false,
        message: "Debes pegar el contenido M3U o una URL de playlist"
      });
    }

    const parsedChannels = parseM3UContent(content);

    if (!parsedChannels.length) {
      return res.status(400).json({
        ok: false,
        message: "No se encontraron canales válidos en la lista M3U"
      });
    }

    const safeDefaultCategory =
      typeof defaultCategory === "string" && defaultCategory.trim()
        ? defaultCategory.trim()
        : "";

    db.serialize(() => {
      db.run("BEGIN IMMEDIATE TRANSACTION", (beginErr) => {
        if (beginErr) {
          console.error("Error iniciando importación M3U:", beginErr);
          return res.status(500).json({
            ok: false,
            message: "No se pudo iniciar la importación"
          });
        }

        const rollback = (message, error) => {
          db.run("ROLLBACK", () => {
            if (error) {
              console.error(message, error);
            }
            return res.status(500).json({ ok: false, message });
          });
        };

        const continueImport = () => {
          let processed = 0;
          let inserted = 0;
          let updated = 0;

          const next = () => {
            if (processed >= parsedChannels.length) {
              return db.run("COMMIT", (commitErr) => {
                if (commitErr) {
                  return rollback("No se pudo completar la importación", commitErr);
                }

                return res.json({
                  ok: true,
                  message: `Importación completada. Insertados: ${inserted}, actualizados: ${updated}`,
                  inserted,
                  updated,
                  total: parsedChannels.length
                });
              });
            }

            const item = parsedChannels[processed];
            processed += 1;

            const name = String(item.name || "").trim();
            const category = safeDefaultCategory || String(item.category || "Otros").trim() || "Otros";
            const url = String(item.url || "").trim();
            const type = normalizeChannelType(item.type);

            db.get(
              `SELECT id FROM channels WHERE LOWER(name) = LOWER(?)`,
              [name],
              (findErr, existing) => {
                if (findErr) {
                  return rollback("Error buscando canal existente", findErr);
                }

                if (existing) {
                  db.run(
                    `UPDATE channels
                     SET category = ?, url = ?, type = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [category, url, type, existing.id],
                    (updateErr) => {
                      if (updateErr) {
                        return rollback("Error actualizando canal", updateErr);
                      }

                      updated += 1;
                      next();
                    }
                  );
                } else {
                  db.get(
                    `SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextSort FROM channels`,
                    [],
                    (sortErr, sortRow) => {
                      if (sortErr) {
                        return rollback("Error calculando orden del canal", sortErr);
                      }

                      db.run(
                        `INSERT INTO channels
                         (name, category, url, type, is_active, sort_order, updated_at)
                         VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)`,
                        [name, category, url, type, sortRow?.nextSort || 0],
                        (insertErr) => {
                          if (insertErr) {
                            return rollback("Error insertando canal", insertErr);
                          }

                          inserted += 1;
                          next();
                        }
                      );
                    }
                  );
                }
              }
            );
          };

          next();
        };

        if (Number(replaceExisting)) {
          db.run(`DELETE FROM channels`, [], (deleteErr) => {
            if (deleteErr) {
              return rollback("No se pudo limpiar la lista actual", deleteErr);
            }

            continueImport();
          });
        } else {
          continueImport();
        }
      });
    });
  } catch (error) {
    console.error("Error en /admin/channels/import-m3u:", error);
    return res.status(500).json({
      ok: false,
      message: error.message || "Error importando lista M3U"
    });
  }
});

// =========================
// Admin - canales
// =========================

app.get("/admin/channels", requireAdmin, (req, res) => {
  db.all(
    `SELECT id, name, category, url, type, is_active, sort_order, created_at, updated_at
     FROM channels
     ORDER BY sort_order ASC, id ASC`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ ok: false, message: "Error listando canales" });
      }

      return res.json({ ok: true, channels: rows });
    }
  );
});

app.post("/admin/channels", requireAdmin, (req, res) => {
  const { name, category, url, type, is_active, sort_order } = req.body;

  if (!name || !category || !url) {
    return res.status(400).json({
      ok: false,
      message: "Nombre, categoría y URL son obligatorios"
    });
  }

  db.run(
    `INSERT INTO channels (name, category, url, type, is_active, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      String(name).trim(),
      String(category).trim(),
      String(url).trim(),
      normalizeChannelType(type),
      Number(is_active) ? 1 : 0,
      Number(sort_order) || 0
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ ok: false, message: "No se pudo crear el canal" });
      }

      return res.json({
        ok: true,
        id: this.lastID,
        message: "Canal creado"
      });
    }
  );
});

app.put("/admin/channels/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const { name, category, url, type, is_active, sort_order } = req.body;

  if (!name || !category || !url) {
    return res.status(400).json({
      ok: false,
      message: "Nombre, categoría y URL son obligatorios"
    });
  }

  db.run(
    `UPDATE channels
     SET name = ?, category = ?, url = ?, type = ?, is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      String(name).trim(),
      String(category).trim(),
      String(url).trim(),
      normalizeChannelType(type),
      Number(is_active) ? 1 : 0,
      Number(sort_order) || 0,
      id
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ ok: false, message: "No se pudo actualizar el canal" });
      }

      return res.json({ ok: true, message: "Canal actualizado" });
    }
  );
});

app.delete("/admin/channels/:id", requireAdmin, (req, res) => {
  const { id } = req.params;

  db.run(`DELETE FROM channels WHERE id = ?`, [id], function (err) {
    if (err) {
      return res.status(500).json({ ok: false, message: "No se pudo eliminar el canal" });
    }

    return res.json({ ok: true, message: "Canal eliminado" });
  });
});

// =========================
// Admin - usuarios
// =========================

app.get("/admin/users", requireAdmin, (req, res) => {
  db.all(
    `SELECT 
      u.id,
      u.username,
      u.role,
      u.start_date,
      u.end_date,
      u.status,
      u.created_at,
      COUNT(us.id) AS active_sessions
     FROM users u
     LEFT JOIN user_sessions us ON us.user_id = u.id
     GROUP BY u.id, u.username, u.role, u.start_date, u.end_date, u.status, u.created_at
     ORDER BY u.id DESC`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ ok: false, message: "Error al listar usuarios" });
      }

      res.json({ ok: true, users: rows });
    }
  );
});

app.post("/admin/users", requireAdmin, async (req, res) => {
  const { username, password, role, start_date, end_date, status, demo_minutes } = req.body;
  const createdAt = formatSQLiteDateTime(getBogotaNow());

  if (!username || !password) {
    return res.status(400).json({ ok: false, message: "Usuario y contraseña son obligatorios" });
  }

  const hash = await bcrypt.hash(password, 10);

  const minutes = Number(demo_minutes) || 0;
  const bogotaNow = getBogotaNow();
  const expiresAt =
    minutes > 0
      ? formatSQLiteDateTime(new Date(bogotaNow.getTime() + minutes * 60 * 1000))
      : null;

  db.run(
    `INSERT INTO users (username, password_hash, role, start_date, end_date, expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      username,
      hash,
      role || "user",
      start_date || null,
      end_date || null,
      expiresAt,
      status || "activo",
      createdAt
    ],
    function (err) {
      if (err) {
        return res.status(500).json({ ok: false, message: "No se pudo crear el usuario" });
      }

      res.json({
        ok: true,
        id: this.lastID,
        message: expiresAt
          ? `Demo creado por ${minutes} minutos`
          : "Usuario creado"
      });
    }
  );
});

app.put("/admin/users/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const { role, start_date, end_date, status } = req.body;

  const currentUser = req.session.user;

  if (Number(id) === Number(currentUser.id)) {
    return res.status(400).json({
      ok: false,
      message: "No puedes cambiar tu propio rol o estado desde esta pantalla"
    });
  }

  db.run(
    `UPDATE users
     SET role = ?, start_date = ?, end_date = ?, status = ?
     WHERE id = ?`,
    [role, start_date, end_date, status, id],
    function (err) {
      if (err) {
        return res.status(500).json({ ok: false, message: "No se pudo actualizar el usuario" });
      }

      res.json({ ok: true, message: "Usuario actualizado" });
    }
  );
});

app.put("/admin/users/:id/renew", requireAdmin, (req, res) => {
  const { id } = req.params;
  const days = Number(req.body.days) || 0;

  if (days <= 0) {
    return res.status(400).json({
      ok: false,
      message: "Cantidad de días inválida"
    });
  }

  db.get(
    "SELECT end_date, expires_at FROM users WHERE id = ?",
    [id],
    (err, user) => {
      if (err || !user) {
        return res.status(500).json({
          ok: false,
          message: "No se pudo cargar el usuario"
        });
      }

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let baseDate;

      if (user.end_date) {
        const currentEnd = new Date(user.end_date + "T00:00:00");
        baseDate = currentEnd >= today ? currentEnd : today;
      } else {
        baseDate = today;
      }

      baseDate.setDate(baseDate.getDate() + days);

      const yyyy = baseDate.getFullYear();
      const mm = String(baseDate.getMonth() + 1).padStart(2, "0");
      const dd = String(baseDate.getDate()).padStart(2, "0");
      const newEndDate = `${yyyy}-${mm}-${dd}`;

      db.run(
        `UPDATE users
         SET end_date = ?, expires_at = NULL, status = 'activo'
         WHERE id = ?`,
        [newEndDate, id],
        function (updateErr) {
          if (updateErr) {
            return res.status(500).json({
              ok: false,
              message: "No se pudo renovar el servicio"
            });
          }

          return res.json({
            ok: true,
            message: `Servicio renovado hasta ${newEndDate}`
          });
        }
      );
    }
  );
});

app.put("/admin/users/:id/password", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ ok: false, message: "La contraseña es obligatoria" });
  }

  const hash = await bcrypt.hash(password, 10);

  db.run(
    `UPDATE users SET password_hash = ? WHERE id = ?`,
    [hash, id],
    function (err) {
      if (err) {
        return res.status(500).json({ ok: false, message: "No se pudo cambiar la contraseña" });
      }

      res.json({ ok: true, message: "Contraseña actualizada" });
    }
  );
});

app.delete("/admin/users/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  const currentUser = req.session.user;

  if (Number(id) === Number(currentUser.id)) {
    return res.status(400).json({
      ok: false,
      message: "No puedes eliminar tu propia cuenta"
    });
  }

  db.run(`DELETE FROM users WHERE id = ?`, [id], function (err) {
    if (err) {
      return res.status(500).json({ ok: false, message: "No se pudo eliminar el usuario" });
    }

    db.run(`DELETE FROM user_sessions WHERE user_id = ?`, [id], () => {
      res.json({ ok: true, message: "Usuario eliminado" });
    });
  });
});

app.get("/admin/logs", requireAdmin, (req, res) => {
  db.all(
    `SELECT id, user_id, username, login_at, ip_address, user_agent, success
     FROM access_logs
     ORDER BY id DESC
     LIMIT 200`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ ok: false, message: "Error al obtener logs" });
      }

      res.json({ ok: true, logs: rows });
    }
  );
});

app.get("/admin/active-sessions", requireAdmin, (req, res) => {
  cleanupUserSessions();

  db.all(
    `SELECT id, user_id, username, session_id, ip_address, user_agent, created_at, last_seen
     FROM user_sessions
     ORDER BY last_seen DESC`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ ok: false, message: "Error al obtener sesiones activas" });
      }

      res.json({ ok: true, sessions: rows });
    }
  );
});

app.get("/admin/connected-users-summary", requireAdmin, (req, res) => {
  db.all(
    `
    SELECT 
      username,
      ip_address,
      user_agent,
      created_at,
      last_seen
    FROM user_sessions
    WHERE datetime(last_seen) >= datetime('now', '-60 seconds')
    ORDER BY last_seen DESC
    `,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ ok: false, message: "Error al obtener conectados" });
      }

      const uniqueUsers = [...new Set(rows.map(r => r.username))];

      res.json({
        ok: true,
        connectedSessions: rows.length,
        connectedUsers: uniqueUsers.length,
        sessions: rows
      });
    }
  );
});

// =========================
// Error handler
// =========================

app.use((err, req, res, next) => {
  console.error("ERROR NO CONTROLADO:", err);
  res.status(500).send("Internal Server Error");
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

// =========================
// Servidor
// =========================

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

const HOST = "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`Servidor corriendo en ${HOST}:${PORT}`);
});