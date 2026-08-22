// A stand-in for Apple's CoreAudio headers, so `au_host.mm` can be COMPILED
// AND RUN on a machine that is not a Mac.
//
// ── What this is for ─────────────────────────────────────────────────────────
//
// `au_host.mm` was written on Linux and, until this file existed, had never
// been through a compiler.  Code that has never been compiled is not code yet:
// a typo in a struct field, an argument in the wrong order, a signature that
// does not match — none of those are visible by reading.  This header plus
// `fake_audiotoolbox.cpp` give the real source something to compile and link
// against, and a fake unit to render through, so the parts of it that are OUR
// logic — the uid parsing, the handle table, the de-interleave/render/
// re-interleave loop, the block splitting, the error paths — are executed.
//
// ── What this is NOT ─────────────────────────────────────────────────────────
//
// It is NOT the authority on the API.  The declarations here are transcribed
// from Apple's documented ones; if one of them is subtly wrong, this file
// compiles and the Mac does not.  That is exactly why the macOS CI job exists
// (`.github/workflows/au-host-macos.yml`): it builds the same source against
// the REAL AudioToolbox, and the real one gets the last word.  A green run
// here means "our logic is right"; a green run there means "the API is right".
//
// Layout of the structs matters only inasmuch as this file is self-consistent,
// since nothing here is passed to a real Apple function.

#pragma once
#include <cstdint>
#include <cstring>

typedef uint32_t UInt32;
typedef uint64_t UInt64;
typedef int32_t  SInt32;
typedef int16_t  SInt16;
typedef float    Float32;
typedef double   Float64;
typedef int32_t  OSStatus;
typedef uint32_t OSType;
typedef unsigned char Boolean;

enum { noErr = 0 };

// Real values, so a mistake in a constant name is a compile error rather than
// a silently different number.
enum { kAudioUnitErr_Uninitialized      = -10867 };
enum { kAudioUnitErr_FormatNotSupported = -10868 };
enum { kAudioUnitErr_InvalidProperty    = -10879 };

typedef UInt32 AudioFormatID;
typedef UInt32 AudioFormatFlags;
enum : AudioFormatID { kAudioFormatLinearPCM = 'lpcm' };
enum : AudioFormatFlags {
  kAudioFormatFlagIsFloat          = 1u << 0,
  kAudioFormatFlagIsBigEndian      = 1u << 1,
  kAudioFormatFlagIsSignedInteger  = 1u << 2,
  kAudioFormatFlagIsPacked         = 1u << 3,
  kAudioFormatFlagIsAlignedHigh    = 1u << 4,
  kAudioFormatFlagIsNonInterleaved = 1u << 5,
};

struct AudioStreamBasicDescription {
  Float64          mSampleRate;
  AudioFormatID    mFormatID;
  AudioFormatFlags mFormatFlags;
  UInt32           mBytesPerPacket;
  UInt32           mFramesPerPacket;
  UInt32           mBytesPerFrame;
  UInt32           mChannelsPerFrame;
  UInt32           mBitsPerChannel;
  UInt32           mReserved;
};

struct AudioBuffer {
  UInt32 mNumberChannels;
  UInt32 mDataByteSize;
  void*  mData;
};

struct AudioBufferList {
  UInt32      mNumberBuffers;
  AudioBuffer mBuffers[1];
};

struct SMPTETime {
  SInt16 mSubframes;
  SInt16 mSubframeDivisor;
  UInt32 mCounter;
  UInt32 mType;
  UInt32 mFlags;
  SInt16 mHours;
  SInt16 mMinutes;
  SInt16 mSeconds;
  SInt16 mFrames;
};

typedef UInt32 AudioTimeStampFlags;
enum : AudioTimeStampFlags { kAudioTimeStampSampleTimeValid = 1u << 0 };

struct AudioTimeStamp {
  Float64             mSampleTime;
  UInt64              mHostTime;
  Float64             mRateScalar;
  UInt64              mWordClockTime;
  SMPTETime           mSMPTETime;
  AudioTimeStampFlags mFlags;
  UInt32              mReserved;
};

// ── Components ───────────────────────────────────────────────────────────────

struct AudioComponentDescription {
  OSType componentType;
  OSType componentSubType;
  OSType componentManufacturer;
  UInt32 componentFlags;
  UInt32 componentFlagsMask;
};

