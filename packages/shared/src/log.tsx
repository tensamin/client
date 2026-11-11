import { toast as sonnerToast } from "@nonanium/ui";
import { Info, TriangleAlert } from "lucide-react";
import type { MTPLogEvent } from "mtp";

export function log(
  logLevel: number,
  logger: string,
  color:
    | "red"
    | "green"
    | "yellow"
    | "orange"
    | "purple"
    | "blue"
    | "cyan"
    | "white"
    | "black"
    | "gray",
  ...args: unknown[]
) {
  const currentLogLevel = Number(localStorage.getItem("log_level") || 0);

  if (logLevel > currentLogLevel) return;

  const resetCode = "\x1b[0m";
  const colorCodes: Record<typeof color, string> = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    orange: "\x1b[38;5;208m",
    purple: "\x1b[35m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
    white: "\x1b[37m",
    black: "\x1b[30m",
    gray: "\x1b[90m",
  };

  if (args.length === 1) {
    console.log(`${colorCodes[color]}${logger}${resetCode} ${args[0]}`);

    return;
  }

  console.groupCollapsed(
    `${colorCodes[color]}${logger}${resetCode} ${args[0]}`,
  );

  try {
    for (const arg of args.slice(1)) {
      console.log(arg);
    }
  } finally {
    console.groupEnd();
  }
}

export function logMTP(
  event: MTPLogEvent,
  hiddenTypes: readonly string[] = ["Ping", "Pong"],
) {
  if (hiddenTypes.includes(event.type)) return;
  const direction =
    event.direction === "send"
      ? "Send "
      : event.direction === "recv"
        ? "Receive "
        : "";
  // Protocol payloads and error objects can contain credentials or bearer tokens.
  const details: unknown[] = [];

  if ("relay" in event && event.relay) {
    const { signerId, finalRecipientId, messageId, createdAt } = event.relay;
    details.push({ signerId, finalRecipientId, messageId, createdAt });
  }

  log(
    event.hint === "info" ? (event.direction ? 3 : 2) : 1,
    "mtp",
    event.hint === "error"
      ? "red"
      : event.hint === "warning"
        ? "orange"
        : "white",
    `${direction}${event.type}`,
    ...details,
  );
}

const size = 20;
export function toast(
  type: "error" | "info" | "warn" | "success",
  message: string,
  description?: string,
  options?: {
    duration?: number;
    closeButton?: boolean;
    id?: string | number;
  },
) {
  switch (type) {
    case "error":
      sonnerToast.error(message, {
        description,
        ...options,
      });
      break;
    case "info":
      sonnerToast(message, {
        icon: <Info size={size} />,
        description,
        ...options,
      });
      break;
    case "warn":
      sonnerToast(message, {
        icon: <TriangleAlert size={size} />,
        description,
        ...options,
      });
      break;
    case "success":
      sonnerToast.success(message, {
        description,
        ...options,
      });
      break;
  }
}
