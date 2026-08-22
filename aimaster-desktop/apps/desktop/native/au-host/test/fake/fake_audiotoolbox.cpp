// A fake Audio Unit, faithful about the things that bite.
//
// It is not a simulator of CoreAudio.  It is a unit that INSISTS on the
// contract `au_host.mm`'s header comment claims to honour, and fails loudly
// when the contract is broken:
//
//   • the stream format on BOTH scopes must be packed non-interleaved float32
//     at the sample rate and channel count that were asked for;
//   • `kAudioUnitProperty_MaximumFramesPerSlice` must be set before
//     `AudioUnitInitialize`, and no render may exceed it;
//   • the buffer list handed to `AudioUnitRender` must have one buffer per
//     channel, each declaring one channel and exactly `frames * 4` bytes;
//   • a render must not be attempted before `AudioUnitInitialize` or after
//     `AudioUnitUninitialize`.
//
// The processing is deliberately channel-dependent — channel `ch` is scaled by
// `gain * (ch + 1)` — so a de-interleave that crosses channels produces the
// wrong numbers rather than merely-different-but-plausible ones.
//
// Every render is appended to the file named by `LOUI_FAKE_AU_LOG`, which is
// how the test checks the block loop without `au_host.mm` having to export
// anything it would not export on a Mac.

#include "coreaudio-shim.h"

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

struct FakeUnit {
  OSType subType = 0;
  bool   formatSetInput = false;
  bool   formatSetOutput = false;
  bool   maxFramesSet = false;
  UInt32 maxFrames = 0;
  bool   initialised = false;
  bool   disposed = false;
  UInt32 channels = 0;
  double sampleRate = 0;
  AURenderCallbackStruct callback = {};
  float  gain = 1.0f;
  std::vector<float> pullPlanes;   // one contiguous block per channel
  int    rendersLeft = -1;         // -1 = unlimited; 0 = fail the next render
};

std::vector<FakeUnit*> g_units;

void LogLine(const std::string& line) {
  const char* path = std::getenv("LOUI_FAKE_AU_LOG");
  if (path == nullptr) return;
  std::FILE* f = std::fopen(path, "a");
  if (f == nullptr) return;
  std::fputs(line.c_str(), f);
  std::fputc('\n', f);
  std::fclose(f);
}

OSType Fourcc(const char* s) {
  return (static_cast<OSType>(static_cast<unsigned char>(s[0])) << 24)
       | (static_cast<OSType>(static_cast<unsigned char>(s[1])) << 16)
       | (static_cast<OSType>(static_cast<unsigned char>(s[2])) << 8)
       |  static_cast<OSType>(static_cast<unsigned char>(s[3]));
}

/** The four components this fake machine has "installed". */
bool Installed(const AudioComponentDescription& d) {
  if (d.componentType != Fourcc("aufx")) return false;
  if (d.componentManufacturer != Fourcc("fake")) return false;
  return d.componentSubType == Fourcc("gain")   // a normal unit
      || d.componentSubType == Fourcc("oldn")   // names in the char array, not CFString
      || d.componentSubType == Fourcc("refu")   // refuses to initialise
      || d.componentSubType == Fourcc("badr");  // fails on the second render
}

}  // namespace

// ── Components ───────────────────────────────────────────────────────────────

extern "C" AudioComponent AudioComponentFindNext(
    AudioComponent inComponent, const AudioComponentDescription* inDesc) {
  if (inComponent != nullptr || inDesc == nullptr) return nullptr;
  if (!Installed(*inDesc)) return nullptr;
  // The "component" is the subtype itself, tagged so it is never null.
  return reinterpret_cast<AudioComponent>(
      static_cast<uintptr_t>(inDesc->componentSubType) | (1ull << 32));
}

extern "C" OSStatus AudioComponentInstanceNew(
    AudioComponent inComponent, AudioComponentInstance* outInstance) {
  if (inComponent == nullptr || outInstance == nullptr) return kAudioUnitErr_Uninitialized;
  FakeUnit* u = new FakeUnit();
  u->subType = static_cast<OSType>(reinterpret_cast<uintptr_t>(inComponent) & 0xffffffffu);
  if (u->subType == Fourcc("badr")) u->rendersLeft = 1;
  g_units.push_back(u);
  *outInstance = reinterpret_cast<AudioComponentInstance>(u);
  return noErr;
}

