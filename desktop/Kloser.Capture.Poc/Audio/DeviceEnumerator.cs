// Phase 9 Step 3 — capture / render device enumeration.
//
// Plan §7.1. Wraps NAudio's MMDeviceEnumerator and exposes a small
// snapshot type the CLI and the capture sources both consume.

using NAudio.CoreAudioApi;

namespace Kloser.Capture.Poc.Audio;

public sealed record DeviceSnapshot(
    string DeviceId,
    string FriendlyName,
    DataFlow DataFlow,
    DeviceState State,
    bool IsDefault
);

public sealed class DeviceEnumerator : IDisposable
{
    private readonly MMDeviceEnumerator _enumerator = new();

    public IReadOnlyList<DeviceSnapshot> ListCaptureDevices() =>
        Snapshot(DataFlow.Capture);

    public IReadOnlyList<DeviceSnapshot> ListRenderDevices() =>
        Snapshot(DataFlow.Render);

    /// <summary>
    /// Resolve a capture endpoint by id; null means "default capture".
    /// Throws InvalidOperationException with a friendly hint if the
    /// caller-supplied id does not match any active device.
    /// </summary>
    public MMDevice ResolveCapture(string? deviceId) =>
        Resolve(DataFlow.Capture, deviceId, Role.Communications);

    /// <summary>
    /// Resolve a render endpoint by id; null means "default render".
    /// Loopback capture binds to the render endpoint.
    /// </summary>
    public MMDevice ResolveRender(string? deviceId) =>
        Resolve(DataFlow.Render, deviceId, Role.Multimedia);

    private MMDevice Resolve(DataFlow flow, string? deviceId, Role defaultRole)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            return _enumerator.GetDefaultAudioEndpoint(flow, defaultRole);
        }
        var collection = _enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active);
        foreach (var dev in collection)
        {
            if (string.Equals(dev.ID, deviceId, StringComparison.Ordinal))
            {
                return dev;
            }
        }
        throw new InvalidOperationException(
            $"device id '{deviceId}' not found among active {flow} endpoints; " +
            "rerun with --list-devices to see valid ids");
    }

    private IReadOnlyList<DeviceSnapshot> Snapshot(DataFlow flow)
    {
        var defaultId = TryGetDefaultId(flow);
        var devices = _enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active);
        var result = new List<DeviceSnapshot>(devices.Count);
        foreach (var dev in devices)
        {
            result.Add(new DeviceSnapshot(
                DeviceId: dev.ID,
                FriendlyName: dev.FriendlyName,
                DataFlow: flow,
                State: dev.State,
                IsDefault: string.Equals(dev.ID, defaultId, StringComparison.Ordinal)
            ));
        }
        return result;
    }

    private string? TryGetDefaultId(DataFlow flow)
    {
        try
        {
            using var dev = _enumerator.GetDefaultAudioEndpoint(flow, Role.Multimedia);
            return dev.ID;
        }
        catch
        {
            // No default device — return null, callers will not mark
            // anything as "[default]" in the listing.
            return null;
        }
    }

    public void Dispose() => _enumerator.Dispose();
}
