#include "whisper.h"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

// stdin: little-endian sample count followed by mono 16 kHz float32 PCM.
// stdout: bounded JSONL. Diagnostics never include audio or transcripts.
static std::string json_string(const std::string &text) {
  std::string result = "\"";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') { result += '\\'; result += c; }
    else if (c < 32) {
      const char *hex = "0123456789abcdef";
      result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15];
    } else result += c;
  }
  return result + "\"";
}

static int run(int argc, char **argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
#endif
  if (argc == 2 && std::string(argv[1]) == "--version") {
    std::cout << "hhc-speech/1 whisper/f24588a272ae8e23280d9c220536437164e6ed28\n";
    return 0;
  }
  if (argc != 3 || (std::string(argv[2]) != "zh" && std::string(argv[2]) != "en")) return 2;
  whisper_log_set([](enum ggml_log_level, const char *, void *) {}, nullptr);
  auto context_params = whisper_context_default_params();
#ifdef _WIN32
  context_params.use_gpu = false;
#endif
  auto *context = whisper_init_from_file_with_params(argv[1], context_params);
  if (!context) return 3;
  std::cout << "{\"ready\":true,\"protocol\":1}\n" << std::flush;
  unsigned char header[4];
  while (std::cin.read(reinterpret_cast<char *>(header), 4)) {
    uint32_t count = uint32_t(header[0]) | (uint32_t(header[1]) << 8) |
                     (uint32_t(header[2]) << 16) | (uint32_t(header[3]) << 24);
    if (count == 0 || count > 480000) { whisper_free(context); return 4; }
    std::vector<float> samples(count);
    if (!std::cin.read(reinterpret_cast<char *>(samples.data()), count * sizeof(float))) { whisper_free(context); return 4; }
    if (std::any_of(samples.begin(), samples.end(), [](float f) { return !std::isfinite(f) || std::abs(f) > 1; })) {
      whisper_free(context); return 4;
    }
    auto started = std::chrono::steady_clock::now();
    auto first = std::find_if(samples.begin(), samples.end(), [](float f) { return f != 0; });
    auto last = std::find_if(samples.rbegin(), samples.rend(), [](float f) { return f != 0; }).base();
    std::string text;
    if (first != samples.end()) {
      int length = static_cast<int>(last - first);
      auto params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
      params.n_threads = 4;
      params.language = argv[2];
      params.no_context = true;
      params.no_timestamps = true;
      params.print_progress = false;
      params.print_realtime = false;
      params.print_timestamps = false;
      params.temperature = 0;
      params.temperature_inc = 0;
      params.audio_ctx = std::string(argv[2]) == "zh" && length <= 768 * 320 ? 768 : 0;
      params.initial_prompt = std::string(argv[2]) == "en"
        ? "Bible scripture, book, chapter, verse. Jesus, Israel, Corinthians." : nullptr;
      if (whisper_full(context, params, &*first, length) != 0) { whisper_free(context); return 5; }
      for (int i = 0; i < whisper_full_n_segments(context); i++) text += whisper_full_get_segment_text(context, i);
    }
    if (text.size() > 64000) { whisper_free(context); return 6; }
    auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    std::cout << "{\"text\":" << json_string(text) << ",\"asrMs\":" << elapsed << "}\n" << std::flush;
  }
  whisper_free(context);
  return std::cin.gcount() == 0 ? 0 : 4;
}

#ifdef _WIN32
int wmain(int argc, wchar_t **wide) {
  std::vector<std::string> values;
  std::vector<char *> args;
  for (int i = 0; i < argc; i++) {
    int size = WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, nullptr, 0, nullptr, nullptr);
    if (size <= 0) return 2;
    std::string value(size, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide[i], -1, value.data(), size, nullptr, nullptr);
    value.pop_back();
    values.push_back(value);
  }
  for (auto &value : values) args.push_back(value.data());
  return run(argc, args.data());
}
#else
int main(int argc, char **argv) { return run(argc, argv); }
#endif
