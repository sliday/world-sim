// Derived from NullClaw's official Cloudflare edge-policy example.
// NullClaw is MIT licensed: https://github.com/nullclaw/nullclaw
const std = @import("std");

pub const Policy = enum(u32) {
    concise = 0,
    detailed = 1,
    urgent = 2,
};

/// Selects how much world context the host may expose to a model.
/// Networking, credentials, validation, and consequences stay in the Worker host.
export fn choose_policy(
    observation_bytes: u32,
    hazard_percent: u32,
    stalled_steps: u32,
    lineage_depth: u32,
) u32 {
    var urgent_score: u32 = 0;
    if (hazard_percent >= 65) urgent_score += 2;
    if (stalled_steps >= 4) urgent_score += 1;
    if (hazard_percent >= 80) urgent_score += 1;

    var detailed_score: u32 = 0;
    if (observation_bytes >= 320) detailed_score += 1;
    if (lineage_depth >= 3) detailed_score += 1;
    if (stalled_steps >= 2) detailed_score += 1;

    if (urgent_score >= 3) return @intFromEnum(Policy.urgent);
    if (detailed_score >= 2) return @intFromEnum(Policy.detailed);
    return @intFromEnum(Policy.concise);
}

/// Certifies whether a model-authored action may enter the host's bounded DSL.
/// The Worker still validates every icon, primitive, length, and consequence.
export fn facilitate_extension(
    evidence_count: u32,
    known_actions: u32,
    program_steps: u32,
    algorithm_bytes: u32,
) u32 {
    if (evidence_count == 0) return 0;
    if (known_actions >= 24) return 0;
    if (program_steps < 2 or program_steps > 4) return 0;
    if (algorithm_bytes < 12 or algorithm_bytes > 180) return 0;
    return 1;
}

test "urgent hazards win" {
    try std.testing.expectEqual(@as(u32, 2), choose_policy(120, 82, 4, 1));
}

test "lineage requests detail" {
    try std.testing.expectEqual(@as(u32, 1), choose_policy(380, 20, 1, 4));
}

test "small observations stay concise" {
    try std.testing.expectEqual(@as(u32, 0), choose_policy(120, 20, 0, 0));
}

test "extensions require evidence and bounded programs" {
    try std.testing.expectEqual(@as(u32, 1), facilitate_extension(3, 7, 3, 80));
    try std.testing.expectEqual(@as(u32, 0), facilitate_extension(0, 7, 3, 80));
    try std.testing.expectEqual(@as(u32, 0), facilitate_extension(3, 7, 8, 80));
}