extern "C" OSStatus AudioComponentInstanceDispose(AudioComponentInstance inInstance) {
  FakeUnit* u = reinterpret_cast<FakeUnit*>(inInstance);
  if (u == nullptr) return kAudioUnitErr_Uninitialized;
  if (u->disposed) { LogLine("double-dispose"); return kAudioUnitErr_Uninitialized; }
  u->disposed = true;
  LogLine("dispose");
  return noErr;
}

// ── Properties ───────────────────────────────────────────────────────────────

extern "C" OSStatus AudioUnitSetProperty(
    AudioUnit inUnit, AudioUnitPropertyID inID, AudioUnitScope inScope,
    AudioUnitElement inElement, const void* inData, UInt32 inDataSize) {
  FakeUnit* u = reinterpret_cast<FakeUnit*>(inUnit);
  if (u == nullptr || inData == nullptr) return kAudioUnitErr_Uninitialized;
  if (inElement != 0) return kAudioUnitErr_InvalidProperty;

  switch (inID) {
    case kAudioUnitProperty_StreamFormat: {
      if (inDataSize != sizeof(AudioStreamBasicDescription)) return kAudioUnitErr_InvalidProperty;
      const AudioStreamBasicDescription* a =
          static_cast<const AudioStreamBasicDescription*>(inData);
      // The whole reason the app de-interleaves.  An interleaved ASBD here is
      // the mistake the header comment warns about, so the fake makes it fatal.
      const bool ok = a->mFormatID == kAudioFormatLinearPCM
          && (a->mFormatFlags & kAudioFormatFlagIsFloat)
          && (a->mFormatFlags & kAudioFormatFlagIsPacked)
          && (a->mFormatFlags & kAudioFormatFlagIsNonInterleaved)
          && a->mBitsPerChannel == 32
          && a->mFramesPerPacket == 1
          && a->mBytesPerFrame == 4
          && a->mBytesPerPacket == 4
          && a->mChannelsPerFrame >= 1
          && a->mSampleRate > 0;
      if (!ok) return kAudioUnitErr_FormatNotSupported;
      if (inScope == kAudioUnitScope_Input)  u->formatSetInput = true;
      else if (inScope == kAudioUnitScope_Output) u->formatSetOutput = true;
      else return kAudioUnitErr_InvalidProperty;
      u->channels = a->mChannelsPerFrame;
      u->sampleRate = a->mSampleRate;
      return noErr;
    }
    case kAudioUnitProperty_MaximumFramesPerSlice: {
      if (inScope != kAudioUnitScope_Global || inDataSize != sizeof(UInt32)) {
        return kAudioUnitErr_InvalidProperty;
      }
      u->maxFrames = *static_cast<const UInt32*>(inData);
      u->maxFramesSet = u->maxFrames > 0;
      return noErr;
    }
    case kAudioUnitProperty_SetRenderCallback: {
      if (inScope != kAudioUnitScope_Input || inDataSize != sizeof(AURenderCallbackStruct)) {
        return kAudioUnitErr_InvalidProperty;
      }
      u->callback = *static_cast<const AURenderCallbackStruct*>(inData);
      return noErr;
    }
    case kAudioUnitProperty_OfflineRender:
      // Plenty of real units do not implement this; the host is required not
      // to care, so the fake refuses it to make sure the host does not.
      return kAudioUnitErr_InvalidProperty;
    default:
      return kAudioUnitErr_InvalidProperty;
  }
}

namespace {
/** Two parameters, so name matching has something to get wrong. */
const AudioUnitParameterID kParamIds[2] = { 7, 42 };
const char* kOldNames[2] = { "Gain", "Dry/Wet" };
}  // namespace

extern "C" OSStatus AudioUnitGetPropertyInfo(
    AudioUnit inUnit, AudioUnitPropertyID inID, AudioUnitScope inScope,
    AudioUnitElement inElement, UInt32* outDataSize, Boolean* outWritable) {
  FakeUnit* u = reinterpret_cast<FakeUnit*>(inUnit);
  if (u == nullptr) return kAudioUnitErr_Uninitialized;
  if (inID != kAudioUnitProperty_ParameterList) return kAudioUnitErr_InvalidProperty;
  if (inScope != kAudioUnitScope_Global || inElement != 0) return kAudioUnitErr_InvalidProperty;
  if (outDataSize != nullptr) *outDataSize = sizeof(kParamIds);
  if (outWritable != nullptr) *outWritable = 0;
  return noErr;
}

