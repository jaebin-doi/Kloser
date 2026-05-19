// Phase 9 Step 3 — source label enum.
//
// Stable string identifiers mirror Phase 9 Step 2 backend contract
// (server/src/types/wsAudio.ts AudioSource). Desktop must emit exactly
// these strings when the Step 5 network adapter lands; the PoC keeps
// them here so the wire-up stays mechanical.

namespace Kloser.Capture.Poc.Audio;

/// <summary>
/// Two source channels captured per call. agent_mic is the agent's
/// microphone; system_loopback is the loopback of whatever the operator
/// is hearing (softphone audio, conferencing app output, etc.).
/// </summary>
public enum AudioSourceId
{
    AgentMic,
    SystemLoopback,
}

public static class AudioSourceIdExtensions
{
    /// <summary>
    /// Wire-format string used by the Phase 9 Step 2 backend contract.
    /// Must remain stable: server zod schema validates exact values.
    /// </summary>
    public static string ToWireString(this AudioSourceId source) => source switch
    {
        AudioSourceId.AgentMic => "agent_mic",
        AudioSourceId.SystemLoopback => "system_loopback",
        _ => throw new ArgumentOutOfRangeException(nameof(source), source, null),
    };
}
