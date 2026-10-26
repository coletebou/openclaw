import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import { resolveSourceReplyExpectation } from "./source-reply-delivery-mode.js";

const MENTIONS_REQUIRE_REPLY_ENV = "BADCLAW_GROUP_MENTIONS_REQUIRE_REPLY";

const ctx: MsgContext = {
  ChatType: "channel",
  Provider: "slack",
  WasMentioned: true,
  MentionSource: "implicit_thread",
};

describe("implicit thread reply expectation", () => {
  // The implicit-thread exception narrows the mention rule, which applies only while mentions
  // require replies.
  beforeEach(() => {
    vi.stubEnv(MENTIONS_REQUIRE_REPLY_ENV, "1");
  });

  it.each([
    { policy: "allow", overrides: {}, expected: "optional" },
    { policy: "disallow", overrides: {}, expected: "required" },
    { policy: undefined, overrides: {}, expected: "required" },
    { policy: "allow", overrides: { MentionSource: "explicit_bot" }, expected: "required" },
    { policy: "allow", overrides: { MentionSource: undefined }, expected: "required" },
    { policy: "allow", overrides: { CommandSource: "native" }, expected: "required" },
    { policy: "allow", overrides: { ChatType: "direct" }, expected: "required" },
  ] as const)(
    "selects $expected for $policy with $overrides",
    ({ policy, overrides, expected }) => {
      expect(
        resolveSourceReplyExpectation({
          ctx: { ...ctx, ...overrides },
          cfg: { surfaces: { slack: { silentReply: { group: policy } } } },
        }),
      ).toBe(expected);
    },
  );
});

describe("group turn reply expectation", () => {
  const groupSilence = (group: "allow" | "disallow") =>
    ({ agents: { defaults: { silentReply: { group } } } }) satisfies OpenClawConfig;
  const expectation = (turn: MsgContext, cfg: OpenClawConfig = groupSilence("allow")) =>
    resolveSourceReplyExpectation({ ctx: { Provider: "imessage", ...turn }, cfg });

  beforeEach(() => {
    vi.stubEnv(MENTIONS_REQUIRE_REPLY_ENV, undefined);
  });

  it.each([
    {
      label: "mentioned group",
      turn: { ChatType: "group", WasMentioned: true },
      expected: "optional",
    },
    { label: "unmentioned group", turn: { ChatType: "group" }, expected: "optional" },
    {
      label: "mentioned channel",
      turn: { ChatType: "channel", Provider: "discord", WasMentioned: true },
      expected: "optional",
    },
    {
      label: "mentioned direct",
      turn: { ChatType: "direct", WasMentioned: true },
      expected: "required",
    },
  ] as const)("under group silence allow, a $label turn is $expected", ({ turn, expected }) => {
    expect(expectation(turn)).toBe(expected);
  });

  it.each([
    { policy: "disallow", cfg: groupSilence("disallow") },
    { policy: "unset", cfg: {} },
  ])("keeps a mentioned group turn required when group silence is $policy", ({ cfg }) => {
    expect(expectation({ ChatType: "group", WasMentioned: true }, cfg)).toBe("required");
  });

  it("restores mention-required group turns only when the switch is exactly 1", () => {
    vi.stubEnv(MENTIONS_REQUIRE_REPLY_ENV, "1");
    expect(expectation({ ChatType: "group", WasMentioned: true })).toBe("required");
    expect(expectation({ ChatType: "group" })).toBe("optional");
    for (const value of ["0", "true", " 1"]) {
      vi.stubEnv(MENTIONS_REQUIRE_REPLY_ENV, value);
      expect(expectation({ ChatType: "group", WasMentioned: true }), value).toBe("optional");
    }
  });
});
