import { readFile, unlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { createVoiceTranscriptionProcessRuntime } from "./voice-transcription-process.js";

export function createWecomVoiceTranscriber({
  tempDirName = "openclaw-wechat",
  resolveVoiceTranscriptionConfig,
  normalizeAudioContentType,
  isLocalVoiceInputTypeDirectlySupported,
  pickAudioFileExtension,
  processEnv = process.env,
  checkCommandAvailableImpl,
  runProcessWithTimeoutImpl,
} = {}) {
  if (typeof resolveVoiceTranscriptionConfig !== "function") {
    throw new Error("createWecomVoiceTranscriber: resolveVoiceTranscriptionConfig is required");
  }
  if (typeof normalizeAudioContentType !== "function") {
    throw new Error("createWecomVoiceTranscriber: normalizeAudioContentType is required");
  }
  if (typeof isLocalVoiceInputTypeDirectlySupported !== "function") {
    throw new Error("createWecomVoiceTranscriber: isLocalVoiceInputTypeDirectlySupported is required");
  }
  if (typeof pickAudioFileExtension !== "function") {
    throw new Error("createWecomVoiceTranscriber: pickAudioFileExtension is required");
  }

  const processRuntime = createVoiceTranscriptionProcessRuntime({
    runProcessWithTimeoutImpl,
    checkCommandAvailableImpl,
  });
  const {
    runProcessWithTimeout,
    checkCommandAvailable,
    ensureFfmpegAvailable,
    resolveLocalWhisperCommand,
  } = processRuntime;

  function resolveWecomVoiceTranscriptionConfig(api) {
    const cfg = api?.config ?? {};
    return resolveVoiceTranscriptionConfig({
      channelConfig: cfg?.channels?.wecom,
      envVars: cfg?.env?.vars ?? {},
      processEnv,
    });
  }

  async function transcodeAudioToWav({ buffer, inputContentType, inputFileName, logger, timeoutMs = 30000 }) {
    const tempDir = join(tmpdir(), tempDirName);
    await mkdir(tempDir, { recursive: true });
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const inputExt = pickAudioFileExtension({ contentType: inputContentType, fileName: inputFileName });
    const inputPath = join(tempDir, `voice-input-${nonce}${inputExt || ".bin"}`);
    const outputPath = join(tempDir, `voice-output-${nonce}.wav`);

    try {
      await writeFile(inputPath, buffer);
      await runProcessWithTimeout({
        command: "ffmpeg",
        args: [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          inputPath,
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "wav",
          outputPath,
        ],
        timeoutMs,
      });
      const outputBuffer = await readFile(outputPath);
      logger?.info?.(`wecom: transcoded voice to wav size=${outputBuffer.length} bytes`);
      return {
        buffer: outputBuffer,
        contentType: "audio/wav",
        fileName: `voice-${Date.now()}.wav`,
      };
    } finally {
      await Promise.allSettled([unlink(inputPath), unlink(outputPath)]);
    }
  }

  async function transcribeWithWhisperCli({ command, modelPath, audioPath, language, prompt, timeoutMs }) {
    if (!modelPath) {
      throw new Error("local-whisper-cli requires voiceTranscription.modelPath");
    }

    const tempDir = join(tmpdir(), tempDirName);
    await mkdir(tempDir, { recursive: true });
    const outputBase = join(tempDir, `voice-whisper-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outputTxt = `${outputBase}.txt`;

    const args = ["-m", modelPath, "-f", audioPath, "-otxt", "-of", outputBase, "--no-prints"];
    if (language) args.push("-l", language);
    if (prompt) args.push("--prompt", prompt);

    try {
      await runProcessWithTimeout({ command, args, timeoutMs });
      const transcript = String(await readFile(outputTxt, "utf8")).trim();
      if (!transcript) {
        throw new Error("whisper-cli transcription output is empty");
      }
      return transcript;
    } finally {
      await Promise.allSettled([unlink(outputTxt)]);
    }
  }

  async function transcribeWithWhisperPython({ command, model, audioPath, language, prompt, timeoutMs }) {
    const tempDir = join(tmpdir(), tempDirName);
    await mkdir(tempDir, { recursive: true });
    const audioBaseName = basename(audioPath, extname(audioPath));
    const outputTxt = join(tempDir, `${audioBaseName}.txt`);

    const args = [
      audioPath,
      "--model",
      model || "base",
      "--output_format",
      "txt",
      "--output_dir",
      tempDir,
      "--task",
      "transcribe",
    ];
    if (language) args.push("--language", language);
    if (prompt) args.push("--initial_prompt", prompt);

    try {
      await runProcessWithTimeout({ command, args, timeoutMs });
      const transcript = String(await readFile(outputTxt, "utf8")).trim();
      if (!transcript) {
        throw new Error("whisper transcription output is empty");
      }
      return transcript;
    } finally {
      await Promise.allSettled([unlink(outputTxt)]);
    }
  }

  async function transcribeInboundVoice({ api, buffer, contentType, mediaId, voiceConfig }) {
    if (!voiceConfig.enabled) {
      throw new Error("voice transcription is disabled");
    }

    let audioBuffer = buffer;
    let normalizedContentType = normalizeAudioContentType(contentType) || "application/octet-stream";
    let fileName = `voice-${mediaId}${pickAudioFileExtension({
      contentType: normalizedContentType,
      fileName: `voice-${mediaId}`,
    })}`;

    if (audioBuffer.length > voiceConfig.maxBytes) {
      throw new Error(`audio size ${audioBuffer.length} exceeds maxBytes ${voiceConfig.maxBytes}`);
    }

    const isWav = normalizedContentType === "audio/wav" || normalizedContentType === "audio/x-wav";
    const unsupportedDirect = !isLocalVoiceInputTypeDirectlySupported(normalizedContentType);
    const shouldTranscode = unsupportedDirect || (voiceConfig.transcodeToWav === true && !isWav);
    if (shouldTranscode) {
      if (!voiceConfig.ffmpegEnabled) {
        throw new Error(
          `content type ${normalizedContentType || "unknown"} requires ffmpeg conversion but ffmpegEnabled=false`,
        );
      }
      const ffmpegAvailable = await ensureFfmpegAvailable(api.logger);
      if (!ffmpegAvailable) {
        throw new Error(`unsupported content type ${normalizedContentType || "unknown"} and ffmpeg not available`);
      }
      const transcoded = await transcodeAudioToWav({
        buffer: audioBuffer,
        inputContentType: normalizedContentType,
        inputFileName: fileName,
        logger: api.logger,
        timeoutMs: Math.max(10000, Math.min(voiceConfig.timeoutMs, 45000)),
      });
      audioBuffer = transcoded.buffer;
      normalizedContentType = transcoded.contentType;
      fileName = transcoded.fileName;
    }

    const command = await resolveLocalWhisperCommand({ voiceConfig, logger: api.logger });
    const provider = String(voiceConfig.provider ?? "").trim().toLowerCase();

    const tempDir = join(tmpdir(), tempDirName);
    await mkdir(tempDir, { recursive: true });
    const audioPath = join(
      tempDir,
      `voice-transcribe-${Date.now()}-${Math.random().toString(36).slice(2)}${pickAudioFileExtension({
        contentType: normalizedContentType,
        fileName,
      })}`,
    );

    await writeFile(audioPath, audioBuffer);
    try {
      if (provider === "local-whisper-cli") {
        if (voiceConfig.requireModelPath !== false && !voiceConfig.modelPath) {
          throw new Error("voiceTranscription.modelPath is required for local-whisper-cli (or set requireModelPath=false)");
        }
        return transcribeWithWhisperCli({
          command,
          modelPath: voiceConfig.modelPath,
          audioPath,
          language: voiceConfig.language,
          prompt: voiceConfig.prompt,
          timeoutMs: voiceConfig.timeoutMs,
        });
      }

      if (provider === "local-whisper") {
        return transcribeWithWhisperPython({
          command,
          model: voiceConfig.model,
          audioPath,
          language: voiceConfig.language,
          prompt: voiceConfig.prompt,
          timeoutMs: voiceConfig.timeoutMs,
        });
      }

      throw new Error(`unsupported local provider ${provider}`);
    } finally {
      await Promise.allSettled([unlink(audioPath)]);
    }
  }

  return {
    resolveWecomVoiceTranscriptionConfig,
    transcribeInboundVoice,
    __internal: {
      resolveLocalWhisperCommand,
      checkCommandAvailable,
      ensureFfmpegAvailable,
      runProcessWithTimeout,
    },
  };
}
