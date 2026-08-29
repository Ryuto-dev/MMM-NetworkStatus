/* MMM-NetworkStatus - lib/format.js
 *
 * Pure formatting helpers shared by the frontend module, the node helper
 * and the unit tests. Written as a UMD-ish module so the very same file can
 * be loaded by the browser (through `getScripts()`) and by Node.js
 * (through `require()`).
 *
 * MIT Licensed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.NetworkStatusFormat = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const BIT_UNITS = ["bps", "kbps", "Mbps", "Gbps", "Tbps"];
  const BYTE_UNITS = ["B/s", "kB/s", "MB/s", "GB/s", "TB/s"];

  /**
   * Clamp a number into [min, max].
   */
  function clamp (value, min, max) {
    if (!Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Round a number to a fixed amount of decimals and return it as string.
   * Keeps "0" instead of "0.00" free of surprises for integer decimals.
   */
  function toFixed (value, decimals) {
    const d = clamp(Math.round(decimals ?? 1), 0, 4);
    if (!Number.isFinite(value)) return (0).toFixed(d);
    return value.toFixed(d);
  }

  /**
   * Auto-scale a speed given in bits per second.
   *
   * @param {number} bps speed in bits per second
   * @param {object} [options]
   * @param {string} [options.unit] "auto" | "bps" | "kbps" | "Mbps" | "Gbps" | "MB/s" ...
   * @param {number} [options.decimals]
   * @returns {{value: number, unit: string, text: string}}
   */
  function formatSpeed (bps, options) {
    const opts = options || {};
    const unit = opts.unit || "auto";
    const decimals = opts.decimals ?? 1;
    const safe = Number.isFinite(bps) && bps > 0 ? bps : 0;

    // Explicit unit requested.
    const bitIndex = BIT_UNITS.indexOf(unit);
    if (bitIndex >= 0) {
      const value = safe / Math.pow(1000, bitIndex);
      return { value, unit, text: `${toFixed(value, decimals)} ${unit}` };
    }
    const byteIndex = BYTE_UNITS.indexOf(unit);
    if (byteIndex >= 0) {
      const value = safe / 8 / Math.pow(1000, byteIndex);
      return { value, unit, text: `${toFixed(value, decimals)} ${unit}` };
    }

    // "bytes" keeps auto scaling but switches to byte based units.
    const useBytes = unit === "bytes" || unit === "auto-bytes";
    const units = useBytes ? BYTE_UNITS : BIT_UNITS;
    let value = useBytes ? safe / 8 : safe;
    let index = 0;
    while (value >= 1000 && index < units.length - 1) {
      value /= 1000;
      index += 1;
    }
    // Below 1 Mbps we still prefer Mbps readability for typical mirrors,
    // except when the value is really tiny.
    return {
      value,
      unit: units[index],
      text: `${toFixed(value, decimals)} ${units[index]}`
    };
  }

  /**
   * Format a latency value in milliseconds.
   */
  function formatPing (ms, options) {
    const opts = options || {};
    const decimals = opts.decimals ?? 0;
    if (!Number.isFinite(ms) || ms < 0) {
      return { value: 0, unit: "ms", text: `-- ms` };
    }
    return { value: ms, unit: "ms", text: `${toFixed(ms, decimals)} ms` };
  }

  /**
   * Human readable "x minutes ago" style relative time without moment.js.
   *
   * @param {number} timestamp epoch millis
   * @param {number} now epoch millis
   * @returns {{unit: "SECONDS"|"MINUTES"|"HOURS"|"DAYS", amount: number}}
   */
  function relativeAge (timestamp, now) {
    const delta = Math.max(0, (now ?? Date.now()) - (timestamp ?? 0));
    const seconds = Math.floor(delta / 1000);
    if (seconds < 60) return { unit: "SECONDS", amount: seconds };
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return { unit: "MINUTES", amount: minutes };
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return { unit: "HOURS", amount: hours };
    return { unit: "DAYS", amount: Math.floor(hours / 24) };
  }

  /**
   * Decide the severity class of a measured value against thresholds.
   *
   * @param {number} value measured value
   * @param {object} thresholds {warn, bad}
   * @param {"lower-is-better"|"higher-is-better"} direction
   * @returns {"good"|"warn"|"bad"|null}
   */
  function severity (value, thresholds, direction) {
    if (!thresholds || !Number.isFinite(value)) return null;
    const { warn, bad } = thresholds;
    if (!Number.isFinite(warn) && !Number.isFinite(bad)) return null;

    if (direction === "higher-is-better") {
      if (Number.isFinite(bad) && value <= bad) return "bad";
      if (Number.isFinite(warn) && value <= warn) return "warn";
      return "good";
    }
    if (Number.isFinite(bad) && value >= bad) return "bad";
    if (Number.isFinite(warn) && value >= warn) return "warn";
    return "good";
  }

  /**
   * Ease-out interpolation used by the "counting up" animation.
   */
  function easeOutCubic (t) {
    const x = clamp(t, 0, 1);
    return 1 - Math.pow(1 - x, 3);
  }

  return {
    BIT_UNITS,
    BYTE_UNITS,
    clamp,
    toFixed,
    formatSpeed,
    formatPing,
    relativeAge,
    severity,
    easeOutCubic
  };
});
