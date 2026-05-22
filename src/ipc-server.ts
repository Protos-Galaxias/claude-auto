import { createServer, type Server } from "node:net";
import { chmodSync, existsSync, rmSync } from "node:fs";

export interface StopEvent {
  hook_event_name: "Stop";
  session_id: string;
  transcript_path: string;
  last_assistant_message?: string;
  agent_id?: string;
}

export interface SubagentStopEvent {
  hook_event_name: "SubagentStop";
  session_id: string;
  agent_id: string;
  agent_type: string;
  agent_transcript_path?: string;
  last_assistant_message?: string;
}

export interface StopFailureEvent {
  hook_event_name: "StopFailure";
  session_id: string;
  error: string;
  error_details?: string;
  last_assistant_message?: string;
}

export interface PreToolUseEvent {
  hook_event_name: "PreToolUse";
  session_id: string;
  tool_name: string;
  tool_input?: unknown;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
}

export type HookEvent =
  | StopEvent
  | SubagentStopEvent
  | StopFailureEvent
  | PreToolUseEvent;

export interface IpcServerOptions {
  /** Called for every parsed hook event, before terminal-event routing. */
  onEvent?: (ev: HookEvent) => void;
}

export interface IpcServerHandle {
  server: Server;
  /** Resolves with the terminating event (main Stop or StopFailure). */
  done: Promise<StopEvent | StopFailureEvent>;
  /** Mutated as SubagentStop events arrive. */
  subagents: SubagentStopEvent[];
  /** Close server and remove socket file. Safe to call multiple times. */
  close: () => void;
}

export function startIpcServer(
  sockPath: string,
  opts: IpcServerOptions = {}
): IpcServerHandle {
  if (existsSync(sockPath)) {
    rmSync(sockPath, { force: true });
  }

  const subagents: SubagentStopEvent[] = [];
  let resolveDone!: (e: StopEvent | StopFailureEvent) => void;
  let rejectDone!: (err: Error) => void;
  const done = new Promise<StopEvent | StopFailureEvent>((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  const server = createServer((sock) => {
    const chunks: Buffer[] = [];
    sock.on("data", (c) => chunks.push(c));
    sock.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        return;
      }
      try {
        const ev = JSON.parse(raw) as HookEvent;
        handleEvent(ev, subagents, resolveDone, opts.onEvent);
      } catch (err) {
        rejectDone(new Error(`Bad hook payload: ${err instanceof Error ? err.message : err}`));
      }
    });
    sock.on("error", () => {});
  });

  server.on("error", rejectDone);
  server.listen(sockPath, () => {
    try {
      chmodSync(sockPath, 0o600);
    } catch {}
  });

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      server.close();
    } catch {}
    try {
      if (existsSync(sockPath)) {
        rmSync(sockPath, { force: true });
      }
    } catch {}
  };

  return { server, done, subagents, close };
}

function handleEvent(
  ev: HookEvent,
  subagents: SubagentStopEvent[],
  resolveDone: (e: StopEvent | StopFailureEvent) => void,
  onEvent?: (ev: HookEvent) => void
): void {
  if (onEvent) {
    try {
      onEvent(ev);
    } catch {
      // Listener errors must not break the IPC loop.
    }
  }

  if (ev.hook_event_name === "SubagentStop") {
    subagents.push(ev);

    return;
  }
  if (ev.hook_event_name === "Stop" && !ev.agent_id) {
    resolveDone(ev);

    return;
  }
  if (ev.hook_event_name === "StopFailure") {
    resolveDone(ev);
  }
}