extern "C" OSStatus AudioUnitGetProperty(
    AudioUnit inUnit, AudioUnitPropertyID inID, AudioUnitScope inScope,
    AudioUnitElement inElement, void* outData, UInt32* ioDataSize) {
  FakeUnit* u = reinterpret_cast<FakeUnit*>(inUnit);
  if (u == nullptr || outData == nullptr || ioDataSize == nullptr) {
    return kAudioUnitErr_Uninitialized;
  }
  if (inID == kAudioUnitProperty_ParameterList) {
    if (*ioDataSize < sizeof(kParamIds)) return kAudioUnitErr_InvalidProperty;
    std::memcpy(outData, kParamIds, sizeof(kParamIds));
    *ioDataSize = sizeof(kParamIds);
    return noErr;
  }
  if (inID == kAudioUnitProperty_ParameterInfo) {
    if (*ioDataSize < sizeof(AudioUnitParameterInfo)) return kAudioUnitErr_InvalidProperty;
    int slot = -1;
    for (int i = 0; i < 2; i++) if (kParamIds[i] == inElement) slot = i;
    if (slot < 0) return kAudioUnitErr_InvalidProperty;

    AudioUnitParameterInfo info = {};
    info.minValue = 0.0f;
    info.maxValue = slot == 0 ? 4.0f : 1.0f;
    info.defaultValue = 1.0f;
    if (u->subType == Fourcc("oldn")) {
      // The old way: the name lives in the char array and there is no CFString.
      std::snprintf(info.name, sizeof(info.name), "%s", kOldNames[slot]);
    } else {
      // The modern way: a CFString the host must copy out and then RELEASE.
      info.flags = kAudioUnitParameterFlag_HasCFNameString
                 | kAudioUnitParameterFlag_CFNameRelease;
      info.cfNameString = reinterpret_cast<CFStringRef>(
          const_cast<char*>(kOldNames[slot]));
    }
    std::memcpy(outData, &info, sizeof(info));
    *ioDataSize = sizeof(info);
    return noErr;
  }
  return kAudioUnitErr_InvalidProperty;
}

// A CFString here is just the char pointer; copying it out has to go through
// the same call the real one does, so the host's buffer handling is exercised.
extern "C" Boolean CFStringGetCString(CFStringRef theString, char* buffer,
                                      long bufferSize, CFStringEncoding encoding) {
  if (theString == nullptr || buffer == nullptr || bufferSize <= 0) return 0;
  if (encoding != kCFStringEncodingUTF8) return 0;
  std::snprintf(buffer, static_cast<size_t>(bufferSize), "%s",
                reinterpret_cast<const char*>(theString));
  return 1;
}

extern "C" void CFRelease(const void* cf) {
  if (cf == nullptr) { LogLine("release-null"); return; }
  LogLine("cfrelease");
}

extern "C" OSStatus AudioUnitSetParameter(
    AudioUnit inUnit, AudioUnitParameterID inID, AudioUnitScope inScope,
    AudioUnitElement inElement, AudioUnitParameterValue inValue,
    UInt32 inBufferOffsetInFrames) {
  FakeUnit* u = reinterpret_cast<FakeUnit*>(inUnit);
  if (u == nullptr) return kAudioUnitErr_Uninitialized;
  if (inScope != kAudioUnitScope_Global || inElement != 0) return kAudioUnitErr_InvalidProperty;
  if (inBufferOffsetInFrames != 0) return kAudioUnitErr_InvalidProperty;
  if (inID == kParamIds[0]) u->gain = inValue;
  LogLine("param " + std::to_string(inID) + " " + std::to_string(inValue));
  return noErr;
}

// ── Lifecycle and render ─────────────────────────────────────────────────────

extern "C" OSStatus AudioUnitInitialize(AudioUnit inUnit) {
  FakeUnit* u = reinterpret_cast<FakeUnit*>(inUnit);
  if (u == nullptr) return kAudioUnitErr_Uninitialized;
  if (u->subType == Fourcc("refu")) return kAudioUnitErr_FormatNotSupported;
  if (!u->formatSetInput || !u->formatSetOutput) return kAudioUnitErr_FormatNotSupported;
  if (!u->maxFramesSet) return kAudioUnitErr_FormatNotSupported;
  if (u->callback.inputProc == nullptr) return kAudioUnitErr_Uninitialized;
  u->pullPlanes.assign(static_cast<size_t>(u->channels) * u->maxFrames, 0.0f);
  u->initialised = true;
  LogLine("init " + std::to_string(u->channels) + " " + std::to_string(u->maxFrames));
  return noErr;
}

