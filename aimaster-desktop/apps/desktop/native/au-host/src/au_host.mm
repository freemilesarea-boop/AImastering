// Audio Unit host — the native leaf.
//
// ⚠️ COMPILED AND RUN, BUT NOT AGAINST APPLE'S AudioToolbox.  See ../README.md.
// `test/` builds this exact source against a fake CoreAudio with real pull
// semantics, so the logic below is executed; the macOS CI job builds it against
// the real framework, which is the only thing that can confirm the API.  Nothing
// above this depends on it working: a failed load, a failed open, or output
// that does not survive validation all come back as "this stage was not
// applied", with the reason, and the audio passes through untouched.
//
// ── The shape ────────────────────────────────────────────────────────────────
//
// One `AudioUnit` per open handle.  Offline rendering, not realtime: the app
// applies third-party plugins on bounce and freeze only (the live graph is Web
// Audio and cannot call out to native code), so this pulls blocks as fast as
// the plugin will produce them rather than servicing a device callback.
//
// `AudioUnitRender` PULLS.  It asks the input callback for samples and writes
// what it produced into the buffer list you hand it.  So the flow per block is:
// point the callback at the next slice of the caller's buffer, render, copy the
// result back over that slice.  In place from the caller's point of view.
//
// ── Two things that bite ─────────────────────────────────────────────────────
//
// FORMAT.  An AU will not run until both its scopes agree with what you are
// about to hand it.  Non-interleaved float32 is the format every modern AU
// accepts, so the interleaved buffer the app uses is de-interleaved on the way
// in and re-interleaved on the way out.  Trying to hand an AU interleaved
// float is the most common way to get a `kAudioUnitErr_FormatNotSupported`
// that reads like the plugin is broken.
//
// MAXIMUM FRAMES.  `kAudioUnitProperty_MaximumFramesPerSlice` defaults to 1156
// and a plugin is entitled to fail any render larger than it. Blocks are
// therefore capped at BLOCK_FRAMES and the property is set to match; rendering
// a whole four-minute track in one call would fail on many units.

#import <AudioToolbox/AudioToolbox.h>
#import <AudioUnit/AudioUnit.h>
#include <napi.h>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace {

/** Small enough that every unit accepts it, large enough to be cheap. */
constexpr UInt32 BLOCK_FRAMES = 512;

/**
 * The channel count above which the number is a mistake, not a mix.
 *
 * Without a ceiling, `channels` arrives as an unsigned cast of whatever was
 * passed: -1 becomes four billion, `resize` throws `std::bad_alloc`, and
 * exceptions are OFF in this build — so the process aborts.  An argument must
 * never be able to do that; a plugin failing alone is the whole point.
 */
constexpr UInt32 MAX_CHANNELS = 64;

struct Instance {
  AudioUnit unit = nullptr;
  UInt32 channels = 2;
  double sampleRate = 48000.0;
  /** De-interleaved input for the current block, one vector per channel. */
  std::vector<std::vector<Float32>> inputPlanes;
  UInt32 blockFrames = 0;
};

std::map<int32_t, Instance*> g_instances;
int32_t g_nextHandle = 1;

/**
 * The pull callback.
 *
 * Hands the unit the block already de-interleaved into `inputPlanes`.  It is
 * called once per render for a unit with one input bus; a unit that asks for
 * more frames than were staged gets silence for the remainder rather than
 * whatever was in memory.
 */
OSStatus RenderInput(void* inRefCon,
                     AudioUnitRenderActionFlags* /*ioActionFlags*/,
                     const AudioTimeStamp* /*inTimeStamp*/,
                     UInt32 /*inBusNumber*/,
                     UInt32 inNumberFrames,
                     AudioBufferList* ioData) {
  Instance* self = static_cast<Instance*>(inRefCon);
  if (self == nullptr || ioData == nullptr) return kAudioUnitErr_Uninitialized;

  for (UInt32 ch = 0; ch < ioData->mNumberBuffers; ch++) {
    Float32* dst = static_cast<Float32*>(ioData->mBuffers[ch].mData);
    if (dst == nullptr) continue;
    const bool have = ch < self->inputPlanes.size();
    const UInt32 available = have
        ? static_cast<UInt32>(self->inputPlanes[ch].size()) : 0;
    const UInt32 copy = inNumberFrames < available ? inNumberFrames : available;
    if (copy > 0) {
      memcpy(dst, self->inputPlanes[ch].data(), copy * sizeof(Float32));
    }
    if (copy < inNumberFrames) {
      memset(dst + copy, 0, (inNumberFrames - copy) * sizeof(Float32));
    }
  }
  return noErr;
}

