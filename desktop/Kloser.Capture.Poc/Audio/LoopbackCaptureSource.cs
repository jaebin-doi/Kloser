// Phase 9 Step 3 — system audio (render endpoint) loopback source.
//
// Plan §7.2. Wraps NAudio WasapiLoopbackCapture bound to a
// render-flow MMDevice. WASAPI loopback captures what the OS is
// sending to that render endpoint without requiring "Stereo Mix" or
// any kernel-level hook.

using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Kloser.Capture.Poc.Audio;

public sealed class LoopbackCaptureSource : CaptureSourceBase
{
    public LoopbackCaptureSource(int frameMs, long sessionStartMs)
        : base(AudioSourceId.SystemLoopback, frameMs, sessionStartMs)
    {
    }

    protected override IWaveIn CreateClient(MMDevice device)
    {
        // WasapiLoopbackCapture binds to the given render MMDevice.
        return new WasapiLoopbackCapture(device);
    }
}
