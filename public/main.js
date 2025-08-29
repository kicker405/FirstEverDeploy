/*global UIkit, Vue */

(() => {
  const notification = (config) =>
    UIkit.notification({
      pos: "top-right",
      timeout: 5000,
      ...config,
    });

  const alert = (message) =>
    notification({
      message,
      status: "danger",
    });

  const info = (message) =>
    notification({
      message,
      status: "success",
    });

  const fetchJson = (...args) =>
    fetch(...args)
      .then((res) =>
        res.ok
          ? res.status !== 204
            ? res.json()
            : null
          : res.text().then((text) => {
              throw new Error(text);
            })
      )
      .catch((err) => {
        alert(err.message);
      });

  new Vue({
    el: "#app",
    data: {
      desc: "",
      activeTimers: [],
      oldTimers: [],
    },
    methods: {
      createTimer() {
        const description = this.desc;
        this.desc = "";
        fetchJson("/api/timers", {
          method: "post",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description }),
          credentials: "include",
        }).then((timer) => {
          info(`Created new timer "${description}" [${timer.timerId}]`);
        });
      },
      stopTimer(id) {
        fetchJson(`/api/timers/${id}/stop`, { method: "post", credentials: "include" }).then(() => {
          info(`Stopped the timer [${id}]`);
        });
      },
      formatTime(ts) {
        const date = new Date(ts);
        return date.toTimeString().split(" ")[0];
      },
      formatDuration(d) {
        if (typeof d === "string") return d;
        if (!d) return "00:00:00";

        const totalSeconds = Math.floor(d / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        return [hours, minutes, seconds].map((num) => num.toString().padStart(2, "0")).join(":");
      },
    },
    created() {
      const ws = new WebSocket(`ws://${window.location.host}/?sessionId=${window.SESSION_ID}`);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "all_timers") {
            this.activeTimers = msg.timers.filter((t) => t.isActive);
            this.oldTimers = msg.timers.filter((t) => !t.isActive || t.timerEnd);
          }
          if (msg.type === "active_timers") {
            this.activeTimers = msg.timers;
          }
        } catch (e) {
          console.error("WS parse error:", e);
        }
      };
    },
    computed: {
      processedActiveTimers() {
        return this.activeTimers.map((timer) => ({
          ...timer,
          progress: this.formatDuration(Date.now() - new Date(timer.timerStart).getTime()),
        }));
      },
    },
  });
})();