/** `aufx-dcmp-appl` → the component the app scanned out of Info.plist. */
bool ParseUid(const std::string& uid, AudioComponentDescription* out) {
  if (uid.size() != 14 || uid[4] != '-' || uid[9] != '-') return false;
  auto fourcc = [](const char* s) -> OSType {
    return (static_cast<OSType>(static_cast<unsigned char>(s[0])) << 24)
         | (static_cast<OSType>(static_cast<unsigned char>(s[1])) << 16)
         | (static_cast<OSType>(static_cast<unsigned char>(s[2])) << 8)
         |  static_cast<OSType>(static_cast<unsigned char>(s[3]));
  };
  memset(out, 0, sizeof(*out));
  out->componentType         = fourcc(uid.c_str());
  out->componentSubType      = fourcc(uid.c_str() + 5);
  out->componentManufacturer = fourcc(uid.c_str() + 10);
  return true;
}

AudioStreamBasicDescription FloatFormat(double sampleRate, UInt32 channels) {
  AudioStreamBasicDescription asbd = {};
  asbd.mSampleRate       = sampleRate;
  asbd.mFormatID         = kAudioFormatLinearPCM;
  // Non-interleaved: one buffer per channel.  See the header comment.
  asbd.mFormatFlags      = kAudioFormatFlagIsFloat
                         | kAudioFormatFlagIsPacked
                         | kAudioFormatFlagIsNonInterleaved;
  asbd.mChannelsPerFrame = channels;
  asbd.mBitsPerChannel   = 32;
  asbd.mFramesPerPacket  = 1;
  asbd.mBytesPerFrame    = 4;
  asbd.mBytesPerPacket   = 4;
  return asbd;
}

// ── open ──────────────────────────────────────────────────────────────────────

