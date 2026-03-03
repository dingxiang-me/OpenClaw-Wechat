import { spawn } from "node:child_process";

function assertFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`createVoiceTranscriptionProcessRuntime: ${name} is required`);
  }
}

export function createVoiceTranscriptionProcessRuntime({
  runProcessWithTimeoutImpl,
  checkCommandAvailableImpl,
} = {}) {
  const ffmpegPathCheckCache = {
    checked: false,
    available: false,
  };
  const commandPathCheckCache = new Map();

  function runProcessWithTimeout({ command, args, timeoutMs = 15000, allowNonZeroExitCode = false }) {
    if (typeof runProcessWithTimeoutImpl === "function") {
      return runProcessWithTimeoutImpl({ command, args, timeoutMs, allowNonZeroExitCode });
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, timeoutMs)
          : null;

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 4000) stdout = stdout.slice(-4000);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`${command} timed out after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0 && !allowNonZeroExitCode) {
          reject(new Error(`${command} exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
          return;
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      });
    });
  }

  async function checkCommandAvailable(command) {
    const normalized = String(command ?? "").trim();
    if (!normalized) return false;

    if (typeof checkCommandAvailableImpl === "function") {
      return checkCommandAvailableImpl(normalized);
    }

    if (commandPathCheckCache.has(normalized)) {
      return commandPathCheckCache.get(normalized);
    }
    try {
      await runProcessWithTimeout({
        command: normalized,
        args: ["--help"],
        timeoutMs: 4000,
        allowNonZeroExitCode: true,
      });
      commandPathCheckCache.set(normalized, true);
      return true;
    } catch {
      commandPathCheckCache.set(normalized, false);
      return false;
    }
  }

  async function ensureFfmpegAvailable(logger) {
    if (ffmpegPathCheckCache.checked) return ffmpegPathCheckCache.available;
    const available = await checkCommandAvailable("ffmpeg");
    ffmpegPathCheckCache.checked = true;
    ffmpegPathCheckCache.available = available;
    if (!available) {
      logger?.warn?.("wecom: ffmpeg not available");
    }
    return available;
  }

  async function resolveLocalWhisperCommand({ voiceConfig, logger }) {
    const provider = String(voiceConfig?.provider ?? "").trim().toLowerCase();
    const explicitCommand = String(voiceConfig?.command ?? "").trim();
    const fallbackCandidates =
      provider === "local-whisper"
        ? ["whisper"]
        : provider === "local-whisper-cli"
          ? ["whisper-cli"]
          : [];
    const candidates = explicitCommand ? [explicitCommand, ...fallbackCandidates] : fallbackCandidates;

    if (candidates.length === 0) {
      throw new Error(
        `unsupported voice transcription provider: ${provider || "unknown"} (supported: local-whisper-cli/local-whisper)`,
      );
    }

    for (const cmd of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await checkCommandAvailable(cmd)) {
        if (explicitCommand && cmd !== explicitCommand) {
          logger?.warn?.(`wecom: voice command ${explicitCommand} unavailable, fallback to ${cmd}`);
        }
        return cmd;
      }
    }

    throw new Error(`local transcription command not found: ${candidates.join(" / ")}`);
  }

  assertFunction("runProcessWithTimeout", runProcessWithTimeout);
  assertFunction("checkCommandAvailable", checkCommandAvailable);
  assertFunction("ensureFfmpegAvailable", ensureFfmpegAvailable);
  assertFunction("resolveLocalWhisperCommand", resolveLocalWhisperCommand);

  return {
    runProcessWithTimeout,
    checkCommandAvailable,
    ensureFfmpegAvailable,
    resolveLocalWhisperCommand,
  };
}
