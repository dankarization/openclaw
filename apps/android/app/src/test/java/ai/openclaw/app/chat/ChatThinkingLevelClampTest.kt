package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class ChatThinkingLevelClampTest {
  private fun options(vararg ids: String): List<ChatThinkingLevelOption> =
    ids.map { ChatThinkingLevelOption(id = it, label = it) }

  @Test
  fun membershipWins() {
    assertEquals("ultra", clampThinkingLevelToOptions("ultra", options("off", "ultra")))
    assertEquals("off", clampThinkingLevelToOptions("off", options("off", "ultra")))
  }

  @Test
  fun preservesUltraWhenOmittedFromAdvertisedOptions() {
    assertEquals(
      "ultra",
      clampThinkingLevelToOptions("ultra", options("off", "high", "xhigh", "max")),
    )
  }

  @Test
  fun preservesCanonicalEffectiveLevelOmittedFromIncompletePickerMetadata() {
    // Gateway missing/identity-only catalog keeps effective Medium while picker shows
    // Off/High/Low/Ultra (session-utils.metadata-perf). Do not reinterpret to Low.
    assertEquals(
      "medium",
      clampThinkingLevelToOptions("medium", options("off", "high", "low", "ultra")),
    )
    assertEquals(
      "adaptive",
      clampThinkingLevelToOptions("adaptive", options("off", "high", "low", "ultra")),
    )
    assertEquals(
      "xhigh",
      clampThinkingLevelToOptions("xhigh", options("off", "high", "ultra")),
    )
  }

  @Test
  fun clampsMediumToOffOnOffUltraProfile() {
    // Growter / DeepSeek Flash advertises Off+Ultra only; Medium must never stick.
    assertEquals("off", clampThinkingLevelToOptions("medium", options("off", "ultra")))
  }

  @Test
  fun ambiguousAdaptivePrefersOffOnOffUltraProfile() {
    // Complete Off/Ultra capabilities prove adaptive unsupported; clamp to Off.
    assertEquals("off", clampThinkingLevelToOptions("adaptive", options("off", "ultra")))
  }

  @Test
  fun highEffortClampsToOffOnOffUltraProfile() {
    // Align with Gateway resolveSupportedThinkingLevelFromProfile: never auto-fallback to Ultra.
    assertEquals("off", clampThinkingLevelToOptions("high", options("off", "ultra")))
    assertEquals("off", clampThinkingLevelToOptions("max", options("off", "ultra")))
    assertEquals("off", clampThinkingLevelToOptions("xhigh", options("off", "ultra")))
  }

  @Test
  fun preservesCanonicalLevelWhenRicherLadderOmitsIt() {
    // Off/High/Ultra is not an Off/Ultra-only restricted profile; preserve omitted Medium.
    assertEquals("medium", clampThinkingLevelToOptions("medium", options("off", "high", "ultra")))
  }

  @Test
  fun soleUltraAdvertisedDoesNotAutoSelectUltra() {
    // Gateway never auto-opts into Ultra; explicit Ultra is membership-only.
    assertEquals("off", clampThinkingLevelToOptions("medium", options("ultra")))
  }

  @Test
  fun unknownLevelPrefersOff() {
    assertEquals("off", clampThinkingLevelToOptions("custom-level", options("off", "ultra")))
    assertEquals("off", clampThinkingLevelToOptions("custom-level", options("off", "high", "ultra")))
  }

  @Test
  fun emptyOptionsPassthrough() {
    assertEquals("medium", clampThinkingLevelToOptions("medium", emptyList()))
  }
}