Napi::Value Open(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() || !info[2].IsNumber()) {
    Napi::TypeError::New(env, "open(uid, sampleRate, channels)").ThrowAsJavaScriptException();
    return env.Null();
  }
  const std::string uid = info[0].As<Napi::String>().Utf8Value();
  const double sampleRate = info[1].As<Napi::Number>().DoubleValue();
  const int32_t requested = info[2].As<Napi::Number>().Int32Value();

  if (!(sampleRate > 0.0) || sampleRate > 1.0e7) {
    Napi::RangeError::New(env, "샘플레이트가 아닙니다").ThrowAsJavaScriptException();
    return env.Null();
  }
  if (requested < 1 || static_cast<UInt32>(requested) > MAX_CHANNELS) {
    Napi::RangeError::New(env, "채널 수가 1.." + std::to_string(MAX_CHANNELS) + " 밖입니다")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  const UInt32 channels = static_cast<UInt32>(requested);

  AudioComponentDescription desc;
  if (!ParseUid(uid, &desc)) {
    Napi::Error::New(env, "식별자 형식이 아닙니다 (type-subtype-manu)").ThrowAsJavaScriptException();
    return env.Null();
  }

  AudioComponent component = AudioComponentFindNext(nullptr, &desc);
  if (component == nullptr) {
    Napi::Error::New(env, "그 컴포넌트가 설치되어 있지 않습니다").ThrowAsJavaScriptException();
    return env.Null();
  }

  AudioUnit unit = nullptr;
  OSStatus status = AudioComponentInstanceNew(component, &unit);
  if (status != noErr || unit == nullptr) {
    Napi::Error::New(env, "인스턴스를 만들지 못했습니다").ThrowAsJavaScriptException();
    return env.Null();
  }

  Instance* self = new Instance();
  self->unit = unit;
  self->channels = channels;
  self->sampleRate = sampleRate;
  self->inputPlanes.resize(channels);

  AudioStreamBasicDescription asbd = FloatFormat(sampleRate, channels);
  // Both scopes, or the unit refuses to initialise.
  AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
                       kAudioUnitScope_Input, 0, &asbd, sizeof(asbd));
  AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat,
                       kAudioUnitScope_Output, 0, &asbd, sizeof(asbd));

  UInt32 maxFrames = BLOCK_FRAMES;
  AudioUnitSetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice,
                       kAudioUnitScope_Global, 0, &maxFrames, sizeof(maxFrames));

  AURenderCallbackStruct callback = {};
  callback.inputProc = RenderInput;
  callback.inputProcRefCon = self;
  AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback,
                       kAudioUnitScope_Input, 0, &callback, sizeof(callback));

  // Offline: tell the unit nobody is listening in realtime, so a unit with a
  // lookahead is free to use it.  Not every unit implements this; failure is
  // not fatal.
  UInt32 offline = 1;
  AudioUnitSetProperty(unit, kAudioUnitProperty_OfflineRender,
                       kAudioUnitScope_Global, 0, &offline, sizeof(offline));

  status = AudioUnitInitialize(unit);
  if (status != noErr) {
    AudioComponentInstanceDispose(unit);
    delete self;
    Napi::Error::New(env, "초기화하지 못했습니다 (포맷을 받지 않는 플러그인일 수 있습니다)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const int32_t handle = g_nextHandle++;
  g_instances[handle] = self;
  return Napi::Number::New(env, handle);
}

Instance* Lookup(int32_t handle) {
  auto it = g_instances.find(handle);
  return it == g_instances.end() ? nullptr : it->second;
}

// ── parameters ────────────────────────────────────────────────────────────────

Napi::Value Parameters(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Array out = Napi::Array::New(env);
  if (info.Length() < 1 || !info[0].IsNumber()) return out;
  Instance* self = Lookup(info[0].As<Napi::Number>().Int32Value());
  if (self == nullptr) return out;

  UInt32 size = 0;
  OSStatus status = AudioUnitGetPropertyInfo(
      self->unit, kAudioUnitProperty_ParameterList,
      kAudioUnitScope_Global, 0, &size, nullptr);
  if (status != noErr || size == 0) return out;

  // A unit that announces a size which is not a whole number of ids would,
  // taken at face value, have the second call write past the end of the
  // vector.  The buffer's real size is what is passed back in, not what was
  // announced — third-party code does not get to choose how much of our
  // memory it writes to.
  std::vector<AudioUnitParameterID> ids(size / sizeof(AudioUnitParameterID));
  if (ids.empty()) return out;
  size = static_cast<UInt32>(ids.size() * sizeof(AudioUnitParameterID));
  status = AudioUnitGetProperty(self->unit, kAudioUnitProperty_ParameterList,
                                kAudioUnitScope_Global, 0, ids.data(), &size);
  if (status != noErr) return out;
  // And it may have filled fewer than it asked for.
  const size_t filled = size / sizeof(AudioUnitParameterID);
  if (filled < ids.size()) ids.resize(filled);

  uint32_t index = 0;
  for (AudioUnitParameterID id : ids) {
    AudioUnitParameterInfo pinfo = {};
    UInt32 infoSize = sizeof(pinfo);
    if (AudioUnitGetProperty(self->unit, kAudioUnitProperty_ParameterInfo,
                             kAudioUnitScope_Global, id, &pinfo, &infoSize) != noErr) {
      continue;
    }
    // The name is either a CFString or a fixed char array, depending on the
    // unit's age.  Both appear in the wild.
    std::string name;
    if ((pinfo.flags & kAudioUnitParameterFlag_HasCFNameString) && pinfo.cfNameString) {
      char buffer[256] = {0};
      if (CFStringGetCString(pinfo.cfNameString, buffer, sizeof(buffer), kCFStringEncodingUTF8)) {
        name = buffer;
      }
      if (pinfo.flags & kAudioUnitParameterFlag_CFNameRelease) {
        CFRelease(pinfo.cfNameString);
      }
    }
    // `pinfo.name` is a fixed 52-byte array.  A unit that fills all 52 leaves
    // it unterminated, and `std::string(const char*)` would read off the end.
    if (name.empty()) {
      const void* nul = memchr(pinfo.name, '\0', sizeof(pinfo.name));
      name = std::string(pinfo.name, nul == nullptr ? sizeof(pinfo.name)
          : static_cast<size_t>(static_cast<const char*>(nul) - pinfo.name));
    }
    if (name.empty()) continue;

    Napi::Object entry = Napi::Object::New(env);
    entry.Set("id", Napi::Number::New(env, static_cast<double>(id)));
    entry.Set("name", Napi::String::New(env, name));
    entry.Set("min", Napi::Number::New(env, pinfo.minValue));
    entry.Set("max", Napi::Number::New(env, pinfo.maxValue));
    out.Set(index++, entry);
  }
  return out;
}

Napi::Value SetParameter(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber()) {
    return env.Undefined();
  }
  Instance* self = Lookup(info[0].As<Napi::Number>().Int32Value());
  if (self == nullptr) return env.Undefined();
  const AudioUnitParameterID id =
      static_cast<AudioUnitParameterID>(info[1].As<Napi::Number>().Int32Value());
  const AudioUnitParameterValue value =
      static_cast<AudioUnitParameterValue>(info[2].As<Napi::Number>().FloatValue());
  AudioUnitSetParameter(self->unit, id, kAudioUnitScope_Global, 0, value, 0);
  return env.Undefined();
}