extern "C" OSStatus AudioUnitUninitialize(AudioUnit inUnit) {
  FakeUnit* u = reinterpret_cast<FakeUnit*>(inUnit);
  if (u == nullptr) return kAudioUnitErr_Uninitialized;
  u->initialised = false;
  LogLine("uninit");
  return noErr;
}

extern "C" OSStatus AudioUnitRender(
    AudioUnit inUnit, AudioUnitRenderActionFlags* ioActionFlags,
    const AudioTimeStamp* inTimeStamp, UInt32 inOutputBusNumber,
    UInt32 inNumberFrames, AudioBufferList* ioData) {
  FakeUnit* u = reinterpret_cast<FakeUnit*>(inUnit);
  if (u == nullptr || !u->initialised) return kAudioUnitErr_Uninitialized;
  if (ioData == nullptr || inTimeStamp == nullptr) return kAudioUnitErr_Uninitialized;
  if (inOutputBusNumber != 0) return kAudioUnitErr_InvalidProperty;
  if (inNumberFrames == 0 || inNumberFrames > u->maxFrames) {
    LogLine("over-max " + std::to_string(inNumberFrames));
    return kAudioUnitErr_InvalidProperty;
  }
  if (ioData->mNumberBuffers != u->channels) {
    LogLine("wrong-buffers " + std::to_string(ioData->mNumberBuffers));
    return kAudioUnitErr_FormatNotSupported;
  }
  if ((inTimeStamp->mFlags & kAudioTimeStampSampleTimeValid) == 0) {
    LogLine("no-sample-time");
    return kAudioUnitErr_InvalidProperty;
  }
  for (UInt32 ch = 0; ch < ioData->mNumberBuffers; ch++) {
    if (ioData->mBuffers[ch].mNumberChannels != 1
        || ioData->mBuffers[ch].mDataByteSize != inNumberFrames * sizeof(Float32)
        || ioData->mBuffers[ch].mData == nullptr) {
      LogLine("bad-buffer " + std::to_string(ch) + " "
              + std::to_string(ioData->mBuffers[ch].mNumberChannels) + " "
              + std::to_string(ioData->mBuffers[ch].mDataByteSize));
      return kAudioUnitErr_FormatNotSupported;
    }
  }
  if (u->rendersLeft == 0) { LogLine("refuse"); return kAudioUnitErr_InvalidProperty; }
  if (u->rendersLeft > 0) u->rendersLeft--;

  LogLine("render " + std::to_string(static_cast<long long>(inTimeStamp->mSampleTime))
          + " " + std::to_string(inNumberFrames));

  // PULL: build the input buffer list over our own planes and ask the host for
  // the samples, exactly as a real unit does.
  std::vector<uint8_t> storage(sizeof(AudioBufferList)
      + sizeof(AudioBuffer) * (u->channels > 0 ? u->channels - 1 : 0));
  AudioBufferList* in = reinterpret_cast<AudioBufferList*>(storage.data());
  in->mNumberBuffers = u->channels;
  for (UInt32 ch = 0; ch < u->channels; ch++) {
    in->mBuffers[ch].mNumberChannels = 1;
    in->mBuffers[ch].mDataByteSize = inNumberFrames * sizeof(Float32);
    in->mBuffers[ch].mData = u->pullPlanes.data() + static_cast<size_t>(ch) * u->maxFrames;
  }
  AudioUnitRenderActionFlags flags = 0;
  const OSStatus pulled = u->callback.inputProc(
      u->callback.inputProcRefCon, &flags, inTimeStamp, 0, inNumberFrames, in);
  if (pulled != noErr) return pulled;

  // Channel-dependent on purpose: a crossed de-interleave shows up as the
  // wrong number, not as an equally plausible one.
  for (UInt32 ch = 0; ch < u->channels; ch++) {
    const Float32* src = static_cast<const Float32*>(in->mBuffers[ch].mData);
    Float32* dst = static_cast<Float32*>(ioData->mBuffers[ch].mData);
    const float scale = u->gain * static_cast<float>(ch + 1);
    for (UInt32 f = 0; f < inNumberFrames; f++) dst[f] = src[f] * scale;
  }
  if (ioActionFlags != nullptr) *ioActionFlags = 0;
  return noErr;
}
