const express = require("express");
const nunjucks = require("nunjucks");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const { nanoid } = require("nanoid");
const http = require("http");
const WebSocket = require("ws");
const DB = require("./db");

const app = express();

nunjucks.configure("views", {
  autoescape: true,
  express: app,
});

app.set("view engine", "njk");
app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());
app.use((err, req, res, next) => {
  console.error("❌ Express Error:", err);
  res.status(500).send("Internal Server Error");
});
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(__dirname + "/public"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});
// ------------------ Аутентификация ------------------
const findUserByUsername = async (username) => DB("users").where({ userName: username }).first();
const findUserBySessionId = async (sessionId) => {
  const session = await DB("sessions").where({ sessionId }).first();
  if (!session) return null;
  return DB("users").where({ userId: session.userId }).first();
};
const createSession = async (userId) => {
  const sessionId = nanoid();
  await DB("sessions").insert({ sessionId, userId });
  return sessionId;
};
const deleteSession = async (sessionId) => DB("sessions").where({ sessionId }).del();

const auth = () => async (req, res, next) => {
  if (!req.cookies.sessionId) return next();
  try {
    const user = await findUserBySessionId(req.cookies.sessionId);
    if (!user) {
      res.clearCookie("sessionId");
      return next();
    }
    req.user = user;
    req.sessionId = req.cookies.sessionId;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    next();
  }
};

// ------------------ Таймеры ------------------
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}

async function getAllTimers(userId) {
  const timers = await DB("timer")
    .select("*")
    .where({ userId })
    .orderBy("timerStart", "desc");
  return timers.map(t => ({ ...t, isActive: !!t.isActive }));
}

async function getActiveTimers(userId) {
  const now = Date.now();
  const timers = await DB("timer")
    .select("*")
    .where({ userId, isActive: true });
  return timers.map(t => ({ ...t, isActive: !!t.isActive, progress: formatDuration(now - new Date(t.timerStart).getTime()) }));
}

// ------------------ Маршруты ------------------
app.get("/", async (req, res) => {
  try {
    console.log("➡️ Route / hit");
    const sessionId = req.cookies.sessionId;
    console.log("Cookie sessionId:", sessionId);

    if (!sessionId) {
      console.log("No sessionId, sending index.html");
      return res.sendFile(__dirname + "/public/index.html");
    }

    const session = await DB("sessions").where({ sessionId }).first();
    console.log("Session from DB:", session);
    if (!session) {
      console.log("No session in DB, sending index.html");
      return res.sendFile(__dirname + "/public/index.html");
    }

    const user = await DB("users").where({ userId: session.userId }).first();
    console.log("User from DB:", user);
    if (!user) {
      console.log("No user in DB, sending index.html");
      return res.sendFile(__dirname + "/public/index.html");
    }

    console.log("✅ User found, sending app.html");
    res.sendFile(__dirname + "/public/app.html");
  } catch (err) {
    console.error("❌ Error in / route:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await findUserByUsername(username);
    if (!user || user.userPassword !== Number(password)) return res.redirect("/?authError=true");
    const sessionId = await createSession(user.userId);
    res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).send("Username and password required");
  const existingUser = await findUserByUsername(username);
  if (existingUser) return res.status(400).send("User exists");
  const [result] = await DB("users").insert({ userName: username, userPassword: Number(password) }).returning("*");
  const sessionId = await createSession(result.userId);
  res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
});

app.get("/logout", async (req, res) => {
  const sessionId = req.cookies.sessionId;
  if (sessionId) await deleteSession(sessionId);
  res.clearCookie("sessionId").redirect("/");
});

// ------------------ API Таймеров ------------------
app.post("/api/timers", auth(), async (req, res) => {
  const { description } = req.body;
  const newTimer = {
    timerId: nanoid(),
    timerDescription: description,
    timerStart: new Date(),
    timerEnd: null,
    timerProcess: null,
    isActive: true,
    duration: null,
    userId: req.user.userId
  };
  const [createdTimer] = await DB("timer").insert(newTimer).returning("*");
  broadcastAllTimers(req.user.userId);
  res.status(201).json({ ...createdTimer, isActive: !!createdTimer.isActive });
});

app.post("/api/timers/:id/stop", async (req, res) => {
  const id = req.params.id;
  const now = new Date();
  const timer = await DB("timer").where({ timerId: id, isActive: true }).first();
  if (!timer) return res.status(404).json({ error: "Not found" });
  await DB("timer").where({ timerId: id }).update({
    timerEnd: now,
    duration: formatDuration(now - new Date(timer.timerStart).getTime()),
    isActive: false
  });
  broadcastAllTimers(timer.userId);
  res.json({ message: "Stopped", id: timer.timerId });
});

// ------------------ WebSocket ------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();

wss.on("connection", async (ws, req) => {
  try {
    const params = new URLSearchParams(req.url.replace(/^.*\?/, ""));
    const sessionId = params.get("sessionId");
    if (!sessionId) return ws.close();
    const user = await findUserBySessionId(sessionId);
    if (!user) return ws.close();

    const uid = user.userId;
    if (!clients.has(uid)) clients.set(uid, new Set());
    clients.get(uid).add(ws);

    ws.on("close", () => {
      clients.get(uid).delete(ws);
      if (clients.get(uid).size === 0) clients.delete(uid);
    });

    const allTimers = await getAllTimers(uid);
    ws.send(JSON.stringify({ type: "all_timers", timers: allTimers }));
  } catch (err) {
    console.error("WS error:", err);
    ws.close();
  }
});

async function broadcastAllTimers(userId) {
  if (!clients.has(userId)) return;
  const allTimers = await getAllTimers(userId);
  for (const ws of clients.get(userId)) {
    ws.send(JSON.stringify({ type: "all_timers", timers: allTimers }));
  }
}

setInterval(async () => {
  for (const [uid, sockets] of clients.entries()) {
    const activeTimers = await getActiveTimers(uid);
    for (const ws of sockets) {
      ws.send(JSON.stringify({ type: "active_timers", timers: activeTimers }));
    }
  }
}, 1000);

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));

DB.raw('SELECT 1')
  .then(() => console.log('✅ DB OK'))
  .catch(err => console.error('❌ DB Error:', err));
