// Phase 9 Step 3 — Windows capture PoC entry point.
//
// Plan: docs/plan/phase-9/PHASE_9_STEP_3_PLAN.md.
//
// CLI surface (Plan §6.2):
//   --list-devices                            print capture + render devices, then exit
//   --mic <device-id>                         use specific microphone (default = Windows default)
//   --loopback <device-id>                    use specific render endpoint (default = Windows default)
//   --no-mic                                  skip microphone capture
//   --no-loopback                             skip loopback capture
//   --frame-ms 20|40|60|80|100                frame duration (default 40)
//   --duration-sec <n>                        auto-stop after n seconds (default 30)
//   --write-diagnostic-wav                    enable dev-only PCM16 WAV per source (default off)
//   --diagnostic-dir <path>                   override diagnostic output directory
//   --status-interval-ms <n>                  status refresh interval (default 500)
//
// Out of scope for this PoC (do NOT add):
//   * Socket.io / backend audio_chunk transport.
//   * Azure Speech SDK.
//   * Login / token storage.
//   * Phase 8 recording upload/finalize.

using Kloser.Capture.Poc.Audio;
using Kloser.Capture.Poc.Diagnostics;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Kloser.Capture.Poc;

public static class Program
{
    public static int Main(string[] args)
    {
        try
        {
            var (mode, options) = ParseArgs(args);
            return mode switch
            {
                Mode.Help => RunHelp(),
                Mode.ListDevices => RunListDevices(),
                Mode.Capture => RunCapture(options!),
                _ => RunHelp(),
            };
        }
        catch (ArgumentException ex)
        {
            Console.Error.WriteLine($"argument error: {ex.Message}");
            RunHelp();
            return 2;
        }
        catch (InvalidOperationException ex)
        {
            Console.Error.WriteLine($"error: {ex.Message}");
            return 3;
        }
    }

    private enum Mode { Help, ListDevices, Capture }

    private static (Mode, CaptureOptions?) ParseArgs(string[] args)
    {
        if (args.Length == 0) return (Mode.Help, null);

        var mode = Mode.Capture;
        string? micDeviceId = null;
        string? loopbackDeviceId = null;
        bool noMic = false;
        bool noLoopback = false;
        int frameMs = 40;
        int durationSec = 30;
        bool writeWav = false;
        string? diagnosticDir = null;
        int statusIntervalMs = 500;

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            switch (a)
            {
                case "--help":
                case "-h":
                    return (Mode.Help, null);
                case "--list-devices":
                    mode = Mode.ListDevices;
                    break;
                case "--no-mic":
                    noMic = true;
                    break;
                case "--no-loopback":
                    noLoopback = true;
                    break;
                case "--write-diagnostic-wav":
                    writeWav = true;
                    break;
                case "--mic":
                    micDeviceId = RequireValue(args, ref i, a);
                    break;
                case "--loopback":
                    loopbackDeviceId = RequireValue(args, ref i, a);
                    break;
                case "--frame-ms":
                    frameMs = int.Parse(RequireValue(args, ref i, a));
                    if (Array.IndexOf(CaptureOptions.AllowedFrameMs, frameMs) < 0)
                    {
                        throw new ArgumentException(
                            "--frame-ms must be one of " +
                            string.Join("/", CaptureOptions.AllowedFrameMs));
                    }
                    break;
                case "--duration-sec":
                    durationSec = int.Parse(RequireValue(args, ref i, a));
                    if (durationSec < 1 || durationSec > 3600)
                    {
                        throw new ArgumentException("--duration-sec must be between 1 and 3600");
                    }
                    break;
                case "--diagnostic-dir":
                    diagnosticDir = RequireValue(args, ref i, a);
                    break;
                case "--status-interval-ms":
                    statusIntervalMs = int.Parse(RequireValue(args, ref i, a));
                    if (statusIntervalMs < 100 || statusIntervalMs > 5000)
                    {
                        throw new ArgumentException(
                            "--status-interval-ms must be between 100 and 5000");
                    }
                    break;
                default:
                    throw new ArgumentException($"unknown option '{a}'");
            }
        }

        if (mode == Mode.ListDevices) return (mode, null);

        if (noMic && noLoopback)
        {
            throw new ArgumentException("cannot specify both --no-mic and --no-loopback");
        }

