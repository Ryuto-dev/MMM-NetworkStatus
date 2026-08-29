/* MMM-NetworkStatus - node_helper.js
 *
 * Backend of the module. It owns all scheduling and measurement work:
 *
 *   1. a fast connectivity/ping loop (default every 30s)
 *   2. a slower speed test loop (default every 30 min)
 *   3. live progress events while a speed test runs, so the frontend can
 *      animate counting numbers
 *
 * Only one instance of the helper exists even when several module instances
 * are configured, therefore state is kept per instance identifier and the
 * heavy work (speed test) is shared/deduplicated.
 *
 * MIT Licensed.
 */
"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");

const probes = require("./lib/probes");

module.exports = NodeHelper.create({
  requiresVersion: "2.15.0",

  start () {
    this.instances = new Map();
    this.engine = null;
    this.engineDetectionPromise = null;
    this.speedTestRunning = false;
    Log.info(`${this.name} helper started`);
  },

  stop () {
    for (const instance of this.instances.values()) {
      this.clearTimers(instance);
    }
    this.instances.clear();
    Log.info(`${this.name} helper stopped`);
  },

  socketNotificationReceived (notification, payload) {
    switch (notification) {
      case "NETWORK_STATUS_CONFIG":
        this.registerInstance(payload);
        break;
      case "NETWORK_STATUS_FORCE_CHECK":
        this.runConnectivityCycle(payload?.identifier, true);
        break;
      case "NETWORK_STATUS_FORCE_SPEEDTEST":
        this.runSpeedTestCycle(payload?.identifier, true);
        break;
      case "NETWORK_STATUS_SUSPEND":
        this.setSuspended(payload?.identifier, true);
        break;
      case "NETWORK_STATUS_RESUME":
        this.setSuspended(payload?.identifier, false);
        break;
      default:
        break;
    }
  },

  /* ---------------------------------------------------------------- *
   * Instance bookkeeping
   * ---------------------------------------------------------------- */

  registerInstance (payload) {
    if (!payload || !payload.identifier) return;
    const { identifier, config } = payload;

    const existing = this.instances.get(identifier);
    if (existing) {
      this.clearTimers(existing);
    }

    const instance = {
      identifier,
      config: config || {},
      suspended: false,
      timers: { connectivity: null, speedtest: null },
      lastSpeedTest: null
    };
    this.instances.set(identifier, instance);

    // Kick off immediately, then schedule.
    this.runConnectivityCycle(identifier, true);
    this.scheduleConnectivity(instance);

    if (this.speedTestEnabled(instance)) {
      const delay = Math.max(0, instance.config.initialSpeedTestDelay ?? 5000);
      instance.timers.initial = setTimeout(() => {
        this.runSpeedTestCycle(identifier, true);
        this.scheduleSpeedTest(instance);
      }, delay);
    }
  },

  speedTestEnabled (instance) {
    return instance.config.showDownload !== false || instance.config.showUpload !== false;
  },

  clearTimers (instance) {
    if (!instance) return;
    for (const key of Object.keys(instance.timers)) {
      if (instance.timers[key]) clearTimeout(instance.timers[key]);
      instance.timers[key] = null;
    }
  },

  setSuspended (identifier, suspended) {
    const instance = this.instances.get(identifier);
    if (!instance) return;
    instance.suspended = Boolean(suspended);
    if (suspended && instance.config.pauseWhenHidden !== false) {
      this.clearTimers(instance);
    } else if (!suspended) {
      this.scheduleConnectivity(instance);
      if (this.speedTestEnabled(instance)) this.scheduleSpeedTest(instance);
    }
  },

  scheduleConnectivity (instance) {
    if (instance.timers.connectivity) clearTimeout(instance.timers.connectivity);
    const interval = Math.max(5000, instance.config.updateInterval ?? 30000);
    instance.timers.connectivity = setTimeout(async () => {
      await this.runConnectivityCycle(instance.identifier, false);
      if (this.instances.has(instance.identifier)) this.scheduleConnectivity(instance);
    }, interval);
  },

  scheduleSpeedTest (instance) {
    if (instance.timers.speedtest) clearTimeout(instance.timers.speedtest);
    const interval = Math.max(60000, instance.config.speedTestInterval ?? 30 * 60 * 1000);
    instance.timers.speedtest = setTimeout(async () => {
      await this.runSpeedTestCycle(instance.identifier, false);
      if (this.instances.has(instance.identifier)) this.scheduleSpeedTest(instance);
    }, interval);
  },

  /* ---------------------------------------------------------------- *
   * Connectivity + ping
   * ---------------------------------------------------------------- */

  async runConnectivityCycle (identifier, force) {
    const instance = this.instances.get(identifier);
    if (!instance) return;
    if (instance.suspended && !force && instance.config.pauseWhenHidden !== false) return;

    const config = instance.config;
    this.send(identifier, "NETWORK_STATUS_CHECKING", { stage: "connectivity" });

    const connectivity = await probes.checkConnectivity({
      host: config.connectivityHost || config.pingHost || "one.one.one.one",
      url: config.connectivityUrl,
      timeout: config.connectivityTimeout ?? 5000
    });

    let ping = { latency: null, jitter: null, packetLoss: null, method: null, error: null };
    if (connectivity.online && config.showPing !== false) {
      ping = await probes.measurePing({
        host: config.pingHost || "1.1.1.1",
        count: config.pingCount ?? 3,
        timeout: config.pingTimeout ?? 8000,
        method: config.pingMethod || "auto",
        tcpPort: config.pingTcpPort ?? 443
      });
    }

    this.send(identifier, "NETWORK_STATUS_CONNECTIVITY", {
      online: connectivity.online,
      reason: connectivity.reason,
      ping: {
        latency: ping.latency,
        jitter: ping.jitter,
        packetLoss: ping.packetLoss,
        method: ping.method,
        error: ping.error
      },
      timestamp: Date.now()
    });
  },

  /* ---------------------------------------------------------------- *
   * Speed test
   * ---------------------------------------------------------------- */

  async resolveEngine (preferred) {
    if (this.engine && (preferred === "auto" || preferred === this.engine)) return this.engine;
    if (!this.engineDetectionPromise) {
      this.engineDetectionPromise = probes
        .detectEngine(preferred || "auto")
        .then((engine) => {
          this.engine = engine;
          this.engineDetectionPromise = null;
          Log.info(`${this.name}: using speed test engine "${engine}"`);
          return engine;
        })
        .catch((err) => {
          this.engineDetectionPromise = null;
          Log.error(`${this.name}: engine detection failed - ${err.message}`);
          this.engine = "http";
          return "http";
        });
    }
    return this.engineDetectionPromise;
  },

  async runSpeedTestCycle (identifier, force) {
    const instance = this.instances.get(identifier);
    if (!instance) return;
    if (!this.speedTestEnabled(instance)) return;
    if (instance.suspended && !force && instance.config.pauseWhenHidden !== false) return;

    if (this.speedTestRunning) {
      Log.debug(`${this.name}: speed test already running, skipping`);
      return;
    }

    const config = instance.config;

    // Never start a test while offline - it would only waste time.
    const connectivity = await probes.checkConnectivity({
      host: config.connectivityHost || config.pingHost || "one.one.one.one",
      url: config.connectivityUrl,
      timeout: config.connectivityTimeout ?? 5000
    });
    if (!connectivity.online) {
      this.send(identifier, "NETWORK_STATUS_CONNECTIVITY", {
        online: false,
        reason: connectivity.reason,
        ping: { latency: null, jitter: null, packetLoss: null, method: null, error: null },
        timestamp: Date.now()
      });
      return;
    }

    this.speedTestRunning = true;
    const engine = await this.resolveEngine(config.speedTestEngine || "auto");
    const targets = this.identifiersForBroadcast(identifier);

    this.broadcast(targets, "NETWORK_STATUS_SPEEDTEST_START", { engine, timestamp: Date.now() });

    try {
      const outcome = await probes.runSpeedTest(
        {
          engine,
          preferredEngine: config.speedTestEngine || "auto",
          acceptLicense: config.acceptSpeedTestLicense !== false,
          serverId: config.speedTestServerId || null,
          extraArgs: config.speedTestExtraArgs || [],
          timeout: config.speedTestTimeout ?? 180000,
          pingHost: config.pingHost || "1.1.1.1",
          pingCount: config.pingCount ?? 3,
          http: config.httpFallback || {}
        },
        (update) => {
          this.broadcast(targets, "NETWORK_STATUS_SPEEDTEST_PROGRESS", update);
        }
      );

      if (outcome.ok && outcome.result) {
        instance.lastSpeedTest = outcome.result;
        this.broadcast(targets, "NETWORK_STATUS_SPEEDTEST_RESULT", {
          engine: outcome.engine,
          result: outcome.result,
          timestamp: Date.now()
        });
      } else {
        Log.warn(`${this.name}: speed test failed - ${outcome.error}`);
        this.broadcast(targets, "NETWORK_STATUS_SPEEDTEST_ERROR", {
          engine: outcome.engine,
          error: outcome.error,
          timestamp: Date.now()
        });
      }
    } catch (err) {
      Log.error(`${this.name}: speed test crashed - ${err.message}`);
      this.broadcast(targets, "NETWORK_STATUS_SPEEDTEST_ERROR", {
        engine,
        error: err.message,
        timestamp: Date.now()
      });
    } finally {
      this.speedTestRunning = false;
    }
  },

  /**
   * A running speed test saturates the line, so all module instances should
   * receive the same live data instead of queuing their own test.
   */
  identifiersForBroadcast (identifier) {
    const ids = [...this.instances.keys()];
    return ids.length ? ids : [identifier];
  },

  broadcast (identifiers, notification, payload) {
    for (const identifier of identifiers) {
      this.send(identifier, notification, payload);
    }
  },

  send (identifier, notification, payload) {
    if (!identifier) return;
    this.sendSocketNotification(notification, { identifier, ...payload });
  }
});