typedef struct OpaqueAudioComponent*         AudioComponent;
typedef struct OpaqueAudioComponentInstance* AudioComponentInstance;
typedef AudioComponentInstance               AudioUnit;

extern "C" {
AudioComponent AudioComponentFindNext(AudioComponent inComponent,
                                      const AudioComponentDescription* inDesc);
OSStatus AudioComponentInstanceNew(AudioComponent inComponent,
                                   AudioComponentInstance* outInstance);
OSStatus AudioComponentInstanceDispose(AudioComponentInstance inInstance);
}

// ── Units ────────────────────────────────────────────────────────────────────

typedef UInt32  AudioUnitPropertyID;
typedef UInt32  AudioUnitScope;
typedef UInt32  AudioUnitElement;
typedef UInt32  AudioUnitParameterID;
typedef Float32 AudioUnitParameterValue;
typedef UInt32  AudioUnitRenderActionFlags;
typedef UInt32  AudioUnitParameterOptions;
typedef UInt32  AudioUnitParameterUnit;

enum : AudioUnitScope {
  kAudioUnitScope_Global = 0,
  kAudioUnitScope_Input  = 1,
  kAudioUnitScope_Output = 2,
};

enum : AudioUnitPropertyID {
  kAudioUnitProperty_ParameterList          = 3,
  kAudioUnitProperty_ParameterInfo          = 4,
  kAudioUnitProperty_StreamFormat           = 8,
  kAudioUnitProperty_MaximumFramesPerSlice  = 14,
  kAudioUnitProperty_SetRenderCallback      = 23,
  kAudioUnitProperty_OfflineRender          = 37,
};

enum : AudioUnitParameterOptions {
  kAudioUnitParameterFlag_CFNameRelease    = 1u << 4,
  kAudioUnitParameterFlag_HasCFNameString  = 1u << 20,
};

typedef const struct __CFString* CFStringRef;
typedef UInt32 CFStringEncoding;
enum : CFStringEncoding { kCFStringEncodingUTF8 = 0x08000100 };

extern "C" {
Boolean CFStringGetCString(CFStringRef theString, char* buffer,
                           long bufferSize, CFStringEncoding encoding);
void CFRelease(const void* cf);
}

struct AudioUnitParameterInfo {
  char                      name[52];
  CFStringRef               unitName;
  UInt32                    clumpID;
  CFStringRef               cfNameString;
  AudioUnitParameterUnit    unit;
  AudioUnitParameterValue   minValue;
  AudioUnitParameterValue   maxValue;
  AudioUnitParameterValue   defaultValue;
  AudioUnitParameterOptions flags;
};

typedef OSStatus (*AURenderCallback)(void* inRefCon,
                                     AudioUnitRenderActionFlags* ioActionFlags,
                                     const AudioTimeStamp* inTimeStamp,
                                     UInt32 inBusNumber,
                                     UInt32 inNumberFrames,
                                     AudioBufferList* ioData);

struct AURenderCallbackStruct {
  AURenderCallback inputProc;
  void*            inputProcRefCon;
};

extern "C" {
OSStatus AudioUnitInitialize(AudioUnit inUnit);
OSStatus AudioUnitUninitialize(AudioUnit inUnit);
OSStatus AudioUnitGetPropertyInfo(AudioUnit inUnit, AudioUnitPropertyID inID,
                                  AudioUnitScope inScope, AudioUnitElement inElement,
                                  UInt32* outDataSize, Boolean* outWritable);
OSStatus AudioUnitGetProperty(AudioUnit inUnit, AudioUnitPropertyID inID,
                              AudioUnitScope inScope, AudioUnitElement inElement,
                              void* outData, UInt32* ioDataSize);
OSStatus AudioUnitSetProperty(AudioUnit inUnit, AudioUnitPropertyID inID,
                              AudioUnitScope inScope, AudioUnitElement inElement,
                              const void* inData, UInt32 inDataSize);
OSStatus AudioUnitSetParameter(AudioUnit inUnit, AudioUnitParameterID inID,
                               AudioUnitScope inScope, AudioUnitElement inElement,
                               AudioUnitParameterValue inValue,
                               UInt32 inBufferOffsetInFrames);
OSStatus AudioUnitRender(AudioUnit inUnit, AudioUnitRenderActionFlags* ioActionFlags,
                         const AudioTimeStamp* inTimeStamp, UInt32 inOutputBusNumber,
                         UInt32 inNumberFrames, AudioBufferList* ioData);
}
