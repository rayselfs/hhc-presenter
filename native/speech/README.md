# Bundled local speech runtime

Build with `npm run prepare:speech-runtime`; CMake 3.24+ and a native C++17 toolchain are required. `HHC_CMAKE` may identify CMake in a build environment. End users never need a compiler, Python, a model path, or a configuration file.

The engine archive and model files are pinned by revision and SHA-256. The whisper.cpp revision matches the measured pywhispercpp 1.5.1 dependency. The build embeds Metal shaders on macOS arm64; Windows x64 uses CPU inference and a static MSVC runtime. GPU acceleration on Windows is not qualified. Packaged builds reject missing or modified runtime assets. No local HTTP server or runtime download is used.

Models are downloaded only after an explicit installation action to the application's versioned user-data directory. A staged file becomes active after exact byte-count and SHA-256 verification. Model bytes are not bundled with the application. Model redistribution follows OpenAI Whisper's MIT license; the engine MIT license and OpenCC code/data licenses are included in resources/licenses and the runtime directory.

`fixtures/zh.wav` and `fixtures/en.wav` are synthetic macOS `say` recordings of Genesis chapter 1 verse 1 commands from the Phase 0 synthetic corpus (0000 and 0300). They contain no private recording. Run `node scripts/smoke-speech-runtime.mjs [model-directory]` to verify native readiness, transcription, silence, and shutdown. CI tests macOS arm64 and Windows x64. Native processing timing is not end-to-screen latency or minimum-device qualification.

Audio is bounded to 30 seconds, 16 kHz mono float32, one request at a time. Strong-noise experiments, volume balancing, retries, and learned VAD are not enabled. The retained automatic endpoint requires digital silence; ordinary microphone background audio needs the explicit Finish utterance action. Hardware microphone/room, signed installer, Windows 11 i7/32 GB, and two-hour coexistence qualification remain release gates.
