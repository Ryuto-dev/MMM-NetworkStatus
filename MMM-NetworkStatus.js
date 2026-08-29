/* global Module, Log, NetworkStatusFormat */

/* MMM-NetworkStatus
 *
 * Text + icon only network monitor for MagicMirror².
 * Successor of the no longer available MMM-NetworkConnection.
 *
 * Shows:
 *   - whether the mirror is connected to the internet (red warning if not)
 *   - latency (ping)
 *   - download speed
 *   - upload speed
 *
 * While a measurement runs, the numbers count up so it is visually obvious
 * that a test is in progress.
 *
 * MIT Licensed.
 */
Module.register("MMM-NetworkStatus", {
  defaults: {
    // --- update scheduling ------------------------------------------------
    updateInterval: 30 * 1000, // connectivity + ping loop
    speedTestInterval: 30 * 60 * 1000, // full speed test loop
    initialSpeedTestDelay: 5 * 1000, // wait after boot before first test
    animationSpeed: 500, // MagicMirror dom fade speed
    pauseWhenHidden: true, // stop measuring while the module is hidden

    // --- what to display --------------------------------------------------
    showStatus: true,
    showPing: true,
    showDownload: true,
    showUpload: true,
    showIcons: true,
    showLabels: true,
    showLastUpdated: false,
    showServerInfo: false,
    showJitter: false,
    showPacketLoss: false,
    layout: "vertical", // "vertical" | "horizontal" | "compact"
    alignment: "left", // "left" | "center" | "right"
    fontSize: "medium", // "xsmall" | "small" | "medium" | "large"

    // --- units / precision ------------------------------------------------
    speedUnit: "auto", // "auto" | "bps" | "kbps" | "Mbps" | "Gbps" | "MB/s" | "bytes"
    speedDecimals: 1,
    pingDecimals: 0,

    // --- animation --------------------------------------------------------
    animateMeasurement: true,
    countUpDuration: 900, // ms of the count-up animation after a result
    liveUpdateFps: 12, // frames per second of the "measuring" animation

    // --- thresholds (used for colour hints) --------------------------------
    pingThresholds: { warn: 80, bad: 200 }, // ms, lower is better
    downloadThresholds: { warn: 20, bad: 5 }, // Mbps, higher is better
    uploadThresholds: { warn: 10, bad: 2 }, // Mbps, higher is better
    colorizeValues: true,

    // --- measurement backend ----------------------------------------------
    speedTestEngine: "auto", // "auto" | "ookla" | "speedtest-cli" | "librespeed" | "http"
    acceptSpeedTestLicense: true, // pass --accept-license/--accept-gdpr to Ookla CLI
    speedTestServerId: null,
    speedTestExtraArgs: [],
    speedTestTimeout: 180 * 1000,

    pingHost: "1.1.1.1",
    pingCount: 3,
    pingMethod: "auto", // "auto" | "icmp" | "tcp"
    pingTcpPort: 443,
    pingTimeout: 8 * 1000,

    connectivityHost: "one.one.one.one",
    connectivityUrl: "https://www.google.com/generate_204",
    connectivityTimeout: 5 * 1000,

    httpFallback: {}, // {downloadUrl, uploadUrl, uploadBytes, maxDurationMs}

    // --- icons (Font Awesome classes, bundled with MagicMirror) ------------
    icons: {
      online: "fa-solid fa-wifi",
      offline: "fa-solid fa-triangle-exclamation",
      ping: "fa-solid fa-stopwatch",
      download: "fa-solid fa-arrow-down",
      upload: "fa-solid fa-arrow-up",
      testing: "fa-solid fa-gauge-high"
    }
  },

  requiresVersion: "2.15.0",

  getStyles () {
    return ["font-awesome.css", this.file("MMM-NetworkStatus.css")];
  },

  getScripts () {
    return [this.file("lib/format.js")];
  },

  getTranslations () {
    return {
      en: "translations/en.json",
      ja: "translations/ja.json",
      de: "translations/de.json",
      fr: "translations/fr.json",
      es: "translations/es.json",
      it: "translations/it.json",
      nl: "translations/nl.json",
      pt: "translations/pt.json",
      "pt-br": "translations/pt-br.json",
      ru: "translations/ru.json",
      pl: "translations/pl.json",
      sv: "translations/sv.json",
      da: "translations/da.json",
      nb: "translations/nb.json",
      fi: "translations/fi.json",
      cs: "translations/cs.json",
      tr: "translations/tr.json",
      hu: "translations/hu.json",
      uk: "translations/uk.json",
      zh_cn: "translations/zh_cn.json",
      zh_tw: "translations/zh_tw.json",
      ko: "translations/ko.json",
      id: "translations/id.json",
      hi: "translations/hi.json",
      ar: "translations/ar.json"
    };
  },

  start () {
    this.fmt = typeof NetworkStatusFormat === "undefined" ? null : NetworkStatusFormat;

    this.state = {
      online: null, // null = unknown yet
      offlineReason: null,
      ping: null,
      jitter: null,
      packetLoss: null,
      download: null,
      upload: null,
      server: null,
      isp: null,
      engine: null,
      lastUpdated: null,
      lastSpeedTest: null,
      error: null,
      checking: false,
      testing: false,
      stage: null, // "ping" | "download" | "upload"
      liveValue: null, // bandwidth being measured right now (bps)
      liveProgress: null
    };

    this.animationFrame = null;
    this.liveTimer = null;
    this.countUp = null;

    this.sendSocketNotification("NETWORK_STATUS_CONFIG", {
      identifier: this.identifier,
      config: this.stripConfig()
    });

    Log.info(`${this.name} started`);
  },

  /**
   * Only forward what the backend really needs.
   */
  stripConfig () {
    const c = this.config;
    return {
      updateInterval: c.updateInterval,
      speedTestInterval: c.speedTestInterval,
      initialSpeedTestDelay: c.initialSpeedTestDelay,
      pauseWhenHidden: c.pauseWhenHidden,
      showPing: c.showPing,
      showDownload: c.showDownload,
      showUpload: c.showUpload,
      speedTestEngine: c.speedTestEngine,
      acceptSpeedTestLicense: c.acceptSpeedTestLicense,
      speedTestServerId: c.speedTestServerId,
      speedTestExtraArgs: c.speedTestExtraArgs,
      speedTestTimeout: c.speedTestTimeout,
      pingHost: c.pingHost,
      pingCount: c.pingCount,
      pingMethod: c.pingMethod,
      pingTcpPort: c.pingTcpPort,
      pingTimeout: c.pingTimeout,
      connectivityHost: c.connectivityHost,
      connectivityUrl: c.connectivityUrl,
      connectivityTimeout: c.connectivityTimeout,
      httpFallback: c.httpFallback
    };
  },

  suspend () {
    this.stopLiveAnimation();
    this.sendSocketNotification("NETWORK_STATUS_SUSPEND", { identifier: this.identifier });
  },

  resume () {
    this.sendSocketNotification("NETWORK_STATUS_RESUME", { identifier: this.identifier });
  },

  notificationReceived (notification) {
    if (notification === "NETWORK_STATUS_FORCE_SPEEDTEST") {
      this.sendSocketNotification("NETWORK_STATUS_FORCE_SPEEDTEST", { identifier: this.identifier });
    } else if (notification === "NETWORK_STATUS_FORCE_CHECK") {
      this.sendSocketNotification("NETWORK_STATUS_FORCE_CHECK", { identifier: this.identifier });
    }
  },

  socketNotificationReceived (notification, payload) {
    if (!payload || payload.identifier !== this.identifier) return;

    switch (notification) {
      case "NETWORK_STATUS_CHECKING":
        this.state.checking = true;
        this.updateDom();
        break;

      case "NETWORK_STATUS_CONNECTIVITY":
        this.state.checking = false;
        this.state.online = payload.online;
        this.state.offlineReason = payload.reason || null;
        this.state.lastUpdated = payload.timestamp || Date.now();
        if (payload.online) {
          this.state.error = null;
          if (payload.ping) {
            this.animateTo("ping", payload.ping.latency);
            this.state.jitter = payload.ping.jitter;
            this.state.packetLoss = payload.ping.packetLoss;
          }
        } else {
          this.stopLiveAnimation();
          this.state.testing = false;
          this.state.stage = null;
        }
        this.updateDom(this.config.animationSpeed);
        break;

      case "NETWORK_STATUS_SPEEDTEST_START":
        this.state.testing = true;
        this.state.error = null;
        this.state.engine = payload.engine || null;
        this.state.stage = "ping";
        this.state.liveValue = null;
        this.state.liveProgress = 0;
        this.startLiveAnimation();
        this.updateDom();
        break;

      case "NETWORK_STATUS_SPEEDTEST_PROGRESS":
        this.state.testing = true;
        this.state.stage = payload.stage || this.state.stage;
        this.state.liveProgress = typeof payload.progress === "number" ? payload.progress : null;
        if (typeof payload.bandwidth === "number") this.state.liveValue = payload.bandwidth;
        if (payload.stage === "ping" && typeof payload.latency === "number") {
          this.state.ping = payload.latency;
        }
        this.startLiveAnimation();
        break;

      case "NETWORK_STATUS_SPEEDTEST_RESULT": {
        this.stopLiveAnimation();
        this.state.testing = false;
        this.state.stage = null;
        this.state.liveValue = null;
        this.state.engine = payload.engine || this.state.engine;
        const r = payload.result || {};
        this.animateTo("ping", r.ping?.latency);
        this.animateTo("download", r.download?.bandwidth);
        this.animateTo("upload", r.upload?.bandwidth);
        this.state.jitter = r.ping?.jitter ?? this.state.jitter;
        this.state.packetLoss = r.ping?.packetLoss ?? this.state.packetLoss;
        this.state.server = r.server || null;
        this.state.isp = r.isp || null;
        this.state.lastSpeedTest = payload.timestamp || Date.now();
        this.state.lastUpdated = this.state.lastSpeedTest;
        this.state.online = true;
        this.updateDom(this.config.animationSpeed);
        break;
      }

      case "NETWORK_STATUS_SPEEDTEST_ERROR":
        this.stopLiveAnimation();
        this.state.testing = false;
        this.state.stage = null;
        this.state.liveValue = null;
        this.state.error = payload.error || "SPEEDTEST_FAILED";
        this.updateDom(this.config.animationSpeed);
        break;

      default:
        break;
    }
  },

  /* ------------------------------------------------------------------ *
   * Animations
   * ------------------------------------------------------------------ */

  /**
   * Animate a metric from its previous value up to the new one, so a
   * finished measurement also "counts" into place.
   */
  animateTo (key, target) {
    if (typeof target !== "number" || !Number.isFinite(target)) {
      if (target === null) this.state[key] = null;
      return;
    }
    if (!this.config.animateMeasurement || !this.fmt) {
      this.state[key] = target;
      return;
    }

    const from = typeof this.state[key] === "number" ? this.state[key] : 0;
    const duration = Math.max(0, this.config.countUpDuration ?? 900);
    if (duration === 0 || Math.abs(target - from) < 1e-9) {
      this.state[key] = target;
      return;
    }

    this.countUp = this.countUp || {};
    this.countUp[key] = { from, target, start: Date.now(), duration };
    this.state[key] = from;
    this.startLiveAnimation();
  },

  startLiveAnimation () {
    if (!this.config.animateMeasurement) {
      this.renderValues();
      return;
    }
    if (this.liveTimer) return;
    const fps = this.fmt ? this.fmt.clamp(this.config.liveUpdateFps ?? 12, 1, 30) : 12;
    this.liveTimer = setInterval(() => this.tickAnimation(), Math.round(1000 / fps));
  },

  stopLiveAnimation () {
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  },

  tickAnimation () {
    let busy = false;

    // Count-up animations of finished values.
    if (this.countUp) {
      const now = Date.now();
      for (const key of Object.keys(this.countUp)) {
        const anim = this.countUp[key];
        const t = (now - anim.start) / anim.duration;
        if (t >= 1) {
          this.state[key] = anim.target;
          delete this.countUp[key];
        } else {
          const eased = this.fmt ? this.fmt.easeOutCubic(t) : t;
          this.state[key] = anim.from + (anim.target - anim.from) * eased;
          busy = true;
        }
      }
    }

    if (this.state.testing) busy = true;
    this.renderValues();
    if (!busy) this.stopLiveAnimation();
  },

  /**
   * Update only the text nodes instead of rebuilding the DOM, which keeps
   * the animation smooth and avoids MagicMirror fade effects per frame.
   */
  renderValues () {
    if (!this.valueNodes) return;
    const nodes = this.valueNodes;

    if (nodes.ping) nodes.ping.textContent = this.pingText();
    if (nodes.download) nodes.download.textContent = this.speedText("download");
    if (nodes.upload) nodes.upload.textContent = this.speedText("upload");

    for (const key of ["ping", "download", "upload"]) {
      const row = this.rowNodes?.[key];
      if (!row) continue;
      row.classList.toggle("measuring", this.state.testing && this.state.stage === key);
    }
  },

  /* ------------------------------------------------------------------ *
   * Value formatting
   * ------------------------------------------------------------------ */

  /**
   * The value shown while a stage is actively being measured. Ookla streams
   * partial bandwidth, otherwise we synthesise a rising number so the user
   * clearly sees "measuring".
   */
  syntheticLiveValue (base) {
    const phase = (Date.now() % 1400) / 1400;
    const reference = Number.isFinite(base) && base > 0 ? base : 1;
    return reference * (0.35 + 0.65 * phase);
  },

  pingText () {
    const s = this.state;
    if (s.online === false) return this.translate("NO_CONNECTION_SHORT");
    if (s.testing && s.stage === "ping") {
      const live = this.syntheticLiveValue(Number.isFinite(s.ping) ? s.ping : 40);
      return this.fmt.formatPing(live, { decimals: this.config.pingDecimals }).text;
    }
    if (!Number.isFinite(s.ping)) return this.placeholder();
    return this.fmt.formatPing(s.ping, { decimals: this.config.pingDecimals }).text;
  },

  speedText (key) {
    const s = this.state;
    if (s.online === false) return this.translate("NO_CONNECTION_SHORT");
    if (s.testing && s.stage === key) {
      const value = Number.isFinite(s.liveValue)
        ? s.liveValue
        : this.syntheticLiveValue(Number.isFinite(s[key]) ? s[key] : 50e6);
      return this.fmt.formatSpeed(value, {
        unit: this.config.speedUnit,
        decimals: this.config.speedDecimals
      }).text;
    }
    if (!Number.isFinite(s[key])) return this.placeholder();
    return this.fmt.formatSpeed(s[key], {
      unit: this.config.speedUnit,
      decimals: this.config.speedDecimals
    }).text;
  },

  placeholder () {
    return "--";
  },

  severityClass (key) {
    if (!this.config.colorizeValues || this.state.testing) return "";
    const s = this.state;
    if (key === "ping") {
      if (!Number.isFinite(s.ping)) return "";
      const level = this.fmt.severity(s.ping, this.config.pingThresholds, "lower-is-better");
      return level ? `level-${level}` : "";
    }
    if (!Number.isFinite(s[key])) return "";
    const mbps = s[key] / 1e6;
    const thresholds = key === "download" ? this.config.downloadThresholds : this.config.uploadThresholds;
    const level = this.fmt.severity(mbps, thresholds, "higher-is-better");
    return level ? `level-${level}` : "";
  },

  /* ------------------------------------------------------------------ *
   * DOM
   * ------------------------------------------------------------------ */

  getDom () {
    const wrapper = document.createElement("div");
    wrapper.className = [
      "mmm-networkstatus",
      `layout-${this.config.layout}`,
      `align-${this.config.alignment}`,
      `size-${this.config.fontSize}`
    ].join(" ");

    if (!this.fmt) {
      wrapper.className = "mmm-networkstatus dimmed light small";
      wrapper.textContent = this.translate("LOADING");
      return wrapper;
    }

    if (this.state.online === false) wrapper.classList.add("offline");
    if (this.state.testing) wrapper.classList.add("testing");

    this.valueNodes = {};
    this.rowNodes = {};

    if (this.config.showStatus) wrapper.appendChild(this.buildStatusRow());
    if (this.config.showPing) wrapper.appendChild(this.buildMetricRow("ping"));
    if (this.config.showDownload) wrapper.appendChild(this.buildMetricRow("download"));
    if (this.config.showUpload) wrapper.appendChild(this.buildMetricRow("upload"));

    const footer = this.buildFooter();
    if (footer) wrapper.appendChild(footer);

    // Fill in the current values right away.
    this.renderValues();
    return wrapper;
  },

  buildStatusRow () {
    const row = document.createElement("div");
    row.className = "ns-row ns-status";

    const offline = this.state.online === false;
    const unknown = this.state.online === null;

    if (this.config.showIcons) {
      const icon = document.createElement("span");
      const iconClass = offline
        ? this.config.icons.offline
        : this.state.testing
          ? this.config.icons.testing
          : this.config.icons.online;
      icon.className = `ns-icon ${iconClass}`;
      if (this.state.testing) icon.classList.add("spin");
      row.appendChild(icon);
    }

    const text = document.createElement("span");
    text.className = "ns-status-text";
    if (offline) {
      text.classList.add("ns-alert");
      text.textContent = this.translate("OFFLINE_WARNING");
    } else if (unknown) {
      text.classList.add("dimmed");
      text.textContent = this.translate("CHECKING");
    } else if (this.state.testing) {
      text.textContent = this.translate("MEASURING");
    } else {
      text.classList.add("ns-ok");
      text.textContent = this.translate("ONLINE");
    }
    row.appendChild(text);

    if (offline && this.state.offlineReason) {
      const reason = document.createElement("span");
      reason.className = "ns-reason";
      reason.textContent = this.state.offlineReason;
      row.appendChild(reason);
    }

    this.rowNodes.status = row;
    return row;
  },

  buildMetricRow (key) {
    const row = document.createElement("div");
    row.className = `ns-row ns-${key}`;
    if (this.state.testing && this.state.stage === key) row.classList.add("measuring");

    if (this.config.showIcons) {
      const icon = document.createElement("span");
      icon.className = `ns-icon ${this.config.icons[key]}`;
      row.appendChild(icon);
    }

    if (this.config.showLabels) {
      const label = document.createElement("span");
      label.className = "ns-label";
      label.textContent = this.translate(key.toUpperCase());
      row.appendChild(label);
    }

    const value = document.createElement("span");
    value.className = `ns-value ${this.severityClass(key)}`.trim();
    if (this.state.online === false) value.classList.add("ns-alert");
    row.appendChild(value);

    this.valueNodes[key] = value;

    // Extra details for the ping row.
    if (key === "ping" && this.state.online !== false) {
      const extras = [];
      if (this.config.showJitter && Number.isFinite(this.state.jitter)) {
        extras.push(`${this.translate("JITTER")} ${this.fmt.formatPing(this.state.jitter, { decimals: 0 }).text}`);
      }
      if (this.config.showPacketLoss && Number.isFinite(this.state.packetLoss)) {
        extras.push(`${this.translate("PACKET_LOSS")} ${this.fmt.toFixed(this.state.packetLoss, 0)}%`);
      }
      if (extras.length) {
        const extra = document.createElement("span");
        extra.className = "ns-extra dimmed";
        extra.textContent = extras.join(" · ");
        row.appendChild(extra);
      }
    }

    this.rowNodes[key] = row;
    return row;
  },

  buildFooter () {
    const parts = [];

    if (this.state.error) {
      parts.push(`${this.translate("SPEEDTEST_ERROR")}: ${this.state.error}`);
    }
    if (this.config.showServerInfo && this.state.server) {
      const server = [this.state.server.name, this.state.server.location].filter(Boolean).join(" · ");
      if (server) parts.push(server);
    }
    if (this.config.showLastUpdated && this.state.lastUpdated) {
      const age = this.fmt.relativeAge(this.state.lastUpdated, Date.now(Date.now()));
      parts.push(
        this.translate("UPDATED", {
          time: `${age.amount} ${this.translate(age.unit)}`,
          fallback: `${this.translate("UPDATED")} {time}`
        })
      );
    }

    if (!parts.length) return null;

    const footer = document.createElement("div");
    footer.className = "ns-footer xsmall dimmed";
    if (this.state.error) footer.classList.add("ns-error");
    footer.textContent = parts.join(" | ");
    return footer;
  }
});