// ── process ───────────────────────────────────────────────────────────────────

Napi::Value Process(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  // The types are checked BEFORE anything is read.  `As<Float32Array>()` on a
  // plain object leaves an exception pending, and the next throw — even the
  // right one, with the right message — is then a FATAL ERROR that takes the
  // whole host process down.  The check has to come first or it is not a check.
  if (info.Length() < 3 || !info[0].IsNumber() || !info[2].IsNumber()
      || !info[1].IsTypedArray()
      || info[1].As<Napi::TypedArray>().TypedArrayType() != napi_float32_array) {
    Napi::TypeError::New(env, "process(handle, Float32Array, frames)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  Instance* self = Lookup(info[0].As<Napi::Number>().Int32Value());
  if (self == nullptr) {
    Napi::Error::New(env, "핸들이 유효하지 않습니다").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Float32Array samples = info[1].As<Napi::Float32Array>();
  const double wantFrames = info[2].As<Napi::Number>().DoubleValue();
  if (!(wantFrames >= 0.0) || wantFrames > 4294967295.0) {
    Napi::RangeError::New(env, "프레임 수가 아닙니다").ThrowAsJavaScriptException();
    return env.Null();
  }
  const UInt32 frames = static_cast<UInt32>(wantFrames);
  const UInt32 channels = self->channels;
  Float32* data = samples.Data();

  if (samples.ElementLength() < static_cast<size_t>(frames) * channels) {
    Napi::Error::New(env, "버퍼가 짧습니다").ThrowAsJavaScriptException();
    return env.Null();
  }

  // One AudioBufferList reused across blocks: allocating per block on a
  // four-minute track is thousands of allocations for no reason.
  std::vector<Float32> outputPlanes(static_cast<size_t>(channels) * BLOCK_FRAMES);
  std::vector<uint8_t> listStorage(
      sizeof(AudioBufferList) + sizeof(AudioBuffer) * (channels > 0 ? channels - 1 : 0));
  AudioBufferList* list = reinterpret_cast<AudioBufferList*>(listStorage.data());
  list->mNumberBuffers = channels;

  AudioTimeStamp timestamp = {};
  timestamp.mFlags = kAudioTimeStampSampleTimeValid;
  timestamp.mSampleTime = 0;

  UInt32 done = 0;
  while (done < frames) {
    const UInt32 block = (frames - done) < BLOCK_FRAMES ? (frames - done) : BLOCK_FRAMES;

    // De-interleave this slice into the planes the callback will hand over.
    for (UInt32 ch = 0; ch < channels; ch++) {
      self->inputPlanes[ch].resize(block);
      Float32* plane = self->inputPlanes[ch].data();
      for (UInt32 f = 0; f < block; f++) {
        plane[f] = data[(static_cast<size_t>(done) + f) * channels + ch];
      }
      list->mBuffers[ch].mNumberChannels = 1;
      list->mBuffers[ch].mDataByteSize = block * sizeof(Float32);
      list->mBuffers[ch].mData = outputPlanes.data() + static_cast<size_t>(ch) * BLOCK_FRAMES;
    }

    AudioUnitRenderActionFlags flags = 0;
    OSStatus status = AudioUnitRender(self->unit, &flags, &timestamp, 0, block, list);
    if (status != noErr) {
      Napi::Error::New(env, "렌더가 실패했습니다").ThrowAsJavaScriptException();
      return env.Null();
    }

    // Re-interleave over the caller's buffer.
    for (UInt32 ch = 0; ch < channels; ch++) {
      const Float32* plane = static_cast<const Float32*>(list->mBuffers[ch].mData);
      for (UInt32 f = 0; f < block; f++) {
        data[(static_cast<size_t>(done) + f) * channels + ch] = plane[f];
      }
    }

    timestamp.mSampleTime += block;
    done += block;
  }

  return Napi::Number::New(env, static_cast<double>(done));
}

Napi::Value Close(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) return env.Undefined();
  const int32_t handle = info[0].As<Napi::Number>().Int32Value();
  Instance* self = Lookup(handle);
  if (self == nullptr) return env.Undefined();
  AudioUnitUninitialize(self->unit);
  AudioComponentInstanceDispose(self->unit);
  delete self;
  g_instances.erase(handle);
  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("open", Napi::Function::New(env, Open));
  exports.Set("parameters", Napi::Function::New(env, Parameters));
  exports.Set("setParameter", Napi::Function::New(env, SetParameter));
  exports.Set("process", Napi::Function::New(env, Process));
  exports.Set("close", Napi::Function::New(env, Close));
  return exports;
}

}  // namespace

NODE_API_MODULE(au_host, Init)