        var options = new CaptureOptions
        {
            MicDeviceId = micDeviceId,
            LoopbackDeviceId = loopbackDeviceId,
            NoMic = noMic,
            NoLoopback = noLoopback,
            FrameMs = frameMs,
            DurationSec = durationSec,
            WriteDiagnosticWav = writeWav,
            DiagnosticDir = diagnosticDir,
            StatusIntervalMs = statusIntervalMs,
        };
        return (mode, options);
    }

    private static string RequireValue(string[] args, ref int i, string opt)
    {
        if (i + 1 >= args.Length)
        {
            throw new ArgumentException($"{opt} requires a value");
        }
        return args[++i];
    }

    private static int RunHelp()
    {
        Console.WriteLine("Kloser.Capture.Poc — Phase 9 Step 3 Windows audio capture PoC");
        Console.WriteLine();
        Console.WriteLine("Usage:");
        Console.WriteLine("  Kloser.Capture.Poc --list-devices");
        Console.WriteLine("  Kloser.Capture.Poc [--mic <id>] [--loopback <id>]");
        Console.WriteLine("                     [--frame-ms 20|40|60|80|100]");
        Console.WriteLine("                     [--duration-sec <n>]");
        Console.WriteLine("                     [--write-diagnostic-wav]");
        Console.WriteLine("                     [--diagnostic-dir <path>]");
        Console.WriteLine("                     [--no-mic] [--no-loopback]");
        Console.WriteLine();
        Console.WriteLine("Defaults: frame-ms=40, duration-sec=30, status-interval-ms=500,");
        Console.WriteLine("          diagnostic WAV disabled, default capture+render endpoints.");
        Console.WriteLine();
        Console.WriteLine("This PoC does NOT connect to the backend, does NOT call Azure, does NOT");
        Console.WriteLine("upload audio, and never writes raw PCM to disk unless explicitly asked.");
        return 0;
    }

    private static int RunListDevices()
    {
        using var enumerator = new DeviceEnumerator();
        Console.WriteLine("Capture devices:");
        PrintDevices(enumerator.ListCaptureDevices());
        Console.WriteLine();
        Console.WriteLine("Render devices:");
        PrintDevices(enumerator.ListRenderDevices());
        Console.WriteLine();
        Console.WriteLine("Pass --mic <id> or --loopback <id> with the exact id above to override defaults.");
        return 0;
    }

    private static void PrintDevices(IReadOnlyList<DeviceSnapshot> snapshots)
    {
        if (snapshots.Count == 0)
        {
            Console.WriteLine("  (none found)");
            return;
        }
        foreach (var d in snapshots)
        {
            string flag = d.IsDefault ? "default" : "active ";
            Console.WriteLine($"  [{flag}] {d.DeviceId} | {d.FriendlyName}");
        }
    }

    private static int RunCapture(CaptureOptions options)
    {
        long sessionStartMs = StatusRenderer.NowMs();
        using var enumerator = new DeviceEnumerator();

        MicCaptureSource? mic = null;
        LoopbackCaptureSource? loop = null;
        DiagnosticWavWriter? wav = null;

        try
        {
            if (!options.NoMic)
            {
                var micDevice = enumerator.ResolveCapture(options.MicDeviceId);
                mic = new MicCaptureSource(options.FrameMs, sessionStartMs);
                mic.SourceError += OnSourceError;
                Console.WriteLine($"mic: starting on {micDevice.FriendlyName}");
                mic.Start(micDevice);
                Console.WriteLine($"mic: native format = {Describe(mic.NativeFormat)}");
            }
            if (!options.NoLoopback)
            {
                var renderDevice = enumerator.ResolveRender(options.LoopbackDeviceId);
                loop = new LoopbackCaptureSource(options.FrameMs, sessionStartMs);
                loop.SourceError += OnSourceError;
                Console.WriteLine($"loopback: starting on {renderDevice.FriendlyName}");
                loop.Start(renderDevice);
                Console.WriteLine($"loopback: native format = {Describe(loop.NativeFormat)}");
            }

            if (options.WriteDiagnosticWav)
            {
                string dir = options.DiagnosticDir ?? DefaultDiagnosticDir();
                wav = new DiagnosticWavWriter(dir);
                Console.WriteLine($"diagnostic WAV enabled; writing to: {wav.OutputDir}");
            }
            else
            {
                Console.WriteLine("diagnostic WAV disabled (default)");
            }

            using var cts = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
            cts.CancelAfter(TimeSpan.FromSeconds(options.DurationSec));

            Console.WriteLine($"capture running for up to {options.DurationSec}s ... press Ctrl-C to stop.");
            var renderer = new StatusRenderer(sessionStartMs);
            long nextStatus = sessionStartMs + options.StatusIntervalMs;

            while (!cts.IsCancellationRequested)
            {
                if (mic is not null)
                {
                    foreach (var frame in mic.Drain(64))
                    {
                        wav?.Write(frame);
                    }
                }
                if (loop is not null)
                {
                    foreach (var frame in loop.Drain(64))
                    {
                        wav?.Write(frame);
                    }
                }
                long now = StatusRenderer.NowMs();
                if (now >= nextStatus)
                {
                    Console.WriteLine(renderer.Render(mic?.GetStatus(), loop?.GetStatus()));
                    nextStatus = now + options.StatusIntervalMs;
                }
                Thread.Sleep(20);
            }

            // Final status snapshot after stop.
            Console.WriteLine(renderer.Render(mic?.GetStatus(), loop?.GetStatus()));

            if (wav is not null)
            {
                wav.Dispose();
                Console.WriteLine("diagnostic WAV files:");
                foreach (var (id, path) in wav.GetWrittenPaths())
                {
                    Console.WriteLine($"  {id.ToWireString()} -> {path}");
                }
            }

            int unhealthy = 0;
            if (mic is not null && !mic.IsHealthy) unhealthy++;
            if (loop is not null && !loop.IsHealthy) unhealthy++;
            return unhealthy > 0 ? 4 : 0;
        }
        finally
        {
            try { mic?.Stop(); } catch { /* swallow */ }
            try { loop?.Stop(); } catch { /* swallow */ }
            try { wav?.Dispose(); } catch { /* swallow */ }
        }
    }

    private static void OnSourceError(object? sender, CaptureSourceError err)
    {
        string tag = err.Fatal ? "FATAL" : "WARN ";
        Console.Error.WriteLine($"[{tag}] {err.Source.ToWireString()} {err.ErrorKind}: {err.Message}");
    }

    private static string DefaultDiagnosticDir()
    {
        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        // Resolve under the project's desktop/.diagnostics/<stamp>/ when
        // invoked via `dotnet run` from the repo root. Use AppContext
        // BaseDirectory as a fallback so the path is always writable.
        string repoCandidate = Path.Combine(
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..")),
            ".diagnostics", stamp);
        return repoCandidate;
    }

    private static string Describe(WaveFormat? fmt)
    {
        if (fmt is null) return "(unknown)";
        return $"{fmt.Encoding} {fmt.SampleRate} Hz {fmt.Channels}ch {fmt.BitsPerSample}-bit";
    }
}
