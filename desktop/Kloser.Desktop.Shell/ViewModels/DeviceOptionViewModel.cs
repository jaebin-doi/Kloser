// Phase 9 Step 4 — single device row inside the picker combobox.
//
// IDs come from Kloser.Capture.Core.Audio.DeviceSnapshot.DeviceId; we
// surface the raw id (sometimes long) alongside a human label so the
// user can pick by either property.

using NAudio.CoreAudioApi;

namespace Kloser.Desktop.Shell.ViewModels;

public sealed class DeviceOptionViewModel
{
    public string DeviceId { get; }
    public string FriendlyName { get; }
    public bool IsDefault { get; }
    public DataFlow Flow { get; }

    public DeviceOptionViewModel(string deviceId, string friendlyName, bool isDefault, DataFlow flow)
    {
        DeviceId = deviceId;
        FriendlyName = friendlyName;
        IsDefault = isDefault;
        Flow = flow;
    }

    public string Display => IsDefault
        ? $"[default] {FriendlyName}"
        : FriendlyName;

    public override string ToString() => Display;
}
