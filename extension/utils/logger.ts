/**
 * Logger utility for the jev-browser-use extension.
 * Logs to console and optionally sends to relay server.
 */

export type LogLevel = "log" | "debug" | "error";

export interface LogMessage {
  method: "log";
  params: {
    level: LogLevel;
    args: string[];
  };
}

export type SendMessageFn = (message: unknown) => void;

/**
 * Creates a logger instance that logs to console and sends to relay.
 */
export function createLogger(sendMessage: SendMessageFn) {
  function formatArgs(args: unknown[]): string[] {
    return args.map((arg) => {
      if (arg === undefined) return "undefined";
      if (arg === null) return "null";
      if (typeof arg === "object") {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    });
  }

  function sendLog(level: LogLevel, args: unknown[]): void {
    sendMessage({
      method: "log",
      params: {
        level,
        args: formatArgs(args),
      },
    });
  }

  return {
    log: (...args: unknown[]) => {
      console.log("[jev-browser-use]", ...args);
      sendLog("log", args);
    },
    debug: (...args: unknown[]) => {
      console.debug("[jev-browser-use]", ...args);
      sendLog("debug", args);
    },
    error: (...args: unknown[]) => {
      console.error("[jev-browser-use]", ...args);
      sendLog("error", args);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
