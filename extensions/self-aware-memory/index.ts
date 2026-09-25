/**
 * pi-self-aware-memory — auditable, in-series context compaction.
 *
 * The agent marks work units open/closed and, at close, writes its own stub
 * while the reasoning is still warm; the same model on the same warm prefix
 * audits the stub in one appended in-series turn; only then is the raw span
 * projected out with pi's append-only context edits. The session file keeps
 * every original byte, so every fold is reversible and offline-auditable.
 *
 * ── P0 scaffold (this file) ─────────────────────────────────────────────
 * Behaviour is deliberately nil: the extension loads, announces once at
 * session start, and serves the /sam status surface. It registers no tool,
 * writes no session entries, drafts no context edits, and sends no messages.
 * Nothing here can mutate a session; every handler is fail-open by
 * construction (F1), so a bug in the scaffold degrades to silence.
 *
 * Phases P1–P4 fill in the auditor, folder, ledger and governor (plan
 * §4/§6); the /sam surface below keeps its names — /sam fold · /sam report ·
 * /sam undo answer "not yet" until their phase lands.
 *
 * Output channels (see src/output.ts): UI notification where a UI exists,
 * stderr in print mode, silence in json mode (stdout is the event stream).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EXTENSION_NAME, SAM_VERSION, describeBuild } from "../../src/identity.ts";
import { renderSamStatus, samOutputChannel } from "../../src/output.ts";
import { createSamState, isSamMode, SAM_MODES } from "../../src/state.ts";

/** Process-local state; one pi process drives one session at a time.
 * Rebuilt from the ledger on load from P2 onward. */
const state = createSamState();

function emit(ctx: ExtensionContext, text: string, uiType: "info" | "error" = "info"): void {
  const channel = samOutputChannel(ctx.hasUI, ctx.mode);
  if (channel === "ui") ctx.ui.notify(text, uiType);
  else if (channel === "stderr") console.error(text);
  // "none" (json mode): no output — the JSON stream must stay parseable.
}

function modelInfo(ctx: ExtensionContext): { provider: string; id: string } | undefined {
  const m = ctx.model;
  return m ? { provider: m.provider, id: m.id } : undefined;
}

function statusText(ctx: ExtensionContext): string {
  return renderSamStatus({
    state,
    usage: ctx.getContextUsage(),
    model: modelInfo(ctx),
  }).join("\n");
}

export default function factory(pi: ExtensionAPI): void {
  // Announce once per session start, in every reason (startup/resume/reload/
  // new/fork). Quiet by design: one line, no footer, no widget.
  pi.on("session_start", (_event, ctx) => {
    emit(ctx, `${EXTENSION_NAME} ${SAM_VERSION} loaded — /sam for status · ${describeBuild()}`);
  });

  pi.registerCommand("sam", {
    description:
      "pi-self-aware-memory status: /sam · /sam mode <display|manual|assisted|auto> · fold/report/undo (P2)",
    handler: async (args: string, ctx: ExtensionContext) => {
      try {
        const arg = args.trim();
        if (arg === "") {
          emit(ctx, statusText(ctx));
          return;
        }
        const [head, ...rest] = arg.split(/\s+/);
        if (head === "mode") {
          const target = rest[0];
          if (target === undefined) {
            emit(ctx, statusText(ctx)); // bare "/sam mode" = show current status
            return;
          }
          if (!isSamMode(target)) {
            emit(
              ctx,
              `sam: unknown mode '${target}' — one of: ${SAM_MODES.join(" | ")}`,
              "error",
            );
            return;
          }
          state.mode = target;
          emit(ctx, `sam: mode is now '${state.mode}' (this session only; persisted settings come with P3)`);
          return;
        }
        if (head === "fold" || head === "report" || head === "undo") {
          emit(ctx, `sam: '/sam ${head}' is planned but not yet implemented (phase P2) — the P0 scaffold folds nothing`);
          return;
        }
        emit(ctx, `sam: unknown subcommand '${head}' — /sam · /sam mode <m> · fold · report · undo`, "error");
      } catch (err) {
        // F1 fail-open: the status surface must never take a session down.
        emit(ctx, `sam: internal error (no state changed): ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
