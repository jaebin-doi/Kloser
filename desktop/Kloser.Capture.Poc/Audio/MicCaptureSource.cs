// Phase 9 Step 3 — microphone (capture endpoint) source.
//
// Plan §7.2. Wraps NAudio WasapiCapture bound to a capture-flow MMDevice.

using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Kloser.Capture.Poc.Audio;

public sealed class MicCaptureSource : CaptureSourceBase
{
    public MicCaptureSource(int frameMs, long sessionStartMs)
        : base(AudioSourceId.AgentMic, frameMs, sessionStartMs)
    {
    }

    protected override IWaveIn CreateClient(MMDevice device)
    {
        // Shared-mode capture so we do not require exclusive access.
        // NAudio picks the device's shared-mode mix format automatically.
        var capture = new WasapiCapture(device, useEventSync: true)
        {
            ShareMode = AudioClientShareMode.Shared,
        };
        return capture;
    }
}
