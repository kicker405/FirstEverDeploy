const express = require("express");
const nunjucks = require("nunjucks");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const { nanoid } = require("nanoid");
const app = express();
const DB = require("./db");
const http = require("http");
const WebSocket = require("ws");

nunjucks.configure("views", {
  autoescape: true,
  express: app,
  tags: {
    blockStart: "[%",
    blockEnd: "%]",
    variableStart: "[[",
    variableEnd: "]]",
    commentStart: "[#",
    commentEnd: "#]",
  },
});

app.set("view engine", "njk");
app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());

//Подключение аутентификации...
const findUserByUsername = async (username) => {
  return DB("users").where({ userName: username }).first();
};

const findUserBySessionId = async (sessionId) => {
  const session = await DB("sessions").where({ sessionId }).first();
  if (!session) return null;
  return DB("users").where({ userId: session.userId }).first();
};

const createSession = async (userId) => {
  console.log("Creating session with userId:", userId);
  const sessionId = nanoid();
  userId = Number(userId);
  if (isNaN(userId)) {
    throw new Error("Invalid userId");
  }
  await DB("sessions").insert({ sessionId, userId });
  return sessionId;
};

const deleteSession = async (sessionId) => {
  await DB("sessions").where({ sessionId }).del();
};

const auth = () => async (req, res, next) => {
  if (!req.cookies["sessionId"]) return next();

  try {
    const user = await findUserBySessionId(req.cookies["sessionId"]);
    if (!user) {
      res.clearCookie("sessionId");
      return next();
    }

    req.user = user;
    req.sessionId = req.cookies["sessionId"];
    next();
  } catch (error) {
    console.error("Auth error:", error);
    next();
  }
};

//API
async function getAllTimers(userId) {
  return DB("timer").where({ userId }).orderBy("timerStart", "desc");
}

async function getActiveTimers(userId) {
  const now = Date.now();
  let timers = await DB("timer").where({ userId, isActive: true });
  return timers.map((t) => ({
    ...t,
    progress: formatDuration(now - new Date(t.timerStart).getTime()),
  }));
}

app.get("/", auth(), (req, res) => {
  res.render("index", {
    user: req.user,
    sessionId: req.sessionId,
    authError: req.query.authError === "true",
  });
});

app.post("/login", bodyParser.urlencoded({ extended: false }), async (req, res) => {
  const { username, password } = req.body;
  const user = await findUserByUsername(username);
  if (!user || user.userPassword !== Number(password)) {
    return res.redirect("/?authError=true");
  }
  const sessionId = await createSession(user.userId);
  res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
});

app.post("/signup", bodyParser.urlencoded({ extended: false }), async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).send("Username and password are required");
  }

  const existingUser = await findUserByUsername(username);
  if (existingUser) {
    return res.status(400).send("Пользователь с таким именем уже существует");
  }

  try {
    const [result] = await DB("users")
      .insert({
        userName: username,
        userPassword: Number(password),
      })
      .returning("userId");

    const newUserId = result.userId;
    const sessionId = await createSession(newUserId);

    res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal server error");
  }
});

app.get("/signup", (req, res) => {
  res.render("signup", {
    authError: req.query.authError === "true",
  });
});

app.get("/logout", async (req, res) => {
  const sessionId = req.cookies["sessionId"];
  if (sessionId) {
    await deleteSession(sessionId);
    res.clearCookie("sessionId");
  }
  res.redirect("/?authError=false");
});

//Timers functions
function formatDuration(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

app.post("/api/timers/:id/stop", async (req, res) => {
  const id = req.params.id;
  const now = new Date();

  try {
    const timer = await DB("timer").where({ timerId: id, isActive: true }).first();
    if (!timer) {
      return res.status(404).json({ error: "Timer not found or already stopped" });
    }

    await DB("timer")
      .where({ timerId: id })
      .update({
        timerEnd: now,
        duration: formatDuration(now - new Date(timer.timerStart).getTime()),
        isActive: false,
      });

    broadcastAllTimers(timer.userId);
    res.status(200).json({ message: "Timer stopped", id: timer.timerId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/timers", auth(), async (req, res) => {
  const { description } = req.body;

  const newTimer = {
    timerId: nanoid(),
    timerDescription: description,
    timerStart: new Date(),
    isActive: true,
    userId: req.user.userId,
  };

  try {
    const [createdTimer] = await DB("timer").insert(newTimer).returning("*");
    broadcastAllTimers(req.user.userId);
    res.status(201).json(createdTimer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal server error" });
  }
});

//Websocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();

wss.on("connection", async (ws, req) => {
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
    const active = await getActiveTimers(uid);
    for (const ws of sockets) {
      ws.send(JSON.stringify({ type: "active_timers", timers: active }));
    }
  }
}, 1000);

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Server is running on port ${port}`);
});
